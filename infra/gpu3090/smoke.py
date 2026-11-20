"""Run real GPU API tests with synthetic inputs; never prints credentials."""
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

ROOT = Path("/data/hsbc")
results = []


def request(kind, route, payload=None, content_type="application/json", auth=True, expected=200):
    port = 6006 if kind == "ocr" else 6008
    headers = {"Content-Type": content_type}
    if auth:
        token = (ROOT / "secrets" / f"{kind}.token").read_text().strip()
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(f"http://127.0.0.1:{port}{route}", data=payload, headers=headers)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=300) as response:
            code, body = response.status, response.read()
    except urllib.error.HTTPError as exc:
        code, body = exc.code, exc.read()
    assert code == expected, f"{kind} {route}: expected {expected}, received {code}"
    results.append({"service": kind, "route": route, "authenticated": auth, "status": code,
                    "seconds": round(time.monotonic() - started, 3)})
    return json.loads(body)


for service in ["ocr", "ner"]:
    request(service, "/health/ready", auth=False, expected=401)
    assert request(service, "/health/ready")["status"] == "ready"
    request(service, "/health/live")

data = {"text": "Apple CEO Tim Cook announced iPhone 15 in Cupertino yesterday.",
        "labels": ["company", "person", "product", "location"]}
entities = request("ner", "/v1/entities", json.dumps(data).encode())["entities"]
assert any(item["text"] == "Tim Cook" for item in entities["person"])
assert any(item["text"] == "Cupertino" for item in entities["location"])
data = {"text": "张三在汇丰银行工作，公司位于上海。", "labels": ["人名", "公司", "地点"], "word_splitter": "char"}
entities = request("ner", "/v1/entities", json.dumps(data).encode())["entities"]
assert any(item["text"] == "张三" for item in entities["人名"])
assert any(item["text"] == "汇丰银行" for item in entities["公司"])
data = {"text": "DEMO INVOICE. Invoice number DEMO-001. Total amount USD 100.00.",
        "labels": ["invoice", "employment contract", "shipping document"]}
assert request("ner", "/v1/classify", json.dumps(data).encode())["label"]["label"] == "invoice"
request("ner", "/v1/entities", b'{"text":"","labels":["person"]}', expected=422)
data = {"text": "cat " * 4500, "labels": ["entity"]}
request("ner", "/v1/entities", json.dumps(data).encode(), expected=422)

boundary = "HSBC-SYNTHETIC-SMOKE-BOUNDARY"
raw = (ROOT / "app/gpu3090/synthetic-invoice.png").read_bytes()
multipart = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"demo.png\"\r\n"
             "Content-Type: image/png\r\n\r\n").encode() + raw + f"\r\n--{boundary}--\r\n".encode()
ocr = request("ocr", "/v1/ocr", multipart, f"multipart/form-data; boundary={boundary}")
text = json.dumps(ocr).upper()
assert "INVOICE" in text and "100" in text
assert any("INVOICE" in page["markdown"].upper() for page in ocr["pages"])
report = {"passed": True, "tests": results, "ocr_demo_markdown": [page["markdown"] for page in ocr["pages"]]}
(ROOT / "deploy/gpu3090-smoke.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
print(json.dumps(report, indent=2, ensure_ascii=False))
