import {candidateAdoptionValue,type DocumentFieldObservation,type DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {DocumentRegion} from '@hsbc/contracts/evidence';
import {assessFieldQuality} from '@hsbc/contracts/field-quality';
import {personalBankNameKey,personalLawName,crossFileSourceReading} from '@hsbc/contracts/personal-bank-comparison';
import type {CrossFileCheck,CrossFileValue} from '@hsbc/contracts/review-checklist';
import type {ChecklistInputDocument} from './checklist.js';
import {sha256} from '../../document/evidence.js';
import {documentHtmlCellSpans} from '../../document/html-cells.js';
import {formBox} from '../documents/director-notice-source.js';
import {guaranteeNativeLineAgreement} from '../documents/guarantee-source-evidence.js';

const kinds:Record<string,'bank'|'law'>={pg_field_4:'bank',pg_field_21:'bank',pg_field_26:'bank',pg_facility_parties:'bank',pg_field_9:'law',pg_field_24:'law',pg_field_29:'law'};
const localRecoverable=new Set(['cloud_field_source_assembly_uncertain','cloud_field_source_assembly_elsewhere','cloud_field_source_unverified','cloud_field_coverage_incomplete']);
const inheritedRecoverable=new Set(['table_merged_cells_unsupported','classification_provider_failed']);
function inside(region:DocumentRegion,parent:DocumentRegion){
 const a=formBox(region),b=formBox(parent);if(!a||!b)return false;
 const overlap=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
 return overlap/(a.width*a.height)>.8;
}
/** Assembly doubts require independent OCR/native agreement at the cited
 * location, not a matching bank elsewhere on the page or in another file. */
function corroborated(page:DocumentPageArtifact,region:DocumentRegion,value:string,kind:'bank'|'law'){
 return page.regions.some(line=>{
  if(line.source!=='pp_ocr'||line.kind!=='text'||line.processing_status!=='ready'||line.coverage_gaps.length||page.conflicts.some(c=>c.region_ids.includes(line.region_id))||!line.raw_text||!(inside(line,region)||inside(region,line)))return false;
  const box=formBox(line);if(!box)return false;
  if(line.raw_text.includes(value)&&guaranteeNativeLineAgreement(page,{region:line,box,text:line.raw_text}).length)return true;
  // Whole bank-name lines may differ only in the already supported spelling
  // conversion. Clauses and legal text are never normalized by this fallback.
  if(kind!=='bank'||personalBankNameKey(line.raw_text)!==personalBankNameKey(value))return false;
  return page.regions.some(native=>native.source==='native_pdf'&&native.kind==='text'&&native.processing_status==='ready'&&!native.coverage_gaps.length&&page.canonicalRegionIds.includes(native.region_id)&&
   personalBankNameKey(native.raw_text??'')===personalBankNameKey(value)&&(inside(line,native)||inside(native,line))&&Math.max(formBox(native)?.height??Infinity,box.height)/Math.min(formBox(native)?.height??0,box.height)<2&&
   !page.conflicts.some(c=>c.region_ids.includes(native.region_id)||c.region_ids.includes(line.region_id)));
 });
}
export function canInspectPersonalName(field:DocumentFieldObservation):boolean {
 return !!kinds[field.fieldId]&&canInspectPersonalValue(field);
}
export function canInspectPersonalValue(field:DocumentFieldObservation):boolean {
 if(!field.candidates.length||field.semanticFilter?.state!=='completed'||field.semanticFilter.decisions.some(d=>d.decision==='uncertain')||
  !field.extractionCoverage||['failed','unknown'].includes(field.extractionCoverage.completion)||field.extractionCoverage.state==='unknown'||field.candidates.some(c=>c.sourceReviewCodes?.length))return false;
 const local=new Set([...field.extractionCoverage.reasonCodes,...field.semanticFilter.reasonCodes]);
 return assessFieldQuality(field,{multiple:true,requireSemanticFilter:true}).reasonCodes.every(code=>localRecoverable.has(code)||inheritedRecoverable.has(code)&&!local.has(code));
}

/** Recheck only the names used by the personal workbook. Every retained literal
 * must be in a cited, current, hash-verified text region without local doubts.
 * Model-incomplete coverage, unknown diagnostics and person identity stay blocked.
 * A table-only value cannot borrow the reliability of an unrelated text region. */
export function personalNameSource(source:CrossFileValue,fields:DocumentFieldObservation[],doc:ChecklistInputDocument):CrossFileValue['personalNameReading'] {
 const kind=kinds[source.fieldId],pages=doc.readingPages,anchors=doc.readingAnchors;
 if(!kind||!pages?.length||!anchors?.length||!fields.length||fields.some(f=>!canInspectPersonalName(f))||!source.values.length||!source.evidence.length)return;
 if(new Set(pages.map(p=>p.page.page_number)).size!==pages.length||fields.some(f=>new Set(f.extractionCoverage!.reviewedPageNumbers).size!==pages.length||pages.some(p=>!f.extractionCoverage!.reviewedPageNumbers.includes(p.page.page_number))))return;
 if(pages.some(p=>p.scope.documentVersionId!==source.documentId||p.scope.parseRevision!==doc.parseRevision||p.page.document_version_id!==source.documentId||p.page.parse_revision!==doc.parseRevision||
  p.scope.sourceSha256!==pages[0]!.scope.sourceSha256||p.page.source_sha256!==p.scope.sourceSha256||['failed','unavailable'].includes(p.processing.ocr)||
  p.canonicalRegionIds.some(id=>!p.regions.some(r=>r.region_id===id))||p.regions.some(r=>r.document_version_id!==source.documentId||r.parse_revision!==doc.parseRevision||r.page_asset_id!==p.page.page_asset_id||r.raw_text!==null&&r.raw_text_sha256!==sha256(r.raw_text))))return;
 const facility=source.fieldId==='pg_facility_parties';
 const values=facility?crossFileSourceReading({bankRule:{row:4}} as CrossFileCheck,source).values:source.values;
 const keys=values.map(v=>kind==='bank'?personalBankNameKey(v):personalLawName(v));
 if(!keys.length||keys.some(k=>!k)||new Set(keys).size!==1)return;
 // Every selected candidate is represented; no convenient subset of conflicting names.
 if(!facility&&fields.some(f=>f.candidates.some(c=>!source.values.includes(c.displayValue??candidateAdoptionValue(c)))))return;
 const proof:CrossFileValue['evidence']=[],verifiedValues:string[]=[];
 const assemblyDoubt=fields.some(f=>assessFieldQuality(f,{multiple:true,requireSemanticFilter:true}).reasonCodes.some(code=>localRecoverable.has(code)));
 const cited=source.evidence.flatMap(e=>{const a=anchors.find(a=>a.anchor_id===e.anchorId&&a.document_version_id===source.documentId&&a.parse_revision===doc.parseRevision);const page=a&&pages.find(p=>p.page.page_number===a.page_number);return a&&page&&e.documentVersionId===source.documentId&&e.parseRevision===doc.parseRevision&&e.directoryRevision===doc.directoryRevision?page.regions.filter(r=>a.block_ids.includes(r.region_id)).map(region=>({e,page,region})):[];});
 if(cited.some(({page,region})=>page.conflicts?.some(c=>c.region_ids.includes(region.region_id))))return;
 for(const value of values){
  let found=false;
  for(const e of source.evidence){
   if(e.documentVersionId!==source.documentId||e.parseRevision!==doc.parseRevision||e.directoryRevision!==doc.directoryRevision||!e.anchorId)continue;
   const anchor=anchors.find(a=>a.anchor_id===e.anchorId&&a.document_version_id===source.documentId&&a.parse_revision===doc.parseRevision);
   const page=anchor&&pages.find(p=>p.page.page_number===anchor.page_number);
   if(!anchor||!page)continue;
   const regions=page.regions.filter(r=>anchor.block_ids.includes(r.region_id));
   if(regions.some(r=>page.conflicts?.some(c=>c.region_ids.includes(r.region_id))))return;
   if(regions.some(r=>r.kind==='text'&&page.canonicalRegionIds.includes(r.region_id)&&r.processing_status==='ready'&&!r.coverage_gaps.length&&
    r.raw_text?.includes(value)&&(!assemblyDoubt||corroborated(page,r,value,kind))&&(!facility||/(?:贷款人|貸款人|Lender)\s*[:：]/iu.test(r.raw_text))&&
    !/(?:并非|並非|不适用|不適用|如果|除非)|\b(?:not|unless|if|formerly)\b/iu.test(r.raw_text))){proof.push(e);verifiedValues.push(value);found=true;break;}
  }
  if(!found&&kind==='bank'&&!facility){
   // A merged table may spell the same bank in traditional characters. Accept
   // only a complete, unique cell corroborated by independently positioned OCR
   // and native text inside that table; retain the exact text-line literal.
   for(const {page,region:table} of cited){
    const bounds=formBox(table),raw=table.raw_text;
    if(table.kind!=='table'||table.source!=='vl_ocr'||!bounds||!raw||table.processing_status!=='ready'||table.coverage_gaps.length||!page.canonicalRegionIds.includes(table.region_id))continue;
    if(documentHtmlCellSpans(raw,{allowImages:true}).filter(span=>raw.slice(span.start,span.end).trim()===value).length!==1)continue;
    const lines=cited.filter(x=>x.page===page&&x.region.kind==='text'&&x.region.source==='pp_ocr'&&x.region.processing_status==='ready'&&!x.region.coverage_gaps.length&&page.canonicalRegionIds.includes(x.region.region_id)&&personalBankNameKey(x.region.raw_text??'')===personalBankNameKey(value));
    for(const {region,e} of lines){const box=formBox(region),text=region.raw_text!;
     if(!box||box.x<bounds.x||box.y<bounds.y||box.x+box.width>bounds.x+bounds.width||box.y+box.height>bounds.y+bounds.height||!guaranteeNativeLineAgreement(page,{region,box,text}).length)continue;
     proof.push(e);verifiedValues.push(text.trim());found=true;break;
    }
    if(found)break;
   }
  }
  if(!found)return;
 }
 return {kind,values:[...new Set(verifiedValues)],evidence:[...new Map(proof.map(e=>[JSON.stringify(e),e])).values()],reason:'已核查相关页面，并将本项名称逐一定位到当前版本无冲突的原文；表格字形差异已与同一位置的其他文字提取结果相互印证。此结论仅用于本项名称核对，原提取提示保留供查阅。'};
}

export function personalNameRuleSource(source:CrossFileValue,row:number):CrossFileValue {
 const kind=[4,23,29].includes(row)?'bank':[26,32].includes(row)?'law':undefined;
 const reading=source.personalNameReading;
 if(source.state!=='uncertain'||!reading||reading.kind!==kind)return source;
 return {...source,state:'available',values:reading.values,evidence:reading.evidence,warnings:[],resolvedQuality:{warnings:source.warnings,originalValues:source.values,reason:reading.reason}};
}
