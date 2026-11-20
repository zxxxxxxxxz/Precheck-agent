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
# FlashInfer/Ninja can observe host CPU/RAM instead of the container limits.
# Keep first-use CUDA compilation bounded on the 16-vCPU / 90-GiB instance.
export MAX_JOBS=2 FLASHINFER_NVCC_THREADS=1 CMAKE_BUILD_PARALLEL_LEVEL=2
export TORCHINDUCTOR_COMPILE_THREADS=1
export OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
export VLLM_NO_USAGE_STATS=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
MODEL_PATH=$(python "$BASE/scripts/check-weights.py")
exec vllm serve "$MODEL_PATH" \
  --host 127.0.0.1 --port 8000 --served-model-name Qwen/Qwen3.8-27B \
  --dtype bfloat16 --kv-cache-dtype auto --max-model-len 32768 --max-num-seqs 3 \
  --gpu-memory-utilization 0.90 --language-model-only --enforce-eager \
  --reasoning-parser qwen3 --enable-auto-tool-choice --tool-call-parser qwen3_coder \
  --no-enable-log-requests --no-enable-log-outputs --no-enable-log-deltas \
  --disable-uvicorn-access-log
