import type {DocumentTranslatedSegment, FullTextTranslationCommand, DocumentTranslationTargets, DocumentTranslationView} from '@hsbc/contracts/document-translation';
import {translationReason, translationRunning} from './presentation.ts';

export class FullTextError extends Error {
  constructor(message: string, readonly invalidatesSnapshot = true) {super(message);}
}

export interface FullTextSnapshot {
  targets: DocumentTranslationTargets;
  jobs: DocumentTranslationView[];
}
export interface FullTextScope {caseId: string; documentId: string; parseRevision: string; caseRevision: number; directoryRevision?: number}
export interface FullTextTransport {
  targets(offset: number, signal: AbortSignal): Promise<DocumentTranslationTargets>;
  history(chunks: string[], signal: AbortSignal): Promise<{items: DocumentTranslationView[]}>;
  fullTextHistory?(signal: AbortSignal): Promise<{items: DocumentTranslationView[]}>;
  get(jobId: string, signal: AbortSignal): Promise<DocumentTranslationView>;
  create(command: FullTextTranslationCommand, signal: AbortSignal): Promise<{jobId: string}>;
  key(): string;
  wait(signal: AbortSignal): Promise<void>;
}
export function fullTextRows(snapshot: FullTextSnapshot) {
  const segments = new Map<string, DocumentTranslatedSegment>();
  // Prefer the latest usable result, keeping source order independent of job order.
  for (const job of [...snapshot.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (job.validity !== 'current' || job.parseRevision !== snapshot.targets.parseRevision || job.directoryRevision !== snapshot.targets.directoryRevision) continue;
    for (const segment of job.items) if (segment.translatedText?.trim() && !segments.has(segment.chunkId)) segments.set(segment.chunkId, segment);
  }
  return snapshot.targets.items.map(target => {
    const candidate = segments.get(target.chunkId);
    const segment = candidate?.sourceSha256 === target.sourceSha256 && candidate.sourceText === target.sourceText ? candidate : undefined;
    const original = !target.available && target.reasonCodes.length === 1 && target.reasonCodes[0] === 'translation_no_english_text' && !!target.sourceText;
    return {target, segment, original, missing: !segment && !original};
  });
}
export function fullTextSummary(snapshot: FullTextSnapshot) {
  const rows = fullTextRows(snapshot);
  return {total: rows.length, translated: rows.filter(row => row.segment).length, original: rows.filter(row => row.original).length,
    missing: rows.filter(row => row.missing).length, review: rows.filter(row => row.segment?.status === 'needs_review').length};
}

export function fullTextJob(snapshot: FullTextSnapshot) {
  const jobs = [...snapshot.jobs].filter(job => job.scope === 'full_text').sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.jobId.localeCompare(a.jobId));
  const available = snapshot.targets.items.filter(target => target.available);
  // Observe accepted work first. Once it ends, a broader set of eligible text
  // needs a new full-text snapshot, not a retry of the old narrower snapshot.
  return jobs.find(job => translationRunning(job.status)) ?? jobs.find(job =>
    job.errorCode === 'translation_call_unknown' || available.every(target => job.chunkIds.includes(target.chunkId)));
}

