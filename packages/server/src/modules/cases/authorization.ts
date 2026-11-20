import {assertRoundInputsOpen,ROUND_INPUT_ACTIONS} from '../review/round-boundary.js';
import {assertCheckerCorrection,assertCheckerInputsMutable,checkerCorrectionActive,isCorrectingChecker,checkerEligibility,assertIndependentChecker} from '../review-checker/access.js';
import type { DB } from '../../infrastructure/database/client.js';
import { AppError } from '../../shared/errors.js';
import type { Actor } from '../identity/types.js';
import { assertActor, hasGrant, requireBusinessRole } from '../identity/authorization.js';

export async function isEligibleMaker(client: DB, personId: string, caseId?: string): Promise<boolean> {
  return Boolean((await client.query(`SELECT 1 FROM business.principals p WHERE p.person_id=$1
    AND p.enabled AND NOT p.must_change AND p.business_role='BCO'
    AND EXISTS(SELECT 1 FROM business.access_grants g WHERE g.person_id=p.person_id AND g.action='maker'
      AND NOT g.revoked AND (g.case_id IS NULL OR g.case_id=$2::uuid)) LIMIT 1`,[personId,caseId??null])).rowCount);
}

/** Completed Checker receipts remain attributable after the correction session closes. */
export async function canOwnReviewResult(client:DB,c:any,personId:string):Promise<boolean>{
 return c.maker_person_id===personId&&await isEligibleMaker(client,personId,c.id)||c.checker_person_id===personId&&await hasGrant(client,personId,'checker:correct',c.id)&&!(await checkerEligibility(client,c,personId)).length;
}

export async function canEditReview(client:DB,c:any,personId:string):Promise<boolean>{
  if(checkerCorrectionActive(c))return isCorrectingChecker(client,c,personId);
  return c.maker_person_id===personId&&await isEligibleMaker(client,personId,c.id);
}

/** The assigned independent Checker may finish a review, without acquiring input/editing grants. */
export async function isAssignedCompletionChecker(client:DB,c:any,personId:string):Promise<boolean>{
 return c.checker_person_id===personId&&!(await checkerEligibility(client,c,personId)).length;
}
export async function authorizeReviewCompletion(client:DB,actor:Actor,caseId:string,action:'round:create'|'case:close'){
 const c=await authorizeCase(client,actor,caseId,'case:read');
 if(c.maker_person_id===actor.personId)return authorizeCase(client,actor,caseId,action==='round:create'?'case:start':'case:close');
 await assertIndependentChecker(client,c,actor.personId);
 if(c.scenario!=='overseas_loan')throw new AppError(409,'scenario_confirmation_required');
 if(action==='round:create'){
  if(c.closed_at)throw new AppError(409,'case_closed');
  if(!c.current_round_id)throw new AppError(409,'checker_confirmation_required');
 }
 return c;
}

/** A case-scoped qualification never permits creating an unrelated new case. */
export async function canCreateCase(client: DB, actor: Actor): Promise<boolean> {
  const principal=await assertActor(client,actor);
  return principal.business_role==='BCO' && await hasGrant(client,actor.personId,'maker') && await hasGrant(client,actor.personId,'case:create');
}

export async function requireCaseCreator(client: DB, actor: Actor): Promise<void> {
  await requireBusinessRole(client,actor);
  if (!await hasGrant(client,actor.personId,'maker')) throw new AppError(403,'maker_qualification_required');
  if (!await hasGrant(client,actor.personId,'case:create')) throw new AppError(403,'permission_denied');
}

export async function authorizeCase(client: DB, actor: Actor, caseId: string, action: string, lock = true): Promise<any> {
  const principal=await assertActor(client, actor);
  if (principal.business_role!=='BCO') throw new AppError(404,'case_not_found');
  const r = await client.query(`SELECT * FROM business.cases WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [caseId]); const c = r.rows[0];
  if (!c) throw new AppError(404,'case_not_found');
  const visible = await hasGrant(client,actor.personId,'case:read',caseId);
  if (!visible) throw new AppError(404,'case_not_found');
  const granted = await hasGrant(client,actor.personId,action,caseId) || action==='document:translate' && await hasGrant(client,actor.personId,'document:parse',caseId);
  if (action !== 'case:read' && !granted) throw new AppError(403,'permission_denied');
  if (['case:assign','case:confirm-scenario','material:upload','document:parse','document:classify'].includes(action)) {
    const role = await requireBusinessRole(client,actor);
    if (['material:upload','document:classify'].includes(action) && (role !== 'BCO' || c.maker_person_id !== actor.personId || !await isEligibleMaker(client,actor.personId,caseId)))
      throw new AppError(403,'maker_assignment_required');
  }
  if (['document:parse','document:classify'].includes(action) && c.scenario !== 'overseas_loan') throw new AppError(409,'scenario_confirmation_required');
  if (['case:configure','case:start','material:adopt','field:correct','finding:decide','case:close'].includes(action)) {
    if(c.scenario!=='overseas_loan')throw new AppError(409,'scenario_confirmation_required');
    if(['field:correct','finding:decide','case:start'].includes(action)&&c.maker_person_id!==actor.personId)await assertCheckerCorrection(client,c,actor.personId);
    else if(c.maker_person_id!==actor.personId||!await isEligibleMaker(client,actor.personId,caseId))throw new AppError(403,'maker_assignment_required');
  }
  if(checkerCorrectionActive(c)&&[...ROUND_INPUT_ACTIONS,'finding:decide','case:start'].includes(action as any)&&c.checker_person_id!==actor.personId)throw new AppError(409,'checker_correction_in_progress');
  if(!['case:read','evidence:read','checker:read','case:close'].includes(action)&&c.closed_at)throw new AppError(409,'case_closed');
  if([...ROUND_INPUT_ACTIONS,'finding:decide','case:start'].includes(action))await assertCheckerInputsMutable(client,c);
  if((ROUND_INPUT_ACTIONS as readonly string[]).includes(action))await assertRoundInputsOpen(client,c);
  return c;
}
