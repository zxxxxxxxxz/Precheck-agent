import { z } from 'zod';

export const ReviewDocumentReceiptSchema=z.strictObject({snapshotHash:z.string().regex(/^[a-f0-9]{64}$/),documentVersionIds:z.array(z.uuid()),projectionJobIds:z.array(z.uuid())});
export type ReviewDocumentReceipt=z.infer<typeof ReviewDocumentReceiptSchema>;
export const ReviewDocumentRequestSchema=z.strictObject({runId:z.uuid(),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/)});
export type ReviewDocumentRequest=z.infer<typeof ReviewDocumentRequestSchema>;
