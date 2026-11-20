#!/usr/bin/env bash
set -euo pipefail
mountpoint -q /data
base=/data/hsbc
[[ -f "$base/app/package.json" && -f "$base/app/pnpm-lock.yaml" ]] || { echo 'Application source/lockfile not yet published'; exit 2; }
exec 9>"$base/run/app-build.lock"
flock -n 9 || { echo 'Another application build is running'; exit 1; }
# Preserve the previous outputs and a consistent DB/rules backup before pnpm can
# replace anything. packageManager in the committed repository pins pnpm.
release=$(python3 "$base/scripts/build-release.py" prepare)
trap 'status=$?; if (( status != 0 )); then echo "Build failed; previous outputs retained in $release" >&2; fi; exit "$status"' EXIT
NODE_IMAGE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["node_image"])' "$release/build.json")
mkdir -p "$base/cache/corepack" "$base/cache/pnpm"
chown -R hsbc:hsbc "$base/cache/corepack" "$base/cache/pnpm"
docker run --rm --user 10001:10001 --workdir /app \
  -e HOME=/tmp -e COREPACK_HOME=/cache/corepack -e COREPACK_DEFAULT_TO_LATEST=0 \
  -e COREPACK_ENABLE_PROJECT_SPEC=1 \
  -v "$base/app:/app" -v "$base/cache:/cache" \
  "$NODE_IMAGE" sh -eu -c 'corepack pnpm install --frozen-lockfile --store-dir /cache/pnpm && corepack pnpm build'
python3 "$base/scripts/build-release.py" complete "$release"
echo 'Application compiled; migrate with deployment identity before restarting runtime services'
