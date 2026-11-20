import React,{useEffect,useRef,useState} from 'react';
import {Alert,App,Button} from 'antd';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import type {ChecklistRow,CrossFileCheck} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import type {AnalysisState} from '@hsbc/contracts/review-delivery';
import {api,errorText,newKey} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {blocksView} from '../../ui.tsx';
import {semanticTasks,nextSemanticAction} from './cross-file-semantic-queue.ts';
import {semanticTaskProgress} from './semantic-progress-model.ts';
import {SemanticProgressInToolbar} from './semantic-progress.tsx';
import {clearRerun,requestRerun,rerunStatus,rerunnable,useRerunQueue} from './semantic-rerun.ts';

type Task={check:CrossFileCheck;fieldId:string};
type Run={task:Task;action:'start'|'retry'|'rerun'};

/** Whether this reviewer may start AI checks on the current revision. Shares the scheduler's cached read. */
export function useSemanticAnalysisAccess(state:ReviewState,needed:boolean){
  const {session}=useAuth();
  const metadata=useQuery({queryKey:['review-analysis-state',session.user?.accountId,state.caseId,state.revision],enabled:!state.readOnly&&needed,
    queryFn:({signal})=>api<AnalysisState>(`/api/cases/${state.caseId}/review-delivery/analysis`,{signal}),retry:false});
  const enabled=!state.readOnly&&!blocksView(metadata)&&metadata.data?.caseId===state.caseId&&metadata.data.revision===state.revision&&metadata.data.modelEnabled&&metadata.data.allowedActions.includes('review:analyze');
  return {metadata,enabled};
}

/** An editable checklist schedules all eligible fields, one bounded job at a time, then any results the reviewer
 * asked to check again. GET remains read-only. */
