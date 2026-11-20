import type { DB } from '../../infrastructure/database/client.js';
import { AppError } from '../../shared/errors.js';
import type { Actor, BusinessRole } from './types.js';

export const TECHNICAL_ACTIONS = ['account:manage','permission:manage','audit:read','system:status'] as const;

/** RM is a historical/external role, never an application login identity. */
export async function canSignIn(client: DB, personId: string, businessRole: BusinessRole | null): Promise<boolean> {
  if (businessRole === 'BCO') return true;
  if (businessRole !== null) return false;
  return Boolean((await client.query(`SELECT 1 FROM business.access_grants WHERE person_id=$1 AND NOT revoked
    AND case_id IS NULL AND action=ANY($2::text[]) LIMIT 1`, [personId, TECHNICAL_ACTIONS])).rowCount);
}

export async function lockPersons(client: DB, personIds: string[]) {
  for (const id of [...new Set(personIds)].sort()) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`p1-person:${id}`]);
}

export async function assertActor(client: DB, actor: Actor) {
  await lockPersons(client, [actor.personId]);
  if (actor.sessionKey) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`p3-session:${actor.sessionKey}`]);
    const current = await client.query(`SELECT 1 FROM business.model_session_grants WHERE session_key=$1
      AND account_id=$2 AND person_id=$3 AND auth_version=$4 AND NOT revoked AND expires_at>clock_timestamp()`,
      [actor.sessionKey,actor.accountId,actor.personId,actor.authVersion]);
    if (!current.rowCount) throw new AppError(401, 'identity_revoked');
  }
  const r = await client.query('SELECT * FROM business.principals WHERE account_id=$1', [actor.accountId]);
  const p = r.rows[0];
  if (!p || p.person_id !== actor.personId || !p.enabled || p.must_change || p.auth_version !== actor.authVersion || !await canSignIn(client,p.person_id,p.business_role)) throw new AppError(401, 'identity_revoked');
  return p as { account_id: string; person_id: string; business_role: BusinessRole | null; auth_version: number };
}

export const ACTIONS = ['case:create','case:read','case:assign','case:confirm-scenario','maker','material:upload','evidence:read','document:parse','document:translate','document:classify','document:authorize',
  'checker','checker:read','checker:comment','checker:confirm','checker:correct','maker:submit','consultation:record','exception:decide',
  'report:read','report:generate','report:export','review:analyze','review:formal','case:close','case:configure','case:start','material:adopt','field:correct','finding:decide','rule:read','rule:propose','rule:trial','rule:approve','rule:publish',
  'account:manage','permission:manage','audit:read','system:status'] as const;

/** Uses the Worker-safe projection; account management never grants a business role implicitly. */
export async function requireBusinessRole(client: DB, actor: Actor): Promise<BusinessRole> {
  const principal = await assertActor(client, actor);
  if (principal.business_role !== 'BCO') throw new AppError(403,'business_role_required');
  return principal.business_role;
}

export async function hasGrant(client: DB, personId: string, action: string, caseId?: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM business.access_grants WHERE person_id=$1 AND action=$2 AND NOT revoked
    AND (case_id IS NULL OR case_id=$3::uuid) LIMIT 1`, [personId, action, caseId ?? null]); return Boolean(r.rowCount);
}

export async function requireGrant(client: DB, actor: Actor, action: string, caseId?: string) {
  const principal=await assertActor(client, actor);
  if (principal.business_role!=='BCO' && !(TECHNICAL_ACTIONS as readonly string[]).includes(action)) throw new AppError(403,'business_role_required');
  if (!await hasGrant(client, actor.personId, action, caseId)) throw new AppError(403,'permission_denied');
}
