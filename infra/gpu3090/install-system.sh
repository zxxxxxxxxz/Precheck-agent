#!/usr/bin/env bash
# Apply supported Ubuntu updates without replacing AutoDL's GPU/platform stack.
set -euo pipefail
export LC_ALL=C DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l RUNLEVEL=1
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
mountpoint -q /root/autodl-tmp
test "$(readlink -f /data)" = /root/autodl-tmp
base=/data/hsbc
mkdir -p "$base/deploy" "$base/logs" "$base/config/apt"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
evidence="$base/deploy/os-upgrade-$stamp"
mkdir -p "$evidence"
dpkg-query -W -f='${binary:Package}\t${Version}\n' > "$evidence/packages-before.tsv"
apt-mark showhold > "$evidence/holds-before.txt"
sha256sum /usr/bin/supervisord /root/miniconda3/bin/python > "$evidence/platform-before.sha256"

# The AutoDL image enables proposed; only supported security/updates are allowed.
printf 'Package: *\nPin: release a=jammy-proposed\nPin-Priority: -1\n' > "$base/config/apt/no-proposed.pref"
install -m 644 "$base/config/apt/no-proposed.pref" /etc/apt/preferences.d/hsbc-no-proposed
protected='^(cuda|nvidia|libnvidia|libcuda|libcudnn|libcublas|libcufft|libcurand|libcusolver|libcusparse|libcupti|libnv|libnccl|libxnvctrl|nsight|linux-image|linux-headers|linux-modules|autodl|supervisor|conda)'
dpkg-query -W -f='${binary:Package}\n' | grep -Ei "$protected" > "$evidence/protected-packages.txt" || true
if [[ -s "$evidence/protected-packages.txt" ]]; then
    xargs -r apt-mark hold < "$evidence/protected-packages.txt" > "$evidence/new-holds.txt"
fi

# Existing AutoDL container policy prevents package scripts from restarting SSH,
# platform processes, or the model proxy. Do not replace a different local policy.
test -x /usr/sbin/policy-rc.d
policy_rc=0
/usr/sbin/policy-rc.d nginx restart || policy_rc=$?
test "$policy_rc" = 101
apt-get update > "$evidence/apt-update.log" 2>&1
apt-get -s --no-remove upgrade > "$evidence/upgrade-plan.txt"
if grep -E "^Inst ${protected#^}" "$evidence/upgrade-plan.txt"; then
    echo 'Refusing a protected package change; review the recorded upgrade plan.' >&2
    exit 1
fi
apt-get -y --no-remove -o Dpkg::Options::=--force-confold upgrade > "$evidence/upgrade.log" 2>&1
dpkg-query -W -f='${binary:Package}\t${Version}\n' > "$evidence/packages-after.tsv"
apt-mark showhold > "$evidence/holds-after.txt"
sha256sum /usr/bin/supervisord /root/miniconda3/bin/python > "$evidence/platform-after.sha256"
cmp "$evidence/platform-before.sha256" "$evidence/platform-after.sha256"
apt-get -s --no-remove upgrade > "$evidence/remaining-plan.txt"
printf '%s\n' "$evidence" > "$base/deploy/os-upgrade-latest.txt"
echo "Completed supported OS updates; evidence: $evidence"
