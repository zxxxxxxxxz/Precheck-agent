#!/usr/bin/env python3
import hashlib
import os
from pathlib import Path
import secrets

root = Path('/data/hsbc')
directory = root / 'secrets'
directory.mkdir(mode=0o700, parents=True, exist_ok=True)
os.umask(0o077)

def token_file(name):
    path = directory / name
    if not path.exists():
        path.write_text(secrets.token_hex(32) + '\n')
    return path.read_text().strip()

token_file('postgres_password')
redis = token_file('redis_password')
roles = directory / 'db-roles.env'
if not roles.exists():
    roles.write_text(''.join(f'HSBC_DB_{role}_PASSWORD={secrets.token_hex(32)}\n' for role in ['APP', 'MIGRATION', 'CHECKPOINT']))
roles.chmod(0o600)  # setup-runtime grants only the actual container service GID.
(directory / 'postgres_password').chmod(0o600)
(directory / 'redis_password').chmod(0o600)
(directory / 'redis.acl').write_text(f'user default off\nuser hsbc on #{hashlib.sha256(redis.encode()).hexdigest()} ~* &* +@all -acl -config -debug -module -shutdown\n')
(directory / 'redis.acl').chmod(0o600)
config = root / 'config' / 'redis.conf'
config.write_text('bind 0.0.0.0\nprotected-mode yes\nport 6379\ndir /data\nappendonly yes\nappendfsync everysec\nmaxmemory-policy noeviction\naclfile /run/secrets/redis.acl\n')
config.chmod(0o644)
env = directory / 'app.env'
if not env.exists():
    values = dict(line.split('=', 1) for line in roles.read_text().splitlines())
    env.write_text('NODE_ENV=production\nPORT=3000\nDATABASE_HOST=postgres\nDATABASE_PORT=5432\nDATABASE_NAME=hsbc\nDATABASE_USER=hsbc_app\nDATABASE_PASSWORD=' + values['HSBC_DB_APP_PASSWORD'] + '\nCHECKPOINT_DATABASE_USER=hsbc_checkpoint\nCHECKPOINT_DATABASE_PASSWORD=' + values['HSBC_DB_CHECKPOINT_PASSWORD'] + '\nREDIS_HOST=redis\nREDIS_PORT=6379\nREDIS_USERNAME=hsbc\nREDIS_PASSWORD=' + redis + '\nOPA_BASE_URL=http://opa:8181\nOCR_BASE_URL=http://autodl-3090:16006\nNER_BASE_URL=http://autodl-3090:16008\nQWEN_BASE_URL=https://u334749-95be-0bf1cc76.bjb2.seetacloud.com:8443/v1\n')
print('Generated/reused secrets; values withheld')
