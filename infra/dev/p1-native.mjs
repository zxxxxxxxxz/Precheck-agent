#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
export function getP1Paths(instanceName = process.env.P1_NATIVE_INSTANCE, root = ROOT) {
  if (instanceName !== undefined && (!/^[a-z][a-z0-9-]{0,47}$/.test(instanceName) || instanceName === 'default')) {
    throw new Error('Invalid P1 named instance');
  }
  const localDir = join(root, instanceName === undefined ? '.local/p1' : `.local/p1-instances/${instanceName}`);
  return { instanceName, localDir, envFile: instanceName === undefined ? join(root, '.env.p1.local') : join(localDir, 'environment.env'),
    markerFile: join(localDir, 'instance.json'), postgresDir: join(localDir, 'postgres'), redisDir: join(localDir, 'redis') };
}
const PATHS = getP1Paths();
const { localDir: LOCAL, postgresDir: PGDATA, redisDir: REDISDIR, envFile: ENVFILE, markerFile: MARKER } = PATHS;
const PG = '/opt/homebrew/opt/postgresql@18/bin';
const REDIS = '/opt/homebrew/bin/redis-server';
const REDISCLI = '/opt/homebrew/bin/redis-cli';
const ROLES = {
  P1_DATABASE_URL: 'hsbc_p1_api',
  P1_WORKER_DATABASE_URL: 'hsbc_p1_worker', P1_CHECKPOINT_DATABASE_URL: 'hsbc_p1_checkpoint',
  P1_MIGRATION_DATABASE_URL: 'hsbc_p1_migration',
};

function validPorts(postgresPort, redisPort) {
  if (![postgresPort, redisPort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) || postgresPort === redisPort) {
    throw new Error('Invalid P1 instance ports');
  }
  return { postgresPort, redisPort };
}

function requestedPorts() {
  const values = [process.env.P1_NATIVE_PG_PORT, process.env.P1_NATIVE_REDIS_PORT];
  if (!values.every(value => typeof value === 'string' && /^[1-9]\d{3,4}$/.test(value))) throw new Error('Named P1 initialization requires both explicit ports');
  return validPorts(Number(values[0]), Number(values[1]));
}

/** A named instance may run its API and Web beside the default 3001/5173 pair. */
export function applicationPorts(values = {}) {
  const api = values.P1_NATIVE_API_PORT ?? '3001', web = values.P1_NATIVE_WEB_PORT ?? '5173';
  if (![api, web].every(value => typeof value === 'string' && /^[1-9]\d{3,4}$/.test(value)) || api === web ||
    [api, web].some(value => Number(value) < 1024 || Number(value) > 65535)) throw new Error('Invalid P1 application ports');
  return { P1_ORIGIN: `http://127.0.0.1:${web}`, P1_PORT: api };
}

function markerPorts(marker, root, instanceName) {
  if (instanceName === undefined) {
    if (marker.kind !== 'hsbc-p1-native-v1') throw new Error('P1 instance identity mismatch');
    return { postgresPort: 25433, redisPort: 26380 };
  }
  const paths = getP1Paths(instanceName, root);
  if (marker.kind !== 'hsbc-p1-native-v2' || marker.instanceName !== instanceName || marker.localDir !== paths.localDir) {
    throw new Error('P1 instance identity mismatch');
  }
  return validPorts(marker.postgresPort, marker.redisPort);
}

function ports() {
  const marker = JSON.parse(readFileSync(MARKER, 'utf8'));
  if (marker.projectRoot !== ROOT || !/^[0-9a-f-]{36}$/.test(marker.instanceId)) throw new Error('P1 instance identity mismatch');
  const selected = markerPorts(marker, ROOT, PATHS.instanceName);
  for (const [key, value] of [['P1_NATIVE_PG_PORT', selected.postgresPort], ['P1_NATIVE_REDIS_PORT', selected.redisPort]]) {
    if (process.env[key] !== undefined && process.env[key] !== String(value)) throw new Error('P1 persisted port override mismatch');
  }
  return selected;
}

function safeFile(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error('P1 path must not be a symbolic link');
}

function safePaths() {
  for (const path of [join(ROOT, '.local'), ...(PATHS.instanceName ? [join(ROOT, '.local/p1-instances')] : []), LOCAL, PGDATA, REDISDIR, ENVFILE, MARKER,
    join(LOCAL, 'admin-password'), join(LOCAL, 'postgres.log'), join(PGDATA, 'postgresql.auto.conf'),
    join(PGDATA, 'postmaster.pid'), join(REDISDIR, 'redis.pid'), join(REDISDIR, 'redis.conf'), join(REDISDIR, 'redis.log')]) safeFile(path);
}

