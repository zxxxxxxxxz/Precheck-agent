import { createCanvas } from '@napi-rs/canvas';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getDocument, OPS, Util, version } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { AffineTransform, DocumentRegion, PageAsset, Polygon } from '@hsbc/contracts/evidence';
import { sha256 } from './evidence.js';
import { polygonArea, transformPoint, validatePolygon } from './geometry.js';

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const imageOps = new Set([OPS.paintImageXObject, OPS.paintImageMaskXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat]);
export interface NativePdfPage {
  page: PageAsset;
  regions: DocumentRegion[];
  source_items: Array<{ source_id: string; text: string; pdf_transform: number[]; width: number; height: number; pdf_polygon: Polygon }>;
  image_occurrences: number;
  text_layer_trust: 'requires_validation';
  coverage_gaps: string[];
}
function loadPdf(bytes: Uint8Array) {
  // The transfer buffer is a copy; never detach or mutate the caller's original bytes.
  return getDocument({ data: new Uint8Array(bytes),
    standardFontDataUrl: join(pdfjsRoot, 'standard_fonts') + '/',
    cMapUrl: join(pdfjsRoot, 'cmaps') + '/', cMapPacked: true,
    wasmUrl: join(pdfjsRoot, 'wasm') + '/',
  });
}
export async function parseNativePdf(bytes: Uint8Array, options: { documentVersionId: string; parseRevision: string; scale?: number; pages?: number[] }): Promise<NativePdfPage[]> {
  const scale = options.scale ?? 1.5;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error('invalid_render_scale');
  const task = loadPdf(bytes);
  const document = await task.promise;
  try {
    const numbers = options.pages ?? Array.from({ length: document.numPages }, (_, i) => i + 1);
    const labels = await document.getPageLabels();
    const result: NativePdfPage[] = [];
    for (const pageNumber of numbers) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) throw new Error('invalid_page_number');
      const pdfPage = await document.getPage(pageNumber), viewport = pdfPage.getViewport({ scale });
      const page: PageAsset = {
        schema_version: 'p0.v1', page_asset_id: `${options.documentVersionId}:${options.parseRevision}:p${pageNumber}:s${scale}`,
        document_version_id: options.documentVersionId, parse_revision: options.parseRevision, page_number: pageNumber,
        printed_page_label: labels?.[pageNumber - 1] ?? null, width: Math.ceil(viewport.width), height: Math.ceil(viewport.height),
        source_sha256: sha256(bytes), renderer: `pdfjs-dist@${version}`, renderer_config: `p0-native-v1:scale=${scale}`,
        pdf_view_box: [...pdfPage.view] as [number, number, number, number], intrinsic_rotation: pdfPage.rotate,
        pdf_to_page: [...viewport.transform] as AffineTransform,
      };
      const content = await pdfPage.getTextContent({ disableNormalization: true });
      const regions: DocumentRegion[] = [], sourceItems: NativePdfPage['source_items'] = [];
      for (const [i, item] of content.items.entries()) {
        if (!('str' in item) || !item.str) continue;
        const [a, b, c, d, x, y] = item.transform as [number, number, number, number, number, number];
        const length = Math.hypot(a, b), font = content.styles[item.fontName];
        const ascent = font?.ascent ?? 0.8, descent = font?.descent ?? -0.2;
        const dx = length ? a / length * item.width : 0, dy = length ? b / length * item.width : 0;
        const sourcePolygon: Polygon = [[x + c * ascent, y + d * ascent], [x + dx + c * ascent, y + dy + d * ascent], [x + dx + c * descent, y + dy + d * descent], [x + c * descent, y + d * descent]];
        let polygon: Polygon = sourcePolygon.map(p => transformPoint(p, page.pdf_to_page));
        if (polygonArea(polygon) < 0) polygon.reverse();
        let reason: string | null = null;
        try { if (font?.vertical) throw new Error('vertical_text_geometry_unverified'); validatePolygon(polygon, page.width, page.height); }
        catch (error) { reason = error instanceof Error ? error.message : 'invalid_geometry'; polygon = []; }
        const sourceId = `${page.page_asset_id}:item${i}`;
        regions.push({ region_id: sourceId, source_id: sourceId, page_asset_id: page.page_asset_id, document_version_id: page.document_version_id, parse_revision: page.parse_revision,
          source: 'native_pdf', kind: 'text', reading_order: i, raw_text: item.str, raw_text_sha256: sha256(item.str), polygons: polygon.length ? [polygon] : [],
          processing_status: 'ready', coverage: ['text'], coverage_gaps: ['text_layer_trust_not_established'], localization_reason: reason,
        });
        sourceItems.push({ source_id: sourceId, text: item.str, pdf_transform: [...item.transform], width: item.width, height: item.height, pdf_polygon: sourcePolygon });
      }
      const operations = await pdfPage.getOperatorList();
      const imageCount = operations.fnArray.filter(op => imageOps.has(op)).length;
      let current=[1,0,0,1,0,0],occurrence=0,imageGeometryFailed=false;
      const stack:number[][]=[];
      for(const [index,operation] of operations.fnArray.entries()){
        if(operation===OPS.save){stack.push([...current]);continue;}
        if(operation===OPS.restore){current=stack.pop()??current;continue;}
        if(operation===OPS.transform){current=Util.transform(current,operations.argsArray[index]!);continue;}
        if(!imageOps.has(operation))continue;
        occurrence++;
        let polygon=([[0,0],[1,0],[1,1],[0,1]] as [number,number][]).map(point=>{
          Util.applyTransform(point,current);Util.applyTransform(point,viewport.transform);return point;
        }) as Polygon;
        if(polygonArea(polygon)<0)polygon.reverse();
        try{validatePolygon(polygon,page.width,page.height);}catch{imageGeometryFailed=true;continue;}
        const sourceId=`${page.page_asset_id}:image-occurrence-${occurrence}`;
        regions.push({region_id:sourceId,source_id:sourceId,page_asset_id:page.page_asset_id,document_version_id:page.document_version_id,parse_revision:page.parse_revision,
          source:'image',kind:'image',reading_order:regions.length,raw_text:null,raw_text_sha256:null,polygons:[polygon],
          processing_status:'ready',coverage:['image_evidence'],coverage_gaps:['image_semantics_or_handwriting_unverified'],localization_reason:'pdf_image_operator_geometry'});
      }
      const noNativeText = !regions.some(region=>region.raw_text!==null);
      if (noNativeText && imageCount > 0) {
        // A full rendered page is reliable image evidence even before OCR. This
        // is not a guessed object box or a claim that its text was extracted.
        regions.push({ region_id: `${page.page_asset_id}:page-image`, source_id: `${page.page_asset_id}:page-image`,
          page_asset_id: page.page_asset_id, document_version_id: page.document_version_id, parse_revision: page.parse_revision,
          source: 'image', kind: 'image', reading_order: 0, raw_text: null, raw_text_sha256: null,
          polygons: [[[0, 0], [page.width, 0], [page.width, page.height], [0, page.height]]],
          processing_status: 'image_only', coverage: ['image_evidence'], coverage_gaps: ['image_content_requires_ocr'], localization_reason: 'whole_page_image_only',
        });
      }
      result.push({ page, regions, source_items: sourceItems, image_occurrences: imageCount, text_layer_trust: 'requires_validation',
        coverage_gaps: [...(imageCount ? ['image_content_requires_ocr'] : []), ...(imageGeometryFailed?['image_geometry_unverified']:[]), ...(noNativeText ? ['native_text_unavailable'] : []), 'text_layer_trust_not_established'],
      });
      pdfPage.cleanup();
    }
    return result;
  } finally { await task.destroy(); }
}
export async function renderPdfPage(bytes: Uint8Array, pageNumber: number, scale = 1.5): Promise<Buffer> {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error('invalid_render_scale');
  const task = loadPdf(bytes), document = await task.promise;
  try {
    const page = await document.getPage(pageNumber), viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas: canvas as never, canvasContext: canvas.getContext('2d') as never, viewport }).promise;
    return canvas.toBuffer('image/png');
  } finally { await task.destroy(); }
}
