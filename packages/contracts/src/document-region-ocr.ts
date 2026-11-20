import { z } from 'zod';
import { DocumentRegionSchema } from './evidence.js';
export const REGION_OCR_VERSION = 'bounded-region-ocr-v1' as const;
const id = z.string().min(1).max(200), hash = z.string().regex(/^[a-f0-9]{64}$/);
const box = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]);
export const DocumentRegionCropSchema = z.strictObject({
  schema_version: z.literal('p0.v1'), crop_id: id, occurrence_id: id, page_asset_id: id,
  document_version_id: id, parse_revision: id, page_image_sha256: hash, image_sha256: hash,
  requested_box: box, crop_box: box, context_pixels: z.number().int().min(0).max(512),
  width: z.number().int().positive(), height: z.number().int().positive(),
  resize: z.strictObject({ x: z.number().positive(), y: z.number().positive() }),
  local_to_page: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
});
export const DocumentRegionOcrRequestSchema = z.strictObject({
  version: z.literal(REGION_OCR_VERSION), sourcePageHash: hash, sourceArtifactHash: hash, crop: DocumentRegionCropSchema,
  sourceRegionIds: z.array(id).min(1).max(16),
  reasons: z.array(z.enum(['source_conflict', 'empty_region', 'low_resolution_region'])).min(1).max(3),
});
export const DocumentRegionOcrReceiptSchema = z.strictObject({
  version: z.literal(REGION_OCR_VERSION), requestHash: hash, crop: DocumentRegionCropSchema,
  status: z.enum(['ready', 'partial', 'failed']), regions: z.array(DocumentRegionSchema).max(2000),
  coverageGaps: z.array(id).max(100),
  configurationVersions: z.strictObject({ layout: hash.nullable(), localization: hash.nullable() }),
});
export const DocumentRegionOcrSummarySchema = z.strictObject({
  version: z.literal(REGION_OCR_VERSION), status: z.enum(['not_needed', 'ready', 'partial']),
  planned: z.number().int().min(0).max(2),
  results: z.array(z.strictObject({
    cropId: id, requestHash: hash, receiptHash: hash.nullable(),
    state: z.enum(['ready', 'partial', 'failed', 'unknown', 'budget_exhausted', 'disabled']),
    sourceRegionIds: z.array(id).min(1).max(16), addedRegionIds: z.array(id).max(2000),
  })).max(2),
  coverageGaps: z.array(id).max(100),
});
export type DocumentRegionOcrRequest = z.infer<typeof DocumentRegionOcrRequestSchema>;
export type DocumentRegionOcrReceipt = z.infer<typeof DocumentRegionOcrReceiptSchema>;
export type DocumentRegionOcrSummary = z.infer<typeof DocumentRegionOcrSummarySchema>;
