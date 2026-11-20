#!/usr/bin/env bash
# Forced command on the APP's restricted authorized_keys entry.
set -euo pipefail
if [[ ${SSH_ORIGINAL_COMMAND:-} != hsbc-bootstrap ]]; then
    printf 'Command not permitted.\n' >&2
    exit 126
fi
exec /bin/bash /data/hsbc/scripts/start-gpu3090.sh
