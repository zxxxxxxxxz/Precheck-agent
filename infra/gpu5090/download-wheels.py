"""Download compatible hash-locked wheels with resumable domestic transfers."""
from pathlib import Path
import subprocess
import tomllib
from urllib.parse import unquote, urlsplit
from pip._vendor.packaging.tags import sys_tags
from pip._vendor.packaging.utils import parse_wheel_filename
from pip._vendor.packaging.markers import Marker

base = Path('/data/hsbc')
lock = tomllib.loads((base / 'deploy/pylock.vllm.toml').read_text())
ranks = {tag: rank for rank, tag in enumerate(sys_tags())}
entries = []
requirements = []
for package in lock['packages']:
    if package.get('marker') and not Marker(package['marker']).evaluate():
        continue
    choices = []
    for wheel in package.get('wheels', []):
        filename = unquote(Path(urlsplit(wheel['url']).path).name)
        tags = parse_wheel_filename(filename)[3]
        matches = [ranks[tag] for tag in tags if tag in ranks]
        if matches:
            choices.append((min(matches), filename, wheel))
    if not choices:
        raise RuntimeError(f'No binary wheel for {package["name"]}')
    _, filename, wheel = min(choices, key=lambda c: c[0])
    entries.append(f'{wheel["url"]}\n out={filename}\n checksum=sha-256={wheel["hashes"]["sha256"]}\n')
    requirements.append(f'{package["name"]}=={package["version"]} --hash=sha256:{wheel["hashes"]["sha256"]}')
manifest = base / 'deploy/wheels.aria2'
manifest.write_text(''.join(entries))
(base / 'deploy/wheels.lock.txt').write_text('\n'.join(requirements) + '\n')
subprocess.run(['aria2c', '--input-file=' + str(manifest), '--dir=' + str(base / 'cache/wheels'),
                '--continue=true', '--auto-file-renaming=false', '--allow-overwrite=true',
                '--file-allocation=none', '--check-integrity=true', '--max-concurrent-downloads=4',
                '--max-connection-per-server=8', '--split=8', '--min-split-size=4M',
                '--max-tries=8', '--retry-wait=3', '--console-log-level=warn',
                '--summary-interval=60', '--show-console-readout=false'], check=True)
