import {reviewHash as inputHash} from '../review/service.js';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {SupplementCommandSchema,SUPPLEMENTAL_MATERIAL_ID,type SupplementState,type SupplementJob} from '@hsbc/contracts/case-supplement';
import type {AnalysisEvidence} from '@hsbc/contracts/review-delivery';
import {transaction} from '../../infrastructure/database/client.js';
import {idempotent} from '../../infrastructure/database/idempotency.js';
import {QwenClient} from '../../infrastructure/integrations/inference.js';
import {ServiceError} from '../../infrastructure/integrations/http.js';
import {AppError} from '../../shared/errors.js';
import type {Actor} from '../identity/types.js';
import type {Auth} from '../identity/auth.js';
import {authorizeCase,canEditReview} from '../cases/authorization.js';
import {hasGrant} from '../identity/authorization.js';
import {assertRoundRequest} from '../review/round-boundary.js';
import {materialMembership} from '../materials/review-scope.js';
import {audit} from '../audit/events.js';
import type {DocumentService} from '../documents/service.js';
import {fixedMaterialType} from '../documents/content-classification.js';
import {evidenceFromBundle} from '../review-delivery/semantic.js';
import type {ReviewAssistConfig,AssistChat} from '../review-delivery/model.js';
import {runSupplement,SUPPLEMENT_MODEL_VERSION} from './model.js';

type Pin={documentVersionId:string;parseRevision:string;directoryRevision:number;artifactHash:string;sourceSha256:string};
interface Input {request:string;documentIds:string[];pins:Pin[];evidence:AnalysisEvidence[];modelVersion:string}
interface Row {id:string;case_id:string;round_id:string|null;account_id:string;person_id:string;auth_version:number;session_key:string|null;expected_revision:number;state:SupplementJob['state'];input:Input;input_hash:string;result:{output:SupplementJob['output'];simulated:boolean}|null;error_code:string|null;created_at:Date}
interface Work {id:string;owner_id:string;epoch:number}
const actorOf=(r:Row):Actor=>({accountId:r.account_id,personId:r.person_id,authVersion:r.auth_version,...(r.session_key?{sessionKey:r.session_key}:{})});

