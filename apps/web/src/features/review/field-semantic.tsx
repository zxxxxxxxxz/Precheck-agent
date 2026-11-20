import React from 'react';
import {useQuery} from '@tanstack/react-query';
import type {ReviewState} from '@hsbc/contracts/review';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {AnalysisJob,AnalysisState} from '@hsbc/contracts/review-delivery';
import {api} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {blocksView,ErrorNotice} from '../../ui.tsx';
import {fieldSemanticItems} from './field-desk-presentation.ts';
import {analysisReason,AnalysisEvidenceView} from '../review-delivery/analysis-panel.tsx';

export function FieldSemantic({state,row}:{state:ReviewState;row:ChecklistRow}) {
  const {session}=useAuth(),run=state.runs[0],base=`/api/cases/${state.caseId}/review-delivery/analysis`;
  const query=useQuery({queryKey:['review-analysis-state',session.user?.accountId,state.caseId],enabled:!!run,queryFn:({signal})=>api<AnalysisState>(base,{signal}),refetchInterval:15000});
  const metadata=!blocksView(query)&&query.data?.caseId===state.caseId?query.data:undefined;
  // Disabled queries can still expose the results page's case-level cache.
  const id=run?metadata?.jobs.find(j=>j.kind==='semantic'&&j.runIds.includes(run.id))?.id:undefined;
  const record=useQuery({queryKey:['review-analysis',session.user?.accountId,state.caseId,id],enabled:!!id,queryFn:({signal})=>api<AnalysisJob>(`${base}/${id}`,{signal}),refetchInterval:q=>q.state.data&&['pending','running'].includes(q.state.data.state)?2000:false});
  const job=metadata&&!blocksView(record)&&record.data&&record.data.id===id&&record.data.caseId===state.caseId&&record.data.kind==='semantic'&&record.data.body.runs.some(r=>r.runId===run?.id)?record.data:undefined;
  const items=job?fieldSemanticItems(job.body.items,row):[];
  if (!run || (!items.length && !query.error && !record.error)) return null;
  return <section className="field-judgment"><h4>语义分析建议</h4><ErrorNotice error={query.error??record.error} retry={()=>{void query.refetch();if(id)void record.refetch();}}/>
    {(query.isFetching&&!metadata||id&&record.isPending)&&<p role="status">正在读取已有分析…</p>}
    {job?.validity==='stale'&&<p className="tone-warning">分析依据已变化，仅供回查，不能作为当前有效建议。</p>}
    {job?.validity==='history'&&<p className="muted">以下为所选轮次的历史分析。</p>}
    {job?.simulated&&<p className="tone-warning">包含模拟分析，仅用于功能验证。</p>}
    {items.map(i=><article key={i.id}><strong>{i.ruleLabel}</strong><p>{i.deferredReason==='batch_limit'?'待继续分析':i.state!=='complete'?{pending:'等待分析',unavailable:'暂不可分析',failed:'分析失败'}[i.state]:{consistent:'建议一致',different:'建议存在差异',insufficient:'证据不足',manual:'待确认条件'}[i.outcome]} · {i.method==='model'?'模型建议':i.method==='program'?'程序检查':'尚未分析'}</p><p>{analysisReason(i.reason)}</p>{i.limitations.map((v,n)=><p className="tone-warning" key={n}>{v}</p>)}<details><summary>核对分析依据</summary>{i.confirmedInputs.map((v,n)=><p key={n}>{v.label}：{String(v.value??'未提供')} · {v.state}</p>)}{i.citations.map((c,n)=><blockquote key={n}>{c.quote}</blockquote>)}<AnalysisEvidenceView caseId={state.caseId} items={job!.body.evidence.filter(e=>i.evidenceIds.includes(e.id))}/></details></article>)}
  </section>;
}
