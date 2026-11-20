import type {CaseSupplementService} from '@hsbc/server/modules/case-supplement/service';
import type {FormalReviewService} from '@hsbc/server/modules/formal-review/service';
import type {CaseAssistantService} from '@hsbc/server/modules/case-assistant/service';
import type {ReviewAnalysisService} from '@hsbc/server/modules/review-delivery/analysis-service';
import type { Pool } from 'pg';
import type { IntakeService } from '@hsbc/server/modules/intake/service';
import type { ReviewService } from '@hsbc/server/modules/review/service';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { logEvent } from '@hsbc/server/runtime/logging';
import { UploadService } from '@hsbc/server/modules/materials/uploads/service';
import type { DocumentService } from '@hsbc/server/modules/documents/service';
import type { MockValidationService } from '@hsbc/server/modules/documents/validation/service';

export const APPLICATION_QUEUES=['workflow','document','model-local','model-cloud','export','maintenance'] as const;
export interface ApplicationTransport {
  start():void;
  ready():boolean;
  dispatch(workIds:string[],queue?:'document'|'model-local'|'model-cloud'|'workflow'):Promise<void>;
  resetDispatch():void;
  close():Promise<void>;
  disconnect():void;
}
class RedisTransport implements ApplicationTransport {
  private modelQueues=new Map<string,Queue>();private modelConsumers:Worker[]=[];
  private consumerConnection:Redis;private producer:Redis;private queue:Queue;private consumer:Worker;private closed=false;
  constructor(uploads:UploadService,options:{redisUrl:string;queuePrefix:string;documents?:DocumentService;mockValidation?:MockValidationService;intake?:IntakeService;reviews?:ReviewService;analyses?:ReviewAnalysisService;formal?:FormalReviewService;supplements?:CaseSupplementService;assistant?:CaseAssistantService}) {
    const common={lazyConnect:true,enableOfflineQueue:false,connectTimeout:2000,retryStrategy:(attempt:number)=>Math.min(5000,attempt*500)};
    // The consumer can wait for Redis; the dispatch producer must have a bounded command lifetime.
    this.consumerConnection=new Redis(options.redisUrl,{...common,maxRetriesPerRequest:null});
    this.producer=new Redis(options.redisUrl,{...common,maxRetriesPerRequest:1,commandTimeout:2500});
    this.consumerConnection.on('error',()=>{});this.producer.on('error',()=>{});
    this.queue=new Queue('document',{connection:this.producer,prefix:options.queuePrefix});this.queue.on('error',()=>{});
    this.consumer=new Worker('document',async job=>{
      if(!['verify_pdf','document_work'].includes(job.name)||typeof job.data?.workId!=='string')return;
      const work=await uploads.claim(job.data.workId);
      if(work)await uploads.verifyWork(work);
      else {const documentWork=await options.documents?.claim(job.data.workId);if(documentWork)await options.documents!.processWork(documentWork);
        else{const mockWork=await options.mockValidation?.claim(job.data.workId);if(mockWork)await options.mockValidation!.processWork(mockWork);}}
    },{connection:this.consumerConnection,prefix:options.queuePrefix,concurrency:2,autorun:false});
    this.consumer.on('error',()=>{});this.consumer.on('failed',()=>logEvent('p1_work_attempt_failed'));
    if(options.reviews||options.analyses||options.formal||options.assistant||options.supplements){
      const producer=new Queue('workflow',{connection:this.producer,prefix:options.queuePrefix});producer.on('error',()=>{});this.modelQueues.set('workflow',producer);
      const worker=new Worker('workflow',async job=>{if(job.name!=='review_work'||typeof job.data?.workId!=='string')return;const work=await options.reviews?.claim(job.data.workId);if(work)await options.reviews!.processWork(work);else{const analysis=await options.analyses?.claim(job.data.workId);if(analysis)await options.analyses!.processWork(analysis);else{const formal=await options.formal?.claim(job.data.workId);if(formal)await options.formal!.processWork(formal);else{const turn=await options.assistant?.claim(job.data.workId);if(turn)await options.assistant!.processWork(turn);else{const supplement=await options.supplements?.claim(job.data.workId);if(supplement)await options.supplements!.processWork(supplement);}}}}},{connection:this.consumerConnection,prefix:options.queuePrefix,concurrency:2,autorun:false});
      worker.on('error',()=>{});worker.on('failed',()=>logEvent('p3_review_attempt_failed'));this.modelConsumers.push(worker);
    }
    if(options.intake)for(const queue of ['model-local','model-cloud'] as const){
      const producer=new Queue(queue,{connection:this.producer,prefix:options.queuePrefix});producer.on('error',()=>{});this.modelQueues.set(queue,producer);
      const worker=new Worker(queue,async job=>{if(job.name!=='model_work'||typeof job.data?.workId!=='string')return;const work=await options.intake!.claim(job.data.workId,queue);if(work)await options.intake!.processWork(work);},{connection:this.consumerConnection,prefix:options.queuePrefix,concurrency:queue==='model-local'?1:2,autorun:false});
      worker.on('error',()=>{});worker.on('failed',()=>logEvent('p3_model_attempt_failed'));this.modelConsumers.push(worker);
    }
  }
  start(){
    if(this.consumerConnection.status==='wait')void this.consumerConnection.connect().catch(()=>{});
    if(this.producer.status==='wait')void this.producer.connect().catch(()=>{});
    for(const worker of this.modelConsumers)void worker.run().catch(()=>{if(!this.closed)logEvent('p3_model_queue_unavailable');});
    void this.consumer.run().catch(()=>{if(!this.closed)logEvent('p1_queue_unavailable');});
  }
  ready(){return this.producer.status==='ready';}
  async dispatch(workIds:string[],queue:'document'|'model-local'|'model-cloud'|'workflow'='document'){
    const target=queue==='document'?this.queue:this.modelQueues.get(queue);if(!target)return;
    await target.addBulk(workIds.map(workId=>({name:queue==='document'?'document_work':queue==='workflow'?'review_work':'model_work',data:{workId},opts:{jobId:workId,attempts:1,removeOnComplete:true,removeOnFail:true}})));
  }
  resetDispatch(){if(!this.closed)this.producer.disconnect(true);}
  async close(){this.closed=true;await Promise.all([this.consumer.close(true),this.queue.close(),...this.modelConsumers.map(w=>w.close(true)),...[...this.modelQueues.values()].map(q=>q.close())]);}
  disconnect(){this.closed=true;this.producer.disconnect();this.consumerConnection.disconnect();void this.consumer.disconnect().catch(()=>{});for(const worker of this.modelConsumers)void worker.disconnect().catch(()=>{});}
}

