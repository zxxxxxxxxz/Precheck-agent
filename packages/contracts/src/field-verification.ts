import {z} from 'zod';
import type {ReviewEvidence} from './review.js';
import type {ReviewFacts} from './review-config.js';
import {ReviewCommandSchema,ReviewEvidenceSchema} from './review.js';
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const FieldReviewPinSchema=z.strictObject({documentId:z.uuid(),parseRevision:z.uuid(),directoryRevision:z.number().int().positive(),fieldsHash:hash});
export const FieldReviewSourceSchema=z.strictObject({filename:z.string().min(1).max(300),page:z.number().int().positive(),evidence:ReviewEvidenceSchema,
 kind:z.enum(['original','extraction']).default('original'),comparisonKey:z.string().min(1).max(100).nullable().optional(),quote:z.string().min(1).max(16000),value:z.string().max(8000),highlights:z.array(z.string().min(1).max(300)).max(30)});
export const FieldReviewItemSchema=z.strictObject({rowId:z.string().min(1).max(500),fieldId:z.string().min(1).max(200),objectId:z.uuid().nullable(),
 meaning:z.enum(['consistent','different','pending','not_applicable']),scope:z.enum(['cross_file','source_check','bank_rule']),reason:z.string().min(1).max(2500),
 actions:z.array(z.string().min(1).max(1500)).max(15),sources:z.array(FieldReviewSourceSchema).max(40)});
export const FieldCorrectionSchema=z.strictObject({documentId:z.uuid(),fieldId:z.string().min(1).max(200),before:z.string().min(1).max(2000),after:z.string().min(1).max(2000),source:FieldReviewSourceSchema,reason:z.string().min(1).max(1000)});
export const SaveFieldReviewSchema=ReviewCommandSchema.extend({configurationReleaseId:z.string().min(1).max(100),pins:z.array(FieldReviewPinSchema).min(1).max(100),items:z.array(FieldReviewItemSchema).min(1).max(500),corrections:z.array(FieldCorrectionSchema).max(100),
 provenance:z.strictObject({kind:z.literal('source_review'),method:z.string().min(1).max(500),reference:z.string().min(1).max(200)})}).strict();
export type FieldReviewItem=z.infer<typeof FieldReviewItemSchema>;
export type FieldReviewPin=z.infer<typeof FieldReviewPinSchema>;
export type FieldCorrection=z.infer<typeof FieldCorrectionSchema>;
export type SaveFieldReview=z.infer<typeof SaveFieldReviewSchema>;
export type FieldReviewStatus='confirmed'|'consistent'|'different'|'pending'|'not_applicable';
export interface FieldVerification extends FieldReviewItem {origin?:'automatic';pendingKind?:'manual'|'incomplete';status:FieldReviewStatus;recordId:string;recordedAt:string|null;caseRevision:number;validity:'current'|'stale';corrections:FieldCorrection[]}
/** Server-executed checks pinned to the run, not human confirmations or fact adoption. */
export interface AutomaticReviewCheck {id:string;fieldId:string;objectId:string|null;ruleIds:string[];status:'done'|'open'|'confirm'|'incomplete';reason:string;item:FieldReviewItem;task?:{kind:'customer'|'bank'|'system'|'notice';group:string};execution?:{version:string;referenceHashes:string[];evidence:ReviewEvidence[];signatureRegions?:Array<{evidence:ReviewEvidence;pageNumber:number;sourceSha256:string;renderSha256:string;box:{x:number;y:number;width:number;height:number}}>}}
/** Server-derived execution inputs, distinct from a saved person/object approval.
 * Frozen with a new run; absent on historical snapshots. */
export interface ReviewedRuleInputs {
 policyVersion:'reviewed-rule-inputs-v1';scopeId:string;role:'corporate_guarantee';configurationReleaseId:string;
 documentIds:string[];bindingEvidence:ReviewEvidence[];
 inputs:Record<string,{fact:ReviewFacts[string];fieldIds:string[];recordIds:string[];evidence:ReviewEvidence[]}>;
 gaps:Array<{fieldId:string;reason:string}>;
}
/** Frozen with a review run; a source comparison is not adoption or business approval. */
export interface FrozenFieldReview {id:string;fieldId:string;label:string;objectId:string|null;objectLabel:string;materialTypes:Array<{id:string;label:string}>;verification:FieldVerification}
/** A reviewed observation is a source fact, not a claim that two texts are identical.
 * Uses the existing comparison key so old readers conservatively retain pending. */
export function isVerifiedSourceFact(item:FieldReviewItem):boolean {
 const primary=item.sources.filter(s=>s.comparisonKey!==null);
 return item.meaning==='consistent'&&item.scope==='source_check'&&!item.actions.length&&primary.length===1
  &&primary[0]!.comparisonKey==='observed-fact'&&primary[0]!.kind==='original'
  &&!!primary[0]!.value.trim()&&primary[0]!.quote.includes(primary[0]!.value);
}
/** A status describes this field comparison, never adoption of a fact or approval. */
export function fieldReviewStatus(item:FieldReviewItem):FieldReviewStatus{
 if(item.meaning==='not_applicable')return 'not_applicable';
 if(item.scope==='bank_rule')return item.meaning==='pending'?'pending':item.meaning==='different'?'different':'consistent';
 if(item.meaning==='pending'||!item.sources.length)return 'pending';
 if(item.meaning==='different')return 'different';
 if(isVerifiedSourceFact(item))return 'confirmed';
 // One source alone cannot establish literal identity. source_check supplies
 // both extraction and its original wording, with the same source locator.
 const groups=new Map<string,typeof item.sources>();
 for(const source of item.sources){if(source.comparisonKey===null)continue;const key=source.comparisonKey??'field';groups.set(key,[...(groups.get(key)??[]),source]);}
 if(!groups.size||[...groups.values()].some(s=>s.length<2||s.some(v=>!v.value.trim())))return 'pending';
 return [...groups.values()].every(s=>s.every(v=>v.value.trim()===s[0]!.value.trim()))?'confirmed':'consistent';
}
