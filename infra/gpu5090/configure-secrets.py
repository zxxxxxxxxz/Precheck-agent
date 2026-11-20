"""Generate the model API credential on the GPU; never print its value."""
import os
import secrets
import re
from pathlib import Path

os.umask(0o077)
root = Path('/data/hsbc/secrets')
root.mkdir(mode=0o700, parents=True, exist_ok=True)
token_file = root / 'qwen-api.token'
if not token_file.exists():
    token_file.write_text(secrets.token_urlsafe(48) + '\n')
token = token_file.read_text().strip()
if not re.fullmatch(r'[-_A-Za-z0-9]{32,128}', token):
    raise ValueError('Invalid bearer token file')
# Nginx literal map keys ignore case; a case-sensitive anchored regex is needed.
(root / 'nginx-bearer.map').write_text(f'"~^Bearer {token}$" 1;\n')
for path in (token_file, root / 'nginx-bearer.map'):
    path.chmod(0o600)
print('Private token and Nginx authentication map configured.')
