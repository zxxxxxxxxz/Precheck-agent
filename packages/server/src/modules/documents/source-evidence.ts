import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DocxSourceDocument } from '@hsbc/contracts/docx';
import { DocumentBundleSchema, DocumentScopeSchema, type DocumentBundle, type DocumentEngineConfig, type DocumentPageArtifact, type DocumentScope, type DocumentSourceAnchor } from '@hsbc/contracts/documents';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compact=(value:string)=>value.normalize('NFC').replace(/\s+/gu,'');
export const SourceMappingSchema=z.strictObject({sourceNodeId:z.string(),anchorIds:z.array(z.string()),pageNumbers:z.array(z.number().int().positive()),status:z.enum(['mapped','ambiguous','source_only']),reason:z.string().nullable()});
export type SourceMapping=z.infer<typeof SourceMappingSchema>;

/** Exact visible sequences only. Repeated values remain ambiguous; source order never invents a page. */
export function mapSourceEvidence(source:DocxSourceDocument,pages:DocumentPageArtifact[],budget:{maxComparisons?:number;maxScannedCharacters?:number}={}):SourceMapping[]{
  const maxComparisons=budget.maxComparisons??200000,maxCharacters=budget.maxScannedCharacters??25000000;
  if(!Number.isSafeInteger(maxComparisons)||maxComparisons<1||maxComparisons>200000||!Number.isSafeInteger(maxCharacters)||maxCharacters<1||maxCharacters>25000000)throw new Error('source_mapping_budget_invalid');
  let comparisons=0,characters=0;
  const sourceCounts=new Map<string,number>();
  for(const node of source.nodes)if(['paragraph','cell'].includes(node.kind)&&!node.excludedFromVisibleFacts){const key=`${node.kind}:${compact(node.visibleText)}`;sourceCounts.set(key,(sourceCounts.get(key)??0)+1);}
  const spans:Array<{text:string;anchorIds:string[];pageNumber:number}>=[];
  for(const page of pages){
    const canonical=new Set(page.canonicalRegionIds),anchorsByBlock=new Map<string,string[]>();
    for(const anchor of page.anchors)if(anchor.polygons.length)for(const block of anchor.block_ids){const ids=anchorsByBlock.get(block)??[];ids.push(anchor.anchor_id);anchorsByBlock.set(block,ids);}
    for(const region of [...page.regions].sort((a,b)=>a.reading_order-b.reading_order)){
      if(!region.raw_text||!canonical.has(region.region_id))continue;
      spans.push({text:compact(region.raw_text),anchorIds:anchorsByBlock.get(region.region_id)??[],pageNumber:page.page.page_number});
    }
  }
  return source.nodes.map(node=>{
    const value=compact(node.visibleText);
    const empty={sourceNodeId:node.id,anchorIds:[],pageNumbers:[],status:'source_only' as const,reason:'visible_sequence_not_mapped'};
    if(node.excludedFromVisibleFacts)return {...empty,reason:'source_not_visible'};
    if(node.kind==='symbol')return {...empty,reason:'symbol_requires_visual_verification'};
    if(!['paragraph','cell'].includes(node.kind))return {...empty,reason:'source_structure_only'};
    if(value.length<4||value.length>100000)return {...empty,reason:'source_structure_only'};
    if((sourceCounts.get(`${node.kind}:${value}`)??0)>1)return {...empty,status:'ambiguous' as const,reason:'repeated_source_sequence'};
    const selected:typeof spans=[];
    // Separate rendered regions/pages are never concatenated to manufacture an
    // occurrence. Unproven cross-region continuity stays source-only.
    for(const span of spans){
      if(++comparisons>maxComparisons||(characters+=span.text.length)>maxCharacters)return {...empty,reason:'source_mapping_budget_exceeded'};
      let offset=span.text.indexOf(value);while(offset>=0){
      const before=[...span.text.slice(0,offset)].at(-1)??'',after=[...span.text.slice(offset+value.length)][0]??'';
      const first=[...value][0]!,last=[...value].at(-1)!;
      if(!(/[\p{L}\p{N}]/u.test(before)&&/[\p{L}\p{N}]/u.test(first))&&!(/[\p{L}\p{N}]/u.test(after)&&/[\p{L}\p{N}]/u.test(last)))selected.push(span);
      if(selected.length>1)break;offset=span.text.indexOf(value,offset+1);
    }if(selected.length>1)break;}
    if(!selected.length)return empty;
    if(selected.length>1)return {...empty,status:'ambiguous' as const,reason:'repeated_visible_sequence'};
    if(selected.some(s=>!s.anchorIds.length))return {...empty,reason:'preview_geometry_unavailable'};
    return {sourceNodeId:node.id,anchorIds:[...new Set(selected.flatMap(s=>s.anchorIds))],pageNumbers:[...new Set(selected.map(s=>s.pageNumber))],status:'mapped' as const,reason:null};
  });
}

