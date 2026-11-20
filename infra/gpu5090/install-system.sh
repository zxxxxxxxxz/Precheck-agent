#!/usr/bin/env bash
# Infrastructure packages only; preserve GPU driver, CUDA and Miniconda base.
set -euo pipefail
BASE=/data/hsbc
if [ ! -e /data ]; then ln -s /root/autodl-tmp /data; fi
test "$(readlink -f /data)" = /root/autodl-tmp
mountpoint -q /root/autodl-tmp
mkdir -p "$BASE/logs" "$BASE/config/nginx" /etc/apt/preferences.d
printf '%s\n' 'Package: *' 'Pin: release a=jammy-proposed' 'Pin-Priority: -1' > /etc/apt/preferences.d/hsbc-no-proposed
apt-get update
apt-get -s upgrade > "$BASE/logs/apt-upgrade-preview.log"
if grep -E '^Inst (cuda|nvidia|linux-image)' "$BASE/logs/apt-upgrade-preview.log"; then
    echo 'Refusing upgrade that would change the platform GPU or kernel packages.' >&2
    exit 1
fi
export RUNLEVEL=1 DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
apt-get -y --no-remove -o Dpkg::Options::=--force-confold upgrade
apt-get install -y --no-install-recommends ca-certificates curl gnupg iproute2 openssl aria2
curl -fsS https://nginx.org/keys/nginx_signing.key -o "$BASE/config/nginx/nginx_signing.key"
gpg --dearmor --batch --yes -o /usr/share/keyrings/nginx-archive-keyring.gpg "$BASE/config/nginx/nginx_signing.key"
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] https://nginx.org/packages/ubuntu jammy nginx' > /etc/apt/sources.list.d/hsbc-nginx.list
apt-get update
apt-get install -y nginx=1.30.5-1~jammy
mkdir -p "$BASE/tmp/nginx-client" "$BASE/tmp/nginx-proxy"
chown nobody:nogroup "$BASE/tmp/nginx-client" "$BASE/tmp/nginx-proxy"
