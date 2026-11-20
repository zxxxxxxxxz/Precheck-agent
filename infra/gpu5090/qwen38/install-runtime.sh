#!/usr/bin/env bash
set -euo pipefail
BASE=/data/hsbc
test "$(readlink -f /data)" = /root/autodl-tmp
mountpoint -q /root/autodl-tmp
export CONDA_PKGS_DIRS="$BASE/cache/conda" PIP_CACHE_DIR="$BASE/cache/pip"
export UV_CACHE_DIR="$BASE/cache/uv" TMPDIR="$BASE/tmp" UV_HTTP_TIMEOUT=300
export PIP_CONFIG_FILE=/dev/null
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
if [ ! -x "$BASE/envs/vllm/bin/python" ]; then
  /root/miniconda3/bin/conda create -y -p "$BASE/envs/vllm" python=3.12.15 pip \
    --override-channels -c https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main/
fi
"$BASE/envs/vllm/bin/python" -m pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple uv==0.13.0
"$BASE/envs/vllm/bin/python" "$BASE/scripts/download-wheels.py"
"$BASE/envs/vllm/bin/uv" pip install --python "$BASE/envs/vllm/bin/python" \
  --no-cache --no-index --find-links "$BASE/cache/wheels" --require-hashes -r "$BASE/deploy/wheels.lock.txt"
"$BASE/envs/vllm/bin/python" -m pip check
"$BASE/envs/vllm/bin/python" -m pip freeze > "$BASE/deploy/vllm-requirements.lock.txt"
# Remove only this fresh deployment's reproducible wheel archives after installation.
"$BASE/envs/vllm/bin/python" - <<'PY'
from pathlib import Path
import shutil
base=Path('/data/hsbc/cache')
for name in ('wheels', 'pip', 'uv', 'conda'):
    path=base/name
    if path.is_dir():
        shutil.rmtree(path)
    path.mkdir()
PY
(
  source /etc/network_turbo >/dev/null 2>&1
  "$BASE/envs/vllm/bin/python" "$BASE/scripts/download-model.py"
)
"$BASE/envs/vllm/bin/python" "$BASE/scripts/configure-secrets.py"
