import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Tag} from 'antd';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Link} from 'react-router';
import type {FormalState,FormalJob} from '@hsbc/contracts/formal-review';
import {api,ApiError} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {blocksView,ErrorNotice,Loading,Section} from '../../ui.tsx';
import {FormalResultsTable} from './formal-results-table.tsx';
import {formatTime} from '../../shared/format.ts';
const labels:Record<string,string>={pending:'等待执行',running:'正在审核',completed:'审核已执行，仍须处理问题',failed:'执行失败',unknown:'结果未知',canceled:'已取消',stale:'已失效'};
const errors:Record<string,string>={input_budget_exhausted:'本项原文超出获准的单次处理范围，请联系管理员检查处理额度；未自动扩大出站范围。',egress_denied:'脱敏或出站校验未通过，请检查授权和脱敏服务。',provider_drift:'实际返回的模型与获准配置不一致，结果未被采用。',formal_authorization_required:'正式审核授权未配置、范围不符或已过期。',formal_permission_required:'当前人员没有本案正式审核权限。',formal_pre_review_required:'请先完成本轮程序预审。',formal_no_analyzable_evidence:'缺少可用于正式审核的完整证据，请补齐材料或业务依据。',execution_unknown:'调用结果尚未核实；不会自动重发。',invalid_output:'模型结果未通过完整性或来源校验。',budget_exhausted:'本轮调用额度或速率已达限制。',call_budget_exhausted:'本项重试次数或调用额度已用尽。',formal_source_stale:'来源或配置版本已有变化。',truncated:'模型输出不完整。',refused:'模型未提供可用审核结果。',provider_rejected:'模型服务拒绝了请求，请检查通道配置。'};
export function FormalReviewPanel({caseId,roundId}:{caseId:string;roundId?:string|null}){
 const {session}=useAuth(),client=useQueryClient(),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[notice,setNotice]=useState('');
 const pending=useRef<{path:string;body:unknown}|undefined>(undefined);
 useEffect(()=>{pending.current=undefined;setError(undefined);setNotice('');},[caseId,roundId,session.user?.accountId]);
 const query=useQuery({queryKey:['formal-review',session.user?.accountId,caseId,roundId],queryFn:({signal})=>api<FormalState>(`/api/cases/${caseId}/formal-review${roundId?`?roundId=${encodeURIComponent(roundId)}`:''}`,{signal}),refetchInterval:10000});
 const state=blocksView(query)?undefined:query.data;
 const act=async(action:'start'|'cancel'|'retry'|'reconcile',job?:FormalJob)=>{
  if(!state||busy)return;setBusy(true);setError(undefined);setNotice('');
  const request=pending.current??{path:`/api/cases/${caseId}/formal-review${action==='start'?'':`/${job!.id}/${action}`}`,body:{expectedRevision:state.revision,idempotencyKey:crypto.randomUUID(),...(action==='start'?{runId:state.runId}:{})}};
  pending.current=request;
  try{const response=await api<{reason?:string}>(request.path,{method:'POST',body:JSON.stringify(request.body)});pending.current=undefined;setNotice(response.reason??'操作已记录。');await client.invalidateQueries({queryKey:['formal-review']});await client.invalidateQueries({queryKey:['checker']});await client.invalidateQueries({queryKey:['review-delivery']});}
  catch(e){setError(e);if(e instanceof ApiError&&e.status>=400&&e.status<500)pending.current=undefined;}finally{setBusy(false);}
 };
 const job=state?.jobs[0];
 return <Section title="正式审核" info={<strong>正式审核</strong>} actions={<div className="row-actions"><Button onClick={()=>void query.refetch()} loading={query.isFetching}>刷新状态</Button>{state&&!state.readOnly&&<Button type="primary" loading={busy} disabled={!state.allowedActions.includes('start')||Boolean(pending.current)} onClick={()=>void act('start')}>开始正式审核</Button>}</div>}>
  <ErrorNotice error={query.error} retry={()=>void query.refetch()}/><ErrorNotice error={error}/>
  {pending.current&&!busy&&<Alert type="warning" showIcon title="上次请求是否受理尚未确认" description="请核对上次操作；不会另建一次模型调用。" action={<Button onClick={()=>void act('start')}>核对上次操作</Button>}/>}
  {notice&&<p role="status">{notice}</p>}
  {query.isPending?<Loading label="正在读取正式审核状态"/>:state&&<>
   {state.readOnly&&<p className="help-text">历史轮次或已结束案件只供查看。</p>}
   {state.blockers.length>0&&<Alert type="warning" showIcon title="正式审核尚未满足开始条件" description={<><ul>{state.blockers.map(reason=><li key={reason}>{reason}</li>)}</ul><Link to={`/cases/${caseId}/review?mode=business&tab=checklist${state.roundId?`&round=${state.roundId}`:''}`}>核对完整字段与事实</Link> · <Link to={`/cases/${caseId}/materials${state.roundId?`?round=${state.roundId}`:''}`}>查看材料</Link></>}/>}
   {!job?<p className="help-text">本轮尚未开始正式审核。字段提取、参考翻译和辅助分析分别保留，不计作正式审核完成。</p>:<>
    <div className="checker-actions"><Tag>{labels[job.state]}</Tag><span>已处理 {job.completed} / {job.total} 项 · {formatTime(job.createdAt)}</span>{job.allowedActions.map(action=><Button key={action} loading={busy} disabled={Boolean(pending.current)} onClick={()=>void act(action as 'cancel'|'retry'|'reconcile',job)}>{action==='cancel'?'取消审核':action==='retry'?'重试未完成项':'核对调用结果'}</Button>)}</div>
    {(job.errorCode||job.reason)&&<Alert type="warning" showIcon title={job.reason??errors[job.errorCode!]??'执行未完成，请刷新核对当前权限和来源版本。'}/>}
    <p className="help-text">执行完成不代表业务通过。仍须核对原文、处理问题，并由独立复核人确认；模型不会改写事实或批准例外。</p>
    <FormalResultsTable caseId={caseId} roundId={job.roundId} checks={job.checks} results={job.results} evidence={job.evidence}/>
    <Link to={`/cases/${caseId}/collaboration${state.roundId?`?round=${state.roundId}`:''}`}>查看复核条件及记录处理依据</Link>
   </>}
  </>}
 </Section>;
}
