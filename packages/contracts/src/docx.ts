import { z } from 'zod';
import { DOCUMENT_PAGE_LIMIT } from './document-limits.js';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const id=z.string().min(1).max(200);
export const DocxBudgetsSchema=z.strictObject({
  maxInputBytes:z.number().int().positive().max(50*1024*1024).default(25*1024*1024),
  maxEntries:z.number().int().positive().max(10000).default(2048),
  maxEntryBytes:z.number().int().positive().max(64*1024*1024).default(32*1024*1024),
  maxExpandedBytes:z.number().int().positive().max(256*1024*1024).default(128*1024*1024),
  maxCompressionRatio:z.number().positive().max(200).default(100),
  maxXmlDepth:z.number().int().positive().max(256).default(128),
  maxXmlNodes:z.number().int().positive().max(500000).default(200000),
  maxSourceNodes:z.number().int().positive().max(100000).default(50000),
  maxTextCharacters:z.number().int().positive().max(10000000).default(5000000),
  conversionTimeoutMs:z.number().int().positive().max(300000).default(120000),
  maxOutputPdfBytes:z.number().int().positive().max(64*1024*1024).default(50*1024*1024),
  maxPreviewPages:z.number().int().positive().max(DOCUMENT_PAGE_LIMIT).default(DOCUMENT_PAGE_LIMIT),
  maxTemporaryBytes:z.number().int().positive().max(1024*1024*1024).default(512*1024*1024),
});
export type DocxBudgets=z.infer<typeof DocxBudgetsSchema>;
export const defaultDocxBudgets=():DocxBudgets=>DocxBudgetsSchema.parse({});
export const DocxNodeSchema=z.strictObject({
  id,kind:z.enum(['section','paragraph','run','table','row','cell','symbol','footnote','endnote','textbox','image','comment']),
  part:z.string(),path:z.string(),parentId:id.nullable(),order:z.number().int().nonnegative(),
  text:z.string(),visibleText:z.string(),textSha256:hash,
  visibility:z.enum(['visible','hidden','deleted','inserted','comment','unknown']),
  excludedFromVisibleFacts:z.boolean(),coverageGaps:z.array(z.string()),
  symbol:z.strictObject({font:z.string(),charCode:z.string(),unicodeCandidate:z.string().nullable(),meaningConfirmed:z.literal(false)}).optional(),
  cell:z.strictObject({rowIndex:z.number().int().nonnegative(),columnIndex:z.number().int().nonnegative(),gridSpan:z.number().int().positive(),verticalMerge:z.enum(['none','restart','continue'])}).optional(),
  reference:z.strictObject({kind:z.enum(['footnote','endnote','comment','image']),targetId:z.string().nullable(),ooxmlId:z.string().optional(),relationshipId:z.string().nullable(),part:z.string().nullable(),sha256:hash.nullable(),external:z.boolean()}).optional(),
  fontNames:z.array(z.string()),
});
export type DocxNode=z.infer<typeof DocxNodeSchema>;
export const DocxFontSchema=z.strictObject({name:z.string(),sources:z.array(z.enum(['font_table','run','style','symbol'])),embedded:z.boolean()});
export const DocxSourceDocumentSchema=z.strictObject({
  schemaVersion:z.literal('docx.v1'),sourceSha256:hash,contentFingerprint:hash,
  nodes:z.array(DocxNodeSchema),fonts:z.array(DocxFontSchema),coverageGaps:z.array(z.string()),
  stats:z.strictObject({inputBytes:z.number().int().nonnegative(),entries:z.number().int().nonnegative(),expandedBytes:z.number().int().nonnegative(),xmlNodes:z.number().int().nonnegative(),sourceNodes:z.number().int().nonnegative(),textCharacters:z.number().int().nonnegative()}),
});
export type DocxSourceDocument=z.infer<typeof DocxSourceDocumentSchema>;
export const DocxConversionManifestSchema=z.strictObject({
  schemaVersion:z.literal('docx-conversion.v1'),sourceSha256:hash,pdfSha256:hash,pdfBytes:z.number().int().positive(),pageCount:z.number().int().positive(),
  converter:z.strictObject({name:z.literal('LibreOffice'),version:z.string(),runtimeManifestSha256:hash.nullable()}),
  mode:z.enum(['production','validation']),sandboxed:z.boolean(),productionEligible:z.boolean(),
  fontManifestSha256:hash.nullable(),configurationSha256:hash,
  fonts:z.array(z.strictObject({requested:z.string(),resolved:z.string().nullable(),status:z.enum(['available','substituted','unresolved']),basis:z.literal('runtime_manifest'),runtimeFontPath:z.string().nullable().default(null),fileSha256:hash.nullable().default(null)})),
  coverageGaps:z.array(z.string()),elapsedMs:z.number().nonnegative(),
});
export type DocxConversionManifest=z.infer<typeof DocxConversionManifestSchema>;
