import type {DocumentTranslationCommand,DocumentTranslationView} from '@hsbc/contracts/document-translation';
import type {ReviewState} from '@hsbc/contracts/review';
import {segmentFor,type RoundTranslations} from './translation-evidence.ts';

export interface EvidenceTranslationBatch {
  documentId:string;
  command:Omit<DocumentTranslationCommand,'idempotencyKey'>;
  sources:Array<[string,string]>;
  previousJobs:string[];
}
/** Only the selected evidence's fully read targets are supplied here. Existing
 * tasks, including failed/partial/unknown outcomes, are never automatically retried. */
export function nextEvidenceTranslation(state:Pick<ReviewState,'revision'|'roundId'|'readOnly'>,data?:RoundTranslations):EvidenceTranslationBatch|undefined {
  if(!data)return;
  const current=(job:RoundTranslations['documents'][number]['jobs'][number])=>job.sourceCurrent??job.validity==='current';
  if(data.documents.some(d=>d.jobs.some(j=>current(j)&&['pending','running'].includes(j.status))))return;
  for(const d of data.documents){
    const m=d.metadata;
    if(!m.enabled||!m.canCreate||m.caseRevision!==state.revision||m.parseRevision!==d.document.parseRevision||m.directoryRevision!==d.document.directoryRevision)continue;
    const targets=d.targets.filter(t=>t.available&&t.sourceText&&/[a-z]{3,}/iu.test(t.sourceText)&&!segmentFor(d,t)&&!d.jobs.some(j=>current(j)&&j.chunkIds.includes(t.chunkId)))
      .sort((a,b)=>a.chunkId.localeCompare(b.chunkId)).slice(0,m.limits.chunksPerJob);
    if(!targets.length)continue;
    return {documentId:d.document.id,command:{expectedRevision:m.caseRevision,parseRevision:m.parseRevision,expectedDirectoryRevision:m.directoryRevision,
      ...(state.readOnly&&state.roundId?{referenceRoundId:state.roundId}:{}),chunkIds:targets.map(t=>t.chunkId),...(targets.every(t=>t.fieldSource)?{fieldSources:targets.map(t=>t.fieldSource!)}:{}),reason:'生成当前核对段落的中文参考译文，供人工核对'},
      sources:targets.map(t=>[t.chunkId,t.sourceSha256]),previousJobs:d.jobs.filter(j=>!current(j)&&j.chunkIds.some(id=>targets.some(t=>t.chunkId===id))).map(j=>j.jobId).sort()};
  }
}
/** Stable across remounts/reloads: an ambiguous POST cannot create a new request
 * just because the user returned to the same evidence. No material is stored. */
export async function evidenceTranslationCommand(accountId:string,caseId:string,batch:EvidenceTranslationBatch):Promise<DocumentTranslationCommand>{
  const input=new TextEncoder().encode(JSON.stringify(['evidence-translation-v1',accountId,caseId,batch]));
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',input)),byte=>byte.toString(16).padStart(2,'0')).join('');
  return {...batch.command,idempotencyKey:`evidence-${hash}`};
}
export class EvidenceTranslationRequests {
  private readonly requests=new Map<string,Promise<DocumentTranslationView>>();
  submit(key:string,create:()=>Promise<DocumentTranslationView>){
    let request=this.requests.get(key);
    if(!request){request=Promise.resolve().then(create);this.requests.set(key,request);}
    return request;
  }
}

export function withEvidenceTranslationJob(data:RoundTranslations|undefined,batch:EvidenceTranslationBatch,job:DocumentTranslationView):RoundTranslations|undefined {
  if(!data||job.documentId!==batch.documentId||job.caseRevision!==batch.command.expectedRevision||job.parseRevision!==batch.command.parseRevision||job.directoryRevision!==batch.command.expectedDirectoryRevision)return data;
  return {...data,documents:data.documents.map(d=>d.document.id===batch.documentId&&d.metadata.caseRevision===batch.command.expectedRevision&&
    d.document.parseRevision===job.parseRevision&&d.document.directoryRevision===job.directoryRevision?
    {...d,jobs:[job,...d.jobs.filter(j=>j.jobId!==job.jobId)]}:d)};
}
