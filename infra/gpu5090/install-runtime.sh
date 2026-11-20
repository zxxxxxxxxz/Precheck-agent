#!/usr/bin/env bash
# Run on the authorized AutoDL 5090 instance. Never modifies Miniconda base/driver.
set -euo pipefail
BASE=/data/hsbc
if [ ! -e /data ]; then ln -s /root/autodl-tmp /data; fi
test "$(readlink -f /data)" = /root/autodl-tmp
mountpoint -q /root/autodl-tmp
mkdir -p "$BASE"/{deploy,config/nginx,config/supervisor,scripts,secrets,envs,models,run,logs,tmp,cache/{conda,pip,uv,huggingface,torch,xdg}}
chmod 700 "$BASE/secrets"
export CONDA_PKGS_DIRS="$BASE/cache/conda" PIP_CACHE_DIR="$BASE/cache/pip"
export UV_CACHE_DIR="$BASE/cache/uv" TMPDIR="$BASE/tmp" UV_HTTP_TIMEOUT=300 UV_CONCURRENT_DOWNLOADS=4
if [ ! -x "$BASE/envs/vllm/bin/python" ]; then
    /root/miniconda3/bin/conda create -y -p "$BASE/envs/vllm" python=3.12.15 pip \
      --override-channels -c https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main/
fi
"$BASE/envs/vllm/bin/python" -m pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple uv==0.13.0
if [ ! -f "$BASE/deploy/pylock.vllm.toml" ]; then
    printf '%s\n' 'vllm==0.31.0' 'supervisor==4.3.0' > "$BASE/deploy/vllm-requirements.in"
    "$BASE/envs/vllm/bin/uv" pip compile --python "$BASE/envs/vllm/bin/python" \
      --index-url https://pypi.tuna.tsinghua.edu.cn/simple --format pylock.toml \
      --output-file "$BASE/deploy/pylock.vllm.toml" "$BASE/deploy/vllm-requirements.in"
fi
# Sequential stages avoid large model transfers starving package downloads.
"$BASE/envs/vllm/bin/python" "$BASE/scripts/download-wheels.py"
"$BASE/envs/vllm/bin/uv" pip install --python "$BASE/envs/vllm/bin/python" \
  --no-index --find-links "$BASE/cache/wheels" --require-hashes -r "$BASE/deploy/wheels.lock.txt"
"$BASE/envs/vllm/bin/python" -m pip freeze > "$BASE/deploy/vllm-requirements.lock.txt"
# Download acceleration is confined to this subshell and never reaches service env.
(
  source /etc/network_turbo >/dev/null 2>&1
  export HF_HOME="$BASE/cache/huggingface" HF_HUB_DOWNLOAD_TIMEOUT=300 HF_HUB_DISABLE_XET=1
  "$BASE/envs/vllm/bin/python" "$BASE/scripts/download-model.py"
)
"$BASE/envs/vllm/bin/python" "$BASE/scripts/configure-secrets.py"
