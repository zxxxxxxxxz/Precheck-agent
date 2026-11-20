import {personalDateRegions} from './personal-date-source.js';
import type {DocumentFieldObservation} from '@hsbc/contracts/documents';
import type {CrossFileValue} from '@hsbc/contracts/review-checklist';
import {personalLawName} from '@hsbc/contracts/personal-bank-comparison';
import type {ChecklistInputDocument} from './checklist.js';
import {sha256} from '../../document/evidence.js';
import {fieldReviewPageQuotes,originalContains} from './field-review-original.js';

const localRecoverable=new Set(['cloud_field_source_assembly_uncertain','cloud_field_source_assembly_elsewhere','cloud_field_source_unverified','cloud_field_coverage_incomplete','overlapping_source_quote']);
const lawFields=new Set(['pg_field_9','pg_field_24','pg_field_29']);
export function canInspectPersonalWorkbook(field:DocumentFieldObservation){
 return (lawFields.has(field.fieldId)||['pg_field_6','pg_facility_parties','pg_field_27'].includes(field.fieldId))&&
  field.extractionCoverage?.completion==='completed'&&
  [...field.extractionCoverage.reasonCodes,...(field.semanticFilter?.reasonCodes??[])].every(c=>localRecoverable.has(c))&&
  !field.semanticFilter?.decisions.some(d=>d.decision==='uncertain')&&!field.candidates.some(c=>c.sourceReviewCodes?.length);
}
/** The bank compares the governing law, not the spelling of unrelated banking
 * practice text. Accept only this complete affirmative clause plus the standard
 * same-jurisdiction supplementary sentence; exceptions remain unresolved. */
export function workbookLawValue(text:string):string|undefined {
 const normalized=text.trim().replace(/^\d+[.、．]\s*/u,'');
 if(personalLawName(normalized))return normalized.replace(/[。.]$/u,'');
 const [first,...tail]=normalized.split('。');
 if(!first||!personalLawName(first))return;
 const rest=tail.join('。').replace(/。$/u,'').trim();
 if(!rest)return first;
 if(/^如有未[盡尽]事宜，[悉均]依中[華华]民[國国](?:相關|相关|有關|有关)法令、[規规]章及[銀银]行[業业][慣惯價价]例(?:[辦办]理之)?$/u.test(rest)&&personalLawName(first)==='中華民國法律')return first;
}
function borrowerValues(text:string,facility:boolean):string[]{
 const values:string[]=[];
 if(facility){
  const match=/(?:^|\n)\s*(?:借款人|Borrower)\s*[:：]\s*([^\n，,。;；]+(?:[（(][^）)]+[）)][^\n，,。;；]*)?)/iu.exec(text);
  if(match?.[1])values.push(match[1].trim());
 }else{
  const labelled=/(?:^|\n)\s*主[債债][務务]人\s*[:：]\s*(.+?)(?=\s+每位|[，,。;；\n]|$)/u.exec(text);
  if(labelled?.[1])values.push(labelled[1].trim());
  for(const match of text.matchAll(/(?:貴行向|贵行向)(.+?)[（(]以下[稱称][「“"]主[債债][務务]人[」”"][）)]/gu))values.push(match[1]!.trim());
 }
 return values.filter(v=>v.length<=240&&!/^[_＿\s.．\-—]+$/u.test(v)&&!/[：:;；]|如果|除非|並非|并非|\b(?:unless|not|if)\b/iu.test(v)&&
  (v.match(/[（(]/gu)?.length??0)===(v.match(/[）)]/gu)?.length??0));
}
/** A read projection of complete, current source regions. The field extraction
 * receipt is retained. No person assignment, document mutation or model guess.
 * OCR alternatives stay in the values sent to semantic comparison. */
