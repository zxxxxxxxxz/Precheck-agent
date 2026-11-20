import { DocumentOcrMarkPageSchema, type DocumentOcrMark, type DocumentOcrMarkPage, type DocumentOcrMarkSource } from '@hsbc/contracts/documents';
import type { DocumentRegion, PageAsset, Polygon } from '@hsbc/contracts/evidence';
import { sha256 } from './evidence.js';
import { polygonArea, validatePolygon } from './geometry.js';

const ADAPTER = 'ocr-mark-clues-v2';
const MAX_SOURCES = 1000;
// These are independent of the page's text budget. Count both retained raw and
// mapped points before quadratic polygon validation or any geometry copies.
const MAX_RETAINED_POLYGON_POINTS = 8192;
const MAX_SERIALIZED_BYTES = 4 * 1024 * 1024;
// The engine later adds an image anchor with the same polygon. Reserve its
// geometry separately and ample bounded metadata, including escaped scope IDs.
const ANCHOR_METADATA_RESERVE_BYTES = 8192;
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
type Box = [number, number, number, number];
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown, max = 200): string | null => typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
const unique = (values: string[]) => [...new Set(values)];
const rawBox = (value: unknown): Box | null => Array.isArray(value) && value.length === 4 && value.every(finite) ? [...value] as Box : null;
const rawPolygon = (value: unknown): Polygon | null => Array.isArray(value) && value.length >= 3 && value.length <= 512 && value.every(point => Array.isArray(point) && point.length === 2 && point.every(finite)) ? value.map(point => [...point]) as Polygon : null;
const markKind = (label: unknown): DocumentOcrMark['kind'] | null => label === 'seal' || label === 'stamp' ? 'stamp' : label === 'signature' ? 'signature' : null;
function intersectionOverUnion(a: Box, b: Box): number {
  const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return intersection / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection);
}