async function bounded<T>(operation:Promise<T>,milliseconds:number):Promise<T>{
  let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([operation,new Promise<T>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('deadline_exceeded')),milliseconds);})]);}
  finally{if(timer)clearTimeout(timer);}
}

/** PG owns work and retries. Dispatch runs independently and never gates PG recovery. */
export class ApplicationWorker {
  private transport:ApplicationTransport;private dispatchBusy=false;
  private readOnly:boolean;
  private timer?:NodeJS.Timeout;private heartbeat?:NodeJS.Timeout;private busy=false;private closed=false;private reconciledAt=0;
  private dispatchTimeoutMs:number;private shutdownTimeoutMs:number;
  private documents?:DocumentService;
  private supplements?:CaseSupplementService;private supplementRecovery=false;
  private formal?:FormalReviewService;private formalRecovery=false;private assistant?:CaseAssistantService;private assistantRecovery=false;
  private analyses?:ReviewAnalysisService;private analysisRecovery=false;
  private reviews?:ReviewService;private reviewRecovery=false;
  private mockValidation?:MockValidationService;private intake?:IntakeService;private modelRecovery=new Set<string>();
  constructor(private pool:Pool,private uploads:UploadService,options:{redisUrl:string;queuePrefix:string;transport?:ApplicationTransport;dispatchTimeoutMs?:number;shutdownTimeoutMs?:number;documents?:DocumentService;mockValidation?:MockValidationService;intake?:IntakeService;reviews?:ReviewService;analyses?:ReviewAnalysisService;formal?:FormalReviewService;supplements?:CaseSupplementService;assistant?:CaseAssistantService;readOnly?:boolean}) {
    this.readOnly=options.readOnly===true;
    this.documents=options.documents;this.supplements=options.supplements;
    this.formal=options.formal;this.assistant=options.assistant;this.reviews=options.reviews;this.analyses=options.analyses;
    this.mockValidation=options.mockValidation;this.intake=options.intake;
    this.transport=options.transport??new RedisTransport(uploads,options);
    this.dispatchTimeoutMs=options.dispatchTimeoutMs??3000;this.shutdownTimeoutMs=options.shutdownTimeoutMs??4000;
  }
  async start() {
    if(!this.readOnly)this.transport.start();
    await this.beat();
    this.heartbeat=setInterval(()=>{void this.beat().catch(()=>logEvent('p1_heartbeat_failed'));},15_000);
    if(!this.readOnly)this.timer=setInterval(()=>{void this.tick().catch(()=>logEvent('p1_reconciliation_failed'));},1000);
    await this.tick();
  }
  private async beat(){if(!this.closed)await this.pool.query("INSERT INTO business.runtime_heartbeats(name,updated_at) VALUES('worker',now()) ON CONFLICT(name) DO UPDATE SET updated_at=now()");}
  async tick() {
    if(this.closed||this.busy||this.readOnly)return;this.busy=true;
    try {
      if(this.supplements&&!this.supplementRecovery){this.supplementRecovery=true;void this.supplements.claim().then(work=>work?this.supplements!.processWork(work):undefined).catch(()=>logEvent('case_supplement_recovery_failed')).finally(()=>this.supplementRecovery=false);}
      if(this.formal&&!this.formalRecovery){this.formalRecovery=true;void this.formal.claim().then(work=>work?this.formal!.processWork(work):undefined).catch(()=>logEvent('formal_review_recovery_failed')).finally(()=>this.formalRecovery=false);}
      if(this.assistant&&!this.assistantRecovery){this.assistantRecovery=true;void this.assistant.claim().then(work=>work?this.assistant!.processWork(work):undefined).catch(()=>logEvent('case_assistant_recovery_failed')).finally(()=>this.assistantRecovery=false);}
      if(this.analyses&&!this.analysisRecovery){this.analysisRecovery=true;void this.analyses.claim().then(work=>work?this.analyses!.processWork(work):undefined).catch(()=>logEvent('review_analysis_recovery_failed')).finally(()=>this.analysisRecovery=false);}
      if(this.reviews&&!this.reviewRecovery){
        this.reviewRecovery=true;
        void this.reviews.claim().then(work=>work?this.reviews!.processWork(work):undefined).catch(()=>logEvent('p3_review_recovery_failed')).finally(()=>this.reviewRecovery=false);
      }
      // Start the PG recovery attempt before touching replaceable queue transport.
      const work=await this.uploads.claim();if(work)await this.uploads.verifyWork(work);
      if(!this.closed){const documentWork=await this.documents?.claim();if(documentWork)await this.documents!.processWork(documentWork);}
      if(!this.closed){const work=await this.mockValidation?.claim();if(work)await this.mockValidation!.processWork(work);}
      if(this.intake&&!this.closed)for(const queue of ['model-local','model-cloud'] as const){
        if(this.modelRecovery.has(queue))continue;this.modelRecovery.add(queue);
        void this.intake.claim(undefined,queue).then(work=>work?this.intake!.processWork(work):undefined).catch(()=>logEvent('p3_model_recovery_failed')).finally(()=>this.modelRecovery.delete(queue));
      }
      if(this.closed)return;
      if(Date.now()-this.reconciledAt>30_000){this.reconciledAt=Date.now();await this.uploads.reconcile();await this.documents?.reconcileProcessing();}
      if(this.closed||this.dispatchBusy||!this.transport.ready())return;
      const rows=(await this.pool.query(`SELECT id,queue FROM business.work_items WHERE (kind='verify_pdf' OR owner_type IN ('DocumentJob','MockValidationJob','ModelCall','Workflow')) AND available_at<=now()
        AND (state='pending' OR state='running' AND lease_until<now()) ORDER BY available_at LIMIT 20`)).rows;
      // A blackholed producer must not retain this tick's PG-recovery busy flag.
      if(rows.length&&!this.closed)void this.dispatch(rows);
    }finally{this.busy=false;}
  }
  private async dispatch(rows:{id:string;queue:string}[]){
    const ids=rows.map(row=>row.id);
    this.dispatchBusy=true;
    try{
      const queues=['document','model-local','model-cloud','workflow'] as const;
      await bounded(Promise.all(queues.map(queue=>{const work=rows.filter(row=>(row.queue??'document')===queue).map(row=>row.id);return work.length?this.transport.dispatch(work,queue):Promise.resolve();})),this.dispatchTimeoutMs);
      if(!this.closed)await this.pool.query('UPDATE business.outbox SET dispatched_at=now() WHERE work_item_id=ANY($1::uuid[])',[ids]);
    }catch{
      if(!this.closed){logEvent('p1_dispatch_unavailable');this.transport.resetDispatch();}
    }finally{this.dispatchBusy=false;}
  }
  async close() {
    if(this.closed)return;
    this.closed=true;this.supplements?.stop();this.assistant?.stop();this.formal?.stop();this.analyses?.stop();this.reviews?.stop();this.intake?.stop();this.documents?.stop();this.mockValidation?.stop();if(this.timer)clearInterval(this.timer);if(this.heartbeat)clearInterval(this.heartbeat);
    // Forced shutdown leaves in-flight work leased in PG. Its next owner must wait for
    // lease expiry and obtain a new epoch; close never marks unfinished work completed.
    try{await bounded(this.transport.close(),this.shutdownTimeoutMs);}
    catch{logEvent('p1_worker_shutdown_timeout');}
    finally{this.transport.disconnect();}
  }
}
