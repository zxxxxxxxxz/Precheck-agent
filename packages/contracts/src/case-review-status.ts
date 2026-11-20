export type CasePreReviewStatus='assignment_required'|'preparing'|'reviewing'|'execution_failed'|'results_pending'|'round_completed'|'canceled'|'stale'|'closed';
export type CaseReviewStage='result_to_confirm'|'to_submit'|'awaiting_checker'|'returned'|'correcting'|'round_confirmed';
export interface CaseReviewProjection {
 partySources?: {borrowers?: 'extracted'|'reviewed'; guarantors?: 'extracted'|'reviewed'};
 checkerRequired?:true;checkerDisplayName?:string|null;
 /** Where the current round stands between the Maker and the Checker; null when the pre-review status already says it. Absent on older servers. */
 stage?:CaseReviewStage|null;
 lifecycle:'open'|'closed';preReviewStatus:CasePreReviewStatus;currentRoundId:string|null;roundNumber:number|null;roundsEnabled:boolean;
 latestCompletedRoundNumber:number|null;latestCompletedRunId:string|null;guaranteeTypes:string[];borrowers:string[];guarantors:string[];latestRunId:string|null;outstandingCount:number;
 closure:null|{closedAt:string;closedBy:string;closedByName:string|null;reason:string;roundId:string|null;runId:string;kind?:'pre_review'|'checker_confirmed'|'checker_terminated'};
}
export interface ClosurePreview {
 caseId:string;revision:number;roundId:string|null;roundNumber:number|null;runId:string;snapshotHash:string;confirmationToken:string;
 /** Every result that is not a pass. `unresolved` marks those without a valid handling record; closing acknowledges each one and keeps its conclusion. */
 items:Array<{id:string;ruleId:string;label:string;scopeId:string;objectLabel:string;outcome:string;reasonCode:string;unresolved:boolean;issueId:string|null;issueVersion:number|null;issueStatus:string|null}>;
 /** The independent confirmation this close relies on, and the unresolved findings it was shown with. */
 checkerConfirmation:{submissionId:string;submissionNumber:number;checkerPersonId:string;confirmedAt:string|null;snapshotHash:string;outstandingFindingIds:string[]};
}
