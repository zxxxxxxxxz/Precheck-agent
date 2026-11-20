import { z } from 'zod';

const name = z.string().min(1).max(300).refine(value => value.trim().length > 0 && !/[\r\n\u0000-\u001f]/u.test(value), 'single_company_name_required');
const lei = z.string().regex(/^[A-Z0-9]{18}[0-9]{2}$/u);
const nullableText = z.string().max(300).nullable();
export const CompanyLookupQuerySchema = z.strictObject({
  name, lei: lei.optional(), jurisdiction: z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,4})?$/u).optional(),
  registrationAuthority: z.string().regex(/^RA[0-9]{6}$/u).optional(),
  registrationNumber: z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N} ._/-]+$/u).optional(),
  maxCandidates: z.number().int().min(1).max(10).default(5),
});
export const CompanyLookupCommandSchema = CompanyLookupQuerySchema.extend({
  expectedRevision: z.number().int().positive(), idempotencyKey: z.string().min(8).max(200),
  reason: z.string().trim().min(1).max(1000),
});
export const CompanyNameSelectionSchema = z.strictObject({ lookupId: z.uuid(), lei });
export const CompanyNormalizedNameSchema = z.strictObject({
  rawName: name, normalizedName: name, comparisonKey: z.string().min(1).max(300),
  version: z.string(), differenceTypes: z.array(z.enum(['unicode_composition', 'whitespace', 'case'])),
});
export const CompanyRecordSchema = z.strictObject({
  lei, legalName: name, language: nullableText,
  aliases: z.array(z.strictObject({ name, language: nullableText, type: nullableText })).max(100),
  jurisdiction: nullableText, registrationAuthority: nullableText, registrationNumber: nullableText,
  entityStatus: nullableText, leiRegistrationStatus: nullableText,
  matchBasis: z.array(z.string()), conflicts: z.array(z.string()),
  sourceUrl: z.string().url(), recordUpdatedAt: nullableText,
});
export const CompanyLookupReceiptSchema = z.strictObject({
  id: z.uuid(), caseId: z.uuid(), caseRevision: z.number().int().positive(),
  status: z.enum(['pending', 'candidates', 'not_found', 'conflicting', 'unavailable', 'blocked', 'stale']),
  query: CompanyLookupQuerySchema, normalized: CompanyNormalizedNameSchema,
  records: z.array(CompanyRecordSchema).max(10), source: z.literal('GLEIF'),
  fetchedAt: z.iso.datetime().nullable(), expiresAt: z.iso.datetime().nullable(),
  cache: z.enum(['miss', 'hit']), truncated: z.boolean(), errorCode: z.string().nullable(),
  clientVersion: z.string(), normalizationVersion: z.string(),
  responseHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), sourceDataVersion: z.string().nullable(),
});
export type CompanyLookupQuery = z.infer<typeof CompanyLookupQuerySchema>;
export type CompanyLookupCommand = z.infer<typeof CompanyLookupCommandSchema>;
export type CompanyRecord = z.infer<typeof CompanyRecordSchema>;
export type CompanyLookupReceipt = z.infer<typeof CompanyLookupReceiptSchema>;
export type CompanyNameSelection = z.infer<typeof CompanyNameSelectionSchema>;
export type CompanyNormalizedName = z.infer<typeof CompanyNormalizedNameSchema>;
export interface CompanyIdentityState {
  caseId: string; revision: number;
  externalLookup: { available: boolean; reasonCode: string | null };
  allowedActions: Array<'lookup' | 'adopt'>; receipts: CompanyLookupReceipt[];
}
