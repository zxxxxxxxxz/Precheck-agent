# AutoDL RTX 5090 model host

The active replacement host was deployed on 2026-11-13 using the
[Qwen3.8-27B profile](qwen38/README.md); see its
[release and acceptance record](../../docs/qwen38-5090-release-20261113.md).
The Qwen3.5-9B instructions and observations below retain the earlier deployment.

Deploys shared `Qwen/Qwen3.5-9B` inference; contains no business application or Agent implementation.

Observed on 2026-10-12: Python 3.12.15, vLLM 0.31.0, Torch 2.13.0+cu130, Nginx 1.30.5 and dedicated Supervisor 4.3.0 are running. All four weight shards passed SHA256 checks for revision `c202236235762e1c871ad0ccb60c8ee5ba337b9a`. The 17 local acceptance checks passed, including two real synthetic generations and a request larger than the default Nginx body buffer. GPU memory after warmup/inference was 26,029 MiB of 32,607 MiB; the requested BF16/8192/concurrency-1/0.85 settings were retained.

## Layout and reproducible installation

The existing AutoDL data disk remains `/root/autodl-tmp`; `/data` points to it. Everything belonging to the project lives under `/data/hsbc`. Preserve the platform driver, CUDA installation, Miniconda base, Jupyter, TensorBoard, and platform supervisor.

Copy the shell/Python files to `/data/hsbc/scripts`, `nginx.conf` to `/data/hsbc/config/nginx/nginx.conf`, `supervisord.conf` to `/data/hsbc/config/supervisor/supervisord.conf`, and the dependency/model locks to `/data/hsbc/deploy/pylock.vllm.toml` and `/data/hsbc/deploy/model.lock.json`.

Run in order as the instance administrator:

```sh
bash /data/hsbc/scripts/install-system.sh
bash /data/hsbc/scripts/install-runtime.sh
chmod 750 /data/hsbc/scripts/*.sh
/usr/sbin/nginx -t -c /data/hsbc/config/nginx/nginx.conf
/data/hsbc/envs/vllm/bin/python /data/hsbc/scripts/install-startup-hook.py
/data/hsbc/scripts/start.sh
```

The stable OS upgrade refuses GPU/kernel package changes and excludes Ubuntu `proposed`. New Python 3.12 and vLLM dependencies install into a dedicated Conda prefix, never into base. Exact compatible wheel URLs and SHA256 hashes are retained in the lock. Large dependency and model transfers run sequentially because concurrent model transfers saturated the instance's observed download bandwidth.

The official Hugging Face model revision is pinned in `deploy/model.lock.json`; fresh installations also default to the checked-in revision. Metadata/tokenizer are fetched from that revision; the publisher's domestic ModelScope weight files are accepted only when size and SHA256 match that revision's LFS metadata. Old revisions fall back to their immutable Hugging Face source. Startup refuses an incomplete download.

## Service interface

- vLLM binds only `127.0.0.1:8000`; BF16, 8192-token context, one active sequence, GPU memory target 0.85, text-only inference.
- Nginx binds only `127.0.0.1:6006`, exposed by the existing AutoDL HTTPS mapping. Port 6008 remains unused.
- All paths require a case-sensitive `Authorization: Bearer ...` header, including health and unknown paths. The credential is generated remotely at `/data/hsbc/secrets/qwen-api.token` with mode `0600`; never place it in Git, logs, or a URL.
- Allowed paths: `GET /health/live`, `GET /health/ready`, `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/completions`. Other authenticated paths return 404. Query strings are rejected.
- `/health/live` checks the proxy; `/health/ready` checks the loaded model engine. A running supervisor process alone is insufficient readiness evidence.
- Request bodies/headers and full query strings are excluded from access logs. Supervisor rotates model/proxy logs. Download acceleration is used only during downloads; serving runs offline without proxy environment variables.

## Operations and acceptance

```sh
/data/hsbc/envs/vllm/bin/supervisorctl -c /data/hsbc/config/supervisor/supervisord.conf status
/data/hsbc/envs/vllm/bin/python /data/hsbc/scripts/verify.py --inference
```

`verify.py` checks absent/invalid/case-mutated credentials, protected health endpoints, denied administrative paths, exact served model, and a real synthetic generation. It never prints the credential or model output. Use its `--base-url` and `--token-file` arguments to run the same checks from APP against the HTTPS mapping.

AutoDL invokes `/etc/autodl.sh`; the installer appends only the project start hook and preserves any prior contents. The project uses its own Python Supervisor and socket, independent of the platform's Go supervisor. A full instance power-cycle is deliberately not performed during installation and remains a separate acceptance check.

The remote `deploy` directory contains the model revision, package versions, and acceptance results. See `deployment-status.json` in this directory for the actual observed deployment outcome; unperformed checks must remain explicitly pending.

## Measured generation throughput

On 2026-10-12, fixed-length synthetic streaming tests measured a highest formal-run decode rate of **95.86 output tokens/s** under the existing BF16 / `max-num-seqs=1` configuration. Short-input single-request median was **95.69 TPS** locally and **95.68 TPS** from APP over HTTPS; APP end-to-end output speed was **94.50 TPS**. Increasing client concurrency to 2 or 4 left aggregate throughput near **94.5 TPS** because the server admits one active sequence. This does not measure the maximum obtainable after batch or precision tuning.

The test did not change service settings or restart the server. See the [full test report and per-request evidence](../evidence/tps-20261012/README.md) and [bounded benchmark script](benchmark-tps.py). Generate fresh synthetic fixtures before each run to avoid reusing cached prefixes.

## Optional signature vision

The default remains text-only. See [the controlled vision canary](VISION-CANARY.md) for the bounded private image interface, shared text-priority admission, opt-in runtime mode, capacity/text acceptance and rollback. Historical deployment evidence above is unchanged and does not establish a vision pass.
