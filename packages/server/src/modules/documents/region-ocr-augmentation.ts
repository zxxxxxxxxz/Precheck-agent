import { DocumentPageArtifactSchema, type DocumentPageArtifact } from '@hsbc/contracts/documents';
import { REGION_OCR_VERSION, DocumentRegionOcrReceiptSchema, type DocumentRegionOcrRequest,
  type DocumentRegionOcrSummary } from '@hsbc/contracts/document-region-ocr';
import type { DocumentRegion } from '@hsbc/contracts/evidence';
import { anchorsForText, sha256 } from '../../document/evidence.js';
import { cropPageRegion, reconcileRegionEvidence } from '../../document/regions.js';
import { configHash } from '../review/opa.js';
import { REGION_OCR_LIMITS, type RegionOcrDispatchResult } from './region-ocr-ledger.js';
type Box = [number, number, number, number];
type Reason = DocumentRegionOcrRequest['reasons'][number];
export interface PlannedRegionOcr { occurrenceId: string; box: Box; sourceRegionIds: string[]; reasons: Reason[] }
const unique = <T>(values: T[]) => [...new Set(values)];
function regionBox(region: DocumentRegion, page: DocumentPageArtifact): Box | undefined {
  if (region.page_asset_id !== page.page.page_asset_id || region.document_version_id !== page.scope.documentVersionId ||
    region.parse_revision !== page.scope.parseRevision || region.polygons.length !== 1 ||
    region.raw_text !== null && region.raw_text_sha256 !== sha256(region.raw_text)) return;
  const p = region.polygons[0]!, b: Box = [Math.min(...p.map(v => v[0])), Math.min(...p.map(v => v[1])),
    Math.max(...p.map(v => v[0])), Math.max(...p.map(v => v[1]))];
  return b.every(Number.isFinite) && b[0] >= 0 && b[1] >= 0 && b[2] <= page.page.width && b[3] <= page.page.height &&
    b[2] > b[0] && b[3] > b[1] ? b : undefined;
}
function expanded(b: Box, page: DocumentPageArtifact): Box {
  return [Math.max(0, Math.floor(b[0] - 6)), Math.max(0, Math.floor(b[1] - 6)),
    Math.min(page.page.width, Math.ceil(b[2] + 6)), Math.min(page.page.height, Math.ceil(b[3] + 6))];
}
const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
/** Deterministic source-gap planning only. No field value, filename, CSV, or
 * model suggestion can nominate an arbitrary image/crop. Whole-page OCR gaps
 * remain unresolved; this pass never disguises a full-page OCR retry. */
