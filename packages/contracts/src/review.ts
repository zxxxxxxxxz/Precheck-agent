import { z } from 'zod';
import { CompanyNameSelectionSchema } from './company-identity.js';
import type {SignatureInformationSummary} from './signature-information.js';
import type {CaseGuidance} from './review-guidance.js';

const id=z.string().min(1).max(200);
export const ReviewCommandSchema=z.strictObject({roundId:z.uuid().optional(),expectedRevision:z.number().int().positive(),idempotencyKey:z.string().min(8).max(200),reason:z.string().trim().min(1).max(1000)});
export const ReviewMaterialScopeSchema=z.strictObject({logicalDocumentId:id.nullable()});
export const ReviewMaterialTargetSchema=ReviewMaterialScopeSchema.extend({caseRevision:z.number().int().positive()});
export const ReviewEvidenceSchema=z.strictObject({materialScope:ReviewMaterialScopeSchema.optional(),documentVersionId:z.uuid(),parseRevision:z.uuid(),directoryRevision:z.number().int().positive().nullable(),anchorId:id.optional(),sourceNodeId:id.optional()}).refine(e=>Boolean(e.anchorId)!==Boolean(e.sourceNodeId),'exactly_one_evidence_locator');
export type ReviewEvidence=z.infer<typeof ReviewEvidenceSchema>;
export const ReviewObjectSchema=z.strictObject({objectId:z.uuid().optional(),kind:z.enum(['party','financing','guarantee','collateral','policy','signatory']),label:z.string().trim().min(1).max(300),role:z.string().regex(/^[a-z][a-z0-9_]*$/).max(128),relations:z.array(z.strictObject({kind:id,targetObjectId:z.uuid(),targetVersion:z.number().int().positive().optional()})).max(100).default([]),evidence:z.array(ReviewEvidenceSchema).max(2000).default([]),companyNameSelection:CompanyNameSelectionSchema.optional()});
export const ReviewFactSchema=z.strictObject({factId:z.uuid().optional(),objectId:z.uuid(),fieldId:id,state:z.enum(['present','redacted','missing','unreadable','not_applicable','expected_blank','pending']),rawValue:z.string().max(10000).nullable(),currency:z.string().max(10).optional(),unit:z.string().max(20).optional(),calendar:z.enum(['gregorian','roc']).optional(),evidence:z.array(ReviewEvidenceSchema).max(100),candidateRef:z.strictObject({observationId:id,candidateId:id,projectionHash:z.string().regex(/^[a-f0-9]{64}$/)}).optional()});
export const ReviewMaterialSchema=z.strictObject({intent:z.enum(['add_scope','edit','refresh']).optional(),target:ReviewMaterialTargetSchema.optional(),expectedSourceHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),operation:z.enum(['adopt','reject']),documentVersionId:z.uuid(),documentTypeId:id,logicalDocumentId:id.optional(),relation:z.strictObject({kind:z.enum(['original','replacement','amendment','supplement']),predecessorDocumentVersionId:z.uuid().optional(),effectiveDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),sequence:z.number().int().positive().optional()}).optional()});
export const ReviewReplySchema=z.strictObject({text:z.string().trim().min(1).max(10000),externalAuthor:z.string().trim().min(1).max(300),externalRole:z.string().trim().min(1).max(100),channel:z.string().trim().min(1).max(100),receivedAt:z.iso.datetime()});
export type ReviewObjectInput=z.infer<typeof ReviewObjectSchema>;
export type ReviewFactInput=z.infer<typeof ReviewFactSchema>;
export interface AutomaticMaterialAttribution {
  policyVersion:'source-party-attribution-v1'; identityKey:string; inputHash:string;
  candidateIds:string[]; sourceHashes:string[]; basis:ReviewEvidence[];
  /** Present when the subject was confirmed by the reviewer before files were attached to it. */
  confirmedSubjectId?:string;
}
export interface ReviewObject extends Omit<ReviewObjectInput,'objectId'>{objectId:string;version:number;validity:'current'|'stale';confirmedBy:string|null;caseRevision:number;automaticAttribution?:AutomaticMaterialAttribution}
/** v2 accepts a grounded value whose only remaining receipts concern completeness of the reading or format caveats of its file. */
export interface AutomaticFieldAdoption {kind:'extraction';policyVersion:'grounded-field-acceptance-v1'|'grounded-field-acceptance-v2';observationIds:string[];sourceHashes:string[];values:string[]}
export interface ReviewFact extends Omit<ReviewFactInput,'factId'>{factId:string;version:number;validity:'current'|'stale';definitionHash?:string;normalizedValue:string|boolean|null;normalization:{status:'normalized'|'pending'|'not_needed';reasonCode:string;currency:string|null;unit:string|null};confirmedBy:string|null;caseRevision:number;automaticAdoption?:AutomaticFieldAdoption}
export interface ReviewMaterial {documentVersionId:string;documentTypeId:string;logicalDocumentId:string|null;operation:'adopt'|'reject'|'superseded';sourceFormat:'pdf'|'docx'|'jpg'|'png';sourceSha256:string;parseRevision:string|null;directoryRevision:number|null;artifactHash:string|null;sourceStructureHash:string|null;projectionHash:string|null;projectionJobId:string|null;relation:z.infer<typeof ReviewMaterialSchema>['relation'];caseRevision:number}
/** Live source metadata only; never persisted into a review snapshot. */
export interface ReviewMaterialSource {
 filename:string;documentVersionId:string;parseRevision:string|null;directoryRevision:number|null;artifactHash:string|null;sourceStructureHash:string|null;projectionHash:string|null;projectionJobId:string|null;
 snapshotHash:string;ready:boolean;scopes:Array<{id:string;pageNumbers:number[];regionIds?:string[];sourceNodeIds?:string[]}>;
}
export interface ReviewMaterialDetail {documentVersionId:string;logicalDocumentId:string|null;caseRevision:number;pageNumbers:number[];regionIds?:string[];sourceNodeIds?:string[];
 /** Pages that no other document of the pinned directory lists; see reviewScopeWholePages. Absent on older servers. */
 wholePageNumbers?:number[];
 updateState:'current'|'available'|'processing'|'scope_missing'}
