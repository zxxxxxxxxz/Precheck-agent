import type {DocumentBundle,DocumentFieldObservation,DocumentPageArtifact} from '@hsbc/contracts/documents';
import {AuthorizationSourceBindingSchema,DocumentFieldCandidateSchema} from '@hsbc/contracts/documents';
import {isDeepStrictEqual} from 'node:util';
import type {DocumentRegion,EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {anchorsForText,sha256,validateAnchorSource} from '../../document/evidence.js';

type Candidate=DocumentFieldObservation['candidates'][number];
type Proof=NonNullable<Candidate['authorizationEvidence']>['sources'][number];
type Binding=NonNullable<Candidate['authorizationEvidence']>['binding'];
type Source={page:DocumentPageArtifact;region:DocumentRegion};
type Located={source:Source;quote:string;anchors:EvidenceAnchor[]};
type Seed={candidate:Candidate;candidateIds:string[];located:Located[]};
const version='authorization-source-v1' as const;
const unique=<T>(values:T[])=>[...new Set(values)];
const compact=(text:string)=>text.replace(/\s+/gu,' ').trim();
const escaped=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
const sameCandidate=(a:Candidate,b:Candidate)=>JSON.stringify([a.rawValue,a.evidenceSegments?.map(s=>[s.rawValue,s.pageNumbers])])===
  JSON.stringify([b.rawValue,b.evidenceSegments?.map(s=>[s.rawValue,s.pageNumbers])]);

export interface AuthorizationSourceInput {
  fields:DocumentFieldObservation[];definitions:ReviewFieldDefinition[];
  pages:DocumentPageArtifact[];logicalDocuments:DocumentBundle['logicalDocuments'];anchors:EvidenceAnchor[];
  /** The composition root supplies published field IDs, not document values. */
  targetFields:{scope:string;signingConditions:string};
  binding:Binding;
}

function available({page,region}:Source):boolean {
  return page.status!=='failed'&&region.kind==='text'&&region.processing_status==='ready'&&!!region.raw_text&&
    region.raw_text.length<=8000&&region.raw_text_sha256===sha256(region.raw_text)&&region.polygons.length>0&&
    (region.source!=='native_pdf'||page.nativeTrust==='validated_geometry_and_visibility')&&
    region.document_version_id===page.scope.documentVersionId&&region.parse_revision===page.scope.parseRevision&&
    region.page_asset_id===page.page.page_asset_id&&page.page.document_version_id===page.scope.documentVersionId&&
    page.page.parse_revision===page.scope.parseRevision&&page.page.source_sha256===page.scope.sourceSha256&&
    !page.conflicts.some(conflict=>conflict.region_ids.includes(region.region_id));
}
function locate(source:Source,quote:string):Located|undefined {
  if(!available(source)||!quote||quote.length>2000||!source.region.raw_text!.includes(quote))return;
  try{
    const anchors=anchorsForText(source.page.page,[source.region],quote);
    if(anchors.length!==1||anchors.some(a=>!a.polygons.length||['ambiguous','unavailable'].includes(a.localization_status)))return;
    for(const anchor of anchors)validateAnchorSource(anchor,source.page.page,source.page.regions);
    return {source,quote,anchors};
  }catch{return;}
}
function proof(value:Located,kind:Proof['kind']):Proof {
  return {kind,quote:value.quote,textSha256:sha256(value.quote),anchorIds:value.anchors.map(a=>a.anchor_id),
    pageNumbers:[value.source.page.page.page_number]};
}
function proofKey(value:Located):string {
  return JSON.stringify([value.source.page.page.page_number,value.source.region.region_id,value.quote]);
}
function locatedCandidate(candidate:Candidate,sources:Source[]):Located[] {
  const segments=candidate.evidenceSegments??[{rawValue:candidate.rawValue,pageNumbers:candidate.pageNumbers}];
  if(!segments.length||segments.length>8)return[];
  const result:Located[]=[];
  for(const segment of segments){
    const matches=sources.filter(source=>segment.pageNumbers.includes(source.page.page.page_number))
      .flatMap(source=>{const value=locate(source,segment.rawValue);return value?[value]:[];});
    // A duplicated quote in different original regions is not a unique source.
    if(matches.length!==1||!matches[0]!.anchors.every(anchor=>candidate.anchorIds.includes(anchor.anchor_id))||
      ('anchorIds' in segment&&!matches[0]!.anchors.every(anchor=>segment.anchorIds.includes(anchor.anchor_id))))return[];
    result.push(matches[0]!);
  }
  return result;
}
function seeds(field:DocumentFieldObservation,sources:Source[]):Seed[] {
  const filter=field.semanticFilter;
  if(filter?.version!=='azure-grounded-fields-v2'||filter.state!=='completed')return[];
  return field.candidates.flatMap(candidate=>{
    if(candidate.authorizationEvidence||candidate.roleEvidence||'sourceCorrectionEvidence' in candidate)return[];
    const located=locatedCandidate(candidate,sources);
    if(!located.length)return[];
    const originals=filter.originalCandidates.filter(prior=>{
      if(prior.authorizationEvidence||prior.roleEvidence||'sourceCorrectionEvidence' in prior||!sameCandidate(prior,candidate))return false;
      const originalSources=locatedCandidate(prior,sources);
      return isDeepStrictEqual(originalSources.map(proofKey),located.map(proofKey))&&
        filter.decisions.some(decision=>decision.candidateId===prior.candidateId&&decision.decision==='selected'&&
          originalSources.every(source=>source.anchors.every(anchor=>decision.anchorIds.includes(anchor.anchor_id))));
    });
    return originals.length?[{candidate,candidateIds:originals.map(c=>c.candidateId),located}]:[];
  });
}

/** A complete affirmative resolution, not a mention of a seal or an arbitrary
 * quote containing "affixed". Conditions remain literal, including "required".
 * Unsupported drafting stays an explicit coverage gap rather than being guessed.
 */
export function isExplicitSealResolution(text:string):boolean {
  const value=compact(text);
  const party='([A-Z][A-Za-z ]{1,79})';
  const pattern=new RegExp(`^(?:[1-9]\\d{0,2}\\.\\s*)?THAT authori[sz]ation be and is hereby given for the (?:Common )?Seal of the ${party} to be affixed, where required, in accordance with the (?:constitution|articles of association) of the \\1 to ([^;\\r\\n]{1,1500});$`,'u');
  const match=pattern.exec(value);
  // The target is a document description, not another statement about whether
  // this resolution is operative. No sentence tail is swallowed by the grammar.
  return !!match&&/\b[Dd]ocuments?\b/u.test(match[2]!)&&!/[.!?]/u.test(match[2]!);
}

type Definition={terms:string[];quote:string};
/** Bounded, whole-paragraph legal definitions. The names of the defined and
 * excluded documents are captured from the source; no sample term is built in.
 */
export function explicitExclusionDefinition(text:string):Definition|undefined {
  const value=compact(text),word='[A-Z][A-Za-z ]{1,119}',quote='["“]';
  const collective=new RegExp(`^\\((?:other than|excluding) (?:the )?(${word}), any such [a-z][a-z ]{1,100} set out above, (?:a|an|the) ${quote}(${word})["”], and collectively, the ${quote}(${word})["”]\\)\\.?$`,'u').exec(value);
  if(collective&&collective[3]===collective[2]+'s')return{terms:[collective[2]!,collective[3]!],quote:text.trim()};
  const direct=new RegExp(`^${quote}(${word})["”] means ([^.;!?]{1,1500}(?:excluding|other than) [^.;!?]{1,300})\\.$`,'u').exec(value);
  if(direct)return{terms:[direct[1]!],quote:text.trim()};
}
function potentialTerms(text:string):string[] {
  if(!/\b(?:means|collectively|referred to as)\b/u.test(text))return[];
  return unique([...text.matchAll(/["“]([A-Z][A-Za-z ]{1,119})["”]/gu)].map(match=>match[1]!));
}
function usesTerm(text:string,term:string):boolean {
  return new RegExp(`(?<![A-Za-z])${escaped(term)}(?![A-Za-z])`,'u').test(text);
}
function eligible(field:DocumentFieldObservation|undefined,definition:ReviewFieldDefinition|undefined,label:string):field is DocumentFieldObservation {
  return !!field&&!!definition&&field.status!=='not_applicable'&&definition.objectKind==='signatory'&&
    definition.objectRole==='authorization_scope'&&definition.valueMultiplicity==='clauses'&&definition.recipe.mode==='cloud_grounded_extract'&&
    definition.recipe.version==='azure-grounded-fields-v2'&&definition.taxonomyIds?.includes(label)===true&&
    field.semanticFilter?.version==='azure-grounded-fields-v2'&&field.semanticFilter.state==='completed';
}
function gap(field:DocumentFieldObservation,reason:string):void {
  field.coverageGaps=unique([...field.coverageGaps,reason]);
  field.extractionCoverage={reviewedPageNumbers:field.extractionCoverage?.reviewedPageNumbers??[],state:'incomplete',
    completion:field.extractionCoverage?.completion??'not_requested',reasonCodes:unique([...(field.extractionCoverage?.reasonCodes??[]),reason])};
}

/** Final private post-processing only. No calls, source changes, translations,
 * CSV, global-name association, or alteration of the provider completion record.
 * Existing candidates remain; additions have separate stable IDs and provenance.
 */
export function augmentAuthorizationSources(input:AuthorizationSourceInput):{fields:DocumentFieldObservation[];anchors:EvidenceAnchor[]} {
  const binding=AuthorizationSourceBindingSchema.parse(input.binding);
  const fields=input.fields.map(field=>({...field,candidates:[...field.candidates]})),addedAnchors:EvidenceAnchor[]=[];
  if(input.targetFields.scope===input.targetFields.signingConditions||binding.scopeFieldId!==input.targetFields.scope||
    binding.signingConditionsFieldId!==input.targetFields.signingConditions)return{fields,anchors:input.anchors};
  const definitions=new Map(input.definitions.map(definition=>[definition.id,definition]));
  const scope=fields.find(field=>field.fieldId===input.targetFields.scope);
  const signing=fields.find(field=>field.fieldId===input.targetFields.signingConditions);
  const scopeDefinition=definitions.get(input.targetFields.scope),signingDefinition=definitions.get(input.targetFields.signingConditions);
  const add=(field:DocumentFieldObservation,value:Located,materialId:string,method:NonNullable<Candidate['authorizationEvidence']>['method'],
    origins:Seed[],evidence:Proof[],definedTerm?:string)=>{
    const metadata={version,association:'candidate' as const,method,targetFieldId:field.fieldId,logicalDocumentId:materialId,
      sourceCandidateIds:unique(origins.flatMap(seed=>seed.candidateIds)),binding,...(definedTerm?{definedTerm}:{}),sources:evidence};
    const anchorIds=value.anchors.map(anchor=>anchor.anchor_id),contextAnchorIds=unique(evidence.flatMap(source=>source.anchorIds));
    const candidate:Candidate={rawValue:value.quote,normalizedValue:null,displayValue:value.quote,anchorIds,
      pageNumbers:[value.source.page.page.page_number],contextText:value.quote,contextAnchorIds,
      evidenceSegments:[{rawValue:value.quote,contextText:value.quote,anchorIds,contextAnchorIds,pageNumbers:[value.source.page.page.page_number]}],
      authorizationEvidence:metadata};
    const candidateId=`local-authorization-${sha256(JSON.stringify(candidate)).slice(0,32)}`;
    if(field.semanticFilter!.originalCandidates.some(prior=>prior.candidateId===candidateId))return;
    field.candidates.push(candidate);field.status='uncertain';field.rawValue=field.candidates.length===1?candidate.rawValue:null;field.normalizedValue=null;
    field.anchorIds=unique([...field.anchorIds,...anchorIds]);field.pageNumbers=unique([...field.pageNumbers,...candidate.pageNumbers]);
    field.semanticFilter={...field.semanticFilter!,originalCandidates:[...field.semanticFilter!.originalCandidates,{...candidate,candidateId}],
      decisions:[...field.semanticFilter!.decisions,{candidateId,decision:'selected',anchorIds:unique([...anchorIds,...contextAnchorIds]),
        pageNumbers:unique(evidence.flatMap(source=>source.pageNumbers))}],
      reasonCodes:unique([...field.semanticFilter!.reasonCodes,'private_authorization_source_candidate'])};
    field.coverageGaps=unique([...field.coverageGaps,'entity_candidate_requires_confirmation','private_authorization_source_candidate']);
    addedAnchors.push(...value.anchors,...origins.flatMap(seed=>seed.located.flatMap(source=>source.anchors)));
  };
  for(const material of input.logicalDocuments){
    if(!material.labelId||!['candidate','confirmed'].includes(material.status)||
      input.logicalDocuments.some(other=>other!==material&&other.pageNumbers.some(page=>material.pageNumbers.includes(page))))continue;
    if(!eligible(scope,scopeDefinition,material.labelId)||!eligible(signing,signingDefinition,material.labelId))continue;
    const pages=input.pages.filter(page=>material.pageNumbers.includes(page.page.page_number));
    if(pages.length!==material.pageNumbers.length||!pages.length||pages.some(page=>
      page.scope.documentVersionId!==binding.documentVersionId||page.scope.parseRevision!==binding.parseRevision||
      page.scope.sourceSha256!==binding.sourceSha256)||[scope,signing].some(field=>
      field.documentVersionId!==binding.documentVersionId||field.parseRevision!==binding.parseRevision))continue;
    const rawSources=pages.flatMap(page=>page.regions.filter(region=>page.canonicalRegionIds.includes(region.region_id)&&material.regionIds.includes(region.region_id)&&
      (region.source!=='native_pdf'||page.nativeTrust==='validated_geometry_and_visibility'))
      .map(region=>({page,region})));
    const sources=rawSources.filter(available);
    const origin=seeds(scope,sources);
    const present=(field:DocumentFieldObservation,quote:string)=>field.candidates.some(candidate=>
      candidate.pageNumbers.length&&candidate.pageNumbers.every(page=>material.pageNumbers.includes(page))&&
      (candidate.evidenceSegments??[{rawValue:candidate.rawValue}]).some(segment=>segment.rawValue===quote)&&
      locatedCandidate(candidate,sources).some(source=>source.quote===quote));
    // Check the source inventory too, not just the model's nonempty answer.
    for(const source of rawSources){
      const text=source.region.raw_text?.trim()??'';
      if(!/\b(?:Common )?Seal\b/u.test(text)||!/\baffixed\b/u.test(text))continue;
      const seed=origin.filter(candidate=>candidate.located.some(located=>located.quote.trim()===text));
      if(present(signing,text))continue;
      if(!isExplicitSealResolution(text)||seed.length!==1){gap(signing,'authorization_signing_source_unresolved');continue;}
      const located=locate(source,text);
      if(!located){gap(signing,'authorization_signing_source_unresolved');continue;}
      add(signing,located,material.id,'classified_clause',seed,[proof(located,'operative_clause')]);
    }
    const usedText=origin.flatMap(seed=>seed.located.map(value=>value.quote)).join('\n');
    const terms=unique(rawSources.flatMap(source=>potentialTerms(source.region.raw_text??''))).filter(term=>usesTerm(usedText,term));
    const seenDefinitions=new Set<string>();
    for(const term of terms){
      const mentions=rawSources.filter(source=>potentialTerms(source.region.raw_text??'').includes(term));
      const matches=mentions.flatMap(source=>{
        const definition=explicitExclusionDefinition(source.region.raw_text??'');
        if(!definition?.terms.includes(term))return[];
        const located=locate(source,definition.quote);return located?[located]:[];
      });
      // Not every definition is an exclusion. Only a source explicitly carrying
      // an exclusion starts this closure check, but every competing definition
      // of that term must be accounted for before establishing a unique link.
      if(!mentions.some(source=>/\b(?:other than|excluding)\b/u.test(source.region.raw_text??'')))continue;
      if(matches.length!==1||mentions.length!==1){gap(scope,'authorization_definition_source_unresolved');continue;}
      const definition=matches[0]!,key=proofKey(definition);
      if(seenDefinitions.has(key)||present(scope,definition.quote))continue;
      const references=origin.filter(seed=>seed.located.some(located=>usesTerm(located.quote,term)&&isExplicitSealResolution(located.quote)));
      // This version accepts a fully affirmative resolution as the operative
      // reference, not another definition, quoted example or generic mention.
      // Other drafting remains a gap until a separate grammar is verified.
      const reference=references.find(seed=>seed.located.length<=7);
      if(!reference){gap(scope,'authorization_definition_source_unresolved');continue;}
      seenDefinitions.add(key);
      add(scope,definition,material.id,'referenced_definition',[reference],
        [proof(definition,'definition'),...reference.located.map(value=>proof(value,'operative_clause'))],term);
    }
  }
  return{fields,anchors:[...new Map([...input.anchors,...addedAnchors].map(anchor=>[anchor.anchor_id,anchor])).values()]};
}

/** Adoption replays the deterministic private proof against persisted original
 * pages, the adopted directory and the currently published field definitions.
 * Derived output is removed first: replay must never trust its own cached result.
 */
export function verifyAuthorizationSourceCandidate(input:AuthorizationSourceInput,candidateId:string,value:unknown):boolean {
  try{
    const candidate=DocumentFieldCandidateSchema.parse(value),proof=candidate.authorizationEvidence;
    if(!proof||candidate.roleEvidence||!isDeepStrictEqual(proof.binding,AuthorizationSourceBindingSchema.parse(input.binding)))return false;
    const fields=input.fields.map(field=>{
      const filter=field.semanticFilter;
      const removed=new Set(filter?.originalCandidates.filter(item=>item.authorizationEvidence).map(item=>item.candidateId)??[]);
      return {...field,candidates:field.candidates.filter(item=>!item.authorizationEvidence),
        ...(filter?{semanticFilter:{...filter,originalCandidates:filter.originalCandidates.filter(item=>!item.authorizationEvidence),
          decisions:filter.decisions.filter(item=>!removed.has(item.candidateId))}}:{})};
    });
    const rebuilt=augmentAuthorizationSources({...input,fields});
    const recovered=rebuilt.fields.find(field=>field.fieldId===proof.targetFieldId)?.semanticFilter?.originalCandidates
      .find(item=>item.candidateId===candidateId&&item.authorizationEvidence);
    if(!recovered)return false;
    const {candidateId:_,...body}=recovered;
    return isDeepStrictEqual(DocumentFieldCandidateSchema.parse(body),candidate);
  }catch{return false;}
}
