import { jwtVerify, type CryptoKey, type KeyObject } from 'jose';
import type { Pool } from 'pg';
import type { AuthorizedScope, ServiceIdentity } from '@hsbc/contracts/identity';
import type { ProtocolAuthorizer } from '../protocols/ports.js';

export class AccessDenied extends Error {
  readonly statusCode: number;
  constructor(readonly code: string, statusCode = 403) { super(code); this.statusCode = statusCode; }
}
export interface DelegationRecord {
  id: string; serviceId: string; enabled: boolean; revoked: boolean;
  caseId: string; revision: number; currentRevision: number;
  taskId?: string; actions: string[]; authorizationVersion: number; expiresAt: number;
}
export interface AccessRepository { delegation(id: string): Promise<DelegationRecord | null> }
export class PgAccessRepository implements AccessRepository {
  constructor(private readonly pool: Pool, private readonly currentRevision: (caseId: string) => Promise<number | null>) {}
  async delegation(id: string): Promise<DelegationRecord | null> {
    const result = await this.pool.query(`SELECT d.*, p.enabled FROM business.delegations d
      JOIN business.service_principals p ON p.id=d.service_id WHERE d.id=$1`, [id]);
    const d = result.rows[0];
    if (!d) return null;
    return { id: d.id, serviceId: d.service_id, enabled: d.enabled, revoked: d.revoked,
      caseId: d.case_id, revision: d.revision, currentRevision: await this.currentRevision(d.case_id) ?? -1,
      ...(d.task_id ? { taskId: d.task_id } : {}), actions: d.actions,
      authorizationVersion: d.authorization_version, expiresAt: new Date(d.expires_at).getTime() };
  }
}
export class ServiceAuthorizer implements ProtocolAuthorizer {
  constructor(private readonly options: {
    publicKey: CryptoKey | KeyObject; issuer: string; audience: string;
    repository: AccessRepository; now?: () => number;
  }) {}
  async authenticate(header: string | undefined): Promise<ServiceIdentity> {
    if (!header?.startsWith('Bearer ')) throw new AccessDenied('authentication_required', 401);
    try {
      const now = this.options.now?.() ?? Date.now();
      const { payload } = await jwtVerify(header.slice(7), this.options.publicKey, {
        issuer: this.options.issuer, audience: this.options.audience, algorithms: ['ES256'],
        requiredClaims: ['sub', 'iat', 'exp', 'jti'], currentDate: new Date(now), maxTokenAge: '5m',
      });
      if (typeof payload.sub !== 'string' || typeof payload.delegationId !== 'string' ||
          typeof payload.jti !== 'string' || payload.exp! - payload.iat! > 300) throw new Error();
      return { kind: 'service', serviceId: payload.sub, delegationId: payload.delegationId, credentialId: payload.jti };
    } catch { throw new AccessDenied('invalid_service_credential', 401); }
  }
  async authorize(identity: ServiceIdentity, action: string, resource?: { caseId: string; revision: number; taskId?: string }): Promise<AuthorizedScope> {
    const d = await this.options.repository.delegation(identity.delegationId);
    if (!d || !d.enabled || d.revoked || d.serviceId !== identity.serviceId ||
        d.expiresAt <= (this.options.now?.() ?? Date.now()) || !d.actions.includes(action) ||
        d.revision !== d.currentRevision ||
        (resource && (resource.caseId !== d.caseId || resource.revision !== d.revision ||
          (d.taskId !== undefined && resource.taskId !== d.taskId)))) throw new AccessDenied('scope_denied');
    return { caseId: d.caseId, revision: d.revision, serviceId: d.serviceId,
      delegationId: d.id, authorizationVersion: d.authorizationVersion };
  }
}

export function assertIndependentReviewer(reviewerPersonId: string, contributorPersonIds: readonly string[]): void {
  if (contributorPersonIds.includes(reviewerPersonId)) throw new AccessDenied('same_person_cannot_review');
}
