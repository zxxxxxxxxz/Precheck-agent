import {materialMembership} from '../materials/review-scope.js';
import type {DB} from '../../infrastructure/database/client.js';
import {AppError} from '../../shared/errors.js';

export interface RoundCase {id:string;revision:number;review_rounds_enabled?:boolean;current_round_id?:string|null;closed_at?:unknown}
export const ROUND_INPUT_ACTIONS=['case:configure','material:upload','material:adopt','field:correct','document:parse','document:classify'] as const;
export async function currentRound(db:DB,c:RoundCase){
  if(!c.review_rounds_enabled)return null;
  if(!c.current_round_id)return null;
  const round=(await db.query('SELECT * FROM business.review_rounds WHERE id=$1 AND case_id=$2',[c.current_round_id,c.id])).rows[0];
  if(!round)throw new AppError(409,'review_round_not_found');return round;
}
/** Caller holds the case lock for writes. Old requests never silently select the latest round. */
export async function assertRoundRequest(db:DB,c:RoundCase,roundId:string|undefined,options:{draft?:boolean}={}){
  if(c.closed_at)throw new AppError(409,'case_closed');
  if(!c.review_rounds_enabled){if(roundId)throw new AppError(409,'review_round_not_enabled');return null;}
  if(!roundId)throw new AppError(409,'review_round_required');
  if(roundId!==c.current_round_id)throw new AppError(409,'review_round_not_current');
  const round=await currentRound(db,c);
  if(!round||round.state==='discarded')throw new AppError(409,'review_round_not_current');
  if(options.draft&&round.state!=='draft')throw new AppError(409,'review_round_locked');
  return round;
}
export async function assertRoundInputsOpen(db:DB,c:RoundCase){
  if(c.closed_at)throw new AppError(409,'case_closed');
  if(c.review_rounds_enabled){const round=await currentRound(db,c);if(!round)throw new AppError(409,'review_round_required');if(round.state!=='draft')throw new AppError(409,'review_round_locked');await assertRoundExecutionSettled(db,round);}
}
/** An object ID/document ID binds a resource, but cannot authorize a different round. */
export async function assertDocumentRound(db:DB,c:RoundCase,documentId:string,options:{allowRemoved?:boolean}={}){
  const doc=(await db.query('SELECT round_id FROM business.document_versions WHERE id=$1 AND case_id=$2',[documentId,c.id])).rows[0];
  if(!doc)throw new AppError(404,'material_not_found');
  if((doc.round_id??null)!==(c.current_round_id??null)||c.review_rounds_enabled&&!c.current_round_id)throw new AppError(409,'review_document_round_mismatch');
  await assertRoundInputsOpen(db,c);
  if(!options.allowRemoved&&!(await materialMembership(db,c.id,c.current_round_id??null)).documents.some(d=>d.id===documentId))throw new AppError(409,'material_not_in_current_list');
}
/** Input-producing work of a round that has not settled yet: what it is and which file it concerns. */
export async function roundInputWork(db:DB,caseId:string,roundId:string|null,limit=20):Promise<RoundInputWork[]>{
  return (await db.query(`SELECT 'upload' AS kind,filename FROM business.upload_sessions WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND state IN ('issued','verifying')
    UNION ALL SELECT j.kind,d.filename FROM business.document_jobs j LEFT JOIN business.document_versions d ON d.id=j.document_version_id
      WHERE j.case_id=$1 AND j.round_id IS NOT DISTINCT FROM $2::uuid AND j.state IN ('pending','running') AND j.required_action<>'evidence:read'
    UNION ALL SELECT 'formal_review',NULL FROM business.formal_review_jobs WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND state IN ('pending','running','unknown')
    UNION ALL SELECT 'supplement',d.filename FROM business.review_supplements s LEFT JOIN business.document_versions d ON d.id=s.document_version_id
      WHERE s.case_id=$1 AND s.round_id IS NOT DISTINCT FROM $2::uuid AND s.state IN ('pending','running') LIMIT $3`,[caseId,roundId,limit])).rows;
}
export interface RoundInputWork {kind:string;filename:string|null}
/** Starting or switching rounds requires all input-producing work to be settled. */
export async function assertNoInputWork(db:DB,c:RoundCase,roundId:string|null){
  if((await roundInputWork(db,c.id,roundId,1)).length)throw new AppError(409,'review_round_inputs_processing');
}

/** Input edits pause during execution, but result generation does not close a round. */
export async function assertRoundExecutionSettled(db:DB,round:{run_id?:string|null}){
  if(round.run_id&&(await db.query("SELECT 1 FROM business.review_runs WHERE id=$1 AND state IN ('pending','running') AND validity='current'",[round.run_id])).rowCount)throw new AppError(409,'review_round_execution_active');
}
