import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {CheckerCommandSchema,CheckerAssignmentSchema,CheckerSubmitSchema,CheckerDecisionSchema,CheckerNoteSchema,CheckerDispositionSchema,type CheckerState,type CheckerSummary,type CheckerTarget,type CheckerBlocker} from '@hsbc/contracts/review-checker';
import {transaction,type DB} from '../../infrastructure/database/client.js';
import {idempotent} from '../../infrastructure/database/idempotency.js';
import {AppError} from '../../shared/errors.js';
import {authorizeCase,isEligibleMaker} from '../cases/authorization.js';
import {hasGrant,lockPersons} from '../identity/authorization.js';
import type {Actor} from '../identity/types.js';
import type {Auth} from '../identity/auth.js';
import {audit} from '../audit/events.js';
import {currentRound,assertNoInputWork,assertRoundExecutionSettled} from '../review/round-boundary.js';
import {reviewHash,type ReviewService} from '../review/service.js';
import {checkerEligibility,assertIndependentChecker,assertCheckerInputsMutable,invalidateCheckerContent,checkerCorrectionActive,isCorrectingChecker} from './access.js';
import {unavailableFormalReview,dispositionBlockers,manualConclusionAllowed,type FormalReviewPort} from './policy.js';
import {ReviewDeliveryService} from '../review-delivery/service.js';
import {reviewEvidenceBelongsToObject} from '../review/material-readiness.js';

const iso=(v:any):string|null=>v?new Date(v).toISOString():null;
const bodyHash=(v:unknown)=>reviewHash(v);
const named=(alias:string)=>`(SELECT display_name FROM auth.people WHERE id=${alias})`;
type Command=z.infer<typeof CheckerCommandSchema>;
// Editing can recover a stale submission; confirming still requires its exact current snapshot.
const correctableSubmission=(c:any,round:any,s:any)=>!checkerCorrectionActive(c)&&s?.state==='submitted'&&s.round_id===c.current_round_id&&round?.run_id===s.run_id&&['submitted','locked'].includes(round.state);

// Preserve the existing database guard for legacy locked rounds.
const returnableSubmission=(c:any,round:any,s:any)=>correctableSubmission(c,round,s)&&(round.state==='submitted'||s.validity==='current');

