#!/usr/bin/env bash
set -euo pipefail
umask 027
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
mountpoint -q /root/autodl-tmp
if [ ! -e /data ]; then ln -s /root/autodl-tmp /data; fi
test "$(readlink -f /data)" = /root/autodl-tmp
BASE=/data/hsbc
mkdir -p "$BASE"/{deploy,config/nginx,config/supervisor,scripts,secrets,envs,models,run,logs,tmp,cache/{conda,pip,uv,wheels,huggingface,torch,xdg}}
chmod 700 "$BASE/secrets"
RUN="$BASE/deploy/system-upgrade-20261113"
mkdir -p "$RUN"
if [ ! -f "$RUN/packages-before.tsv" ]; then
  dpkg-query -W -f='${Package}\t${Version}\n' > "$RUN/packages-before.tsv"
  apt-mark showhold > "$RUN/holds-before.txt"
  cp -a /etc/apt "$RUN/apt-before"
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader > "$RUN/gpu-before.txt"
fi
printf '%s\n' 'Package: *' 'Pin: release a=jammy-proposed' 'Pin-Priority: -1' > /etc/apt/preferences.d/hsbc-no-proposed
sed -i '/^[[:space:]]*deb.*jammy-proposed/s/^/# Disabled for stable deployment: /' /etc/apt/sources.list
export RUNLEVEL=1 DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
apt-get update > "$RUN/apt-update.log" 2>&1
apt-get -s upgrade > "$RUN/upgrade-preview.log" 2>&1
if grep -E '^Inst (cuda|nvidia|libcuda|libcublas|libcudnn|libnccl|linux-|nsight)' "$RUN/upgrade-preview.log" > "$RUN/protected-changes.txt"; then
  : > /etc/apt/preferences.d/hsbc-preserve-platform
  while read -r _ package _; do
    version=$(dpkg-query -W -f='${Version}' "$package")
    printf 'Package: %s\nPin: version %s\nPin-Priority: 1001\n\n' "$package" "$version" >> /etc/apt/preferences.d/hsbc-preserve-platform
  done < "$RUN/protected-changes.txt"
  apt-get -s upgrade > "$RUN/upgrade-filtered-preview.log" 2>&1
  if grep -Eq '^Inst (cuda|nvidia|libcuda|libcublas|libcudnn|libnccl|linux-|nsight)' "$RUN/upgrade-filtered-preview.log"; then
    echo 'Protected platform packages remain in the upgrade; stopped.' >&2
    exit 12
  fi
fi
apt-get -y --no-remove -o Dpkg::Options::=--force-confold upgrade > "$RUN/upgrade.log" 2>&1
apt-get install -y --no-install-recommends ca-certificates curl gnupg iproute2 openssl aria2 > "$RUN/tools-install.log" 2>&1
curl -fsS https://nginx.org/keys/nginx_signing.key -o "$BASE/config/nginx/nginx_signing.key"
gpg --dearmor --batch --yes -o /usr/share/keyrings/nginx-archive-keyring.gpg "$BASE/config/nginx/nginx_signing.key"
chmod 644 /usr/share/keyrings/nginx-archive-keyring.gpg
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] https://nginx.org/packages/ubuntu jammy nginx' > /etc/apt/sources.list.d/hsbc-nginx.list
apt-get update > "$RUN/nginx-update.log" 2>&1
apt-get install -y nginx=1.30.5-1~jammy > "$RUN/nginx-install.log" 2>&1
mkdir -p "$BASE/tmp/nginx-client" "$BASE/tmp/nginx-proxy"
chown nobody:nogroup "$BASE/tmp/nginx-client" "$BASE/tmp/nginx-proxy"
dpkg-query -W -f='${Package}\t${Version}\n' > "$RUN/packages-after.tsv"
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader > "$RUN/gpu-after.txt"
cmp "$RUN/gpu-before.txt" "$RUN/gpu-after.txt"
apt-mark showhold > "$RUN/holds-after.txt"
cmp "$RUN/holds-before.txt" "$RUN/holds-after.txt"
/root/miniconda3/bin/python - "$RUN" <<'PY'
import json,pathlib,sys,datetime
p=pathlib.Path(sys.argv[1])
def packages(name):return dict(x.split('\t',1) for x in (p/name).read_text().splitlines())
before=packages('packages-before.tsv');after=packages('packages-after.tsv')
out={'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'upgraded':[{'package':k,'before':before[k],'after':v} for k,v in after.items() if k in before and before[k]!=v],'installed':[k for k in after if k not in before],'driver_unchanged':True,'existing_holds_preserved':True,'ubuntu_release':'22.04','proposed_disabled':True}
(p/'result.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({'status':'completed','upgraded_count':len(out['upgraded']),'installed_count':len(out['installed']),'driver_unchanged':True,'existing_holds_preserved':True}))
PY
