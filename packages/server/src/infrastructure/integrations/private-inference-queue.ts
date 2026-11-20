import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { ServiceError } from './http.js';

interface QueueLease {connection:pg.PoolClient;release:()=>Promise<void>}
interface QueueConnections {checkout:()=>Promise<pg.PoolClient>;put:(connection:pg.PoolClient,destroy?:boolean)=>void}
/** Queue rows determine admission; the session lock is the concurrency fence.
 * Pending requests return pooled connections between polls, so the running
 * request can still persist its dispatch/receipt with the same bounded pool. */
async function acquire(connections:QueueConnections,kind:'text'|'vision',signal:AbortSignal,
  options:{waitMs?:number;pollMs?:number}={}):Promise<QueueLease> {
  const waitMs=options.waitMs??60_000,pollMs=options.pollMs??100;
  if(!Number.isInteger(waitMs)||waitMs<0||waitMs>300_000||!Number.isInteger(pollMs)||pollMs<1)throw new ServiceError('qwen_invalid_queue_budget');
  signal.throwIfAborted();const id=randomUUID(),deadline=Date.now()+waitMs;
  let connection:pg.PoolClient|undefined,locked=false,handedOff=false,attempted=false;
  const broken=new AbortController(),onError=()=>broken.abort();
  const combined=AbortSignal.any([signal,broken.signal]);
  const checkout=async()=>{connection=await connections.checkout();connection.on('error',onError);};
  const put=(destroy=false)=>{if(connection){connection.removeListener('error',onError);connections.put(connection,destroy);connection=undefined;}};
  try {
    await checkout();
    await connection!.query(`INSERT INTO business.private_inference_queue(id,kind,expires_at)
      VALUES($1,$2,clock_timestamp()+($3::double precision*interval '1 millisecond'))`,[id,kind,waitMs+5000]);
    put();
    while(true){
      combined.throwIfAborted();
      if(attempted&&Date.now()>=deadline)throw new ServiceError('qwen_busy',true,2000);
      attempted=true;await checkout();combined.throwIfAborted();
      const result=await connection!.query('SELECT pg_try_advisory_lock(71012026, 1) AS locked');
      locked=result.rows[0]?.locked===true;
      if(locked){
        const priority=await connection!.query(`SELECT EXISTS(
          SELECT 1 FROM business.private_inference_queue other,business.private_inference_queue current
          WHERE current.id=$1 AND other.id<>current.id AND other.expires_at>clock_timestamp()
          AND ((other.kind='text' AND current.kind='vision')
            OR (other.kind=current.kind AND (other.queued_at,other.id)<(current.queued_at,current.id)))
        ) AS blocked`,[id]);
        if(!priority.rows[0]?.blocked){
          await connection!.query('DELETE FROM business.private_inference_queue WHERE id=$1 OR expires_at<=clock_timestamp()',[id]);
          combined.throwIfAborted();
          const active=connection!;active.removeListener('error',onError);connection=undefined;handedOff=true;
          return {connection:active,release:async()=>{await active.query('SELECT pg_advisory_unlock(71012026, 1)');}};
        }
        await connection!.query('SELECT pg_advisory_unlock(71012026, 1)');locked=false;
      }
      put();
      if(Date.now()>=deadline)throw new ServiceError('qwen_busy',true,2000);
      await sleep(Math.min(pollMs,Math.max(1,deadline-Date.now())),undefined,{signal:combined});
    }
  } catch(error){
    if(connection&&locked)try{await connection.query('SELECT pg_advisory_unlock(71012026, 1)');locked=false;}catch{ /* destroyed below */ }
    put(locked||broken.signal.aborted);throw error;
  } finally {
    if(!handedOff){
      // A database failure can leave only an expiring queue row, never a leased
      // pooled session. Cleanup is best-effort because it cannot release locks.
      try{await checkout();await connection!.query('DELETE FROM business.private_inference_queue WHERE id=$1',[id]);put();}catch{put(true);}
    }
  }
}
export async function acquirePrivateInferenceFromPool(pool:pg.Pool,kind:'text'|'vision',signal:AbortSignal,options:{waitMs?:number;pollMs?:number}={}):Promise<QueueLease>{
  return acquire({checkout:()=>pool.connect(),put:(connection,destroy)=>connection.release(destroy)},kind,signal,options);
}
/** Explicit-session variant for transactions, integration probes and callers
 * which own their connection. The caller must destroy it after a DB failure. */
export async function acquirePrivateInference(connection:pg.PoolClient,kind:'text'|'vision',signal:AbortSignal,options:{waitMs?:number;pollMs?:number}={}):Promise<()=>Promise<void>>{
  return (await acquire({checkout:async()=>connection,put:()=>{}},kind,signal,options)).release;
}
