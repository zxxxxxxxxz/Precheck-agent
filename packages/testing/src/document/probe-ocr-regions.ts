/** Explicit synthetic-only region probe. Never loads remote environment or database settings. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { p0Paths } from '@hsbc/server/experiments/p0/persistence/environment';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { OcrClient, OcrClientError } from '@hsbc/server/document/ocr-client';
import { parseNativePdf, renderPdfPage } from '@hsbc/server/document/pdf';
import { sha256, validateAnchorSource } from '@hsbc/server/document/evidence';
import { DocumentRegionSchema, EvidenceAnchorSchema } from '@hsbc/contracts/evidence';
import { combineOcrRegion, cropPageRegion, failedOcrRegion, pdfRectangleOnPage, reconcileRegionEvidence, summarizeRegionCoverage, type RegionOcrEvidence } from '@hsbc/server/document/regions';

if (!process.argv.includes('--execute')) throw new Error('Explicit --execute required; only fixed allowlisted synthetic image occurrences are sent for inference');
const requested = process.argv.find(arg => arg.startsWith('--fixture='))?.slice(10) ?? 'all';
// Source annotations are the exact PDF placements in generate-fixtures.ts.
// P0 deliberately validates the crop contract, not automatic region discovery.
const plans = {
  '03-mixed-page': [{ page: 1, id: 'raster-table-and-signature', rectangle: [32, 140, 540, 135] }],
  '04-repeated-image': [
    { page: 1, id: 'first-image', rectangle: [30, 240, 360, 90] },
    { page: 1, id: 'second-image', rectangle: [160, 70, 360, 90] },
    { page: 2, id: 'third-image', rectangle: [40, 140, 540, 135] },
  ],
  '05-untrusted-ocr': [{ page: 1, id: 'visible-image-over-hidden-text', rectangle: [32, 150, 540, 135] }],
} satisfies Record<string, Array<{ page: number; id: string; rectangle: [number, number, number, number] }>>;
if (requested !== 'all' && !(requested in plans)) throw new Error('fixture_not_allowlisted');
const names = requested === 'all' ? Object.keys(plans) as Array<keyof typeof plans> : [requested as keyof typeof plans];
const manifest = JSON.parse(await readFile('testdata/synthetic/manifest.json', 'utf8'));
const base = process.env.P0_OCR_URL, token = process.env.P0_OCR_TOKEN;
if (!base || !token) throw new Error('P0_OCR_URL and P0_OCR_TOKEN must be explicitly supplied');
const client = new OcrClient(base, token, 120_000), output = resolve(p0Paths().localDir, 'document-artifacts/regions');
await mkdir(output, { recursive: true });

for (const name of names) {
  const fixture = manifest.fixtures.find((item: { id: string }) => item.id === name);
  if (!fixture || fixture.filename !== `${name}.pdf`) throw new Error('fixture_not_allowlisted');
  const bytes = await readFile(resolve('testdata/synthetic', fixture.filename));
  if (sha256(bytes) !== fixture.sha256) throw new Error('fixture_hash_mismatch');
  const pages = await parseNativePdf(bytes, { documentVersionId: `fixture-${fixture.sha256.slice(0, 16)}`, parseRevision: 'region-ocr-v1', pages: [...new Set(plans[name].map(plan => plan.page))] });
  const prepared = [];
  const images = new Map<number, Buffer>();
  for (const plan of plans[name]) {
    const native = pages.find(page => page.page.page_number === plan.page)!;
    let pageImage = images.get(plan.page);
    if (!pageImage) { pageImage = await renderPdfPage(bytes, plan.page); images.set(plan.page, pageImage); await writeFile(resolve(output, `${name}-page-${plan.page}.png`), pageImage); }
    const { image, crop } = await cropPageRegion({ page: native.page, pageImage, occurrenceId: plan.id, box: pdfRectangleOnPage(native.page, plan.rectangle), contextPixels: 16, scale: 2 });
    await writeFile(resolve(output, `${name}-${plan.id}-input.png`), image);
    prepared.push({ plan, native, image, crop });
  }
  const records = [], results: RegionOcrEvidence[] = [];
  for (const item of prepared) {
    const start = performance.now(); let result: RegionOcrEvidence;
    const record: Record<string, unknown> = { occurrence_id: item.plan.id, crop: item.crop, contract: 'POST /v1/ocr', return_word_box: true };
    try {
      const response = await client.parse(item.image, { returnWordBox: true });
      record.response = response;
      result = combineOcrRegion({ page: item.native.page, crop: item.crop, response, targets: ['300,000', '800,000', 'USD', 'Signature'] });
      for (const region of result.regions) DocumentRegionSchema.parse(region);
      for (const target of result.targets) for (const anchor of [...target.layout_anchors, ...target.localization_anchors]) {
        EvidenceAnchorSchema.parse(anchor); validateAnchorSource(anchor, item.native.page, result.regions);
      }
    } catch (error) {
      const code = error instanceof OcrClientError ? error.code : 'ocr_region_contract_or_evidence_invalid';
      record.error = { code, ...(error instanceof OcrClientError ? { status: error.status } : {}) };
      result = failedOcrRegion(item.native.page, item.crop, code); process.exitCode = 1;
    }
    record.duration_ms = Math.round(performance.now() - start); record.status = result.status;
    results.push(result); records.push(record);
    console.log(JSON.stringify({ fixture: name, occurrence: item.plan.id, status: result.status, duration_ms: record.duration_ms, region_count: result.regions.length, coverage_gaps: result.coverage_gaps }));
  }
  const reconciled = reconcileRegionEvidence([...pages.flatMap(page => page.regions), ...results.flatMap(result => result.regions)]);
  const evidence = { schema_version: 'p0.v1', fixture: name, recorded_at: new Date().toISOString(), purpose: 'synthetic_p0_region_contract_validation',
    source_pdf_sha256: fixture.sha256, region_selection: 'fixed_synthetic_source_annotations', render_scale: 1.5, context_pixels: 16, requested_resize: 2,
    pages: pages.map(page => ({ page: page.page, native_regions: page.regions, native_coverage_gaps: page.coverage_gaps })),
    coverage: summarizeRegionCoverage(prepared.map(item => item.crop), results), results,
    reconciliation: { canonical_region_ids: reconciled.canonical_region_ids, duplicates: reconciled.duplicates, conflicts: reconciled.conflicts },
    limits: ['Region selection uses known synthetic annotations; this is not automatic image-region discovery.', 'Successful OCR is processing coverage, not bank field-accuracy acceptance.', 'Native and OCR text remain independent; historical hidden text is untrusted.', 'No use_ocr_for_image_block request option is supported or enabled.'],
  };
  await writeFile(resolve(output, `${name}-raw.json`), JSON.stringify({ fixture: name, source_pdf_sha256: fixture.sha256, requests: records }, null, 2) + '\n');
  await writeFile(resolve(output, `${name}-evidence.json`), JSON.stringify(evidence, null, 2) + '\n');
  for (const native of pages) {
    const image = await loadImage(images.get(native.page.page_number)!);
    const canvas = createCanvas(native.page.width, native.page.height), context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    for (const result of results.filter(result => result.crop.page_asset_id === native.page.page_asset_id)) {
      const [left, top, right, bottom] = result.crop.crop_box;
      context.strokeStyle = '#2563eb'; context.lineWidth = 2; context.strokeRect(left, top, right - left, bottom - top);
      for (const region of result.regions.filter(region => region.source === 'pp_ocr' && /:line:\d+$/.test(region.source_id))) for (const polygon of region.polygons) {
        context.strokeStyle = '#dc2626'; context.lineWidth = 1; context.beginPath();
        polygon.forEach((point, index) => index ? context.lineTo(...point) : context.moveTo(...point)); context.closePath(); context.stroke();
      }
    }
    await writeFile(resolve(output, `${name}-page-${native.page.page_number}-overlay.png`), canvas.toBuffer('image/png'));
  }
  console.log(JSON.stringify({ fixture: name, coverage: evidence.coverage, output: resolve(output, `${name}-evidence.json`) }));
}
