import { hostedQwenOptions } from '../../infrastructure/integrations/qwen-hosting.js';
import { z } from 'zod';
import { isResponsesEndpoint } from '../../model/cloud-endpoint.js';
import { logEvent } from '../../runtime/logging.js';
import type { ServiceConfig } from '../../infrastructure/integrations/http.js';
const Policy=z.object({id:z.string().min(1).max(100),version:z.string().min(1).max(100),approvalRef:z.string().min(1).max(200),dataClass:z.enum(['synthetic','public_synthetic','bank']),purpose:z.literal('draft_intake'),provider:z.literal('azure-openai'),deployment:z.string().min(1).max(100),actualModels:z.array(z.string().min(1).max(100)).min(1),endpoint:z.string().url().refine(isResponsesEndpoint),region:z.string().min(1).max(100),retention:z.string().min(1).max(300),trainingUse:z.literal('disabled'),subprocessors:z.array(z.string().min(1).max(100)).min(1),expiresAt:z.iso.datetime()}).strict();
export type IntakePolicy=z.infer<typeof Policy>;
/** The daily budget is whatever the operator sets: the loader only requires a whole positive amount it can count exactly. */
const DAILY_BUDGET_CEILING=Number.MAX_SAFE_INTEGER;
export const ASSISTANT_CAPACITY_DEFAULTS=Object.freeze({maxSourceBytes:120_000,maxPrivacyCalls:64});
export const ASSISTANT_CAPACITY_LIMITS=Object.freeze({maxSourceBytes:256_000,maxPrivacyCalls:192,maxCloudInputBytes:524_288});
export interface IntakeConfig {
  assistantCapacity?:{maxSourceBytes:number;maxPrivacyCalls:number};
  cloudMode:'off'|'synthetic'|'public_synthetic'|'bank';cloud?:{token:string;endpoint:string;model:string;policy:IntakePolicy;timeoutMs:number;maxInputTokens:number;maxOutputTokens:number;requestsPerMinute:number;dailyBudgetMicros:number;callBudgetMicros:number;inputMicrosPerMillion:number;outputMicrosPerMillion:number};
  local?:{service:ServiceConfig;model:string;timeoutMs:number;maxInputTokens:number;maxOutputTokens:number;requestsPerMinute:number;dailyBudgetMicros:number;callBudgetMicros:number;inputMicrosPerMillion:number;outputMicrosPerMillion:number};ner?:ServiceConfig;

}
export function intakeAssistantCapacity(config:IntakeConfig){
  return config.cloudMode==='public_synthetic'?{...ASSISTANT_CAPACITY_DEFAULTS,...config.assistantCapacity}:{...ASSISTANT_CAPACITY_DEFAULTS};
}
export function loadIntakeConfig(env:NodeJS.ProcessEnv=process.env):IntakeConfig{
  const mode=z.enum(['off','synthetic','public_synthetic','bank']).parse(env.P3_CLOUD_MODE??'off');
  const number=(key:string,max:number)=>{const value=Number(env[key]);if(!Number.isSafeInteger(value)||value<1||value>max)throw new Error(`invalid_configuration:${key}`);return value;};
  const required=(key:string)=>{if(!env[key])throw new Error(`missing_configuration:${key}`);return env[key]!;};
  const service=(name:string,timeoutMs:number):ServiceConfig=>({baseUrl:required(`P1_${name}_BASE_URL`),token:required(`P1_${name}_TOKEN`),allowHttp:env[`P1_${name}_ALLOW_HTTP`]==='true',timeoutMs});
  const config:IntakeConfig={cloudMode:mode};
  if(mode==='public_synthetic'){
    const capacity=(key:string,fallback:number,max:number)=>env[key]===undefined?fallback:number(key,max);
    config.assistantCapacity={maxSourceBytes:capacity('P3_ASSISTANT_MAX_SOURCE_BYTES',ASSISTANT_CAPACITY_DEFAULTS.maxSourceBytes,ASSISTANT_CAPACITY_LIMITS.maxSourceBytes),maxPrivacyCalls:capacity('P3_ASSISTANT_MAX_PRIVACY_CALLS',ASSISTANT_CAPACITY_DEFAULTS.maxPrivacyCalls,ASSISTANT_CAPACITY_LIMITS.maxPrivacyCalls)};
  }
  const cloudKey=(suffix:string)=>`${mode==='public_synthetic'?'P3_ASSISTANT_CLOUD':'P3_MODEL'}_${suffix}`;
  const cloudNumber=(suffix:string,max:number)=>number(cloudKey(suffix),max);
  if(mode!=='off'){
    let policy:IntakePolicy;try{policy=Policy.parse(JSON.parse(required('P3_EGRESS_POLICY_JSON')));}catch{throw new Error('invalid_configuration:P3_EGRESS_POLICY_JSON');}
    if(policy.dataClass!==mode||Date.parse(policy.expiresAt)<=Date.now())throw new Error('invalid_configuration:P3_EGRESS_POLICY_JSON');
    config.cloud={token:env.AZURE_OPENAI_API_KEY??required('P3_AZURE_API_KEY'),endpoint:`${(env.AZURE_OPENAI_ENDPOINT??'https://tkd-resource.openai.azure.com/openai/v1').replace(/\/$/,'')}/responses`,model:env.AZURE_OPENAI_DEPLOYMENT??'gpt-6-astra',policy,timeoutMs:cloudNumber('TIMEOUT_MS',120000),maxInputTokens:cloudNumber('MAX_INPUT_TOKENS',mode==='public_synthetic'?ASSISTANT_CAPACITY_LIMITS.maxCloudInputBytes:16000),maxOutputTokens:cloudNumber('MAX_OUTPUT_TOKENS',4096),requestsPerMinute:cloudNumber('REQUESTS_PER_MINUTE',60),dailyBudgetMicros:cloudNumber('DAILY_BUDGET_MICROS',DAILY_BUDGET_CEILING),callBudgetMicros:cloudNumber('CALL_BUDGET_MICROS',100000000),inputMicrosPerMillion:cloudNumber('INPUT_MICROS_PER_MILLION',1000000000),outputMicrosPerMillion:cloudNumber('OUTPUT_MICROS_PER_MILLION',1000000000)};
    if(config.cloud.endpoint!==policy.endpoint||config.cloud.model!==policy.deployment)throw new Error('azure_policy_configuration_mismatch');
    config.ner=service('NER',10000);
  }
  config.local=loadLocalIntakeConfig(env,mode==='public_synthetic');
  if(!config.local)delete config.local;
  return config;
}

