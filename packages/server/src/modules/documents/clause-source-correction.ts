import {isDeepStrictEqual} from 'node:util';
import {DocumentFieldCandidateSchema,SourceCorrectionBindingSchema,candidateAdoptionValue,
  type DocumentBundle,type DocumentFieldObservation,type DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {DocumentRegion,EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {anchorsForText,compareRegionSources,sha256,validateAnchorSource} from '../../document/evidence.js';

type Candidate=DocumentFieldObservation['candidates'][number];
type Segment=NonNullable<Candidate['evidenceSegments']>[number];
type Evidence=NonNullable<Candidate['sourceCorrectionEvidence']>;
type Located={page:DocumentPageArtifact;region:DocumentRegion;quote:string;anchor:EvidenceAnchor};
type Correction={index:number;original:Located;native:Located;ocr:Located;parts:[Located,Located,Located]};
const reason='private_independent_line_source_correction';
const unique=<T>(values:T[])=>[...new Set(values)];
const withoutId=(value:Candidate&{candidateId?:string}):Candidate=>{
  const {candidateId:_,...candidate}=value;return candidate;
};
export interface ClauseSourceCorrectionInput {
  fields:DocumentFieldObservation[];definitions:ReviewFieldDefinition[];pages:DocumentPageArtifact[];
  logicalDocuments:DocumentBundle['logicalDocuments'];anchors:EvidenceAnchor[];binding:Evidence['binding'];
}
function bounds(region:DocumentRegion):[number,number,number,number]|undefined {
  if(region.polygons.length!==1)return;
  const polygon=region.polygons[0]!;
  if(polygon.length<3||polygon.some(point=>point.some(value=>!Number.isFinite(value))))return;
  return [Math.min(...polygon.map(p=>p[0])),Math.min(...polygon.map(p=>p[1])),
    Math.max(...polygon.map(p=>p[0])),Math.max(...polygon.map(p=>p[1]))];
}
function available(page:DocumentPageArtifact,region:DocumentRegion):boolean {
  const box=bounds(region);
  return page.status!=='failed'&&region.kind==='text'&&region.processing_status==='ready'&&
    !!region.raw_text&&region.raw_text.length<=8000&&sha256(region.raw_text)===region.raw_text_sha256&&
    !!box&&box[0]>=0&&box[1]>=0&&box[2]<=page.page.width&&box[3]<=page.page.height&&box[2]>box[0]&&box[3]>box[1]&&
    region.document_version_id===page.scope.documentVersionId&&region.parse_revision===page.scope.parseRevision&&
    region.page_asset_id===page.page.page_asset_id&&page.page.document_version_id===page.scope.documentVersionId&&
    page.page.parse_revision===page.scope.parseRevision&&page.page.source_sha256===page.scope.sourceSha256&&
    !page.conflicts.some(conflict=>conflict.region_ids.includes(region.region_id));
}
function locate(page:DocumentPageArtifact,region:DocumentRegion,quote:string):Located|undefined {
  if(!available(page,region)||!quote||quote.length>2000)return;
  try{
    const anchors=anchorsForText(page.page,[region],quote);
    if(anchors.length!==1||anchors[0]!.localization_status!=='block_only')return;
    validateAnchorSource(anchors[0]!,page.page,page.regions);
    return {page,region,quote,anchor:anchors[0]!};
  }catch{return;}
}
function singleOccurrence(text:string,part:string):number {
  const start=text.indexOf(part);return start>=0&&text.indexOf(part,start+1)<0?start:-1;
}
/** Fixed, literal, complete-grapheme edges, never a similarity or edit-distance
 * choice. Only an interior same-length source discrepancy is supported.
 * Edge changes, insertion/deletion and competing windows remain unresolved. */
export function exactLinePartition(segment:string,line:string):[string,string,string]|undefined {
  const graphemes=[...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(line)];
  if(graphemes.length<25||line.length>2000||/[\r\n]/u.test(line))return;
  const head=graphemes.slice(0,12).map(value=>value.segment).join('');
  const tail=graphemes.slice(-12).map(value=>value.segment).join('');
  const start=singleOccurrence(segment,head),last=singleOccurrence(segment,tail),end=last+tail.length;
  if(start<=0||last<start+head.length||end>=segment.length||end-start!==line.length)return;
  if(segment.slice(start,end)===line)return;
  const edges=new Set([...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(segment)].map(value=>value.index));
  if(!edges.has(start)||!edges.has(end))return;
  const before=segment.slice(0,start),after=segment.slice(end);
  if(!before.trim()||!after.trim())return;
  return [before,line,after];
}
function insideLine(line:DocumentRegion,container:DocumentRegion):boolean {
  const l=bounds(line),c=bounds(container);if(!l||!c)return false;
  // Containment uses actual source coordinates, not the text's occurrence order.
  return l[0]>=c[0]&&l[1]>=c[1]&&l[2]<=c[2]&&l[3]<=c[3]&&l[3]-l[1]<=40;
}
function sourcesForSegment(segment:Segment,pages:DocumentPageArtifact[],material:DocumentBundle['logicalDocuments'][number],anchors:Map<string,EvidenceAnchor>):Located[] {
  // Single-region anchors identify the only regions that can reproduce their IDs.
  // Narrow the search before expensive quotation/geometry checks; still rebuild
  // and compare the complete anchor below, never trust the supplied block alone.
  const ids=new Set(segment.anchorIds.flatMap(id=>anchors.get(id)?.block_ids??[]));
  return pages.flatMap(page=>segment.pageNumbers.includes(page.page.page_number)?
    page.regions.filter(region=>ids.has(region.region_id)&&page.canonicalRegionIds.includes(region.region_id)&&material.regionIds.includes(region.region_id))
      .flatMap(region=>{const found=locate(page,region,segment.rawValue);return found&&segment.anchorIds.includes(found.anchor.anchor_id)?[found]:[];}):[]);
}
type LinePair={native:DocumentRegion;ocr:DocumentRegion};
function correction(index:number,located:Located,cache:Map<DocumentPageArtifact,LinePair[]>):Correction|undefined {
  if(located.region.source!=='vl_ocr'||located.page.nativeTrust!=='validated_geometry_and_visibility')return;
  const page=located.page;
  const matches:Correction[]=[];
  let pairs=cache.get(page);
  if(!pairs){
    pairs=[];
    const nativeRegions=page.regions.filter(region=>region.source==='native_pdf');
    const ocrRegions=page.regions.filter(region=>region.source==='pp_ocr'&&available(page,region));
    for(const native of nativeRegions){
      if(!available(page,native)||/[\r\n]/u.test(native.raw_text!)||native.raw_text!.trim()!==native.raw_text)continue;
      if(nativeRegions.some(other=>other!==native&&compareRegionSources(native,other)!=='distinct'))continue;
      const peers=ocrRegions.filter(other=>other.source_id!==native.source_id&&compareRegionSources(native,other)!=='distinct');
      if(peers.length===1&&peers[0]!.raw_text===native.raw_text)pairs.push({native,ocr:peers[0]!});
    }
    cache.set(page,pairs);
  }
  for(const {native,ocr} of pairs){
    if(!insideLine(native,located.region))continue;
    const quote=native.raw_text!;
    const p=exactLinePartition(located.quote,quote);if(!p)continue;
    const n=locate(page,native,quote),o=locate(page,ocr,quote);
    const before=locate(page,located.region,p[0]),after=locate(page,located.region,p[2]);
    if(n&&o&&before&&after)matches.push({index,original:located,native:n,ocr:o,parts:[before,n,after]});
  }
  return matches.length===1?matches[0]:undefined;
}
const asSegment=(located:Located):Segment=>({rawValue:located.quote,contextText:located.quote,
  anchorIds:[located.anchor.anchor_id],contextAnchorIds:[located.anchor.anchor_id],pageNumbers:[located.page.page.page_number]});
const asProof=(located:Located)=>({quote:located.quote,textSha256:sha256(located.quote),
  anchorIds:[located.anchor.anchor_id],pageNumbers:[located.page.page.page_number]});

/** Pure, bounded private reconciliation. Original OCR, model responses and
 * originalCandidates are retained. It never invents a contiguous corrected quote
 * in the inaccurate VL block: the corrected line is a separate native reference,
 * with a separate agreeing PP reference required for subsequent adoption. */
export function correctClauseSources(input:ClauseSourceCorrectionInput):{fields:DocumentFieldObservation[];anchors:EvidenceAnchor[]} {
  const binding=SourceCorrectionBindingSchema.parse(input.binding),added:EvidenceAnchor[]=[];
  const sourceAnchors=new Map(input.anchors.map(anchor=>[anchor.anchor_id,anchor]));
  const linePairs=new Map<DocumentPageArtifact,LinePair[]>();
  const definitions=new Map(input.definitions.map(value=>[value.id,value]));
  const fields=input.fields.map(field=>{
    const definition=definitions.get(field.fieldId),filter=field.semanticFilter;
    if(field.status==='not_applicable'||field.documentVersionId!==binding.documentVersionId||field.parseRevision!==binding.parseRevision||
      definition?.valueMultiplicity!=='clauses'||definition.recipe.mode!=='cloud_grounded_extract'||definition.recipe.version!=='azure-grounded-fields-v2'||
      filter?.version!=='azure-grounded-fields-v2'||filter.state!=='completed')return field;
    const candidates:Candidate[]=[],originalCandidates=[...filter.originalCandidates],decisions=filter.decisions.map(value=>({...value}));
    let changed=false;
    for(const candidate of field.candidates){
      const segments=candidate.evidenceSegments;
      if(candidate.sourceCorrectionEvidence||candidate.roleEvidence||candidate.authorizationEvidence||!segments?.length||segments.length>6||
        candidate.rawValue!==segments[0]!.rawValue){candidates.push(candidate);continue;}
      const originals=filter.originalCandidates.filter(prior=>!prior.sourceCorrectionEvidence&&isDeepStrictEqual(withoutId(prior),candidate)&&
        filter.decisions.some(decision=>decision.candidateId===prior.candidateId&&decision.decision==='selected'&&
          segments.every(segment=>segment.anchorIds.length&&segment.anchorIds.some(id=>decision.anchorIds.includes(id)))));
      if(!originals.length){candidates.push(candidate);continue;}
      const material=input.logicalDocuments.filter(item=>item.labelId&&definition.taxonomyIds?.includes(item.labelId)&&
        ['candidate','confirmed'].includes(item.status)&&segments.every(segment=>segment.pageNumbers.length&&segment.pageNumbers.every(page=>item.pageNumbers.includes(page))));
      if(material.length!==1||input.logicalDocuments.some(other=>other!==material[0]&&other.pageNumbers.some(page=>material[0]!.pageNumbers.includes(page)))){
        candidates.push(candidate);continue;
      }
      const pages=input.pages.filter(page=>material[0]!.pageNumbers.includes(page.page.page_number));
      if(pages.length!==material[0]!.pageNumbers.length||pages.some(page=>page.scope.documentVersionId!==binding.documentVersionId||
        page.scope.parseRevision!==binding.parseRevision||page.scope.sourceSha256!==binding.sourceSha256)){candidates.push(candidate);continue;}
      const located=segments.map(segment=>sourcesForSegment(segment,pages,material[0]!,sourceAnchors));
      if(located.some(values=>!values.length)||located.some(values=>values.some(value=>!candidate.anchorIds.includes(value.anchor.anchor_id)))||
        segments.some((segment,index)=>segment.anchorIds.some(id=>!located[index]!.some(value=>value.anchor.anchor_id===id)))||
        candidate.anchorIds.some(id=>!segments.some(segment=>segment.anchorIds.includes(id)))){
        candidates.push(candidate);continue;
      }
      // Unchanged segments retain their existing independent source occurrences.
      // Only the segment being corrected must have one unique original VL source.
      const corrections=located.flatMap((values,index)=>{
        if(values.length!==1)return[];
        const c=correction(index,values[0]!,linePairs);return c?[c]:[];
      });
      if(corrections.length!==1){candidates.push(candidate);continue;}
      const fix=corrections[0]!,nextSegments=segments.flatMap((segment,index)=>index===fix.index?fix.parts.map(asSegment):[segment]);
      const sourceCorrectionEvidence:Evidence={version:'independent-line-source-v1',association:'candidate',method:'independent_line_agreement',
        targetFieldId:field.fieldId,logicalDocumentId:material[0]!.id,sourceCandidateIds:originals.map(value=>value.candidateId),
        binding,segmentIndex:fix.index,originalSegment:asProof(fix.original),nativeLine:asProof(fix.native),ocrLine:asProof(fix.ocr)};
      const anchors=unique(nextSegments.flatMap(segment=>segment.anchorIds)),pageNumbers=unique(nextSegments.flatMap(segment=>segment.pageNumbers));
      // A source correction does not rewrite a model's semantic component or
      // silently keep its inaccurate derived value. The complete clause is kept.
      const next:Candidate={rawValue:nextSegments[0]!.rawValue,normalizedValue:null,evidenceSegments:nextSegments,
        anchorIds:anchors,pageNumbers,sourceCorrectionEvidence};
      if(candidateAdoptionValue(next).length>10000){candidates.push(candidate);continue;}
      const candidateId=`local-line-${sha256(JSON.stringify(next)).slice(0,32)}`;
      candidates.push(next);originalCandidates.push({...next,candidateId});
      // Other completed rounds may retain the same inaccurate source span with
      // different semantic components. They must not remain selectable after the
      // visible clause is corrected. Equal words at another source are untouched.
      const superseded=new Set(filter.originalCandidates.filter(prior=>!prior.sourceCorrectionEvidence&&
        prior.evidenceSegments?.some(segment=>segment.rawValue===fix.original.quote&&segment.anchorIds.includes(fix.original.anchor.anchor_id)))
        .map(prior=>prior.candidateId));
      for(const decision of decisions)if(superseded.has(decision.candidateId))decision.decision='rejected';
      decisions.push({candidateId,decision:'selected',anchorIds:unique([...anchors,fix.native.anchor.anchor_id,fix.ocr.anchor.anchor_id]),pageNumbers});
      added.push(...fix.parts.map(value=>value.anchor),fix.native.anchor,fix.ocr.anchor);changed=true;
    }
    if(!changed)return field;
    return {...field,candidates,rawValue:candidates.length===1?candidates[0]!.rawValue:null,normalizedValue:null,
      anchorIds:unique(candidates.flatMap(value=>value.anchorIds)),pageNumbers:unique(candidates.flatMap(value=>value.pageNumbers)),
      coverageGaps:unique([...field.coverageGaps,reason]),
      semanticFilter:{...filter,originalCandidates,decisions,reasonCodes:unique([...filter.reasonCodes,reason])}};
  });
  return {fields,anchors:[...new Map([...input.anchors,...added].map(anchor=>[anchor.anchor_id,anchor])).values()]};
}

/** The command supplies persisted fields and immutable current sources. Request
 * metadata cannot nominate a new source candidate: first require exact equality
 * to the persisted local result, then remove it and reconstruct the entire proof. */
export function verifySourceCorrectionCandidate(input:ClauseSourceCorrectionInput,candidateId:string,value:unknown):boolean {
  try{
    const candidate=DocumentFieldCandidateSchema.parse(value),proof=candidate.sourceCorrectionEvidence;
    if(!proof||!isDeepStrictEqual(proof.binding,SourceCorrectionBindingSchema.parse(input.binding)))return false;
    const field=input.fields.find(item=>item.fieldId===proof.targetFieldId);
    const persisted=field?.semanticFilter?.originalCandidates.find(item=>item.candidateId===candidateId);
    if(!persisted||!isDeepStrictEqual(withoutId(persisted),candidate)||!field!.candidates.some(item=>isDeepStrictEqual(item,candidate)))return false;
    const sourceIds=new Set(proof.sourceCandidateIds);
    const sources=field!.semanticFilter!.originalCandidates.filter(item=>sourceIds.has(item.candidateId));
    if(sources.length!==sourceIds.size||sources.some(item=>item.sourceCorrectionEvidence||item.authorizationEvidence||item.roleEvidence)||
      !field!.semanticFilter!.reasonCodes.includes(reason)||
      sources.some(item=>!field!.semanticFilter!.decisions.some(decision=>decision.candidateId===item.candidateId&&decision.decision==='rejected')))return false;
    const fields=input.fields.map(item=>{
      if(item!==field)return item;
      const filter=item.semanticFilter!,removed=new Set(filter.originalCandidates.filter(item=>item.sourceCorrectionEvidence).map(item=>item.candidateId));
      return {...item,candidates:[...item.candidates.filter(item=>!item.sourceCorrectionEvidence),...sources.map(withoutId)],
        semanticFilter:{...filter,originalCandidates:filter.originalCandidates.filter(item=>!removed.has(item.candidateId)),
          decisions:filter.decisions.filter(item=>!removed.has(item.candidateId)).map(item=>sourceIds.has(item.candidateId)?{...item,decision:'selected' as const}:item)}};
    });
    const rebuilt=correctClauseSources({...input,fields}).fields.find(item=>item.fieldId===proof.targetFieldId)?.semanticFilter?.originalCandidates
      .find(item=>item.candidateId===candidateId);
    return !!rebuilt&&isDeepStrictEqual(withoutId(rebuilt),candidate);
  }catch{return false;}
}
