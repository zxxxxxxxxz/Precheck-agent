#!/usr/bin/env bash
set -euo pipefail
BASE=/data/hsbc
test "$(readlink -f /data)" = /root/autodl-tmp
mountpoint -q /root/autodl-tmp
export PATH="$BASE/envs/vllm/bin:/usr/local/cuda/bin:/usr/bin:/bin"
export CUDA_HOME=/usr/local/cuda CUDACXX=/usr/local/cuda/bin/nvcc
export HF_HOME="$BASE/cache/huggingface" XDG_CACHE_HOME="$BASE/cache/xdg"
export TORCH_HOME="$BASE/cache/torch" TMPDIR="$BASE/tmp"
export VLLM_CACHE_ROOT="$BASE/cache/vllm" CUDA_CACHE_PATH="$BASE/cache/cuda"
export FLASHINFER_WORKSPACE_BASE="$BASE/cache/flashinfer" TRITON_CACHE_DIR="$BASE/cache/triton"
export TORCHINDUCTOR_CACHE_DIR="$BASE/cache/torchinductor" TORCH_EXTENSIONS_DIR="$BASE/cache/torch-extensions"
export NUMBA_CACHE_DIR="$BASE/cache/numba"
export VLLM_NO_USAGE_STATS=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
MODEL_PATH=$(python -c 'import json; print(json.load(open("/data/hsbc/deploy/model.lock.json"))["local_path"])')
# The operational mode is changed only during a locked, drained canary. Missing
# mode files retain the established text-only deployment.
MODE=text
if [[ -f "$BASE/deploy/qwen-mode" ]]; then MODE=$(cat "$BASE/deploy/qwen-mode"); fi
case "$MODE" in
  text) MEDIA_ARGS=(--language-model-only) ;;
  vision)
    MEDIA_ARGS=(--limit-mm-per-prompt '{"image":1,"video":0}'
      --mm-processor-kwargs '{"max_pixels":1048576,"min_pixels":4096}'
      --mm-processor-cache-gb 0
      --allowed-media-domains image-download-disabled.invalid)
    ;;
  *) echo 'Invalid controlled Qwen mode' >&2; exit 1 ;;
esac
unset VLLM_MEDIA_CACHE
exec vllm serve "$MODEL_PATH" \
  --host 127.0.0.1 --port 8000 \
  --served-model-name Qwen/Qwen3.5-9B \
  --dtype bfloat16 --max-model-len 8192 --max-num-seqs 1 \
  --gpu-memory-utilization 0.85 "${MEDIA_ARGS[@]}" \
  --reasoning-parser qwen3 --enable-auto-tool-choice --tool-call-parser qwen3_coder \
  --no-enable-log-requests --no-enable-log-outputs --no-enable-log-deltas \
  --disable-uvicorn-access-log
