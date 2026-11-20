#!/usr/bin/env bash
# Only for the explicitly approved, empty 100 GiB APP data disk.
set -euo pipefail
[[ ${EUID} == 0 ]] || exit 1
if mountpoint -q /data; then
  [[ $(findmnt -n -o SOURCE /data) == /dev/vdb ]] || { echo 'Unexpected /data source'; exit 1; }
  exit 0
fi
[[ $(blockdev --getsize64 /dev/vdb) == 107374182400 ]]
[[ $(lsblk -nr -o NAME /dev/vdb | wc -l) == 1 ]]
[[ -z $(wipefs --no-act --noheadings /dev/vdb) ]]
[[ -z $(findmnt -rn -S /dev/vdb) ]]
python3 - <<'PY'
import os
with open('/dev/vdb', 'rb', buffering=0) as f:
    for off in (0, 107374182400-1048576):
        f.seek(off)
        if any(f.read(1048576)):
            raise SystemExit('Disk contains nonzero boundary data; refusing initialization')
if os.path.exists('/data') and os.listdir('/data'):
    raise SystemExit('/data is not empty')
PY
mkfs.ext4 -L hsbc-data -m 1 /dev/vdb
mkdir -p /data
disk_uuid=$(blkid -s UUID -o value /dev/vdb)
cp -a /etc/fstab /etc/fstab.pre-hsbc
printf 'UUID=%s /data ext4 defaults,nofail 0 2\n' "$disk_uuid" >> /etc/fstab
systemctl daemon-reload
mount /data
mountpoint -q /data
findmnt /data

