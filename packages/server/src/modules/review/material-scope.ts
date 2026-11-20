import {DOCUMENT_CLASSIFICATION_PROJECTION} from './classification-projection.js';
import {fixedMaterialType} from '../documents/content-classification.js';
import {createHash} from 'node:crypto';
import type {ReviewMaterial} from '@hsbc/contracts/review';
import type {DB} from '../../infrastructure/database/client.js';
import {AppError} from '../../shared/errors.js';
import {currentMaterialDecisions,fixedMaterialSnapshot,materialMembership,usesFileListScope} from '../materials/review-scope.js';
import {getPublished} from './configuration.js';

function reviewMaterialHash(value:unknown):string {
  const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,ordered(v[k])])):v;
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}
export async function materialProjection(db:DB,documentId:string,parseRevision:string,directoryRevision:number|null,exactJobId?:string|null){
    if(directoryRevision===null||exactJobId===null)return {ready:true,hash:null,jobId:null,items:[] as any[],anchors:[] as any[],authorizationSource:undefined,sourceCorrection:undefined,tablePartySource:undefined};
    const latest=exactJobId===parseRevision?null:(await db.query(`SELECT id,result,state,input FROM business.document_jobs WHERE document_version_id=$1 AND kind='extract_fields'
      AND input->>'parseRevision'=$2 AND input->>'directoryRevision'=$3 AND ($4::uuid IS NULL AND validity='current' OR id=$4)
      ORDER BY created_at DESC,id DESC LIMIT 1`,[documentId,parseRevision,String(directoryRevision),exactJobId??null])).rows[0];
    const parsed=(await db.query('SELECT result FROM business.document_jobs WHERE id=$1',[parseRevision])).rows[0];
    const initial=parsed?.result?.fieldFilter?.directoryRevision===directoryRevision?parsed.result.fieldFilter.items:undefined;
    if(exactJobId&&exactJobId!==parseRevision&&!latest)throw new AppError(409,'review_projection_missing');
    const items=latest?['ready','partial','stale'].includes(latest.state)&&Array.isArray(latest.result?.items)?latest.result.items:[]:Array.isArray(initial)?initial:[];
    const anchors=latest?.result?.anchors??[];
    return {ready:!latest||['ready','partial'].includes(latest.state),hash:latest||Array.isArray(initial)?reviewMaterialHash({items,anchors,sourceAnchors:latest?.result?.sourceAnchors??[]}):null,
      jobId:latest?.id??(initial?parseRevision:null),items,anchors,sourceAnchors:latest?.result?.sourceAnchors,
      authorizationSource:(latest?latest.result:parsed?.result)?.cloudExtraction?.authorizationSource,
      sourceCorrection:(latest?latest.result:parsed?.result)?.cloudExtraction?.sourceCorrection,
      tablePartySource:(latest?latest.result:parsed?.result)?.cloudExtraction?.tablePartySource};
  }

/** Read-only projection of the current file list. Classification and source readiness
 * are separate from inclusion; unknown/unreadable files remain pending in the snapshot. */
export async function reviewMaterials(db:DB,caseId:string,roundId:string|null):Promise<ReviewMaterial[]> {
  if(!await usesFileListScope(db,caseId,roundId)){
    const snapshot=await fixedMaterialSnapshot(db,caseId,roundId);
    return snapshot?.materialScope==='file-list'?snapshot.materials:(await db.query(currentMaterialDecisions,[caseId,roundId])).rows.map(r=>r.body);
  }
  const c=(await db.query('SELECT configuration_release_id FROM business.cases WHERE id=$1',[caseId])).rows[0];
  const {documents,decisions}=await materialMembership(db,caseId,roundId);
  if(!c.configuration_release_id)return [];
  const release=await getPublished(db,c.configuration_release_id),types=new Set(release.manifest.taxonomy.map(t=>t.id));
  const result:ReviewMaterial[]=[];
  for(const doc of documents){
    if(!['pdf','docx','jpg','png'].includes(doc.source_format)||!doc.current_parse_job_id)continue;
    const parseRevision=doc.current_parse_job_id;
    const artifact=(await db.query(`SELECT directory_revision,jsonb_build_object(${DOCUMENT_CLASSIFICATION_PROJECTION}) AS body,sha256 FROM business.document_artifacts WHERE job_id=$1 ORDER BY directory_revision DESC LIMIT 1`,[parseRevision])).rows[0];
    const source=(await db.query('SELECT sha256 FROM business.document_sources WHERE job_id=$1',[parseRevision])).rows[0];
    if(!artifact&&!source)continue;
    const saved=decisions.filter(m=>m.documentVersionId===doc.id),whole=saved.find(m=>!m.logicalDocumentId&&m.operation==='adopt'&&types.has(m.documentTypeId));
    const logicals=artifact?.body.logicalDocuments??[];
    const contentFirst=artifact?.body.classificationMode==='content-first-v1';
    const fixedType=contentFirst?fixedMaterialType(artifact.body):null;
    const classifications: Array<{logicalDocumentId:string|null;documentTypeId:string}>=contentFirst?(fixedType&&types.has(fixedType)?logicals.filter((l:any)=>!l.id.startsWith('source-document:')).map((l:any)=>({logicalDocumentId:l.id,documentTypeId:fixedType})):[]):whole?[{logicalDocumentId:null,documentTypeId:whole.documentTypeId}]:logicals.flatMap((l:any)=>{
      const explicit=saved.find(m=>m.logicalDocumentId===l.id&&m.operation==='adopt');
      const type=explicit?.documentTypeId??(['candidate','confirmed'].includes(l.status)?l.labelId:null);
      return type&&types.has(type)?[{logicalDocumentId:l.id,documentTypeId:type}]:[];
    });
    // A previous explicit source-only classification still supplies its type.
    if(!contentFirst&&!classifications.length&&!logicals.length)for(const m of saved)if(m.operation==='adopt'&&types.has(m.documentTypeId))classifications.push({logicalDocumentId:null,documentTypeId:m.documentTypeId});
    const projection=await materialProjection(db,doc.id,parseRevision,artifact?.directory_revision??null);
    for(const classification of classifications)result.push({documentVersionId:doc.id,...classification,operation:'adopt',sourceFormat:doc.source_format,sourceSha256:doc.sha256,
      parseRevision,directoryRevision:artifact?.directory_revision??null,artifactHash:artifact?.sha256??null,sourceStructureHash:source?.sha256??null,
      projectionHash:projection.hash,projectionJobId:projection.jobId,relation:{kind:'original'},caseRevision:saved.find(m=>(m.logicalDocumentId??null)===classification.logicalDocumentId)?.caseRevision??doc.registration_revision});
  }
  return result;
}