function privateWrite(path, contents) {
  safeFile(path);
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(result, match[1])) throw new Error('Invalid or duplicate P1 environment entry');
    result[match[1]] = match[2];
  }
  return result;
}

export function assertP1Target(env, marker, root = ROOT, instanceName) {
  const { postgresPort, redisPort } = markerPorts(marker, root, instanceName);
  if (marker.projectRoot !== root || env.P1_NATIVE_INSTANCE !== instanceName ||
    env.P1_ENV !== 'p1-native' || env.P1_MODE !== 'local' || env.P1_PROJECT_ROOT !== root ||
    !/^[0-9a-f-]{36}$/.test(marker.instanceId) || env.P1_INSTANCE_ID !== marker.instanceId) {
    throw new Error('P1 instance identity mismatch');
  }
  for (const [key, role] of Object.entries(ROLES)) {
    let url;
    try { url = new URL(env[key]); } catch { throw new Error(`Invalid ${key}`); }
    if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== String(postgresPort) ||
      url.pathname !== '/hsbc_p1' || url.username !== role || !/^[A-Za-z0-9_-]+$/.test(url.password) || url.search || url.hash) {
      throw new Error(`${key} must target the isolated P1 database with its assigned role`);
    }
  }
  let redis;
  try { redis = new URL(env.P1_REDIS_URL); } catch { throw new Error('Invalid P1_REDIS_URL'); }
  if (redis.protocol !== 'redis:' || redis.hostname !== '127.0.0.1' || redis.port !== String(redisPort) ||
    redis.pathname !== '/0' || redis.username !== 'default' || !/^[A-Za-z0-9_-]+$/.test(redis.password) || redis.search || redis.hash) {
    throw new Error('P1_REDIS_URL must target the isolated P1 Redis');
  }
  if (!env.P1_SESSION_SECRET || env.P1_SESSION_SECRET.length < 32) throw new Error('Missing P1 session secret');
  return env;
}

export function loadP1Environment() {
  safePaths();
  if (!existsSync(ENVFILE) || !existsSync(MARKER)) throw new Error('Run p1-native.mjs init first');
  if ((lstatSync(ENVFILE).mode & 0o077) !== 0) throw new Error('.env.p1.local must have mode 600');
  ports();
  return assertP1Target(parseEnv(readFileSync(ENVFILE, 'utf8')), JSON.parse(readFileSync(MARKER, 'utf8')), ROOT, PATHS.instanceName);
}

function run(bin, args, options = {}) {
  // Deliberately ignore inherited PG*/REDIS* connection variables and arbitrary loader flags.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', ...options.env };
  const result = spawnSync(bin, args, { encoding: 'utf8', env, input: options.input, timeout: 30000 });
  if (result.status !== 0) throw new Error(`${bin.split('/').at(-1)} failed (exit ${result.status ?? 'unavailable'}); inspect the local service log`);
  return result.stdout.trim();
}

function versions() {
  if (process.version !== 'v24.19.0' && !(process.env.P0_ALLOW_NODE24_COMPAT === 'true' && process.versions.node.startsWith('24.'))) throw new Error('Use scripts/node24.sh; P1 requires Node 24.19.0');
  const pg = run(join(PG, 'postgres'), ['--version']);
  const redis = run(REDIS, ['--version']);
  if (!/PostgreSQL\) 18\.6(?:\s|$)/.test(pg)) throw new Error('P1 requires PostgreSQL 18.6');
  if (!/v=8\.10\.1(?:\s|$)/.test(redis)) throw new Error('P1 requires Redis 8.10.1');
  return { node: process.version, postgres: '18.6', redis: '8.10.1' };
}

function adminSql(sql, database = 'hsbc_p1') {
  const password = readFileSync(join(LOCAL, 'admin-password'), 'utf8').trim();
  return run(join(PG, 'psql'), ['-X', '-w', '-h', '127.0.0.1', '-p', String(ports().postgresPort), '-U', 'hsbc_p1_admin', '-d', database, '-v', 'ON_ERROR_STOP=1', '-At'], {
    env: { PGPASSWORD: password }, input: sql,
  });
}

function roleSql(urlString, sql) {
  const url = new URL(urlString);
  return run(join(PG, 'psql'), ['-X', '-w', '-h', url.hostname, '-p', url.port, '-U', url.username, '-d', 'hsbc_p1', '-v', 'ON_ERROR_STOP=1', '-At'], {
    env: { PGPASSWORD: decodeURIComponent(url.password) }, input: sql,
  });
}

