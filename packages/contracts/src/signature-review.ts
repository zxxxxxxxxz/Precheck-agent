import { z } from 'zod';

const id=z.string().min(1).max(200),sha=z.string().regex(/^[a-f0-9]{64}$/),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const SignatureMarkKindSchema=z.enum(['handwriting','stamp','blank_signing_slot','printed_name','uncertain']);
export const SignatureBoxSchema=z.strictObject({x:z.number().nonnegative(),y:z.number().nonnegative(),width:z.number().positive(),height:z.number().positive()});
export type SignatureBox=z.infer<typeof SignatureBoxSchema>;
export const SignatureObservationSchema=z.strictObject({
  id,pageNumber:z.number().int().positive(),kind:SignatureMarkKindSchema,confidence:z.number().min(0).max(1),
  box:SignatureBoxSchema,imageSha256:sha,cropSha256:sha,sourceSha256:sha,parseRevision:id,
  coordinateSpace:z.literal('page_image'),imageWidth:z.number().int().positive(),imageHeight:z.number().int().positive(),
  cropTransform:z.strictObject({offsetX:z.number().nonnegative(),offsetY:z.number().nonnegative(),scaleX:z.number().positive(),scaleY:z.number().positive()}),
  model:id,modelVersion:id,promptVersion:id,anchorIds:z.array(id),coverageGaps:z.array(id),
}).superRefine((value,context)=>{if(value.box.x+value.box.width>value.imageWidth||value.box.y+value.box.height>value.imageHeight||value.cropTransform.offsetX>value.imageWidth||value.cropTransform.offsetY>value.imageHeight)context.addIssue({code:'custom',message:'signature_geometry_outside_page'});});
export type SignatureObservation=z.infer<typeof SignatureObservationSchema>;
export type SignatureRequirementExpression =
  | {kind:'signers';roles:string[];minimum:number;mark:'signature'|'stamp'|'signature_and_stamp'|'signature_or_stamp'}
  | {kind:'allOf'|'anyOf';children:SignatureRequirementExpression[]};
const RawSignatureRequirementExpressionSchema:z.ZodType<SignatureRequirementExpression>=z.lazy(()=>z.union([
  z.strictObject({kind:z.literal('signers'),roles:z.array(id).max(30),minimum:z.number().int().min(1).max(20),mark:z.enum(['signature','stamp','signature_and_stamp','signature_or_stamp'])}),
  z.strictObject({kind:z.enum(['allOf','anyOf']),children:z.array(RawSignatureRequirementExpressionSchema).min(1).max(20)}),
 ]));
