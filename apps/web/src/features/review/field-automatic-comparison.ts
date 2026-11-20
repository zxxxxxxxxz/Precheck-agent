import type {CrossFileCheck,CrossFileValue} from '@hsbc/contracts/review-checklist';
import {focusedSourceReading} from './cross-file-presentation.ts';
import {focusedValues,focusKind,type FieldFocus} from './field-focused-reading.ts';
import {sourceIsPendingBusinessValue} from './field-desk-checks.ts';
import type {DecisionStep} from './field-decision.ts';

const currencies:Record<string,string>={RMB:'CNY',人民币:'CNY',人民幣:'CNY',美元:'USD',美金:'USD','US$':'USD',港币:'HKD',港幣:'HKD',港元:'HKD','HK$':'HKD',欧元:'EUR',歐元:'EUR',英镑:'GBP',英鎊:'GBP',日元:'JPY',新加坡元:'SGD',NTD:'TWD','NT$':'TWD',新台币:'TWD',新臺幣:'TWD',新台幣:'TWD',台币:'TWD',臺幣:'TWD'};
const currencyKey=(raw:string)=>currencies[raw.toUpperCase()]??raw.toUpperCase();
const unique=<T>(values:T[])=>[...new Set(values)];
// Upload-day comparisons use current file metadata, not a text anchor.
export const missingSourceEvidence=(source:CrossFileValue)=>!!source.documentId&&source.fieldId!=='review_business_date'&&!source.evidence.length;
export function sourceCurrencies(source:CrossFileValue):string[] {
  return unique(source.values.flatMap(raw=>focusedValues(raw,{fieldId:source.fieldId,label:'币种',type:'currency'},
    {compound:['cgt_facility_guarantee_terms','cgt_facility_parties','pg_facility_parties'].includes(source.fieldId)})).map(currencyKey));
}

/** Deterministic file reading, independent of pending business adoption. Does
 * not approve rules, infer identity or interpret signatures/legal clauses. */
export function automaticFieldComparison(checks:CrossFileCheck[],focus:FieldFocus,literal:DecisionStep,original:CrossFileCheck[]):DecisionStep|undefined {
  const sources=unique(checks.flatMap(c=>c.sources).filter(s=>!sourceIsPendingBusinessValue(s)));
  if(!sources.length)return undefined;
  if(sources.some(s=>s.state==='processing'))return {label:'等待提取完成',note:'字段提取完成后更新核对结果',tone:'pending'};
  if(sources.some(s=>s.state!=='available'||s.warnings.length||missingSourceEvidence(s)))return {label:['金额数字相同','币种相同','日期相同','字面一致'].includes(literal.label)?`${literal.label}，来源待核实`:'核对依据待补齐',note:'已有取值可供对照，来源完整性及可靠性仍需核实',tone:'pending'};
  if(checks.some(c=>c.sources.filter(s=>!sourceIsPendingBusinessValue(s)).some(s=>!focusedSourceReading(c,s,focus).values.length)))return undefined;
  if(new Set(sources.flatMap(s=>s.documentId?[s.documentId]:[])).size<2)return literal.label==='已取得字段值'?
    {label:/签署|签字|Witness|Signature/iu.test(focus.label)?'已取得签署记录':'已取得明确取值',note:'已取得当前文件取值，需结合适用规则核对',tone:'neutral'}:undefined;
  const kind=focusKind(focus);
  if(kind==='amount'&&['金额数字相同','金额数字不同'].includes(literal.label)){
    const perSource=sources.map(source=>{
      const direct=sourceCurrencies(source);
      const companions=original.flatMap(c=>c.sources).filter(s=>source.documentId&&s.documentId===source.documentId&&focusKind(s)==='currency'&&s.state==='available'&&!s.warnings.length&&s.evidence.length);
      return unique([...direct,...companions.flatMap(sourceCurrencies)]);
    });
    if(perSource.some(v=>v.length!==1))return {label:literal.label,note:'金额数字已核对，需明确币种后判断是否满足要求',tone:'neutral'};
    if(new Set(perSource.map(v=>v[0])).size>1)return {label:'币种不同，金额不可直接比较',note:'币种不同，需确认适用币种及金额比较口径',tone:'attention'};
    return {label:literal.label==='金额数字相同'?'金额及币种一致':'同币种金额存在差异',note:`金额及 ${perSource[0]![0]} 币种已核对，是否满足要求需结合确认基准判断`,tone:literal.label==='金额数字相同'?'pass':'attention'};
  }
  if(literal.label==='币种相同')return {label:'币种一致',note:'对应币种名称或代码指向同一货币',tone:'pass'};
  if(literal.label==='币种不同')return {label:'币种存在差异',note:'对应文件币种不同，需核实适用币种',tone:'attention'};
  if(literal.label==='日期相同')return {label:'日期一致',note:'所指日期一致，相关事件及时间要求仍须核实',tone:'pass'};
  if(literal.label==='日期不同')return {label:'日期存在差异',note:'所指日期不同，需结合事件及时间要求判断',tone:'neutral'};
  if(literal.label==='字面一致')return {label:'表述一致',note:'文字内容一致，主体身份、授权及适用范围仍须核实',tone:'pass'};
  return undefined;
}
