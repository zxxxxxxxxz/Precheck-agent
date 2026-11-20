import {z} from 'zod';
import {SemanticGuidanceKindSchema,type CaseGuidance,type GuidanceDigestView,type SemanticGuidanceBody} from './review-guidance.js';
import type {ReviewEvidence} from './review.js';

export const CASE_ASSIST_SCHEMA='case-assist.v1';
export const CASE_ASSIST_LEGAL_SCHEMA='case-assist-legal.v1';

/** Client hints only. The server re-reads the authorized case, round and checklist. */
export const CaseAssistPageSchema=z.strictObject({
  view:z.enum(['desk','reader','result','materials','other']),
  roundId:z.uuid().nullable(),
  rowId:z.string().min(1).max(500).nullable(),
  documentId:z.uuid().nullable(),
});
export type CaseAssistPage=z.infer<typeof CaseAssistPageSchema>;
export const CaseAssistTurnRequestSchema=z.strictObject({
  clientTurnId:z.uuid(),text:z.string().trim().min(1).max(2000),
  mode:z.enum(['chat','legal_opinion']).default('chat'),page:CaseAssistPageSchema,
});
export type CaseAssistTurnRequest=z.infer<typeof CaseAssistTurnRequestSchema>;
export const ApplyCaseAssistProposalSchema=z.strictObject({
  contentHash:z.string().regex(/^[a-f0-9]{64}$/),expectedRevision:z.number().int().positive(),idempotencyKey:z.string().min(8).max(200),
  /** Reviewer may tighten the wording; scope and kind stay as proposed. */
  statement:z.string().trim().min(4).max(500).optional(),
});
export const CancelCaseAssistProposalSchema=z.strictObject({idempotencyKey:z.string().min(8).max(200)});

// ---- Model contract (after privacy projection) ----------------------------

export const CaseAssistIntentSchema=z.enum(['locate','explain','summarize','document','fill_field','feedback_rule','rule_summary','rule_digest','legal_opinion','clarify','unsupported']);
export type CaseAssistIntent=z.infer<typeof CaseAssistIntentSchema>;
const fieldRef=z.string().regex(/^F\d{1,3}$/);
const ruleRef=z.string().regex(/^(?:R|G)\d{1,3}$/);
/** B = built-in draft baseline awaiting business/legal confirmation. */
const baselineRef=z.string().regex(/^(?:R|G|B)\d{1,3}$/);
/** Strict schema for Azure structured output: every key present, absent values are null. */
export const CaseAssistModelOutputSchema=z.strictObject({
  intent:CaseAssistIntentSchema,
  reply:z.string().trim().min(1).max(2000),
  targets:z.array(fieldRef).max(5),
  question:z.string().trim().min(1).max(300).nullable(),
  /** Verbatim passages of the open file behind the reply; empty when no file text was supplied. */
  quotes:z.array(z.strictObject({sourceRef:z.string().min(1).max(40),quote:z.string().trim().min(1).max(400)})).max(3),
  /** Values read from the open file for its fields: to fill an empty field, or to correct one the reviewer says is wrong.
   * Shown to the reviewer for confirmation, never written by the model. */
  fieldValues:z.array(z.strictObject({fieldRef,value:z.string().trim().min(1).max(2000),sourceRef:z.string().min(1).max(40),quote:z.string().trim().min(1).max(1000)})).max(5),
  ruleCandidate:z.strictObject({
    kind:SemanticGuidanceKindSchema,statement:z.string().trim().min(4).max(500),
    fieldRefs:z.array(fieldRef).max(10),expressions:z.array(z.string().trim().min(1).max(300)).max(10),
    replaces:ruleRef.nullable(),
  }).nullable(),
});
export type CaseAssistModelOutput=z.infer<typeof CaseAssistModelOutputSchema>;
export const CaseAssistLegalOutputSchema=z.strictObject({
  reply:z.string().trim().min(1).max(1500),
  points:z.array(z.strictObject({
    category:z.enum(['assumption','condition','qualification','baseline']),
    summary:z.string().trim().min(1).max(500),
    sourceRef:z.string().min(1).max(40),quote:z.string().min(1).max(1000),
    baselineRef:baselineRef.nullable(),
  })).max(20),
});
export type CaseAssistLegalOutput=z.infer<typeof CaseAssistLegalOutputSchema>;

// ---- Views -----------------------------------------------------------------

export interface CaseAssistTarget {rowId:string;fieldId:string;label:string;objectLabel:string;status:string;roundId:string|null;evidence:ReviewEvidence|null}
interface CaseAssistProposalBase {id:string;state:'pending'|'applied'|'canceled'|'expired'|'stale'|'superseded';contentHash:string;caseRevision:number;expiresAt:string;guidanceId:string|null;notes:string[]}
export interface CaseAssistGuidanceProposal extends CaseAssistProposalBase {kind:'guidance';
  body:SemanticGuidanceBody&{quote:string;replaces:string|null;replacesLabel:string|null;fieldLabels:string[]}}
/** The file, field, value and the verbatim passage it was read from. */
export interface CaseAssistFieldValueBody {documentId:string;filename:string;fieldId:string;rowId:string;fieldLabel:string;objectLabel:string;value:string;quote:string;evidence:ReviewEvidence;
  /** The file's current values for this field when the proposal corrects them; absent when it fills an empty field. */
  replaces?:string[]}
export interface CaseAssistFieldValueProposal extends CaseAssistProposalBase {kind:'field_value';body:CaseAssistFieldValueBody;
  /** For an applied proposal: whether its value is still the one in place for that file and field. False once it was withdrawn or replaced. Absent on older servers. */
  inPlace?:boolean}
export type CaseAssistProposalView=CaseAssistGuidanceProposal|CaseAssistFieldValueProposal;
export interface CaseAssistLegalPoint {category:'assumption'|'condition'|'qualification'|'baseline';summary:string;quote:string;filename:string;evidence:ReviewEvidence|null;baselineLabel:string|null}
export type CaseAssistCard=
  |{kind:'targets';items:CaseAssistTarget[]}
  |{kind:'choices';question:string;items:CaseAssistTarget[]}
  |{kind:'proposal';proposalId:string}
  |{kind:'rules';active:CaseGuidance[];releaseCount:number;pendingProposalIds:string[];nextRunLabels:string[]}
  |{kind:'digest';digest:Pick<GuidanceDigestView,'id'|'state'|'trigger'>&{entryCount:number}}
  |{kind:'legal';documents:string[];points:CaseAssistLegalPoint[];limitations:string[]}
  /** Passages checked verbatim against the open file's own text. */
  |{kind:'quotes';filename:string;items:Array<{quote:string;evidence:ReviewEvidence|null}>}
  |{kind:'action';action:'legal_opinion'|'rule_digest'|'recheck';label:string};
export interface CaseAssistTurnView {
  id:string;clientTurnId:string;mode:'chat'|'legal_opinion';text:string;state:'pending'|'running'|'ready'|'failed'|'unknown'|'canceled';
  createdAt:string;caseRevision:number;roundId:string|null;roundNumber:number|null;
  reply:{intent:CaseAssistIntent;text:string;cards:CaseAssistCard[];notes:string[]}|null;
  errorCode:string|null;
}
export interface CaseAssistantState {
  caseId:string;available:boolean;reason:string|null;model:string|null;
  conversationId:string|null;turns:CaseAssistTurnView[];proposals:CaseAssistProposalView[];
  allowedActions:string[];
}
