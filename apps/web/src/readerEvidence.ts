import type {EvidenceAnchor, DocumentFieldObservation, DocumentSignatureCandidate} from './features/documents/types.ts';

export interface ReaderEvidenceScope {
  documentId: string;
  parseRevision: string;
  pageAssetId: string;
  pageNumber: number;
}

/** Select business evidence for the current page; raw OCR observations remain stored but are not overlays. */
export function usefulEvidenceAnchors(
  scope: ReaderEvidenceScope,
  anchors: readonly EvidenceAnchor[],
  fields: readonly DocumentFieldObservation[],
  signatures: readonly DocumentSignatureCandidate[],
  selectedIds: readonly string[],
): EvidenceAnchor[] {
  const wanted = new Set(selectedIds);
  for (const field of fields) {
    if (field.documentVersionId !== scope.documentId || field.parseRevision !== scope.parseRevision) continue;
    for (const id of field.anchorIds) wanted.add(id);
    for (const candidate of field.candidates) for (const id of [...candidate.anchorIds,...(candidate.contextAnchorIds??[])]) wanted.add(id);
  }
  // Filter identities before resolving references; a stale root must not introduce current-page candidates.
  const scoped = new Map<string, EvidenceAnchor>();
  for (const anchor of anchors) {
    if (anchor.document_version_id === scope.documentId && anchor.parse_revision === scope.parseRevision
      && anchor.page_asset_id === scope.pageAssetId && anchor.page_number === scope.pageNumber && !scoped.has(anchor.anchor_id)) scoped.set(anchor.anchor_id, anchor);
  }
  const included = new Set<string>();
  const includeSources = (rootIds: Iterable<string>, regions?: ReadonlySet<string>) => {
    const pending = [...rootIds], visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const anchor = scoped.get(id);
      if (!anchor) continue;
      if (!regions?.size || anchor.block_ids.some(blockId => regions.has(blockId))) included.add(id);
      // Ambiguous roots may have only candidate references, with no geometry of their own.
      if (anchor.localization_status === 'ambiguous') pending.push(...anchor.candidate_anchor_ids);
    }
  };
  includeSources(wanted);
  for (const signature of signatures) {
    if (signature.kind !== 'image_unclassified' && signature.pageNumber === scope.pageNumber) includeSources(signature.anchorIds, new Set(signature.regionIds));
  }
  return [...scoped.values()].filter(anchor => included.has(anchor.anchor_id) && anchor.localization_status !== 'unavailable' && anchor.polygons.length > 0);
}

/** Keep real local geometry. Whole-page sources retain their page locator, without a misleading enclosing box. */
export function visibleEvidencePolygons(polygons: EvidenceAnchor['polygons'], width: number, height: number): EvidenceAnchor['polygons'] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  return polygons.filter(polygon => {
    if (polygon.length < 3 || polygon.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height)) return false;
    const twiceArea = polygon.reduce((area, [x, y], index) => {
      const [nextX, nextY] = polygon[(index + 1) % polygon.length];
      return area + x * nextY - nextX * y;
    }, 0);
    if (Math.abs(twiceArea) <= Number.EPSILON) return false;
    const xs = polygon.map(point => point[0]), ys = polygon.map(point => point[1]);
    const enclosingArea = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    return enclosingArea < width * height * 0.85;
  });
}
