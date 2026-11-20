import type {DocumentFieldObservation,DocumentPageArtifact} from '@hsbc/contracts/documents';
import {candidateAdoptionValue} from '@hsbc/contracts/documents';
import type {EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import type {CrossFileValue} from '@hsbc/contracts/review-checklist';
import {assessFieldQuality} from '@hsbc/contracts/field-quality';
import {decimalKey,focusedValues,focusKind,type FieldFocus,type FocusKind} from '@hsbc/contracts/field-focused-reading';
import {documentCloudRegions,valueAnchors} from '../documents/cloud-extraction-contract.js';
import {fieldSourceAssemblyUncertain} from '../documents/field-source-coverage.js';
import {sha256} from '../../document/evidence.js';
import {normalizeReviewValue} from './normalization.js';

const recoverable=new Set(['cloud_field_source_assembly_uncertain','cloud_field_source_assembly_elsewhere','cloud_field_source_unverified','cloud_field_coverage_incomplete']);
/** Necessary conditions only; page identity, coverage and value proof are still
 * checked below. Callers can avoid loading whole pages when no proof is possible. */
export function canInspectScopedSource(field:DocumentFieldObservation):boolean {
 const quality=assessFieldQuality(field,{multiple:true,requireSemanticFilter:true});
 return quality.state!=='processing'&&quality.reasonCodes.every(code=>recoverable.has(code))&&
  field.semanticFilter?.state==='completed'&&!!field.extractionCoverage&&
  !['failed','unknown'].includes(field.extractionCoverage.completion)&&
  !field.semanticFilter.decisions.some(decision=>decision.decision==='uncertain');
}
const amountLabels=['担保金额','擔保金額','保证金额','保證金額','指定金额','指定金額','指定本金','保证本金','保證本金','guarantee amount','guaranteed amount','specified sum','principal cap','maximum liability','amount'];
const unique=<T>(items:T[])=>[...new Set(items)];
const key=(value:string,kind:FocusKind)=>{
 if(kind==='amount')return decimalKey(value);
 const normalized=normalizeReviewValue(value,kind==='text'?'text':kind);
 return normalized.status==='pending'||normalized.value===null?undefined:JSON.stringify([normalized.value,normalized.currency]);
};
/** A separate read projection, not a replacement extraction receipt. Reconstruct
 * the selected literal plus its label from current source spans, inspect every
 * reviewed page for competing labelled values, and check doubts against that
 * exact scope. Whole-clause coverage and manual business decisions stay intact.
 * No inference from merely equal displayed numbers or from unknown diagnostics. */
export function scopedSourceReadings(definition:ReviewFieldDefinition,fields:DocumentFieldObservation[],source:CrossFileValue,
 pages:DocumentPageArtifact[],anchors:EvidenceAnchor[]):NonNullable<CrossFileValue['scopedReadings']> {
 if(!pages.length||!fields.length||!source.values.length||!source.evidence.length||fields.some(field=>!canInspectScopedSource(field)))return [];
 if(pages.some(page=>page.scope.documentVersionId!==source.documentId||source.evidence.some(e=>e.parseRevision!==page.scope.parseRevision)||
   page.page.document_version_id!==source.documentId||page.page.parse_revision!==page.scope.parseRevision||
   page.scope.sourceSha256!==pages[0]!.scope.sourceSha256||page.page.source_sha256!==page.scope.sourceSha256||
   ['failed','unavailable'].includes(page.processing.ocr)||
   page.canonicalRegionIds.some(id=>!page.regions.some(r=>r.region_id===id))||
   page.regions.some(r=>r.document_version_id!==source.documentId||r.parse_revision!==page.scope.parseRevision||r.page_asset_id!==page.page.page_asset_id||r.raw_text!==null&&r.raw_text_sha256!==sha256(r.raw_text))))return [];
 const ownKind=focusKind({...definition,fieldId:definition.id}),compound=definition.valueMultiplicity==='clauses';
 const kinds:FocusKind[]=compound?['amount','currency']: [ownKind];
 const results:NonNullable<CrossFileValue['scopedReadings']>=[];
 for(const kind of kinds){
  const focus:FieldFocus={fieldId:kind,label:kind,type:kind};
  const labels=compound?amountLabels:definition.aliases;
  if(!labels.length)continue;
  // Every relevant page must have a completed review before a narrower
  // reading can be proved; the cheap field-level prerequisites were checked first.
  if(fields.some(f=>pages.some(page=>!f.extractionCoverage!.reviewedPageNumbers.includes(page.page.page_number))))continue;
  const picked=fields.flatMap(field=>field.candidates).flatMap(candidate=>{
   const raw=candidate.displayValue??candidateAdoptionValue(candidate),values=focusedValues(raw,compound?focus:{...definition,fieldId:definition.id,type:kind},{compound});
   return values.length?[{candidate,raw,values}]:[];
  });
  const values=unique(picked.flatMap(item=>item.values)),keys=values.map(value=>key(value,kind));
  if(!values.length||keys.some(k=>!k)||new Set(keys).size!==1)continue;
  // Unknown provenance on any selected candidate is not recoverable here.
  if(picked.some(({candidate})=>candidate.sourceReviewCodes?.length))continue;
  const narrowed:DocumentFieldObservation['candidates']=[],proof:EvidenceAnchor[]=[];
  let failed=false,matched=false;
  const literalFocus=compound?focus:{...definition,fieldId:definition.id,type:kind};
  for(const page of pages){
   // Canonical PDF text may split a printed label and its value into separate
   // regions. Use the same ordered page text as extraction, retaining exact
   // source offsets for anchors instead of treating a label-only fragment as
   // an absent value or dropping it from the coverage scan.
   const raw=documentCloudRegions(page).map(region=>region.raw_text!).join('\n');
   const markers=labels.flatMap(label=>{
    const escaped=label.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
    return [...raw.matchAll(new RegExp(escaped,'giu'))].filter(match=>{
     const at=match.index!;
     if(/[a-z0-9]/iu.test(label[0]!)&&/[a-z0-9]/iu.test(raw[at-1]??''))return false;
     if(/[a-z0-9]/iu.test(label.at(-1)!)&&/[a-z0-9]/iu.test(raw[at+match[0].length]??''))return false;
     return !compound||label!=='amount'||/^\s*[:：]/u.test(raw.slice(at+match[0].length));
    }).map(match=>({at:match.index!,end:match.index!+match[0].length}));
   }).sort((a,b)=>a.at-b.at||b.end-a.end).filter((m,i,all)=>!all.slice(0,i).some(other=>other.at<=m.at&&other.end>=m.end));
   for(const [index,marker] of markers.entries()){
    const next=markers[index+1];
    const prefix=raw.slice(Math.max(0,marker.at-120),marker.at).split(/[;；。]/u).at(-1)!;
    if(/不(?:是|属于|屬於|作为|作為|适用|適用)|非\s*$|并非|並非|未确定|未確定|如果|除非|仅当|僅當|\b(?:not|unless|if|conditional|proposed|former)\b/iu.test(prefix)){failed=true;break;}
    // Consecutive aliases (e.g. 保证本金指定金额) describe one value.
    if(next&&/^\s*$/u.test(raw.slice(marker.end,next.at)))continue;
    const segment=raw.slice(marker.at,Math.min(next?.at??raw.length,marker.at+240)).split(/[;；。]/u)[0]!;
    const found=focusedValues(segment,literalFocus,{compound});
    if(!found.length||found.some(value=>key(value,kind)!==keys[0])){failed=true;break;}
    for(const value of found){
     const at=segment.indexOf(value);
     if(at<0||at>120){failed=true;break;}
     const context=segment.slice(0,at+value.length);
     // Keep the currency and role label in the checked span, not just digits.
     const located=valueAnchors(page,context,raw);
     if(!located.length){failed=true;break;}
     proof.push(...located);narrowed.push({rawValue:context,normalizedValue:context,anchorIds:located.map(a=>a.anchor_id),pageNumbers:[page.page.page_number]});matched=true;
    }
    if(failed)break;
   }
   if(failed)break;
  }
  if(failed||!matched)continue;
  const scopedDefinition={...definition,aliases:labels,roleEvidence:compound?undefined:definition.roleEvidence};
  if(fieldSourceAssemblyUncertain(scopedDefinition,narrowed,pages,[...anchors,...proof]))continue;
  // Every displayed value must be represented by this proof. Do not narrow a
  // conflicting list to the convenient member or change document attribution.
  const selectedValues=unique(picked.map(item=>item.raw));
  if(!selectedValues.every(value=>source.values.includes(value)))continue;
  const selectedIds=new Set(picked.flatMap(({candidate})=>candidate.anchorIds));
  const proofBlocks=new Set(proof.flatMap(anchor=>anchor.block_ids));
  const evidence=source.evidence.filter(e=>!!e.anchorId&&selectedIds.has(e.anchorId)&&anchors.some(a=>a.anchor_id===e.anchorId&&a.block_ids.some(id=>proofBlocks.has(id))));
  if(!evidence.length)continue;
  results.push({kind,values:selectedValues,evidence,reason:'已按当前取值及其标签重新核验原文；其他内容的质量标记仍保留在对应字段。'});
 }
 return results;
}
