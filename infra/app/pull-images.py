#!/usr/bin/env python3
"""Run on APP; lock the image content actually pulled. Does not invent ACR URLs."""
import datetime
import json
import os
from pathlib import Path
import subprocess

root = Path('/data/hsbc/deploy')
images = {
    'NODE_IMAGE': 'node:24.21.0-bookworm',
    'POSTGRES_IMAGE': 'postgres:18.6-bookworm',
    'REDIS_IMAGE': 'redis:8.10.2',
    'OPA_IMAGE': 'openpolicyagent/opa:1.21.1',
}
resolved = {}
for key, original in images.items():
    mirror = 'dockerproxy.net/' + (original if '/' in original else 'library/' + original)
    for candidate in (original, mirror):
        try:
            subprocess.run(['docker', 'pull', '--platform', 'linux/amd64', candidate], check=True, timeout=1200)
            info = json.loads(subprocess.check_output(['docker', 'image', 'inspect', candidate]))[0]
            repository = candidate.rsplit(':', 1)[0]
            aliases = {repository, 'docker.io/' + repository}
            if '/' not in repository:
                aliases.update({'library/' + repository, 'docker.io/library/' + repository})
            digests = {item.split('@', 1)[1] for item in info['RepoDigests']
                       if item.split('@', 1)[0] in aliases}
            if len(digests) != 1:
                raise RuntimeError('Pulled repository does not have one unambiguous digest')
            digest = digests.pop()
            # Resolve the exact repository + digest before writing deployment references.
            pinned = json.loads(subprocess.check_output(['docker', 'image', 'inspect', candidate + '@' + digest]))[0]
            if pinned['Id'] != info['Id'] or pinned['Os'] != 'linux' or pinned['Architecture'] != 'amd64':
                raise RuntimeError('Pinned image content or platform mismatch')
            resolved[key] = {'source': original, 'pulled_from': candidate, 'reference': candidate + '@' + digest,
                             'digest': digest, 'image_id': info['Id'], 'platform': 'linux/amd64'}
            break
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, IndexError) as exc:
            print(f'Image candidate failed: {candidate}: {type(exc).__name__}', flush=True)
    else:
        raise SystemExit(f'No valid source for {original}')
    # Preserve partial evidence even if a later source fails.
    (root / 'images.resolved.json').write_text(json.dumps(resolved, indent=2) + '\n')
path = root / '.env'
current = dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line and not line.startswith('#')) if path.exists() else {}
current.update({key: item['reference'] for key, item in resolved.items()})
path.write_text(''.join(f'{key}={value}\n' for key, value in current.items()))
path.chmod(0o600)
lock = {'recorded_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'images': resolved,
        'distribution': 'bootstrap; private ACR credentials pending',
        'application': 'not implemented; repository currently has no local commits'}
(root / 'versions.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
print('All four images pulled and locked')

