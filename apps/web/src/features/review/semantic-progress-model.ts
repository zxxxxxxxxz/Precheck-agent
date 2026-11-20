import type {ChecklistRow,CrossFileCheck} from '@hsbc/contracts/review-checklist';
import {needsSemanticAnalysis} from './cross-file-semantic-queue.ts';
import {rerunStatus,type RerunQueue} from './semantic-rerun.ts';

export interface SemanticProgress {total:number;completed:number;pending:number;unfinished:number;failed:number;unavailable:number;waiting:number;percent:number}

/** Count current receipts plus work this page will schedule. Deterministic matches,
 * missing materials and human confirmations are not semantic jobs. A shared check
 * is one task even when several fields reference it. A result queued to be checked again waits for its new job. */
export function semanticTaskProgress(rows:ChecklistRow[],scheduled:Array<{check:CrossFileCheck}>,rerun:RerunQueue=new Map()):SemanticProgress {
  const checks=new Map<string,CrossFileCheck>();
  for(const {check} of scheduled)if(needsSemanticAnalysis(check))checks.set(check.id,check);
  // Retain completed receipts even if their owning field no longer needs scheduling.
  for(const row of rows)for(const check of row.crossChecks??[])if(check.semantic)checks.set(check.id,check);
  let completed=0,pending=0,unfinished=0,failed=0,unavailable=0,waiting=0;
  for(const check of checks.values()){
    if(!check.semantic||rerunStatus(rerun,check)==='queued')waiting++;
    else if(check.semantic.state==='pending')pending++;
    else if(check.semantic.state==='complete'&&!check.semantic.simulated)completed++;
    else {
      unfinished++;
      if(check.semantic.state==='failed')failed++;
      else if(check.semantic.state==='unavailable')unavailable++;
    }
  }
  const total=checks.size;
  return {total,completed,pending,unfinished,failed,unavailable,waiting,percent:total?completed/total*100:0};
}
