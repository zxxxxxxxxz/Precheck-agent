#!/usr/bin/env python3
"""P1 host-side release phases. Never migrates, seeds or installs at container startup."""
import argparse
import datetime
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time
import urllib.request

BASE = Path('/data/hsbc')
RELEASE_ID = re.compile(r'[a-f0-9]{40}')
ARTIFACTS = ('apps/api/dist/p1.js', 'apps/worker/dist/p1.js', 'apps/web/dist/index.html',
             'packages/server/dist/p2/engine-thread.js')
INTAKE_V2_ARTIFACTS = ('packages/server/dist/p3/draft-attachment-thread.js',)
DOMAIN_ARTIFACTS = ('apps/api/dist/application.js', 'apps/api/dist/p1.js',
                    'apps/worker/dist/application.js', 'apps/worker/dist/p1.js',
                    'apps/web/dist/index.html',
                    'packages/server/dist/modules/documents/engine/thread.js')
DOMAIN_INTAKE_ARTIFACTS = ('packages/server/dist/modules/materials/draft-attachments/thread.js',)
MIGRATION_DIRECTORIES = {
    1: 'packages/server/src/p1/migrations',
    2: 'packages/server/src/infrastructure/database/migrations',
}


def run(args, **kwargs):
    # Tool stdout/stderr can contain database URLs, provider exceptions, or credential SQL.
    # Do not forward it. Operators get a stable command label only.
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=kwargs.pop('timeout', 120), **kwargs)
    if result.returncode:
        raise RuntimeError(f'{Path(args[0]).name} failed with exit {result.returncode}; output suppressed')
    return result.stdout


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, data):
    temporary = path.with_name('.' + path.name + '.new')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    os.replace(temporary, path)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def release_path(base, release_id):
    if not RELEASE_ID.fullmatch(release_id):
        raise ValueError('Release ID must be a full 40-character commit')
    root = base / 'releases'
    release = root / release_id
    if release.is_symlink() or (release.exists() and release.resolve().parent != root.resolve()):
        raise ValueError('Release escapes the managed releases directory')
    return release


def record(base, release_id, verify=True):
    release = release_path(base, release_id)
    data = json.loads((release / 'release.json').read_text())
    if data.get('commit') != release_id or data.get('format') != 'hsbc-p1-release-v1':
        raise ValueError('Invalid P1 release record')
    if verify:
        source = release / 'source'
        if data.get('source_storage_path') and str(source.resolve()) != data['source_storage_path']:
            raise RuntimeError('Release source storage target changed after build')
        if sha(source / 'pnpm-lock.yaml') != data['lockfile_sha256']:
            raise RuntimeError('Release lockfile changed after build')
        if data.get('authorization_version', 1) > 1 and not data.get('runtime_compatibility_sha256'):
            raise RuntimeError('Release authorization compatibility was not pinned at build')
        if data.get('runtime_compatibility_sha256'):
            compatibility = source / 'infra/app/runtime-compatibility.json'
            if not compatibility.is_file() or sha(compatibility) != data['runtime_compatibility_sha256']:
                raise RuntimeError('Release authorization compatibility changed after build')
        # Select paths only after verifying this immutable release's declaration.
        if source_authorization(source) != data.get('authorization_version', 1):
            raise RuntimeError('Release authorization declaration does not match its record')
        layout = source_layout(source)
        if layout > 1 and not data.get('runtime_compatibility_sha256'):
            raise RuntimeError('Release server layout compatibility was not pinned at build')
        if (data.get('authorization_version', 1) >= 2 or layout > 1) and any(name not in data['artifacts'] for name in required_artifacts(source)):
            raise RuntimeError('Release record is missing a required build artifact')
        if data.get('authorization_version', 1) >= 4 and any(name not in data['artifacts'] for name in p3_release_inputs(source)):
            raise RuntimeError('P3 release record is missing a required migration or configuration hash')
        for name, digest in data['artifacts'].items():
            path = source / name
            if not path.resolve().is_relative_to(source.resolve()) or sha(path) != digest:
                raise RuntimeError('Release artifact checksum mismatch')
    return release, data


