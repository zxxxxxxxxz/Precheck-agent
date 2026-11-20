import {reviewMaterials} from '../../review/material-scope.js';
import {assertRoundRequest,assertDocumentRound} from '../../review/round-boundary.js';
import { createHash,randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { z } from 'zod';
import { DocumentBundleSchema,DocumentPageArtifactSchema,type DocumentBundle } from '@hsbc/contracts/documents';
import { SignatureCheckCommandSchema,SignatureConfirmationCommandSchema,SignatureConfirmationSchema,SignatureObservationSchema,SignatureReviewProjectionSchema,type SignatureReviewProjection,type SignatureRequirementRecord,type SignatureConfirmation,type SignatureObservation } from '@hsbc/contracts/signature-review';
import { AppError } from '../../../shared/errors.js';
import { transaction } from '../../../infrastructure/database/client.js';
import { idempotent,inputHash } from '../../../infrastructure/database/idempotency.js';
import { ServiceError } from '../../../infrastructure/integrations/http.js';
import type { ObjectStore } from '../../../infrastructure/integrations/oss.js';
import type { QwenDispatch } from '../../../infrastructure/integrations/inference.js';
import type { PrivateSignatureVision } from '../../../infrastructure/integrations/signature-vision.js';
import type { DocumentRuntimeConfig } from '../config.js';
import type { DocumentReviewPort } from '../ports.js';
import type { Actor } from '../../identity/types.js';
import { authorizeCase } from '../../cases/authorization.js';
import { audit } from '../../audit/events.js';
import { documentClassificationScope } from '../field-applicability.js';
import { signatureRequirementProjection } from './requirements.js';
import {readSignatureInformation,saveSignatureInformation} from './information.js';
import { evaluateSignatureRequirements } from './evaluator.js';
import { ocrMarkHintBoxes } from '../ocr-marks.js';
import { directorNoticeSignatures } from './director-notice-signatures.js';

const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export interface SignatureJob {id:string;case_id:string;document_version_id:string;expected_revision:number;person_id:string;state:string;validity:string;input:Record<string,any>;error_code:string|null;result:any;}
export interface SignatureSnapshot {sourceSha256:string;parseRevision:string;directoryRevision:number;configurationReleaseId:string|null;caseRevision:number;modelRevision:string;promptVersion:string;requirements:SignatureRequirementRecord[];requirementsTruncated?:boolean;taxonomyIds:string[];classificationKnown:boolean;pageCount:number;pageHashes:Array<{pageNumber:number;imageSha256:string}>;}
const terminal=new Set(['qwen_truncated','qwen_refused','qwen_unsupported_output','qwen_model_drift','qwen_authorization_failed','qwen_request_rejected','qwen_invalid_response','qwen_response_too_large']);
/** Restore fences execution authority, not an unresolved provider outcome. */
async function hasUnknownSnapshotCall(db:PoolClient,documentId:string,snapshotHash:string,exceptJobId?:string){
  return Boolean((await db.query(`SELECT 1 FROM business.signature_review_snapshots s JOIN business.document_jobs j ON j.id=s.job_id
    WHERE j.document_version_id=$1 AND s.input_hash=$2 AND ($3::uuid IS NULL OR j.id<>$3)
    AND (j.result->>'signatureCallUnknown'='true' OR j.error_code='signature_call_unknown'
      OR EXISTS(SELECT 1 FROM business.signature_model_calls call WHERE call.job_id=j.id AND call.state='unknown')) LIMIT 1`,[documentId,snapshotHash,exceptJobId??null])).rowCount);
}
/** One record is written before dispatch. Unknown results are never resubmitted. */
export function signatureDispatch(pool:Pool,jobId:string,fence:(db:PoolClient)=>Promise<void>):QwenDispatch{return async(body,start)=>{
  const hash=inputHash(body),prepared=await transaction(pool,async db=>{await fence(db);await db.query('SELECT id FROM business.document_jobs WHERE id=$1 FOR UPDATE',[jobId]);
    const snapshot=(await db.query('SELECT j.document_version_id,s.input_hash FROM business.document_jobs j JOIN business.signature_review_snapshots s ON s.job_id=j.id WHERE j.id=$1',[jobId])).rows[0];
    if(!snapshot)throw new ServiceError('signature_snapshot_missing');
    if(await hasUnknownSnapshotCall(db,snapshot.document_version_id,snapshot.input_hash))throw new ServiceError('signature_call_unknown');
    const old=(await db.query('SELECT * FROM business.signature_model_calls WHERE job_id=$1 AND request_hash=$2',[jobId,hash])).rows[0];
    if(old){if(old.state==='completed')return {response:old.response};throw new ServiceError(old.state==='unknown'?'signature_call_unknown':old.error_code??'signature_call_failed');}
    const count=Number((await db.query('SELECT count(*) AS n FROM business.signature_model_calls WHERE job_id=$1',[jobId])).rows[0].n);if(count>=6500)throw new ServiceError('signature_call_budget_exceeded');
    const id=randomUUID();await db.query("INSERT INTO business.signature_model_calls(id,job_id,request_hash,state) VALUES($1,$2,$3,'unknown')",[id,jobId,hash]);await db.query("UPDATE business.document_jobs SET result=coalesce(result,'{}'::jsonb)||'{\"signatureCallUnknown\":true}'::jsonb WHERE id=$1",[jobId]);return {id};});
  if('response'in prepared)return prepared.response;
  try{const result=await start();await transaction(pool,async db=>{await fence(db);await db.query("UPDATE business.signature_model_calls SET state='completed',response=$2,completed_at=now() WHERE id=$1 AND state='unknown'",[prepared.id,JSON.stringify(result)]);await db.query("UPDATE business.document_jobs SET result=coalesce(result,'{}'::jsonb)||'{\"signatureCallUnknown\":false}'::jsonb WHERE id=$1",[jobId]);});return result;}
  catch(error){if(error instanceof ServiceError&&terminal.has(error.code))await transaction(pool,async db=>{await fence(db);await db.query("UPDATE business.signature_model_calls SET state='failed',error_code=$2,completed_at=now() WHERE id=$1 AND state='unknown'",[prepared.id,error.code]);await db.query("UPDATE business.document_jobs SET result=coalesce(result,'{}'::jsonb)||'{\"signatureCallUnknown\":false}'::jsonb WHERE id=$1",[jobId]);}).catch(()=>undefined);throw error;}
};}

export class SignatureReviewService {
  constructor(private pool:Pool,private store:ObjectStore,private config:DocumentRuntimeConfig,private review:DocumentReviewPort,private vision:Pick<PrivateSignatureVision,'reviewPage'>|undefined,private promptVersion:string){}
  private enabled(caseId:string,documentId:string){const c=this.config.signatureVision;return Boolean(c&&c.caseIds.includes(caseId)&&c.documentIds.includes(documentId));}
  information(actor:Actor,caseId:string,documentId:string,parseRevision?:string,recordId?:string){return transaction(this.pool,db=>readSignatureInformation(db,actor,caseId,documentId,this.review,parseRevision,recordId));}
  saveInformation(actor:Actor,caseId:string,documentId:string,raw:unknown){return transaction(this.pool,db=>saveSignatureInformation(db,actor,caseId,documentId,this.review,raw));}
  private async context(db:PoolClient,actor:Actor,caseId:string,documentId:string,parseRevision?:string,write=false){
    const c=await authorizeCase(db,actor,caseId,write?'document:parse':'evidence:read',write);
    const doc=(await db.query(`SELECT d.* FROM business.document_versions d JOIN business.upload_sessions u ON u.id=d.upload_session_id WHERE d.case_id=$1 AND d.id=$2 AND u.state='registered' AND u.document_version_id=d.id ${write?'FOR UPDATE OF d':''}`,[caseId,documentId])).rows[0];if(!doc)throw new AppError(404,'material_not_found');
    const parse=(await db.query("SELECT * FROM business.document_jobs WHERE id=$1 AND case_id=$2 AND document_version_id=$3 AND kind='parse_document'",[parseRevision??doc.current_parse_job_id,caseId,documentId])).rows[0];if(!parse)throw new AppError(409,'parse_not_available');
    const artifact=(await db.query('SELECT directory_revision,body FROM business.document_artifacts WHERE job_id=$1 ORDER BY directory_revision DESC LIMIT 1',[parse.id])).rows[0];if(!artifact)throw new AppError(409,'index_not_ready');
    return {c,doc,parse,bundle:DocumentBundleSchema.parse(artifact.body),directoryRevision:Number(artifact.directory_revision)};
  }
  async check(actor:Actor,caseId:string,documentId:string,raw:unknown,accept:(db:PoolClient,c:any,doc:any,input:Record<string,unknown>)=>Promise<{jobId:string;status:string}>){
    const input=SignatureCheckCommandSchema.parse(raw);if(!this.enabled(caseId,documentId))throw new AppError(409,'signature_vision_unavailable');
    return transaction(this.pool,async db=>{const context=await this.context(db,actor,caseId,documentId,input.parseRevision,true),{c,doc,parse,bundle,directoryRevision}=context;await assertRoundRequest(db,c,input.roundId,{draft:true});await assertDocumentRound(db,c,documentId);
      if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');if(doc.current_parse_job_id!==parse.id)throw new AppError(409,'stale_parse_revision');if(directoryRevision!==input.expectedDirectoryRevision)throw new AppError(409,'stale_directory_revision');if(!['ready','partial'].includes(parse.state))throw new AppError(409,'parse_not_ready');if(doc.source_format!=='pdf')throw new AppError(409,'signature_format_unsupported');
      return idempotent(db,actor,`document.signatures:${documentId}`,input.idempotencyKey,input,async()=>{
        const published=c.configuration_release_id?await this.review.getPublished(db,c.configuration_release_id):null;
        if(this.config.requireReviewConfiguration&&published?.manifest.compatibility.signatureExecutorVersion!=='signature-requirements-v1')throw new AppError(409,'signature_configuration_required');
        const pages=(await db.query('SELECT page_number,image_sha256 FROM business.document_pages WHERE job_id=$1 ORDER BY page_number',[parse.id])).rows;
        const classification=documentClassificationScope(bundle),requirements=signatureRequirementProjection(bundle,published?.manifest.signatureRequirements??[]);
        const snapshot:SignatureSnapshot={sourceSha256:doc.sha256,parseRevision:parse.id,directoryRevision,configurationReleaseId:c.configuration_release_id??null,caseRevision:c.revision,modelRevision:this.config.signatureVision!.modelRevision,promptVersion:this.promptVersion,requirements:requirements.requirements,...(requirements.truncated?{requirementsTruncated:true}:{}),taxonomyIds:classification.taxonomyIds,classificationKnown:classification.known,pageCount:doc.page_count,pageHashes:pages.map(p=>({pageNumber:p.page_number,imageSha256:p.image_sha256}))};
        const hash=stableHash(snapshot),old=(await db.query("SELECT j.id,j.state,j.person_id,j.account_id,j.auth_version,j.result,j.error_code FROM business.signature_review_snapshots s JOIN business.document_jobs j ON j.id=s.job_id WHERE j.document_version_id=$1 AND s.input_hash=$2 AND j.validity='current' ORDER BY j.created_at DESC LIMIT 1",[documentId,hash])).rows[0];
        if(await hasUnknownSnapshotCall(db,documentId,hash,old?.id))throw new AppError(409,'signature_call_unknown');
        if(old){
          if(['failed','canceled'].includes(old.state)){
            // API sees only job/state columns, never the private model response.
            // Check the durable ledger as well as the hint before restoring work.
            const calls=(await db.query("SELECT state FROM business.signature_model_calls WHERE job_id=$1 AND state IN ('unknown','failed')",[old.id])).rows;
            if(old.result?.signatureCallUnknown===true||old.error_code==='signature_call_unknown'||calls.some(call=>call.state==='unknown'))throw new AppError(409,'signature_call_unknown');
            // qwen_busy is raised by admission before dispatch. Other failures,
            // including known failed model outputs, require separate resolution.
            const resumable=old.state==='canceled'||old.state==='failed'&&old.error_code==='qwen_busy';
            if(resumable&&!calls.some(call=>call.state==='failed')&&old.person_id===actor.personId&&old.account_id===actor.accountId&&old.auth_version===actor.authVersion){
              await db.query("UPDATE business.document_jobs SET state='pending',error_code=NULL,updated_at=now() WHERE id=$1",[old.id]);
              const resumed=(await db.query("UPDATE business.work_items SET state='pending',error_code=NULL,attempts=0,epoch=epoch+1,lease_until=NULL,available_at=now(),updated_at=now() WHERE owner_type='DocumentJob' AND owner_id=$1 AND state IN ('canceled','rejected') RETURNING id,epoch",[old.id])).rows[0];
              if(!resumed)throw new AppError(409,'signature_work_missing');
              await db.query('INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,$3,$4)',[randomUUID(),resumed.id,`work.available.epoch.${resumed.epoch}`,old.id]);
              await audit(db,{actorId:actor.accountId,targetId:old.id,action:'document:signature_resumed'});
              return {jobId:old.id,status:'pending',reused:true};
            }
          }
          return {jobId:old.id,status:old.state,reused:true};
        }
        const result=await accept(db,c,doc,{parseRevision:parse.id,directoryRevision,inputSha256:hash,reviewReleaseId:snapshot.configurationReleaseId,reason:input.reason});
        await db.query('INSERT INTO business.signature_review_snapshots(job_id,input_hash,body) VALUES($1,$2,$3)',[result.jobId,hash,JSON.stringify(snapshot)]);return {...result,reused:false};
      });
    });
  }
  async read(db:PoolClient,actor:Actor,caseId:string,documentId:string,bundle:DocumentBundle,directoryRevision:number,reviewId?:string):Promise<SignatureReviewProjection>{
    const c=await authorizeCase(db,actor,caseId,'evidence:read',false),doc=(await db.query('SELECT current_parse_job_id,sha256 FROM business.document_versions WHERE id=$1 AND case_id=$2',[documentId,caseId])).rows[0];
    const job=(await db.query("SELECT j.*,s.input_hash,s.body AS snapshot FROM business.document_jobs j JOIN business.signature_review_snapshots s ON s.job_id=j.id WHERE j.document_version_id=$1 AND j.input->>'parseRevision'=$2 AND ($3::uuid IS NULL OR j.id=$3) ORDER BY j.created_at DESC LIMIT 1",[documentId,bundle.scope.parseRevision,reviewId??null])).rows[0];
    if(job&&stableHash(job.snapshot)!==job.input_hash)throw new AppError(409,'signature_snapshot_integrity_failed');
    if(reviewId&&!job)throw new AppError(404,'signature_review_not_found');
    const history=(await db.query("SELECT id,created_at,state,validity FROM business.document_jobs WHERE document_version_id=$1 AND kind='review_signatures' AND input->>'parseRevision'=$2 ORDER BY created_at DESC LIMIT 100",[documentId,bundle.scope.parseRevision])).rows.map(row=>({reviewId:row.id,createdAt:row.created_at.toISOString(),status:row.state,validity:row.validity}));
    const historical=Boolean(reviewId&&reviewId!==history[0]?.reviewId);
    const current=Boolean(job&&job.validity==='current'&&job.expected_revision===c.revision&&job.input.directoryRevision===directoryRevision&&doc.current_parse_job_id===bundle.scope.parseRevision&&doc.sha256===job.snapshot.sourceSha256&&job.snapshot.configurationReleaseId===(c.configuration_release_id??null));
    const enabled=this.enabled(caseId,documentId),allowed:SignatureReviewProjection['allowedActions']=[];
    if(!historical&&enabled&&doc.current_parse_job_id===bundle.scope.parseRevision)try{const writable=await authorizeCase(db,actor,caseId,'document:parse',false);await assertDocumentRound(db,writable,documentId);allowed.push('check');if(current&&job.person_id===actor.personId&&['pending','running'].includes(job.state))allowed.push('cancel');}catch(error){if(!(error instanceof AppError))throw error;}
    if(!historical&&current&&['ready','partial'].includes(job.state))try{const writable=await authorizeCase(db,actor,caseId,'field:correct',false);await assertDocumentRound(db,writable,documentId);allowed.push('confirm');}catch(error){if(!(error instanceof AppError))throw error;}
    const receipts=job?(await db.query('SELECT body,body_hash FROM business.signature_page_receipts WHERE job_id=$1 ORDER BY page_number',[job.id])).rows:[];
    for(const row of receipts)if(stableHash(row.body)!==row.body_hash)throw new AppError(409,'signature_receipt_integrity_failed');
    const observations=receipts.flatMap(r=>z.array(SignatureObservationSchema).parse(r.body.observations));
    const confirmations=job?(await db.query('SELECT body FROM business.signature_confirmations WHERE job_id=$1 ORDER BY created_at,id',[job.id])).rows.map(row=>SignatureConfirmationSchema.parse(row.body)):[];
    const snapshot:SignatureSnapshot|undefined=job?.snapshot;
    const coverage={expectedPages:snapshot?.pageCount??bundle.pageCount??0,completedPages:receipts.map(r=>r.body.pageNumber as number),uncertainPages:receipts.filter(r=>r.body.coverage!=='complete').map(r=>r.body.pageNumber as number),gaps:[...new Set([...receipts.flatMap(r=>r.body.issues as string[]),...(snapshot?.requirementsTruncated?['requirements_truncated']:[])])]};
    const latest=new Map(confirmations.filter(c=>c.requirementId).map(c=>[c.requirementId,c]));
    const requirements=(snapshot?.requirements??[]).map(r=>{const change=latest.get(r.requirement.id);return change?.action==='adopt_requirement'?{...r,requirement:change.requirement??r.requirement,status:'adopted' as const}:change?.action==='exclude_requirement'?{...r,status:'excluded' as const}:r;});
    return SignatureReviewProjectionSchema.parse({schemaVersion:'signature-review.v1',enabled,reviewId:job?.id??null,jobId:job?.id??null,status:!job?'not_started':!current?'stale':job.state,validity:!job?'current':current?'current':'stale',errorCode:job?.error_code??null,parseRevision:bundle.scope.parseRevision,directoryRevision,configurationReleaseId:snapshot?.configurationReleaseId??c.configuration_release_id??null,inputSha256:job?.input_hash??null,sourceSha256:doc.sha256,history,observations,requirements,confirmations,checks:snapshot?evaluateSignatureRequirements({requirements,observations,confirmations,coverageComplete:coverage.completedPages.length===coverage.expectedPages&&!coverage.uncertainPages.length&&!snapshot.requirementsTruncated,classificationKnown:snapshot.classificationKnown,taxonomyIds:snapshot.taxonomyIds}):[],coverage,allowedActions:allowed});
  }
  async fence(db:PoolClient,job:SignatureJob){
    const context=(await db.query(`SELECT d.current_parse_job_id,d.sha256,c.configuration_release_id,(SELECT max(directory_revision) FROM business.document_artifacts WHERE job_id=$3) AS directory_revision FROM business.document_versions d JOIN business.cases c ON c.id=d.case_id WHERE d.id=$1 AND c.id=$2`,[job.document_version_id,job.case_id,job.input.parseRevision])).rows[0];
    if(!context||context.current_parse_job_id!==job.input.parseRevision)throw new AppError(409,'stale_parse_revision');if(Number(context.directory_revision)!==job.input.directoryRevision)throw new AppError(409,'stale_directory_revision');if((context.configuration_release_id??null)!==job.input.reviewReleaseId)throw new AppError(409,'stale_configuration');
    const snapshot=(await db.query('SELECT body FROM business.signature_review_snapshots WHERE job_id=$1',[job.id])).rows[0]?.body;
    if(!snapshot||snapshot.sourceSha256!==context.sha256||snapshot.modelRevision!==this.config.signatureVision?.modelRevision||snapshot.promptVersion!==this.promptVersion)throw new AppError(409,'stale_signature_input');
    if(!this.enabled(job.case_id,job.document_version_id))throw new AppError(409,'signature_vision_unavailable');
  }
  async process(job:SignatureJob,signal:AbortSignal,fence:(db:PoolClient)=>Promise<void>,finish:(db:PoolClient,state:'ready'|'partial',result:unknown)=>Promise<void>,yieldWork:(db:PoolClient)=>Promise<void>){
    if(!this.vision)throw new ServiceError('signature_vision_unavailable');
    const snapshotRow=(await this.pool.query('SELECT input_hash,body FROM business.signature_review_snapshots WHERE job_id=$1',[job.id])).rows[0];if(!snapshotRow)throw new ServiceError('signature_snapshot_missing');const snapshot=snapshotRow.body as SignatureSnapshot;
    if(stableHash(snapshot)!==snapshotRow.input_hash||snapshotRow.input_hash!==job.input.inputSha256)throw new ServiceError('signature_snapshot_integrity_failed');
    const existing=(await this.pool.query('SELECT page_number FROM business.signature_page_receipts WHERE job_id=$1',[job.id])).rows.map(r=>r.page_number as number);
    const next=snapshot.pageHashes.find(p=>!existing.includes(p.pageNumber));
    if(next){await transaction(this.pool,fence);signal.throwIfAborted();const row=(await this.pool.query('SELECT body,image_key,image_version_id,image_sha256 FROM business.document_pages WHERE job_id=$1 AND page_number=$2',[snapshot.parseRevision,next.pageNumber])).rows[0];if(!row||row.image_sha256!==next.imageSha256)throw new ServiceError('signature_page_integrity_failed');const page=DocumentPageArtifactSchema.parse(row.body);if(page.scope.parseRevision!==snapshot.parseRevision||page.scope.documentVersionId!==job.document_version_id||page.scope.sourceSha256!==snapshot.sourceSha256||page.imageSha256!==next.imageSha256)throw new ServiceError('signature_page_integrity_failed');const bytes=await this.store.read(row.image_key,row.image_version_id,this.config.maxPageBytes);if(digest(bytes)!==next.imageSha256)throw new ServiceError('signature_page_integrity_failed');
      const hintedIds=new Set(page.signatures.filter(s=>s.kind!=='image_unclassified').flatMap(s=>s.regionIds));
      const legacyHints=page.regions.filter(r=>hintedIds.has(r.region_id)).flatMap(r=>r.polygons).map(points=>[Math.floor(Math.min(...points.map(p=>p[0]))),Math.floor(Math.min(...points.map(p=>p[1]))),Math.ceil(Math.max(...points.map(p=>p[0]))),Math.ceil(Math.max(...points.map(p=>p[1])))] as [number,number,number,number]).filter(b=>b[2]>b[0]&&b[3]>b[1]&&(b[2]-b[0])*(b[3]-b[1])<page.page.width*page.page.height*0.2);
      const hintBoxes=[...ocrMarkHintBoxes(page),...legacyHints].filter(b=>(b[2]-b[0])*(b[3]-b[1])<page.page.width*page.page.height*0.2);
      const hints=[...new Map(hintBoxes.map(box=>[JSON.stringify(box),box])).values()].slice(0,12);
      const noticeSlots=directorNoticeSignatures(page,snapshot.directoryRevision)?.map(r=>[Math.floor(r.box.x),Math.floor(r.box.y),Math.ceil(r.box.x+r.box.width),Math.ceil(r.box.y+r.box.height)] as [number,number,number,number]);
      const result=await this.vision.reviewPage({pageNumber:next.pageNumber,image:bytes,pageImageHash:next.imageSha256,width:Math.round(page.page.width),height:Math.round(page.page.height),hintBoxes:hints,...(noticeSlots?.length?{signingSlotBoxes:noticeSlots}:{})},{signal,beforeSend:async()=>{await transaction(this.pool,fence);},dispatch:signatureDispatch(this.pool,job.id,fence)});
      if(result.pageNumber!==next.pageNumber||result.pageImageHash!==next.imageSha256||result.width!==Math.round(page.page.width)||result.height!==Math.round(page.page.height)||result.model!==this.config.signatureVision?.model||result.modelRevision!==snapshot.modelRevision||result.promptVersion!==snapshot.promptVersion)throw new ServiceError('signature_vision_scope_mismatch');
      const observations:SignatureObservation[]=result.observations.map((o,index)=>SignatureObservationSchema.parse({id:`signature:${job.id}:${next.pageNumber}:${index}`,pageNumber:next.pageNumber,kind:o.kind,confidence:Math.round(o.confidence*1e6)/1e6,box:{x:o.bbox[0],y:o.bbox[1],width:o.bbox[2]-o.bbox[0],height:o.bbox[3]-o.bbox[1]},imageSha256:next.imageSha256,cropSha256:o.cropSha256,sourceSha256:snapshot.sourceSha256,parseRevision:snapshot.parseRevision,coordinateSpace:'page_image',imageWidth:Math.round(page.page.width),imageHeight:Math.round(page.page.height),cropTransform:{offsetX:o.cropToPage[4],offsetY:o.cropToPage[5],scaleX:o.cropToPage[0],scaleY:o.cropToPage[3]},model:result.model,modelVersion:result.modelRevision,promptVersion:snapshot.promptVersion,anchorIds:[],coverageGaps:result.issues}));
      const receipt={pageNumber:next.pageNumber,imageSha256:next.imageSha256,observations,coverage:result.coverage,issues:result.issues};
      await transaction(this.pool,async db=>{await fence(db);signal.throwIfAborted();await db.query('INSERT INTO business.signature_page_receipts(job_id,page_number,body,body_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[job.id,next.pageNumber,JSON.stringify(receipt),stableHash(receipt)]);await db.query('UPDATE business.document_jobs SET completed_pages=(SELECT count(*) FROM business.signature_page_receipts WHERE job_id=$1) WHERE id=$1',[job.id]);await yieldWork(db);});return;
    }
    await transaction(this.pool,async db=>{await fence(db);const receipts=(await db.query('SELECT body FROM business.signature_page_receipts WHERE job_id=$1',[job.id])).rows;const complete=receipts.length===snapshot.pageCount&&receipts.every(r=>r.body.coverage==='complete')&&!snapshot.requirementsTruncated;await finish(db,complete?'ready':'partial',{signatureReviewId:job.id,inputSha256:snapshotRow.input_hash,completedPages:receipts.length,expectedPages:snapshot.pageCount});});
  }
  async confirm(actor:Actor,caseId:string,documentId:string,raw:unknown){
    const input=SignatureConfirmationCommandSchema.parse(raw);
    return transaction(this.pool,async db=>{const c=await authorizeCase(db,actor,caseId,'field:correct');await assertRoundRequest(db,c,input.roundId,{draft:true});await assertDocumentRound(db,c,documentId);if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
      return idempotent(db,actor,`document.signature-confirm:${documentId}`,input.idempotencyKey,input,async()=>{
        const context=await this.context(db,actor,caseId,documentId),projection=await this.read(db,actor,caseId,documentId,context.bundle,context.directoryRevision);
        if(!projection.allowedActions.includes('confirm')||projection.reviewId!==input.reviewId||projection.inputSha256!==input.expectedInputSha256)throw new AppError(409,'stale_signature_review');
        const observation=projection.observations.find(o=>o.id===input.observationId),requirement=projection.requirements.find(r=>r.requirement.id===input.requirementId);
        if(['accept','exclude'].includes(input.action)){if(!observation||input.requirementId||input.requirement||input.transactionFacts)throw new AppError(422,'signature_confirmation_invalid');if(input.action==='exclude'&&(input.identity||input.observedKind))throw new AppError(422,'signature_confirmation_invalid');}
        if(['adopt_requirement','exclude_requirement'].includes(input.action)){if(!requirement||requirement.source!=='document_clause'||input.observationId||input.identity||input.transactionFacts||input.observedKind)throw new AppError(422,'signature_requirement_not_candidate');if(input.requirement&&(input.requirement.id!==requirement.requirement.id||JSON.stringify(input.requirement.sourceIds)!==JSON.stringify(requirement.requirement.sourceIds)||input.requirement.taxonomyIds.some(id=>!context.bundle.logicalDocuments.some(d=>d.labelId===id))))throw new AppError(422,'signature_requirement_source_mismatch');}
        if(input.action==='set_transaction'&&(!input.transactionFacts||input.observationId||input.requirementId||input.identity||input.requirement||input.observedKind))throw new AppError(422,'signature_transaction_invalid');
        if(input.identity)await this.validateIdentity(db,caseId,input.identity);
        const confirmation:SignatureConfirmation=SignatureConfirmationSchema.parse({id:randomUUID(),reviewId:input.reviewId,observationId:input.observationId??null,requirementId:input.requirementId??null,action:input.action,identity:input.identity??null,requirement:input.requirement??null,transactionFacts:input.transactionFacts??null,observedKind:input.observedKind??null,actorId:actor.accountId,reason:input.reason,createdAt:new Date().toISOString()});
        await db.query('INSERT INTO business.signature_confirmations(id,job_id,case_id,case_revision,input_hash,body) VALUES($1,$2,$3,$4,$5,$6)',[confirmation.id,input.reviewId,caseId,c.revision,input.expectedInputSha256,JSON.stringify(confirmation)]);
        await audit(db,{actorId:actor.accountId,targetId:input.reviewId,action:'document:signature_confirmed',details:{confirmationId:confirmation.id,action:input.action}});
        return {confirmationId:confirmation.id,reviewId:input.reviewId};
      });
    });
  }
  private async validateIdentity(db:PoolClient,caseId:string,identity:NonNullable<SignatureConfirmation['identity']>){
    const objects=(await db.query('SELECT DISTINCT ON(object_id) object_id,body,validity FROM business.review_object_versions WHERE case_id=$1 ORDER BY object_id,version DESC',[caseId])).rows;
    const person=objects.find(o=>o.object_id===identity.personId&&o.validity==='current'&&o.body.kind==='signatory'&&o.body.role===identity.role&&o.body.evidence?.length),subject=objects.find(o=>o.object_id===identity.subjectId&&o.validity==='current'&&o.body.kind==='party'&&o.body.role===identity.subjectRole&&o.body.evidence?.length);
    if(!person||!subject)throw new AppError(422,'signature_identity_not_confirmed');
    const references=[...(person.body.evidence??[]),...(subject.body.evidence??[])];
    const anchors=new Set<string>();
    const c=(await db.query('SELECT current_round_id FROM business.cases WHERE id=$1',[caseId])).rows[0];
    const materials=(await reviewMaterials(db,caseId,c?.current_round_id??null)).filter(m=>m.operation==='adopt');
    for(const material of materials){const row=(await db.query('SELECT d.current_parse_job_id,(SELECT max(directory_revision) FROM business.document_artifacts WHERE job_id=d.current_parse_job_id) AS latest,a.body FROM business.document_versions d JOIN business.document_artifacts a ON a.job_id=$2 AND a.directory_revision=$3 WHERE d.id=$1 AND d.case_id=$4',[material.documentVersionId,material.parseRevision,material.directoryRevision,caseId])).rows[0];if(!row||row.current_parse_job_id!==material.parseRevision||Number(row.latest)!==material.directoryRevision)continue;for(const a of row.body.anchors??[])anchors.add(a.anchor_id);}
    if(references.some(e=>!e.anchorId||!anchors.has(e.anchorId))||identity.authorization?.sourceAnchorIds.some(id=>!anchors.has(id)))throw new AppError(422,'signature_authorization_evidence_invalid');
  }
}
function stableHash(value:unknown):string {const sort=(v:any):any=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;return inputHash(sort(value));}
