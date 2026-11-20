"""Fetch pip --dry-run --report wheels concurrently, verifying each official hash."""
import json
from pathlib import Path
import subprocess
import sys
from urllib.parse import unquote, urlparse

report = json.loads(Path(sys.argv[1]).read_text())
cache = Path("/data/hsbc/cache/wheels")
cache.mkdir(parents=True, exist_ok=True)
lines = []
for item in report["install"]:
    source = item["download_info"]
    url = source["url"]
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "files.pythonhosted.org":
        raise RuntimeError("Only official PyPI wheel downloads are accepted")
    name = Path(unquote(parsed.path)).name
    if not name.endswith(".whl") or "\n" in name:
        raise RuntimeError("Expected a wheel file")
    digest = source["archive_info"]["hashes"]["sha256"]
    lines.extend([url, f" out={name}", f" checksum=sha-256={digest}"])
task_file = cache / "downloads.txt"
task_file.write_text("\n".join(lines) + "\n")
subprocess.run(["aria2c", "--continue=true", "--max-concurrent-downloads=5",
                "--max-connection-per-server=4", "--split=4", "--min-split-size=4M",
                "--max-tries=5", "--retry-wait=3", "--summary-interval=30",
                "--console-log-level=warn", "--dir", str(cache), "--input-file", str(task_file)], check=True)
