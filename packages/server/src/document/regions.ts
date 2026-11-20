import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PageAssetSchema, type AffineTransform, type DocumentRegion, type EvidenceAnchor, type PageAsset } from '@hsbc/contracts/evidence';
import { combineOcrPage } from './combine-ocr.js';
import { compareRegionSources, sha256 } from './evidence.js';
import { mapCropPolygonToPage, transformPoint } from './geometry.js';
import type { OcrParseResult } from './ocr-client.js';

export interface RegionCrop {
  schema_version: 'p0.v1';
  crop_id: string;
  occurrence_id: string;
  page_asset_id: string;
  document_version_id: string;
  parse_revision: string;
  page_image_sha256: string;
  image_sha256: string;
  /** Both boxes use pixels in the fixed rendered PageAsset, not PDF points. */
  requested_box: [number, number, number, number];
  crop_box: [number, number, number, number];
  context_pixels: number;
  width: number;
  height: number;
  resize: { x: number; y: number };
  local_to_page: AffineTransform;
}

/** Crop a known occurrence on a fixed render; never extract/reinterpret a PDF object. */
export async function cropPageRegion(input: {
  page: PageAsset; pageImage: Uint8Array; occurrenceId: string;
  box: [number, number, number, number]; contextPixels?: number; scale?: number;
}): Promise<{ image: Buffer; crop: RegionCrop }> {
  const page = PageAssetSchema.parse(input.page), context = input.contextPixels ?? 16, scale = input.scale ?? 2;
  if (!input.occurrenceId || input.occurrenceId.length > 100) throw new Error('invalid_occurrence_id');
  const [left, top, right, bottom] = input.box;
  if (!input.box.every(Number.isFinite) || left < 0 || top < 0 || right > page.width || bottom > page.height || right <= left || bottom <= top)
    throw new Error('invalid_region_bounds');
  if (!Number.isInteger(context) || context < 0 || context > 512 || !Number.isFinite(scale) || scale <= 0 || scale > 4)
    throw new Error('invalid_crop_configuration');
  const source = await loadImage(input.pageImage);
  if (source.width !== page.width || source.height !== page.height) throw new Error('page_image_dimensions_mismatch');
  const box: RegionCrop['crop_box'] = [Math.max(0, Math.floor(left - context)), Math.max(0, Math.floor(top - context)), Math.min(page.width, Math.ceil(right + context)), Math.min(page.height, Math.ceil(bottom + context))];
  const sourceWidth = box[2] - box[0], sourceHeight = box[3] - box[1];
  const width = Math.round(sourceWidth * scale), height = Math.round(sourceHeight * scale);
  if (width < 1 || height < 1 || width * height > 20_000_000) throw new Error('crop_dimensions_unsupported');
  const canvas = createCanvas(width, height), context2d = canvas.getContext('2d');
  context2d.fillStyle = 'white'; context2d.fillRect(0, 0, width, height);
  context2d.drawImage(source, box[0], box[1], sourceWidth, sourceHeight, 0, 0, width, height);
  const image = canvas.toBuffer('image/png');
  const identity = { page_asset_id: page.page_asset_id, document_version_id: page.document_version_id, parse_revision: page.parse_revision, occurrence_id: input.occurrenceId, crop_box: box, width, height };
  return { image, crop: {
    schema_version: 'p0.v1', crop_id: `crop:${sha256(JSON.stringify(identity)).slice(0, 32)}`, ...identity,
    requested_box: [...input.box], context_pixels: context, page_image_sha256: sha256(input.pageImage), image_sha256: sha256(image),
    resize: { x: width / sourceWidth, y: height / sourceHeight },
    local_to_page: [sourceWidth / width, 0, 0, sourceHeight / height, box[0], box[1]],
  } };
}

