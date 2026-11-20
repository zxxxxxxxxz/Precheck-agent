import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {ReviewTeamCommandSchema, type ReviewTeam} from '@hsbc/contracts/identity';
import {transaction, type DB} from '../../infrastructure/database/client.js';
import {AppError} from '../../shared/errors.js';
import {audit} from '../audit/events.js';
import {hasGrant, lockPersons, requireGrant} from '../identity/authorization.js';
import type {Actor} from '../identity/types.js';
import type {Auth} from '../identity/auth.js';
import {checkerEligibility} from '../review-checker/access.js';

// Case visibility is granted separately, only when this pair creates a new case.
export const MAKER_TEAM_ACTIONS = ['maker','case:create','case:assign','case:confirm-scenario','material:upload','evidence:read','document:parse','document:classify','case:configure','case:start','material:adopt','field:correct','finding:decide','checker:read','maker:submit','report:read','report:generate','report:export','review:analyze','review:formal','case:close'] as const;
export const CHECKER_TEAM_ACTIONS = ['checker','evidence:read','checker:read','checker:comment','checker:confirm','checker:correct','field:correct','finding:decide','case:start','report:read','report:generate','report:export','review:analyze','review:formal'] as const;
const delegatedActions = [...new Set<string>(['case:read',...MAKER_TEAM_ACTIONS,...CHECKER_TEAM_ACTIONS])];
type TeamRow = {maker_person_id:string;checker_person_id:string;enabled:boolean;version:number;authorized_by:string;authority_person_id:string};
async function team(db:DB, maker:string):Promise<TeamRow|undefined>{
  return (await db.query('SELECT t.*,a.person_id AS authority_person_id FROM business.case_review_teams t JOIN auth.accounts a ON a.id=t.authorized_by WHERE t.maker_person_id=$1',[maker])).rows[0];
}
async function requireAuthority(db:DB,personId:string){
  if(!await hasGrant(db,personId,'permission:manage'))throw new AppError(403,'review_team_authority_required');
  const actions=(await db.query('SELECT action FROM business.grant_authorities WHERE person_id=$1 AND case_id IS NULL',[personId])).rows.map(r=>r.action);
  if(delegatedActions.some(a=>!actions.includes(a)))throw new AppError(403,'grant_scope_denied');
}
async function requirePerson(db:DB,id:string){
  if(!(await db.query("SELECT 1 FROM business.principals WHERE person_id=$1 AND enabled AND NOT must_change AND business_role='BCO' LIMIT 1",[id])).rowCount)throw new AppError(422,'review_team_person_unavailable');
}
export async function listReviewTeams(db:DB):Promise<ReviewTeam[]>{
  return (await db.query('SELECT t.maker_person_id AS "makerPersonId",t.checker_person_id AS "checkerPersonId",m.display_name AS "makerName",c.display_name AS "checkerName",t.enabled,t.version FROM business.case_review_teams t JOIN auth.people m ON m.id=t.maker_person_id JOIN auth.people c ON c.id=t.checker_person_id ORDER BY m.display_name,t.maker_person_id')).rows;
}
export async function saveReviewTeam(db:DB,actor:Actor,raw:unknown){
  const input=ReviewTeamCommandSchema.parse(raw),before=await team(db,input.makerPersonId);
  await lockPersons(db,[actor.personId,input.makerPersonId,input.checkerPersonId,...(before?[before.checker_person_id,before.authority_person_id]:[])]);
  await requireGrant(db,actor,'permission:manage');
  const current=await team(db,input.makerPersonId);
  if((current?.version??0)!==input.expectedVersion)throw new AppError(409,'stale_revision');
  if(!input.enabled&&!current)throw new AppError(404,'review_team_not_found');
  if(input.enabled){
    await requireAuthority(db,actor.personId);
    for(const id of [input.makerPersonId,input.checkerPersonId])await requirePerson(db,id);
    for(const [personId,actions] of [[input.makerPersonId,MAKER_TEAM_ACTIONS],[input.checkerPersonId,CHECKER_TEAM_ACTIONS]] as const){
      for(const action of actions){
        const result=await db.query('INSERT INTO business.access_grants(id,person_id,action,created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',[randomUUID(),personId,action,actor.accountId]);
        if(result.rowCount)await audit(db,{actorId:actor.accountId,targetId:personId,action:'permission.granted',details:{grantAction:action,caseId:'global',reason:input.reason,source:'fixed_review_team'}});
      }
    }
  }
  await db.query(`INSERT INTO business.case_review_teams(maker_person_id,checker_person_id,enabled,authorized_by) VALUES($1,$2,$3,$4)
    ON CONFLICT(maker_person_id) DO UPDATE SET checker_person_id=EXCLUDED.checker_person_id,enabled=EXCLUDED.enabled,authorized_by=EXCLUDED.authorized_by,version=business.case_review_teams.version+1,updated_at=now()`,[input.makerPersonId,input.checkerPersonId,input.enabled,actor.accountId]);
  await audit(db,{actorId:actor.accountId,targetId:input.makerPersonId,action:'review_team.configured',details:{checkerPersonId:input.checkerPersonId,previousCheckerPersonId:current?.checker_person_id??'none',enabled:input.enabled,reason:input.reason}});
  return {items:await listReviewTeams(db)};
}
/** Acquire the full person-lock set before authorizeDraft locks the Maker. Re-read after locking. */
export async function lockCreationTeam(db:DB,actor:Actor){
  const before=await team(db,actor.personId);
  await lockPersons(db,[actor.personId,...(before?[before.checker_person_id,before.authority_person_id]:[])]);
  const current=await team(db,actor.personId);
  if((current?.version??0)!==(before?.version??0))throw new AppError(409,'review_team_changed');
  return current;
}
export async function assignCreationTeam(db:DB,actor:Actor,caseId:string,configured:TeamRow|undefined){
  if(!configured?.enabled)return;
  const authority=(await db.query('SELECT enabled,must_change FROM business.principals WHERE account_id=$1 AND person_id=$2',[configured.authorized_by,configured.authority_person_id])).rows[0];
  if(!authority?.enabled||authority.must_change)throw new AppError(409,'review_team_authority_unavailable');
  await requireAuthority(db,configured.authority_person_id);
  for(const [personId,actions] of [[actor.personId,MAKER_TEAM_ACTIONS],[configured.checker_person_id,CHECKER_TEAM_ACTIONS]] as const){
    await requirePerson(db,personId);
    for(const action of actions)if(!await hasGrant(db,personId,action))throw new AppError(409,'review_team_permissions_changed');
  }
  // Standing consent comes from the saved administrator policy, not the creating Maker's delegation powers.
  const result=await db.query("INSERT INTO business.access_grants(id,person_id,action,case_id,created_by) VALUES($1,$2,'case:read',$3,$4) ON CONFLICT DO NOTHING RETURNING id",[randomUUID(),configured.checker_person_id,caseId,configured.authorized_by]);
  const c=(await db.query('SELECT * FROM business.cases WHERE id=$1',[caseId])).rows[0];
  if((await checkerEligibility(db,c,configured.checker_person_id)).length)throw new AppError(409,'checker_not_independent_or_authorized');
  await db.query('UPDATE business.cases SET checker_person_id=$2,checker_assignment_version=checker_assignment_version+1 WHERE id=$1',[caseId,configured.checker_person_id]);
  const details={personId:configured.checker_person_id,previousPersonId:null,reason:'按已授权固定分工自动指派',teamVersion:configured.version,authorizedBy:configured.authorized_by};
  await db.query("INSERT INTO business.checker_events(id,case_id,kind,actor_person_id,account_id,details) VALUES($1,$2,'assigned',$3,$4,$5)",[randomUUID(),caseId,actor.personId,actor.accountId,JSON.stringify(details)]);
  if(result.rowCount)await audit(db,{actorId:actor.accountId,targetId:configured.checker_person_id,action:'permission.granted',details:{grantAction:'case:read',caseId,source:'fixed_review_team',authorizedBy:configured.authorized_by,teamVersion:configured.version}});
  await audit(db,{actorId:actor.accountId,targetId:caseId,action:'checker.assigned',details:{checkerPersonId:configured.checker_person_id,source:'fixed_review_team',teamVersion:configured.version}});
}
export function registerReviewTeams(app:FastifyInstance,pool:Pool,auth:Auth){
  app.get('/api/admin/review-teams',async request=>transaction(pool,async db=>{
    const actor=await auth.requireSession(request);await requireGrant(db,actor,'permission:manage');return {items:await listReviewTeams(db)};
  }));
  app.post('/api/admin/review-teams',async request=>{return auth.checkWrite(request).then(actor=>transaction(pool,db=>saveReviewTeam(db,actor,request.body)));});
}