def source_authorization(source):
    declaration = source / 'infra/app/runtime-compatibility.json'
    if not declaration.exists():
        return 1
    data = json.loads(declaration.read_text())
    version = data.get('authorizationVersion')
    if data.get('schemaVersion') != 1 or type(version) is not int or not 1 <= version <= 100:
        raise RuntimeError('Invalid runtime authorization compatibility declaration')
    return version


def source_layout(source):
    """Missing layout metadata means the original immutable release layout."""
    declaration = source / 'infra/app/runtime-compatibility.json'
    if not declaration.exists():
        return 1
    data = json.loads(declaration.read_text())
    version = data.get('serverLayoutVersion', 1)
    if data.get('schemaVersion') != 1 or type(version) is not int or version not in MIGRATION_DIRECTORIES:
        raise RuntimeError('Unsupported server layout compatibility declaration')
    return version


def migration_directory(source):
    return MIGRATION_DIRECTORIES[source_layout(source)]


def authorization_floor(base):
    path = base / 'run/p1-authorization-floor.json'
    if not path.exists():
        return 1
    value = json.loads(path.read_text()).get('authorization_version')
    if type(value) is not int or not 1 <= value <= 100:
        raise RuntimeError('Invalid installed authorization compatibility floor')
    return value


def require_compatible_authorization(base, data):
    # Legacy release records have P1 semantics even if the database is additive.
    version = data.get('authorization_version', 1)
    if type(version) is not int or version < authorization_floor(base):
        raise RuntimeError('Release authorization semantics are older than the installed database; keep maintenance and fix forward')
    return version


def image(base):
    reference = json.loads((base / 'deploy/versions.lock.json').read_text())['images']['NODE_IMAGE']['reference']
    if not re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}', reference):
        raise RuntimeError('An immutable Node image digest is required')
    return reference


def p3_release_inputs(source):
    names = ['scripts/p1-migrate.ts', 'scripts/p3-config-parity.mjs', 'infra/app/p3.env.example']
    version = source_authorization(source)
    required_version = 60 if version >= 25 else 59 if version >= 24 else 51 if version >= 18 else 47 if version >= 17 else 43 if version >= 15 else 42 if version >= 14 else 41 if version >= 13 else 39 if version >= 11 else 35 if version >= 9 else 34 if version >= 7 else 32 if version >= 6 else 30 if version >= 5 else 21
    migrations = sorted((source / migration_directory(source)).glob('*.sql'))
    versions = [int(file.name[:3]) for file in migrations if re.fullmatch(r'\d{3}_.+\.sql', file.name)]
    expected = list(range(1, max(versions or [0]) + 1))
    # 033 belongs to unfinished work retained on a separate branch. Only this
    # reserved gap is accepted; every delivered migration remains hash pinned.
    if version >= 7 and 33 not in versions and 33 in expected:
        expected.remove(33)
    # The migration ledger keys full filenames. V17 combines independently shipped
    # 042/043 files without renaming or changing any historical migration.
    sequence = sorted(set(versions)) if version >= 17 else versions
    if len(versions) != len(migrations) or sequence != expected or max(versions or [0]) < required_version:
        raise RuntimeError('P3 release requires a complete, unique migration sequence through ' + str(required_version).zfill(3))
    if version >= 17:
        required_names = {'041_document_processing_access.sql', '042_processing_approval_inbox.sql',
                          '043_document_parse_recovery.sql', '044_document_translation.sql',
                          '042_review_rounds.sql', '043_case_pre_review_closure.sql',
                          '045_review_delivery.sql', '046_review_analysis.sql',
                          '047_reference_translation_permission.sql'}
        if not required_names.issubset({file.name for file in migrations}):
            raise RuntimeError('V17 release is missing a required full migration filename')
    if version >= 18:
        required_formal = {'048_checker_review.sql', '049_checker_termination.sql', '050_formal_review.sql', '051_formal_review_history.sql'}
        if not required_formal.issubset({file.name for file in migrations}):
            raise RuntimeError('V18 release is missing a required Checker/formal migration')
    if version >= 24:
        required_round_confirmation = {'054_required_independent_review.sql', '054_round_result_confirmation.sql',
                                       '055_legacy_round_correction.sql', '056_checker_round_correction.sql',
                                       '057_mandatory_checker.sql', '058_checker_direct_correction.sql',
                                       '059_checker_worker_fence.sql'}
        if not required_round_confirmation.issubset({file.name for file in migrations}):
            raise RuntimeError('V24 release is missing a required round confirmation migration')
    if version >= 25 and '060_fixed_review_teams.sql' not in {file.name for file in migrations}:
        raise RuntimeError('V25 release is missing the fixed review team migration')
    if required_version >= 28:
        names += ['infra/app/verify-backup.py', 'infra/opa/review/prepare.py']
    names += [str(file.relative_to(source)) for file in migrations]
    if any(not (source / name).is_file() for name in names):
        raise RuntimeError('P3 release is missing a required migration or configuration input')
    return names


