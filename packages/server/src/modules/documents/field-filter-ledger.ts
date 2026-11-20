import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { transaction } from '../../infrastructure/database/client.js';
import { ServiceError } from '../../infrastructure/integrations/http.js';
import type { FieldFilterChat } from './field-filter.js';

const responseSchema = z.strictObject({text:z.string().max(128_000),model:z.string().min(1),simulated:z.boolean().optional()});
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminalErrors = new Set(['qwen_truncated','qwen_refused','qwen_unsupported_output','qwen_model_drift','qwen_authorization_failed','qwen_request_rejected','qwen_invalid_response','qwen_response_too_large']);
export const FIELD_FILTER_DURABLE_CALL_LIMIT=48;

/** Receipts contain private provider results in the business store, never logs.
 * A sent request with no durable result is deliberately not replayed. */
export function durableFieldFilterChat(pool:Pool,jobId:string,model:string,chat:FieldFilterChat,
  fence:(db:PoolClient)=>Promise<void>,maxCalls=FIELD_FILTER_DURABLE_CALL_LIMIT):FieldFilterChat {
  return async(messages,signal,options={})=>{
    signal?.throwIfAborted();
    const requestHash=hash({model,messages,maxTokens:options.maxTokens??1024,disableThinking:options.disableThinking??false,jsonObject:options.jsonObject??false});
    const previous=await transaction(pool,async db=>{
      await fence(db);
      const rows=(await db.query('SELECT state,response,error_code FROM business.field_filter_calls WHERE job_id=$1 AND request_hash=$2 ORDER BY created_at DESC,id DESC',[jobId,requestHash])).rows;
      if(rows.some(row=>row.state==='unknown'))throw new ServiceError('semantic_filter_call_unknown');
      const completed=rows.find(row=>row.state==='completed');
      if(completed)return responseSchema.parse(completed.response);
      const failed=rows.find(row=>terminalErrors.has(row.error_code));
      if(failed)throw new ServiceError(failed.error_code);
      return null;
    });
    if(previous)return previous;
    let callId:string|undefined;
    try {
      const response=await chat(messages,signal,{...options,beforeSend:async body=>{
        await options.beforeSend?.(body);
        signal?.throwIfAborted();
        callId=await transaction(pool,async db=>{
          await fence(db);
          // All owners use the job/lease fence before this lock; the count is
          // cumulative across claims, transport retries and capacity waits.
          await db.query('SELECT id FROM business.document_jobs WHERE id=$1 FOR UPDATE',[jobId]);
          const count=Number((await db.query('SELECT count(*) AS n FROM business.field_filter_calls WHERE job_id=$1',[jobId])).rows[0].n);
          if(count>=maxCalls)throw new ServiceError('semantic_filter_call_budget_exceeded');
          const id=randomUUID();
          await db.query("INSERT INTO business.field_filter_calls(id,job_id,request_hash,payload_hash,state) VALUES($1,$2,$3,$4,'unknown')",[id,jobId,requestHash,hash(body)]);
          return id;
        });
      }});
      // The production client always invokes beforeSend. Test adapters must
      // obey the same boundary; an unrecorded response cannot enter a snapshot.
      if(!callId)throw new ServiceError('semantic_filter_dispatch_unrecorded');
      const saved=responseSchema.parse({text:response.text,model:response.model,...(response.simulated===undefined?{}:{simulated:response.simulated})});
      await transaction(pool,async db=>{
        await fence(db);signal?.throwIfAborted();
        await db.query("UPDATE business.field_filter_calls SET state='completed',response=$2,completed_at=now() WHERE id=$1 AND state='unknown'",[callId,JSON.stringify(saved)]);
      });
      return saved;
    } catch(error) {
      if(callId&&error instanceof ServiceError&&(terminalErrors.has(error.code)||error.code==='qwen_busy')) {
        await transaction(pool,async db=>{
          await fence(db);
          await db.query("UPDATE business.field_filter_calls SET state='failed',error_code=$2,completed_at=now() WHERE id=$1 AND state='unknown'",[callId,error.code]);
        }).catch(()=>undefined);
      }
      throw error;
    }
  };
}
