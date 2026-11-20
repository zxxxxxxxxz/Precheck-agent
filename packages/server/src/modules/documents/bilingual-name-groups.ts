import type {DocumentFieldObservation, DocumentPageArtifact, DocumentBundle} from '@hsbc/contracts/documents';
import type {EvidenceAnchor, DocumentRegion} from '@hsbc/contracts/evidence';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import {anchorsForText, sha256, validateAnchorSource} from '../../document/evidence.js';
import {documentHtmlCellSpans} from '../../document/html-cells.js';
import {companyRegistrationEvidence} from '../company-identity/source-registrations.js';
import {associateCompanySigningRecords} from '../company-identity/normalization.js';
import {companyNameCellEvidence} from '../company-identity/source-cells.js';

export const BILINGUAL_NAME_VERSION = 'source-bilingual-name-v1';
const missingEvidence = 'bilingual_name_evidence_insufficient';
type Candidate = DocumentFieldObservation['candidates'][number];
type Definition = ReviewConfigManifest['fields'][number];
export interface BilingualNameInput {
  fields: DocumentFieldObservation[]; definitions: Definition[]; pages: DocumentPageArtifact[];
  logicalDocuments: DocumentBundle['logicalDocuments']; anchors: EvidenceAnchor[];
}
type Source = {region: DocumentRegion; start: number; end: number};
type RecordProof = {names: [string, string]; page: DocumentPageArtifact; sources: Source[]; anchors: EvidenceAnchor[]};
const unique = <T>(items: T[]) => [...new Set(items)];
// Preserve word boundaries, spelling, punctuation and case; this is not fuzzy identity matching.
const textKey = (text: string) => text.normalize('NFC').trim().replace(/\s+/gu, ' ');
const language = (text: string) => /\p{Script=Han}/u.test(text) ? /[A-Za-z]/u.test(text) ? null : 'zh' : /[A-Za-z]/u.test(text) ? 'en' : null;
const organization = (text: string) => /\b(?:limited|ltd\.?|inc\.?|corporation|llc|plc|bank|company)\b|公司|银行|銀行/iu.test(text);
const branch = (text: string) => /\bbranch\b|分行|支行|分公司/iu.test(text.normalize('NFKC'));
const bounds = (region: DocumentRegion) => {
  const points = region.polygons[0]!;
  return {l: Math.min(...points.map(p => p[0])), t: Math.min(...points.map(p => p[1])), r: Math.max(...points.map(p => p[0])), b: Math.max(...points.map(p => p[1]))};
};
function overlaps(a: DocumentRegion, b: DocumentRegion) {
  const x = bounds(a), y = bounds(b), area = (r: typeof x) => (r.r-r.l)*(r.b-r.t);
  return Math.max(0, Math.min(x.r,y.r)-Math.max(x.l,y.l))*Math.max(0, Math.min(x.b,y.b)-Math.max(x.t,y.t)) / Math.min(area(x),area(y)) >= .8;
}
function validRegion(page: DocumentPageArtifact, region: DocumentRegion) {
  return page.status !== 'failed' && page.page.document_version_id === page.scope.documentVersionId && page.page.parse_revision === page.scope.parseRevision &&
    page.page.source_sha256 === page.scope.sourceSha256 && region.document_version_id === page.scope.documentVersionId && region.parse_revision === page.scope.parseRevision &&
    region.page_asset_id === page.page.page_asset_id && region.processing_status === 'ready' && !!region.raw_text && region.raw_text_sha256 === sha256(region.raw_text) &&
    region.polygons.length === 1 && region.polygons[0]!.length >= 3 && region.polygons[0]!.every(([x,y]) => Number.isFinite(x) && Number.isFinite(y) && x>=0 && y>=0 && x<=page.page.width && y<=page.page.height) &&
    bounds(region).r>bounds(region).l && bounds(region).b>bounds(region).t && !page.conflicts.some(conflict => conflict.region_ids.includes(region.region_id));
}
function isPair(text: string, names: [string,string]) {
  const value = textKey(text.replace(/<br\s*\/?>/giu, ' '));
  return [names, [names[1],names[0]]].some(([a,b]) => [' ', ' / ', '/', '／', '\n'].some(separator => value === textKey(a+separator+b)) ||
    value === textKey(`${a} (${b})`) || value === textKey(`${a}（${b}）`));
}
// A singular, explicit name field is a bounded record. Free prose or a shared paragraph is not.
function nameValue(text: string) {
  return /^(?:Name(?:\s*\(in Block Letters\))?(?:\s+of\s+[A-Za-z ]{1,60})?|(?:中文|英文)?(?:姓名|名称|名稱))\s*[:：]\s*([^\r\n]+)$/iu.exec(text.trim())?.[1];
}
function hasConflictingRegistrationNumbers(candidates: Candidate[]) {
  const values=new Map<string,Set<string>>();
  for(const candidate of candidates)for(const match of (candidate.contextText??'').matchAll(/\b(LEI|RA\d{6}|(?:Company|Business)\s+(?:Registration\s+)?(?:Number|No\.?)|(?:BRN\s*\/\s*)?UBI|BRN)\s*[:/]\s*([A-Z0-9][A-Z0-9.-]{3,79})\b/giu)) {
    const label=match[1]!.toUpperCase().replace(/\s+/gu,' '),key=label==='LEI'||/^RA\d{6}$/u.test(label)?label:'registration';
    const existing=values.get(key)??new Set<string>();existing.add(match[2]!);values.set(key,existing);
  }
  // This is a conservative conflict veto, never positive identity evidence.
  return [...values.values()].some(numbers=>numbers.size>1);
}
function recordsFor(page: DocumentPageArtifact, candidates: Candidate[], kinds: Definition['partyKinds']): RecordProof[] {
  const names = unique(candidates.map(c => c.rawValue).filter(n => n.length>=2 && n.length<=300 && language(n)));
  const pairs: [string,string][] = names.filter(n => language(n)==='en').flatMap(en => names.filter(n => language(n)==='zh').map(zh => [en,zh] as [string,string]))
    .filter(pair => organization(pair[0])===organization(pair[1]) && branch(pair[0])===branch(pair[1]) &&
      (pair.some(organization) ? kinds?.includes('organization') : kinds?.length===1));
  const regions = page.regions.filter(region => validRegion(page,region));
  const records: RecordProof[] = [];
  for (const region of regions.filter(r => page.canonicalRegionIds.includes(r.region_id))) {
    if (region.kind==='table' && region.source==='vl_ocr') {
      // Reuse the company cell proof, omitting the combined spelling only from
      // proof discovery. Every original candidate must still own its sources.
      const companyProof=companyNameCellEvidence(candidates.filter(c=>language(c.rawValue)),[page]);
      for (const span of documentHtmlCellSpans(region.raw_text!)) {
        const content=region.raw_text!.slice(span.start,span.end);
        const matches=pairs.filter(pair=>kinds?.length===1 && kinds[0]==='person'
          ? !!nameValue(content.replace(/<br\s*\/?>/giu,' ')) && isPair(nameValue(content.replace(/<br\s*\/?>/giu,' '))!,pair)
          : isPair(content,pair) && companyProof.pairs.some(proof=>pair.every(name=>proof.names.includes(name))));
        if(matches.length!==1)continue;
        const anchors=anchorsForText(page.page,[region],content).filter(a=>a.text_span_refs.some(ref=>ref.offset===[...region.raw_text!.slice(0,span.start)].length));
        if(anchors.length)records.push({names:matches[0]!,page,sources:[{region,start:[...region.raw_text!.slice(0,span.start)].length,end:[...region.raw_text!.slice(0,span.end)].length}],anchors});
      }
    } else if(region.kind==='text' && region.raw_text!.length<=1000) {
      const value=nameValue(region.raw_text!);if(!value)continue;
      const matches=pairs.filter(pair=>isPair(value,pair));if(matches.length!==1)continue;
      const pair=matches[0]!;
      // Text rows require independent literal agreement at the same source location.
      // Geometry alone is never a bilingual relationship or an identity proof.
      const support=regions.filter(other=>other.kind==='text' && other.source!==region.source && overlaps(region,other) &&
        (pair.some(name=>textKey(other.raw_text!)===textKey(name)) || isPair(nameValue(other.raw_text!)??other.raw_text!,pair)));
      if(!pair.every(name=>support.some(other=>other.raw_text!.includes(name))))continue;
      const sources=[region,...support].map(r=>({region:r,start:0,end:[...r.raw_text!].length}));
      records.push({names:pair,page,sources,anchors:anchorsForText(page.page,[region],region.raw_text!)});
    }
  }
  return records;
}
function candidateOwnsRecord(candidate: Candidate, anchor: EvidenceAnchor, record: RecordProof) {
  if(anchor.document_version_id!==record.page.scope.documentVersionId || anchor.parse_revision!==record.page.scope.parseRevision || anchor.page_asset_id!==record.page.page.page_asset_id || anchor.page_number!==record.page.page.page_number || !anchor.text_span_refs.length || !anchor.block_ids.length || !anchor.polygons.length || !['exact','block_only'].includes(anchor.localization_status))return false;
  try {validateAnchorSource(anchor,record.page.page,record.page.regions);}catch{return false;}
  const allowed=record.names.filter(name=>textKey(candidate.rawValue)===textKey(name));
  if(!allowed.length && !isPair(candidate.rawValue,record.names))return false;
  return anchor.block_ids.every(id=>anchor.text_span_refs.some(span=>span.block_id===id)) && anchor.text_span_refs.every(span=>{
    const source=record.sources.find(s=>s.region.region_id===span.block_id && span.offset>=s.start && span.offset+span.length<=s.end);
    if(!source)return false;
    const quote=[...source.region.raw_text!].slice(span.offset,span.offset+span.length).join('');
    return allowed.length ? allowed.some(name=>textKey(quote)===textKey(name)) : record.names.some(name=>textKey(quote)===textKey(name)) || isPair(quote,record.names);
  });
}

