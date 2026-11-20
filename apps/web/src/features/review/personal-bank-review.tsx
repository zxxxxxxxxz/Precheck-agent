import {personalReviewGuidance} from './personal-review-guidance.ts';
import React from 'react';
import type {ChecklistRow,CrossFileCheck} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import {PersonalFieldComparison,PersonalFieldSources} from './personal-field-comparison.tsx';
import {FieldDecisionStrip} from './field-decision-strip.tsx';
import {FieldWorkflow} from './field-workflow.tsx';
import {crossFileSourceWarnings} from './cross-file-presentation.ts';
import {personalBankDecision,personalBankDisplayCheck} from './personal-bank-presentation.ts';
import './personal-field-comparison.css';

const labels={consistent:'符合本条要求',different:'发现差异',manual:'待完成核对',insufficient:'待完成核对',single_source:'待完成核对',not_applicable:'不适用'};
export function PersonalBankReview({row,state,onEditObject,onEditFact,inputs}:{row:ChecklistRow;state:ReviewState;onEditObject:()=>void;onEditFact?:()=>void;inputs?:React.ReactNode}){
 const checks=(row.crossChecks??[]).filter(check=>check.bankRule).map(personalBankDisplayCheck).map(check=>({...check,sources:check.sources.map(source=>({...source,warnings:crossFileSourceWarnings(source)}))}));
 const focus={fieldId:row.fieldId,label:row.label};
 const guidance=personalReviewGuidance(row);
 const readingChecks:CrossFileCheck[]=checks.length?checks:[{id:row.id,label:row.label,fieldIds:[row.fieldId],objectId:row.objectId,method:'manual',outcome:'manual',reason:row.reason,manualReasons:[],sources:row.sourceValues??[]}];
 for(const check of readingChecks)check.sources=check.sources.map(source=>{
  if(source.fieldId!=='pg_required_amount'||!source.id.endsWith(':fact'))return source;
  const fact=state.facts.find(f=>f.fieldId===source.fieldId&&f.objectId===row.objectId&&f.validity==='current');const currency=fact?.normalization.currency??fact?.currency;
  return currency?{...source,values:source.values.map(value=>value.toUpperCase().includes(currency.toUpperCase())?value:`${value} ${currency}`)}:source;
 });
 const decision=personalBankDecision({...row,crossChecks:checks},!!state.readOnly,state);
 return <section className="personal-bank-review" aria-label="按银行原表核对">
  <p role="status">{state.readOnly?'当前轮次只读，以下为历史核对结果。':'系统会自动核对可用材料；需要补充的信息和人工决定会列在当前项下方。'}</p>
  <div className="field-comparison-heading"><h3>{checks.length?'跨文件判定链':'原文与要求核对'}</h3></div>
  <PersonalFieldComparison checks={readingChecks} focus={focus} requirements={checks.length?checks.flatMap(check=>check.bankRule!.requirement?[check.bankRule!.requirement]:[]):row.rules.map(rule=>rule.text)}/>
  <FieldDecisionStrip decision={decision} bankRule/>
  <section className="field-conclusion" aria-label="当前字段检查结论">
   <div className="field-section-title"><h3>为何这样判断</h3></div>
   {row.verification?.origin==='automatic'&&<p>{row.verification.status==='pending'?'自动核对仍有未完成项；具体缺项或业务条件见下方。':'本项已自动核对，无需逐项点击确认。'}{row.verification.scope==='source_check'&&row.verification.status==='confirmed'?'已确认的是原文取值；下方银行要求和适用条件分别列示。':''}</p>}
   {row.verification&&<p role="status">{row.verification.validity==='current'?row.verification.reason:'上次保存的依据已变化，请重新核对当前项。'}</p>}
   {checks.map(check=><div className="field-check-explanation" key={check.id}><p>{checks.length>1?`${check.label}：`:''}{labels[check.outcome]}。{check.reason}</p></div>)}
   {!checks.length&&<p>提取值按对应原文核验；法律结论、适用条件和主体归属按本项具体要求确认。</p>}
   {checks.some(check=>check.bankRule!.row===6)&&<p>授信函或客户官方注册文件可任选其一核对客户名称；未提供授信函时，按银行要求保留人工判断。</p>}
   {inputs}
   {!!guidance.length&&<section aria-label="还需要你做什么"><h4>还需要你做什么</h4><ul>{guidance.map(message=><li key={message}>{message}</li>)}</ul></section>}
   {!!decision.conditions?.length&&<div className="personal-bank-conditions"><h4>核对结果与具体条件</h4><ul>{decision.conditions.map(condition=><li key={condition.id}><strong>{condition.label}</strong><p>{condition.detail}</p></li>)}</ul></div>}
   {!!checks.length&&<section className="field-rule-details"><h3>规则原文</h3>
    {checks.map(check=><div className="personal-bank-rule" key={check.id}>
     {checks.length>1&&<h4>{check.label}</h4>}
     <p className="personal-comparison-filename">{check.bankRule!.reference}</p>
     <div className="field-rule-line"><h4>判断规则及可接受差异</h4><p>{check.bankRule!.requirement||'本行未填写判断规则，请按处理要求人工核对。'}</p></div>
     {check.bankRule!.notice&&<div className="field-rule-line"><h4>异常处理或需人工判断的情况</h4><p>{check.bankRule!.notice}</p></div>}
     {check.bankRule!.applicability&&<p>提取信息表要求：{check.bankRule!.applicability}</p>}
     {check.bankRule!.row===40&&<p>规则依据：关于法律意见书的审核要求，见单独的 checklist。</p>}
    </div>)}
   </section>}
   <PersonalFieldSources checks={readingChecks} focus={focus} caseId={state.caseId} roundId={state.roundId}/>
  </section>
  <FieldWorkflow row={row} state={state} decision={decision} onEditObject={onEditObject} onEditFact={onEditFact} ownershipRequired={!checks.length||checks.some(check=>check.method==='manual')}/>
 </section>;
}
