#!/usr/bin/env python3
"""Consistent local PG/policy backup. OSS upload requires separate credentials."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def create_backup(base, runner=subprocess.run):
    """Keep a failed partial directory for investigation; never mark it complete."""
    base = Path(base)
    os.umask(0o077)
    (base / 'run').mkdir(parents=True, exist_ok=True)
    (base / 'backups').mkdir(mode=0o700, parents=True, exist_ok=True)
    # The lock is shared with OPA publication, covering both dumps and config.
    with (base / 'run/backup.lock').open('w') as backup_lock, \
            (base / 'run/opa-publish.lock').open('w') as opa_lock:
        fcntl.flock(backup_lock, fcntl.LOCK_EX)
        fcntl.flock(opa_lock, fcntl.LOCK_EX)
        if (base / 'config/opa/pending-activation.json').exists():
            raise RuntimeError('Recover interrupted OPA activation before taking a backup')
        required = ['policies/releases', 'config/opa', 'config/opa/approved.json',
                    'deploy/versions.lock.json', 'deploy/compose.yaml', 'deploy/compose.opa-loads.json']
        version_record = json.loads((base / 'deploy/versions.lock.json').read_text())
        related_locks = []
        for name in version_record.get('related_model_locks', {}).values():
            if Path(name).name != name or not name.endswith('.lock.json'):
                raise RuntimeError('Invalid related model lock path')
            related_locks.append('deploy/' + name)
        required += related_locks
        p1_files = []
        if (base / 'run/p1-active.json').exists():
            active = json.loads((base / 'run/p1-active.json').read_text())
            import re
            if not re.fullmatch(r'[a-f0-9]{40}', active.get('commit', '')):
                raise RuntimeError('Invalid active P1 release identity')
            p1_files = ['deploy/compose.p1.yaml', 'deploy/p1-release.env', 'run/p1-active.json',
                        'config/nginx/nginx.conf.template', 'releases/' + active['commit'] + '/release.json']
            required += p1_files
        if (base / 'run/p1-authorization-floor.json').exists():
            p1_files.append('run/p1-authorization-floor.json')
            required.append('run/p1-authorization-floor.json')
        for name in required:
            if not (base / name).exists():
                raise RuntimeError(f'Required backup input missing: {name}')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        out = Path(tempfile.mkdtemp(prefix=f'.partial-{stamp}-', dir=base / 'backups'))
        compose = [str(base / 'scripts/compose.sh'), 'exec', '-T', 'postgres']
        for filename, command in (
            ('database.dump', ['pg_dump', '-U', 'hsbc_admin', '-d', 'hsbc', '-Fc']),
            ('roles.sql', ['pg_dumpall', '-U', 'hsbc_admin', '--roles-only']),
        ):
            with (out / filename).open('wb') as stream:
                runner(compose + command, stdout=stream, check=True)
                stream.flush()
                os.fsync(stream.fileno())
            if (out / filename).stat().st_size == 0:
                raise RuntimeError(f'Dump produced an empty file: {filename}')
        with tarfile.open(out / 'policies-and-deployment.tar.gz', 'w:gz') as archive:
            for name in ['policies', 'config/opa', 'deploy/versions.lock.json',
                         'deploy/compose.yaml', 'deploy/compose.opa-loads.json', *related_locks, *p1_files]:
                archive.add(base / name, arcname=name)
        manifest = {p.name: file_sha256(p) for p in out.iterdir() if p.is_file()}
        (out / 'sha256.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (out / 'complete.json').write_text(json.dumps({
            'format': 'hsbc-backup-v1', 'completed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'manifest_sha256': file_sha256(out / 'sha256.json'),
            'scope': ['postgres_database', 'postgres_roles', 'immutable_policies', 'opa_and_compose_configuration'],
            # pg_dump is intentionally unfiltered. This documents coverage without
            # claiming that an older database already contains these tables.
            'postgres_scope_when_present': ['private_case_drafts_and_creation_receipts',
                'intake_turns_candidates_events_and_text_mappings', 'model_calls_and_egress_receipts',
                'model_budgets_session_fences_and_fixture_grants'],
            'oss_uploaded': False, 'restore_verified': False,
        }, indent=2) + '\n')
        for path in out.iterdir():
            with path.open('rb') as stream:
                os.fsync(stream.fileno())
        final = out.with_name(out.name.removeprefix('.partial-'))
        os.rename(out, final)
        directory_fd = os.open(final.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return final


if __name__ == '__main__':
    subprocess.run(['mountpoint', '-q', '/data'], check=True)
    print(create_backup(Path('/data/hsbc')))
