import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import type {DocumentRegion} from '@hsbc/contracts/evidence';
import {sha256} from '../../document/evidence.js';
import {validatePolygon} from '../../document/geometry.js';
import type {LocatedRoleEvidence} from './field-role-evidence.js';

const compact=(s:string)=>s.replace(/\s+/gu,' ').trim();
const same=(a:string,b:string)=>compact(a)===compact(b);
const name=(s:string)=>s.length>=2&&s.length<=300&&/^[\p{L}\p{N} &'’().,/-]+$/u.test(s)&&!/[;:]|\b(?:not|unless|if|agent|acting|former)\b/iu.test(s);
const facility=/^(?:\d+\.\s*)?(?:FACILIT(?:Y|IES)\.\s*)?(.{2,300}?) has offered (.{2,300}?)(?:, the Company['’]s wholly owned subsidiary,)? (?:Banking|Credit|Loan) Facilities under (?:the |a )?Facility (?:Offer )?Letter\b/u;
const authorization=/^(?:\d+\.\s*)?AUTHORI[ZS]ED SIGNATOR(?:Y|IES)\.\s+(.{2,600}?) (?:is|are) authori[sz]ed to (?:sign|execute) the Guarantee\b/iu;
function parties(text:string){
  const match=facility.exec(compact(text));
  return match&&name(match[1]!)&&name(match[2]!)?{lender:match[1]!,borrower:match[2]!}:undefined;
}
function signers(text:string){
  const match=authorization.exec(compact(text));if(!match)return[];
  const names=match[1]!.split(/\s+and\s+|,\s*/u);
  return names.length<=20&&names.every(name)&&new Set(names).size===names.length?names:[];
}
function available(page:DocumentPageArtifact,r:DocumentRegion){
  try{for(const polygon of r.polygons)validatePolygon(polygon,page.page.width,page.page.height);}catch{return false;}
  return r.kind==='text'&&r.processing_status==='ready'&&!!r.raw_text&&r.raw_text_sha256===sha256(r.raw_text)&&r.polygons.length>0&&
    r.document_version_id===page.scope.documentVersionId&&r.parse_revision===page.scope.parseRevision&&r.page_asset_id===page.page.page_asset_id&&
    (r.source!=='native_pdf'||page.nativeTrust==='validated_geometry_and_visibility');
}

/** A proposed literal name can be supported by a resolution's affirmative
 * narrative, not only by a form label. Never supplies names or repairs quotes.
 * The caller still validates material classification, placeholders, exact
 * occurrences and value anchors. Supporting clauses remain separate anchors. */
export function resolutionRoleEvidence(page:DocumentPageArtifact,value:string,context:string,definition:ReviewFieldDefinition):LocatedRoleEvidence|undefined {
  if(definition.recipe.version!=='azure-grounded-fields-v2'||definition.valueKind!=='party_name'||!definition.taxonomyIds?.includes('cgt_resolution')||
    !['cgt_field_24','cgt_field_26','cgt_field_27','cgt_field_29'].includes(definition.id)||page.status==='failed'||
    page.page.document_version_id!==page.scope.documentVersionId||page.page.parse_revision!==page.scope.parseRevision||page.page.source_sha256!==page.scope.sourceSha256)return;
  // A specimen column establishes a sample location, not authority to sign.
  // Keep explicitly labelled authorised-signatory tables on the existing path.
  if(definition.id==='cgt_field_29'&&/specimen|签字样式|簽字式樣|签字样本|簽字樣本/iu.test(context)&&
    /<table[\s>]/iu.test(context)&&!definition.roleEvidence?.labels.some(label=>compact(context).toLowerCase().includes(compact(label).toLowerCase())))
    return {state:'unsupported',regions:[]};
  const regions=page.regions.filter(r=>page.canonicalRegionIds.includes(r.region_id)&&available(page,r));
  const occurrences=regions.filter(r=>r.raw_text!.includes(value)&&(r.raw_text!.includes(context)||context.includes(r.raw_text!)));
  if(!occurrences.length)return;
  const supported=(proof:DocumentRegion[]):LocatedRoleEvidence=>({state:'supported',regions:[...new Map(proof.map(r=>[r.region_id,r])).values()]});
  if(['cgt_field_26','cgt_field_27'].includes(definition.id)){
    const proofs=occurrences.filter(r=>{const p=parties(r.raw_text!);return p&&same(value,definition.id==='cgt_field_26'?p.lender:p.borrower);});
    if(proofs.length)return supported(proofs);
  }
  if(definition.id==='cgt_field_29'){
    const proofs=occurrences.filter(r=>signers(r.raw_text!).some(n=>same(n,value)));
    if(proofs.length)return supported(proofs);
  }
  if(definition.id==='cgt_field_24'){
    const declarations=regions.flatMap(r=>{const m=/^(.{2,300}?)\s+\(the Company\)$/u.exec(compact(r.raw_text!));return m&&name(m[1]!)?[{r,name:m[1]!}]:[];});
    if(!declarations.length||new Set(declarations.map(d=>d.name)).size!==1||!same(declarations[0]!.name,value)||!declarations.some(d=>occurrences.includes(d.r)))return;
    const approvals=regions.filter(r=>/^(?:\d+\.\s*)?APPROVAL\. (?:Having reviewed [^.;]{1,300}, )?the directors (?:unanimously )?approved the Guarantee\b[^.]{0,400}\bexecution, delivery and performance\b/u.test(compact(r.raw_text!)));
    const representatives=regions.filter(r=>signers(r.raw_text!).length&&/\bas the Company['’]s (?:two |three |\d+ )?directors\b/u.test(compact(r.raw_text!)));
    if(approvals.length&&representatives.length)return supported([...declarations.map(d=>d.r),...approvals,...representatives]);
  }
}
