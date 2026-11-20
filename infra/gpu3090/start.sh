#!/usr/bin/env bash
set -euo pipefail
umask 077
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
test "$(readlink -f /data)" = /root/autodl-tmp
mountpoint -q /root/autodl-tmp
test -x /data/hsbc/envs/ocr/bin/python
test -x /data/hsbc/envs/ner/bin/python
conf=/data/hsbc/config/supervisor/gpu3090.conf
chmod 700 /data/hsbc/run
exec 9>/data/hsbc/run/start-gpu3090.lock
flock -x 9
/usr/sbin/nginx -t -c /data/hsbc/config/nginx/gpu3090.conf
if [[ -S /data/hsbc/run/supervisor3090.sock && -s /data/hsbc/run/supervisor3090.pid ]] &&
   kill -0 "$(cat /data/hsbc/run/supervisor3090.pid)" 2>/dev/null; then
    /usr/bin/supervisord ctl -s unix:///data/hsbc/run/supervisor3090.sock start all >/dev/null 2>&1 || true
    exit 0
fi
/usr/bin/supervisord -d -c "$conf" 9>&-
