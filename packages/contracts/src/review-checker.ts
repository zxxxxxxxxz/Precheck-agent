import {z} from 'zod';
import {ReviewEvidenceSchema} from './review.js';

export const CheckerCommandSchema=z.strictObject({expectedRevision:z.number().int().positive(),idempotencyKey:z.string().min(8).max(200),reason:z.string().trim().min(1).max(1000)});
export const CheckerTargetSchema=z.strictObject({kind:z.enum(['case','finding','field','material','mail']),id:z.string().min(1).max(200).optional()}).refine(v=>v.kind==='case'||!!v.id,'target_id_required');
export const CheckerAssignmentSchema=CheckerCommandSchema.extend({checkerPersonId:z.uuid()});
export const CheckerSubmitSchema=CheckerCommandSchema.extend({roundId:z.uuid(),runId:z.uuid(),previewHash:z.string().regex(/^[a-f0-9]{64}$/)});
export const CheckerDecisionSchema=CheckerCommandSchema.extend({submissionVersion:z.number().int().positive()});
export const CheckerNoteSchema=CheckerDecisionSchema.extend({target:CheckerTargetSchema,text:z.string().trim().min(1).max(4000)});
export const CheckerDispositionSchema=CheckerCommandSchema.extend({roundId:z.uuid(),runId:z.uuid(),findingId:z.uuid(),kind:z.enum(['manual_satisfied','professional_opinion','exception']),evidence:z.array(ReviewEvidenceSchema).min(1).max(50),externalAuthor:z.string().trim().min(1).max(300).optional(),source:z.string().trim().min(1).max(1000).optional(),receivedAt:z.iso.datetime().optional(),verified:z.boolean().default(false),validUntil:z.iso.datetime().optional(),conditions:z.string().trim().min(1).max(2000).optional(),opinionIds:z.array(z.uuid()).max(30).default([])}).superRefine((v,ctx)=>{
 if(v.kind!=='manual_satisfied'&&(!v.externalAuthor||!v.source||!v.receivedAt))ctx.addIssue({code:'custom',message:'external_provenance_required'});
 if(v.kind==='exception'&&(!v.validUntil||!v.conditions))ctx.addIssue({code:'custom',message:'exception_scope_required'});
});
export type CheckerTarget=z.infer<typeof CheckerTargetSchema>;
export type CheckerDispositionInput=z.infer<typeof CheckerDispositionSchema>;
export type CheckerStatus='assignment_required'|'correcting'|'not_submitted'|'pending'|'returned'|'confirmed'|'stale'|'terminated';
export interface CheckerBlocker {code:string;label:string;target?:CheckerTarget}
export interface CheckerSummary {enabled:true;status:CheckerStatus;personId:string|null;displayName:string|null;submissionId:string|null;confirmedAt:string|null}
export interface CheckerSubmission {
 id:string;roundId:string;roundNumber:number;runId:string;number:number;version:number;state:'submitted'|'returned'|'withdrawn'|'confirmed'|'terminated';validity:'current'|'stale';
 makerPersonId:string;checkerPersonId:string;makerName:string;checkerName:string;createdAt:string;decidedAt:string|null;reason:string;decisionReason:string|null;snapshotHash:string;
 snapshot:Record<string,unknown>;changes:string[];
}
export interface CheckerItem {id:string;submissionId:string;roundId:string;target:CheckerTarget;text:string;version:number;status:'open'|'responded'|'accepted';responses:Array<{id:string;kind:string;text:string;actorName:string;createdAt:string;evidence:unknown[]}>}
export interface CheckerDisposition {id:string;runId:string;findingId:string;ruleId:string;kind:string;reason:string;authorName:string;createdAt:string;verified:boolean;validUntil:string|null;externalAuthor:string|null;source:string|null;receivedAt:string|null;conditions:string|null;evidence:unknown[];opinionIds:string[]}
export interface CheckerState {
 caseId:string;revision:number;roundId:string|null;readOnly:boolean;summary:CheckerSummary;assignmentVersion:number;allowedActions:string[];
 candidates:Array<{personId:string;displayName:string;eligible:boolean;reasons:string[]}>;
 /** Prerequisites for handing the current snapshot to the Checker. */
 blockers:CheckerBlocker[];
 /** Unresolved findings and files left out of the round are preserved as results. They are never prerequisites
  * for round confirmation or for closing the case; closing acknowledges each finding and keeps its conclusion. */
 outstandingFindings?:CheckerBlocker[];
 previewHash:string|null;runId:string|null;submissions:CheckerSubmission[];items:CheckerItem[];dispositions:CheckerDisposition[];
 notes:Array<{id:string;submissionId:string;target:CheckerTarget;text:string;actorName:string;createdAt:string}>;
 findings:Array<{id:string;ruleId:string;label:string;outcome:string;reasonCode:string;manualAllowed:boolean}>;
 evidenceChoices:Array<{key:string;label:string;evidence:z.infer<typeof ReviewEvidenceSchema>}>;
 formalReviewAvailable:boolean;
}
