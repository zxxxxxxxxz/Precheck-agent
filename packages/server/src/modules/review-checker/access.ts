import type {DB} from '../../infrastructure/database/client.js';
import {hasGrant} from '../identity/authorization.js';
import {AppError} from '../../shared/errors.js';

export const CHECKER_PERMISSIONS=['checker','checker:read','checker:comment','checker:confirm','checker:correct','maker:submit','consultation:record','exception:decide'] as const;
export async function checkerEligibility(db:DB,c:any,personId:string):Promise<string[]>{
 const reasons:string[]=[];
 const person=(await db.query("SELECT 1 FROM business.principals WHERE person_id=$1 AND enabled AND NOT must_change AND business_role='BCO' LIMIT 1",[personId])).rowCount;
 if(!person)reasons.push('人员未启用或不具备 BCO 身份');
 for(const action of ['checker','case:read','evidence:read','checker:read','checker:comment','checker:confirm','report:read'])if(!await hasGrant(db,personId,action,c.id))reasons.push(`缺少权限：${action}`);
 const contributed=personId===c.maker_person_id||personId===c.created_by||Boolean((await db.query(`SELECT 1 FROM business.contributions WHERE case_id=$1 AND person_id=$2 AND kind<>'checker_correction'
 UNION ALL SELECT 1 FROM business.review_events WHERE case_id=$1 AND actor_person_id=$2 AND COALESCE(details->>'reviewRole','maker')<>'checker' AND kind IN ('object_confirmed','fact_confirmed','material_adopted','material_rejected','issue_decided','external_reply','configuration_bound')
 UNION ALL SELECT 1 FROM business.document_jobs WHERE case_id=$1 AND person_id=$2 AND required_action IN ('document:parse','document:classify') LIMIT 1`,[c.id,personId])).rowCount);
 if(contributed)reasons.push('曾作为经办人参与本案，不能担任独立复核人');
 return reasons;
}
export async function assertIndependentChecker(db:DB,c:any,personId:string){
 if(c.checker_person_id!==personId)throw new AppError(403,'checker_assignment_required');
 if((await checkerEligibility(db,c,personId)).length)throw new AppError(403,'checker_not_independent_or_authorized');
}
export async function assertCheckerInputsMutable(db:DB,c:any){
  if((await db.query("SELECT 1 FROM business.checker_submissions WHERE case_id=$1 AND state='submitted' AND validity='current' LIMIT 1",[c.id])).rowCount)throw new AppError(409,'checker_submission_pending');
}
export async function assertCheckerCorrection(db:DB,c:any,personId:string){
 if(!await hasGrant(db,personId,'checker:correct',c.id)||!await hasGrant(db,personId,'field:correct',c.id))throw new AppError(403,'checker_correction_not_authorized');
 await assertIndependentChecker(db,c,personId);
 if(!checkerCorrectionActive(c,personId))throw new AppError(409,'checker_correction_required');
 await assertCheckerInputsMutable(db,c);
}
export async function invalidateCheckerContent(db:DB,caseId:string){
 await db.query("UPDATE business.checker_submissions SET validity='stale',version=version+1 WHERE case_id=$1 AND validity='current' AND state IN ('submitted','confirmed')",[caseId]);
}

/** The assignment version fences corrections after reassignment, including the same person. */
export function checkerCorrectionActive(c:any,personId?:string){
 return !c.closed_at&&!!c.current_round_id&&c.checker_correction_round_id===c.current_round_id
  &&c.checker_correction_person_id===c.checker_person_id&&c.checker_correction_assignment_version===c.checker_assignment_version
  &&(personId===undefined||c.checker_person_id===personId);
}
export async function isCorrectingChecker(db:DB,c:any,personId:string){
 return checkerCorrectionActive(c,personId)&&await hasGrant(db,personId,'checker:correct',c.id)&&!(await checkerEligibility(db,c,personId)).length;
}
