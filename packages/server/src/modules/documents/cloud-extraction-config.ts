import { z } from 'zod';
import { isResponsesEndpoint } from '../../model/cloud-endpoint.js';
import { loadIntakeConfig, type IntakeConfig } from '../intake/config.js';
import {DocumentCloudPricingSchema,type DocumentCloudPricing} from './cloud-cost.js';

export const DocumentEgressPolicySchema = z.strictObject({
  id:z.string().min(1).max(100),version:z.string().min(1).max(100),approvalRef:z.string().min(1).max(200),
  dataClass:z.literal('public_synthetic'),purpose:z.literal('document_extraction'),provider:z.literal('azure-openai'),
  deployment:z.string().min(1).max(100),actualModels:z.array(z.string().min(1).max(100)).min(1),
  endpoint:z.string().url().refine(isResponsesEndpoint),
  region:z.string().min(1).max(100),retention:z.string().min(1).max(300),trainingUse:z.literal('disabled'),
  subprocessors:z.array(z.string().min(1).max(100)).min(1),expiresAt:z.iso.datetime(),
  caseIds:z.array(z.uuid()).min(1).max(100),documentIds:z.array(z.uuid()).min(1).max(2000),
});
export type DocumentEgressPolicy = z.infer<typeof DocumentEgressPolicySchema>;
export const DocumentV2OutputConfigSchema=z.strictObject({reasoningEffort:z.literal('low'),maxOutputTokens:z.literal(32768)});
export interface DocumentCloudConfig {
  caseAuthorization?:boolean;
  /** Automatically apply the shared public/synthetic policy in this Demo environment. */
  policyReuse?:boolean;
  cloud: Omit<NonNullable<IntakeConfig['cloud']>,'policy'> & {policy:DocumentEgressPolicy;reasoningEffort?:'low';pricing?:DocumentCloudPricing};
  local: NonNullable<IntakeConfig['local']>;
  ner: NonNullable<IntakeConfig['ner']>;
  maxSourceBytes:number;
  maxPrivacyCalls:number;
  nerSourceSpans?:boolean;
  /** Opt-in only. V1 keeps the base cloud settings and request shape. */
  v2Output?:z.infer<typeof DocumentV2OutputConfigSchema>;
}
export function documentCloudExecutionConfig(config:DocumentCloudConfig,v2:boolean):DocumentCloudConfig {
  const {reasoningEffort:_ignored,...base}=config.cloud;
  if(!Number.isSafeInteger(base.maxOutputTokens)||base.maxOutputTokens<1||base.maxOutputTokens>16384)throw new Error('document_cloud_output_capacity_invalid');
  const output=v2&&config.v2Output?DocumentV2OutputConfigSchema.parse(config.v2Output):undefined;
  return {...config,cloud:{...base,...(output?{maxOutputTokens:output.maxOutputTokens,reasoningEffort:output.reasoningEffort}:{})}};
}
/** Separate purpose and document allowlist; intake approval never enables document egress. */
export function loadDocumentCloudConfig(env:NodeJS.ProcessEnv=process.env):DocumentCloudConfig|undefined {
  if(env.P3_DOCUMENT_CLOUD_ENABLED===undefined||env.P3_DOCUMENT_CLOUD_ENABLED==='false')return undefined;
  if(env.P3_DOCUMENT_CLOUD_ENABLED!=='true')throw new Error('document_cloud_flag_invalid');
  const base=loadIntakeConfig(env);
  if(base.cloudMode!=='public_synthetic'||!base.cloud||!base.local||!base.ner)throw new Error('document_cloud_dependencies_required');
  let policy:DocumentEgressPolicy;
  try{policy=DocumentEgressPolicySchema.parse(JSON.parse(env.P3_DOCUMENT_EGRESS_POLICY_JSON??''));}
  catch{throw new Error('document_cloud_policy_invalid');}
  if(Date.parse(policy.expiresAt)<=Date.now()||policy.endpoint!==base.cloud.endpoint||policy.deployment!==base.cloud.model)throw new Error('document_cloud_policy_mismatch');
  const maxOutputTokens=env.P3_DOCUMENT_CLOUD_MAX_OUTPUT_TOKENS===undefined?base.cloud.maxOutputTokens:Number(env.P3_DOCUMENT_CLOUD_MAX_OUTPUT_TOKENS);
  if(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>16384)throw new Error('document_cloud_output_capacity_invalid');
  const timeoutMs=env.P3_DOCUMENT_CLOUD_TIMEOUT_MS===undefined?base.cloud.timeoutMs:Number(env.P3_DOCUMENT_CLOUD_TIMEOUT_MS);
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>240000)throw new Error('document_cloud_timeout_invalid');
  const nerSourceSpans=env.P3_DOCUMENT_NER_SOURCE_SPANS_ENABLED;
  const caseAuthorization=env.P3_DOCUMENT_CASE_AUTHORIZATION_ENABLED;
  const policyReuse=env.P3_DOCUMENT_POLICY_REUSE_ENABLED;
  if(policyReuse!==undefined&&!['true','false'].includes(policyReuse))throw new Error('document_policy_reuse_flag_invalid');
  if(caseAuthorization!==undefined&&!['true','false'].includes(caseAuthorization))throw new Error('document_case_authorization_flag_invalid');
  if(nerSourceSpans!==undefined&&!['true','false'].includes(nerSourceSpans))throw new Error('document_ner_spans_flag_invalid');
  const effort=env.P3_DOCUMENT_CLOUD_V2_REASONING_EFFORT,outputTokens=env.P3_DOCUMENT_CLOUD_V2_MAX_OUTPUT_TOKENS;
  const v2Output=effort===undefined&&outputTokens===undefined?undefined:
    DocumentV2OutputConfigSchema.safeParse({reasoningEffort:effort,maxOutputTokens:Number(outputTokens)});
  if(v2Output&&!v2Output.success)throw new Error('document_cloud_v2_output_invalid');
  let pricing:DocumentCloudPricing|undefined;
  if(env.P3_DOCUMENT_CLOUD_PRICING_JSON!==undefined){
    try{pricing=DocumentCloudPricingSchema.parse(JSON.parse(env.P3_DOCUMENT_CLOUD_PRICING_JSON));}
    catch{throw new Error('document_cloud_pricing_invalid');}
    if(pricing.deployment!==policy.deployment||policy.actualModels.some(model=>!pricing!.actualModels.includes(model as DocumentCloudPricing['actualModels'][number])))throw new Error('document_cloud_pricing_mismatch');
  }
  return {cloud:{...base.cloud,policy,maxOutputTokens,timeoutMs,...(pricing?{pricing}:{})},local:base.local,ner:base.ner,
    ...(caseAuthorization==='true'?{caseAuthorization:true}:{}),
    ...(policyReuse==='true'?{policyReuse:true}:{}),
    ...(nerSourceSpans==='true'?{nerSourceSpans:true}:{}),
    ...(v2Output?.success?{v2Output:v2Output.data}:{}),
    maxSourceBytes:base.assistantCapacity?.maxSourceBytes??120000,maxPrivacyCalls:base.assistantCapacity?.maxPrivacyCalls??64};
}
