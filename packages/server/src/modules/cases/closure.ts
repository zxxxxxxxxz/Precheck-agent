import {lockPersons} from '../identity/authorization.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import type {ClosurePreview} from '@hsbc/contracts/case-review-status';
import {RoundCommandSchema} from '@hsbc/contracts/review-rounds';
import {transaction,type DB} from '../../infrastructure/database/client.js';
import {idempotent} from '../../infrastructure/database/idempotency.js';
import {AppError} from '../../shared/errors.js';
import {authorizeReviewCompletion} from './authorization.js';
import {assertNoInputWork,currentRound} from '../review/round-boundary.js';
import {reviewHash} from '../review/service.js';
import {audit} from '../audit/events.js';
import type {Actor} from '../identity/types.js';
import type {Auth} from '../identity/auth.js';
import {caseReviewProjections} from './review-status.js';
import type {CheckerService} from '../review-checker/service.js';

export class CaseClosureService {
 constructor(readonly pool:Pool,readonly checker:Pick<CheckerService,'assertConfirmedForClosure'>){}
 private async lockedCase(db:DB,actor:Actor,caseId:string){
  const before=(await db.query('SELECT maker_person_id,checker_person_id FROM business.cases WHERE id=$1',[caseId])).rows[0];
  await lockPersons(db,[actor.personId,...[before?.maker_person_id,before?.checker_person_id].filter(Boolean)]);
  const c=await authorizeReviewCompletion(db,actor,caseId,'case:close');
  if(c.maker_person_id!==before?.maker_person_id||c.checker_person_id!==before?.checker_person_id)throw new AppError(409,'stale_revision');
  return c;
 }
 private async previewIn(db:DB,c:any):Promise<ClosurePreview>{
  if(c.closed_at)throw new AppError(409,'case_closed');
  if(!this.checker)throw new AppError(409,'checker_confirmation_required');
  const checkerConfirmation=await this.checker.assertConfirmedForClosure(db,c);
  if(!checkerConfirmation)throw new AppError(409,'checker_confirmation_required');
  if((await db.query("SELECT 1 FROM business.review_rounds WHERE case_id=$1 AND state='draft' LIMIT 1",[c.id])).rowCount)throw new AppError(409,'closure_draft_pending');
  if((await db.query("SELECT 1 FROM business.review_runs WHERE case_id=$1 AND state IN ('pending','running') LIMIT 1",[c.id])).rowCount)throw new AppError(409,'review_round_execution_active');
  await assertNoInputWork(db,c,c.current_round_id??null);
  const round=await currentRound(db,c),latest=(await db.query(`SELECT * FROM business.review_runs WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid ORDER BY created_at DESC,id DESC LIMIT 1`,[c.id,c.current_round_id??null])).rows[0];
  if(c.review_rounds_enabled&&(!round||round.state!=='locked'||round.run_id!==latest?.id))throw new AppError(409,'closure_result_required');
  if(!latest||latest.state!=='ready'||latest.validity!=='current'||latest.case_revision!==(round?.locked_revision??c.revision))throw new AppError(409,'closure_result_required');
  if(reviewHash(latest.snapshot)!==latest.snapshot_hash)throw new AppError(409,'review_snapshot_corrupt');
  const manifest=(await db.query('SELECT manifest FROM business.review_config_releases WHERE release_id=$1',[latest.configuration_release_id])).rows[0].manifest;
  const issues=(await db.query('SELECT * FROM business.review_issues WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid',[c.id,c.current_round_id??null])).rows;
  const unresolved=new Set<string>(checkerConfirmation.outstandingFindingIds);
  const items:ClosurePreview['items']=latest.results.filter((r:any)=>!['pass','not_applicable'].includes(r.outcome)).map((r:any)=>{const issue=issues.find(i=>i.latest_finding_id===r.evaluationId);return {id:r.evaluationId,ruleId:r.ruleId,label:manifest.rules.find((v:any)=>v.id===r.ruleId)?.label??r.ruleId,scopeId:r.scopeId,objectLabel:latest.snapshot.objects.find((o:any)=>o.objectId===r.scopeId)?.label??'待确认对象',outcome:r.outcome,reasonCode:r.reasonCode,unresolved:unresolved.has(r.evaluationId),issueId:issue?.id??null,issueVersion:issue?.version??null,issueStatus:issue?.status??null};}).sort((a:any,b:any)=>a.id.localeCompare(b.id));
  // Every unresolved finding must be one of the items the closer is shown and acknowledges.
  if([...unresolved].some(id=>!items.some(item=>item.id===id)))throw new AppError(409,'closure_result_required');
  const body={caseId:c.id,revision:c.revision,roundId:c.current_round_id??null,roundNumber:round?.number??null,runId:latest.id,snapshotHash:latest.snapshot_hash,items,checkerConfirmation};return {...body,confirmationToken:reviewHash(body)};
 }
 async preview(actor:Actor,caseId:string){return transaction(this.pool,async db=>this.previewIn(db,await this.lockedCase(db,actor,caseId)));}
 async close(actor:Actor,caseId:string,raw:unknown){
  const input=RoundCommandSchema.extend({roundId:z.uuid().nullable(),runId:z.uuid(),confirmationToken:z.string().regex(/^[a-f0-9]{64}$/),acknowledgedItemIds:z.array(z.uuid()).max(10000),
   // The closing reason applies to every acknowledged item; an item may carry its own reason instead.
   itemReasons:z.record(z.uuid(),z.string().trim().min(1).max(1000)).optional(),confirmPreReviewOnly:z.literal(true)}).parse(raw);
  return transaction(this.pool,async db=>{
   const c=await this.lockedCase(db,actor,caseId);
   await idempotent(db,actor,`case.close:${caseId}`,input.idempotencyKey,input,async()=>{
    if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
    const preview=await this.previewIn(db,c);
    if(input.roundId!==preview.roundId||input.runId!==preview.runId||input.confirmationToken!==preview.confirmationToken)throw new AppError(409,'closure_confirmation_stale');
    if(new Set(input.acknowledgedItemIds).size!==input.acknowledgedItemIds.length||JSON.stringify([...input.acknowledgedItemIds].sort())!==JSON.stringify(preview.items.map(i=>i.id).sort()))throw new AppError(422,'closure_items_not_acknowledged');
    if(Object.keys(input.itemReasons??{}).some(id=>!preview.items.some(item=>item.id===id)))throw new AppError(422,'closure_items_not_acknowledged');
    // Each item keeps its original conclusion together with the reason it was left as it is.
    const acknowledgements=preview.items.map(item=>({itemId:item.id,ruleId:item.ruleId,scopeId:item.scopeId,outcome:item.outcome,reasonCode:item.reasonCode,unresolved:item.unresolved,reason:input.itemReasons?.[item.id]??input.reason}));
    await db.query('INSERT INTO business.review_events(id,case_id,round_id,case_revision,kind,actor_person_id,account_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),caseId,preview.roundId,c.revision+1,'pre_review_closed',actor.personId,actor.accountId,JSON.stringify({runId:preview.runId,reason:input.reason,acknowledgedItemIds:input.acknowledgedItemIds,acknowledgements})]);
    await db.query('UPDATE business.cases SET closed_at=now(),closed_by=$2,closure_reason=$3,closed_round_id=$4,closed_run_id=$5,closure_receipt=$6,revision=revision+1,updated_at=now() WHERE id=$1',[caseId,actor.personId,input.reason,preview.roundId,preview.runId,JSON.stringify({...preview,acknowledgements})]);
    await audit(db,{actorId:actor.accountId,targetId:caseId,action:'case.pre_review_closed',details:{roundId:preview.roundId??'legacy',runId:preview.runId,outstandingCount:preview.items.length,unresolvedCount:preview.items.filter(item=>item.unresolved).length}});return {caseId};
   });return (await caseReviewProjections(db,[caseId])).get(caseId)!;
  });
 }
}
export function registerCaseClosureRoutes(app:FastifyInstance,auth:Auth,service:CaseClosureService){
 const id=(r:any)=>z.uuid().parse(r.params.caseId);
 app.get('/api/cases/:caseId/closure-preview',async r=>service.preview(await auth.requireSession(r),id(r)));
 app.post('/api/cases/:caseId/close',async r=>service.close(await auth.checkWrite(r),id(r),r.body));
}