export function addSourceEvidence(source:DocxSourceDocument,scope:DocumentScope,config:DocumentEngineConfig,previewGaps:string[],pages:DocumentPageArtifact[],base?:DocumentBundle){
  const identity=hash(DocumentScopeSchema.parse(scope));
  if(scope.sourceFormat!=='docx'||source.sourceSha256!==scope.sourceSha256||(base&&hash(DocumentScopeSchema.parse(base.scope))!==identity)||pages.some(page=>hash(DocumentScopeSchema.parse(page.scope))!==identity))throw new Error('source_evidence_scope_mismatch');
  const mappings=mapSourceEvidence(source,pages),map=new Map(mappings.map(m=>[m.sourceNodeId,m]));
  const unsafePreviewSemantics=source.nodes.some(n=>n.excludedFromVisibleFacts&&(n.text.trim().length>0||['image','textbox'].includes(n.kind)));
  const previewSuppressed=Boolean(base&&unsafePreviewSemantics),trustedBase=previewSuppressed?undefined:base;
  const sourceAnchors:DocumentSourceAnchor[]=source.nodes.map(node=>{
    const mapping=map.get(node.id)!;
    return {schema_version:'p2.v2',anchor_id:`source:${node.id}`,location_scope:'source_structure',document_version_id:scope.documentVersionId,parse_revision:scope.parseRevision,sourceNodeId:node.id,part:node.part,path:node.path,
      granularity:node.kind==='paragraph'||node.kind==='cell'||node.kind==='symbol'?node.kind:'node',previewRevision:scope.previewRevision??null,localization_status:mapping.status,page_numbers:mapping.pageNumbers,candidate_anchor_ids:mapping.anchorIds};
  });
  const gaps=[...new Set([...(base?.coverageGaps??[]),...source.coverageGaps,...previewGaps])];
  if(previewSuppressed)gaps.push('preview_revision_or_visibility_review_required');
  const docId=`source-document:${scope.parseRevision}`,revision=base?.directoryRevision??'1';
  const bundle:DocumentBundle=trustedBase?structuredClone(trustedBase):{
    schema_version:'p2.v2',...(config.classificationMode?{classificationMode:config.classificationMode}:{}),scope,directoryRevision:revision,pageCount:base?.pageCount??null,
    logicalDocuments:(base?.logicalDocuments??[]).map(d=>d.source==='manual'?structuredClone(d):{...d,labelId:null,label:'待核对',status:'unknown'}),structures:[],fields:config.fields.map(f=>({id:`source-field:${hash([scope,f.id])}`,fieldId:f.id,fieldLabel:f.label,documentVersionId:scope.documentVersionId,parseRevision:scope.parseRevision,status:'uncertain',rawValue:null,normalizedValue:null,pageNumbers:[],anchorIds:[],candidates:[],objectId:null,humanRevisionId:null,coverageGaps:[previewSuppressed?'preview_revision_or_visibility_review_required':'preview_unavailable_source_review_required']})),tables:[],signatures:[],anchors:structuredClone(base?.anchors??[]),chunks:[],coverageGaps:gaps,status:'partial',
    indexManifest:{id:`index:${hash(scope)}`,schema_version:'p2.v2',scope,directoryRevision:revision,configVersion:config.version,taxonomyVersion:config.taxonomyVersion,fieldDictionaryVersion:config.fieldDictionaryVersion,indexVersion:'p2-source-structure-v1',status:'partial',indexedPageNumbers:[],expectedPageCount:base?.pageCount??null,chunkIds:[],sourceFingerprint:hash(scope),coverageGaps:gaps,retrieval:{lexical:'unicode-terms-v1',embedding:null,reranker:null,modelEvaluation:'unverified'}},
  };
  // Keep the recorded OCR clue provenance when a DOCX preview cannot establish
  // visible business facts, but do not expose its geometry as verified evidence.
  if (previewSuppressed && base?.ocrMarkPages) bundle.ocrMarkPages=base.ocrMarkPages.map(layer=>({
    ...structuredClone(layer),status:'partial',coverageGaps:[...new Set([...layer.coverageGaps,'ocr_marks_preview_visibility_unverified'])],
    items:layer.items.map(item=>({...structuredClone(item),mappingStatus:'unavailable',regionId:null,bbox:null,polygon:null,
      coverageGaps:[...new Set([...item.coverageGaps,'ocr_marks_preview_visibility_unverified'])]})),
  }));
  // Rebuilding fields from the same OCR/source must not append another copy of
  // the source document, clauses or search chunks from an earlier projection.
  bundle.logicalDocuments=bundle.logicalDocuments.filter(item=>item.id!==docId);
  bundle.structures=bundle.structures.filter(item=>item.logicalDocumentId!==docId);
  bundle.chunks=bundle.chunks.filter(item=>item.logicalDocumentId!==docId);
  bundle.schema_version='p2.v2';bundle.sourceAnchors=sourceAnchors;
  bundle.logicalDocuments.push({id:docId,labelId:null,label:'源结构',status:'unknown',pageNumbers:[],regionIds:[],source:'classification'});
  const parents=new Map(source.nodes.map(n=>[n.id,n]));
  const retainedPreviewAnchors=new Set((trustedBase?.chunks??[]).flatMap(c=>c.anchorIds));
  const children=new Map<string,string[]>();for(const node of source.nodes)if(node.parentId){const ids=children.get(node.parentId)??[];ids.push(node.id);children.set(node.parentId,ids);}
  const inCell=(id:string|null):boolean=>{for(let depth=0;id&&depth<128;depth++){const n=parents.get(id);if(!n)return false;if(n.kind==='cell')return true;id=n.parentId;}return false;};
  for(const node of source.nodes){
    if(node.excludedFromVisibleFacts||!node.visibleText||!['paragraph','cell'].includes(node.kind)||(node.kind==='paragraph'&&inCell(node.parentId)))continue;
    const mapping=map.get(node.id)!;
    // Mapped text is already indexed as rendered evidence; source-only occurrences remain searchable.
    if(mapping.status==='mapped'&&mapping.anchorIds.some(id=>retainedPreviewAnchors.has(id)))continue;
    const id=`source-chunk:${hash([scope.parseRevision,node.id])}`;
    const nodeGaps=[...new Set([...node.coverageGaps,...(mapping.reason?[mapping.reason]:[]),...(mapping.status!=='mapped'?['source_visibility_not_visually_verified']:[])])];
    const located=mapping.status==='mapped'&&Boolean(base),pageNumbers=located?mapping.pageNumbers:[],anchorIds=located?mapping.anchorIds:[];
    bundle.structures.push({id,logicalDocumentId:docId,kind:'clause',label:null,text:node.visibleText,pageNumbers,regionIds:[],anchorIds,parentId:null,sourceNodeIds:[node.id],references:[],coverageGaps:nodeGaps});
    bundle.chunks.push({id,documentVersionId:scope.documentVersionId,parseRevision:scope.parseRevision,logicalDocumentId:docId,structureNodeId:id,parentId:null,text:node.visibleText,textSha256:createHash('sha256').update(node.visibleText).digest('hex'),pageNumbers,regionIds:[],anchorIds,sourceNodeIds:[node.id],dependencyIds:[],unresolvedReferences:[],coverageGaps:nodeGaps});
  }
  const bySource=new Map<string,typeof bundle.chunks>(),byAnchor=new Map<string,typeof bundle.chunks>();
  for(const chunk of bundle.chunks){for(const nodeId of chunk.sourceNodeIds??[]){const rows=bySource.get(nodeId)??[];rows.push(chunk);bySource.set(nodeId,rows);}for(const anchor of chunk.anchorIds){const rows=byAnchor.get(anchor)??[];rows.push(chunk);byAnchor.set(anchor,rows);}}
  const chunksFor=(nodeId:string)=>{
    const anchors=new Set(map.get(nodeId)?.anchorIds??[]);
    return [...new Set([...(bySource.get(nodeId)??[]),...[...anchors].flatMap(a=>byAnchor.get(a)??[])])];
  };
  for(const mapping of mappings)if(mapping.status==='mapped')for(const chunk of chunksFor(mapping.sourceNodeId))chunk.sourceNodeIds=[...new Set([...(chunk.sourceNodeIds??[]),mapping.sourceNodeId])];
  const targetDependencies=new Map<string,string[]>(),structuresById=new Map(bundle.structures.map(s=>[s.id,s]));
  // Explicit OOXML note references remain mandatory even when the note is far
  // from the calling paragraph or has no reliable preview page mapping.
  for(const node of source.nodes){
    if(node.kind!=='run'||node.excludedFromVisibleFacts||!node.reference||!['footnote','endnote'].includes(node.reference.kind))continue;
    let owner=parents.get(node.parentId??'');let owners:typeof bundle.chunks=[];
    for(let depth=0;owner&&depth<128;depth++){owners=chunksFor(owner.id);if(owners.length)break;owner=parents.get(owner.parentId??'');}
    if(!owners.length)continue;
    const target=node.reference.targetId;
    if(target&&!targetDependencies.has(target)){
      const pending=[target],visited=new Set<string>(),ids=new Set<string>();
      while(pending.length){const id=pending.pop()!;if(visited.has(id))continue;visited.add(id);for(const chunk of chunksFor(id))ids.add(chunk.id);pending.push(...children.get(id)??[]);}
      targetDependencies.set(target,[...ids]);
    }
    const dependencies=target?targetDependencies.get(target)??[]:[];
    for(const chunk of owners){
      chunk.dependencyIds=[...new Set([...chunk.dependencyIds,...dependencies.filter(id=>id!==chunk.id)])];
      if(!dependencies.length){chunk.unresolvedReferences.push(node.reference.kind);chunk.coverageGaps.push('source_note_reference_unresolved');gaps.push('source_note_reference_unresolved');}
      const structure=structuresById.get(chunk.structureNodeId);
      structure?.references.push({label:node.reference.kind,targetIds:dependencies,required:true,status:dependencies.length?'resolved':'missing'});
    }
  }
  const unmapped=mappings.filter(m=>m.status!=='mapped').length;
  if(mappings.some(m=>m.reason==='source_mapping_budget_exceeded'))gaps.push('source_mapping_budget_exceeded');
  if(unmapped)gaps.push('source_mapping_incomplete');
  for(const structure of bundle.structures)structure.references=[...new Map(structure.references.map(ref=>[JSON.stringify(ref),ref])).values()];
  for(const chunk of bundle.chunks){chunk.unresolvedReferences=[...new Set(chunk.unresolvedReferences)];chunk.coverageGaps=[...new Set(chunk.coverageGaps)];}
  bundle.coverageGaps=[...new Set(gaps)];bundle.status=bundle.coverageGaps.length?'partial':'ready';
  bundle.indexManifest={...bundle.indexManifest,id:`index:${hash([scope,revision,bundle.chunks.map(c=>c.id)])}`,schema_version:'p2.v2',sourceFingerprint:hash([scope,source.contentFingerprint]),indexedPageNumbers:[...new Set(bundle.chunks.flatMap(c=>c.pageNumbers))].sort((a,b)=>a-b),chunkIds:bundle.chunks.map(c=>c.id),coverageGaps:bundle.coverageGaps,status:bundle.status==='ready'?'ready':'partial'};
  return {bundle:DocumentBundleSchema.parse(bundle),mappings};
}
