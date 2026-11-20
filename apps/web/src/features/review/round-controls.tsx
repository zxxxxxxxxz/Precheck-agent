import React,{useState,useEffect} from 'react';
import {Button,Dropdown} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {useNavigate,useSearchParams} from 'react-router';
import {caseMaterialsPath} from '../cases/workspace-navigation.ts';
import type {ReviewRoundsState} from '@hsbc/contracts/review-rounds';
import type {CaseSummary} from '../cases/types.ts';
import {api,newKey,queryClient} from '../../api.ts';
import {ActionModal,ErrorNotice,Section} from '../../ui.tsx';
import {useCapabilities} from '../../capabilities.ts';
import {useAuth} from '../../auth.tsx';
import {CheckerEntry} from '../review-checker/checker-entry.tsx';
import {ReturnToMaker} from '../review-checker/return-to-maker.tsx';
import {roundNotice} from './round-notice.ts';
import './round-completion.css';

export {roundLabels} from './round-notice.ts';
export const roundQuery=(id?:string|null)=>id?`?roundId=${encodeURIComponent(id)}`:'';
export function useReviewRounds(caseId:string){
 const {session}=useAuth(),capabilities=useCapabilities();
 const query=useQuery({queryKey:['review-rounds',session.user?.accountId,caseId],enabled:capabilities.data?.reviewLoop===true,queryFn:({signal})=>api<ReviewRoundsState>(`/api/cases/${caseId}/review/rounds`,{signal}),refetchInterval:5000});
 const transition=query.data?.items.map(r=>`${r.roundId}:${r.status}`).join('|');
 useEffect(()=>{if(transition)void Promise.all(['case','case-review','cases','workbench'].map(name=>queryClient.invalidateQueries({queryKey:[name]})));},[transition]);
 return query;
}
export async function refreshRounds(caseId:string){await Promise.all(['review-rounds','case-review','case','cases','workbench','materials','document-processing'].map(name=>queryClient.invalidateQueries({queryKey:[name]})));}
export function RoundControls({item,state,compact=false,inline=false,roundCommands=true,primaryAction,actionsOnly=false,selectionOnly=false,displayedRun,reviewAction,completionContent,confirmationDisabled=false,progress}:{item:CaseSummary;state?:ReviewRoundsState;compact?:boolean;inline?:boolean;roundCommands?:boolean;primaryAction?:React.ReactNode;actionsOnly?:boolean;selectionOnly?:boolean;reviewAction?:React.ReactNode;completionContent?:React.ReactNode;progress?:React.ReactNode;confirmationDisabled?:boolean;displayedRun?:{id:string;snapshotHash:string}}){
 const navigate=useNavigate();
 const [,setParams]=useSearchParams(),[command,setCommand]=useState<{action:string;title:string;revision:number;roundId?:string;key:string;runId?:string|null;snapshotHash?:string|null}>(),[pending,setPending]=useState(false),[error,setError]=useState<unknown>();
 if(!state)return null;
 const selected=item.selectedRoundId??state.currentRoundId??(!state.enabled?'legacy':undefined),round=state.items.find(r=>r.roundId===selected),open=(action:string)=>{setError(undefined);setCommand({action,title:title[action]!,revision:state.revision,roundId:round?.roundId,runId:round?.runId,snapshotHash:round?.snapshotHash,key:newKey()});};
 const matchesDisplayedRun=!!round&&displayedRun?.id===round.runId&&displayedRun?.snapshotHash===round.snapshotHash;
 const title:Record<string,string>={create:state.enabled?`准备第 ${Math.max(0,...state.items.map(r=>r.roundNumber))+1} 轮材料`:'启用预审轮次',discard:'放弃本轮准备',retry:'重试本轮预审',cancel:'取消本轮执行',confirm:state.checkerCorrection?'确认更正结果':'确认初审结果',reopen:'返回初审修改'};
 const noticeInfo=roundNotice(state,selected,!!item.closure),notice=noticeInfo.text,attention=noticeInfo.kind==='attention';
 const completionTitle=item.closure?'案件已完结':round?`第 ${round.roundNumber} 轮${round.status==='completed'?'完成后':'预审结果'}`:'预审完成后';
 const footer=completionContent!==undefined;
 const commands=['confirm','reopen','discard','retry','cancel'].filter(action=>(roundCommands||action==='reopen')&&(action!=='confirm'||actionsOnly&&matchesDisplayedRun&&reviewAction===undefined)&&round?.allowedActions.includes(`round:${action}`));
 const commandButton=(action:string)=><Button key={action} type={footer?'default':action==='confirm'?'primary':'default'} className={footer&&action!=='confirm'?'round-completion-link':undefined} danger={action==='discard'||action==='cancel'} disabled={action==='confirm'&&confirmationDisabled} onClick={()=>open(action)}>{title[action]}</Button>;
 const actions=<>{roundCommands&&state.allowedActions.includes('round:create')&&<Button onClick={()=>open('create')}>{title.create}</Button>}{!actionsOnly&&primaryAction}{reviewAction===undefined&&round?.status==='checker_pending'&&<CheckerEntry item={item} round={round}/>}
  {commands.filter(action=>action!=='reopen'&&(!footer||action==='confirm')).map(commandButton)}{actionsOnly&&reviewAction}{actionsOnly&&primaryAction}</>;
 const modal=command&&<ActionModal title={command.action==='discard'?'放弃本轮准备？':command.title} okText={command.action==='discard'?'确认放弃':command.title} danger={command.action==='discard'} pending={pending} error={<ErrorNotice error={error}/>} onCancel={()=>{if(!pending)setCommand(undefined);}} onFinish={async()=>{if(pending)return;setPending(true);setError(undefined);try{const base=`/api/cases/${item.id}/review/rounds`,response=await api<ReviewRoundsState&{commandRoundId?:string}>(command.action==='create'?base:`${base}/${command.roundId}/${command.action}`,{method:'POST',body:{expectedRevision:command.revision,idempotencyKey:command.key,...(command.action==='confirm'?{runId:command.runId,snapshotHash:command.snapshotHash}:{}),reason:command.action==='confirm'?state.checkerCorrection?'复核人确认当前更正结果':'经办确认当前初审结果':command.action==='discard'?'经办确认放弃本轮准备':({create:'准备下一轮材料',reopen:'返回初审修改',retry:'重试本轮预审',cancel:'取消本轮执行'} as Record<string,string>)[command.action]}});if(command.action==='create'&&response.commandRoundId){setCommand(undefined);navigate(caseMaterialsPath(item.id,response.commandRoundId));void refreshRounds(item.id);return;}await refreshRounds(item.id);if(command.action==='discard')setParams(current=>{const next=new URLSearchParams(current);next.delete('round');return next;});setCommand(undefined);}catch(failure){setError(failure);}finally{setPending(false);}}}>
   <p>{command.action==='confirm'?state.checkerCorrection?'确认后固定更正结果，请继续核对复核依据与邮件，并在独立复核中完成确认。':'确认后固定本轮材料和初审结果，请到协作与复核提交给独立复核人。本轮在复核人确认后结束；需要修改时，由复核人退回原经办人。':command.action==='reopen'?'返回后可在本轮更正。已有结果和历史提交保留，材料或字段变化后须重新预审及确认。':command.action==='discard'?'确认后将停止本轮准备，取消尚未完成的上传和处理任务。本轮已有材料及操作记录会保留，但不能再提交预审；如需继续，请准备新一轮。':command.action==='create'?'新一轮保留配置选择，材料、对象和事实需重新确认。':'此操作会保留本轮历史记录。重试会继续使用原冻结快照。'}</p>
  </ActionModal>;
 const roundAction=round?.allowedActions.includes('round:reopen')?commandButton('reopen'):round?.roundId===state.currentRoundId&&round.locked&&['checker_pending','stale'].includes(round.status)?<ReturnToMaker key={round.roundId} item={item} round={round}/>:null;
 const hasActions=!selectionOnly&&!footer&&((roundCommands&&state.allowedActions.includes('round:create'))||!!primaryAction||(reviewAction===undefined&&round?.status==='checker_pending')||commands.some(action=>action!=='reopen'&&(!footer||action==='confirm'))||(actionsOnly&&reviewAction!=null));
 // The round selector lives in the workspace header. This bar appears only when there is something to do or to heed
 // here, and then explains the round beside those actions; routine notes stay in the selector's list.
 if(inline){
  // Page-head variant: preparing the next round stays a button; stopping, retrying or reopening the round is one menu away.
  const menu=commands.filter(action=>action!=='confirm'&&action!=='reopen').map(action=>({key:action,label:title[action],danger:action==='discard'||action==='cancel',onClick:()=>open(action)}));
  return <>{roundAction}{state.allowedActions.includes('round:create')&&<Button onClick={()=>open('create')}>{title.create}</Button>}
   {menu.length>0&&<Dropdown trigger={['click']} menu={{items:menu}}><Button className="round-more" aria-label={`本轮更多操作：${menu.map(entry=>entry.label).join('、')}`}><span aria-hidden="true">⋯</span></Button></Dropdown>}
   {modal}</>;
 }
 const showNotice=attention||!!roundAction||hasActions||!!progress;
 if(compact&&!footer&&!actionsOnly&&!showNotice&&!command)return null;
 return <Section title={actionsOnly&&compact?completionTitle:actionsOnly?(round?.status==='draft'?'本轮材料':round?.status==='completed'?'下一轮材料':'本轮结果'):'预审轮次'} className={`review-round-controls${compact?' review-round-controls-compact':''}${footer?' round-completion-section':''}`} info={footer?undefined:actionsOnly&&compact?<span className="report-completion-title">{completionTitle}</span>:!actionsOnly&&showNotice&&<div className="review-loop-toolbar-actions">{roundAction}<div className="round-control-status"><p className="help-text round-control-notice">{notice}</p>{progress}</div></div>} actions={!selectionOnly&&!footer&&<div className="review-loop-toolbar-actions">{actions}</div>}>
  {footer&&<><div className="round-completion"><div className="round-completion-copy"><h3>{completionTitle}</h3>{completionContent}</div><div className="round-completion-actions">{actions}</div></div>{commands.some(action=>action!=='confirm'&&action!=='reopen')&&<div className="round-completion-support">{commands.filter(action=>action!=='confirm'&&action!=='reopen').map(commandButton)}</div>}</>}
  {actionsOnly&&round?.allowedActions.includes('round:confirm')&&!matchesDisplayedRun&&<p role="status">正在同步最新预审结果，完成后可确认。</p>}
  {!compact&&<p className="help-text">{notice}</p>}
  {modal}
 </Section>;
}
