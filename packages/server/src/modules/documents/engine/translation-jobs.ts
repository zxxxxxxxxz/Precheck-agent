import { DocumentBundleSchema, DocumentTranslationBindingSchema, DocumentTranslationCacheSchema, DocumentTranslationJobSchema, type DocumentBundle, type DocumentTranslation, type DocumentTranslationBinding, type DocumentTranslationCache, type DocumentTranslationJob } from '@hsbc/contracts/documents';
import { sha256 } from '../../../document/evidence.js';
import { translateEvidence, type DocumentTranslationClient } from './translation.js';

export interface DocumentTranslationVersions { glossaryVersion: string; promptVersion: string; clientVersion: string; targetLanguage: 'zh' }
/** Pure identity calculation. No provider call and no simulated output is made to obtain a key. */
export function translationBinding(bundle: DocumentBundle, chunkIds: string[], versions: DocumentTranslationVersions): DocumentTranslationBinding {
  DocumentBundleSchema.parse(bundle);
  if (!chunkIds.length || new Set(chunkIds).size !== chunkIds.length) throw new Error('p2_translation_target_invalid');
  const chunks = chunkIds.map(id => { const chunk = bundle.chunks.find(chunk => chunk.id === id); if (!chunk?.text || !chunk.anchorIds.length) throw new Error('p2_translation_source_unavailable'); return chunk; });
  const contextIds = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (chunkIds.includes(id) || contextIds.has(id) || depth > 8 || contextIds.size >= 32) return;
    const chunk = bundle.chunks.find(chunk => chunk.id === id); if (!chunk) return;
    contextIds.add(id); chunk.dependencyIds.forEach(dependency => visit(dependency, depth + 1));
  };
  chunks.forEach(chunk => chunk.dependencyIds.forEach(id => visit(id, 0)));
  const anchors = [...new Set(chunks.flatMap(chunk => chunk.anchorIds))];
  if (chunks.some(chunk => chunk.documentVersionId !== bundle.scope.documentVersionId || chunk.parseRevision !== bundle.scope.parseRevision || sha256(chunk.text) !== chunk.textSha256) || anchors.some(id => !bundle.anchors.some(anchor => anchor.anchor_id === id && anchor.document_version_id === bundle.scope.documentVersionId && anchor.parse_revision === bundle.scope.parseRevision))) throw new Error('p2_translation_source_scope_mismatch');
  return DocumentTranslationBindingSchema.parse({ scope: bundle.scope, directoryRevision: bundle.directoryRevision, indexManifestId: bundle.indexManifest.id, indexVersion: bundle.indexManifest.indexVersion, sourceChunkIds: chunkIds, sourceAnchorIds: anchors,
    sourceSha256: sha256(chunks.map(chunk => chunk.text).join('\n\n')), contextSha256: sha256(bundle.chunks.filter(chunk => contextIds.has(chunk.id)).map(chunk => chunk.text).join('\n\n')),
    contextManifestSha256: sha256(JSON.stringify([...chunks, ...bundle.chunks.filter(chunk => contextIds.has(chunk.id))].map(chunk => [chunk.id, chunk.textSha256, chunk.dependencyIds, chunk.unresolvedReferences, chunk.coverageGaps]))),
    glossaryVersion: versions.glossaryVersion, promptVersion: versions.promptVersion, clientVersion: versions.clientVersion, targetLanguage: versions.targetLanguage });
}
export const translationCacheKey = (binding: DocumentTranslationBinding): string => sha256(JSON.stringify(DocumentTranslationBindingSchema.parse(binding)));
export function translationCacheValidity(cache: DocumentTranslationCache, bundle: DocumentBundle, versions: DocumentTranslationVersions): 'current' | 'stale' {
  try {
    DocumentTranslationCacheSchema.parse(cache);
    const result = cache.result, binding = cache.binding;
    const boundResult = result.status === 'ready' && result.simulated && result.validity === 'current'
      && JSON.stringify(result.scope) === JSON.stringify(binding.scope) && JSON.stringify(result.sourceChunkIds) === JSON.stringify(binding.sourceChunkIds)
      && JSON.stringify(result.sourceAnchorIds) === JSON.stringify(binding.sourceAnchorIds) && result.sourceSha256 === binding.sourceSha256 && result.contextSha256 === binding.contextSha256
      && result.glossaryVersion === binding.glossaryVersion && result.promptVersion === binding.promptVersion && result.clientVersion === binding.clientVersion;
    return boundResult && cache.validity === 'current' && cache.cacheKey === translationCacheKey(binding) && cache.cacheKey === translationCacheKey(translationBinding(bundle, binding.sourceChunkIds, versions)) ? 'current' : 'stale';
  } catch { return 'stale'; }
}
/** In-memory job/cache contract replay only; deliberately not an HTTP, queue or cloud service.
 * A real client is rejected even when isolatedReplay is true. Production translation stays disabled. */