def verify_model_configuration(base, release, data):
    if data.get('authorization_version', 1) < 4:
        return
    # Parse the two role-specific files with the same Node runtime. Output is a fixed status only.
    run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop=ALL', '--user', '10001:10001',
         '--security-opt=no-new-privileges', '-v', str(release / 'source') + ':/app:ro',
         '-v', str(base / 'secrets/p1-api.env') + ':/run/secrets/api.env:ro',
         '-v', str(base / 'secrets/p1-worker.env') + ':/run/secrets/worker.env:ro', data['node_image'],
         'node', '/app/scripts/p3-config-parity.mjs', '/run/secrets/api.env', '/run/secrets/worker.env'])


def required_artifacts(source):
    # Keep earlier immutable release records inspectable. Only v6 and later
    # promise the isolated draft-attachment parser introduced by migration 031.
    if source_layout(source) == 2:
        return DOMAIN_ARTIFACTS + (DOMAIN_INTAKE_ARTIFACTS if source_authorization(source) >= 6 else ())
    return ARTIFACTS + (INTAKE_V2_ARTIFACTS if source_authorization(source) >= 6 else ())


def artifacts(source):
    for name in required_artifacts(source):
        if not (source / name).is_file():
            raise RuntimeError(f'Missing build artifact: {name}')
    if source_layout(source) == 2:
        # New workspace packages are part of the same immutable release.
        outputs = [directory for root in ('apps', 'packages') for directory in (source / root).glob('*/dist') if directory.is_dir()]
    else:
        outputs = [source / folder for folder in ('apps/api/dist', 'apps/worker/dist', 'apps/web/dist', 'packages/server/dist')]
    files = [p for directory in outputs for p in directory.rglob('*') if p.is_file()]
    if source_authorization(source) >= 4:
        files += [source / name for name in p3_release_inputs(source)]
    return {str(p.relative_to(source)): sha(p) for p in sorted(files)}


def backup(base):
    result = run(['python3', str(base / 'scripts/backup.py')]).decode().strip()
    path = Path(result)
    if path.parent != base / 'backups' or not (path / 'complete.json').is_file():
        raise RuntimeError('Backup did not return a complete managed backup')
    return path.name


