import { qwenProvider, qwenRequestBody, hostedAdapter, hostedAuthorization } from '../../infrastructure/integrations/qwen-hosting.js';
import {editableDraftValues, draftValue, setDraftValue} from '../cases/draft-values.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import {DraftFieldSchema,DraftCommandSchema, type DraftField, type IntakeField} from '@hsbc/contracts/draft';
import type { DraftModelRequest,ModelProfile,ModelRequest,ModelResult } from '@hsbc/contracts/model';
import type { Auth } from '../identity/auth.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/events.js';
import { idempotent, inputHash } from '../../infrastructure/database/idempotency.js';
import { transaction, type DB } from '../../infrastructure/database/client.js';
import { type Actor } from '../identity/types.js';
import { authorizeDraft, assertOpenDraft, draftView, type DraftRow } from '../cases/draft-state.js';
import { ModelGateway,ModelExecutionError,type ModelGrant,type PreparedModelPayload,type ModelEgressPermit } from '../../model/gateway.js';
import { AzureIntakeAdapter,LocalIntakeAdapter,AZURE_INTAKE_ADAPTER_VERSION,LOCAL_INTAKE_ADAPTER_VERSION,LOCAL_INTAKE_INSTRUCTIONS } from './model-adapters.js';
import {AZURE_INTAKE_V2_ADAPTER_VERSION,LOCAL_PRIVACY_ADAPTER_VERSION} from './intake-v2-model.js';
import {PRIVACY_PREPARE_VERSION} from './privacy-projection.js';
import { loadRuntimeIntakeConfig,reserveMicros,intakeAssistantCapacity,type IntakeConfig } from './config.js';
import { INTAKE_SCHEMA,CloudSuggestionSchema,LocalCandidateOutputSchema,localIntake,projectDraft,inspectFinalPayload,validateCandidateValues,digest,intakeInputFingerprint,type IntakeCandidate } from './privacy.js';
import {assistantCapability,createAssistantTurn,runAssistant,assistantEvent} from './assistant.js';
import type {DraftAttachmentService} from '../materials/draft-attachments/service.js';
export function intakeProfileVersion(config:IntakeConfig,profile:'local_intake'|'cloud_assistant'){
  const c=profile==='cloud_assistant'?config.cloud:config.local;if(!c)return'disabled';
  const {token,...cloud}=config.cloud??{};const {service,...local}=config.local??{};
  const adapterVersion=config.cloudMode==='public_synthetic'
    ?profile==='cloud_assistant'?AZURE_INTAKE_V2_ADAPTER_VERSION:LOCAL_PRIVACY_ADAPTER_VERSION
    :profile==='cloud_assistant'?AZURE_INTAKE_ADAPTER_VERSION:LOCAL_INTAKE_ADAPTER_VERSION;
  return`p3-intake-4-${digest(JSON.stringify({adapterVersion,config:profile==='cloud_assistant'?cloud:{...local,endpoint:service?.baseUrl,...(service?.hostedQwen?{hostedPolicy:service.hostedQwen}:{})},...(config.cloudMode==='public_synthetic'?{assistantCapacity:intakeAssistantCapacity(config),privacyVersion:PRIVACY_PREPARE_VERSION}:{})})).slice(0,24)}`;
}
const terminal=new Set(['ready','failed','canceled','unknown','stale']);
export type TurnRow={protocol_version?:number;attachment_ids?:string[];input_snapshot?:{blocks:{id:string;text:string}[];historyCondensed?:boolean;contextAttachmentIds?:string[]};reply_blocks?:any[];assistant_questions?:string[];result_revision?:number|null;applied_fields?:IntakeField[];conflict_fields?:IntakeField[];id:string;draft_id:string;owner_person_id:string;account_id:string;auth_version:number;session_key:string|null;selected_candidate_ids:string[]|null;draft_revision:number;client_turn_id:string;input_hash:string;text:string;fields_snapshot:DraftRow['fields'];questions:{field:DraftField;code:string}[];status:string;error_code:string|null;expires_at:Date;created_at:Date};
export type ModelWork={id:string;owner_id:string;epoch:number;queue:string};
export const CreateTurnSchema=z.object({expectedRevision:z.number().int().positive(),clientTurnId:z.uuid(),text:z.string().trim().max(5000),attachmentIds:z.array(z.uuid()).max(20).default([])}).strict().refine(r=>r.text.length>0||r.attachmentIds.length>0);
function actorFor(row:TurnRow):Actor{return{accountId:row.account_id,personId:row.owner_person_id,authVersion:row.auth_version};}
async function addEvent(db:DB,turn:Pick<TurnRow,'id'|'draft_revision'>,type:string,body:Record<string,unknown>={}){
  // Caller holds the turn row or its parent draft lock. No provider output bypasses this event store.
  const r=await db.query('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM business.intake_events WHERE turn_id=$1',[turn.id]);
  await db.query('INSERT INTO business.intake_events(turn_id,seq,type,body) VALUES($1,$2,$3,$4)',[turn.id,r.rows[0].seq,type,JSON.stringify(body)]);
}
async function candidatesFor(db:DB,turnId:string):Promise<Array<Omit<IntakeCandidate,'field'>&{field:IntakeField;sourceRefs:string[]}>>{return(await db.query('SELECT id AS "candidateId",field,value,source_refs AS "sourceRefs" FROM business.intake_candidates WHERE turn_id=$1 ORDER BY field',[turnId])).rows;}
async function putCandidates(db:DB,turnId:string,candidates:IntakeCandidate[]){
  // Upserts preserve a single current candidate per field and its stable opaque identifier.
  for(const c of candidates)await db.query('INSERT INTO business.intake_candidates(id,turn_id,field,value) VALUES($1,$2,$3,$4) ON CONFLICT(turn_id,field) DO UPDATE SET value=EXCLUDED.value',[c.candidateId,turnId,c.field,c.value]);
}
async function suggestionFor(db:DB,turn:TurnRow){const all=await candidatesFor(db,turn.id);return{questions:turn.questions,candidates:turn.selected_candidate_ids===null?all:all.filter(c=>turn.selected_candidate_ids!.includes(c.candidateId))};}
export async function loadApplicableCandidate(db:DB,actor:Actor,draft:DraftRow,turnId:string,candidateId:string):Promise<{field:IntakeField;value:unknown;sourceRefs?:string[]}>{
  const current=await authorizeDraft(db,actor,draft.id);assertOpenDraft(current,draft.revision);
  const turn=(await db.query('SELECT * FROM business.intake_turns WHERE id=$1 AND draft_id=$2 AND owner_person_id=$3 FOR UPDATE',[turnId,draft.id,actor.personId])).rows[0] as TurnRow|undefined;
  if(!turn||turn.status!=='ready'||(turn.selected_candidate_ids!==null&&!turn.selected_candidate_ids.includes(candidateId))||(turn.result_revision??turn.draft_revision)!==current.revision||turn.auth_version!==actor.authVersion)throw new AppError(409,'suggestion_not_current');
  const candidate=(await db.query('SELECT field,value,source_refs AS "sourceRefs" FROM business.intake_candidates WHERE id=$1 AND turn_id=$2',[candidateId,turnId])).rows[0];
  if(!candidate)throw new AppError(404,'suggestion_not_found');return candidate;
}
async function releaseUnsentReservations(db:DB,turnId:string){
  const calls=(await db.query("SELECT * FROM business.model_calls WHERE turn_id=$1 AND sent_at IS NULL AND reserved_micros>0 FOR UPDATE",[turnId])).rows;
  for(const call of calls){
    if(!call.budget_day)throw new AppError(409,'model_budget_inconsistent');
    await db.query('UPDATE business.model_budgets SET reserved_micros=reserved_micros-$3 WHERE profile_id=$1 AND budget_day=$2',[call.profile_id,call.budget_day,Number(call.reserved_micros)]);
    await db.query('UPDATE business.model_calls SET reserved_micros=0,charged_micros=0 WHERE id=$1',[call.id]);
  }
}
export async function cancelDraftTurns(db:DB,draftId:string){
  const rows=(await db.query("UPDATE business.intake_turns SET status='canceled',error_code='draft_closed',updated_at=now() WHERE draft_id=$1 AND status IN ('pending','running') RETURNING *",[draftId])).rows as TurnRow[];
  for(const row of rows){
    await releaseUnsentReservations(db,row.id);
    await db.query("UPDATE business.model_calls SET state=CASE WHEN state='sent' THEN 'unknown' ELSE 'canceled' END,error_code='canceled',updated_at=now() WHERE turn_id=$1 AND state IN ('pending','running','sent')",[row.id]);
    await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL,updated_at=now() WHERE owner_type='ModelCall' AND owner_id IN(SELECT id FROM business.model_calls WHERE turn_id=$1) AND state IN ('pending','running')",[row.id]);
    await addEvent(db,row,'canceled',{errorCode:'draft_closed'});
  }
}
export class IntakeService{
  private controllers=new Map<string,AbortController>();private stopped=false;
  constructor(private pool:Pool,readonly config:IntakeConfig=loadRuntimeIntakeConfig(),private fetcher:typeof fetch=fetch,private attachments?:DraftAttachmentService){}
  private async authorizedTurn(db:DB,actor:Actor,draftId:string,turnId:string,lock=true){
    const draft=await authorizeDraft(db,actor,draftId,lock);
    const turn=(await db.query(`SELECT * FROM business.intake_turns WHERE id=$1 AND draft_id=$2 AND owner_person_id=$3 ${lock?'FOR UPDATE':''}`,[turnId,draftId,actor.personId])).rows[0] as TurnRow|undefined;
    if(!turn)throw new AppError(404,'turn_not_found');return{draft,turn};
  }
  private async view(db:DB,turn:TurnRow){
    const events=(await db.query('SELECT seq,type,body FROM business.intake_events WHERE turn_id=$1 ORDER BY seq',[turn.id])).rows.map(e=>({seq:e.seq,requestId:turn.client_turn_id,turnId:turn.id,draftRevision:turn.draft_revision,type:e.type,...e.body}));
    return{id:turn.id,clientTurnId:turn.client_turn_id,draftId:turn.draft_id,draftRevision:turn.draft_revision,status:turn.status,text:turn.text,events,suggestion:turn.status==='ready'?await suggestionFor(db,turn):null,errorCode:turn.error_code,protocolVersion:turn.protocol_version??1,attachmentIds:turn.attachment_ids??[],replyBlocks:turn.reply_blocks??[],questions:turn.assistant_questions??[],resultRevision:turn.result_revision,appliedFields:turn.applied_fields??[],conflictFields:turn.conflict_fields??[],createdAt:new Date(turn.created_at).toISOString()};
  }
  async get(actor:Actor,draftId:string,turnId:string){return transaction(this.pool,async db=>this.view(db,(await this.authorizedTurn(db,actor,draftId,turnId,false)).turn));}
  async list(actor:Actor,draftId:string){return transaction(this.pool,async db=>{await authorizeDraft(db,actor,draftId,false);const rows=(await db.query('SELECT * FROM business.intake_turns WHERE draft_id=$1 AND owner_person_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100',[draftId,actor.personId])).rows as TurnRow[];return{items:await Promise.all(rows.reverse().map(r=>this.view(db,r)))};});}
  private async cloudAllowed(db:DB,turn:TurnRow){
    const c=this.config.cloud;if(!c||this.config.cloudMode==='off'||Date.parse(c.policy.expiresAt)<=Date.now())return false;
    if(this.config.cloudMode==='public_synthetic')return assistantCapability(this.config).available;
    if(this.config.cloudMode==='bank')return c.policy.dataClass==='bank';
    return Boolean((await db.query('SELECT 1 FROM business.model_fixture_grants WHERE draft_id=$1 AND owner_person_id=$2 AND input_fingerprint=$3 AND policy_version=$4 AND expires_at>clock_timestamp()',[turn.draft_id,turn.owner_person_id,turn.input_hash,c.policy.version])).rowCount);
  }
  private async schedule(db:DB,turn:TurnRow,profile:'local_intake'|'cloud_assistant'){
    const id=randomUUID(),workId=randomUUID(),candidates=(await suggestionFor(db,turn)).candidates;
    const projection=projectDraft(turn.fields_snapshot,candidates.map(candidate=>({...candidate,field:DraftFieldSchema.parse(candidate.field)})),turn.questions as any);
    const inserted=await db.query("INSERT INTO business.model_calls(id,turn_id,profile_id,profile_version,task_type,policy_version,projection) VALUES($1,$2,$3,$4,'draft_intake',$5,$6) ON CONFLICT(turn_id,profile_id,step_key,call_index) DO NOTHING RETURNING id",[id,turn.id,profile,intakeProfileVersion(this.config,profile),profile==='cloud_assistant'?this.config.cloud!.policy.version:null,JSON.stringify(projection)]);
    if(!inserted.rowCount)return;
    await db.query("INSERT INTO business.work_items(id,owner_type,owner_id,kind,queue,max_attempts) VALUES($1,'ModelCall',$2,'draft_intake',$3,1)",[workId,id,profile==='cloud_assistant'?'model-cloud':'model-local']);
    await db.query("INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,'work.available',$3)",[randomUUID(),workId,id]);
  }
  private async ready(db:DB,turn:TurnRow){
    await db.query("UPDATE business.intake_turns SET status='ready',updated_at=now() WHERE id=$1",[turn.id]);
    await addEvent(db,turn,'suggestion',{suggestion:await suggestionFor(db,turn)});await addEvent(db,turn,'completed');
  }
  async create(actor:Actor,draftId:string,input:unknown){
    const r=CreateTurnSchema.parse(input);if(!actor.sessionKey)throw new AppError(401,'session_execution_authorization_required');return transaction(this.pool,async db=>{
      const draft=await authorizeDraft(db,actor,draftId),hash=intakeInputFingerprint(r.text,draft.fields);
      const old=(await db.query('SELECT * FROM business.intake_turns WHERE draft_id=$1 AND owner_person_id=$2 AND client_turn_id=$3',[draftId,actor.personId,r.clientTurnId])).rows[0] as TurnRow|undefined;
      if(old){if(old.text!==r.text||old.draft_revision!==r.expectedRevision||JSON.stringify(old.attachment_ids??[])!==JSON.stringify(r.attachmentIds))throw new AppError(409,'turn_idempotency_conflict');return this.view(db,old);}
      assertOpenDraft(draft,r.expectedRevision);
      // A new turn supersedes unfinished work; it never silently overwrites a draft field.
      await cancelDraftTurns(db,draftId);
      if(this.config.cloudMode==='public_synthetic'){const turn=await createAssistantTurn(db,actor,draft,r,this.config,intakeProfileVersion(this.config,'local_intake'));return this.view(db,turn);}
      if(r.attachmentIds.length)throw new AppError(503,'assistant_configuration_required');
      const local=localIntake(r.text,draft.fields),id=randomUUID();
      const turn=(await db.query(`INSERT INTO business.intake_turns(id,draft_id,owner_person_id,account_id,auth_version,draft_revision,client_turn_id,input_hash,text,fields_snapshot,questions,session_key,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+interval '5 minutes') RETURNING *`,[id,draftId,actor.personId,actor.accountId,actor.authVersion,draft.revision,r.clientTurnId,hash,r.text,JSON.stringify(draft.fields),JSON.stringify(local.questions),actor.sessionKey])).rows[0] as TurnRow;
      await putCandidates(db,id,local.candidates);await addEvent(db,turn,'stage',{stage:'organizing'});
      if(this.config.local)await this.schedule(db,turn,'local_intake');else if(await this.cloudAllowed(db,turn))await this.schedule(db,turn,'cloud_assistant');else await this.ready(db,turn);
      await audit(db,{actorId:actor.accountId,targetId:id,action:'draft.turn_created',details:{revision:draft.revision}});
      return this.view(db,(await db.query('SELECT * FROM business.intake_turns WHERE id=$1',[id])).rows[0]);
    });
  }
  async cancel(actor:Actor,draftId:string,turnId:string){return transaction(this.pool,async db=>{
    const {turn}=await this.authorizedTurn(db,actor,draftId,turnId);
    if(['pending','running'].includes(turn.status)){
      await releaseUnsentReservations(db,turnId);
      await db.query("UPDATE business.intake_turns SET status='canceled',error_code='canceled',updated_at=now() WHERE id=$1",[turnId]);
      await db.query("UPDATE business.model_calls SET state=CASE WHEN state='sent' THEN 'unknown' ELSE 'canceled' END,error_code='canceled',updated_at=now() WHERE turn_id=$1 AND state IN ('pending','running','sent')",[turnId]);
      await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL,updated_at=now() WHERE owner_type='ModelCall' AND owner_id IN (SELECT id FROM business.model_calls WHERE turn_id=$1) AND state IN ('pending','running')",[turnId]);
      await addEvent(db,turn,'canceled',{errorCode:'canceled'});
    }
    // Worker heartbeats observe this turn's cancellation within one second; unrelated turns continue.
    return this.view(db,(await db.query('SELECT * FROM business.intake_turns WHERE id=$1',[turnId])).rows[0]);
  });}
  async claim(workId?:string,queue?:'model-local'|'model-cloud'):Promise<ModelWork|null>{
    if(this.stopped)return null;
    return transaction(this.pool,async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('p3-model-claim',0))");
      const rows=(await db.query(`SELECT w.*,t.owner_person_id FROM business.work_items w JOIN business.model_calls m ON m.id=w.owner_id JOIN business.intake_turns t ON t.id=m.turn_id
        WHERE w.owner_type='ModelCall' AND ($1::uuid IS NULL OR w.id=$1) AND ($2::text IS NULL OR w.queue=$2) AND w.available_at<=now()
        AND (w.state='pending' OR w.state='running' AND w.lease_until<clock_timestamp()) ORDER BY w.available_at LIMIT 10`,[workId??null,queue??null])).rows;
      // Recovery and cancellation share the person-before-work order. Sort any multi-person locks.
      for(const candidate of rows.sort((a,b)=>a.owner_person_id.localeCompare(b.owner_person_id))){
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`p1-person:${candidate.owner_person_id}`]);
        const row=(await db.query("SELECT * FROM business.work_items WHERE id=$1 AND available_at<=clock_timestamp() AND (state='pending' OR state='running' AND lease_until<clock_timestamp()) FOR UPDATE SKIP LOCKED",[candidate.id])).rows[0];if(!row)continue;
        const call=(await db.query('SELECT * FROM business.model_calls WHERE id=$1 FOR UPDATE',[row.owner_id])).rows[0];
        if(['completed','failed','canceled'].includes(call.state)){
          await db.query("UPDATE business.work_items SET state='canceled',lease_until=NULL WHERE id=$1",[row.id]);
          // A terminal provider receipt can commit before output validation. A
          // crash there must close the turn without re-dispatch or late autofill.
          if(call.state==='completed'&&call.profile_id==='cloud_assistant'&&!call.result){
            const interrupted=(await db.query("UPDATE business.intake_turns SET status='failed',error_code='model_result_not_committed',updated_at=now() WHERE id=$1 AND protocol_version=2 AND status IN ('pending','running') RETURNING *",[call.turn_id])).rows[0];
            if(interrupted)await addEvent(db,interrupted,'failed',{errorCode:'model_result_not_committed'});
          }
          continue;
        }
        if(['sent','unknown'].includes(call.state)||(await db.query("SELECT 1 FROM business.model_calls WHERE parent_call_id=$1 AND sent_at IS NOT NULL LIMIT 1",[call.id])).rowCount){
          await db.query("UPDATE business.model_calls SET state=CASE WHEN sent_at IS NULL THEN 'failed' ELSE 'unknown' END,error_code='execution_unknown',updated_at=now() WHERE id=$1",[call.id]);
          await db.query("UPDATE business.model_calls SET state='unknown',error_code='execution_unknown',updated_at=now() WHERE parent_call_id=$1 AND state='sent'",[call.id]);
          await db.query("UPDATE business.work_items SET state='rejected',error_code='execution_unknown',lease_until=NULL,epoch=epoch+1 WHERE id=$1",[row.id]);
          const turn=(await db.query("UPDATE business.intake_turns SET status='unknown',error_code='execution_unknown',updated_at=now() WHERE id=$1 AND status IN ('pending','running') RETURNING *",[call.turn_id])).rows[0];
          if(turn)await addEvent(db,turn,'failed',{errorCode:'execution_unknown'});continue;
        }
        const count=Number((await db.query("SELECT count(*) FROM business.work_items WHERE owner_type='ModelCall' AND queue=$1 AND state='running' AND lease_until>clock_timestamp()",[row.queue])).rows[0].count);
        if(count>=(row.queue==='model-local'?1:2))continue;
        const claimed=(await db.query("UPDATE business.work_items SET state='running',epoch=epoch+1,attempts=attempts+1,lease_until=now()+interval '150 seconds',updated_at=now() WHERE id=$1 RETURNING *",[row.id])).rows[0];
        await db.query("UPDATE business.model_calls SET state='running',updated_at=now() WHERE id=$1",[call.id]);return claimed;
      }return null;
    });
  }
  private async fence(db:DB,work:ModelWork,turn:TurnRow){
    const draft=await authorizeDraft(db,actorFor(turn),turn.draft_id);assertOpenDraft(draft,turn.draft_revision);
    if(turn.session_key)await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`p3-session:${turn.session_key}`]);
    if(!turn.session_key||!(await db.query('SELECT 1 FROM business.model_session_grants WHERE session_key=$1 AND account_id=$2 AND person_id=$3 AND auth_version=$4 AND NOT revoked AND expires_at>clock_timestamp()',[turn.session_key,turn.account_id,turn.owner_person_id,turn.auth_version])).rowCount)throw new AppError(401,'identity_revoked');
    const fresh=(await db.query('SELECT * FROM business.intake_turns WHERE id=$1 FOR UPDATE',[turn.id])).rows[0] as TurnRow;
    if(!fresh||!['pending','running'].includes(fresh.status)||new Date(fresh.expires_at).getTime()<=Date.now())throw new AppError(409,'turn_not_current');
    const lease=await db.query("SELECT id FROM business.work_items WHERE id=$1 AND owner_type='ModelCall' AND owner_id=$2 AND epoch=$3 AND state='running' AND lease_until>clock_timestamp() FOR UPDATE",[work.id,work.owner_id,work.epoch]);
    if(!lease.rowCount||this.stopped)throw new AppError(409,'model_lease_lost');return draft;
  }
  private async reserve(db:DB,call:any,payload:PreparedModelPayload){
    const c=(call.profile_id==='cloud_assistant'?this.config.cloud:this.config.local)!;
    let amount:number;try{amount=reserveMicros(c,Buffer.byteLength(payload.body));}catch(error){
      const code=error instanceof Error&&['input_budget_exhausted','call_budget_exhausted'].includes(error.message)?error.message as 'input_budget_exhausted'|'call_budget_exhausted':'budget_exhausted';
      throw new ModelExecutionError(code);
    }
    // A crashed worker may have reserved before its send intent. Reuse only the same unsent bytes.
    if(Number(call.reserved_micros)>0){if(call.sent_at)throw new ModelExecutionError('execution_unknown');if(call.payload_hash!==payload.payloadHash||!call.budget_day)throw new ModelExecutionError('egress_denied');return;}
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('p3-model-budget',0))");
    const active=Number((await db.query("SELECT count(*) FROM business.model_calls WHERE profile_id=$1 AND (sent_at>clock_timestamp()-interval '1 minute' OR sent_at IS NULL AND reserved_micros>0)",[call.profile_id])).rows[0].count);
    if(active>=c.requestsPerMinute)throw new ModelExecutionError('budget_exhausted');
    const day=new Date().toISOString().slice(0,10);
    await db.query("INSERT INTO business.model_budgets(profile_id,budget_day) VALUES($2,$1) ON CONFLICT DO NOTHING",[day,call.profile_id]);
    const budget=(await db.query("SELECT * FROM business.model_budgets WHERE profile_id=$2 AND budget_day=$1 FOR UPDATE",[day,call.profile_id])).rows[0];
    if(Number(budget.reserved_micros)+Number(budget.charged_micros)+amount>c.dailyBudgetMicros)throw new ModelExecutionError('budget_exhausted');
    if(Number(call.reserved_micros)>0)throw new ModelExecutionError('execution_unknown');
    await db.query("UPDATE business.model_budgets SET reserved_micros=reserved_micros+$2 WHERE profile_id=$3 AND budget_day=$1",[day,amount,call.profile_id]);
    await db.query('UPDATE business.model_calls SET reserved_micros=$2,payload_hash=$3,budget_day=$4 WHERE id=$1',[call.id,amount,payload.payloadHash,day]);
  }
  /** Persist the send intent, then invoke HTTP while authorization mutations are still fenced. */
  private async dispatch<T>(turn:TurnRow,persist:(db:DB)=>Promise<void>,start:()=>Promise<T>):Promise<T>{
    if(!turn.session_key)throw new AppError(401,'identity_revoked');
    const db=await this.pool.connect(),keys=[`p1-person:${turn.owner_person_id}`,`p3-session:${turn.session_key}`];
    let locked=0,inTransaction=false,destroy=false,pending:Promise<T>|undefined;
    const onError=()=>{destroy=true;};db.on('error',onError);
    try{
      for(const key of keys){await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);locked++;}
      await db.query('BEGIN');inTransaction=true;await persist(db);await db.query('COMMIT');inTransaction=false;
      // No await exists between durable COMMIT and invoking the actual transport.
      if(destroy)throw new ModelExecutionError('execution_unknown');
      pending=start();void pending.catch(()=>undefined);
    }catch(error){if(inTransaction)await db.query('ROLLBACK').catch(()=>{destroy=true;});throw error;}
    finally{
      for(const key of keys.slice(0,locked).reverse())try{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}catch{destroy=true;}
      db.removeListener('error',onError);db.release(destroy);
    }
    return pending!;
  }
  async processWork(work:ModelWork){
    const call=(await this.pool.query('SELECT * FROM business.model_calls WHERE id=$1',[work.owner_id])).rows[0];if(!call)return;
    const turn=(await this.pool.query('SELECT * FROM business.intake_turns WHERE id=$1',[call.turn_id])).rows[0] as TurnRow;if(!turn)return;
    const controller=new AbortController();this.controllers.set(work.id,controller);
    const heartbeat=setInterval(()=>{void transaction(this.pool,async db=>{await this.fence(db,work,turn);await db.query("UPDATE business.work_items SET lease_until=now()+interval '150 seconds' WHERE id=$1 AND epoch=$2",[work.id,work.epoch]);}).catch(()=>controller.abort());},1000);heartbeat.unref();
    try{
      await transaction(this.pool,async db=>{await this.fence(db,work,turn);await db.query("UPDATE business.intake_turns SET status='running',updated_at=now() WHERE id=$1",[turn.id]);await addEvent(db,turn,'stage',{stage:call.profile_id==='cloud_assistant'?'privacy_check':'organizing'});});
      if(call.profile_version!==intakeProfileVersion(this.config,call.profile_id))throw new AppError(409,'model_capability_disabled');
      if(turn.protocol_version===2){await runAssistant({pool:this.pool,config:this.config,turn,work,call,signal:controller.signal,fetcher:this.fetcher,attachments:this.attachments,fence:db=>this.fence(db,work,turn),version:profile=>intakeProfileVersion(this.config,profile),reserve:(db,entry,payload)=>this.reserve(db,entry,payload),settle:(db,entry,result)=>this.settle(db,entry,result),dispatch:(persist,start)=>this.dispatch(turn,persist,start)});return;}
      const hosted=call.profile_id==='local_intake'&&this.config.local?.service.hostedQwen;
      const profile:ModelProfile={id:call.profile_id,version:call.profile_version,provider:call.profile_id==='cloud_assistant'?'azure-openai':hosted?'bailian':'local-vllm',locality:call.profile_id==='cloud_assistant'||hosted?'cloud':'local',model:call.profile_id==='cloud_assistant'?this.config.cloud?.model??'disabled':this.config.local?.model??'disabled',allowedActualProviders:[call.profile_id==='cloud_assistant'?'azure-openai':hosted?'bailian':'self-hosted-vllm'],...(call.profile_id==='cloud_assistant'?{allowedActualModels:this.config.cloud?.policy.actualModels}:{}),capabilities:[call.profile_id==='cloud_assistant'?'json_schema':'text'],allowedTasks:['draft_intake'],adapterId:'intake',fallback:'disabled'};
      const request:DraftModelRequest={scopeType:'draft',draftId:turn.draft_id,ownerPersonId:turn.owner_person_id,revision:turn.draft_revision,conversationId:turn.draft_id,turnId:turn.id,projectionRef:call.id,requestId:call.id,attemptId:`${call.id}:${work.epoch}`,taskId:work.id,taskType:'draft_intake',modelProfileId:profile.id,profileVersion:profile.version,messageBundleRef:turn.id,outputSchemaRef:INTAKE_SCHEMA,requiredCapabilities:profile.capabilities,timeoutMs:(call.profile_id==='cloud_assistant'?this.config.cloud?.timeoutMs:this.config.local?.timeoutMs)??30000,attempt:1,maxAttempts:1};
      const authorize=async():Promise<ModelGrant|null>=>{try{return await transaction(this.pool,async db=>{await this.fence(db,work,turn);return{scopeType:'draft',draftId:turn.draft_id,ownerPersonId:turn.owner_person_id,revision:turn.draft_revision,conversationId:turn.draft_id,turnId:turn.id,projectionRef:call.id,taskId:work.id,messageBundleRef:turn.id,profileId:profile.id,profileVersion:profile.version,evidenceClass:hosted?'approved_original':profile.locality==='cloud'?'redacted':'original',authorizationVersion:turn.auth_version};});}catch{return null;}};
      const beforeSend=async(payload:PreparedModelPayload,permit:ModelEgressPermit,start:()=>Promise<Response>)=>this.dispatch(turn,async db=>{
        await this.fence(db,work,turn);if(!await this.cloudAllowed(db,turn))throw new ModelExecutionError('egress_denied');
        const receipt=await db.query("SELECT 1 FROM business.model_egress_receipts WHERE id=$1 AND call_id=$2 AND payload_hash=$3 AND policy_version=$4 AND decision='approved'",[permit.receiptId,call.id,digest(payload.body),this.config.cloud?.policy.version]);
        if(!receipt.rowCount)throw new ModelExecutionError('egress_denied');
        const updated=await db.query("UPDATE business.model_calls SET state='sent',sent_at=now(),updated_at=now() WHERE id=$1 AND state='running' AND payload_hash=$2 RETURNING id",[call.id,payload.payloadHash]);
        if(!updated.rowCount)throw new ModelExecutionError('execution_unknown');await addEvent(db,turn,'stage',{stage:'generating'});
      },start);
      const adapter=call.profile_id==='cloud_assistant'&&this.config.cloud?new AzureIntakeAdapter(this.config.cloud,async()=>call.projection,beforeSend,this.fetcher):call.profile_id==='local_intake'&&this.config.local?new LocalIntakeAdapter(this.config.local,this.pool,async()=>turn.text,async(body,start)=>this.dispatch(turn,async db=>{
        await this.fence(db,work,turn);const current=(await db.query('SELECT * FROM business.model_calls WHERE id=$1 FOR UPDATE',[call.id])).rows[0];
        if(current.state!=='running')throw new ModelExecutionError('execution_unknown');
        await this.reserve(db,current,{body:JSON.stringify(body),payloadHash:digest(JSON.stringify(body)),endpoint:this.config.local!.service.baseUrl,actualProvider:qwenProvider(this.config.local!.service),model:this.config.local!.model});
        await db.query("UPDATE business.model_calls SET state='sent',sent_at=now(),updated_at=now() WHERE id=$1",[call.id]);await addEvent(db,turn,'stage',{stage:'generating'});
      },start)):null;
      if(!adapter)throw new AppError(409,'model_capability_disabled');
      const gateway=new ModelGateway({profiles:[profile],adapters:new Map([['intake',hosted?hostedAdapter(adapter,this.config.local!.service,this.config.local!.model,()=>qwenRequestBody(this.config.local!.model,[{role:'system',content:LOCAL_INTAKE_INSTRUCTIONS},{role:'user',content:turn.text}],{maxTokens:this.config.local!.maxOutputTokens,disableThinking:true,jsonObject:true},true)):adapter]]),outputSchemas:new Map([[INTAKE_SCHEMA,call.profile_id==='cloud_assistant'?CloudSuggestionSchema:LocalCandidateOutputSchema]]),authorization:{authorize,authorizeEgress:async()=>hosted?true:transaction(this.pool,db=>this.cloudAllowed(db,turn)),authorizePayload:async(_identity,_request,_grant,_profile,payload)=>{
        if(hosted)return hostedAuthorization(this.config.local!.service,this.config.local!.model,async()=>{await transaction(this.pool,db=>this.fence(db,work,turn));}).authorizePayload!(_identity,_request,_grant,_profile,payload);
        try{await inspectFinalPayload(payload,call.projection,this.config,JSON.stringify({text:turn.text,fields:turn.fields_snapshot}));}
        catch(error){await this.pool.query("INSERT INTO business.model_egress_receipts(id,call_id,payload_hash,policy_version,provider,endpoint,data_classes,decision) VALUES($1,$2,$3,$4,'azure-openai',$5,'[]','denied')",[randomUUID(),call.id,digest(payload.body),this.config.cloud!.policy.version,this.config.cloud!.endpoint]);throw error instanceof ModelExecutionError?error:new ModelExecutionError('egress_denied');}
        return transaction(this.pool,async db=>{
          await this.fence(db,work,turn);if(!await this.cloudAllowed(db,turn)||call.policy_version!==this.config.cloud?.policy.version)throw new ModelExecutionError('egress_denied');
          const current=(await db.query('SELECT * FROM business.model_calls WHERE id=$1 FOR UPDATE',[call.id])).rows[0];await this.reserve(db,current,payload);
          const receiptId=randomUUID();await db.query("INSERT INTO business.model_egress_receipts(id,call_id,payload_hash,policy_version,provider,endpoint,data_classes,decision) VALUES($1,$2,$3,$4,'azure-openai',$5,$6,'approved')",[receiptId,call.id,payload.payloadHash,this.config.cloud!.policy.version,payload.endpoint,JSON.stringify(['field_state','candidate_reference','question_code'])]);
          return{receiptId,payloadHash:payload.payloadHash,endpoint:payload.endpoint,policyVersion:this.config.cloud!.policy.version};
        });
      }}});
      const result=await gateway.generate(request,{kind:'human',accountId:turn.account_id,personId:turn.owner_person_id,sessionId:turn.id},controller.signal);
      await this.finish(work,turn,call,result);
    }catch(error){await this.fail(work,turn,call,error instanceof ModelExecutionError?error.code:error instanceof AppError?error.code:'model_execution_failed',error instanceof ModelExecutionError?error.diagnostic:undefined);}
    finally{clearInterval(heartbeat);this.controllers.delete(work.id);}
  }
  private async settle(db:DB,call:any,result:ModelResult){
    const fresh=(await db.query('SELECT * FROM business.model_calls WHERE id=$1 FOR UPDATE',[call.id])).rows[0];
    if(result.status==='failed'&&result.error.code==='execution_unknown')return;
    const reserved=Number(fresh.reserved_micros);if(!reserved)return;
    const c=(call.profile_id==='cloud_assistant'?this.config.cloud:this.config.local)!,usage=result.status==='completed'?result.usage:null;
    // Missing usage after a dispatched request retains the full conservative reservation as charge.
    const charged=usage?Math.ceil((usage.inputTokens*c.inputMicrosPerMillion+usage.outputTokens*c.outputMicrosPerMillion)/1_000_000):fresh.sent_at?reserved:0;
    const day=fresh.budget_day;if(!day)throw new ModelExecutionError('execution_unknown');
    await db.query("UPDATE business.model_budgets SET reserved_micros=GREATEST(0,reserved_micros-$2),charged_micros=charged_micros+$3 WHERE profile_id=$4 AND budget_day=$1",[day,reserved,charged,call.profile_id]);
    await db.query('UPDATE business.model_calls SET charged_micros=$2,reserved_micros=0 WHERE id=$1',[call.id,charged]);
  }
  private async finish(work:ModelWork,turn:TurnRow,call:any,result:ModelResult){
    if(result.status==='failed'){await this.fail(work,turn,call,result.error.code,result.error.diagnostic);return;}
    await transaction(this.pool,async db=>{
      await this.fence(db,work,turn);
      if(call.profile_id==='local_intake'){
        const value=LocalCandidateOutputSchema.parse(result.structured),candidates=value.candidates.map(c=>({...c,candidateId:randomUUID()}));validateCandidateValues(candidates,turn.text);
        await putCandidates(db,turn.id,candidates);turn.questions=value.questions;
        turn.selected_candidate_ids=(await candidatesFor(db,turn.id)).filter(c=>candidates.some(selected=>selected.field===c.field)).map(c=>c.candidateId);
        await db.query('UPDATE business.intake_turns SET questions=$2,selected_candidate_ids=$3 WHERE id=$1',[turn.id,JSON.stringify(turn.questions),turn.selected_candidate_ids]);
      }else{
        const value=CloudSuggestionSchema.parse(result.structured),allowed=new Set((call.projection.candidates as {candidateId:string}[]).map(c=>c.candidateId));
        if(new Set(value.candidateIds).size!==value.candidateIds.length||value.candidateIds.some(id=>!allowed.has(id)))throw new ModelExecutionError('adapter_failed');
        // The cloud may select only existing local candidates, never introduce a new value.
        const permitted=new Set((call.projection.questions as any[]).map(q=>`${q.field}:${q.code}`));
        if(value.questions.some(q=>!permitted.has(`${q.field}:${q.code}`)))throw new ModelExecutionError('adapter_failed');
        turn.questions=value.questions;turn.selected_candidate_ids=value.candidateIds;await db.query('UPDATE business.intake_turns SET questions=$2,selected_candidate_ids=$3 WHERE id=$1',[turn.id,JSON.stringify(turn.questions),value.candidateIds]);
      }
      await this.settle(db,call,result);
      await db.query("UPDATE business.model_calls SET state='completed',actual_model=$2,actual_provider=$3,provider_request_id=$4,usage=$5,updated_at=now() WHERE id=$1",[call.id,result.actualModel,result.actualProvider,result.providerRequestId,JSON.stringify(result.usage)]);
      await db.query("UPDATE business.work_items SET state='succeeded',lease_until=NULL,updated_at=now() WHERE id=$1 AND epoch=$2",[work.id,work.epoch]);
      await db.query('INSERT INTO business.inbox(work_item_id,epoch) VALUES($1,$2) ON CONFLICT DO NOTHING',[work.id,work.epoch]);
      if(call.profile_id==='local_intake'&&await this.cloudAllowed(db,turn))await this.schedule(db,turn,'cloud_assistant');else await this.ready(db,turn);
      await audit(db,{actorId:turn.account_id,targetId:call.id,action:'model.call_completed',details:{profile:call.profile_id,simulated:false}});
    });
  }
  private async fail(work:ModelWork,turn:TurnRow,call:any,code:string,diagnostic?:string){
    const safeCodes=new Set(['execution_unknown','canceled','egress_denied','budget_exhausted','authorization_denied','stale_draft_revision','draft_closed','turn_not_current','identity_revoked','permission_denied','maker_qualification_required','case_creator_required','model_capability_disabled','invalid_output','truncated','refused','timeout','adapter_failed','provider_drift','provider_rejected','assistant_configuration_required','attachment_parser_unavailable','attachment_coverage_incomplete','attachment_text_empty','input_budget_exhausted','call_budget_exhausted']);
    code=safeCodes.has(code)?code:'model_execution_failed';
    await transaction(this.pool,async db=>{
      // Failure bookkeeping cannot publish output. Serialize with cancellation before checking the epoch.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`p1-person:${turn.owner_person_id}`]);
      await db.query('SELECT id FROM business.intake_turns WHERE id=$1 FOR UPDATE',[turn.id]);
      const lease=(await db.query("SELECT id FROM business.work_items WHERE id=$1 AND epoch=$2 AND state='running' FOR UPDATE",[work.id,work.epoch])).rows[0];if(!lease)return;
      const fresh=(await db.query('SELECT * FROM business.model_calls WHERE id=$1 FOR UPDATE',[call.id])).rows[0];
      const knownFailure=new Set(['provider_rejected','invalid_output','truncated','refused','provider_drift']);
      const unknown=Boolean(fresh.sent_at)&&!fresh.usage&&!knownFailure.has(code);
      if(code==='execution_unknown'&&!fresh.sent_at)code='timeout';
      if((!fresh.sent_at||code==='provider_rejected')&&Number(fresh.reserved_micros)>0&&fresh.budget_day){
        await db.query('UPDATE business.model_budgets SET reserved_micros=GREATEST(0,reserved_micros-$3) WHERE profile_id=$1 AND budget_day=$2',[fresh.profile_id,fresh.budget_day,Number(fresh.reserved_micros)]);
        await db.query('UPDATE business.model_calls SET reserved_micros=0,charged_micros=0 WHERE id=$1',[call.id]);
      }
      if(fresh.sent_at&&knownFailure.has(code)&&code!=='provider_rejected')await this.settle(db,fresh,{status:'failed',error:{code}} as ModelResult);
      await db.query("UPDATE business.model_calls SET state=$2,error_code=$3,updated_at=now() WHERE id=$1",[call.id,unknown?'unknown':'failed',diagnostic??code]);
      await db.query("UPDATE business.work_items SET state='rejected',error_code=$3,lease_until=NULL,updated_at=now() WHERE id=$1 AND epoch=$2",[work.id,work.epoch,code]);
      const current=(await db.query("UPDATE business.intake_turns SET status=$2,error_code=$3,updated_at=now() WHERE id=$1 AND status IN ('pending','running') RETURNING *",[turn.id,unknown?'unknown':'failed',code])).rows[0];
      if(current)await addEvent(db,current,'failed',{errorCode:unknown?'execution_unknown':code});
      await audit(db,{actorId:turn.account_id,targetId:call.id,action:'model.call_failed',result:unknown?'unknown':'failed',details:{code,...(diagnostic?{diagnostic}:{})}});
    });
  }
  stop(){this.stopped=true;for(const controller of this.controllers.values())controller.abort();}
}
export async function registerIntakeRoutes(http:FastifyInstance,pool:Pool,auth:Auth,config:IntakeConfig=loadRuntimeIntakeConfig(),attachments?:DraftAttachmentService){
  const service=new IntakeService(pool,config,fetch,attachments);const base='/api/case-drafts/:draftId/turns';
  const path=(request:any)=>({draftId:z.uuid().parse(request.params.draftId),turnId:request.params.turnId?z.uuid().parse(request.params.turnId):undefined});
  http.post(base,async(request,reply)=>{const actor=await auth.checkWrite(request);reply.header('Cache-Control','private, no-store');return{turn:await service.create(actor,path(request).draftId,request.body)};});
  http.get(base,async(request,reply)=>{reply.header('Cache-Control','private, no-store');return service.list(await auth.requireSession(request),path(request).draftId);});
  http.get(`${base}/:turnId`,async(request,reply)=>{reply.header('Cache-Control','private, no-store');const p=path(request);return{turn:await service.get(await auth.requireSession(request),p.draftId,p.turnId!)};});
  http.post(`${base}/:turnId/cancel`,async(request,reply)=>{const actor=await auth.checkWrite(request),p=path(request);z.object({}).strict().parse(request.body??{});reply.header('Cache-Control','private, no-store');return{turn:await service.cancel(actor,p.draftId,p.turnId!)};});
  http.post(`${base}/:turnId/undo`,async(request,reply)=>{
    const actor=await auth.checkWrite(request),p=path(request),input=DraftCommandSchema.parse(request.body);
    reply.header('Cache-Control','private, no-store');
    return transaction(pool,async db=>{
      const draft=await authorizeDraft(db,actor,p.draftId);
      await idempotent(db,actor,`draft.undo:${p.draftId}:${p.turnId}`,input.idempotencyKey,input,async()=>{
        assertOpenDraft(draft,input.expectedRevision);
        const receipt=(await db.query('SELECT * FROM business.intake_autofill_receipts WHERE turn_id=$1 AND draft_id=$2 FOR UPDATE',[p.turnId,p.draftId])).rows[0];
        if(!receipt||receipt.undone_at||receipt.result_revision!==draft.revision||!receipt.applied_fields.length)throw new AppError(409,'autofill_not_current');
        const values=editableDraftValues(draft),before=editableDraftValues({...draft,fields:receipt.before_fields,details:receipt.before_details,guarantee_types:receipt.before_guarantee_types}),states={...draft.field_states},sources={...draft.field_sources};
        for(const field of receipt.applied_fields as IntakeField[]){
          if(sources[field]?.kind!=='assistant'||(sources[field] as {turnId?:string}).turnId!==p.turnId)throw new AppError(409,'autofill_not_current');
          setDraftValue(values,field,draftValue(before,field));
          if(receipt.before_states[field])states[field]=receipt.before_states[field];else delete states[field];
          if(receipt.before_sources[field])sources[field]=receipt.before_sources[field];else delete sources[field];
        }
        await cancelDraftTurns(db,p.draftId);
        await db.query('UPDATE business.case_drafts SET fields=$2,field_states=$3,field_sources=$4,details=$5,guarantee_types=$6,revision=revision+1,updated_at=now() WHERE id=$1',[p.draftId,JSON.stringify(values.fields),JSON.stringify(states),JSON.stringify(sources),JSON.stringify(values.details),JSON.stringify(values.guaranteeTypes)]);
        await db.query('UPDATE business.intake_autofill_receipts SET undone_at=now() WHERE turn_id=$1',[p.turnId]);
        await audit(db,{actorId:actor.accountId,targetId:p.draftId,action:'draft.assistant_undone',details:{turnId:p.turnId!,revision:draft.revision+1}});return{id:p.draftId};
      });
      return draftView(await authorizeDraft(db,actor,p.draftId));
    });
  });
  http.get(`${base}/:turnId/events`,async(request,reply)=>{
    const p=path(request),query=z.object({after:z.coerce.number().int().nonnegative().default(0)}).strict().parse(request.query);
    let actor=await auth.requireSession(request),view=await service.get(actor,p.draftId,p.turnId!),seq=query.after;
    reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'private, no-store','X-Accel-Buffering':'no','Connection':'keep-alive'});
    let disconnected=false,wake:(()=>void)|undefined;
    const disconnect=()=>{disconnected=true;wake?.();};
    request.raw.once('aborted',disconnect);reply.raw.once('close',disconnect);
    reply.raw.flushHeaders();
    const start=Date.now();try{
      while(!disconnected&&!reply.raw.destroyed&&Date.now()-start<15000){
        for(const event of view.events)if(event.seq>seq){reply.raw.write(`id: ${event.seq}\nevent: intake\ndata: ${JSON.stringify(event)}\n\n`);seq=event.seq;}
        if(terminal.has(view.status))break;
        // Parsed control frames keep streaming clients alive without consuming a
        // durable business sequence or implying any model/attachment progress.
        reply.raw.write('event: keepalive\ndata: {}\n\n');
        await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);wake=undefined;resolve();};const timer=setTimeout(done,1000);wake=done;});
        if(disconnected||reply.raw.destroyed||Date.now()-start>=15000)break;
        actor=await auth.requireSession(request);view=await service.get(actor,p.draftId,p.turnId!);
      }
    }catch{/* Reauthorization failure closes the stream without exposing data or exception bodies. */}finally{
      request.raw.off('aborted',disconnect);reply.raw.off('close',disconnect);
      if(!reply.raw.destroyed)reply.raw.end();
    }
  });
  http.addHook('onClose',async()=>service.stop());return service;
}
