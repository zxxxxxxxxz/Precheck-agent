#!/usr/bin/env python3
"""Explicit one-time P1 DB-role/environment provisioning; no migration or account seed."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import uuid
from urllib.parse import quote

BASE = Path('/data/hsbc')
ROLES = ('api', 'worker', 'checkpoint', 'migration')
SCHEMAS = {'auth': ('api',), 'business': ('api', 'worker'), 'a2a': ('api', 'worker'), 'checkpoint': ('checkpoint',)}


def parse_env(contents):
    values = {}
    for line in contents.splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        match = re.fullmatch(r'([A-Z][A-Z0-9_]*)=(.*)', line)
        if not match or match[1] in values:
            raise ValueError('Malformed or duplicate environment entry')
        values[match[1]] = match[2]
    return values


def write_private(path, data):
    if path.is_symlink():
        raise RuntimeError('Secret file cannot be a symbolic link')
    with path.open('x') as stream:
        os.chmod(path, 0o600)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def role_sql(passwords, database='hsbc'):
    if database not in ('hsbc', 'hsbc_p1') or set(passwords) != set(ROLES):
        raise ValueError('Invalid P1 role configuration')
    if any(not re.fullmatch(r'[A-Za-z0-9_-]{32,}', value) for value in passwords.values()):
        raise ValueError('P1 credentials must be generated base64url secrets')
    sql = ['BEGIN;']
    for role, password in passwords.items():
        name = 'hsbc_p1_' + role
        sql += [f"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='{name}') THEN CREATE ROLE {name}; END IF; END $$;",
                f"ALTER ROLE {name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD '{password}';",
                f'GRANT CONNECT ON DATABASE {database} TO {name};']
    sql += [f'GRANT CREATE ON DATABASE {database} TO hsbc_p1_migration;', 'REVOKE CREATE ON SCHEMA public FROM PUBLIC;']
    # Existing legacy objects keep their owner and grants. Only P1 migration-created objects
    # receive P1 default privileges; no GRANT ON ALL TABLES includes P0/legacy relations.
    for schema, roles in SCHEMAS.items():
        names = ', '.join('hsbc_p1_' + r for r in roles)
        sql += [f'CREATE SCHEMA IF NOT EXISTS {schema} AUTHORIZATION hsbc_p1_migration;',
                f'ALTER SCHEMA {schema} OWNER TO hsbc_p1_migration;',
                f'REVOKE ALL ON SCHEMA {schema} FROM PUBLIC;',
                f'GRANT USAGE ON SCHEMA {schema} TO {names};',
                f'ALTER DEFAULT PRIVILEGES FOR ROLE hsbc_p1_migration IN SCHEMA {schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {names};',
                f'ALTER DEFAULT PRIVILEGES FOR ROLE hsbc_p1_migration IN SCHEMA {schema} GRANT USAGE, SELECT ON SEQUENCES TO {names};',
                f'ALTER DEFAULT PRIVILEGES FOR ROLE hsbc_p1_migration IN SCHEMA {schema} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;']
        for role in ROLES:
            if role not in roles and role != 'migration':
                sql += [f'REVOKE ALL ON SCHEMA {schema} FROM hsbc_p1_{role};']
    for role, search_path in [('api', 'business,auth,a2a'), ('worker', 'business,a2a'), ('checkpoint', 'checkpoint'), ('migration', 'business')]:
        sql += [f'ALTER ROLE hsbc_p1_{role} IN DATABASE {database} SET search_path={search_path};']
    sql += ['COMMIT;']
    return '\n'.join(sql)


def configure(base=BASE):
    os.umask(0o077)
    subprocess.run(['mountpoint', '-q', '/data'], check=True)
    with (base / 'run/p1-release.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state_file = base / 'secrets/p1-credentials.json'
        if state_file.is_symlink():
            raise RuntimeError('P1 credentials cannot be a symlink')
        if not state_file.exists():
            state = {'format': 'hsbc-p1-credentials-v1', 'instance_id': str(uuid.uuid4()),
                     'passwords': {name: secrets.token_urlsafe(32) for name in ROLES},
                     'session_secret': secrets.token_urlsafe(48)}
            write_private(state_file, json.dumps(state) + '\n')
        state = json.loads(state_file.read_text())
        if state['format'] != 'hsbc-p1-credentials-v1' or (state_file.stat().st_mode & 0o077):
            raise RuntimeError('Invalid credentials format or permissions')
        # Schema ownership/role changes require a completed pre-change backup too.
        backup_run = subprocess.run(['python3', str(base / 'scripts/backup.py')], text=True, capture_output=True)
        if backup_run.returncode:
            raise RuntimeError('Pre-provision backup failed')
        backup_dir = Path(backup_run.stdout.strip())
        if backup_dir.parent != base / 'backups' or not (backup_dir / 'complete.json').is_file():
            raise RuntimeError('Pre-provision backup incomplete')
        # psql receives generated credentials only on stdin; provider errors never printed.
        result = subprocess.run([str(base / 'scripts/compose.sh'), 'exec', '-T', 'postgres',
                                 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'hsbc_admin', '-d', 'hsbc'],
                                input=role_sql(state['passwords']), text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError('P1 role provisioning failed; secret-bearing SQL output suppressed')
        old = parse_env((base / 'secrets/app.env').read_text())
        redis_password = (base / 'secrets/redis_password').read_text().strip()
        common = {'NODE_ENV': 'production', 'P1_MODE': 'production', 'P1_INSTANCE_ID': state['instance_id'],
                  'P1_ORIGIN': 'https://hsbc.mse.pub', 'P1_REDIS_URL': f'redis://hsbc:{quote(redis_password, safe="")}@redis:6379/0',
                  'P1_HOST': '0.0.0.0', 'P1_PORT': '3000', 'P1_TRUST_PROXY': '172.30.90.1/32',
                  'P1_OSS_BUCKET': 'hsbc-poc', 'P1_OSS_REGION': 'cn-wulanchabu',
                  'P1_OSS_ENDPOINT': 'https://oss-cn-wulanchabu-internal.aliyuncs.com',
                  'P1_OSS_PUBLIC_ENDPOINT': 'https://hsbc-poc.oss-cn-wulanchabu.aliyuncs.com',
                  'P1_OSS_PREFIX': 'p1/'}
        # Keep GPU endpoints on the established internal tunnel; never consume .env.remote.
        model_keys = ('OCR_BASE_URL', 'NER_BASE_URL', 'QWEN_BASE_URL', 'OPA_BASE_URL')
        common.update({key: old[key] for key in model_keys if key in old})
        urls = {name: f'postgresql://hsbc_p1_{name}:{password}@postgres:5432/hsbc' for name, password in state['passwords'].items()}
        scopes = {
            'api': {'P1_DATABASE_URL': urls['api'], 'P1_SESSION_SECRET': state['session_secret']},
            'worker': {'P1_WORKER_DATABASE_URL': urls['worker'], 'P1_CHECKPOINT_DATABASE_URL': urls['checkpoint']},
            'migration': {'P1_MIGRATION_DATABASE_URL': urls['migration']},
        }
        for name, scope in scopes.items():
            path = base / f'secrets/p1-{name}.env'
            if not path.exists():
                values = common | scope
                write_private(path, ''.join(f'{key}={value}\n' for key, value in values.items()))
                # Runtime UID must read only its mounted role-specific file; the directory stays private.
                if name != 'migration':
                    os.chown(path, 10001, 10001)
        print(json.dumps({'status': 'configured', 'roles': ['hsbc_p1_' + r for r in ROLES],
                          'schemas': list(SCHEMAS), 'env_files': [f'p1-{name}.env' for name in scopes],
                          'migration_executed': False, 'accounts_seeded': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        configure()
    except Exception:
        raise SystemExit('P1 configuration failed; secret values and SQL omitted')
