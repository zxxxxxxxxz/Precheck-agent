import React,{createContext,useContext,useState} from 'react';
import {createPortal} from 'react-dom';
import {Progress} from 'antd';
import {palette} from '../../theme.ts';
import type {SemanticProgress} from './semantic-progress-model.ts';
import './semantic-progress.css';

const ProgressSlotContext=createContext<{target:HTMLDivElement|null;setTarget:React.Dispatch<React.SetStateAction<HTMLDivElement|null>>}|null>(null);

/** The scheduler owns progress; the round toolbar only provides its display slot. */
export function ReviewProgressProvider({children}:{children:React.ReactNode}){
  const [target,setTarget]=useState<HTMLDivElement|null>(null);
  return <ProgressSlotContext.Provider value={{target,setTarget}}>{children}</ProgressSlotContext.Provider>;
}
export function ReviewProgressSlot(){
  const context=useContext(ProgressSlotContext);
  return context?<div className="round-progress-slot" ref={context.setTarget}/>:null;
}
export function SemanticProgressView({progress,active=false,blocked=false,rerunning=false,action}:{progress:SemanticProgress;active?:boolean;blocked?:boolean;rerunning?:boolean;action?:React.ReactNode}){
  if(!progress.total)return null;
  const complete=progress.completed===progress.total;
  const label=complete?'自动核对完成':rerunning?'重新核对中':active||progress.pending?'自动核对中':blocked?'自动核对暂不可用':progress.unfinished?'自动核对未完成':'等待自动核对';
  const counts=[progress.failed?`失败 ${progress.failed}`:'',progress.unavailable?`无法核对 ${progress.unavailable}`:'',progress.unfinished>progress.failed+progress.unavailable?`结果待核实 ${progress.unfinished-progress.failed-progress.unavailable}`:''].filter(Boolean).join(' · ');
  const description=`${label} · 已完成 ${progress.completed} / ${progress.total} 个任务${counts?` · ${counts}`:''}`;
  const detail=`按自动核对任务去重统计，一个任务可涉及多个字段。左侧“需关注”按字段统计，也包括差异、缺失信息和人工待办。${progress.unfinished?`其中 ${progress.unfinished} 个任务未取得有效结果，不会随等待自动完成。`:''}`;
  return <div className="round-semantic-progress">
    <div className="round-semantic-progress-head">
      <span className="round-semantic-progress-label" role="status" aria-atomic="true" title={detail}>{label} · 已完成 {progress.completed} / {progress.total} 个任务{counts&&<span className="round-semantic-progress-failures"> · {counts}</span>}</span>
      {action}
    </div>
    <Progress aria-label={description} percent={progress.percent} showInfo={false} status="normal"
      size={['100%',4]} strokeLinecap="butt" strokeColor={palette.primary} railColor={palette.border}/>
  </div>;
}
export function SemanticProgressInToolbar(props:React.ComponentProps<typeof SemanticProgressView>){
  const context=useContext(ProgressSlotContext);
  return context?.target?createPortal(<SemanticProgressView {...props}/>,context.target):null;
}
