import type { z } from 'zod';
import type { AffineTransform, DocumentRegion, EvidenceAnchor, PageAsset } from '@hsbc/contracts/evidence';
import type { LocalizationSchema } from './ocr-client.js';
import { anchorsForText, sha256 } from './evidence.js';
import { codePointMatches, mapCropPolygonToPage, validatePolygon } from './geometry.js';

/** PP-OCR owns its text spans. No offset from the VL source is ever reused. */
export function buildLocalizationEvidence(response: z.infer<typeof LocalizationSchema>, page: PageAsset, cropToPage: AffineTransform | null, target: string): { regions: DocumentRegion[]; anchors: EvidenceAnchor[] } {
  if (new Set(response.items.map(item => item.source_id)).size !== response.items.length) throw new Error('duplicate_localization_source_id');
  const regions = response.items.map((item, i): DocumentRegion => {
    let polygons: DocumentRegion['polygons'] = [], reason: string | null = null;
    try { validatePolygon(item.polygon, response.width, response.height); polygons = [mapCropPolygonToPage(item.polygon, cropToPage, page)]; }
    catch (error) { reason = error instanceof Error ? error.message : 'geometry_unavailable'; }
    return { region_id: `${page.page_asset_id}:pp:${response.configuration_version}:${item.source_id}`, source_id: item.source_id,
      page_asset_id: page.page_asset_id, document_version_id: page.document_version_id, parse_revision: page.parse_revision,
      source: 'pp_ocr', kind: 'text', reading_order: i, raw_text: item.text, raw_text_sha256: sha256(item.text),
      polygons, processing_status: 'ready', coverage: ['text'], coverage_gaps: reason ? [reason] : [], localization_reason: reason,
    };
  });
  const items = new Map(response.items.map(item => [item.source_id, item]));
  const bySource = new Map(regions.map(region => [region.source_id, region]));
  const wordRegions = regions.filter(region => items.get(region.source_id)?.granularity === 'word' && region.raw_text === target);
  const parentId = (region: DocumentRegion) => region.source_id.replace(/:word:\d+$/, '');
  const selectedWords = wordRegions.filter(word => {
    if (word.polygons.length > 0) return true;
    const parent = bySource.get(parentId(word));
    // One exact unit and one occurrence in its own valid parent line establish
    // the same occurrence. A broken unit box falls back to that line instead
    // of manufacturing a second candidate. Keep the raw unit region and gap.
    return !parent || items.get(parent.source_id)?.granularity !== 'line' || parent.polygons.length === 0
      || codePointMatches(parent.raw_text ?? '', target).length !== 1
      || wordRegions.filter(candidate => parentId(candidate) === parent.source_id).length !== 1;
  });
  const selected = [...selectedWords, ...regions.filter(region => {
    if (items.get(region.source_id)?.granularity !== 'line') return false;
    // The adapter's IDs establish parentage, not a correspondence to VL text.
    // Only replace a line when every occurrence has a valid finer candidate.
    // Partial word output must not erase other occurrences in this or another line.
    const children = wordRegions.filter(word => parentId(word) === region.source_id && word.polygons.length > 0);
    const occurrences = codePointMatches(region.raw_text ?? '', target).length;
    return occurrences > 0 && (children.length === 0 || children.length !== occurrences);
  })];
  const anchors = anchorsForText(page, selected, target);
  for (const anchor of anchors) {
    const region = regions.find(candidate => candidate.region_id === anchor.block_ids[0])!;
    anchor.granularity = items.get(region.source_id)!.granularity;
    anchor.configuration_version = response.configuration_version;
    if (anchor.granularity === 'word' && anchor.localization_status === 'block_only') { anchor.localization_status = 'exact'; anchor.reason = null; }
  }
  return { regions, anchors };
}
