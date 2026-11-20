import { z } from 'zod';
import { ResourceScopeSchema } from './identity.js';
const ref = z.string().min(1).max(200);
export const ModelProfileIdSchema = z.enum(['local-qwen','cloud-direct','openrouter','cloud_assistant','local_intake','document_cloud','formal_cloud']);
export const ModelTaskTypeSchema = z.enum(['extract_fields','resolve_candidates','cloud_review','review_assist','translate_clause','draft_intake','case_assist']);
export const ModelCapabilitySchema = z.enum(['text','json_schema','tool_suggestions']);
export const ModelProfileSchema = z.object({
  id:ModelProfileIdSchema,version:ref,provider:z.enum(['local-vllm','cloud-direct','openrouter','azure-openai','bailian']),locality:z.enum(['local','cloud']),model:ref,
  allowedActualProviders:z.array(ref).min(1),allowedActualModels:z.array(ref).min(1).optional(),capabilities:z.array(ModelCapabilitySchema).min(1),allowedTasks:z.array(ModelTaskTypeSchema).min(1),adapterId:ref,fallback:z.literal('disabled'),
}).strict().superRefine((p,ctx)=>{
  if((p.provider==='local-vllm')!==(p.locality==='local'))ctx.addIssue({code:'custom',message:'Locality must reflect the execution environment'});
  if(p.provider==='bailian'&&p.allowedTasks.includes('cloud_review'))ctx.addIssue({code:'custom',message:'Hosted replacement cannot fulfill formal review'});
  const routes:Record<string,string>={'local-qwen':'local-vllm','cloud-direct':'cloud-direct',openrouter:'openrouter',local_intake:'local-vllm',cloud_assistant:'azure-openai',document_cloud:'azure-openai',formal_cloud:'azure-openai'};
  if(p.provider!==routes[p.id]&&!(p.provider==='bailian'&&['local-qwen','local_intake'].includes(p.id)))ctx.addIssue({code:'custom',message:'Profile route is fixed by controlled configuration'});
  if(['cloud_assistant','local_intake'].includes(p.id)&&p.allowedTasks.some(t=>!['draft_intake','case_assist'].includes(t)))ctx.addIssue({code:'custom',message:'Assistant profiles cannot satisfy review tasks'});
  if(p.id==='formal_cloud'&&p.allowedTasks.some(t=>t!=='cloud_review'))ctx.addIssue({code:'custom',message:'Formal review profile is purpose-bound'});
  if(p.id==='document_cloud'&&p.allowedTasks.some(t=>t!=='extract_fields'))ctx.addIssue({code:'custom',message:'Document extraction cannot satisfy formal review or chat'});
});
export type ModelProfile=z.infer<typeof ModelProfileSchema>;
const callFields={requestId:ref,attemptId:ref,taskId:ref,taskType:ModelTaskTypeSchema,modelProfileId:ModelProfileIdSchema,profileVersion:ref,messageBundleRef:ref,outputSchemaRef:ref.optional(),toolDefinitionsRef:ref.optional(),requiredCapabilities:z.array(ModelCapabilitySchema).min(1),timeoutMs:z.number().int().positive().max(240_000),attempt:z.number().int().positive(),maxAttempts:z.number().int().positive()};
// The case default preserves P0's internal fixtures. Drafts never accept case fields.
export const CaseModelRequestSchema=ResourceScopeSchema.extend({scopeType:z.literal('case').default('case'),evidencePackageRef:ref,...callFields}).strict().superRefine((r,ctx)=>{
  if(r.timeoutMs>120_000&&!(r.taskType==='extract_fields'&&r.modelProfileId==='document_cloud'&&['document-extraction.v2','document-extraction.docx.v1'].includes(r.outputSchemaRef??'')))ctx.addIssue({code:'custom',message:'Extended timeout is limited to document extraction v2 and native Word extraction'});
});
export const DraftModelRequestSchema=z.object({scopeType:z.literal('draft'),draftId:z.uuid(),ownerPersonId:z.uuid(),revision:z.number().int().positive(),conversationId:z.uuid(),turnId:z.uuid(),projectionRef:ref,...callFields,timeoutMs:z.number().int().positive().max(120_000)}).strict();
export const ModelRequestSchema=z.union([DraftModelRequestSchema,CaseModelRequestSchema]).superRefine((r,ctx)=>{
  if(r.attempt>r.maxAttempts)ctx.addIssue({code:'custom',message:'Attempt budget exhausted'});
  if(r.requiredCapabilities.includes('json_schema')&&!r.outputSchemaRef)ctx.addIssue({code:'custom',message:'Structured output requires a schema reference'});
  if(r.requiredCapabilities.includes('tool_suggestions')&&!r.toolDefinitionsRef)ctx.addIssue({code:'custom',message:'Tool suggestions require a controlled definition'});
  if(r.scopeType==='draft'&&r.taskType!=='draft_intake')ctx.addIssue({code:'custom',message:'Draft scope only permits intake'});
  if(['draft_intake','case_assist'].includes(r.taskType)&&(!r.outputSchemaRef||r.toolDefinitionsRef||r.requiredCapabilities.includes('tool_suggestions')))ctx.addIssue({code:'custom',message:'Chat requires a versioned schema and forbids tools'});
  if(r.scopeType==='case'&&r.taskType==='draft_intake')ctx.addIssue({code:'custom',message:'Intake requires draft scope'});
});
export type CaseModelRequest=z.input<typeof CaseModelRequestSchema>;
export type DraftModelRequest=z.infer<typeof DraftModelRequestSchema>;
export type ModelRequest=CaseModelRequest|DraftModelRequest;
export const ModelToolSuggestionSchema=z.object({suggestionId:ref,name:ref,arguments:z.record(z.string(),z.unknown())}).strict();
export const ModelUsageSchema=z.object({inputTokens:z.number().int().nonnegative(),outputTokens:z.number().int().nonnegative(),totalTokens:z.number().int().nonnegative()}).strict().refine(u=>u.totalTokens===u.inputTokens+u.outputTokens,'Token usage must reconcile');
export const ModelErrorCodeSchema=z.enum(['profile_unavailable','profile_version_mismatch','authorization_denied','egress_denied','cloud_profile_required','capability_unsupported','adapter_unavailable','provider_drift','invalid_output','truncated','refused','timeout','adapter_failed','canceled','execution_unknown','budget_exhausted','input_budget_exhausted','call_budget_exhausted','daily_budget_exhausted','request_budget_exhausted','rate_limited','fresh_parse_required','provider_rejected']);
const resultFields={requestId:ref,attemptId:ref,taskId:ref,taskType:ModelTaskTypeSchema,profileId:ModelProfileIdSchema,profileVersion:ref,requestedModel:ref,requestedProvider:ref,locality:z.enum(['local','cloud']),adapterVersion:ref,simulated:z.boolean()};
const caseResult=ResourceScopeSchema.extend({scopeType:z.literal('case').default('case'),evidencePackageRef:ref,...resultFields});
const draftResult=z.object({scopeType:z.literal('draft'),draftId:z.uuid(),ownerPersonId:z.uuid(),revision:z.number().int().positive(),conversationId:z.uuid(),turnId:z.uuid(),projectionRef:ref,...resultFields});
const success={status:z.literal('completed'),actualModel:ref,actualProvider:ref,providerRequestId:ref,finishReason:z.literal('stop'),usage:ModelUsageSchema.nullable(),text:z.string().optional(),structured:z.unknown().optional(),toolSuggestions:z.array(ModelToolSuggestionSchema).optional()};
export const ModelDiagnosticSchema=z.enum(['document_dictionary_references','privacy_mask_mapping','privacy_policy_unavailable','privacy_canonical_mismatch','privacy_sensitive_pattern','privacy_ner_unavailable','privacy_source_entity','privacy_final_entity','privacy_encoded_input','local_output_not_json','local_output_empty','local_output_leading_think','local_output_markdown_fence','local_output_schema','local_output_source','local_output_source_ambiguous','intake_reply_schema','intake_output_schema','intake_output_refs','intake_output_placeholder_source','intake_output_scenario_source','intake_output_reference_source','intake_output_number_source','intake_output_restored_schema','azure_stream_protocol','azure_stream_limit','azure_stream_text_mismatch','azure_stream_reply_mismatch','azure_output_not_json','azure_output_schema','qwen_busy','qwen_timeout','qwen_truncated','qwen_refused','qwen_model_drift','qwen_unsupported_output','qwen_invalid_response','qwen_transport_error','qwen_authorization_failed','qwen_request_rejected','qwen_unavailable','qwen_canceled','azure_deployment_not_found','azure_invalid_json_schema','azure_unsupported_parameter','azure_authentication_failed','azure_rate_limited','azure_http_400','azure_http_403','azure_http_404','azure_http_409','azure_http_413','azure_http_422','azure_request_rejected',
  // Why a dispatched call has no known result. The call stays unknown and is never sent again; these only say what was seen.
  'azure_transport_error','azure_transport_not_connected','azure_transport_reset','azure_http_5xx','azure_http_unexpected','azure_response_unreadable']);
