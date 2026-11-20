"""Download official Paddle artifacts and verify the reviewed deployment hashes."""
import hashlib
import json
import os
from pathlib import Path
import shutil

ROOT = Path("/data/hsbc")
os.environ["PADDLE_PDX_CACHE_HOME"] = str(ROOT / "cache/paddlex")
os.environ["PADDLE_PDX_MODEL_SOURCE"] = "bos"
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
lock = json.loads((ROOT / "deploy/ocr-model-artifacts.lock.json").read_text())
from paddlex.inference.utils.official_models import official_models

for name, artifact in lock["models"].items():
    target = ROOT / "models" / name
    if not target.exists():
        source = Path(official_models[name])
        shutil.copytree(source, target)
    for relative, expected in artifact["files"].items():
        path = target / relative
        with path.open("rb") as content:
            actual = hashlib.file_digest(content, "sha256").hexdigest()
        if actual != expected["sha256"] or path.stat().st_size != expected["bytes"]:
            raise RuntimeError(f"Model artifact hash mismatch: {name}/{relative}")
    print(f"verified {name}")
