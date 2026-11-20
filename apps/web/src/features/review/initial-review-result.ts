import type {CheckerState,CheckerSubmission} from '@hsbc/contracts/review-checker';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {FrozenFieldReview} from '@hsbc/contracts/field-verification';
import type {ReviewFact,ReviewState} from '@hsbc/contracts/review';
import {checklistReviewLabel,checklistReviewStatus} from './field-review-status.ts';

interface SubmittedReview {
 fieldReviews?:FrozenFieldReview[];
 crossFileChecklist?:Array<Pick<ChecklistRow,'id'|'fieldId'|'crossChecks'>>;
 facts?:ReviewFact[];
}

/** Corrections append confirmed snapshots; the Maker's submitted record remains.
 * Never substitute a different round or a correction for that original handoff. */
export function initialReviewSubmission(state:ReviewState,checker:CheckerState|undefined):CheckerSubmission|undefined {
 if(!checker||checker.caseId!==state.caseId||checker.roundId!==state.roundId)return;
 const submissions=checker.submissions.filter(s=>s.roundId===state.roundId);
 return submissions.filter(s=>s.state==='submitted').sort((a,b)=>b.number-a.number)[0]
  ??submissions.filter(s=>s.state==='confirmed').sort((a,b)=>a.number-b.number)[0];
}

/** Only values from the immutable submission may enter the initial-result panel. */
export function initialReviewResult(row:ChecklistRow,state:ReviewState,submission:CheckerSubmission){
 const snapshot=submission.snapshot.reviewSnapshot as SubmittedReview|undefined;
 if(!snapshot||submission.roundId!==state.roundId)return;
 const saved=snapshot.fieldReviews?.find(f=>f.id===row.id&&f.fieldId===row.fieldId&&f.objectId===row.objectId);
 const cross=snapshot.crossFileChecklist?.find(f=>f.id===row.id&&f.fieldId===row.fieldId);
 const fact=snapshot.facts?.find(f=>f.fieldId===row.fieldId&&f.objectId===row.objectId);
 if(!saved&&!cross?.crossChecks?.length&&!fact)return;
 const frozenRow:ChecklistRow={...row,verification:saved?.verification,crossChecks:cross?.crossChecks,fact:fact??null,
  sourceVerification:undefined,sourceValues:undefined,confirmations:[],candidates:[],unassignedCandidates:[]};
 const frozenState={...state,readOnly:true};
 const reasons=saved?[saved.verification.reason]:cross?.crossChecks?.flatMap(c=>[c.reason,...c.manualReasons])??[];
 return {status:checklistReviewStatus(frozenRow,frozenState),label:checklistReviewLabel(frozenRow,frozenState),
  reasons:[...new Set(reasons.filter(Boolean))],actions:saved?.verification.actions??[],
  corrections:saved?.verification.corrections??[],fact,stale:saved?.verification.validity==='stale',
  hasFieldResult:!!saved||!!cross?.crossChecks?.length};
}

export const initialReviewProgress:Record<CheckerState['summary']['status'],string>={
 assignment_required:'待指派复核人',not_submitted:'未提交复核',pending:'待复核',correcting:'复核人更正中',
 returned:'已退回',confirmed:'已确认',stale:'提交已失效，需更正',terminated:'未完成复核即终止',
};
