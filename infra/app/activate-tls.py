#!/usr/bin/env python3
"""Validate certd input, pin an immutable certificate pair, and reload Nginx."""
from pathlib import Path
import datetime
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

if len(sys.argv) != 3:
    raise SystemExit('Usage: activate-tls.py CERT_FILE KEY_FILE')
root = Path('/etc/ssl/certs/mse.pub')
source_cert, source_key = [Path(p).resolve(strict=True) for p in sys.argv[1:]]
for path in (source_cert, source_key):
    if not path.is_relative_to(root) or not re.fullmatch(r'[a-zA-Z0-9_./-]+', str(path)):
        raise SystemExit('Certificate paths must remain in /etc/ssl/certs/mse.pub/')
run = Path('/data/hsbc/run')
run.mkdir(parents=True, exist_ok=True)
lock = (run / 'tls-activation.lock').open('w')
fcntl.flock(lock, fcntl.LOCK_EX)
source_key.chmod(0o600)
# Read each input once. A partial/mixed certd upload fails validation without
# changing the known-good certificate paths in the running Nginx configuration.
cert_bytes, key_bytes = source_cert.read_bytes(), source_key.read_bytes()
staging = Path(tempfile.mkdtemp(prefix='.tls-candidate-', dir=root))
try:
    cert, key = staging / 'cert.pem', staging / 'cert.key'
    cert.write_bytes(cert_bytes)
    key.write_bytes(key_bytes)
    key.chmod(0o600)
    hostname_check = subprocess.check_output(['openssl', 'x509', '-in', str(cert), '-noout',
        '-checkhost', 'hsbc.mse.pub'], text=True, env=dict(os.environ, LC_ALL='C')).strip()
    if hostname_check != 'Hostname hsbc.mse.pub does match certificate':
        raise SystemExit('Certificate does not cover hsbc.mse.pub; Nginx configuration unchanged')
    subprocess.run(['openssl', 'verify', '-CApath', '/etc/ssl/certs', '-untrusted', str(cert),
                    '-verify_hostname', 'hsbc.mse.pub', str(cert)], check=True,
                   stdout=subprocess.DEVNULL)
    cert_public = subprocess.check_output(['openssl', 'x509', '-in', str(cert), '-pubkey', '-noout'])
    key_public = subprocess.check_output(['openssl', 'pkey', '-in', str(key), '-pubout'])
    if cert_public != key_public:
        raise SystemExit('Certificate and key mismatch; Nginx configuration unchanged')
    certificate_der = subprocess.check_output(['openssl', 'x509', '-in', str(cert), '-outform', 'DER'])
    fingerprint = hashlib.sha256(certificate_der).hexdigest()
    versions = root / 'releases'
    versions.mkdir(mode=0o700, exist_ok=True)
    version = versions / hashlib.sha256(cert_bytes).hexdigest()
    if version.exists():
        if (version / 'cert.pem').read_bytes() != cert_bytes:
            raise SystemExit('Existing certificate snapshot content mismatch')
        existing_public = subprocess.check_output(['openssl', 'pkey', '-in', str(version / 'cert.key'), '-pubout'])
        if existing_public != cert_public:
            raise SystemExit('Existing certificate snapshot key mismatch')
    else:
        os.rename(staging, version)
    cert, key = version / 'cert.pem', version / 'cert.key'
finally:
    if staging.exists():
        shutil.rmtree(staging)

config = Path('/etc/nginx/conf.d/hsbc.conf')
old = config.read_bytes() if config.exists() else None
rendered = Path('/data/hsbc/config/nginx/nginx.conf.template').read_text().replace('@@CERT@@', str(cert)).replace('@@KEY@@', str(key))
activation_id = hashlib.sha256(rendered.encode() + cert_bytes).hexdigest()
record = run / 'tls-activation.json'
previous = json.loads(record.read_text()) if record.exists() else {}
pending = Path('/etc/nginx/conf.d/hsbc-pending.conf')
pending_bytes = pending.read_bytes() if pending.exists() else None
if previous.get('activation_id') == activation_id and old == rendered.encode() and pending_bytes is None:
    print('TLS certificate and configuration unchanged')
    raise SystemExit(0)
recovery = Path('/data/hsbc/config/nginx/hsbc-pending.conf.before-tls')
if pending_bytes is not None and not recovery.exists():
    recovery.write_bytes(pending_bytes)
config.write_text(rendered)
try:
    pending.unlink(missing_ok=True)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
except BaseException:
    if old is None:
        config.unlink(missing_ok=True)
    else:
        config.write_bytes(old)
    if pending_bytes is not None:
        pending.write_bytes(pending_bytes)
    raise
record_tmp = record.with_suffix('.json.tmp')
record_tmp.write_text(json.dumps({
    'activated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'hostname': 'hsbc.mse.pub', 'certificate_sha256': fingerprint,
    'loaded_certificate': str(cert), 'activation_id': activation_id,
    'nginx_test_passed': True,
}, indent=2) + '\n')
os.replace(record_tmp, record)
print('Certificate validated, immutable pair pinned, and Nginx reloaded')
