import type {DocumentRegion,PageAsset} from '@hsbc/contracts/evidence';
import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import {compareRegionSources,sha256} from './evidence.js';

export const SOURCE_TEXT_ENGINE_VERSION='p2-document-engine-4';
type Assembly=NonNullable<DocumentPageArtifact['sourceTextAssembly']>;
type Box=[number,number,number,number];
const unique=<T>(items:T[])=>[...new Set(items)];
const normalized=(text:string)=>text.normalize('NFKC').replace(/\s+/gu,' ').trim();
function bounds(region:DocumentRegion):Box|undefined {
  if(region.processing_status!=='ready'||!region.raw_text||region.raw_text_sha256!==sha256(region.raw_text)||region.polygons.length!==1)return;
  const points=region.polygons[0]!,box:Box=[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
  return box.every(Number.isFinite)&&box[2]>box[0]&&box[3]>box[1]?box:undefined;
}
function covered(inner:DocumentRegion,outer:DocumentRegion){
  const a=bounds(inner),b=bounds(outer);if(!a||!b)return false;
  return Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]))/((a[2]-a[0])*(a[3]-a[1]))>0.8;
}
function sameScope(a:DocumentRegion,b:DocumentRegion){
  return a.document_version_id===b.document_version_id&&a.parse_revision===b.parse_revision&&a.page_asset_id===b.page_asset_id;
}
function isWord(region:DocumentRegion){return region.source==='pp_ocr'&&/^line:\d+:word:\d+$/u.test(region.source_id);}
/** Parentage is owned by the deployed PP adapter, including its producer/config
 * prefix. A matching word on another line, page or producer is not a parent. */
function parentOf(word:DocumentRegion,byId:Map<string,DocumentRegion>){
  if(!isWord(word)||!word.region_id.includes(':pp:')||!word.region_id.endsWith(`:${word.source_id}`))return;
  const parent=byId.get(word.region_id.replace(/:word:\d+$/u,''));
  return parent?.source==='pp_ocr'&&parent.kind==='text'&&parent.source_id===word.source_id.replace(/:word:\d+$/u,'')&&sameScope(word,parent)?parent:undefined;
}
function isParentEvidence(word:DocumentRegion,parent:DocumentRegion){
  // The deployed adapter also emits space/punctuation units. Their parent and
  // geometry prove membership in exactly the same way as a visible word.
  return Boolean(word.raw_text&&parent.raw_text?.includes(word.raw_text)&&covered(word,parent));
}
function represents(parent:DocumentRegion,body:DocumentRegion){
  return sameScope(parent,body)&&Boolean(bounds(parent)&&bounds(body))&&(
    parent.region_id===body.region_id||compareRegionSources(parent,body)==='duplicate'||
    body.source==='vl_ocr'&&Boolean(parent.raw_text&&body.raw_text?.includes(parent.raw_text))&&covered(parent,body));
}

/** Called only while creating engine-4 pages. Never mutate a source region, its
 * text/hash, coordinates, anchors, duplicate ledger or an old page artifact. */
