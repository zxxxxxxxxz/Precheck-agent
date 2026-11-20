"""Resume one pinned NVFP4 checkpoint, verifying publisher LFS hashes."""
import hashlib
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
from urllib.parse import quote

base = Path('/data/hsbc')
lock = base / 'deploy/model.lock.json'
record = json.loads(lock.read_text())
assert record['repo_id'] == 'Inferact/Qwen3.8-27B-NVFP4'
assert record['revision'] == '6128240ebaf4eaa7bad2b3d1c72c37d677c5f462'
destination = Path(record['local_path'])
assert destination.is_relative_to(base / 'models')
destination.mkdir(parents=True, exist_ok=True)
clean_env = {k: v for k, v in os.environ.items() if k.lower() not in ('http_proxy', 'https_proxy', 'all_proxy')}
routes = [('autodl-accelerator', 'https://huggingface.co', dict(os.environ)),
          ('official-direct', 'https://huggingface.co', clean_env),
          ('hf-mirror', 'https://hf-mirror.com', clean_env)]

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

remaining = sum(meta['size'] - min(meta['size'], (destination / name).stat().st_size)
                if (destination / name).exists() else meta['size']
                for name, meta in record['files'].items())
if shutil.disk_usage(destination).free < remaining + 5 * 1024**3:
    raise SystemExit('Insufficient data disk space for checkpoint plus 5 GiB reserve')
def download_file(item):
    name, meta = item
    target = destination / name
    assert target.resolve().is_relative_to(destination.resolve())
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size == meta['size'] and (not meta.get('sha256') or digest(target) == meta['sha256']):
        meta['verified_sha256'] = digest(target)
        meta.setdefault('download_route', 'verified-existing-file')
        return
    completed = False
    for route, endpoint, env in routes:
        url = f"{endpoint}/{record['repo_id']}/resolve/{record['revision']}/{quote(name)}"
        args = ['aria2c', '--dir=' + str(target.parent), '--out=' + target.name,
                '--continue=true', '--auto-file-renaming=false', '--allow-overwrite=true',
                '--file-allocation=none', '--max-connection-per-server=8', '--split=8',
                '--min-split-size=4M', '--max-tries=3', '--retry-wait=3', '--connect-timeout=15',
                '--timeout=60', '--lowest-speed-limit=32K', '--console-log-level=error',
                '--summary-interval=0', '--show-console-readout=false']
        if meta.get('sha256'):
            args += ['--check-integrity=true', '--checksum=sha-256=' + meta['sha256']]
        result = subprocess.run(args + [url], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode == 0 and target.stat().st_size == meta['size'] and (not meta.get('sha256') or digest(target) == meta['sha256']):
            meta['download_route'] = route
            meta['verified_sha256'] = digest(target)
            completed = True
            print(json.dumps({'file': name, 'status': 'verified', 'route': route}), flush=True)
            break
    if not completed:
        raise SystemExit('Pinned model file could not be verified: ' + name)

# Bound connection and disk pressure while avoiding serial multi-GiB shards.
with ThreadPoolExecutor(max_workers=3) as pool:
    list(pool.map(download_file, record['files'].items()))
record['download_complete'] = True
temporary = lock.with_suffix('.json.new')
temporary.write_text(json.dumps(record, indent=2) + '\n')
temporary.replace(lock)
print(json.dumps({'download_complete': True, 'revision': record['revision']}))
