import React,{useRef,useState} from 'react';
import {Button,Input,Modal} from 'antd';
import type {CheckerState} from '@hsbc/contracts/review-checker';
import type {ReviewRound} from '@hsbc/contracts/review-rounds';
import type {CaseSummary} from '../cases/types.ts';
import {useAuth} from '../../auth.tsx';
import {api,ApiError,newKey,queryClient} from '../../api.ts';
import {blocksView,ErrorNotice} from '../../ui.tsx';
import {refreshRounds} from '../review/round-controls.tsx';
import {useCheckerEntryState} from './checker-entry.tsx';
import './checker.css';

export function returnToMakerSubmission(item:CaseSummary,round:ReviewRound,state:CheckerState|undefined,personId?:string){
 if(!state||!personId||item.closure||state.readOnly||!round.locked||state.caseId!==item.id||state.roundId!==round.roundId||
   personId===item.makerPersonId||personId!==state.summary.personId||!state.allowedActions.includes('checker:return'))return undefined;
 return state.submissions.find(s=>s.id===state.summary.submissionId&&s.roundId===round.roundId&&s.runId===round.runId&&s.state==='submitted');
}

/** The assigned Checker hands the existing round back to its original Maker. */
export function ReturnToMaker({item,round}:{item:CaseSummary;round:ReviewRound}){
 const {session}=useAuth(),query=useCheckerEntryState(item.id,round.roundId);
 const state=blocksView(query)?undefined:query.data;
 const submission=returnToMakerSubmission(item,round,state,session.user?.personId);
 if(!state||!submission)return null;
 return <ReturnToMakerControl key={`${session.user?.accountId}:${round.roundId}:${state.revision}:${submission.version}`} item={item} round={round} state={state} submission={submission}/>;
}

function ReturnToMakerControl({item,round,state,submission}:{item:CaseSummary;round:ReviewRound;state:CheckerState;submission:NonNullable<ReturnType<typeof returnToMakerSubmission>>}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[conflict,setConflict]=useState(false),[completed,setCompleted]=useState(false),[reason,setReason]=useState('');
 const running=useRef(false),request=useRef<{expectedRevision:number;submissionVersion:number;idempotencyKey:string;reason:string}|undefined>(undefined);
 const refresh=()=>Promise.allSettled([refreshRounds(item.id),queryClient.invalidateQueries({queryKey:['checker']}),queryClient.invalidateQueries({queryKey:['checker-inbox']}),queryClient.invalidateQueries({queryKey:['review-delivery']})]);
 const finish=async()=>{
  if(running.current)return;
  if(conflict){setOpen(false);void refresh();return;}
  if(!request.current&&!reason.trim())return;
  running.current=true;setBusy(true);setError(undefined);
  try{
   request.current??={expectedRevision:state.revision,submissionVersion:submission.version,idempotencyKey:newKey(),reason:reason.trim()};
   await api(`/api/cases/${item.id}/checker/submissions/${submission.id}/return`,{method:'POST',body:request.current});
   setCompleted(true);setOpen(false);void refresh();
  }catch(e){setError(e);if(e instanceof ApiError&&e.status>=400&&e.status<500)setConflict(true);}
  finally{running.current=false;setBusy(false);}
 };
 return <><Button disabled={completed} onClick={()=>setOpen(true)}>{completed?'已退回初审':'返回初审修改'}</Button>
  {open&&<Modal open title="返回初审修改？" width={480} okText={conflict?'关闭并刷新':'确认退回'} cancelText="取消" confirmLoading={busy} closable={!busy} keyboard={!busy} mask={{closable:false}} cancelButtonProps={{disabled:busy}} okButtonProps={{disabled:!conflict&&!request.current&&!reason.trim()}} onCancel={()=>{if(!running.current)setOpen(false);}} onOk={()=>void finish()}>
   <ErrorNotice error={error}/>
   <p>将第 {round.roundNumber} 轮退回给原经办人{item.makerDisplayName?` ${item.makerDisplayName}`:''}修改。现有材料、预审报告和复核记录保留；经办人修改后需重新预审，并重新提交复核。</p>
   <label className="return-to-maker-reason"><span>退回原因</span>
    <Input.TextArea aria-required placeholder="说明需要经办人修改或补充什么，经办人会在本轮看到这段说明。" autoSize={{minRows:2,maxRows:5}} maxLength={1000} showCount disabled={busy||!!request.current} value={reason} onChange={event=>setReason(event.target.value)}/></label>
  </Modal>}
 </>;
}
