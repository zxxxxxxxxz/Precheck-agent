#!/usr/bin/env bash
set -euo pipefail
mountpoint -q /data
cd /data/hsbc/deploy
args=(--env-file .env -f compose.yaml)
if [[ -f compose.opa-loads.json ]]; then
  args+=(-f compose.opa-loads.json)
fi
if [[ -f compose.remote-db.yaml ]]; then
  args+=(--env-file remote-db.env -f compose.remote-db.yaml)
fi
if [[ -f compose.p1.yaml && -f p1-release.env ]]; then
  args+=(--env-file p1-release.env -f compose.p1.yaml)
fi
if [[ -f compose.docx.yaml ]]; then
  [[ -f docx-runtime.env && -f docx-seccomp.json ]]
  args+=(--env-file docx-runtime.env -f compose.docx.yaml)
fi
exec docker compose "${args[@]}" "$@"

