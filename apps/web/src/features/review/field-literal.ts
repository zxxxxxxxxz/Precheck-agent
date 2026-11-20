import {gapDecision} from './field-gap-guidance.ts';
import {fixedComparisonValue,type CrossFileCheck} from '@hsbc/contracts/review-checklist';
import {focusedSourceReading} from './cross-file-presentation.ts';
import {decimalKey} from './field-amount-reading.ts';
import {focusKind,type FieldFocus} from './field-focused-reading.ts';
import {sourceIsPendingBusinessValue} from './field-desk-checks.ts';
export interface DecisionStep {label:string;note:string;tone:'neutral'|'pass'|'attention'|'pending'}
export const decisionStep=(label:string,note:string,tone:DecisionStep['tone']='neutral'):DecisionStep=>({label,note,tone});
const step=decisionStep;
const textKey=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/gu,' ').toUpperCase();
const currencyNames:Record<string,string>={RMB:'CNY',人民币:'CNY',人民幣:'CNY',美元:'USD',美金:'USD','US$':'USD',港币:'HKD',港幣:'HKD',港元:'HKD','HK$':'HKD',欧元:'EUR',歐元:'EUR',英镑:'GBP',英鎊:'GBP',日元:'JPY',新加坡元:'SGD',NTD:'TWD','NT$':'TWD',新台币:'TWD',新臺幣:'TWD',新台幣:'TWD',台币:'TWD',臺幣:'TWD'};
function dateKey(raw:string):string|undefined {
  const value=raw.normalize('NFKC').trim();
  const numeric=/^(\d{4})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})日?$/u.exec(value);
  const roc=/^(?:民国|民國)\s*(\d{1,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/u.exec(value);
  const english=/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/iu.exec(value);
  const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
  const month=english?months.findIndex(m=>m===english[2]!.toLowerCase()||m.slice(0,3)===english[2]!.toLowerCase())+1:0;
  const parts=roc&&+roc[1]!>0?[+roc[1]!+1911,+roc[2]!,+roc[3]!]:numeric?[+numeric[1]!,+numeric[2]!,+numeric[3]!]:english&&month?[+english[3]!,month,+english[1]!]:undefined;
  if(!parts)return undefined;
  const [y,m,d]=parts as [number,number,number],date=new Date(Date.UTC(y,m-1,d));
  return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d?`${y}-${m}-${d}`:undefined;
}

/** Literal reading is independent of semantic advice and business approval. */
export function fieldLiteralDecision(checks:CrossFileCheck[],focus:FieldFocus):DecisionStep {
  const kind=focusKind(focus);
  const entries=checks.flatMap(check=>check.sources.filter(s=>fixedComparisonValue(s.fieldId)===undefined&&!sourceIsPendingBusinessValue(s)&&(!check.comparisons?.length||check.comparisons.some(c=>c.values.some(v=>v.sourceId===s.id))))
    .map(source=>({source,values:focusedSourceReading(check,source,focus).values})));
  if(entries.some(e=>e.source.state==='processing'))return step('正在提取','完成后自动更新对照','pending');
  if(!entries.length||entries.some(e=>!e.values.length))return step('无完整可比取值',gapDecision(checks)?.note??'尚未取得本项可比较的值，请查看对应原文','pending');
  if(new Set(entries.flatMap(e=>e.source.documentId?[e.source.documentId]:[])).size<2)
    return step('已取得字段值','与规则基准另行核对');
  const key=(value:string)=>kind==='amount'?decimalKey(value):kind==='date'?dateKey(value):kind==='currency'?
    currencyNames[textKey(value)]??(/^(?:USD|HKD|CNY|EUR|GBP|JPY|SGD|AUD|CAD|CHF|NZD|TWD)$/u.test(textKey(value))?textKey(value):undefined):textKey(value);
  const values=entries.map(e=>[...new Set(e.values.map(key))].sort());
  if(values.some(v=>v.includes(undefined)||kind!=='text'&&v.length!==1))return step('取值尚未明确','存在多个取值或无法明确转换的格式','pending');
  const same=new Set(values.map(v=>JSON.stringify(v))).size===1;
  if(!same)return step(kind==='amount'?'金额数字不同':kind==='currency'?'币种不同':kind==='date'?'日期不同':'字面不同','是否同义见右侧语义结论');
  return step(kind==='amount'?'金额数字相同':kind==='currency'?'币种相同':kind==='date'?'日期相同':'字面一致',
    kind==='amount'?'已统一明确数字格式与数量级':kind==='date'?'已统一明确日期格式':kind==='currency'?'已统一明确币种名称':'已统一全半角、大小写与连续空白');
}
