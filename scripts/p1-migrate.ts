import { createHash } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadConfig, type AppConfig } from '@hsbc/server/runtime/config';

export async function migrateP1(config:AppConfig){
  const pool=new pg.Pool({connectionString:config.databaseUrl,max:1});const db=await pool.connect();
  try{
    const identity=(await db.query('SELECT current_user AS role,current_database() AS db')).rows[0];
    if(identity.role!=='hsbc_p1_migration')throw new Error('migration_role_required');
    if(config.mode==='local'){
      const marker=(await db.query('SELECT instance_id FROM p1_guard.instance')).rows[0];
      if(marker?.instance_id!==config.instanceId)throw new Error('migration_instance_mismatch');
    }
    await db.query("SELECT pg_advisory_lock(hashtextextended('p1-schema-migrations',0))");
    if((await db.query("SELECT to_regclass('business.app_instance') AS name")).rows[0].name){
      if((await db.query('SELECT instance_id FROM business.app_instance WHERE singleton=true')).rows[0]?.instance_id!==config.instanceId)throw new Error('migration_instance_mismatch');
    }
    for(const schema of ['auth','business','a2a','checkpoint'])await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await db.query(`CREATE TABLE IF NOT EXISTS business.schema_migrations(version text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    const files=(await readdir(resolve('packages/server/src/infrastructure/database/migrations'))).filter(f=>/^\d{3}_.+\.sql$/.test(f)).sort();
    for(const file of files){
      const sql=await readFile(resolve('packages/server/src/infrastructure/database/migrations',file),'utf8'),hash=createHash('sha256').update(sql).digest('hex');
      const prior=(await db.query('SELECT sha256 FROM business.schema_migrations WHERE version=$1',[file])).rows[0];
      if(prior){if(prior.sha256!==hash)throw new Error(`migration_checksum_mismatch:${file}`);continue;}
      await db.query('BEGIN');
      try{
        await db.query(sql);
        if(file.startsWith('001_'))await db.query('INSERT INTO business.app_instance(singleton,instance_id) VALUES(true,$1)',[config.instanceId]);
        await db.query('INSERT INTO business.schema_migrations(version,sha256) VALUES($1,$2)',[file,hash]);
        await db.query('COMMIT');
      }catch(e){await db.query('ROLLBACK');throw e;}
    }
    if((await db.query('SELECT instance_id FROM business.app_instance WHERE singleton=true')).rows[0]?.instance_id!==config.instanceId)throw new Error('migration_instance_mismatch');
    await db.query('BEGIN');
    // Revoke permissive bootstrap defaults; runtime roles receive only their process capabilities.
    const authTables='auth.people,auth.accounts,auth.sessions,auth.session_revocations,auth.login_limits';
    const documentTables='business.document_configurations,business.document_jobs,business.document_pages,business.document_artifacts,business.document_tool_delegations,business.document_chunks,business.document_sources,business.document_previews,business.document_source_mappings,business.mock_validation_jobs';
    const intakeTables='business.intake_turns,business.intake_candidates,business.intake_events,business.model_calls,business.model_egress_receipts,business.model_budgets,business.intake_private_projections,business.intake_autofill_receipts';
    const reviewConfigTables='business.review_config_drafts,business.review_config_revisions,business.review_config_trials,business.review_config_approvals,business.review_config_releases';
    const reviewTables='business.review_rounds,business.review_object_versions,business.review_fact_versions,business.review_material_events,business.review_runs,business.review_findings,business.review_issues,business.review_events,business.review_supplements,business.review_supplement_gaps';
    const businessTables=`business.case_review_teams,business.app_instance,business.schema_migrations,business.principals,business.cases,business.case_number_counters,business.access_grants,business.grant_authorities,business.contributions,business.audit_events,business.command_receipts,business.runtime_heartbeats,business.upload_sessions,business.document_versions,business.parse_intents,business.work_items,business.outbox,business.inbox,business.draft_attachments,business.case_drafts,business.model_fixture_grants,business.model_session_grants,${intakeTables},${documentTables},${reviewConfigTables},${reviewTables},business.field_filter_calls,business.review_document_receipts`;
    await db.query(`REVOKE ALL ON ${authTables},${businessTables} FROM hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint`);
    await db.query('REVOKE ALL ON business.document_processing_access FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint');
    await db.query('GRANT SELECT,INSERT,UPDATE ON business.document_processing_access TO hsbc_p1_api; GRANT SELECT ON business.document_processing_access TO hsbc_p1_worker');
    await db.query('REVOKE ALL ON business.document_model_snapshots,business.document_model_calls FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint');
    await db.query('REVOKE ALL ON business.signature_review_snapshots,business.signature_page_receipts,business.signature_model_calls,business.signature_confirmations,business.signature_information_records,business.private_inference_queue FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint');
    await db.query('GRANT SELECT,INSERT ON business.signature_review_snapshots,business.signature_confirmations TO hsbc_p1_api; GRANT SELECT ON business.signature_page_receipts TO hsbc_p1_api; GRANT SELECT ON business.signature_review_snapshots,business.signature_confirmations TO hsbc_p1_worker; GRANT SELECT,INSERT ON business.signature_page_receipts TO hsbc_p1_worker; GRANT SELECT,INSERT,UPDATE ON business.signature_model_calls TO hsbc_p1_worker; GRANT SELECT,INSERT,DELETE ON business.private_inference_queue TO hsbc_p1_api,hsbc_p1_worker');
    await db.query('GRANT SELECT,INSERT ON business.signature_information_records TO hsbc_p1_api; GRANT SELECT ON business.signature_information_records TO hsbc_p1_worker');
    await db.query('GRANT SELECT(job_id,state) ON business.signature_model_calls TO hsbc_p1_api');
    await db.query('GRANT SELECT,INSERT ON business.document_model_snapshots TO hsbc_p1_worker; GRANT SELECT,INSERT,UPDATE ON business.document_model_calls TO hsbc_p1_worker');
    for(const schema of ['auth','business','a2a','checkpoint']){
      await db.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint`);
      await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON TABLES FROM hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint`);
    }
    await db.query(`GRANT USAGE ON SCHEMA auth,business TO hsbc_p1_api;
      GRANT USAGE ON SCHEMA business TO hsbc_p1_worker;
      REVOKE ALL ON SCHEMA auth FROM hsbc_p1_worker,hsbc_p1_checkpoint;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ${authTables} TO hsbc_p1_api;
      GRANT SELECT ON ${businessTables} TO hsbc_p1_api;
      GRANT SELECT ON business.app_instance,business.principals,business.cases,business.access_grants TO hsbc_p1_worker;
      GRANT SELECT(case_id,person_id,kind) ON business.contributions TO hsbc_p1_worker;
      GRANT UPDATE(revision) ON business.cases TO hsbc_p1_worker;
      GRANT INSERT,UPDATE ON business.case_review_teams,business.cases,business.access_grants,business.contributions,business.command_receipts,business.upload_sessions,business.work_items,business.outbox TO hsbc_p1_api;
      GRANT INSERT,UPDATE ON business.case_drafts,business.case_number_counters TO hsbc_p1_api;
      GRANT SELECT,INSERT,UPDATE ON business.draft_attachments TO hsbc_p1_api,hsbc_p1_worker;
      GRANT INSERT ON business.document_versions,business.parse_intents TO hsbc_p1_api;
      GRANT INSERT ON ${reviewConfigTables} TO hsbc_p1_api;
      GRANT UPDATE ON business.review_config_drafts TO hsbc_p1_api;
      GRANT SELECT ON ${reviewConfigTables} TO hsbc_p1_worker;
      GRANT INSERT,UPDATE ON ${reviewTables} TO hsbc_p1_api;
      GRANT SELECT,INSERT,UPDATE ON ${reviewTables} TO hsbc_p1_worker;
      GRANT SELECT,INSERT,UPDATE ON business.field_filter_calls TO hsbc_p1_worker;
      GRANT SELECT,INSERT ON business.review_document_receipts TO hsbc_p1_worker;
      GRANT SELECT,INSERT ON business.command_receipts TO hsbc_p1_worker;
      GRANT SELECT ON business.draft_attachments,business.case_drafts,business.model_fixture_grants,business.model_session_grants TO hsbc_p1_worker;
      GRANT UPDATE(revision,fields,field_states,field_sources,details,guarantee_types,updated_at) ON business.case_drafts TO hsbc_p1_worker;
      GRANT SELECT,INSERT,UPDATE ON ${intakeTables} TO hsbc_p1_api,hsbc_p1_worker;
      GRANT INSERT,DELETE ON business.grant_authorities TO hsbc_p1_api;
      GRANT INSERT ON business.audit_events TO hsbc_p1_api,hsbc_p1_worker;
      GRANT SELECT,INSERT,UPDATE,DELETE ON business.upload_sessions,business.document_versions,business.parse_intents,business.work_items,business.outbox,business.inbox,business.runtime_heartbeats TO hsbc_p1_worker;
      GRANT SELECT ON ${documentTables} TO hsbc_p1_worker;
      GRANT INSERT ON business.document_configurations,business.document_artifacts,business.document_chunks TO hsbc_p1_api,hsbc_p1_worker;
      GRANT INSERT,UPDATE ON business.document_jobs TO hsbc_p1_api,hsbc_p1_worker;
      GRANT INSERT ON business.document_pages TO hsbc_p1_worker;
      GRANT INSERT ON business.document_sources,business.document_previews,business.document_source_mappings TO hsbc_p1_worker;
      GRANT INSERT,UPDATE ON business.mock_validation_jobs TO hsbc_p1_api;
      GRANT UPDATE ON business.mock_validation_jobs TO hsbc_p1_worker;
      GRANT UPDATE ON business.document_versions,business.parse_intents,business.work_items TO hsbc_p1_api;
      GRANT INSERT ON business.inbox TO hsbc_p1_api;
      GRANT USAGE ON SCHEMA checkpoint TO hsbc_p1_checkpoint;`);
    await db.query('COMMIT');
    console.log(JSON.stringify({code:'p1_migration_complete',versions:files.length,instance:'verified'}));
  } finally{await db.query("SELECT pg_advisory_unlock(hashtextextended('p1-schema-migrations',0))").catch(()=>undefined);db.release();await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{await migrateP1(loadConfig(process.env,'migration'));}
  catch{console.error('P1 migration failed; inspect schema/version/instance with the migration operator. No credentials logged.');process.exitCode=1;}
}