/** Source-backed annotation shared by new extraction and read-only historical views.
 * Never changes candidate identity, values, decisions, warnings, or adoption commands. */
export function associateBilingualNames(input: BilingualNameInput) {
  const anchors=new Map(input.anchors.map(a=>[a.anchor_id,a])), extra=new Map<string,EvidenceAnchor>();
  const fields=input.fields.map(field=>{
    const definition=input.definitions.find(d=>d.id===field.fieldId);
    const candidates=field.candidates.map(c=>{if(c.nameAssociation?.version!==BILINGUAL_NAME_VERSION)return c;const copy={...c};delete copy.nameAssociation;return copy;});
    const clean={...field,candidates,coverageGaps:field.coverageGaps.filter(gap=>gap!==missingEvidence)};
    if(definition?.valueKind!=='party_name' || definition.valueMultiplicity!=='entities' || definition.recipe.mode==='manual' || !definition.partyKinds?.length ||
      field.candidates.length<2 || field.candidates.length>64 || field.semanticFilter?.state!=='completed')return clean;
    let output=[...candidates];
    for(const material of input.logicalDocuments.filter(m=>m.labelId && definition.taxonomyIds?.includes(m.labelId) && ['candidate','confirmed'].includes(m.status))) {
      if(material.pageNumbers.some(n=>input.logicalDocuments.some(m=>m.id!==material.id && m.pageNumbers.includes(n))))continue;
      const pages=input.pages.filter(p=>material.pageNumbers.includes(p.page.page_number) && p.scope.documentVersionId===field.documentVersionId && p.scope.parseRevision===field.parseRevision);
      if(!pages.length || new Set(pages.map(p=>p.scope.sourceSha256)).size!==1)continue;
      const records=pages.flatMap(page=>recordsFor(page,candidates,definition.partyKinds));
      const counterparts=new Map<string,Set<string>>();
      for(const record of records)for(const [name,other] of [record.names,[record.names[1],record.names[0]]]){
        const values=counterparts.get(textKey(name!))??new Set<string>();values.add(textKey(other!));counterparts.set(textKey(name!),values);
      }
      const pairs=new Map<string,RecordProof[]>();
      for(const record of records){if(record.names.some(name=>counterparts.get(textKey(name))?.size!==1))continue;
        const key=JSON.stringify(record.names.map(textKey));pairs.set(key,[...(pairs.get(key)??[]),record]);}
      for(const proofs of pairs.values()) {
        const names=proofs[0]!.names;
        const indices=candidates.flatMap((candidate,index)=>{
          if(!candidate.anchorIds.length || !candidate.pageNumbers.length || !candidate.pageNumbers.every(n=>material.pageNumbers.includes(n)))return [];
          const sources=candidate.anchorIds.map(id=>anchors.get(id));
          return sources.every(a=>a && proofs.some(record=>candidateOwnsRecord(candidate,a,record))) && candidate.pageNumbers.every(n=>sources.some(a=>a?.page_number===n)) ? [index] : [];
        });
        if(indices.length<2)continue;
        // Separate occurrences are connected only through a candidate that itself cites both.
        const components: number[][]=[];
        for(const index of indices){const own=candidates[index]!.anchorIds.map(id=>anchors.get(id)!);
          const touched=components.filter(group=>group.some(other=>candidates[other]!.anchorIds.some(id=>proofs.some(record=>candidateOwnsRecord(candidates[other]!,anchors.get(id)!,record) && own.some(a=>candidateOwnsRecord(candidates[index]!,a,record))))));
          const merged=unique([index,...touched.flat()]);for(const old of touched)components.splice(components.indexOf(old),1);components.push(merged);}
        for(const indices of components.filter(group=>group.length>=2)) {
          // Existing independent associations may carry a conflicting alias.
          // Never overwrite that evidence to make a newer group appear certain.
          if(indices.some(index=>candidates[index]!.nameAssociation?.names.some(name=>!names.some(n=>textKey(n)===textKey(name)))))continue;
          const used=proofs.filter(record=>indices.some(index=>candidates[index]!.anchorIds.some(id=>candidateOwnsRecord(candidates[index]!,anchors.get(id)!,record))));
          const locatedAnchors=new Map<string,EvidenceAnchor>();
          const sourceNames=names.map(name=>{const located=used.flatMap(record=>record.sources.flatMap(source=>anchorsForText(record.page.page,[source.region],name).filter(a=>a.text_span_refs.every(span=>span.offset>=source.start && span.offset+span.length<=source.end))));
            for(const a of located)locatedAnchors.set(a.anchor_id,a);return {name,anchorIds:unique(located.map(a=>a.anchor_id)),pageNumbers:unique(located.map(a=>a.page_number)).sort((a,b)=>a-b)};});
          if(sourceNames.some(source=>!source.anchorIds.length))continue;
          const evidenceAnchorIds=unique([...used.flatMap(record=>record.anchors.map(a=>a.anchor_id)),...sourceNames.flatMap(source=>source.anchorIds),...indices.flatMap(index=>candidates[index]!.anchorIds)]).sort();
          // Organization-specific registration and branch guards are not applied to people.
          if(names.some(organization) || definition.partyKinds.length===1 && definition.partyKinds[0]==='organization'){
            if(hasConflictingRegistrationNumbers(indices.map(index=>candidates[index]!)))continue;
            const registration=companyRegistrationEvidence(candidates,pages);
            const checked=associateCompanySigningRecords(candidates,[{names,candidateIndexes:indices,sourceNames,evidenceAnchorIds,materialPageNumbers:material.pageNumbers}],registration.identifiers);
            if(indices.some(index=>!checked[index]!.nameAssociation || checked[index]!.nameAssociation===candidates[index]!.nameAssociation))continue;
          }
          const groupId=`bilingual:${sha256(JSON.stringify({document:field.documentVersionId,parse:field.parseRevision,field:field.fieldId,object:field.objectId,role:definition.objectRole,kind:definition.partyKinds,material:material.id,names,sourceNames,evidenceAnchorIds}))}`;
          for(const index of indices)output[index]={...candidates[index]!,nameAssociation:{version:BILINGUAL_NAME_VERSION,groupId,basis:'source_bilingual_pair',names:[...names],sourceNames,evidenceAnchorIds,identityConfirmed:false}};
          for(const a of locatedAnchors.values())extra.set(a.anchor_id,a);
          for(const record of used)for(const a of record.anchors)extra.set(a.anchor_id,a);
        }
      }
    }
    // A recognizable combined spelling is only a reason to explain a missing
    // grouping proof; substring matching never authorizes an association.
    const en=candidates.filter(c=>language(c.rawValue)==='en'),zh=candidates.filter(c=>language(c.rawValue)==='zh');
    const unresolved=output.some(c=>!c.nameAssociation && en.some(a=>zh.some(b=>isPair(c.rawValue,[a.rawValue,b.rawValue]))));
    return {...clean,candidates:output,coverageGaps:unresolved?[...clean.coverageGaps,missingEvidence]:clean.coverageGaps};
  });
  return {fields,anchors:[...new Map([...input.anchors,...extra.values()].map(a=>[a.anchor_id,a])).values()]};
}
