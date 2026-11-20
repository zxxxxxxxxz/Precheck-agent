/** Explicit public/synthetic-only probe. Never loads .env.remote or any DB config. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { p0Paths } from '@hsbc/server/experiments/p0/persistence/environment';
import { OcrClient, OcrClientError } from '@hsbc/server/document/ocr-client';
import { parseNativePdf, renderPdfPage } from '@hsbc/server/document/pdf';
import { sha256 } from '@hsbc/server/document/evidence';
import { combineOcrPage } from '@hsbc/server/document/combine-ocr';

if (!process.argv.includes('--execute')) throw new Error('Explicit --execute required; this makes an inference request using only an allowlisted public/synthetic page');
const requested = process.argv.find(arg => arg.startsWith('--fixture='))?.slice(10) ?? '03-mixed-page';
const manifest = JSON.parse(await readFile('testdata/synthetic/manifest.json', 'utf8'));
let path: string, expectedHash: string, pageNumber = 1;
const synthetic = manifest.fixtures.find((item: { id: string }) => item.id === requested);
if (synthetic) { path = resolve('testdata/synthetic', synthetic.filename); expectedHash = synthetic.sha256; }
else {
  const match = /^worldbank-(loan|guarantee)-([23])$/.exec(requested);
  if (!match || match[1] === 'loan' && match[2] !== '2') throw new Error('fixture_not_allowlisted');
  const provenance = JSON.parse(await readFile('testdata/public/worldbank-9526-ec/provenance.json', 'utf8'));
  const source = provenance.documents.find((item: { document_id: string }) => item.document_id === match[1]);
  path = resolve('testdata/public/worldbank-9526-ec', source.filename); expectedHash = source.sha256; pageNumber = Number(match[2]);
}
const bytes = await readFile(path);
if (sha256(bytes) !== expectedHash) throw new Error('fixture_hash_mismatch');
const base = process.env.P0_OCR_URL, token = process.env.P0_OCR_TOKEN;
if (!base || !token) throw new Error('P0_OCR_URL and P0_OCR_TOKEN must be explicitly supplied');
const client = new OcrClient(base, token, 120_000);
// --localize is retained as a CLI alias, not the obsolete HTTP /localize route.
const withWords = process.argv.includes('--word-boxes') || process.argv.includes('--localize');
const record: Record<string, unknown> = { schema_version: 'p0.v1', fixture: requested, sha256: expectedHash, page_number: pageNumber, recorded_at: new Date().toISOString(), purpose: 'public_synthetic_p0_validation', contract: 'POST /v1/ocr', return_word_box: withWords };
const output = resolve(p0Paths().localDir, 'document-artifacts'); await mkdir(output, { recursive: true });
const prefix = `${requested}-${withWords ? 'combined' : 'layout'}`;
const image = await renderPdfPage(bytes, pageNumber);
record.image_sha256 = sha256(image);
await writeFile(resolve(output, `${prefix}-input.png`), image);
const start = performance.now();
try {
  const response = await client.parse(image, withWords ? { returnWordBox: true } : {});
  record.response = response; record.duration_ms = Math.round(performance.now() - start);
  const parsed = await parseNativePdf(bytes, { documentVersionId: `fixture-${expectedHash.slice(0, 16)}`, parseRevision: 'combined-ocr-v1', pages: [pageNumber] });
  const targets = requested.startsWith('worldbank-') ? ['300,000,000', 'Loan', 'ECUADOR', '9526'] : ['300,000', '800,000', 'USD', 'Synthetic'];
  const evidence = combineOcrPage({ page: parsed[0]!.page, response, targets, imageSha256: sha256(image) });
  await writeFile(resolve(output, `${prefix}-evidence.json`), JSON.stringify(evidence, null, 2));
  record.status = 'passed';
} catch (error) {
  record.status = 'failed'; record.duration_ms = Math.round(performance.now() - start);
  record.error = error instanceof OcrClientError ? { code: error.code, status: error.status } : { code: 'ocr_contract_or_evidence_invalid' };
  process.exitCode = 1;
}
await writeFile(resolve(output, `${prefix}-raw.json`), JSON.stringify(record, null, 2));
console.log(JSON.stringify({ fixture: requested, status: record.status, return_word_box: withWords, duration_ms: record.duration_ms, output: resolve(output, `${prefix}-raw.json`) }));