export interface ReviewRun {id:string;caseRevision:number;configurationReleaseId:string;snapshotHash:string;state:'pending'|'running'|'ready'|'failed'|'canceled'|'stale';validity:'current'|'stale';errorCode:string|null;createdAt:string;results:Array<{ruleId:string;scopeId:string;outcome:string;reasonCode:string;details?:{expiryDate:string};evidenceIds:string[];reusedFrom:string|null;
  /** Present when the system's judgement chain decided a rule the engine could only hand to a person. */
  resolution?:{version:string;engineOutcome:string;engineReasonCode:string;checkIds:string[]}}>;executionReceipts:Array<{evaluationId:string;scopeId:string;actualReleaseId:string;actualPackageHash:string;executorVersion:string;reusedFrom:string|null}>}
export interface ReviewIssue {issueId:string;version:number;ruleId:string;scopeId:string;status:'open'|'resolved'|'acknowledged';validity:'current'|'stale';latestFindingId:string;outcome:string;reasonCode:string;evidenceIds:string[];caseRevision:number}
export interface ReviewHistoryEvent {id:string;kind:string;caseRevision:number;actorPersonId:string;createdAt:string;details:Record<string,unknown>}
export interface ReviewSupplement {id:string;issueId:string;documentVersionId:string;parseRevision:string;fieldIds:string[];state:'pending'|'running'|'requested'|'failed'|'canceled';jobId:string|null;errorCode:string|null;createdAt:string}
/** Read-only preparation projection. Provided materials are not an approval. */
export interface MaterialPreparationItem {
 materialId:string; scopeId:string; objectLabel:string|null;
 requirement:'required'|'optional'|'not_applicable'|'unknown';
 status:'provided'|'missing'|'pending'|'optional'|'not_applicable';
 documentVersionIds:string[];
}
export interface ReviewState {materialPreparation?:MaterialPreparationItem[];materialScope?:'file-list';materialCount?:number;roundId?:string|null;roundNumber?:number|null;roundsEnabled?:boolean;legacyView?:boolean;readOnly?:boolean;caseId:string;revision:number;configurationReleaseId:string|null;businessDate:string|null;objects:ReviewObject[];facts:ReviewFact[];materials:ReviewMaterial[];runs:ReviewRun[];issues:ReviewIssue[];history:ReviewHistoryEvent[];supplements:ReviewSupplement[];allowedActions:string[];
 configuration:{releaseId:string;label:string;fields:Array<{id:string;label:string;type:string;objectKind:string;objectRole?:string;unit:string|null;currency:string|null}>;taxonomy:Array<{id:string;label:string}>;materials:Array<{id:string;label:string;taxonomyId:string;objectRole?:string}>;rules:Array<{id:string;label:string;description?:string;sourceReferences:string[];inputFieldIds:string[]}>}|null;
 /** Read-only confirmation receipts; absent for older servers. Never added to stored snapshots. */
 materialSources?:ReviewMaterialSource[];
 materialDetails?:ReviewMaterialDetail[];
 factRecords?:Array<{factId:string;version:number;origin:'automatic_candidate'|'manual'|'unknown';confirmedBy:string;confirmedByName?:string;confirmedAt:string;caseRevision:number}>;
 guaranteeTypes?:string[];
 signatureInformation?:SignatureInformationSummary[];
 availableConfigurations:Array<{releaseId:string;label:string;guaranteeTypes?:string[];scope?:'bank'|'synthetic';publishedAt?:string}>;
 /** Case-level judgement rules, including retired ones for history. Absent on older servers. */
 guidance?:CaseGuidance[];
}

/** A directory assigns every canonical region of a page to exactly one document. A page that no other
 * document of the same directory lists therefore belongs wholly to this one, including duplicate and
 * alternative OCR regions that never appear in a region list. Shared pages still need the region list. */
export function reviewScopeWholePages(scope:{id:string;pageNumbers?:readonly number[]},directory:ReadonlyArray<{id:string;pageNumbers?:readonly number[]}>):number[] {
 return [...new Set(scope.pageNumbers??[])].filter(page=>!directory.some(other=>other.id!==scope.id&&other.pageNumbers?.includes(page)));
}
/** Shared display/validation boundary; the service still verifies the fixed source and permissions. */
export function reviewEvidenceInScope(scope:{pageNumbers:number[];regionIds?:string[];sourceNodeIds?:string[];wholePageNumbers?:number[]},anchor?:{page_number:number;block_ids?:readonly string[]},sourceNodeId?:string):boolean {
 if(!anchor)return Boolean(sourceNodeId&&scope.sourceNodeIds?.includes(sourceNodeId));
 if(!scope.pageNumbers.includes(anchor.page_number))return false;
 if(scope.wholePageNumbers?.includes(anchor.page_number))return true;
 return !scope.regionIds?.length||Boolean(anchor.block_ids?.length&&anchor.block_ids.every(id=>scope.regionIds!.includes(id)));
}