export class CheckerService {
 private readonly delivery:ReviewDeliveryService;
 constructor(readonly pool:Pool,readonly evidenceReview:Pick<ReviewService,'validateEvidence'|'validateCheckerSnapshot'>,readonly formalReview:FormalReviewPort=unavailableFormalReview){this.delivery=new ReviewDeliveryService(pool);}
 private async readCase(db:DB,actor:Actor,id:string,write=false){
  const c=await authorizeCase(db,actor,id,'checker:read',write);
  if(!await hasGrant(db,actor.personId,'evidence:read',id)||!await hasGrant(db,actor.personId,'report:read',id))throw new AppError(403,'checker_read_scope_required');
  return c;
 }
 private async maker(db:DB,actor:Actor,c:any){if(c.maker_person_id!==actor.personId||!await isEligibleMaker(db,actor.personId,c.id))throw new AppError(403,'maker_assignment_required');}
 private async event(db:DB,actor:Actor,c:any,kind:string,details:Record<string,unknown>,submissionId?:string){
  await db.query('INSERT INTO business.checker_events(id,case_id,submission_id,kind,actor_person_id,account_id,details) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),c.id,submissionId??null,kind,actor.personId,actor.accountId,JSON.stringify(details)]);
  await audit(db,{actorId:actor.accountId,targetId:c.id,action:`checker.${kind}`,details:{submissionId:submissionId??'none'}});
 }
 private async command(actor:Actor,id:string,action:string,input:Command,operation:string,fn:(db:DB,c:any)=>Promise<unknown>,persons:string[]=[]){
  return transaction(this.pool,async db=>{
   const before=(await db.query('SELECT maker_person_id,checker_person_id FROM business.cases WHERE id=$1',[id])).rows[0];
   await lockPersons(db,[actor.personId,...persons,...[before?.maker_person_id,before?.checker_person_id].filter(Boolean)]);
   const c=await this.readCase(db,actor,id,true);
   if(c.maker_person_id!==before?.maker_person_id||c.checker_person_id!==before?.checker_person_id)throw new AppError(409,'stale_revision');
   if(c.closed_at)throw new AppError(409,'case_closed');
   if(!await hasGrant(db,actor.personId,action,id))throw new AppError(403,'permission_denied');
   if(['checker:comment','checker:correct','checker:confirm'].includes(action))await assertIndependentChecker(db,c,actor.personId);
   if(action==='maker:submit')await this.maker(db,actor,c);
   const receipt=await idempotent(db,actor,`checker.${operation}:${id}`,input.idempotencyKey,input,async()=>{
    if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
    const value=await fn(db,c);
    await db.query('UPDATE business.cases SET revision=revision+1,updated_at=now() WHERE id=$1 AND closed_at IS NULL',[id]);
    return value??{};
   });
   return {receipt,revision:(await db.query('SELECT revision FROM business.cases WHERE id=$1',[id])).rows[0].revision};
  });
 }
 async assign(actor:Actor,id:string,raw:unknown){const input=CheckerAssignmentSchema.parse(raw);return this.command(actor,id,'case:assign',input,'assign',async(db,c)=>{
  if(c.maker_person_id===input.checkerPersonId)throw new AppError(403,'checker_not_independent_or_authorized');
  if((await checkerEligibility(db,c,input.checkerPersonId)).length)throw new AppError(422,'checker_not_independent_or_authorized');
  await db.query('UPDATE business.cases SET checker_person_id=$2,checker_assignment_version=checker_assignment_version+1,checker_correction_round_id=CASE WHEN checker_correction_round_id=current_round_id THEN current_round_id END,checker_correction_person_id=CASE WHEN checker_correction_round_id=current_round_id THEN $2::uuid END,checker_correction_assignment_version=CASE WHEN checker_correction_round_id=current_round_id THEN checker_assignment_version+1 END WHERE id=$1',[id,input.checkerPersonId]);
  if(checkerCorrectionActive(c)){
   // Reassignment invalidates work even if the same person is assigned again before a late result returns.
   const runs=(await db.query("UPDATE business.review_runs SET validity='stale',state=CASE WHEN state IN ('pending','running') THEN 'stale' ELSE state END WHERE case_id=$1 AND round_id=$2 AND validity='current' RETURNING id",[id,c.current_round_id])).rows.map(r=>r.id);
   await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL WHERE owner_id=ANY($1::uuid[]) AND kind='p3_review' AND state IN ('pending','running')",[runs]);
  }
  // Assignment still advances the optimistic-lock revision and fences Checker
  // execution, but does not change the field review's evidence or business inputs.
  await this.event(db,actor,c,'assigned',{previousPersonId:c.checker_person_id??null,personId:input.checkerPersonId,reason:input.reason,
   fieldReviewTransition:{from:c.revision,to:c.revision+1,roundId:c.current_round_id??null}});
 },[input.checkerPersonId]);}
 private async dispositions(db:DB,id:string,runId?:string){return (await db.query(`SELECT d.*,${named('d.actor_person_id')} AS author_name FROM business.checker_dispositions d WHERE case_id=$1 AND ($2::uuid IS NULL OR run_id=$2) ORDER BY created_at,id`,[id,runId??null])).rows;}
 private async items(db:DB,id:string){
  const rows=(await db.query('SELECT * FROM business.checker_items WHERE case_id=$1 ORDER BY created_at,id',[id])).rows;
  const events=(await db.query(`SELECT e.*,${named('e.actor_person_id')} AS actor_name FROM business.checker_item_events e WHERE case_id=$1 ORDER BY created_at,id`,[id])).rows;
  return rows.map(r=>({...r,responses:events.filter(e=>e.item_id===r.id)}));
 }
 private async context(db:DB,c:any){
  const blockers:CheckerBlocker[]=[];
  const round=await currentRound(db,c);
  const run=round?.run_id?(await db.query('SELECT * FROM business.review_runs WHERE id=$1 AND case_id=$2',[round.run_id,c.id])).rows[0]:null;
  const release=run?(await db.query('SELECT manifest FROM business.review_config_releases WHERE release_id=$1',[run.configuration_release_id])).rows[0]?.manifest:null;
  if(!c.maker_person_id||!await isEligibleMaker(db,c.maker_person_id,c.id)||!await hasGrant(db,c.maker_person_id,'maker:submit',c.id))blockers.push({code:'maker_qualification_required',label:'当前经办人的资格或提交权限已失效，请先调整授权或指派'});
  if(!c.checker_person_id)blockers.push({code:'checker_assignment_required',label:'请先指派具备资格的独立复核人'});
  else if((await checkerEligibility(db,c,c.checker_person_id)).length)blockers.push({code:'checker_not_independent_or_authorized',label:'当前复核人的资格、权限或独立性不满足要求，请改派'});
  if(!round||!['submitted','locked'].includes(round.state)||!run||run.state!=='ready'||run.validity!=='current'||run.case_revision!==round.locked_revision)blockers.push({code:'checker_result_required',label:checkerCorrectionActive(c)?'更正后请重新预审，并确认最新更正结果':'请先完成当前轮材料、事实核对，并确认初审结果'});
  if(run&&bodyHash(run.snapshot)!==run.snapshot_hash)throw new AppError(409,'review_snapshot_corrupt');
  if(run?.state==='ready')try{await this.evidenceReview.validateCheckerSnapshot(db,run.snapshot);}catch(error){if(error instanceof AppError)blockers.push({code:error.code,label:'本轮来源或证据版本无法核验，须重新核对'});else throw error;}
  if(run&&!run.results?.length)blockers.push({code:'required_check_incomplete',label:'本轮没有完整的必查结果'});
  try{await assertNoInputWork(db,c,c.current_round_id??null);}catch(error){if(error instanceof AppError)blockers.push({code:error.code,label:'本轮仍有材料处理任务未结束'});else throw error;}
  const items=await this.items(db,c.id),dispositions=run?await this.dispositions(db,c.id,run.id):[];
  const issues=run?(await db.query('SELECT id,version,status,validity,latest_finding_id FROM business.review_issues WHERE case_id=$1 AND round_id=$2 ORDER BY id',[c.id,round.id])).rows:[];
  const replies=run?(await db.query("SELECT id,issue_id,details,actor_person_id FROM business.review_events WHERE case_id=$1 AND round_id=$2 AND kind IN ('external_reply','issue_decided') ORDER BY created_at,id",[c.id,round.id])).rows:[];
  const mail=run?(await db.query('SELECT id,version,format,body_hash,source_hash,body FROM business.review_mail_drafts WHERE case_id=$1 AND run_id=$2 ORDER BY version DESC LIMIT 1',[c.id,run.id])).rows[0]??null:null;
  if(run&&!mail)blockers.push({code:'checker_mail_required',label:'请先生成本轮待复核的预审邮件'});
  if(mail&&bodyHash(mail.body)!==mail.body_hash)throw new AppError(409,'checker_mail_corrupt');
  if(mail&&!await this.delivery.checkerMailCurrent(db,c,mail.id))blockers.push({code:'checker_mail_stale',label:'邮件依据已有变化，请重新生成本轮邮件'});
  if(release?.scope==='bank'&&!release.bankApprovalRef)blockers.push({code:'checker_business_configuration_unapproved',label:'正式业务配置尚缺批准依据'});
  // A file that was read but could not be typed or used does not hold the handover: it stays listed for the Checker,
  // and the rules that needed it remain unresolved. Only work that is still running waits (assertNoInputWork above).
  const unusedMaterials:CheckerBlocker[]=(run?.snapshot.pendingMaterials??[]).map((m:any)=>({code:'checker_materials_unused',label:run.snapshot.materialScope==='file-list'?'材料未能识别类型，未纳入本轮核对':'材料的用途或版本未确认，未纳入本轮核对',target:{kind:'material' as const,id:m.documentVersionId}}));
  const outstandingFindings=[...(run&&release?dispositionBlockers(run.results??[],release.rules??[],dispositions,new Date()):[]),...unusedMaterials];
  const sources=run?(await db.query('SELECT id,filename,sha256,current_parse_job_id FROM business.document_versions WHERE case_id=$1 AND round_id=$2 ORDER BY id',[c.id,round.id])).rows:[];
  if(run?.snapshot.materialScope==='file-list'){const included=new Set([...run.snapshot.materials,...(run.snapshot.pendingMaterials??[])].map((m:any)=>m.documentVersionId));sources.splice(0,sources.length,...sources.filter(d=>included.has(d.id)));}
  if(run?.snapshot.materials?.some((m:any)=>!sources.some(d=>d.id===m.documentVersionId&&d.sha256===m.sourceSha256&&d.current_parse_job_id===m.parseRevision)))blockers.push({code:'checker_source_changed',label:'材料来源版本已变化，需要重新核对并审核'});
  const formalInput={caseId:c.id,roundId:round?.id??'',runId:run?.id??'',snapshotHash:run?.snapshot_hash??'',configurationReleaseId:run?.configuration_release_id??''};
  const formal=await this.formalReview.verify(formalInput,db);
  const formalRules=(release?.rules??[]).map((r:any)=>({...r,id:`formal:${r.id}`,label:`正式审核 · ${r.label}`,operator:'manual_review'}));
  const results=[...(run?.results??[]),...(formal.findings??[])],rules=[...(release?.rules??[]),...formalRules];
  const factHistory=run?(await db.query('SELECT fact_id,object_id,field_id,version,body,confirmed_by,reason,created_at FROM business.review_fact_versions WHERE case_id=$1 AND round_id=$2 ORDER BY fact_id,version',[c.id,round.id])).rows:[];
  const snapshot={schemaVersion:'checker-submission.v1',caseId:c.id,roundId:round?.id??null,roundNumber:round?.number??null,runId:run?.id??null,
   configurationReleaseId:run?.configuration_release_id??null,configurationHash:release?bodyHash(release):null,makerPersonId:c.maker_person_id,checkerPersonId:c.checker_person_id,assignmentVersion:c.checker_assignment_version,
   configuration:release?{fields:release.fields.map((f:any)=>({id:f.id,label:f.label})),rules:rules.map((r:any)=>({id:r.id,label:r.label,sourceIds:r.sourceIds})),sources:release.sources}:null,factHistory,
   reviewSnapshot:run?.snapshot??null,reviewSnapshotHash:run?.snapshot_hash??null,results,issues,replies,sources,
   dispositions:dispositions.map(({author_name,...d})=>d),mail,
   returnItems:items.map(i=>({id:i.id,roundId:i.round_id,target:i.target,text:i.text,responses:i.responses.filter((e:any)=>e.kind==='response').map(({actor_name,...e}:any)=>e)})),
   formalDetails:formal.details??null,formalReceipt:formal.complete?{id:formal.receiptId,runId:formal.runId,snapshotHash:formal.snapshotHash,configurationReleaseId:formal.configurationReleaseId}:null};
  const frozen=JSON.parse(JSON.stringify(snapshot));
  return {round,run,release,items,dispositions,blockers,outstandingFindings,snapshot:frozen,hash:bodyHash(frozen),formal,results,rules};
 }
 private validateTarget(target:CheckerTarget,snapshot:any){
  const valid=target.kind==='case'||target.kind==='finding'&&snapshot.results.some((r:any)=>r.evaluationId===target.id)||target.kind==='field'&&snapshot.reviewSnapshot?.facts.some((f:any)=>f.factId===target.id)||target.kind==='material'&&snapshot.sources.some((d:any)=>d.id===target.id)||target.kind==='mail'&&snapshot.mail?.id===target.id;
  if(!valid)throw new AppError(422,'checker_target_outside_submission');
 }
 private async evidence(db:DB,c:any,evidence:any[]){
  for(const e of evidence){
   const doc=(await db.query('SELECT id,current_parse_job_id FROM business.document_versions WHERE id=$1 AND case_id=$2 AND round_id=$3',[e.documentVersionId,c.id,c.current_round_id])).rows[0];
   if(!doc||doc.current_parse_job_id!==e.parseRevision)throw new AppError(422,'checker_evidence_version_mismatch');
  }
  await this.evidenceReview.validateEvidence(db,c.id,evidence);
 }
 async submit(actor:Actor,id:string,raw:unknown){const input=CheckerSubmitSchema.parse(raw);return this.command(actor,id,'maker:submit',input,'submit',async(db,c)=>{
  await this.maker(db,actor,c);if(checkerCorrectionActive(c))throw new AppError(409,'checker_correction_in_progress');await assertCheckerInputsMutable(db,c);
  const ctx=await this.context(db,c);
  if(ctx.blockers.length)throw new AppError(409,ctx.blockers[0]!.code);
  if(ctx.round?.id!==input.roundId||ctx.run?.id!==input.runId||ctx.hash!==input.previewHash)throw new AppError(409,'checker_preview_stale');
  const number=Number((await db.query('SELECT coalesce(max(number),0)+1 AS n FROM business.checker_submissions WHERE case_id=$1',[id])).rows[0].n),submissionId=randomUUID();
  await db.query("INSERT INTO business.checker_submissions(id,case_id,round_id,run_id,number,maker_person_id,checker_person_id,assignment_version,snapshot,snapshot_hash,reason,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'submitted')",[submissionId,id,input.roundId,input.runId,number,actor.personId,c.checker_person_id,c.checker_assignment_version,JSON.stringify(ctx.snapshot),ctx.hash,input.reason]);
  await db.query("INSERT INTO business.contributions(id,case_id,person_id,kind) VALUES($1,$2,$3,'checker_submission')",[randomUUID(),id,actor.personId]);
  await this.event(db,actor,c,'submitted',{number,roundId:input.roundId,runId:input.runId},submissionId);return {submissionId};
 });}
 private async pending(db:DB,actor:Actor,c:any,id:string,version:number){
  await assertIndependentChecker(db,c,actor.personId);
  const s=(await db.query('SELECT * FROM business.checker_submissions WHERE id=$1 AND case_id=$2 FOR UPDATE',[id,c.id])).rows[0];
  if(!s)throw new AppError(404,'checker_submission_not_found');
  if(s.state!=='submitted'||s.validity!=='current'||s.version!==version||s.round_id!==c.current_round_id||s.checker_person_id!==c.checker_person_id||s.assignment_version!==c.checker_assignment_version)throw new AppError(409,'checker_submission_stale');
  if(bodyHash(s.snapshot)!==s.snapshot_hash)throw new AppError(409,'checker_snapshot_corrupt');
  const context=await this.context(db,c);
  if(context.hash!==s.snapshot_hash)throw new AppError(409,'checker_submission_stale');
  return {s,context};
 }
 async note(actor:Actor,id:string,submissionId:string,raw:unknown){const input=CheckerNoteSchema.parse(raw);return this.command(actor,id,'checker:comment',input,`note:${submissionId}`,async(db,c)=>{
  const {s}=await this.pending(db,actor,c,submissionId,input.submissionVersion);this.validateTarget(input.target,s.snapshot);
  await db.query('INSERT INTO business.checker_notes(id,case_id,submission_id,target,text,actor_person_id,account_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),id,submissionId,JSON.stringify(input.target),input.text,actor.personId,actor.accountId]);
  await this.event(db,actor,c,'commented',{},submissionId);
 });}
 async confirm(actor:Actor,id:string,submissionId:string,raw:unknown){const input=CheckerDecisionSchema.parse(raw);return this.command(actor,id,'checker:confirm',input,`confirm:${submissionId}`,async(db,c)=>{
  const {context}=await this.pending(db,actor,c,submissionId,input.submissionVersion);
  if(context.blockers.length)throw new AppError(409,context.blockers[0]!.code);
  await db.query("UPDATE business.checker_submissions SET state='confirmed',version=version+1,decided_at=now(),decision_reason=$2 WHERE id=$1",[submissionId,input.reason]);
  await db.query("UPDATE business.review_rounds SET state='locked' WHERE id=$1 AND state='submitted'",[context.round.id]);
  await this.event(db,actor,c,'confirmed',{reason:input.reason},submissionId);
 });}
 async returnToMaker(actor:Actor,id:string,submissionId:string,raw:unknown){const input=CheckerDecisionSchema.parse(raw);return this.command(actor,id,'checker:correct',input,`return:${submissionId}`,async(db,c)=>{
  const s=(await db.query('SELECT * FROM business.checker_submissions WHERE case_id=$1 AND round_id=$2 ORDER BY number DESC LIMIT 1 FOR UPDATE',[id,c.current_round_id])).rows[0],round=await currentRound(db,c);
  if(!returnableSubmission(c,round,s)||s.id!==submissionId||s.version!==input.submissionVersion)throw new AppError(409,'checker_submission_stale');
  if(bodyHash(s.snapshot)!==s.snapshot_hash)throw new AppError(409,'checker_snapshot_corrupt');
  await assertRoundExecutionSettled(db,round!);await assertNoInputWork(db,c,c.current_round_id);
  await db.query("UPDATE business.checker_submissions SET state='returned',version=version+1,decided_at=now(),decision_reason=$2 WHERE id=$1",[s.id,input.reason]);
  await db.query("UPDATE business.review_rounds SET state='draft' WHERE id=$1",[s.round_id]);
  // Keep the original report and submission, but require a new Maker execution.
  await db.query("UPDATE business.review_runs SET validity='stale' WHERE id=$1 AND case_id=$2",[s.run_id,id]);
  await this.event(db,actor,c,'returned_to_maker',{roundId:s.round_id,makerPersonId:c.maker_person_id,reason:input.reason},s.id);
 });}
 async beginCorrection(actor:Actor,id:string,submissionId:string,raw:unknown){const input=CheckerDecisionSchema.parse(raw);return this.command(actor,id,'checker:correct',input,`correct:${submissionId}`,async(db,c)=>{
  if(!await hasGrant(db,actor.personId,'field:correct',id))throw new AppError(403,'checker_correction_not_authorized');
  const s=(await db.query('SELECT * FROM business.checker_submissions WHERE case_id=$1 AND round_id=$2 ORDER BY number DESC LIMIT 1 FOR UPDATE',[id,c.current_round_id])).rows[0],round=await currentRound(db,c);
  if(!correctableSubmission(c,round,s)||s.id!==submissionId||s.version!==input.submissionVersion)throw new AppError(409,'checker_submission_stale');
  if(bodyHash(s.snapshot)!==s.snapshot_hash)throw new AppError(409,'checker_snapshot_corrupt');
  await assertRoundExecutionSettled(db,round!);await assertNoInputWork(db,c,c.current_round_id);
  await db.query("UPDATE business.checker_submissions SET validity='stale',version=version+1 WHERE id=$1",[s.id]);
  await db.query('UPDATE business.cases SET checker_correction_round_id=$2,checker_correction_person_id=$3,checker_correction_assignment_version=checker_assignment_version WHERE id=$1',[id,s.round_id,actor.personId]);
  await db.query("UPDATE business.review_rounds SET state='draft' WHERE id=$1 AND state IN ('submitted','locked')",[s.round_id]);
  await this.event(db,actor,c,'correction_started',{roundId:s.round_id,reason:input.reason},s.id);
 });}
 async confirmCorrection(actor:Actor,id:string,raw:unknown){const input=CheckerSubmitSchema.parse(raw);return this.command(actor,id,'checker:confirm',input,'confirm-correction',async(db,c)=>{
  if(!await isCorrectingChecker(db,c,actor.personId))throw new AppError(409,'checker_correction_required');
  const ctx=await this.context(db,c);
  if(ctx.blockers.length)throw new AppError(409,ctx.blockers[0]!.code);
  if(ctx.round?.id!==input.roundId||ctx.run?.id!==input.runId||ctx.hash!==input.previewHash)throw new AppError(409,'checker_preview_stale');
  const number=Number((await db.query('SELECT coalesce(max(number),0)+1 AS n FROM business.checker_submissions WHERE case_id=$1',[id])).rows[0].n),submissionId=randomUUID();
  await db.query("INSERT INTO business.checker_submissions(id,case_id,round_id,run_id,number,maker_person_id,checker_person_id,assignment_version,snapshot,snapshot_hash,reason,state,decided_at,decision_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'confirmed',now(),$11)",[submissionId,id,input.roundId,input.runId,number,c.maker_person_id,actor.personId,c.checker_assignment_version,JSON.stringify(ctx.snapshot),ctx.hash,input.reason]);
  await db.query("UPDATE business.review_rounds SET state='locked' WHERE id=$1 AND state='submitted'",[input.roundId]);
  await db.query('UPDATE business.cases SET checker_correction_round_id=NULL,checker_correction_person_id=NULL,checker_correction_assignment_version=NULL WHERE id=$1',[id]);
  await this.event(db,actor,c,'correction_confirmed',{roundId:input.roundId,runId:input.runId,reason:input.reason},submissionId);return {submissionId};
 });}
 async disposition(actor:Actor,id:string,raw:unknown){const input=CheckerDispositionSchema.parse(raw);const action=input.kind==='exception'?'exception:decide':input.kind==='professional_opinion'?'consultation:record':'finding:decide';return this.command(actor,id,action,input,'disposition',async(db,c)=>{
  if(checkerCorrectionActive(c)&&!await isCorrectingChecker(db,c,actor.personId))throw new AppError(409,'checker_correction_in_progress');
  if(input.kind!=='exception'&&!await isCorrectingChecker(db,c,actor.personId))await this.maker(db,actor,c);
  await assertCheckerInputsMutable(db,c);await this.evidence(db,c,input.evidence);
  const ctx=await this.context(db,c);
  if(!ctx.run||ctx.run.state!=='ready'||ctx.run.validity!=='current'||ctx.run.id!==input.runId||ctx.round?.id!==input.roundId)throw new AppError(409,'checker_result_required');
  const finding=ctx.results.find((r:any)=>r.evaluationId===input.findingId),rule=ctx.rules.find((r:any)=>r.id===finding?.ruleId);
  if(!finding)throw new AppError(422,'checker_target_outside_submission');
  const object=ctx.run.snapshot.objects.find((o:any)=>o.objectId===finding.scopeId);
  if(object&&!reviewEvidenceBelongsToObject(object,input.evidence))throw new AppError(422,'fact_evidence_object_mismatch');
  if(input.kind==='manual_satisfied'&&(!manualConclusionAllowed(rule,finding)||!input.verified))throw new AppError(422,'checker_manual_conclusion_not_allowed');
  if(input.opinionIds.some(id=>!ctx.dispositions.some(d=>d.id===id&&d.run_id===input.runId&&d.finding_id===input.findingId&&d.kind==='professional_opinion')))throw new AppError(422,'checker_opinion_scope_mismatch');
  if(input.receivedAt&&new Date(input.receivedAt)>new Date()||input.validUntil&&new Date(input.validUntil)<=new Date())throw new AppError(422,'checker_disposition_date_invalid');
  const dispositionId=randomUUID();
  await db.query(`INSERT INTO business.checker_dispositions(id,case_id,round_id,run_id,finding_id,rule_id,kind,reason,evidence,actor_person_id,account_id,external_author,source,received_at,verified,valid_until,conditions,opinion_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[dispositionId,id,input.roundId,input.runId,input.findingId,finding.ruleId,input.kind,input.reason,JSON.stringify(input.evidence),actor.personId,actor.accountId,input.externalAuthor??null,input.source??null,input.receivedAt??null,input.verified,input.validUntil??null,input.conditions??null,JSON.stringify(input.opinionIds)]);
  await db.query("INSERT INTO business.contributions(id,case_id,person_id,kind) VALUES($1,$2,$3,$4)",[randomUUID(),id,actor.personId,checkerCorrectionActive(c,actor.personId)?'checker_correction':'human_disposition']);
  await invalidateCheckerContent(db,id);await this.event(db,actor,c,'disposition_recorded',{dispositionId,kind:input.kind});return {dispositionId};
 });}
 /** The closure service calls this inside its existing case transaction. */
 async assertConfirmedForClosure(db:DB,c:any){
  const ctx=await this.context(db,c);
  const s=(await db.query("SELECT * FROM business.checker_submissions WHERE case_id=$1 AND round_id=$2 AND state='confirmed' AND validity='current' ORDER BY number DESC LIMIT 1",[c.id,c.current_round_id])).rows[0];
  if(!s||s.snapshot_hash!==ctx.hash||ctx.blockers.length)throw new AppError(409,'checker_confirmation_required');
  await assertIndependentChecker(db,c,s.checker_person_id);
  // Unresolved findings do not stop a normal close. They are returned so the closer acknowledges each one
  // and the confirmation token covers exactly this set.
  const outstandingFindingIds=ctx.outstandingFindings.flatMap(f=>f.target?.kind==='finding'&&f.target.id?[f.target.id]:[]).sort();
  return {submissionId:s.id,submissionNumber:s.number,checkerPersonId:s.checker_person_id,confirmedAt:iso(s.decided_at),snapshotHash:s.snapshot_hash,outstandingFindingIds};
 }
 async terminate(actor:Actor,id:string,raw:unknown){const input=CheckerCommandSchema.extend({confirmUnreviewed:z.literal(true)}).parse(raw);return this.command(actor,id,'case:close',input,'terminate',async(db,c)=>{
  await this.maker(db,actor,c);
  // Upload/model calls must be settled by their own cancellation/reconciliation flows first.
  await assertNoInputWork(db,c,c.current_round_id??null);
  if((await db.query("SELECT 1 FROM business.review_runs WHERE case_id=$1 AND state IN ('pending','running')",[id])).rowCount)throw new AppError(409,'review_round_execution_active');
  await db.query("UPDATE business.checker_submissions SET state='terminated',version=version+1,decided_at=now(),decision_reason=$2 WHERE case_id=$1 AND state='submitted'",[id,input.reason]);
  await this.event(db,actor,c,'terminated',{reason:input.reason,confirmed:false});
  const round=await currentRound(db,c);
  await db.query('UPDATE business.cases SET checker_required=true,closed_at=now(),closed_by=$2,closure_reason=$3,closed_round_id=$4,closed_run_id=$5,closure_receipt=$6,revision=revision+1,updated_at=now() WHERE id=$1',[id,actor.personId,input.reason,c.current_round_id,round?.run_id??null,JSON.stringify({kind:'checker_terminated',confirmed:false})]);
 });}
 async state(actor:Actor,id:string,selectedRound?:string):Promise<CheckerState>{return transaction(this.pool,async db=>{
  const c=await this.readCase(db,actor,id),ctx=await this.context(db,c),readOnly=Boolean(c.closed_at||selectedRound&&selectedRound!==c.current_round_id);
  if(selectedRound&&!(await db.query('SELECT 1 FROM business.review_rounds WHERE id=$1 AND case_id=$2',[selectedRound,id])).rowCount)throw new AppError(404,'review_round_not_found');
  const rows=(await db.query(`SELECT s.*,${named('s.maker_person_id')} AS maker_name,${named('s.checker_person_id')} AS checker_name FROM business.checker_submissions s WHERE case_id=$1 ORDER BY number DESC`,[id])).rows;
  const visible=rows.filter(s=>!selectedRound||s.round_id===selectedRound),latest=visible.find(s=>s.round_id===(selectedRound??c.current_round_id));
  const stale=(s:any)=>s.validity==='stale'||!readOnly&&s.round_id===c.current_round_id&&['submitted','confirmed'].includes(s.state)&&(s.snapshot_hash!==ctx.hash||ctx.blockers.some(b=>b.code==='checker_not_independent_or_authorized'));
  const current=rows.find(s=>s.round_id===c.current_round_id),pending=current?.state==='submitted'&&!stale(current);
  const person=c.checker_person_id?(await db.query('SELECT display_name FROM auth.people WHERE id=$1',[c.checker_person_id])).rows[0]:null;
  const historical=Boolean(selectedRound&&selectedRound!==c.current_round_id),correcting=checkerCorrectionActive(c);
  const summary:CheckerSummary={enabled:true,status:!historical&&c.closure_receipt?.kind==='checker_terminated'?'terminated':!historical&&!c.checker_person_id?'assignment_required':!historical&&correcting?'correcting':latest?.state==='terminated'?'terminated':latest?.state==='returned'?'returned':latest&&stale(latest)&&!(historical&&latest.state==='confirmed')?'stale':!latest||latest.state==='withdrawn'?'not_submitted':latest.state==='submitted'?'pending':latest.state,personId:historical?(latest?.checker_person_id??null):(c.checker_person_id??null),displayName:historical?(latest?.checker_name??null):(person?.display_name??null),submissionId:latest?.id??null,confirmedAt:latest?.state==='confirmed'?iso(latest.decided_at):null};
  const allowedActions:string[]=[];const maker=c.maker_person_id===actor.personId&&await isEligibleMaker(db,actor.personId,id),independent=c.checker_person_id===actor.personId&&!(await checkerEligibility(db,c,actor.personId)).length;
  if(!readOnly){
   if(await hasGrant(db,actor.personId,'case:assign',id))allowedActions.push('checker:assign');
   if(maker&&await hasGrant(db,actor.personId,'case:close',id))allowedActions.push('checker:terminate');
   if(maker&&!correcting&&!pending&&await hasGrant(db,actor.personId,'maker:submit',id)){allowedActions.push('checker:prepare-submit');if(!ctx.blockers.length)allowedActions.push('checker:submit');}
   if((maker&&!correcting||await isCorrectingChecker(db,c,actor.personId))&&!pending)for(const action of ['finding:decide','consultation:record'])if(await hasGrant(db,actor.personId,action,id))allowedActions.push(action);
   if(!pending&&await hasGrant(db,actor.personId,'exception:decide',id))allowedActions.push('exception:decide');
   if(independent&&pending){allowedActions.push('checker:comment');if(!ctx.blockers.length)allowedActions.push('checker:confirm');}
   if(independent&&correctableSubmission(c,ctx.round,current)&&await hasGrant(db,actor.personId,'checker:correct',id)&&await hasGrant(db,actor.personId,'field:correct',id))allowedActions.push('checker:correct');
   if(independent&&returnableSubmission(c,ctx.round,current)&&await hasGrant(db,actor.personId,'checker:correct',id))allowedActions.push('checker:return');
   if(await isCorrectingChecker(db,c,actor.personId)){allowedActions.push('checker:editing');if(!ctx.blockers.length&&await hasGrant(db,actor.personId,'checker:confirm',id))allowedActions.push('checker:confirm-correction');}
  }
  const candidates=[] as CheckerState['candidates'];
  if(allowedActions.includes('checker:assign'))for(const p of (await db.query("SELECT DISTINCT p.person_id,people.display_name FROM business.principals p JOIN auth.people people ON people.id=p.person_id WHERE p.business_role='BCO' AND p.enabled ORDER BY people.display_name,p.person_id LIMIT 500")).rows){const reasons=await checkerEligibility(db,c,p.person_id);candidates.push({personId:p.person_id,displayName:p.display_name,eligible:!reasons.length,reasons});}
  const notes=(await db.query(`SELECT n.*,${named('n.actor_person_id')} AS actor_name FROM business.checker_notes n WHERE case_id=$1 ORDER BY created_at,id`,[id])).rows.filter(n=>visible.some(s=>s.id===n.submission_id));
  const selectedSnapshot=selectedRound&&selectedRound!==c.current_round_id?latest?.snapshot:null;
  const dispositions=selectedSnapshot?.dispositions??(readOnly&&selectedRound?(latest?await this.dispositions(db,id,latest.run_id):[]):ctx.dispositions);
  const visibleItems=ctx.items.filter(i=>!readOnly||!selectedRound||i.round_id===selectedRound);
  // History uses events recorded at the decision cutoff, never a later round's reply.
  const cutoff=readOnly&&selectedRound?(await db.query('SELECT created_at FROM business.review_rounds WHERE case_id=$1 AND number>(SELECT number FROM business.review_rounds WHERE id=$2) ORDER BY number LIMIT 1',[id,selectedRound])).rows[0]?.created_at:null;
  return {caseId:id,revision:c.revision,roundId:selectedRound??c.current_round_id,readOnly,summary,assignmentVersion:c.checker_assignment_version,allowedActions,candidates,blockers:readOnly?[]:ctx.blockers,outstandingFindings:readOnly?[]:ctx.outstandingFindings,previewHash:readOnly?null:ctx.hash,runId:readOnly?latest?.run_id??null:ctx.run?.id??null,formalReviewAvailable:ctx.formal.available,
   submissions:visible.map((s,index)=>({id:s.id,roundId:s.round_id,roundNumber:s.snapshot.roundNumber,runId:s.run_id,number:s.number,version:s.version,state:s.state,validity:stale(s)?'stale':'current',makerPersonId:s.maker_person_id,checkerPersonId:s.checker_person_id,makerName:s.maker_name,checkerName:s.checker_name,createdAt:iso(s.created_at)!,decidedAt:iso(s.decided_at),reason:s.reason,decisionReason:s.decision_reason,snapshotHash:s.snapshot_hash,snapshot:s.snapshot,changes:visible[index+1]?['reviewSnapshot','issues','dispositions','mail','returnItems'].filter(k=>bodyHash(s.snapshot[k])!==bodyHash(visible[index+1].snapshot[k])):[]})),
   items:visibleItems.map((item:any)=>{const events=item.responses.filter((r:any)=>!cutoff||new Date(r.created_at)<new Date(cutoff)),last=events.at(-1),i={...item,responses:events,...(cutoff?{status:last?.kind==='accepted'?'accepted':last?.kind==='response'?'responded':'open',version:events.length+1}:{})};return ({id:i.id,submissionId:i.submission_id,roundId:i.round_id,target:i.target,text:i.text,version:i.version,status:i.status,responses:(i.responses??[]).map((r:any)=>({id:r.id,kind:r.kind,text:r.text,actorName:r.actor_name??'已记录人员',createdAt:iso(r.created_at)!,evidence:r.evidence??[]}))});}),
   dispositions:dispositions.map((d:any)=>({id:d.id,runId:d.run_id,findingId:d.finding_id,ruleId:d.rule_id,kind:d.kind,reason:d.reason,authorName:d.author_name??'已记录人员',createdAt:iso(d.created_at)!,verified:d.verified,validUntil:iso(d.valid_until),externalAuthor:d.external_author,source:d.source,receivedAt:iso(d.received_at),conditions:d.conditions,evidence:d.evidence,opinionIds:d.opinion_ids})),
   notes:notes.map(n=>({id:n.id,submissionId:n.submission_id,target:n.target,text:n.text,actorName:n.actor_name,createdAt:iso(n.created_at)!})),
   evidenceChoices:readOnly?[]:[...new Map<string,CheckerState['evidenceChoices'][number]>([
    ...(ctx.run?.snapshot.facts??[]).flatMap((f:any)=>(f.evidence??[]).map((e:any)=>[bodyHash(e),{key:bodyHash(e),label:`${ctx.run.snapshot.objects.find((o:any)=>o.objectId===f.objectId)?.label??'对象'} · ${ctx.release?.fields.find((v:any)=>v.id===f.fieldId)?.label??f.fieldId} · ${e.sourceNodeId?'Word 原文':'PDF 原文'}`,evidence:e}])),
    ...(ctx.formal.details?.evidence??[]).flatMap((source:any)=>source.locations.map((e:any)=>[bodyHash(e),{key:bodyHash(e),label:`正式审核 · ${source.filename} · ${e.sourceNodeId?'Word 原文':'PDF 原文'}`,evidence:e}]))
   ]).values()],
   findings:readOnly?[]:ctx.results.map((r:any)=>({id:r.evaluationId,ruleId:r.ruleId,label:ctx.rules.find((v:any)=>v.id===r.ruleId)?.label??r.ruleId,outcome:r.outcome,reasonCode:r.reasonCode,manualAllowed:manualConclusionAllowed(ctx.rules.find((v:any)=>v.id===r.ruleId),r)}))};
 });}
 async inbox(actor:Actor){return transaction(this.pool,async db=>{
  // The case read and evidence scopes are rechecked per item; a task is not an access grant.
  const rows=(await db.query("SELECT c.id,coalesce(nullif(c.title,''),c.case_number,nullif(c.reference,''),c.id::text) AS title,c.reference FROM business.cases c LEFT JOIN LATERAL (SELECT * FROM business.checker_submissions x WHERE x.case_id=c.id AND x.round_id=c.current_round_id ORDER BY x.number DESC LIMIT 1) s ON true WHERE c.checker_person_id=$1 AND c.closed_at IS NULL AND (s.state='submitted' OR c.checker_correction_round_id=c.current_round_id AND c.checker_correction_person_id=c.checker_person_id AND c.checker_correction_assignment_version=c.checker_assignment_version) ORDER BY s.created_at LIMIT 100",[actor.personId])).rows;
  const items=[];for(const row of rows){try{const c=await this.readCase(db,actor,row.id);await assertIndependentChecker(db,c,actor.personId);if(await isCorrectingChecker(db,c,actor.personId)){items.push({...row,roundId:c.current_round_id,submissionId:null});continue;}const ctx=await this.context(db,c);const s=(await db.query("SELECT * FROM business.checker_submissions WHERE case_id=$1 AND round_id=$2 ORDER BY number DESC LIMIT 1",[c.id,c.current_round_id])).rows[0];if(s?.state==='submitted'&&(s.validity==='current'&&s.snapshot_hash===ctx.hash||correctableSubmission(c,ctx.round,s)&&await hasGrant(db,actor.personId,'checker:correct',c.id)&&await hasGrant(db,actor.personId,'field:correct',c.id)))items.push({...row,roundId:c.current_round_id,submissionId:s.id});}catch(e){if(!(e instanceof AppError&&[403,404].includes(e.status)))throw e;}}
  return {items};
 });}
}

export function registerCheckerRoutes(app:FastifyInstance,auth:Auth,service:CheckerService){
 const base='/api/cases/:caseId/checker',params=(r:any)=>z.object({caseId:z.uuid(),submissionId:z.uuid().optional()}).parse(r.params);
 app.get('/api/checker/inbox',async r=>service.inbox(await auth.requireSession(r)));
 app.get(base,async r=>service.state(await auth.requireSession(r),params(r).caseId,z.object({roundId:z.uuid().optional()}).parse(r.query).roundId));
 app.post(`${base}/assignment`,async r=>service.assign(await auth.checkWrite(r),params(r).caseId,r.body));
 app.post(`${base}/terminate`,async r=>service.terminate(await auth.checkWrite(r),params(r).caseId,r.body));
 app.post(`${base}/submissions`,async r=>service.submit(await auth.checkWrite(r),params(r).caseId,r.body));
 app.post(`${base}/dispositions`,async r=>service.disposition(await auth.checkWrite(r),params(r).caseId,r.body));
 for(const [action,method] of [['notes','note'],['correct','beginCorrection'],['return','returnToMaker'],['confirm','confirm']] as const)app.post(`${base}/submissions/:submissionId/${action}`,async r=>{const p=params(r);return service[method](await auth.checkWrite(r),p.caseId,p.submissionId!,r.body);});
 app.post(`${base}/corrections/confirm`,async r=>service.confirmCorrection(await auth.checkWrite(r),params(r).caseId,r.body));
}
