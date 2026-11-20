import {useSyncExternalStore} from 'react';
import type {CrossFileCheck} from '@hsbc/contracts/review-checklist';

/** A check the reviewer asked to check again, keyed by check id. `jobId` is the result they saw: the check is queued
 * while the checklist still shows that job, running while it shows a newer pending job, and done after that.
 * `requestId` tells one request from the next, so asking again after a failed start is a new attempt. */
export interface RerunEntry {jobId:string;fieldId:string;requestId:string}
export type RerunQueue=ReadonlyMap<string,RerunEntry>;
export type RerunStatus='queued'|'running'|'done';

// In memory only: switching pages keeps the queue, reloading the browser ends it. The server never depends on it.
const queues=new Map<string,RerunQueue>(),listeners=new Set<()=>void>(),empty:RerunQueue=new Map();
const scope=(caseId:string,roundId:string|null|undefined)=>`${caseId}:${roundId??'current'}`;
const update=(key:string,next:Map<string,RerunEntry>)=>{if(next.size)queues.set(key,next);else queues.delete(key);for(const listener of listeners)listener();};

/** Only a settled AI result can be checked again; first runs and pending jobs belong to the automatic scheduler. */
export const rerunnable=(check:CrossFileCheck)=>!!check.semanticEligible&&!!check.semantic&&check.semantic.state!=='pending';

export function rerunStatus(queue:RerunQueue,check:CrossFileCheck):RerunStatus|undefined {
  const entry=queue.get(check.id);if(!entry)return;
  if(check.semantic?.jobId===entry.jobId)return 'queued';
  return check.semantic?.state==='pending'?'running':'done';
}

export function requestRerun(caseId:string,roundId:string|null|undefined,tasks:Array<{check:CrossFileCheck;fieldId:string}>){
  const key=scope(caseId,roundId),next=new Map(queues.get(key)??empty),requestId=crypto.randomUUID();
  for(const {check,fieldId} of tasks)if(rerunnable(check))next.set(check.id,{jobId:check.semantic!.jobId,fieldId,requestId});
  update(key,next);
}
export function clearRerun(caseId:string,roundId:string|null|undefined,checkIds:Iterable<string>){
  const key=scope(caseId,roundId),current=queues.get(key);if(!current)return;
  const next=new Map(current);let changed=false;
  for(const id of checkIds)changed=next.delete(id)||changed;
  if(changed)update(key,next);
}
export const readRerunQueue=(caseId:string,roundId:string|null|undefined):RerunQueue=>queues.get(scope(caseId,roundId))??empty;
export function useRerunQueue(caseId:string,roundId:string|null|undefined):RerunQueue {
  return useSyncExternalStore(listener=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},()=>readRerunQueue(caseId,roundId),()=>empty);
}