export function CorporateSemanticActions({rows,state,progressRows=rows}:{rows:ChecklistRow[];state:ReviewState;progressRows?:ChecklistRow[]}){
  const {session}=useAuth(),{modal}=App.useApp(),cache=useQueryClient(),attempted=useRef(new Set<string>()),rerunInFlight=useRef<string|undefined>(undefined);
  const [failed,setFailed]=useState(false),[rerunErrors,setRerunErrors]=useState<Array<{label:string;error:unknown}>>([]);
  const base=`/api/cases/${state.caseId}/review-delivery/analysis`;
  // Automatic first runs cover this round's scoped rows; a re-check may target any field the reviewer can see.
  const tasks=semanticTasks(rows),allTasks=semanticTasks(progressRows);
  const eligible=tasks.map(t=>t.check);
  const {metadata,enabled}=useSemanticAnalysisAccess(state,allTasks.length>0);
  const queue=useRerunQueue(state.caseId,state.roundId);
  const mutation=useMutation({mutationFn:({task,action}:Run)=>action==='retry'
    ?api<{id:string}>(`${base}/${task.check.semantic!.jobId}/retry`,{method:'POST',body:{expectedRevision:state.revision,idempotencyKey:newKey()}})
    :api<{id:string}>(`${base}/cross-file`,{method:'POST',body:{checkId:task.check.id,fieldId:task.fieldId,expectedRevision:state.revision,idempotencyKey:newKey(),...(action==='rerun'?{rerunOf:task.check.semantic!.jobId}:{})}}),
    retry:false,onSuccess:()=>cache.invalidateQueries({queryKey:['review-checklist',session.user?.accountId,state.caseId]}),
    // A re-check that cannot start is reported on its own and keeps the earlier result; the other queued checks continue.
    onError:(error,run)=>{if(run.action!=='rerun'){setFailed(true);return;}
      clearRerun(state.caseId,state.roundId,[run.task.check.id]);setRerunErrors(current=>[...current,{label:run.task.check.label,error}]);},
    onSettled:()=>{rerunInFlight.current=undefined;}});
  const key=(check:CrossFileCheck)=>JSON.stringify([state.caseId,state.roundId,state.revision,check.id,check.sources,check.semantic?.jobId]);
  const rerunKey=(check:CrossFileCheck)=>`rerun:${queue.get(check.id)?.requestId}:${check.id}`;
  const status=(check:CrossFileCheck)=>check.id===rerunInFlight.current&&queue.has(check.id)?'running':rerunStatus(queue,check);
  const next=tasks.find(({check:c})=>nextSemanticAction(c)&&!attempted.current.has(key(c)));
  const rerunNext=allTasks.find(({check:c})=>status(c)==='queued'&&!attempted.current.has(rerunKey(c)));
  const rerunning=allTasks.some(({check:c})=>status(c)==='queued'||status(c)==='running');
  const busy=mutation.isPending||eligible.some(c=>c.semantic?.state==='pending');
  const rerunBusy=mutation.isPending||allTasks.some(t=>t.check.semantic?.state==='pending');
  useEffect(()=>{
    // Forget finished requests, requests that could not start, and checks that left this round.
    if(queue.size&&!rerunInFlight.current){
      const settled=[...queue.keys()].filter(id=>{const task=allTasks.find(t=>t.check.id===id);
        return !task||status(task.check)==='done'||status(task.check)==='queued'&&attempted.current.has(rerunKey(task.check));});
      if(settled.length){clearRerun(state.caseId,state.roundId,settled);return;}
    }
    if(!enabled)return;
    if(next){if(busy)return;attempted.current.add(key(next.check));mutation.mutate({task:next,action:nextSemanticAction(next.check)!});return;}
    if(!rerunNext||rerunBusy)return;
    attempted.current.add(rerunKey(rerunNext.check));rerunInFlight.current=rerunNext.check.id;
    mutation.mutate({task:{check:rerunNext.check,fieldId:queue.get(rerunNext.check.id)!.fieldId},action:'rerun'});
  });
  const retry=()=>{attempted.current.clear();setFailed(false);mutation.reset();void metadata.refetch();void cache.invalidateQueries({queryKey:['review-checklist',session.user?.accountId,state.caseId]});};
  const candidates=allTasks.filter(t=>rerunnable(t.check));
  const recheck=()=>modal.confirm({title:'重新核对本轮自动核对？',okText:'重新核对',cancelText:'取消',width:480,
    content:`将按当前材料逐项重新执行 ${candidates.length} 个 AI 核对任务。每项开始后显示为核对中，完成后显示新结果；已保存的人工核对记录不变。`,
    onOk:()=>{setRerunErrors([]);requestRerun(state.caseId,state.roundId,candidates);}});
  const queued=[...queue.keys()].filter(id=>{const task=allTasks.find(t=>t.check.id===id);return !!task&&status(task.check)==='queued';});
  const action=state.readOnly||!enabled?null:rerunning
    ?<Button type="link" size="small" className="round-semantic-progress-action" disabled={!queued.length} onClick={()=>clearRerun(state.caseId,state.roundId,queued)}>停止重新核对</Button>
    :candidates.length?<Button type="link" size="small" className="round-semantic-progress-action" disabled={rerunBusy||!!next} onClick={recheck}>重新核对</Button>:null;
  return <>
    {!state.readOnly&&<SemanticProgressInToolbar progress={semanticTaskProgress(progressRows,tasks,queue)} active={busy||!!(enabled&&next)} rerunning={rerunning} action={action} blocked={metadata.isError||failed||!!(metadata.data&&!enabled)}/>}
    {metadata.isError||failed?<Alert type="error" title="部分自动核对未能启动" description="已完成的结果保留。请重试未启动的核对；系统错误不计为人工待办。" action={<Button size="small" onClick={retry}>重试核对</Button>}/>:
      eligible.length&&!state.readOnly&&metadata.data&&!enabled?<Alert type="warning" title="自动语义核对暂不可用" description={metadata.data.modelEnabled?'当前账号无权启动语义核对。':'语义核对服务尚未启用。'}/>:null}
    {!!rerunErrors.length&&<Alert type="warning" showIcon closable={{onClose:()=>setRerunErrors([]),'aria-label':'关闭重新核对提示'}} title={`${rerunErrors.length} 项未能重新核对，原结果保留`}
      description={<ul className="semantic-rerun-errors">{rerunErrors.map(({label,error},index)=><li key={index}>{label}：{errorText(error)}</li>)}</ul>}/>}
  </>;
}
