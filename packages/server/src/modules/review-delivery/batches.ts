import type {AnalysisBody,MaterialChange,SemanticItem} from '@hsbc/contracts/review-delivery';

export const ANALYSIS_BATCH_SIZE=24;
export const ANALYSIS_ITEM_ATTEMPTS=3;
type Item=SemanticItem|MaterialChange;
export interface AnalysisBatch {
  rootId:string;rootInputHash:string;parentId:string|null;number:number;itemIds:string[];attempts:Record<string,number>;
}
export const analysisItems=(body:AnalysisBody):Item[]=>[...body.items,...body.changes];
// Compatibility is deliberately exact: missing evidence and model-disabled items are never queued.
export const isDeferred=(item:Item)=>item.state==='unavailable'&&(item.deferredReason==='batch_limit'||item.reason==='超过本次 24 项模型调用预算，未完成此项分析。');
export function deferBeyondBatch(body:AnalysisBody){
  for(const item of analysisItems(body).filter(i=>i.state==='pending').slice(ANALYSIS_BATCH_SIZE)){
    item.state='unavailable';item.deferredReason='batch_limit';item.reason='尚未开始，可继续分析剩余项目。';
  }
}
export function initialBatch(body:AnalysisBody,id:string,inputHash:string,attempts=1):AnalysisBatch{
  const itemIds=analysisItems(body).filter(i=>i.state==='pending').map(i=>i.id);
  return {rootId:id,rootInputHash:inputHash,parentId:null,number:1,itemIds,attempts:Object.fromEntries(itemIds.map(id=>[id,attempts]))};
}
export function retryableItems(body:AnalysisBody,batch:AnalysisBatch){
  return analysisItems(body).filter(i=>['pending','failed'].includes(i.state)&&(batch.attempts[i.id]??0)<ANALYSIS_ITEM_ATTEMPTS)
    .sort((a,b)=>Number(b.state==='pending')-Number(a.state==='pending'));
}
export function followupBatch(body:AnalysisBody,batch:AnalysisBatch,parentId:string,action:'continue'|'retry'){
  const selected=(action==='continue'?analysisItems(body).filter(isDeferred):retryableItems(body,batch)).slice(0,ANALYSIS_BATCH_SIZE);
  const ids=new Set(selected.map(i=>i.id));
  const reset=<T extends Item>(item:T):T=>{
    if(!ids.has(item.id))return item.state==='pending'?{...item,state:'failed',reason:'此项未完成，已达到重试上限，请人工核对原文。'}:item;
    const {deferredReason:_,...rest}=item;
    return {...rest,state:'pending',reason:action==='continue'?'等待继续分析。':'等待重试。'} as T;
  };
  return {body:{...body,items:body.items.map(reset),changes:body.changes.map(reset)},batch:{...batch,parentId,number:batch.number+1,itemIds:[...ids],
    attempts:{...batch.attempts,...Object.fromEntries(selected.map(i=>[i.id,(batch.attempts[i.id]??0)+1]))}}};
}
export function analysisProgress(body:AnalysisBody,batch:AnalysisBatch){
  const items=analysisItems(body),deferred=items.filter(isDeferred).length;
  return {total:items.length,complete:items.filter(i=>i.state==='complete').length,pending:items.filter(i=>i.state==='pending').length,
    failed:items.filter(i=>i.state==='failed').length,deferred,unavailable:items.filter(i=>i.state==='unavailable').length-deferred,batchNumber:batch.number,batchSize:ANALYSIS_BATCH_SIZE};
}
