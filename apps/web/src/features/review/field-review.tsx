import {checkGaps,sourceGap} from './field-gap-guidance.ts';
import {PersonalRequiredInputs} from './personal-required-inputs.tsx';
import {PersonalBankSupport} from './personal-bank-support-view.tsx';
import {fieldReviewLabels} from './field-review-status.ts';
import {PersonalBankReview} from './personal-bank-review.tsx';
import {PersonalFieldComparison,PersonalFieldSources} from './personal-field-comparison.tsx';
import {FieldWorkflow} from './field-workflow.tsx';
import {UploadDateBasis} from './upload-date-baseline.tsx';
import {FieldVerificationView,hasCustomerAddressBusinessCheck} from './field-verification.tsx';
import {CrossFileSemanticActions} from './cross-file-semantic-actions.tsx';
import {CrossFileChecks} from './cross-file-checks.tsx';
import React, {useState} from 'react';
import {Button, Select} from 'antd';
import type {ChecklistRow,CrossFileCheck} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import {can} from '../identity/permissions.ts';
import {canEditField, fieldBusinessRules, fieldComparison, type FieldSourceValue} from './field-comparison.ts';
import {useEvidenceParagraphs} from './use-evidence-paragraphs.ts';
import {fieldValueReading} from './field-value-reading.ts';
import {FieldSemantic} from './field-semantic.tsx';
import {reviewReasonLabels} from './presentation.ts';
import {focusedValues,focusKind,rowFocus} from './field-focused-reading.ts';
import {fieldDeskChecks,withScopedReading} from './field-desk-checks.ts';
import {fieldDecision} from './field-decision.ts';
import {FieldDecisionStrip} from './field-decision-strip.tsx';
import {fieldRuleReading} from './field-rule-reading.ts';

export interface FieldDeskActions {
  onEditFact: (row: ChecklistRow) => void;
  onEditObject: (row: ChecklistRow) => void;
  onManageObjects: () => void;
}

export function FieldReview(props:React.ComponentProps<typeof FieldReviewContent>){
  const owner=props.state.objects.find(o=>o.objectId===props.row.objectId);
  const editable=!props.state.readOnly&&can(props.state.allowedActions,'field:correct');
  return <>{owner?.automaticAttribution&&<p className="help-text">材料已自动关联至 {owner.label}，无需再次确认归属{editable?'；如有误，可更正关联。':'。'}</p>}<FieldReviewContent {...props}/></>;
}

