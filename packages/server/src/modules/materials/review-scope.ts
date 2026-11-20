import type {ReviewMaterial} from '@hsbc/contracts/review';
import type {DB} from '../../infrastructure/database/client.js';

export const currentMaterialDecisions = `SELECT DISTINCT ON(document_version_id,coalesce(body->>'logicalDocumentId','')) *
  FROM business.review_material_events WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid
  ORDER BY document_version_id,coalesce(body->>'logicalDocumentId',''),case_revision DESC,created_at DESC,id DESC`;

/** A file-level removal takes precedence over older per-document classifications.
 * Existing explicit exclusions remain exclusions; an undecided upload is included. */
export function fileIsIncluded(decisions:ReviewMaterial[]):boolean {
  const whole=decisions.find(m=>!m.logicalDocumentId);
  return whole ? whole.operation==='adopt' : !decisions.length || decisions.some(m=>m.operation==='adopt');
}

export async function materialMembership(db:DB,caseId:string,roundId:string|null) {
  const decisions=(await db.query(currentMaterialDecisions,[caseId,roundId])).rows.map(r=>r.body as ReviewMaterial);
  const documents=(await db.query(`SELECT d.*,u.expected_revision AS registration_revision FROM business.document_versions d
    JOIN business.upload_sessions u ON u.id=d.upload_session_id
    WHERE d.case_id=$1 AND d.round_id IS NOT DISTINCT FROM $2::uuid AND u.state='registered' AND u.document_version_id=d.id
    ORDER BY d.created_at,d.id`,[caseId,roundId])).rows.filter(d=>fileIsIncluded(decisions.filter(m=>m.documentVersionId===d.id)));
  return {documents,decisions};
}

/** Old submitted rounds retain their recorded membership, never a new interpretation. */
export async function usesFileListScope(db:DB,caseId:string,roundId:string|null):Promise<boolean> {
  const c=(await db.query('SELECT closed_at,review_rounds_enabled,current_round_id FROM business.cases WHERE id=$1',[caseId])).rows[0];
  if(!c||c.closed_at)return false;
  if(!c.review_rounds_enabled)return roundId===null;
  if(!roundId||roundId!==c.current_round_id)return false;
  return (await db.query('SELECT state FROM business.review_rounds WHERE id=$1 AND case_id=$2',[roundId,caseId])).rows[0]?.state==='draft';
}

/** Fixed new snapshots also support the legacy view after a case adopts rounds. */
export async function fixedMaterialSnapshot(db:DB,caseId:string,roundId:string|null){
  return roundId?(await db.query(`SELECT r.snapshot FROM business.review_rounds q JOIN business.review_runs r ON r.id=q.run_id
    WHERE q.case_id=$1 AND q.id=$2`,[caseId,roundId])).rows[0]?.snapshot:
    (await db.query(`SELECT snapshot FROM business.review_runs WHERE case_id=$1 AND round_id IS NULL ORDER BY created_at DESC,id DESC LIMIT 1`,[caseId])).rows[0]?.snapshot;
}

/** null preserves the old historical list. New runs pin every included file,
 * including files whose parsing or classification could not complete. */
export async function materialListIds(db:DB,caseId:string,roundId:string|null):Promise<string[]|null> {
  if(await usesFileListScope(db,caseId,roundId))return (await materialMembership(db,caseId,roundId)).documents.map(d=>d.id);
  const snapshot=await fixedMaterialSnapshot(db,caseId,roundId);
  if(snapshot?.materialScope==='file-list')return [...new Set<string>([...snapshot.materials,...(snapshot.pendingMaterials??[])].map(m=>m.documentVersionId))];
  return null;
}
