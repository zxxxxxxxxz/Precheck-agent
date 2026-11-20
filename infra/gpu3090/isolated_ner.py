"""Preflight/start/stop one optional span evaluation server, never production.

Run with the existing locked /data/hsbc/envs/ner/bin/python. No installation,
download, supervisor edit, production file edit, or firewall change is supported.
The staged manifest must contain exact hashes of the six listed input files.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path("/data/hsbc")
FILES = ("service.py", "ner_contract.py", "ocr_contract.py",
         "ner-requirements.lock.txt", "ner-model-artifacts.lock.json", "isolated_ner.py")
PORT = 8003
PYTHON = ROOT / "envs/ner/bin/python"


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def gpu_free():
    response = subprocess.run(["/usr/bin/nvidia-smi", "--query-gpu=memory.free",
                               "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10)
    if response.returncode or len(response.stdout.splitlines()) != 1:
        raise RuntimeError("gpu_capacity_unavailable")
    return int(response.stdout.strip())


def ready(port, token):
    request = urllib.request.Request(f"http://127.0.0.1:{port}/health/ready",
                                    headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status == 200 and json.load(response).get("status") == "ready"
    except (urllib.error.URLError, TimeoutError):
        return False


def control_health():
    return {
        kind: ready(port, (ROOT / "secrets" / f"{kind}.token").read_text().strip())
        for kind, port in (("ocr", 6006), ("ner", 6008))
    }


def identity(pid):
    path = Path("/proc") / str(pid)
    # Linux stat's command field may contain spaces/parentheses.
    suffix = (path / "stat").read_text().rsplit(")", 1)[1].split()
    return {"startTicks": suffix[19], "cwd": str((path / "cwd").resolve()),
            "cmdline": (path / "cmdline").read_bytes().split(b"\0")}


def owned_identity(run, record):
    try:
        actual = identity(record["pid"])
    except (FileNotFoundError, ProcessLookupError):
        return False
    if (actual["startTicks"] != record["startTicks"] or actual["cwd"] != str(run) or
            b"uvicorn" not in actual["cmdline"] or b"8003" not in actual["cmdline"]):
        raise RuntimeError("isolated_process_identity_mismatch")
    return True


def stop_owned(run, record):
    if not owned_identity(run, record):
        return
    os.killpg(record["pid"], signal.SIGTERM)


def preflight(stage, expected_manifest_hash):
    if Path("/data").resolve() != Path("/root/autodl-tmp") or not os.path.ismount("/root/autodl-tmp"):
        raise RuntimeError("expected_data_mount_required")
    if Path(sys.executable).resolve() != PYTHON.resolve():
        raise RuntimeError("locked_ner_python_required")
    manifest_path = stage / "isolation-manifest.json"
    if digest(manifest_path) != expected_manifest_hash:
        raise RuntimeError("staged_manifest_hash_mismatch")
    manifest = json.loads(manifest_path.read_text())
    if set(manifest.get("files", {})) != set(FILES):
        raise RuntimeError("staged_manifest_invalid")
    for name in FILES:
        path = stage / name
        if path.is_symlink() or not path.is_file() or digest(path) != manifest["files"][name]:
            raise RuntimeError("staged_source_hash_mismatch")
    for line in (stage / "ner-requirements.lock.txt").read_text().splitlines():
        name, version = line.split("==")
        if importlib.metadata.version(name) != version:
            raise RuntimeError("locked_dependency_mismatch")
    if importlib.metadata.version("gliner2") != "2.1.0":
        raise RuntimeError("locked_gliner_version_required")
    lock = json.loads((stage / "ner-model-artifacts.lock.json").read_text())
    if lock["revision"] != "cf5593a5d45e3bbf204b9df621b13b1c0cf25ee3":
        raise RuntimeError("locked_model_revision_required")
    model_root = ROOT / "models/gliner2.5-multi-v1"
    for name, metadata in lock["files"].items():
        target = model_root / name
        if model_root.resolve() not in target.resolve().parents or target.stat().st_size != metadata["bytes"] or digest(target) != metadata["sha256"]:
            raise RuntimeError("locked_model_hash_mismatch")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", PORT))
    if gpu_free() < 8192:
        raise RuntimeError("isolated_ner_capacity_insufficient")
    before = control_health()
    if not all(before.values()):
        raise RuntimeError("production_control_not_ready")
    return {"manifestHash": expected_manifest_hash, "sourceHashes": manifest["files"],
            "modelRevision": lock["revision"], "glinerVersion": "2.1.0",
            "gpuFreeMiB": gpu_free(), "productionControlBefore": before}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("preflight", "start", "status", "stop"))
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--manifest-sha256", required=True)
    args = parser.parse_args()
    if len(args.manifest_sha256) != 64 or any(c not in "0123456789abcdef" for c in args.manifest_sha256):
        raise RuntimeError("manifest_hash_required")
    stage = args.stage.resolve(strict=True)
    run = (ROOT / "evaluations" / ("ner-spans-" + args.manifest_sha256[:16])).resolve()
    if args.action in ("status", "stop"):
        record = json.loads((run / "process.json").read_text())
        if args.action == "stop":
            stop_owned(run, record)
            print(json.dumps({"status": "isolated_stop_requested", "productionProcessesChanged": False}))
        else:
            if not owned_identity(run, record):
                print(json.dumps({"status": "isolated_process_stopped", "ready": False}))
                return
            token = (run / "secrets/ner.token").read_text().strip()
            print(json.dumps({"ready": ready(PORT, token), "gpuFreeMiB": gpu_free(),
                              "productionControl": control_health()}))
        return
    report = preflight(stage, args.manifest_sha256)
    report.update({"port": PORT, "bind": "127.0.0.1", "runDirectory": str(run),
                   "productionFilesChanged": False, "productionProcessesChanged": False})
    if args.action == "preflight":
        print(json.dumps(report)); return
    os.umask(0o077)
    run.parent.mkdir(exist_ok=True, mode=0o700)
    run.mkdir(mode=0o700)  # Existing/unknown run is never restarted.
    for child in ("secrets", "logs", "tmp", "cache"):
        (run / child).mkdir(mode=0o700)
    for name in FILES:
        shutil.copyfile(stage / name, run / name)
    token = secrets.token_urlsafe(48)
    (run / "secrets/ner.token").write_text(token)
    env = {key: value for key, value in os.environ.items()
           if key.lower() not in ("http_proxy", "https_proxy", "all_proxy", "no_proxy", "pythonpath", "pythonhome")}
    env.update(MODEL_SERVICE="ner", MODEL_RUNTIME_ROOT=str(run),
               HF_HOME=str(run / "cache/huggingface"), HF_HUB_OFFLINE="1",
               TRANSFORMERS_OFFLINE="1", TMPDIR=str(run / "tmp"), OMP_NUM_THREADS="4",
               PYTHONUNBUFFERED="1")
    process = None
    try:
        with (run / "logs/service.log").open("xb") as log:
            process = subprocess.Popen([str(PYTHON), "-m", "uvicorn", "service:app",
                                        "--host", "127.0.0.1", "--port", str(PORT),
                                        "--workers", "1", "--no-access-log"],
                                       cwd=run, env=env, stdout=log, stderr=log, start_new_session=True)
        # Wait for exec/cwd to settle before recording the process identity.
        for _ in range(50):
            if process.poll() is not None:
                raise RuntimeError("isolated_ner_start_failed")
            actual = identity(process.pid)
            if actual["cwd"] == str(run) and b"uvicorn" in actual["cmdline"]:
                break
            time.sleep(0.02)
        else:
            raise RuntimeError("isolated_process_identity_unavailable")
        record = {"pid": process.pid, "startTicks": actual["startTicks"]}
        (run / "process.json").write_text(json.dumps(record))
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("isolated_ner_start_failed")
            if gpu_free() < 6144:
                raise RuntimeError("isolated_ner_capacity_guard")
            if ready(PORT, token):
                report["productionControlAfter"] = control_health()
                if not all(report["productionControlAfter"].values()):
                    raise RuntimeError("production_control_changed")
                report.update(status="ready", gpuFreeAfterMiB=gpu_free())
                (run / "receipt.json").write_text(json.dumps(report, indent=2))
                print(json.dumps(report)); return
            time.sleep(1)
        raise RuntimeError("isolated_ner_warmup_timeout")
    except Exception:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        code = str(exc)
        if not code or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789_" for c in code):
            code = "isolated_ner_operation_failed"
        print(json.dumps({"status": "failed", "errorCode": code, "productionProcessesChanged": False}))
        raise SystemExit(1) from None
