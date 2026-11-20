import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DocumentPageArtifactSchema } from '@hsbc/contracts/documents';
import { ServiceError } from '../../../infrastructure/integrations/http.js';
import type { ProcessedDocumentPage, ProcessPageOptions } from './page.js';

export interface ProcessPageIsolatedOptions extends ProcessPageOptions { timeoutMs?: number }
function entrypoint() {
  const source = fileURLToPath(import.meta.url).endsWith('.ts');
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let index = 0; index < 8; index++) {
    const target = resolve(directory, `packages/server/${source ? 'src' : 'dist'}/modules/documents/engine/thread.${source ? 'ts' : 'js'}`);
    if (existsSync(target)) return { path: pathToFileURL(target).href, source };
    const next = dirname(directory); if (next === directory) break; directory = next;
  }
  throw new Error('p2_page_worker_entry_missing');
}
/** Renderer CPU/native memory and diagnostics stay in a disposable worker.
 * Provider calls remain on the parent thread, preserving the caller's authorization/epoch fence. */
export async function processPageIsolated(bytes: Uint8Array, pageNumber: number, options: ProcessPageIsolatedOptions): Promise<ProcessedDocumentPage> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 300000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000) throw new Error('p2_page_worker_timeout_invalid');
  const entry = entrypoint(), require = createRequire(import.meta.url);
  const bootstrap = entry.source
    ? `const {workerData}=require('node:worker_threads'); import(workerData.tsxApi).then(api=>api.tsImport(workerData.entry,workerData.entry)).catch(()=>{require('node:worker_threads').parentPort.postMessage({type:'failure',code:'p2_page_worker_boot_failed'});});`
    : `const {workerData}=require('node:worker_threads'); import(workerData.entry).catch(()=>{require('node:worker_threads').parentPort.postMessage({type:'failure',code:'p2_page_worker_boot_failed'});});`;
  const worker = new Worker(bootstrap, { eval: true, execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32 },
    workerData: { kind: 'p2-page', entry: entry.path, ...(entry.source ? { tsxApi: pathToFileURL(require.resolve('tsx/esm/api')).href } : {}), bytes: new Uint8Array(bytes), pageNumber, scope: options.scope, config: options.config,
      ...(options.ocr ? { ocr: { simulated: options.ocr.simulated ?? false } } : {}),
      ...(options.ner ? { ner: { simulated: options.ner.simulated ?? false, classify: Boolean(options.ner.classify), entities: Boolean(options.ner.entities) } } : {}) },
  });
  worker.stdout.resume(); worker.stderr.resume();
  const requests = new Map<number, AbortController>();
  return new Promise<ProcessedDocumentPage>((resolveResult, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: ProcessedDocumentPage) => {
      if (settled) return; settled = true; clearTimeout(deadline); options.signal?.removeEventListener('abort', abort);
      for (const controller of requests.values()) controller.abort(); requests.clear();
      void worker.terminate().finally(() => error ? reject(error) : resolveResult(value!));
    };
    const abort = () => finish(new Error('p2_page_worker_canceled'));
    const deadline = setTimeout(() => finish(new Error('p2_page_worker_timeout')), timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    worker.on('message', (message: { type?: string; id?: number; method?: string; args?: any; result?: ProcessedDocumentPage; code?: string }) => {
      if (settled) return;
      if (message.type === 'result') {
        try { const { png, ...artifact } = message.result!; const parsed = DocumentPageArtifactSchema.parse(artifact); finish(undefined, { ...parsed, png: Buffer.from(png) }); }
        catch { finish(new Error('p2_page_worker_invalid_result')); }
        return;
      }
      if (message.type === 'failure') { finish(new Error(message.code?.startsWith('p2_') ? message.code : 'p2_page_worker_failed')); return; }
      if (typeof message.id !== 'number') return;
      if (message.type === 'rpc_cancel') { requests.get(message.id)?.abort(); requests.delete(message.id); return; }
      if (message.type !== 'rpc' || requests.has(message.id)) return;
      const id = message.id, controller = new AbortController(); requests.set(id, controller);
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      void (async () => {
        try {
          signal.throwIfAborted(); let result: unknown;
          if (message.method === 'ocr.parse' && options.ocr) result = await options.ocr.parse(new Uint8Array(message.args.image), { returnWordBox: true, signal });
          else if (message.method === 'ner.classify' && options.ner?.classify) result = await options.ner.classify(message.args.text, message.args.labels, { signal });
          else if (message.method === 'ner.entities' && options.ner?.entities) result = await options.ner.entities(message.args.text, message.args.labels, { signal, wordSplitter: message.args.wordSplitter });
          else throw new Error('unsupported_provider_call');
          if (!settled && requests.has(id) && !signal.aborted) worker.postMessage({ type: 'rpc_result', id, result });
        } catch (error) {
          // A rejected capacity request has not produced OCR evidence. Return it
          // to the durable queue instead of checkpointing an unreadable page.
          if (message.method === 'ocr.parse' && error instanceof ServiceError && error.code === 'ocr_busy' && error.retryable) {
            finish(error); return;
          }
          if (!settled && requests.has(id)) worker.postMessage({ type: 'rpc_result', id, error: true });
        }
        finally { requests.delete(id); }
      })();
    });
    worker.once('error', () => finish(new Error('p2_page_worker_failed')));
    worker.once('exit', () => { if (!settled) finish(new Error('p2_page_worker_exited')); });
  });
}
