"""Acquire official PP-OCRv6 weights; pin every runtime artifact by SHA256."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from datetime import datetime, timezone

ROOT = Path("/data/hsbc")
os.environ["PADDLE_PDX_CACHE_HOME"] = str(ROOT / "cache/paddlex")
os.environ["PADDLE_PDX_MODEL_SOURCE"] = "bos"
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
from paddlex.inference.utils.official_models import official_models

lock_path = ROOT / "deploy/ppocr-model-artifacts.lock.json"
previous = json.loads(lock_path.read_text()) if lock_path.exists() else None
report = {"recorded_at": datetime.now(timezone.utc).isoformat(),
          "source": "official Paddle BOS inference archives via PaddleX 3.7.2",
          "models": {}}
for name in ("PP-OCRv6_medium_det", "PP-OCRv6_medium_rec"):
    target = ROOT / "models" / name
    if not target.exists():
        source = Path(official_models[name])
        with tempfile.TemporaryDirectory(prefix=f".{name}-", dir=target.parent) as temporary:
            staging = Path(temporary) / name
            shutil.copytree(source, staging)
            staging.rename(target)
    files = {}
    for path in sorted(target.rglob("*")):
        if path.is_file():
            files[str(path.relative_to(target))] = {
                "bytes": path.stat().st_size,
                "sha256": hashlib.file_digest(path.open("rb"), "sha256").hexdigest()}
    if previous and files != previous["models"][name]["files"]:
        raise RuntimeError("Pinned PP-OCR artifact mismatch: " + name)
    report["models"][name] = {"files": files}
    print("verified", name, "files", len(files), flush=True)
if not previous:
    lock_path.write_text(json.dumps(report, indent=2) + "\n")
