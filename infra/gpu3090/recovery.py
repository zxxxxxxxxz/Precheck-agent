"""Stop only the NER worker and verify Supervisor recovers its real readiness."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path("/data/hsbc")
command = ["/usr/bin/supervisord", "ctl", "-s", "unix:///data/hsbc/run/supervisor3090.sock", "pid", "hsbc-ner"]
old_pid = int(subprocess.check_output(command).decode().strip())
assert b"/data/hsbc/envs/ner/bin/python" in Path(f"/proc/{old_pid}/cmdline").read_bytes()
token = (ROOT / "secrets/ner.token").read_text().strip()
started = time.monotonic()
os.kill(old_pid, signal.SIGTERM)
new_pid = old_pid
while time.monotonic() - started < 60:
    try:
        new_pid = int(subprocess.check_output(command).decode().strip())
        req = urllib.request.Request("http://127.0.0.1:6008/health/ready", headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=3) as response:
            ready = json.load(response)["status"] == "ready"
        if new_pid != old_pid and ready:
            report = {"passed": True, "test": "ner_process_automatic_recovery",
                      "old_pid": old_pid, "new_pid": new_pid,
                      "seconds": round(time.monotonic() - started, 3)}
            (ROOT / "deploy/gpu3090-recovery.json").write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps(report))
            break
    except (ValueError, OSError, urllib.error.HTTPError):
        pass
    time.sleep(1)
else:
    raise RuntimeError("Supervisor did not recover model readiness within 60 seconds")
