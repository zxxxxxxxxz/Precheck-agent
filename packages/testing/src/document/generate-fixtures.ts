import { PDFDocument, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from '@hsbc/server/document/evidence';

export const fixtureCases = [
  ['01-native-unicode', 'Non-square native text; repeated amounts; accents; non-BMP code-point offsets; split spans'],
  ['02-crop-rotation', 'Non-zero CropBox with intrinsic 90-degree rotation'],
  ['03-mixed-page', 'Native body plus raster table and signature; image content must remain a coverage gap'],
  ['04-repeated-image', 'Same image reused twice on one page and on another page'],
  ['05-untrusted-ocr', 'Scanned visible amount USD 300,000 with conflicting hidden historical text USD 800,000'],
  ['06-source-conflict', 'Same-position source agreement/conflict and equal text at distinct positions'],
  ['07-cross-page-image', 'Clause continues onto second page; third page is pure image evidence'],
  ['08-failure-input', 'Baseline input for timeout, invalid geometry, missing inverse and stale-version injection'],
] as const;

export async function generateDocumentFixtures(root = resolve('testdata/synthetic')) {
  await mkdir(root, { recursive: true });
  const fontBytes = await readFile(resolve('testdata/synthetic/fonts/DejaVuSans.ttf'));
  GlobalFonts.register(fontBytes, 'FixtureFont');
  const canvas = createCanvas(720, 180), context = canvas.getContext('2d');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, 720, 180);
  context.strokeStyle = '#000000'; context.strokeRect(4, 4, 710, 170);
  context.fillStyle = '#111111'; context.font = '24px FixtureFont';
  context.fillText('SYNTHETIC TABLE / IMAGE', 20, 40);
  context.fillText('Currency  USD      Amount  300,000', 20, 95);
  context.fillText('Signature: Example Person', 20, 148);
  const raster = canvas.toBuffer('image/png');
  await writeFile(resolve(root, 'table-and-signature.png'), raster);
  const manifest = [];
  for (const [id, purpose] of fixtureCases) {
    const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit);
    pdf.setCreationDate(new Date('2026-10-13T00:00:00.000Z')); pdf.setModificationDate(new Date('2026-10-13T00:00:00.000Z'));
    pdf.setTitle(`SYNTHETIC P0 ${id}`); pdf.setAuthor('P0 synthetic fixture generator');
    const font = await pdf.embedFont(fontBytes, { subset: true });
    const image = await pdf.embedPng(raster);
    const page = pdf.addPage([640, 420]);
    const text = (value: string, x = 32, y = 350) => page.drawText(value, { x, y, size: 14, font, color: rgb(0, 0, 0) });
    text(`SYNTHETIC / ${id}`, 32, 390);
    if (id === '01-native-unicode') {
      text('Borrower: Café Example 𝔸'); text('Facility A: USD 300,000', 32, 300); text('Facility B: USD 300,000', 32, 250);
      text('Split reference: ', 32, 200); text('9526', 164, 200); text('-EC', 205, 200);
    } else if (id === '02-crop-rotation') {
      page.setCropBox(20, 30, 580, 350); page.setRotation(degrees(90)); text('CropBox origin is (20,30)', 50, 300); text('USD 300,000', 50, 230);
    } else if (id === '03-mixed-page') {
      text('Borrower is Example Borrower; terms below are raster only.'); page.drawImage(image, { x: 32, y: 140, width: 540, height: 135 });
    } else if (id === '04-repeated-image') {
      page.drawImage(image, { x: 30, y: 240, width: 360, height: 90 }); page.drawImage(image, { x: 160, y: 70, width: 360, height: 90 });
      pdf.addPage([640, 420]).drawImage(image, { x: 40, y: 140, width: 540, height: 135 });
    } else if (id === '05-untrusted-ocr') {
      page.drawImage(image, { x: 32, y: 150, width: 540, height: 135 });
      page.drawText('USD 800,000', { x: 270, y: 210, size: 18, font, opacity: 0 });
    } else if (id === '06-source-conflict') {
      text('Amount: USD 300,000'); text('Repeated elsewhere: USD 300,000', 32, 220);
    } else if (id === '07-cross-page-image') {
      text('The borrower shall repay amounts under clause 4, except');
      const second = pdf.addPage([640, 420]); second.drawText('where the extension in Schedule 2 applies.', { x: 32, y: 350, size: 14, font });
      pdf.addPage([640, 420]).drawImage(image, { x: 32, y: 150, width: 540, height: 135 });
    } else { text('Amount: USD 300,000'); text('Do not convert processing failures to field not-found.', 32, 300); }
    const bytes = await pdf.save({ useObjectStreams: false });
    await writeFile(resolve(root, `${id}.pdf`), bytes);
    manifest.push({ id, filename: `${id}.pdf`, sha256: sha256(bytes), physical_pages: pdf.getPageCount(), purpose });
  }
  await writeFile(resolve(root, 'manifest.json'), JSON.stringify({ schema_version: 'p0.v1', synthetic: true, generated_at: '2026-10-13T00:00:00Z', fixtures: manifest,
    fault_injections: ['ocr_timeout', 'geometry_out_of_bounds', 'inverse_mapping_unavailable', 'stale_evidence_source'],
    limitations: ['Synthetic geometry and OCR response fixtures are engineering tests, not bank quality acceptance.', 'Native text presence does not establish source correctness.'],
  }, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await generateDocumentFixtures();
