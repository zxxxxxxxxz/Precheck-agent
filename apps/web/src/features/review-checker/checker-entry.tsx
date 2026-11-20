import React from 'react';
import {Button} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {useLocation} from 'react-router';
import type {CheckerState} from '@hsbc/contracts/review-checker';
import type {ReviewRound} from '@hsbc/contracts/review-rounds';
import type {CaseSummary} from '../cases/types.ts';
import {useAuth} from '../../auth.tsx';
import {api} from '../../api.ts';
import {caseExtractionPath} from '../cases/workspace-navigation.ts';
import {LinkButton} from '../../ui.tsx';

/** Only the next actionable handoff is a link; a submitted Maker waits. */
export function checkerEntry(item:CaseSummary,round:ReviewRound,state:CheckerState|undefined,personId?:string){
 if(!personId||!state||state.caseId!==item.id||state.roundId!==round.roundId||item.closure||state.readOnly)return null;
 // Maker handoff stays in collaboration; Checker starts with this round’s extracted fields.
 const entry=(label:string,kind:'submit'|'view'='view')=>({label,kind,path:`/cases/${item.id}/collaboration?round=${encodeURIComponent(round.roundId)}`});
 const waiting={label:'等待复核',kind:'waiting' as const};
 const status=state.summary.status;
 if(['confirmed','terminated'].includes(status))return null;
 if(personId===item.makerPersonId){
  if(['pending','correcting'].includes(status))return waiting;
  if(state.allowedActions.includes('checker:prepare-submit'))return entry('提交复核','submit');
  if(status==='stale'&&state.summary.submissionId)return waiting;
 }else if(personId===state.summary.personId&&['pending','correcting','stale'].includes(status)&&state.allowedActions.some(action=>['checker:comment','checker:confirm','checker:correct','checker:editing','checker:confirm-correction'].includes(action))){
  return {...entry(`开始第 ${round.roundNumber} 轮复审`),path:caseExtractionPath(item.id,round.roundId)};
 }
 return null;
}

export function CheckerEntryContent({entry}:{entry:NonNullable<ReturnType<typeof checkerEntry>>}){
 return entry.kind==='waiting'?<span role="status" className="muted">{entry.label}</span>:<LinkButton type="primary" to={entry.path}>{entry.label}</LinkButton>;
}

export function useCheckerEntryState(caseId:string,roundId:string|undefined,enabled=true){
 const {session}=useAuth();
 return useQuery({queryKey:['checker',session.user?.accountId,caseId,roundId],enabled:enabled&&!!roundId,queryFn:({signal})=>api<CheckerState>(`/api/cases/${caseId}/checker?roundId=${encodeURIComponent(roundId!)}`,{signal}),refetchInterval:15000});
}

export function CheckerEntryLoading({error,retry}:{error:unknown;retry:()=>void}){
 return error?<Button onClick={retry}>重试读取复核状态</Button>:<span role="status" className="muted">正在读取复核状态</span>;
}

export function CheckerEntry({item,round}:{item:CaseSummary;round:ReviewRound}){
 const location=useLocation();
 const {session}=useAuth(),query=useCheckerEntryState(item.id,round.roundId);
 if(query.error||query.isPending)return <CheckerEntryLoading error={query.error} retry={()=>void query.refetch()}/>;
 const entry=checkerEntry(item,round,query.data,session.user?.personId);
 if(entry?.kind==='waiting')return null;
 if(entry?.kind==='view'&&location.pathname.endsWith('/review'))return null;
 return entry?<CheckerEntryContent entry={entry}/>:null;
}
