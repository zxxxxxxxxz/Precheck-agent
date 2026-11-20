#!/usr/bin/env bash
set -euo pipefail
BASE=/data/hsbc
test "$(readlink -f /data)" = /root/autodl-tmp
mountpoint -q /root/autodl-tmp
test -f "$BASE/deploy/model.lock.json"
"$BASE/envs/vllm/bin/python" -c 'import json; assert json.load(open("/data/hsbc/deploy/model.lock.json")).get("download_complete") is True'
test -r "$BASE/secrets/nginx-bearer.map"
if "$BASE/envs/vllm/bin/supervisorctl" -c "$BASE/config/supervisor/supervisord.conf" pid >/dev/null 2>&1; then
    exec "$BASE/envs/vllm/bin/supervisorctl" -c "$BASE/config/supervisor/supervisord.conf" start all
fi
exec "$BASE/envs/vllm/bin/supervisord" -c "$BASE/config/supervisor/supervisord.conf"