/** Preserve explicit upstream mark labels only. This performs no detection or absence inference. */
export function normalizeOcrMarks(input: { page: PageAsset; result: unknown; imageSha256: string; sourceSha256?: string }): { layer: DocumentOcrMarkPage; regions: DocumentRegion[] } {
  const { page } = input, outer = object(input.result), root = object(outer?.res) ?? outer;
  const settings = object(root?.model_settings), gaps: string[] = [];
  const layout = object(root?.layout_det_res);
  const layoutList = Array.isArray(root?.layout_det_res);
  const hasBoxes = !!layout && Array.isArray(layout.boxes);
  const blocks = Array.isArray(root?.parsing_res_list) ? root.parsing_res_list : [];
  let mappingError: string | null = !root || root.width !== page.width || root.height !== page.height ? 'ocr_marks_page_dimensions_mismatch'
    : settings?.use_doc_preprocessor !== false || root.doc_preprocessor_res != null ? 'ocr_marks_coordinate_mapping_unverified' : null;
  if (mappingError) gaps.push(mappingError);
  if (layoutList) gaps.push('ocr_marks_layout_list_mapping_unverified');
  else if (!hasBoxes) gaps.push('ocr_marks_layout_unavailable');
  if (settings?.use_layout_detection === false) { gaps.push('ocr_marks_layout_disabled'); mappingError ??= 'ocr_marks_layout_disabled'; }

  // Configuration and response hashes cover bounded source metadata, never OCR text or file paths.
  const configuration = Object.fromEntries(Object.entries(settings ?? {}).filter(([key, value]) =>
    ['use_doc_preprocessor', 'use_layout_detection', 'use_seal_recognition', 'merge_layout_blocks', 'return_layout_polygon_points'].includes(key)
    && (typeof value === 'boolean' || finite(value))));
  const model = text(layout?.model_name), modelVersion = text(layout?.model_version);
  const configurationSha256 = sha256(JSON.stringify({ adapter: ADAPTER, settings: configuration, model, modelVersion }));
  const declaredLabels = layout?.supported_labels;
  const supportedKinds = Array.isArray(declaredLabels) && declaredLabels.length <= 100 && declaredLabels.every(label => typeof label === 'string' && label.length <= 64)
    ? [...new Set(declaredLabels.map(markKind).filter((kind): kind is DocumentOcrMark['kind'] => kind !== null))] : null;
  const items: DocumentOcrMark[] = [];
  const sourceSummary: unknown[] = [];
  let seenSources = 0, retainedPolygonPoints = 0;
  const add = (value: unknown, source: DocumentOcrMarkSource['source'], index: number, listIndex?: number) => {
    const raw = object(value);
    if (!raw) { gaps.push('ocr_marks_source_shape_invalid'); return; }
    const label = source === 'layout_detection' ? raw.label : raw.block_label;
    const kind = markKind(label);
    if (!kind) return;
    if (++seenSources > MAX_SOURCES) { gaps.push('ocr_marks_source_budget_exceeded'); return; }
    const issues: string[] = [];
    const originalBox = source === 'layout_detection' ? raw.coordinate : raw.block_bbox;
    const originalPolygon = source === 'layout_detection' ? raw.polygon_points : raw.block_polygon_points;
    const bbox = rawBox(originalBox), originalValidPolygon = rawPolygon(originalPolygon);
    const reason = mappingError ?? (listIndex === undefined ? null : 'ocr_marks_layout_list_mapping_unverified');
    const pointCost = (originalValidPolygon?.length ?? 0)
      + (!reason && bbox && (originalPolygon == null || originalValidPolygon) ? originalValidPolygon?.length ?? 4 : 0);
    const geometryBudgetExceeded = retainedPolygonPoints + pointCost > MAX_RETAINED_POLYGON_POINTS;
    const polygon = geometryBudgetExceeded ? null : originalValidPolygon;
    if (geometryBudgetExceeded) issues.push('ocr_marks_polygon_budget_exceeded');
    else retainedPolygonPoints += pointCost;
    if (!bbox) issues.push('ocr_mark_bbox_invalid');
    if (originalPolygon != null && !originalValidPolygon) issues.push('ocr_mark_polygon_invalid');
    const rawScore = finite(raw.score) ? raw.score : null;
    const score = rawScore !== null && rawScore >= 0 && rawScore <= 1 ? rawScore : null;
    if (raw.score != null && score === null) issues.push('ocr_mark_score_invalid');
    const rawId = source === 'layout_block' ? raw.block_id : raw.id;
    const classId = finite(raw.cls_id) ? raw.cls_id : text(raw.cls_id, 64);
    if (raw.cls_id != null && classId === null) issues.push('ocr_mark_class_id_invalid');
    const sourceRef: DocumentOcrMarkSource = {
      source, index, sourceId: listIndex === undefined ? finite(rawId) ? String(rawId) : text(rawId) : `list:${listIndex}:${index}`,
      label: label as string, classId, score: rawScore,
      bbox, polygon,
    };
    // Hash the original bounded geometry without retaining a second raw copy.
    // Budget degradation must not make different upstream polygons hash alike.
    sourceSummary.push({ ...sourceRef, polygon: undefined,
      polygonSha256: originalValidPolygon ? sha256(JSON.stringify(originalValidPolygon)) : null });
    let verifiedBox: Box | null = null, verifiedPolygon: Polygon | null = null;
    if (reason) issues.push(reason);
    else if (!geometryBudgetExceeded && bbox && (originalPolygon == null || polygon)) {
      try {
        const [left, top, right, bottom] = bbox;
        if (!(left >= 0 && top >= 0 && right > left && bottom > top && right <= page.width && bottom <= page.height)) throw new Error('invalid');
        const geometry: Polygon = polygon ? polygon.map(point => [...point]) : [[left, top], [right, top], [right, bottom], [left, bottom]];
        if (polygonArea(geometry) < 0) geometry.reverse();
        validatePolygon(geometry, page.width, page.height);
        // A polygon from a different coordinate frame must not borrow this box's validity.
        if (geometry.some(([x, y]) => x < left || x > right || y < top || y > bottom)) throw new Error('invalid');
        verifiedBox = [...bbox]; verifiedPolygon = geometry;
      } catch { issues.push('ocr_mark_geometry_invalid'); }
    }
    const matches = verifiedBox ? items.filter(item => item.kind === kind && item.bbox && item.sourceRefs.some(ref => ref.source === 'layout_detection')
      && (source === 'layout_block' ? intersectionOverUnion(item.bbox, verifiedBox!) >= 0.9
        : JSON.stringify(item.bbox) === JSON.stringify(verifiedBox) && JSON.stringify(item.polygon) === JSON.stringify(verifiedPolygon))) : [];
    if (matches.length === 1) {
      const match = matches[0]!;
      if (match.sourceRefs.length < 16) match.sourceRefs.push(sourceRef);
      else issues.push('ocr_mark_source_refs_truncated');
      match.coverageGaps = unique([...match.coverageGaps, ...issues]);
    } else {
      if (matches.length > 1) issues.push('ocr_mark_duplicate_mapping_ambiguous');
      const id = `ocr-mark:${sha256(JSON.stringify([page.page_asset_id, configurationSha256, source, index, listIndex ?? null]))}`;
      items.push({ id, kind, score, regionId: verifiedBox ? `${id}:region` : null,
        bbox: verifiedBox, polygon: verifiedPolygon, mappingStatus: verifiedBox ? 'verified' : 'unavailable',
        sourceRefs: [sourceRef], coverageGaps: unique(issues) });
    }
    gaps.push(...issues);
  };
  if (hasBoxes) {
    const boxes = layout!.boxes as unknown[];
    if (boxes.length > MAX_SOURCES) gaps.push('ocr_marks_source_budget_exceeded');
    boxes.slice(0, MAX_SOURCES).forEach((value, index) => add(value, 'layout_detection', index));
  } else if (layoutList) {
    // Multi-image / tiled layouts have no verified per-entry inverse transform here.
    const entries = root!.layout_det_res as unknown[];
    if (entries.length > 16) gaps.push('ocr_marks_source_budget_exceeded');
    entries.slice(0, 16).forEach((entry, listIndex) => {
      const boxes = object(entry)?.boxes;
      if (!Array.isArray(boxes)) { gaps.push('ocr_marks_source_shape_invalid'); return; }
      if (boxes.length > MAX_SOURCES) gaps.push('ocr_marks_source_budget_exceeded');
      boxes.slice(0, MAX_SOURCES).forEach((value, index) => add(value, 'layout_detection', index, listIndex));
    });
  }
  if (blocks.length > 5000) gaps.push('ocr_marks_source_budget_exceeded');
  blocks.slice(0, 5000).forEach((value, index) => add(value, 'layout_block', index));
  if (!hasBoxes && items.length) gaps.push('ocr_marks_detection_coverage_unknown');
  const layer: DocumentOcrMarkPage = {
    schemaVersion: 'ocr-marks.v1', pageNumber: page.page_number, pageAssetId: page.page_asset_id,
    documentVersionId: page.document_version_id, parseRevision: page.parse_revision,
    sourceSha256: input.sourceSha256 ?? page.source_sha256, imageSha256: input.imageSha256,
    status: gaps.length ? hasBoxes || items.length ? 'partial' : 'unavailable' : 'reported',
    responseSha256: root ? sha256(JSON.stringify({ width: finite(root.width) ? root.width : null, height: finite(root.height) ? root.height : null,
      hasBoxes, layoutList, configurationSha256, declaredKinds: supportedKinds, sources: sourceSummary })) : null,
    configurationSha256, model, modelVersion, supportedKinds, items, coverageGaps: unique(gaps), absenceProven: false,
  };
  let regions: DocumentRegion[] = layer.items.filter(item => item.regionId && item.polygon).map((item, index) => ({
    region_id: item.regionId!, source_id: item.id, page_asset_id: page.page_asset_id,
    document_version_id: page.document_version_id, parse_revision: page.parse_revision,
    source: 'vl_ocr', kind: 'image', reading_order: index, raw_text: null, raw_text_sha256: null,
    polygons: [item.polygon!], processing_status: 'ready', coverage: ['image_evidence'],
    coverage_gaps: ['ocr_mark_is_unconfirmed_clue', ...item.coverageGaps], localization_reason: 'ocr_mark_reported_region',
  }));
  const regionsById = new Map(regions.map(region => [region.region_id, region]));
  const cost = (item: DocumentOcrMark): number => {
    const region = item.regionId ? regionsById.get(item.regionId) : undefined;
    return jsonBytes(item) + 1 + (region ? jsonBytes(region) + 1 + jsonBytes(region.polygons) + ANCHOR_METADATA_RESERVE_BYTES : 0);
  };
  // The envelope reserve also covers diagnostics added during degradation.
  let serializedBytes = jsonBytes({ layer: { ...layer, items: [] }, regions: [] }) + 4096
    + layer.items.reduce((sum, item) => sum + cost(item), 0);
  for (let index = layer.items.length - 1; serializedBytes > MAX_SERIALIZED_BYTES && index >= 0; index--) {
    const item = layer.items[index]!;
    if (!item.polygon && !item.sourceRefs.some(ref => ref.polygon)) continue;
    const before = cost(item);
    item.regionId = null; item.bbox = null; item.polygon = null; item.mappingStatus = 'unavailable';
    item.sourceRefs = item.sourceRefs.map(ref => ({ ...ref, polygon: null }));
    item.coverageGaps = unique([...item.coverageGaps, 'ocr_marks_serialization_budget_exceeded']);
    serializedBytes += cost(item) - before;
    layer.status = 'partial';
    layer.coverageGaps = unique([...layer.coverageGaps, 'ocr_marks_serialization_budget_exceeded']);
  }
  // At most 1000 bounded source references remain even if every geometry is
  // removed; their IDs, class IDs, scores and raw boxes fit within this budget.
  const retainedRegionIds = new Set(layer.items.flatMap(item => item.regionId ? [item.regionId] : []));
  regions = regions.filter(region => retainedRegionIds.has(region.region_id));
  return { layer: DocumentOcrMarkPageSchema.parse(layer), regions };
}
