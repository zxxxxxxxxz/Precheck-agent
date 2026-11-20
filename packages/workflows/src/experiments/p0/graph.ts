import { Annotation,StateGraph,START,END,interrupt,Command } from '@langchain/langgraph';
import pg from 'pg';
import { P0Store,type Execution } from '@hsbc/server/experiments/p0/persistence/store';
import { FencedPostgresSaver } from './checkpointer.js';

const State=Annotation.Root({taskId:Annotation<string>(),waitId:Annotation<string>(),decisionId:Annotation<string>(),done:Annotation<boolean>()});
export type FaultPoint='before-interrupt'|'checkpoint-before-arm'|'effect-before-checkpoint'|'resume-before-ack';
export type FaultHook=(point:FaultPoint,taskId:string)=>Promise<void>;
const noFault:FaultHook=async()=>{};
export function p0Graph(store:P0Store,saver:FencedPostgresSaver,execution:Execution,fault:FaultHook=noFault) {
  return new StateGraph(State)
    .addNode('prepare',async()=>({waitId:await store.prepareWait(execution)}))
    .addNode('human',async state=>{
      await fault('before-interrupt',execution.taskId);
      const decision=interrupt({waitId:state.waitId,kind:'synthetic_review'}) as {id:string;value:string};
      return {decisionId:decision.id};
    })
    .addNode('apply',async state=>{await store.effect(execution,state.decisionId);await fault('effect-before-checkpoint',execution.taskId);return {done:true};})
    .addEdge(START,'prepare').addEdge('prepare','human').addEdge('human','apply').addEdge('apply',END)
    .compile({checkpointer:saver});
}
export async function executeWork(store:P0Store,checkpointPool:pg.Pool,work:{id:string;task_id:string;kind:string},fault:FaultHook=noFault) {
  const execution=await store.claim(work.task_id,work.id,undefined,undefined,work.kind);if(!execution)return;
  const heartbeat=setInterval(()=>{void store.renew(execution).catch(()=>{});},5000);
  try {
    if(await store.stopIfInvalid(execution,execution.workId))return;
    if(execution.kind==='document'){await store.runDocument(execution,execution.workId);return;}
    await store.working(execution);
    const graph=p0Graph(store,new FencedPostgresSaver(checkpointPool,execution),execution,fault);
    const config={configurable:{thread_id:execution.taskId},durability:'sync' as const};
    let snapshot=await graph.getState(config);
    if(snapshot.values?.done){await store.finish(execution,execution.workId);return;}
    const pending=snapshot.tasks.flatMap(t=>t.interrupts??[]);
    const decision=await store.pendingDecision(execution.taskId);
    if(pending.length && decision) {
      await graph.invoke(new Command({resume:{[pending[0].id!]:decision}}),config);
      await fault('resume-before-ack',execution.taskId);
    } else if(!pending.length) {
      // Resume an interrupted execution from its committed checkpoint, or start.
      await graph.invoke(snapshot.createdAt?null:{taskId:execution.taskId},config);
    }
    snapshot=await graph.getState(config);
    if(snapshot.values?.done)await store.finish(execution,execution.workId);
    else {
      const waiting=snapshot.tasks.flatMap(t=>t.interrupts??[]);
      if(!waiting[0]?.id)throw new Error('checkpoint_wait_missing');
      await fault('checkpoint-before-arm',execution.taskId);
      await store.arm(execution,execution.workId,waiting[0].id);
    }
  } finally {clearInterval(heartbeat);await store.release(execution);}
}
