import React,{useEffect,useState} from 'react';
import {Alert,Button,Checkbox,Table,Tag} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {Link,useSearchParams} from 'react-router';
import type {CheckerState,CheckerSubmission} from '@hsbc/contracts/review-checker';
import type {ReviewRoundsState} from '@hsbc/contracts/review-rounds';
import {CaseClosure} from '../review/case-closure.tsx';
import {ReportActions} from './report-actions.tsx';
import {CheckerEntryLoading,useCheckerEntryState} from './checker-entry.tsx';
import {CheckerCompletionActions} from './completion-actions.tsx';
import '../review/round-completion.css';
import type {CaseSummary} from '../cases/types.ts';
import {caseExtractionPath} from '../cases/workspace-navigation.ts';
import {api} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {blocksView,ErrorNotice,Loading,RefreshNotice,Section} from '../../ui.tsx';
import {formatTime} from '../../shared/format.ts';
import {EvidenceLinks} from '../review/evidence-links.tsx';
import type {ReviewEvidence} from '@hsbc/contracts/review';
import {CheckerDialog,type CheckerDialogAction} from './checker-dialog.tsx';
import {SubmissionSnapshot} from './submission-snapshot.tsx';
import {PendingReviewFindings,SubmissionPrerequisites} from './submission-readiness.tsx';
import './checker.css';

function CheckerSection({title,info,...props}:React.ComponentProps<typeof Section>){return <Section {...props} title={title} info={<><strong>{title}</strong>{info}</>}/>;}

export const checkerStatusLabels:Record<string,string>={assignment_required:'待指派复核人',not_submitted:'未提交复核',pending:'待复核',correcting:'复核人更正中',submitted:'待复核',returned:'已退回',confirmed:'本轮已确认',stale:'原提交已失效',withdrawn:'已撤回',terminated:'未完成复核即终止'};
const itemLabels={open:'待经办处理',responded:'已回复，待复核',accepted:'复核人已接受'};
const changeLabels:Record<string,string>={reviewSnapshot:'材料与事实',issues:'问题处置',dispositions:'人工处理依据',mail:'邮件版本',returnItems:'退回事项回复'};

type DisplayedRun={id:string;snapshotHash:string};

/** The report and collaboration routes share the assigned Checker's completion controls. */
export function ReviewReportActions(props:{item:CaseSummary;state?:ReviewRoundsState;displayedRun:DisplayedRun}){
 const {item,state}=props,{session}=useAuth();
 const round=state?.items.find(r=>r.roundId===(item.selectedRoundId??state.currentRoundId));
 const checking=!!round&&['ready','checker_pending','completed'].includes(round.status)&&!item.closure;
 const query=useCheckerEntryState(item.id,round?.roundId,checking);
 if(checking&&(query.error||query.isPending))return <CheckerEntryLoading error={query.error} retry={()=>void query.refetch()}/>;
 const checker=query.data;
 const assigned=checking&&checker?.caseId===item.id&&checker.roundId===round?.roundId&&!!session.user?.personId&&session.user.personId!==item.makerPersonId&&session.user.personId===checker.summary.personId;
 return assigned?<CheckerPanel item={item} compact roundState={state} displayedRun={props.displayedRun}/>:<ReportActions {...props}/>;
}

