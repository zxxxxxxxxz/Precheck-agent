import {registerReviewTeams,lockCreationTeam,assignCreationTeam} from './review-teams.js';
import {caseExtractedParties} from './extracted-parties.js';
import {reviewedPartyNames} from './reviewed-parties.js';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import {caseReviewProjections} from './review-status.js';
import {assertNoInputWork,currentRound,ROUND_INPUT_ACTIONS} from '../review/round-boundary.js';
import {createInitialReviewRound} from '../review/rounds.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { CaseDetailsSchema, emptyCaseDetails, CaseCreationFieldsSchema, CreateCaseFromDraftSchema, type CaseConfigurationOptions, type CaseReviewSelection } from '@hsbc/contracts/draft';
import { assertOpenDraft, authorizeDraft } from './draft-state.js';
import type { Auth } from '../identity/auth.js';
import { AppError } from '../../shared/errors.js';
import { assertActor, hasGrant, lockPersons, requireBusinessRole, requireGrant } from '../identity/authorization.js';
import { audit } from '../audit/events.js';
import { authorizeCase, isEligibleMaker, requireCaseCreator, isAssignedCompletionChecker } from './authorization.js';
import { idempotent } from '../../infrastructure/database/idempotency.js';
import { transaction, type DB } from '../../infrastructure/database/client.js';
import { type Actor } from '../identity/types.js';
import { type AppConfig } from '../../runtime/config.js';
import {allocateCaseNumber} from './numbering.js';

export interface CaseDraftLifecycle {
  reviewedFields?: (db: PoolClient, actor: Actor, caseId: string) => Promise<ChecklistRow[]>;
  adoptAttachments(db: PoolClient, actor: Actor, draftId: string, caseId: string): Promise<void>;
  cancelTurns(db: DB, draftId: string): Promise<void>;
  configurations?: {
    list(db: DB, actor: Actor): Promise<CaseConfigurationOptions>;
    initialize(db: PoolClient, actor: Actor, caseId: string, selection: CaseReviewSelection): Promise<void>;
  };
}

