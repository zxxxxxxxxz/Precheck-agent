#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} == 0 ]]
mountpoint -q /data
base=/data/hsbc
mkdir -p "$base"/{deploy,config/{nginx,opa,systemd},secrets/ssh,scripts,data/{postgres,redis},cache/pnpm,tmp,logs,backups,policies/releases,run} /data/docker /data/containerd
chmod 700 "$base/secrets" "$base/secrets/ssh" "$base/backups"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
apt-get update
apt-get -y -o Dpkg::Options::=--force-confold upgrade
apt-get install -y ca-certificates curl gnupg git jq openssl rsync python3 iproute2 acl unattended-upgrades
install -d -m 755 /etc/apt/keyrings
curl -fsSL --retry 3 https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc | grep -q 9DC858229FC7DD38854AE2D88D81803C0EBFCD88
cat > /etc/apt/sources.list.d/docker.sources <<'EOF'
Types: deb
URIs: https://mirrors.aliyun.com/docker-ce/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
curl -fsSL --retry 3 https://nginx.org/keys/nginx_signing.key -o "$base/tmp/nginx.key"
gpg --show-keys --with-colons "$base/tmp/nginx.key" | grep -q 573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62
gpg --batch --yes --dearmor -o /etc/apt/keyrings/nginx.gpg "$base/tmp/nginx.key"
echo 'deb [signed-by=/etc/apt/keyrings/nginx.gpg] https://nginx.org/packages/ubuntu noble nginx' > /etc/apt/sources.list.d/nginx.list
printf 'Package: nginx*\nPin: origin nginx.org\nPin-Priority: 900\n' > /etc/apt/preferences.d/99nginx
mkdir -p /etc/docker /etc/containerd /etc/systemd/system/{docker,containerd}.service.d
cat > "$base/config/docker-daemon.json" <<'EOF'
{"data-root":"/data/docker","registry-mirrors":["https://dockerproxy.net"],"log-driver":"local","log-opts":{"max-size":"20m","max-file":"3"},"live-restore":true}
EOF
install -m 644 "$base/config/docker-daemon.json" /etc/docker/daemon.json
cat > "$base/config/containerd.toml" <<'EOF'
version = 2
root = "/data/containerd"
state = "/run/containerd"
[grpc]
  address = "/run/containerd/containerd.sock"
EOF
install -m 644 "$base/config/containerd.toml" /etc/containerd/config.toml
for service in docker containerd; do
  cat > "$base/config/systemd/$service-data.conf" <<'EOF'
[Unit]
RequiresMountsFor=/data
[Service]
ExecStartPre=/usr/bin/mountpoint -q /data
EOF
  install -m 644 "$base/config/systemd/$service-data.conf" "/etc/systemd/system/$service.service.d/data.conf"
done
systemctl daemon-reload
apt-get update
docker_version=$(apt-cache madison docker-ce | awk '$3 ~ /^5:29\./ && !selected {print $3; selected=1}')
[[ -n "$docker_version" ]]
apt-get install -y -o Dpkg::Options::=--force-confold "docker-ce=$docker_version" "docker-ce-cli=$docker_version" containerd.io docker-buildx-plugin docker-compose-plugin nginx
systemctl enable --now docker containerd
id hsbc >/dev/null 2>&1 || useradd --uid 10001 --create-home --home-dir /data/hsbc/home --shell /bin/bash hsbc
id hsbc-tunnel >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin hsbc-tunnel
install -d -o hsbc -g hsbc "$base/cache/pnpm"
docker version --format '{{.Server.Version}}'
docker compose version
nginx -v
docker info --format '{{.DockerRootDir}}'
dpkg-query -W docker-ce docker-ce-cli containerd.io docker-compose-plugin nginx > "$base/deploy/host-packages.lock"