function FieldReviewContent({row, rows, state, names, onEditFact, onEditObject}: FieldDeskActions & {
  row: ChecklistRow; rows: ChecklistRow[]; state: ReviewState; names: Record<string, string>;
}) {
  const [source, setSource] = useState<string>();
  const comparison = fieldComparison(row, rows, state, source);
  const sourceOnly=['corporate_guarantee','personal_guarantee'].includes(row.objectRole??'')&&row.crossChecks?.length===0;
  const reading = useEvidenceParagraphs(state.caseId,comparison.evidence);
  const editable = !state.readOnly && can(state.allowedActions, 'field:correct');
  const owner = state.objects.find(o => o.objectId === row.objectId);
  const run = state.runs[0];
  const results = row.objectId ? run?.results.filter(r => r.scopeId === row.objectId && row.rules.some(rule => rule.id === r.ruleId)) ?? [] : [];
  const stale = run && (run.validity === 'stale' || run.configurationReleaseId !== state.configurationReleaseId);
  const rules = fieldBusinessRules(row);
  const ruleReading = fieldRuleReading(row);
  const focus=rowFocus(row,state.configuration?.fields.find(field=>field.id===row.fieldId)?.type);
  const checks=fieldDeskChecks(row,rows);
  const readingChecks:CrossFileCheck[]=checks.length?checks:[{id:row.id,label:row.label,fieldIds:[row.fieldId],objectId:row.objectId,method:'manual',outcome:'manual',reason:row.reason,manualReasons:[],sources:row.sourceValues?.length?row.sourceValues.map(source=>withScopedReading(source,focusKind(focus))):
    [...comparison.primary,...comparison.references].map(value=>({id:value.id,fieldId:row.fieldId,label:row.label,documentId:value.documentId??null,filename:value.label,values:value.value?[fieldValueReading(value,reading.error?undefined:reading.data)??'']:[],evidence:value.evidence,warnings:[],state:value.stale?'uncertain':'available'}))}];
  const decision=fieldDecision(row,state,readingChecks,focus);
  const gaps=checks.flatMap(checkGaps);
  const sourceValue = (value: FieldSourceValue) => {
    const text = fieldValueReading(value,reading.error?undefined:reading.data);
    const values=text?focusedValues(text,focus):[];
    const paragraphs=values.length?values:[text?'未能明确分离本项取值，请查看原文':'未取得值'];
    return <article className="field-source-value" key={value.id}>
    {(sourceOnly||comparison.documents.length > 1) && <p className="field-source-label">{value.documentId ? names[value.documentId] ?? value.label : value.label}</p>}
    {paragraphs.map((paragraph,index)=><p className="checklist-value" key={index}>{paragraph}{focusKind(focus)!=='amount'&&index===paragraphs.length-1&&<>{value.currency && !paragraph.includes(value.currency) && <small> {value.currency}</small>}{value.unit && <small> {value.unit}</small>}</>}</p>)}
    {(value.stale || value.origin === 'fact') && <p className="help-text">{value.stale ? '已失效，待重新确认' : row.fact?.automaticAdoption ? '提取值已用于检查' : '人工采用值'}</p>}
  </article>;
  };
  if(row.objectRole==='personal_guarantee'&&(!state.readOnly||row.crossChecks?.some(c=>c.bankRule)))return <>
    <CrossFileSemanticActions checks={row.crossChecks??[]} state={state} fieldId={row.fieldId}/>
    <PersonalBankReview row={row} state={state} inputs={<PersonalRequiredInputs row={row} rows={rows} state={state} onEditFact={onEditFact} onEditObject={onEditObject}/>} onEditObject={()=>onEditObject(row)} onEditFact={editable&&canEditField(row.fieldId)&&owner?.validity==='current'?()=>onEditFact(row):undefined}/>
    <PersonalBankSupport row={row} rows={rows} state={state} onEditFact={onEditFact}/>
  </>;
  if(row.objectRole==='personal_guarantee'){
    const saved=row.verification;
    if(saved){const current=saved.validity==='current';decision.conclusion={label:current?fieldReviewLabels[saved.status]:'待重新核对',note:current?'核对结果已保存':'材料或案件信息已变化',tone:!current||saved.status==='pending'?'pending':saved.status==='different'?'attention':'pass'};}
    return <>
      <CrossFileSemanticActions checks={row.crossChecks??[]} state={state} fieldId={row.fieldId}/>
      <div className="field-comparison-heading"><h3>跨文件判定链</h3></div>
      <PersonalFieldComparison checks={readingChecks} focus={focus} requirements={ruleReading.requirements}/>
      <FieldDecisionStrip decision={decision}/>
      <section className="field-conclusion" aria-label="当前字段检查结论">
        <div className="field-section-title"><h3>为何这样判断</h3>{editable&&canEditField(row.fieldId)&&<div className="field-inline-actions">
          {owner?.validity==='current'&&<Button type="link" size="small" onClick={()=>onEditFact(row)}>{row.fact?'更正字段值':'确认采用值'}</Button>}
          <Button type="link" size="small" onClick={()=>onEditObject(row)}>{owner?'调整材料归属':'确认材料归属'}</Button>
        </div>}</div>
        {saved?<div className="field-check-explanation"><p>{saved.validity==='current'?saved.reason:`上次核对：${saved.reason}`}</p>{!!saved.actions.length&&<ul>{saved.actions.map((action,i)=><li key={i}>{action}</li>)}</ul>}</div>:checks.length?checks.map(check=><div className="field-check-explanation" key={check.id}><p>{check.reason}</p>{!!check.manualReasons.length&&<ul>{check.manualReasons.map(reason=><li key={reason}>{reason}</li>)}</ul>}</div>):<p>{row.reason}</p>}
        {stale&&<p className="tone-warning" role="status">依据已变化，需重新检查。</p>}
        {results.map(result=><p key={`${result.ruleId}:${result.scopeId}`}>{reviewReasonLabels[result.reasonCode]??'请结合本项规则要求与对应原文核对。'}{result.details?.expiryDate&&` 系统计算到期日：${result.details.expiryDate}`}</p>)}
        <FieldSemantic state={state} row={row}/>
        <section className="field-rule-details"><h3>规则原文</h3>
          {!!ruleReading.requirements.length&&<div className="field-rule-line"><h4>判断规则及可接受差异</h4>{ruleReading.requirements.map((text,index)=><p key={index}>{text}</p>)}</div>}
          {!!ruleReading.exceptions.length&&<div className="field-rule-line"><h4>异常处理或需人工判断的情况</h4>{ruleReading.exceptions.map((text,index)=><p key={index}>{text}</p>)}</div>}
          {!!ruleReading.supplementary.length&&<details className="field-rule-supplement"><summary>相关检查说明</summary>{ruleReading.supplementary.map(rule=><article key={rule.id}><h4>{rule.label}</h4><p>{rule.text}</p></article>)}</details>}
        </section>
        <PersonalFieldSources checks={readingChecks} focus={focus} caseId={state.caseId} roundId={state.roundId}/>
      </section>
      {!!decision.workflow?.some(task=>task.id!=='ownership')&&<FieldWorkflow row={row} state={state} decision={decision} onEditObject={()=>onEditObject(row)} onEditFact={editable&&canEditField(row.fieldId)&&owner?.validity==='current'?()=>onEditFact(row):undefined}/>}
    </>;
  }
  if(row.verification&&!hasCustomerAddressBusinessCheck(row)&&!(row.documentScope&&!state.readOnly&&row.crossChecks?.some(c=>c.bankExecution||c.valueBasis==='extracted')))return <><UploadDateBasis row={row}/><FieldVerificationView decision={decision} record={row.verification} row={row} state={state} onEditObject={()=>onEditObject(row)} onEditFact={editable&&canEditField(row.fieldId)&&owner?.validity==='current'?()=>onEditFact(row):undefined}/></>;
  return <>
    {row.objectRole!=='corporate_guarantee'&&<CrossFileSemanticActions checks={row.crossChecks??[]} state={state} fieldId={row.fieldId}/>}
    <div className="field-comparison-heading"><h3>{sourceOnly?'提取值与原文核对':'跨文件判定链'}</h3></div>
    {row.crossChecks?.length ? <CrossFileChecks checks={checks} caseId={state.caseId} focus={focus} desk/> : sourceOnly ? <>
    <div className="field-value-comparison field-cross-comparison"><section aria-label="文件取值"><h4>文件 A · 提取结果</h4>
      {[...comparison.primary,...comparison.references].map(sourceValue)}
      {!comparison.primary.length&&!comparison.references.length&&<p className="field-comparison-empty">尚未取得字段值</p>}
    </section><section><h4>本项检查要求</h4>{row.fieldId==='cgt_field_45'&&<p>“身份”指年报所列人员的职务，例如董事或候补董事。</p>}{rules.length ? rules.map(rule=><p key={rule.id}>{rule.text}</p>) : <p>{row.definition}</p>}</section></div>
    </> : <>
    <div className="field-source-selector">{comparison.documents.length > 1 && <Select size="small" aria-label="当前对照文件" value={comparison.documentId} onChange={setSource}
      options={comparison.documents.map(id => ({value: id, label: names[id] ?? `文件 ${id.slice(0, 8)}`}))}/>}</div>
    <div className="field-value-comparison field-cross-comparison">
      <section><h4>文件 A · 提取结果</h4>{comparison.primary.length ? comparison.primary.map(sourceValue) : <p className="field-comparison-empty">尚未取得字段值</p>}</section>
      <section><h4>对应文件取值</h4>{comparison.references.map(sourceValue)}
        {comparison.missing.map(other => <article key={other.id} className="field-source-value"><p className="field-source-label">{other.materialTypes.map(m => m.label).join(' / ')} · {other.label}</p><p>尚无可对照的字段值</p><p className="help-text">{other.reason}</p></article>)}
        {!comparison.references.length && <p>尚无对应文件的取值，无法完成跨文件核对。请查看材料处理状态。</p>}
      </section>
    </div>
    </>}
    <FieldDecisionStrip decision={decision}/>
    <section className="field-conclusion" aria-label="当前字段检查结论">
      <div className="field-section-title"><h3>核对结果与具体条件</h3></div>
      {!!decision.comparisons?.length&&<ul className="field-check-findings" aria-label="自动核对结果">{decision.comparisons.map((result,index)=><li key={index}><strong>{result.label}</strong><span>{result.note}</span></li>)}</ul>}
      {!!decision.conditions?.length&&<ul className="field-pending-conditions" aria-label="待完成的具体条件">{decision.conditions.map(condition=>{
        const target=condition.fieldId?rows.find(other=>other.fieldId===condition.fieldId&&other.objectId===row.objectId&&other.objectRole===row.objectRole):undefined;
        return <li key={condition.id}><div><small className="field-condition-kind">{{confirmation:'需确认',evidence:'需核实',processing:'自动继续',workflow:'流程待办'}[condition.kind]}</small><strong>{condition.label}</strong><p>{condition.detail}</p></div>
          {editable&&condition.id==='ownership'&&<Button size="small" onClick={()=>onEditObject(row)}>确认归属</Button>}
          {editable&&owner?.validity==='current'&&target&&canEditField(target.fieldId)&&<Button size="small" onClick={()=>onEditFact(target)}>确认取值</Button>}
        </li>;
      })}</ul>}
      {!decision.conditions?.length&&!decision.comparisons?.length&&<p style={{whiteSpace:'pre-line'}}>{sourceOnly?row.reason||decision.conclusion.note:decision.conclusion.note}</p>}
      {!decision.conditions?.length&&!!gaps.length&&<ul>{[...new Set(gaps.map(gap=>gap.action))].map(action=><li key={action}>{action}</li>)}</ul>}
      {editable&&owner?.validity==='current'&&row.objectRole==='corporate_guarantee'&&<div className="field-inline-actions">{['cgt_limited','cgt_user_required_amount','cgt_user_required_currency'].filter(id=>checks.some(check=>check.outcome!=='not_applicable'&&check.sources.some(source=>source.fieldId===id&&sourceGap(source)?.kind==='confirmation'))).map(id=>{
        const input=rows.find(other=>other.fieldId===id&&other.objectId===row.objectId&&other.objectRole===row.objectRole);
        return input&&canEditField(input.fieldId)?<Button key={id} type="link" size="small" onClick={()=>onEditFact(input)}>填写{input.label}</Button>:null;
      })}</div>}
      {stale && <p className="tone-warning" role="status">依据已变化，需重新检查。</p>}
      {results.map(result => <article className={`field-check-result ${stale ? 'is-stale' : result.outcome === 'fail' ? 'has-difference' : ''}`} key={`${result.ruleId}:${result.scopeId}`}>

        <p>{reviewReasonLabels[result.reasonCode] ?? '请结合本项规则要求与对应原文核对。'}</p>{result.details?.expiryDate && <p>系统计算到期日：{result.details.expiryDate}</p>}
      </article>)}

      <FieldSemantic state={state} row={row}/>
    </section>
    {!(row.objectRole==='corporate_guarantee'&&row.documentScope&&!state.readOnly)&&<FieldWorkflow row={row} state={state} decision={decision} onEditObject={()=>onEditObject(row)} onEditFact={editable&&canEditField(row.fieldId)&&owner?.validity==='current'?()=>onEditFact(row):undefined}/>}
    <section className="field-rule-details"><h3>规则原文</h3>
      {!!ruleReading.requirements.length&&<div className="field-rule-line"><h4>判断规则及可接受差异</h4>{ruleReading.requirements.map((text,index)=><p key={index}>{text}</p>)}</div>}
      {!!ruleReading.exceptions.length&&<div className="field-rule-line"><h4>异常处理或需人工判断的情况</h4>{ruleReading.exceptions.map((text,index)=><p key={index}>{text}</p>)}</div>}
      {!!ruleReading.supplementary.length&&<details className="field-rule-supplement"><summary>相关检查说明</summary>{ruleReading.supplementary.map(rule=><article key={rule.id}><h4>{rule.label}</h4><p>{rule.text}</p></article>)}</details>}
    </section>

  </>;
}
