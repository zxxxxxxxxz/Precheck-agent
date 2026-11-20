#!/usr/bin/env bash
set -euo pipefail

# Project-local entry point: never change the user's default Node installation.
candidate="${P0_NODE_BIN:-/opt/homebrew/opt/node@24/bin/node}"
if [[ ! -x "$candidate" ]]; then
  echo 'Node 24.19.0 not found. Set P0_NODE_BIN to its absolute executable path.' >&2
  exit 1
fi
runtime_version="$("$candidate" --version)"
# Explicit local compatibility checks may use another Node 24 release.
if [[ "$runtime_version" != 'v24.19.0' && !( "${P0_ALLOW_NODE24_COMPAT:-false}" == 'true' && "$runtime_version" == v24.* ) ]]; then
  echo 'P0 requires Node 24.19.0. Refusing to use a different runtime.' >&2
  exit 1
fi
export PATH="$(dirname "$candidate"):$PATH"
if [[ "${1:-}" == '--pnpm' ]]; then
  shift
  if [[ "$(pnpm --version)" != '10.28.0' ]]; then
    echo 'P0 requires pnpm 10.28.0.' >&2
    exit 1
  fi
  exec pnpm "$@"
fi
exec "$candidate" "$@"
