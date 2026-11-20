import React from 'react';
import {Button} from 'antd';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import {PERSONAL_FACT_OPTIONS} from '@hsbc/contracts/personal-requirements';
import {personalInputIds} from './personal-review-guidance.ts';

export function PersonalRequiredInputs({row,rows,state,onEditFact,onEditObject}:{row:ChecklistRow;rows:ChecklistRow[];state:ReviewState;onEditFact:(row:ChecklistRow)=>void;onEditObject:(row:ChecklistRow)=>void}){
  const ids=[...new Set([...personalInputIds(row.fieldId),...(row.crossChecks??[]).flatMap(c=>c.sources.filter(s=>s.state==='pending_confirmation').map(s=>s.fieldId))])];
  const inputs=ids.flatMap(id=>{
    const input=rows.find(r=>r.fieldId===id&&r.objectRole==='personal_guarantee'&&r.objectId===row.objectId);
    return input?[input]:[];
  });
  if(!inputs.length)return null;
  const editable=!state.readOnly&&state.allowedActions.includes('field:correct');
  const owner=state.objects.find(o=>o.objectId===row.objectId&&o.validity==='current');
  return <section className="personal-required-inputs" aria-label="本项需要的信息"><h4>本项需要的信息</h4>
    {inputs.map(input=><div key={input.id}><strong>{input.label}</strong><p>{input.fact?.validity==='current'&&input.fact.state==='present'?
      PERSONAL_FACT_OPTIONS[input.fieldId]?.find(option=>option.value===input.fact!.rawValue)?.label??[input.fact.rawValue,input.fact.normalization.currency??input.fact.currency].filter(Boolean).join(' '):'尚未提供'}</p>
      {editable&&owner&&<Button type="link" onClick={()=>onEditFact(input)}>{input.fact?.validity==='current'?'修改':'填写'}{input.label}</Button>}
    </div>)}
    {editable&&!owner&&<><p>请先明确这组材料属于哪位担保人，再填写此人的业务要求。</p><Button onClick={()=>onEditObject(row)}>确认担保人与材料归属</Button></>}
  </section>;
}