export function planRegionOcr(page: DocumentPageArtifact): { targets: PlannedRegionOcr[]; coverageGaps: string[] } {
  const planned: Array<{ box: Box; sourceRegionIds: string[]; reasons: Reason[] }> = [], gaps: string[] = [];
  for (const conflict of page.conflicts) {
    const regions = conflict.region_ids.map(id => page.regions.find(region => region.region_id === id));
    const boxes = regions.map(region => region && regionBox(region, page));
    if (boxes.some(b => !b)) { gaps.push('region_ocr_unlocalized_gap'); continue; }
    planned.push({ box: [Math.min(...boxes.map(b => b![0])), Math.min(...boxes.map(b => b![1])),
      Math.max(...boxes.map(b => b![2])), Math.max(...boxes.map(b => b![3]))],
    sourceRegionIds: [...conflict.region_ids], reasons: ['source_conflict'] });
  }
  for (const region of page.regions) {
    if (region.source !== 'vl_ocr' || !['text', 'table'].includes(region.kind)) continue;
    const b = regionBox(region, page);
    const empty = !region.raw_text?.trim(), unclear = Boolean(region.raw_text?.includes('\uFFFD')) ||
      region.coverage_gaps.some(gap => ['low_resolution_text', 'low_confidence_text', 'text_unreadable'].includes(gap)) ||
      Boolean(b && b[3] - b[1] < 16 && page.coverageGaps.includes('page_render_downscaled_pixel_budget'));
    if (!empty && !unclear) continue;
    if (!b) { gaps.push('region_ocr_unlocalized_gap'); continue; }
    planned.push({ box: b, sourceRegionIds: [region.region_id], reasons: [empty ? 'empty_region' : 'low_resolution_region'] });
  }
  const bounded: PlannedRegionOcr[] = [];
  const merged = new Map<string, typeof planned[number]>();
  for (const plan of planned) {
    const key = configHash(plan.box), old = merged.get(key);
    if (old) {
      old.sourceRegionIds = unique([...old.sourceRegionIds, ...plan.sourceRegionIds]);
      old.reasons = unique([...old.reasons, ...plan.reasons]);
    } else merged.set(key, { ...plan, sourceRegionIds: unique(plan.sourceRegionIds) });
  }
  for (const plan of [...merged.values()].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
    if (plan.sourceRegionIds.length > 16) { gaps.push('region_ocr_source_budget_exhausted'); continue; }
    const padded = expanded(plan.box, page);
    if (area(padded) / (page.page.width * page.page.height) > REGION_OCR_LIMITS.pageAreaRatio ||
      area(padded) > REGION_OCR_LIMITS.cropPixels) { gaps.push('region_ocr_large_gap_not_cropped'); continue; }
    // Overlapping source gaps share one attempt; do not spend again on almost
    // the same pixels through another OCR engine's region.
    if (bounded.some(item => Math.max(0, Math.min(item.box[2], plan.box[2]) - Math.max(item.box[0], plan.box[0])) *
      Math.max(0, Math.min(item.box[3], plan.box[3]) - Math.max(item.box[1], plan.box[1])) / Math.min(area(item.box), area(plan.box)) >= 0.8)) {
      gaps.push('region_ocr_overlapping_gap_not_repeated'); continue;
    }
    if (bounded.length >= REGION_OCR_LIMITS.perPage) { gaps.push('region_ocr_page_budget_exhausted'); continue; }
    bounded.push({ ...plan, occurrenceId: `region-gap:${configHash([page.page.page_asset_id, plan.box, plan.sourceRegionIds]).slice(0, 32)}` });
  }
  return { targets: bounded, coverageGaps: unique(gaps) };
}
export async function augmentDocumentRegions(input: {
  page: DocumentPageArtifact; png: Uint8Array; signal?: AbortSignal;
  execute: (request: DocumentRegionOcrRequest, image: Uint8Array, signal?: AbortSignal) => Promise<RegionOcrDispatchResult>;
}): Promise<DocumentPageArtifact> {
  const page = DocumentPageArtifactSchema.parse(input.page);
  if (sha256(input.png) !== page.imageSha256) throw new Error('region_ocr_page_image_mismatch');
  if (page.regionOcr) return page; // One pass per immutable page artifact.
  const plan = planRegionOcr(page), gaps = [...plan.coverageGaps], results: DocumentRegionOcrSummary['results'] = [];
  const additions: DocumentRegion[] = [];
  const sourceArtifactHash = configHash({ scope: page.scope, page: page.page, imageSha256: page.imageSha256,
    regions: page.regions, canonicalRegionIds: page.canonicalRegionIds, conflicts: page.conflicts });
  for (const target of plan.targets) {
    input.signal?.throwIfAborted();
    const padded = expanded(target.box, page), scale = Math.min(2, Math.sqrt(REGION_OCR_LIMITS.cropPixels / area(padded)));
    let rendered: Awaited<ReturnType<typeof cropPageRegion>>;
    try {
      rendered = await cropPageRegion({ page: page.page, pageImage: input.png, occurrenceId: target.occurrenceId,
        box: target.box, contextPixels: 6, scale });
    } catch {
      input.signal?.throwIfAborted();
      gaps.push('region_ocr_crop_unavailable');
      continue;
    }
    const { crop, image } = rendered;
    const request: DocumentRegionOcrRequest = { version: REGION_OCR_VERSION, sourcePageHash: page.imageSha256,
      sourceArtifactHash, crop, sourceRegionIds: target.sourceRegionIds, reasons: target.reasons };
    const requestHash = configHash(request);
    let result: RegionOcrDispatchResult;
    if (image.length > REGION_OCR_LIMITS.imageBytes) result = { state: 'budget_exhausted' };
    else result = await input.execute(request, image, input.signal);
    input.signal?.throwIfAborted();
    const addedIds: string[] = [];
    if (result.receipt) {
      const receipt = DocumentRegionOcrReceiptSchema.parse(result.receipt);
      if (receipt.requestHash !== requestHash || configHash(receipt.crop) !== configHash(crop) ||
        configHash(receipt) !== result.receiptHash) throw new Error('region_ocr_receipt_integrity_failed');
      const size = receipt.regions.reduce((count, region) => count + (region.raw_text?.length ?? 0), 0);
      if (size > 12_000 || receipt.regions.length > 500) gaps.push('region_ocr_evidence_budget_exhausted');
      else {
        for (const region of receipt.regions) {
          if (region.page_asset_id !== page.page.page_asset_id || region.document_version_id !== page.scope.documentVersionId ||
            region.parse_revision !== page.scope.parseRevision || !region.source_id.startsWith(`${crop.crop_id}:`) ||
            page.regions.some(original => original.region_id === region.region_id) || additions.some(old => old.region_id === region.region_id))
            throw new Error('region_ocr_source_collision');
          additions.push(region); addedIds.push(region.region_id);
        }
      }
      gaps.push(...receipt.coverageGaps);
    } else gaps.push(`region_ocr_${result.state}`);
    results.push({ cropId: crop.crop_id, requestHash, receiptHash: result.receiptHash ?? null, state: result.state,
      sourceRegionIds: target.sourceRegionIds, addedRegionIds: addedIds });
  }
  const oldIds = new Set(page.regions.map(region => region.region_id));
  const combined = reconcileRegionEvidence([...page.regions, ...additions]);
  const newConflicts = combined.conflicts.filter(item => item.region_ids.some(id => !oldIds.has(id)));
  if (newConflicts.length) gaps.push('region_ocr_source_conflict_unresolved');
  const anchors = additions.flatMap(region => region.raw_text?.trim() ? anchorsForText(page.page, [region], region.raw_text) : []);
  const coverageGaps = unique(gaps);
  const summary: DocumentRegionOcrSummary = { version: REGION_OCR_VERSION, planned: plan.targets.length, results,
    status: coverageGaps.length || results.some(result => result.state !== 'ready') ? 'partial' : results.length ? 'ready' : 'not_needed',
    coverageGaps };
  return DocumentPageArtifactSchema.parse({ ...page, regions: [...page.regions, ...additions], anchors: [...page.anchors, ...anchors],
    canonicalRegionIds: unique([...page.canonicalRegionIds, ...combined.canonical_region_ids.filter(id => !oldIds.has(id))]),
    conflicts: [...page.conflicts, ...newConflicts],
    duplicates: [...page.duplicates, ...combined.duplicates.filter(item => !oldIds.has(item.duplicate_region_id))],
    status: page.status === 'ready' && summary.status === 'partial' ? 'partial' : page.status,
    coverageGaps: unique([...page.coverageGaps, ...coverageGaps]), regionOcr: summary });
}
