import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ModelUsageSchema, type ModelRequest, type ModelProfile } from '@hsbc/contracts/model';
import { ModelExecutionError, type ModelAdapter, type AdapterOutput, type PreparedModelPayload, type ModelEgressPermit } from '../../model/gateway.js';
import { cloudAuthorizationHeader } from '../../model/cloud-endpoint.js';
import type { PrivateIntakeProjection } from '../intake/privacy-projection.js';
import { intakeCloudReferences } from '../intake/intake-source-references.js';
import { privacyIdentifierMarkers } from '../intake/privacy-identifier-markers.js';
import { DOCUMENT_CLOUD_INSTRUCTIONS, DOCUMENT_CLOUD_SCHEMA, DOCUMENT_CLOUD_VERSION, DocumentCloudOutputSchema } from './cloud-extraction-contract.js';
import type { DocumentCloudConfig } from './cloud-extraction-config.js';
import type { DocumentCallHooks } from './cloud-extraction-ledger.js';
import {documentResponseMetadata} from './cloud-response-metadata.js';

const digest=(body:string)=>createHash('sha256').update(body).digest('hex');
const schema=z.toJSONSchema(DocumentCloudOutputSchema,{target:'draft-7'});
export interface DocumentCloudProtocol {version:string;schema:'document-extraction.v1'|'document-extraction.v2'|'document-extraction.docx.v1';instructions:string;outputSchema:z.ZodType;requiredFieldRefs?:string[];completionTargetRefs?:string[];savedMaterial?:{typeRef:string;label:string}}
export const DOCUMENT_CLOUD_V1_PROTOCOL:DocumentCloudProtocol={version:DOCUMENT_CLOUD_VERSION,schema:DOCUMENT_CLOUD_SCHEMA,instructions:DOCUMENT_CLOUD_INSTRUCTIONS,outputSchema:DocumentCloudOutputSchema};
function boundedFieldSchema(protocol:DocumentCloudProtocol,refs:string[]|undefined,pageRefs?:string[],nativeRefs?:string[]) {
  const result=protocol===DOCUMENT_CLOUD_V1_PROTOCOL?schema:z.toJSONSchema(protocol.outputSchema,{target:'draft-7'});
  const object=(value:unknown):Record<string,unknown>=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw new ModelExecutionError('invalid_output');
    return value as Record<string,unknown>;
  };
  // Require nullable confidence in new strict requests, while old receipts stay readable.
  if(protocol.schema!=='document-extraction.v1'){
    const fields=object(object(result.properties).fields),items=object(fields.items);
    const values=object(object(items.properties).values),candidate=object(values.items);
    if(object(candidate.properties).confidence){
      const required=Array.isArray(candidate.required)?candidate.required:[];
      candidate.required=[...new Set([...required,'confidence'])];
    }
  }
  if(pageRefs){
    const fields=object(object(result.properties).fields),items=object(fields.items);
    const coverage=object(object(items.properties).coverage),reviewed=object(object(coverage.properties).reviewedSourceRefs);
    object(reviewed.items).enum=[...pageRefs];
  }
  if(nativeRefs){
    const fields=object(object(result.properties).fields),items=object(fields.items),properties=object(items.properties);
    const coverage=object(properties.coverage),reviewed=object(object(coverage.properties).sourceRefs);
    object(reviewed.items).enum=[...nativeRefs];
    const candidate=object(object(properties.values).items);
    for(const key of ['value','context'])object(object(object(object(candidate.properties)[key]).properties).sourceRef).enum=[...nativeRefs];
  }
  if(!refs)return result;
  const fields=object(object(result.properties).fields),items=object(fields.items),reference=object(object(items.properties).fieldRef);
  if(fields.type!=='array'||items.type!=='object'||reference.type!=='string')throw new ModelExecutionError('invalid_output');
  fields.minItems=refs.length;fields.maxItems=refs.length;reference.enum=[...refs];
  return result;
}
export function documentCloudBody(projection:PrivateIntakeProjection,config:DocumentCloudConfig['cloud'],protocol:DocumentCloudProtocol=DOCUMENT_CLOUD_V1_PROTOCOL) {
  const targets=protocol.completionTargetRefs;
  if(protocol.savedMaterial&&!/^type_[1-9]\d*$/u.test(protocol.savedMaterial.typeRef))throw new ModelExecutionError('invalid_output');
  for(const refs of [targets,protocol.requiredFieldRefs])if(refs&&(!['document-extraction.v2','document-extraction.docx.v1'].includes(protocol.schema)||!refs.length||refs.length>500||new Set(refs).size!==refs.length||refs.some(ref=>!/^field_[1-9]\d*$/u.test(ref))))throw new ModelExecutionError('invalid_output');
  if(targets&&protocol.requiredFieldRefs&&targets.some(ref=>!protocol.requiredFieldRefs!.includes(ref)))throw new ModelExecutionError('invalid_output');
  const required=targets??protocol.requiredFieldRefs;
  const wire=intakeCloudReferences(projection.blocks);
  // Bind coverage to original pages, not the dictionary that shares the wire
  // transport. Derive ordinals from this projection, including narrowed passes.
  const originalPageRefs=protocol.schema==='document-extraction.v2'?wire.blocks.filter((_,index)=>/^page-[1-9]\d*$/u.test(projection.blocks[index]!.id)).map(block=>block.id):[];
  const pageRefs=originalPageRefs.length||(protocol.schema==='document-extraction.v2'&&projection.blocks.some(block=>block.id==='dictionary'))?originalPageRefs:undefined;
  if(pageRefs&&!pageRefs.length)throw new ModelExecutionError('invalid_output');
  const dictionaryRef=wire.blocks.find((_,index)=>projection.blocks[index]!.id==='dictionary')?.id;
  const nativeRefs=protocol.schema==='document-extraction.docx.v1'?wire.blocks.filter((_,index)=>projection.blocks[index]!.id!=='dictionary').map(block=>block.id):undefined;
  if(nativeRefs&&!nativeRefs.length)throw new ModelExecutionError('invalid_output');
  const coverageInstructions=pageRefs?`\nOnly these original page references may appear in reviewedSourceRefs: ${JSON.stringify(pageRefs)}. ${dictionaryRef?`${dictionaryRef} is configuration metadata, not evidence; never include it in reviewedSourceRefs or cite it as a material or field value. `:''}Report only pages actually examined; metadata cannot satisfy page coverage.`:'';
  const nativeInstructions=nativeRefs?`\nOnly these original Word source references may appear in coverage.sourceRefs, value.sourceRef or context.sourceRef: ${JSON.stringify(nativeRefs)}. ${dictionaryRef?`${dictionaryRef} is configuration metadata, never original evidence or reviewed source coverage. `:''}State found requires at least one value. State uncertain may have values or none. States not_found, not_applicable, blank, redacted and unreadable require an empty values array. Privacy placeholders replacing visible source text are not source redaction: a supported placeholder value may be found or uncertain. State redacted means the original document visibly redacts the content.`:'';
  const instructions=protocol.instructions+coverageInstructions+nativeInstructions+(protocol.savedMaterial?'\nSaved material typeRef: '+protocol.savedMaterial.typeRef+'. Use this fixed type for every supplied source unit.':'')+(targets?`\nThis is the single coverage-completion pass. Independently reread the original pages for ONLY these fieldRefs: ${JSON.stringify(targets)}. Return exactly those fields, including every supported row/alternative, ${protocol.savedMaterial?'without any material classification output':'and the complete unchanged material classification'}. No earlier answer is supplied: do not assume it was complete. Pay particular attention to an explicit role declared after a name, labelled codes, printed table cells, and every OR/AND branch. Do not guess missing facts.`:
    required?`\nReturn exactly one field result for each of these fieldRefs: ${JSON.stringify(required)}. An unsupported value still requires a field result with an explicit not_found or uncertain state and truthful coverage; do not omit fields or invent values to fill the schema.`:'');
  const identifierMarkers=protocol.schema!=='document-extraction.v1'?privacyIdentifierMarkers(projection):undefined;
  return JSON.stringify({model:config.model,store:false,stream:false,instructions,
    ...(['document-extraction.v2','document-extraction.docx.v1'].includes(protocol.schema)&&config.reasoningEffort?{reasoning:{effort:config.reasoningEffort}}:{}),
    input:[{role:'user',content:[{type:'input_text',text:JSON.stringify({schema:protocol.schema,blocks:wire.blocks,...(identifierMarkers?{identifierMarkers}:{})})}]}],
    max_output_tokens:config.maxOutputTokens,text:{format:{type:'json_schema',name:protocol.schema==='document-extraction.docx.v1'?'document_extraction_docx_v1':protocol.schema==='document-extraction.v1'?'document_extraction_v1':'document_extraction_v2',strict:true,
      schema:boundedFieldSchema(protocol,required,pageRefs,nativeRefs)}}});
}
/** What a failed request looked like at the socket: never connected, cut on an open connection, or anything else. Only
 * the platform's own error code is read; the result of the call stays unknown either way. */
