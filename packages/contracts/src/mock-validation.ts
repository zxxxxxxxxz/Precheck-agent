import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
const point = z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()]);
export const MockOverlaySchema = z.strictObject({
  id: identifier,
  box: z.strictObject({ x:z.number().int().nonnegative(), y:z.number().int().nonnegative(), width:z.number().int().min(8).max(10000), height:z.number().int().min(8).max(10000) }),
  // Glyph coverage is checked against the explicitly hash-pinned runtime font.
  text: z.string().trim().min(1).max(200).refine(text=>!/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(text)),
  fontSize: z.number().int().min(8).max(144),
});
export const MockValidationCommandSchema = z.strictObject({
  expectedRevision:z.number().int().positive(), idempotencyKey:z.string().min(8).max(200), reason:z.string().trim().min(1).max(500),
  sourceParseRevision:z.uuid(), pageNumber:z.number().int().positive(), sourceSha256:hash, sourcePageSha256:hash,
  confirmedRedactionBoxes:z.literal(true), syntheticValuesConfirmed:z.literal(true),
  overlays:z.array(MockOverlaySchema).min(1).max(50),
}).superRefine((v,ctx)=>{if(new Set(v.overlays.map(o=>o.id)).size!==v.overlays.length)ctx.addIssue({code:'custom',path:['overlays'],message:'Duplicate overlay identifiers'});});
export const MockValidationResultSchema = z.strictObject({
  schemaVersion:z.literal('mock-ocr.v1'), synthetic:z.literal(true), purpose:z.literal('mock_ocr_validation'),
  ocrInputSha256:hash, renderer:z.literal('canvas-overlay.v1'), fontSha256:hash, model:z.string().min(1).max(100),
  regions:z.array(z.strictObject({id:z.string().min(1),text:z.string().max(10000),polygon:z.array(point).length(4),confidence:z.number().min(0).max(1)})).max(20000),
  comparisons:z.array(z.strictObject({overlayId:identifier,expected:z.string(),actual:z.string(),matched:z.boolean(),regionIds:z.array(z.string()),characterErrorRate:z.number().min(0).max(10000)})).max(50),
  coverageGaps:z.array(z.string().regex(/^[a-z_]+$/)).max(30),
  outsidePixelsUnchanged:z.literal(true),originalFileUnchanged:z.literal(true),originalPageUnchanged:z.literal(true),
});
export const MockValidationRunSummarySchema = z.strictObject({
  id:z.uuid(),documentVersionId:z.uuid(),sourceParseRevision:z.uuid(),pageNumber:z.number().int().positive(),
  status:z.enum(['pending','running','ready','partial','failed','stale','canceled']),createdAt:z.iso.datetime(),errorCode:z.string().nullable(),
  synthetic:z.literal(true),purpose:z.literal('mock_ocr_validation'),
});
export const MockValidationRunSchema = MockValidationRunSummarySchema.extend({
  sourceSha256:hash,sourcePageSha256:hash,mockImageSha256:hash.nullable(),width:z.number().int().positive(),height:z.number().int().positive(),
  overlays:z.array(MockOverlaySchema),result:MockValidationResultSchema.nullable(),
});
export type MockOverlay=z.infer<typeof MockOverlaySchema>;
export type MockValidationCommand=z.infer<typeof MockValidationCommandSchema>;
export type MockValidationResult=z.infer<typeof MockValidationResultSchema>;
export type MockValidationRunSummary=z.infer<typeof MockValidationRunSummarySchema>;
export type MockValidationRun=z.infer<typeof MockValidationRunSchema>;
