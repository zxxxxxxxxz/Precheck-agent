import {z} from 'zod';
import {DocumentEgressPolicySchema} from '../documents/cloud-extraction-config.js';
import {reviewHash} from '../review/service.js';
const positive=z.number().int().positive();
export const FormalPolicySchema=DocumentEgressPolicySchema.extend({purpose:z.literal('cloud_review'),budgetId:z.string().min(1).max(100),totalBudgetMicros:positive,maxCalls:positive.max(1000)});
export const FormalConfigSchema=z.strictObject({policy:FormalPolicySchema,token:z.string().min(1),model:z.string().min(1),endpoint:z.string().url(),
 maxInputTokens:positive.max(256000),maxOutputTokens:positive.max(16384),timeoutMs:positive.max(120000),requestsPerMinute:positive.max(60),
 dailyBudgetMicros:positive,callBudgetMicros:positive,inputMicrosPerMillion:positive,outputMicrosPerMillion:positive,
 ner:z.strictObject({baseUrl:z.string().url(),token:z.string().min(1),allowHttp:z.boolean().optional(),timeoutMs:positive.max(120000).optional()}),maxSourceBytes:positive.max(256000),maxPrivacyCalls:positive.max(192)}).superRefine((c,ctx)=>{
 if(c.policy.endpoint!==c.endpoint||c.policy.deployment!==c.model)ctx.addIssue({code:'custom',message:'formal_policy_mismatch'});
});
export type FormalConfig=z.infer<typeof FormalConfigSchema>;
export function loadFormalConfig(env:NodeJS.ProcessEnv=process.env):FormalConfig|undefined {
 if(env.P3_FORMAL_REVIEW_ENABLED===undefined||env.P3_FORMAL_REVIEW_ENABLED==='false')return;
 if(env.P3_FORMAL_REVIEW_ENABLED!=='true')throw new Error('formal_review_flag_invalid');
 try{return FormalConfigSchema.parse({...JSON.parse(env.P3_FORMAL_REVIEW_CONFIG_JSON??''),token:env.P3_FORMAL_REVIEW_TOKEN,ner:{...JSON.parse(env.P3_FORMAL_REVIEW_CONFIG_JSON??'{}').ner,token:env.P3_FORMAL_REVIEW_NER_TOKEN}});}catch{throw new Error('formal_review_configuration_invalid');}
}
export function formalProfileHash(config:FormalConfig){const {token,ner,...rest}=config;return reviewHash({...rest,ner:{baseUrl:ner.baseUrl,allowHttp:ner.allowHttp,timeoutMs:ner.timeoutMs}});}
