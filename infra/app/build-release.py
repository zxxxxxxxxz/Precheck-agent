#!/usr/bin/env python3
"""Record a build and retain previous compiled outputs; never activate services."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile

BASE = Path('/data/hsbc')


def source_record(base):
    app = base / 'app'
    manager = json.loads((app / 'package.json').read_text()).get('packageManager', '')
    if not re.fullmatch(r'pnpm@\d+\.\d+\.\d+(?:\+sha(?:224|256|384|512)\.[a-fA-F0-9]+)?', manager):
        raise RuntimeError('package.json must pin a stable, exact pnpm version in packageManager')
    def git(*arguments):
        return subprocess.check_output(['git', '-c', 'safe.directory=' + str(app), '-C', str(app), *arguments], text=True).strip()
    if git('status', '--porcelain', '--untracked-files=normal'):
        raise RuntimeError('Commit application source changes before building; ignore generated outputs in Git')
    lock = json.loads((base / 'deploy/versions.lock.json').read_text())
    return {'commit': git('rev-parse', 'HEAD'), 'package_manager': manager,
            'lockfile_sha256': hashlib.sha256((app / 'pnpm-lock.yaml').read_bytes()).hexdigest(),
            'node_image': lock['images']['NODE_IMAGE']['reference']}


def prepare(base, backup_runner=subprocess.check_output):
    os.umask(0o077)
    record = source_record(base)
    # Save both the database/policies and previous compiled application outputs.
    database_backup = backup_runner([sys.executable, str(base / 'scripts/backup.py')], text=True).strip()
    release = Path(tempfile.mkdtemp(prefix='app-build-', dir=base / 'backups'))
    (release / 'versions.before.json').write_bytes((base / 'deploy/versions.lock.json').read_bytes())
    with tarfile.open(release / 'previous-outputs.tar.gz', 'w:gz') as archive:
        for folder in ('apps', 'packages'):
            for directory, children, _ in os.walk(base / 'app' / folder):
                children[:] = [name for name in children if name not in ('.git', 'node_modules')]
                if 'dist' in children:
                    output = Path(directory) / 'dist'
                    archive.add(output, arcname=str(output.relative_to(base / 'app')))
                    children.remove('dist')
    record.update(status='prepared', prepared_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  database_backup=database_backup)
    (release / 'build.json').write_text(json.dumps(record, indent=2) + '\n')
    return release


def complete(base, release):
    release = Path(release).resolve(strict=True)
    if release.parent != (base / 'backups').resolve() or not release.name.startswith('app-build-'):
        raise RuntimeError('Invalid build record path')
    record = json.loads((release / 'build.json').read_text())
    if record['status'] != 'prepared' or any(record.get(key) != value for key, value in source_record(base).items()):
        raise RuntimeError('Application source, lockfile, or Node image changed during build')
    record.update(status='built_not_activated', built_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  previous_outputs=str(release / 'previous-outputs.tar.gz'))
    (release / 'build.json').write_text(json.dumps(record, indent=2) + '\n')
    versions = base / 'deploy/versions.lock.json'
    data = json.loads(versions.read_text())
    data['application'] = record
    temporary = versions.with_name('.versions.app-build.json')
    temporary.write_text(json.dumps(data, indent=2) + '\n')
    os.replace(temporary, versions)


if __name__ == '__main__':
    subprocess.run(['mountpoint', '-q', '/data'], check=True)
    if sys.argv[1:] == ['prepare']:
        print(prepare(BASE))
    elif len(sys.argv) == 3 and sys.argv[1] == 'complete':
        complete(BASE, Path(sys.argv[2]))
    else:
        raise SystemExit('Usage: build-release.py prepare | complete BUILD_RECORD_DIRECTORY')
