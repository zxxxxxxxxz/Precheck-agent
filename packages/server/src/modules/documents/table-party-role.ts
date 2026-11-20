import {isDeepStrictEqual} from 'node:util';
import {DocumentFieldCandidateSchema,SourceCorrectionBindingSchema,type DocumentBundle,type DocumentFieldObservation,type DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {EvidenceAnchor,DocumentRegion} from '@hsbc/contracts/evidence';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {anchorsForText,sha256,validateAnchorSource} from '../../document/evidence.js';
import {documentHtmlCellSpans} from '../../document/html-cells.js';
type Candidate=DocumentFieldObservation['candidates'][number];
type Proof=NonNullable<Candidate['tablePartyEvidence']>;
export interface TablePartyInput {fields:DocumentFieldObservation[];definitions:ReviewFieldDefinition[];pages:DocumentPageArtifact[];logicalDocuments:DocumentBundle['logicalDocuments'];anchors:EvidenceAnchor[];binding:Proof['binding']}
const unique=<T>(values:T[])=>[...new Set(values)];
const key=(s:string)=>s.normalize('NFKC').replace(/<br\s*\/?>/giu,'').replace(/\s/gu,'');
const reason='private_table_party_source';
const body=(c:Candidate&{candidateId?:string}):Candidate=>{const{candidateId:_,...value}=c;return value;};
function usable(page:DocumentPageArtifact,region:DocumentRegion,input:TablePartyInput):boolean{
 return page.scope.documentVersionId===input.binding.documentVersionId&&page.scope.parseRevision===input.binding.parseRevision&&page.scope.sourceSha256===input.binding.sourceSha256&&page.status!=='failed'&&
 page.page.document_version_id===page.scope.documentVersionId&&page.page.parse_revision===page.scope.parseRevision&&page.page.source_sha256===page.scope.sourceSha256&&
 region.document_version_id===page.scope.documentVersionId&&region.parse_revision===page.scope.parseRevision&&region.page_asset_id===page.page.page_asset_id&&
 region.source==='vl_ocr'&&region.kind==='table'&&region.processing_status==='ready'&&!!region.raw_text&&region.raw_text_sha256===sha256(region.raw_text)&&
 region.polygons.length===1&&region.polygons[0]!.length>=3&&region.polygons[0]!.every(p=>p[0]>=0&&p[1]>=0&&p[0]<=page.page.width&&p[1]<=page.page.height)&&
 page.canonicalRegionIds.includes(region.region_id)&&!page.conflicts.some(c=>c.region_ids.includes(region.region_id));
}
function locate(page:DocumentPageArtifact,region:DocumentRegion,start:number,end:number):{source:Proof['name'];anchors:EvidenceAnchor[]}|undefined{
 const text=region.raw_text!,quote=text.slice(start,end),offset=Array.from(text.slice(0,start)).length;
 if(!quote||quote.length>2000)return;
 try{
  const anchors=anchorsForText(page.page,[region],quote).filter(a=>a.text_span_refs.length===1&&a.text_span_refs[0]!.offset===offset);
  if(anchors.length!==1)return;
  // A same-name second row is not ambiguous: the immutable, exact cell offset
  // establishes which occurrence was selected, while geometry remains block-only.
  const anchor={...anchors[0]!,localization_status:'block_only' as const,candidate_anchor_ids:[]};
  validateAnchorSource(anchor,page.page,page.regions);
  return {source:{quote,textSha256:sha256(quote),anchorIds:[anchor.anchor_id],pageNumbers:[page.page.page_number]},anchors:[anchor]};
 }catch{return;}
}
function seedValid(seed:Candidate,pages:DocumentPageArtifact[],anchors:Map<string,EvidenceAnchor>):boolean{
 if(!seed.rawValue.trim()||seed.rawValue!==seed.rawValue.trim()||seed.rawValue.length>300||seed.evidenceSegments?.length!==1||seed.evidenceSegments[0]!.rawValue!==seed.rawValue||
 seed.roleEvidence||seed.authorizationEvidence||seed.sourceCorrectionEvidence||seed.tablePartyEvidence)return false;
 return seed.anchorIds.some(id=>{const a=anchors.get(id),p=a&&pages.find(p=>p.page.page_asset_id===a.page_asset_id);if(!a||!p)return false;try{
  validateAnchorSource(a,p.page,p.regions);return a.text_span_refs.map(r=>Array.from(p.regions.find(x=>x.region_id===r.block_id)!.raw_text!).slice(r.offset,r.offset+r.length).join('')).join('')===seed.rawValue;
 }catch{return false;}});
}
/** Only a model's retained, rejected, literal name can be paired with an exact
 * classified formal-name row. No OCR repair, filename, CSV or cross-row inference. */
export function recoverTablePartyRoles(input:TablePartyInput):{fields:DocumentFieldObservation[];anchors:EvidenceAnchor[]}{
 if(!SourceCorrectionBindingSchema.safeParse(input.binding).success)return {fields:input.fields,anchors:input.anchors};
 const anchors=new Map(input.anchors.map(a=>[a.anchor_id,a]));
 const fields=input.fields.map(field=>structuredClone(field));
 for(const field of fields){
  const definition=input.definitions.find(d=>d.id===field.fieldId),filter=field.semanticFilter;
  if(!definition||definition.valueKind!=='party_name'||!definition.taxonomyIds?.includes('insurance_application')||filter?.version!=='azure-grounded-fields-v2'||field.status==='not_applicable'||
   field.documentVersionId!==input.binding.documentVersionId||field.parseRevision!==input.binding.parseRevision)continue;
  const candidates:Array<{candidate:Candidate;anchors:EvidenceAnchor[];id:string}>=[];
  for(const material of input.logicalDocuments){
   if(material.labelId!=='insurance_application'||!['candidate','confirmed'].includes(material.status)||input.logicalDocuments.some(m=>m!==material&&m.pageNumbers.some(p=>material.pageNumbers.includes(p))))continue;
   const pages=input.pages.filter(p=>material.pageNumbers.includes(p.page.page_number));
   if(pages.length!==material.pageNumbers.length)continue;
   const seeds=filter.originalCandidates.filter(c=>c.candidateId.startsWith('cloud-party-seed-')&&filter.decisions.some(d=>d.candidateId===c.candidateId&&d.decision==='rejected')&&seedValid(c,pages,anchors));
   for(const page of pages)for(const region of page.regions){
    if(!material.regionIds.includes(region.region_id)||!usable(page,region,input))continue;
    const text=region.raw_text!,cells=documentHtmlCellSpans(text);if(!cells.length)continue;
    const rows=[...text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/giu)];
    for(const [rowIndex,row] of rows.entries()){
     const rowStart=row.index!+row[0].indexOf('>')+1,rowEnd=row.index!+row[0].lastIndexOf('<');
     const members=cells.map((span,index)=>({...span,index})).filter(s=>s.start>=rowStart&&s.end<=rowEnd);
     if(members.length<2||members.length>3)continue;
     const r=members[0]!,f=members[1]!,role=text.slice(r.start,r.end),formal=text.slice(f.start,f.end);
     if(!definition.aliases.some(a=>key(a)===key(role)))continue;
     let n=members[2],name=n?text.slice(n.start,n.end):'',formalStart=f.start,formalEnd=f.end,nameStart=n?.start??0,nameEnd=n?.end??0;
     if(!['正式名称','正式名稱'].includes(key(formal))){
       // Some source tables put label and value in one cell, followed by other
       // explicitly labelled lines. Only this same-cell complete label grammar
       // establishes the boundary; nearby names or another row never do.
       const prefix=/^\s*正式名[称稱]\s*[:：]\s*/u.exec(formal);
       if(!prefix||(formal.match(/正式名[称稱]/gu)??[]).length!==1||/[<>]/u.test(formal))continue;
       const possibilities=unique(seeds.filter(s=>s.pageNumbers.includes(page.page.page_number)).map(s=>s.rawValue)).filter(value=>{
         if(!formal.startsWith(value,prefix[0].length))return false;
         const tail=formal.slice(prefix[0].length+value.length);
         return !tail.trim()||/^(?:\s|\\[nr])*(?:行业类型|行業類型|证件类型|證件類型|证件号码|證件號碼|通讯地址|通訊地址|联系地址|聯繫地址|联系人姓名|聯繫人姓名|联系电话|聯繫電話|组织机构代码|組織機構代碼|统一社会信用代码|統一社會信用代碼|客户编号|客戶編號)\s*[:：]/u.test(tail);
       });
       if(possibilities.length!==1)continue;
       n=f;name=possibilities[0]!;formalEnd=f.start+prefix[0].length;nameStart=formalEnd;nameEnd=nameStart+name.length;
     }
     if(!n||name!==name.trim()||/[<>\r\n]/u.test(name))continue;
     const matching=seeds.filter(s=>s.rawValue===name&&s.pageNumbers.includes(page.page.page_number));if(!matching.length)continue;
     const roleSource=locate(page,region,r.start,r.end),formalSource=locate(page,region,formalStart,formalEnd),nameSource=locate(page,region,nameStart,nameEnd);
     if(!roleSource||!formalSource||!nameSource)continue;
     const proof:Proof={version:'table-party-role-v1',association:'candidate',method:'classified_formal_name_row',targetFieldId:field.fieldId,logicalDocumentId:material.id,
      sourceCandidateIds:matching.map(s=>s.candidateId).sort(),binding:input.binding,
      table:{regionId:region.region_id,rawTextSha256:region.raw_text_sha256!,rowIndex,roleCellIndex:r.index,formalNameCellIndex:f.index,nameCellIndex:n.index},role:roleSource.source,formalName:formalSource.source,name:nameSource.source};
     const all=[...roleSource.anchors,...formalSource.anchors,...nameSource.anchors],context=text.slice(rowStart,rowEnd);
     const candidate:Candidate={rawValue:name,normalizedValue:name,displayValue:name,anchorIds:nameSource.source.anchorIds,pageNumbers:[page.page.page_number],contextText:context,
      contextAnchorIds:unique(all.map(a=>a.anchor_id)),evidenceSegments:[{rawValue:name,contextText:context,anchorIds:nameSource.source.anchorIds,contextAnchorIds:unique(all.map(a=>a.anchor_id)),pageNumbers:[page.page.page_number]}],tablePartyEvidence:proof};
     const parsed=DocumentFieldCandidateSchema.safeParse(candidate);if(!parsed.success)continue;
     candidates.push({candidate:parsed.data,anchors:all,id:`local-table-party-${sha256(JSON.stringify([field.fieldId,proof])).slice(0,32)}`});
    }
   }
  }
  // More than one distinct formal row for the role remains unresolved.
  const uniqueRows=[...new Map(candidates.map(c=>[c.id,c])).values()];if(uniqueRows.length!==1)continue;
  const found=uniqueRows[0]!;if(filter.originalCandidates.some(c=>c.candidateId===found.id)||field.candidates.some(c=>c.rawValue===found.candidate.rawValue))continue;
  for(const a of found.anchors)anchors.set(a.anchor_id,a);
  field.candidates.push(found.candidate);filter.originalCandidates.push({...found.candidate,candidateId:found.id});
  filter.decisions.push({candidateId:found.id,decision:'selected',anchorIds:found.anchors.map(a=>a.anchor_id),pageNumbers:found.candidate.pageNumbers});
  filter.state='completed';filter.reasonCodes=unique([...filter.reasonCodes,reason]);field.status='uncertain';
  field.rawValue=field.candidates.length===1?found.candidate.rawValue:null;field.normalizedValue=field.candidates.length===1?found.candidate.normalizedValue:null;
  field.anchorIds=unique(field.candidates.flatMap(c=>c.anchorIds));field.pageNumbers=unique(field.candidates.flatMap(c=>c.pageNumbers));field.coverageGaps=unique([...field.coverageGaps,reason,'entity_candidate_requires_confirmation']);
 }
 return {fields,anchors:[...anchors.values()]};
}
export function verifyTablePartyCandidate(input:TablePartyInput,candidateId:string,candidate:Candidate):boolean{
 const proof=candidate.tablePartyEvidence;if(!proof||!isDeepStrictEqual(proof.binding,input.binding))return false;
 const stripped=input.fields.map(f=>({...f,candidates:f.candidates.filter(c=>!c.tablePartyEvidence),semanticFilter:f.semanticFilter?{...f.semanticFilter,
  originalCandidates:f.semanticFilter.originalCandidates.filter(c=>!c.tablePartyEvidence),decisions:f.semanticFilter.decisions.filter(d=>!d.candidateId.startsWith('local-table-party-'))}:undefined}));
 const rebuilt=recoverTablePartyRoles({...input,fields:stripped}).fields.find(f=>f.fieldId===proof.targetFieldId)?.semanticFilter?.originalCandidates.find(c=>c.candidateId===candidateId);
 return !!rebuilt&&isDeepStrictEqual(body(rebuilt),candidate);
}
