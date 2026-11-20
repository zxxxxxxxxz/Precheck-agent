import { z } from 'zod';
import { PointSchema } from '@hsbc/contracts/evidence';

export class OcrClientError extends Error {
  constructor(readonly code: string, readonly status: number | null = null) { super(code); }
}
/** Internal normalized localization shape; not an HTTP route or upstream response. */
export const LocalizationSchema = z.strictObject({
  schema_version: z.literal('p0.v1'), model_version: z.string().min(1), configuration_version: z.string().min(1),
  width: z.number().int().positive(), height: z.number().int().positive(),
  items: z.array(z.strictObject({ source_id: z.string(), text: z.string(), granularity: z.enum(['line', 'word']), polygon: z.array(PointSchema).min(3), confidence: z.number().min(0).max(1).nullable() })),
  raw_result: z.unknown(),
});

// Raw PP-OCR coordinates use the original uploaded image. The upstream CTC
// alignment may extend beyond its edges; clipping belongs to evidence/display
// mapping, never to response validation or a silent alteration of raw evidence.
const RawPointSchema = z.tuple([z.number().finite(), z.number().finite()]);
const RawQuadSchema = z.tuple([RawPointSchema, RawPointSchema, RawPointSchema, RawPointSchema]);
const RawBoxSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
  .refine(box => box[0] <= box[2] && box[1] <= box[3], { message: 'Invalid word box ordering' });

/** Deployed /v1/ocr word_ocr contract. Scores are per line, never per word. */
export const WordOcrSchema = z.strictObject({
  model: z.literal('PP-OCRv6'),
  detector: z.literal('PP-OCRv6_medium_det'),
  recognizer: z.literal('PP-OCRv6_medium_rec'),
  coordinate_system: z.literal('original_image_pixels'),
  width: z.number().int().positive(), height: z.number().int().positive(),
  granularity: z.literal('latin_word_cjk_character'),
  method: z.literal('ctc_alignment'),
  rec_texts: z.array(z.string()),
  rec_scores: z.array(z.number().finite().min(0).max(1)),
  rec_polys: z.array(RawQuadSchema),
  text_word: z.array(z.array(z.string())),
  text_word_region: z.array(z.array(RawQuadSchema)),
  text_word_boxes: z.array(z.array(RawBoxSchema)),
}).superRefine((value, ctx) => {
  const lineCount = value.rec_texts.length;
  for (const field of ['rec_scores', 'rec_polys', 'text_word', 'text_word_region', 'text_word_boxes'] as const) {
    if (value[field].length !== lineCount) ctx.addIssue({ code: 'custom', path: [field], message: 'OCR line arrays must align' });
  }
  for (const [index, words] of value.text_word.entries()) {
    for (const field of ['text_word_region', 'text_word_boxes'] as const) {
      if (value[field][index]?.length !== words.length) ctx.addIssue({ code: 'custom', path: [field, index], message: 'OCR unit arrays must align' });
    }
  }
});
export const OcrPageSchema = z.object({ result: z.unknown(), markdown: z.string(), word_ocr: WordOcrSchema.optional() });
export const OcrParseResultSchema = z.object({ pages: z.array(OcrPageSchema).min(1) });
export type WordOcr = z.infer<typeof WordOcrSchema>;
export type OcrPage = z.infer<typeof OcrPageSchema>;
export type OcrParseResult = z.infer<typeof OcrParseResultSchema>;

export class OcrClient {
  private base: string;
  constructor(baseUrl: string, private readonly token: string, private readonly timeoutMs = 15_000) {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid_ocr_base_url');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('ocr_tls_required');
    this.base = url.href.replace(/\/$/, '');
    if (!token || timeoutMs <= 0) throw new Error('invalid_ocr_configuration');
  }
  private async request(path: string, form?: FormData): Promise<unknown> {
    try {
      const response = await fetch(`${this.base}${path}`, { method: form ? 'POST' : 'GET', redirect: 'error', headers: { Authorization: `Bearer ${this.token}` }, ...(form ? { body: form } : {}), signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) throw new OcrClientError(response.status === 503 ? 'ocr_unavailable' : response.status === 422 ? 'ocr_request_rejected' : 'ocr_request_failed', response.status);
      const text = await response.text();
      if (text.length > 20 * 1024 * 1024) throw new OcrClientError('ocr_response_too_large');
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof OcrClientError) throw error;
      throw new OcrClientError(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'ocr_timeout' : 'ocr_transport_error');
    }
  }
  private imageForm(image: Uint8Array): FormData {
    if (!image.length || image.length > 10 * 1024 * 1024) throw new OcrClientError('invalid_image_size');
    const form = new FormData(); form.set('file', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'page.png'); return form;
  }
  async parse(image: Uint8Array, options: { returnWordBox?: boolean } = {}): Promise<OcrParseResult> {
    const form = this.imageForm(image);
    if (options.returnWordBox === true) form.set('return_word_box', 'true');
    const parsed = OcrParseResultSchema.safeParse(await this.request('/v1/ocr', form));
    if (!parsed.success) throw new OcrClientError('ocr_invalid_response');
    if (options.returnWordBox === true && parsed.data.pages.some(page => !page.word_ocr)) throw new OcrClientError('ocr_word_result_missing');
    return parsed.data;
  }
}
