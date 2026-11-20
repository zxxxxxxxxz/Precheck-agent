import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
import {ServiceError} from '../../../infrastructure/integrations/http.js';

export interface LocalAttachmentPage {blocks:Array<{text:string;nodeId?:string}>;png?:Buffer;coverageGaps:string[]}
function entrypoint(){
  const source=fileURLToPath(import.meta.url).endsWith('.ts');let directory=dirname(fileURLToPath(import.meta.url));
  for(let index=0;index<8;index++){
    const path=resolve(directory,`packages/server/${source?'src':'dist'}/modules/materials/draft-attachments/thread.${source?'ts':'js'}`);
    if(existsSync(path))return {path:pathToFileURL(path).href,source};
    const next=dirname(directory);if(next===directory)break;directory=next;
  }
  throw new ServiceError('attachment_parser_unavailable');
}
export async function parseAttachmentLocal(bytes:Uint8Array,input:{kind:'pdf'|'docx';attachmentId:string;pageNumber?:number;signal?:AbortSignal}):Promise<LocalAttachmentPage>{
  input.signal?.throwIfAborted();const entry=entrypoint();
  const bootstrap=entry.source?`const {workerData}=require('node:worker_threads');import(workerData.tsxApi).then(api=>api.tsImport(workerData.entry,workerData.entry)).catch(()=>require('node:worker_threads').parentPort.postMessage({error:'attachment_parser_unavailable'}));`:`const {workerData}=require('node:worker_threads');import(workerData.entry).catch(()=>require('node:worker_threads').parentPort.postMessage({error:'attachment_parser_unavailable'}));`;
  const worker=new Worker(bootstrap,{eval:true,execArgv:[],stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:384,maxYoungGenerationSizeMb:32},workerData:{kind:input.kind,attachmentId:input.attachmentId,pageNumber:input.pageNumber,bytes:new Uint8Array(bytes),entry:entry.path,...(entry.source?{tsxApi:pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href}:{})}});
  worker.stdout.resume();worker.stderr.resume();
  return new Promise((resolveResult,reject)=>{
    let settled=false;const finish=(error?:Error,result?:LocalAttachmentPage)=>{if(settled)return;settled=true;clearTimeout(timer);input.signal?.removeEventListener('abort',abort);void worker.terminate();error?reject(error):resolveResult(result!);};
    const abort=()=>finish(new ServiceError('attachment_canceled'));const timer=setTimeout(()=>finish(new ServiceError('attachment_parse_timeout')),120000);
    input.signal?.addEventListener('abort',abort,{once:true});
    worker.once('message',(message:{error?:string;result?:LocalAttachmentPage})=>{const result=message.result;finish(message.error||!result?new ServiceError(message.error??'attachment_parse_failed'):undefined,result?{...result,...(result.png?{png:Buffer.from(result.png)}:{})}:undefined);});
    worker.once('error',()=>finish(new ServiceError('attachment_parse_failed')));worker.once('exit',()=>{if(!settled)finish(new ServiceError('attachment_parse_failed'));});
  });
}
