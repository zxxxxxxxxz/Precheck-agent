import type { Pool, PoolClient } from 'pg';

export type DB = Pool | PoolClient;

export async function verifyDatabase(pool: DB, instanceId: string) {
  const r = await pool.query('SELECT instance_id FROM business.app_instance WHERE singleton=true');
  if (r.rows.length !== 1 || r.rows[0].instance_id !== instanceId) throw new Error('p1_database_identity_mismatch');
}

export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
