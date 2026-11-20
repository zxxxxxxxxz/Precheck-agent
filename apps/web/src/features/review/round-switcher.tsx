import React from 'react';
import {Button,Select} from 'antd';
import {useSearchParams} from 'react-router';
import {blocksView,CaseStatus} from '../../ui.tsx';
import {useReviewRounds} from './round-controls.tsx';
import {resolveSelectedRound,roundNotice,roundOptions} from './round-notice.ts';
import './round-switcher.css';

/** Case-level round selector shown once in the workspace header for every case step. */
export function RoundSwitcher({caseId,caseStatus,closed=false,fallback}:{caseId:string;caseStatus:string;closed?:boolean;fallback:React.ReactNode}){
  const rounds=useReviewRounds(caseId);
  const [params,setParams]=useSearchParams();
  const state=blocksView(rounds)?undefined:rounds.data;
  if(!state||state.caseId!==caseId||(!state.items.length&&!state.hasLegacyRecords))return <>{fallback}</>;
  const selected=resolveSelectedRound(state,params.get('round'));
  const round=state.items.find(value=>value.roundId===selected),current=state.items.find(value=>value.roundId===state.currentRoundId);
  const historical=!!round&&round.roundId!==state.currentRoundId;
  const notice=roundNotice(state,selected,closed);
  const choose=(id:string)=>setParams(value=>{const next=new URLSearchParams(value);next.set('round',id);for(const key of ['document','parse','page','run','directory','anchor','sourceNode','view','field'])next.delete(key);return next;});
  return <div className={`round-switcher${historical?' is-history':''}`}>
    <Select aria-label="查看预审轮次" className="round-switcher-select" value={selected} placeholder="尚未准备预审轮次" options={roundOptions(state)} onChange={choose} status={historical?'warning':undefined} popupMatchSelectWidth={false} placement="bottomRight"
      labelRender={()=>round?<span className="round-switcher-label"><b>第 {round.roundNumber} 轮</b>{historical?<span className="round-switcher-readonly">只读</span>:<CaseStatus status={caseStatus}/>}</span>:<span className="round-switcher-label"><b>历史记录</b><span className="round-switcher-readonly">未分轮</span></span>}
      popupRender={menu=><>{menu}<p className="round-switcher-notice">{notice.text}</p></>}/>
    {historical&&current&&<Button type="text" className="round-switcher-back" onClick={()=>choose(current.roundId)}>回到第 {current.roundNumber} 轮</Button>}
  </div>;
}
