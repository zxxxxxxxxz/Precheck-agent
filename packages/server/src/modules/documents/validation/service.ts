import { randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { MockValidationCommandSchema,MockValidationRunSchema,MockValidationRunSummarySchema,MockValidationResultSchema,type MockValidationCommand,type MockValidationRunSummary } from '@hsbc/contracts/mock-validation';
import { AppError } from '../../../shared/errors.js';
import { audit } from '../../audit/events.js';
import { authorizeCase } from '../../cases/authorization.js';
import { idempotent } from '../../../infrastructure/database/idempotency.js';
import { transaction } from '../../../infrastructure/database/client.js';
import { type Actor } from '../../identity/types.js';
import { OcrInferenceClient } from '../../../infrastructure/integrations/inference.js';
import { ServiceError,type ServiceConfig } from '../../../infrastructure/integrations/http.js';
import type { ObjectStore,UploadConfig } from '../../../infrastructure/integrations/oss.js';
import type { ClaimedWork } from '../../../infrastructure/jobs/types.js';
import { compareMockOcr,DEFAULT_MOCK_FONT,mockDigest,renderMockPage,validateOverlayGeometry,type MockFontConfig } from './image.js';

export interface MockValidationConfig {enabled:boolean;reader:boolean;ocr?:ServiceConfig;leaseSeconds:number;maxPageBytes:number;maxPixels?:number;font?:MockFontConfig}
type MockJob={id:string;case_id:string;document_version_id:string;source_parse_revision:string;page_number:number;source_sha256:string;source_page_sha256:string;
  source_page_key:string;source_page_version_id:string;width:number;height:number;account_id:string;person_id:string;auth_version:number;expected_revision:number;
  input:MockValidationCommand;input_fingerprint:string;font_sha256:string;font_family:string;state:MockValidationRunSummary['status'];image_key:string|null;image_version_id:string|null;image_sha256:string|null;
  result:unknown;error_code:string|null;created_at:Date};
const actorOf=(j:MockJob):Actor=>({accountId:j.account_id,personId:j.person_id,authVersion:j.auth_version});
const fingerprint=(caseId:string,documentId:string,input:MockValidationCommand,font:MockFontConfig)=>mockDigest(JSON.stringify({namespace:'mock-ocr.v1',caseId,documentId,input,fontSha256:font.sha256,fontFamily:font.family,renderer:'canvas-overlay.v1'}));
const summary=(j:MockJob)=>MockValidationRunSummarySchema.parse({id:j.id,documentVersionId:j.document_version_id,sourceParseRevision:j.source_parse_revision,pageNumber:j.page_number,status:j.state,createdAt:j.created_at.toISOString(),errorCode:j.error_code,synthetic:true,purpose:'mock_ocr_validation'});

/** Independent evaluation owner. This service never writes canonical document tables. */
export class MockValidationService {
  private stopping=false;
  private active=new Set<AbortController>();
  private readonly ocr?:OcrInferenceClient;
  private readonly font:MockFontConfig;
  constructor(readonly pool:Pool,readonly store:ObjectStore,readonly upload:UploadConfig,readonly config:MockValidationConfig){
    if(config.leaseSeconds<30||config.maxPageBytes<1||config.maxPageBytes>20*1024*1024||(config.maxPixels!==undefined&&(config.maxPixels<1||config.maxPixels>16_000_000)))throw new Error('invalid_mock_budget');
    if(config.ocr)this.ocr=new OcrInferenceClient(config.ocr);
    this.font=config.font??DEFAULT_MOCK_FONT;
  }
  stop(){this.stopping=true;for(const controller of this.active)controller.abort();}
  private readEnabled(){if(!this.config.reader)throw new AppError(409,'capability_disabled');}
  private async document(db:PoolClient,caseId:string,documentId:string,lock=false){
    const d=(await db.query(`SELECT d.* FROM business.document_versions d JOIN business.upload_sessions u ON u.id=d.upload_session_id
      WHERE d.id=$1 AND d.case_id=$2 AND u.state='registered' AND u.document_version_id=d.id ${lock?'FOR UPDATE OF d':''}`,[documentId,caseId])).rows[0];
    if(!d)throw new AppError(404,'material_not_found');return d;
  }
  private async source(db:PoolClient,caseId:string,documentId:string,input:MockValidationCommand,lock=false){
    const doc=await this.document(db,caseId,documentId,lock);
    if(doc.sha256!==input.sourceSha256)throw new AppError(409,'mock_source_hash_mismatch');
    const page=(await db.query(`SELECT p.* FROM business.document_pages p JOIN business.document_jobs j ON j.id=p.job_id
      WHERE p.job_id=$1 AND p.page_number=$2 AND j.case_id=$3 AND j.document_version_id=$4 AND j.kind='parse_document'`,[input.sourceParseRevision,input.pageNumber,caseId,documentId])).rows[0];
    if(!page)throw new AppError(409,'page_not_ready');
    if(page.image_sha256!==input.sourcePageSha256)throw new AppError(409,'mock_source_page_mismatch');
    return {doc,page};
  }
  /** Called only by the explicit-actor operator CLI, never exposed as an HTTP POST. */
  async create(actor:Actor,caseId:string,documentId:string,raw:unknown){
    if(!this.config.enabled)throw new AppError(409,'capability_disabled');
    if(!this.ocr)throw new AppError(409,'mock_ocr_unavailable');
    const input=MockValidationCommandSchema.parse(raw);
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'document:parse');await authorizeCase(db,actor,caseId,'evidence:read',false);
      if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
      return idempotent(db,actor,`mock.create:${documentId}`,input.idempotencyKey,input,async()=>{
        const {doc,page}=await this.source(db,caseId,documentId,input,true);
        if(doc.current_parse_job_id!==input.sourceParseRevision)throw new AppError(409,'stale_parse_revision');
        const width=Number(page.body.page.width),height=Number(page.body.page.height);
        if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width*height>(this.config.maxPixels??16_000_000))throw new AppError(422,'mock_pixel_budget_exceeded');
        validateOverlayGeometry(input.overlays,width,height);
        const id=randomUUID(),workId=randomUUID();
        await db.query(`INSERT INTO business.mock_validation_jobs(id,case_id,document_version_id,source_parse_revision,page_number,source_sha256,source_page_sha256,source_page_key,source_page_version_id,width,height,account_id,person_id,auth_version,expected_revision,input,input_fingerprint,font_sha256,font_family)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,[id,caseId,documentId,input.sourceParseRevision,input.pageNumber,input.sourceSha256,input.sourcePageSha256,page.image_key,page.image_version_id,width,height,actor.accountId,actor.personId,actor.authVersion,c.revision,JSON.stringify(input),fingerprint(caseId,documentId,input,this.font),this.font.sha256,this.font.family]);
        await db.query("INSERT INTO business.work_items(id,owner_type,owner_id,kind,queue) VALUES($1,'MockValidationJob',$2,'mock_ocr_validation','document')",[workId,id]);
        await db.query("INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,'work.available',$3)",[randomUUID(),workId,id]);
        await audit(db,{actorId:actor.accountId,targetId:id,action:'mock_validation:created',details:{caseId,documentId,pageNumber:input.pageNumber,synthetic:true}});
        return {id,status:'pending' as const};
      });
    });
  }
  async list(actor:Actor,caseId:string,documentId:string){
    this.readEnabled();return transaction(this.pool,async db=>{
      await authorizeCase(db,actor,caseId,'evidence:read',false);await this.document(db,caseId,documentId);
      const rows=(await db.query('SELECT * FROM business.mock_validation_jobs WHERE case_id=$1 AND document_version_id=$2 ORDER BY created_at DESC LIMIT 100',[caseId,documentId])).rows as MockJob[];
      return {items:rows.map(summary)};
    });
  }
  private async readJob(db:PoolClient,actor:Actor,caseId:string,documentId:string,id:string){
    await authorizeCase(db,actor,caseId,'evidence:read',false);await this.document(db,caseId,documentId);
    const job=(await db.query('SELECT * FROM business.mock_validation_jobs WHERE id=$1 AND case_id=$2 AND document_version_id=$3',[id,caseId,documentId])).rows[0] as MockJob|undefined;
    if(!job)throw new AppError(404,'mock_run_not_found');return job;
  }
  async get(actor:Actor,caseId:string,documentId:string,id:string){
    this.readEnabled();return transaction(this.pool,async db=>{
      const j=await this.readJob(db,actor,caseId,documentId,id);
      return MockValidationRunSchema.parse({...summary(j),sourceSha256:j.source_sha256,sourcePageSha256:j.source_page_sha256,mockImageSha256:j.image_sha256,width:j.width,height:j.height,overlays:j.input.overlays,result:j.result});
    });
  }
  async image(actor:Actor,caseId:string,documentId:string,id:string,kind:'original'|'mock'){
    this.readEnabled();if(kind!=='original'&&kind!=='mock')throw new AppError(404,'mock_image_not_found');
    const j=await transaction(this.pool,db=>this.readJob(db,actor,caseId,documentId,id));
    const key=kind==='original'?j.source_page_key:j.image_key,version=kind==='original'?j.source_page_version_id:j.image_version_id,hash=kind==='original'?j.source_page_sha256:j.image_sha256;
    if(!key||!version||!hash)throw new AppError(409,'mock_image_not_ready');
    const bytes=await this.store.read(key,version,this.config.maxPageBytes);
    if(mockDigest(bytes)!==hash)throw new AppError(409,'mock_image_integrity_failed');
    await transaction(this.pool,db=>this.readJob(db,actor,caseId,documentId,id));return bytes;
  }
  /** Operator cancellation is scoped to the submitting person; no public mutation route. */
  async cancel(actor:Actor,caseId:string,documentId:string,id:string){
    return transaction(this.pool,async db=>{
      await authorizeCase(db,actor,caseId,'document:parse');const job=await this.readJob(db,actor,caseId,documentId,id);
      if(job.person_id!==actor.personId)throw new AppError(404,'mock_run_not_found');
      const updated=await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL,updated_at=now() WHERE owner_type='MockValidationJob' AND owner_id=$1 AND state IN ('pending','running') RETURNING id",[id]);
      if(updated.rowCount){await db.query("UPDATE business.mock_validation_jobs SET state='canceled',updated_at=now() WHERE id=$1",[id]);await audit(db,{actorId:actor.accountId,targetId:id,action:'mock_validation:canceled'});}
      return {id,status:updated.rowCount?'canceled' as const:job.state};
    });
  }
  async claim(workId?:string):Promise<ClaimedWork|undefined>{
    if(!this.config.enabled||this.stopping)return undefined;
    return (await this.pool.query(`UPDATE business.work_items SET state='running',attempts=attempts+1,epoch=epoch+1,lease_until=now()+$2*interval '1 second',updated_at=now()
      WHERE id=(SELECT w.id FROM business.work_items w JOIN business.mock_validation_jobs j ON j.id=w.owner_id WHERE w.owner_type='MockValidationJob'
        AND j.state IN ('pending','running') AND w.available_at<=now() AND (w.state='pending' OR w.state='running' AND w.lease_until<now())
        AND ($1::uuid IS NULL OR w.id=$1) ORDER BY w.available_at FOR UPDATE OF w SKIP LOCKED LIMIT 1) RETURNING *`,[workId??null,this.config.leaseSeconds])).rows[0];
  }
  private async fence(db:PoolClient,job:MockJob,work:ClaimedWork){
    if(this.stopping)throw new AppError(409,'worker_stopping');
    const actor=actorOf(job),c=await authorizeCase(db,actor,job.case_id,'document:parse');await authorizeCase(db,actor,job.case_id,'evidence:read',false);
    if(c.revision!==job.expected_revision)throw new AppError(409,'stale_revision');
    const input=MockValidationCommandSchema.parse(job.input);
    if(job.font_sha256!==this.font.sha256||job.font_family!==this.font.family)throw new AppError(409,'mock_font_configuration_changed');
    if(fingerprint(job.case_id,job.document_version_id,input,this.font)!==job.input_fingerprint)throw new AppError(409,'mock_input_integrity_failed');
    const {doc,page}=await this.source(db,job.case_id,job.document_version_id,input,true);
    if(doc.current_parse_job_id!==job.source_parse_revision)throw new AppError(409,'stale_parse_revision');
    if(page.image_key!==job.source_page_key||page.image_version_id!==job.source_page_version_id)throw new AppError(409,'mock_source_page_mismatch');
    const j=(await db.query('SELECT state FROM business.mock_validation_jobs WHERE id=$1',[job.id])).rows[0];
    if(!j||!['pending','running'].includes(j.state))throw new AppError(409,'stale_mock_run');
    const lease=await db.query("SELECT id FROM business.work_items WHERE id=$1 AND owner_type='MockValidationJob' AND owner_id=$3 AND epoch=$2 AND state='running' AND lease_until>now() FOR UPDATE",[work.id,work.epoch,job.id]);
    if(!lease.rowCount)throw new AppError(409,'lease_lost');return doc;
  }
  async processWork(work:ClaimedWork){
    const job=(await this.pool.query('SELECT * FROM business.mock_validation_jobs WHERE id=$1',[work.owner_id])).rows[0] as MockJob|undefined;if(!job)return;
    const controller=new AbortController();this.active.add(controller);let renewing=false,fenceFailure:unknown;
    const timer=setInterval(()=>{
      if(renewing)return;renewing=true;
      void transaction(this.pool,async db=>{
        await this.fence(db,job,work);
        await db.query("UPDATE business.work_items SET lease_until=now()+$3*interval '1 second' WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now()",[work.id,work.epoch,this.config.leaseSeconds]);
      }).catch(error=>{fenceFailure=error;controller.abort();}).finally(()=>{renewing=false;});
    },Math.min(10000,this.config.leaseSeconds*1000/3));
    const abandoned:Array<{key:string;version:string}>=[];
    try{
      if(work.attempts>work.max_attempts)throw new ServiceError('work_attempts_exhausted');
      if(!this.ocr)throw new ServiceError('mock_ocr_unavailable');
      const doc=await transaction(this.pool,async db=>{const d=await this.fence(db,job,work);await db.query("UPDATE business.mock_validation_jobs SET state='running',error_code=NULL,updated_at=now() WHERE id=$1",[job.id]);return d;});
      const original=await this.store.read(doc.object_key,doc.oss_version_id,this.upload.maxBytes);
      if(mockDigest(original)!==job.source_sha256)throw new ServiceError('original_integrity_failed');
      const page=await this.store.read(job.source_page_key,job.source_page_version_id,this.config.maxPageBytes);
      if(mockDigest(page)!==job.source_page_sha256)throw new ServiceError('page_integrity_failed');
      const rendered=await renderMockPage(page,job.input.overlays,{maxPixels:this.config.maxPixels,maxBytes:Math.min(this.config.maxPageBytes,10*1024*1024),font:this.font});
      if(rendered.width!==job.width||rendered.height!==job.height)throw new ServiceError('mock_image_dimensions_mismatch');
      await transaction(this.pool,db=>this.fence(db,job,work));controller.signal.throwIfAborted();
      // Only the encoded image and fixed protocol flags cross the OCR boundary.
      const response=await this.ocr.parse(rendered.png,{returnWordBox:true,signal:controller.signal});controller.signal.throwIfAborted();
      const result=compareMockOcr(job.id,rendered.png,job.input.overlays,response,rendered.fontSha256);
      if(Buffer.byteLength(JSON.stringify(result))>20*1024*1024)throw new ServiceError('mock_result_budget_exceeded');
      await transaction(this.pool,db=>this.fence(db,job,work));
      if(!this.store.put)throw new ServiceError('derived_storage_unavailable');
      const key=`${this.upload.prefix}derived/mock-validation/${job.id}/e${work.epoch}-${randomUUID()}.png`,object=await this.store.put(key,rendered.png,'image/png');abandoned.push({key,version:object.versionId});
      await transaction(this.pool,async db=>{
        await this.fence(db,job,work);controller.signal.throwIfAborted();
        await db.query('UPDATE business.mock_validation_jobs SET state=$2,image_key=$3,image_version_id=$4,image_sha256=$5,result=$6,error_code=NULL,updated_at=now() WHERE id=$1',[job.id,result.coverageGaps.length?'partial':'ready',key,object.versionId,rendered.imageSha256,JSON.stringify(MockValidationResultSchema.parse(result))]);
        await db.query("UPDATE business.work_items SET state='succeeded',lease_until=NULL,updated_at=now() WHERE id=$1 AND epoch=$2",[work.id,work.epoch]);
        await db.query('INSERT INTO business.inbox(work_item_id,epoch) VALUES($1,$2) ON CONFLICT DO NOTHING',[work.id,work.epoch]);
        await audit(db,{actorId:job.account_id,targetId:job.id,action:'mock_validation:completed',details:{synthetic:true,matched:result.comparisons.filter(c=>c.matched).length,total:result.comparisons.length}});
      });abandoned.length=0;
    }catch(error){if(!this.stopping)await this.fail(job,work,fenceFailure??error);}finally{
      clearInterval(timer);controller.abort();this.active.delete(controller);
      for(const object of abandoned)await this.store.deleteVersion(object.key,object.version).catch(()=>undefined);
    }
  }
  private async fail(job:MockJob,work:ClaimedWork,error:unknown){
    const code=error instanceof AppError||error instanceof ServiceError?error.code:'mock_processing_failed';
    const retry=error instanceof ServiceError&&error.retryable&&work.attempts<work.max_attempts;
    await transaction(this.pool,async db=>{
      await db.query('SELECT id FROM business.cases WHERE id=$1 FOR UPDATE',[job.case_id]);
      const updated=await db.query("UPDATE business.work_items SET state=$3,error_code=$4,lease_until=NULL,available_at=now()+interval '5 seconds',updated_at=now() WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now() RETURNING id",[work.id,work.epoch,retry?'pending':'rejected',code]);
      if(updated.rowCount)await db.query('UPDATE business.mock_validation_jobs SET state=$2,error_code=$3,updated_at=now() WHERE id=$1',[job.id,retry?'pending':code.startsWith('stale_')?'stale':'failed',code]);
    });
  }
}

export function registerMockValidation(pool:Pool,store:ObjectStore,upload:UploadConfig,config:MockValidationConfig){return new MockValidationService(pool,store,upload,config);}
