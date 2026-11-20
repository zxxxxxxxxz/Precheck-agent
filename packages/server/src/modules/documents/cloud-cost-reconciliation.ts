import {z} from 'zod';
import type {Pool} from 'pg';
import {transaction} from '../../infrastructure/database/client.js';
import {configHash} from '../review/opa.js';
import {audit} from '../audit/events.js';
import {DocumentCloudPricingSchema,documentCloudUsageCost} from './cloud-cost.js';

export const DocumentCostReconciliationSchema=z.strictObject({
  version:z.literal('document-cost-reconciliation.v1'),
  verificationRef:z.string().min(1).max(200),
  pricing:DocumentCloudPricingSchema,
  calls:z.array(z.strictObject({
    id:z.uuid(),requestHash:z.string().regex(/^[a-f0-9]{64}$/u),policyHash:z.string().regex(/^[a-f0-9]{64}$/u),
    reservedMicros:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    usageHash:z.string().regex(/^[a-f0-9]{64}$/u),
  })).min(1).max(2000).refine(calls=>new Set(calls.map(c=>c.id)).size===calls.length),
});
/** Explicit operator reconciliation only. Never dispatches, changes original
 * receipts, invents missing usage/model identity, or settles an unknown call. */
export async function reconcileDocumentCloudCosts(pool:Pool,input:unknown,apply=false) {
  const manifest=DocumentCostReconciliationSchema.parse(input);
  return transaction(pool,async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtext('document-extraction:cloud'))");
    const results=[];
    for(const expected of manifest.calls){
      const c=(await db.query('SELECT * FROM business.document_model_calls WHERE id=$1 FOR UPDATE',[expected.id])).rows[0];
      if(!c||c.channel!=='cloud'||c.state!=='completed'||!c.usage||c.request_hash!==expected.requestHash||
        c.policy_hash!==expected.policyHash||Number(c.reserved_micros)!==expected.reservedMicros||configHash(c.usage)!==expected.usageHash||
        c.model!==manifest.pricing.deployment||c.response?.actualProvider!=='azure-openai'||c.response?.simulated!==false||
        c.response?.status!=='completed'||configHash(c.response?.usage??null)!==expected.usageHash)throw new Error('document_cost_reconciliation_mismatch');
      // Historical usage did not include cache categories. Keep them unknown;
      // do not grant the Worker read access to the wider audit log for a discount.
      const calculation=documentCloudUsageCost(manifest.pricing,c.usage,c.response.actualModel);
      const previous=(await db.query('SELECT p.*,s.calculation FROM business.document_model_prices p LEFT JOIN business.document_model_charges s ON s.call_id=p.call_id WHERE p.call_id=$1',[c.id])).rows[0];
      if(previous&&(configHash(previous.pricing)!==configHash(manifest.pricing)||previous.provenance!=='verified_legacy'||
        previous.verification_ref!==manifest.verificationRef||configHash(previous.calculation)!==configHash(calculation)))throw new Error('document_cost_reconciliation_conflict');
      if(apply&&!previous){
        await db.query("INSERT INTO business.document_model_prices(call_id,pricing,provenance,verification_ref) VALUES($1,$2,'verified_legacy',$3)",[c.id,manifest.pricing,manifest.verificationRef]);
        await db.query("INSERT INTO business.document_model_charges(call_id,charged_micros,basis,usage,calculation) VALUES($1,$2,$3,$4,$5)",[c.id,calculation.chargedMicros,calculation.basis,c.usage,calculation]);
        await audit(db,{actorId:c.approved_by,targetId:c.job_id,action:'document.model_budget_reconciled',
          details:{callId:c.id,originalReservedMicros:expected.reservedMicros,budgetChargeMicros:calculation.chargedMicros,basis:calculation.basis,verificationRef:manifest.verificationRef}});
      }
      results.push({callId:c.id,originalReservedMicros:expected.reservedMicros,budgetChargeMicros:calculation.chargedMicros,existing:!!previous});
    }
    return {version:manifest.version,applied:apply,basis:'usage_upper_bound_not_invoice',verificationRef:manifest.verificationRef,calls:results};
  });
}
