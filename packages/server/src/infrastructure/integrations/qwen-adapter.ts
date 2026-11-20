import type { ModelProfile,ModelRequest } from '@hsbc/contracts/model';
import type { AdapterOutput,ModelAdapter } from '../../model/gateway.js';
import { QwenClient } from './inference.js';
import { ServiceError } from './http.js';

export interface BoundMessageBundle {
  caseId?:string;revision:number;messageBundleRef:string;evidencePackageRef?:string;
  scopeType?:'case'|'draft';draftId?:string;ownerPersonId?:string;projectionRef?:string;turnId?:string;
  messages:{role:'system'|'user'|'assistant';content:string}[];
}
/** Resolves server-owned message references only, behind the existing authorized gateway. */
export class QwenModelAdapter implements ModelAdapter {
  readonly version='p1-qwen-text/1';readonly simulated=false;
  constructor(private client:QwenClient,private resolve:(request:ModelRequest)=>Promise<BoundMessageBundle>){ }
  async generate(request:ModelRequest,profile:ModelProfile,signal:AbortSignal):Promise<AdapterOutput>{
    if(profile.id!=='local-qwen'||profile.locality!=='local'||profile.provider!=='local-vllm'||profile.model!==this.client.model||
      request.requiredCapabilities.some(capability=>capability!=='text')||request.outputSchemaRef||request.toolDefinitionsRef||request.taskType==='cloud_review')throw new ServiceError('qwen_capability_unsupported');
    signal.throwIfAborted();const bundle=await this.resolve(request);signal.throwIfAborted();
    if(bundle.revision!==request.revision||bundle.messageBundleRef!==request.messageBundleRef||(request.scopeType==='draft'?(bundle.scopeType!=='draft'||bundle.draftId!==request.draftId||bundle.ownerPersonId!==request.ownerPersonId||bundle.turnId!==request.turnId||bundle.projectionRef!==request.projectionRef):(bundle.caseId!==request.caseId||bundle.evidencePackageRef!==request.evidencePackageRef)))throw new ServiceError('qwen_message_scope_mismatch');
    const result=await this.client.chat(bundle.messages,signal);
    return{actualModel:result.model,actualProvider:'self-hosted-vllm',providerRequestId:result.requestId,finishReason:'stop',text:result.text,
      usage:{inputTokens:result.usage.prompt_tokens,outputTokens:result.usage.completion_tokens,totalTokens:result.usage.total_tokens}};
  }
}
/** Text is the only capability accepted by P1's real synthetic integration probe. */
export function createQwenModelProfile(model:string):ModelProfile{return{id:'local-qwen',version:'p1-qwen-text-1',provider:'local-vllm',locality:'local',model,
  allowedActualProviders:['self-hosted-vllm'],capabilities:['text'],allowedTasks:['extract_fields','resolve_candidates'],adapterId:'p1-qwen',fallback:'disabled'};}
