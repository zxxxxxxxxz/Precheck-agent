"""Write non-secret deployed version and artifact evidence on the 3090."""
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/data/hsbc')


def command(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()


def sha256(path):
    return hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()


environments = {}
for kind, packages in {
    'ocr': ['paddlepaddle-gpu', 'paddleocr', 'paddlex', 'fastapi', 'uvicorn'],
    'ner': ['gliner2', 'torch', 'transformers', 'fastapi', 'uvicorn'],
}.items():
    python = str(ROOT / f'envs/{kind}/bin/python')
    installed = json.loads(command(python, '-c',
        'import importlib.metadata as m,json;print(json.dumps({p:m.version(p) for p in '
        + repr(packages) + '}))'))
    explicit = ROOT / f'deploy/{kind}-conda-explicit.lock.txt'
    explicit.write_text(command('/root/miniconda3/bin/conda', 'list', '--explicit',
                                '-p', str(ROOT / f'envs/{kind}')) + '\n')
    environments[kind] = {
        'prefix': str(ROOT / f'envs/{kind}'),
        'python': command(python, '--version'),
        'packages': installed,
        'requirements_lock': str(ROOT / f'deploy/{kind}-requirements.lock.txt'),
        'conda_explicit_lock': str(explicit),
    }

artifacts = [
    ROOT / 'app/gpu3090/service.py',
    ROOT / 'app/gpu3090/ocr_contract.py',
    ROOT / 'app/gpu3090/ner_contract.py',
    ROOT / 'config/nginx/gpu3090.conf',
    ROOT / 'config/supervisor/gpu3090.conf',
    ROOT / 'scripts/start-gpu3090.sh',
    ROOT / 'scripts/tunnel-bootstrap.sh',
    ROOT / 'scripts/install-system-gpu3090.sh',
    *[ROOT / f'deploy/{kind}-{suffix}' for kind in ('ocr', 'ner')
      for suffix in ('requirements.lock.txt', 'conda-explicit.lock.txt')],
    ROOT / 'deploy/ocr-model-artifacts.lock.json',
    ROOT / 'deploy/ppocr-model-artifacts.lock.json',
    ROOT / 'scripts/download_ppocr.py',
    ROOT / 'models/gliner2.5-multi-v1/download-manifest.json',
]
report = {
    'recorded_at_utc': datetime.now(timezone.utc).isoformat(),
    'server': 'autodl-3090',
    'data_target': str(Path('/data').resolve()),
    'environment': environments,
    'gpu': command('nvidia-smi', '--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'),
    'nginx': command('/usr/sbin/nginx', '-v'),
    'supervisor': command('/usr/bin/supervisord', 'version'),
    'ner_model': {
        'repository': 'fastino/gliner2.5-multi-v1',
        'revision': 'cf5593a5d45e3bbf204b9df621b13b1c0cf25ee3',
        'local_path': str(ROOT / 'models/gliner2.5-multi-v1'),
    },
    'ocr_models': {
        'pipeline': 'PaddleOCR-VL 1.6 + optional PP-OCRv6 medium word localization',
        'source': 'official Paddle BOS inference archives',
        'upstream_snapshot_in_archive_metadata': '676e2aad67375fec9c7dcc9740babec7a0d0d110',
        'local_paths': [str(ROOT / 'models' / name) for name in (
            'PP-DocLayoutV3', 'PaddleOCR-VL-1.6',
            'PP-OCRv6_medium_det', 'PP-OCRv6_medium_rec')],
        'identity': 'Exact per-file SHA256 values in ocr-model-artifacts.lock.json and ppocr-model-artifacts.lock.json are authoritative.',
    },
    'sha256': {str(path): sha256(path) for path in artifacts},
    'os_upgrade_evidence': (ROOT / 'deploy/os-upgrade-latest.txt').read_text().strip(),
}
(ROOT / 'deploy/versions.lock.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'status': 'written', 'path': str(ROOT / 'deploy/versions.lock.json')}))
