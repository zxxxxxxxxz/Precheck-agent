#!/usr/bin/env bash
set -euo pipefail
mountpoint -q /data
cd /data/hsbc/deploy
set -a
source .env
set +a
pg_gid=$(docker run --rm --network none --entrypoint id "$POSTGRES_IMAGE" -g postgres)
redis_gid=$(docker run --rm --network none --entrypoint id "$REDIS_IMAGE" -g redis)
chown root:"$pg_gid" /data/hsbc/secrets/postgres_password /data/hsbc/secrets/db-roles.env
chmod 640 /data/hsbc/secrets/postgres_password /data/hsbc/secrets/db-roles.env
chown root:"$redis_gid" /data/hsbc/secrets/redis_password /data/hsbc/secrets/redis.acl
chmod 640 /data/hsbc/secrets/redis_password /data/hsbc/secrets/redis.acl
setfacl -m u:hsbc-tunnel:--- /data/hsbc/secrets/postgres_password /data/hsbc/secrets/db-roles.env /data/hsbc/secrets/redis_password /data/hsbc/secrets/redis.acl
chown -R hsbc-tunnel:hsbc-tunnel /data/hsbc/secrets/ssh
chmod 700 /data/hsbc/secrets/ssh
chmod 600 /data/hsbc/secrets/ssh/*
setfacl -m u:hsbc-tunnel:--x /data/hsbc/secrets
python3 - <<'PY'
from pathlib import Path
import os,secrets
os.umask(0o077)
root=Path('/data/hsbc/secrets')
p=root/'opa.env'
if not p.exists():
    p.write_text('OPA_QUERY_TOKEN='+secrets.token_hex(32)+'\nOPA_PROBE_TOKEN='+secrets.token_hex(32)+'\n')
env=root/'app.env'
data=dict(x.split('=',1) for x in env.read_text().splitlines() if '=' in x)
for key,name in [('OCR_API_TOKEN','ocr.token'),('NER_API_TOKEN','ner.token'),('QWEN_API_TOKEN','qwen-api.token')]:
    if (root/name).exists(): data[key]=(root/name).read_text().strip()
data['OPA_QUERY_TOKEN']=dict(x.split('=',1) for x in p.read_text().splitlines())['OPA_QUERY_TOKEN']
data.update(OSS_BUCKET='hsbc-poc',OSS_REGION='cn-wulanchabu',OSS_ENDPOINT='https://oss-cn-wulanchabu-internal.aliyuncs.com',OSS_PUBLIC_ENDPOINT='https://oss-cn-wulanchabu.aliyuncs.com',OSS_AUTH_MODE='ecs_ram_role')
env.write_text(''.join(f'{k}={v}\n' for k,v in data.items()))
env.chmod(0o600)
PY
install -m 644 /data/hsbc/config/systemd/hsbc-*.service /data/hsbc/config/systemd/hsbc-*.timer /etc/systemd/system/
systemctl daemon-reload
docker compose --env-file .env -f compose.yaml config --quiet
docker compose --env-file .env -f compose.yaml up -d --wait postgres redis
echo 'Postgres and Redis started; OPA requires validated activation'

