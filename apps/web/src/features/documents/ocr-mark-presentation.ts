import type {DocumentOcrMark, DocumentOcrMarkPage, DocumentPageArtifact, EvidenceAnchor} from './types.ts';

export function ocrMarkPagesForSource(pages: readonly DocumentOcrMarkPage[] | undefined, documentId: string, parseRevision: string, sourceSha256: string) {
  return pages?.filter(page => page.schemaVersion === 'ocr-marks.v1' && page.documentVersionId === documentId && page.parseRevision === parseRevision && page.sourceSha256 === sourceSha256).sort((a, b) => a.pageNumber - b.pageNumber);
}
export const ocrMarkLabel = (kind: DocumentOcrMark['kind']) => kind === 'stamp' ? '疑似印章' : '疑似签字';
export function ocrMarkScore(score: number | null) {return score === null || !Number.isFinite(score) || score < 0 || score > 1 ? '未提供' : `${Math.round(score * 100)}%`;}
export function ocrMarkPageNotice(page: DocumentOcrMarkPage) {
  if (page.status === 'unavailable') return '本页线索暂不可用';
  if (page.status === 'partial' || page.coverageGaps.length) return '本页线索不完整';
  if (page.supportedKinds === null) return '覆盖范围未说明';
  if (!page.supportedKinds.includes('stamp')) return '印章线索未覆盖';
  if (!page.supportedKinds.includes('signature')) return '签字线索未覆盖';
  return undefined;
}
/** Use only immutable image anchors verified against the loaded original page; raw detector coordinates never become overlays. */
export function ocrMarkSourceAnchorIds(layer: DocumentOcrMarkPage, mark: DocumentOcrMark, page: DocumentPageArtifact, anchors: readonly EvidenceAnchor[]): string[] {
  const asset = page.page;
  if (layer.documentVersionId !== page.scope.documentVersionId || layer.documentVersionId !== asset.document_version_id || layer.parseRevision !== page.scope.parseRevision || layer.parseRevision !== asset.parse_revision
    || layer.sourceSha256 !== page.scope.sourceSha256 || asset.source_sha256 !== (page.scope.previewSha256 ?? page.scope.sourceSha256) || layer.imageSha256 !== page.imageSha256 || layer.pageNumber !== asset.page_number || layer.pageAssetId !== asset.page_asset_id
    || layer.status === 'unavailable' || mark.mappingStatus !== 'verified' || !mark.regionId || !mark.bbox || !mark.polygon || mark.polygon.length < 3 || !layer.items.some(item => item.id === mark.id && JSON.stringify(item) === JSON.stringify(mark))) return [];
  const [left, top, right, bottom] = mark.bbox;
  if (![left, top, right, bottom].every(Number.isFinite) || left < 0 || top < 0 || right <= left || bottom <= top || right > asset.width || bottom > asset.height
    || mark.polygon.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < left || y < top || x > right || y > bottom)) return [];
  const samePolygon = (polygon: number[][]) => JSON.stringify(polygon) === JSON.stringify(mark.polygon);
  if (!page.regions.some(region => region.region_id === mark.regionId && region.page_asset_id === layer.pageAssetId && region.document_version_id === layer.documentVersionId && region.parse_revision === layer.parseRevision && region.kind === 'image' && region.polygons.some(samePolygon))) return [];
  return anchors.filter(anchor => anchor.document_version_id === layer.documentVersionId && anchor.parse_revision === layer.parseRevision && anchor.page_number === layer.pageNumber && anchor.page_asset_id === layer.pageAssetId
    && anchor.evidence_kind === 'image_region' && anchor.localization_status === 'block_only' && anchor.text_span_refs.length === 0 && anchor.block_ids.includes(mark.regionId!) && anchor.polygons.some(samePolygon)).map(anchor => anchor.anchor_id);
}
