import {z} from 'zod';
import {ReviewCommandSchema, ReviewEvidenceSchema, type ReviewObject} from './review.js';
import {SignatureBoxSchema, SignatureMarkKindSchema, SignatureRequirementSchema, type SignatureRequirementRecord, type SignatureBox} from './signature-review.js';

const id=z.string().min(1).max(200), label=z.string().trim().min(1).max(300);
const refs=z.array(ReviewEvidenceSchema).max(100);
const status=z.enum(['pending','confirmed','excluded']);
export const SignatureDateKindSchema=z.enum(['document_signing','person_signing','location_signing','resolution','authorization_from','authorization_until','other']);
export const SignatureLocationSchema=z.strictObject({
  id,label,logicalDocumentId:id,fieldId:id.nullable(),pageNumber:z.number().int().positive(),
  box:SignatureBoxSchema.nullable(),coverage:z.enum(['unchecked','complete','uncertain']),evidence:refs,
});
export const SignatureEntrySchema=z.strictObject({
  id,locationId:id,kind:SignatureMarkKindSchema,box:SignatureBoxSchema.nullable(),
  status,duplicateOf:id.nullable(),personId:z.uuid().nullable(),subjectId:z.uuid().nullable(),
  role:id.nullable(),additionalRoles:z.array(id).max(30).optional(),capacity:z.enum(['unknown','representative','self']).default('unknown'),identityConfirmed:z.boolean(),authorizationIds:z.array(id).max(100),
  evidence:refs,sourceObservationId:id.nullable(),note:z.string().max(1000),
});
export const SignatureDateRecordSchema=z.strictObject({
  id,kind:SignatureDateKindSchema,targetType:z.enum(['document','location','entry','authorization']),targetId:id.nullable(),
  rawValue:z.string().max(300),normalizedValue:z.string().nullable(),calendar:z.enum(['gregorian','roc']),
  status,evidence:refs,
});
export const SignatureAuthorizationRecordSchema=z.strictObject({
  id,label,subjectId:z.uuid(),personIds:z.array(z.uuid()).max(100),roles:z.array(id).max(30),
  logicalDocumentIds:z.array(id).min(1).max(100),status,evidence:refs,
  maxAmount:z.string().regex(/^\d+(\.\d+)?$/).nullable(),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),
  transactionTypes:z.array(id).max(100),
});
const dateSelector=z.strictObject({kind:SignatureDateKindSchema,targetType:z.enum(['document','location','entry','authorization']),targetId:id});
export const SignatureDateRuleSchema=z.strictObject({
  id,label,status:z.enum(['pending','confirmed','excluded']),evidence:refs,
  operation:z.enum(['required','blank','before','not_after','equal','after','not_before']),
  left:dateSelector,right:dateSelector.nullable(),
});
export const ScopedSignatureRequirementSchema=z.strictObject({
  id,requirement:SignatureRequirementSchema,sourceRequirementId:id.nullable(),
  status,mandatory:z.boolean(),logicalDocumentId:id,subjectId:z.uuid(),
  scope:z.enum(['document','each_location']),locationIds:z.array(id).max(100),
  distinctPeople:z.boolean(),entryIds:z.array(id).max(1000),evidence:refs,
  transaction:z.strictObject({amount:z.string().regex(/^\d+(\.\d+)?$/).nullable(),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),type:id.nullable(),evidence:refs}),
});
export const SignatureInformationStateSchema=z.strictObject({
  locations:z.array(SignatureLocationSchema).max(500),entries:z.array(SignatureEntrySchema).max(1000),
  dates:z.array(SignatureDateRecordSchema).max(1000),authorizations:z.array(SignatureAuthorizationRecordSchema).max(500),
  requirements:z.array(ScopedSignatureRequirementSchema).max(500),dateRules:z.array(SignatureDateRuleSchema).max(500),
});
export const SignatureInformationCommandSchema=ReviewCommandSchema.extend({
  parseRevision:z.uuid(),expectedDirectoryRevision:z.number().int().positive(),expectedVersion:z.number().int().nonnegative(),
  expectedInputHash:z.string().regex(/^[a-f0-9]{64}$/),state:SignatureInformationStateSchema,
});
export type SignatureInformationState=z.infer<typeof SignatureInformationStateSchema>;
export type SignatureLocation=z.infer<typeof SignatureLocationSchema>;
export type SignatureEntry=z.infer<typeof SignatureEntrySchema>;
export type SignatureDateRecord=z.infer<typeof SignatureDateRecordSchema>;
export type SignatureAuthorizationRecord=z.infer<typeof SignatureAuthorizationRecordSchema>;
export type ScopedSignatureRequirement=z.infer<typeof ScopedSignatureRequirementSchema>;
export interface SignatureInformationCheck {
  id:string;label:string;requirementId:string|null;locationId:string|null;entryIds:string[];
  status:'satisfied'|'needs_confirmation'|'not_satisfied'|'not_applicable';mandatory:boolean;
  reasons:string[];evidence:z.infer<typeof ReviewEvidenceSchema>[];
}
export interface SignatureInformationEvaluation {
  checks:SignatureInformationCheck[];
  counts:{signatures:number;people:number;satisfied:number;pending:number};
  blocking:boolean;
}
export interface SignatureInformationCandidate {
  id:string;fieldId:string;label:string;value:string|null;normalizedValue:string|null;
  kind:'person'|'subject'|'role'|'date'|'authorization';dateKind:z.infer<typeof SignatureDateKindSchema>|null;
  logicalDocumentId:string|null;pageNumbers:number[];evidence:z.infer<typeof ReviewEvidenceSchema>[];
  origin:'automatic_candidate'|'adopted_fact';candidateId:string|null;factId:string|null;objectId:string|null;suggestedObjectIds?:string[];
}
export interface SignatureInformationProjection {
  schemaVersion:'signature-information.v1';caseId:string;documentId:string;parseRevision:string;directoryRevision:number;
  sourceSha256:string;roundId:string|null;caseRevision:number;inputHash:string;version:number;recordId:string|null;
  validity:'current'|'stale';readOnly:boolean;storageAvailable:boolean;
  locations:Array<{id:string;label:string;taxonomyId:string|null;pageNumbers:number[]}>;
  pages:Array<{pageNumber:number;width:number;height:number;imageSha256:string}>;
  objects:ReviewObject[];candidates:SignatureInformationCandidate[];requirementCandidates:SignatureRequirementRecord[];
  automatic?: AutomaticSignatureInformation;
  state:SignatureInformationState;evaluation:SignatureInformationEvaluation;
  history:Array<{id:string;version:number;createdAt:string;actorId:string;reason:string}>;
}
/** Source extraction, independent of saved human decisions and legal sufficiency. */
export interface AutomaticSignatureValue {
  label:string;value:string;evidence:z.infer<typeof ReviewEvidenceSchema>[];box:SignatureBox|null;
}
export interface AutomaticSignatureRecord {
  label?:string;
  purpose?:'execution'|'specimen';
  id:string;pageNumber:number;box:SignatureBox;presence:'handwriting'|'graphic'|'blank'|'printed'|'stamp'|'unknown';
  name:AutomaticSignatureValue|null;role:AutomaticSignatureValue|null;number:AutomaticSignatureValue|null;
  /** Address from the same explicitly labelled signing column. */
  address?:AutomaticSignatureValue|null;
  /** A source association candidate, never a confirmed person identity. */
  numberAssociation?:{recordId:string;method:'unique_same_page_specimen_name_and_capacity'};
  dates:AutomaticSignatureValue[];evidence:z.infer<typeof ReviewEvidenceSchema>[];uncertainText:boolean;
}
export interface AutomaticSignatureInformation {
  version:'source-signature-blocks-v1';documentId:string;parseRevision:string;sourceSha256:string;
  records:AutomaticSignatureRecord[];dates:Array<AutomaticSignatureValue & {pageNumber:number}>;
  coverage:{processedPages:number[];unavailablePages:number[]};
}
export interface SignatureInformationSummary {
  documentId:string;filename:string;recordId:string;version:number;inputHash:string;validity:'current'|'stale';
  state:SignatureInformationState;evaluation:SignatureInformationEvaluation;
}
export const emptySignatureInformation=():SignatureInformationState=>({locations:[],entries:[],dates:[],authorizations:[],requirements:[],dateRules:[]});