function transportDiagnostic(error:unknown){
  const code=String((error as {cause?:{code?:unknown}}|null)?.cause?.code??'');
  return ['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(code)?'azure_transport_not_connected' as const:
    ['ECONNRESET','EPIPE','UND_ERR_SOCKET'].includes(code)?'azure_transport_reset' as const:'azure_transport_error' as const;
}
export class AzureDocumentExtractionAdapter implements ModelAdapter {
  readonly version:string;readonly simulated=false;
  constructor(private readonly config:DocumentCloudConfig['cloud'],private readonly projection:PrivateIntakeProjection,
    private readonly scope:{caseId:string;revision:number;taskId:string;evidencePackageRef:string},private readonly hooks:DocumentCallHooks,
    private readonly fetcher:typeof fetch=fetch,private readonly protocol:DocumentCloudProtocol=DOCUMENT_CLOUD_V1_PROTOCOL){this.version=protocol.version;}
  async generate():Promise<AdapterOutput>{throw new ModelExecutionError('egress_denied');}
  async prepare(request:ModelRequest,profile:ModelProfile,signal:AbortSignal):Promise<PreparedModelPayload>{
    signal.throwIfAborted();
    if(request.scopeType!=='case'||request.taskType!=='extract_fields'||request.modelProfileId!=='document_cloud'||profile.model!==this.config.model||
      request.outputSchemaRef!==this.protocol.schema||request.toolDefinitionsRef||request.caseId!==this.scope.caseId||request.revision!==this.scope.revision||
      request.taskId!==this.scope.taskId||request.evidencePackageRef!==this.scope.evidencePackageRef)throw new ModelExecutionError('egress_denied');
    const body=documentCloudBody(this.projection,this.config,this.protocol);
    if(Buffer.byteLength(body)>this.config.maxInputTokens)throw new ModelExecutionError('input_budget_exhausted');
    return Object.freeze({endpoint:this.config.endpoint,body,payloadHash:digest(body),actualProvider:'azure-openai',model:this.config.model});
  }
  async dispatch(payload:PreparedModelPayload,permit:ModelEgressPermit,signal:AbortSignal):Promise<AdapterOutput>{
    const expected=documentCloudBody(this.projection,this.config,this.protocol);
    if(payload.endpoint!==this.config.endpoint||payload.body!==expected||payload.payloadHash!==digest(expected)||permit.payloadHash!==payload.payloadHash||
      permit.endpoint!==payload.endpoint||permit.policyVersion!==this.config.policy.version||Date.parse(this.config.policy.expiresAt)<=Date.now())throw new ModelExecutionError('egress_denied');
    signal.throwIfAborted();
    const response=await this.hooks.dispatch(async()=>{
      signal.throwIfAborted();
      try{return await this.fetcher(payload.endpoint,{method:'POST',redirect:'error',signal,headers:{...cloudAuthorizationHeader(payload.endpoint,this.config.token),'Content-Type':'application/json'},body:payload.body});}
      catch(error){throw new ModelExecutionError('execution_unknown',false,signal.aborted?undefined:transportDiagnostic(error));}
    });
    if(!response.ok){
      await response.body?.cancel();
      // A timeout, conflict or intermediary failure may hide an executed call.
      // Only explicit validation/auth/rate rejections have a durable known result.
      if([400,401,403,404,405,413,415,422,429].includes(response.status)){
        await this.hooks.providerRejected(response.status===429);throw new ModelExecutionError(response.status===429?'rate_limited':'provider_rejected',false,response.status===429?'azure_rate_limited':undefined);
      }
      throw new ModelExecutionError('execution_unknown',false,response.status>=500?'azure_http_5xx':'azure_http_unexpected');
    }
    let decoded:unknown;
    try{
      if(!response.body||Number(response.headers.get('content-length'))>512000)throw new Error();
      const chunks:Uint8Array[]=[];let count=0;
      for await(const chunk of response.body){count+=chunk.byteLength;if(count>512000)throw new Error();chunks.push(chunk);}
      decoded=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch{throw new ModelExecutionError('execution_unknown',false,signal.aborted?undefined:'azure_response_unreadable');}
    const envelope=z.object({id:z.string().min(1),model:z.string().min(1),status:z.string(),
      usage:z.object({input_tokens:z.number(),output_tokens:z.number(),total_tokens:z.number()}),output:z.array(z.unknown()).optional()}).safeParse(decoded);
    if(!envelope.success)throw new ModelExecutionError('execution_unknown',false,'azure_response_unreadable');
    const data=envelope.data,usage=ModelUsageSchema.parse({inputTokens:data.usage.input_tokens,outputTokens:data.usage.output_tokens,totalTokens:data.usage.total_tokens});
    await this.hooks.receipt(usage,documentResponseMetadata(decoded),data.model);
    const common={actualModel:data.model,actualProvider:'azure-openai',providerRequestId:data.id,usage};
    if(data.status==='incomplete')return{...common,finishReason:'length'};
    if(data.status!=='completed')throw new ModelExecutionError('execution_unknown');
    const outputs=z.array(z.object({type:z.enum(['message','reasoning']),content:z.array(z.object({type:z.string(),text:z.string().optional()})).optional()})).safeParse(data.output);
    if(!outputs.success)throw new ModelExecutionError('invalid_output');
    const content=outputs.data.filter(item=>item.type==='message').flatMap(item=>item.content??[]);
    if(content.some(part=>part.type==='refusal'))return{...common,finishReason:'refusal'};
    if(content.length!==1||content[0]!.type!=='output_text'||!content[0]!.text)throw new ModelExecutionError('invalid_output');
    let structured:unknown;try{structured=this.protocol.outputSchema.parse(JSON.parse(content[0]!.text));}catch{throw new ModelExecutionError('invalid_output');}
    return{...common,finishReason:'stop',structured};
  }
}
