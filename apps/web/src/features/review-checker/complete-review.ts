import type {CheckerState} from '@hsbc/contracts/review-checker';
import type {ReviewRound,ReviewRoundsState} from '@hsbc/contracts/review-rounds';
import type {ClosurePreview} from '@hsbc/contracts/case-review-status';
import {ApiError} from '../../api.ts';
import {closureConfirmation,type ClosureAcknowledgement} from '../review/closure-confirmation.ts';

type Request=<T>(path:string,options?:{method:'POST';body:Record<string,unknown>})=>Promise<T>;
type Command={path:string;body:Record<string,unknown>;done:boolean};
export interface ReviewCompletionPlan {
 caseId:string;roundId:string;runId:string;snapshotHash:string;previewHash:string|null;
 initial?:Command;confirmation?:Command;confirmed:boolean;key:()=>string;
 next?:Command;preview?:ClosurePreview;closure?:ReturnType<typeof closureConfirmation>;
}
export function completionReady(state:CheckerState,round:ReviewRound,rounds:ReviewRoundsState,displayed:{id:string;snapshotHash:string}){
 if(state.readOnly||state.caseId!==rounds.caseId||state.roundId!==round.roundId||round.roundId!==rounds.currentRoundId||state.runId!==displayed.id||round.runId!==displayed.id||round.snapshotHash!==displayed.snapshotHash)return false;
 if(round.status==='completed')return state.summary.status==='confirmed';
 const initial=rounds.checkerCorrection&&round.allowedActions.includes('round:confirm')&&state.allowedActions.includes('checker:editing');
 if(state.blockers.some(b=>!initial||b.code!=='checker_result_required'))return false;
 return !!initial||state.allowedActions.includes('checker:confirm-correction')||state.allowedActions.includes('checker:confirm')&&state.submissions.some(s=>s.roundId===round.roundId&&s.runId===displayed.id&&s.state==='submitted'&&s.validity==='current');
}
export function reviewCompletionPlan(state:CheckerState,round:ReviewRound,rounds:ReviewRoundsState,displayed:{id:string;snapshotHash:string},key:()=>string):ReviewCompletionPlan {
 if(!completionReady(state,round,rounds,displayed))throw new ApiError(409,'checker_preview_stale','复核内容或条件已有变化，请重新核对。');
 const base=`/api/cases/${state.caseId}`,plan:ReviewCompletionPlan={caseId:state.caseId,roundId:round.roundId,runId:displayed.id,snapshotHash:displayed.snapshotHash,previewHash:state.previewHash,confirmed:round.status==='completed',key};
 if(rounds.checkerCorrection&&round.allowedActions.includes('round:confirm'))plan.initial={path:`${base}/review/rounds/${round.roundId}/confirm`,done:false,body:{expectedRevision:rounds.revision,idempotencyKey:key(),runId:displayed.id,snapshotHash:displayed.snapshotHash,reason:'复核人确认当前更正结果'}};
 else if(!plan.confirmed)plan.confirmation=confirmationCommand(plan,state);
 return plan;
}
function confirmationCommand(plan:ReviewCompletionPlan,state:CheckerState):Command {
 const base=`/api/cases/${plan.caseId}/checker`,body={expectedRevision:state.revision,idempotencyKey:plan.key(),reason:'复核人核对预审结果后执行收尾操作'};
 if(state.allowedActions.includes('checker:confirm-correction')&&state.previewHash)return {path:`${base}/corrections/confirm`,done:false,body:{...body,roundId:plan.roundId,runId:plan.runId,previewHash:state.previewHash}};
 const submission=state.submissions.find(s=>s.roundId===plan.roundId&&s.runId===plan.runId&&s.state==='submitted'&&s.validity==='current');
 if(!submission||!state.allowedActions.includes('checker:confirm'))throw new ApiError(409,'checker_preview_stale','当前提交无法确认，请重新核对。');
 return {path:`${base}/submissions/${submission.id}/confirm`,done:false,body:{...body,submissionVersion:submission.version}};
}
async function confirmCompletion(plan:ReviewCompletionPlan,request:Request){
 if(plan.confirmed)return;
 if(plan.initial&&!plan.initial.done){await request(plan.initial.path,{method:'POST',body:plan.initial.body});plan.initial.done=true;}
 if(!plan.confirmation){
  const state=await request<CheckerState>(`/api/cases/${plan.caseId}/checker?roundId=${encodeURIComponent(plan.roundId)}`);
  if(state.caseId!==plan.caseId||state.roundId!==plan.roundId||state.runId!==plan.runId||state.previewHash!==plan.previewHash||state.readOnly||state.blockers.length)throw new ApiError(409,'checker_preview_stale','更正结果已有变化，请重新核对。');
  plan.confirmation=confirmationCommand(plan,state);
 }
 await request(plan.confirmation.path,{method:'POST',body:plan.confirmation.body});plan.confirmation.done=true;plan.confirmed=true;
}
/** Each successful step is retained; lost responses retry the exact frozen command. */
export async function prepareReviewedRound(plan:ReviewCompletionPlan,request:Request){
 await confirmCompletion(plan,request);
 if(!plan.next){
  const state=await request<ReviewRoundsState>(`/api/cases/${plan.caseId}/review/rounds`),round=state.items.find(r=>r.roundId===plan.roundId);
  if(state.caseId!==plan.caseId||state.currentRoundId!==plan.roundId||round?.status!=='completed'||round.runId!==plan.runId||round.snapshotHash!==plan.snapshotHash||!state.allowedActions.includes('round:create'))throw new ApiError(409,'checker_preview_stale','当前轮次或下一轮准备条件已有变化，请刷新。');
  plan.next={path:`/api/cases/${plan.caseId}/review/rounds`,done:false,body:{expectedRevision:state.revision,idempotencyKey:plan.key(),reason:'复核人核对本轮结果后准备下一轮材料'}};
 }
 return request<ReviewRoundsState&{commandRoundId:string}>(plan.next.path,{method:'POST',body:plan.next.body});
}
export async function previewReviewedClosure(plan:ReviewCompletionPlan,request:Request){
 await confirmCompletion(plan,request);
 if(!plan.preview){
  const preview=await request<ClosurePreview>(`/api/cases/${plan.caseId}/closure-preview`);
  if(preview.caseId!==plan.caseId||preview.roundId!==plan.roundId||preview.runId!==plan.runId||preview.snapshotHash!==plan.snapshotHash)throw new ApiError(409,'closure_confirmation_stale','完结预览与已核对结果不一致，请刷新。');
  plan.preview=preview;
 }
 return plan.preview;
}
export async function closeReviewedCase(plan:ReviewCompletionPlan,request:Request,acknowledgement?:ClosureAcknowledgement){
 if(!plan.confirmed||!plan.preview)throw new ApiError(409,'closure_preview_required','请先核对完结条件。');
 // The first accepted acknowledgement is frozen with the command, so a lost response retries exactly what was confirmed.
 plan.closure??=closureConfirmation(plan.preview,plan.key(),acknowledgement);
 return request(`/api/cases/${plan.caseId}/close`,{method:'POST',body:plan.closure});
}
