import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CompanyLookupCommandSchema, CompanyLookupQuerySchema, CompanyLookupReceiptSchema,
  type CompanyIdentityState, type CompanyLookupReceipt, type CompanyLookupQuery, type CompanyNameSelection,
} from '@hsbc/contracts/company-identity';
import type { Auth } from '../identity/auth.js';
import type { Actor } from '../identity/types.js';
import { hasGrant } from '../identity/authorization.js';
import { authorizeCase, isEligibleMaker } from '../cases/authorization.js';
import { transaction, type DB } from '../../infrastructure/database/client.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/events.js';
import { CompanyLookupError, GleifClient, GLEIF_CLIENT_VERSION } from './gleif-client.js';
import { normalizeCompanyName, COMPANY_NAME_VERSION } from './normalization.js';
import type { CompanyIdentityConfig } from './config.js';
import { configHash } from '../review/opa.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
interface LookupRow { id: string; case_id: string; case_revision: number; query: CompanyLookupQuery; created_at: Date; input_hash: string }
const POSITIVE_TTL = 24 * 60 * 60 * 1000, NEGATIVE_TTL = 60 * 60 * 1000;
/** Shared deterministic service. External searches are explicit HTTP commands, never parsing side effects. */
export class CompanyIdentityService {
  constructor(readonly pool: Pool, readonly config: CompanyIdentityConfig, readonly client = new GleifClient()) {}
  private availability(caseId: string): { available: boolean; reasonCode: string | null } {
    const policy = this.config.policy;
    const reasonCode = !this.config.externalEnabled ? 'company_lookup_disabled' : !policy ? 'company_lookup_policy_required' :
      Date.parse(policy.expiresAt) <= Date.now() ? 'company_lookup_policy_expired' :
      !policy.caseIds.includes(caseId) ? 'company_lookup_scope_denied' : null;
    return { available: reasonCode === null, reasonCode };
  }
  private async fence(db: DB, actor: Actor, caseId: string, expectedRevision: number, policyHash: string) {
    const c = await authorizeCase(db, actor, caseId, 'field:correct');
    if (c.revision !== expectedRevision) throw new AppError(409, 'stale_revision');
    const availability = this.availability(caseId);
    if (!availability.available || hash(this.config.policy) !== policyHash) throw new AppError(403, availability.reasonCode ?? 'company_lookup_policy_changed');
    return c;
  }
  private pending(row: LookupRow): CompanyLookupReceipt {
    const unknown = Date.now() - row.created_at.getTime() > 30_000;
    return CompanyLookupReceiptSchema.parse({
      id: row.id, caseId: row.case_id, caseRevision: row.case_revision, query: row.query,
      normalized: normalizeCompanyName(row.query.name), status: unknown ? 'unavailable' : 'pending', records: [], source: 'GLEIF',
      fetchedAt: null, expiresAt: null, cache: 'miss', truncated: false, errorCode: unknown ? 'company_lookup_execution_unknown' : null,
      clientVersion: GLEIF_CLIENT_VERSION, normalizationVersion: COMPANY_NAME_VERSION, responseHash: null, sourceDataVersion: null,
    });
  }
  private view(receipt: CompanyLookupReceipt, revision: number): CompanyLookupReceipt {
    const stale = receipt.caseRevision !== revision || Boolean(receipt.expiresAt && Date.parse(receipt.expiresAt) <= Date.now());
    return stale ? { ...receipt, status: 'stale', errorCode: 'company_lookup_stale' } : receipt;
  }
  async state(actor: Actor, caseId: string): Promise<CompanyIdentityState> {
    return transaction(this.pool, async db => {
      const c = await authorizeCase(db, actor, caseId, 'evidence:read', false), allowedActions: CompanyIdentityState['allowedActions'] = [];
      const permitted = c.maker_person_id === actor.personId && await isEligibleMaker(db, actor.personId, caseId) &&
        await hasGrant(db, actor.personId, 'field:correct', caseId) && c.scenario === 'overseas_loan';
      const externalLookup = this.availability(caseId);
      if (permitted) { allowedActions.push('adopt'); if (externalLookup.available) allowedActions.push('lookup'); }
      const rows = (await db.query(`SELECT r.*,v.body FROM business.company_lookup_requests r
        LEFT JOIN business.company_lookup_receipts v ON v.lookup_id=r.id WHERE r.case_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 50`, [caseId])).rows;
      return { caseId, revision: c.revision, externalLookup, allowedActions,
        receipts: rows.map(row => this.view(row.body ? CompanyLookupReceiptSchema.parse(row.body) : this.pending(row), c.revision)) };
    });
  }
  async get(actor: Actor, caseId: string, lookupId: string): Promise<CompanyLookupReceipt> {
    return transaction(this.pool, async db => {
      const c = await authorizeCase(db, actor, caseId, 'evidence:read', false);
      const row = (await db.query(`SELECT r.*,v.body FROM business.company_lookup_requests r
        LEFT JOIN business.company_lookup_receipts v ON v.lookup_id=r.id WHERE r.case_id=$1 AND r.id=$2`, [caseId, lookupId])).rows[0];
      if (!row) throw new AppError(404, 'company_lookup_not_found');
      return this.view(row.body ? CompanyLookupReceiptSchema.parse(row.body) : this.pending(row), c.revision);
    });
  }
  private async save(db: DB, receipt: CompanyLookupReceipt, actor: Actor) {
    const validated = CompanyLookupReceiptSchema.parse(receipt);
    await db.query('INSERT INTO business.company_lookup_receipts(lookup_id,case_id,body,body_hash) VALUES($1,$2,$3,$4) ON CONFLICT(lookup_id) DO NOTHING',
      [receipt.id, receipt.caseId, JSON.stringify(validated), configHash(validated)]);
    await audit(db, { actorId: actor.accountId, targetId: receipt.id, action: 'company.lookup_completed',
      details: { status: receipt.status, count: receipt.records.length, cache: receipt.cache, truncated: receipt.truncated, clientVersion: receipt.clientVersion } });
  }
  async lookup(actor: Actor, caseId: string, raw: unknown, signal?: AbortSignal): Promise<CompanyLookupReceipt> {
    const input = CompanyLookupCommandSchema.parse(raw);
    const { expectedRevision, idempotencyKey, reason, ...parts } = input;
    const query = CompanyLookupQuerySchema.parse(parts), inputHash = hash(input), policyHash = hash(this.config.policy);
    // All parameters, versions and policy participate in the cache key; names never enter logs.
    const queryHash = hash({ query, policyHash, normalization: COMPANY_NAME_VERSION, client: GLEIF_CLIENT_VERSION });
    const prepared = await transaction(this.pool, async db => {
      const c = await authorizeCase(db, actor, caseId, 'field:correct');
      const commandKey = `${actor.accountId}:company-lookup:${caseId}:${idempotencyKey}`;
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [commandKey]);
      const priorCommand = (await db.query('SELECT input_hash,result FROM business.command_receipts WHERE receipt_key=$1', [commandKey])).rows[0];
      if (priorCommand && priorCommand.input_hash !== inputHash) throw new AppError(409, 'idempotency_conflict');
      const old = priorCommand ? (await db.query('SELECT * FROM business.company_lookup_requests WHERE id=$1 AND case_id=$2', [priorCommand.result.lookupId, caseId])).rows[0] : undefined;
      if (old) {
        const receipt = (await db.query('SELECT body FROM business.company_lookup_receipts WHERE lookup_id=$1', [old.id])).rows[0]?.body;
        return { receipt: this.view(receipt ? CompanyLookupReceiptSchema.parse(receipt) : this.pending(old), c.revision) };
      }
      const commandReceipt = (id: string) => db.query('INSERT INTO business.command_receipts(receipt_key,input_hash,result) VALUES($1,$2,$3)',
        [commandKey, inputHash, JSON.stringify({ lookupId: id })]);
      if (c.revision !== expectedRevision) throw new AppError(409, 'stale_revision');
      const available = this.availability(caseId);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['company-lookup:provider-budget']);
      const unresolved = (await db.query(`SELECT r.* FROM business.company_lookup_requests r
        WHERE r.case_id=$1 AND r.case_revision=$2 AND r.query_hash=$3 AND r.account_id=$4 AND r.dispatched
        AND NOT EXISTS(SELECT 1 FROM business.company_lookup_receipts v WHERE v.lookup_id=r.id) ORDER BY r.created_at LIMIT 1`,
      [caseId, expectedRevision, queryHash, actor.accountId])).rows[0];
      if (unresolved) { await commandReceipt(unresolved.id); return { receipt: this.pending(unresolved) }; }
      const cached = available.available ? (await db.query('SELECT body FROM business.company_lookup_cache WHERE case_id=$1 AND query_hash=$2 AND expires_at>now()', [caseId, queryHash])).rows[0]?.body : undefined;
      const count = available.available && !cached ? (await db.query(`SELECT
        count(*) FILTER (WHERE created_at>now()-interval '1 minute')::int AS minute,
        count(*) FILTER (WHERE created_at>=date_trunc('day',now()))::int AS day
        FROM business.company_lookup_requests WHERE dispatched AND created_at>now()-interval '1 day'`)).rows[0] : undefined;
      const budget = count && (count.minute >= this.config.policy!.requestsPerMinute || count.day >= this.config.policy!.requestsPerDay);
      const errorCode = available.reasonCode ?? (budget ? 'company_lookup_budget_exhausted' : null);
      const row: LookupRow = { id: randomUUID(), case_id: caseId, case_revision: expectedRevision, query, created_at: new Date(), input_hash: inputHash };
      const dispatch = !errorCode && !cached;
      await db.query(`INSERT INTO business.company_lookup_requests
        (id,case_id,case_revision,account_id,person_id,auth_version,idempotency_key,input_hash,query_hash,policy_hash,query,reason,dispatched)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [row.id, caseId, expectedRevision, actor.accountId, actor.personId, actor.authVersion, idempotencyKey, inputHash, queryHash, policyHash, JSON.stringify(query), reason, dispatch]);
      await commandReceipt(row.id);
      const initial = this.pending(row);
      if (errorCode || cached) {
        const receipt: CompanyLookupReceipt = errorCode ? { ...initial, status: 'blocked', errorCode } :
          { ...CompanyLookupReceiptSchema.parse(cached), id: row.id, caseId, caseRevision: expectedRevision, cache: 'hit' };
        await this.save(db, receipt, actor); return { receipt };
      }
      await audit(db, { actorId: actor.accountId, targetId: row.id, action: 'company.lookup_dispatched',
        details: { policyVersion: this.config.policy!.version, queryHash, clientVersion: GLEIF_CLIENT_VERSION } });
      return { row, initial };
    });
    if (prepared.receipt) return prepared.receipt;
    const { initial } = prepared;
    let receipt: CompanyLookupReceipt;
    try {
      signal?.throwIfAborted();
      // A second authorization immediately precedes the network call, without holding a DB transaction across HTTP.
      await transaction(this.pool, db => this.fence(db, actor, caseId, expectedRevision, policyHash));
      const result = await this.client.lookup(query, signal), fetchedAt = new Date();
      receipt = { ...initial!, ...result, fetchedAt: fetchedAt.toISOString(),
        expiresAt: new Date(Math.min(Date.parse(this.config.policy!.expiresAt), fetchedAt.getTime() + (result.records.length ? POSITIVE_TTL : NEGATIVE_TTL))).toISOString(),
        status: !result.records.length ? 'not_found' : result.records.every(record => record.conflicts.length > 0) ? 'conflicting' : 'candidates' };
    } catch (error) {
      receipt = { ...initial!, status: error instanceof AppError ? 'blocked' : 'unavailable',
        errorCode: error instanceof CompanyLookupError || error instanceof AppError ? error.code : 'company_lookup_canceled' };
    }
    try {
      await transaction(this.pool, async db => {
        await this.fence(db, actor, caseId, expectedRevision, policyHash); signal?.throwIfAborted();
        await this.save(db, receipt, actor);
        for (const record of receipt.records) {
          // Match/conflict explanations belong to the case query receipt, not the public record cache.
          const { matchBasis, conflicts, ...publicRecord } = record;
          await db.query(`INSERT INTO business.company_registry_records
            (lei,record_hash,fetched_at,expires_at,source_data_version,client_version,body) VALUES($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT(lei,record_hash,fetched_at) DO NOTHING`,
          [record.lei, configHash(publicRecord), receipt.fetchedAt, receipt.expiresAt, receipt.sourceDataVersion, receipt.clientVersion, JSON.stringify(publicRecord)]);
        }
        if (['candidates', 'not_found', 'conflicting'].includes(receipt.status)) await db.query(`INSERT INTO business.company_lookup_cache(case_id,query_hash,body,expires_at)
          VALUES($1,$2,$3,$4) ON CONFLICT(case_id,query_hash) DO UPDATE SET body=EXCLUDED.body,expires_at=EXCLUDED.expires_at`,
        [caseId, queryHash, JSON.stringify(receipt), receipt.expiresAt]);
      });
    } catch (error) {
      // Record only a safe terminal outcome after revocation/version conflict; never persist the late external records.
      await transaction(this.pool, db => this.save(db, { ...initial!, status: 'stale', records: [], errorCode: 'company_lookup_authority_changed' }, actor));
      if (error instanceof AppError) throw error;
      throw new AppError(409, 'company_lookup_canceled');
    }
    return receipt;
  }
}

/** Called only inside the existing Maker confirmation transaction. A lookup never creates identity facts. */
export async function validateCompanyNameSelection(db: DB, caseId: string, revision: number, selection: CompanyNameSelection, label: string) {
  const row = (await db.query('SELECT body FROM business.company_lookup_receipts WHERE case_id=$1 AND lookup_id=$2', [caseId, selection.lookupId])).rows[0];
  if (!row) throw new AppError(422, 'company_lookup_selection_invalid');
  const receipt = CompanyLookupReceiptSchema.parse(row.body), record = receipt.records.find(value => value.lei === selection.lei);
  if (receipt.caseRevision !== revision || !receipt.expiresAt || Date.parse(receipt.expiresAt) <= Date.now()) throw new AppError(409, 'company_lookup_stale');
  if (receipt.status !== 'candidates' || !record || record.conflicts.length || record.legalName !== label) throw new AppError(422, 'company_lookup_selection_invalid');
  return record;
}
export function registerCompanyIdentityRoutes(app: FastifyInstance, auth: Auth, service: CompanyIdentityService) {
  const base = '/api/cases/:caseId/company-identities';
  const params = (request: any) => z.object({ caseId: z.uuid(), lookupId: z.uuid().optional() }).parse(request.params);
  app.get(base, async request => service.state(await auth.requireSession(request), params(request).caseId));
  app.get(`${base}/lookups/:lookupId`, async request => { const p = params(request); return service.get(await auth.requireSession(request), p.caseId, p.lookupId!); });
  app.post(`${base}/lookups`, async request => service.lookup(await auth.checkWrite(request), params(request).caseId, request.body));
}
