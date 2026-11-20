import React from 'react';
import type {ReviewState} from '@hsbc/contracts/review';
import {GUARANTEE_LABELS} from '@hsbc/contracts/mixed-guarantee';
import {MaterialRequirementsList} from '../review/configuration-picker.tsx';
import {preparationChecklist, preparationRowStatus, preparationSummary} from './preparation-checklist.ts';
import {materialIdentification} from './processing.ts';
import type {Material} from './types.ts';
import type {HistoricalMaterial} from '@hsbc/contracts/material-history';
import {MaterialChecklistTitle} from './material-checklist-title.tsx';

export function PreparationChecklist({state, materials=[], history=[]}:{state:ReviewState; materials?:Material[]; history?:HistoricalMaterial[]}) {
  const summary=preparationChecklist(state);
  if(!summary.available)return <MaterialRequirementsList state={state}/>;
  const roles=[...new Set(summary.rows.map(row=>row.objectRole))];
  const identification=materialIdentification(state);
  return <div className="preparation-checklist">
    <p className="preparation-summary" role="status">{preparationSummary(summary)} · {state.configuration?.fields.length??0} 字段</p>
    {identification.unidentified>0&&<p className="help-text" role="status">本轮有 {identification.unidentified} 份文件尚未完成类型识别。{!state.readOnly&&'识别后自动更新清单，已上传文件无需重复上传。'}</p>}
    {roles.map(role=><section key={role}><h3 className={roles.length===1?'visually-hidden':undefined}>{role==='common'?'共用核对材料':GUARANTEE_LABELS[role]??role}</h3><ul>
      {summary.rows.filter(row=>row.objectRole===role).map(row=>{
        const previous=[...new Set(history.filter(file=>!file.alreadyInCurrent&&!!row.taxonomyId&&file.taxonomyIds.includes(row.taxonomyId)).map(file=>file.uploadedRoundNumber))].sort((a,b)=>a-b);
        return <li key={row.id}>
        <MaterialChecklistTitle {...row}/>
        <div className="preparation-row-states">
        <span className={`preparation-status is-${identification.unidentified>0&&!row.documentVersionIds.length&&row.status!=='not_applicable'&&(row.reference||row.status==='missing')?'pending':row.reference&&!row.documentVersionIds.length&&row.status!=='not_applicable'?'missing':row.status}`}>{preparationRowStatus(row,state.roundNumber,materials,identification.unidentified)}</span>
        {previous.length>0&&row.status!=='provided'&&row.status!=='not_applicable'&&<span className="preparation-history">第 {previous.join('、')} 轮已上传 · 未加入本轮</span>}
        </div>
      </li>;})}
    </ul></section>)}
    <p className="help-text">按材料要求统计本轮收件，重复上传不重复计数。已上传不代表审核通过。</p>
  </div>;
}
