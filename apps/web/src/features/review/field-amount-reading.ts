import {decimalKey} from '@hsbc/contracts/field-focused-reading';
export {decimalKey} from '@hsbc/contracts/field-focused-reading';
import type {CrossFileCheck} from '@hsbc/contracts/review-checklist';
import {focusedSourceReading} from './cross-file-presentation.ts';
import {focusKind,type FieldFocus} from './field-focused-reading.ts';
import {sourceIsPendingBusinessValue} from './field-desk-checks.ts';

// Compare only the numbers displayed on the desk, without adopting facts or
// replacing the server's currency, attribution and business-rule assessment.
export function fieldAmountReading(checks:CrossFileCheck[],focus:FieldFocus):{label:string;detail:string}|undefined {
  if(focusKind(focus)!=='amount'||!checks.length)return undefined;
  const entries=checks.flatMap(check=>check.sources.filter(source=>!sourceIsPendingBusinessValue(source))
    .map(source=>({source,values:focusedSourceReading(check,source,focus).values})));
  const pending={label:'金额尚未明确',detail:'部分文件没有明确的单一金额，暂不能完成数字对照。'};
  if(entries.some(({source})=>source.state==='processing'))return {label:'金额提取中',detail:'材料仍在提取，完成后更新数字对照。'};
  if(entries.some(({values})=>!values.length))return pending;
  if(new Set(entries.flatMap(({source})=>source.documentId?[source.documentId]:[])).size<2)
    return {label:'缺少对照金额',detail:'尚未取得两份文件的对应金额。'};
  const numbers=entries.map(({values})=>[...new Set(values.map(decimalKey))]);
  if(numbers.some(values=>values.length!==1||values[0]===undefined))return pending;
  const same=new Set(numbers.map(values=>values[0])).size===1;
  return {label:same?'金额数字相同':'金额数字不同',detail:same?
    '两侧文件的金额数字相同；币种、材料归属及是否满足本次担保要求由业务检查另行核对。':
    '两侧文件的金额数字不同；是否达到要求仍须结合币种、比较基准及担保条件检查。'};
}