const failed={status:z.literal('failed'),error:z.object({code:ModelErrorCodeSchema,retryable:z.boolean(),diagnostic:ModelDiagnosticSchema.optional()}).strict()};
export const ModelResultSchema=z.union([caseResult.extend(success).strict(),caseResult.extend(failed).strict(),draftResult.extend(success).strict(),draftResult.extend(failed).strict()]);
export type ModelResult=z.infer<typeof ModelResultSchema>;
export function modelScope(r:ModelRequest){return r.scopeType==='draft'?{scopeType:'draft' as const,draftId:r.draftId,ownerPersonId:r.ownerPersonId,revision:r.revision,conversationId:r.conversationId,turnId:r.turnId,projectionRef:r.projectionRef}:{scopeType:'case' as const,caseId:r.caseId,revision:r.revision,evidencePackageRef:r.evidencePackageRef};}
/** Chat, local and simulated responses never fulfill formal cloud review. */
export function mandatoryCloudReviewState(result:ModelResult,expected:Pick<CaseModelRequest,'caseId'|'revision'|'taskId'|'modelProfileId'|'profileVersion'|'evidencePackageRef'>):'complete'|'incomplete'{
  const parsed=ModelResultSchema.safeParse(result);if(!parsed.success)return'incomplete';const r=parsed.data;
  return r.scopeType==='case'&&r.status==='completed'&&!r.simulated&&r.locality==='cloud'&&r.taskType==='cloud_review'&&r.caseId===expected.caseId&&r.revision===expected.revision&&r.taskId===expected.taskId&&r.profileId===expected.modelProfileId&&r.profileVersion===expected.profileVersion&&r.evidencePackageRef===expected.evidencePackageRef?'complete':'incomplete';
}
