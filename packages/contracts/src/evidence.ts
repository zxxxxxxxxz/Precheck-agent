import { z } from 'zod';

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PointSchema = z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()]);
export const PolygonSchema = z.array(PointSchema).min(3);
export const AffineTransformSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]);
export const PageAssetSchema = z.strictObject({
  schema_version: z.literal('p0.v1'), page_asset_id: id, document_version_id: id, parse_revision: id,
  page_number: z.number().int().positive(), printed_page_label: z.string().nullable(),
  width: z.number().positive().finite(), height: z.number().positive().finite(),
  source_sha256: hash, renderer: z.string().min(1), renderer_config: z.string().min(1),
  pdf_view_box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  intrinsic_rotation: z.number().int(), pdf_to_page: AffineTransformSchema,
});
export const TextSpanRefSchema = z.strictObject({
  block_id: id, offset: z.number().int().nonnegative(), length: z.number().int().positive(),
  offset_unit: z.literal('unicode_code_point'),
});
export const DocumentRegionSchema = z.strictObject({
  region_id: id, page_asset_id: id, document_version_id: id, parse_revision: id,
  source: z.enum(['native_pdf', 'vl_ocr', 'pp_ocr', 'image']),
  source_id: id, kind: z.enum(['text', 'table', 'image', 'signature', 'unknown']),
  reading_order: z.number().int().nonnegative(), raw_text: z.string().nullable(), raw_text_sha256: hash.nullable(),
  polygons: z.array(PolygonSchema), processing_status: z.enum(['ready', 'pending', 'failed', 'image_only']),
  coverage: z.array(z.enum(['text', 'table_structure', 'image_evidence'])),
  coverage_gaps: z.array(z.string().min(1)), localization_reason: z.string().nullable(),
});
export const EvidenceAnchorSchema = z.strictObject({
  schema_version: z.literal('p0.v1'), anchor_id: id, evidence_kind: z.enum(['text', 'image_region']),
  document_version_id: id, parse_revision: id, page_asset_id: id, page_number: z.number().int().positive(),
  block_ids: z.array(id), text_span_refs: z.array(TextSpanRefSchema), polygons: z.array(PolygonSchema),
  granularity: z.enum(['block', 'line', 'word', 'cell']),
  localization_status: z.enum(['exact', 'block_only', 'ambiguous', 'unavailable']),
  localization_source: z.string().min(1), configuration_version: id, reason: z.string().nullable(),
  candidate_anchor_ids: z.array(id),
}).superRefine((anchor, ctx) => {
  if (anchor.localization_status !== 'unavailable' && anchor.polygons.length === 0 && anchor.candidate_anchor_ids.length === 0)
    ctx.addIssue({ code: 'custom', message: 'Localized evidence requires actual geometry or candidates' });
  if (anchor.evidence_kind === 'image_region' && anchor.text_span_refs.length)
    ctx.addIssue({ code: 'custom', message: 'Image evidence must not invent text offsets' });
  if (anchor.localization_status === 'exact' && (anchor.evidence_kind !== 'text' || anchor.text_span_refs.length === 0 || anchor.polygons.length === 0))
    ctx.addIssue({ code: 'custom', message: 'Exact localization requires text provenance and geometry' });
  if (anchor.localization_status === 'unavailable' && (anchor.polygons.length > 0 || !anchor.reason))
    ctx.addIssue({ code: 'custom', message: 'Unavailable localization must have a reason and no guessed polygons' });
});
export const FieldObservationSchema = z.strictObject({
  observation_id: id, case_id: id, snapshot_id: id, field: id,
  document_version_id: id, parse_revision: id,
  status: z.enum(['extracted', 'not_found', 'not_applicable', 'uncertain']),
  raw_value: z.string().nullable(), normalized_value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  evidence_anchor_ids: z.array(id), human_revision_id: id.nullable(),
});
export type Point = z.infer<typeof PointSchema>;
export type Polygon = z.infer<typeof PolygonSchema>;
export type AffineTransform = z.infer<typeof AffineTransformSchema>;
export type PageAsset = z.infer<typeof PageAssetSchema>;
export type DocumentRegion = z.infer<typeof DocumentRegionSchema>;
export type EvidenceAnchor = z.infer<typeof EvidenceAnchorSchema>;
export type FieldObservation = z.infer<typeof FieldObservationSchema>;
