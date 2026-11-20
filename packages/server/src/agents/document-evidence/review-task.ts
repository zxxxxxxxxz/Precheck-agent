import { AppError } from '../../shared/errors.js';
import type { ClaimedWork } from '../../infrastructure/jobs/types.js';
import { reviewHash, type ReviewSnapshot } from '../../modules/review/service.js';
import { ReviewDocumentReceiptSchema, type ReviewDocumentReceipt, type ReviewDocumentRequest } from './contracts.js';

/** The existing bounded evidence task; the domain port owns authorization and durable receipts. */
export function createReviewDocumentTask(work:ClaimedWork,snapshot:ReviewSnapshot,verify:()=>Promise<ReviewDocumentReceipt>){
  const snapshotHash=reviewHash(snapshot);
  return {
    runId:work.owner_id,caseId:snapshot.caseId,snapshotHash,
    async execute(input:ReviewDocumentRequest){
      if(input.runId!==work.owner_id||input.snapshotHash!==snapshotHash)throw new AppError(403,'review_a2a_scope_denied');
      const receipt=ReviewDocumentReceiptSchema.parse(await verify());
      if(receipt.snapshotHash!==snapshotHash)throw new AppError(409,'review_a2a_artifact_mismatch');
      return receipt;
    },
  };
}
