import type {ReviewEvidence} from '@hsbc/contracts/review';
import {ApiError} from '../../api.ts';
import {translationApi,translationBase} from '../documents/translation/api.ts';
import {FullTextTranslation,type FullTextSnapshot} from '../documents/translation/full-text.ts';

export interface FullOriginalScope {caseId:string;source:ReviewEvidence;referenceRoundId?:string}
export interface FullOriginalResult {snapshot:FullTextSnapshot;translationError?:unknown}
/** The source is pinned to the evidence, never to the document's latest parse. */
export async function loadFullOriginal(scope:FullOriginalScope,signal:AbortSignal,transport=translationApi):Promise<FullOriginalResult> {
  const {caseId,source,referenceRoundId}=scope;
  const base=translationBase(caseId,source.documentVersionId);
  const first=await transport.targets(base,source.parseRevision,0,signal,referenceRoundId,true);
  if(first.parseRevision!==source.parseRevision||(source.directoryRevision!==null&&first.directoryRevision!==source.directoryRevision))
    throw new ApiError(409,'evidence_version_mismatch','原文版本已变化，请刷新页面后重新打开全文。');
  let translationError:unknown;
  const readOnly=async():Promise<never>=>{throw new Error('全文阅读不会发起翻译任务。');};
  const session=new FullTextTranslation({caseId,documentId:source.documentVersionId,parseRevision:source.parseRevision,
    caseRevision:first.caseRevision,directoryRevision:first.directoryRevision},{
    targets:(offset,signal)=>offset===0?Promise.resolve(first):transport.targets(base,source.parseRevision,offset,signal,referenceRoundId,true),
    history:async(chunks,signal)=>{
      if(translationError)return {items:[]};
      try{return await transport.history(base,source.parseRevision,signal,chunks);}
      catch(error){
        if(signal.aborted||(error instanceof ApiError&&[401,403].includes(error.status)))throw error;
        translationError=error;return {items:[]};
      }
    },get:readOnly,create:readOnly,key:()=>'',wait:readOnly,
  });
  const snapshot=await session.load(signal);
  signal.throwIfAborted();
  return {snapshot,translationError};
}
