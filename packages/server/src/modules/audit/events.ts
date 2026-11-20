import { randomUUID } from 'node:crypto';
import type { DB } from '../../infrastructure/database/client.js';

export async function audit(client: DB, event: {actorId?:string;targetId?:string;action:string;result?:string;details?:Record<string,string|number|boolean>}) {
  // Only callers' explicitly selected identifiers/status values reach audit, never request bodies.
  await client.query('INSERT INTO business.audit_events(id,actor_id,target_id,action,result,details) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(),event.actorId ?? null,event.targetId ?? null,event.action,event.result ?? 'success',JSON.stringify(event.details ?? {})]);
}
