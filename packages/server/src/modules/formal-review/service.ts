import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {FormalCommandSchema,FormalStartSchema,type FormalState,type FormalJob,type FormalResult} from '@hsbc/contracts/formal-review';
import {ModelResultSchema} from '@hsbc/contracts/model';
import {transaction,type DB} from '../../infrastructure/database/client.js';
import {idempotent} from '../../infrastructure/database/idempotency.js';
import {AppError} from '../../shared/errors.js';
import {ModelExecutionError,type PreparedModelPayload} from '../../model/gateway.js';
import {authorizeCase,canEditReview,canOwnReviewResult} from '../cases/authorization.js';
import {hasGrant} from '../identity/authorization.js';
import type {Actor} from '../identity/types.js';
import type {Auth} from '../identity/auth.js';
import {audit} from '../audit/events.js';
import {getPublished} from '../review/configuration.js';
import {reviewHash,type ReviewService} from '../review/service.js';
import {ReviewAnalysisService} from '../review-delivery/analysis-service.js';
import type {DocumentService} from '../documents/service.js';
import {assertCheckerInputsMutable,invalidateCheckerContent} from '../review-checker/access.js';
import type {FormalReviewPort,FormalReviewReceipt} from '../review-checker/policy.js';
import {reserveMicros} from '../intake/config.js';
import {formalChecklist,formalFindings,formalProgramResult} from './coverage.js';
import {FormalConfigSchema,formalProfileHash,type FormalConfig} from './config.js';
import {FORMAL_SCHEMA,FORMAL_PROMPT_HASH,executeFormalModel} from './model.js';
import {formalRecord,type FormalInput} from './records.js';
type Work={id:string;owner_id:string;epoch:number};
const actorOf=(j:any):Actor=>({accountId:j.account_id,personId:j.person_id,authVersion:j.auth_version,...(j.session_key?{sessionKey:j.session_key}:{})});
export class FormalReviewService implements FormalReviewPort {
 private active=new Map<string,AbortController>();private stopping=false;
 private readonly analysis:ReviewAnalysisService;
 constructor(readonly pool:Pool,readonly documents:Pick<DocumentService,'reviewBundle'|'translation'>,readonly review:Pick<ReviewService,'validateCheckerSnapshot'>,readonly config?:FormalConfig,readonly fetcher:typeof fetch=fetch){if(config)FormalConfigSchema.parse(config);this.analysis=new ReviewAnalysisService(pool,documents);}
 stop(){this.stopping=true;for(const c of this.active.values())c.abort();}
 private async authorize(db:DB,actor:Actor,caseId:string,write=false){
  const c=await authorizeCase(db,actor,caseId,'evidence:read',write);
  if(!await hasGrant(db,actor.personId,'report:read',caseId))throw new AppError(403,'permission_denied');
  if(write){if(c.closed_at)throw new AppError(409,'case_closed');if(!await canEditReview(db,c,actor.personId)||!await hasGrant(db,actor.personId,'review:formal',caseId))throw new AppError(403,'formal_permission_required');await assertCheckerInputsMutable(db,c);}
  return c;
 }
 private policy(caseId:string,documentIds:string[]){const c=this.config,p=c?.policy;
  if(!c||!p||Date.parse(p.expiresAt)<=Date.now()||!p.caseIds.includes(caseId)||documentIds.some(id=>!p.documentIds.includes(id)))throw new AppError(409,'formal_authorization_required');
  return c;
 }
 private validCall(c:any,j:any,input:FormalInput){
  const m=ModelResultSchema.safeParse(c.response?.result),check=input.checks.find(v=>v.id===c.batch_key),item=c.response?.item;
  const evidence=input.evidence.filter(e=>check?.evidenceIds.includes(e.id));
  if(!check||!item||item.checkId!==check.id||!Array.isArray(item.citations)||!['no_issue','issue','insufficient','manual'].includes(item.outcome)||typeof item.reason!=='string'||!item.reason.trim())return false;
  if(item.citations.some((c:any)=>{const e=evidence.find(e=>e.id===c.evidenceId);return typeof c.quote!=='string'||!c.quote||!e||!e.locations.length||!e.text.includes(c.quote);}))return false;
  if(['no_issue','issue'].includes(item.outcome)&&(!item.citations.length||check.gaps.length||evidence.some(e=>!item.citations.some((c:any)=>evidence.find(v=>v.id===c.evidenceId)?.documentId===e.documentId))))return false;
  return c.state==='completed'&&m.success&&m.data.scopeType==='case'&&m.data.status==='completed'&&!m.data.simulated&&m.data.locality==='cloud'&&m.data.taskType==='cloud_review'&&m.data.caseId===j.case_id&&m.data.taskId===j.id&&m.data.requestId===j.id&&m.data.attemptId===c.payload_hash&&m.data.revision===input.caseRevision&&m.data.profileId==='formal_cloud'&&m.data.profileVersion===reviewHash([j.profile_hash,FORMAL_PROMPT_HASH,FORMAL_SCHEMA])&&m.data.adapterVersion===FORMAL_PROMPT_HASH&&m.data.evidencePackageRef===reviewHash({check,evidence})&&m.data.requestedProvider==='azure-openai'&&m.data.requestedModel===this.config?.model&&m.data.actualProvider==='azure-openai'&&this.config?.policy.actualModels.includes(m.data.actualModel)&&c.policy_hash===reviewHash(this.config.policy)&&c.profile_hash===j.profile_hash;
 }
 private async run(db:DB,c:any,id:string,current=true){
  const r=(await db.query('SELECT r.*,q.state AS round_state,q.run_id AS round_run FROM business.review_runs r JOIN business.review_rounds q ON q.id=r.round_id WHERE r.id=$1 AND r.case_id=$2',[id,c.id])).rows[0];
  if(!r||r.state!=='ready'||r.validity!=='current'||!['submitted','locked'].includes(r.round_state)||r.round_run!==r.id||current&&r.round_id!==c.current_round_id)throw new AppError(409,'formal_pre_review_required');
  if(reviewHash(r.snapshot)!==r.snapshot_hash)throw new AppError(409,'review_snapshot_corrupt');
  await this.review.validateCheckerSnapshot(db,r.snapshot);return r;
 }
 async start(actor:Actor,caseId:string,raw:unknown){const command=FormalStartSchema.parse(raw);return transaction(this.pool,async db=>{
  const c=await this.authorize(db,actor,caseId,true);
  return idempotent(db,actor,`formal.start:${caseId}`,command.idempotencyKey,command,async()=>{
   if(c.revision!==command.expectedRevision)throw new AppError(409,'stale_revision');
   const run=await this.run(db,c,command.runId),config=this.policy(caseId,run.snapshot.materials.map((m:any)=>m.documentVersionId));
   const release=await getPublished(db,run.configuration_release_id),prepared=await this.analysis.evidenceForRuns(db,actor,caseId,[run]);
   const input:FormalInput={checks:formalChecklist(run.snapshot,release,run.results,prepared.evidence),evidence:prepared.evidence,runHash:run.snapshot_hash,configHash:reviewHash(release.manifest),profileHash:formalProfileHash(config),protocol:FORMAL_SCHEMA,promptHash:FORMAL_PROMPT_HASH,caseRevision:run.case_revision};
   const hash=reviewHash(input),old=await formalRecord(db,run.id);
   if(old){if(old.job.input_hash===hash)return {id:old.job.id,reused:true};throw new AppError(409,'formal_existing_version_requires_review');}
   if(!input.checks.length)throw new AppError(409,'formal_program_coverage_incomplete');
   const id=randomUUID(),work=randomUUID();
   await db.query("INSERT INTO business.formal_review_jobs(id,case_id,round_id,run_id,account_id,person_id,auth_version,session_key,snapshot_hash,configuration_release_id,profile_hash,input_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')",[id,caseId,run.round_id,run.id,actor.accountId,actor.personId,actor.authVersion,actor.sessionKey??null,run.snapshot_hash,run.configuration_release_id,input.profileHash,hash]);
   await db.query('INSERT INTO business.formal_review_snapshots(job_id,body,body_hash) VALUES($1,$2,$3)',[id,JSON.stringify(input),hash]);
   await db.query("INSERT INTO business.work_items(id,owner_type,owner_id,kind,queue,max_attempts) VALUES($1,'Workflow',$2,'formal_review','workflow',3)",[work,id]);
   await db.query("INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,'formal_review_requested',$3)",[randomUUID(),work,id]);
   await invalidateCheckerContent(db,caseId);await audit(db,{actorId:actor.accountId,targetId:caseId,action:'formal_review.requested',details:{jobId:id,runId:run.id,count:input.checks.length}});return {id,reused:false};
  });
 });}
 private async fence(db:PoolClient,j:any,input:FormalInput,work?:Work){
  if(this.stopping)throw new AppError(409,'worker_stopping');
  const c=await this.authorize(db,actorOf(j),j.case_id,true),run=await this.run(db,c,j.run_id);
  const config=this.policy(j.case_id,run.snapshot.materials.map((m:any)=>m.documentVersionId));
  const release=await getPublished(db,run.configuration_release_id);
  if(formalProfileHash(config)!==j.profile_hash||run.snapshot_hash!==j.snapshot_hash||input.promptHash!==FORMAL_PROMPT_HASH||input.protocol!==FORMAL_SCHEMA||reviewHash(release.manifest)!==input.configHash||reviewHash(formalChecklist(run.snapshot,release,run.results,input.evidence))!==reviewHash(input.checks))throw new AppError(409,'formal_source_stale');
  const row=(await db.query('SELECT * FROM business.formal_review_jobs WHERE id=$1 FOR UPDATE',[j.id])).rows[0];
  if(!row||row.cancel_requested||!['pending','running','unknown','failed'].includes(row.state))throw new AppError(409,'formal_canceled');
  if(work&&!(await db.query("SELECT id FROM business.work_items WHERE id=$1 AND owner_id=$2 AND epoch=$3 AND state='running' AND lease_until>now() FOR UPDATE",[work.id,j.id,work.epoch])).rowCount)throw new AppError(409,'lease_lost');
  return config;
 }
 async claim(id?:string):Promise<Work|undefined>{if(this.stopping)return;return(await this.pool.query(`UPDATE business.work_items SET state='running',epoch=epoch+1,attempts=attempts+1,lease_until=now()+interval '180 seconds',updated_at=now()
  WHERE id=(SELECT w.id FROM business.work_items w JOIN business.formal_review_jobs j ON j.id=w.owner_id WHERE w.owner_type='Workflow' AND w.kind='formal_review' AND (j.state IN ('pending','running') AND NOT j.cancel_requested OR j.state='unknown')
  AND w.available_at<=now() AND (w.state='pending' OR w.state='running' AND w.lease_until<now()) AND ($1::uuid IS NULL OR w.id=$1) ORDER BY w.available_at,w.id FOR UPDATE OF w SKIP LOCKED LIMIT 1) RETURNING *`,[id??null])).rows[0];}
 async processWork(work:Work){
  const j=(await this.pool.query('SELECT * FROM business.formal_review_jobs WHERE id=$1',[work.owner_id])).rows[0];if(!j)return;
  const controller=new AbortController();this.active.set(j.id,controller);let callId:string|undefined;
  const timer=setInterval(()=>{void this.pool.query("UPDATE business.work_items SET lease_until=now()+interval '180 seconds' WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now() RETURNING id",[work.id,work.epoch]).then(r=>{if(!r.rowCount)controller.abort();}).catch(()=>controller.abort());},30000);timer.unref();
  try{
   const record=await transaction(this.pool,async db=>{
    // Keep the same identity → case → job → work lock order as API commands.
    await this.authorize(db,actorOf(j),j.case_id,true);
    const record=await formalRecord(db,j.run_id);if(!record||record.job.id!==j.id)throw new AppError(409,'formal_source_stale');
    if(record.job.state==='unknown'){
     // Only Worker may settle the call ledger. An explicit reconcile command
     // schedules this work; unknown jobs otherwise remain rejected, not polled.
     await db.query('SELECT id FROM business.formal_review_jobs WHERE id=$1 FOR UPDATE',[j.id]);
     if(!(await db.query("SELECT id FROM business.work_items WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now() FOR UPDATE",[work.id,work.epoch])).rowCount)throw new AppError(409,'lease_lost');
     for(const call of (await db.query("SELECT * FROM business.formal_review_calls WHERE job_id=$1 AND state='unknown' FOR UPDATE",[j.id])).rows){
      const returned=call.response?.returned;
      if(!returned||!this.validCall({...call,state:'completed',response:returned},j,record.input))throw new ModelExecutionError('execution_unknown');
      await db.query("UPDATE business.formal_review_calls SET state='completed',response=$2,completed_at=now() WHERE id=$1 AND state='unknown'",[call.id,JSON.stringify(returned)]);
     }
     if(record.job.cancel_requested){
      await db.query("UPDATE business.formal_review_jobs SET state='canceled',updated_at=now() WHERE id=$1",[j.id]);
      await db.query("UPDATE business.work_items SET state='canceled',lease_until=NULL WHERE id=$1 AND epoch=$2",[work.id,work.epoch]);return null;
     }
    }
    await this.fence(db,j,record.input,work);await db.query("UPDATE business.formal_review_jobs SET state='running',updated_at=now() WHERE id=$1",[j.id]);return record;
   });
   if(!record)return;
   const next=record.input.checks.find(c=>!record.results.some(r=>r.checkId===c.id));
   if(next){
    let item:Omit<FormalResult,'id'>;
    if(next.programOutcome==='not_applicable')item={checkId:next.id,outcome:'no_issue',reason:'程序已依据本轮确认事实标记不适用；未作为通过项执行云分析。',citations:[]};
    else if(next.method==='program')item=formalProgramResult(next)!;
    else if(next.gaps.length)item={checkId:next.id,outcome:'insufficient',reason:next.gaps.join('；'),citations:[]};
    else{
     const old=(await this.pool.query('SELECT * FROM business.formal_review_calls WHERE job_id=$1 AND batch_key=$2 ORDER BY attempt DESC LIMIT 1',[j.id,next.id])).rows[0];
     if(old?.state==='unknown')throw new ModelExecutionError('execution_unknown');
     if(old?.state==='completed'){
      const saved=old.response;if(!this.validCall(old,j,record.input))throw new AppError(409,'formal_integrity_failed');item=saved.item;
     }else{
      if(old&&old.attempt>=2)throw new ModelExecutionError('call_budget_exhausted');
      const config=this.config!;
      const result=await executeFormalModel({job:{...j,case_revision:record.input.caseRevision},check:next,evidence:record.input.evidence.filter(e=>next.evidenceIds.includes(e.id)),config,signal:controller.signal,fetcher:this.fetcher,hooks:{
       authorize:()=>transaction(this.pool,async db=>{await this.fence(db,j,record.input,work);}),
       reserve:payload=>transaction(this.pool,async db=>{
        await this.fence(db,j,record.input,work);controller.signal.throwIfAborted();
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`formal-budget:${config.policy.budgetId}`]);
        if((await db.query("SELECT 1 FROM business.formal_review_calls WHERE job_id=$1 AND batch_key=$2 AND state IN ('completed','unknown')",[j.id,next.id])).rowCount)throw new ModelExecutionError('execution_unknown');
        let reserved:number;try{reserved=reserveMicros(config,Buffer.byteLength(payload.body));}catch(error){
         if(error instanceof Error&&['input_budget_exhausted','call_budget_exhausted'].includes(error.message))throw new ModelExecutionError(error.message as 'input_budget_exhausted'|'call_budget_exhausted');throw error;
        }
        // Purpose-specific accounting shares the existing budget ledger, without copying/resetting another task's allowance.
        const budgetId=`formal:${config.policy.budgetId}`;
        const totals=(await db.query('SELECT coalesce(sum(reserved_micros+charged_micros),0)::text AS spent FROM business.model_budgets WHERE profile_id=$1',[budgetId])).rows[0];
        const recent=(await db.query("SELECT count(*)::int AS n FROM business.formal_review_calls WHERE created_at>now()-interval '1 minute'")).rows[0].n;
        const count=(await db.query('SELECT count(*)::int AS n FROM business.formal_review_calls WHERE job_id=$1',[j.id])).rows[0].n;
        if(Number(totals.spent)+reserved>config.policy.totalBudgetMicros||recent>=config.requestsPerMinute||count>=config.policy.maxCalls)throw new ModelExecutionError('budget_exhausted');
        await db.query('INSERT INTO business.model_budgets(profile_id,budget_day) VALUES($1,(now() AT TIME ZONE \'UTC\')::date) ON CONFLICT DO NOTHING',[budgetId]);
        const daily=await db.query('UPDATE business.model_budgets SET reserved_micros=reserved_micros+$2 WHERE profile_id=$1 AND budget_day=(now() AT TIME ZONE \'UTC\')::date AND reserved_micros+charged_micros+$2<=$3 RETURNING profile_id',[budgetId,reserved,config.dailyBudgetMicros]);
        if(!daily.rowCount)throw new ModelExecutionError('budget_exhausted');
        callId=randomUUID();await db.query("INSERT INTO business.formal_review_calls(id,job_id,batch_key,attempt,payload_hash,policy_hash,profile_hash,reserved_micros,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'unknown')",[callId,j.id,next.id,(old?.attempt??0)+1,payload.payloadHash,reviewHash(config.policy),j.profile_hash,reserved]);
        await audit(db,{actorId:j.account_id,targetId:j.case_id,action:'formal_review.egress_reserved',details:{callId,payloadHash:payload.payloadHash,policyHash:reviewHash(config.policy),reservedMicros:reserved}});
        return {payloadHash:payload.payloadHash,endpoint:config.endpoint,policyVersion:config.policy.version,receiptId:callId};
       }),dispatch:async start=>{await transaction(this.pool,async db=>{await this.fence(db,j,record.input,work);});controller.signal.throwIfAborted();return start();},
       returned:async returned=>{if(!callId)throw new ModelExecutionError('execution_unknown');await this.pool.query("UPDATE business.formal_review_calls SET response=$2 WHERE id=$1 AND state='unknown'",[callId,JSON.stringify({returned})]);},
       save:async result=>{if(!callId)return;if(result.status==='failed'&&result.error.code!=='execution_unknown')await this.pool.query("UPDATE business.formal_review_calls SET state='failed',response=coalesce(response,'{}'::jsonb)||$2::jsonb,error_code=$3,completed_at=now() WHERE id=$1 AND state='unknown'",[callId,JSON.stringify({result}),result.error.code]);}
      }});
      item=result.item;
      // Accounting/returned artifacts survive revocation. Publishing current results below still requires the fence.
      if(!callId)throw new ModelExecutionError('execution_unknown');
      await this.pool.query("UPDATE business.formal_review_calls SET state='completed',response=$2,completed_at=now() WHERE id=$1 AND state='unknown'",[callId,JSON.stringify(result)]);
     }
    }
    await transaction(this.pool,async db=>{await this.fence(db,j,record.input,work);const result={...item,id:randomUUID()};await db.query('INSERT INTO business.formal_review_results(job_id,check_id,body,body_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[j.id,next.id,JSON.stringify(result),reviewHash(result)]);
     const finding=formalFindings(record.input.checks,[result])[0];
     if(finding){
      await db.query('INSERT INTO business.review_findings(id,run_id,case_id,case_revision,rule_id,scope_id,input_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[result.id,j.run_id,j.case_id,record.input.caseRevision,finding.ruleId,finding.scopeId,reviewHash(result),JSON.stringify({purpose:'cloud_review',formalJobId:j.id,result:finding})]);
      await db.query('INSERT INTO business.review_issues(id,case_id,rule_id,scope_id,latest_finding_id,case_revision,round_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),j.case_id,finding.ruleId,finding.scopeId,result.id,record.input.caseRevision,j.round_id]);
     }
});
   }
   await transaction(this.pool,async db=>{await this.fence(db,j,record.input,work);const saved=await formalRecord(db,j.run_id);const done=saved!.results.length===record.input.checks.length;
    const real=(await db.query("SELECT 1 FROM business.formal_review_calls WHERE job_id=$1 AND state='completed' AND response->'result'->>'simulated'='false' LIMIT 1",[j.id])).rowCount;
    if(done&&!real)throw new AppError(409,'formal_no_analyzable_evidence');
    await db.query('UPDATE business.formal_review_jobs SET state=$2,error_code=NULL,updated_at=now() WHERE id=$1',[j.id,done?'completed':'running']);
    await db.query("UPDATE business.work_items SET state=$3,lease_until=NULL,available_at=now()+interval '1 second' WHERE id=$1 AND epoch=$2",[work.id,work.epoch,done?'succeeded':'pending']);
    if(done){await invalidateCheckerContent(db,j.case_id);await audit(db,{actorId:j.account_id,targetId:j.case_id,action:'formal_review.completed',details:{jobId:j.id,count:saved!.results.length}});}
   });
  }catch(e){let code=e instanceof AppError||e instanceof ModelExecutionError?e.code:'formal_execution_failed';
   await transaction(this.pool,async db=>{const unknown=(await db.query("SELECT 1 FROM business.formal_review_calls WHERE job_id=$1 AND state='unknown'",[j.id])).rowCount;
    const row=(await db.query('SELECT cancel_requested FROM business.formal_review_jobs WHERE id=$1',[j.id])).rows[0];
    if(!row?.cancel_requested)try{const c=await this.authorize(db,actorOf(j),j.case_id,true);await this.run(db,c,j.run_id);if(formalProfileHash(this.policy(j.case_id,[]))!==j.profile_hash)code='formal_source_stale';}catch(gate){if(gate instanceof AppError)code=gate.code;else throw gate;}
    const state=unknown?'unknown':row?.cancel_requested?'canceled':['identity_revoked','permission_denied','formal_source_stale','formal_pre_review_required','formal_permission_required','case_closed','formal_authorization_required'].includes(code)?'stale':'failed';
    const lease=await db.query("UPDATE business.work_items SET state='rejected',error_code=$3,lease_until=NULL WHERE id=$1 AND epoch=$2 AND state='running' RETURNING id",[work.id,work.epoch,code]);
    if(lease.rowCount)await db.query('UPDATE business.formal_review_jobs SET state=$2,error_code=$3,updated_at=now() WHERE id=$1 AND state<>\'completed\'',[j.id,state,code]);
   });
  }finally{clearInterval(timer);this.active.delete(j.id);controller.abort();}
 }
 async command(actor:Actor,caseId:string,id:string,action:'cancel'|'retry'|'reconcile',raw:unknown){const command=FormalCommandSchema.parse(raw);return transaction(this.pool,async db=>{
  const c=await this.authorize(db,actor,caseId,true);return idempotent(db,actor,`formal.${action}:${id}`,command.idempotencyKey,command,async()=>{
   if(c.revision!==command.expectedRevision)throw new AppError(409,'stale_revision');
   const j=(await db.query('SELECT * FROM business.formal_review_jobs WHERE id=$1 AND case_id=$2 FOR UPDATE',[id,caseId])).rows[0];
   if(!j||j.round_id!==c.current_round_id)throw new AppError(409,'formal_source_stale');
   if(action==='reconcile'&&j.state==='unknown'){
    const record=await formalRecord(db,j.run_id);
    const unknownCalls=(await db.query("SELECT * FROM business.formal_review_calls WHERE job_id=$1 AND state='unknown'",[id])).rows;
    if(unknownCalls.length){
     if(!record||unknownCalls.some(call=>!call.response?.returned||!this.validCall({...call,state:'completed',response:call.response.returned},j,record.input)))return {id,state:'unknown',reason:'供应商执行结果尚未取得可核验回执；保留预算，不重新发送。'};
     await db.query("UPDATE business.work_items SET state='pending',epoch=epoch+1,lease_until=NULL,available_at=now() WHERE owner_id=$1 AND kind='formal_review'",[id]);
     await audit(db,{actorId:actor.accountId,targetId:caseId,action:'formal_review.reconcile_requested',details:{jobId:id}});
     return {id,state:'unknown',reason:'已找到保存的返回凭据，正在由后台核验；不会重新发送模型请求。'};
    }
   }
   const unknown=(await db.query("SELECT 1 FROM business.formal_review_calls WHERE job_id=$1 AND state='unknown'",[id])).rowCount;
   if(action==='cancel'){
    if(!['pending','running','unknown'].includes(j.state))throw new AppError(409,'formal_action_unavailable');
    await db.query("UPDATE business.formal_review_jobs SET cancel_requested=true,state=$2,updated_at=now() WHERE id=$1",[id,unknown?'unknown':'canceled']);
    await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL WHERE owner_id=$1 AND kind='formal_review'",[id]);this.active.get(id)?.abort();
   }else{
    if(!['unknown','failed'].includes(j.state)||j.cancel_requested&&action!=='reconcile')throw new AppError(409,'formal_action_unavailable');
    if(unknown)return {id,state:'unknown',reason:'供应商执行结果尚未取得可核验回执；保留预算，不重新发送。'};
    if(j.cancel_requested){await db.query("UPDATE business.formal_review_jobs SET state='canceled',updated_at=now() WHERE id=$1",[id]);return {id,state:'canceled'};}
    const record=await formalRecord(db,j.run_id);await this.fence(db,j,record!.input);
    await db.query("UPDATE business.formal_review_jobs SET state='pending',error_code=NULL,updated_at=now() WHERE id=$1",[id]);
    await db.query("UPDATE business.work_items SET state='pending',epoch=epoch+1,lease_until=NULL,available_at=now() WHERE owner_id=$1 AND kind='formal_review'",[id]);
   }
   await audit(db,{actorId:actor.accountId,targetId:caseId,action:`formal_review.${action}`,details:{jobId:id}});return {id};
  });
 });}
 async verify(input:{caseId:string;roundId:string;runId:string;snapshotHash:string;configurationReleaseId:string},db?:DB):Promise<FormalReviewReceipt>{
  if(!db)return transaction(this.pool,db=>this.verify(input,db));
  const base={...input,available:Boolean(this.config),complete:false,findings:[] as any[]};
  if(!input.runId)return {...base,reason:'请先完成程序预审'};
  const r=await formalRecord(db,input.runId);if(!r)return {...base,reason:this.config?'尚未执行本轮正式审核':'正式审核服务尚未配置，请联系系统管理员核对模型服务、材料处理范围和预算'};
  const j=r.job,p=(await db.query('SELECT * FROM business.principals WHERE account_id=$1',[j.account_id])).rows[0];
  const current=(await db.query('SELECT * FROM business.cases WHERE id=$1',[input.caseId])).rows[0];
  const matches=j.case_id===input.caseId&&j.round_id===input.roundId&&j.run_id===input.runId&&j.snapshot_hash===input.snapshotHash&&j.configuration_release_id===input.configurationReleaseId;
  const authorized=p?.enabled&&!p.must_change&&p.person_id===j.person_id&&p.auth_version===j.auth_version&&current&&await canOwnReviewResult(db,current,j.person_id)&&current.current_round_id===j.round_id&&await hasGrant(db,j.person_id,'review:formal',input.caseId)&&await hasGrant(db,j.person_id,'evidence:read',input.caseId)&&await hasGrant(db,j.person_id,'report:read',input.caseId);
  let approved=false;try{const config=this.policy(input.caseId,r.input.evidence.map(e=>e.documentId));
   const run=await this.run(db,current,input.runId);
   const release=await getPublished(db,run.configuration_release_id);
   approved=formalProfileHash(config)===j.profile_hash&&r.input.protocol===FORMAL_SCHEMA&&r.input.promptHash===FORMAL_PROMPT_HASH&&r.input.configHash===reviewHash(release.manifest)&&reviewHash(formalChecklist(run.snapshot,release,run.results,r.input.evidence))===reviewHash(r.input.checks)&&await canOwnReviewResult(db,current,j.person_id);
  }catch{/* A changed source, policy or identity never produces a usable receipt. */}
  const calls=(await db.query('SELECT * FROM business.formal_review_calls WHERE job_id=$1',[j.id])).rows;
  const validCalls=calls.filter(c=>this.validCall(c,j,r.input));
  const covered=r.input.checks.every(check=>{
   const result=r.results.find(v=>v.checkId===check.id);if(!result)return false;
   if(check.programOutcome==='not_applicable')return result.outcome==='no_issue'&&!result.citations.length;
   if(check.method==='program'){const {id,...item}=result;return reviewHash(item)===reviewHash(formalProgramResult(check));}
   if(check.gaps.length)return result.outcome==='insufficient';
   const {id,...item}=result;
   if(result.citations.some(c=>{const e=r.input.evidence.find(e=>e.id===c.evidenceId);return !e||!check.evidenceIds.includes(e.id)||!e.locations.length||!e.text.includes(c.quote);}))return false;
   if(['no_issue','issue'].includes(result.outcome)&&(!result.citations.length||r.input.evidence.filter(e=>check.evidenceIds.includes(e.id)).some(e=>!result.citations.some(c=>r.input.evidence.find(v=>v.id===c.evidenceId)?.documentId===e.documentId))))return false;
   return validCalls.some(call=>call.batch_key===check.id&&reviewHash(call.response.item)===reviewHash(item));
  });
  const complete=Boolean(matches&&authorized&&approved&&j.state==='completed'&&!j.cancel_requested&&r.results.length===r.input.checks.length&&validCalls.length&&covered&&!calls.some(c=>c.state==='unknown'));
  return {...base,complete,receiptId:complete?j.id:undefined,findings:matches?r.findings:[],reason:complete?undefined:'正式审核未完成、授权已变化或回执与当前版本不一致',details:complete?{checks:r.input.checks,results:r.results,evidence:r.input.evidence}:undefined};
 }
 async state(actor:Actor,caseId:string,roundId?:string):Promise<FormalState>{return transaction(this.pool,async db=>{
  const c=await this.authorize(db,actor,caseId),selected=roundId??c.current_round_id,readOnly=Boolean(c.closed_at||selected!==c.current_round_id),blockers:string[]=[],allowedActions:string[]=[];
  const round=(await db.query('SELECT * FROM business.review_rounds WHERE id=$1 AND case_id=$2',[selected,caseId])).rows[0];if(!round)throw new AppError(404,'review_round_not_found');
  let writable=false;try{if(!readOnly){await this.authorize(db,actor,caseId,true);writable=true;}}catch(error){
   if(!(error instanceof AppError))throw error;
   blockers.push(error.code==='checker_submission_pending'?'本案已提交 Checker，请由复核人进入本轮更正后重新发起审核。':c.maker_person_id!==actor.personId?'正式审核由经办人或正在更正本轮的复核人按授权发起；当前账号可查看已有结果。':'当前经办人尚未获得本案的正式审核权限或经办资格，请联系权限管理员。');
  }
  if(!this.config)blockers.push('正式审核服务尚未配置，请联系系统管理员核对模型服务、材料处理范围和预算。');
  if(!round.run_id)blockers.push('请先核对材料及事实，完成本轮程序预审。');
  else try{const run=await this.run(db,c,round.run_id,!readOnly);if(this.config)this.policy(caseId,run.snapshot.materials.map((m:any)=>m.documentVersionId));}catch(e){blockers.push(e instanceof AppError&&e.code==='formal_authorization_required'?'本案材料不在正式审核服务的有效处理范围内，请联系系统管理员核对材料范围和有效期。':'程序预审或原文版本尚未满足正式审核条件。');}
  const jobs:FormalJob[]=[];
  const rows=(await db.query('SELECT run_id FROM business.formal_review_jobs WHERE case_id=$1 AND round_id=$2 ORDER BY created_at DESC LIMIT 20',[caseId,selected])).rows;
  for(const row of rows){const r=(await formalRecord(db,row.run_id))!,j=r.job,actions:string[]=[];
   const stale=!readOnly&&j.state==='completed'&&!(await this.verify({caseId,roundId:j.round_id,runId:j.run_id,snapshotHash:j.snapshot_hash,configurationReleaseId:j.configuration_release_id},db)).complete;
   if(writable&&!readOnly){if(['pending','running','unknown'].includes(j.state)&&!j.cancel_requested)actions.push('cancel');if(j.state==='unknown')actions.push('reconcile');if(j.state==='failed'&&!j.cancel_requested)actions.push('retry');}
   jobs.push({id:j.id,roundId:j.round_id,runId:j.run_id,state:stale?'stale':j.state,errorCode:j.error_code,createdAt:new Date(j.created_at).toISOString(),checks:r.input.checks,results:r.results,evidence:r.input.evidence,completed:r.results.length,total:r.input.checks.length,allowedActions:actions,simulated:false,reason:stale?'原审核已完成，但当前授权或版本条件已变化，不能用于提交复核。':j.state==='unknown'?'结果未知；不会自动重新调用或释放已预留预算。':null});
  }
  if(writable&&!readOnly&&!blockers.length&&!jobs.length)allowedActions.push('start');
  return {caseId,revision:c.revision,roundId:selected,runId:round.run_id,enabled:Boolean(this.config),readOnly,blockers,allowedActions,jobs};
 });}
}
export function registerFormalReviewRoutes(app:FastifyInstance,auth:Auth,service:FormalReviewService){
 const path=(r:any)=>z.object({caseId:z.uuid(),id:z.uuid().optional()}).parse(r.params),base='/api/cases/:caseId/formal-review';
 app.get(base,async r=>service.state(await auth.requireSession(r),path(r).caseId,z.object({roundId:z.uuid().optional()}).parse(r.query).roundId));
 app.post(base,async r=>service.start(await auth.checkWrite(r),path(r).caseId,r.body));
 for(const action of ['cancel','retry','reconcile'] as const)app.post(`${base}/:id/${action}`,async r=>{const p=path(r);return service.command(await auth.checkWrite(r),p.caseId,p.id!,action,r.body);});
}
