import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from '../../../infrastructure/database/client.js';
import { inputHash } from '../../../infrastructure/database/idempotency.js';
import type { QwenDispatch } from '../../../infrastructure/integrations/inference.js';
import { ServiceError } from '../../../infrastructure/integrations/http.js';

const knownFailures = new Set(['qwen_busy', 'qwen_authorization_failed', 'qwen_request_rejected', 'qwen_invalid_response', 'qwen_response_too_large']);
/** Persist before sending. A lost response is never silently billed/sent again on Worker recovery. */
export function translationDispatch(pool: Pool, jobId: string, chunkId: string, fence: (db: PoolClient) => Promise<void>): QwenDispatch {
  return async (body, start) => {
    const requestHash = inputHash(body);
    const previous = await transaction(pool, async db => {
      await fence(db);
      await db.query('SELECT id FROM business.document_jobs WHERE id=$1 FOR UPDATE', [jobId]);
      const old = (await db.query('SELECT * FROM business.document_translation_calls WHERE job_id=$1 AND chunk_id=$2', [jobId, chunkId])).rows[0];
      if (old) {
        if (old.request_hash !== requestHash) throw new ServiceError('translation_call_identity_mismatch');
        if (old.state === 'completed') return { response: old.response };
        throw new ServiceError(old.state === 'unknown' ? 'translation_call_unknown' : old.error_code ?? 'translation_call_failed');
      }
      const id = randomUUID();
      await db.query("INSERT INTO business.document_translation_calls(id,job_id,chunk_id,request_hash,state) VALUES($1,$2,$3,$4,'unknown')", [id, jobId, chunkId, requestHash]);
      return { id };
    });
    if ('response' in previous) return previous.response;
    try {
      const result = await start();
      await transaction(pool, async db => { await fence(db); await db.query("UPDATE business.document_translation_calls SET state='completed',response=$2,completed_at=now() WHERE id=$1 AND state='unknown'", [previous.id, JSON.stringify(result)]); });
      return result;
    } catch (error) {
      if (error instanceof ServiceError && knownFailures.has(error.code)) await transaction(pool, async db => {
        await fence(db); await db.query("UPDATE business.document_translation_calls SET state='failed',error_code=$2,completed_at=now() WHERE id=$1 AND state='unknown'", [previous.id, error.code]);
      }).catch(() => undefined);
      throw error;
    }
  };
}
