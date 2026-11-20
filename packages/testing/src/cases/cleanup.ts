import type { Pool } from 'pg';

/** Deletes only the explicitly supplied isolated fixtures, never schemas or other cases. */
export async function cleanupCases(db:Pool,caseIds:string[]){
  await db.query('UPDATE business.document_versions SET current_parse_job_id=NULL WHERE case_id=ANY($1::uuid[])',[caseIds]);
  await db.query('DELETE FROM business.document_source_mappings WHERE job_id IN (SELECT id FROM business.document_jobs WHERE case_id=ANY($1::uuid[]))',[caseIds]);
  await db.query('DELETE FROM business.document_previews WHERE job_id IN (SELECT id FROM business.document_jobs WHERE case_id=ANY($1::uuid[]))',[caseIds]);
  await db.query('DELETE FROM business.document_sources WHERE job_id IN (SELECT id FROM business.document_jobs WHERE case_id=ANY($1::uuid[]))',[caseIds]);
  await db.query('DELETE FROM business.document_chunks WHERE job_id IN (SELECT id FROM business.document_jobs WHERE case_id=ANY($1::uuid[]))',[caseIds]);
  await db.query('DELETE FROM business.document_artifacts WHERE job_id IN (SELECT id FROM business.document_jobs WHERE case_id=ANY($1::uuid[]))',[caseIds]);
  const owners='SELECT id FROM business.document_jobs WHERE case_id=ANY($1::uuid[]) UNION SELECT id FROM business.upload_sessions WHERE case_id=ANY($1::uuid[]) UNION SELECT id FROM business.mock_validation_jobs WHERE case_id=ANY($1::uuid[])';
  await db.query(`DELETE FROM business.inbox WHERE work_item_id IN (SELECT id FROM business.work_items WHERE owner_id IN (${owners}))`,[caseIds]);
  await db.query(`DELETE FROM business.outbox WHERE owner_id IN (${owners} UNION SELECT id FROM business.document_versions WHERE case_id=ANY($1::uuid[]))`,[caseIds]);
  await db.query(`DELETE FROM business.work_items WHERE owner_id IN (${owners})`,[caseIds]);
  await db.query('DELETE FROM business.mock_validation_jobs WHERE case_id=ANY($1::uuid[])',[caseIds]);
  await db.query('DELETE FROM business.document_pages WHERE job_id IN (SELECT id FROM business.document_jobs WHERE case_id=ANY($1::uuid[]))',[caseIds]);
  await db.query('DELETE FROM business.document_tool_delegations WHERE case_id=ANY($1::uuid[])',[caseIds]);
  for(const table of ['signature_confirmations','signature_model_calls','signature_page_receipts','signature_review_snapshots'])await db.query(`DELETE FROM business.${table} WHERE job_id IN (SELECT id FROM business.document_jobs WHERE case_id=ANY($1::uuid[]))`,[caseIds]);
  await db.query('DELETE FROM business.document_jobs WHERE case_id=ANY($1::uuid[])',[caseIds]);
  await db.query('DELETE FROM business.parse_intents WHERE document_version_id IN (SELECT id FROM business.document_versions WHERE case_id=ANY($1::uuid[]))',[caseIds]);
  await db.query('DELETE FROM business.document_versions WHERE case_id=ANY($1::uuid[])',[caseIds]);
  await db.query('DELETE FROM business.upload_sessions WHERE case_id=ANY($1::uuid[])',[caseIds]);
  if((await db.query("SELECT to_regclass('business.document_processing_access') AS name")).rows[0].name)await db.query('DELETE FROM business.document_processing_access WHERE case_id=ANY($1::uuid[])',[caseIds]);
  for(const table of ['access_grants','contributions'])await db.query(`DELETE FROM business.${table} WHERE case_id=ANY($1::uuid[])`,[caseIds]);
  await db.query('DELETE FROM business.cases WHERE id=ANY($1::uuid[])',[caseIds]);
}
