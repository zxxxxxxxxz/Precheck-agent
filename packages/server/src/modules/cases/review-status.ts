import type {DB} from '../../infrastructure/database/client.js';
import type {CaseReviewProjection,CaseReviewStage} from '@hsbc/contracts/case-review-status';

/** A single SQL projection used by list, detail, and authorized dashboard aggregates. */
export const reviewProjectionJoins=(alias='c')=>`LEFT JOIN business.review_rounds q ON q.id=${alias}.current_round_id
 LEFT JOIN LATERAL (SELECT x.* FROM business.review_runs x WHERE x.case_id=${alias}.id AND
   (CASE WHEN ${alias}.review_rounds_enabled THEN x.id=q.run_id ELSE x.round_id IS NULL END)
   ORDER BY x.created_at DESC,x.id DESC LIMIT 1) r ON true`;
export const reviewStatusSql=(c='c')=>`CASE WHEN ${c}.closed_at IS NOT NULL THEN 'closed' WHEN ${c}.maker_person_id IS NULL THEN 'assignment_required'
 WHEN ${c}.review_rounds_enabled AND (q.id IS NULL OR q.state='draft' AND q.run_id IS NULL) THEN 'preparing'
 WHEN r.state IN ('pending','running') THEN 'reviewing' WHEN r.state='failed' THEN 'execution_failed' WHEN r.state='canceled' THEN 'canceled'
 WHEN r.validity='stale' OR r.state='stale' OR (NOT ${c}.review_rounds_enabled AND r.case_revision<>${c}.revision) THEN 'stale'
 WHEN r.state='ready' AND (q.state IN ('draft','submitted') OR NOT EXISTS(SELECT 1 FROM business.checker_submissions s WHERE s.case_id=${c}.id AND s.round_id IS NOT DISTINCT FROM r.round_id AND s.run_id=r.id AND s.state='confirmed' AND s.validity='current' AND s.assignment_version=${c}.checker_assignment_version AND s.checker_person_id=${c}.checker_person_id)) THEN 'results_pending'
 WHEN r.state='ready' THEN 'round_completed' ELSE 'preparing' END`;
/** Who has to act on the current round. The pre-review status alone cannot say this: one value covers a result the Maker
 * has not confirmed, a round waiting for the Checker and a round the Checker sent back. */
export function caseReviewStage(row:{closed_at?:unknown;review_status:string;round_state?:string|null;run_state?:string|null;run_validity?:string|null;submission_state?:string|null;correcting?:boolean|null}):CaseReviewStage|null {
 if(row.closed_at||['assignment_required','preparing','closed'].includes(row.review_status))return null;
 if(row.correcting)return 'correcting';
 if(['pending','running'].includes(row.run_state??''))return null;
 if(row.submission_state==='submitted')return 'awaiting_checker';
 if(row.review_status==='round_completed')return 'round_confirmed';
 const current=row.run_state==='ready'&&row.run_validity==='current';
 if(row.round_state==='submitted'&&current)return 'to_submit';
 if(row.round_state==='draft'&&current)return 'result_to_confirm';
 // Sent back by the Checker and not yet run again by the Maker.
 if(row.submission_state==='returned'&&row.round_state==='draft')return 'returned';
 return null;
}
export async function caseReviewProjections(db:DB,ids:string[]):Promise<Map<string,CaseReviewProjection>>{
 if(!ids.length)return new Map();
 const rows=(await db.query(`SELECT c.id,c.review_rounds_enabled,c.current_round_id,c.closed_at,c.closed_by,c.closure_reason,c.closed_round_id,c.closed_run_id,c.closure_receipt,
   (SELECT display_name FROM auth.people WHERE id=c.checker_person_id) AS checker_name,
   (SELECT jsonb_build_object('number',done.number,'runId',done.run_id) FROM business.review_rounds done JOIN business.review_runs finished ON finished.id=done.run_id WHERE done.case_id=c.id AND done.state='locked' AND EXISTS(SELECT 1 FROM business.checker_submissions s WHERE s.round_id=done.id AND s.run_id=finished.id AND s.state='confirmed') AND finished.state='ready' AND finished.validity='current' ORDER BY done.number DESC LIMIT 1) AS latest_completed,
   q.number,q.state AS round_state,r.state AS run_state,r.validity AS run_validity,r.id AS run_id,r.snapshot,${reviewStatusSql()} AS review_status,
   (SELECT s.state FROM business.checker_submissions s WHERE s.case_id=c.id AND s.round_id=c.current_round_id AND s.validity='current' ORDER BY s.number DESC LIMIT 1) AS submission_state,
   (c.closed_at IS NULL AND c.current_round_id IS NOT NULL AND c.checker_correction_round_id=c.current_round_id AND c.checker_correction_person_id=c.checker_person_id AND c.checker_correction_assignment_version=c.checker_assignment_version) AS correcting,release.manifest->'guaranteeTypes' AS guarantee_types,
   (SELECT display_name FROM auth.people WHERE id=c.closed_by) AS closed_by_name,
   (SELECT count(*)::int FROM jsonb_array_elements(coalesce(r.results,'[]'::jsonb)) result WHERE result->>'outcome' NOT IN ('pass','not_applicable')) AS outstanding,
   (SELECT coalesce(jsonb_agg(v.body),'[]'::jsonb) FROM (SELECT DISTINCT ON(object_id) body FROM business.review_object_versions
     WHERE case_id=c.id AND round_id IS NOT DISTINCT FROM c.current_round_id AND NOT(c.review_rounds_enabled AND c.current_round_id IS NULL)
     ORDER BY object_id,version DESC) v) AS objects
   FROM business.cases c ${reviewProjectionJoins()} LEFT JOIN business.review_config_releases release ON release.release_id=coalesce(q.configuration_release_id,c.configuration_release_id)
   WHERE c.id=ANY($1::uuid[])`,[ids])).rows;
 return new Map(rows.map(row=>{const objects=(row.snapshot?.objects??row.objects) as Array<{role:string;label:string}>;return [row.id,{
   checkerRequired:true,checkerDisplayName:row.checker_name??null,stage:caseReviewStage(row),lifecycle:row.closed_at?'closed':'open',preReviewStatus:row.review_status,currentRoundId:row.current_round_id,roundNumber:row.number??null,roundsEnabled:row.review_rounds_enabled,
   latestCompletedRoundNumber:row.latest_completed?.number??null,latestCompletedRunId:row.latest_completed?.runId??null,guaranteeTypes:row.guarantee_types??[],borrowers:objects.filter(o=>o.role==='borrower').map(o=>o.label),guarantors:objects.filter(o=>['guarantor','corporate_guarantee','personal_guarantee'].includes(o.role)).map(o=>o.label),latestRunId:row.run_id??null,outstandingCount:row.outstanding,
   closure:row.closed_at?{kind:row.closure_receipt?.kind==='checker_terminated'?'checker_terminated':row.closure_receipt?.checkerConfirmation?'checker_confirmed':'pre_review',closedAt:row.closed_at.toISOString(),closedBy:row.closed_by,closedByName:row.closed_by_name??null,reason:row.closure_reason,roundId:row.closed_round_id,runId:row.closed_run_id}:null,
 }];}));
}
