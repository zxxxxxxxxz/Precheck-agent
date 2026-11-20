import {SUPPLEMENTAL_MATERIAL_ID} from '@hsbc/contracts/case-supplement';
import type { DocumentBundle, DocumentEngineConfig, DocumentPageArtifact } from '@hsbc/contracts/documents';
import type { ReviewFieldDefinition } from '@hsbc/contracts/review-config';
import {CORPORATE_ARTICLES_REVIEW_INPUTS} from '@hsbc/contracts/corporate-requirements';
import {PERSONAL_IDENTITY_HIDDEN_FIELDS} from '@hsbc/contracts/personal-requirements';
import {documentTitleCandidates} from './engine/directory.js';

/** A literal configured title at the top of the first source page identifies
 * the file, unlike a registration reference or another document named in its
 * body. Never override manual classification or infer a type from filenames. */
export function fileTitleMaterialType(bundle:DocumentBundle,page:DocumentPageArtifact|undefined,taxonomy:DocumentEngineConfig['taxonomy']|undefined):string|null {
  if(bundle.classificationMode||!page||!taxonomy||bundle.scope?.sourceFormat==='docx'||page.page.page_number!==1||
    page.scope.documentVersionId!==bundle.scope?.documentVersionId||page.scope.parseRevision!==bundle.scope?.parseRevision||page.scope.sourceSha256!==bundle.scope?.sourceSha256||
    bundle.logicalDocuments.some(entry=>entry.source==='manual'))return null;
  const canonical=new Set(page.canonicalRegionIds);
  const types=new Set(page.regions.filter(region=>canonical.has(region.region_id)&&region.kind==='text'&&region.processing_status==='ready'&&region.raw_text&&
    region.polygons.length>0&&region.polygons.every(polygon=>polygon.length>0&&polygon.every(([,y])=>y>=0&&y<=page.page.height*0.3)))
    .flatMap(region=>documentTitleCandidates(region.raw_text!,{taxonomy} as DocumentEngineConfig)));
  return types.size===1?[...types][0]!:null;
}
export function documentClassificationScope(bundle:DocumentBundle){
  const logical=bundle.logicalDocuments.filter(d=>!d.id.startsWith('source-document:')),pages=new Set(logical.flatMap(d=>d.pageNumbers));
  if(bundle.scope?.sourceFormat==='docx'){
    const nodes=[...new Set(bundle.chunks.flatMap(c=>c.sourceNodeIds??[]))];
    const typed=logical.length>0&&logical.every(d=>!!d.labelId&&!['unknown','conflict'].includes(d.status));
    const taxonomyIds=[...new Set(logical.flatMap(d=>d.labelId?[d.labelId]:[]))];
    // `known` stays strict: it lets fields of other types be ruled out, which needs every source node read and owned.
    // `wholeFileType` only answers which type this file is. A Word file has one material type, so when every classified
    // part names the same type, layout or generated nodes outside the classified units and format caveats of the file
    // do not make that type unknown; those caveats stay on the fields read from the file.
    return {known:nodes.length>0&&typed&&logical.every(d=>d.sourceCoverageComplete===true)&&nodes.every(id=>logical.some(d=>d.sourceNodeIds?.includes(id))),taxonomyIds,
      wholeFileType:nodes.length>0&&typed&&taxonomyIds.length===1?taxonomyIds[0]!:null};
  }
  const complete=Boolean(bundle.pageCount&&pages.size===bundle.pageCount&&Array.from({length:bundle.pageCount},(_,i)=>i+1).every(page=>pages.has(page)));
  return {known:complete&&logical.length>0&&logical.every(d=>Boolean(d.labelId)&&!['unknown','conflict'].includes(d.status)),taxonomyIds:[...new Set(logical.flatMap(d=>d.labelId?[d.labelId]:[]))],wholeFileType:null as string|null};
}
/** A file has one material type. Page-level classification disagreements must be
 * resolved explicitly, never by taking the union or choosing the largest group. */
export function fieldApplicability(bundle:DocumentBundle,definitions:ReviewFieldDefinition[]|undefined,directoryRevision:number,observations=bundle.fields,titleEvidence?:{page:DocumentPageArtifact;taxonomy:DocumentEngineConfig['taxonomy']}){
  const classification=documentClassificationScope(bundle);
  const titleType=bundle.classificationMode?null:fileTitleMaterialType(bundle,titleEvidence?.page,titleEvidence?.taxonomy);
  const logical=bundle.logicalDocuments.filter(entry=>!entry.id.startsWith('source-document:'));
  const manuallyTyped=logical.length>0&&logical.every(entry=>entry.source==='manual'&&entry.status==='confirmed'&&entry.labelId);
  const status=titleType?'resolved' as const:classification.taxonomyIds.length>1?'ambiguous' as const:(classification.known||manuallyTyped)&&classification.taxonomyIds.length===1?'resolved' as const:'unknown' as const;
  const materialScope={status,taxonomyId:titleType??(status==='resolved'?classification.taxonomyIds[0]!:null),...(titleType?{basis:'document_title' as const}:{})};
  const byFieldId:Record<string,'applicable'|'not_applicable'|'unknown'>={};
  for(const id of new Set([...bundle.fields,...observations].map(field=>field.fieldId))){
    // This is a review input retained for existing rules/facts, not a printed
    // certificate field. Apply at read time to old pinned configurations too.
    if((PERSONAL_IDENTITY_HIDDEN_FIELDS as readonly string[]).includes(id)||id==='cgt_jurisdiction'||(CORPORATE_ARTICLES_REVIEW_INPUTS as readonly string[]).includes(id)){byFieldId[id]='not_applicable';continue;}
    if(materialScope.taxonomyId===SUPPLEMENTAL_MATERIAL_ID){byFieldId[id]='not_applicable';continue;}
    const definition=definitions?.find(d=>d.id===id);
    byFieldId[id]=status!=='resolved'||!definition?'unknown':!definition.taxonomyIds?.length||definition.taxonomyIds.includes(materialScope.taxonomyId!)?'applicable':'not_applicable';
  }
  return {directoryRevision,materialScope,byFieldId};
}
