import type {PoolClient} from 'pg';
import {LEGACY_FRAGMENT_PREPARE_VERSION,PRIVACY_DOCUMENT_TERMS_VERSION,PRIVACY_SPAN_PREPARE_VERSION,PRIVACY_PREPARE_VERSION} from '../intake/privacy-projection.js';
export type RecoveryAvailability={available:true;mode:'prepare'|'cached'}|{available:false;reason:string};
/** The owner service separately checks current case, actor, configuration and permit. */
export async function documentRecoveryAvailability(db:PoolClient,jobId:string):Promise<RecoveryAvailability>{
  const row=(await db.query(`SELECT recovery.*,job.error_code,
    (SELECT details->>'diagnostic' FROM business.audit_events WHERE target_id=job.id::text AND action='document:processing_failed'
      ORDER BY created_at DESC,id DESC LIMIT 1) AS error_diagnostic
    FROM business.document_jobs job CROSS JOIN LATERAL business.document_recovery_status(job.id) recovery WHERE job.id=$1`,[jobId])).rows[0];
  if(!row)return {available:false,reason:'parse_not_available'};
  if(row.unknown_calls)return {available:false,reason:'execution_unknown'};
  // The same legacy error also covers request/snapshot identity mismatches.
  // No unresolved dispatch does not prove that the failed job can be replayed.
  if(row.error_code==='execution_unknown')return {available:false,reason:'fresh_parse_required'};
  if(row.error_code==='invalid_output'&&row.error_diagnostic==='document_dictionary_references')return {available:false,reason:'document_dictionary_references'};
  if(Number(row.recovery_count)>=3)return {available:false,reason:'recovery_attempts_exhausted'};
  if(row.failed_cloud)return {available:false,reason:'fresh_parse_required'};
  if(row.privacy_version===LEGACY_FRAGMENT_PREPARE_VERSION&&row.completed_first)return {available:true,mode:'cached'};
  if(row.privacy_version&&![PRIVACY_DOCUMENT_TERMS_VERSION,PRIVACY_SPAN_PREPARE_VERSION,PRIVACY_PREPARE_VERSION].includes(row.privacy_version))return {available:false,reason:'fresh_parse_required'};
  return {available:true,mode:'prepare'};
}
