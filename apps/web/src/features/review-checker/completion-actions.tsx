import React,{useEffect,useState} from 'react';
import {Button,Checkbox,Modal} from 'antd';
import {useNavigate} from 'react-router';
import type {CheckerState} from '@hsbc/contracts/review-checker';
import type {ReviewRound,ReviewRoundsState} from '@hsbc/contracts/review-rounds';
import type {CaseSummary} from '../cases/types.ts';
import {caseMaterialsPath} from '../cases/workspace-navigation.ts';
import {useAuth} from '../../auth.tsx';
import {api,ApiError,newKey,queryClient} from '../../api.ts';
import {ErrorNotice} from '../../ui.tsx';
import {refreshRounds} from '../review/round-controls.tsx';
import {SubmissionPrerequisites} from './submission-readiness.tsx';
import {completionReady,reviewCompletionPlan,prepareReviewedRound,previewReviewedClosure,closeReviewedCase,type ReviewCompletionPlan} from './complete-review.ts';
import {acknowledgementComplete,emptyAcknowledgement} from '../review/closure-confirmation.ts';
import {ClosureAcknowledgementFields} from '../review/closure-acknowledgement.tsx';

export function CheckerCompletionActions({item,state,round,rounds,displayedRun}:{item:CaseSummary;state:CheckerState;round:ReviewRound;rounds:ReviewRoundsState;displayedRun:{id:string;snapshotHash:string}}){
 const {session}=useAuth(),navigate=useNavigate();
 const [acknowledgedKey,setAcknowledgedKey]=useState(''),[command,setCommand]=useState<{kind:'next'|'close';nextNumber:number;plan:ReviewCompletionPlan}>(),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[conflict,setConflict]=useState(false),[closing,setClosing]=useState(emptyAcknowledgement);
 const acknowledgementKey=JSON.stringify([session.user?.accountId,item.id,round.roundId,state.revision,state.previewHash,displayedRun]);
 useEffect(()=>setAcknowledgedKey(''),[acknowledgementKey]);
 const acknowledged=acknowledgedKey===acknowledgementKey;
 const ready=completionReady(state,round,rounds,displayedRun)&&!item.closure;
 const nextNumber=Math.max(...rounds.items.map(r=>r.roundNumber))+1;
 const nextAllowed=ready&&(round.status!=='completed'||rounds.allowedActions.includes('round:create'));
 const canClose=item.allowed_actions.includes('case:close');
 const blockers=state.blockers.filter(b=>!(rounds.checkerCorrection&&round.allowedActions.includes('round:confirm')&&b.code==='checker_result_required'));
 const refresh=()=>Promise.all([refreshRounds(item.id),queryClient.invalidateQueries({queryKey:['checker']}),queryClient.invalidateQueries({queryKey:['checker-inbox']}),queryClient.invalidateQueries({queryKey:['review-delivery']})]);
 const open=(kind:'next'|'close')=>{setError(undefined);setConflict(false);setClosing(emptyAcknowledgement());try{setCommand({kind,nextNumber,plan:reviewCompletionPlan(state,round,rounds,displayedRun,newKey)});}catch(e){setError(e);}};
 const cancel=()=>{setCommand(undefined);setError(undefined);setConflict(false);void refresh();};
 const finish=async()=>{
  if(!command||busy)return;
  if(conflict){cancel();return;}
  setBusy(true);setError(undefined);
  try{
   if(command.kind==='next'){
    const result=await prepareReviewedRound(command.plan,api);
    setCommand(undefined);navigate(caseMaterialsPath(item.id,result.commandRoundId));void refresh();
   }else if(!command.plan.preview){await previewReviewedClosure(command.plan,api);await refresh();}
   else{if(!acknowledgementComplete(command.plan.preview,closing))return;await closeReviewedCase(command.plan,api,closing);await refresh();setCommand(undefined);}
  }catch(e){setError(e);if(e instanceof ApiError&&e.status>=400&&e.status<500)setConflict(true);}finally{setBusy(false);}
 };
 return <><div className="round-completion">
  <div className="round-completion-copy"><h3>第 {round.roundNumber} 轮完成后</h3>
   <p>如需补件复审，请在同一案件号下准备第 {nextNumber} 轮；如无需继续，<span className="round-completion-keep-line">审单员可手动完结案件。</span></p>
   <Checkbox checked={acknowledged} disabled={!ready||!canClose} onChange={event=>setAcknowledgedKey(event.target.checked?acknowledgementKey:'')}>我已核对预审结果及邮件草稿，并确认本案可以完结。</Checkbox>
   {blockers.length>0&&<details className="checker-blockers" open><summary>操作前还需准备 {blockers.length} 项</summary><SubmissionPrerequisites caseId={item.id} roundId={round.roundId} blockers={blockers}/></details>}
   {!ready&&!blockers.length&&<p role="status">当前结果尚不能确认，请核对最新结果与复核状态。</p>}
   {!command&&<ErrorNotice error={error}/>}
  </div>
  <div className="round-completion-actions"><Button disabled={!nextAllowed} onClick={()=>open('next')}>准备第 {nextNumber} 轮材料</Button><Button danger disabled={!ready||!canClose||!acknowledged} onClick={()=>open('close')}>手动确认案件完结</Button></div>
 </div>
 {command&&<Modal open title={command.kind==='next'?`准备第 ${command.nextNumber} 轮材料？`:command.plan.preview?'确认完结案件？':'核对案件完结条件'} width={520} okText={conflict?'关闭并刷新':command.kind==='next'?`准备第 ${command.nextNumber} 轮材料`:command.plan.preview?'确认完结':'确认复核并继续'} cancelText="取消" confirmLoading={busy} closable={!busy} keyboard={!busy} mask={{closable:false}} cancelButtonProps={{disabled:busy}} okButtonProps={{disabled:!conflict&&command.kind==='close'&&!!command.plan.preview&&!acknowledgementComplete(command.plan.preview,closing)}} onCancel={cancel} onOk={()=>void finish()}>
  <ErrorNotice error={error}/>
  {!!error&&command.plan.confirmed&&<p role="status">本轮复核已确认；后续操作尚未完成。</p>}
  {!!error&&!conflict&&<p role="status">重试会核对同一请求，不会重复创建轮次或提交新的决定。</p>}
  {command.kind==='next'?<p>确认本轮复核后准备第 {command.nextNumber} 轮材料，未解决事项保留。下一轮由经办人上传完整材料。</p>:command.plan.preview?<ClosureAcknowledgementFields preview={command.plan.preview} value={closing} onChange={setClosing} disabled={busy||conflict||!!command.plan.closure}/>:<p>先确认本轮复核并核对完结条件，再确认案件完结。若暂不完结，本轮复核确认仍会保留。</p>}
 </Modal>}</>;
}