def prepare(base, ref, source_storage_root=None):
    source_repo = base / 'app'
    git = ['git', '-c', 'safe.directory=' + str(source_repo), '-C', str(source_repo)]
    if run(git + ['status', '--porcelain', '--untracked-files=normal']).strip():
        raise RuntimeError('Source repository has uncommitted changes')
    commit = run(git + ['rev-parse', '--verify', ref + '^{commit}']).decode().strip()
    release = release_path(base, commit)
    if release.exists():
        _, data = record(base, commit)
        if data['status'] not in ('prepared', 'migrated', 'active', 'superseded'):
            raise RuntimeError('Incomplete candidate exists; preserve and investigate it')
        return data
    node_image = image(base)
    release.mkdir(parents=True)
    source = release / 'source'
    if source_storage_root is None:
        source.mkdir()
    else:
        # Only the new immutable candidate uses this operator-selected volume.
        # Existing releases, caches, backup paths and business data never move.
        storage = Path(source_storage_root)
        if not storage.is_absolute() or storage.is_symlink() or not storage.is_dir() or storage.resolve() != storage:
            raise RuntimeError('Source storage requires an existing absolute non-symlink directory')
        target = storage / commit
        target.mkdir()
        source.symlink_to(target, target_is_directory=True)
    archive_bytes = run(git + ['archive', '--format=tar', commit])
    with tarfile.open(fileobj=io.BytesIO(archive_bytes)) as archive:
        for member in archive.getmembers():
            if member.name.startswith('/') or '..' in Path(member.name).parts:
                raise RuntimeError('Unsafe source archive')
        archive.extractall(source, filter='data')
    manager = json.loads((source / 'package.json').read_text()).get('packageManager', '')
    if not re.fullmatch(r'pnpm@\d+\.\d+\.\d+(?:\+sha\d+\.[a-f0-9]+)?', manager):
        raise RuntimeError('Exact pnpm packageManager pin is required')
    for folder in ('cache/corepack', 'cache/pnpm'):
        (base / folder).mkdir(parents=True, exist_ok=True)
        run(['chown', '-R', '10001:10001', str(base / folder)])
    run(['chown', '-R', '10001:10001', str(source.resolve())])
    data = {'format': 'hsbc-p1-release-v1', 'commit': commit, 'status': 'building', 'prepared_at': now(),
            'node_image': node_image, 'package_manager': manager, 'source_archive_sha256': hashlib.sha256(archive_bytes).hexdigest(),
            'lockfile_sha256': sha(source / 'pnpm-lock.yaml'), 'migration_policy': 'compatibility-floor-fenced', 'artifacts': {}}
    data['authorization_version'] = source_authorization(source)
    data['source_storage_path'] = str(source.resolve())
    source_layout(source)  # Reject unsupported source layouts before build or publication.
    declaration = source / 'infra/app/runtime-compatibility.json'
    if declaration.exists():
        data['runtime_compatibility_sha256'] = sha(declaration)
    write_json(release / 'release.json', data)
    run(['docker', 'run', '--rm', '--user', '10001:10001', '--workdir', '/app',
         '-e', 'HOME=/tmp', '-e', 'COREPACK_HOME=/cache/corepack', '-e', 'COREPACK_DEFAULT_TO_LATEST=0',
         '-e', 'COREPACK_ENABLE_PROJECT_SPEC=1', '-v', str(source) + ':/app', '-v', str(base / 'cache') + ':/cache',
         node_image, 'sh', '-eu', '-c',
         'corepack pnpm install --frozen-lockfile --store-dir /cache/pnpm && corepack pnpm typecheck && corepack pnpm build'], timeout=1800)
    if sha(source / 'pnpm-lock.yaml') != data['lockfile_sha256']:
        raise RuntimeError('Lockfile changed during build')
    data.update(status='prepared', built_at=now(), artifacts=artifacts(source))
    write_json(release / 'release.json', data)
    return data


