import type {DocumentBundle,DocumentFieldObservation,DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {DocumentRegion,EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {sha256} from '../../document/evidence.js';
import {partyNameSectionEvidence} from './labelled-company-names.js';
import {anchorTouchesDisagreement,sourceUncertaintySpans} from './source-uncertainty-spans.js';

type Box=[number,number,number,number];
function bounds(polygons:DocumentRegion['polygons']):Box|undefined {
  const points=polygons.flat();if(!points.length)return;
  const box:Box=[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
  return box.every(Number.isFinite)&&box[2]>box[0]&&box[3]>box[1]?box:undefined;
}
function intersects(a:Box,b:Box){
  return Math.min(a[2],b[2])>Math.max(a[0],b[0])&&Math.min(a[3],b[3])>Math.max(a[1],b[1]);
}
function readable(region:DocumentRegion){
  return region.processing_status==='ready'&&Boolean(region.raw_text?.trim())&&region.raw_text_sha256===sha256(region.raw_text!);
}
/** Parentage of a PP word is fixed by the adapter's own identifiers, as in source text assembly: the same producer,
 * page and line. A word of another line or producer is never taken for a part of this one. */
function wordCarriedByLine(word:DocumentRegion,byId:Map<string,DocumentRegion>){
  if(word.source!=='pp_ocr'||!/^line:\d+:word:\d+$/u.test(word.source_id)||!word.region_id.includes(':pp:')||!word.region_id.endsWith(`:${word.source_id}`))return false;
  if(word.processing_status!=='ready'||typeof word.raw_text!=='string'||!word.raw_text||word.raw_text_sha256!==sha256(word.raw_text))return false;
  const line=byId.get(word.region_id.replace(/:word:\d+$/u,''));
  return Boolean(line&&line.source==='pp_ocr'&&line.kind==='text'&&line.source_id===word.source_id.replace(/:word:\d+$/u,'')&&
    line.document_version_id===word.document_version_id&&line.parse_revision===word.parse_revision&&line.page_asset_id===word.page_asset_id&&
    readable(line)&&bounds(line.polygons)&&line.raw_text!.includes(word.raw_text));
}
function mentionsLabel(text:string,labels:string[],excluded:string[]=[]){
  const normalized=text.normalize('NFKC').replace(/\s+/gu,' ').toLowerCase();
  return labels.some(label=>{
    const term=label.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
    if(!term)return false;
    for(let at=normalized.indexOf(term);at>=0;at=normalized.indexOf(term,at+1)){
      if(excluded.some(value=>{
        const other=value.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
        for(let start=normalized.indexOf(other);other&&start>=0;start=normalized.indexOf(other,start+1))
          if(start<=at&&start+other.length>=at+term.length)return true;
        return false;
      }))continue;
      // English aliases are words, not substrings of an unrelated label.
      if((!/[a-z0-9]/u.test(term[0]!)||!/[a-z0-9]/u.test(normalized[at-1]??''))&&
        (!/[a-z0-9]/u.test(term.at(-1)!)||!/[a-z0-9]/u.test(normalized[at+term.length]??'')))return true;
    }
    return false;
  });
}

function hasRoleLabel(text:string,label:string,definition:ReviewFieldDefinition){
  const policy=definition.roleEvidence;if(!policy)return true;
  const escaped=label.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&').replace(/\s+/gu,'\\s+');
  const source=text.replace(/<br\s*\/?\s*>/giu,'\n').replace(/<\/?(?:td|th|tr)\b[^>]*>/giu,'\n');
  // A Bank word inside a street/building name is not a lender label. Keep
  // actual standalone labels, declarations and explicitly stated roles.
  if(new RegExp(`(?:^|[\\n\\t.;。；!?])\\s*["“]?${escaped}["”]?\\s*(?:[:：]|\\n|$|(?:means|shall mean|is)\\s+|[为為是指])`,'iu').test(source))return true;
  return policy.declarationTerms.some(term=>term.toLowerCase()===label.toLowerCase())&&
    new RegExp(`\\(\\s*(?:the\\s+)?["“]?${escaped}["”]?\\s*\\)|(?:\\bas\\s+|作为|作為)(?:the\\s+)?${escaped}(?:$|[\\s,，.;；])`,'iu').test(source);
}

function equivalentLabelledValue(candidates:DocumentFieldObservation['candidates'],region:DocumentRegion,page:DocumentPageArtifact,anchors:EvidenceAnchor[]){
  if(region.kind!=='text'||!['pp_ocr','vl_ocr'].includes(region.source))return false;
  const compact=(text:string)=>text.replace(/\s/gu,''),box=bounds(region.polygons);if(!box)return false;
  const label=(text:string,value:string)=>{
    const source=compact(text),needle=compact(value);
    if(!needle||!source.endsWith(needle)||source.indexOf(needle)!==source.length-needle.length)return;
    // Compare an already selected value's entire row, not a new label/value
    // assignment. Preserve the footnote marker count: * and $^{*}$ agree,
    // absence of a marker does not. Currency signs and conditions stay literal.
    const prefix=source.slice(0,-needle.length),decoration=/^(?:\*|\$\^\{\*\}\$)+/u.exec(prefix)?.[0]??'';
    const printed=prefix.slice(decoration.length).replace(/[:：]$/u,'');
    return /^[\p{L}\p{N}()（）/_-]+$/u.test(printed)?`${(decoration.match(/\*/gu)??[]).length}:${printed.toLowerCase()}`:undefined;
  };
  return candidates.some(candidate=>{
    const ownLabel=label(region.raw_text!,candidate.rawValue);if(!ownLabel)return false;
    return page.regions.some(other=>{
      if(other.source===region.source||!['pp_ocr','vl_ocr'].includes(other.source)||other.kind!=='text'||!readable(other)||
        other.page_asset_id!==region.page_asset_id||other.parse_revision!==region.parse_revision||other.document_version_id!==region.document_version_id||
        label(other.raw_text!,candidate.rawValue)!==ownLabel)return false;
      const b=bounds(other.polygons);if(!b)return false;
      const overlap=Math.max(0,Math.min(box[2],b[2])-Math.max(box[0],b[0]))*Math.max(0,Math.min(box[3],b[3])-Math.max(box[1],b[1]));
      if(Math.max(box[3]-box[1],b[3]-b[1])/Math.min(box[3]-box[1],b[3]-b[1])>2||
        overlap/Math.min((box[2]-box[0])*(box[3]-box[1]),(b[2]-b[0])*(b[3]-b[1]))<.8)return false;
      return anchors.some(anchor=>candidate.anchorIds.includes(anchor.anchor_id)&&anchor.block_ids.some(id=>id===region.region_id||id===other.region_id));
    });
  });
}

/** Where an assembly doubt of the page stands relative to a field: on what the field's own value, role or condition
 * evidence reads (`value`), or elsewhere on the page where it can only mean that something more for this field may
 * have gone unread (`elsewhere`). `cause` names the test that decided it. */
export interface FieldSourceAssemblyDoubt {kind:'value'|'elsewhere';cause:'no_candidates'|'evidence_missing'|'region_unplaced'|'region_unreadable'|'no_scope'|'fragment_omitted'|'evidence_touched'|'label_nearby'}

/** Attribute immutable assembly doubts to the field's value/role/condition
 * evidence and relevant labels, rather than to every field on the page.
 * The caller still requires exhaustive model review of every applicable page.
 * Missing values or unlocatable doubts cannot prove absence and remain a doubt
 * about the value. A doubtful region that the field's evidence does not touch
 * is reported apart: the value that was read does not depend on it.
 * Page-level warnings and raw sources are never cleared. */
export function fieldSourceAssemblyDoubt(definition:ReviewFieldDefinition,candidates:DocumentFieldObservation['candidates'],pages:DocumentPageArtifact[],anchors:EvidenceAnchor[]):FieldSourceAssemblyDoubt|null {
  const uncertainPages=pages.filter(page=>page.sourceTextAssembly?.uncertainRegionIds.length);
  if(!uncertainPages.length)return null;
  if(!candidates.length)return {kind:'value',cause:'no_candidates'};
  const ids=new Set(candidates.flatMap(candidate=>[
    ...candidate.anchorIds,...candidate.contextAnchorIds??[],
    ...candidate.evidenceSegments?.flatMap(segment=>[...segment.anchorIds,...segment.contextAnchorIds])??[],
    ...candidate.structuredValue?.components.flatMap(component=>component.anchorIds)??[],
  ]));
  // No evidence means no safe basis for spatial exclusion.
  if(!ids.size||[...ids].some(id=>!anchors.some(anchor=>anchor.anchor_id===id)))return {kind:'value',cause:'evidence_missing'};
  const labels=[...definition.aliases,...definition.roleEvidence?.headings??[],...definition.roleEvidence?.declarationTerms??[]];
  let elsewhere:FieldSourceAssemblyDoubt|null=null;
  for(const page of uncertainPages){
    const differences=sourceUncertaintySpans(page);
    const byId=new Map(page.regions.map(region=>[region.region_id,region]));
    const evidence=anchors.filter(anchor=>ids.has(anchor.anchor_id)&&anchor.page_asset_id===page.page.page_asset_id&&
      anchor.document_version_id===page.page.document_version_id&&anchor.parse_revision===page.page.parse_revision);
    const body=page.regions.filter(region=>page.canonicalRegionIds.includes(region.region_id)&&readable(region));
    for(const id of page.sourceTextAssembly!.uncertainRegionIds){
      const region=byId.get(id),box=region&&bounds(region.polygons);
      // An OCR word delivered without a usable outline is doubted only because it cannot be laid over its line. Where
      // that line is on the page with its own outline and already reads the word, the line carries everything the word
      // says, and the word adds no doubt of its own.
      if(region&&!box&&wordCarriedByLine(region,byId))continue;
      // A doubt that cannot be placed on the page may lie on the value itself.
      if(!region||!box)return {kind:'value',cause:'region_unplaced'};
      const touched=evidence.filter(anchor=>anchor.block_ids.includes(id)||
        anchor.polygons.some(polygon=>{const other=bounds([polygon]);return !other||intersects(box,other);})||!anchor.polygons.length);
      // What cannot be read, compared or assigned to a body block is a doubt about the value only where the value's own
      // evidence lies on it.
      const unplaced=(cause:FieldSourceAssemblyDoubt['cause']):FieldSourceAssemblyDoubt=>({kind:touched.length?'value':'elsewhere',cause});
      let found:FieldSourceAssemblyDoubt|null=null;
      if(!readable(region))found=unplaced('region_unreadable');
      else if(equivalentLabelledValue(candidates,region,page,anchors))continue;
      else{
        // Parent lines, alternatives and withheld words share physical scope.
        // A retained body block supplies context even when the doubtful fragment
        // itself was withheld; without such a scope we cannot exclude any field.
        const scope=body.filter(owner=>{const other=bounds(owner.polygons);return other&&intersects(box,other);});
        // A fragment omitted from all readable alternatives may contain another
        // value without its label. Spatial separation alone cannot dismiss it.
        const compact=(text:string)=>text.normalize('NFKC').replace(/\s/gu,'');
        const difference=differences.get(id);
        if(!scope.length)found=unplaced('no_scope');
        else if(!scope.some(owner=>compact(owner.raw_text!).includes(compact(region.raw_text!))))found=unplaced('fragment_omitted');
        else if(touched.some(anchor=>!difference||anchorTouchesDisagreement(anchor,region,difference,page,differences)))found={kind:'value',cause:'evidence_touched'};
        else{
          // Also catch an omitted second value/row which is not among the model's
          // citations, but whose local text contains this field's configured label.
          // Generic Name labels must satisfy the same configured section policy as
          // extraction. A witness table cannot label a customer's name elsewhere.
          const labelled=difference?difference.contexts.map((text,index)=>({region:byId.get(difference.contextRegionIds[index]!)??region,text})):
            [region,...scope].map(region=>({region,text:region.raw_text!}));
          if(labelled.some(({region:owner,text})=>labels.some(label=>{
            if(!mentionsLabel(text,[label],definition.excludedLabels)||!hasRoleLabel(text,label,definition))return false;
            const section=definition.partyNameSection;
            return !section||section.headings.some(heading=>heading.normalize('NFKC').toLowerCase()===label.normalize('NFKC').toLowerCase())||
              partyNameSectionEvidence(page,owner,label,definition)!==null;
          })))found={kind:'elsewhere',cause:'label_nearby'};
        }
      }
      if(found?.kind==='value')return found;
      elsewhere??=found;
    }
  }
  return elsewhere;
}
export const SOURCE_ASSEMBLY_UNCERTAIN='cloud_field_source_assembly_uncertain',SOURCE_ASSEMBLY_ELSEWHERE='cloud_field_source_assembly_elsewhere';
/** The receipt kept with a field: a doubt on what its value reads withholds the value; a doubt elsewhere on the page is
 * a note that something more may have gone unread. */
export const sourceAssemblyReceipt=(doubt:FieldSourceAssemblyDoubt|null)=>doubt===null?null:doubt.kind==='elsewhere'?SOURCE_ASSEMBLY_ELSEWHERE:SOURCE_ASSEMBLY_UNCERTAIN;
/** Whether any assembly doubt bears on the field, on its value or elsewhere. */
export function fieldSourceAssemblyUncertain(definition:ReviewFieldDefinition,candidates:DocumentFieldObservation['candidates'],pages:DocumentPageArtifact[],anchors:EvidenceAnchor[]):boolean {
  return fieldSourceAssemblyDoubt(definition,candidates,pages,anchors)!==null;
}

/** New extraction finalization only: deterministic recovery may supply or
 * replace source-bound candidates after the model passes. Recheck that final
 * evidence, while preserving every other reason for incomplete coverage. */
export function finalizeFieldSourceCoverage(input:{fields:DocumentFieldObservation[];definitions:ReviewFieldDefinition[];
  pages:DocumentPageArtifact[];logicalDocuments:DocumentBundle['logicalDocuments'];anchors:EvidenceAnchor[]}) {
  const generic='cloud_field_coverage_incomplete',receipts=[SOURCE_ASSEMBLY_UNCERTAIN,SOURCE_ASSEMBLY_ELSEWHERE];
  const informational=new Set(['party_name_boundary_corroborated','ocr_table_cell_conflict_corroborated','overlapping_source_quote']);
  return input.fields.map(field=>{
    const definition=input.definitions.find(item=>item.id===field.fieldId),coverage=field.extractionCoverage;
    if(!definition||!coverage||field.status==='not_applicable')return field;
    const numbers=input.logicalDocuments.filter(material=>material.labelId&&definition.taxonomyIds?.includes(material.labelId)).flatMap(material=>material.pageNumbers);
    const pages=input.pages.filter(page=>numbers.includes(page.page.page_number));
    const sourceReason=sourceAssemblyReceipt(fieldSourceAssemblyDoubt(definition,field.candidates,pages,input.anchors)),uncertain=sourceReason!==null;
    const previous=receipts.find(code=>coverage.reasonCodes.includes(code))??null,hadSourceReason=previous!==null;
    if(sourceReason===previous)return field;
    const remaining=coverage.reasonCodes.filter(code=>!receipts.includes(code)&&code!==generic);
    const resolved=hadSourceReason&&!uncertain&&remaining.every(code=>informational.has(code))&&
      !['failed','unknown'].includes(coverage.completion)&&field.semanticFilter?.state==='completed'&&
      numbers.every(page=>coverage.reviewedPageNumbers.includes(page));
    const state=uncertain?'incomplete':resolved?'complete':coverage.state;
    const update=(codes:string[])=>[...new Set([...codes.filter(code=>!receipts.includes(code)&&(state!=='complete'||code!==generic)),
      ...(sourceReason?[sourceReason,generic]:[])])];
    return {...field,extractionCoverage:{...coverage,state,reasonCodes:update(coverage.reasonCodes)},coverageGaps:update(field.coverageGaps),
      ...(field.semanticFilter?{semanticFilter:{...field.semanticFilter,reasonCodes:update(field.semanticFilter.reasonCodes)}}:{})};
  });
}
