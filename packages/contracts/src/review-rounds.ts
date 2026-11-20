import {z} from 'zod';

export const RoundCommandSchema=z.strictObject({expectedRevision:z.number().int().positive(),idempotencyKey:z.string().min(8).max(200),reason:z.string().trim().min(1).max(1000)});
export type ReviewRoundStatus='draft'|'pending'|'running'|'ready'|'failed'|'canceled'|'stale'|'discarded'|'checker_pending'|'completed';
export interface ReviewRound {
  roundId:string;caseId:string;roundNumber:number;status:ReviewRoundStatus;locked:boolean;
  configurationReleaseId:string|null;guaranteeTypes:string[];businessDate:string|null;
  createdAt:string;submittedAt:string|null;discardedAt:string|null;runId:string|null;
  snapshotHash:string|null;resultRef:string|null;materialsRef:string;reviewStateRef:string;materialCount:number;allowedActions:string[];
}
export interface ReviewRoundsState {
 checkerCorrection?:boolean;
 returnedToMaker?:boolean;
 /** What the Checker wrote when sending the round back; shown to the Maker with the return. */
 returnReason?:string;
  caseId:string;revision:number;enabled:boolean;currentRoundId:string|null;items:ReviewRound[];
  hasLegacyRecords:boolean;allowedActions:string[];
}
