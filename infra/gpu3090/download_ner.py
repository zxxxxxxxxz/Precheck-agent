"""Download one reviewed Hub revision; run with AutoDL turbo only for this step."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import shutil
import urllib.request

REPO = "fastino/gliner2.5-multi-v1"
REVISION = "cf5593a5d45e3bbf204b9df621b13b1c0cf25ee3"
ROOT = Path("/data/hsbc/models/gliner2.5-multi-v1")
FILES = ["config.json", "encoder_config/config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json"]
ROOT.mkdir(parents=True, exist_ok=True)
reviewed = json.loads(Path('/data/hsbc/deploy/ner-model-artifacts.lock.json').read_text())
assert reviewed['repository'] == REPO and reviewed['revision'] == REVISION
with urllib.request.urlopen(f"https://huggingface.co/api/models/{REPO}/revision/{REVISION}?blobs=true", timeout=60) as response:
    metadata = json.load(response)
assert metadata["sha"] == REVISION
expected = {entry["rfilename"]: entry for entry in metadata["siblings"]}
manifest = {"repository": REPO, "revision": REVISION, "files": {}}
for name in FILES:
    target = ROOT / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        part = target.with_suffix(target.suffix + ".part")
        endpoint = os.environ.get("MODEL_HUB_ENDPOINT", "https://huggingface.co")
        command = ["curl", "--fail", "--location", "--silent", "--show-error",
                   "--connect-timeout", "30", "--retry", "5", "--retry-delay", "3",
                   "--continue-at", "-", "--output", str(part),
                   f"{endpoint}/{REPO}/resolve/{REVISION}/{name}"]
        if endpoint == "https://hf-mirror.com":
            command[1:1] = ["--noproxy", "*"]
        if shutil.which("aria2c"):
            command = ["aria2c", "--continue=true", "--max-connection-per-server=4",
                       "--split=4", "--min-split-size=4M", "--max-tries=5",
                       "--retry-wait=3", "--summary-interval=30", "--console-log-level=warn",
                       "--dir", str(part.parent), "--out", part.name,
                       f"{endpoint}/{REPO}/resolve/{REVISION}/{name}"]
            if endpoint == "https://hf-mirror.com":
                command[1:1] = ["--all-proxy="]
        subprocess.run(command, check=True)
        part.rename(target)
    digest = hashlib.file_digest(target.open("rb"), "sha256").hexdigest() if hasattr(hashlib, "file_digest") else hashlib.sha256(target.read_bytes()).hexdigest()
    lfs_hash = expected[name].get("lfs", {}).get("sha256")
    if lfs_hash and digest != lfs_hash:
        raise RuntimeError(f"Official LFS hash mismatch: {name}")
    if digest != reviewed['files'][name]['sha256'] or target.stat().st_size != reviewed['files'][name]['bytes']:
        raise RuntimeError(f"Reviewed artifact hash mismatch: {name}")
    manifest["files"][name] = {"sha256": digest, "bytes": target.stat().st_size}
    print(f"verified {name} {target.stat().st_size}", flush=True)
(ROOT / "download-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
