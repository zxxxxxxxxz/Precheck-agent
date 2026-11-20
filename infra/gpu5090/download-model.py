"""Download a pinned official model; existing lock prevents silent revision changes."""
import json
import os
import hashlib
import concurrent.futures
import urllib.request
import urllib.parse
import subprocess
from pathlib import Path
from huggingface_hub import HfApi, snapshot_download

base = Path('/data/hsbc')
lock = base / 'deploy/model.lock.json'
repo = 'Qwen/Qwen3.5-9B'
revision = json.loads(lock.read_text())['revision'] if lock.exists() else 'c202236235762e1c871ad0ccb60c8ee5ba337b9a'
destination = base / 'models/Qwen3.5-9B' / revision
record = {'repo_id': repo, 'revision': revision, 'local_path': str(destination)}
lock.write_text(json.dumps(record, indent=2) + '\n')
metadata = HfApi().model_info(repo, revision=revision, files_metadata=True)
weights = [f for f in metadata.siblings if f.rfilename.endswith('.safetensors')]
# Metadata/tokenizer always come from the pinned Hugging Face commit.
snapshot_download(repo, revision=revision, local_dir=destination,
                  allow_patterns=['*.json', '*.txt', '*.model', '*.jinja', 'README.md', 'LICENSE'], max_workers=4)
# Qwen also publishes these weights on ModelScope. Use that domestic route only
# after proving each advertised hash equals the pinned Hugging Face LFS hash.
direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
mirror_url = 'https://modelscope.cn/api/v1/models/Qwen/Qwen3.5-9B/repo/files?Revision=master&Recursive=true'
try:
    with direct.open(mirror_url, timeout=30) as response:
        mirror_files = {f['Name']: f for f in json.load(response)['Data']['Files']}
except Exception:
    mirror_files = {}

def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

def download(file):
    target = destination / file.rfilename
    if target.exists() and target.stat().st_size == file.size and sha256(target) == file.lfs.sha256:
        return
    mirror = mirror_files.get(file.rfilename, {})
    if mirror.get('Sha256') != file.lfs.sha256 or mirror.get('Size') != file.size:
        snapshot_download(repo, revision=revision, local_dir=destination,
                          allow_patterns=[file.rfilename], max_workers=1)
        assert target.stat().st_size == file.size and sha256(target) == file.lfs.sha256
        return
    part = target.with_suffix(target.suffix + '.part')
    url = 'https://modelscope.cn/api/v1/models/Qwen/Qwen3.5-9B/repo?Revision=master&FilePath=' + urllib.parse.quote(file.rfilename)
    clean_env = {k: v for k, v in os.environ.items() if k.lower() not in ('http_proxy', 'https_proxy', 'all_proxy')}
    subprocess.run(['aria2c', '--dir=' + str(destination), '--out=' + part.name,
                    '--continue=true', '--always-resume=true', '--auto-file-renaming=false',
                    '--file-allocation=none', '--check-integrity=true',
                    '--checksum=sha-256=' + file.lfs.sha256, '--split=8',
                    '--max-connection-per-server=8', '--min-split-size=4M',
                    '--max-tries=8', '--retry-wait=3', '--console-log-level=warn',
                    '--summary-interval=60', '--show-console-readout=false', url], env=clean_env, check=True)
    assert part.stat().st_size == file.size and sha256(part) == file.lfs.sha256
    part.replace(target)
    print(f'verified {file.rfilename}', flush=True)

with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(download, weights))
record['weight_source'] = 'Qwen ModelScope publisher mirror with immutable Hugging Face fallback; verified against pinned Hugging Face LFS SHA256'
record['weights'] = {f.rfilename: {'size': f.size, 'sha256': f.lfs.sha256} for f in weights}
record['download_complete'] = True
lock.write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record))
