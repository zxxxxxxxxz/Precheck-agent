import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {transaction} from '../../infrastructure/database/client.js';
import {inputHash} from '../../infrastructure/database/idempotency.js';
import type {QwenDispatch} from '../../infrastructure/integrations/inference.js';
import {ServiceError} from '../../infrastructure/integrations/http.js';
import {ANALYSIS_BATCH_SIZE} from './batches.js';
/** Same dispatch-before-network protocol as document translations, with its own purpose/authorization. */
export function analysisDispatch(pool:Pool,jobId:string,itemId:string,fence:(db:PoolClient)=>Promise<unknown>):QwenDispatch{
  return async(body,start)=>{
    const hash=inputHash(body),previous=await transaction(pool,async db=>{
      await fence(db);const old=(await db.query('SELECT * FROM business.review_analysis_calls WHERE job_id=$1 AND item_id=$2',[jobId,itemId])).rows[0];
      if(old){if(old.request_hash!==hash)throw new ServiceError('review_assist_call_mismatch');if(old.state==='completed')return {response:old.response};throw new ServiceError(old.state==='unknown'?'review_assist_call_unknown':'review_assist_call_failed');}
      if(Number((await db.query('SELECT count(*) AS n FROM business.review_analysis_calls WHERE job_id=$1',[jobId])).rows[0].n)>=ANALYSIS_BATCH_SIZE)throw new ServiceError('review_assist_call_budget');
      const id=randomUUID();await db.query("INSERT INTO business.review_analysis_calls(id,job_id,item_id,request_hash,state) VALUES($1,$2,$3,$4,'unknown')",[id,jobId,itemId,hash]);return {id};
    });
    if('response'in previous)return previous.response;
    try{const result=await start();await transaction(pool,async db=>{await fence(db);await db.query("UPDATE business.review_analysis_calls SET state='completed',response=$2,completed_at=now() WHERE id=$1 AND state='unknown'",[previous.id,JSON.stringify(result)]);});return result;}
    catch(e){if(e instanceof ServiceError&&['qwen_busy','qwen_authorization_failed','qwen_request_rejected','qwen_invalid_response','qwen_response_too_large'].includes(e.code))await transaction(pool,async db=>{await fence(db);await db.query("UPDATE business.review_analysis_calls SET state='failed',error_code=$2,completed_at=now() WHERE id=$1 AND state='unknown'",[previous.id,e.code]);}).catch(()=>undefined);throw e;}
  };
}
