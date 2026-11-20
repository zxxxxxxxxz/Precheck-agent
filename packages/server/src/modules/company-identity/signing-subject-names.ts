import type {DocumentFieldObservation,DocumentPageArtifact,DocumentBundle} from '@hsbc/contracts/documents';
import type {EvidenceAnchor,DocumentRegion} from '@hsbc/contracts/evidence';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import {anchorsForText,sha256,validateAnchorSource} from '../../document/evidence.js';
import {companyRegistrationEvidence} from './source-registrations.js';
import {associateCompanySigningRecords,normalizeCompanyName,type CompanySigningRecord} from './normalization.js';

type DocumentLogicalDocument=DocumentBundle['logicalDocuments'][number];
type Candidate=DocumentFieldObservation['candidates'][number];
type Definition=ReviewConfigManifest['fields'][number];
const unique=<T>(xs:T[])=>[...new Set(xs)];
const fold=(text:string)=>text.normalize('NFC').toLowerCase().replace(/\s+/gu,'');
// This fold is confined to a conflicting OCR reading of the SAME located
// text. It is never used as a company identity key.
const locatedOcrFormat=(text:string)=>text.replace(/\s+/gu,'').replace(/（/gu,'(').replace(/）/gu,')');
const nameKey=(text:string)=>normalizeCompanyName(text).comparisonKey;
const candidateUsesNames=(raw:string,names:string[])=>names.some(name=>nameKey(name)===nameKey(raw))||[[names[0]!,names[1]!],[names[1]!,names[0]!]].some(pair=>[' ','/',' / ','／',' ／ '].some(separator=>nameKey(pair.join(separator))===nameKey(raw)));
const clean=(text:string)=>text.replace(/\\n|<br\s*\/?>/giu,'\n').trim();
const language=(text:string)=>/\p{Script=Han}/u.test(text)?(/[A-Za-z]/u.test(text)?null:'zh'):/[A-Za-z]/u.test(text)?'en':null;
const box=(region:DocumentRegion)=>{const p=region.polygons[0]!;return {x:Math.min(...p.map(p=>p[0])),y:Math.min(...p.map(p=>p[1])),r:Math.max(...p.map(p=>p[0])),b:Math.max(...p.map(p=>p[1]))};};
const area=(a:ReturnType<typeof box>)=>(a.r-a.x)*(a.b-a.y);
const intersection=(a:ReturnType<typeof box>,b:ReturnType<typeof box>)=>Math.max(0,Math.min(a.r,b.r)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.b,b.b)-Math.max(a.y,b.y));
const valid=(p:DocumentPageArtifact,r:DocumentRegion)=>p.status!=='failed'&&p.scope.documentVersionId===p.page.document_version_id&&p.scope.parseRevision===p.page.parse_revision&&p.scope.sourceSha256===p.page.source_sha256&&r.polygons.every(poly=>poly.length>=3&&poly.every(([x,y])=>Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0&&x<=p.page.width&&y<=p.page.height))&&r.kind==='text'&&r.raw_text!==null&&r.raw_text.length<=2000&&r.processing_status==='ready'&&r.polygons.length===1&&area(box(r))>0&&r.raw_text_sha256===sha256(r.raw_text)&&r.page_asset_id===p.page.page_asset_id&&r.document_version_id===p.scope.documentVersionId&&r.parse_revision===p.scope.parseRevision;
const conflicted=(p:DocumentPageArtifact,r:DocumentRegion)=>p.conflicts.some(conflict=>conflict.region_ids.includes(r.region_id));
const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
function roleLabels(definition:Definition){
 const en=definition.aliases.filter(alias=>/^[A-Za-z ]+$/u.test(alias)&&!alias.toLowerCase().endsWith('s')).map(alias=>new RegExp(`^(?:THE\\s+)?(?:ORIGINAL\\s+)?${escape(alias)}$`,'iu'));
 const zh=definition.aliases.filter(alias=>/^[\p{Script=Han}]+$/u.test(alias)).map(alias=>new RegExp(`^(?:初始|原始)?${escape(alias)}$`,'u'));
 return {en,zh};
}
function candidateAliases(candidates:Candidate[]){
 const singles=candidates.map(c=>c.rawValue.trim()).filter(name=>language(name)&&name.length<=300);
 const names=[...singles];
 for(const c of candidates){
  if(language(c.rawValue))continue;
  for(const known of singles.filter(name=>language(name)==='zh')){
   const at=c.rawValue.indexOf(known);if(at<0||c.rawValue.indexOf(known,at+known.length)>=0)continue;
   const before=c.rawValue.slice(0,at).trim(),after=c.rawValue.slice(at+known.length).trim();
   const other=before&&!after?before:after&&!before?after:'';
   if(other&&language(other)==='en'&&other.length<=300&&!/[\r\n;；]/u.test(other))names.push(other);
  }
 }
 return unique(names);
}
function exhausts(raw:string,names:string[]){
 let rest=clean(raw);for(const name of [...names].sort((a,b)=>b.length-a.length)){
  const wanted=fold(name),parts=[...rest],starts:number[]=[],ends:number[]=[];let flat='';
  let offset=0;for(const part of parts){const normalized=part.normalize('NFC').toLowerCase();if(!/\s/u.test(part)){for(const char of normalized){flat+=char;starts.push(offset);ends.push(offset+part.length);}}offset+=part.length;}
  const at=flat.indexOf(wanted);if(at>=0&&flat.indexOf(wanted,at+wanted.length)<0)rest=rest.slice(0,starts[at]!)+rest.slice(ends[at+wanted.length-1]!);
 }
 return /^[\s/／]*$/u.test(rest);
}
function sourceProof(page:DocumentPageArtifact,candidates:Candidate[],definition:Definition):{records:CompanySigningRecord[];anchors:EvidenceAnchor[]}{
 const structural=page.regions.filter(r=>valid(page,r));
 // A conflict is not dismissed: only an independently identical native/VL
 // pair can support names when every conflicting PP reading differs solely
 // in whitespace or corresponding parenthesis width. Original PP spellings
 // and conflicts remain untouched.
 const nameAgreement=(r:DocumentRegion)=>r.source==='native_pdf'&&conflicted(page,r)&&structural.some(other=>other.source==='vl_ocr'&&!conflicted(page,other)&&page.canonicalRegionIds.includes(other.region_id)&&other.raw_text===r.raw_text&&intersection(box(other),box(r))/Math.min(area(box(other)),area(box(r)))>=.65)&&page.conflicts.filter(c=>c.region_ids.includes(r.region_id)).every(c=>c.region_ids.length>=2&&c.region_ids.filter(id=>id!==r.region_id).every(id=>{const other=structural.find(candidate=>candidate.region_id===id);return other?.source==='pp_ocr'&&locatedOcrFormat(other.raw_text!)===locatedOcrFormat(r.raw_text!)&&intersection(box(other),box(r))/Math.min(area(box(other)),area(box(r)))>=.65;}));
 const regions=structural.filter(r=>!conflicted(page,r)),labels=roleLabels(definition),records:CompanySigningRecord[]=[],allAnchors:EvidenceAnchor[]=[];
 const headers=regions.filter(r=>clean(r.raw_text!).split(/\r?\n/u).some(line=>labels.en.some(re=>re.test(line.trim())))&&clean(r.raw_text!).split(/\r?\n/u).every(line=>labels.en.some(re=>re.test(line.trim()))||labels.zh.some(re=>re.test(line.trim()))));
 if(!headers.length)return {records,anchors:allAnchors};
 const h=headers[0]!,hb=box(h);
 if(headers.some(r=>Math.abs(box(r).y-hb.y)>page.page.height*.025||intersection(box(r),hb)/Math.min(area(box(r)),area(hb))<.5))return {records,anchors:allAnchors};
 const chinese=regions.filter(r=>clean(r.raw_text!).split(/\r?\n/u).some(line=>labels.zh.some(re=>re.test(line.trim())))&&clean(r.raw_text!).split(/\r?\n/u).every(line=>labels.en.some(re=>re.test(line.trim()))||labels.zh.some(re=>re.test(line.trim())))&&Math.abs(box(r).x-hb.x)<=page.page.width*.04&&box(r).y>=hb.y-page.page.height*.01&&box(r).b<=hb.b+page.page.height*.04);
 if(!chinese.length)return {records,anchors:allAnchors};
 const headerBottom=Math.max(...[...headers,...chinese].map(r=>box(r).b));
 const boundaryLabel=(r:DocumentRegion)=>/^(?:By(?:\s*签署)?|签署)\s*[:：]/iu.exec(clean(r.raw_text!))?.[0]??(/^By$/iu.test(clean(r.raw_text!))&&r.source==='pp_ocr'&&structural.some(parent=>parent.source===r.source&&r.source_id.startsWith(parent.source_id+':word:')&&/^By\s*签署(?:\s*[:：]|\s|$)/iu.test(clean(parent.raw_text!))&&intersection(box(r),box(parent))/area(box(r))>=.95)?clean(r.raw_text!):null);
 const boundaries=regions.filter(r=>boundaryLabel(r)&&box(r).y>headerBottom&&box(r).y-headerBottom<page.page.height*.3&&Math.abs(box(r).x-hb.x)<page.page.width*.08&&box(r).b-box(r).y<page.page.height*.08).sort((a,b)=>box(a).y-box(b).y);
 if(!boundaries.length)return {records,anchors:allAnchors};
 const end=box(boundaries[0]!).y;
 const within=(r:DocumentRegion)=>box(r).y>=headerBottom-page.page.height*.003&&box(r).b<=end&&Math.abs(box(r).x-hb.x)<page.page.width*.08;
 const agreedNames=structural.filter(r=>nameAgreement(r)&&within(r));
 const supportedConflictIds=new Set(agreedNames.flatMap(r=>page.conflicts.filter(c=>c.region_ids.includes(r.region_id)).flatMap(c=>c.region_ids)));
 regions.push(...agreedNames);
 const native=regions.filter(r=>r.source==='native_pdf'&&within(r));
 if(!native.length||native.some(r=>!page.canonicalRegionIds.includes(r.region_id)))return {records,anchors:allAnchors};
 const aliases=candidateAliases(candidates),located=aliases.map(name=>({name,regions:native.filter(r=>r.raw_text!.includes(name))})).filter(x=>x.regions.length);
 const byKey=new Map<string,typeof located[number]>();for(const item of located)if(!byKey.has(nameKey(item.name)))byKey.set(nameKey(item.name),item);
 const pair=[...byKey.values()];if(pair.length!==2||new Set(pair.map(item=>language(item.name))).size!==2)return {records,anchors:allAnchors};
 const names=pair.map(item=>item.name);
 // A complete subject record, not page proximity: every native text block
 // between the exact role heading and the next signing label is exhausted.
 if(native.some(r=>!exhausts(r.raw_text!,names)))return {records,anchors:allAnchors};
 const nameBounds=pair.flatMap(item=>item.regions.map(box)),top=Math.min(...nameBounds.map(b=>b.y)),bottom=Math.max(...nameBounds.map(b=>b.b));
 if(bottom-top>page.page.height*.07||top-headerBottom>page.page.height*.07||end-bottom>page.page.height*.15)return {records,anchors:allAnchors};
 const support:DocumentRegion[]=[];
 for(const item of pair){
  const ocr=regions.filter(r=>['vl_ocr','pp_ocr'].includes(r.source)&&within(r)&&fold(clean(r.raw_text!)).includes(fold(item.name))&&exhausts(r.raw_text!,names)&&item.regions.some(n=>intersection(box(n),box(r))/area(box(n))>=.65));
  if(!ocr.length)return {records,anchors:allAnchors};support.push(...ocr);
 }
 const columnRegions=structural.filter(r=>within(r)&&page.canonicalRegionIds.includes(r.region_id));
 if(columnRegions.some(r=>conflicted(page,r)&&!supportedConflictIds.has(r.region_id)||!exhausts(r.raw_text!,names)&&!(r.source==='pp_ocr'&&supportedConflictIds.has(r.region_id))&&!support.some(parent=>r.source===parent.source&&r.source_id.startsWith(parent.source_id+':word:')&&parent.raw_text!.includes(r.raw_text!)&&intersection(box(r),box(parent))/area(box(r))>=.95)))return {records,anchors:allAnchors};
 const inputAnchors=new Map(page.anchors.map(a=>[a.anchor_id,a]));
 const ownsAnchor=(candidate:Candidate,expected:EvidenceAnchor)=>{
  if(!candidate.anchorIds.includes(expected.anchor_id))return false;
  const old=inputAnchors.get(expected.anchor_id);if(!old)return true;
  if(!old.block_ids.length||old.document_version_id!==page.scope.documentVersionId||old.parse_revision!==page.scope.parseRevision||old.page_asset_id!==page.page.page_asset_id||old.page_number!==page.page.page_number||JSON.stringify(old.block_ids)!==JSON.stringify(expected.block_ids)||JSON.stringify(old.text_span_refs)!==JSON.stringify(expected.text_span_refs))return false;
  try{validateAnchorSource(old,page.page,page.regions);return true;}catch{return false;}
 };
 const supportedPp=structural.filter(r=>r.source==='pp_ocr'&&supportedConflictIds.has(r.region_id)&&within(r));
 const ppOccurrence=(candidate:Candidate)=>supportedPp.find(r=>{
  if(!names.some(name=>locatedOcrFormat(name)===locatedOcrFormat(candidate.rawValue)))return false;
  const at=r.raw_text!.indexOf(candidate.rawValue);if(at<0||r.raw_text!.indexOf(candidate.rawValue,at+candidate.rawValue.length)>=0)return false;
  return anchorsForText(page.page,[r],candidate.rawValue).some(a=>ownsAnchor(candidate,a));
 });
 const indexes=candidates.flatMap((candidate,index)=>{
  if(candidate.pageNumbers.length!==1||candidate.pageNumbers[0]!==page.page.page_number||!candidate.anchorIds.length)return [];
  // A formatting variant can join only through its own exact PP occurrence
  // in this already proved native/VL name row, never by spelling similarity.
  if(!candidateUsesNames(candidate.rawValue,names)&&!ppOccurrence(candidate))return [];
  return [index];
 });
 if(indexes.length<2)return {records,anchors:allAnchors};
 // Require the candidate's own quoted source occurrence to belong to this
 // bounded record; a matching spelling elsewhere cannot borrow the proof.

 // Candidate text anchors may be generated after page parsing. Rebuild IDs
 // from these exact native/OCR source slices instead of trusting a shared box.
 const sourceNames=pair.map(item=>{const anchors=item.regions.flatMap(r=>anchorsForText(page.page,[r],item.name));allAnchors.push(...anchors);return {name:item.name,anchorIds:unique(anchors.map(a=>a.anchor_id)),pageNumbers:[page.page.page_number]};});
 const ownsLiteral=(candidate:Candidate,text:string)=>[...native,...support].flatMap(r=>anchorsForText(page.page,[r],text)).some(expected=>ownsAnchor(candidate,expected));
 const hasOccurrence=(candidate:Candidate)=>Boolean(ppOccurrence(candidate))||ownsLiteral(candidate,candidate.rawValue)||
   (!names.some(name=>nameKey(name)===nameKey(candidate.rawValue))&&candidateUsesNames(candidate.rawValue,names)&&names.every(name=>ownsLiteral(candidate,name)));
 if(indexes.some(index=>!hasOccurrence(candidates[index]!)))return {records:[],anchors:[]};
 const headerAnchors=unique([...headers,...chinese]).flatMap(r=>anchorsForText(page.page,[r],r.raw_text!));
 const boundary=boundaries[0]!,label=boundaryLabel(boundary)!;
 const boundaryAnchors=anchorsForText(page.page,[boundary],label);
 if(!headerAnchors.length||!boundaryAnchors.length||sourceNames.some(name=>!name.anchorIds.length))return {records:[],anchors:[]};
 allAnchors.push(...indexes.flatMap(index=>{const pp=ppOccurrence(candidates[index]!);return pp?anchorsForText(page.page,[pp],candidates[index]!.rawValue):[];}),...headerAnchors,...boundaryAnchors,...support.flatMap(r=>anchorsForText(page.page,[r],r.raw_text!)));
 records.push({candidateIndexes:indexes,names:names as [string,string],sourceNames,evidenceAnchorIds:unique(allAnchors.map(a=>a.anchor_id)),materialPageNumbers:[page.page.page_number]});
 return {records,anchors:unique(allAnchors)};
}
export function associateSigningSubjectNames(input:{fields:DocumentFieldObservation[];definitions:Definition[];pages:DocumentPageArtifact[];logicalDocuments:DocumentLogicalDocument[];anchors:EvidenceAnchor[]}){
 const anchors=[...input.anchors],entries:Array<{fieldId:string;logicalDocumentId:string;groups:number;candidateCount:number}>=[];
 const fields=input.fields.map(field=>{
  const definition=input.definitions.find(d=>d.id===field.fieldId);if(!definition||definition.valueKind!=='party_name'||definition.recipe.version!=='azure-grounded-fields-v2')return field;
  let candidates=field.candidates.some(c=>c.nameAssociation?.version==='company-signing-subject-v1')?field.candidates.map(c=>{if(c.nameAssociation?.version!=='company-signing-subject-v1')return c;const copy={...c};delete copy.nameAssociation;return copy;}):field.candidates;
  for(const material of input.logicalDocuments.filter(m=>m.labelId&&definition.taxonomyIds?.includes(m.labelId)&&['candidate','confirmed'].includes(m.status))){
   const pages=input.pages.filter(page=>material.pageNumbers.includes(page.page.page_number));
   if(material.pageNumbers.some(number=>input.logicalDocuments.some(other=>other.id!==material.id&&other.pageNumbers.includes(number))))continue;
   const proofs=pages.map(page=>sourceProof(page,candidates,definition)),records=proofs.flatMap(p=>p.records);
   if(!records.length)continue;
   const identifiers=companyRegistrationEvidence(candidates,pages);
   const grouped=associateCompanySigningRecords(candidates,records,identifiers.identifiers);
   const changed=grouped.filter((c,i)=>c.nameAssociation!==candidates[i]?.nameAssociation);
   if(!changed.length)continue;
   candidates=grouped;anchors.push(...proofs.flatMap(p=>p.anchors),...identifiers.anchors);
   entries.push({fieldId:field.fieldId,logicalDocumentId:material.id,groups:new Set(changed.map(c=>c.nameAssociation?.groupId)).size,candidateCount:changed.length});
  }
  return candidates===field.candidates?field:{...field,candidates};
 });
 return {fields,anchors:[...new Map(anchors.map(a=>[a.anchor_id,a])).values()],receipt:{version:'company-signing-subject-v1',entries}};
}
