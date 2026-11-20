import cookie from '@fastify/cookie';
import session from '@fastify/session';
import connectPgSimple from 'connect-pg-simple';
import expressSession from 'express-session';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AccessDenied } from './access.js';

export const IDLE_MS = 30 * 60_000;
export const ABSOLUTE_MS = 8 * 60 * 60_000;
export interface LoginState { accountId: string; personId: string; sessionEpoch: number; authenticatedAt: number; lastActivityAt: number; csrf: string }
declare module 'fastify' { interface Session { login?: LoginState } }
export interface AccountRecord { id: string; personId: string; passwordHash: string; enabled: boolean; sessionEpoch: number }
export interface AccountRepository {
  find(username: string): Promise<AccountRecord | null>;
  get(id: string): Promise<AccountRecord | null>;
}
export class PgAccountRepository implements AccountRepository {
  constructor(private readonly pool: Pool) {}
  async find(username: string) { return this.load('username', username); }
  async get(id: string) { return this.load('id', id); }
  private async load(column: 'id' | 'username', value: string): Promise<AccountRecord | null> {
    const result = await this.pool.query(`SELECT id, person_id, password_hash, enabled, session_epoch FROM auth.accounts WHERE ${column}=$1 AND synthetic=true`, [value]);
    const row = result.rows[0];
    return row ? { id: row.id, personId: row.person_id, passwordHash: row.password_hash, enabled: row.enabled, sessionEpoch: row.session_epoch } : null;
  }
}

export function isSessionCurrent(login: LoginState, now: number): boolean {
  return now >= login.authenticatedAt && now >= login.lastActivityAt &&
    now - login.authenticatedAt < ABSOLUTE_MS && now - login.lastActivityAt < IDLE_MS;
}
export function createPgSessionStore(pool: Pool) {
  const PgStore = connectPgSimple(expressSession);
  class RevocablePgStore extends PgStore {
    override set(sid: string, data: expressSession.SessionData, callback?: (error?: unknown) => void) {
      void this.writeSession(sid, data).then(() => callback?.(), error => callback?.(error));
    }
    override destroy(sid: string, callback?: (error?: unknown) => void) {
      void this.writeSession(sid, null).then(() => callback?.(), error => callback?.(error));
    }
    private async writeSession(sid: string, data: expressSession.SessionData | null) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`p0-session:${sid}`]);
        if (data === null) {
          await client.query('INSERT INTO auth.session_revocations(sid) VALUES ($1) ON CONFLICT DO NOTHING', [sid]);
          await client.query('DELETE FROM auth.sessions WHERE sid=$1', [sid]);
        } else {
          const revoked = await client.query('SELECT 1 FROM auth.session_revocations WHERE sid=$1', [sid]);
          if (revoked.rowCount) throw new AccessDenied('session_revoked', 401);
          const expire = data.cookie.expires ? new Date(data.cookie.expires) : new Date(Date.now() + ABSOLUTE_MS);
          await client.query(`INSERT INTO auth.sessions(sid,sess,expire) VALUES($1,$2,$3)
            ON CONFLICT(sid) DO UPDATE SET sess=EXCLUDED.sess,expire=EXCLUDED.expire`, [sid, JSON.stringify(data), expire]);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
  }
  return new RevocablePgStore({ pool, schemaName: 'auth', tableName: 'sessions',
    createTableIfMissing: false, disableTouch: true, pruneSessionInterval: false });
}
/** P0 synthetic login experiment; never mounted unless explicitly enabled by bootstrap. */
export async function registerP0Auth(app: FastifyInstance, options: {
  accounts: AccountRepository; store: ReturnType<typeof createPgSessionStore>;
  secret: string; origin: string; secure: boolean; now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const dummyHash = await argon2.hash(randomBytes(32), { type: argon2.argon2id });
  if (!options.secure && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(options.origin)) {
    throw new Error('Insecure P0 cookies are restricted to loopback');
  }
  await app.register(cookie);
  await app.register(session, { secret: options.secret,
    cookieName: options.secure ? '__Host-p0-session' : 'p0-session',
    cookie: { httpOnly: true, secure: options.secure, sameSite: 'lax', path: '/', maxAge: ABSOLUTE_MS },
    saveUninitialized: false, rolling: false,
    store: options.store as unknown as NonNullable<Parameters<typeof session>[1]>['store'],
  });
  const checkOrigin = (request: FastifyRequest) => {
    if (request.headers.origin !== options.origin) throw new AccessDenied('invalid_origin');
  };
  const requireLogin = async (request: FastifyRequest): Promise<LoginState> => {
    const login = request.session.login;
    if (!login || !isSessionCurrent(login, now())) {
      if (login) await request.session.destroy();
      throw new AccessDenied('session_expired', 401);
    }
    const account = await options.accounts.get(login.accountId);
    if (!account?.enabled || account.personId !== login.personId || account.sessionEpoch !== login.sessionEpoch) {
      await request.session.destroy(); throw new AccessDenied('account_disabled', 401);
    }
    return login;
  };
  const checkWrite = async (request: FastifyRequest) => {
    checkOrigin(request); const login = await requireLogin(request);
    if (request.headers['x-csrf-token'] !== login.csrf) throw new AccessDenied('invalid_csrf');
    return login;
  };
  // Bounded loopback experiment throttle. P1 uses the shared PG/Redis policy.
  const attempts = new Map<string, { count: number; until: number }>();
  app.post('/api/p0/auth/login', async request => {
    checkOrigin(request);
    const previous = attempts.get(request.ip);
    if (previous && previous.until > now() && previous.count >= 5) throw new AccessDenied('login_rate_limited', 429);
    if (attempts.size > 1000) for (const [ip, entry] of attempts) if (entry.until <= now()) attempts.delete(ip);
    const entry = previous && previous.until > now() ? previous : { count: 0, until: now() + 60_000 };
    entry.count++; attempts.set(request.ip, entry);
    const parsed = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) }).strict().safeParse(request.body);
    if (!parsed.success) throw new AccessDenied('invalid_credentials', 401);
    const account = await options.accounts.find(parsed.data.username);
    const correct = await argon2.verify(account?.passwordHash ?? dummyHash, parsed.data.password);
    if (!account?.enabled || !correct) throw new AccessDenied('invalid_credentials', 401);
    await request.session.regenerate();
    request.session.login = { accountId: account.id, personId: account.personId, sessionEpoch: account.sessionEpoch, authenticatedAt: now(), lastActivityAt: now(), csrf: randomBytes(32).toString('base64url') };
    await request.session.save();
    return { authenticated: true, csrf: request.session.login.csrf };
  });
  app.get('/api/p0/auth/session', async request => {
    const login = await requireLogin(request);
    return { accountId: login.accountId, personId: login.personId, csrf: login.csrf,
      idleExpiresAt: login.lastActivityAt + IDLE_MS, absoluteExpiresAt: login.authenticatedAt + ABSOLUTE_MS };
  });
  app.post('/api/p0/auth/session/activity', async request => {
    const login = await checkWrite(request);
    if (now() - login.lastActivityAt >= 10_000) { login.lastActivityAt = now(); request.session.login = login; await request.session.save(); }
    return { idleExpiresAt: login.lastActivityAt + IDLE_MS };
  });
  app.post('/api/p0/auth/logout', async request => {
    await checkWrite(request); await request.session.destroy(); return { authenticated: false };
  });
  return { requireLogin, checkWrite };
}
