import { IntakeAssistantOutputSchema, IntakeReplyBlockSchema, type IntakeAssistantOutput, type IntakeReplyBlock } from '@hsbc/contracts/intake';
import type { ModelProfile, DraftModelRequest } from '@hsbc/contracts/model';
import { AppError } from '../../shared/errors.js';
import { ModelGateway, ModelExecutionError, type PreparedModelPayload, type ModelEgressPermit } from '../../model/gateway.js';
import { NerClient } from '../../infrastructure/integrations/inference.js';
import { PrivacyProjectionService, privacyCoverageNotice } from '../../modules/intake/privacy-projection.js';
import { AzureIntakeV2Adapter, intakeV2CloudBody } from '../../modules/intake/intake-v2-model.js';
import { intakeAssistantCapacity } from '../../modules/intake/config.js';
import type { IntakeAssistantPorts } from './ports.js';

export async function runIntakeAssistant(b:IntakeAssistantPorts) {
  const {turn,call,signal,config}=b;
  const emit=b.emit;
  const started=new Map<string,number>();
  const step=(key:string,title:string,status:string,summary?:string)=>{if(status==='running')started.set(key,Date.now());return emit('step',{step:{key,title,status,summary,...(status==='completed'&&started.has(key)?{durationMs:Date.now()-started.get(key)!}:{})}});};
  const capacity=intakeAssistantCapacity(config);
  const privacy=new PrivacyProjectionService({ner:new NerClient(config.ner!),publicVocabulary:[config.local!.model,config.cloud!.model,...config.cloud!.policy.actualModels],proposeEntities:b.proposeEntities,
    maxSourceBytes:capacity.maxSourceBytes,maxCalls:capacity.maxPrivacyCalls
  });
    if(call.profile_id==='local_intake'){
      await step('attachments','读取附件','running');
      const attachmentIds=turn.input_snapshot?.contextAttachmentIds??turn.attachment_ids??[];
      const parsed=await b.parseAttachments(attachmentIds);
      await step('attachments','读取附件','completed',parsed.coverageGaps.length?'附件中有部分内容无法读取，请核对原件；本轮仅使用已读取的内容。':`已读取 ${attachmentIds.length} 份附件`);
      const blocks=[...(turn.input_snapshot?.blocks??[]),...parsed.blocks.map(item=>({id:item.id,text:item.text}))];
      if(!blocks.length)throw new AppError(422,'attachment_text_empty');
      if(parsed.coverageGaps.length)blocks.push({id:'coverage:attachments',text:'本轮附件部分内容无法读取。请明确提醒用户核对原件；只能根据已经读取的来源整理，不可推断遗漏内容。'});
      await step('privacy','隐私处理','running');
      const previous=await b.previousProjection();
      const projection=await privacy.prepare({scopeId:turn.draft_id,blocks,previousReplacements:previous?.replacements,isolatableSourceIds:parsed.blocks.map(block=>block.id)},signal);
      await b.completePreparation(projection,()=>Date.now()-(started.get('privacy')??Date.now()));return;
    }
    const cloud=config.cloud!;
    const projection=await b.projection();
    if(!projection)throw new ModelExecutionError('egress_denied');
    const profile:ModelProfile={id:'cloud_assistant',version:call.profile_version,provider:'azure-openai',locality:'cloud',model:cloud.model,allowedActualModels:cloud.policy.actualModels,allowedActualProviders:['azure-openai'],capabilities:['json_schema'],allowedTasks:['draft_intake'],adapterId:'assistant-v2',fallback:'disabled'};
    const request:DraftModelRequest={scopeType:'draft',draftId:turn.draft_id,ownerPersonId:turn.owner_person_id,revision:turn.draft_revision,conversationId:turn.draft_id,turnId:turn.id,projectionRef:turn.id,requestId:call.id,attemptId:`${call.id}:${b.work.epoch}`,taskId:b.work.id,taskType:'draft_intake',modelProfileId:profile.id,profileVersion:profile.version,messageBundleRef:turn.id,outputSchemaRef:'draft_intake_v2',requiredCapabilities:['json_schema'],timeoutMs:cloud.timeoutMs,attempt:1,maxAttempts:1};
    const allowed=()=>b.available()&&call.policy_version===cloud.policy.version&&call.profile_version===b.version('cloud_assistant');
    const authorize=()=>b.authorize(profile,allowed);
    const beforeSend=(payload:PreparedModelPayload,permit:ModelEgressPermit,start:()=>Promise<Response>)=>b.dispatchCloud(payload,permit,start,allowed);
    const adapter=new AzureIntakeV2Adapter(cloud,projection,privacy,beforeSend,b.fetcher,b.recordCloudReceipt,b.recordOutputValidationFailure);
    const gateway=new ModelGateway({profiles:[profile],adapters:new Map([['assistant-v2',adapter]]),outputSchemas:new Map([['draft_intake_v2',IntakeAssistantOutputSchema]]),streamSchemas:new Map([['draft_intake_v2',IntakeReplyBlockSchema]]),authorization:{authorize,authorizeEgress:async()=>allowed(),authorizePayload:async(_i,_r,_g,_p,payload)=>{
      const result=await privacy.validateOutbound(payload,projection,cloud,intakeV2CloudBody(projection,cloud.maxOutputTokens,cloud.model),signal);
      return b.approvePayload(payload,result,allowed);
    }}});
    await step('filling','整理案件信息','running');
    const replyBlocks:IntakeReplyBlock[]=[];
    const coverageNotice=privacyCoverageNotice(projection);
    if(coverageNotice)await b.publishChunk(coverageNotice,replyBlocks);
    const result=await gateway.stream(request,{kind:'human',accountId:turn.account_id,personId:turn.owner_person_id,sessionId:turn.id},async chunk=>{
      const block=chunk as IntakeReplyBlock;
      if(replyBlocks.some(item=>item.id===block.id))return;
      await b.publishChunk(block,replyBlocks);
    },signal);
    if(result.status==='failed')throw new ModelExecutionError(result.error.code,result.error.retryable,result.error.diagnostic);
    const modelOutput=result.structured as IntakeAssistantOutput;
    const output=coverageNotice?IntakeAssistantOutputSchema.parse({...modelOutput,replyBlocks:[coverageNotice,...modelOutput.replyBlocks]}):modelOutput;
    await b.complete(result,output,()=>Date.now()-(started.get('filling')??Date.now()));

}
