import React from 'react';
import {Button} from 'antd';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import {useSemanticAnalysisAccess} from './corporate-semantic-actions.tsx';
import {requestRerun,rerunStatus,rerunnable,useRerunQueue} from './semantic-rerun.ts';

/** Checks the selected field's AI results again. The checklist's scheduler sends the request, one job at a time. */
export function FieldRecheckAction({state,rows}:{state:ReviewState;rows:ChecklistRow[]}){
  const eligible=rows.flatMap(row=>(row.crossChecks??[]).filter(check=>check.semanticEligible).map(check=>({check,fieldId:row.fieldId})));
  const queue=useRerunQueue(state.caseId,state.roundId);
  const {enabled}=useSemanticAnalysisAccess(state,eligible.length>0);
  if(state.readOnly||!enabled||!eligible.length)return null;
  const checking=eligible.some(({check})=>check.semantic?.state==='pending'),waiting=eligible.some(({check})=>rerunStatus(queue,check)==='queued');
  const candidates=[...new Map(eligible.filter(({check})=>rerunnable(check)).map(task=>[task.check.id,task])).values()];
  if(!checking&&!waiting&&!candidates.length)return null;
  return <Button type="link" size="small" className="field-recheck-action" loading={checking||waiting} disabled={checking||waiting}
    title="按当前材料重新执行本项 AI 核对" onClick={()=>requestRerun(state.caseId,state.roundId,candidates)}>{checking?'核对中':waiting?'等待重新核对':'重新核对'}</Button>;
}
