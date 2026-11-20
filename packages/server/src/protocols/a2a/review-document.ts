import { SendMessageRequest, SendMessageResponse, Task, TaskState, Role } from '@a2a-js/sdk';
import { AppError } from '../../shared/errors.js';
import type { ClaimedWork } from '../../infrastructure/jobs/types.js';
import type { ReviewSnapshot } from '../../modules/review/service.js';
import { createReviewDocumentTask } from '../../agents/document-evidence/review-task.js';
import { ReviewDocumentRequestSchema, ReviewDocumentReceiptSchema, type ReviewDocumentRequest, type ReviewDocumentReceipt } from '../../agents/document-evidence/contracts.js';

/** Private in-process SDK adapter. No public route or remote Agent registry is introduced. */
export function reviewDocumentAgent(work:ClaimedWork,snapshot:ReviewSnapshot,verify:()=>Promise<ReviewDocumentReceipt>){
  const task=createReviewDocumentTask(work,snapshot,verify),messageId=`review-document:${work.owner_id}`;
  return {async sendMessage(raw:unknown){
    const request=SendMessageRequest.fromJSON(raw),message=request.message;
    if(!message||message.messageId!==messageId||message.role!==Role.ROLE_USER||message.taskId||message.contextId||request.tenant||request.configuration?.taskPushNotificationConfig||message.parts.length!==1||message.parts[0]?.content?.$case!=='text')throw new AppError(422,'review_a2a_request_invalid');
    let parsed:ReviewDocumentRequest;try{parsed=ReviewDocumentRequestSchema.parse(JSON.parse(message.parts[0].content.value));}catch{throw new AppError(422,'review_a2a_request_invalid');}
    const receipt=await task.execute(parsed);
    const response=Task.fromJSON({id:task.runId,contextId:task.caseId,status:{state:TaskState.TASK_STATE_COMPLETED,timestamp:new Date().toISOString()},
      artifacts:[{artifactId:`document-review:${task.snapshotHash}`,parts:[{data:receipt}]}],metadata:{snapshotHash:task.snapshotHash}});
    return SendMessageResponse.toJSON({payload:{$case:'task',value:response}});
  }};
}

export async function requestReviewDocument(doc:ReturnType<typeof reviewDocumentAgent>,runId:string,snapshotHash:string):Promise<ReviewDocumentReceipt>{
  const request=SendMessageRequest.toJSON(SendMessageRequest.fromJSON({message:{messageId:`review-document:${runId}`,role:Role.ROLE_USER,parts:[{text:JSON.stringify({runId,snapshotHash})}]},configuration:{returnImmediately:true}}));
  const response=SendMessageResponse.fromJSON(await doc.sendMessage(request));
  if(response.payload?.$case!=='task'||response.payload.value.status?.state!==TaskState.TASK_STATE_COMPLETED)throw new AppError(409,'review_a2a_task_incomplete');
  const content=response.payload.value.artifacts[0]?.parts[0]?.content;
  if(content?.$case!=='data')throw new AppError(409,'review_a2a_artifact_missing');
  const receipt=ReviewDocumentReceiptSchema.parse(content.value);
  if(receipt.snapshotHash!==snapshotHash)throw new AppError(409,'review_a2a_artifact_mismatch');
  return receipt;
}
