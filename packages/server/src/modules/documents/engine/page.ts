import { createCanvas, loadImage } from '@napi-rs/canvas';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DocumentRegion, EvidenceAnchor, Polygon } from '@hsbc/contracts/evidence';
import { DocumentEngineConfigSchema, DocumentPageArtifactSchema, DocumentScopeSchema, type DocumentEngineConfig, type DocumentPageArtifact, type DocumentScope } from '@hsbc/contracts/documents';
import {renderImagePage} from '../../../document/image.js';
import { parseNativePdf, renderPdfPage } from '../../../document/pdf.js';
import { anchorsForText, sha256 } from '../../../document/evidence.js';
import { combineOcrPage } from '../../../document/combine-ocr.js';
import { reconcileRegionEvidence } from '../../../document/regions.js';
import {assembleSourceText,assertSourceTextAssembly,SOURCE_TEXT_ENGINE_VERSION} from '../../../document/source-text-assembly.js';
import type { OcrParseResult } from '../../../document/ocr-client.js';
import { discoverVisibleInk } from './ink.js';
import { assertOcrMarkPage } from '../ocr-marks.js';
export { discoverVisibleInk } from './ink.js';

export const ENGINE_VERSION = SOURCE_TEXT_ENGINE_VERSION;
export const SYNTHETIC_DOCUMENT_CONFIG: DocumentEngineConfig = DocumentEngineConfigSchema.parse({
  version: 'p2-synthetic-v1', taxonomyVersion: 'p2-synthetic-taxonomy-v1', fieldDictionaryVersion: 'p2-synthetic-fields-v1',
  taxonomy: [
    { id: 'loan_agreement', label: '贷款协议', keywords: ['loan agreement', 'facility agreement', '贷款协议', '授信协议'] },
    { id: 'guarantee', label: '担保文件', keywords: ['guarantee agreement', 'guarantee deed', '担保合同', '保证合同'] },
    { id: 'resolution', label: '公司决议', keywords: ['board resolution', 'shareholder resolution', '董事会决议', '股东会决议'] },
    { id: 'authorization', label: '授权文件', keywords: ['power of attorney', 'authorized signatories', '授权委托书', '签署授权'] },
  ],
  fields: [
    { id: 'borrower', label: '借款人', aliases: ['Borrower', '借款人'], type: 'text' },
    { id: 'guarantor', label: '担保人', aliases: ['Guarantor', '担保人'], type: 'text' },
    { id: 'lender', label: '贷款银行', aliases: ['Lender', 'Lending Bank', '贷款银行'], type: 'text' },
    { id: 'amount', label: '融资金额', aliases: ['Facility Amount', 'Loan Amount', '融资金额', '贷款金额'], type: 'amount' },
    { id: 'currency', label: '币种', aliases: ['Currency', '币种'], type: 'currency' },
    { id: 'maturity', label: '到期日', aliases: ['Maturity Date', '到期日'], type: 'date' },
  ],
});
export const defaultEngineConfig = (): DocumentEngineConfig => structuredClone(SYNTHETIC_DOCUMENT_CONFIG);
export interface DocumentOcrAdapter { simulated?: boolean; parse(image: Uint8Array, options: { returnWordBox: true; signal?: AbortSignal }): Promise<OcrParseResult> }
export interface DocumentNerAdapter {
  simulated?: boolean;
  classify?(text: string, labels: string[], options?: { signal?: AbortSignal }): Promise<{ label: { label: string; confidence: number } }>;
  entities?(text: string, labels: string[], options?: { signal?: AbortSignal; wordSplitter?: 'whitespace' | 'char' }): Promise<{ entities: Record<string, Array<{ text: string; confidence: number }>> }>;
}
export interface ProcessPageOptions { scope: DocumentScope; config?: DocumentEngineConfig; ocr?: DocumentOcrAdapter; ner?: DocumentNerAdapter; signal?: AbortSignal }
export type ProcessedDocumentPage = DocumentPageArtifact & { png: Buffer };
const unique = <T>(values: T[]) => [...new Set(values)];
function bounds(polygon: Polygon): [number, number, number, number] {
  return [Math.min(...polygon.map(p => p[0])), Math.min(...polygon.map(p => p[1])), Math.max(...polygon.map(p => p[0])), Math.max(...polygon.map(p => p[1]))];
}
/** UTF-8 bound is conservative request sizing, not an estimate of provider tokens. */
export function boundedUtf8(text: string, maximum = 1500): string {
  let size = 0, result = '';
  for (const character of text) { const bytes = Buffer.byteLength(character); if (size + bytes > maximum) break; result += character; size += bytes; }
  return result;
}
async function bounded<T>(action: (signal: AbortSignal) => Promise<T>, milliseconds: number, outer?: AbortSignal): Promise<T> {
  const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds);
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  try { return await Promise.race([action(signal), new Promise<T>((_resolve, reject) => { onAbort = () => reject(new Error('provider_deadline')); signal.addEventListener('abort', onAbort, { once: true }); })]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
async function inspectPage(bytes: Uint8Array, pageNumber: number, config: DocumentEngineConfig) {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const task = getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: join(root, 'standard_fonts') + '/', cMapUrl: join(root, 'cmaps') + '/', cMapPacked: true, wasmUrl: join(root, 'wasm') + '/' });
  try {
    const document = await task.promise;
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) throw new Error('p2_page_out_of_range');
    const page = await document.getPage(pageNumber), viewport = page.getViewport({ scale: config.renderScale });
    if (!Number.isFinite(viewport.width * viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error('p2_page_pixel_budget_exceeded');
    // Preserve the source and lower only this page's render scale. Bound both the
    // rounded canvas allocation and its sides; extreme media boxes must not turn
    // into an unreadably tiny or unbounded-aspect canvas.
    const minimumScale = 0.5, maximumSide = 16384;
    const fits = (scale: number) => {
      const measured = page.getViewport({ scale }), width = Math.ceil(measured.width), height = Math.ceil(measured.height);
      return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
        && width <= maximumSide && height <= maximumSide && width * height <= config.maxPagePixels;
    };
    let renderScale = config.renderScale;
    if (!fits(renderScale)) {
      if (!fits(minimumScale)) throw new Error('p2_page_pixel_budget_exceeded');
      let lower = minimumScale, upper = renderScale;
      for (let iteration = 0; iteration < 48; iteration++) {
        const middle = (lower + upper) / 2;
        if (fits(middle)) lower = middle; else upper = middle;
      }
      renderScale = Math.floor(lower * 1_000_000) / 1_000_000;
      if (renderScale < minimumScale || !fits(renderScale)) throw new Error('p2_page_pixel_budget_exceeded');
    }
    const operators = await page.getOperatorList();
    const hiddenText = operators.fnArray.some((operator, index) => operator === OPS.setTextRenderingMode && [3, 7].includes(operators.argsArray[index]?.[0]));
    const vectorGraphics = operators.fnArray.some(operator => [OPS.constructPath, OPS.shadingFill].includes(operator));
    return { hiddenText, vectorGraphics, renderScale };
  } finally { await task.destroy(); }
}
/** One fixed document page per call: caller persists this result before requesting the next page. */
export async function processPage(bytes: Uint8Array, pageNumber: number, options: ProcessPageOptions): Promise<ProcessedDocumentPage> {
  const started = performance.now(), scope = DocumentScopeSchema.parse(options.scope), config = DocumentEngineConfigSchema.parse(options.config ?? defaultEngineConfig());
  options.signal?.throwIfAborted();
  if (sha256(bytes) !== (scope.previewSha256??scope.sourceSha256)) throw new Error('p2_document_hash_mismatch');
  if(scope.sourceFormat==='docx'&&(!scope.previewSha256||!scope.previewRevision))throw new Error('p2_preview_identity_required');
  const imageFormat=scope.sourceFormat==='png'||scope.sourceFormat==='jpg'?scope.sourceFormat:undefined;
  if(imageFormat&&pageNumber!==1)throw new Error('p2_page_out_of_range');
  const raster=imageFormat?await renderImagePage(bytes,imageFormat,scope,config.maxPagePixels):undefined;
  const inspection = raster?{hiddenText:false,vectorGraphics:false,renderScale:config.renderScale}:await inspectPage(bytes, pageNumber, config);
  const renderScale = inspection.renderScale;
  const native = raster?.native ?? (await parseNativePdf(bytes, { documentVersionId: scope.documentVersionId, parseRevision: scope.parseRevision, scale: renderScale, pages: [pageNumber] }))[0]!;
  if (native.regions.length > config.maxRegions || native.regions.reduce((n, region) => n + (region.raw_text?.length ?? 0), 0) > config.maxPageCharacters) throw new Error('p2_page_content_budget_exceeded');
  options.signal?.throwIfAborted();
  const png = raster?.png ?? await renderPdfPage(bytes, pageNumber, renderScale), image = await loadImage(png);
  const canvas = createCanvas(native.page.width, native.page.height), context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
  const pixelData = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const visible = (region: DocumentRegion) => {
    if (region.polygons.length !== 1 || !region.raw_text?.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(region.raw_text)) return false;
    const [l, t, r, b] = bounds(region.polygons[0]!); let ink = 0, tested = 0;
    for (let y = Math.max(0, Math.floor(t)); y < Math.min(canvas.height, Math.ceil(b)); y += 2) for (let x = Math.max(0, Math.floor(l)); x < Math.min(canvas.width, Math.ceil(r)); x += 2) {
      const p = (y * canvas.width + x) * 4; tested++; if (pixelData[p]! + pixelData[p + 1]! + pixelData[p + 2]! < 630 && pixelData[p + 3]! > 100) ink++;
    }
    return tested > 0 && ink / tested > 0.003 && ink / tested < 0.85;
  };
  const nativeText = native.regions.filter(region => region.source === 'native_pdf' && region.raw_text?.trim());
  const trusted = nativeText.length > 0 && !inspection.hiddenText && nativeText.every(visible);
  const needsOcr = !trusted || native.image_occurrences > 0 || inspection.vectorGraphics;
  const gaps: string[] = [], anchors: EvidenceAnchor[] = [];
  if (raster?.downscaled || renderScale < config.renderScale) gaps.push('page_render_downscaled_pixel_budget');
  let regions = native.regions.map(region => ({ ...region, coverage_gaps: trusted && region.source === 'native_pdf' ? [] : region.coverage_gaps }));
  let ocrState: DocumentPageArtifact['processing']['ocr'] = needsOcr ? 'unavailable' : 'not_needed';
  let ocrMarks: DocumentPageArtifact['ocrMarks'];
  if (inspection.hiddenText) gaps.push('hidden_text_layer_requires_ocr');
  if (!trusted && nativeText.length) gaps.push('native_text_visibility_or_geometry_unverified');
  if (needsOcr && options.ocr && png.length <= config.maxOcrImageBytes) {
    try {
      const response = await bounded(signal => options.ocr!.parse(png, { returnWordBox: true, signal }), config.ocrTimeoutMs, options.signal);
      const combined = combineOcrPage({ page: native.page, response, targets: [], imageSha256: sha256(png), sourceSha256: scope.sourceSha256 });
      const markRegionIds = new Set(combined.ocrMarks.items.flatMap(item => item.regionId ? [item.regionId] : []));
      const baseRegions = combined.regions.filter(region => !markRegionIds.has(region.region_id));
      if (baseRegions.length > config.maxRegions || baseRegions.reduce((n, region) => n + (region.raw_text?.length ?? 0), 0) > config.maxPageCharacters) throw new Error('ocr_page_budget_exceeded');
      // Optional mark geometry must never displace usable OCR text at the existing budget.
      const retainedMarks = combined.regions.filter(region => markRegionIds.has(region.region_id)).slice(0, config.maxRegions - baseRegions.length);
      const retainedIds = new Set(retainedMarks.map(region => region.region_id));
      if (retainedIds.size < markRegionIds.size) {
        const reason = 'ocr_marks_region_budget_exceeded';
        combined.ocrMarks = { ...combined.ocrMarks, status: 'partial', coverageGaps: unique([...combined.ocrMarks.coverageGaps, reason]),
          items: combined.ocrMarks.items.map(item => item.regionId && !retainedIds.has(item.regionId)
            ? { ...item, mappingStatus: 'unavailable', regionId: null, bbox: null, polygon: null, coverageGaps: unique([...item.coverageGaps, reason]) } : item) };
        combined.regions = [...baseRegions, ...retainedMarks];
      }
      regions.push(...combined.regions); gaps.push(...combined.coverage_gaps); ocrState = 'completed'; ocrMarks = combined.ocrMarks;
      for (const region of combined.regions.filter(region => ['image', 'signature'].includes(region.kind))) region.coverage_gaps = unique([...region.coverage_gaps, 'image_semantics_or_handwriting_unverified']);
      if (!combined.regions.some(region => region.source === 'vl_ocr')) gaps.push('visible_layout_not_established');
    } catch { options.signal?.throwIfAborted(); ocrState = 'failed'; gaps.push('ocr_processing_failed'); }
  } else if (needsOcr) gaps.push(png.length > config.maxOcrImageBytes ? 'ocr_image_byte_budget_exceeded' : 'ocr_adapter_unavailable');
  // A rendered whole-page occurrence ensures visible raster/vector content remains represented
  // even when PDF resource metadata cannot establish accurate object placement.
  if (needsOcr) {
    const imageRegion: DocumentRegion = {
      region_id: `image:${sha256(`${native.page.page_asset_id}:visible-page`)}`, source_id: `visible-page-${pageNumber}`,
      page_asset_id: native.page.page_asset_id, document_version_id: scope.documentVersionId, parse_revision: scope.parseRevision,
      source: 'image', kind: 'image', reading_order: regions.length, raw_text: null, raw_text_sha256: null,
      polygons: [[[0, 0], [native.page.width, 0], [native.page.width, native.page.height], [0, native.page.height]]],
      processing_status: ocrState === 'completed' ? 'ready' : 'image_only', coverage: ['image_evidence'],
      coverage_gaps: ocrState === 'completed' ? ['non_text_visual_content_unverified'] : ['visible_region_requires_ocr'], localization_reason: 'whole_page_visible_image',
    };
    regions = regions.filter(region => !(region.source === 'image' && region.region_id.endsWith(':page-image'))); regions.push(imageRegion);
    gaps.push(...imageRegion.coverage_gaps);
  }
  const visibleInk = discoverVisibleInk({ pixels: pixelData, width: native.page.width, height: native.page.height,
    textPolygons: regions.filter(region => region.raw_text && region.kind === 'text' && (region.source !== 'native_pdf' || trusted)).flatMap(region => region.polygons) });
  // Release the native canvas backing store before asynchronous classification calls.
  canvas.width = 1; canvas.height = 1;
  if (visibleInk.truncated) gaps.push('visible_ink_candidate_budget_exhausted');
  const signatureLabels = regions.filter(region => /\b(?:signed\s+by|signature|signatory|executed\s+by)\b|签名|签字|签署人/iu.test(region.raw_text ?? ''));
  const inkLabels = new Map<string, string>();
  for (const [index, box] of visibleInk.boxes.entries()) {
    const nearbyLabels = signatureLabels.filter(label => label.polygons.some(polygon => {
      const [l, t, r, b] = bounds(polygon); return box[0] < r + 300 * renderScale && box[2] > l - 20 && box[1] >= t - 10 && box[1] <= b + 130 * renderScale;
    }));
    nearbyLabels.sort((a, b) => {
      const distance = (candidate: DocumentRegion) => Math.min(...candidate.polygons.map(polygon => { const [l, t, r, b] = bounds(polygon); return Math.hypot((box[0] + box[2] - l - r) / 2, (box[1] + box[3] - t - b) / 2); }));
      return distance(a) - distance(b);
    });
    const regionId = `ink:${sha256(JSON.stringify([native.page.page_asset_id, box]))}`;
    if (nearbyLabels[0]) inkLabels.set(regionId, nearbyLabels[0].region_id);
    regions.push({ region_id: regionId, source_id: `visible-ink-${index}`, page_asset_id: native.page.page_asset_id, document_version_id: scope.documentVersionId, parse_revision: scope.parseRevision,
      source: 'image', kind: nearbyLabels.length ? 'signature' : 'image', reading_order: regions.length, raw_text: null, raw_text_sha256: null,
      polygons: [[[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]], processing_status: 'image_only', coverage: ['image_evidence'],
      coverage_gaps: [nearbyLabels.length ? 'visible_ink_is_signature_candidate_only' : 'non_text_visible_ink_unclassified'], localization_reason: 'measured_visible_ink_pixels' });
  }
  const ocrMarkRegionIds = new Set(ocrMarks?.items.flatMap(item => item.regionId ? [item.regionId] : []) ?? []);
  const reconciled = reconcileRegionEvidence(regions.filter(region => !ocrMarkRegionIds.has(region.region_id)));
  if (reconciled.conflicts.length) gaps.push('source_text_conflict');
  for (const region of regions) {
    if (region.raw_text) anchors.push(...anchorsForText(native.page, [region], region.raw_text));
    else if (region.polygons.length) anchors.push({ schema_version: 'p0.v1', anchor_id: `image:${sha256(region.region_id)}`, evidence_kind: 'image_region', document_version_id: scope.documentVersionId, parse_revision: scope.parseRevision, page_asset_id: native.page.page_asset_id, page_number: pageNumber, block_ids: [region.region_id], text_span_refs: [], polygons: region.polygons, granularity: 'block', localization_status: 'block_only', localization_source: region.source, configuration_version: config.version, reason: 'image_evidence_content_unverified', candidate_anchor_ids: [] });
  }
  const assembly=assembleSourceText(native.page,regions.filter(r=>!ocrMarkRegionIds.has(r.region_id)),reconciled.canonical_region_ids,reconciled.duplicates);
  const canonical=assembly.canonicalRegionIds;
  gaps.push(...assembly.coverageGaps);
  const classifications: DocumentPageArtifact['classifications'] = [];
  let nerCalls = 0;
  for (const region of regions.filter(region => canonical.includes(region.region_id) && region.raw_text?.trim())) {
    const headingText = region.raw_text!.trim().toLocaleLowerCase();
    const candidates = config.taxonomy.filter(label => label.keywords.some(word => headingText.length <= 160 && headingText.startsWith(word.toLocaleLowerCase()))).map(label => label.id);
    let classification: DocumentPageArtifact['classifications'][number] = { regionId: region.region_id, labelId: candidates.length === 1 ? candidates[0]! : null, candidates, status: candidates.length > 1 ? 'conflict' : candidates.length ? 'candidate' : 'unknown', source: 'configured_keyword', confidence: null };
    if (!config.classificationMode && !candidates.length && options.ner?.classify && nerCalls < 16 && region.raw_text!.trim().length >= 20) {
      nerCalls++;
      try {
        const fullText = region.raw_text!; const text = boundedUtf8(fullText);
        if (text !== fullText) gaps.push('classification_input_truncated_byte_bound');
        const response = await bounded(signal => options.ner!.classify!(text, config.taxonomy.map(label => label.id), { signal }), Math.min(config.ocrTimeoutMs, 30000), options.signal);
        if (!config.taxonomy.some(label => label.id === response.label.label) || !Number.isFinite(response.label.confidence) || response.label.confidence < 0 || response.label.confidence > 1) throw new Error('invalid_classification');
        classification = { ...classification, candidates: [response.label.label], labelId: response.label.confidence >= 0.7 ? response.label.label : null, status: response.label.confidence >= 0.7 ? 'candidate' : 'unknown', source: 'ner_adapter', confidence: response.label.confidence };
      } catch { options.signal?.throwIfAborted(); gaps.push('classification_provider_failed'); }
    }
    classifications.push(classification);
  }
  if (nerCalls >= 16) gaps.push('classification_call_budget_reached');
  const entityCandidates: DocumentPageArtifact['entityCandidates'] = [];
  const candidateFields=config.fields.filter(field=>!field.candidateExtraction);
  if (options.ner?.entities && candidateFields.length) {
    const sourceRegions = regions.filter(region => canonical.includes(region.region_id) && region.raw_text);
    const inputs: string[] = []; let batch = '';
    for (const region of sourceRegions) {
      const text = boundedUtf8(region.raw_text!); if (text !== region.raw_text) gaps.push('entity_input_truncated_byte_bound');
      if (batch && Buffer.byteLength(batch + '\n' + text) > 1500) { inputs.push(batch); batch = ''; }
      batch += `${batch ? '\n' : ''}${text}`;
    }
    if (batch) inputs.push(batch);
    if (inputs.length > 16) gaps.push('entity_call_budget_reached');
    for (const text of inputs.slice(0, 16)) {
      try {
        const response = await bounded(signal => options.ner!.entities!(text, candidateFields.map(field => field.id), { signal, wordSplitter: /\p{Script=Han}/u.test(text) ? 'char' : 'whitespace' }), Math.min(config.ocrTimeoutMs, 30000), options.signal);
        for (const [fieldId, entities] of Object.entries(response.entities)) {
          if (!candidateFields.some(field => field.id === fieldId) || !Array.isArray(entities)) throw new Error('entity_response_invalid');
          for (const entity of entities) {
            if (!entity.text || !text.includes(entity.text) || !Number.isFinite(entity.confidence) || entity.confidence < 0 || entity.confidence > 1) throw new Error('entity_response_invalid');
            const matches = anchorsForText(native.page, sourceRegions, entity.text);
            if (!matches.length) gaps.push('entity_unaligned_to_source');
            anchors.push(...matches);
            entityCandidates.push({ fieldId, text: entity.text, confidence: entity.confidence, anchorIds: matches.map(anchor => anchor.anchor_id), source: 'ner_adapter', simulated: options.ner.simulated ?? false });
          }
        }
      } catch { options.signal?.throwIfAborted(); gaps.push('entity_provider_failed'); }
    }
  }
  const signatures: DocumentPageArtifact['signatures'] = [];
  const canonicalRegions = regions.filter(region => canonical.includes(region.region_id));
  for (const [index, region] of canonicalRegions.entries()) {
    const label = /\b(?:signed\s+by|signature|signatory|executed\s+by)\b|签名|签字|签署人/iu.test(region.raw_text ?? '');
    if (!label && region.kind !== 'signature') continue;
    const inkCandidate = region.source === 'image' && region.source_id.startsWith('visible-ink');
    const labelIndex = inkCandidate ? canonicalRegions.findIndex(candidate => candidate.region_id === inkLabels.get(region.region_id)) : index;
    const contextIndex = labelIndex >= 0 ? labelIndex : index;
    const nextLabelIndex = canonicalRegions.findIndex((candidate, candidateIndex) => candidateIndex > contextIndex && signatureLabels.some(label => label.region_id === candidate.region_id));
    const contextRegions = unique([...canonicalRegions.slice(contextIndex, Math.min(nextLabelIndex < 0 ? canonicalRegions.length : nextLabelIndex, contextIndex + 7)), region]);
    const text = contextRegions.map(entry => entry.raw_text ?? '').join('\n');
    let ambiguousContext = false;
    const value = (expression: RegExp) => { const matches = unique([...text.matchAll(new RegExp(expression.source, `${expression.flags}g`))].map(match => match[1]!.trim())); if (matches.length > 1) ambiguousContext = true; return matches.length === 1 ? matches[0]! : null; };
    const name = value(/(?:Name|姓名)\s*[:：]\s*([^\n]+)/iu), title = value(/(?:Title|Position|职务)\s*[:：]\s*([^\n]+)/iu), date = value(/(?:Date|日期)\s*[:：]\s*([^\n]+)/iu);
    signatures.push({ id: `signature:${sha256(region.region_id)}`, pageNumber, regionIds: contextRegions.map(entry => entry.region_id), anchorIds: anchors.filter(anchor => anchor.block_ids.some(id => contextRegions.some(entry => entry.region_id === id))).map(anchor => anchor.anchor_id), status: 'needs_human_confirmation', kind: inkCandidate ? 'visual_ink_candidate' : region.kind === 'signature' ? 'ocr_signature_region' : 'signature_label', name, title, date, authorizationReferences: unique([...text.matchAll(/(?:resolution|power of attorney|authorization|决议|授权)[^\n]*/giu)].map(match => match[0])), contextText: boundedUtf8(text, 5000), handwritingAssessment: 'not_performed', coverageGaps: ['signature_existence_identity_and_authority_require_human_confirmation', ...(ambiguousContext ? ['signature_context_multiple_values_unassigned'] : [])] });
  }
  if (needsOcr && !signatures.length) signatures.push({ id: `signature-unknown:${sha256(native.page.page_asset_id)}`, pageNumber, regionIds: regions.filter(region => region.source === 'image').map(region => region.region_id), anchorIds: anchors.filter(anchor => anchor.evidence_kind === 'image_region' && !anchor.block_ids.some(id => ocrMarkRegionIds.has(id))).map(anchor => anchor.anchor_id), status: 'needs_human_confirmation', kind: 'image_unclassified', name: null, title: null, date: null, authorizationReferences: [], contextText: '', handwritingAssessment: 'not_performed', coverageGaps: ['signature_presence_unknown'] });
  const coverageGaps = unique([...gaps, ...regions.flatMap(region => region.coverage_gaps)]);
  const artifact = DocumentPageArtifactSchema.parse({ schema_version: scope.sourceFormat==='docx'?'p2.v2':'p2.v1', scope, page: native.page, regions, anchors: [...new Map(anchors.map(anchor => [anchor.anchor_id, anchor])).values()], imageSha256: sha256(png), status: coverageGaps.length ? 'partial' : 'ready', nativeTrust: trusted ? 'validated_geometry_and_visibility' : nativeText.length ? 'requires_validation' : 'unavailable', route: nativeText.length ? needsOcr ? 'mixed' : 'native' : ocrState === 'completed' ? 'ocr' : 'image_only', coverageGaps, canonicalRegionIds: canonical, duplicates: reconciled.duplicates, conflicts: reconciled.conflicts, classifications, signatures, ...(ocrMarks ? { ocrMarks } : {}), entityCandidates, processing: { engineVersion: ENGINE_VERSION, configVersion: config.version, ocr: ocrState, ocrSimulated: options.ocr?.simulated ?? false, elapsedMs: performance.now() - started } });
  const assembled=DocumentPageArtifactSchema.parse({...artifact,sourceTextAssembly:assembly.sourceTextAssembly});
  assertOcrMarkPage(assembled);assertSourceTextAssembly(assembled);
  return { ...assembled, png };
}
