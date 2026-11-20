import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ServiceError, type ServiceConfig } from './http.js';
import type { ModelAdapter, ModelAuthorization, PreparedModelPayload } from '../../model/gateway.js';

/** Explicit operator approval for hosted processing; no implicit cloud fallback. */
export const HostedQwenPolicySchema = z.strictObject({
  version: z.literal('bailian-hosted-v1'), approvalRef: z.string().min(1).max(200),
  dataClass: z.literal('authorized_original'), model: z.literal('qwen3.8-flash'),
  baseUrl: z.string().url().refine(value => {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash &&
      /^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(u.hostname) && u.pathname === '/compatible-mode/v1';
  }), expiresAt: z.iso.datetime().nullable(),
});
export type HostedQwenPolicy = z.infer<typeof HostedQwenPolicySchema>;
const expectedPayload = new AsyncLocalStorage<PreparedModelPayload>();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function checkHostedPolicy(policy: HostedQwenPolicy, baseUrl: string, model: string) {
  const parsed = HostedQwenPolicySchema.safeParse(policy);
  if (!parsed.success || (policy.expiresAt !== null && Date.parse(policy.expiresAt) <= Date.now()) || policy.baseUrl !== baseUrl.replace(/\/$/, '') || policy.model !== model)
    throw new ServiceError('qwen_hosted_policy_denied');
  return policy;
}
export function hostedQwenOptions(env: NodeJS.ProcessEnv): Pick<ServiceConfig, 'hostedQwen'> {
  if (!env.P1_QWEN_PROVIDER || env.P1_QWEN_PROVIDER === 'local-vllm') {
    if (env.P1_QWEN_HOSTED_POLICY_JSON) throw new ServiceError('qwen_hosted_policy_denied');
    return {};
  }
  if (env.P1_QWEN_PROVIDER !== 'bailian') throw new ServiceError('qwen_hosted_policy_denied');
  let policy: HostedQwenPolicy;
  try { policy = HostedQwenPolicySchema.parse(JSON.parse(env.P1_QWEN_HOSTED_POLICY_JSON ?? '')); }
  catch { throw new ServiceError('qwen_hosted_policy_denied'); }
  return { hostedQwen: checkHostedPolicy(policy, env.P1_QWEN_BASE_URL ?? '', env.P1_QWEN_MODEL ?? '') };
}
export function supportedQwenModel(env: NodeJS.ProcessEnv) {
  return hostedQwenOptions(env).hostedQwen ? true :
    ['Qwen/Qwen3.5-9B', 'Qwen/Qwen3.8-27B'].includes(env.P1_QWEN_MODEL ?? '');
}
export function qwenProvider<T extends string = 'self-hosted-vllm'>(service: ServiceConfig, legacy: T = 'self-hosted-vllm' as T): T|'bailian' { return service.hostedQwen ? 'bailian' : legacy; }
export function qwenRequestBody(model: string, messages: unknown[], options: {maxTokens?:number;disableThinking?:boolean;jsonObject?:boolean;jsonSchema?:{name:string;schema:Record<string,unknown>}}, hosted = false) {
  return {model,messages,stream:false,max_tokens:options.maxTokens??1024,temperature:0,
    ...(options.disableThinking ? hosted ? {enable_thinking:false} : {chat_template_kwargs:{enable_thinking:false}} : {}),
    ...(options.jsonSchema ? {response_format:{type:'json_schema',json_schema:{name:options.jsonSchema.name,strict:true,schema:options.jsonSchema.schema}}} : options.jsonObject ? {response_format:{type:'json_object'}} : {})};
}
export function hostedPayload(service: ServiceConfig, model: string, body: unknown): PreparedModelPayload {
  const policy = service.hostedQwen;
  if (!policy) throw new ServiceError('qwen_hosted_policy_denied');
  checkHostedPolicy(policy, service.baseUrl, model);
  const text = JSON.stringify(body);
  return {endpoint:policy.baseUrl+'/chat/completions',model,actualProvider:'bailian',body:text,payloadHash:hash(text)};
}
/** Binds the exact bytes approved by the gateway to the eventual transport. */
export function hostedDispatchRecord(service: ServiceConfig, model: string, body: unknown): unknown {
  if (!service.hostedQwen) return body;
  const payload = hostedPayload(service, model, body), expected = expectedPayload.getStore();
  if (expected && (expected.payloadHash !== payload.payloadHash || expected.endpoint !== payload.endpoint || expected.model !== model))
    throw new ServiceError('qwen_hosted_policy_denied');
  return {request:body,egress:{provider:'bailian',endpoint:payload.endpoint,model,policy:service.hostedQwen,payloadHash:payload.payloadHash}};
}
export function hostedAdapter(adapter: ModelAdapter, service: ServiceConfig, model: string,
  body: () => unknown | Promise<unknown>): ModelAdapter {
  if (!service.hostedQwen) return adapter;
  let prepared: {request:Parameters<ModelAdapter['generate']>[0];profile:Parameters<ModelAdapter['generate']>[1];payload:PreparedModelPayload}|undefined;
  return {version:adapter.version+'-bailian-v1',simulated:adapter.simulated,generate:()=>{throw new ServiceError('qwen_hosted_policy_denied');},
    async prepare(request,profile,signal) { signal.throwIfAborted();const payload=hostedPayload(service,model,await body());prepared={request,profile,payload};return payload; },
    async dispatch(payload,permit,signal) {
      const p=prepared;prepared=undefined;
      if(!p || payload.payloadHash!==p.payload.payloadHash || payload.body!==p.payload.body || payload.endpoint!==p.payload.endpoint ||
        permit.payloadHash!==payload.payloadHash || permit.endpoint!==payload.endpoint || permit.policyVersion!==hash(JSON.stringify(service.hostedQwen)))
        throw new ServiceError('qwen_hosted_policy_denied');
      checkHostedPolicy(service.hostedQwen!,service.baseUrl,model);
      return expectedPayload.run(payload,()=>adapter.generate(p.request,p.profile,signal));
    }};
}
export function hostedAuthorization(service: ServiceConfig, model: string, authorize: () => Promise<void>): Pick<ModelAuthorization,'authorizeEgress'|'authorizePayload'> {
  return {authorizeEgress:async()=>{if(!service.hostedQwen)return false;checkHostedPolicy(service.hostedQwen,service.baseUrl,model);return true;},
    authorizePayload:async(_identity,_request,grant,profile,payload)=>{
      await authorize();
      if(!service.hostedQwen || grant.evidenceClass!=='approved_original' || profile.provider!=='bailian')return null;
      checkHostedPolicy(service.hostedQwen,service.baseUrl,model);
      if(payload.endpoint!==service.hostedQwen.baseUrl+'/chat/completions'||payload.model!==model||payload.actualProvider!=='bailian'||hash(payload.body)!==payload.payloadHash)return null;
      const policyVersion=hash(JSON.stringify(service.hostedQwen));
      return {payloadHash:payload.payloadHash,endpoint:payload.endpoint,policyVersion,receiptId:hash(policyVersion+payload.payloadHash)};
    }};
}
