import { z } from 'zod';
import type { DocumentOcrMarkPage } from '@hsbc/contracts/documents';
import { PageAssetSchema, type AffineTransform, type DocumentRegion, type EvidenceAnchor, type PageAsset, type Polygon } from '@hsbc/contracts/evidence';
import { anchorsForText, sha256 } from './evidence.js';
import { polygonArea, validatePolygon } from './geometry.js';
import { buildLocalizationEvidence } from './localize.js';
import { OcrParseResultSchema, type LocalizationSchema, type OcrParseResult, type WordOcr } from './ocr-client.js';
import { normalizeOcrMarks } from './ocr-marks.js';

const identity: AffineTransform = [1, 0, 0, 1, 0, 0];
const number = z.number().finite();
const rawPoint = z.tuple([number, number]);
const VlBlockSchema = z.object({
  block_id: z.union([z.string(), number]), block_order: number.nullable().optional(),
  block_label: z.string(), block_content: z.string(),
  block_bbox: z.tuple([number, number, number, number]),
  block_polygon_points: z.array(rawPoint).nullable().optional(),
});
const VlSchema = z.object({
  width: z.number().int().positive(), height: z.number().int().positive(),
  model_settings: z.record(z.string(), z.unknown()), doc_preprocessor_res: z.unknown().optional(),
  parsing_res_list: z.array(z.unknown()),
});

type LayerStatus = 'ready' | 'partial' | 'unavailable';
interface Layer {
  status: LayerStatus;
  model_version: string | null;
  configuration_version: string | null;
  region_ids: string[];
  coverage_gaps: string[];
}
export interface CombinedOcrPage {
  schema_version: 'p0.v1';
  page: PageAsset;
  image_sha256: string;
  ocrMarks: DocumentOcrMarkPage;
  layout: Layer & { markdown: string; raw_result: unknown };
  localization: Layer & {
    detector: string | null; recognizer: string | null; method: string | null;
    granularity: string | null; raw_result: WordOcr | null;
  };
  regions: DocumentRegion[];
  targets: Array<{ target: string; layout_anchors: EvidenceAnchor[]; localization_anchors: EvidenceAnchor[] }>;
  coverage_gaps: string[];
}