export function assembleSourceText(page:PageAsset,regions:DocumentRegion[],canonicalIds:string[],duplicates:DocumentPageArtifact['duplicates']){
  const byId=new Map(regions.map(r=>[r.region_id,r]));
  if(byId.size!==regions.length||canonicalIds.some(id=>!byId.has(id))||regions.some(r=>r.document_version_id!==page.document_version_id||r.parse_revision!==page.parse_revision||r.page_asset_id!==page.page_asset_id))throw new Error('p2_source_assembly_scope_invalid');
  const body=new Set(canonicalIds),represented=new Map<string,string>();
  const uncertain=new Set<string>(),withheld=new Set<string>(),gaps=new Set<string>();
  const wordRepresentations:Assembly['wordRepresentations']=[];
  const layout=regions.filter(r=>r.source==='vl_ocr'&&body.has(r.region_id)&&bounds(r));
  // Preserve the existing full-line-to-layout reduction, but remember which
  // retained source represents the complete parent line. Words are handled below.
  for(const r of regions){
    if(!body.has(r.region_id)||r.source!=='pp_ocr'||isWord(r)||!bounds(r))continue;
    const owners=layout.filter(o=>r.raw_text&&o.raw_text?.includes(r.raw_text)&&covered(r,o));
    if(owners.length===1){body.delete(r.region_id);represented.set(r.region_id,owners[0]!.region_id);}
    else if(owners.length>1){uncertain.add(r.region_id);gaps.add('source_text_conflict');}
  }
  const duplicateParents=new Map(duplicates.map(d=>[d.duplicate_region_id,d.canonical_region_id]));
  const representation=(parent:DocumentRegion):DocumentRegion|undefined=>{
    let current=parent;const visited=new Set<string>();
    while(!body.has(current.region_id)){
      if(visited.has(current.region_id))return;visited.add(current.region_id);
      const nextId=represented.get(current.region_id)??duplicateParents.get(current.region_id),next=nextId?byId.get(nextId):undefined;
      if(!next||!represents(current,next))return;current=next;
    }
    return represents(parent,current)?current:undefined;
  };
  for(const word of regions.filter(r=>isWord(r)&&body.has(r.region_id))){
    const parent=parentOf(word,byId),owner=parent&&isParentEvidence(word,parent)?representation(parent):undefined;
    if(parent&&owner){
      body.delete(word.region_id);
      wordRepresentations.push({wordRegionId:word.region_id,parentLineRegionId:parent.region_id,bodyRegionId:owner.region_id});
      // A conflicting layout remains an alternative source, not a silently
      // corrected transcript. Its uncertainty must survive extraction coverage.
      const alternatives=layout.filter(o=>covered(parent,o)&&!normalized(o.raw_text!).includes(normalized(parent.raw_text!)));
      if(alternatives.length){uncertain.add(parent.region_id);alternatives.forEach(o=>uncertain.add(o.region_id));gaps.add('source_text_conflict');}
      continue;
    }
    uncertain.add(word.region_id);gaps.add('source_word_parent_unverified');
    // Keep genuinely word-only text. An unverified fragment over a retained
    // line/block is quarantined from body concatenation, but stays in raw evidence.
    if(regions.some(r=>r!==word&&body.has(r.region_id)&&!isWord(r)&&covered(word,r))){body.delete(word.region_id);withheld.add(word.region_id);}
  }
  const sourceTextAssembly:Assembly={version:'line-word-source-v1',wordRepresentations,uncertainRegionIds:[...uncertain],withheldWordRegionIds:[...withheld]};
  return {canonicalRegionIds:[...body],sourceTextAssembly,coverageGaps:[...gaps]};
}

/** Audit links may only refer to this immutable page and an actually retained
 * body region. Old pages are read as stored; they are never silently reassembled. */
export function assertSourceTextAssembly(page:DocumentPageArtifact){
  const a=page.sourceTextAssembly;
  if(!a){if(page.processing.engineVersion===SOURCE_TEXT_ENGINE_VERSION)throw new Error('p2_source_assembly_missing');return;}
  const fail=()=>{throw new Error('p2_source_assembly_invalid');};
  if(a.version!=='line-word-source-v1'||page.processing.engineVersion!==SOURCE_TEXT_ENGINE_VERSION)fail();
  const byId=new Map(page.regions.map(r=>[r.region_id,r])),body=new Set(page.canonicalRegionIds);
  if(byId.size!==page.regions.length||page.regions.some(r=>r.document_version_id!==page.page.document_version_id||r.parse_revision!==page.page.parse_revision||r.page_asset_id!==page.page.page_asset_id)||page.canonicalRegionIds.some(id=>!byId.has(id)))fail();
  if(unique(a.wordRepresentations.map(r=>r.wordRegionId)).length!==a.wordRepresentations.length||unique(a.uncertainRegionIds).length!==a.uncertainRegionIds.length||unique(a.withheldWordRegionIds).length!==a.withheldWordRegionIds.length)fail();
  for(const link of a.wordRepresentations){
    const word=byId.get(link.wordRegionId),parent=byId.get(link.parentLineRegionId),owner=byId.get(link.bodyRegionId);
    if(!word||!parent||!owner||parentOf(word,byId)!==parent||!isParentEvidence(word,parent)||!represents(parent,owner)||body.has(word.region_id)||!body.has(owner.region_id))fail();
  }
  if(a.uncertainRegionIds.some(id=>!byId.has(id))||a.withheldWordRegionIds.some(id=>!a.uncertainRegionIds.includes(id)||!byId.get(id)||!isWord(byId.get(id)!)||body.has(id)))fail();
  if(a.uncertainRegionIds.length&&(!page.coverageGaps.some(g=>g==='source_text_conflict'||g==='source_word_parent_unverified')||page.status==='ready'))fail();
}
