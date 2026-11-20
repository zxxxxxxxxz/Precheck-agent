import type {AnalysisState,AnalysisJob,SemanticItem} from '@hsbc/contracts/review-delivery';

export function comparisonPair(state:AnalysisState|undefined,runId:string){
  const rounds=(state?.rounds??[]).filter(r=>r.runId&&r.roundId&&!state?.excludedRounds?.some(x=>x.roundId===r.roundId)).toSorted((a,b)=>(b.roundNumber??0)-(a.roundNumber??0));
  const index=rounds.findIndex(r=>r.runId===runId),after=rounds[index],before=rounds[index+1];
  return index>=0&&after&&before?{before,after}:undefined;
}
export function comparisonUnavailableReason(state:AnalysisState|undefined,runId:string){
  const selected=state?.rounds.find(r=>r.runId===runId);
  if(!selected)return '当前执行未关联可比较的轮次结果，请刷新后核对执行记录。';
  if(selected.roundNumber===1)return '首轮无历史可比较';
  const excluded=state?.excludedRounds?.filter(r=>r.roundNumber<(selected.roundNumber??0))??[];
  if(excluded.length)return excluded.map(r=>`第 ${r.roundNumber} 轮${r.reason==='discarded'?'已作废':'尚无预审结果'}`).join('；')+'，暂无可比较的上一轮结果。';
  return '暂无可比较的上一轮预审结果。';
}
export function analysisJobsForRun(state:AnalysisState|undefined,runId:string,kind:'semantic'|'comparison'){
  const pair=comparisonPair(state,runId);
  return state?.jobs.filter(j=>j.kind===kind&&(kind==='semantic'?j.runIds.includes(runId):!!pair&&j.runIds.length===2&&j.runIds[0]===pair.before.runId&&j.runIds[1]===pair.after.runId))??[];
}
export function consistentFieldKeys(items:SemanticItem[]):Set<string>{
  const all=new Map<string,SemanticItem[]>();
  for(const item of items)for(const field of item.fieldIds){const key=JSON.stringify([item.objectId,field]);all.set(key,[...(all.get(key)??[]),item]);}
  return new Set([...all].filter(([,entries])=>entries.every(i=>i.state==='complete'&&!i.deferredReason&&i.kind!=='outside_scope'&&i.method!=='not_run'&&i.outcome==='consistent')).map(([key])=>key));
}
export function usableAnalysis(job:AnalysisJob|undefined,runId:string){
  return job&&job.validity!=='stale'&&['ready','partial'].includes(job.state)&&job.body.runs.some(r=>r.runId===runId)?job:undefined;
}
/** Highlight only exact quotes that the existing analysis associated with this evidence. */
export function quotedSegments(text:string,quotes:string[]):Array<{text:string;marked:boolean}>{
  const spans=quotes.filter(Boolean).flatMap(quote=>{const out:Array<[number,number]>=[];let start=text.indexOf(quote);while(start>=0){out.push([start,start+quote.length]);start=text.indexOf(quote,start+quote.length);}return out;}).sort((a,b)=>a[0]-b[0]);
  const merged:Array<[number,number]>=[];
  for(const span of spans){const last=merged.at(-1);if(last&&span[0]<=last[1])last[1]=Math.max(last[1],span[1]);else merged.push([...span]);}
  const parts:Array<{text:string;marked:boolean}>=[];let cursor=0;
  for(const [start,end] of merged){if(start>cursor)parts.push({text:text.slice(cursor,start),marked:false});parts.push({text:text.slice(start,end),marked:true});cursor=end;}
  if(cursor<text.length)parts.push({text:text.slice(cursor),marked:false});return parts;
}
