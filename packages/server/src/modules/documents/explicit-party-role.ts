import type { DocumentBundle, DocumentFieldObservation, DocumentPageArtifact } from '@hsbc/contracts/documents';
import type { DocumentRegion, EvidenceAnchor } from '@hsbc/contracts/evidence';
import type { ReviewFieldDefinition } from '@hsbc/contracts/review-config';
import { anchorsForText, sha256, validateAnchorSource } from '../../document/evidence.js';

type Candidate = DocumentFieldObservation['candidates'][number];
type Source = { page:DocumentPageArtifact; region:DocumentRegion };
type Declaration = { name:string; term:string; registration?:string; source:Source; quote:string; anchors:EvidenceAnchor[]; candidate:Candidate };
export interface ExplicitPartyRoleInput {
  fields:DocumentFieldObservation[];
  definitions:ReviewFieldDefinition[];
  logicalDocuments:DocumentBundle['logicalDocuments'];
  pages:DocumentPageArtifact[];
  anchors:EvidenceAnchor[];
}
const version='explicit-defined-role-v1' as const;
const unique=<T>(values:T[])=>[...new Set(values)];
const escaped=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
const termKey=(value:string)=>value.toLowerCase().replace(/\s+/gu,' ').trim();
// This is a deliberately bounded, affirmative English declaration grammar.
// Unsupported syntax remains a gap; a role heading or nearby word is no proof.
const unsafe=/\b(?:not|never|unless|if|may|might|could|would|former(?:ly)?|previous(?:ly)?|ceased|hypothetical|proposed|conditional)\b|\b(?:subject\s+to|provided\s+that|on\s+behalf\s+of|acting\s+for|shall\s+become)\b/iu;
const safeTerm=(term:string)=>/^[A-Za-z][A-Za-z -]{1,79}$/u.test(term)&&term.trim()===term;
// A cover caption ("as the ...") is not a definition. Only an expressly
// quoted term establishes this link; captions are checked for contradictions.
const marker=(term:string)=>new RegExp(`\\(\\s*(?:hereinafter\\s+(?:called|referred\\s+to\\s+as)\\s+)?the\\s+["“‘']${escaped(term)}["”’']\\s*\\)`,'giu');
const caption=(term:string)=>new RegExp(`\\(\\s*as\\s+the\\s+${escaped(term)}\\s*\\)`,'giu');
const registrationPrefix=/^\s*\(\s*(?:Registration|Company)\s*(?:No\.?|Number)\s*[:：]?\s*([\p{L}\p{N} ._/-]{1,100})\)\s*/iu;
const compact=(text:string)=>text.replace(/\s+/gu,' ').trim();

