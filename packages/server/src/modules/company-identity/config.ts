import { z } from 'zod';
import { GLEIF_ORIGIN } from './gleif-client.js';

export const CompanyLookupPolicySchema = z.strictObject({
  id: z.string().min(1).max(100), version: z.string().min(1).max(100), approvalRef: z.string().min(1).max(200),
  purpose: z.literal('company_lookup'), provider: z.literal('GLEIF'), origin: z.literal(GLEIF_ORIGIN),
  dataClass: z.enum(['public_synthetic', 'bank']), caseIds: z.array(z.uuid()).min(1).max(100),
  expiresAt: z.iso.datetime(), requestsPerMinute: z.number().int().min(1).max(60).default(10),
  requestsPerDay: z.number().int().min(1).max(10000).default(200),
});
export type CompanyLookupPolicy = z.infer<typeof CompanyLookupPolicySchema>;
export interface CompanyIdentityConfig { externalEnabled: boolean; policy?: CompanyLookupPolicy }
export function loadCompanyIdentityConfig(env: NodeJS.ProcessEnv = process.env): CompanyIdentityConfig {
  if (!env.P4_COMPANY_LOOKUP_ENABLED || env.P4_COMPANY_LOOKUP_ENABLED === 'false') return { externalEnabled: false };
  if (env.P4_COMPANY_LOOKUP_ENABLED !== 'true') throw new Error('company_lookup_flag_invalid');
  let policy: CompanyLookupPolicy;
  try { policy = CompanyLookupPolicySchema.parse(JSON.parse(env.P4_COMPANY_LOOKUP_POLICY_JSON ?? '')); }
  catch { throw new Error('company_lookup_policy_invalid'); }
  if (Date.parse(policy.expiresAt) <= Date.now()) throw new Error('company_lookup_policy_expired');
  return { externalEnabled: true, policy };
}
