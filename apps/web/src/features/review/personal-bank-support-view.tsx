import React from 'react';
import {Button} from 'antd';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import {personalBankSupportRows} from './personal-bank-support.ts';
import {canEditField} from './field-comparison.ts';
import {can} from '../identity/permissions.ts';

export function PersonalBankSupport({row,rows,state,onEditFact}:{row:ChecklistRow;rows:ChecklistRow[];state:ReviewState;onEditFact:(row:ChecklistRow)=>void}){
 const support=personalBankSupportRows(row,rows);
 if(!support.length)return null;
 const editable=!state.readOnly&&can(state.allowedActions,'field:correct')&&state.objects.some(o=>o.objectId===row.objectId&&o.validity==='current');
 return <details className="field-rule-supplement"><summary>相关依据与补充信息（{support.length}）</summary>
  {support.map(other=><article key={other.id}>
   <div className="field-section-title"><h4>{other.label}</h4>{editable&&canEditField(other.fieldId)&&<Button type="link" size="small" onClick={()=>onEditFact(other)}>补充或更正</Button>}</div>
   {other.fact?.rawValue&&<p>已采用值：{other.fact.rawValue}</p>}
   {(other.sourceValues??[]).map(source=><div key={source.id}><p className="personal-comparison-filename">{source.filename}</p>
    {source.values.length?source.values.map((value,i)=><p className="checklist-value" key={i}>{value}</p>):<p className="help-text">尚无取值</p>}
    {source.warnings.map((warning,i)=><p className="help-text" key={i}>{warning}</p>)}
   </div>)}
   {!!other.rules.length&&<details><summary>相关要求</summary>{other.rules.map(rule=><p key={rule.id}>{rule.text}</p>)}</details>}
  </article>)}
 </details>;
}
