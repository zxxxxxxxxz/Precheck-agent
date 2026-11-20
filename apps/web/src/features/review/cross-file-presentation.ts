import {sourceGap} from './field-gap-guidance.ts';
import {fixedComparisonValue,type CrossFileCheck,type CrossFileValue} from '@hsbc/contracts/review-checklist';

import {crossFileSourceReading} from '@hsbc/contracts/personal-bank-comparison';
export {crossFileSourceReading} from '@hsbc/contracts/personal-bank-comparison';

import {focusedValues,sourceFocus,focusKind,type FieldFocus} from './field-focused-reading.ts';
import {fieldQualityReason} from '@hsbc/contracts/field-quality';

/** Resolved candidates are the system's final extraction. Cross-file differences
 * are reported by the comparison, not by warnings about discarded alternatives. */
export function crossFileSourceWarnings(source:CrossFileValue):string[] {
  return source.displaySelection&&source.displaySelection.reason!=='unresolved'
    ?source.warnings.filter(warning=>warning!==fieldQualityReason('multiple_field_candidates'))
    :source.warnings;
}



export function focusedSourceReading(check:CrossFileCheck,source:CrossFileValue,selected?:FieldFocus) {
  if(fixedComparisonValue(source.fieldId)!==undefined)return {label:'要求',values:['是'],focused:false};
  const selectedSource=source.displaySelection?{...source,values:source.displaySelection.values}:source;
  const reading=crossFileSourceReading(check,selectedSource);
  // The personal amount rule already receives the complete scalar, including
  // words and figures. Do not hide it behind the name/compound-clause reader.
  if(check.bankRule&&[7,19].includes(check.bankRule.row)&&['pg_field_7','pg_field_17','pg_required_amount'].includes(source.fieldId))return reading;
  const field=sourceFocus(source,selected);
  const extracted=reading.values.flatMap(value=>focusedValues(value,reading.focused?{...field,label:reading.label}:field,
    {compound:['cgt_field_12','cgt_facility_guarantee_terms','cgt_facility_parties'].includes(source.fieldId)&&!reading.focused}));
  const values=/公司|客户名称|客戶名稱|担保人名称|Guarantor|Borrower/iu.test(reading.label)?extracted.filter(value=>!extracted.some(other=>other!==value&&
    (key(other)===key(value)+'limited'||key(other)===key(value)+'ltd.'||/^(?:limited|ltd\.?|有限公司)$/iu.test(value)&&key(other).endsWith(key(value))))):extracted;
  return {...reading,label:focusKind(source)!==focusKind(field)?field.label:reading.label,values:[...new Set(values)],focused:reading.focused||JSON.stringify(values)!==JSON.stringify(source.values)};
}

const key = (value:string)=>value.normalize('NFKC').replace(/\s+/gu,'').toLowerCase();


export function crossFileMissingText(source:CrossFileValue,focused=false){
  const gap=sourceGap(source);
  if(gap)return `${gap.summary}。${gap.action}`;
  return source.state==='processing'?'正在提取，完成后自动更新':source.missingText??(source.state==='pending_confirmation'?'尚待人工确认':focused?'未能从条款中单独识别本项名称，请查看原文':'尚无对应取值');
}
