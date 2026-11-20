import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Button, Checkbox, Progress} from 'antd';
import {DRAFT_ATTACHMENT_LIMITS, type DraftAttachment} from '@hsbc/contracts/draft-attachment';
import type {CaseDraft, DraftSource} from '@hsbc/contracts/draft';
import {api, errorText, newKey} from './api.ts';
import {formatSize} from './shared/format.ts';
import {DOCX_MIME, uploadToOss} from './upload.ts';
import type {UploadTicket} from './features/materials/types.ts';

export const draftAttachmentAccept = '.pdf,.docx,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
function mime(file: File) {const ext = file.name.split('.').pop()?.toLowerCase(); return ext === 'pdf' ? 'application/pdf' : ext === 'docx' ? DOCX_MIME : ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : undefined;}
export function validateDraftAttachment(file: File) {
  const type = mime(file);
  if (!type || file.type && file.type !== type) return '请选择 PDF、DOCX、JPG 或 PNG 文件。';
  const max = type === 'application/pdf' ? DRAFT_ATTACHMENT_LIMITS.pdfBytes : type === DOCX_MIME ? DRAFT_ATTACHMENT_LIMITS.docxBytes : DRAFT_ATTACHMENT_LIMITS.imageBytes;
  if (!file.size) return '文件为空，请重新选择。';
  if (file.size > max) return `此文件超过 ${formatSize(max)}，请缩减后上传。`;
}
type IssueBody = {purpose: 'draft_attachment'; draftId: string; expectedRevision: number; filename: string; size: number; mimeType?: string; source?: DraftSource; idempotencyKey: string};
type Transfer = {issueBody?: IssueBody; ticket?: UploadTicket; id: string; file: File; key: string; uploadId?: string; progress: number; running: boolean; error?: string; select: boolean};
const liveState = (item: DraftAttachment) => !['removed', 'canceled', 'expired'].includes(item.state);
export function useDraftAttachments(draft: CaseDraft | undefined, source: DraftSource | undefined, onDraftChange?: (draft: CaseDraft) => void) {
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const onDraftChangeRef = useRef(onDraftChange); onDraftChangeRef.current = onDraftChange;
  const canceledTransfers = useRef(new Set<string>());
  const filesByUpload = useRef(new Map<string, {file: File; select: boolean}>());
  const controllers = useRef(new Map<string, AbortController>());
  const state = useRef({draft, source, items, transfers}); state.current = {draft, source, items, transfers};
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!draft?.id || state.current.draft?.id !== draft.id) return;
    const gen = generation.current;
    const result = await api<{items: DraftAttachment[]}>(`/api/case-drafts/${draft.id}/attachments`);
    if (generation.current === gen && state.current.draft?.id === draft.id) {setItems(result.items.filter(liveState)); setError(undefined);}
  }, [draft?.id]);
  useEffect(() => {
    generation.current++; canceledTransfers.current.clear(); filesByUpload.current.clear(); setItems([]); setTransfers([]); setSelected([]); setError(undefined);
    if (!draft?.id) return;
    let alive = true; setLoading(true);
    void refresh().catch(failure => {if (alive) setError(failure);}).finally(() => {if (alive) setLoading(false);});
    return () => {alive = false; generation.current++; for (const controller of controllers.current.values()) controller.abort(); controllers.current.clear();};
  }, [draft?.id, refresh]);
  const pending = items.some(item => ['issued', 'verifying'].includes(item.state) || item.parseState === 'running');
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => void refresh().catch(setError), 2000);
    return () => clearInterval(timer);
  }, [pending, refresh]);
  function patch(id: string, patch: Partial<Transfer>) {setTransfers(previous => previous.map(item => item.id === id ? {...item, ...patch} : item));}
  async function start(entry: Transfer) {
    const current = state.current;
    if (!current.draft || current.draft.status !== 'open' || canceledTransfers.current.has(entry.id)) return;
    const gen = generation.current, controller = new AbortController(); controllers.current.set(entry.id, controller);
    const safePatch = (value: Partial<Transfer>) => {if (gen === generation.current) patch(entry.id, value);};
    safePatch({running: true, error: undefined});
    try {
      // Retain exact issuance data across lost responses, edits and retries.
      const issueBody: IssueBody = entry.issueBody ?? {purpose: 'draft_attachment', draftId: current.draft.id, expectedRevision: current.draft.revision, filename: entry.file.name, size: entry.file.size, mimeType: mime(entry.file), source: current.source, idempotencyKey: entry.key};
      safePatch({issueBody});
      let uploadId = entry.uploadId;
      let status = uploadId ? await api<{state: UploadTicket['state']}>(`/api/uploads/${uploadId}`, {signal: controller.signal}) : undefined;
      if (!status || status.state === 'issued') {
        const ticket = await api<UploadTicket>('/api/uploads', {method: 'POST', signal: controller.signal, body: issueBody});
        uploadId = ticket.id; filesByUpload.current.set(uploadId, {file: entry.file, select: entry.select}); safePatch({uploadId, ticket});
        status = ticket;
        if (ticket.state === 'issued') {
          const receipt = await uploadToOss(ticket, entry.file, progress => safePatch({progress}), controller.signal);
          status = await api<{state: UploadTicket['state']}>(`/api/uploads/${uploadId}/complete`, {method: 'POST', body: receipt, signal: controller.signal});
        }
      }
      if (!uploadId || status && ['rejected', 'expired', 'canceled'].includes(status.state)) throw new Error('上传未完成，请移除此记录后重新选择文件。');
      if (gen !== generation.current) return;
      if (entry.select) setSelected(previous => [...new Set([...previous, uploadId!])]);
      setTransfers(previous => previous.filter(item => item.id !== entry.id)); await refresh();
    } catch (failure) {if (!controller.signal.aborted) safePatch({running: false, error: errorText(failure)});}
    finally {if (controllers.current.get(entry.id) === controller) controllers.current.delete(entry.id);}
  }
  async function add(files: File[], select = false) {
    if (!state.current.draft || state.current.draft.status !== 'open') return;
    setError(undefined);
    const current = state.current;
    const counted = current.items.filter(item => item.state !== 'rejected');
    const local = current.transfers.filter(item => !item.uploadId || !counted.some(attachment => attachment.id === item.uploadId));
    const issue = files.map(validateDraftAttachment).find(Boolean);
    if (issue) {setError(new Error(issue)); return;}
    if (counted.length + local.length + files.length > DRAFT_ATTACHMENT_LIMITS.count) {setError(new Error('每份草稿最多上传 20 份附件。')); return;}
    if ([...counted, ...local.map(entry => ({size: entry.file.size})), ...files].reduce((sum, item) => sum + item.size, 0) > DRAFT_ATTACHMENT_LIMITS.totalBytes) {setError(new Error('每份草稿的附件合计不能超过 100 MiB。')); return;}
    const gen = generation.current;
    const entries = files.map(file => ({id: newKey(), file, key: newKey(), progress: 0, running: true, select}));
    setTransfers(previous => [...previous, ...entries]);
    // Sequential tickets avoid races against the per-draft count/byte limits.
    for (const entry of entries) {if (generation.current !== gen || state.current.draft?.id !== current.draft?.id) break; if (!canceledTransfers.current.has(entry.id)) await start(entry);}
  }
  async function cancel(entry: Transfer) {
    const gen = generation.current;
    canceledTransfers.current.add(entry.id);
    controllers.current.get(entry.id)?.abort(); controllers.current.delete(entry.id);
    try {if (entry.uploadId) await api(`/api/uploads/${entry.uploadId}/cancel`, {method: 'POST'}); if (gen !== generation.current) return; setTransfers(previous => previous.filter(item => item.id !== entry.id)); await refresh();} catch (failure) {if (gen === generation.current) patch(entry.id, {running: false, error: errorText(failure)});}
  }
  async function remove(item: DraftAttachment) {
    const gen = generation.current;
    try {await api(`/api/case-drafts/${draft!.id}/attachments/${item.id}/remove`, {method: 'POST', body: {idempotencyKey: newKey()}}); if (gen !== generation.current) return; setSelected(previous => previous.filter(id => id !== item.id)); await refresh(); const next = await api<CaseDraft>(`/api/case-drafts/${draft!.id}`); if (gen === generation.current) onDraftChangeRef.current?.(next);} catch (failure) {if (gen === generation.current) setError(failure);}
  }
  async function retryAttachment(item: DraftAttachment) {
    const cached = filesByUpload.current.get(item.id);
    if (!cached || !draft) return;
    const gen = generation.current;
    try {
      await api(`/api/case-drafts/${draft.id}/attachments/${item.id}/remove`, {method: 'POST', body: {idempotencyKey: newKey()}});
      const next = await api<CaseDraft>(`/api/case-drafts/${draft.id}`);
      if (gen !== generation.current) return;
      state.current.draft = next; onDraftChangeRef.current?.(next);
      await refresh();
      const entry = {id: newKey(), file: cached.file, key: newKey(), progress: 0, running: true, select: cached.select};
      setTransfers(previous => [...previous, entry]); await start(entry);
    } catch (failure) {if (gen === generation.current) setError(failure);}
  }
  const readySelected = selected.filter(id => items.some(item => item.id === id && item.state === 'registered'));
  return {items, transfers, selected, readySelected, setSelected, loading, error, add, remove, cancel, retry: start, retryAttachment, canRetry: (id: string) => filesByUpload.current.has(id), refresh, blocked: loading || transfers.length > 0 || items.some(item => ['issued', 'verifying'].includes(item.state)), toggle: (id: string, checked: boolean) => setSelected(previous => checked ? [...new Set([...previous, id])] : previous.filter(value => value !== id))};
}
export type DraftAttachments = ReturnType<typeof useDraftAttachments>;
const stateText: Record<DraftAttachment['state'], string> = {issued: '等待传输', verifying: '正在校验', registered: '已上传', rejected: '校验未通过', expired: '上传已过期', canceled: '已取消', removed: '已移除', adopted: '已关联案件'};
export function AttachmentList({attachments, draftId, disabled, compact = false, selectable = true, onUse, useDisabled = false}: {attachments: DraftAttachments; draftId: string; disabled: boolean; compact?: boolean; selectable?: boolean; useDisabled?: boolean; onUse?: (id: string) => void}) {
  const {items, transfers} = attachments;
  const shown = compact ? items.filter(item => attachments.selected.includes(item.id)) : items;
  return <div className={`intake-attachments${compact ? ' intake-attachments-compact' : ''}`}>
    {!!attachments.error && <p className="intake-attachment-error" role="alert">{attachments.error instanceof Error ? attachments.error.message : errorText(attachments.error)}</p>}
    {shown.map(item => <div className="intake-attachment" key={item.id}>
      {!compact && selectable && item.state === 'registered' && <Checkbox aria-label={`随消息发送 ${item.filename}`} checked={attachments.selected.includes(item.id)} disabled={disabled} onChange={event => attachments.toggle(item.id, event.target.checked)}/>}
      <div className="intake-attachment-info"><span className="intake-attachment-name" title={item.filename}>{item.filename}</span><span className="intake-attachment-meta">{formatSize(item.size)} · {stateText[item.state]}{item.parseState === 'running' ? ' · 正在读取' : item.parseState === 'ready' ? ' · 已读取' : item.parseState === 'failed' ? ' · 读取失败，可保留原件' : ''}</span></div>
      <div className="intake-attachment-actions">{compact ? <Button type="text" size="small" aria-label={`不发送 ${item.filename}`} disabled={disabled} onClick={() => attachments.toggle(item.id, false)}>×</Button> : <>{item.state === 'registered' && <><a href={`/api/case-drafts/${draftId}/attachments/${item.id}/content`} target="_blank" rel="noreferrer">原件</a>{onUse && <Button type="link" size="small" disabled={disabled || useDisabled} onClick={() => onUse(item.id)}>用于填表</Button>}</>}{item.state === 'rejected' && attachments.canRetry(item.id) && <Button type="text" size="small" disabled={disabled} onClick={() => void attachments.retryAttachment(item)}>重试上传</Button>}<Button type="text" size="small" disabled={disabled} onClick={() => void attachments.remove(item)}>移除</Button></>}</div>
    </div>)}
    {transfers.map(item => <div className="intake-attachment" key={item.id}><div className="intake-attachment-info"><span className="intake-attachment-name">{item.file.name}</span>{item.running ? <Progress percent={item.progress} size="small" aria-label={`${item.file.name}上传进度`}/> : <span className="intake-attachment-error">{item.error}</span>}</div><div className="intake-attachment-actions">{!item.running && <Button type="text" size="small" disabled={disabled} onClick={() => void attachments.retry(item)}>重试</Button>}<Button type="text" size="small" onClick={() => void attachments.cancel(item)}>取消</Button></div></div>)}
  </div>;
}