export class IsolatedTranslationReplay {
  private jobs = new Map<string, DocumentTranslationJob>();
  private caches = new Map<string, DocumentTranslationCache>();
  private calls = new Map<string, { epoch: number; controller: AbortController }>();
  private readonly client: DocumentTranslationClient;
  constructor(options: { isolatedReplay: true; client: DocumentTranslationClient }) {
    if (options.isolatedReplay !== true || options.client.simulated !== true) throw new Error('p2_translation_isolated_simulation_required');
    this.client = options.client;
  }
  create(bundle: DocumentBundle, chunkIds: string[], options: Omit<DocumentTranslationVersions, 'clientVersion'>): DocumentTranslationJob {
    if (this.client.simulated !== true) throw new Error('p2_translation_isolated_simulation_required');
    const binding = translationBinding(bundle, chunkIds, { ...options, clientVersion: this.client.version }), cacheKey = translationCacheKey(binding), id = `translation-job:${cacheKey}`;
    const previous = this.jobs.get(id), cached = this.caches.get(cacheKey);
    if (previous && (previous.status === 'running' || previous.status === 'queued')) return structuredClone(previous);
    const cacheHit = Boolean(cached && translationCacheValidity(cached, bundle, binding) === 'current');
    const job = DocumentTranslationJobSchema.parse({ schema_version: 'p2.v1', id, cacheKey, binding, epoch: previous ? previous.epoch + (cacheHit ? 0 : 1) : 1,
      status: cacheHit ? 'succeeded' : 'queued', isolatedReplay: true, simulated: true, cacheHit, resultId: cacheHit ? cached!.result.id : null, reasonCodes: [] });
    this.jobs.set(id, job); return structuredClone(job);
  }
  get(id: string): DocumentTranslationJob { const job = this.jobs.get(id); if (!job) throw new Error('p2_translation_job_not_found'); return structuredClone(job); }
  cache(key: string): DocumentTranslationCache | null { return structuredClone(this.caches.get(key) ?? null); }
  cancel(id: string): DocumentTranslationJob {
    const job = this.get(id); if (!['queued', 'running'].includes(job.status)) return job;
    this.calls.get(id)?.controller.abort();
    const canceled = DocumentTranslationJobSchema.parse({ ...job, epoch: job.epoch + 1, status: 'canceled', resultId: null, reasonCodes: ['translation_canceled'] });
    this.jobs.set(id, canceled); return structuredClone(canceled);
  }
  invalidate(id: string, bundle: DocumentBundle, versions: DocumentTranslationVersions): DocumentTranslationJob {
    const job = this.get(id);
    let current = false;
    try { current = job.cacheKey === translationCacheKey(translationBinding(bundle, job.binding.sourceChunkIds, versions)); } catch { /* Missing source invalidates. */ }
    if (current) return job;
    this.calls.get(id)?.controller.abort(); const cache = this.caches.get(job.cacheKey);
    if (cache) this.caches.set(job.cacheKey, DocumentTranslationCacheSchema.parse({ ...cache, validity: 'stale', result: { ...cache.result, validity: 'stale' } }));
    const stale = DocumentTranslationJobSchema.parse({ ...job, epoch: job.epoch + 1, status: 'stale', resultId: null, cacheHit: false, reasonCodes: ['translation_binding_changed'] });
    this.jobs.set(id, stale); return structuredClone(stale);
  }
  async run(id: string, bundle: DocumentBundle, options: { signal?: AbortSignal } = {}): Promise<{ job: DocumentTranslationJob; translation: DocumentTranslation | null }> {
    if (this.client.simulated !== true) throw new Error('p2_translation_isolated_simulation_required');
    let job = this.get(id);
    job = this.invalidate(id, bundle, { ...job.binding, clientVersion: this.client.version });
    if (job.status === 'succeeded') return { job, translation: structuredClone(this.caches.get(job.cacheKey)?.result ?? null) };
    if (job.status !== 'queued') return { job, translation: null };
    const epoch = job.epoch, controller = new AbortController(), abort = () => { this.cancel(id); };
    this.calls.set(id, { epoch, controller }); this.jobs.set(id, { ...job, status: 'running' });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const translation = await translateEvidence(bundle, job.binding.sourceChunkIds, this.client, { glossaryVersion: job.binding.glossaryVersion, promptVersion: job.binding.promptVersion, authorized: true, signal: controller.signal });
      const latest = this.get(id);
      if (latest.epoch !== epoch || latest.status !== 'running' || controller.signal.aborted) return { job: latest, translation: null };
      const checked = this.invalidate(id, bundle, { ...job.binding, clientVersion: this.client.version });
      if (checked.status === 'stale') return { job: checked, translation: null };
      const status = translation.status === 'ready' ? 'succeeded' : translation.status;
      const completed = DocumentTranslationJobSchema.parse({ ...latest, status, resultId: translation.id, reasonCodes: translation.coverageGaps });
      if (status === 'succeeded') this.caches.set(job.cacheKey, DocumentTranslationCacheSchema.parse({ schema_version: 'p2.v1', cacheKey: job.cacheKey, binding: job.binding, isolatedReplay: true, simulated: true, validity: 'current', result: translation }));
      this.jobs.set(id, completed); return { job: structuredClone(completed), translation };
    } catch {
      const latest = this.get(id);
      if (latest.epoch !== epoch || latest.status !== 'running') return { job: latest, translation: null };
      const failed = DocumentTranslationJobSchema.parse({ ...latest, status: 'failed', reasonCodes: ['translation_replay_failed'] }); this.jobs.set(id, failed); return { job: structuredClone(failed), translation: null };
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (this.calls.get(id)?.epoch === epoch) this.calls.delete(id);
    }
  }
}