function redisCommand(env, args) {
  return run(REDISCLI, ['--no-auth-warning', '-h', '127.0.0.1', '-p', String(ports().redisPort), '--raw', ...args], {
    env: { REDISCLI_AUTH: decodeURIComponent(new URL(env.P1_REDIS_URL).password) },
  });
}

function processCommand(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid P1 service PID');
  return run('/bin/ps', ['-p', String(pid), '-o', 'command=']);
}

export function assertPostgresIdentity(pidText, command, dataDir = PGDATA, expectedPort = 25433) {
  const lines = pidText.trim().split('\n');
  const pid = Number(lines[0]);
  const binaries = [join(PG, 'postgres')];
  if (existsSync(binaries[0])) binaries.push(realpathSync(binaries[0]));
  if (!Number.isSafeInteger(pid) || pid <= 1 || lines[1] !== dataDir || lines[3] !== String(expectedPort) ||
    !binaries.some(binary => command === `${binary} -D ${dataDir}`)) throw new Error('PostgreSQL process does not belong to this P1 instance');
  return pid;
}

export function assertRedisIdentity(infoText, expectedPid, configPath = join(REDISDIR, 'redis.conf'), expectedPort = 26380) {
  const info = Object.fromEntries(infoText.split(/\r?\n/).filter(line => line.includes(':')).map(line => {
    const i = line.indexOf(':'); return [line.slice(0, i), line.slice(i + 1)];
  }));
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 1 || Number(info.process_id) !== expectedPid ||
    info.config_file !== configPath || info.tcp_port !== String(expectedPort)) throw new Error('Redis process does not belong to this P1 instance');
}

async function occupied(port) {
  return new Promise(resolvePort => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = value => { if (!done) { done = true; socket.destroy(); resolvePort(value); } };
    socket.once('connect', () => finish(true));
    socket.once('error', error => {
      // Permission and routing failures are unsafe to interpret as a free port.
      if (error.code === 'ECONNREFUSED') finish(false); else finish(true);
    });
    socket.setTimeout(1000, () => finish(true));
  });
}

function verifyPostgres(env, requireDatabase = true) {
  const pidText = readFileSync(join(PGDATA, 'postmaster.pid'), 'utf8');
  const pid = Number(pidText.split('\n')[0]);
  assertPostgresIdentity(pidText, processCommand(pid), PGDATA, ports().postgresPort);
  if (adminSql('SHOW data_directory;', 'postgres') !== PGDATA) throw new Error('PostgreSQL data directory mismatch');
  if (requireDatabase && roleSql(env.P1_MIGRATION_DATABASE_URL, 'SELECT instance_id FROM p1_guard.instance;') !== env.P1_INSTANCE_ID) {
    throw new Error('Database P1 marker mismatch');
  }
}

function verifyRedis(env) {
  const pid = Number(readFileSync(join(REDISDIR, 'redis.pid'), 'utf8').trim());
  assertRedisIdentity(redisCommand(env, ['INFO', 'server']), pid, join(REDISDIR, 'redis.conf'), ports().redisPort);
  if (redisCommand(env, ['GET', 'p1:instance']) !== env.P1_INSTANCE_ID) throw new Error('Redis P1 marker mismatch');
}