/** Owns only supplementary notes. No write port to review fields, rules, facts or findings. */
export class CaseSupplementService {
  private active=new Set<AbortController>();private stopping=false;private client?:AssistChat;
  constructor(readonly pool:Pool,readonly documents:Pick<DocumentService,'reviewBundle'>,readonly config?:ReviewAssistConfig,client?:AssistChat){this.config=config?.service.hostedQwen?undefined:config;this.client=client??(this.config?new QwenClient(this.config.service,this.config.model,pool):undefined);}
  stop(){this.stopping=true;for(const controller of this.active)controller.abort();}
  private modelVersion(){return inputHash([this.config?.model,this.config?.modelRevision,SUPPLEMENT_MODEL_VERSION]);}
  private async authorize(db:PoolClient,actor:Actor,caseId:string,write=false){
    const c=await authorizeCase(db,actor,caseId,'evidence:read',write);
    if(write){if(!await hasGrant(db,actor.personId,'review:analyze',caseId))throw new AppError(403,'permission_denied');
      if(c.closed_at)throw new AppError(409,'case_closed');if(c.scenario!=='overseas_loan')throw new AppError(409,'scenario_confirmation_required');
      if(!await canEditReview(db,c,actor.personId))throw new AppError(403,'maker_assignment_required');}
    return c;
  }
  private async pins(db:PoolClient,caseId:string,roundId:string|null,ids:string[]):Promise<Pin[]> {
    const members=await materialMembership(db,caseId,roundId);
    if(ids.some(id=>!members.documents.some(d=>d.id===id)))throw new AppError(409,'supplement_material_scope');
    const pins:Pin[]=[];
    for(const id of ids){
      const row=(await db.query(`SELECT d.id,d.sha256,d.current_parse_job_id,a.directory_revision,a.sha256 AS artifact_hash
        FROM business.document_versions d JOIN business.document_jobs j ON j.id=d.current_parse_job_id AND j.case_id=d.case_id
        JOIN LATERAL (SELECT directory_revision,sha256 FROM business.document_artifacts WHERE job_id=j.id ORDER BY directory_revision DESC LIMIT 1) a ON true
        WHERE d.id=$1 AND d.case_id=$2 AND j.validity='current'`,[id,caseId])).rows[0];
      if(!row)throw new AppError(409,'supplement_source_unavailable');
      pins.push({documentVersionId:row.id,parseRevision:row.current_parse_job_id,directoryRevision:row.directory_revision,artifactHash:row.artifact_hash,sourceSha256:row.sha256});
    }
    return pins;
  }
  private async current(db:PoolClient,c:any,row:Row){
    if(c.revision!==row.expected_revision||(c.current_round_id??null)!==row.round_id)return false;
    try{return inputHash(await this.pins(db,row.case_id,row.round_id,row.input.documentIds))===inputHash(row.input.pins);}
    catch(error){if(error instanceof AppError)return false;throw error;}
  }
  async state(actor:Actor,caseId:string,roundId:string|null):Promise<SupplementState>{return transaction(this.pool,async db=>{
    const c=await this.authorize(db,actor,caseId);let canRequest=false;
    if(roundId&&(await db.query('SELECT id FROM business.review_rounds WHERE id=$1 AND case_id=$2',[roundId,caseId])).rowCount!==1)throw new AppError(404,'review_round_not_found');
    try{await this.authorize(db,actor,caseId,true);await assertRoundRequest(db,c,roundId??undefined);canRequest=true;}catch(error){if(!(error instanceof AppError))throw error;}
    const membership=await materialMembership(db,caseId,roundId),documents:SupplementState['documents']=[];
    for(const d of membership.documents){
      const artifact=(await db.query('SELECT body->\'logicalDocuments\' AS directory FROM business.document_artifacts WHERE job_id=$1 ORDER BY directory_revision DESC LIMIT 1',[d.current_parse_job_id])).rows[0];
      const logical=(artifact?.directory??[]).filter((r:any)=>!r.id.startsWith('source-document:'));
      documents.push({id:d.id,filename:d.filename,supplemental:logical.length>0&&logical.every((r:any)=>r.labelId===SUPPLEMENTAL_MATERIAL_ID),available:!!artifact});
    }
    const rows=(await db.query('SELECT * FROM business.case_supplement_jobs WHERE case_id=$1 AND person_id=$2 AND round_id IS NOT DISTINCT FROM $3::uuid ORDER BY created_at DESC,id DESC LIMIT 20',[caseId,actor.personId,roundId])).rows as Row[];
    const items:SupplementJob[]=[];
    for(const row of rows){if(inputHash(row.input)!==row.input_hash)throw new AppError(409,'supplement_snapshot_changed');
      const cited=new Set([...(row.result?.output?.fields??[]),...(row.result?.output?.checks??[])].flatMap(r=>r.citations.map(c=>c.evidenceId)));
      items.push({id:row.id,request:row.input.request,documentIds:row.input.documentIds,state:row.state,validity:await this.current(db,c,row)?'current':'stale',createdAt:new Date(row.created_at).toISOString(),errorCode:row.error_code,output:row.result?.output??null,evidence:row.input.evidence.filter(e=>cited.has(e.id)),simulated:row.result?.simulated??false});}
    return {available:!!this.config,canRequest,documents,items};
  });}
  async create(actor:Actor,caseId:string,raw:unknown){const command=SupplementCommandSchema.parse(raw);return transaction(this.pool,async db=>{
    const c=await this.authorize(db,actor,caseId,true);
    return idempotent(db,actor,`case.supplement:${caseId}`,command.idempotencyKey,command,async()=>{
      if(!this.config)throw new AppError(503,'supplement_unavailable');
      await assertRoundRequest(db,c,command.roundId);
      if(c.revision!==command.expectedRevision)throw new AppError(409,'stale_revision');
      const roundId=c.current_round_id??null,pins=await this.pins(db,caseId,roundId,command.documentIds),evidence:AnalysisEvidence[]=[];
      const membership=await materialMembership(db,caseId,roundId);let hasSupplement=false;
      for(const pin of pins){const bundle=await this.documents.reviewBundle(db,actor,caseId,pin);
        hasSupplement ||= fixedMaterialType(bundle)===SUPPLEMENTAL_MATERIAL_ID;
        const parts=evidenceFromBundle(bundle,membership.documents.find(d=>d.id===pin.documentVersionId)!.filename,true);
        if(!parts.length)throw new AppError(409,'supplement_source_unavailable');evidence.push(...parts);}
      if(!hasSupplement)throw new AppError(422,'supplement_material_required');
      if(evidence.length>48||evidence.some(e=>e.text.length>17000)||JSON.stringify(evidence.map(e=>e.text)).length>48000)throw new AppError(422,'supplement_input_budget');
      if(Number((await db.query("SELECT count(*) AS n FROM business.case_supplement_jobs WHERE case_id=$1 AND state IN ('pending','running')",[caseId])).rows[0].n)>=2)throw new AppError(429,'supplement_queue_full');
      const id=randomUUID(),workId=randomUUID(),input:Input={request:command.request,documentIds:command.documentIds,pins,evidence,modelVersion:this.modelVersion()};
      await db.query(`INSERT INTO business.case_supplement_jobs(id,case_id,round_id,account_id,person_id,auth_version,session_key,expected_revision,state,input,input_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)`,[id,caseId,roundId,actor.accountId,actor.personId,actor.authVersion,actor.sessionKey??null,c.revision,JSON.stringify(input),inputHash(input)]);
      await db.query("INSERT INTO business.work_items(id,owner_type,owner_id,kind,queue,max_attempts) VALUES($1,'Workflow',$2,'case_supplement','workflow',3)",[workId,id]);
      await db.query("INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,'case_supplement_requested',$3)",[randomUUID(),workId,id]);
      await audit(db,{actorId:actor.accountId,targetId:caseId,action:'case.supplement_requested',details:{jobId:id,documentCount:pins.length}});
      return {id};
    });
  });}
  async claim(workId?:string):Promise<Work|undefined>{if(this.stopping)return;return(await this.pool.query(`UPDATE business.work_items SET state='running',epoch=epoch+1,attempts=attempts+1,lease_until=now()+interval '180 seconds',updated_at=now()
    WHERE id=(SELECT w.id FROM business.work_items w JOIN business.case_supplement_jobs j ON j.id=w.owner_id
    WHERE w.owner_type='Workflow' AND w.kind='case_supplement' AND j.state IN ('pending','running') AND w.available_at<=now()
    AND (w.state='pending' OR w.state='running' AND w.lease_until<now()) AND ($1::uuid IS NULL OR w.id=$1)
    ORDER BY w.available_at,w.id FOR UPDATE OF w SKIP LOCKED LIMIT 1) RETURNING *`,[workId??null])).rows[0];}
  private async fence(db:PoolClient,row:Row,work:Work){
    if(this.stopping)throw new AppError(409,'worker_stopping');
    const c=await this.authorize(db,actorOf(row),row.case_id,true);
    if(inputHash(row.input)!==row.input_hash||row.input.modelVersion!==this.modelVersion())throw new AppError(409,'supplement_snapshot_changed');
    if(!await this.current(db,c,row))throw new AppError(409,'supplement_source_stale');
    if(!(await db.query("SELECT id FROM business.work_items WHERE id=$1 AND owner_id=$2 AND epoch=$3 AND state='running' AND lease_until>now() FOR UPDATE",[work.id,row.id,work.epoch])).rowCount)throw new AppError(409,'lease_lost');
  }
  async processWork(work:Work){
    const row=(await this.pool.query('SELECT * FROM business.case_supplement_jobs WHERE id=$1',[work.owner_id])).rows[0] as Row|undefined;if(!row)return;
    const controller=new AbortController();this.active.add(controller);
    const timer=setInterval(()=>{void this.pool.query("UPDATE business.work_items SET lease_until=now()+interval '180 seconds' WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now() RETURNING id",[work.id,work.epoch]).then(r=>{if(!r.rowCount)controller.abort();}).catch(()=>controller.abort());},30000);timer.unref();
    try{
      await transaction(this.pool,async db=>{await this.fence(db,row,work);await db.query("UPDATE business.case_supplement_jobs SET state='running',updated_at=now() WHERE id=$1",[row.id]);});
      if(!this.config||!this.client)throw new AppError(503,'supplement_unavailable');
      let dispatched=false;
      const result=await runSupplement({request:row.input.request,evidence:row.input.evidence,config:this.config,client:this.client,job:row,signal:controller.signal,authorize:()=>transaction(this.pool,db=>this.fence(db,row,work)),dispatch:async(body,start)=>{
        dispatched=true;const hash=inputHash(body),old=await transaction(this.pool,async db=>{
          await this.fence(db,row,work);const prior=(await db.query('SELECT * FROM business.case_supplement_calls WHERE job_id=$1',[row.id])).rows[0];
          if(prior){if(prior.request_hash!==hash)throw new AppError(409,'supplement_call_mismatch');if(prior.state!=='completed')throw new AppError(409,'supplement_call_unknown');return prior;}
          await db.query("INSERT INTO business.case_supplement_calls(job_id,request_hash,state) VALUES($1,$2,'unknown')",[row.id,hash]);return null;
        });
        if(old)return old.response;
        const response=await start();
        // Save the provider receipt even if case edits or revocation prevent publishing it.
        await this.pool.query("UPDATE business.case_supplement_calls SET state='completed',response=$2 WHERE job_id=$1 AND request_hash=$3 AND state='unknown'",[row.id,JSON.stringify(response),hash]);
        return response;
      }});
      if(!dispatched)throw new AppError(409,'supplement_dispatch_missing');
      await transaction(this.pool,async db=>{await this.fence(db,row,work);
        await db.query("UPDATE business.case_supplement_jobs SET state='ready',result=$2,updated_at=now() WHERE id=$1",[row.id,JSON.stringify(result)]);
        await db.query("UPDATE business.work_items SET state='succeeded',lease_until=NULL WHERE id=$1 AND epoch=$2",[work.id,work.epoch]);
        await db.query('INSERT INTO business.inbox(work_item_id,epoch) VALUES($1,$2) ON CONFLICT DO NOTHING',[work.id,work.epoch]);
        await audit(db,{actorId:row.account_id,targetId:row.case_id,action:'case.supplement_completed',details:{jobId:row.id}});
      });
    }catch(error){
      const code=error instanceof AppError||error instanceof ServiceError?error.code:'supplement_failed';
      await transaction(this.pool,async db=>{
        if(!(await db.query("SELECT id FROM business.work_items WHERE id=$1 AND epoch=$2 AND state='running' FOR UPDATE",[work.id,work.epoch])).rowCount)return;
        const call=(await db.query('SELECT state FROM business.case_supplement_calls WHERE job_id=$1',[row.id])).rows[0];
        const unknown=call?.state==='unknown';
        await db.query('UPDATE business.case_supplement_jobs SET state=$2,error_code=$3,updated_at=now() WHERE id=$1',[row.id,unknown?'unknown':'failed',unknown?'supplement_call_unknown':code]);
        await db.query("UPDATE business.work_items SET state='rejected',lease_until=NULL WHERE id=$1 AND epoch=$2",[work.id,work.epoch]);
      });
    }finally{clearInterval(timer);this.active.delete(controller);}
  }
}
export function registerCaseSupplementRoutes(app:FastifyInstance,auth:Auth,service:CaseSupplementService){
  const base='/api/cases/:caseId/assistant/supplements';
  app.get<{Params:{caseId:string}}>(base,async request=>{const q=z.object({roundId:z.uuid().optional()}).parse(request.query);return service.state(await auth.requireSession(request),z.uuid().parse(request.params.caseId),q.roundId??null);});
  app.post<{Params:{caseId:string}}>(base,async(request,reply)=>reply.code(202).send(await service.create(await auth.checkWrite(request),z.uuid().parse(request.params.caseId),request.body)));
}
