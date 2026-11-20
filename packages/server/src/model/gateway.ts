import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { IdentityContext } from '@hsbc/contracts/identity';
import { ModelProfileSchema,ModelRequestSchema,ModelResultSchema,ModelUsageSchema,ModelToolSuggestionSchema,ModelErrorCodeSchema,ModelDiagnosticSchema,modelScope,type ModelProfile,type ModelRequest,type ModelResult } from '@hsbc/contracts/model';
type GrantCommon={taskId:string;messageBundleRef:string;profileId:string;profileVersion:string;evidenceClass:'original'|'redacted'|'approved_original';authorizationVersion:number};
export type ModelGrant=GrantCommon&({scopeType?:'case';caseId:string;revision:number;evidencePackageRef:string}|{scopeType:'draft';draftId:string;ownerPersonId:string;revision:number;conversationId:string;turnId:string;projectionRef:string});
export interface PreparedModelPayload {readonly endpoint:string;readonly body:string;readonly payloadHash:string;readonly actualProvider:string;readonly model:string}
export interface ModelEgressPermit {readonly payloadHash:string;readonly endpoint:string;readonly policyVersion:string;readonly receiptId:string}
export interface ModelAuthorization {
  authorize(identity:IdentityContext,request:ModelRequest):Promise<ModelGrant|null>;
  authorizeEgress(grant:ModelGrant,profile:ModelProfile):Promise<boolean>;
  authorizePayload?(identity:IdentityContext,request:ModelRequest,grant:ModelGrant,profile:ModelProfile,payload:PreparedModelPayload):Promise<ModelEgressPermit|null>;
}
const AdapterOutputSchema=z.object({actualModel:z.string().min(1),actualProvider:z.string().min(1),providerRequestId:z.string().min(1),finishReason:z.enum(['stop','length','refusal']),usage:ModelUsageSchema.nullable(),text:z.string().optional(),structured:z.unknown().optional(),toolSuggestions:z.array(ModelToolSuggestionSchema).optional()}).strict();
export type AdapterOutput=z.infer<typeof AdapterOutputSchema>;
/** Only complete application chunks cross this port; raw provider deltas stay in adapters. */
export type AdapterStreamItem =
  | {type:'chunk';value:unknown;actualModel:string;actualProvider:string;providerRequestId:string}
  | {type:'completed';output:AdapterOutput};