function incorporationDescription(text:string):boolean {
  if(!text.trim())return true;
  // Deliberately narrow postal self-description. No free-form tail can consume
  // a subsidiary, representative, or second party before the defined term.
  const match=/^,\s*a company (?:incorporated|registered) in ([A-Z][a-z]+(?: (?:[A-Z][a-z]+|of|the)){0,4}) and having its registered office at ([A-Za-z0-9 ,./#'-]{1,500})\s*$/u.exec(compact(text));
  if(!match||!match[2]!.includes(','))return false;
  const words=match[2]!.match(/[A-Za-z][A-Za-z'-]*/gu)??[];
  return words.every(word=>/^[A-Z]/u.test(word)||['of','the','de','la'].includes(word));
}

/** The sole supported relationship syntax is an affirmative agreement recital
 * with a numbered parties list and an affirmative lending main clause.
 * A phrase mentioned in ordinary prose, a quotation, a heading, or an item
 * followed by a predicate does not satisfy this grammar. The whole recital is
 * retained, not a fabricated continuous name/role quotation. */
function affirmativeRelation(text:string,term:string,alias:string):boolean {
  if(text.length>2000)return false;
  const value=compact(text),termPattern=escaped(term),aliasPattern=escaped(alias);
  const prefix=/^(?:[A-Z]\.\s*)?Pursuant to (?:a|the) (?:facility|loan|credit) agreement dated \d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\s*/u.exec(value);
  if(!prefix)return false;
  const rest=value.slice(prefix[0].length),between=/\bmade (?:between|among)\s*/gu;
  const boundaries=[...rest.matchAll(between)];
  if(boundaries.length!==1)return false;
  const boundary=boundaries[0]!,definition=rest.slice(0,boundary.index!);
  // Recognize a complete definition, rather than accepting arbitrary prose up
  // to "made between". The optional amendment clause is bounded legal grammar,
  // not a free-text wildcard. A missing OCR closing parenthesis is tolerated
  // only after every word of that clause; it supplies no identity proof itself.
  const definedAgreement='\\(["“][A-Z][A-Za-z ]* Agreement["”]';
  const plural='(?:\\(s\\)|s)?';
  const amendment=`which expression shall, where the context so admits, include any amendment${plural} or variation${plural} thereof and addition${plural} thereto and any other instrument${plural} executed supplemental thereto or in substitution thereof`;
  if(!new RegExp(`^(?:${definedAgreement}\\)|${definedAgreement} ${amendment}\\)?)\\s*$`,'u').test(definition))return false;
  const body=rest.slice(boundary.index!+boundary[0].length);
  const conclusion=new RegExp(`,\\s*the [A-Z][A-Za-z -]{1,79} have(?:, at the request of the ${termPattern},)? (?:severally |jointly |also |hereby )?agreed to make available to the ${termPattern} the [A-Z][A-Za-z ]{1,79} \\(as defined (?:below|herein|therein)\\), upon the terms and subject to the conditions (?:herein|therein) contained\\.$`,'u').exec(body);
  if(!conclusion)return false;
  const parties=body.slice(0,conclusion.index);
  const entries=[...parties.matchAll(/(?:^|;\s*(?:and\s+)?)(\((?:[ivx]+|\d{1,2})\))\s*([^;]+)/gu)];
  if(entries.length<2||entries.map(entry=>entry[0]).join('')!==parties)return false;
  const roman=['i','ii','iii','iv','v','vi','vii','viii','ix','x'];
  if(!entries.every((entry,index)=>entry[1]===`(${index+1})`)&&!entries.every((entry,index)=>entry[1]===`(${roman[index]})`))return false;
  const target=new RegExp(`^the ${termPattern} as (?:the )?${aliasPattern}$`,'iu');
  // A target name appearing in a different, qualified list item is ambiguity.
  const referring=entries.filter(entry=>new RegExp(`\\bthe ${termPattern}\\b`,'iu').test(entry[2]!));
  return referring.length===1&&target.test(referring[0]![2]!.trim());
}

function sameLocatedRecitalFragment(source:Source,proof:Source,term:string,alias:string):boolean {
  if(source.page.page.page_asset_id!==proof.page.page.page_asset_id||source.region.polygons.length!==1||proof.region.polygons.length!==1)return false;
  const polygon=source.region.polygons[0]!,outer=proof.region.polygons[0]!;
  const bounds=(points:typeof polygon)=>[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
  const a=bounds(polygon),b=bounds(outer);
  if(!(a[0]!>=b[0]!&&a[1]!>=b[1]!&&a[2]!<=b[2]!&&a[3]!<=b[3]!))return false;
  // Only a clipped OCR line containing the exact complete first list item may
  // corroborate an already established full recital. It cannot establish one.
  const text=compact(source.region.raw_text??'');
  return !unsafe.test(text)&&new RegExp(`made (?:between|among) \\((?:i|1)\\) the ${escaped(term)} as (?:the )?${escaped(alias)};\\s*\\((?:ii|2)\\) [^.;]{1,120}$`,'iu').test(text);
}

function available(source:Source):boolean {
  const {page,region}=source;
  return page.status!=='failed'&&region.kind==='text'&&region.processing_status==='ready'&&!!region.raw_text&&
    region.raw_text.length<=4000&&region.raw_text_sha256===sha256(region.raw_text)&&region.polygons.length>0&&
    region.page_asset_id===page.page.page_asset_id&&region.document_version_id===page.scope.documentVersionId&&
    region.parse_revision===page.scope.parseRevision&&page.page.document_version_id===page.scope.documentVersionId&&
    page.page.parse_revision===page.scope.parseRevision&&
    !page.conflicts.some(conflict=>conflict.region_ids.includes(region.region_id));
}
function located(source:Source,quote:string):EvidenceAnchor[] {
  try{
    const anchors=anchorsForText(source.page.page,[source.region],quote);
    if(anchors.length!==1||anchors.some(anchor=>anchor.localization_status==='unavailable'||anchor.localization_status==='ambiguous'))return[];
    for(const anchor of anchors)validateAnchorSource(anchor,source.page.page,source.page.regions);
    return anchors;
  }catch{return[];}
}
function nameAnchors(candidate:Candidate,pages:DocumentPageArtifact[],anchors:Map<string,EvidenceAnchor>):EvidenceAnchor[] {
  if(candidate.evidenceSegments&&candidate.evidenceSegments.length!==1||candidate.roleEvidence||
    !candidate.rawValue.trim()||candidate.rawValue!==candidate.rawValue.trim()||candidate.rawValue.length>300)return[];
  const result:EvidenceAnchor[]=[];
  for(const id of candidate.anchorIds){
    const anchor=anchors.get(id),page=anchor&&pages.find(page=>page.page.page_asset_id===anchor.page_asset_id);
    if(!anchor||!page||!anchor.polygons.length||anchor.localization_status==='ambiguous'||anchor.localization_status==='unavailable')continue;
    try{
      validateAnchorSource(anchor,page.page,page.regions);
      const text=anchor.text_span_refs.map(span=>{
        const region=page.regions.find(region=>region.region_id===span.block_id)!;
        return Array.from(region.raw_text!).slice(span.offset,span.offset+span.length).join('');
      }).join('');
      if(text===candidate.rawValue)result.push(anchor);
    }catch{/* A stale or fabricated source cannot seed a role association. */}
  }
  return result;
}
/** Name must directly precede a designation, optionally with its own registration
 * and incorporation description. A second named party or a non-identification
 * phrase defeats the declaration; arbitrary document-wide co-occurrence cannot. */
function declarationFor(source:Source,term:string,match:RegExpMatchArray,candidates:Candidate[]):Declaration|undefined {
  const text=source.region.raw_text!,before=text.slice(0,match.index!);
  const names=unique(candidates.map(candidate=>candidate.rawValue)).filter(name=>before.includes(name));
  if(names.length!==1)return;
  const name=names[0]!,at=before.indexOf(name);
  if(at!==before.lastIndexOf(name)||at>12)return;
  const lead=before.slice(0,at);
  // A short separate opening is not removed from the name here. The name itself
  // must already have independently validated exact source anchors.
  if(lead&&(!/^\s*\p{L}{1,4}\s*,\s*$/u.test(lead)||unsafe.test(lead)||/\b(?:for|by|of|or|and)\b/iu.test(lead)))return;
  const tail=before.slice(at+name.length);
  const registration=registrationPrefix.exec(tail);
  const description=registration?tail.slice(registration[0].length):tail;
  if(!incorporationDescription(description))return;
  if(!registration&&description.trim())return;
  if(unsafe.test(description)||/\b(?:borrower|lender|chargor|mortgagor|guarantor|agent)\b/iu.test(description))return;
  const quote=text.slice(at,match.index!+match[0].length);
  if(quote.length>2000)return;
  const anchors=located(source,quote);
  if(!anchors.length)return;
  const candidate=candidates.find(item=>item.rawValue===name&&item.pageNumbers.includes(source.page.page.page_number))??
    candidates.find(item=>item.rawValue===name)!;
  return {name,term,...(registration?{registration:registration[1]!.trim()}:{}),source,quote,anchors,candidate};
}
function roleSource(quote:string,anchors:EvidenceAnchor[]){
  return {quote,textSha256:sha256(quote),anchorIds:unique(anchors.map(anchor=>anchor.anchor_id)),pageNumbers:unique(anchors.map(anchor=>anchor.page_number))};
}

/** Private deterministic recovery after the final v2 model merge.
 * It reads no network/CSV and changes no original page, provider response,
 * privacy projection or completeness claim. Only an explicit, unambiguous
 * NAME -> defined term -> role declaration produces another unconfirmed candidate.
 */
export function recoverExplicitPartyRoles(input:ExplicitPartyRoleInput):{fields:DocumentFieldObservation[];anchors:EvidenceAnchor[]} {
  const anchors=new Map(input.anchors.map(anchor=>[anchor.anchor_id,anchor]));
  for(const page of input.pages)for(const anchor of page.anchors)if(!anchors.has(anchor.anchor_id))anchors.set(anchor.anchor_id,anchor);
  const fields=input.fields.map(field=>({...field,candidates:[...field.candidates]})),newAnchors:EvidenceAnchor[]=[];
  const definitions=new Map(input.definitions.map(definition=>[definition.id,definition]));
  for(const material of input.logicalDocuments){
    if(!material.labelId||!['candidate','confirmed'].includes(material.status)||
      input.logicalDocuments.some(other=>other!==material&&other.pageNumbers.some(page=>material.pageNumbers.includes(page))))continue;
    const pages=input.pages.filter(page=>material.pageNumbers.includes(page.page.page_number));
    if(!pages.length||pages.length!==material.pageNumbers.length||new Set(pages.map(page=>JSON.stringify(page.scope))).size!==1)continue;
    const rawSources=pages.flatMap(page=>page.regions.filter(region=>page.canonicalRegionIds.includes(region.region_id)&&material.regionIds.includes(region.region_id))
      .map(region=>({page,region})));
    const sources=rawSources.filter(available).sort((a,b)=>a.page.page.page_number-b.page.page.page_number||a.region.reading_order-b.region.reading_order);
    const seeds=input.fields.flatMap(field=>{
      const definition=definitions.get(field.fieldId);
      if(definition?.valueKind!=='party_name'||!definition.taxonomyIds?.includes(material.labelId!)||
        field.documentVersionId!==pages[0]!.scope.documentVersionId||field.parseRevision!==pages[0]!.scope.parseRevision||
        field.semanticFilter?.version!=='azure-grounded-fields-v2'||field.semanticFilter.state!=='completed')return[];
      return field.candidates.filter(candidate=>nameAnchors(candidate,pages,anchors).length)
        .map(candidate=>({candidate,terms:definition.aliases.filter(safeTerm)}));
    });
    for(const term of unique(seeds.flatMap(seed=>seed.terms)).sort()){
      // An unusable competing declaration or role statement is not absence.
      // Do not hide it by filtering to the convenient, readable source alone.
      const reference=new RegExp(`\\bthe\\s+${escaped(term)}\\s+as\\b`,'iu');
      if(rawSources.some(source=>!available(source)&&(marker(term).test(source.region.raw_text??'')||reference.test(source.region.raw_text??''))))continue;
      const candidates=seeds.filter(seed=>seed.terms.some(value=>termKey(value)===termKey(term))).map(seed=>seed.candidate);
      const markers=sources.flatMap(source=>[...source.region.raw_text!.matchAll(marker(term))].map(match=>({source,match})));
      if(!markers.length)continue;
      const declarations=markers.map(({source,match})=>declarationFor(source,term,match,candidates));
      // Even an unresolvable second declaration can refer to another party.
      if(declarations.some(value=>!value))continue;
      const proofs=declarations as Declaration[];
      // A bare registration number is not a jurisdiction-scoped identity.
      // Even equal names/numbers do not merge two separate formal declarations.
      if(proofs.length!==1)continue;
      const declaration=proofs[0]!,name=declaration.name;
      if(rawSources.some(source=>[...(source.region.raw_text??'').matchAll(caption(term))].some(match=>{
        if(!available(source))return true;
        const before=source.region.raw_text!.slice(0,match.index!).trim();
        if(!before.startsWith(name))return true;
        const tail=before.slice(name.length);
        // A damaged registration closing bracket in a cover caption is not
        // repaired and is never used as identity evidence.
        return !!tail.trim()&&!/^\s*\(\s*(?:Registration|Company)\s*(?:No\.?|Number)\s*[:：]?\s*[\p{L}\p{N} ._/-]{1,100}\)?\s*$/iu.test(tail);
      })))continue;
      for(const field of fields){
        const definition=definitions.get(field.fieldId);
        if(definition?.valueKind!=='party_name'||!definition.objectRole||!definition.taxonomyIds?.includes(material.labelId!)||
          field.status==='not_applicable'||field.semanticFilter?.version!=='azure-grounded-fields-v2'||field.semanticFilter.state!=='completed'||
          field.documentVersionId!==pages[0]!.scope.documentVersionId||field.parseRevision!==pages[0]!.scope.parseRevision)continue;
        if(field.candidates.some(candidate=>candidate.rawValue===name))continue;
        const aliases=definition.aliases.filter(safeTerm);
        const relations=sources.flatMap(source=>aliases.flatMap(alias=>{
          const text=source.region.raw_text!;
          if(!affirmativeRelation(text,term,alias))return[];
          const evidence=located(source,text);
          return evidence.length?[{quote:text,anchors:evidence,source,alias}]:[];
        }));
        if(!relations.length)continue;
        const targetReference=new RegExp(`\\bthe\\s+${escaped(term)}\\s+as\\s+(?:the\\s+)?(?:${aliases.map(escaped).join('|')})\\b`,'iu');
        if(rawSources.some(source=>targetReference.test(source.region.raw_text??'')&&!relations.some(proof=>
          proof.source===source||available(source)&&sameLocatedRecitalFragment(source,proof.source,term,proof.alias))))continue;
        const relation=relations[0]!,nameEvidence=located(declaration.source,name);
        if(!nameEvidence.length)continue;
        const contextAnchorIds=unique([...declaration.anchors,...relation.anchors].map(anchor=>anchor.anchor_id));
        const candidate:Candidate={rawValue:name,normalizedValue:name,displayValue:name,
          anchorIds:nameEvidence.map(anchor=>anchor.anchor_id),pageNumbers:[declaration.source.page.page.page_number],
          contextText:declaration.quote,contextAnchorIds,
          evidenceSegments:[{rawValue:name,contextText:declaration.quote,anchorIds:nameEvidence.map(anchor=>anchor.anchor_id),
            contextAnchorIds,pageNumbers:[declaration.source.page.page.page_number]}],
          roleEvidence:{version,association:'candidate',role:definition.objectRole,definedTerm:term,logicalDocumentId:material.id,
            declaration:roleSource(declaration.quote,declaration.anchors),relation:roleSource(relation.quote,relation.anchors)}};
        const candidateId=`local-role-${sha256(JSON.stringify([field.fieldId,field.documentVersionId,field.parseRevision,candidate])).slice(0,32)}`;
        const decisionAnchors=unique([...candidate.anchorIds,...contextAnchorIds]);
        field.candidates.push(candidate);
        field.status='uncertain';field.rawValue=field.candidates.length===1?name:null;field.normalizedValue=field.candidates.length===1?name:null;
        field.anchorIds=unique([...field.anchorIds,...candidate.anchorIds]);
        field.pageNumbers=unique([...field.pageNumbers,...candidate.pageNumbers]);
        field.semanticFilter={...field.semanticFilter,originalCandidates:[...field.semanticFilter.originalCandidates,{...candidate,candidateId}],
          decisions:[...field.semanticFilter.decisions,{candidateId,decision:'selected',anchorIds:decisionAnchors,
            pageNumbers:unique([...candidate.pageNumbers,...candidate.roleEvidence!.relation.pageNumbers])}],
          reasonCodes:unique([...field.semanticFilter.reasonCodes,'private_explicit_role_candidate'])};
        field.coverageGaps=unique([...field.coverageGaps,'entity_candidate_requires_confirmation','private_explicit_role_candidate']);
        newAnchors.push(...nameEvidence,...declaration.anchors,...relation.anchors);
      }
    }
  }
  return {fields,anchors:[...new Map([...input.anchors,...newAnchors].map(anchor=>[anchor.anchor_id,anchor])).values()]};
}
