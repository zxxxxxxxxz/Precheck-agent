import { qwenProvider } from '../../infrastructure/integrations/qwen-hosting.js';
import {editableDraftValues, draftValue, setDraftValue} from '../cases/draft-values.js';
import { runIntakeAssistant } from '../../agents/intake-assistant/runner.js';
import type { IntakeAssistantPorts } from '../../agents/intake-assistant/ports.js';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {IntakeField} from '@hsbc/contracts/draft';
import {CaseDraftFieldsSchema} from '@hsbc/contracts/draft';
import type {IntakeSourceBlock, IntakeAssistantOutput, IntakeReplyBlock} from '@hsbc/contracts/intake';
import type {ModelResult} from '@hsbc/contracts/model';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/events.js';
import { inputHash } from '../../infrastructure/database/idempotency.js';
import { transaction, type DB } from '../../infrastructure/database/client.js';
import { type Actor } from '../identity/types.js';
import {ModelExecutionError, type PreparedModelPayload, type ModelEgressPermit} from '../../model/gateway.js';
import {splitPrivacyCorrectionBlocks,type PrivateIntakeProjection,type PrivacyEntity} from './privacy-projection.js';
import {proposeIntakeEntities} from './intake-v2-model.js';
import {PrivacyOutputValidationSchema} from './privacy-output-diagnostics.js';
import { draftView, type DraftRow } from '../cases/draft-state.js';
import {validateDraftAttachmentIds, type DraftAttachmentService} from '../materials/draft-attachments/service.js';
import {intakeAssistantCapacity,type IntakeConfig} from './config.js';
import type {ModelWork, TurnRow} from './service.js';