export interface RegionOcrEvidence {
  crop: RegionCrop;
  status: 'ready' | 'partial' | 'failed';
  regions: DocumentRegion[];
  targets: Array<{ target: string; layout_anchors: EvidenceAnchor[]; localization_anchors: EvidenceAnchor[] }>;
  coverage_gaps: string[];
  configuration_versions: { layout: string | null; localization: string | null };
}

export function validateCrop(page: PageAsset, crop: RegionCrop): void {
  if (crop.page_asset_id !== page.page_asset_id || crop.document_version_id !== page.document_version_id || crop.parse_revision !== page.parse_revision)
    throw new Error('stale_crop_source');
  const [left, top, right, bottom] = crop.crop_box;
  if (![left, top, right, bottom, crop.width, crop.height].every(Number.isInteger) || left < 0 || top < 0 || right > page.width || bottom > page.height || right <= left || bottom <= top || crop.width <= 0 || crop.height <= 0)
    throw new Error('invalid_crop_geometry');
  const expected: AffineTransform = [(right - left) / crop.width, 0, 0, (bottom - top) / crop.height, left, top];
  if (!crop.local_to_page || expected.some((value, i) => Math.abs(value - crop.local_to_page[i]!) > 1e-10) || !crop.local_to_page.every(Number.isFinite))
    throw new Error('crop_inverse_mapping_mismatch');
  if (Math.abs(crop.resize.x - crop.width / (right - left)) > 1e-10 || Math.abs(crop.resize.y - crop.height / (bottom - top)) > 1e-10)
    throw new Error('crop_resize_mismatch');
  if (![crop.page_image_sha256, crop.image_sha256].every(hash => /^[a-f0-9]{64}$/.test(hash))) throw new Error('invalid_crop_image_hash');
}

/** VL and PP retain separate raw text spans; geometry alone moves to the original page. */
export function combineOcrRegion(input: { page: PageAsset; crop: RegionCrop; response: OcrParseResult; targets: string[] }): RegionOcrEvidence {
  const { page, crop } = input; validateCrop(page, crop);
  // A temporary local coordinate frame makes the existing per-source dimension
  // and preprocessing checks apply before any mapping back to page coordinates.
  const localPage: PageAsset = { ...page, page_asset_id: crop.crop_id, width: crop.width, height: crop.height };
  const combined = combineOcrPage({ page: localPage, response: input.response, targets: input.targets, imageSha256: crop.image_sha256 });
  const regionId = (id: string) => `region:${sha256(`${crop.crop_id}:${id}`)}`;
  const anchorId = (id: string) => `anchor:${sha256(`${crop.crop_id}:${id}`)}`;
  const regions = combined.regions.map(region => ({ ...region,
    region_id: regionId(region.region_id), source_id: `${crop.crop_id}:${region.source_id}`,
    page_asset_id: page.page_asset_id,
    polygons: region.polygons.map(polygon => mapCropPolygonToPage(polygon, crop.local_to_page, page)),
  }));
  const mapAnchor = (anchor: EvidenceAnchor): EvidenceAnchor => ({ ...anchor,
    anchor_id: anchorId(anchor.anchor_id), page_asset_id: page.page_asset_id,
    block_ids: anchor.block_ids.map(regionId), text_span_refs: anchor.text_span_refs.map(span => ({ ...span, block_id: regionId(span.block_id) })),
    candidate_anchor_ids: anchor.candidate_anchor_ids.map(anchorId),
    polygons: anchor.polygons.map(polygon => mapCropPolygonToPage(polygon, crop.local_to_page, page)),
  });
  const gaps = [...combined.coverage_gaps];
  if (!regions.some(region => region.raw_text?.trim())) gaps.push('region_ocr_returned_no_text');
  else if (!regions.some(region => region.source === 'pp_ocr' && region.raw_text?.trim())) gaps.push('region_localization_returned_no_text');
  if (combined.layout.status === 'unavailable') gaps.push('region_layout_unavailable');
  if (combined.localization.status === 'unavailable') gaps.push('region_localization_unavailable');
  return { crop, status: gaps.length ? 'partial' : 'ready', regions,
    targets: combined.targets.map(target => ({ target: target.target, layout_anchors: target.layout_anchors.map(mapAnchor), localization_anchors: target.localization_anchors.map(mapAnchor) })),
    coverage_gaps: [...new Set(gaps)], configuration_versions: { layout: combined.layout.configuration_version, localization: combined.localization.configuration_version },
  };
}

