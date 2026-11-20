import { parentPort, workerData } from 'node:worker_threads';
import { processPage, type DocumentNerAdapter, type DocumentOcrAdapter } from './page.js';
import type { OcrParseResult } from '../../../document/ocr-client.js';
import type { DocumentEngineConfig, DocumentScope } from '@hsbc/contracts/documents';

const port = parentPort;
if (!port || workerData?.kind !== 'p2-page') throw new Error('p2_worker_entry_requires_parent');
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
let sequence = 0;
port.on('message', (message: { type?: string; id?: number; result?: unknown; error?: boolean }) => {
  if (message.type !== 'rpc_result' || typeof message.id !== 'number') return;
  const request = pending.get(message.id); if (!request) return; pending.delete(message.id);
  message.error ? request.reject(new Error('p2_provider_request_failed')) : request.resolve(message.result);
});
async function rpc<T>(method: string, args: unknown, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted(); const id = ++sequence;
  let rejectRequest: ((error: Error) => void) | undefined;
  const abort = () => { pending.delete(id); port!.postMessage({ type: 'rpc_cancel', id }); rejectRequest?.(new Error('p2_provider_request_canceled')); };
  try {
    return await new Promise<T>((resolve, reject) => {
      rejectRequest = reject; pending.set(id, { resolve: value => resolve(value as T), reject });
      signal?.addEventListener('abort', abort, { once: true }); port!.postMessage({ type: 'rpc', id, method, args });
    });
  } finally { signal?.removeEventListener('abort', abort); pending.delete(id); }
}
const data = workerData as { kind: string; bytes: Uint8Array; pageNumber: number; scope: DocumentScope; config?: DocumentEngineConfig; ocr?: { simulated: boolean }; ner?: { simulated: boolean; classify: boolean; entities: boolean } };
const ocr: DocumentOcrAdapter | undefined = data.ocr ? { simulated: data.ocr.simulated, parse: (image, options) => rpc<OcrParseResult>('ocr.parse', { image, returnWordBox: true }, options.signal) } : undefined;
const ner: DocumentNerAdapter | undefined = data.ner ? { simulated: data.ner.simulated,
  ...(data.ner.classify ? { classify: (text: string, labels: string[], options?: { signal?: AbortSignal }) => rpc<{ label: { label: string; confidence: number } }>('ner.classify', { text, labels }, options?.signal) } : {}),
  ...(data.ner.entities ? { entities: (text: string, labels: string[], options?: { signal?: AbortSignal; wordSplitter?: 'whitespace' | 'char' }) => rpc<{ entities: Record<string, Array<{ text: string; confidence: number }>> }>('ner.entities', { text, labels, wordSplitter: options?.wordSplitter }, options?.signal) } : {}),
} : undefined;
try {
  const result = await processPage(data.bytes, data.pageNumber, { scope: data.scope, config: data.config, ocr, ner });
  port.postMessage({ type: 'result', result });
} catch (error) {
  const safe = new Set(['p2_document_hash_mismatch', 'p2_page_out_of_range', 'p2_page_pixel_budget_exceeded', 'p2_page_content_budget_exceeded']);
  port.postMessage({ type: 'failure', code: error instanceof Error && safe.has(error.message) ? error.message : 'p2_page_processing_failed' });
} finally { port.close(); }
