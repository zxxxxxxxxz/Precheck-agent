import React,{useEffect,useRef,useState} from 'react';
import {Checkbox} from 'antd';
import {GUARANTEE_LABELS,guaranteeSelectionKey} from '@hsbc/contracts/mixed-guarantee';
import type {ReviewState} from '@hsbc/contracts/review';
import {api,queryClient} from '../../api.ts';
import {ErrorNotice} from '../../ui.tsx';
import {matchingRoundConfiguration} from './guarantee-selection.ts';
import '../cases/new-case-configuration.css';

export function MaterialGuaranteeSelection({state,disabled}:{state:ReviewState;disabled?:boolean}) {
  const [types,setTypes]=useState(state.guaranteeTypes??[]);
  const [pending,setPending]=useState(false),[error,setError]=useState<unknown>();
  const saving=useRef(false);
  const request=useRef<{revision:number;key:string;selection:string}|undefined>(undefined);
  const original=guaranteeSelectionKey(state.guaranteeTypes??[]);
  useEffect(()=>{setTypes(state.guaranteeTypes??[]);setError(undefined);},[state.caseId,state.roundId,original]);
  const changed=guaranteeSelectionKey(types)!==original;
  const choice=matchingRoundConfiguration(state,types);
  const editable=state.roundNumber===1&&!disabled&&!state.readOnly&&state.allowedActions.includes('case:configure');
  async function select(next:string[]){
    if(!editable||saving.current)return;
    setTypes(next);setError(undefined);
    const choice=matchingRoundConfiguration(state,next),selection=guaranteeSelectionKey(next);
    if(!choice||selection===original)return;
    if(request.current?.revision!==state.revision||request.current.selection!==selection)request.current={revision:state.revision,key:crypto.randomUUID(),selection};
    saving.current=true;
    setPending(true);setError(undefined);
    try{
      const updated=await api<ReviewState>(`/api/cases/${state.caseId}/review/configuration`,{method:'POST',body:{releaseId:choice.releaseId,guaranteeTypes:next,
        expectedRevision:request.current.revision,idempotencyKey:request.current.key,reason:'调整本轮担保类型与材料准备清单',...(state.roundId?{roundId:state.roundId}:{})}});
      setTypes(updated.guaranteeTypes??next);
    }catch(failure){setTypes(state.guaranteeTypes??[]);setError(failure);}finally{
      await Promise.all(['case-review','review-rounds','case','cases','workbench','materials','review-checklist','document-fields'].map(name=>queryClient.invalidateQueries({queryKey:[name]})));
      saving.current=false;setPending(false);
    }
  }
  if(!editable&&!pending&&!error){
    const labels=(state.guaranteeTypes??[]).map(type=>GUARANTEE_LABELS[type as keyof typeof GUARANTEE_LABELS]??type);
    return <span className="material-guarantee-locked" aria-label="本轮担保类型">担保类型 <b>{labels.join('、')||'待确认'}</b>{(state.roundNumber??0)>1&&<span className="muted">（第二轮起不可修改）</span>}</span>;
  }
  return <section className="case-business-picker material-guarantee-picker" aria-label="本轮担保类型">
    <div className="case-business-heading"><h2>担保类型 {editable&&<span>可多选</span>}</h2><span>已选择 {types.length} 项</span></div>
    <Checkbox.Group aria-label="本轮担保类型" className="case-business-options" value={types} disabled={!editable||pending}
      options={Object.entries(GUARANTEE_LABELS).map(([value,label])=>({value,label,className:`case-business-option${types.includes(value)?' is-selected':''}`}))}
      onChange={next=>void select(next as string[])}/>
    {pending&&<p role="status">正在保存担保类型…</p>}
    {editable&&changed&&!choice&&<p role="status">所选组合暂无可用的已发布规则，尚未保存，请调整选择。</p>}
    {(state.roundNumber??0)>1&&<p className="help-text">担保类型已固定，第二轮起不可修改。</p>}
    <ErrorNotice error={error}/>
  </section>;
}
