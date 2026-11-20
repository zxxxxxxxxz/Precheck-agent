import { DOCUMENT_PAGE_LIMIT } from '@hsbc/contracts/document-limits';

export interface AppConfig {
  mode: 'local' | 'production'; instanceId: string; databaseUrl: string; workerDatabaseUrl?: string;
  checkpointDatabaseUrl?: string; migrationDatabaseUrl?: string; redisUrl: string; sessionSecret: string;
  origin: string; host: string; port: number; trustProxy: string[]; queuePrefix: string;
  upload: { enabled: boolean; bucket: string; region: string; endpoint?: string; publicEndpoint?: string;
    prefix: string; maxBytes: number; maxPages: number; ttlSeconds: number; orphanGraceSeconds: number;
    docxEnabled?: boolean; maxDocxBytes?: number;
    credential?: { accessKeyId: string; accessKeySecret: string; securityToken?: string; expiresAt?: string } };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, role: 'api'|'worker'|'migration' = 'api'): AppConfig {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('node24_required');
  const required = (key: string) => { const value = env[key]; if (!value) throw new Error(`missing_configuration:${key}`); return value; };
  const mode = required('P1_MODE'); if (mode !== 'local' && mode !== 'production') throw new Error('invalid_p1_mode');
  const origin = new URL(required('P1_ORIGIN'));
  if (origin.origin !== env.P1_ORIGIN || origin.username || origin.password) throw new Error('invalid_p1_origin');
  if (mode === 'production' ? origin.protocol !== 'https:' : origin.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(origin.hostname)) throw new Error('invalid_p1_transport');
  const secret = role === 'api' ? required('P1_SESSION_SECRET') : '';
  if (role === 'api' && secret.length < 32) throw new Error('session_secret_too_short');
  const databaseUrl = required(role === 'worker' ? 'P1_WORKER_DATABASE_URL' : role === 'migration' ? 'P1_MIGRATION_DATABASE_URL' : 'P1_DATABASE_URL');
  const db = new URL(databaseUrl); if (!['postgres:', 'postgresql:'].includes(db.protocol)) throw new Error('invalid_database_url');
  if (mode === 'local' && (!['localhost','127.0.0.1','[::1]'].includes(db.hostname) || db.pathname !== '/hsbc_p1')) throw new Error('local_database_isolation_required');
  const port = Number(env.P1_PORT ?? '3001'); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
  const prefix = env.P1_OSS_PREFIX ?? 'p1/'; if (!/^p1\/[a-zA-Z0-9/_-]*$/.test(prefix) || !prefix.endsWith('/')) throw new Error('invalid_oss_prefix');
  const key = env.P1_OSS_ACCESS_KEY_ID, keySecret = env.P1_OSS_ACCESS_KEY_SECRET;
  if (Boolean(key) !== Boolean(keySecret)) throw new Error('incomplete_oss_credential');
  if(env.P2_DOCX_ENABLED!==undefined&&!['true','false'].includes(env.P2_DOCX_ENABLED))throw new Error('invalid_flag:P2_DOCX_ENABLED');
  return { mode, instanceId: required('P1_INSTANCE_ID'), databaseUrl,
    workerDatabaseUrl: env.P1_WORKER_DATABASE_URL, checkpointDatabaseUrl: env.P1_CHECKPOINT_DATABASE_URL,
    migrationDatabaseUrl: env.P1_MIGRATION_DATABASE_URL, redisUrl: required('P1_REDIS_URL'), sessionSecret: secret,
    origin: origin.origin, host: env.P1_HOST ?? '127.0.0.1', port,
    trustProxy: (env.P1_TRUST_PROXY ?? '').split(',').map(s => s.trim()).filter(Boolean),
    queuePrefix: `p1-${required('P1_INSTANCE_ID').replace(/[^a-zA-Z0-9_-]/g, '')}`,
    upload: { enabled: Boolean(env.P1_OSS_BUCKET), bucket: env.P1_OSS_BUCKET ?? '', region: env.P1_OSS_REGION ?? 'cn-wulanchabu',
      endpoint: env.P1_OSS_ENDPOINT, publicEndpoint: env.P1_OSS_PUBLIC_ENDPOINT, prefix,
      maxBytes: 50 * 1024 * 1024, maxPages: DOCUMENT_PAGE_LIMIT, ttlSeconds: 300, orphanGraceSeconds: 3600,
      docxEnabled:env.P2_DOCX_ENABLED==='true',maxDocxBytes:25*1024*1024,
      ...(key && keySecret ? { credential: { accessKeyId:key, accessKeySecret:keySecret, securityToken:env.P1_OSS_SECURITY_TOKEN, expiresAt:env.P1_OSS_CREDENTIAL_EXPIRES_AT } } : {}) }
  };
}
