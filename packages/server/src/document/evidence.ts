import { createHash } from 'node:crypto';
import type { DocumentRegion, EvidenceAnchor, PageAsset } from '@hsbc/contracts/evidence';
import { codePointMatches, codePointSlice, validatePolygon } from './geometry.js';

export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
/** No normalization: offsets always refer to the immutable text of this source. */
export function anchorsForText(page: PageAsset, regions: DocumentRegion[], target: string): EvidenceAnchor[] {
  const anchors: EvidenceAnchor[] = [];
  for (const region of regions) {
    if (region.page_asset_id !== page.page_asset_id || region.parse_revision !== page.parse_revision || region.document_version_id !== page.document_version_id)
      throw new Error('stale_evidence_source');
    if (region.raw_text === null || region.raw_text_sha256 !== sha256(region.raw_text)) continue;
    for (const span of codePointMatches(region.raw_text, target)) {
      const known = region.polygons.length > 0 && region.processing_status === 'ready';
      // Identity belongs to an immutable source span, not to the order of hits
      // for a query. Different targets can otherwise collide within one block.
      const anchorId = `text:${sha256(JSON.stringify([page.document_version_id, page.parse_revision, page.page_asset_id, region.region_id, region.raw_text_sha256, span.offset, span.length]))}`;
      anchors.push({ schema_version: 'p0.v1', anchor_id: anchorId, evidence_kind: 'text',
        document_version_id: page.document_version_id, parse_revision: page.parse_revision, page_asset_id: page.page_asset_id, page_number: page.page_number,
        block_ids: [region.region_id], text_span_refs: [{ block_id: region.region_id, ...span, offset_unit: 'unicode_code_point' }],
        polygons: known ? region.polygons.map(p => validatePolygon(p, page.width, page.height)) : [],
        granularity: 'block', localization_status: known ? 'block_only' : 'unavailable',
        localization_source: region.source, configuration_version: page.renderer_config,
        reason: known ? 'source_item_geometry_only' : region.localization_reason ?? 'source_geometry_unavailable', candidate_anchor_ids: [],
      });
    }
  }
  if (anchors.length > 1) for (const anchor of anchors) {
    if (anchor.localization_status !== 'unavailable') anchor.localization_status = 'ambiguous';
    anchor.candidate_anchor_ids = anchors.filter(a => a.anchor_id !== anchor.anchor_id).map(a => a.anchor_id);
    anchor.reason = 'multiple_source_matches';
  }
  return anchors;
}
export function validateAnchorSource(anchor: EvidenceAnchor, page: PageAsset, regions: DocumentRegion[]): void {
  if (anchor.page_asset_id !== page.page_asset_id || anchor.document_version_id !== page.document_version_id || anchor.parse_revision !== page.parse_revision || anchor.page_number !== page.page_number)
    throw new Error('stale_evidence_source');
  anchor.polygons.forEach(p => validatePolygon(p, page.width, page.height));
  for (const span of anchor.text_span_refs) {
    const region = regions.find(r => r.region_id === span.block_id && r.page_asset_id === page.page_asset_id && r.parse_revision === page.parse_revision && r.document_version_id === page.document_version_id);
    if (!region || region.raw_text === null || region.raw_text_sha256 !== sha256(region.raw_text)) throw new Error('missing_text_source');
    codePointSlice(region.raw_text, span.offset, span.length);
  }
}
/** Same-position overlap may duplicate evidence. Same text at another position remains a separate occurrence. */
export function compareRegionSources(a: DocumentRegion, b: DocumentRegion): 'distinct' | 'duplicate' | 'conflict' {
  if (a.page_asset_id !== b.page_asset_id || a.parse_revision !== b.parse_revision || a.polygons.length !== 1 || b.polygons.length !== 1) return 'distinct';
  const bounds = (r: DocumentRegion) => { const p = r.polygons[0]!; return [Math.min(...p.map(x => x[0])), Math.min(...p.map(x => x[1])), Math.max(...p.map(x => x[0])), Math.max(...p.map(x => x[1]))]; };
  const [ax, ay, ar, ab] = bounds(a) as [number, number, number, number], [bx, by, br, bb] = bounds(b) as [number, number, number, number];
  const intersection = Math.max(0, Math.min(ar, br) - Math.max(ax, bx)) * Math.max(0, Math.min(ab, bb) - Math.max(ay, by));
  const union = (ar - ax) * (ab - ay) + (br - bx) * (bb - by) - intersection;
  if (union <= 0 || intersection / union < 0.85) return 'distinct';
  return a.raw_text !== null && a.raw_text === b.raw_text ? 'duplicate' : 'conflict';
}
