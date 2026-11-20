import type {CrossFileValue} from '@hsbc/contracts/review-checklist';
import type {DocumentFieldObservation} from '@hsbc/contracts/documents';
import type {ChecklistInputDocument} from './checklist.js';
import {canInspectPersonalValue} from './personal-name-source.js';
import {fieldReviewPageQuotes,originalContains} from './field-review-original.js';

/** Amount, date and title checks use the personal workbook, not corporate rules. Recover
 * extraction assembly doubts only when every retained value has its own proof. */
export function personalScalarSource(source:CrossFileValue,fields:DocumentFieldObservation[],doc:ChecklistInputDocument):CrossFileValue['personalScalarReading']{
 if(!['pg_field_7','pg_field_10','pg_field_17','pg_field_18','pg_field_27','pg_field_32'].includes(source.fieldId)||!source.originalEligible||!fields.length||fields.some(f=>!canInspectPersonalValue(f))||!source.values.length)return;
 if(!doc.projectionCurrent||!doc.sourceHash||!['ready','partial'].includes(doc.state)||doc.invalidFieldIds?.some(id=>id==='*'||id===source.fieldId)||source.documentId!==doc.id||source.evidence.some(e=>e.documentVersionId!==doc.id||e.parseRevision!==doc.parseRevision||e.directoryRevision!==doc.directoryRevision))return;
 const pages=doc.readingPages??[],anchors=doc.readingAnchors??[];
 if(!pages.length||new Set(pages.map(p=>p.page.page_number)).size!==pages.length||fields.some(f=>new Set(f.extractionCoverage!.reviewedPageNumbers).size!==pages.length||pages.some(p=>!f.extractionCoverage!.reviewedPageNumbers.includes(p.page.page_number))))return;
 const evidence:CrossFileValue['evidence']=[],provenValues:string[]=[];
 for(const value of source.values){
  const match=source.evidence.find(e=>{
   const anchor=anchors.find(a=>a.anchor_id===e.anchorId&&a.document_version_id===doc.id&&a.parse_revision===doc.parseRevision);
   const page=anchor&&pages.find(p=>p.page.page_number===anchor.page_number);
   if(!anchor||!page||page.scope.documentVersionId!==doc.id||page.scope.parseRevision!==doc.parseRevision||page.page.document_version_id!==doc.id||page.page.parse_revision!==doc.parseRevision||page.page.source_sha256!==page.scope.sourceSha256)return false;
   return fieldReviewPageQuotes(e,anchor,page,{independentText:true}).some(q=>q.quote.length<=16000&&originalContains(q.quote,value)&&(!q.corroboratingQuotes||q.corroboratingQuotes.some(t=>originalContains(t,value))));
  });
  if(!match){if(source.fieldId==='pg_field_32')continue;return;}
  evidence.push(match);provenValues.push(value);
 }
 if(!evidence.length)return;
 const values=source.fieldId==='pg_field_32'?provenValues.filter(value=>value.trim()&&!/^[_＿\s-]+$/u.test(value)):source.values;
 if(!values.length)return;
 return {values,evidence:[...new Map(evidence.map(e=>[JSON.stringify(e),e])).values()],reason:'本项全部取值已定位到当前版本同一位置的可靠原文；仅供本条金额、日期或填写情况核对，保留原提取提示。'};
}
export function personalScalarRuleSource(source:CrossFileValue,row:number):CrossFileValue {
 const reading=source.personalScalarReading;
 if(![7,10,19,20,30,35].includes(row)||source.state!=='uncertain'||!reading)return source;
 return {...source,state:'available',values:reading.values,evidence:reading.evidence,warnings:[],resolvedQuality:{warnings:source.warnings,originalValues:source.values,reason:reading.reason}};
}
