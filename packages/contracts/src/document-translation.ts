import { z } from 'zod';

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const TRANSLATION_LIMITS = { chunksPerJob: 20, sourceCharacters: 4000, contextCharacters: 10000, contextChunks: 32 } as const;
export const FieldTranslationSourceSchema = z.strictObject({
  anchorId: id.optional(), sourceNodeId: id.optional(), quote: z.string().min(1).max(16000).optional(),
}).refine(source => Boolean(source.anchorId) !== Boolean(source.sourceNodeId), 'Exactly one source location is required');
export type FieldTranslationSource = z.infer<typeof FieldTranslationSourceSchema>;
export const FieldTranslationTargetsQuerySchema = z.strictObject({
  parseRevision: z.uuid(), referenceRoundId: z.uuid().optional(),
  expectedDirectoryRevision: z.number().int().positive(),
  fieldSources: z.array(FieldTranslationSourceSchema).min(1).max(20),
});
export const DocumentTranslationCommandSchema = z.strictObject({
  expectedRevision: z.number().int().positive(), parseRevision: z.uuid(),
  referenceRoundId: z.uuid().optional(),
  expectedDirectoryRevision: z.number().int().positive(),
  chunkIds: z.array(id).min(1).max(TRANSLATION_LIMITS.chunksPerJob).refine(ids => new Set(ids).size === ids.length),
  idempotencyKey: z.string().min(8).max(200), reason: z.string().trim().min(1).max(500),
  retryOf: z.uuid().optional(),
  fieldSources: z.array(FieldTranslationSourceSchema).min(1).max(20).optional(),
});
export type DocumentTranslationCommand = z.infer<typeof DocumentTranslationCommandSchema>;
/** The server freezes all available paragraphs; callers cannot supply text or bypass selection limits. */
export const FullTextTranslationCommandSchema = DocumentTranslationCommandSchema.omit({chunkIds: true, fieldSources: true});
export type FullTextTranslationCommand = z.infer<typeof FullTextTranslationCommandSchema>;
export const DocumentTranslationStatusSchema = z.enum(['pending', 'running', 'ready', 'partial', 'failed', 'canceled', 'stale']);
export const DocumentTranslationAcceptedSchema = z.strictObject({ jobId: z.uuid(), status: DocumentTranslationStatusSchema, reused: z.boolean() });
export type DocumentTranslationAccepted = z.infer<typeof DocumentTranslationAcceptedSchema>;
export const TranslationSourceReferenceSchema = z.strictObject({
  anchorIds: z.array(id), pageNumbers: z.array(z.number().int().positive()), sourceNodeIds: z.array(id),
});
export const DocumentTranslationTargetSchema = z.strictObject({
  chunkId: id, logicalDocumentId: id, sourceSha256: hash,
  sourceText: z.string().nullable(), characterCount: z.number().int().nonnegative(),
  fieldSource: FieldTranslationSourceSchema.optional(),
  source: TranslationSourceReferenceSchema, fieldIds: z.array(id), recommended: z.boolean(),
  fieldEvidence: z.array(z.strictObject({fieldId:id,anchorIds:z.array(id)})).optional(),
  available: z.boolean(), reasonCodes: z.array(z.string()), sourceWarnings: z.array(z.string()),
});
export type DocumentTranslationTarget = z.infer<typeof DocumentTranslationTargetSchema>;
export const DocumentTranslationTargetsSchema = z.strictObject({
  schemaVersion: z.literal('document-translation.v1'), caseRevision: z.number().int().positive(),
  parseRevision: z.uuid(), directoryRevision: z.number().int().positive(), enabled: z.boolean(), canCreate: z.boolean(),
  limits: z.strictObject({ chunksPerJob: z.literal(20), sourceCharacters: z.literal(4000), contextCharacters: z.literal(10000), contextChunks: z.literal(32) }),
  items: z.array(DocumentTranslationTargetSchema).max(100), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(),
});
export type DocumentTranslationTargets = z.infer<typeof DocumentTranslationTargetsSchema>;
export const TranslationCheckSchema = z.strictObject({
  kind: z.enum(['structure', 'numbers', 'currencies', 'placeholders', 'references', 'terminology']), passed: z.boolean(),
});
export const DocumentTranslatedSegmentSchema = z.strictObject({
  chunkId: id, sourceSha256: hash, contextSha256: hash, sourceText: z.string(),
  source: TranslationSourceReferenceSchema, sourceWarnings: z.array(z.string()),
  translatedText: z.string().nullable(), status: z.enum(['ready', 'needs_review']),
  checks: z.array(TranslationCheckSchema), reasonCodes: z.array(z.string()),
  model: id, provider: z.enum(['local-vllm','bailian']), simulated: z.boolean(),
});
export type DocumentTranslatedSegment = z.infer<typeof DocumentTranslatedSegmentSchema>;
export const DocumentTranslationViewSchema = z.strictObject({
  schemaVersion: z.literal('document-translation.v1'), jobId: z.uuid(), caseId: z.uuid(), documentId: z.uuid(),
  caseRevision: z.number().int().positive(), parseRevision: z.uuid(), directoryRevision: z.number().int().positive(),
  status: DocumentTranslationStatusSchema,
  fieldSources: z.array(FieldTranslationSourceSchema).min(1).max(20).optional(),
  scope: z.literal('full_text').optional(),
  sourceCurrent: z.boolean().optional(), referenceRoundId: z.uuid().optional(),
  validity: z.enum(['current', 'stale']), purpose: z.literal('reference'), targetLanguage: z.literal('zh-CN'),
  reviewState: z.literal('unreviewed'), errorCode: z.string().nullable(),
  progress: z.strictObject({ completedSegments: z.number().int().nonnegative(), totalSegments: z.number().int().positive() }),
  items: z.array(DocumentTranslatedSegmentSchema), chunkIds: z.array(id).min(1),
  canCancel: z.boolean(), canRetry: z.boolean(),
  createdAt: z.iso.datetime(), modelRevision: id, promptVersion: id, glossaryVersion: id,
}).refine(view => view.scope === 'full_text' || view.chunkIds.length <= TRANSLATION_LIMITS.chunksPerJob, {message: 'Selection translations are limited to 20 paragraphs'});
export type DocumentTranslationView = z.infer<typeof DocumentTranslationViewSchema>;
export const DocumentTranslationListSchema = z.strictObject({ items: z.array(DocumentTranslationViewSchema).max(10) });
export type DocumentTranslationList = z.infer<typeof DocumentTranslationListSchema>;

/** Optional source filter is applied before the history limit, so other fields cannot hide older matches. */
export const DocumentTranslationHistoryQuerySchema = z.strictObject({
  scope: z.enum(['full_text', 'selection']).optional(),
  parseRevision: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(10).default(10),
  chunkIds: z.string().max(5000).transform((value, context) => {
    try { return JSON.parse(value) as unknown; }
    catch { context.addIssue({code: 'custom', message: 'Invalid chunk IDs'}); return z.NEVER; }
  }).pipe(z.array(id).min(1).max(20).refine(ids => new Set(ids).size === ids.length)).optional(),
});
