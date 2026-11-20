import React from 'react';
import {Button} from 'antd';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import type {FieldDecision} from './field-decision.ts';
import {EvidenceLinks} from './evidence-links.tsx';

/** Ownership is a prerequisite only while its current record is unconfirmed. */
export function FieldWorkflow({row,state,decision,onEditObject,onEditFact,ownershipRequired=true}: {
  row:ChecklistRow;state:ReviewState;decision:FieldDecision;onEditObject:()=>void;onEditFact?:()=>void;ownershipRequired?:boolean;
}) {
  if(decision.action.label==='本轮不启用')return null;
  const owner=state.objects.find(object=>object.objectId===row.objectId);
  const showOwnership=ownershipRequired||!!row.objectId;
  const confirmed=owner?.validity==='current';
  const editable=!state.readOnly&&state.allowedActions.includes('field:correct');
  const pending=showOwnership&&!confirmed&&!state.readOnly;
  const title=!showOwnership?'后续流程':pending?'流程待办':'材料归属';
  const workflow=(decision.workflow??[]).filter(task=>task.id!=='ownership');
  if(!showOwnership&&!workflow.length)return null;
  return <section className="field-verified-boundary" aria-label={title}>
    <h3>{title}</h3>
    {pending&&<p>{owner?'材料归属依据已失效，请重新确认对应主体及本笔业务。':'请确认文件对应的主体及本笔业务。'}</p>}
    {owner&&<details><summary>查看材料归属</summary><p>{owner.label}{!confirmed?'（依据已失效）':''}</p>
      <EvidenceLinks caseId={state.caseId} evidence={owner.evidence} names={Object.fromEntries((state.materialSources??[]).map(material=>[material.documentVersionId,material.filename]))} roundId={state.roundId}/>
    </details>}
    {showOwnership&&!owner&&state.readOnly&&<p>本轮未确认材料归属。</p>}
    {showOwnership&&editable&&<Button type="link" size="small" onClick={onEditObject}>{confirmed?'调整材料归属':owner?'重新确认材料归属':'确认材料归属'}</Button>}
    {!!workflow.length&&<div>{showOwnership&&<h4>后续流程</h4>}{workflow.map(task=><p key={task.id}><strong>{task.label}</strong>：{task.detail}</p>)}</div>}
    {editable&&confirmed&&onEditFact&&<Button type="link" size="small" onClick={onEditFact}>{row.fact?'更正字段值':'确认采用值'}</Button>}
  </section>;
}
