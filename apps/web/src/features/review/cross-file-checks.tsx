import React,{useState} from 'react';
import {comparisonSource,type CrossFileCheck} from '@hsbc/contracts/review-checklist';
import {EvidenceLinks} from './evidence-links.tsx';
import {crossFileMissingText,focusedSourceReading,crossFileSourceWarnings} from './cross-file-presentation.ts';
import './cross-file-checks.css';
import {focusedChecks,type FieldFocus} from './field-focused-reading.ts';
import {isBusinessSource,sourceGap} from './field-gap-guidance.ts';

export const crossFileLabels:Record<CrossFileCheck['outcome'],string>={consistent:'一致',different:'存在差异',insufficient:'证据不足',manual:'待确认条件',single_source:'缺少对照文件',not_applicable:'不适用'};
export type CrossFileFilter='different'|'consistent'|'manual'|'insufficient';
export function matchesCrossFileFilter(check:CrossFileCheck,filter:CrossFileFilter){
  return filter==='manual'?check.outcome==='manual'||check.manualReasons.length>0:filter==='insufficient'?['insufficient','single_source'].includes(check.outcome):check.outcome===filter;
}
export function CrossFileReport({checks,caseId}:{checks:CrossFileCheck[];caseId:string}){
  const [filter,setFilter]=useState<CrossFileFilter>();
  const shown=checks.filter(c=>!filter||matchesCrossFileFilter(c,filter));
  return <section className="cross-file-report" aria-label="本轮跨文件核对结果"><h2>本轮跨文件核对</h2>
    <div className="cross-file-filter" role="group" aria-label="筛选跨文件结果"><button type="button" aria-pressed={!filter} onClick={()=>setFilter(undefined)}>全部 {checks.length}</button>{(['different','consistent','manual','insufficient'] as const).map(value=><button type="button" key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{crossFileLabels[value]} {checks.filter(c=>matchesCrossFileFilter(c,value)).length}</button>)}</div>
    <p className="help-text">已保存本轮取值和依据。文字或数值一致的项目仍可能需要人工判断。</p>
    {shown.map(check=><details className="cross-file-report-item" key={check.id}><summary><span>{check.label}</span><strong>{crossFileLabels[check.outcome]}{check.manualReasons.length&&check.outcome!=='manual'?' · 待确认条件':''}</strong></summary><CrossFileChecks checks={[check]} caseId={caseId} compact/></details>)}
    {!shown.length&&<p>没有此类核对结果。</p>}
  </section>;
}
export function CrossFileChecks({checks,caseId,compact=false,focus,desk=false}:{checks:CrossFileCheck[];caseId:string;compact?:boolean;focus?:FieldFocus;desk?:boolean}){
  const shown=focus&&!desk?focusedChecks(checks,focus):checks.map(check=>({...check,sources:check.sources.map(comparisonSource)}));
  return <div className={`cross-file-checks${desk?' field-desk-comparison':''}`}>{shown.filter(check=>!desk||check.reviewItems?.some(item=>item.kind==='notice')||check.sources.some(source=>!isBusinessSource(source)||check.outcome!=='not_applicable'||source.values.length>0)).map(check=><section key={check.id} className={`cross-file-check cross-file-${check.outcome}`} aria-label={`${check.label}跨文件核对`}>
    {!desk&&<header><h3>{check.label}</h3><strong className="cross-file-outcome">{crossFileLabels[check.outcome]}</strong></header>}
    {!desk&&<p className="cross-file-reason">{check.reason}</p>}
    {!desk&&!!check.manualReasons.length&&<div className="cross-file-manual"><strong>待确认条件</strong><ul>{check.manualReasons.map(reason=><li key={reason}>{reason}</li>)}</ul></div>}
    {!!check.reviewItems?.some(item=>item.kind==='notice')&&<div className="cross-file-notes"><strong>条款提醒</strong>{check.reviewItems.filter(item=>item.kind==='notice').map(item=><p key={item.id}>{item.title}：{item.action}</p>)}</div>}
    <div className="cross-file-sources">{check.sources.filter(source=>!desk||!isBusinessSource(source)).map(source=>{const reading=focusedSourceReading(check,source,focus);const warnings=crossFileSourceWarnings(source);return <article key={source.id}>
      <div className="cross-file-source-heading"><strong>{source.filename}</strong><span>{reading.label}</span></div>
      {reading.values.length?reading.values.map((value,index)=><p className="cross-file-value" key={index}>{value}</p>):<p className={`cross-file-missing${source.missingText?' cross-file-missing-counterpart':''}`}>{check.outcome==='not_applicable'?'本项不适用，无需补充此取值':crossFileMissingText(source,reading.focused)}</p>}
      {!desk&&!!warnings.length&&<details className="cross-file-notes"><summary>需核对原文 · {warnings.length} 项原因</summary><ul className="cross-file-warnings">{warnings.map(warning=><li key={warning}>{warning}</li>)}</ul></details>}
      {!desk&&reading.focused&&!!source.values.length&&<details className="cross-file-full-extract"><summary>查看完整提取内容</summary>{source.values.map((value,index)=><p key={index}>{value}</p>)}</details>}
      {!desk&&!!source.evidence.length&&<EvidenceLinks caseId={caseId} evidence={source.evidence} compact names={source.documentId?{[source.documentId]:source.filename}:{}}/>}
    </article>;})}{desk&&check.sources.some(source=>isBusinessSource(source)&&(check.outcome!=='not_applicable'||source.values.length>0))&&<article>
      <div className="cross-file-source-heading"><strong>本项确认信息</strong><span>用于判断是否满足本次要求</span></div>
      {check.sources.filter(source=>isBusinessSource(source)&&(check.outcome!=='not_applicable'||source.values.length>0)).map(source=><p className="cross-file-missing" key={source.id}>{source.values.length?`${source.label}：`+source.values.map(value=>value==='limited'?'有限额责任':value==='unlimited'?'无限额责任':value).join(' / '):sourceGap(source)?.summary??`尚未确认${source.label}`}</p>)}
    </article>}</div>
    {!compact&&!desk&&<p className="help-text">对照基于本轮文件的原文取值；业务处置请结合上方人工判断事项。</p>}
  </section>)}</div>;
}
