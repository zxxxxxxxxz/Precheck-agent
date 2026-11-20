import React from 'react';
import type {CrossFileCheck} from '@hsbc/contracts/review-checklist';
import {personalComparisonSides} from './personal-field-presentation.ts';
import {focusedSourceReading,crossFileMissingText,crossFileSourceWarnings} from './cross-file-presentation.ts';
import {focusedValues,focusKind,type FieldFocus} from './field-focused-reading.ts';
import {EvidenceContent} from './evidence-content.tsx';
import {EvidenceLinks} from './evidence-links.tsx';
import './personal-field-comparison.css';

export function PersonalFieldComparison({checks,focus,requirements}:{checks:CrossFileCheck[];focus:FieldFocus;requirements:string[]}) {
  const {primary,references}=personalComparisonSides(checks,focus.fieldId);
  const sources=(items:typeof primary)=>{
    // Collapse repeated bank wording only. Person names, identity, addresses and
    // amounts remain per source so joint documents never suggest merged people.
    const bank=['pg_field_4','pg_field_21','pg_field_26'].includes(focus.fieldId);
    const groups=new Map<string,typeof primary>();
    for(const item of items){
      const reading=focusedSourceReading(item.check,item.source,focus);
      const key=bank&&reading.values.length&&item.source.state==='available'&&!item.source.warnings.length&&item.source.documentId?JSON.stringify(reading.values):item.source.id;
      groups.set(key,[...(groups.get(key)??[]),item]);
    }
    const showFilenames=[...groups.values()].filter(group=>group[0]?.source.documentId).length>1;
    return [...groups.values()].map(group=>{
      const {check,source}=group[0]!,reading=focusedSourceReading(check,source,focus);
      const currencies=focusKind(focus)==='amount'?[...new Set((source.displaySelection?.values??source.values).flatMap(value=>focusedValues(value,{fieldId:'currency',label:'币种'})))]:[];
      return <article className="personal-comparison-source" key={source.id}>
        {(source.documentId&&(showFilenames||check.bankRule)||!source.documentId&&check.bankRule)&&<p className="personal-comparison-filename">{source.documentId?`${source.filename}${check.bankRule?` · ${reading.label}`:''}`:source.label}</p>}
        {reading.values.length?reading.values.map((value,i)=>/<table\b/iu.test(value)?<div className="cross-file-value" key={i}><EvidenceContent text={value.replace(/\\n/gu,'\n')}/></div>:<p className="cross-file-value" key={i}>{value}{currencies.length>0&&!currencies.some(currency=>value.includes(currency))?` ${currencies.join(' / ')}`:''}</p>):<p className="field-comparison-empty">{source.state==='pending_confirmation'?`${source.label}：待确认`:crossFileMissingText(source,reading.focused)}</p>}
        {source.displaySelection?.reason==='highest_confidence'&&<p className="personal-comparison-filename">系统最终提取值 · 按最高置信度选定</p>}
        {focusKind(focus)==='amount'&&reading.values.length>0&&!currencies.length&&<p className="personal-comparison-filename">币种待确认</p>}
        {[...new Map((check.bankRule?.dates??[]).filter(date=>date.sourceId===source.id&&date.raw!==date.gregorian&&(!source.displaySelection||source.displaySelection.values.includes(date.raw))).map(date=>[date.gregorian,date])).values()].map((date,i)=><p className="personal-comparison-filename" key={`date-${i}`}>公历日期：{date.gregorian}（原日期保留如上）</p>)}
      </article>;
    });
  };
  return <div className="field-value-comparison personal-field-comparison">
    <section aria-label="当前字段提取结果"><h4>{primary.length&&primary.every(item=>!item.source.documentId)?'业务确认值':'文件 A · 提取结果'}</h4>{primary.length?sources(primary):<p className="field-comparison-empty">尚未取得当前字段值</p>}</section>
    <section aria-label="对应文件与规则基准"><h4>文件 B / 规则基准</h4>{references.length?sources(references):requirements.map((text,i)=><p key={i}>{text}</p>)}{checks.some(check=>check.bankRule?.currentDate)&&<p>当前日期（北京时间）：{checks.find(check=>check.bankRule?.currentDate)!.bankRule!.currentDate}</p>}{!references.length&&!requirements.length&&<p className="field-comparison-empty">暂无可用对照依据</p>}</section>
  </div>;
}

export function PersonalFieldSources({checks,focus,caseId,roundId}:{checks:CrossFileCheck[];focus:FieldFocus;caseId:string;roundId?:string|null}) {
  const {primary,references}=personalComparisonSides(checks,focus.fieldId);
  const sourceDetails=(items:typeof primary)=>items.map(({check,source})=><div key={source.id} className="personal-comparison-origin">
    <p className="personal-comparison-filename">{source.filename} · {focusedSourceReading(check,source,focus).label}</p>
    {source.displaySelection?.reason==='equivalent'&&<p className="personal-comparison-filename">同一字段的多个写法一致，已合并显示。</p>}
    {source.displaySelection?.reason==='highest_confidence'&&<p className="personal-comparison-filename">已按最高置信度确定本字段的最终提取值，后续核对使用该值。原始候选保留如下。</p>}
    {source.displaySelection?.reason==='unresolved'&&<p className="personal-comparison-filename">候选置信度相同或未提供，保留不同取值供核对。</p>}
    {(source.displaySelection?.originalValues??source.resolvedQuality?.originalValues??source.values).map((value,i)=>/<table\b/iu.test(value)?<div className="personal-comparison-extract" key={i}><EvidenceContent text={value.replace(/\\n/gu,'\n')}/></div>:<p className="personal-comparison-extract" key={i}>{value}</p>)}
    {source.resolvedQuality&&<div><p>{source.resolvedQuality.reason}</p><details><summary>查看原提取提示（本项名称已核验）</summary><ul>{source.resolvedQuality.warnings.map(warning=><li key={warning}>{warning}</li>)}</ul></details></div>}
    {!!crossFileSourceWarnings(source).length&&<ul>{crossFileSourceWarnings(source).map(warning=><li key={warning}>{warning}</li>)}</ul>}
    {!!source.evidence.length&&<EvidenceLinks caseId={caseId} roundId={roundId} evidence={source.evidence} compact names={source.documentId?{[source.documentId]:source.filename}:{}}/>}
  </div>);
  return <details className="personal-comparison-origins"><summary>查看核对来源与待办事项</summary>{sourceDetails([...primary,...references])}</details>;
}
