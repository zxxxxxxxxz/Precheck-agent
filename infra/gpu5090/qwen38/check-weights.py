"""Fail closed before serving if the pinned checkpoint is incomplete or changed."""
import hashlib
import json
from pathlib import Path

record = json.loads(Path('/data/hsbc/deploy/model.lock.json').read_text())
assert record['repo_id'] == 'Inferact/Qwen3.8-27B-NVFP4'
assert record['revision'] == '6128240ebaf4eaa7bad2b3d1c72c37d677c5f462'
assert record.get('download_complete') is True
root = Path(record['local_path']).resolve(strict=True)
assert root.is_relative_to(Path('/data/hsbc/models').resolve(strict=True))
assert len([name for name in record['files'] if name.endswith('.safetensors')]) == 7
for name, meta in record['files'].items():
    path = (root / name).resolve(strict=True)
    assert path.is_relative_to(root) and path.is_file()
    assert path.stat().st_size == meta['size']
    expected = meta.get('sha256') or meta.get('verified_sha256')
    assert expected
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    assert digest.hexdigest() == expected
print(root)