/** Observes durable work. Aborting this client never cancels the server task. */
export class FullTextTranslation {
  private uncertain?: FullTextTranslationCommand;
  constructor(private scope: FullTextScope, private transport: FullTextTransport) {}
  async load(signal: AbortSignal): Promise<FullTextSnapshot> {
    const first = await this.transport.targets(0, signal);
    if (first.parseRevision !== this.scope.parseRevision || first.caseRevision !== this.scope.caseRevision ||
        (this.scope.directoryRevision !== undefined && first.directoryRevision !== this.scope.directoryRevision)) throw new FullTextError('材料信息已更新，请刷新页面后重新打开全文翻译。');
    const items = [...first.items];
    let offset = first.nextOffset, previous = 0;
    while (offset !== null) {
      signal.throwIfAborted();
      if (offset <= previous) throw new FullTextError('全文段落分页异常，请刷新后重试。');
      previous = offset;
      const page = await this.transport.targets(offset, signal);
      if (page.caseRevision !== first.caseRevision || page.parseRevision !== first.parseRevision || page.directoryRevision !== first.directoryRevision || page.total !== first.total) throw new FullTextError('材料信息已更新，请刷新页面后重新打开全文翻译。');
      items.push(...page.items); offset = page.nextOffset;
    }
    if (items.length !== first.total || new Set(items.map(item => item.chunkId)).size !== items.length) throw new FullTextError('全文段落未完整加载，请刷新后重试。');
    const jobs = new Map<string, DocumentTranslationView>();
    const fullText = await this.transport.fullTextHistory?.(signal);
    for (const job of fullText?.items ?? []) if (this.matches(job, first)) jobs.set(job.jobId, job);
    for (let start = 0; start < items.length; start += 20) {
      const batch = items.slice(start, start + 20);
      const history = await this.transport.history(batch.map(item => item.chunkId), signal);
      for (const job of history.items) if (this.matches(job, first)) jobs.set(job.jobId, job);
      // The history endpoint caps at ten records. Query each uncovered paragraph
      // if that cap was hit, so later field jobs cannot hide older full-text work.
      if (history.items.length === 10) for (const target of batch) {
        if ([...jobs.values()].some(job => job.items.some(segment => segment.chunkId === target.chunkId && segment.sourceSha256 === target.sourceSha256 && segment.translatedText?.trim()))) continue;
        const older = await this.transport.history([target.chunkId], signal);
        for (const job of older.items) if (this.matches(job, first)) jobs.set(job.jobId, job);
      }
    }
    return {targets: {...first, items, nextOffset: null}, jobs: [...jobs.values()]};
  }
  private matches(job: DocumentTranslationView, targets: DocumentTranslationTargets) {
    return job.caseId === this.scope.caseId && job.documentId === this.scope.documentId && job.parseRevision === targets.parseRevision && job.directoryRevision === targets.directoryRevision && job.validity === 'current';
  }
  async watch(snapshot: FullTextSnapshot, signal: AbortSignal, update: (snapshot: FullTextSnapshot) => void, jobId = fullTextJob(snapshot)?.jobId) {
    if (!jobId) return snapshot;
    let job = await this.transport.get(jobId, signal);
    const save = () => {
      signal.throwIfAborted();
      if (!this.matches(job, snapshot.targets)) throw new FullTextError('原文或案件依据已更新，请刷新后重新打开全文翻译。');
      snapshot = {...snapshot, jobs: [...snapshot.jobs.filter(item => item.jobId !== job.jobId), job]};
      update(snapshot);
    };
    save();
    while (translationRunning(job.status)) {
      await this.transport.wait(signal); job = await this.transport.get(jobId, signal); save();
    }
    if (job.errorCode) throw new FullTextError(translationReason(job.errorCode), false);
    return snapshot;
  }
  async generate(signal: AbortSignal, update: (snapshot: FullTextSnapshot) => void) {
    const snapshot = await this.load(signal); signal.throwIfAborted(); update(snapshot);
    const previous = fullTextJob(snapshot);
    if (previous && translationRunning(previous.status)) return this.watch(snapshot, signal, update);
    if (!snapshot.targets.canCreate || !snapshot.targets.enabled) throw new FullTextError('当前材料版本或权限不允许生成译文，可导出已有结果。');
    if (!fullTextRows(snapshot).some(row => row.missing && row.target.available)) return snapshot;
    if (previous && !previous.canRetry) throw new FullTextError(translationReason(previous.errorCode ?? 'translation_retry_not_allowed'), false);
    const command = this.uncertain ?? {
      expectedRevision: snapshot.targets.caseRevision, parseRevision: snapshot.targets.parseRevision,
      expectedDirectoryRevision: snapshot.targets.directoryRevision, idempotencyKey: this.transport.key(),
      reason: '生成全文中文参考翻译，供人工核对及 PDF 导出', ...(previous ? {retryOf: previous.jobId} : {}),
    };
    this.uncertain = command;
    let accepted: {jobId: string};
    try { accepted = await this.transport.create(command, signal); }
    catch (error) {
      if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500) this.uncertain = undefined;
      throw error;
    }
    this.uncertain = undefined;
    await this.watch(snapshot, signal, update, accepted.jobId);
    const fresh = await this.load(signal); signal.throwIfAborted(); update(fresh); return fresh;
  }
}