export function assistantCapability(config:IntakeConfig) {
  const available=config.cloudMode==='public_synthetic'&&!!config.cloud&&!!config.local&&!!config.ner&&config.cloud.policy.dataClass==='public_synthetic'&&Date.parse(config.cloud.policy.expiresAt)>Date.now();
  return {available,reason:available?undefined:'assistant_configuration_required',localModel:config.local?.model,cloudModel:config.cloud?.model};
}
export async function assistantEvent(db:DB,turn:Pick<TurnRow,'id'>,type:string,body:Record<string,unknown>={}) {
  const seq=(await db.query('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM business.intake_events WHERE turn_id=$1',[turn.id])).rows[0].seq;
  await db.query('INSERT INTO business.intake_events(turn_id,seq,type,body) VALUES($1,$2,$3,$4)',[turn.id,seq,type,JSON.stringify(body)]);
}
export async function createAssistantTurn(db:DB,actor:Actor,draft:DraftRow,r:{text:string;clientTurnId:string;attachmentIds:string[]},config:IntakeConfig,version:string) {
  if(!assistantCapability(config).available)throw new AppError(503,'assistant_configuration_required');
  await validateDraftAttachmentIds(db,actor,draft.id,r.attachmentIds);
  const history=(await db.query("SELECT id,text,reply_blocks,assistant_questions,attachment_ids FROM business.intake_turns WHERE draft_id=$1 AND status='ready' ORDER BY created_at DESC,id DESC LIMIT 1001",[draft.id])).rows.reverse();
  if(history.length>1000)throw new AppError(422,'input_budget_exhausted');
  // Keep every user fact. Compact older assistant prose; accepted facts remain in the form.
  const blocks:IntakeSourceBlock[]=history.flatMap((row,index)=>[
    ...(row.text?[{id:`message:${row.id}`,text:row.text}]:[]),
    ...(index>=history.length-8?[{id:`reply:${row.id}`,text:[...(row.reply_blocks??[]).map((block:IntakeReplyBlock)=>block.text),...(row.assistant_questions??[])].join('\n')}].filter(block=>block.text):[]),
  ]);
  const formLabels:Record<string,string>={customerNumber:'客户编号',jurisdiction:'司法管辖地',guaranteeCurrency:'担保币种',guaranteeAmount:'担保金额',guaranteeTypes:'担保类型'};
  for(const [field,value] of Object.entries({...draft.fields,...draft.details,guaranteeTypes:JSON.stringify(draft.guarantee_types??[])}))if(value)blocks.push({id:`field:${field}`,text:`${formLabels[field]??field}: ${value}`});
  const id=randomUUID();if(r.text)blocks.push({id:`message:${id}`,text:r.text});
  if(blocks.length>256||blocks.reduce((sum,block)=>sum+Buffer.byteLength(block.text),0)>intakeAssistantCapacity(config).maxSourceBytes)throw new AppError(422,'input_budget_exhausted');
  const priorIds=[...new Set(history.flatMap(row=>row.attachment_ids??[]))];
  const retained=(await db.query("SELECT id FROM business.draft_attachments WHERE draft_id=$1 AND id=ANY($2::uuid[]) AND state='active'",[draft.id,priorIds])).rows.map(row=>row.id as string);
  const contextAttachmentIds=[...new Set([...retained,...r.attachmentIds])];
  const snapshot={blocks,contextAttachmentIds,fieldSources:draft.field_sources,historyCondensed:history.length>8};
  const turn=(await db.query(`INSERT INTO business.intake_turns(id,draft_id,owner_person_id,account_id,auth_version,draft_revision,client_turn_id,input_hash,text,fields_snapshot,session_key,expires_at,protocol_version,attachment_ids,input_snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+interval '30 minutes',2,$12,$13) RETURNING *`,[id,draft.id,actor.personId,actor.accountId,actor.authVersion,draft.revision,r.clientTurnId,inputHash({text:r.text,fields:draft.fields,attachmentIds:r.attachmentIds,snapshot}),r.text,JSON.stringify(draft.fields),actor.sessionKey,r.attachmentIds,JSON.stringify(snapshot)])).rows[0] as TurnRow;
  if(!r.attachmentIds.length&&/^(?:请问)?(?:你(?:是|用的|使用的)?(?:什么|哪个|哪款)模型|你(?:的)?模型(?:是(?:什么|哪个))?|模型型号)[？?。！!\s]*$/u.test(r.text.trim())){
    const block={id:'configured-models',text:`我是跨境通途建案助手。当前服务配置为：私有 ${config.local!.model} 负责识别和脱敏，Azure ${config.cloud!.model} 负责回复与整理表单。你可以补充案件信息或发送附件，核对表单后点击“创建案件”。`,sourceRefs:[]};
    await db.query("UPDATE business.intake_turns SET status='ready',reply_blocks=$2,result_revision=$3,updated_at=now() WHERE id=$1",[id,JSON.stringify([block]),draft.revision]);
    await assistantEvent(db,turn,'assistant_delta',{block});await assistantEvent(db,turn,'completed');
    await audit(db,{actorId:actor.accountId,targetId:id,action:'draft.turn_created',details:{revision:draft.revision,protocol:2,configurationReply:true}});
    return(await db.query('SELECT * FROM business.intake_turns WHERE id=$1',[id])).rows[0] as TurnRow;
  }
  const callId=randomUUID(),workId=randomUUID();
  await db.query("INSERT INTO business.model_calls(id,turn_id,profile_id,profile_version,task_type,projection,step_key) VALUES($1,$2,'local_intake',$3,'draft_intake','{}','prepare')",[callId,id,version]);
  await db.query("INSERT INTO business.work_items(id,owner_type,owner_id,kind,queue,max_attempts) VALUES($1,'ModelCall',$2,'draft_intake','model-local',1)",[workId,callId]);
  await db.query("INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,'work.available',$3)",[randomUUID(),workId,callId]);
  await assistantEvent(db,turn,'step',{step:{key:'organizing',title:'整理上下文',status:'completed',summary:history.length>8?'已结合当前草稿、全部用户补充和最近 8 轮助手回复。':'已结合当前草稿和已提交的交流。'}});
  await audit(db,{actorId:actor.accountId,targetId:id,action:'draft.turn_created',details:{revision:draft.revision,protocol:2,attachmentCount:r.attachmentIds.length}});
  return turn;
}
type Bridge={pool:Pool;config:IntakeConfig;turn:TurnRow;work:ModelWork;call:any;signal:AbortSignal;fetcher:typeof fetch;attachments?:DraftAttachmentService;
  fence:(db:DB)=>Promise<unknown>;version:(profile:'local_intake'|'cloud_assistant')=>string;
  reserve:(db:DB,call:any,payload:PreparedModelPayload)=>Promise<void>;
  settle:(db:DB,call:any,result:ModelResult)=>Promise<void>;
  dispatch:<T>(persist:(db:DB)=>Promise<void>,start:()=>Promise<T>)=>Promise<T>;
};
export async function runAssistant(b:Bridge) {
  const {pool,turn,call,signal,config}=b;
  const actor:Actor={accountId:turn.account_id,personId:turn.owner_person_id,authVersion:turn.auth_version,sessionKey:turn.session_key??undefined};
  const cloud=config.cloud!;
  let childIndex=0,activeChild:any;
  const ports:IntakeAssistantPorts={
    config,turn,call,signal,work:b.work,fetcher:b.fetcher,version:b.version,
    available:()=>assistantCapability(config).available,
    emit:(type:string,body:Record<string,unknown>)=>transaction(pool,async db=>{await b.fence(db);await assistantEvent(db,turn,type,body);}),
    proposeEntities:async(blocks,privacySignal,trustedSourceContext)=>{
      let receiptCommitted=false;
      const invoke=async(parts:IntakeSourceBlock[],correction?:{sourceCorrectionOf:string;sourceCorrectionPart:number})=>{
        (privacySignal??signal).throwIfAborted();receiptCommitted=false;
        const child=await transaction(pool,async db=>{
          await b.fence(db);
          // The configured ceiling counts every provider attempt, including a
          // correction. It is checked before any child or reservation is created.
          if(childIndex>=intakeAssistantCapacity(config).maxPrivacyCalls)throw new ModelExecutionError('input_budget_exhausted');
          const index=childIndex++;
          const old=(await db.query("SELECT * FROM business.model_calls WHERE turn_id=$1 AND step_key='redact' AND call_index=$2",[turn.id,index])).rows[0];
          if(old)throw new ModelExecutionError('execution_unknown');
          const id=randomUUID();return(await db.query("INSERT INTO business.model_calls(id,turn_id,profile_id,profile_version,task_type,projection,step_key,call_index,parent_call_id,state) VALUES($1,$2,'local_intake',$3,'draft_intake',$6,'redact',$4,$5,'running') RETURNING *",[id,turn.id,b.version('local_intake'),index,call.id,JSON.stringify(correction??{})])).rows[0];
        });
        activeChild=child;
          const partIds=new Set(parts.map(block=>block.id));
          const output=await proposeIntakeEntities(parts,config.local!,pool,privacySignal??signal,{
            dispatch:async(body,start)=>b.dispatch(async db=>{
              await b.fence(db);const current=(await db.query('SELECT * FROM business.model_calls WHERE id=$1 FOR UPDATE',[child.id])).rows[0];
              if(current.state!=='running'||current.sent_at)throw new ModelExecutionError('execution_unknown');
              const text=JSON.stringify(body);await b.reserve(db,current,{body:text,payloadHash:inputHash(body),endpoint:config.local!.service.baseUrl,actualProvider:qwenProvider(config.local!.service),model:config.local!.model});
              await db.query("UPDATE business.model_calls SET state='sent',sent_at=now() WHERE id=$1",[child.id]);
            },start),
            onResult:async result=>{
              await transaction(pool,async db=>{
                // Usage bookkeeping survives cancellation; publishing still requires the fence below.
                await b.settle(db,child,{status:'completed',usage:result.usage} as ModelResult);
                await db.query("UPDATE business.model_calls SET state='completed',actual_model=$2,actual_provider=$3,provider_request_id=$4,usage=$5,updated_at=now() WHERE id=$1",[child.id,result.actualModel,result.actualProvider,result.providerRequestId,JSON.stringify(result.usage)]);
              });
              receiptCommitted=true;
            },
            onSourceValidationRejected:async diagnostics=>{
              if(!receiptCommitted)throw new ModelExecutionError('execution_unknown');
              const saved=await pool.query("UPDATE business.model_calls SET projection=jsonb_set(projection,'{sourceValidation}',$2::jsonb),updated_at=now() WHERE id=$1 AND state='completed' AND provider_request_id IS NOT NULL AND usage IS NOT NULL AND reserved_micros=0 RETURNING id",[child.id,JSON.stringify(diagnostics)]);
              if(!saved.rowCount)throw new ModelExecutionError('execution_unknown');
            },
          },{sourceCorrection:!!correction,trustedSourceContext:trustedSourceContext?.filter(block=>partIds.has(block.id))});
          activeChild=undefined;return output;
      };
      try{return await invoke(blocks);}
      catch(error){
          const sourceFailure=error instanceof ModelExecutionError&&error.code==='invalid_output'&&['local_output_source','local_output_source_ambiguous'].includes(error.diagnostic??'');
          const truncated=error instanceof ModelExecutionError&&error.code==='truncated'&&error.diagnostic==='qwen_truncated';
          // Only the initial known, paid response can trigger one split. An
          // unknown result or any failure inside a split never starts another.
          if(!receiptCommitted||!activeChild||!(sourceFailure||truncated))throw error;
          const correctionOf=activeChild.id;
          const rejected=await pool.query("UPDATE business.model_calls SET state='failed',error_code=$2,updated_at=now() WHERE id=$1 AND state='completed' AND provider_request_id IS NOT NULL AND usage IS NOT NULL AND reserved_micros=0 RETURNING id",[correctionOf,error.diagnostic]);
          if(!rejected.rowCount)throw error;
          activeChild=undefined;
          (privacySignal??signal).throwIfAborted();
          const parts=splitPrivacyCorrectionBlocks(blocks);
          if(parts.length!==2)throw error;
          // Check space for the entire correction before creating its first
          // child. Each request still has its own budget reservation and fence.
          await transaction(pool,async db=>{await b.fence(db);if(childIndex+parts.length>intakeAssistantCapacity(config).maxPrivacyCalls)throw new ModelExecutionError('input_budget_exhausted');});
          const entities=new Map<string,PrivacyEntity>();
          for(const [index,part]of parts.entries()){
            let result;
            try{result=await invoke(part,{sourceCorrectionOf:correctionOf,sourceCorrectionPart:index+1});}
            catch(correctionError){
              const sourceRejected=correctionError instanceof ModelExecutionError&&correctionError.code==='invalid_output'&&['local_output_source','local_output_source_ambiguous'].includes(correctionError.diagnostic??'');
              const outputTruncated=correctionError instanceof ModelExecutionError&&correctionError.code==='truncated'&&correctionError.diagnostic==='qwen_truncated';
              if(!receiptCommitted||!activeChild||!(sourceRejected||outputTruncated))throw correctionError;
              (privacySignal??signal).throwIfAborted();
              // This is a known, paid failed correction, never an uncertain
              // request. The projection service may withhold the whole original
              // attachment blocks; it cannot accept any partial entity list.
              const reason=sourceRejected?'source_validation_failed' as const:'output_truncated' as const;
              await transaction(pool,async db=>{
                await b.fence(db);
                const saved=await db.query("UPDATE business.model_calls SET state='failed',error_code=$2,projection=jsonb_set(projection,'{sourceIsolation}',$3::jsonb),updated_at=now() WHERE id=$1 AND state='completed' AND provider_request_id IS NOT NULL AND usage IS NOT NULL AND reserved_micros=0 RETURNING id",[activeChild.id,correctionError.diagnostic,JSON.stringify({version:'whole-source/1',reason,sourceBlockCount:new Set(blocks.map(block=>block.id)).size})]);
                if(!saved.rowCount)throw new ModelExecutionError('execution_unknown');
              });
              activeChild=undefined;
              return{withheld:{reason}};
            }
            for(const entity of result.entities){
              entities.set(JSON.stringify([entity.kind,entity.text]),entity);
              if(entities.size>512)throw new ModelExecutionError('invalid_output',false,'local_output_schema');
            }
          }
          return{entities:[...entities.values()]};
      }
    },
    parseAttachments:async attachmentIds=>{
      if(attachmentIds.length&&!b.attachments)throw new AppError(503,'attachment_parser_unavailable');
      return b.attachments?await b.attachments.parseAttachments(actor,turn.draft_id,attachmentIds,{signal,beforeStep:()=>transaction(pool,b.fence)}):{blocks:[],coverageGaps:[]};
    },
    previousProjection:async()=>(await pool.query('SELECT projection FROM business.intake_private_projections WHERE draft_id=$1 ORDER BY created_at DESC LIMIT 1',[turn.draft_id])).rows[0]?.projection as PrivateIntakeProjection|undefined,
    completePreparation:async(projection,duration)=>{await transaction(pool,async db=>{
        await b.fence(db);
        await db.query('INSERT INTO business.intake_private_projections(turn_id,draft_id,projection) VALUES($1,$2,$3)',[turn.id,turn.draft_id,JSON.stringify(projection)]);
        await db.query("UPDATE business.model_calls SET state='completed',result=$2,updated_at=now() WHERE id=$1",[call.id,JSON.stringify({projectionRef:turn.id})]);
        await db.query("UPDATE business.work_items SET state='succeeded',lease_until=NULL WHERE id=$1 AND epoch=$2",[b.work.id,b.work.epoch]);
        await db.query('INSERT INTO business.inbox(work_item_id,epoch) VALUES($1,$2) ON CONFLICT DO NOTHING',[b.work.id,b.work.epoch]);
        await assistantEvent(db,turn,'step',{step:{key:'privacy',title:'隐私处理',status:'completed',durationMs:duration(),summary:projection.withheldSources?.length?`已隔离 ${projection.withheldSources.length} 段未通过隐私处理的附件内容；仅根据其余通过检查的材料继续整理，请核对未处理部分。`:'已完成私有识别、替换与出站检查'}});
        const next=randomUUID(),workId=randomUUID();
        await db.query("INSERT INTO business.model_calls(id,turn_id,profile_id,profile_version,task_type,policy_version,projection,step_key) VALUES($1,$2,'cloud_assistant',$3,'draft_intake',$4,$5,'assistant')",[next,turn.id,b.version('cloud_assistant'),config.cloud!.policy.version,JSON.stringify({version:'draft_intake_v2',projectionRef:turn.id})]);
        await db.query("INSERT INTO business.work_items(id,owner_type,owner_id,kind,queue,max_attempts) VALUES($1,'ModelCall',$2,'draft_intake','model-cloud',1)",[workId,next]);
        await db.query("INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,'work.available',$3)",[randomUUID(),workId,next]);
      });},
    projection:async()=>(await pool.query('SELECT projection FROM business.intake_private_projections WHERE turn_id=$1 AND draft_id=$2',[turn.id,turn.draft_id])).rows[0]?.projection as PrivateIntakeProjection,
    authorize:(profile,allowed)=>(async()=>{try{return await transaction(pool,async db=>{await b.fence(db);if(!allowed())return null;return{scopeType:'draft' as const,draftId:turn.draft_id,ownerPersonId:turn.owner_person_id,revision:turn.draft_revision,conversationId:turn.draft_id,turnId:turn.id,projectionRef:turn.id,taskId:b.work.id,messageBundleRef:turn.id,profileId:profile.id,profileVersion:profile.version,evidenceClass:'redacted' as const,authorizationVersion:turn.auth_version};});}catch{return null;}})(),
    dispatchCloud:(payload,permit,start,allowed)=>((payload:PreparedModelPayload,permit:ModelEgressPermit,start:()=>Promise<Response>)=>b.dispatch(async db=>{
      await b.fence(db);if(!allowed())throw new ModelExecutionError('egress_denied');
      const receipt=await db.query("SELECT 1 FROM business.model_egress_receipts WHERE id=$1 AND call_id=$2 AND payload_hash=$3 AND policy_version=$4 AND decision='approved'",[permit.receiptId,call.id,payload.payloadHash,cloud.policy.version]);
      if(!receipt.rowCount)throw new ModelExecutionError('egress_denied');
      const update=await db.query("UPDATE business.model_calls SET state='sent',sent_at=now() WHERE id=$1 AND state='running' AND sent_at IS NULL RETURNING id",[call.id]);if(!update.rowCount)throw new ModelExecutionError('execution_unknown');
    },start))(payload,permit,start),
    recordCloudReceipt:async receipt=>transaction(pool,async db=>{
      // Persist provider completion/usage even if validation or authorization later
      // prevents publishing. This hook never writes draft fields or replies.
      await b.settle(db,call,{status:'completed',usage:receipt.usage} as ModelResult);
      await db.query("UPDATE business.model_calls SET state='completed',actual_model=$2,actual_provider=$3,provider_request_id=$4,usage=$5,updated_at=now() WHERE id=$1",[call.id,receipt.actualModel,receipt.actualProvider,receipt.providerRequestId,JSON.stringify(receipt.usage)]);
    }),
    recordOutputValidationFailure:async observation=>{
      const safe=PrivacyOutputValidationSchema.parse(observation);
      await transaction(pool,async db=>{
        await b.fence(db);
        const saved=await db.query("UPDATE business.model_calls SET projection=jsonb_set(projection,'{outputValidation}',$3::jsonb),updated_at=now() WHERE id=$1 AND turn_id=$2 AND profile_id='cloud_assistant' AND state='completed' AND sent_at IS NOT NULL AND provider_request_id IS NOT NULL AND usage IS NOT NULL AND reserved_micros=0 AND NOT (projection ? 'outputValidation') RETURNING id",[call.id,turn.id,JSON.stringify(safe)]);
        if(!saved.rowCount)throw new ModelExecutionError('execution_unknown');
      });
    },
    approvePayload:async(payload,result,allowed)=>transaction(pool,async db=>{
        await b.fence(db);if(!allowed())throw new ModelExecutionError('egress_denied');
        const current=(await db.query('SELECT * FROM business.model_calls WHERE id=$1 FOR UPDATE',[call.id])).rows[0];await b.reserve(db,current,payload);
        const receiptId=randomUUID();await db.query("INSERT INTO business.model_egress_receipts(id,call_id,payload_hash,policy_version,provider,endpoint,data_classes,decision) VALUES($1,$2,$3,$4,'azure-openai',$5,$6,'approved')",[receiptId,call.id,result.payloadHash,cloud.policy.version,payload.endpoint,JSON.stringify(result.dataClasses)]);
        return{receiptId,payloadHash:result.payloadHash,endpoint:payload.endpoint,policyVersion:cloud.policy.version};
      }),
    publishChunk:async(block,replyBlocks)=>{await transaction(pool,async db=>{await b.fence(db);replyBlocks.push(block);await db.query('UPDATE business.intake_turns SET reply_blocks=$2 WHERE id=$1',[turn.id,JSON.stringify(replyBlocks)]);await assistantEvent(db,turn,'assistant_delta',{block});});
    },
    complete:async(result,output,duration)=>{await transaction(pool,async db=>{
      await b.fence(db);const draft=(await db.query('SELECT * FROM business.case_drafts WHERE id=$1 FOR UPDATE',[turn.draft_id])).rows[0] as DraftRow;
      await b.settle(db,call,result);
      await db.query("UPDATE business.model_calls SET state='completed',actual_model=$2,actual_provider=$3,provider_request_id=$4,usage=$5,result=$6,updated_at=now() WHERE id=$1",[call.id,result.actualModel,result.actualProvider,result.providerRequestId,JSON.stringify(result.usage),JSON.stringify(output)]);
      const {fields,details,guaranteeTypes,states,sources,appliedFields,conflictFields,candidates}=buildAutofill(draft,turn,output);
      for(const candidate of candidates)await db.query('INSERT INTO business.intake_candidates(id,turn_id,field,value,source_refs) VALUES($1,$2,$3,$4,$5)',[candidate.candidateId,turn.id,candidate.field,candidate.value,JSON.stringify(candidate.sourceRefs)]);
      const revision=draft.revision+(appliedFields.length?1:0);
      await db.query('INSERT INTO business.intake_autofill_receipts(turn_id,draft_id,before_fields,before_states,before_sources,applied_fields,result_revision,before_details,before_guarantee_types) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[turn.id,draft.id,JSON.stringify(draft.fields),JSON.stringify(draft.field_states),JSON.stringify(draft.field_sources),appliedFields,revision,JSON.stringify(draft.details??{}),JSON.stringify(draft.guarantee_types??[])]);
      if(appliedFields.length)await db.query('UPDATE business.case_drafts SET fields=$2,field_states=$3,field_sources=$4,revision=$5,details=$6,guarantee_types=$7,updated_at=now() WHERE id=$1',[draft.id,JSON.stringify(fields),JSON.stringify(states),JSON.stringify(sources),revision,JSON.stringify(details),JSON.stringify(guaranteeTypes)]);
      await db.query("UPDATE business.intake_turns SET status='ready',reply_blocks=$2,assistant_questions=$3,result_revision=$4,applied_fields=$5,conflict_fields=$6,selected_candidate_ids=$7,updated_at=now() WHERE id=$1",[turn.id,JSON.stringify(output.replyBlocks),JSON.stringify(output.questions),revision,appliedFields,conflictFields,candidates.map(c=>c.candidateId)]);
      const current=draftView((await db.query('SELECT * FROM business.case_drafts WHERE id=$1',[draft.id])).rows[0]);
      await assistantEvent(db,turn,'step',{step:{key:'filling',title:'校验并填写表单',status:'completed',durationMs:duration(),summary:`已填写 ${appliedFields.length} 项，保留 ${conflictFields.length} 项手动内容。`}});
      await assistantEvent(db,turn,'draft_updated',{draft:current,baseRevision:turn.draft_revision,resultRevision:revision,appliedFields,conflictFields});
      await assistantEvent(db,turn,'completed');
      await db.query("UPDATE business.work_items SET state='succeeded',lease_until=NULL WHERE id=$1 AND epoch=$2",[b.work.id,b.work.epoch]);
      await db.query('INSERT INTO business.inbox(work_item_id,epoch) VALUES($1,$2) ON CONFLICT DO NOTHING',[b.work.id,b.work.epoch]);
      await audit(db,{actorId:turn.account_id,targetId:draft.id,action:'draft.assistant_applied',details:{turnId:turn.id,count:appliedFields.length,revision}});
    });},
  };
  try{await runIntakeAssistant(ports);}catch(error){
    if(activeChild){
      // An active child has not produced accepted output. A committed provider
      // receipt stays paid even for truncation, refusal or a later local failure;
      // an unreceipted dispatch remains unknown and must never be replayed.
      const diagnostic=error instanceof ModelExecutionError?(error.diagnostic??error.code):'assistant_step_failed';
      await pool.query("UPDATE business.model_calls SET state=CASE WHEN state='completed' OR sent_at IS NULL THEN 'failed' ELSE 'unknown' END,error_code=$2,updated_at=now() WHERE id=$1 AND state IN ('running','sent','completed')",[activeChild.id,diagnostic]);
    }
    throw error;
  }
}
export function buildAutofill(draft:DraftRow,turn:Pick<TurnRow,'id'|'account_id'|'owner_person_id'>,output:IntakeAssistantOutput) {
  const values=editableDraftValues(draft),states={...draft.field_states},sources={...draft.field_sources},appliedFields:IntakeField[]=[],conflictFields:IntakeField[]=[];
  const candidates=output.fieldSuggestions.map(item=>({...item,candidateId:randomUUID()}));
  for(const item of candidates){
    const current=draftValue(values,item.field);
    const proposed=editableDraftValues(draft);setDraftValue(proposed,item.field,item.value);
    if(JSON.stringify(current)===JSON.stringify(draftValue(proposed,item.field)))continue;
    const source=sources[item.field];
    const protectedField=source?.kind==='manual'||source?.kind==='suggestion'||(!source&&(Array.isArray(current)?current.length>0:!!current));
    if(protectedField){conflictFields.push(item.field);continue;}
    setDraftValue(values,item.field,item.value);states[item.field]='assistant';sources[item.field]={kind:'assistant',turnId:turn.id,candidateId:item.candidateId,personId:turn.owner_person_id,accountId:turn.account_id,sourceRefs:item.sourceRefs};appliedFields.push(item.field);
  }
  CaseDraftFieldsSchema.parse(values.fields);return{...values,states,sources,appliedFields,conflictFields,candidates};
}