export function CheckerPanel({item,compact=false,records,roundState,displayedRun}:{item:CaseSummary;compact?:boolean;records?:React.ReactNode;roundState?:ReviewRoundsState;displayedRun?:DisplayedRun}){
 const {session}=useAuth(),[params]=useSearchParams(),round=params.get('round')??item.selectedRoundId??roundState?.currentRoundId??null;
 const [acknowledgedKey,setAcknowledgedKey]=useState('');
 const [dialog,setDialog]=useState<CheckerDialogAction>(),[selected,setSelected]=useState<CheckerSubmission>();
 const query=useQuery({queryKey:['checker',session.user?.accountId,item.id,round],queryFn:({signal})=>api<CheckerState>(`/api/cases/${item.id}/checker${round&&round!=='legacy'?`?roundId=${encodeURIComponent(round)}`:''}`,{signal}),enabled:round!=='legacy',refetchInterval:15000});
 const state=blocksView(query)?undefined:query.data;
 const active=state?.submissions.find(s=>s.roundId===state.roundId&&s.state==='submitted'&&(s.validity==='current'||state.allowedActions.includes('checker:correct')));
 const can=(action:string)=>state?.allowedActions.includes(action);
 const selectedRound=roundState?.items.find(r=>r.roundId===state?.roundId);
 const matchesDisplayedRun=!displayedRun||!!selectedRound&&displayedRun.id===selectedRound.runId&&displayedRun.snapshotHash===selectedRound.snapshotHash&&displayedRun.id===state?.runId;
 const acknowledgementKey=JSON.stringify([session.user?.accountId,item.id,state?.roundId,state?.revision,state?.previewHash,active?.id,active?.version,displayedRun,matchesDisplayedRun]);
 useEffect(()=>setAcknowledgedKey(''),[acknowledgementKey]);
 const acknowledged=matchesDisplayedRun&&acknowledgedKey===acknowledgementKey;
 const hasReviewAction=!state?.readOnly&&(!!active&&!!can('checker:comment')||!!can('checker:editing'));
 const assigned=!!session.user?.personId&&session.user.personId!==item.makerPersonId&&session.user.personId===state?.summary.personId;
 const summary=state&&<dl className={compact?'checker-summary':'case-facts'}>{!compact&&<div><dt>机器预审</dt><dd>查看 <Link to={`/cases/${item.id}/review?mode=business${state.roundId?`&round=${state.roundId}`:''}`}>本轮检查结果</Link></dd></div>}<div><dt>人工复核</dt><dd><Tag>{checkerStatusLabels[state.summary.status]}</Tag></dd></div><div><dt>经办人</dt><dd>{item.makerDisplayName??'尚未指派'}</dd></div><div><dt>复核人</dt><dd>{state.summary.displayName??'尚未指派'}</dd></div>{!compact&&<div><dt>案件</dt><dd>{item.closure?'已结束 · 只读':'进行中'}</dd></div>}</dl>;
 const support=state&&<div className="round-completion-support">
  {can('checker:editing')?<><Link to={`/cases/${item.id}/review?mode=business&tab=checklist&round=${state.roundId}`}>继续修改</Link><Link to={`/cases/${item.id}/reports?round=${state.roundId}`}>核对更正结果</Link></>:active&&can('checker:correct')&&<Button type="link" onClick={()=>setDialog({kind:'correct',submission:active})}>修改审核结果</Button>}
  {active&&<Button type="link" onClick={()=>setSelected(active)}>查看提交版本</Button>}
  {active&&can('checker:comment')&&<Button type="link" onClick={()=>setDialog({kind:'note',submission:active})}>添加复核意见</Button>}
  <details className="checker-reference-links"><summary>查阅材料与字段</summary><div className="checker-links"><Link to={`/cases/${item.id}/review?mode=business&tab=checklist${state.roundId?`&round=${state.roundId}`:''}`}>完整字段与参考译文</Link><Link to={`/cases/${item.id}/materials${state.roundId?`?round=${state.roundId}`:''}`}>材料及原文</Link></div></details>
 </div>;
 const targetText=(target:{kind:string;id?:string},submissionId?:string)=>{
  const snapshot=state?.submissions.find(s=>s.id===submissionId)?.snapshot as any;
  if(target.kind==='case')return '本案审核事项';
  if(target.kind==='material')return snapshot?.sources?.find((d:any)=>d.id===target.id)?.filename??'材料';
  if(target.kind==='mail')return snapshot?.mail?`邮件 · 版本 ${snapshot.mail.version}`:'邮件';
  const entry=target.kind==='field'?snapshot?.reviewSnapshot?.facts?.find((f:any)=>f.factId===target.id):snapshot?.results?.find((r:any)=>r.evaluationId===target.id);
  const object=snapshot?.reviewSnapshot?.objects?.find((o:any)=>o.objectId===(entry?.objectId??entry?.scopeId));
  const label=target.kind==='field'?snapshot?.configuration?.fields?.find((f:any)=>f.id===entry?.fieldId)?.label:snapshot?.configuration?.rules?.find((r:any)=>r.id===entry?.ruleId)?.label??state?.findings.find(f=>f.id===target.id)?.label;
  return [object?.label,label??(target.kind==='field'?'已确认字段':'检查项')].filter(Boolean).join(' · ');
 };
 if(round==='legacy')return <><CheckerSection title="独立复核"><p>历史未分轮记录仅供回查，不补记复核确认。</p></CheckerSection>{records}</>;
 return <div className={`checker-panel${compact?' checker-panel-compact':''}`}><Section title="独立复核" info={!compact&&<strong>独立复核</strong>} actions={state&&(can('checker:assign')||!state.readOnly&&can('checker:prepare-submit'))&&<div className="row-actions">
  {can('checker:assign')&&<Button onClick={()=>setDialog({kind:'assign'})}>{state.summary.personId?'改派复核人':'指派复核人'}</Button>}
  {!state.readOnly&&can('checker:prepare-submit')&&<Button type="primary" disabled={!can('checker:submit')} onClick={()=>setDialog({kind:'submit'})}>提交复核</Button>}
 </div>}>
  <ErrorNotice error={query.error} retry={()=>void query.refetch()}/>{query.isPending?<Loading label="正在读取复核状态"/>:state&&<>
   <RefreshNotice query={query} retry={()=>void query.refetch()}/>
   {compact&&assigned&&!state.readOnly&&selectedRound&&roundState?<CheckerCompletionActions item={item} state={state} round={selectedRound} rounds={roundState} displayedRun={displayedRun??{id:selectedRound.runId??'',snapshotHash:selectedRound.snapshotHash??''}}/>:compact&&state.summary.status==='confirmed'&&selectedRound&&roundState?<ReportActions item={item} state={roundState} displayedRun={{id:selectedRound.runId??'',snapshotHash:selectedRound.snapshotHash??''}}/>:<>
   <div className="round-completion">
    <div className="round-completion-copy">
     <h3>{selectedRound?`第 ${selectedRound.roundNumber} 轮复核`:active?`第 ${active.roundNumber} 轮复核`:'独立复核'}</h3>
     {!compact&&summary}
     {compact&&!state.readOnly&&<p>{hasReviewAction?'核对本轮预审结果及邮件草稿后，可确认结束本轮；未解决事项保留至后续轮次。':checkerStatusLabels[state.summary.status]}</p>}
     {state.readOnly?<Alert type="info" showIcon title="历史轮次或已结束案件只供回查"/>:<>
      {state.blockers.length>0&&<details className="checker-blockers" open><summary>{active||can('checker:editing')?'结束本轮':'提交'}前还需准备 {state.blockers.length} 项</summary><SubmissionPrerequisites caseId={item.id} roundId={state.roundId??''} blockers={state.blockers}/></details>}
      {!compact&&<PendingReviewFindings items={state.outstandingFindings??[]} submitted={['pending','correcting','confirmed','stale'].includes(state.summary.status)}/>}
     </>}
     {hasReviewAction&&<Checkbox checked={acknowledged} disabled={!matchesDisplayedRun} onChange={event=>setAcknowledgedKey(event.target.checked?acknowledgementKey:'')}>我已核对本轮审核结果及邮件草稿。</Checkbox>}
     {hasReviewAction&&!matchesDisplayedRun&&<p role="status">正在同步最新预审结果，完成后可确认。</p>}
     {!compact&&hasReviewAction&&<p className="round-completion-note">结束本轮仅确认本轮复核，未解决事项保留。</p>}
    </div>
    <div className="round-completion-actions">
     {can('checker:editing')?<Button disabled={!acknowledged||!can('checker:confirm-correction')} onClick={()=>setDialog({kind:'confirm-correction'})}>结束本轮</Button>:active&&can('checker:comment')&&<Button disabled={!acknowledged||!can('checker:confirm')} onClick={()=>setDialog({kind:'confirm',submission:active})}>结束本轮</Button>}
     {!state.readOnly&&hasReviewAction&&<CaseClosure item={item} compact disabled/>}
    </div>
   </div>
   </>}
   {!compact&&support}
  </>}
 </Section>
 {state&&<>
  <details className="checker-supporting" open={compact?undefined:true}><summary>复核意见与记录</summary>
  {compact&&<div className="checker-supporting-overview">{summary}<PendingReviewFindings items={state.outstandingFindings??[]} submitted={['pending','correcting','confirmed','stale'].includes(state.summary.status)}/>{support}</div>}
  {state.items.length>0&&<CheckerSection title="历史退回记录" info={<span>{state.items.length} 项</span>}>
   {state.items.map(i=><article className="checker-record" key={i.id}><div className="checker-record-head"><strong>{targetText(i.target,i.submissionId)}</strong><Tag>{itemLabels[i.status]}</Tag></div><p>{i.text}</p>{i.roundId!==state.roundId&&<Link to={`/cases/${item.id}/collaboration?round=${i.roundId}`}>查看原退回轮次及对应事项</Link>}{i.responses.map(r=><div className="checker-response" key={r.id}><span>{r.actorName} · {formatTime(r.createdAt)} · {r.kind==='response'?'处理回复':r.kind==='accepted'?'接受处理':'仍需处理'}</span><p>{r.text}</p>{r.evidence.length>0&&<EvidenceLinks caseId={item.id} roundId={i.roundId} evidence={r.evidence as ReviewEvidence[]}/>}</div>)}</article>)}
  </CheckerSection>}
  <CheckerSection title="人工处置与专业意见" actions={!state.readOnly&&(can('finding:decide')||can('consultation:record')||can('exception:decide'))&&<Button disabled={!state.runId||!state.findings.length} onClick={()=>setDialog({kind:'disposition'})}>记录处理依据</Button>}>
   <p className="help-text">保留原始检查结论。已知悉不等于已解决；专业意见需记录来源并核实。例外规则尚未确定时，登记不会将检查项改为已解决。</p>
   {!state.dispositions.length?<p className="muted">暂无处理依据</p>:state.dispositions.map(d=><article className="checker-record" key={d.id}><strong>{state.findings.find(f=>f.id===d.findingId)?.label??d.ruleId}</strong><p>{({manual_satisfied:'人工判断',professional_opinion:'专业意见',exception:'例外决定记录'} as Record<string,string>)[d.kind]} · {d.authorName} · {formatTime(d.createdAt)} · {d.verified?'已核实来源':'来源未核实'}</p><p>{d.reason}</p>{d.externalAuthor&&<p>外部作者：{d.externalAuthor} · 来源：{d.source} · 收到：{formatTime(d.receivedAt!)}</p>}{d.validUntil&&<p>有效至：{formatTime(d.validUntil)} · 附加条件：{d.conditions}</p>}<EvidenceLinks caseId={item.id} roundId={state.roundId} evidence={d.evidence as ReviewEvidence[]}/></article>)}
  </CheckerSection>
  <CheckerSection title="复核提交记录" flush>
   <Table<CheckerSubmission> rowKey="id" size="small" dataSource={state.submissions} pagination={{pageSize:8,hideOnSinglePage:true}} scroll={{x:850}} locale={{emptyText:'尚无复核提交记录'}} columns={[
    {title:'轮次 / 提交',key:'number',render:(_,s)=>`第 ${s.roundNumber} 轮 · 第 ${s.number} 次提交`},
    {title:'状态',key:'state',render:(_,s)=>s.validity==='stale'?`${checkerStatusLabels[s.state]} · ${s.state==='confirmed'?'不适用当前版本':'原提交已失效'}`:checkerStatusLabels[s.state]},
    {title:'经办 / 复核',key:'people',render:(_,s)=>`${s.makerName} / ${s.checkerName}`},
    {title:'提交时间',key:'time',render:(_,s)=>formatTime(s.createdAt)},
    {title:'较上次提交',key:'changes',render:(_,s)=>s.changes.map(k=>changeLabels[k]).join('、')||'无新增内容'},
    {title:'记录',key:'open',render:(_,s)=><Button type="link" onClick={()=>setSelected(s)}>查看固定版本</Button>},
   ]}/>
  </CheckerSection>
  {state.notes.length>0&&<CheckerSection title="复核意见">{state.notes.map(n=><article className="checker-record" key={n.id}><strong>{targetText(n.target,n.submissionId)}</strong><p>{n.text}</p><span className="muted">{n.actorName} · {formatTime(n.createdAt)} · 第 {state.submissions.find(s=>s.id===n.submissionId)?.number} 次提交</span></article>)}</CheckerSection>}
  {can('checker:terminate')&&<CheckerSection title="提前结束"><p className="help-text">无法继续的案件可以记录原因并终止；会明确标记“未完成复核即终止”，不作为审核完成。材料处理中的任务须先取消或处理完毕。</p><Button danger onClick={()=>setDialog({kind:'terminate'})}>未完成复核即终止</Button></CheckerSection>}
  {records}
  </details>
  {dialog&&<CheckerDialog key={JSON.stringify(dialog)} action={dialog} state={state} close={()=>setDialog(undefined)}/>}
  {selected&&<SubmissionSnapshot caseId={item.id} submission={selected} close={()=>setSelected(undefined)}/>}
 </>}
 </div>;
}

export function CheckerInbox(){
 const {session}=useAuth();
 const query=useQuery({queryKey:['checker-inbox',session.user?.accountId],queryFn:({signal})=>api<{items:Array<{id:string;title:string;reference:string|null;roundId:string}>}>('/api/checker/inbox',{signal}),enabled:session.allowed_actions.includes('checker:read'),refetchInterval:15000});
 if(!session.allowed_actions.includes('checker:read'))return null;
 return <CheckerSection title="待我复核" info={!blocksView(query)&&query.data&&<span>（{query.data.items.length} 个案件）</span>} className={!blocksView(query)&&query.data&&!query.data.items.length?'checker-inbox-empty':undefined} actions={<Link to="/cases">全部案件</Link>}><ErrorNotice error={query.error} retry={()=>void query.refetch()}/>{query.isPending?<Loading/>:!blocksView(query)&&query.data&&<>{query.data.items.length?<ul className="checker-inbox">{query.data.items.map(i=><li key={i.id}><Link to={caseExtractionPath(i.id,i.roundId)}>{i.title}</Link><span>{i.reference}</span></li>)}</ul>:<p className="help-text">暂无有效的待复核提交。指派后仍需经办人满足条件并提交。</p>}</>}</CheckerSection>;
}
