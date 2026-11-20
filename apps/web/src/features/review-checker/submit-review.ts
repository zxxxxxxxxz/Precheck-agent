import type {CheckerState} from '@hsbc/contracts/review-checker';
import type {ReviewRound,ReviewRoundsState} from '@hsbc/contracts/review-rounds';
import {ApiError} from '../../api.ts';

type Request=<T>(path:string,options?:{method:'POST';body:Record<string,unknown>})=>Promise<T>;
export interface ReviewSubmissionPlan {
 caseId:string;roundId:string;runId:string;previewHash:string;
 confirmation?:{body:Record<string,unknown>;done:boolean};
 submission?:Record<string,unknown>;submissionKey:string;reason:string;
}
export function submissionBlockers(state:CheckerState,round:ReviewRound,displayed:{id:string;snapshotHash:string}) {
 const matches=state.caseId===round.caseId&&state.roundId===round.roundId&&state.runId===displayed.id&&round.runId===displayed.id&&round.snapshotHash===displayed.snapshotHash;
 if(!matches)return ['预审结果已有变化，请重新读取本轮结果。'];
 if(state.readOnly||!state.allowedActions.includes('checker:prepare-submit'))return ['当前不能提交复核。'];
 const confirm=round.allowedActions.includes('round:confirm');
 return state.blockers.filter(b=>!confirm||b.code!=='checker_result_required').map(b=>b.label);
}
export function reviewSubmissionPlan(state:CheckerState,round:ReviewRound,rounds:ReviewRoundsState,displayed:{id:string;snapshotHash:string},reason:string,key:()=>string):ReviewSubmissionPlan {
 if(rounds.currentRoundId!==round.roundId||submissionBlockers(state,round,displayed).length||!state.previewHash)throw new ApiError(409,'checker_preview_stale','复核内容或提交条件已有变化，请重新核对。');
 return {caseId:state.caseId,roundId:round.roundId,runId:displayed.id,previewHash:state.previewHash,reason,submissionKey:key(),
  ...(round.allowedActions.includes('round:confirm')?{confirmation:{done:false,body:{expectedRevision:rounds.revision,idempotencyKey:key(),runId:displayed.id,snapshotHash:displayed.snapshotHash,reason}}}:{}),
 };
}
/** Keep both requests stable when a response is lost; never submit a changed preview. */
export async function submitReview(plan:ReviewSubmissionPlan,request:Request) {
 const base=`/api/cases/${plan.caseId}`;
 if(plan.confirmation&&!plan.confirmation.done){
  await request(`${base}/review/rounds/${plan.roundId}/confirm`,{method:'POST',body:plan.confirmation.body});
  plan.confirmation.done=true;
 }
 if(!plan.submission){
  const current=await request<CheckerState>(`${base}/checker?roundId=${encodeURIComponent(plan.roundId)}`);
  if(current.caseId!==plan.caseId||current.roundId!==plan.roundId||current.runId!==plan.runId||current.previewHash!==plan.previewHash||current.readOnly||!current.allowedActions.includes('checker:submit')||current.blockers.length)throw new ApiError(409,'checker_preview_stale','复核内容或提交条件已有变化，请重新核对。');
  plan.submission={expectedRevision:current.revision,idempotencyKey:plan.submissionKey,roundId:plan.roundId,runId:plan.runId,previewHash:plan.previewHash,reason:plan.reason};
 }
 await request(`${base}/checker/submissions`,{method:'POST',body:plan.submission});
}
