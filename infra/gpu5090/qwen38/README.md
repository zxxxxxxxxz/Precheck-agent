# Qwen3.8-27B on the replacement RTX 5090

This profile serves text inference on `connect.bjb2.seetacloud.com:17348`,
instance `3e754898af-7a867124`. The 2026-11-13 deployment and application cutover
passed acceptance; see [status](deployment-status.json) and the
[release record](../../../docs/qwen38-5090-release-20261113.md).
The later [concurrency acceptance](../../../docs/qwen38-concurrency3-20261113.md)
raises the model endpoint limit to three active sequences. The application's
own serial queue remains unchanged by explicit user choice.

The data disk is an existing XFS mount at `/root/autodl-tmp`. Initial inspection
reported 50 GiB; after the authorized power cycle the platform reported 400 GiB.
This deployment did not resize or purchase storage. Never format it. `/data`
points to that mount and project files live below `/data/hsbc`.
Preserve the platform driver, CUDA, held libraries, Conda base and platform
services. `install-system.sh` upgrades stable Ubuntu 22.04 packages, excludes
`jammy-proposed`, pins any proposed GPU/kernel package changes to their installed
versions, saves before/after package inventories and installs Nginx.

Copy this profile's model lock to `deploy/model.lock.json`, the existing pinned
`../pylock.vllm.toml` to `deploy/pylock.vllm.toml`, this profile's shell/Python
scripts to `scripts/`, and the shared `download-wheels.py`, `configure-secrets.py`,
`verify.py`, `start.sh`, and `install-startup-hook.py` from the parent directory.
Use the parent Nginx and Supervisor configurations under `config/`.

Run system installation first, then `install-runtime.sh`. Runtime installation
uses an isolated Python 3.12.15 environment and the existing vLLM 0.31.0 lock.
Only the download subprocess sources AutoDL's `/etc/network_turbo`. Model
downloads fall back to direct Hugging Face and then `hf-mirror.com`, retaining
the exact revision and publisher SHA256 hashes, with at most three files in
flight. Serving is offline and clears
proxy variables. Each model process startup checks all file sizes and SHA256
hashes against the completed manifest. Reproducible installation caches are removed before model
download; the downloader requires the complete checkpoint plus 5 GiB free.

The checkpoint is `Inferact/Qwen3.8-27B-NVFP4` revision
`6128240ebaf4eaa7bad2b3d1c72c37d677c5f462`, exposed as `Qwen/Qwen3.8-27B`.
Settings: NVFP4 weights, BF16 computation/KV cache, 32768-token context, up to three
active sequences sharing KV capacity, 0.90 GPU memory utilization, language-model-only, eager execution,
Qwen reasoning/tool parsers, no speculative decoding. Quantization is carried
by the checkpoint configuration rather than an unrelated runtime preset.
First-use CUDA compilation is limited to two Ninja jobs and one NVCC thread per
job; the container exposes host CPU/RAM figures that can otherwise overcommit
its actual 16-vCPU / 90-GiB allocation.
Serving also overrides the platform startup environment's CPU math thread
counts to one, avoiding contention between small CPU operations and GPU work.

vLLM binds `127.0.0.1:8000`; the authenticated Nginx proxy binds
`127.0.0.1:6006`, exposed at
`https://u334749-98af-7a867124.bjb2.seetacloud.com:8443`. Port 6008 is unused.
All proxy routes, including health, require the private bearer token. API base
URLs append `/v1`. No credentials, prompts or generated text are written to
ordinary logs or acceptance reports.

After configuring authentication, validate Nginx, install the project startup
hook and run `start.sh`. Run the shared `verify.py --inference --model
Qwen/Qwen3.8-27B`, then this profile's capability acceptance before switching
application traffic. Application rollout must separately follow
`docs/release-validation.md`; preserve the previous hosted Qwen configuration
for an explicit deployment rollback, without runtime cloud fallback.

References: [AutoDL acceleration](https://www.autodl.com/docs/network_turbo/),
[vLLM single-5090 recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-27B).