function bootstrapSql(env) {
  const roles = [...new Set(Object.values(ROLES))];
  const password = role => decodeURIComponent(new URL(env[Object.keys(ROLES).find(key => ROLES[key] === role)]).password);
  // Secrets are generated as base64url and never printed or passed in process argv.
  return `
${roles.map(role => `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password(role)}';`).join('\n')}
REVOKE ALL ON DATABASE hsbc_p1 FROM PUBLIC;
GRANT CONNECT ON DATABASE hsbc_p1 TO ${roles.join(', ')};
GRANT CREATE ON DATABASE hsbc_p1 TO hsbc_p1_migration;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA p1_guard;
CREATE TABLE p1_guard.instance (instance_id text PRIMARY KEY);
INSERT INTO p1_guard.instance VALUES ('${env.P1_INSTANCE_ID}');
GRANT USAGE ON SCHEMA p1_guard TO ${roles.join(', ')};
GRANT SELECT ON p1_guard.instance TO ${roles.join(', ')};
${['auth', 'business', 'a2a', 'checkpoint'].map(schema => `CREATE SCHEMA ${schema} AUTHORIZATION hsbc_p1_migration;`).join('\n')}
${[['auth', ['hsbc_p1_api']], ['business', ['hsbc_p1_api', 'hsbc_p1_worker']], ['a2a', ['hsbc_p1_api', 'hsbc_p1_worker']], ['checkpoint', ['hsbc_p1_checkpoint']]].map(([schema, allowed]) => `
GRANT USAGE ON SCHEMA ${schema} TO ${allowed.join(', ')};
ALTER DEFAULT PRIVILEGES FOR ROLE hsbc_p1_migration IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${allowed.join(', ')};
ALTER DEFAULT PRIVILEGES FOR ROLE hsbc_p1_migration IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${allowed.join(', ')};
ALTER DEFAULT PRIVILEGES FOR ROLE hsbc_p1_migration IN SCHEMA ${schema} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`).join('\n')}
ALTER ROLE hsbc_p1_api IN DATABASE hsbc_p1 SET search_path = business, auth, a2a;
ALTER ROLE hsbc_p1_worker IN DATABASE hsbc_p1 SET search_path = business, a2a;
ALTER ROLE hsbc_p1_checkpoint IN DATABASE hsbc_p1 SET search_path = checkpoint;
ALTER ROLE hsbc_p1_migration IN DATABASE hsbc_p1 SET search_path = business;
`;
}

function init() {
  versions(); safePaths();
  if (existsSync(ENVFILE) || existsSync(MARKER)) {
    const existingEnv = loadP1Environment();
    if (!existsSync(join(PGDATA, 'PG_VERSION'))) {
      if (existsSync(PGDATA)) throw new Error('P1 init incomplete; preserve the partial cluster and inspect before retrying');
      initCluster(existingEnv);
    }
    if (!existsSync(join(PGDATA, 'postgresql.auto.conf')) || !existsSync(join(REDISDIR, 'redis.conf'))) {
      throw new Error('P1 service configuration incomplete; preserve the cluster and inspect before retrying');
    }
    console.log('P1 environment already initialized; credentials preserved.'); return;
  }
  if (existsSync(LOCAL)) throw new Error('Unmarked P1 directory exists; refusing to reuse it');
  const selectedPorts = PATHS.instanceName ? requestedPorts() : {postgresPort:25433,redisPort:26380};
  const application = applicationPorts(PATHS.instanceName ? process.env : {});
  if ([selectedPorts.postgresPort, selectedPorts.redisPort].some(port => [application.P1_PORT, new URL(application.P1_ORIGIN).port].includes(String(port)))) throw new Error('Invalid P1 application ports');
  mkdirSync(LOCAL, { recursive: true, mode: 0o700 });
  mkdirSync(REDISDIR, { mode: 0o700 });
  const instanceId = randomUUID();
  const secret = () => randomBytes(32).toString('base64url');
  const passwords = Object.fromEntries([...new Set(Object.values(ROLES))].map(role => [role, secret()]));
  const env = { P1_ENV: 'p1-native', P1_MODE: 'local', P1_INSTANCE_ID: instanceId, P1_PROJECT_ROOT: ROOT, ...application, P1_HOST: '127.0.0.1', P1_TRUST_PROXY: '' };
  if(PATHS.instanceName)env.P1_NATIVE_INSTANCE=PATHS.instanceName;
  for (const [key, role] of Object.entries(ROLES)) env[key] = `postgresql://${role}:${passwords[role]}@127.0.0.1:${selectedPorts.postgresPort}/hsbc_p1`;
  env.P1_REDIS_URL = `redis://default:${secret()}@127.0.0.1:${selectedPorts.redisPort}/0`;
  env.P1_SESSION_SECRET = secret();
  privateWrite(MARKER, JSON.stringify({ kind: PATHS.instanceName?'hsbc-p1-native-v2':'hsbc-p1-native-v1', projectRoot: ROOT, instanceId, ...(PATHS.instanceName?{instanceName:PATHS.instanceName,localDir:LOCAL,...selectedPorts}:{}) }, null, 2));
  privateWrite(ENVFILE, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  privateWrite(join(LOCAL, 'admin-password'), secret() + '\n');
  initCluster(env);
  console.log('Initialized isolated P1 environment; credentials saved with mode 600.');
}

function initCluster(env) {
  run(join(PG, 'initdb'), ['-D', PGDATA, '-U', 'hsbc_p1_admin', '--pwfile', join(LOCAL, 'admin-password'), '--auth-local=scram-sha-256', '--auth-host=scram-sha-256', '--encoding=UTF8', '--locale=C']);
  privateWrite(join(PGDATA, 'postgresql.auto.conf'), `listen_addresses = '127.0.0.1'\nport = ${ports().postgresPort}\nunix_socket_directories = ''\npassword_encryption = 'scram-sha-256'\nlog_statement = 'none'\nlog_min_error_statement = 'panic'\n`);
  const quoted = value => JSON.stringify(value);
  privateWrite(join(REDISDIR, 'redis.conf'), `bind 127.0.0.1\nport ${ports().redisPort}\nprotected-mode yes\nrequirepass ${new URL(env.P1_REDIS_URL).password}\ndaemonize yes\npidfile ${quoted(join(REDISDIR, 'redis.pid'))}\nlogfile ${quoted(join(REDISDIR, 'redis.log'))}\ndir ${quoted(REDISDIR)}\nappendonly yes\nappendfsync everysec\nmaxmemory-policy noeviction\n`);
}

