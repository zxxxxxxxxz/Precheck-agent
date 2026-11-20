import React,{useRef,useState} from 'react';
import {Button,Checkbox,Modal} from 'antd';
import {useQuery} from '@tanstack/react-query';
import type {ReviewState} from '@hsbc/contracts/review';
import type {HistoricalMaterials,AddedHistoricalMaterials} from '@hsbc/contracts/material-history';
import {api,newKey,queryClient} from '../../api.ts';
import {blocksView,ErrorNotice,Loading} from '../../ui.tsx';
import {formatSize} from '../../shared/format.ts';

export function useHistoricalMaterials(state?:ReviewState){
  return useQuery({queryKey:['material-history',state?.caseId,state?.roundId,state?.revision],enabled:!!state?.roundId&&(state.roundNumber??0)>1,
    queryFn:({signal})=>api<HistoricalMaterials>(`/api/cases/${state!.caseId}/materials/history?roundId=${state!.roundId}`,{signal})});
}
export function AddHistoricalMaterials({state,disabled}:{state:ReviewState;disabled:boolean}){
  const [open,setOpen]=useState(false),[selection,setSelection]=useState<string[]>([]),[pending,setPending]=useState(false),[error,setError]=useState<unknown>();
  const request=useRef<{roundId:string;expectedRevision:number;idempotencyKey:string;documentVersionIds:string[]}|undefined>(undefined);
  const busy=useRef(false),history=useHistoricalMaterials(state);
  const rows=blocksView(history)?[]:history.data?.items??[],selected=selection.filter(id=>rows.some(row=>row.id===id&&!row.alreadyInCurrent));
  const rounds=[...new Set(rows.map(row=>row.uploadedRoundNumber))].sort((a,b)=>b-a);
  const submit=async()=>{
    if(busy.current||disabled||!state.roundId||!selected.length||blocksView(history))return;
    request.current??={roundId:state.roundId,expectedRevision:state.revision,idempotencyKey:newKey(),documentVersionIds:selected};
    busy.current=true;setPending(true);setError(undefined);
    try{
      await api<AddedHistoricalMaterials>(`/api/cases/${state.caseId}/materials/history`,{method:'POST',body:request.current});
      await Promise.all(['materials','material-history','case-review','case','cases','workbench','review-rounds','review-checklist','document-processing-summary'].map(key=>queryClient.invalidateQueries({queryKey:[key]})));
      setOpen(false);setSelection([]);request.current=undefined;
    }catch(e){setError(e);}finally{busy.current=false;setPending(false);}
  };
  return <><Button type="link" disabled={disabled} onClick={()=>{setOpen(true);setSelection([]);setError(undefined);request.current=undefined;}}>加入历史材料</Button>
    <Modal className="material-history-dialog" title="加入历史材料" open={open} width={720} destroyOnHidden confirmLoading={pending} okText={error?'重试加入':`加入本轮${selected.length?`（${selected.length}）`:''}`} cancelText="取消"
      okButtonProps={{disabled:disabled||!selected.length||blocksView(history)||history.isFetching}} cancelButtonProps={{disabled:pending}}
      onCancel={()=>{if(!pending)setOpen(false);}} onOk={()=>void submit()}>
      <p className="historical-material-intro">选择本案历史轮次中的文件加入第 {state.roundNumber} 轮。原文件和历史记录保留，本轮重新提取与核对。</p>
      {history.isPending?<Loading/>:<ErrorNotice error={history.error} retry={()=>void history.refetch()}/>}
      <div className="historical-materials">{rounds.map(round=><section key={round}><h3>第 {round} 轮已上传</h3><ul>{rows.filter(row=>row.uploadedRoundNumber===round).map(row=><li key={row.id}>
        <Checkbox checked={row.alreadyInCurrent||selected.includes(row.id)} disabled={row.alreadyInCurrent||pending||!!request.current} onChange={e=>setSelection(e.target.checked?[...selection,row.id]:selection.filter(id=>id!==row.id))}>
          <span className="historical-material-name">{row.filename}</span><span className="historical-material-meta">{row.format.toUpperCase()} · {formatSize(row.size)}{row.pageCount!==null?` · ${row.pageCount} 页`:''}</span>
        </Checkbox><span className="historical-material-state">{row.alreadyInCurrent?'已在本轮':''}</span>
      </li>)}</ul></section>)}</div>
      {!history.isPending&&!history.error&&!rows.length&&<p>暂无可加入的历史材料。</p>}
      <ErrorNotice error={error}/>{!!error&&<p className="help-text">可重试同一次加入；刷新后可查看文件是否已在本轮。</p>}
    </Modal></>;
}