async function view(db:PoolClient,actor:Actor,row:any,lifecycle:CaseDraftLifecycle){
  const actions=['case:read'];const round=await currentRound(db,row),projection=(await caseReviewProjections(db,[row.id])).get(row.id)!;
  const {business_role:role}=await assertActor(db,actor),businessRole=role==='BCO';
  const completionChecker=await isAssignedCompletionChecker(db,row,actor.personId);
  for(const action of ['case:assign','case:confirm-scenario','material:upload','evidence:read','document:parse','document:classify','case:configure','case:start','material:adopt','field:correct','finding:decide','case:close']){
    if(row.closed_at&&action!=='evidence:read')continue;
    if(row.review_rounds_enabled&&round?.run_id&&(ROUND_INPUT_ACTIONS as readonly string[]).includes(action)&&(await db.query("SELECT 1 FROM business.review_runs WHERE id=$1 AND state IN ('pending','running') AND validity='current'",[round.run_id])).rowCount)continue;
    if(row.review_rounds_enabled&&(ROUND_INPUT_ACTIONS as readonly string[]).includes(action)&&round?.state!=='draft')continue;
    if(action==='case:close'){if(!['results_pending','round_completed'].includes(projection.preReviewStatus))continue;try{await assertNoInputWork(db,row,row.current_round_id??null);}catch(error){if(error instanceof AppError)continue;throw error;}}
    if(!await hasGrant(db,actor.personId,action,row.id)&&!(action==='case:close'&&completionChecker))continue;
    if(action!=='evidence:read'&&!businessRole)continue;
    if(action==='case:confirm-scenario'&&row.scenario!=='pending')continue;
    if(action==='case:close'&&row.scenario!=='overseas_loan')continue;
    if(['document:parse','document:classify'].includes(action)&&row.scenario!=='overseas_loan')continue;
    if(action==='document:classify'&&(role!=='BCO'||row.maker_person_id!==actor.personId||!await isEligibleMaker(db,actor.personId,row.id)))continue;
    if(action==='material:upload'&&(row.maker_person_id!==actor.personId||!await isEligibleMaker(db,actor.personId,row.id)))continue;
    if(['case:configure','case:start','material:adopt','field:correct','finding:decide','case:close'].includes(action)&&!(action==='case:close'&&completionChecker)&&
      (row.scenario!=='overseas_loan'||row.maker_person_id!==actor.personId||!await isEligibleMaker(db,actor.personId,row.id)))continue;
    actions.push(action);
  }
  if (actions.includes('evidence:read') && projection.guaranteeTypes.includes('corporate_guarantee') &&
    (!projection.borrowers.length || !projection.guarantors.length) && lifecycle.reviewedFields) {
    const reviewed = reviewedPartyNames(await lifecycle.reviewedFields(db, actor, row.id));
    for (const role of ['borrowers', 'guarantors'] as const) {
      if (!projection[role].length && reviewed[role].length) {
        projection[role] = reviewed[role];
        projection.partySources = {...projection.partySources, [role]: 'reviewed'};
      }
    }
  }
  if (actions.includes('evidence:read') && (!projection.borrowers.length || !projection.guarantors.length)) {
    const extracted = await caseExtractedParties(db, row);
    for (const role of ['borrowers', 'guarantors'] as const) {
      if (!projection[role].length && extracted[role].length) {
        projection[role] = extracted[role];
        projection.partySources = {...projection.partySources, [role]: 'extracted'};
      }
    }
  }
  const makerDisplayName=row.maker_person_id?(await db.query('SELECT display_name FROM auth.people WHERE id=$1',[row.maker_person_id])).rows[0]?.display_name:null;
  return {...projection,id:row.id,caseNumber:row.case_number??null,title:row.title,reference:row.reference,background:row.background,details:{...emptyCaseDetails(),...row.details},scenario:row.scenario,status:row.status,makerDisplayName,
    revision:row.revision,makerPersonId:row.maker_person_id,configurationReleaseId:row.configuration_release_id??null,updatedAt:row.updated_at,allowed_actions:actions};
}
export async function registerCases(app:FastifyInstance,pool:Pool,auth:Auth,config:AppConfig,parsingEnabled=false,documentCapabilities={documentReader:false,logicalDirectory:false,evidenceSearch:false,versionComparison:false}, lifecycle:CaseDraftLifecycle){
  registerReviewTeams(app,pool,auth);
  const caseId=(request:any)=>z.uuid().parse(request.params.id);
  app.get('/api/case-configuration-options',async request=>transaction(pool,async db=>{
    const actor=await auth.requireSession(request);await requireCaseCreator(db,actor);
    return lifecycle.configurations?lifecycle.configurations.list(db,actor):{canSelect:false,reason:'configuration_unavailable',items:[]};
  }));
  app.get('/api/cases',async request=>transaction(pool,async db=>{
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const actor=await auth.requireSession(request);await requireGrantForListing(db,actor);
    const query=z.object({q:z.string().max(200).optional(),lifecycle:z.literal('closed').optional()}).parse(request.query);
    const rows=(await db.query(`SELECT c.* FROM business.cases c WHERE
      EXISTS(SELECT 1 FROM business.access_grants g WHERE g.person_id=$1 AND g.action='case:read' AND NOT g.revoked AND (g.case_id IS NULL OR g.case_id=c.id))
      AND ($2::text IS NULL OR c.case_number ILIKE '%'||$2||'%' OR c.title ILIKE '%'||$2||'%' OR c.reference ILIKE '%'||$2||'%') AND ($3::text IS NULL OR c.closed_at IS NOT NULL) ORDER BY updated_at DESC LIMIT 200`,[actor.personId,query.q??null,query.lifecycle??null])).rows;
    return {items:await Promise.all(rows.map(row=>view(db,actor,row,lifecycle)))};
  }));
  app.post('/api/cases',async request=>{
    const actor=await auth.checkWrite(request),input=CreateCaseFromDraftSchema.parse(request.body);
    return transaction(pool,async db=>{
      const creationTeam=await lockCreationTeam(db,actor);
      const draft=await authorizeDraft(db,actor,input.draftId);
      const result=await idempotent(db,actor,'case.create',input.idempotencyKey,input,async()=>{
        // A different key still resolves the unique draft receipt; an existing key retains its hash check.
        if(draft.status==='created')return {id:draft.created_case_id!};
        assertOpenDraft(draft,input.expectedRevision);
        const fields=CaseCreationFieldsSchema.parse(draft.fields);
        const id=randomUUID(),caseNumber=await allocateCaseNumber(db);
        const details=CaseDetailsSchema.parse(draft.details??emptyCaseDetails());
        await db.query(`INSERT INTO business.cases(id,title,reference,background,scenario,status,maker_person_id,created_by,source,created_from_draft_id,case_number,checker_required,details)
          VALUES($1,$2,$3,$4,'overseas_loan','collecting_materials',$5,$5,$6,$7,$8,true,$9)`,[id,fields.title,fields.reference,fields.background,actor.personId,JSON.stringify(draft.source),draft.id,caseNumber,JSON.stringify(details)]);
        // Creation explicitly records the creator's read scope; it remains revocable like other grants.
        await db.query("INSERT INTO business.access_grants(id,person_id,action,case_id,created_by) VALUES($1,$2,'case:read',$3,$4)",[randomUUID(),actor.personId,id,actor.accountId]);
        for(const kind of ['case_creation','maker_assignment'])await db.query('INSERT INTO business.contributions(id,case_id,person_id,kind) VALUES($1,$2,$3,$4)',[randomUUID(),id,actor.personId,kind]);
        if(input.createReviewRound)await createInitialReviewRound(db,actor,id);
        if(input.reviewConfiguration){
          if(!lifecycle.configurations)throw new AppError(409,'review_configuration_unavailable');
          await lifecycle.configurations.initialize(db,actor,id,input.reviewConfiguration);
        }
        await lifecycle.adoptAttachments(db,actor,draft.id,id);
        await assignCreationTeam(db,actor,id,creationTeam);
        await db.query("UPDATE business.case_drafts SET status='created',created_case_id=$2,revision=revision+1,updated_at=now() WHERE id=$1",[draft.id,id]);
        await lifecycle.cancelTurns(db,draft.id);
        await audit(db,{actorId:actor.accountId,targetId:id,action:'case.created',details:{draftId:draft.id,makerPersonId:actor.personId}});return {id};
      });
      // A receipt does not grant access after a later revocation; return the current authorized projection.
      return view(db,actor,await authorizeCase(db,actor,result.id,'case:read'),lifecycle);
    });
  });
  app.get('/api/cases/:id',async request=>transaction(pool,async db=>{
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const actor=await auth.requireSession(request),row=await authorizeCase(db,actor,caseId(request),'case:read',false);return view(db,actor,row,lifecycle);
  }));
  app.get('/api/cases/:id/assignment-candidates',async request=>transaction(pool,async db=>{
    const actor=await auth.requireSession(request),id=caseId(request);await authorizeCase(db,actor,id,'case:assign',false);
    return {items:(await db.query(`SELECT p.id AS "personId",p.display_name AS "displayName" FROM auth.people p WHERE p.enabled
      AND p.business_role='BCO' AND EXISTS(SELECT 1 FROM auth.accounts a WHERE a.person_id=p.id AND a.enabled AND NOT a.must_change)
      AND EXISTS(SELECT 1 FROM business.access_grants g WHERE g.person_id=p.id AND g.action='maker' AND NOT g.revoked AND (g.case_id IS NULL OR g.case_id=$1)) ORDER BY p.display_name LIMIT 500`,[id])).rows};
  }));
  app.post('/api/cases/:id/assign',async request=>{
    const actor=await auth.checkWrite(request),id=caseId(request),input=z.object({makerPersonId:z.uuid(),expectedRevision:z.number().int().positive(),idempotencyKey:z.string().min(1).max(128),reason:z.string().trim().min(1).max(500)}).strict().parse(request.body);
    return transaction(pool,async db=>{
      await lockPersons(db,[actor.personId,input.makerPersonId]);await authorizeCase(db,actor,id,'case:assign');
      await idempotent(db,actor,`case.assign:${id}`,input.idempotencyKey,input,async()=>{
        const row=await authorizeCase(db,actor,id,'case:assign');if(row.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
        if(!await isEligibleMaker(db,input.makerPersonId,id))throw new AppError(422,'maker_unavailable');
        const next=(await db.query("UPDATE business.cases SET maker_person_id=$2,status='collecting_materials',revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",[id,input.makerPersonId])).rows[0];
        await db.query("INSERT INTO business.access_grants(id,person_id,action,case_id,created_by) VALUES($1,$2,'case:read',$3,$4) ON CONFLICT DO NOTHING",[randomUUID(),input.makerPersonId,id,actor.accountId]);
        await db.query("INSERT INTO business.contributions(id,case_id,person_id,kind) VALUES($1,$2,$3,'maker_assignment')",[randomUUID(),id,input.makerPersonId]);
        await audit(db,{actorId:actor.accountId,targetId:id,action:'case.assigned',details:{makerPersonId:input.makerPersonId,previousMakerPersonId:row.maker_person_id??'',caseRevision:next.revision,reason:input.reason}});return {id};
      });
      return view(db,actor,await authorizeCase(db,actor,id,'case:read'),lifecycle);
    });
  });
  app.post('/api/cases/:id/confirm-scenario',async request=>{
    const actor=await auth.checkWrite(request),id=caseId(request),input=z.object({scenario:z.string(),expectedRevision:z.number().int().positive(),idempotencyKey:z.string().min(1).max(128),reason:z.string().trim().min(1).max(500)}).strict().parse(request.body);
    if(input.scenario!=='overseas_loan')throw new AppError(422,'unsupported_scenario');
    return transaction(pool,async db=>{
      await authorizeCase(db,actor,id,'case:confirm-scenario');
      await idempotent(db,actor,`case.confirm-scenario:${id}`,input.idempotencyKey,input,async()=>{
        const row=await authorizeCase(db,actor,id,'case:confirm-scenario');
        if(row.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
        if(row.scenario!=='pending')throw new AppError(409,'scenario_already_confirmed');
        await db.query("UPDATE business.cases SET scenario='overseas_loan',revision=revision+1,updated_at=now() WHERE id=$1",[id]);
        await audit(db,{actorId:actor.accountId,targetId:id,action:'case.scenario_confirmed',details:{fromScenario:'pending',scenario:'overseas_loan',caseRevision:row.revision+1,reason:input.reason}});
        return {id};
      });
      return view(db,actor,await authorizeCase(db,actor,id,'case:read'),lifecycle);
    });
  });
  app.get('/api/system/status',async request=>transaction(pool,async db=>{
    const actor=await auth.requireSession(request);await requireGrant(db,actor,'system:status');
    const live=(await db.query("SELECT 1 FROM business.runtime_heartbeats WHERE name='worker' AND updated_at>now()-interval '60 seconds'")).rowCount;
    return {version:'p1',services:[{name:'database',status:'ready'},{name:'taskRecovery',status:live?'ready':'waiting'},
      {name:'objectStorage',status:config.upload.enabled?'configured':'disabled'}],capabilities:{registration:config.upload.enabled,parsing:parsingEnabled,...documentCapabilities,cloudReview:false},updatedAt:new Date().toISOString()};
  }));
}
async function requireGrantForListing(db:DB,actor:Actor){
  // An authenticated account may see an empty list; administrators have no implicit case access.
  await requireBusinessRole(db,actor);
}