def migrate(base, release_id):
    release, data = record(base, release_id)
    if data['status'] != 'prepared':
        raise RuntimeError('Only a prepared release can enter the explicit migration phase')
    version = require_compatible_authorization(base, data)
    verify_model_configuration(base, release, data)
    pre_migration_backup = backup(base)
    data['backup_before_migration'] = pre_migration_backup
    write_json(release / 'release.json', data)
    if version > authorization_floor(base):
        # Stop old semantics before migrating. The monotonic floor is recorded
        # before DDL; a partial migration must never re-enable old privileges.
        (base / 'run/p1-maintenance').touch()
        compose(base, 'stop', 'app-worker', 'app-api')
        write_json(base / 'run/p1-authorization-floor.json', {
            'authorization_version': version, 'migration_candidate': release_id, 'recorded_at': now()})
    run(['docker', 'run', '--rm', '--network', 'hsbc_app', '--workdir', '/app', '--read-only',
         '--tmpfs', '/tmp:rw,size=128m', '-v', str(release / 'source') + ':/app:ro',
         '-v', str(base / 'secrets/p1-migration.env') + ':/run/secrets/p1-migration.env:ro', data['node_image'],
         'node', '--env-file=/run/secrets/p1-migration.env', '--import', 'tsx', 'scripts/p1-migrate.ts'], timeout=180)
    data.update(status='migrated', migrated_at=now())
    write_json(release / 'release.json', data)
    return data


def compose(base, *args):
    return run([str(base / 'scripts/compose.sh'), *args], timeout=180)


def healthy(base, not_before=None):
    # API health asserts PG/instance readiness. Redis failure must not block the PG worker recovery loop.
    for _ in range(40):
        try:
            with urllib.request.urlopen('http://127.0.0.1:3000/api/health/ready', timeout=3) as response:
                api_ok = response.status == 200
            worker_id = compose(base, 'ps', '-q', 'app-worker').decode().strip()
            state = json.loads(run(['docker', 'inspect', worker_id]))[0]['State']
            heartbeat_sql = "SELECT EXISTS (SELECT FROM business.runtime_heartbeats WHERE name='worker' AND updated_at > now() - interval '45 seconds'"
            if not_before:
                heartbeat_sql += " AND updated_at >= '" + not_before + "'::timestamptz"
            heartbeat_sql += ');'
            heartbeat = compose(base, 'exec', '-T', 'postgres', 'psql', '-X', '-At', '-U', 'hsbc_admin', '-d', 'hsbc', '-c', heartbeat_sql).strip() == b't'
            if api_ok and heartbeat and state['Running'] and not state.get('Restarting', False):
                return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('P1 application readiness timed out')


def replace_link(target, link):
    temporary = link.with_name('.' + link.name + '.new')
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    os.replace(temporary, link)


def switch(base, release_id):
    release, data = record(base, release_id)
    require_compatible_authorization(base, data)
    if data['status'] not in ('migrated', 'active', 'superseded'):
        raise RuntimeError('Release has not passed the explicit migration phase')
    verify_model_configuration(base, release, data)
    # Same-version API/Worker/Web: public requests see maintenance during the switch.
    (base / 'run/p1-maintenance').touch()
    try:
        compose(base, 'stop', 'app-worker', 'app-api')
    except Exception:
        # First activation has no app services; a previously active release must stop cleanly.
        if (base / 'run/p1-active.json').exists():
            raise
    (base / 'deploy/p1-release.env').write_text('P1_RELEASE_DIR=' + str(release / 'source') + '\n')
    started_at = now()
    compose(base, 'up', '-d', '--no-deps', '--force-recreate', 'app-api', 'app-worker')
    healthy(base, started_at)
    for service, entry in [('app-api', 'apps/api/dist/p1.js'), ('app-worker', 'apps/worker/dist/p1.js')]:
        container_id = compose(base, 'ps', '-q', service).decode().strip()
        runtime = json.loads(run(['docker', 'inspect', container_id]))[0]
        mounts = [m for m in runtime['Mounts'] if m['Destination'] == '/app']
        if runtime['Config']['Image'] != data['node_image'] or len(mounts) != 1 or Path(mounts[0]['Source']).resolve() != (release / 'source').resolve() or entry not in runtime['Config']['Cmd']:
            raise RuntimeError('API/Worker runtime must match the candidate image, entrypoint and source')
    replace_link(release / 'source/apps/web/dist', base / 'current-web')
    # TLS timer renders the current template, so install that template alongside live configuration.
    template = release / 'source/infra/app/nginx.conf.template'
    shutil.copyfile(template, base / 'config/nginx/nginx.conf.template')
    run(['python3', str(base / 'scripts/activate-tls.py'), '/etc/ssl/certs/mse.pub/cert.pem', '/etc/ssl/certs/mse.pub/cert.key'])
    (base / 'run/p1-maintenance').unlink(missing_ok=True)
    run(['docker', 'run', '--rm', '--network', 'host', '--read-only', '-v', str(release / 'source') + ':/app:ro', data['node_image'], 'node', '/app/scripts/p1-smoke.mjs', '--origin', 'https://hsbc.mse.pub'])
    return release, data