function configurationNumber(env:NodeJS.ProcessEnv,key:string,max:number){const value=Number(env[key]);if(!Number.isSafeInteger(value)||value<1||value>max)throw new Error(`invalid_configuration:${key}`);return value;}
function loadLocalIntakeConfig(env:NodeJS.ProcessEnv,assistant:boolean):IntakeConfig['local']{
  const required=(key:string)=>{if(!env[key])throw new Error(`missing_configuration:${key}`);return env[key]!;};
  if(env.P3_LOCAL_INTAKE_ENABLED==='true'){
    if(env.P3_LOCAL_INTAKE_VALIDATED!=='true')throw new Error('local_intake_capability_validation_required');
    const key=(suffix:string)=>`${assistant?'P3_ASSISTANT_LOCAL':'P3_LOCAL_INTAKE'}_${suffix}`;
    const number=(suffix:string,max:number)=>configurationNumber(env,key(suffix),max);
    const timeoutMs=number('TIMEOUT_MS',120000);
    return {service:{...hostedQwenOptions(env),baseUrl:required('P1_QWEN_BASE_URL'),token:required('P1_QWEN_TOKEN'),allowHttp:env.P1_QWEN_ALLOW_HTTP==='true',timeoutMs},model:required('P1_QWEN_MODEL'),timeoutMs,maxInputTokens:number('MAX_INPUT_TOKENS',6000),maxOutputTokens:number('MAX_OUTPUT_TOKENS',2048),requestsPerMinute:number('REQUESTS_PER_MINUTE',assistant?120:30),dailyBudgetMicros:number('DAILY_BUDGET_MICROS',DAILY_BUDGET_CEILING),callBudgetMicros:number('CALL_BUDGET_MICROS',100000000),inputMicrosPerMillion:number('INPUT_MICROS_PER_MILLION',1000000000),outputMicrosPerMillion:number('OUTPUT_MICROS_PER_MILLION',1000000000)};
  }else if(env.P3_LOCAL_INTAKE_ENABLED&&env.P3_LOCAL_INTAKE_ENABLED!=='false')throw new Error('invalid_configuration:P3_LOCAL_INTAKE_ENABLED');
}
export function reserveMicros(config:Pick<NonNullable<IntakeConfig['cloud']>,'maxInputTokens'|'maxOutputTokens'|'inputMicrosPerMillion'|'outputMicrosPerMillion'|'callBudgetMicros'>,inputBytes:number){
  // UTF-8 bytes are a conservative token ceiling, not a reported tokenizer count.
  if(inputBytes>config.maxInputTokens)throw new Error('input_budget_exhausted');
  const estimate=Math.ceil((inputBytes*config.inputMicrosPerMillion+config.maxOutputTokens*config.outputMicrosPerMillion)/1_000_000);
  if(estimate>config.callBudgetMicros)throw new Error('call_budget_exhausted');return estimate;
}

/** Invalid model configuration closes that channel while the form workflow remains available. */
export function loadRuntimeIntakeConfig(env:NodeJS.ProcessEnv=process.env):IntakeConfig{
  let cloud:IntakeConfig={cloudMode:'off'},local:IntakeConfig={cloudMode:'off'};
  try{cloud=loadIntakeConfig({...env,P3_LOCAL_INTAKE_ENABLED:'false'});}catch{logEvent('p3_cloud_configuration_disabled');}
  try{const configured=loadLocalIntakeConfig(env,env.P3_CLOUD_MODE==='public_synthetic');if(configured)local.local=configured;}catch{logEvent('p3_local_configuration_disabled');}
  return{...cloud,...(local.local?{local:local.local}:{})};
}