export const SignatureRequirementExpressionSchema:z.ZodType<SignatureRequirementExpression>=z.custom<unknown>((value)=>{
  const pending:Array<{value:unknown;depth:number}>=[{value,depth:0}];let count=0;
  while(pending.length){const item=pending.pop()!;if(++count>200||item.depth>8)return false;const node=item.value;if(node&&typeof node==='object'&&'children'in node&&Array.isArray(node.children))for(const child of node.children)pending.push({value:child,depth:item.depth+1});}
  return true;
},'signature_requirement_too_complex').pipe(RawSignatureRequirementExpressionSchema);
export const SignatureAuthorizationConditionsSchema=z.strictObject({requireEvidence:z.boolean(),checkDate:z.boolean(),checkAmount:z.boolean(),checkTransaction:z.boolean()});
export const SignatureRequirementSchema=z.strictObject({
  id,label:z.string().min(1).max(300),subjectRole:id,taxonomyIds:z.array(id).min(1).max(200),sourceIds:z.array(id).min(1).max(100),
  expression:SignatureRequirementExpressionSchema,authorization:SignatureAuthorizationConditionsSchema,
});
export type SignatureRequirement=z.infer<typeof SignatureRequirementSchema>;
export const SignatureRequirementRecordSchema=z.strictObject({requirement:SignatureRequirementSchema,source:z.enum(['published_configuration','document_clause']),status:z.enum(['authoritative','candidate','adopted','excluded']),anchorIds:z.array(id),pageNumbers:z.array(z.number().int().positive()),clauseText:z.string().max(8000).nullable()});
export type SignatureRequirementRecord=z.infer<typeof SignatureRequirementRecordSchema>;
export const SignatureAuthorizationSchema=z.strictObject({sourceAnchorIds:z.array(id).min(1),validFrom:date.nullable(),validUntil:date.nullable(),maxAmount:z.string().max(100).regex(/^\d+(\.\d+)?$/).nullable(),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),transactionTypes:z.array(id)});
export const SignatureIdentitySchema=z.strictObject({personId:id,subjectId:id,subjectRole:id,role:id,authorization:SignatureAuthorizationSchema.nullable()});
export const SignatureTransactionFactsSchema=z.strictObject({date:date.nullable(),amount:z.string().max(100).regex(/^\d+(\.\d+)?$/).nullable(),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),transactionType:id.nullable()});
export type SignatureTransactionFacts=z.infer<typeof SignatureTransactionFactsSchema>;
export const SignatureConfirmationSchema=z.strictObject({id,reviewId:id,observationId:id.nullable(),requirementId:id.nullable(),action:z.enum(['accept','exclude','adopt_requirement','exclude_requirement','set_transaction']),identity:SignatureIdentitySchema.nullable(),requirement:SignatureRequirementSchema.nullable(),transactionFacts:SignatureTransactionFactsSchema.nullable(),observedKind:SignatureMarkKindSchema.nullable(),actorId:id,reason:z.string().min(1).max(500),createdAt:z.string()});
export type SignatureConfirmation=z.infer<typeof SignatureConfirmationSchema>;
export const SignatureCheckSchema=z.strictObject({id,requirementId:id.nullable(),subjectRole:id,subjectId:id.nullable(),label:z.string(),status:z.enum(['satisfied','suspected_missing_signature','suspected_missing_stamp','needs_confirmation','authorization_failed','not_applicable']),reasonCodes:z.array(id),observationIds:z.array(id),anchorIds:z.array(id),pageNumbers:z.array(z.number().int().positive())});
export type SignatureCheck=z.infer<typeof SignatureCheckSchema>;
export const SignatureReviewProjectionSchema=z.strictObject({
  schemaVersion:z.literal('signature-review.v1'),enabled:z.boolean(),reviewId:id.nullable(),jobId:id.nullable(),status:z.enum(['not_started','pending','running','ready','partial','failed','canceled','stale']),validity:z.enum(['current','stale','superseded']),errorCode:id.nullable(),
  parseRevision:id,directoryRevision:z.number().int().positive(),configurationReleaseId:id.nullable(),inputSha256:sha.nullable(),sourceSha256:sha,
  history:z.array(z.strictObject({reviewId:id,createdAt:z.string(),status:z.string(),validity:z.string()})),
  observations:z.array(SignatureObservationSchema),requirements:z.array(SignatureRequirementRecordSchema),checks:z.array(SignatureCheckSchema),confirmations:z.array(SignatureConfirmationSchema),
  coverage:z.strictObject({expectedPages:z.number().int().nonnegative(),completedPages:z.array(z.number().int().positive()),uncertainPages:z.array(z.number().int().positive()),gaps:z.array(id)}),allowedActions:z.array(z.enum(['check','cancel','confirm'])),
});
export type SignatureReviewProjection=z.infer<typeof SignatureReviewProjectionSchema>;
const command=z.strictObject({roundId:z.uuid().optional(),expectedRevision:z.number().int().positive(),idempotencyKey:z.string().min(8).max(200),reason:z.string().trim().min(1).max(500)});
export const SignatureCheckCommandSchema=command.extend({parseRevision:z.uuid(),expectedDirectoryRevision:z.number().int().positive()});
export const SignatureConfirmationCommandSchema=command.extend({reviewId:z.uuid(),expectedInputSha256:sha,observationId:id.optional(),requirementId:id.optional(),action:SignatureConfirmationSchema.shape.action,identity:SignatureIdentitySchema.optional(),requirement:SignatureRequirementSchema.optional(),transactionFacts:SignatureTransactionFactsSchema.optional(),observedKind:SignatureMarkKindSchema.optional()});
export const SignatureEvaluationInputSchema=z.strictObject({
  signers:z.array(SignatureIdentitySchema.extend({signature:z.boolean(),stamp:z.boolean()})).max(1000),
  transactionFacts:SignatureTransactionFactsSchema,coverageComplete:z.boolean(),classificationKnown:z.boolean(),taxonomyIds:z.array(id).max(200),
});
export type SignatureEvaluationInput=z.infer<typeof SignatureEvaluationInputSchema>;
