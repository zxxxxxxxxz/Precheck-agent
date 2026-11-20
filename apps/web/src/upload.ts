import {DRAFT_ATTACHMENT_LIMITS} from '@hsbc/contracts/draft-attachment';
import type {UploadTicket} from './features/materials/types.ts';
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export function validatePdf(file: Pick<File, 'name' | 'size' | 'type'>): string | undefined {
  if (!file.name.toLowerCase().endsWith('.pdf') || (file.type && file.type !== 'application/pdf')) return '请选择 PDF 文件。';
  if (file.size === 0) return '文件为空，请重新选择。';
  if (file.size > MAX_PDF_BYTES) return '文件超过 50 MiB，请缩减后重新上传。';
}
export const MAX_DOCX_BYTES = 25 * 1024 * 1024;
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export function materialMime(file: Pick<File, 'name'>) {
  const extension=file.name.split('.').pop()?.toLowerCase();
  return extension==='png'?'image/png':extension==='jpg'||extension==='jpeg'?'image/jpeg':extension==='docx'?DOCX_MIME:'application/pdf';
}
export function materialAccept(docxEnabled: boolean) {return `application/pdf,.pdf,image/jpeg,image/png,.jpg,.jpeg,.png${docxEnabled?`,${DOCX_MIME},.docx`:''}`;}
export function validateMaterial(file: Pick<File, 'name' | 'size' | 'type'>, docxEnabled: boolean): string | undefined {
  if (file.name.toLowerCase().endsWith('.pdf')) return validatePdf(file);
  const type=materialMime(file);
  if(type==='image/png'||type==='image/jpeg'){
    if(file.type&&file.type!==type)return '图片格式与扩展名不一致，请重新选择。';
    if(file.size===0)return '文件为空，请重新选择。';
    if(file.size>DRAFT_ATTACHMENT_LIMITS.imageBytes)return '图片超过 10 MiB，请缩减后重新上传。';
    return;
  }
  if (!docxEnabled) return '请选择 PDF、JPG 或 PNG 文件。';
  if (!file.name.toLowerCase().endsWith('.docx') || (file.type && file.type !== DOCX_MIME)) return '请选择 PDF、DOCX、JPG 或 PNG 文件。';
  if (file.size === 0) return '文件为空，请重新选择。';
  if (file.size > MAX_DOCX_BYTES) return 'DOCX 文件超过 25 MiB，请缩减后重新上传。';
}
export function uploadToOss(ticket: UploadTicket, file: File, onProgress: (percent: number) => void, signal: AbortSignal): Promise<{versionId?: string; requestId?: string}> {
  return new Promise((resolve, reject) => {
    const host = new URL(ticket.host);
    if (host.protocol !== 'https:' || host.username || host.password) {reject(new Error('上传地址无效')); return;}
    if (signal.aborted) {reject(new DOMException('已取消', 'AbortError')); return;}
    const remaining = new Date(ticket.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {reject(new Error('上传授权已过期，请重新申请。')); return;}
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    for (const [name, value] of Object.entries(ticket.fields)) form.append(name, value);
    form.append('file', file);
    xhr.open('POST', host.toString());
    xhr.withCredentials = false;
    xhr.timeout = Math.min(remaining, 300_000);
    const abort = () => xhr.abort();
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, {once: true});
    xhr.upload.onprogress = event => {if (event.lengthComputable) onProgress(Math.floor(event.loaded / event.total * 100));};
    xhr.onload = () => {cleanup(); if (xhr.status >= 200 && xhr.status < 300) resolve({versionId: xhr.getResponseHeader('x-oss-version-id') ?? undefined, requestId: xhr.getResponseHeader('x-oss-request-id') ?? undefined}); else reject(new Error('文件传输未确认，请查询上传状态。'));};
    xhr.onerror = xhr.ontimeout = () => {cleanup(); reject(new Error('文件传输中断，请查询上传状态。'));};
    xhr.onabort = () => {cleanup(); reject(new DOMException('已取消', 'AbortError'));};
    xhr.send(form);
  });
}
