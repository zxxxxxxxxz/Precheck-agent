import React from 'react';
import type {DocumentFieldPresentation} from '@hsbc/contracts/document-presentation';
import {assessFieldQuality,fieldQualityReason} from '@hsbc/contracts/field-quality';
import {describeProcessingNote} from '../../processing-notes.ts';
import {visibleProcessingGap} from './diagnostic-visibility.ts';

type ExtractionState = {label:string;tone:'plain'|'muted'|'warning'|'neutral'};
type NoticeOptions = {hasValue:boolean;detail?:string;detailsInline?:boolean};
const unspecifiedReason='提取记录未说明待核对原因，请核对原文';
const genericReasons=new Set(['待核对','待人工核对','需人工确认',fieldQualityReason('unknown'),fieldQualityReason('extraction_uncertain')]);

/** Use field-local diagnostics; never infer a source failure from an uncertain status alone. */
export function fieldExtractionNoticeDetail(field:DocumentFieldPresentation,gaps:readonly string[]=field.coverageGaps):string|undefined {
  const quality=assessFieldQuality({...field,coverageGaps:gaps},{multiple:true});
  const reasons=quality.reasonCodes.filter(code=>visibleProcessingGap(code)||code==='source_text_conflict').map(code=>{
    if(code==='extraction_uncertain')return unspecifiedReason;
    const reason=fieldQualityReason(code);
    if(reason!==fieldQualityReason('unknown'))return reason;
    const note=describeProcessingNote(code);
    return note.title==='解析提示暂无法解释'?'提取记录包含尚未识别的问题类型，请核对原文':note.explanation;
  });
  return reasons.length?[...new Set(reasons)].join('；'):undefined;
}

/** Reading presentation only: retain status/attention for filtering and business review. */
export function extractionNoticeText(state:ExtractionState,{hasValue,detail,detailsInline}:NoticeOptions):string|null {
  if(detailsInline&&hasValue)return null;
  if(hasValue&&['在信息核对中判断','审核时计算','原文已识别'].includes(state.label))return null;
  const summary=/^(?:已提取(?: \d+ (?:项|个名称组))?|已保留 \d+ 个值|已整理 \d+ 条表内人员记录|已找到 \d+ 处(?:签署|签字样本))(?: · (.+))?$/u.exec(state.label);
  if(summary&&hasValue){
    if(summary[1])return genericReasons.has(summary[1])?detail||unspecifiedReason:summary[1];
    return state.tone==='warning'?detail||(/^已保留 \d+ 个值$/u.test(state.label)?'存在多个取值，需核对采用值':unspecifiedReason):null;
  }
  if(/^(?:待核对|待人工核对|需人工确认|有候选待人工核对)$/u.test(state.label))return detail||unspecifiedReason;
  if(/^多个候选（\d+）$/u.test(state.label))return detail||'存在多个取值，需核对采用值';
  return state.label;
}

export function ExtractionNotice({state,className='field-state',...options}:NoticeOptions&{state:ExtractionState;className?:string}) {
  const text=extractionNoticeText(state,options);
  return text?<span className={`${className} tone-${state.tone}`}>{text}</span>:null;
}
