import {z} from 'zod';
import {ReviewCommandSchema} from './review.js';
import {SemanticGuidanceBodySchema,SemanticGuidanceKindSchema} from './review-config.js';

export {SemanticGuidanceKindSchema,SemanticGuidanceBodySchema};
export type SemanticGuidanceKind=z.infer<typeof SemanticGuidanceKindSchema>;
export type SemanticGuidanceBody=z.infer<typeof SemanticGuidanceBodySchema>;

export const SEMANTIC_GUIDANCE_KIND_LABELS:Record<SemanticGuidanceKind,string>={
  name_equivalence:'名称等同',wording_tolerance:'可接受的表述差异',legal_baseline:'法律意见书底线',focus_note:'重点提示',
};
/** Kinds that may change a cross-file semantic conclusion. Others only inform reading. */
export const COMPARISON_GUIDANCE_KINDS:readonly SemanticGuidanceKind[]=['name_equivalence','wording_tolerance'];

export const SaveCaseGuidanceSchema=ReviewCommandSchema.extend({
  ...SemanticGuidanceBodySchema.shape,
  fieldIds:SemanticGuidanceBodySchema.shape.fieldIds.default([]),
  expressions:SemanticGuidanceBodySchema.shape.expressions.default([]),
  quote:z.string().trim().min(1).max(2000).optional(),
  replaces:z.uuid().optional(),
});
export type SaveCaseGuidance=z.infer<typeof SaveCaseGuidanceSchema>;
export const RetireCaseGuidanceSchema=ReviewCommandSchema;

export interface CaseGuidance extends SemanticGuidanceBody {
  id:string;number:number;label:string;status:'active'|'retired';
  origin:{kind:'manual'|'assistant';quote?:string;proposalId?:string};
  createdBy:string;createdByName?:string;createdAt:string;roundId:string|null;roundNumber:number|null;caseRevision:number;
  supersedes:string|null;retiredAt?:string;retireReason?:string;
  /** Published rule-centre entries that adopted this case rule. */
  adoptions:Array<{releaseId:string;entryId:string}>;
}
/** Deterministic projection attached to checks and frozen in snapshots; no timestamps. */
export interface GuidanceRef {ref:string;source:'case'|'release';label:string;kind:SemanticGuidanceKind;statement:string;fieldIds:string[];expressions:string[]}

export const caseGuidanceLabel=(number:number)=>`本案规则 #${number}`;
export const releaseGuidanceLabel=(index:number)=>`规则中心口径 G-${index+1}`;

/** Same NFKC/whitespace/case folding as the literal cross-file comparison. */
export const guidanceTextKey=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/gu,' ').toUpperCase();

/** Content identity, used to deduplicate case rules already published centrally. */
export function guidanceContentKey(body:Pick<SemanticGuidanceBody,'kind'|'statement'|'fieldIds'|'expressions'>):string {
  return JSON.stringify([body.kind,guidanceTextKey(body.statement),[...body.fieldIds].sort(),[...new Set(body.expressions.map(guidanceTextKey))].sort()]);
}

// ---- Rule-centre digest -------------------------------------------------

export const GuidanceDigestDispositionSchema=z.enum(['adopt','merge','conflict','case_only']);
export const GuidanceDigestEntrySchema=z.strictObject({
  guidanceId:z.uuid(),label:z.string().min(1).max(100),body:SemanticGuidanceBodySchema,
  /** Runs of this case whose frozen checks applied the rule. */
  usedInRunIds:z.array(z.uuid()).max(100),appliedCheckCount:z.number().int().min(0),
  disposition:GuidanceDigestDispositionSchema,relatedEntryId:z.string().min(1).max(128).nullable(),
  reason:z.string().min(1).max(1000),suggestedStatement:z.string().trim().min(4).max(500),
  method:z.enum(['deterministic','model']),
});
export type GuidanceDigestEntry=z.infer<typeof GuidanceDigestEntrySchema>;
export const GuidanceDigestBodySchema=z.strictObject({
  version:z.literal('guidance-digest.v1'),baseReleaseId:z.string().min(1).max(100),
  entries:z.array(GuidanceDigestEntrySchema).max(100),
  /** Active rules the reviewer kept but that no frozen result used. Never proposed. */
  unused:z.array(z.strictObject({guidanceId:z.uuid(),label:z.string().min(1).max(100),statement:z.string().min(1).max(500)})).max(100),
  limitations:z.array(z.string().min(1).max(500)).max(20),
});
export type GuidanceDigestBody=z.infer<typeof GuidanceDigestBodySchema>;
export interface GuidanceDigestView {
  id:string;caseId:string;caseNumber:string|null;caseTitle:string;roundId:string|null;roundNumber:number|null;runId:string|null;
  baseReleaseId:string;trigger:'round_confirmed'|'manual';state:'pending'|'running'|'ready'|'adopted'|'declined'|'failed';
  body:GuidanceDigestBody|null;errorCode:string|null;createdAt:string;
  adoption:{draftId:string|null;releaseId:string|null;step:string|null;errorCode:string|null;entryIds:string[]}|null;
  allowedActions:string[];
}
export const GuidanceDigestRequestSchema=ReviewCommandSchema;
export const AdoptGuidanceDigestSchema=z.strictObject({
  idempotencyKey:z.string().min(8).max(200),guidanceIds:z.array(z.uuid()).min(1).max(100),
  /** Optional reviewer wording, keyed by guidance id; defaults to the suggested statement. */
  statements:z.record(z.uuid(),z.string().trim().min(4).max(500)).default({}),
  label:z.string().trim().min(1).max(200).optional(),
});
export type AdoptGuidanceDigest=z.infer<typeof AdoptGuidanceDigestSchema>;
export const DeclineGuidanceDigestSchema=z.strictObject({idempotencyKey:z.string().min(8).max(200),reason:z.string().trim().min(1).max(1000)});
