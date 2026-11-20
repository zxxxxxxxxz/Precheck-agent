import { createHash } from 'node:crypto';
import type { DB } from './client.js';
import type { Actor } from '../../modules/identity/types.js';
import { AppError } from '../../shared/errors.js';

export function inputHash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export async function idempotent<T>(client: DB, actor: Actor, operation: string, key: string, input: unknown, fn:()=>Promise<T>): Promise<T> {
  const id = `${actor.accountId}:${operation}:${key}`; const hash = inputHash(input);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
  const old = (await client.query('SELECT * FROM business.command_receipts WHERE receipt_key=$1',[id])).rows[0];
  if (old) { if (old.input_hash !== hash) throw new AppError(409,'idempotency_conflict'); return old.result; }
  const result = await fn(); await client.query('INSERT INTO business.command_receipts(receipt_key,input_hash,result) VALUES($1,$2,$3)',[id,hash,JSON.stringify(result)]); return result;
}
