import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { ServiceError } from '../../../infrastructure/integrations/http.js';

/** Bounded format/readability verification only; no OCR, extraction, or rendering. */
export async function verifyPdf(bytes: Uint8Array, limits: { maxBytes: number; maxPages: number }) {
  if (!bytes.length || bytes.length > limits.maxBytes) throw new ServiceError('upload_size_exceeded');
  if (Buffer.from(bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') throw new ServiceError('upload_not_pdf');
  const pageCount = await new Promise<number>((resolve,reject)=>{
    // Parsing untrusted PDF structures cannot block the HTTP/queue event loop.
    // Bound CPU duration and heap; send only code/count across the thread boundary.
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const {PDFDocument}=require(workerData.library);
      (async()=>{try{
        // Load the envelope only so isEncrypted is reliable with pdf-lib's ES5 Error subclasses.
        // No encrypted page is inspected or accepted.
        const document=await PDFDocument.load(workerData.bytes,{ignoreEncryption:true,updateMetadata:false,throwOnInvalidObject:true});
        if(document.isEncrypted)throw {code:'upload_encrypted_pdf'};
        const pages=document.getPages();
        if(!pages.length||pages.length>workerData.maxPages)throw {code:'upload_page_limit'};
        for(const page of pages){const {width,height}=page.getSize();if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width>100000||height>100000)throw {code:'upload_invalid_pdf'};}
        parentPort.postMessage({pageCount:pages.length});
      }catch(error){parentPort.postMessage({error:error?.name==='EncryptedPDFError'?'upload_encrypted_pdf':error?.code||'upload_invalid_pdf'});}})();
    `,{eval:true,workerData:{bytes:new Uint8Array(bytes),maxPages:limits.maxPages,library:createRequire(import.meta.url).resolve('pdf-lib')},resourceLimits:{maxOldGenerationSizeMb:256,maxYoungGenerationSizeMb:32},stdout:true,stderr:true});
    // Do not forward parser diagnostics: malformed documents can embed original text.
    worker.stdout.resume();worker.stderr.resume();
    const timeout=setTimeout(()=>{void worker.terminate();reject(new ServiceError('upload_pdf_timeout'));},30_000);
    worker.once('message',(result:{pageCount?:number;error?:string})=>{clearTimeout(timeout);void worker.terminate();result.error?reject(new ServiceError(result.error)):resolve(result.pageCount!);});
    worker.once('error',()=>{clearTimeout(timeout);reject(new ServiceError('upload_invalid_pdf'));});
    worker.once('exit',code=>{clearTimeout(timeout);if(code!==0)reject(new ServiceError('upload_invalid_pdf'));});
  });
  return { pageCount, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !match[1] && !match[2]) throw new ServiceError('range_not_satisfiable');
  let start: number, end: number;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new ServiceError('range_not_satisfiable'); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new ServiceError('range_not_satisfiable');
  return { start, end };
}