export function personalWorkbookSource(source:CrossFileValue,fields:DocumentFieldObservation[],doc:ChecklistInputDocument):CrossFileValue['personalWorkbookReading'] {
 const kind=source.fieldId==='pg_field_27'?'date':lawFields.has(source.fieldId)?'law':['pg_field_6','pg_facility_parties'].includes(source.fieldId)?'borrower':undefined;
 const pages=doc.readingPages??[],anchors=doc.readingAnchors??[];
 if(!kind||source.documentId!==doc.id||fields.some(f=>f.documentVersionId!==doc.id||f.parseRevision!==doc.parseRevision)||!doc.projectionCurrent||!doc.sourceHash||!doc.readingSourceSha256||!doc.directoryRevision||!['ready','partial'].includes(doc.state)||
  doc.invalidFieldIds?.some(id=>id==='*'||id===source.fieldId)||!pages.length||!anchors.length||!fields.length||fields.some(f=>!canInspectPersonalWorkbook(f)))return;
 if(new Set(pages.map(p=>p.page.page_number)).size!==pages.length||fields.some(f=>new Set(f.extractionCoverage!.reviewedPageNumbers).size!==pages.length||pages.some(p=>!f.extractionCoverage!.reviewedPageNumbers.includes(p.page.page_number))))return;
 if(pages.some(p=>p.scope.documentVersionId!==doc.id||p.scope.parseRevision!==doc.parseRevision||p.scope.sourceSha256!==doc.readingSourceSha256||
  p.page.document_version_id!==doc.id||p.page.parse_revision!==doc.parseRevision||p.page.source_sha256!==doc.readingSourceSha256||p.processing.ocrSimulated||['failed','unavailable'].includes(p.processing.ocr)||
  p.regions.some(r=>r.document_version_id!==doc.id||r.parse_revision!==doc.parseRevision||r.page_asset_id!==p.page.page_asset_id||r.raw_text!==null&&r.raw_text_sha256!==sha256(r.raw_text))))return;
 const passages:NonNullable<CrossFileValue['personalWorkbookReading']>['passages']=[],values:string[]=[];
 if(kind==='date'){
  for(const page of pages)for(const {region,value} of personalDateRegions(page)){
   const anchor=anchors.find(a=>a.document_version_id===doc.id&&a.parse_revision===doc.parseRevision&&a.page_number===page.page.page_number&&a.block_ids.includes(region.region_id));
   if(!anchor)continue;
   values.push(value);passages.push({text:region.raw_text!,evidence:{documentVersionId:doc.id,parseRevision:doc.parseRevision!,directoryRevision:doc.directoryRevision,anchorId:anchor.anchor_id}});
  }
  if(values.length)return {kind,values:[...new Set(values)],passages,evidence:passages.map(p=>p.evidence),reason:'同一日期栏在两个独立文字通道中均读得相同日期；仅用于日期先后核对，不采用其他文字差异。'};
 }

 for(const page of pages)for(const region of page.regions){
  if(!page.canonicalRegionIds.includes(region.region_id)||region.kind!=='text'||!region.raw_text||region.processing_status!=='ready'||region.coverage_gaps.length||
   page.conflicts.some(c=>c.region_ids.includes(region.region_id))||region.source==='native_pdf'&&page.nativeTrust!=='validated_geometry_and_visibility')continue;
  const date=/(?:^|\n)\s*(?:Date|日期)\s*[:：]\s*((?:中華民國|中华民国|民國|民国)?\s*\d{2,4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/iu.exec(region.raw_text)?.[1];
  const picked=kind==='date'?(date?[date]:[]):kind==='law'?[workbookLawValue(region.raw_text)].filter((v):v is string=>!!v):borrowerValues(region.raw_text,source.fieldId==='pg_facility_parties');
  if(kind==='law'&&!picked.length&&/(?:本保[證证][書书]|本授[權权][書书]|本票).*(?:法律|準據法|准据法).*(?:解[釋释]|為|为)/u.test(region.raw_text))return;
  if(!picked.length)continue;
  const anchor=anchors.find(a=>a.document_version_id===doc.id&&a.parse_revision===doc.parseRevision&&a.page_number===page.page.page_number&&a.block_ids.includes(region.region_id));
  if(!anchor)continue;
  const evidence={documentVersionId:doc.id,parseRevision:doc.parseRevision!,directoryRevision:doc.directoryRevision,anchorId:anchor.anchor_id};
  // Law-only normalization has to be independently grounded at this location.
  // The rest of the full region is still sent to the model and shown as evidence.
  if(kind==='law'||kind==='date'){
   const proof=fieldReviewPageQuotes(evidence,anchor,page,{independentText:true}).find(q=>q.quote===region.raw_text);
   if(!proof||proof.corroboratingQuotes&&!picked.every(v=>proof.corroboratingQuotes!.some(q=>originalContains(q,v))))continue;
  }
  values.push(...picked);passages.push({text:region.raw_text,evidence});
 }
 if(!values.length)return;
 if(kind==='law'){
  const keys=values.map(personalLawName);
  // Every retained extraction candidate must describe this law; no dropping an
  // unknown exception, second jurisdiction or negative clause to obtain a pass.
  const selected=source.values.map(v=>personalLawName(workbookLawValue(v)??v));
  if(selected.some(k=>!k)||new Set([...keys,...selected]).size!==1)return;
 }
 return {kind,values:[...new Set(values)],evidence:[...new Map(passages.map(p=>[JSON.stringify(p.evidence),p.evidence])).values()],passages,
  reason:'按本条银行要求重新定位当前版本的完整原文段落；仅比较借款人名称或适用法律，原提取告警和其他业务要求保留。'};
}
export function personalWorkbookRuleSource(source:CrossFileValue,row:number):CrossFileValue {
 const reading=source.personalWorkbookReading,kind=row===30?'date':row===6?'borrower':[26,32].includes(row)?'law':undefined;
 if(!reading||kind!==reading.kind||!['uncertain','missing','available'].includes(source.state))return source;
 return {...source,state:'available',values:reading.values,evidence:reading.evidence,warnings:[],resolvedQuality:{warnings:source.warnings,originalValues:source.values,reason:reading.reason}};
}
