import {checkerCorrectionActive} from '../review-checker/access.js';
import {materialListIds} from '../materials/review-scope.js';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {RoundCommandSchema,type ReviewRound,type ReviewRoundsState} from '@hsbc/contracts/review-rounds';
import {transaction,type DB} from '../../infrastructure/database/client.js';
import {idempotent} from '../../infrastructure/database/idempotency.js';
import {AppError} from '../../shared/errors.js';
import {authorizeCase,canEditReview,authorizeReviewCompletion,isAssignedCompletionChecker} from '../cases/authorization.js';
import {hasGrant,lockPersons} from '../identity/authorization.js';
import type {Actor} from '../identity/types.js';
import type {Auth} from '../identity/auth.js';
import {audit} from '../audit/events.js';
import {assertNoInputWork,currentRound,assertRoundExecutionSettled} from './round-boundary.js';
import type {ReviewService} from './service.js';

async function record(db:DB,actor:Actor,c:any,roundId:string,kind:string,reason:string){
  await db.query('INSERT INTO business.review_events(id,case_id,round_id,case_revision,kind,actor_person_id,account_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),c.id,roundId,c.revision,kind,actor.personId,actor.accountId,JSON.stringify({roundId,reason})]);
  await audit(db,{actorId:actor.accountId,targetId:c.id,action:`review.${kind}`,details:{roundId,revision:c.revision}});
}
/** Used inside explicit case creation, before draft attachments are transferred. */
export async function createInitialReviewRound(db:DB,actor:Actor,caseId:string){
  const id=randomUUID();
  await db.query("INSERT INTO business.review_rounds(id,case_id,number,created_by,reason) VALUES($1,$2,1,$3,'建案时准备第一轮')",[id,caseId,actor.personId]);
  const c=(await db.query('UPDATE business.cases SET review_rounds_enabled=true,current_round_id=$2 WHERE id=$1 RETURNING *',[caseId,id])).rows[0];
  await record(db,actor,c,id,'round_prepared','建案时准备第一轮');return id;
}

export class ReviewRoundService {
  constructor(readonly pool:Pool){}
  async list(actor:Actor,caseId:string):Promise<ReviewRoundsState>{return transaction(this.pool,async db=>{
    const c=await authorizeCase(db,actor,caseId,'case:read',false);return this.view(db,actor,c);
  });}
  private async view(db:DB,actor:Actor,c:any):Promise<ReviewRoundsState>{
    const editable=!c.closed_at&&await canEditReview(db,c,actor.personId)&&await hasGrant(db,actor.personId,'case:start',c.id);
    const canPrepareNext=!c.closed_at&&(editable||!!c.current_round_id&&await isAssignedCompletionChecker(db,c,actor.personId));
    const checkerPending=Boolean((await db.query("SELECT 1 FROM business.checker_submissions WHERE case_id=$1 AND state='submitted' AND validity='current' LIMIT 1",[c.id])).rowCount);
    const checkerConfirmed=Boolean((await db.query("SELECT 1 FROM business.checker_submissions WHERE case_id=$1 AND round_id=$2 AND run_id=(SELECT run_id FROM business.review_rounds WHERE id=$2) AND state='confirmed' AND validity='current' AND assignment_version=$3 AND checker_person_id=$4 LIMIT 1",[c.id,c.current_round_id??null,c.checker_assignment_version,c.checker_person_id])).rowCount);
    const rows=(await db.query(`SELECT q.*,r.state AS run_state,r.validity,r.snapshot_hash,release.manifest->'guaranteeTypes' AS guarantee_types,
      (SELECT count(*)::int FROM business.document_versions d WHERE d.case_id=q.case_id AND d.round_id=q.id) AS material_count,
      NOT EXISTS(SELECT 1 FROM business.review_events e WHERE e.round_id=q.id AND e.kind='round_result_confirmed') AND NOT EXISTS(SELECT 1 FROM business.checker_submissions s WHERE s.round_id=q.id AND s.validity='current' AND s.state IN ('submitted','confirmed')) AS legacy_reopen
      FROM business.review_rounds q LEFT JOIN business.review_runs r ON r.id=q.run_id LEFT JOIN business.review_config_releases release ON release.release_id=q.configuration_release_id
      WHERE q.case_id=$1 ORDER BY q.number DESC`,[c.id])).rows;
    for(const q of rows){const ids=await materialListIds(db,c.id,q.id);if(ids!==null)q.material_count=ids.length;}
    const correcting=checkerCorrectionActive(c);
    const returned=(await db.query(`SELECT s.decision_reason FROM business.review_rounds q JOIN LATERAL
      (SELECT state,run_id,decision_reason FROM business.checker_submissions WHERE case_id=q.case_id AND round_id=q.id ORDER BY number DESC LIMIT 1) s ON true
      WHERE q.id=$1 AND q.state='draft' AND s.state='returned' AND s.run_id=q.run_id`,[c.current_round_id??null])).rows[0];
    const returnedToMaker=Boolean(returned);
    const items:ReviewRound[]=rows.map(q=>({roundId:q.id,caseId:q.case_id,roundNumber:q.number,status:q.state==='submitted'?'checker_pending':q.state==='locked'?(q.validity==='stale'?'stale':q.run_state==='ready'?(q.id===c.current_round_id?(q.legacy_reopen?'ready':checkerConfirmed?'completed':'checker_pending'):'completed'):q.run_state??'stale'):q.state==='draft'&&q.run_id?(q.validity==='stale'?'stale':q.run_state??'stale'):q.state,locked:q.state!=='draft',
      configurationReleaseId:q.configuration_release_id,guaranteeTypes:q.guarantee_types??[],businessDate:q.business_date,
      createdAt:q.created_at.toISOString(),submittedAt:q.submitted_at?.toISOString()??null,discardedAt:q.discarded_at?.toISOString()??null,
      runId:q.run_id,snapshotHash:q.snapshot_hash??null,resultRef:q.run_state==='ready'&&q.validity==='current'?`/api/cases/${c.id}/review/runs/${q.run_id}`:null,materialsRef:`/api/cases/${c.id}/materials?roundId=${q.id}`,reviewStateRef:`/api/cases/${c.id}/review?roundId=${q.id}`,materialCount:q.material_count,
      allowedActions:!editable||checkerPending||q.id!==c.current_round_id?[]:q.state==='draft'?[...(correcting?[]:['round:discard']),...(['pending','running'].includes(q.run_state)?['round:cancel']:['round:start',...(q.run_state==='ready'&&q.validity==='current'?['round:confirm']:[]),...(['failed','canceled'].includes(q.run_state)?['round:retry']:[])])]:q.state==='submitted'||q.state==='locked'&&q.legacy_reopen&&!['pending','running'].includes(q.run_state)?['round:reopen',...(['failed','canceled','stale'].includes(q.run_state)?['round:retry']:[])]:q.state==='locked'&&['failed','canceled','stale'].includes(q.run_state)?['round:retry']:[],
    }));
    const active=rows.some(q=>['pending','running'].includes(q.run_state)||['draft','submitted'].includes(q.state)||q.id===c.current_round_id&&q.state==='locked'&&(!checkerConfirmed||q.legacy_reopen));
    const legacyRunning=(await db.query("SELECT 1 FROM business.review_runs WHERE case_id=$1 AND round_id IS NULL AND state IN ('pending','running') LIMIT 1",[c.id])).rowCount;
    const legacy=(await db.query('SELECT 1 FROM business.review_runs WHERE case_id=$1 AND round_id IS NULL UNION ALL SELECT 1 FROM business.document_versions WHERE case_id=$1 AND round_id IS NULL UNION ALL SELECT 1 FROM business.review_events WHERE case_id=$1 AND round_id IS NULL LIMIT 1',[c.id])).rowCount;
    const completionAllowed=canPrepareNext&&(c.maker_person_id===actor.personId||checkerConfirmed&&items.some(q=>q.roundId===c.current_round_id&&q.status==='completed'));
    return {caseId:c.id,revision:c.revision,checkerCorrection:correcting,returnedToMaker,...(returned?.decision_reason?{returnReason:returned.decision_reason as string}:{}),enabled:!!c.review_rounds_enabled,currentRoundId:c.current_round_id??null,items,hasLegacyRecords:!!legacy,allowedActions:completionAllowed&&!checkerPending&&!active&&!legacyRunning?['round:create']:[]};
  }
  async create(actor:Actor,caseId:string,raw:unknown){
    const input=RoundCommandSchema.parse(raw);
    return transaction(this.pool,async db=>{
      const before=(await db.query('SELECT maker_person_id,checker_person_id FROM business.cases WHERE id=$1',[caseId])).rows[0];
      await lockPersons(db,[actor.personId,...[before?.maker_person_id,before?.checker_person_id].filter(Boolean)]);
      const c=await authorizeReviewCompletion(db,actor,caseId,'round:create');
      if(c.maker_person_id!==before?.maker_person_id||c.checker_person_id!==before?.checker_person_id)throw new AppError(409,'stale_revision');
      const result=await idempotent(db,actor,`round.create:${caseId}`,input.idempotencyKey,input,async()=>{
        if(c.closed_at)throw new AppError(409,'case_closed');
        if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
        const round=await currentRound(db,c);
        if(round?.state==='submitted')throw new AppError(409,'checker_confirmation_required');
        if(round?.state==='locked'&&!(await db.query("SELECT 1 FROM business.checker_submissions WHERE case_id=$1 AND round_id=$2 AND run_id=$5 AND state='confirmed' AND validity='current' AND assignment_version=$3 AND checker_person_id=$4 LIMIT 1",[c.id,round.id,c.checker_assignment_version,c.checker_person_id,round.run_id])).rowCount)throw new AppError(409,'checker_confirmation_required');
        if(round?.run_id)await assertRoundExecutionSettled(db,round);
        if(round?.state==='draft')throw new AppError(409,'review_round_draft_exists');
        if(c.maker_person_id!==actor.personId&&round?.state!=='locked')throw new AppError(409,'checker_confirmation_required');
        if((await db.query("SELECT 1 FROM business.review_runs WHERE case_id=$1 AND state IN ('pending','running') LIMIT 1",[caseId])).rowCount)throw new AppError(409,'review_round_execution_active');
        await assertNoInputWork(db,c,c.current_round_id??null);
        const id=randomUUID(),number=Number((await db.query('SELECT COALESCE(max(number),0)+1 AS number FROM business.review_rounds WHERE case_id=$1',[caseId])).rows[0].number);
        await db.query('INSERT INTO business.review_rounds(id,case_id,number,configuration_release_id,created_by,reason) VALUES($1,$2,$3,$4,$5,$6)',[id,caseId,number,c.configuration_release_id??null,actor.personId,input.reason]);
        const updated=(await db.query(`UPDATE business.cases SET legacy_review_context=CASE WHEN review_rounds_enabled THEN legacy_review_context ELSE jsonb_build_object('configurationReleaseId',configuration_release_id,'businessDate',review_business_date) END,
          review_rounds_enabled=true,current_round_id=$2,review_business_date=NULL,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,[caseId,id])).rows[0];
        await record(db,actor,updated,id,'round_prepared',input.reason);return {roundId:id};
      });
      return {...await this.view(db,actor,(await db.query('SELECT * FROM business.cases WHERE id=$1',[caseId])).rows[0]),commandRoundId:result.roundId};
    });
  }
  async reopen(actor:Actor,caseId:string,roundId:string,raw:unknown){
    const input=RoundCommandSchema.parse(raw);
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'case:start');
      await idempotent(db,actor,`round.reopen:${caseId}:${roundId}`,input.idempotencyKey,input,async()=>{
        if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
        const round=await currentRound(db,c);
        if(round?.id!==roundId||!['submitted','locked'].includes(round.state))throw new AppError(409,'review_round_locked');
        if(round.state==='locked'&&((await db.query("SELECT 1 FROM business.review_events WHERE round_id=$1 AND kind='round_result_confirmed' UNION ALL SELECT 1 FROM business.checker_submissions WHERE round_id=$1 AND validity='current' AND state='confirmed' LIMIT 1",[roundId])).rowCount))throw new AppError(409,'review_round_locked');
        await assertRoundExecutionSettled(db,round);
        await assertNoInputWork(db,c,roundId);
        await db.query("UPDATE business.review_rounds SET state='draft' WHERE id=$1",[roundId]);
        const updated=(await db.query('UPDATE business.cases SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[caseId])).rows[0];
        await record(db,actor,updated,roundId,'round_reopened',input.reason);return {roundId};
      });
      return this.view(db,actor,(await db.query('SELECT * FROM business.cases WHERE id=$1',[caseId])).rows[0]);
    });
  }
  async discard(actor:Actor,caseId:string,roundId:string,raw:unknown){
    const input=RoundCommandSchema.parse(raw);
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'case:start');
      await idempotent(db,actor,`round.discard:${caseId}:${roundId}`,input.idempotencyKey,input,async()=>{
        if(c.closed_at)throw new AppError(409,'case_closed');
        if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
        const round=await currentRound(db,c);
        if(round?.id!==roundId)throw new AppError(409,'review_round_not_current');
        if(round.state!=='draft')throw new AppError(409,'review_round_locked');
        if(checkerCorrectionActive(c))throw new AppError(409,'checker_correction_in_progress');
        await db.query("UPDATE business.review_runs SET validity='stale',state=CASE WHEN state IN ('pending','running') THEN 'canceled' ELSE state END WHERE case_id=$1 AND round_id=$2",[caseId,roundId]);
        // Fence owners and leases in the same case-locked transaction. Late workers cannot write this draft again.
        const owners=(await db.query(`SELECT id FROM business.upload_sessions WHERE case_id=$1 AND round_id=$2 UNION ALL SELECT id FROM business.document_jobs WHERE case_id=$1 AND round_id=$2 UNION ALL SELECT id FROM business.review_supplements WHERE case_id=$1 AND round_id=$2 UNION ALL SELECT id FROM business.review_runs WHERE case_id=$1 AND round_id=$2`,[caseId,roundId])).rows.map(r=>r.id);
        await db.query("UPDATE business.upload_sessions SET state='canceled',updated_at=now() WHERE case_id=$1 AND round_id=$2 AND state IN ('issued','verifying')",[caseId,roundId]);
        await db.query("UPDATE business.document_jobs SET state='canceled',validity='stale',updated_at=now() WHERE case_id=$1 AND round_id=$2 AND state IN ('pending','running')",[caseId,roundId]);
        await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL,updated_at=now() WHERE owner_id=ANY($1::uuid[]) AND state IN ('pending','running')",[owners]);
        await db.query("UPDATE business.review_rounds SET state='discarded',run_id=NULL,submitted_at=NULL,locked_revision=NULL,discarded_at=now(),discarded_by=$2,discard_reason=$3 WHERE id=$1",[roundId,actor.personId,input.reason]);
        const previous=(await db.query("SELECT * FROM business.review_rounds WHERE case_id=$1 AND state='locked' ORDER BY number DESC LIMIT 1",[caseId])).rows[0];
        const updated=(await db.query('UPDATE business.cases SET current_round_id=$2,configuration_release_id=$3,review_business_date=$4,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[caseId,previous?.id??null,previous?.configuration_release_id??c.configuration_release_id,previous?.business_date??null])).rows[0];
        await record(db,actor,updated,roundId,'round_discarded',input.reason);return {roundId};
      });
      return this.view(db,actor,(await db.query('SELECT * FROM business.cases WHERE id=$1',[caseId])).rows[0]);
    });
  }
}

export function registerReviewRoundRoutes(app:FastifyInstance,auth:Auth,rounds:ReviewRoundService,reviews:ReviewService){
  const base='/api/cases/:caseId/review/rounds';
  const path=(request:any)=>z.object({caseId:z.uuid(),roundId:z.uuid().optional()}).parse(request.params);
  app.get(base,async request=>rounds.list(await auth.requireSession(request),path(request).caseId));
  app.get(`${base}/:roundId`,async request=>{const p=path(request),state=await rounds.list(await auth.requireSession(request),p.caseId);const round=state.items.find(q=>q.roundId===p.roundId);if(!round)throw new AppError(404,'review_round_not_found');return round;});
  app.post(base,async request=>rounds.create(await auth.checkWrite(request),path(request).caseId,request.body));
  app.post(`${base}/:roundId/discard`,async request=>{const p=path(request);return rounds.discard(await auth.checkWrite(request),p.caseId,p.roundId!,request.body);});
  app.post(`${base}/:roundId/start`,async request=>{const p=path(request);return reviews.start(await auth.checkWrite(request),p.caseId,{...z.record(z.string(),z.unknown()).parse(request.body),roundId:p.roundId});});
  app.post(`${base}/:roundId/confirm`,async request=>{const p=path(request);await reviews.confirmRound(await auth.checkWrite(request),p.caseId,p.roundId!,request.body);return rounds.list(await auth.requireSession(request),p.caseId);});
  app.post(`${base}/:roundId/reopen`,async request=>{const p=path(request);return rounds.reopen(await auth.checkWrite(request),p.caseId,p.roundId!,request.body);});
  app.post(`${base}/:roundId/retry`,async request=>{const p=path(request);return reviews.retryRound(await auth.checkWrite(request),p.caseId,p.roundId!,request.body);});
  app.post(`${base}/:roundId/cancel`,async request=>{const p=path(request);return reviews.cancelRound(await auth.checkWrite(request),p.caseId,p.roundId!,request.body);});
}
