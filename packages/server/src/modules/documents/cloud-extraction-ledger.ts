import { createHash, randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { ModelErrorCodeSchema, ModelDiagnosticSchema, ModelResultSchema, type ModelUsageSchema } from '@hsbc/contracts/model';
import type { z } from 'zod';
import { transaction } from '../../infrastructure/database/client.js';
import { ModelExecutionError, type ModelEgressPermit } from '../../model/gateway.js';
import { audit } from '../audit/events.js';
import { reserveMicros } from '../intake/config.js';
import type { DocumentCloudConfig } from './cloud-extraction-config.js';
import {DocumentResponseMetadataSchema,type DocumentResponseMetadata} from './cloud-response-metadata.js';
import {configHash} from '../review/opa.js';
import {documentCloudUsageCost,reserveDocumentCloudMicros} from './cloud-cost.js';

const hash=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const requestHash=(stepKey:string,seed:unknown,model:string)=>hash({stepKey,seed,model});
type Usage=z.infer<typeof ModelUsageSchema>;
export interface UnknownCompletionFirstPass {
  inputHash:string;projectionHash:string;firstSeed:unknown;completionSeed:unknown;firstResponse:unknown;
}
export interface DocumentCallHooks {
  reserve(body:string):Promise<ModelEgressPermit>;
  dispatch<T>(start:()=>Promise<T>):Promise<T>;
  receipt(usage:Usage,metadata?:DocumentResponseMetadata,actualModel?:string):Promise<void>;
  /** A bounded HTTP rejection is a known non-result; no usage or refund is invented. */
  providerRejected(rateLimited?:boolean):Promise<void>;
}
/** Only a local model that is not a hosted service qualifies: a hosted or cloud call that timed out may still have been
 * processed and charged, so it stays unknown. */
const gaveUpOnLocalModel=(error:unknown,channel:'private'|'cloud',config:DocumentCloudConfig)=>channel==='private'&&!config.local.service.hostedQwen&&
  error instanceof ModelExecutionError&&error.code==='timeout'&&error.diagnostic==='qwen_timeout';
/** A durable unknown dispatch is never repeated, including after a Worker restart. */
export class DocumentExtractionLedger {
  constructor(private readonly pool:Pool,private readonly job:{id:string;account_id:string},private readonly config:DocumentCloudConfig,
    private readonly fence:(db:PoolClient)=>Promise<void>,private readonly signal:AbortSignal,private readonly cloudCallLimit:1|2|3=1,private readonly recovering=false) {}
  /** Only a settled failure (or denial before reserve) may keep a first result.
   * A durable unknown, revocation or stale job must propagate to the owner. */
  async completionMayBeRetained(stepKey:string):Promise<boolean>{
    return transaction(this.pool,async db=>{
      await this.fence(db);this.signal.throwIfAborted();
      const rows=(await db.query('SELECT state FROM business.document_model_calls WHERE job_id=$1 AND step_key=$2',[this.job.id,stepKey])).rows;
      return rows.length===0||rows.every(row=>row.state==='failed'||row.state==='completed');
    });
  }
  async assertNoUnknownCalls(client:PoolClient):Promise<void>{
    await this.fence(client);this.signal.throwIfAborted();
    if((await client.query("SELECT 1 FROM business.document_model_calls WHERE job_id=$1 AND state='unknown' LIMIT 1",[this.job.id])).rowCount)throw new ModelExecutionError('execution_unknown');
  }
  /** Keep only the independently completed first pass. This never settles,
   * refunds, recovers or dispatches the unknown completion request. */
  async firstPassMayBeRetainedAfterUnknown(expected:UnknownCompletionFirstPass,client?:PoolClient):Promise<boolean>{
    const check=async(db:PoolClient)=>{
      await this.fence(db);this.signal.throwIfAborted();
      if(this.cloudCallLimit<2||Date.parse(this.config.cloud.policy.expiresAt)<=Date.now())return false;
      const snapshot=(await db.query('SELECT input_hash,projection_hash,projection FROM business.document_model_snapshots WHERE job_id=$1',[this.job.id])).rows[0];
      if(!snapshot||snapshot.input_hash!==expected.inputHash||snapshot.projection_hash!==expected.projectionHash||
        configHash(snapshot.projection)!==expected.projectionHash)return false;
      const rows=(await db.query('SELECT * FROM business.document_model_calls WHERE job_id=$1 ORDER BY created_at,id',[this.job.id])).rows;
      const cloud=rows.filter(row=>row.channel==='cloud'),classification=cloud.filter(row=>row.step_key==='classify:content:v1'),extraction=cloud.filter(row=>row.step_key!=='classify:content:v1'),first=cloud.find(row=>row.step_key==='extract:v2'),completion=cloud.find(row=>row.step_key==='complete:v2');
      if(extraction.length!==2||classification.length>(this.cloudCallLimit===3?1:0)||classification.some(row=>row.state!=='completed')||!first||!completion||first.state!=='completed'||completion.state!=='unknown'||
        rows.some(row=>row.state==='unknown'&&row.id!==completion.id)||completion.response!==null||
        first.request_hash!==requestHash('extract:v2',expected.firstSeed,this.config.cloud.model)||
        completion.request_hash!==requestHash('complete:v2',expected.completionSeed,this.config.cloud.model))return false;
      const policy=this.config.cloud.policy;
      if(cloud.some(row=>row.model!==this.config.cloud.model||row.policy_version!==policy.version||row.policy_hash!==hash(policy)||row.approved_by!==this.job.account_id))return false;
      const response=ModelResultSchema.safeParse(first.response),supplied=ModelResultSchema.safeParse(expected.firstResponse);
      this.signal.throwIfAborted();
      return response.success&&supplied.success&&response.data.status==='completed'&&supplied.data.status==='completed'&&
        response.data.taskId===this.job.id&&response.data.profileId==='document_cloud'&&response.data.actualProvider==='azure-openai'&&
        !response.data.simulated&&policy.actualModels.includes(response.data.actualModel)&&configHash(response.data)===configHash(supplied.data);
    };
    return client?check(client):transaction(this.pool,check);
  }
  async run<T>(stepKey:string,seed:unknown,channel:'private'|'cloud',invoke:(hooks:DocumentCallHooks)=>Promise<T>):Promise<T>{
    this.signal.throwIfAborted();
    const config=channel==='cloud'?this.config.cloud:this.config.local,expectedRequestHash=requestHash(stepKey,channel==='private'&&this.config.local.service.hostedQwen?{seed,hostedPolicy:this.config.local.service.hostedQwen}:seed,config.model);
    const old=await transaction(this.pool,async db=>{
      await this.fence(db);
      const rows=(await db.query('SELECT * FROM business.document_model_calls WHERE job_id=$1 AND step_key=$2 ORDER BY created_at',[this.job.id,stepKey])).rows;
      if(rows.some(row=>row.request_hash!==expectedRequestHash))throw new ModelExecutionError('execution_unknown');
      const row=rows[0];
      if(!row&&this.recovering&&channel==='private'&&/^repair-v[67]:/u.test(stepKey)){
        await this.assertNoUnknownCalls(db);
        // Old ordinal numbers can change when a public dictionary is skipped.
        // Reuse only exact requests, with the known algorithm-version upgrade;
        // prepare() still revalidates every source span and the final projection.
        const prior=(await db.query("SELECT * FROM business.document_model_calls WHERE job_id=$1 AND channel='private' AND state='completed' AND model=$2 AND approved_by=$3 ORDER BY created_at,id",[this.job.id,config.model,this.job.account_id])).rows;
        for(const candidate of prior){
          const versions=['intake-redaction-v5','intake-redaction-v6','intake-redaction-v7','intake-redaction-v8'];
          if(versions.some(privacyVersion=>candidate.request_hash===requestHash(candidate.step_key,{...(seed as Record<string,unknown>),privacyVersion},config.model))){
            await audit(db,{actorId:this.job.account_id,targetId:this.job.id,action:'document.model_call_reused',details:{callId:candidate.id,stepKey}});
            return {value:candidate.response as T};
          }
        }
      }
      if(!row)return null;
      if(row.channel!==channel||row.model!==config.model||row.approved_by!==this.job.account_id||channel==='cloud'&&(row.policy_version!==this.config.cloud.policy.version||row.policy_hash!==hash(this.config.cloud.policy)))throw new ModelExecutionError('execution_unknown');
      if(row.state==='completed')return {value:row.response as T};
      if(row.state==='failed')throw new ModelExecutionError(ModelErrorCodeSchema.safeParse(row.error_code).success?row.error_code:'invalid_output',false,
        ModelDiagnosticSchema.safeParse(row.error_diagnostic).success?row.error_diagnostic:undefined);
      throw new ModelExecutionError('execution_unknown');
    });
    if(old)return old.value;
    let callId:string|undefined,settled=false;
    const pricing=channel==='cloud'?this.config.cloud.pricing:undefined;
    const hooks:DocumentCallHooks={
      reserve:async body=>{
        this.signal.throwIfAborted();
        if(callId)throw new ModelExecutionError('execution_unknown');
        let reserved:number;try{
          const bytes=Buffer.byteLength(body);
          if(bytes>config.maxInputTokens)throw new ModelExecutionError('input_budget_exhausted');
          reserved=pricing?reserveDocumentCloudMicros(pricing,bytes,config.maxOutputTokens):reserveMicros(config,bytes);
          if(reserved>config.callBudgetMicros)throw new ModelExecutionError('request_budget_exhausted');
        }catch(error){if(error instanceof ModelExecutionError)throw error;throw new ModelExecutionError('request_budget_exhausted');}
        const id=randomUUID(),payloadHash=hash(body),policy=channel==='cloud'?this.config.cloud.policy:this.config.local.service.hostedQwen??null;
        await transaction(this.pool,async db=>{
          await this.fence(db);this.signal.throwIfAborted();
          await db.query('SELECT id FROM business.document_jobs WHERE id=$1 FOR UPDATE',[this.job.id]);
          // All jobs share the same channel budget lock, so concurrent documents cannot overspend.
          await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`document-extraction:${channel}`]);
          const previous=(await db.query('SELECT state FROM business.document_model_calls WHERE job_id=$1 AND (step_key=$2 OR state=\'unknown\')',[this.job.id,stepKey])).rows;
          if(previous.length)throw new ModelExecutionError('execution_unknown');
          const count=Number((await db.query('SELECT count(*) AS count FROM business.document_model_calls WHERE job_id=$1 AND channel=$2',[this.job.id,channel])).rows[0].count);
          if(count>=(channel==='cloud'?this.cloudCallLimit:this.config.maxPrivacyCalls))throw new ModelExecutionError('call_budget_exhausted');
          const budget=(await db.query(pricing?`SELECT coalesce(sum(CASE WHEN c.state<>'unknown' THEN coalesce(s.charged_micros,c.reserved_micros) ELSE c.reserved_micros END),0)::text AS spent,
            count(*) FILTER(WHERE c.created_at>now()-interval '1 minute')::int AS recent
            FROM business.document_model_calls c LEFT JOIN business.document_model_charges s ON s.call_id=c.id
            WHERE c.channel=$1 AND c.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`:
            `SELECT coalesce(sum(reserved_micros),0)::text AS spent,
            count(*) FILTER(WHERE created_at>now()-interval '1 minute')::int AS recent
            FROM business.document_model_calls WHERE channel=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,[channel])).rows[0];
          if(Number(budget.spent)+reserved>config.dailyBudgetMicros)throw new ModelExecutionError('daily_budget_exhausted');
          if(budget.recent>=config.requestsPerMinute)throw new ModelExecutionError('rate_limited',true);
          if(policy&&policy.expiresAt!==null&&Date.parse(policy.expiresAt)<=Date.now())throw new ModelExecutionError('egress_denied');
          await db.query(`INSERT INTO business.document_model_calls(id,job_id,step_key,request_hash,payload_hash,channel,model,policy_version,policy_hash,approved_by,reserved_micros,state)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'unknown')`,[id,this.job.id,stepKey,expectedRequestHash,payloadHash,channel,config.model,policy?.version??null,policy?hash(policy):null,this.job.account_id,reserved]);
          if(pricing)await db.query(`INSERT INTO business.document_model_prices(call_id,pricing,provenance,verification_ref)
            VALUES($1,$2,'dispatch',$3)`,[id,JSON.stringify(pricing),pricing.version]);
          await audit(db,{actorId:this.job.account_id,targetId:this.job.id,action:policy?'document.model_egress_approved':'document.model_call_reserved',
            details:{callId:id,payloadHash,model:config.model,channel,reservedMicros:reserved,...(policy?{policyVersion:policy.version,policyHash:hash(policy)}:{})}});
        });
        callId=id;
        return {payloadHash,endpoint:channel==='cloud'?this.config.cloud.endpoint:this.config.local.service.baseUrl,
          policyVersion:policy?.version??'private',receiptId:id};
      },
      dispatch:async start=>{
        this.signal.throwIfAborted();
        if(!callId)throw new ModelExecutionError('egress_denied');
        await transaction(this.pool,async db=>{
          await this.fence(db);this.signal.throwIfAborted();
          const row=(await db.query('SELECT state FROM business.document_model_calls WHERE id=$1',[callId])).rows[0];
          if(row?.state!=='unknown')throw new ModelExecutionError('execution_unknown');
          if(channel==='cloud'&&Date.parse(this.config.cloud.policy.expiresAt)<=Date.now())throw new ModelExecutionError('egress_denied');
        });
        return start();
      },
      receipt:async(usage,metadata,actualModel)=>{
        if(!callId)throw new ModelExecutionError('execution_unknown');
        const selected=metadata===undefined?undefined:DocumentResponseMetadataSchema.parse(metadata);
        if(selected&&channel!=='cloud')throw new ModelExecutionError('invalid_output');
        // Accounting survives revocation; publishing any values still requires the fence.
        await transaction(this.pool,async db=>{
          const saved=await db.query("UPDATE business.document_model_calls SET usage=$2 WHERE id=$1 AND state='unknown' RETURNING id",[callId,JSON.stringify(usage)]);
          if(!saved.rowCount)throw new ModelExecutionError('execution_unknown');
          if(selected)await audit(db,{actorId:this.job.account_id,targetId:this.job.id,action:'document.model_response_received',
            details:{callId:callId!,responseMetadata:JSON.stringify(selected)}});
          // No guessed model or billing category. An invalid/mismatched receipt
          // remains fully reserved; usage is still durable for investigation.
          let calculation:ReturnType<typeof documentCloudUsageCost>|undefined;
          if(pricing&&actualModel)try{calculation=documentCloudUsageCost(pricing,usage,actualModel,selected);}catch{/* retain reservation */}
          if(calculation)await db.query(`INSERT INTO business.document_model_charges(call_id,charged_micros,basis,usage,calculation)
            VALUES($1,$2,$3,$4,$5)`,[callId,calculation.chargedMicros,calculation.basis,JSON.stringify(usage),JSON.stringify(calculation)]);
        });
        settled=true;
      },
      providerRejected:async(rateLimited=false)=>{
        if(!callId)throw new ModelExecutionError('execution_unknown');
        const saved=await this.pool.query("UPDATE business.document_model_calls SET state='failed',error_code=$2,error_diagnostic=$3,completed_at=now() WHERE id=$1 AND state='unknown' AND usage IS NULL RETURNING id",[callId,rateLimited?'rate_limited':'provider_rejected',rateLimited?'azure_rate_limited':null]);
        if(!saved.rowCount)throw new ModelExecutionError('execution_unknown');
        settled=true;
      },
    };
    try{
      const result=await invoke(hooks);this.signal.throwIfAborted();
      if(!callId)throw new ModelExecutionError('execution_unknown');
      const body=JSON.stringify(result);if(Buffer.byteLength(body)>512000)throw new ModelExecutionError('invalid_output');
      await transaction(this.pool,async db=>{
        await this.fence(db);this.signal.throwIfAborted();
        const saved=await db.query("UPDATE business.document_model_calls SET state='completed',response=$2,completed_at=now() WHERE id=$1 AND state='unknown' RETURNING id",[callId,body]);
        if(!saved.rowCount)throw new ModelExecutionError('execution_unknown');
      });
      return result;
    }catch(error){
      if(callId&&settled){
        const code=error instanceof ModelExecutionError?error.code:'invalid_output';
        await this.pool.query("UPDATE business.document_model_calls SET state='failed',error_code=$2,error_diagnostic=$3,completed_at=now() WHERE id=$1 AND state='unknown'",[callId,code,error instanceof ModelExecutionError?error.diagnostic??null:null]).catch(()=>undefined);
      }else if(callId&&gaveUpOnLocalModel(error,channel,this.config)){
        // The redaction model on this machine did not answer within its time limit and the request was dropped. Nothing
        // left the machine and the reservation stays counted, so this call is closed as failed rather than left unknown:
        // the caller may then send smaller parts as new calls. This exact request is still never sent again.
        await this.pool.query("UPDATE business.document_model_calls SET state='failed',error_code='timeout',error_diagnostic='qwen_timeout',completed_at=now() WHERE id=$1 AND state='unknown' AND usage IS NULL",[callId]).catch(()=>undefined);
      }else if(callId&&error instanceof ModelExecutionError&&error.code==='execution_unknown'&&error.diagnostic){
        // The result stays unknown and the call is still never sent again. What was seen when it went unknown is kept
        // beside it, so the cause can be told without the provider's own message.
        await this.pool.query("UPDATE business.document_model_calls SET error_diagnostic=$2 WHERE id=$1 AND state='unknown'",[callId,error.diagnostic]).catch(()=>undefined);
      }
      throw error;
    }
  }
}
