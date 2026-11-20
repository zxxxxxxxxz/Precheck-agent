import { z } from 'zod';
import { PointSchema } from './evidence.js';

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const rawBox = z.tuple([finite, finite, finite, finite]);
const rawPolygon = z.array(z.tuple([finite, finite])).min(3).max(512);
const kind = z.enum(['stamp', 'signature']);
export const DocumentOcrMarkSourceSchema = z.strictObject({
  source: z.enum(['layout_detection', 'layout_block']), index: z.number().int().nonnegative(),
  sourceId: id.nullable(), label: z.string().min(1).max(64),
  classId: z.union([finite, z.string().max(64)]).nullable(), score: finite.nullable(),
  bbox: rawBox.nullable(), polygon: rawPolygon.nullable(),
});
export const DocumentOcrMarkSchema = z.strictObject({
  id, kind, score: z.number().min(0).max(1).nullable(), regionId: id.nullable(),
  bbox: rawBox.nullable(), polygon: z.array(PointSchema).min(3).max(512).nullable(),
  mappingStatus: z.enum(['verified', 'unavailable']),
  sourceRefs: z.array(DocumentOcrMarkSourceSchema).min(1).max(16),
  coverageGaps: z.array(z.string().min(1).max(100)).max(20),
}).superRefine((item, context) => {
  if (item.mappingStatus === 'verified' && (!item.bbox || !item.polygon || !item.regionId))
    context.addIssue({ code: 'custom', message: 'Verified OCR mark requires page geometry and region' });
  if (item.mappingStatus === 'unavailable' && (item.bbox || item.polygon || item.regionId))
    context.addIssue({ code: 'custom', message: 'Unavailable OCR mark must not guess page geometry' });
  if (item.bbox && !(item.bbox[0] >= 0 && item.bbox[1] >= 0 && item.bbox[2] > item.bbox[0] && item.bbox[3] > item.bbox[1]))
    context.addIssue({ code: 'custom', message: 'Invalid page OCR mark box' });
});
/** OCR-reported clues, separate from visually verified signature observations. */
export const DocumentOcrMarkPageSchema = z.strictObject({
  schemaVersion: z.literal('ocr-marks.v1'), pageNumber: z.number().int().positive(),
  pageAssetId: id, documentVersionId: id, parseRevision: id,
  sourceSha256: hash, imageSha256: hash,
  status: z.enum(['reported', 'partial', 'unavailable']),
  responseSha256: hash.nullable(), configurationSha256: hash,
  model: id.nullable(), modelVersion: id.nullable(),
  supportedKinds: z.array(kind).max(2).nullable(),
  items: z.array(DocumentOcrMarkSchema).max(1000),
  coverageGaps: z.array(z.string().min(1).max(100)).max(40),
  absenceProven: z.literal(false),
});
export type DocumentOcrMarkSource = z.infer<typeof DocumentOcrMarkSourceSchema>;
export type DocumentOcrMark = z.infer<typeof DocumentOcrMarkSchema>;
export type DocumentOcrMarkPage = z.infer<typeof DocumentOcrMarkPageSchema>;
