import { Queue,Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import { P0Store } from '@hsbc/server/experiments/p0/persistence/store';
import { logEvent } from '@hsbc/server/experiments/p0/persistence/environment';
import { executeWork,type FaultHook } from './graph.js';

export function queueConnection(url:string) {return new Redis(url,{maxRetriesPerRequest:null,enableReadyCheck:true});}
/** Redis is disposable execution transport. Outstanding work is reread from PG. */
export class P0Runner {
  private connection:Redis;
  private queues:Record<string,Queue>;
  private workers:Worker[]=[];
  private timer?:NodeJS.Timeout;
  private dispatching=false;
  constructor(private store:P0Store,private checkpointPool:pg.Pool,redisUrl:string,private prefix:string,private fault?:FaultHook) {
    this.connection=queueConnection(redisUrl);
    this.connection.on('error',()=>logEvent('redis_unavailable'));
    this.queues=Object.fromEntries(['workflow','document'].map(name=>[name,new Queue(name,{connection:this.connection,prefix})]));
  }
  async start() {
    for(const name of ['workflow','document']) {
      const worker=new Worker(name,async job=>{
        await executeWork(this.store,this.checkpointPool,job.data,this.fault);
      },{connection:this.connection,prefix:this.prefix,concurrency:2,lockDuration:10000,stalledInterval:5000});
      worker.on('error',()=>logEvent('worker_transport_error'));
      worker.on('failed',(_job)=>logEvent('work_attempt_failed'));
      this.workers.push(worker);
    }
    this.timer=setInterval(()=>{void this.dispatch().catch(()=>logEvent('dispatch_unavailable'));},500);
    await this.dispatch();
  }
  async dispatch() {
    if(this.dispatching||this.connection.status!=='ready')return;
    this.dispatching=true;
    try {await this.store.reconcileInvalidTasks();for(const work of await this.store.pendingWork()) {
      // Completed/failed transport entries must never prevent PG recovery.
      await this.queues[work.kind].add(work.kind,work,{jobId:work.id,attempts:1,removeOnComplete:true,removeOnFail:true});
      await this.store.dispatched(work.id);
    }}finally{this.dispatching=false;}
  }
  async close() {
    if(this.timer)clearInterval(this.timer);
    await Promise.all(this.workers.map(w=>w.close()));
    await Promise.all(Object.values(this.queues).map(q=>q.close()));
    this.connection.disconnect();
  }
}
