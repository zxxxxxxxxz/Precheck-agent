import {Link} from 'react-router';
import React,{useRef,useState} from 'react';
import {Button,Modal} from 'antd';
import {useQuery} from '@tanstack/react-query';
import type {ClosurePreview} from '@hsbc/contracts/case-review-status';
import type {CaseSummary} from '../cases/types.ts';
import {api,ApiError,newKey} from '../../api.ts';
import {ErrorNotice,Loading,Section} from '../../ui.tsx';
import {formatTime} from '../../shared/format.ts';
import {refreshRounds} from './round-controls.tsx';
import {acknowledgementComplete,closureConfirmation,emptyAcknowledgement} from './closure-confirmation.ts';
import {ClosureAcknowledgementFields} from './closure-acknowledgement.tsx';

export function CaseClosure({item,compact=false,disabled=false}:{item:CaseSummary;compact?:boolean;disabled?:boolean}){
 const [open,setOpen]=useState(false);
 if(item.closure&&compact)return <span role="status">{item.closure.kind==='checker_terminated'?'已提前终止':item.closure.kind==='checker_confirmed'?'已复核完结':'预审已结束'} · {formatTime(item.closure.closedAt)} · {item.closure.closedByName??'已记录经办人'}</span>;
 if(item.closure)return <Section title="案件已完结"><p>{item.closure.kind==='checker_terminated'?'未完成复核即终止，当前为只读状态。':item.closure.kind==='checker_confirmed'?'本轮已复核确认并完结，当前为只读状态。':'本案预审流程已结束，当前为只读状态。'}</p><dl className="case-facts"><div><dt>完结人</dt><dd>{item.closure.closedByName??'已记录经办人'}</dd></div><div><dt>完结时间</dt><dd>{formatTime(item.closure.closedAt)}</dd></div><div className="case-facts-wide"><dt>完结原因</dt><dd>{item.closure.reason}</dd></div></dl><p className="help-text">预审完结不代表正式业务批准。原有问题和历史结论均保留。</p></Section>;
 if(!item.allowed_actions.includes('case:close'))return null;
 if(compact)return <><Button danger disabled={disabled} onClick={()=>setOpen(true)}>手动确认案件完结</Button>{open&&<ClosureDialog item={item} close={()=>setOpen(false)}/>}</>;
 return <Section title="复核后完结"><p>案件完结须有当前轮的有效独立复核确认。尚未指派复核人时，请先完成指派并提交复核。</p><Link to={`/cases/${item.id}/collaboration`}>查看复核状态及提前终止入口</Link><Button onClick={()=>setOpen(true)}>检查完结条件</Button>{open&&<ClosureDialog item={item} close={()=>setOpen(false)}/>}</Section>;
}
function ClosureDialog({item,close}:{item:CaseSummary;close:()=>void}){
 const [key,setKey]=useState(newKey),[pending,setPending]=useState(false),[error,setError]=useState<unknown>(),[conflict,setConflict]=useState(false),[acknowledgement,setAcknowledgement]=useState(emptyAcknowledgement);
 const request=useRef<ReturnType<typeof closureConfirmation>|undefined>(undefined);
 const preview=useQuery({queryKey:['closure-preview',item.id,key],queryFn:({signal})=>api<ClosurePreview>(`/api/cases/${item.id}/closure-preview`,{signal}),refetchOnWindowFocus:false,retry:false});
 const value=preview.data;
 const reload=()=>{request.current=undefined;setError(undefined);setConflict(false);setKey(newKey());};
 const finish=async()=>{
  if(pending)return;
  if(conflict||preview.error){reload();return;}
  if(!value||preview.isFetching||!acknowledgementComplete(value,acknowledgement))return;
  request.current??=closureConfirmation(value,key,acknowledgement);
  setPending(true);setError(undefined);
  try{
   await api(`/api/cases/${item.id}/close`,{method:'POST',body:request.current});
   await refreshRounds(item.id);close();
  }catch(failure){setError(failure);if(failure instanceof ApiError&&failure.status>=400&&failure.status<500){request.current=undefined;setConflict(true);}}finally{setPending(false);}
 };
 return <Modal open title="确认完结案件？" width={520} okText={conflict||preview.error?'重新核对':request.current?'核对上次操作':'确认完结'} cancelText="取消" confirmLoading={pending} closable={!pending} keyboard={!pending} mask={{closable:false}} cancelButtonProps={{disabled:pending}} okButtonProps={{disabled:!conflict&&!preview.error&&(!value||preview.isFetching||!acknowledgementComplete(value,acknowledgement))}} onCancel={close} onOk={()=>void finish()}>
  <ErrorNotice error={preview.error}/><ErrorNotice error={error}/>
  {preview.isPending?<Loading label="正在核对完结条件"/>:value&&<ClosureAcknowledgementFields preview={value} value={acknowledgement} onChange={setAcknowledgement} disabled={pending||!!request.current}/>}
 </Modal>;
}
