import {z} from 'zod';
import {DocumentEgressPolicySchema} from '../documents/cloud-extraction-config.js';
import {reviewHash} from '../review/service.js';

const positive=z.number().int().positive();
/** Purpose-bound: extraction, intake and formal-review approvals never authorize assistant egress. */
export const CaseAssistPolicySchema=DocumentEgressPolicySchema.omit({caseIds:true,documentIds:true}).extend({
  purpose:z.literal('case_assist'),budgetId:z.string().min(1).max(100),totalBudgetMicros:positive,
  /** Either named cases, or only cases bound to a synthetic-scope published configuration. */
  caseScope:z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('listed'),caseIds:z.array(z.uuid()).min(1).max(200)}),
    z.strictObject({kind:z.literal('synthetic_configuration')}),
  ]),
});
export type CaseAssistPolicy=z.infer<typeof CaseAssistPolicySchema>;
export const CaseAssistConfigSchema=z.strictObject({
  policy:CaseAssistPolicySchema,token:z.string().min(1),model:z.string().min(1),endpoint:z.string().url(),
  maxInputTokens:positive.max(256000),maxOutputTokens:positive.max(16384),timeoutMs:positive.max(120000),requestsPerMinute:positive.max(60),
  dailyBudgetMicros:positive,callBudgetMicros:positive,inputMicrosPerMillion:positive,outputMicrosPerMillion:positive,
  ner:z.strictObject({baseUrl:z.string().url(),token:z.string().min(1),allowHttp:z.boolean().optional(),timeoutMs:positive.max(120000).optional()}),
  maxSourceBytes:positive.max(256000),maxPrivacyCalls:positive.max(192),
}).superRefine((c,ctx)=>{
  if(c.policy.endpoint!==c.endpoint||c.policy.deployment!==c.model)ctx.addIssue({code:'custom',message:'case_assist_policy_mismatch'});
});
export type CaseAssistConfig=z.infer<typeof CaseAssistConfigSchema>;

/** Default off. An explicit, complete configuration is required; there is no simulated fallback. */
export function loadCaseAssistConfig(env:NodeJS.ProcessEnv=process.env):CaseAssistConfig|undefined {
  if(env.P4_CASE_ASSISTANT_ENABLED===undefined||env.P4_CASE_ASSISTANT_ENABLED==='false')return;
  if(env.P4_CASE_ASSISTANT_ENABLED!=='true')throw new Error('case_assistant_flag_invalid');
  try{
    const raw=JSON.parse(env.P4_CASE_ASSISTANT_CONFIG_JSON??'');
    return CaseAssistConfigSchema.parse({...raw,token:env.P4_CASE_ASSISTANT_TOKEN,ner:{...raw.ner,token:env.P4_CASE_ASSISTANT_NER_TOKEN}});
  }catch{throw new Error('case_assistant_configuration_invalid');}
}
export function caseAssistProfileHash(config:CaseAssistConfig){const {token,ner,...rest}=config;return reviewHash({...rest,ner:{baseUrl:ner.baseUrl,allowHttp:ner.allowHttp,timeoutMs:ner.timeoutMs}});}
export function caseAssistCapability(config:CaseAssistConfig|undefined){
  const available=!!config&&Date.parse(config.policy.expiresAt)>Date.now();
  return {available,reason:available?null:config?'case_assistant_policy_expired':'case_assistant_disabled',model:available?config!.model:null};
}
