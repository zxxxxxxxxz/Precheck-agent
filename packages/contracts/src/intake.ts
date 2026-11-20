import { z } from 'zod';
import { CASE_FIELD_LIMITS, DraftFieldSchema, IntakeFieldSchema, IntakeDetailFieldSchema, CaseDetailsSchema, DraftGuaranteeTypesSchema } from './draft.js';

export const INTAKE_V2_SCHEMA = 'draft_intake_v2' as const;
const sourceRef = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.:-]+$/);
export const IntakeSourceBlockSchema = z.strictObject({ id: sourceRef, text: z.string().max(200_000) });
export type IntakeSourceBlock = z.infer<typeof IntakeSourceBlockSchema>;
export const IntakeReplyBlockSchema = z.strictObject({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  text: z.string().trim().min(1).max(2000), sourceRefs: z.array(sourceRef).max(32),
});
export type IntakeReplyBlock = z.infer<typeof IntakeReplyBlockSchema>;
export const IntakeFieldSuggestionSchema = z.strictObject({
  field: IntakeFieldSchema, value: z.string().max(CASE_FIELD_LIMITS.background), sourceRefs: z.array(sourceRef).min(1).max(32),
}).superRefine((value, ctx) => {
  if (IntakeDetailFieldSchema.safeParse(value.field).success) return;
  if (value.field === 'scenario' ? value.value !== 'overseas_loan' : value.value.length > CASE_FIELD_LIMITS[value.field as keyof typeof CASE_FIELD_LIMITS]) {
    ctx.addIssue({ code: 'custom', message: 'Invalid draft field value' });
  }
});
export type IntakeFieldSuggestion = z.infer<typeof IntakeFieldSuggestionSchema>;
export const IntakeAssistantOutputSchema = z.strictObject({
  replyBlocks: z.array(IntakeReplyBlockSchema).min(1).max(12),
  fieldSuggestions: z.array(IntakeFieldSuggestionSchema).max(9),
  questions: z.array(z.string().trim().min(1).max(500)).max(4),
}).superRefine((value, ctx) => {
  if (new Set(value.replyBlocks.map(block => block.id)).size !== value.replyBlocks.length ||
      new Set(value.fieldSuggestions.map(field => field.field)).size !== value.fieldSuggestions.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate assistant output identifiers' });
  }
});
export type IntakeAssistantOutput = z.infer<typeof IntakeAssistantOutputSchema>;

/** Explicit JSON Schema keeps the existing Azure strict-output contract stable. */
export const intakeAssistantJsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    replyBlocks: { type: 'array', minItems: 1, maxItems: 12, items: {
      type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9_-]+$' },
        text: { type: 'string', minLength: 1, maxLength: 2000 },
        sourceRefs: { type: 'array', maxItems: 32, items: { type: 'string' } },
      }, required: ['id', 'text', 'sourceRefs'],
    } },
    fieldSuggestions: { type: 'array', maxItems: 9, items: {
      type: 'object', additionalProperties: false, properties: {
        field: { type: 'string', enum: ['customerNumber', 'jurisdiction', 'guaranteeCurrency', 'guaranteeAmount', 'guaranteeTypes'] },
        value: { type: 'string', maxLength: 5000 },
        sourceRefs: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' } },
      }, required: ['field', 'value', 'sourceRefs'],
    } },
    questions: { type: 'array', maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 500 } },
  }, required: ['replyBlocks', 'fieldSuggestions', 'questions'],
} as const;

/** Validate restored values with the same schema used by manual form saves. */
export function intakeFieldValue(field: string, value: unknown): unknown {
  if (field === 'guaranteeTypes') return DraftGuaranteeTypesSchema.parse(typeof value === 'string' ? JSON.parse(value) : value);
  if (field in CaseDetailsSchema.shape) return CaseDetailsSchema.shape[field as keyof typeof CaseDetailsSchema.shape].parse(value);
  DraftFieldSchema.parse(field);
  return value;
}
