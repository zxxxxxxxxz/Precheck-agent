#!/usr/bin/env bash
# Run on the 3090 only. Does not change the platform Conda base or GPU driver.
set -euo pipefail
cd -- "$(dirname -- "$0")"
mountpoint -q /root/autodl-tmp
if [[ ! -e /data ]]; then ln -s /root/autodl-tmp /data; fi
test "$(readlink -f /data)" = /root/autodl-tmp
base=/data/hsbc
mkdir -p "$base"/{app/gpu3090,deploy,config/nginx,config/supervisor,secrets,scripts,envs,models,run,tmp,logs,cache/pip,cache/conda,cache/huggingface}
chmod 700 "$base/secrets"
export CONDA_PKGS_DIRS="$base/cache/conda" PIP_CACHE_DIR="$base/cache/pip" TMPDIR="$base/tmp"
bash ./install-system.sh
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nginx libgl1 libglib2.0-0 curl ca-certificates aria2
for env in ner ocr; do
    if [[ ! -x "$base/envs/$env/bin/python" ]]; then
        /root/miniconda3/bin/conda create -y -p "$base/envs/$env" --file "$env-conda-explicit.lock.txt"
    fi
done
"$base/envs/ocr/bin/python" -m pip install paddlepaddle-gpu==3.2.1 -i https://www.paddlepaddle.org.cn/packages/stable/cu126/
"$base/envs/ocr/bin/python" -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r ocr-requirements.lock.txt
"$base/envs/ner/bin/python" -m pip install -i https://pypi.org/simple -r ner-requirements.lock.txt
install -m 644 service.py ocr_contract.py ner_contract.py ppocr_smoke.py download_ner.py "$base/app/gpu3090/"
install -m 644 nginx.conf "$base/config/nginx/gpu3090.conf"
install -m 644 supervisord.conf "$base/config/supervisor/gpu3090.conf"
install -m 755 start.sh "$base/scripts/start-gpu3090.sh"
install -m 755 tunnel-bootstrap.sh "$base/scripts/tunnel-bootstrap.sh"
install -m 644 prepare_ocr.py download_ppocr.py smoke.py recovery.py record_versions.py verify_deployment.py "$base/scripts/"
install -m 755 install-system.sh "$base/scripts/install-system-gpu3090.sh"
install -m 644 ocr-model-artifacts.lock.json "$base/deploy/ocr-model-artifacts.lock.json"
install -m 644 ppocr-model-artifacts.lock.json "$base/deploy/ppocr-model-artifacts.lock.json"
install -m 644 ner-model-artifacts.lock.json "$base/deploy/ner-model-artifacts.lock.json"
"$base/envs/ner/bin/python" - <<'PY'
from pathlib import Path
import secrets
for kind in ['ocr','ner']:
    path = Path('/data/hsbc/secrets') / f'{kind}.token'
    if not path.exists():
        path.write_text(secrets.token_urlsafe(48)+'\n')
    path.chmod(0o600)
PY
# Do not inherit download proxy settings into any serving process.
(
    source /etc/network_turbo >/dev/null
    "$base/envs/ner/bin/python" "$base/app/gpu3090/download_ner.py"
)
"$base/envs/ocr/bin/python" "$base/scripts/prepare_ocr.py"
"$base/envs/ocr/bin/python" "$base/scripts/download_ppocr.py"
"$base/envs/ocr/bin/python" - <<'PY'
from PIL import Image, ImageDraw
image=Image.new('RGB',(1000,400),'white')
draw=ImageDraw.Draw(image)
draw.text((60,50),'DEMO INVOICE\nInvoice number: DEMO-001\nTotal: USD 100.00',fill='black',font_size=28)
image.save('/data/hsbc/app/gpu3090/synthetic-invoice.png')
PY
"$base/envs/ner/bin/python" -m pip freeze > "$base/deploy/ner-requirements.lock.txt"
"$base/envs/ocr/bin/python" -m pip freeze > "$base/deploy/ocr-requirements.lock.txt"
"$base/envs/ner/bin/python" "$base/scripts/record_versions.py"
"$base/scripts/start-gpu3090.sh"
