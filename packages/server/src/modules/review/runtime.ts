import { HttpRuleExecutor, LocalOpaExecutor, UnavailableRuleExecutor, type RuleExecutor } from './opa.js';

export interface ReviewRuntime { configuration:boolean; review:boolean; executor:RuleExecutor }
/** Flags are independent of model-intake/field-filter flags and fail closed. */
export function loadReviewRuntime(env:NodeJS.ProcessEnv=process.env):ReviewRuntime {
  const flag=(key:string)=>{if(env[key]!==undefined&&!['true','false'].includes(env[key]!))throw new Error(`invalid_flag:${key}`);return env[key]==='true';};
  const configuration=flag('P3_REVIEW_CONFIG_ENABLED'),review=flag('P3_REVIEW_ENABLED');
  if(review&&!configuration)throw new Error('review_configuration_capability_required');
  if(!configuration)return {configuration,review,executor:new UnavailableRuleExecutor()};
  if(env.P3_OPA_BINARY){
    if(env.P1_MODE!=='local')throw new Error('local_opa_only');
    return {configuration,review,executor:new LocalOpaExecutor(env.P3_OPA_BINARY)};
  }
  if(!env.P3_OPA_BASE_URL||!env.P3_OPA_TOKEN)throw new Error('opa_configuration_required');
  return {configuration,review,executor:new HttpRuleExecutor({baseUrl:env.P3_OPA_BASE_URL,token:env.P3_OPA_TOKEN,timeoutMs:15000,allowHttp:env.P3_OPA_ALLOW_HTTP==='true'})};
}
