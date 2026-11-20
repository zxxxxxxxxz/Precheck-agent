import React,{useEffect,useRef,useState} from 'react';
import {Link} from 'react-router';
import {Button,Checkbox,Modal} from 'antd';
import type {ReviewRoundsState} from '@hsbc/contracts/review-rounds';
import type {CaseSummary} from '../cases/types.ts';
import {useAuth} from '../../auth.tsx';
import {api,ApiError,newKey,queryClient} from '../../api.ts';
import {ErrorNotice} from '../../ui.tsx';
import {RoundControls,refreshRounds} from '../review/round-controls.tsx';
import {CaseClosure} from '../review/case-closure.tsx';
import {reviewSubmissionPlan,submissionBlockers,submitReview,type ReviewSubmissionPlan} from './submit-review.ts';
import {SubmissionPrerequisites} from './submission-readiness.tsx';
import {checkerEntry,CheckerEntryContent,CheckerEntryLoading,useCheckerEntryState} from './checker-entry.tsx';

type Props={item:CaseSummary;state?:ReviewRoundsState;displayedRun:{id:string;snapshotHash:string}};
export function ReportActions(props:Props){
 const {item,state}=props,{session}=useAuth(),[acknowledgedKey,setAcknowledgedKey]=useState('');
 const round=state?.items.find(r=>r.roundId===(item.selectedRoundId??state.currentRoundId));
 const current=!!round&&round.roundId===state?.currentRoundId&&!item.closure;
 const eligible=current&&!state?.checkerCorrection&&['ready','checker_pending'].includes(round!.status);
 const query=useCheckerEntryState(item.id,round?.roundId,eligible);
 const checker=query.error?undefined:query.data;
 const entry=eligible&&round?checkerEntry(item,round,checker,session.user?.personId):null;
 const complete=current&&round?.status==='completed';
 const correcting=current&&state?.checkerCorrection&&round?.allowedActions.includes('round:confirm');
 const canClose=current&&item.allowed_actions.includes('case:close');
 const needsAcknowledgement=entry?.kind==='submit'||correcting||complete&&canClose;
 const acknowledgementKey=JSON.stringify([session.user?.accountId,item.id,round?.roundId,state?.revision,round?.status,props.displayedRun,eligible?checker?.revision:null]);
 useEffect(()=>setAcknowledgedKey(''),[acknowledgementKey]);
 const acknowledged=acknowledgedKey===acknowledgementKey;
 const description=item.closure?'案件已完结，可查看各轮材料、审核结果与操作记录。':!current?'历史轮次仅供查看。':complete?`如需补件复审，请在同一案件号下准备第 ${Math.max(0,...state!.items.map(r=>r.roundNumber))+1} 轮；如无需继续，可手动完结案件。`:state?.checkerCorrection?'更正后请核对最新预审结果，再返回独立复核结束本轮。':entry?.kind==='waiting'?`初审结果已提交给${checker?.summary.displayName??'复核人'}，等待复核确认。复核确认或退回后，本页和案件列表的状态会随之更新。`:entry?.kind==='submit'?'核对预审结果及邮件草稿后提交复核，复核人确认后本轮结束。':'请先核对本轮结果及复核准备情况。';
 const completionContent=<><p>{description}{entry?.kind==='waiting'&&<> <Link to="/cases">返回案件列表</Link></>}</p>{needsAcknowledgement&&<Checkbox checked={acknowledged} onChange={event=>setAcknowledgedKey(event.target.checked?acknowledgementKey:'')}>{complete?'我已核对预审结果及邮件草稿，并确认本案可以完结。':state?.checkerCorrection?'我已核对本轮更正结果。':'我已核对本轮预审结果及邮件草稿。'}</Checkbox>}</>;
 return <RoundControls {...props} compact actionsOnly completionContent={completionContent} confirmationDisabled={!acknowledged}
  reviewAction={state?.checkerCorrection?undefined:<SubmitReview key={`${item.id}:${round?.roundId}:${props.displayedRun.id}`} {...props} acknowledged={acknowledged}/>}
  primaryAction={item.closure||canClose?<CaseClosure item={item} compact disabled={!complete||!acknowledged}/>:undefined}/>;
}
function SubmitReview({item,state:rounds,displayedRun,acknowledged}:Props&{acknowledged:boolean}){
 const {session}=useAuth(),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[conflict,setConflict]=useState(false);
 const plan=useRef<ReviewSubmissionPlan|undefined>(undefined);
 const round=rounds?.items.find(r=>r.roundId===(item.selectedRoundId??rounds.currentRoundId));
 const eligible=!!round&&!item.closure&&round.roundId===rounds?.currentRoundId&&['ready','checker_pending'].includes(round.status);
 const query=useCheckerEntryState(item.id,round?.roundId,eligible);
 const state=query.error?undefined:query.data;
 if(!eligible||!round||!rounds)return null;
 if(query.error||query.isPending)return <CheckerEntryLoading error={query.error} retry={()=>void query.refetch()}/>;
 const entry=checkerEntry(item,round,state,session.user?.personId);
 if(!entry)return null;
 if(entry.kind!=='submit')return <CheckerEntryContent entry={entry}/>;
 const blockers=state?submissionBlockers(state,round,displayedRun):[];
 const finish=async()=>{
  if(busy)return;
  if(conflict){setOpen(false);setConflict(false);void query.refetch();return;}
  if(!state||(!plan.current&&(!acknowledged||blockers.length)))return;
  setBusy(true);setError(undefined);
  try{
   plan.current??=reviewSubmissionPlan(state,round,rounds,displayedRun,'经办提交本轮审核结果供独立复核',newKey);
   await submitReview(plan.current,api);
   await Promise.all([refreshRounds(item.id),queryClient.invalidateQueries({queryKey:['checker']}),queryClient.invalidateQueries({queryKey:['checker-inbox']}),queryClient.invalidateQueries({queryKey:['review-delivery']})]);
   plan.current=undefined;setOpen(false);
  }catch(e){setError(e);if(e instanceof ApiError&&e.status>=400&&e.status<500){setConflict(true);plan.current=undefined;}}finally{setBusy(false);}
 };
 const prerequisites=blockers.map(label=>state?.blockers.find(b=>b.label===label)??{code:'preview_changed',label});
 const needsPreparation=!plan.current&&!conflict&&(!state||blockers.length>0);
 return <><Button disabled={query.isPending||!acknowledged} onClick={()=>{setOpen(true);setError(undefined);setConflict(false);}}>完成初审并提交</Button>{open&&(needsPreparation?<Modal open title="提交复核前还需准备" width={640} onCancel={()=>setOpen(false)} footer={<Button onClick={()=>setOpen(false)}>返回预审结果</Button>} styles={{body:{maxHeight:'calc(100vh - 240px)',overflowY:'auto'}}}>
  <ErrorNotice error={query.error} retry={()=>void query.refetch()}/>
  {prerequisites.length>0&&<><p>请完成以下 {prerequisites.length} 项准备，再提交给独立复核人。</p><SubmissionPrerequisites caseId={item.id} roundId={round.roundId} blockers={prerequisites} onNavigate={()=>setOpen(false)}/></>}
 </Modal>:<Modal open title="提交本轮复核？" width={520} okText={conflict?'关闭并刷新':plan.current?'核对上次提交':'确认提交'} cancelText="取消" confirmLoading={busy} closable={!busy} keyboard={!busy} mask={{closable:false}} cancelButtonProps={{disabled:busy}} onCancel={()=>setOpen(false)} onOk={()=>void finish()}>
  <ErrorNotice error={query.error} retry={()=>void query.refetch()}/><ErrorNotice error={error}/>
  <p>将第 {round.roundNumber} 轮审核结果提交给{state?.summary.displayName??'独立复核人'}审核，未解决事项一并保留。</p>
 </Modal>)}</>;
}