async function start() {
  init();
  const env = loadP1Environment();
  if (await occupied(ports().postgresPort)) verifyPostgres(env, false);
  else run(join(PG, 'pg_ctl'), ['-D', PGDATA, '-l', join(LOCAL, 'postgres.log'), '-w', 'start']);
  const exists = adminSql("SELECT 1 FROM pg_database WHERE datname='hsbc_p1';", 'postgres') === '1';
  if (!exists) {
    adminSql('CREATE DATABASE hsbc_p1;', 'postgres');
    adminSql(`BEGIN;\n${bootstrapSql(env)}\nCOMMIT;`);
  }
  verifyPostgres(env);
  // Migrations (including PostgresSaver.setup) use CREATE SCHEMA IF NOT EXISTS;
  // PostgreSQL requires database CREATE even when the schema already exists.
  adminSql('GRANT CREATE ON DATABASE hsbc_p1 TO hsbc_p1_migration;');
  if (await occupied(ports().redisPort)) verifyRedis(env);
  else {
    run(REDIS, [join(REDISDIR, 'redis.conf')]);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { ready = redisCommand(env, ['PING']) === 'PONG'; } catch { /* Startup race; bounded retry only. */ }
      if (ready) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    if (!ready) throw new Error('P1 Redis did not become ready');
    const existingMarker = redisCommand(env, ['GET', 'p1:instance']);
    if (existingMarker && existingMarker !== env.P1_INSTANCE_ID) throw new Error('Redis persisted marker mismatch');
    redisCommand(env, ['SET', 'p1:instance', env.P1_INSTANCE_ID]);
    verifyRedis(env);
  }
  console.log(`P1 ready: PostgreSQL 127.0.0.1:${ports().postgresPort}/hsbc_p1; Redis 127.0.0.1:${ports().redisPort}/0.`);
}

async function status() {
  const env = loadP1Environment();
  const result = { postgres: 'stopped', redis: 'stopped' };
  if (await occupied(ports().postgresPort)) { verifyPostgres(env); result.postgres = 'running-owned'; }
  if (await occupied(ports().redisPort)) { verifyRedis(env); result.redis = 'running-owned'; }
  console.log(JSON.stringify(result));
}

async function stop() {
  const env = loadP1Environment();
  // Verify all active targets before issuing either stop operation.
  const pgUp = await occupied(ports().postgresPort), redisUp = await occupied(ports().redisPort);
  if (pgUp) verifyPostgres(env);
  if (redisUp) verifyRedis(env);
  if (redisUp) redisCommand(env, ['SHUTDOWN', 'SAVE']);
  if (pgUp) run(join(PG, 'pg_ctl'), ['-D', PGDATA, '-m', 'fast', '-w', 'stop']);
  console.log('Stopped only the verified P1 services; data preserved.');
}

async function doctor() {
  const version = versions();
  const env = loadP1Environment();
  verifyPostgres(env); verifyRedis(env);
  const worker = roleSql(env.P1_WORKER_DATABASE_URL, "SELECT has_schema_privilege(current_user, 'auth', 'USAGE'), has_schema_privilege(current_user, 'business', 'CREATE'), rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user;");
  if (worker !== 'f|f|f|f|f') throw new Error('Worker privileges exceed the P1 boundary');
  const redisSettings = redisCommand(env, ['CONFIG', 'GET', 'appendonly', 'maxmemory-policy']);
  if (!redisSettings.includes('noeviction') || !redisSettings.includes('yes')) throw new Error('Redis durability configuration mismatch');
  console.log(JSON.stringify({ status: 'passed', versions: version, marker: 'verified', workerAuthAccess: 'denied', redisAof: true, redisPolicy: 'noeviction' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const commands = { init, start, stop, status, doctor };
    if (!Object.hasOwn(commands, process.argv[2]) || process.argv.length !== 3) throw new Error('Usage: p1-native.mjs init|start|stop|status|doctor');
    await commands[process.argv[2]]();
  } catch (error) {
    console.error(`P1: ${error.message}`);
    process.exitCode = 1;
  }
}
