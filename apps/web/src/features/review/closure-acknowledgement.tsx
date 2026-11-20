import React,{useState} from 'react';
import {Button,Checkbox,Input} from 'antd';
import type {ClosurePreview} from '@hsbc/contracts/case-review-status';
import {reviewReasonLabels} from './presentation.ts';
import {unresolvedItems,type ClosureAcknowledgement} from './closure-confirmation.ts';
import './closure-acknowledgement.css';

/** The items that stay unresolved when the case is closed: each is ticked, and a reason is recorded with its conclusion. */
export function ClosureAcknowledgementFields({preview,value,onChange,disabled=false}:{preview:ClosurePreview;value:ClosureAcknowledgement;onChange:(next:ClosureAcknowledgement)=>void;disabled?:boolean}){
 const unresolved=unresolvedItems(preview),[own,setOwn]=useState<string[]>([]);
 if(!unresolved.length)return <p>确认完结当前已复核的文件审核流程？完结后案件只读，{preview.items.length?`${preview.items.length} 项已处理事项及原结论保留。`:'审核结果及历史记录保留。'}</p>;
 const checked=unresolved.filter(item=>value.checked.includes(item.id)).length,all=checked===unresolved.length;
 const toggle=(id:string,on:boolean)=>onChange({...value,checked:on?[...new Set([...value.checked,id])]:value.checked.filter(item=>item!==id)});
 return <div className="closure-acknowledgement">
  <p>完结后案件只读。以下 {unresolved.length} 项尚未解决，请逐项确认；原结论和遗留原因随案件保留。</p>
  <Checkbox checked={all} indeterminate={checked>0&&!all} disabled={disabled} onChange={event=>onChange({...value,checked:event.target.checked?unresolved.map(item=>item.id):[]})}>全部确认（已确认 {checked} / {unresolved.length} 项）</Checkbox>
  <ul className="closure-acknowledgement-items" aria-label="尚未解决的事项">{unresolved.map(item=>{
   const separate=own.includes(item.id)||!!value.itemReasons[item.id];
   return <li key={item.id}>
    <Checkbox checked={value.checked.includes(item.id)} disabled={disabled} onChange={event=>toggle(item.id,event.target.checked)}>
     <span className="closure-acknowledgement-label">{item.label}</span>
     <span className="closure-acknowledgement-meta">{item.objectLabel}，{reviewReasonLabels[item.reasonCode]??'尚未解决'}</span>
    </Checkbox>
    {separate?<Input aria-label={`${item.label}的遗留原因`} placeholder="本项的遗留原因" maxLength={1000} disabled={disabled} value={value.itemReasons[item.id]??''} onChange={event=>onChange({...value,itemReasons:{...value.itemReasons,[item.id]:event.target.value}})}/>
     :<Button type="link" size="small" disabled={disabled} onClick={()=>setOwn(current=>[...current,item.id])}>单独说明</Button>}
   </li>;
  })}</ul>
  <label className="closure-acknowledgement-reason"><span>遗留原因</span>
   <Input.TextArea aria-required placeholder="说明这些事项为何保留现状，例如待后续业务环节补充。未单独说明的事项使用此原因。" autoSize={{minRows:2,maxRows:4}} maxLength={1000} showCount disabled={disabled}
    value={value.reason} onChange={event=>onChange({...value,reason:event.target.value})}/></label>
 </div>;
}
