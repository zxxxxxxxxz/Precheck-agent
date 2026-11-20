import {isDeepStrictEqual} from 'node:util';
import type {DocumentBundle,DocumentFieldObservation,DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {DocumentRegion,EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {anchorsForText,sha256,validateAnchorSource} from '../../document/evidence.js';
import {companyRegistrationEvidence} from './source-registrations.js';

type Candidate=DocumentFieldObservation['candidates'][number];
type Input={fields:DocumentFieldObservation[];definitions:ReviewFieldDefinition[];pages:DocumentPageArtifact[];
  logicalDocuments:DocumentBundle['logicalDocuments'];anchors:EvidenceAnchor[]};
type Proof={sourceCandidateIds:string[];disputedAnchorId:string;corroboratingAnchorIds:string[];pageNumbers:number[]};
const version='registered-header-ocr-consistency-v1';
const unique=<T>(values:T[])=>[...new Set(values)];
const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
const box=(r:DocumentRegion)=>{const p=r.polygons[0]!;return [Math.min(...p.map(p=>p[0])),Math.min(...p.map(p=>p[1])),
  Math.max(...p.map(p=>p[0])),Math.max(...p.map(p=>p[1]))] as const;};
const area=(b:ReturnType<typeof box>)=>(b[2]-b[0])*(b[3]-b[1]);
const inside=(a:DocumentRegion,b:DocumentRegion)=>{const x=box(a),y=box(b);return x[0]>=y[0]&&x[1]>=y[1]&&x[2]<=y[2]&&x[3]<=y[3];};
const overlap=(a:DocumentRegion,b:DocumentRegion)=>{const x=box(a),y=box(b);return Math.max(0,Math.min(x[2],y[2])-Math.max(x[0],y[0]))*
  Math.max(0,Math.min(x[3],y[3])-Math.max(x[1],y[1]))/Math.min(area(x),area(y));};
const valid=(p:DocumentPageArtifact,r:DocumentRegion)=>p.status!=='failed'&&p.scope.documentVersionId===p.page.document_version_id&&
  p.scope.parseRevision===p.page.parse_revision&&p.scope.sourceSha256===p.page.source_sha256&&r.document_version_id===p.scope.documentVersionId&&
  r.parse_revision===p.scope.parseRevision&&r.page_asset_id===p.page.page_asset_id&&r.kind==='text'&&r.processing_status==='ready'&&
  !!r.raw_text&&r.raw_text.length<=2000&&sha256(r.raw_text)===r.raw_text_sha256&&r.polygons.length===1&&
  r.polygons[0]!.length>=3&&r.polygons[0]!.every(([x,y])=>Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0&&x<=p.page.width&&y<=p.page.height)&&area(box(r))>0;
const conflicted=(p:DocumentPageArtifact,r:DocumentRegion)=>p.conflicts.some(c=>c.region_ids.includes(r.region_id));
function anchors(p:DocumentPageArtifact,r:DocumentRegion,text:string):EvidenceAnchor[] {
  try {const result=anchorsForText(p.page,[r],text);for(const a of result)validateAnchorSource(a,p.page,p.regions);return result;}
  catch{return [];}
}
function owns(c:Candidate,p:DocumentPageArtifact,r:DocumentRegion):EvidenceAnchor|undefined {
  if(c.pageNumbers.length!==1||c.pageNumbers[0]!==p.page.page_number||c.anchorIds.length!==1||
    c.evidenceSegments?.length!==1||c.evidenceSegments[0]!.rawValue!==c.rawValue)return;
  const found=anchors(p,r,c.rawValue);
  return found.length===1&&c.anchorIds[0]===found[0]!.anchor_id&&
    isDeepStrictEqual(c.evidenceSegments[0]!.anchorIds,c.anchorIds)?found[0]:undefined;
}
function independentName(name:string,pages:DocumentPageArtifact[],exceptPage:number):EvidenceAnchor[] {
  const proofs:EvidenceAnchor[][]=[];
  for(const page of pages.filter(p=>p.page.page_number!==exceptPage)){
    const regions=page.regions.filter(r=>valid(page,r)&&!conflicted(page,r)&&r.raw_text===name);
    for(const native of regions.filter(r=>r.source==='native_pdf'&&page.canonicalRegionIds.includes(r.region_id))){
      const vl=regions.filter(r=>r.source==='vl_ocr'&&page.canonicalRegionIds.includes(r.region_id)&&overlap(r,native)>=.65);
      const pp=regions.filter(r=>r.source==='pp_ocr'&&overlap(r,native)>=.65);
      if(vl.length!==1||pp.length!==1)continue;
      const proof=[native,vl[0]!,pp[0]!].flatMap(r=>anchors(page,r,name));
      if(proof.length===3)proofs.push(proof);
    }
  }
  return proofs.flat();
}

/** Reject a contradicted OCR reading, without inventing or replacing any name.
 * This is not fuzzy company matching: a full bilingual incorporation record,
 * exact registration identifier, the same located native name, and independent
 * native/VL/PP agreement on another page are all required. Original model
 * candidates and OCR remain immutable and available for review. */
export function rejectContradictedHeaderNames(input:Input){
  const added:EvidenceAnchor[]=[],entries:Array<{fieldId:string;logicalDocumentId:string;proofs:Proof[]}>=[];
  const fields=input.fields.map(field=>{
    const definition=input.definitions.find(d=>d.id===field.fieldId),filter=field.semanticFilter;
    if(definition?.valueKind!=='party_name'||definition.recipe.version!=='azure-grounded-fields-v2'||
      field.status==='not_applicable'||filter?.state!=='completed'||filter.version!=='azure-grounded-fields-v2')return field;
    const materials=input.logicalDocuments.filter(m=>m.labelId&&definition.taxonomyIds?.includes(m.labelId)&&
      ['candidate','confirmed'].includes(m.status));
    const removals=new Map<Candidate,Proof>(),decisions=filter.decisions.map(d=>({...d}));
    for(const material of materials){
      const materialProofs:Proof[]=[];
      if(input.logicalDocuments.some(m=>m!==material&&m.pageNumbers.some(n=>material.pageNumbers.includes(n))))continue;
      const pages=input.pages.filter(p=>material.pageNumbers.includes(p.page.page_number));
      if(pages.length!==material.pageNumbers.length||pages.some(p=>p.scope.documentVersionId!==field.documentVersionId||
        p.scope.parseRevision!==field.parseRevision||p.scope.sourceSha256!==pages[0]?.scope.sourceSha256))continue;
      const registrations=companyRegistrationEvidence(field.candidates,pages);
      const pairs=registrations.pairs.filter(p=>p.basis==='scoped_identifier'&&p.scopedIdentifier);
      for(const candidate of field.candidates){
        if(!/^[\p{Script=Han}（）()·\s]+$/u.test(candidate.rawValue)||candidate.rawValue.length>300||
          candidate.nameAssociation||candidate.roleEvidence||candidate.tablePartyEvidence||candidate.sourceCorrectionEvidence)continue;
        const matches:Array<{proof:Proof;anchors:EvidenceAnchor[]}>=[];
        for(const pair of pairs){
          const chinese=pair.names.filter(n=>/^[\p{Script=Han}（）()·\s]+$/u.test(n));
          const english=pair.names.filter(n=>!/\p{Script=Han}/u.test(n));
          if(chinese.length!==1||english.length!==1||candidate.rawValue===chinese[0])continue;
          const number=/^registration-jurisdiction:[A-Z]{2}:([A-Z0-9][A-Z0-9./-]{3,79})$/u.exec(pair.scopedIdentifier!)?.[1];
          if(!number)continue;
          // Both complete name/number pairs must be adjacent in this exact OCR
          // header. A bare number, a similar name or a country in prose is not proof.
          const header=new RegExp(`^\\s*${escape(english[0]!)}\\s*[([（]?\\s*Company\\s+(?:No\\.?|Number)\\s*[:：]?\\s*${escape(number)}\\s*[)\\]）]?\\s+${escape(candidate.rawValue)}\\s*[([（]?\\s*公司编号\\s*[:：]?\\s*${escape(number)}(?:\\s|[)\\]）]|$)`,'u');
          for(const page of pages.filter(p=>candidate.pageNumbers.includes(p.page.page_number))){
            const sources=page.regions.filter(r=>valid(page,r)&&r.source==='vl_ocr'&&page.canonicalRegionIds.includes(r.region_id)&&header.test(r.raw_text!));
            for(const source of sources){
              const disputed=owns(candidate,page,source);if(!disputed)continue;
              const natives=page.regions.filter(r=>valid(page,r)&&r.source==='native_pdf'&&r.raw_text===chinese[0]&&inside(r,source));
              if(natives.length!==1||!field.candidates.some(c=>c.rawValue===chinese[0]&&owns(c,page,natives[0]!)))continue;
              const corroboration=independentName(chinese[0]!,pages,page.page.page_number);
              if(!corroboration.length)continue;
              const selected=filter.originalCandidates.filter(prior=>{
                const {candidateId,...value}=prior;return isDeepStrictEqual(value,candidate)&&
                  filter.decisions.some(d=>d.candidateId===candidateId&&d.decision==='selected');
              });
              if(!selected.length)continue;
              const supporting=[...anchors(page,natives[0]!,chinese[0]!),...corroboration,...registrations.anchors.filter(a=>pair.evidenceAnchorIds.includes(a.anchor_id))];
              matches.push({proof:{sourceCandidateIds:selected.map(c=>c.candidateId),disputedAnchorId:disputed.anchor_id,
                corroboratingAnchorIds:unique(supporting.map(a=>a.anchor_id)),pageNumbers:unique([page.page.page_number,...corroboration.map(a=>a.page_number)])},
                anchors:[disputed,...supporting]});
            }
          }
        }
        if(matches.length!==1)continue;
        removals.set(candidate,matches[0]!.proof);materialProofs.push(matches[0]!.proof);added.push(...matches[0]!.anchors);
      }
      if(materialProofs.length)entries.push({fieldId:field.fieldId,logicalDocumentId:material.id,proofs:materialProofs});
    }
    if(!removals.size)return field;
    const rejected=new Set([...removals.values()].flatMap(p=>p.sourceCandidateIds));
    for(const decision of decisions)if(rejected.has(decision.candidateId))decision.decision='rejected';
    const candidates=field.candidates.filter(c=>!removals.has(c));
    return {...field,candidates,rawValue:candidates.length===1?candidates[0]!.rawValue:null,
      normalizedValue:candidates.length===1?candidates[0]!.normalizedValue:null,
      anchorIds:unique(candidates.flatMap(c=>c.anchorIds)),pageNumbers:unique(candidates.flatMap(c=>c.pageNumbers)),
      semanticFilter:{...filter,decisions,reasonCodes:unique([...filter.reasonCodes,'registered_header_ocr_reading_rejected'])}};
  });
  return {fields,anchors:[...new Map([...input.anchors,...added].map(a=>[a.anchor_id,a])).values()],receipt:{version,entries}};
}
