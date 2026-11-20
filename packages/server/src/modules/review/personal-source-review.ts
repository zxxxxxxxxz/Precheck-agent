import type {FieldReviewItem} from '@hsbc/contracts/field-verification';
import type {ChecklistRow,CrossFileCheck,CrossFileValue} from '@hsbc/contracts/review-checklist';
import type {DB} from '../../infrastructure/database/client.js';
import {fieldReviewOriginalReader,originalContains,originalTextKey} from './field-review-original.js';

/** Check readable text without adopting a person, a fact, or document completeness.
 * A partial receipt may have independently verified text at the cited location.
 * It cannot use a stale receipt, search another page, or trust unvalidated OCR. */
export function personalSourceReviewer(db:DB){
 const original=fieldReviewOriginalReader(db,{independentText:true});
 async function grounded(source:CrossFileValue):Promise<FieldReviewItem['sources']|undefined>{
  if(!source.originalEligible||!source.documentId||!source.values.length||!source.evidence.length||
    !['available','uncertain'].includes(source.state))return;
  const found:FieldReviewItem['sources']=[];
  for(const value of source.values){
   if(!value.trim()||value.length>8000)return;
   let matched=false;
   for(const evidence of source.evidence){
    if(evidence.documentVersionId!==source.documentId)return;
    const quote=(await original(evidence)).find(q=>q.quote.length<=16000&&originalContains(q.quote,value)&&
      (!q.corroboratingQuotes||q.corroboratingQuotes.some(other=>originalContains(other,value))));
    if(!quote)continue;
    found.push({filename:source.filename,page:quote.page,evidence,kind:'original',comparisonKey:source.id,quote:quote.quote,value,highlights:[]});
    matched=true;break;
   }
   if(!matched){
    // Check the already-associated segments individually; never concatenate
    // arbitrary page text or borrow another candidate/person's source.
    for(const candidate of source.originalSegments?.filter(s=>s.value===value)??[]){
     const parts:FieldReviewItem['sources']=[];
     for(const part of candidate.parts){
      if(!part.value.trim()||!part.evidence.length||part.evidence.some(e=>e.documentVersionId!==source.documentId||!source.evidence.some(own=>JSON.stringify(own)===JSON.stringify(e))))break;
      const group=await grounded({...source,originalSegments:undefined,values:[part.value],evidence:part.evidence});
      if(!group)break;
      parts.push(...group);
     }
     if(candidate.parts.length&&parts.length===candidate.parts.length){found.push(...parts);matched=true;break;}
    }
   }
   if(!matched)return;
  }
  return found;
 }
 return {
  grounded,
  async gaps(row:ChecklistRow):Promise<string[]>{
   const inputs=(row.sourceValues??[]).filter(s=>s.fieldId===row.fieldId),reasons:string[]=[];
   for(const source of inputs){
    const prefix=`${source.filename} · ${source.label}：`;
    if(!source.documentId){reasons.push(prefix+'缺少可用于本项核对的对应文件。');continue;}
    if(source.state==='processing'){reasons.push(prefix+'正在提取，完成后重新核对。');continue;}
    if(!source.values.length){reasons.push(prefix+'文件已上传，但尚未提取到字段值。');continue;}
    if(!source.originalEligible||!source.evidence.length){reasons.push(prefix+'取值已有，但来源定位或版本尚未通过校验；需修复定位或重新提取。');continue;}
    const quotes=(await Promise.all(source.evidence.map(e=>original(e)))).flat();
    if(!quotes.length){reasons.push(prefix+'所引位置没有可核验的当前原文；需修复原文定位或重新提取。');continue;}
    if(source.values.some(value=>!quotes.some(q=>originalContains(q.quote,value)))){
     reasons.push(prefix+'提取值未能与所引原文逐项对应；请对照原件核实并更正取值或定位。');continue;
    }
    if(source.values.some(value=>!quotes.some(q=>originalContains(q.quote,value)&&(!q.corroboratingQuotes||q.corroboratingQuotes.some(other=>originalContains(other,value))))))
     reasons.push(prefix+'已有识别文字，但识别结果尚未得到可靠的原文验证；请对照原件核实本栏取值。');
   }
   return reasons.length?reasons:['本项提取值尚未完成原文核验，请对照原件逐项核实。'];
  },
  async source(row:ChecklistRow):Promise<FieldReviewItem|undefined>{
   const inputs=[...new Map((row.sourceValues??row.crossChecks?.flatMap(c=>c.sources)??[])
    .filter(s=>s.fieldId===row.fieldId).map(s=>[s.id,s])).values()];
   if(!inputs.length||inputs.some(s=>!s.values.length))return;
   const groups=await Promise.all(inputs.map(grounded));
   if(groups.some(g=>!g))return;
   const sources=groups.flatMap(g=>g!).flatMap((s,i)=>[{...s,comparisonKey:`source-${i}`},{...s,kind:'extraction' as const,comparisonKey:`source-${i}`}]);
   if(!sources.length||sources.length>40)return;
   return {rowId:row.id,fieldId:row.fieldId,objectId:row.objectId,scope:'source_check',meaning:'consistent',
    reason:'已将所列提取文字逐项核对至当前版本原文；材料完整性、归属及业务适用性另行判断。',actions:[],sources};
  },
  async bank(check:CrossFileCheck):Promise<CrossFileCheck>{
   // Bank names are compared across the specified documents, independent of
   // guarantor identity. Amounts, dates and signatures retain their own scope.
   if(![23,29].includes(check.bankRule?.row??0))return check;
   if(check.sources.some(s=>!s.originalComparisonEligible))return check;
   if(check.fieldIds.some(id=>!check.sources.some(s=>s.fieldId===id)))return check;
   const groups=await Promise.all(check.sources.map(grounded));
   if(groups.some(g=>!g))return check;
   const values=groups.flatMap(g=>g!).map(s=>originalTextKey(s.value).toUpperCase());
   if(!values.length||new Set(values).size!==1)return check;
   return {...check,outcome:'consistent',reason:'所列文件的银行名称已逐项核对原文，文字一致；不据此确认担保人身份或材料完整性。',
    sources:check.sources.map(s=>({...s,state:'available',warnings:[]}))};
  },
 };
}
