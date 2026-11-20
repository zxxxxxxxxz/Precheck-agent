"""Sequential real-HTTP acceptance using only generated, nonbusiness images.

Only synthetic inputs and their OCR responses may be persisted by this script.
Credentials, response bodies and recognized text are never printed in summaries.
"""

import argparse
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time

from PIL import Image, ImageDraw, ImageFont
import requests

from ocr_contract import normalize_word_result


def now():
    return datetime.now(timezone.utc).isoformat()


def private_write(path, data):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(data)


def write_json(path, value):
    private_write(path, (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode())


class GPUSampler:
    def __init__(self):
        self.stop = threading.Event()
        self.samples = []
        self.errors = 0
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop.is_set():
            started = time.monotonic()
            try:
                output = subprocess.run(
                    ["nvidia-smi", "--id=0", "--query-gpu=memory.used,memory.free", "--format=csv,noheader,nounits"],
                    capture_output=True, text=True, timeout=5, check=True,
                ).stdout.strip()
                used, free = (int(value.strip()) for value in output.split(","))
                self.samples.append({"at": now(), "used_mib": used, "free_mib": free})
            except Exception:
                self.errors += 1
            self.stop.wait(max(0, 0.2 - (time.monotonic() - started)))

    def finish(self):
        self.stop.set()
        self.thread.join(timeout=6)
        values = self.samples
        return {
            "gpu_index": 0, "scope": "all_gpu_processes", "requested_interval_seconds": 0.2,
            "samples": len(values), "sampling_errors": self.errors,
            "min_used_mib": min((v["used_mib"] for v in values), default=None),
            "max_used_mib": max((v["used_mib"] for v in values), default=None),
            "min_free_mib": min((v["free_mib"] for v in values), default=None),
            "max_free_mib": max((v["free_mib"] for v in values), default=None),
            "first_at": values[0]["at"] if values else None,
            "last_at": values[-1]["at"] if values else None,
        }


def synthetic_images(directory):
    font_path = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"
    images = {}
    for name, size, lines, font_size, x, y, spacing in (
        ("mixed", (1000, 700), ["DEMO INVOICE", "Invoice number DEMO 001", "支付金额 人民币 100.00", "Total USD 100.00"], 38, 70, 70, 110),
        ("blank", (1000, 700), [], 38, 70, 70, 110),
        ("large", (2000, 2800), [f"DEMO Item {i:02d} 金额 人民币 100.00" for i in range(1, 11)], 58, 100, 150, 235),
    ):
        image = Image.new("RGB", size, "white")
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype(font_path, font_size)
        for index, line in enumerate(lines):
            draw.text((x, y + index * spacing), line, font=font, fill="black")
        stream = io.BytesIO()
        image.save(stream, format="PNG")
        data = stream.getvalue()
        path = directory / f"{name}.png"
        private_write(path, data)
        images[name] = {"bytes": data, "size": size, "path": str(path)}
    return images


def check(condition, code):
    if not condition:
        raise ValueError(code)


def inspect_response(body, size, want_words, expect_blank=False, expect_chinese=False):
    check(isinstance(body, dict), "response_not_object")
    pages = body.get("pages")
    check(isinstance(pages, list) and len(pages) == 1, "page_count")
    page = pages[0]
    check(isinstance(page, dict) and isinstance(page.get("result"), dict), "missing_vl_result")
    check(isinstance(page.get("markdown"), str), "missing_vl_markdown")
    res = page["result"].get("res", page["result"])
    check(isinstance(res, dict), "invalid_vl_result")
    blocks = res.get("parsing_res_list", [])
    check(isinstance(blocks, list), "invalid_vl_blocks")
    summary = {"page_count": len(pages), "block_count": len(blocks), "word_units": 0,
               "chinese_characters": 0, "latin_units": 0, "nonempty_lines": 0}
    if not want_words:
        check("word_ocr" not in page, "unexpected_word_ocr")
        return summary, None
    word = page.get("word_ocr")
    check(isinstance(word, dict), "missing_word_ocr")
    normalized = normalize_word_result(word, *size)
    for key in ("model", "detector", "recognizer", "coordinate_system", "width", "height", "granularity", "method"):
        check(word.get(key) == normalized[key], "word_metadata_mismatch")
    units = [unit for line in normalized["text_word"] for unit in line]
    summary.update(
        word_units=len(units), chinese_characters=sum(len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]", unit)) for unit in units),
        latin_units=sum(bool(re.search(r"[A-Za-z]", unit)) for unit in units),
        nonempty_lines=sum(bool(line.strip()) for line in normalized["rec_texts"]),
        lines_with_multiple_units=sum(sum(bool(unit.strip()) for unit in line) > 1 for line in normalized["text_word"]),
    )
    width, height = size
    polygons = list(normalized["rec_polys"]) + [poly for line in normalized["text_word_region"] for poly in line]
    for polygon in polygons:
        for x, y in polygon:
            check(-2 <= x <= width + 2 and -2 <= y <= height + 2, "sample_polygon_out_of_bounds")
    for line in normalized["text_word_boxes"]:
        for x1, y1, x2, y2 in line:
            check(-2 <= x1 <= x2 <= width + 2 and -2 <= y1 <= y2 <= height + 2, "sample_box_out_of_bounds")
    if expect_blank:
        check(not units and summary["nonempty_lines"] == 0, "blank_has_text")
    else:
        check(summary["word_units"] > 0 and summary["nonempty_lines"] > 0, "missing_word_units")
        check(all(sum(bool(unit.strip()) for unit in line) > 1
                  for text, line in zip(normalized["rec_texts"], normalized["text_word"]) if text.strip()),
              "missing_multiple_units_per_line")
    if expect_chinese:
        check(summary["latin_units"] > 0 and summary["chinese_characters"] > 0, "missing_mixed_language_units")
    return summary, normalized


def save_visualization(image_data, word, path):
    image = Image.open(io.BytesIO(image_data)).convert("RGB")
    draw = ImageDraw.Draw(image)
    for line in word["text_word_region"]:
        for region in line:
            points = [tuple(point) for point in region]
            draw.line(points + points[:1], fill="red", width=2)
    output = io.BytesIO()
    image.save(output, format="PNG")
    private_write(path, output.getvalue())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8003")
    parser.add_argument("--output", type=Path, default=Path("/data/hsbc/deploy/ppocr-candidate-acceptance.json"))
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    directory = args.output.parent / (args.output.stem + "-synthetic")
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    report = {"started_at": now(), "base_url": args.base_url, "synthetic_only": True,
              "artifact_policy": "Only generated synthetic images and their OCR responses are saved; no business data or credentials.",
              "artifact_directory": str(directory), "cases": [], "passed": False}
    sampler = GPUSampler()
    sampler.thread.start()
    try:
        token = Path("/data/hsbc/secrets/ocr.token").read_text().strip()
        check(len(token) >= 32, "invalid_local_token")
        images = synthetic_images(directory)
        report["inputs"] = {name: {"path": value["path"], "width": value["size"][0], "height": value["size"][1]} for name, value in images.items()}
        cases = [
            {"name": "default_vl", "status": 200},
            {"name": "false_vl", "status": 200, "fields": [("return_word_box", "false")]},
            {"name": "true_mixed", "status": 200, "fields": [("return_word_box", "true")], "words": True, "chinese": True},
            {"name": "true_blank", "status": 200, "fields": [("return_word_box", "true")], "words": True, "image": "blank"},
            {"name": "true_large", "status": 200, "fields": [("return_word_box", "true")], "words": True, "image": "large"},
            {"name": "unauthenticated", "status": 401, "auth": False},
            *[{"name": "invalid_bool_" + str(i), "status": 422, "fields": [("return_word_box", value)]} for i, value in enumerate(("True", "1", "yes", ""))],
            {"name": "duplicate_return_word_box", "status": 422, "fields": [("return_word_box", "true"), ("return_word_box", "false")]},
            {"name": "duplicate_file", "status": 422, "duplicate_file": True},
            {"name": "unknown_use_word_boxes", "status": 422, "fields": [("use_word_boxes", "true")]},
            {"name": "query_return_word_box", "status": 422, "query": "?return_word_box=true"},
            {"name": "invalid_image", "status": 422, "invalid_image": True},
        ]
        with requests.Session() as session:
            session.trust_env = False
            for case in cases:
                record = {"case": case["name"], "expected_status": case["status"], "passed": False}
                started = time.monotonic()
                try:
                    image_name = case.get("image", "mixed")
                    source = images[image_name]
                    data = b"synthetic invalid image" if case.get("invalid_image") else source["bytes"]
                    files = [("file", ("synthetic.png", data, "image/png"))]
                    if case.get("duplicate_file"):
                        files.append(("file", ("synthetic-duplicate.png", data, "image/png")))
                    files += [(name, (None, value)) for name, value in case.get("fields", [])]
                    headers = {"Authorization": "Bearer " + token} if case.get("auth", True) else {}
                    response = session.post(args.base_url.rstrip("/") + "/v1/ocr" + case.get("query", ""),
                                            headers=headers, files=files, timeout=(10, 180), allow_redirects=False)
                    record["http_status"] = response.status_code
                    check(response.status_code == case["status"], "unexpected_http_status")
                    if case["status"] == 200:
                        body = response.json()
                        if case.get("words"):
                            # These requests contain generated test images exclusively.
                            response_path = directory / (case["name"] + "-response.json")
                            write_json(response_path, body)
                            record["synthetic_response_path"] = str(response_path)
                        summary, word = inspect_response(body, source["size"], case.get("words", False),
                                                         image_name == "blank", case.get("chinese", False))
                        record.update(summary)
                        if word is not None:
                            overlay_path = directory / (case["name"] + "-word-boxes.png")
                            save_visualization(source["bytes"], word, overlay_path)
                            record["synthetic_overlay_path"] = str(overlay_path)
                    record["passed"] = True
                except Exception as exc:
                    record["error_type"] = type(exc).__name__
                    # Only our constant validation codes may be recorded, never library exception text.
                    if type(exc) is ValueError and re.fullmatch(r"[a-z_]+", str(exc)):
                        record["error_code"] = str(exc)
                finally:
                    record["elapsed_seconds"] = round(time.monotonic() - started, 3)
                    report["cases"].append(record)
                    print(json.dumps({key: record[key] for key in ("case", "http_status", "passed", "elapsed_seconds", "error_code") if key in record}), flush=True)
        report["passed"] = all(case["passed"] for case in report["cases"]) and len(report["cases"]) == len(cases)
    except Exception as exc:
        report["setup_error_type"] = type(exc).__name__
    finally:
        report["gpu_memory"] = sampler.finish()
        if report["gpu_memory"]["samples"] == 0:
            report["passed"] = False
            report["gpu_sampling_failed"] = True
        report["completed_at"] = now()
        write_json(args.output, report)
    print(json.dumps({"passed": report["passed"], "cases": len(report["cases"]),
                      "gpu_memory": report["gpu_memory"], "report": str(args.output)}), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