const distinct = (values: string[]) => [...new Set(values)];
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Same HTTP response, independent OCR sources. This does not adjudicate field values. */
export function combineOcrPage(input: { page: PageAsset; response: OcrParseResult; targets: string[]; imageSha256: string; sourceSha256?: string }): CombinedOcrPage {
  const page = PageAssetSchema.parse(input.page);
  if (!/^[a-f0-9]{64}$/.test(input.imageSha256)) throw new Error('invalid_page_image_hash');
  if (input.targets.some(target => !target)) throw new Error('empty_target');
  const response = OcrParseResultSchema.parse(input.response);
  if (response.pages.length !== 1) throw new Error('single_ocr_page_required');
  const source = response.pages[0]!;
  const marks = normalizeOcrMarks({ page, result: source.result, imageSha256: input.imageSha256, sourceSha256: input.sourceSha256 });
  const raw = object(source.result);
  const parsedVl = VlSchema.safeParse(raw?.res ?? raw);
  const vlRegions: DocumentRegion[] = [], vlGaps: string[] = [];
  let vlConfiguration: string | null = null;

  if (!parsedVl.success) vlGaps.push('vl_response_shape_unsupported');
  else {
    const vl = parsedVl.data;
    vlConfiguration = sha256(JSON.stringify({ adapter: 'vl-blocks-v1', settings: vl.model_settings }));
    const sameSize = vl.width === page.width && vl.height === page.height;
    const mappingKnown = vl.model_settings.use_doc_preprocessor === false && vl.doc_preprocessor_res == null;
    const mappingError = !sameSize ? 'vl_page_dimensions_mismatch' : !mappingKnown ? 'vl_coordinate_mapping_unverified' : null;
    if (mappingError) vlGaps.push(mappingError);
    const ids = new Set<string>();
    for (const [index, rawBlock] of vl.parsing_res_list.entries()) {
      const parsedBlock = VlBlockSchema.safeParse(rawBlock);
      if (!parsedBlock.success) { vlGaps.push('vl_block_shape_unsupported'); continue; }
      const block = parsedBlock.data;
      const sourceId = String(block.block_id);
      if (ids.has(sourceId)) throw new Error('duplicate_vl_source_id');
      ids.add(sourceId);
      let polygons: Polygon[] = [], reason = mappingError;
      try {
        if (mappingError) throw new Error(mappingError);
        const [left, top, right, bottom] = block.block_bbox;
        if (left > right || top > bottom) throw new Error('geometry_invalid_bbox');
        const polygon: Polygon = block.block_polygon_points?.map(point => [...point]) ?? [[left, top], [right, top], [right, bottom], [left, bottom]];
        if (polygonArea(polygon) < 0) polygon.reverse();
        polygons = [validatePolygon(polygon, page.width, page.height)];
      } catch (error) { reason = error instanceof Error ? error.message : 'geometry_unavailable'; }
      if (reason) vlGaps.push(reason);
      const kind = block.block_label === 'table' ? 'table' : /image|figure|chart/.test(block.block_label) ? 'image' : block.block_label === 'signature' ? 'signature' : 'text';
      vlRegions.push({
        region_id: `${page.page_asset_id}:vl:${vlConfiguration}:${sourceId}`, source_id: sourceId,
        page_asset_id: page.page_asset_id, document_version_id: page.document_version_id, parse_revision: page.parse_revision,
        source: 'vl_ocr', kind, reading_order: index,
        raw_text: block.block_content, raw_text_sha256: sha256(block.block_content), polygons,
        processing_status: 'ready', coverage: ['text'], coverage_gaps: reason ? [reason] : [], localization_reason: reason,
      });
    }
  }

  const word = source.word_ocr;
  const ppGaps: string[] = [];
  let ppConfiguration: string | null = null;
  let normalized: z.infer<typeof LocalizationSchema> | null = null;
  let ppMapping: AffineTransform | null = null;
  if (!word) ppGaps.push('word_ocr_not_requested_or_unavailable');
  else {
    ppConfiguration = sha256(JSON.stringify({ adapter: 'deployed-word-ocr-v1', model: word.model, detector: word.detector, recognizer: word.recognizer, coordinate_system: word.coordinate_system, granularity: word.granularity, method: word.method }));
    ppMapping = word.width === page.width && word.height === page.height ? identity : null;
    if (!ppMapping) ppGaps.push('pp_page_dimensions_mismatch');
    const items: z.infer<typeof LocalizationSchema>['items'] = [];
    for (const [line, text] of word.rec_texts.entries()) {
      items.push({ source_id: `line:${line}`, text, granularity: 'line', polygon: word.rec_polys[line]!, confidence: word.rec_scores[line]! });
      for (const [unit, unitText] of word.text_word[line]!.entries()) {
        items.push({ source_id: `line:${line}:word:${unit}`, text: unitText, granularity: 'word', polygon: word.text_word_region[line]![unit]!, confidence: null });
      }
    }
    // Raw finite coordinates may be negative or outside the image. The mapping
    // layer degrades each invalid item; do not reject or clip the whole response.
    normalized = { schema_version: 'p0.v1', model_version: word.model, configuration_version: ppConfiguration,
      width: word.width, height: word.height, items, raw_result: word };
  }
  const ppByTarget = new Map<string, EvidenceAnchor[]>();
  let ppRegions: DocumentRegion[] = [];
  // An internal unmatched target still constructs regions when callers only need parsing.
  for (const target of distinct(input.targets.length ? input.targets : ['\u0000'])) {
    if (!normalized) break;
    const evidence = buildLocalizationEvidence(normalized, page, ppMapping, target);
    ppRegions = evidence.regions;
    ppByTarget.set(target, evidence.anchors);
  }
  ppGaps.push(...ppRegions.flatMap(region => region.coverage_gaps));
  const layout: CombinedOcrPage['layout'] = {
    status: !parsedVl.success ? 'unavailable' : vlGaps.length ? 'partial' : 'ready',
    model_version: null, configuration_version: vlConfiguration,
    markdown: source.markdown, raw_result: source.result, region_ids: vlRegions.map(region => region.region_id), coverage_gaps: distinct(vlGaps),
  };
  const localization: CombinedOcrPage['localization'] = {
    status: !word ? 'unavailable' : ppGaps.length ? 'partial' : 'ready',
    model_version: word?.model ?? null, detector: word?.detector ?? null, recognizer: word?.recognizer ?? null,
    method: word?.method ?? null, granularity: word?.granularity ?? null, configuration_version: ppConfiguration,
    raw_result: word ?? null, region_ids: ppRegions.map(region => region.region_id), coverage_gaps: distinct(ppGaps),
  };
  return {
    schema_version: 'p0.v1', page, image_sha256: input.imageSha256, ocrMarks: marks.layer, layout, localization,
    regions: [...vlRegions, ...ppRegions, ...marks.regions],
    targets: distinct(input.targets).map(target => {
      const layoutAnchors = anchorsForText(page, vlRegions, target);
      for (const anchor of layoutAnchors) anchor.configuration_version = vlConfiguration!;
      return { target, layout_anchors: layoutAnchors, localization_anchors: ppByTarget.get(target) ?? [] };
    }),
    coverage_gaps: distinct([...vlGaps, ...ppGaps]),
  };
}
