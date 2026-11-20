import React from 'react';
import {useQuery} from '@tanstack/react-query';
import {Link} from 'react-router';
import {mailSummary,type MailDraft,type AnalysisState,type AnalysisJob} from '@hsbc/contracts/review-delivery';
import type {ReviewState} from '@hsbc/contracts/review';
import {api} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {blocksView,ErrorNotice} from '../../ui.tsx';
import {useChecklist} from '../review/checklist-translations.tsx';
import {analysisJobsForRun,consistentFieldKeys,usableAnalysis} from './result-presentation.ts';
import {isGroupedMailTemplate} from '@hsbc/contracts/review-delivery';
import {mailGroupSummary,mailToneLabels} from './mail-preview.tsx';

export function useResultAnalysis(caseId:string,enabled=true){
  const {session}=useAuth();
  const query=useQuery({queryKey:['review-analysis-state',session.user?.accountId,caseId],enabled,queryFn:({signal})=>api<AnalysisState>(`/api/cases/${caseId}/review-delivery/analysis`,{signal}),refetchInterval:15000});
  return {...query,data:enabled&&!blocksView(query)&&query.data?.caseId===caseId?query.data:undefined};
}
export function ResultOverview({state,runId,draft,analysis,reviewPath}:{state:ReviewState;runId:string;draft?:MailDraft;analysis?:AnalysisState;reviewPath:string}){
  const {session}=useAuth(),checklist=useChecklist(state);
  const semanticId=analysisJobsForRun(analysis,runId,'semantic')[0]?.id,comparisonId=analysisJobsForRun(analysis,runId,'comparison')[0]?.id;
  const useRecord=(id:string|undefined)=>useQuery({queryKey:['review-analysis',session.user?.accountId,state.caseId,id],enabled:!!id,queryFn:({signal})=>api<AnalysisJob>(`/api/cases/${state.caseId}/review-delivery/analysis/${id}`,{signal}),refetchInterval:q=>q.state.data&&['pending','running'].includes(q.state.data.state)?5000:false});
  const semantic=useRecord(semanticId),comparison=useRecord(comparisonId);
  const valid=(query:typeof semantic,id:string|undefined)=>!blocksView(query)&&query.data?.id===id&&query.data?.caseId===state.caseId?usableAnalysis(query.data,runId):undefined;
  const s=valid(semantic,semanticId),c=valid(comparison,comparisonId),counts=draft?.runId===runId?mailSummary(draft.body):undefined;
  const fields=!blocksView(checklist)&&checklist.data?.roundId===(state.roundId??null)?checklist.data:undefined;
  const consistent=s&&fields?[...consistentFieldKeys(s.body.items)].filter(key=>fields.rows.some(r=>JSON.stringify([r.objectId,r.fieldId])===key)).length:undefined;
  const items=[[['pre-review-mail.v4','pre-review-mail.v5'].includes(draft?.body.templateVersion??'')?'发现问题（合并后）':'邮件未解决事项',counts?.open,'tone-danger'],[draft?.body.templateVersion==='pre-review-mail.v5'?'需要人工判断':'待确认事项',counts?.confirm,'tone-warning'],...(counts?.incomplete!==undefined?[['检查未完成',counts.incomplete,'']]:[]),['检查无误 / 无需跟进',counts?.done,'tone-success'],[draft?.body.fieldReviewSummary?'已确认字段':'字面不同但无需修改',draft?.body.fieldReviewSummary?.confirmed??'—','tone-success'],[draft?.body.fieldReviewSummary?'核对一致字段':'语义一致字段（建议）',draft?.body.fieldReviewSummary?.consistent??(consistent===undefined?'未分析':`${consistent}${s?.state==='partial'?'（部分）':''}`),'tone-success'],['完整字段清单',fields?.rows.length,''],['跨轮次实质改动',c?`${c.body.changes.filter(x=>x.state==='complete'&&x.classification==='substantive').length} 组${c.state==='partial'?'（部分）':''}`:'未分析','']];
  return <aside className="report-overview" aria-label="本轮预审概览"><h2>本轮预审概览</h2>
    <dl>{items.map(([label,value,tone])=><div key={label}><dt>{label}</dt><dd className={String(tone)}>{value??'—'}</dd></div>)}</dl>
    {draft?.validity==='stale'&&<p className="tone-warning">草稿来源已有更新，统计仅供回看。</p>}
    {!!counts?.incomplete&&<p>仍有检查未完成，当前问题数不代表全部检查通过。</p>}
    {(()=>{
      if(!draft||draft.runId!==runId||draft.format!=='documents'||!isGroupedMailTemplate(draft.body.templateVersion))return null;
      const groups=mailGroupSummary(draft.body),labels=mailToneLabels(draft.body),short={open:labels.open==='发现问题'?'问题':labels.open,confirm:labels.confirm==='需要人工判断'?'人工判断':labels.confirm};
      return groups.length>1&&<nav className="report-overview-groups" aria-label="按文件类型跳转"><h3><span>按文件类型</span><span title={labels.open}>{short.open}</span><span title={labels.confirm}>{short.confirm}</span></h3>
        {groups.map(group=><a key={group.id} href={`#${group.id}`}><span title={group.label}>{group.label.replace(/^文件类型[-－]/,'')}</span><span className={group.open?'tone-danger':'muted'}>{group.open||'—'}</span><span className={group.confirm?'tone-warning':'muted'}>{group.confirm||'—'}</span></a>)}</nav>;
    })()}
    <Link to={reviewPath}>查看完整字段清单</Link>
    <ErrorNotice error={checklist.error??semantic.error??comparison.error}/>
  </aside>;
}