export class ModelExecutionError extends Error {constructor(readonly code:z.infer<typeof ModelErrorCodeSchema>,readonly retryable=false,readonly diagnostic?:z.infer<typeof ModelDiagnosticSchema>){super(code);}}
export interface ModelAdapter {
  readonly version:string;readonly simulated:boolean;
  generate(request:ModelRequest,profile:ModelProfile,signal:AbortSignal):Promise<AdapterOutput>;
  prepare?(request:ModelRequest,profile:ModelProfile,signal:AbortSignal):Promise<PreparedModelPayload>;
  dispatch?(payload:PreparedModelPayload,permit:ModelEgressPermit,signal:AbortSignal):Promise<AdapterOutput>;
  dispatchStream?(payload:PreparedModelPayload,permit:ModelEgressPermit,signal:AbortSignal):AsyncIterable<AdapterStreamItem>;
}
export class ModelGateway {
  private readonly profiles:Map<string,ModelProfile>;
  constructor(private readonly options:{profiles:ModelProfile[];adapters:ReadonlyMap<string,ModelAdapter>;authorization:ModelAuthorization;outputSchemas?:ReadonlyMap<string,z.ZodType>;streamSchemas?:ReadonlyMap<string,z.ZodType>}){
    this.profiles=new Map(options.profiles.map(p=>{const profile=ModelProfileSchema.parse(structuredClone(p));return[profile.id,profile];}));
    if(this.profiles.size!==options.profiles.length)throw new Error('Duplicate model profile');
  }
  async generate(input:unknown,identity:IdentityContext,signal?:AbortSignal):Promise<ModelResult>{
    return this.execute(input,identity,signal);
  }
  async stream(input:unknown,identity:IdentityContext,onChunk:(chunk:unknown)=>Promise<void>,signal?:AbortSignal):Promise<ModelResult>{
    return this.execute(input,identity,signal,onChunk);
  }
  private async execute(input:unknown,identity:IdentityContext,signal?:AbortSignal,onChunk?:(chunk:unknown)=>Promise<void>):Promise<ModelResult>{
    const r=ModelRequestSchema.parse(input),p=this.profiles.get(r.modelProfileId),adapter=p&&this.options.adapters.get(p.adapterId);
    const base={...modelScope(r),requestId:r.requestId,attemptId:r.attemptId,taskId:r.taskId,taskType:r.taskType,profileId:r.modelProfileId,profileVersion:r.profileVersion,requestedModel:p?.model??'unresolved',requestedProvider:p?.provider??'unresolved',locality:p?.locality??'cloud',adapterVersion:adapter?.version??'unavailable',simulated:adapter?.simulated??true};
    const fail=(code:Extract<ModelResult,{status:'failed'}>['error']['code'],retryable=false,diagnostic?:z.infer<typeof ModelDiagnosticSchema>):ModelResult=>ModelResultSchema.parse({...base,status:'failed',error:{code,retryable,...(diagnostic?{diagnostic}:{})}});
    if(!p)return fail('profile_unavailable');if(p.version!==r.profileVersion)return fail('profile_version_mismatch');
    if(r.taskType==='cloud_review'&&p.locality!=='cloud')return fail('cloud_profile_required');
    if(!p.allowedTasks.includes(r.taskType)||r.requiredCapabilities.some(c=>!p.capabilities.includes(c)))return fail('capability_unsupported');
    if(!adapter)return fail('adapter_unavailable');const schema=r.outputSchemaRef?this.options.outputSchemas?.get(r.outputSchemaRef):undefined;
    if(r.outputSchemaRef&&!schema)return fail('capability_unsupported');
    const authorize=async():Promise<ModelGrant|null>=>{
      const g=await this.options.authorization.authorize(identity,r);if(!g)return null;
      if(g.taskId!==r.taskId||g.messageBundleRef!==r.messageBundleRef||g.profileId!==p.id||g.profileVersion!==p.version||g.revision!==r.revision)return null;
      if(r.scopeType==='draft'){if(g.scopeType!=='draft'||g.draftId!==r.draftId||g.ownerPersonId!==r.ownerPersonId||g.conversationId!==r.conversationId||g.turnId!==r.turnId||g.projectionRef!==r.projectionRef)return null;}
      else if(g.scopeType==='draft'||g.caseId!==r.caseId||g.evidencePackageRef!==r.evidencePackageRef)return null;
      return g;
    };
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)controller.abort();let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      controller.signal.throwIfAborted();const grant=await authorize();if(!grant)return fail('authorization_denied');
      if(p.locality==='cloud'&&((grant.evidenceClass!=='redacted'&&!(grant.evidenceClass==='approved_original'&&p.provider==='bailian'&&['local-qwen','local_intake'].includes(p.id)))||!await this.options.authorization.authorizeEgress(grant,p)))return fail('egress_denied');
      // Real cloud transports cannot use the legacy boolean-only authorization path.
      if(p.locality==='cloud'&&!adapter.simulated&&(!adapter.prepare||(!adapter.dispatch&&!adapter.dispatchStream)||!this.options.authorization.authorizePayload))return fail('egress_denied');
      const execute=async()=>{
        if(adapter.prepare){
          if((!adapter.dispatch&&!adapter.dispatchStream)||!this.options.authorization.authorizePayload)throw new ModelExecutionError('egress_denied');
          const payload=Object.freeze({...await adapter.prepare(r,p,controller.signal)});
          if(createHash('sha256').update(payload.body).digest('hex')!==payload.payloadHash||payload.model!==p.model||!p.allowedActualProviders.includes(payload.actualProvider))throw new ModelExecutionError('egress_denied');
          const current=await authorize();if(!current)throw new ModelExecutionError('egress_denied');
          const permit=await this.options.authorization.authorizePayload(identity,r,current,p,payload);
          if(!permit||permit.payloadHash!==payload.payloadHash||permit.endpoint!==payload.endpoint)throw new ModelExecutionError('egress_denied');
          controller.signal.throwIfAborted();
          if(onChunk&&adapter.dispatchStream){
            const chunkSchema=r.outputSchemaRef?this.options.streamSchemas?.get(r.outputSchemaRef):undefined;
            if(!chunkSchema)throw new ModelExecutionError('capability_unsupported');
            let completed:AdapterOutput|undefined,streamModel:string|undefined,streamRequestId:string|undefined;
            for await(const item of adapter.dispatchStream(payload,permit,controller.signal)){
              controller.signal.throwIfAborted();
              if(completed)throw new ModelExecutionError('invalid_output');
              if(item.type==='completed'){
                completed=item.output;
                if(streamModel&&completed.actualModel!==streamModel||streamRequestId&&completed.providerRequestId!==streamRequestId)throw new ModelExecutionError('provider_drift');
                continue;
              }
              if(!(p.allowedActualModels??[p.model]).includes(item.actualModel)||!p.allowedActualProviders.includes(item.actualProvider)||!item.providerRequestId||streamModel&&streamModel!==item.actualModel||streamRequestId&&streamRequestId!==item.providerRequestId)throw new ModelExecutionError('provider_drift');
              const chunk=chunkSchema.safeParse(item.value);if(!chunk.success)throw new ModelExecutionError('invalid_output');
              if(!await authorize())throw new ModelExecutionError('authorization_denied');
              controller.signal.throwIfAborted();streamModel=item.actualModel;streamRequestId=item.providerRequestId;
              await onChunk(chunk.data);
            }
            if(!completed)throw new ModelExecutionError('execution_unknown');return completed;
          }
          if(!adapter.dispatch)throw new ModelExecutionError('capability_unsupported');
          return adapter.dispatch(payload,permit,controller.signal);
        }
        return adapter.generate(structuredClone(r),structuredClone(p),controller.signal);
      };
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('gateway_timeout'));},r.timeoutMs);});
      const output=AdapterOutputSchema.safeParse(await Promise.race([execute(),timeout]));if(!output.success)return fail('invalid_output');const data=output.data;
      if(!(p.allowedActualModels??[p.model]).includes(data.actualModel)||!p.allowedActualProviders.includes(data.actualProvider))return fail('provider_drift');
      if(data.finishReason==='length')return fail('truncated');if(data.finishReason==='refusal')return fail('refused');
      if(data.toolSuggestions?.length&&!r.requiredCapabilities.includes('tool_suggestions'))return fail('invalid_output');
      if(data.text===undefined&&data.structured===undefined&&!data.toolSuggestions?.length)return fail('invalid_output');
      if(schema&&!schema.safeParse(data.structured).success)return fail('invalid_output');
      if(signal?.aborted)return fail('canceled');if(!await authorize())return fail('authorization_denied');
      return ModelResultSchema.parse({...base,...data,status:'completed'});
    }catch(error){
      if(error instanceof ModelExecutionError)return fail(error.code,error.retryable,error.diagnostic);
      // A real remote timeout may already have incurred usage; it is not safe to resend.
      if(p.locality==='cloud'&&!adapter.simulated&&controller.signal.aborted)return fail('execution_unknown');
      return fail(signal?.aborted?'canceled':controller.signal.aborted?'timeout':'adapter_failed',!signal?.aborted);
    }finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
}
