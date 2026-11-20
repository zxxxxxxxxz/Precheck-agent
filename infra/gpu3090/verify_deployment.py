"""Short post-upgrade verification; never print credentials or model content."""
import json
import subprocess
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/data/hsbc')
report = {'checked_at_utc': datetime.now(timezone.utc).isoformat(), 'ready': {}}
for kind, port in [('ocr', 6006), ('ner', 6008)]:
    token = (ROOT / f'secrets/{kind}.token').read_text().strip()
    request = urllib.request.Request(f'http://127.0.0.1:{port}/health/ready',
                                    headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=15) as response:
        result = json.load(response)
        assert response.status == 200 and result['status'] == 'ready'
        report['ready'][kind] = {'http_status': response.status, 'status': result['status']}

proxy_names = {'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy'}
report['serving_processes'] = []
for proc in Path('/proc').iterdir():
    if not proc.name.isdigit():
        continue
    try:
        args = (proc / 'cmdline').read_bytes().split(b'\0')
        if not args or not (
            args[0] in [b'/data/hsbc/envs/ocr/bin/python', b'/data/hsbc/envs/ner/bin/python']
            and b'uvicorn' in args
            or args[0] == b'/usr/bin/supervisord'
            and b'/data/hsbc/config/supervisor/gpu3090.conf' in args
        ):
            continue
        keys = {entry.split(b'=', 1)[0].decode() for entry in (proc / 'environ').read_bytes().split(b'\0') if entry}
        assert not keys.intersection(proxy_names), 'Serving process inherited a download proxy'
        report['serving_processes'].append({'pid': int(proc.name), 'download_proxy_present': False})
    except (FileNotFoundError, ProcessLookupError):
        continue
assert len(report['serving_processes']) == 3
evidence = Path((ROOT / 'deploy/os-upgrade-latest.txt').read_text().strip())
def packages(name):
    return dict(line.split('\t', 1) for line in (evidence / name).read_text().splitlines())
before, after = packages('packages-before.tsv'), packages('packages-after.tsv')
upgraded = [{'package': name, 'before': old, 'after': after[name]}
            for name, old in before.items() if after.get(name) != old]
assert (evidence / 'platform-before.sha256').read_bytes() == (evidence / 'platform-after.sha256').read_bytes()
report['system_update'] = {
    'evidence_directory': str(evidence),
    'upgraded_count': len(upgraded),
    'upgraded_packages': upgraded,
    'protected_packages': (evidence / 'protected-packages.txt').read_text().splitlines(),
    'held_back': ['libgl1-mesa-dri', 'libglapi-mesa', 'libglx-mesa0', 'libxnvctrl0'],
    'held_back_reason': 'Three Mesa graphics libraries require dependency changes; apt upgrade retained them. libxnvctrl0 is explicitly held to preserve the GPU/platform stack.',
    'platform_supervisor_and_base_python_unchanged': True,
    'reboot_performed': False,
    'platform_services_restarted': False,
    'remaining_plan': (evidence / 'remaining-plan.txt').read_text(),
}
report['gpu'] = subprocess.check_output(['nvidia-smi', '--query-gpu=name,driver_version,memory.used,memory.total',
                                        '--format=csv,noheader'], text=True).strip()
report['status'] = 'passed'
(ROOT / 'deploy/gpu3090-post-upgrade.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'status': report['status'], 'ready': report['ready'],
                  'upgraded_count': len(upgraded), 'serving_processes': report['serving_processes']}))
