#!/usr/bin/env python3
"""APP-only synthetic persistence/restore checks; never touches business rows."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

BASE = Path('/data/hsbc')
COMPOSE = [str(BASE / 'scripts/compose.sh')]


def run(args, data=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=180)
    if result.returncode:
        # Command arguments and server diagnostics can contain credentials: omit both.
        raise RuntimeError('Verification subprocess failed')
    return result.stdout.strip()


def sql(statement, database='hsbc'):
    return run(COMPOSE + ['exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
        '-At', '-U', 'hsbc_admin', '-d', database], statement)


def redis(*arguments, authenticated=True):
    if authenticated:
        return run(COMPOSE + ['exec', '-T', 'redis', 'sh', '-ec',
            'export REDISCLI_AUTH="$(cat /run/secrets/redis_password)"; exec redis-cli --raw --user hsbc "$@"',
            'probe', *arguments])
    return run(COMPOSE + ['exec', '-T', 'redis', 'redis-cli', '--raw', *arguments])


def verify():
    run(['mountpoint', '-q', '/data'])
    token = uuid.uuid4().hex
    database = 'infra_probe_' + token
    restored = 'infra_restore_' + token
    key = 'infra:probe:' + token
    dump = BASE / 'tmp' / (database + '.dump')
    report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'checks': {}}
    checks = report['checks']
    try:
        sql(f'CREATE DATABASE {database};')
        sql(f"CREATE TABLE probe (id text PRIMARY KEY); INSERT INTO probe VALUES ('{token}');", database)
        assert redis('SET', key, token, 'EX', '3600') == 'OK'
        # Credential rejection and privileges are distinct from process liveness.
        assert 'NOAUTH' in redis('PING', authenticated=False)
        assert 'NOPERM' in redis('CONFIG', 'GET', '*')
        checks['redis_auth_and_admin_denial'] = True
        grants = sql("SELECT has_schema_privilege('hsbc_app','business','USAGE'), "
            "has_schema_privilege('hsbc_app','checkpoint','USAGE'), "
            "has_schema_privilege('hsbc_checkpoint','checkpoint','USAGE'), "
            "has_schema_privilege('hsbc_checkpoint','business','USAGE'), "
            "has_schema_privilege('hsbc_app','business','CREATE');")
        assert grants == 't|f|t|f|f', grants
        checks['postgres_schema_separation'] = True
        # Restart after at least one AOF fsync via an explicit synchronous barrier.
        assert redis('WAITAOF', '1', '0', '5000').splitlines()[0] == '1'
        run(COMPOSE + ['up', '-d', '--no-deps', '--force-recreate', '--wait', 'postgres', 'redis'])
        assert sql('SELECT id FROM probe;', database) == token
        assert redis('GET', key) == token
        checks['postgres_and_redis_recreate_persistence'] = True
        with dump.open('wb') as output:
            subprocess.run(COMPOSE + ['exec', '-T', 'postgres', 'pg_dump', '-U', 'hsbc_admin',
                '-d', database, '-Fc'], stdout=output, stderr=subprocess.DEVNULL, check=True, timeout=60)
        sql(f'CREATE DATABASE {restored};')
        with dump.open('rb') as source:
            subprocess.run(COMPOSE + ['exec', '-T', 'postgres', 'pg_restore', '--exit-on-error',
                '-U', 'hsbc_admin', '-d', restored], stdin=source, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, check=True, timeout=60)
        assert sql('SELECT id FROM probe;', restored) == token
        checks['synthetic_database_dump_restore'] = True
        for service in ['postgres', 'redis', 'opa']:
            cid = run(COMPOSE + ['ps', '-q', service])
            info = json.loads(run(['docker', 'inspect', cid]))[0]
            assert not info['HostConfig']['PortBindings'], service
        checks['no_host_database_or_opa_ports'] = True
        # Mount guard tested in an isolated namespace; the real /data stays mounted.
        guard = subprocess.run(['unshare', '--mount', 'sh', '-ec',
            'mount --make-rprivate /; umount -l /data; test -z "$(findmnt -n -M /data)"; '
            'if /usr/bin/mountpoint -q /data; then exit 1; fi'], capture_output=True, timeout=10)
        assert guard.returncode == 0
        checks['missing_data_mount_guard'] = True
        report['ok'] = True
        path = BASE / 'run/data-verification.json'
        path.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))
    finally:
        # Exact random names only; never remove other databases, keys, or backups.
        sql(f'DROP DATABASE IF EXISTS {restored};')
        sql(f'DROP DATABASE IF EXISTS {database};')
        redis('DEL', key)
        dump.unlink(missing_ok=True)


if __name__ == '__main__':
    verify()
