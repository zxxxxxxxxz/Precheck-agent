import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DocumentRegionOcrRequestSchema, DocumentRegionOcrReceiptSchema, type DocumentRegionOcrRequest,
  type DocumentRegionOcrReceipt } from '@hsbc/contracts/document-region-ocr';
import { configHash } from '../review/opa.js';
import { transaction } from '../../infrastructure/database/client.js';
import { sha256 } from '../../document/evidence.js';
import { combineOcrRegion, validateCrop } from '../../document/regions.js';
import { PageAssetSchema, type PageAsset } from '@hsbc/contracts/evidence';
import type { DocumentOcrAdapter } from './engine/page.js';
export interface RegionOcrDispatchResult {
  state: 'ready' | 'partial' | 'failed' | 'unknown' | 'budget_exhausted' | 'disabled';
  receipt?: DocumentRegionOcrReceipt;
  receiptHash?: string;
}
export const REGION_OCR_LIMITS = { perPage: 2, perDocument: 6, cropPixels: 2_000_000, imageBytes: 2 * 1024 * 1024,
  responseBytes: 4 * 1024 * 1024, pageAreaRatio: 0.2 } as const;
/** Private OCR has its own append-only receipts; it is not a cloud model call.
 * Fences surround dispatch and settlement. Unknown execution never repeats. */
export class DocumentRegionOcrLedger {
  constructor(private readonly pool: Pool, private readonly job: { id: string; document_version_id: string; total_pages: number },
    private readonly fence: (db: PoolClient) => Promise<void>) {}
  async execute(page: PageAsset, raw: DocumentRegionOcrRequest, image: Uint8Array,
    ocr: Pick<DocumentOcrAdapter, 'parse'> | undefined, signal?: AbortSignal): Promise<RegionOcrDispatchResult> {
    const request = DocumentRegionOcrRequestSchema.parse(raw), requestHash = configHash(request), crop = request.crop;
    PageAssetSchema.parse(page);
    validateCrop(page, crop);
    const bytes = Buffer.from(image), [left, top, right, bottom] = crop.requested_box;
    if (crop.parse_revision !== this.job.id || crop.document_version_id !== this.job.document_version_id ||
      page.document_version_id !== this.job.document_version_id || page.parse_revision !== this.job.id ||
      page.page_number > this.job.total_pages || page.page_asset_id !== crop.page_asset_id ||
      request.sourcePageHash !== crop.page_image_sha256 ||
      left < 0 || top < 0 || right > page.width || bottom > page.height || right <= left || bottom <= top ||
      (crop.crop_box[2] - crop.crop_box[0]) * (crop.crop_box[3] - crop.crop_box[1]) / (page.width * page.height) > REGION_OCR_LIMITS.pageAreaRatio ||
      crop.crop_box[0] > left || crop.crop_box[1] > top || crop.crop_box[2] < right || crop.crop_box[3] < bottom ||
      bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      bytes.readUInt32BE(16) !== crop.width || bytes.readUInt32BE(20) !== crop.height ||
      image.length > REGION_OCR_LIMITS.imageBytes || crop.width * crop.height > REGION_OCR_LIMITS.cropPixels ||
      sha256(image) !== crop.image_sha256) throw new Error('region_ocr_source_mismatch');
    signal?.throwIfAborted();
    const reserved = await transaction(this.pool, async db => {
      await this.fence(db);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`region-ocr:${this.job.id}`]);
      const old = (await db.query(`SELECT q.id,q.request_hash,q.body,r.body AS receipt,r.body_hash
        FROM business.document_region_ocr_requests q LEFT JOIN business.document_region_ocr_receipts r ON r.request_id=q.id
        WHERE q.job_id=$1 AND q.crop_id=$2`, [this.job.id, crop.crop_id])).rows[0];
      if (old) {
        if (old.request_hash !== requestHash || configHash(old.body) !== old.request_hash) return { state: 'unknown' as const };
        if (!old.receipt) return { state: 'unknown' as const };
        const receipt = DocumentRegionOcrReceiptSchema.parse(old.receipt);
        if (configHash(receipt) !== old.body_hash || receipt.requestHash !== requestHash ||
          configHash(receipt.crop) !== configHash(crop)) throw new Error('region_ocr_receipt_integrity_failed');
        return { state: receipt.status, receipt, receiptHash: old.body_hash as string };
      }
      if (!ocr) return { state: 'disabled' as const };
      const counts = (await db.query(`SELECT count(*)::int AS total,
        count(*) FILTER(WHERE q.page_number=$2)::int AS page,
        count(*) FILTER(WHERE r.request_id IS NULL)::int AS unknown
        FROM business.document_region_ocr_requests q LEFT JOIN business.document_region_ocr_receipts r ON r.request_id=q.id WHERE q.job_id=$1`,
      [this.job.id, page.page_number])).rows[0];
      if (counts.unknown) return { state: 'unknown' as const };
      if (counts.total >= REGION_OCR_LIMITS.perDocument || counts.page >= REGION_OCR_LIMITS.perPage) return { state: 'budget_exhausted' as const };
      const id = randomUUID();
      await db.query(`INSERT INTO business.document_region_ocr_requests(id,job_id,page_number,crop_id,request_hash,body)
        VALUES($1,$2,$3,$4,$5,$6)`, [id, this.job.id, page.page_number, crop.crop_id, requestHash, JSON.stringify(request)]);
      return { id };
    });
    if (!('id' in reserved)) return reserved;
    // There is no retry here, including a transport error with unknown outcome.
    await transaction(this.pool, this.fence);
    signal?.throwIfAborted();
    let response: Awaited<ReturnType<DocumentOcrAdapter['parse']>>;
    try { response = await ocr!.parse(image, { returnWordBox: true, signal }); }
    catch {
      signal?.throwIfAborted();
      await transaction(this.pool, this.fence);
      return { state: 'unknown' };
    }
    signal?.throwIfAborted();
    let receipt: DocumentRegionOcrReceipt;
    try {
      if (Buffer.byteLength(JSON.stringify(response)) > REGION_OCR_LIMITS.responseBytes) throw new Error('region_ocr_response_budget');
      const combined = combineOcrRegion({ page, crop, response, targets: [] });
      receipt = DocumentRegionOcrReceiptSchema.parse({ version: request.version, requestHash, crop, status: combined.status,
        regions: combined.regions, coverageGaps: combined.coverage_gaps, configurationVersions: combined.configuration_versions });
    } catch {
      // The response completed, but did not establish usable mapped evidence.
      receipt = DocumentRegionOcrReceiptSchema.parse({ version: request.version, requestHash, crop, status: 'failed',
        regions: [], coverageGaps: ['region_ocr_response_unusable'], configurationVersions: { layout: null, localization: null } });
    }
    const receiptHash = configHash(receipt);
    await transaction(this.pool, async db => {
      await this.fence(db); signal?.throwIfAborted();
      await db.query(`INSERT INTO business.document_region_ocr_receipts(request_id,body_hash,body) VALUES($1,$2,$3)`,
        [reserved.id, receiptHash, JSON.stringify(receipt)]);
    });
    return { state: receipt.status, receipt, receiptHash };
  }
}
