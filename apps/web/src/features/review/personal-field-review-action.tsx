import React,{useState} from 'react';
import {Button} from 'antd';
import {useQueryClient} from '@tanstack/react-query';
import type {ReviewState} from '@hsbc/contracts/review';
import {api,newKey} from '../../api.ts';
import {ErrorNotice} from '../../ui.tsx';

export function PersonalFieldReviewAction({state,hasSources,rowId}:{state:ReviewState;hasSources:boolean;rowId:string}){
  const cache=useQueryClient(),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[saved,setSaved]=useState(false);
  if(state.readOnly||!state.allowedActions.includes('field:correct'))return null;
  const save=async()=>{setBusy(true);setError(undefined);setSaved(false);try{
    await api(`/api/cases/${state.caseId}/review/personal-field-verifications`,{method:'POST',body:{expectedRevision:state.revision,rowId,roundId:state.roundId??undefined,idempotencyKey:newKey(),reason:'按银行原表核对并保存当前项'},timeoutMs:120000});
    await cache.invalidateQueries();setSaved(true);
  }catch(e){setError(e);}finally{setBusy(false);}};
  return <div className="personal-field-save"><Button type="link" size="small" disabled={!hasSources} loading={busy} onClick={()=>void save()}>核对并保存当前项</Button>{saved&&<p role="status">核对结果已保存，状态统计已更新。</p>}<ErrorNotice error={error}/></div>;
}
