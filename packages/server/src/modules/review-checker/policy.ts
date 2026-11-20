import type {DB} from '../../infrastructure/database/client.js';
import type {CheckerBlocker} from '@hsbc/contracts/review-checker';
import type {FormalCheck,FormalResult} from '@hsbc/contracts/formal-review';
import type {AnalysisEvidence} from '@hsbc/contracts/review-delivery';

/** Formal-review adapters verify a persisted authorized receipt for this exact run.
 * Never populated from a browser request, a translation job or an auxiliary analysis result. */
export interface FormalReviewReceipt {available:boolean;complete:boolean;runId:string;snapshotHash:string;configurationReleaseId:string;receiptId?:string;reason?:string;findings?:any[];details?:{checks:FormalCheck[];results:FormalResult[];evidence:AnalysisEvidence[]}}
export interface FormalReviewPort {verify(input:{caseId:string;roundId:string;runId:string;snapshotHash:string;configurationReleaseId:string},db?:DB):Promise<FormalReviewReceipt>}
export const unavailableFormalReview:FormalReviewPort={async verify(input){return {...input,available:false,complete:false,reason:'正式云审核尚未接入，不能提交正式复核或确认文件审核'};}};
export function formalReviewBlockers(receipt:FormalReviewReceipt,input:{runId:string;snapshotHash:string;configurationReleaseId:string}):CheckerBlocker[]{
 if(!receipt.available)return [{code:'formal_review_unavailable',label:receipt.reason??'正式审核尚未接入'}];
 if(!receipt.complete||!receipt.receiptId||receipt.runId!==input.runId||receipt.snapshotHash!==input.snapshotHash||receipt.configurationReleaseId!==input.configurationReleaseId)return [{code:'formal_review_incomplete',label:'当前版本的正式审核及证据校验尚未完成'}];
 return [];
}
export function manualConclusionAllowed(rule:any,result:any):boolean{
 return rule?.operator==='manual_review'&&rule.sourceDirectionConfirmed===true&&(!rule.manualReason||rule.manualReason==='manual_review_required')&&result.reasonCode==='manual_review_required';
}
export function dispositionBlockers(results:any[],rules:any[],dispositions:any[],now:Date):CheckerBlocker[]{
 return results.flatMap(result=>{
  if(['pass','not_applicable'].includes(result.outcome))return [];
  const rule=rules.find(r=>r.id===result.ruleId),records=dispositions.filter(d=>d.finding_id===result.evaluationId);
  const manual=[...records].reverse().find(d=>d.kind==='manual_satisfied');
  const manualValid=manual?.verified&&manual.evidence?.length&&(!manual.valid_until||new Date(manual.valid_until)>now);
  const opinions=manual?.opinion_ids??[];
  const opinionsValid=opinions.every((id:string)=>dispositions.some(d=>d.id===id&&d.kind==='professional_opinion'&&d.verified&&d.external_author&&d.source&&d.received_at&&(!d.valid_until||new Date(d.valid_until)>now)));
  if(manualConclusionAllowed(rule,result)&&manualValid&&opinionsValid)return [];
  const exception=records.some(d=>d.kind==='exception');
  return [{code:exception?'exception_policy_unconfirmed':result.reasonCode==='manual_review_required'?'manual_disposition_required':'required_check_incomplete',label:`${rule?.label??result.ruleId}：${exception?'例外适用口径尚未配置，记录不能替代有效批准':manual&&!opinionsValid?'所依赖专业意见未核实或已失效':'仍需有效依据和处理结论'}`,target:{kind:'finding' as const,id:result.evaluationId}}];
 });
}
