import type { DocumentBundle, DocumentOcrMark, DocumentOcrMarkPage, DocumentPageArtifact } from '@hsbc/contracts/documents';
import type { EvidenceAnchor } from '@hsbc/contracts/evidence';

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function assertGeometry(item: DocumentOcrMark) {
  if (item.mappingStatus !== 'verified') return;
  const box = item.bbox!;
  if (item.polygon!.some(([x, y]) => x < box[0] || x > box[2] || y < box[1] || y > box[3]))
    throw new Error('p2_ocr_marks_geometry_invalid');
}

function assertLayerScope(layer: DocumentOcrMarkPage, scope: DocumentBundle['scope']) {
  if (layer.documentVersionId !== scope.documentVersionId || layer.parseRevision !== scope.parseRevision || layer.sourceSha256 !== scope.sourceSha256)
    throw new Error('p2_ocr_marks_scope_mismatch');
  if (new Set(layer.items.map(item => item.id)).size !== layer.items.length)
    throw new Error('p2_ocr_marks_identity_invalid');
}

function hasAnchor(layer: DocumentOcrMarkPage, regionId: string, polygon: unknown, anchors: EvidenceAnchor[]) {
  return anchors.some(anchor => anchor.document_version_id === layer.documentVersionId && anchor.parse_revision === layer.parseRevision
    && anchor.page_asset_id === layer.pageAssetId && anchor.page_number === layer.pageNumber
    && anchor.evidence_kind === 'image_region' && anchor.localization_status === 'block_only'
    && anchor.block_ids.length === 1 && anchor.block_ids[0] === regionId && same(anchor.polygons, [polygon]));
}

/** OCR output is a positioning clue. It does not establish signature presence or authorization. */
export function assertOcrMarkPage(page: DocumentPageArtifact): void {
  const layer = page.ocrMarks;
  if (!layer) return;
  assertLayerScope(layer, page.scope);
  if (layer.pageNumber !== page.page.page_number || layer.pageAssetId !== page.page.page_asset_id || layer.imageSha256 !== page.imageSha256)
    throw new Error('p2_ocr_marks_page_mismatch');
  for (const item of layer.items) {
    if (item.mappingStatus !== 'verified') continue;
    assertGeometry(item);
    const region = page.regions.find(value => value.region_id === item.regionId);
    if (!region || region.kind !== 'image' || region.raw_text !== null || region.page_asset_id !== layer.pageAssetId
      || region.document_version_id !== layer.documentVersionId || region.parse_revision !== layer.parseRevision || !same(region.polygons, [item.polygon])
      || !hasAnchor(layer, region.region_id, item.polygon, page.anchors)) throw new Error('p2_ocr_marks_evidence_mismatch');
    const box = item.bbox!;
    if (box[0] < 0 || box[1] < 0 || box[2] > page.page.width || box[3] > page.page.height
      || box[2] <= box[0] || box[3] <= box[1]) throw new Error('p2_ocr_marks_geometry_invalid');
  }
}

/** A legacy bundle has no retained OCR layer; do not manufacture empty detections for it. */
export function ocrMarkPagesForBundle(bundle: DocumentBundle, pages?: Array<{ page_number: number; page_asset_id: string; image_sha256: string }>): DocumentOcrMarkPage[] {
  const layers = bundle.ocrMarkPages ?? [], seen = new Set<number>();
  for (const layer of layers) {
    assertLayerScope(layer, bundle.scope);
    if (seen.has(layer.pageNumber) || bundle.pageCount !== null && layer.pageNumber > bundle.pageCount)
      throw new Error('p2_ocr_marks_page_mismatch');
    if (pages && !pages.some(page => page.page_number === layer.pageNumber && page.page_asset_id === layer.pageAssetId && page.image_sha256 === layer.imageSha256))
      throw new Error('p2_ocr_marks_page_mismatch');
    seen.add(layer.pageNumber);
    for (const item of layer.items) {
      assertGeometry(item);
      if (item.mappingStatus === 'verified' && (!item.regionId || !hasAnchor(layer, item.regionId, item.polygon, bundle.anchors)))
        throw new Error('p2_ocr_marks_evidence_mismatch');
    }
  }
  return layers;
}

/** Priority hints only; receiving these boxes must never count as a completed visual review. */
export function ocrMarkHintBoxes(page: DocumentPageArtifact): Array<[number, number, number, number]> {
  assertOcrMarkPage(page);
  return (page.ocrMarks?.items ?? []).filter(item => item.mappingStatus === 'verified' && item.bbox)
    .map(item => item.bbox!.map((coordinate, index) => index < 2 ? Math.floor(coordinate) : Math.ceil(coordinate)) as [number, number, number, number]);
}

export const OCR_MARK_BUNDLE_BYTES = 4 * 1024 * 1024;
/** Keep document summaries bounded independently of text. Full per-page clues
 * remain immutable and readable when their aggregate geometry exceeds budget. */
export function collectOcrMarkPages(pages: Pick<DocumentPageArtifact, 'ocrMarks' | 'anchors'>[], maximumBytes = OCR_MARK_BUNDLE_BYTES) {
  const reason = 'ocr_marks_document_budget_exceeded';
  const layers = pages.flatMap(page => page.ocrMarks ? [{ ...page.ocrMarks, items: [] as DocumentOcrMark[] }] : []);
  const auxiliaryIds = new Set(pages.flatMap(page => page.ocrMarks?.items.flatMap(item => item.regionId ? [item.regionId] : []) ?? []));
  const keptIds = new Set<string>();
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  // Reserve separators and all possible per-page diagnostic metadata upfront.
  let used = bytes(layers) + layers.length * 128 + 256;
  if (used > maximumBytes) throw new Error('ocr_marks_document_metadata_budget_exceeded');
  let layerIndex = 0;
  for (const page of pages) {
    if (!page.ocrMarks) continue;
    const layer = layers[layerIndex++]!;
    for (const original of page.ocrMarks.items) {
      let item = original;
      const anchors = item.regionId ? page.anchors.filter(anchor => anchor.block_ids.includes(item.regionId!)) : [];
      let size = bytes(item) + bytes(anchors) + 8;
      if (used + size > maximumBytes) {
        layer.status = 'partial';
        layer.coverageGaps = [...new Set([...layer.coverageGaps.slice(0, 39), reason])];
        item = { ...item, regionId: null, bbox: null, polygon: null, mappingStatus: 'unavailable',
          sourceRefs: item.sourceRefs.map(source => ({ ...source, polygon: null })),
          coverageGaps: [...new Set([...item.coverageGaps.slice(0, 19), reason])] };
        size = bytes(item) + 8;
        if (used + size > maximumBytes) continue;
      }
      layer.items.push(item); used += size;
      if (item.regionId) keptIds.add(item.regionId);
    }
  }
  return { layers, auxiliaryIds, keptIds };
}