export function failedOcrRegion(page: PageAsset, crop: RegionCrop, errorCode: string): RegionOcrEvidence {
  validateCrop(page, crop);
  if (!/^[a-z0-9_]+$/.test(errorCode)) throw new Error('invalid_ocr_error_code');
  return { crop, status: 'failed', regions: [], targets: [], coverage_gaps: [`region_ocr_failed:${errorCode}`], configuration_versions: { layout: null, localization: null } };
}

/** Coverage is a ledger of planned occurrences, not a claim of OCR accuracy. */
export function summarizeRegionCoverage(planned: RegionCrop[], results: RegionOcrEvidence[]) {
  if (new Set(planned.map(crop => crop.crop_id)).size !== planned.length || new Set(results.map(result => result.crop.crop_id)).size !== results.length)
    throw new Error('duplicate_region_occurrence');
  if (results.some(result => !planned.some(crop => crop.crop_id === result.crop.crop_id))) throw new Error('unplanned_region_result');
  const occurrences = planned.map(crop => {
    const result = results.find(candidate => candidate.crop.crop_id === crop.crop_id);
    if (result && JSON.stringify(result.crop) !== JSON.stringify(crop)) throw new Error('region_result_source_mismatch');
    return { crop_id: crop.crop_id, occurrence_id: crop.occurrence_id, page_asset_id: crop.page_asset_id,
      status: result?.status ?? 'pending', coverage_gaps: result?.coverage_gaps ?? ['region_ocr_not_attempted'] };
  });
  return { status: occurrences.length && occurrences.every(occurrence => occurrence.status === 'ready') ? 'ready' : 'partial',
    planned: planned.length, completed: occurrences.filter(occurrence => occurrence.status === 'ready' || occurrence.status === 'partial').length,
    failed: occurrences.filter(occurrence => occurrence.status === 'failed').length, occurrences };
}

/** Retain every source; only canonical display IDs are deduplicated on strict position + text equality. */
export function reconcileRegionEvidence(regions: DocumentRegion[]) {
  if (new Set(regions.map(region => region.region_id)).size !== regions.length) throw new Error('duplicate_region_id');
  const canonical = new Set(regions.map(region => region.region_id));
  const duplicates: Array<{ canonical_region_id: string; duplicate_region_id: string }> = [];
  const conflicts: Array<{ region_ids: [string, string]; reason: string }> = [];
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    const first = regions[i]!, second = regions[j]!;
    if (first.document_version_id !== second.document_version_id || !first.raw_text?.trim() || !second.raw_text?.trim()) continue;
    const comparison = compareRegionSources(first, second);
    if (comparison === 'duplicate' && canonical.has(first.region_id) && canonical.has(second.region_id)) {
      canonical.delete(second.region_id); duplicates.push({ canonical_region_id: first.region_id, duplicate_region_id: second.region_id });
    } else if (comparison === 'conflict') conflicts.push({ region_ids: [first.region_id, second.region_id], reason: 'same_position_source_text_disagrees' });
  }
  return { regions, canonical_region_ids: [...canonical], duplicates, conflicts };
}

/** Annotation bounds are PDF points, transformed using the exact PageAsset render. */
export function pdfRectangleOnPage(page: PageAsset, rectangle: [number, number, number, number]): [number, number, number, number] {
  const [x, y, width, height] = rectangle;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('invalid_pdf_rectangle');
  const points = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]].map(point => transformPoint(point as [number, number], page.pdf_to_page));
  return [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])), Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))];
}