def activate(base, release_id, rollback=False):
    release, data = record(base, release_id)
    require_compatible_authorization(base, data)
    active_file = base / 'run/p1-active.json'
    previous = json.loads(active_file.read_text()) if active_file.exists() else None
    if previous and previous['commit'] == release_id:
        verify_model_configuration(base, release, data)
        healthy(base)
        return previous
    if data['status'] not in ('migrated', 'superseded'):
        raise RuntimeError('Activation requires a migrated candidate or a previously deployed release')
    if rollback and (not previous or data.get('activated_at') is None):
        raise RuntimeError('Rollback only selects a previously activated compatible application release')
    # This record exists before mutating services so interrupted activation is explicit and recoverable.
    pending = {'target': release_id, 'previous': previous['commit'] if previous else None, 'started_at': now()}
    write_json(base / 'run/p1-pending.json', pending)
    try:
        release, data = switch(base, release_id)
    except Exception:
        if previous:
            try:
                switch(base, previous['commit'])
                write_json(base / 'run/p1-failed.json', dict(pending, restored_previous=True, failed_at=now()))
                (base / 'run/p1-pending.json').unlink(missing_ok=True)
            except Exception:
                (base / 'run/p1-maintenance').touch()
                write_json(base / 'run/p1-failed.json', dict(pending, restored_previous=False,
                    failed_at=now(), recovery='compatible_release_or_fix_forward_required'))
        else:
            # No previous business version exists. Keep maintenance; never expose mixed partial state.
            (base / 'run/p1-maintenance').touch()
        raise
    if previous:
        previous_release, previous_record = record(base, previous['commit'])
        previous_record['status'] = 'superseded'
        write_json(previous_release / 'release.json', previous_record)
    data.update(status='active', activated_at=now())
    write_json(release / 'release.json', data)
    current = {'commit': release_id, 'previous': previous['commit'] if previous else None, 'activated_at': now(), 'rollback': rollback}
    write_json(active_file, current)
    (base / 'run/p1-pending.json').unlink(missing_ok=True)
    return current


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=('prepare', 'migrate', 'activate', 'rollback', 'status'))
    parser.add_argument('ref', nargs='?')
    args = parser.parse_args()
    os.umask(0o022)
    run(['mountpoint', '-q', '/data'])
    (BASE / 'run').mkdir(exist_ok=True)
    with (BASE / 'run/p1-release.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.phase == 'status':
            out = {name: json.loads((BASE / f'run/p1-{name}.json').read_text()) if (BASE / f'run/p1-{name}.json').exists() else None for name in ('active', 'pending', 'failed')}
        elif args.phase == 'rollback':
            active = json.loads((BASE / 'run/p1-active.json').read_text())
            out = activate(BASE, args.ref or active.get('previous') or '', rollback=True)
        elif not args.ref:
            parser.error('A commit/ref or full release ID is required for this phase')
        elif args.phase == 'prepare':
            out = prepare(BASE, args.ref)
        elif args.phase == 'migrate':
            out = migrate(BASE, args.ref)
        else:
            out = activate(BASE, args.ref)
        print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # All internal runner failures are sanitized, but arbitrary I/O exception paths may not be.
        raise SystemExit('P1 release operation failed; inspect phase records, credentials and raw output omitted') from None
