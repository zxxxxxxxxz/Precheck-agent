"""Small authenticated model adapters; business orchestration lives on APP."""
import hmac
import io
import json
import logging
import os
from pathlib import Path
import tempfile
import threading
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictBool
from ocr_contract import normalize_word_result, parse_ocr_options
from ner_contract import (
    NerSpanInvalid, NerSpansUnavailable, native_span_input, normalize_entity_spans, require_native_spans,
)

KIND = os.environ["MODEL_SERVICE"]
ROOT = Path("/data/hsbc")


def runtime_root(data_root, kind, requested):
    if not requested:
        return data_root
    candidate = Path(requested).resolve(strict=True)
    if kind != "ner" or candidate.parent != (data_root / "evaluations").resolve(strict=True):
        raise RuntimeError("invalid_model_runtime_root")
    return candidate


RUNTIME_ROOT = runtime_root(ROOT, KIND, os.environ.get("MODEL_RUNTIME_ROOT"))
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
for key, directory in {
    "XDG_CACHE_HOME": RUNTIME_ROOT / "cache",
    "CUDA_CACHE_PATH": RUNTIME_ROOT / "cache/cuda",
    "TORCH_HOME": RUNTIME_ROOT / "cache/torch",
    "TORCH_EXTENSIONS_DIR": RUNTIME_ROOT / "cache/torch-extensions",
    "TORCHINDUCTOR_CACHE_DIR": RUNTIME_ROOT / "cache/torch-inductor",
    "TRITON_CACHE_DIR": RUNTIME_ROOT / "cache/triton",
    "PADDLE_HOME": RUNTIME_ROOT / "cache/paddle",
}.items():
    directory.mkdir(parents=True, exist_ok=True)
    os.environ[key] = str(directory)
TOKEN = (RUNTIME_ROOT / "secrets" / f"{KIND}.token").read_text().strip()
if len(TOKEN) < 32:
    raise RuntimeError("Service token is missing or too short")
model = None
word_model = None
status = "loading"
lock = threading.Lock()
logger = logging.getLogger("hsbc-model")
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"{KIND}-model")


def load_model():
    global model, word_model, status
    try:
        if KIND == "ner":
            from gliner2 import AutoExtractor
            model = AutoExtractor.from_pretrained(
                str(ROOT / "models/gliner2.5-multi-v1"),
                map_location="cuda", quantize=True,
            )
            # Ready includes one real, synthetic inference.
            if RUNTIME_ROOT != ROOT:
                require_native_spans(model)
                warm_text = "Alice works at Example Ltd."
                normalize_entity_spans(warm_text, ["person", "company"], model.extract_entities(
                    warm_text, ["person", "company"], include_confidence=True, include_spans=True,
                ))
            else:
                model.extract_entities("Alice works at Example Ltd.", ["person", "company"])
        else:
            from paddleocr import PaddleOCR, PaddleOCRVL
            model = PaddleOCRVL(
                pipeline_version="v1.6", device="gpu:0",
                layout_detection_model_dir=str(ROOT / "models/PP-DocLayoutV3"),
                vl_rec_model_dir=str(ROOT / "models/PaddleOCR-VL-1.6"),
                use_doc_orientation_classify=False, use_doc_unwarping=False,
            )
            # Startup preflight exercises both layout and vision-language inference.
            list(model.predict(str(ROOT / "app/gpu3090/synthetic-invoice.png")))
            word_model = PaddleOCR(
                device="gpu:0",
                text_detection_model_name="PP-OCRv6_medium_det",
                text_detection_model_dir=str(ROOT / "models/PP-OCRv6_medium_det"),
                text_recognition_model_name="PP-OCRv6_medium_rec",
                text_recognition_model_dir=str(ROOT / "models/PP-OCRv6_medium_rec"),
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                text_recognition_batch_size=1,
                text_det_limit_type="max", text_det_limit_side_len=1600,
                return_word_box=True,
            )
            warm = list(word_model.predict(
                str(ROOT / "app/gpu3090/synthetic-invoice.png"), return_word_box=True,
            ))
            if len(warm) != 1:
                raise RuntimeError("word_ocr_warmup_page_count")
            from PIL import Image
            with Image.open(ROOT / "app/gpu3090/synthetic-invoice.png") as image:
                normalized = normalize_word_prediction(warm[0], *image.size)
            if not any(normalized["text_word"]):
                raise RuntimeError("word_ocr_warmup_empty")
        status = "ready"
        logger.warning("model_ready service=%s", KIND)
    except Exception as exc:
        status = "failed"
        # Loading and warm-up use only fixed synthetic input; trace aids deployment diagnosis.
        logger.exception("model_load_failed service=%s error_type=%s", KIND, type(exc).__name__)


@asynccontextmanager
async def lifespan(_app):
    # Paddle keeps execution mode in thread-local state. Initialization and every
    # prediction must run on the same dedicated thread, independent of HTTP workers.
    executor.submit(load_model)
    yield
    executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def require_token(request: Request, call_next):
    expected = "Bearer " + TOKEN
    if not hmac.compare_digest(request.headers.get("authorization", "").encode(), expected.encode()):
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


@app.get("/health/live")
def live():
    return {"status": "live", "service": KIND}


@app.get("/health/ready")
def ready():
    return JSONResponse({"status": status, "service": KIND}, status_code=200 if status == "ready" else 503)


def acquire():
    if status != "ready":
        raise HTTPException(503, "model_not_ready")
    if not lock.acquire(blocking=False):
        raise HTTPException(503, "model_busy", headers={"Retry-After": "2"})


class TextRequest(BaseModel):
    text: str = Field(min_length=1, max_length=20000)
    labels: list[str] = Field(min_length=1, max_length=64)
    # Use char for Chinese or other text without whitespace word boundaries.
    word_splitter: Literal["whitespace", "char"] = "whitespace"


class EntityRequest(TextRequest):
    # False follows the exact original call/response path.
    include_spans: StrictBool = False


def validate_labels(data: TextRequest):
    if any(not label.strip() or len(label) > 128 for label in data.labels):
        raise HTTPException(422, "invalid_labels")


def validate_tokens(data: TextRequest, model_text=None):
    tokenizer = model.processor.tokenizer
    count = len(tokenizer.encode(data.text if model_text is None else model_text)) + sum(len(tokenizer.encode(label)) for label in data.labels)
    # Reserve room for schema markers; callers split large documents explicitly.
    if count + 4 * len(data.labels) > 3800:
        raise HTTPException(422, "input_requires_splitting")


def run_ner(data: TextRequest, task: str):
    model.set_word_splitter(data.word_splitter)
    model_text = native_span_input(data.text) if task == "entities" and getattr(data, "include_spans", False) else data.text
    validate_tokens(data, model_text)
    if task == "entities":
        if getattr(data, "include_spans", False):
            try:
                require_native_spans(model)
                result = model.extract_entities(
                    model_text, data.labels, include_confidence=True, include_spans=True,
                )
                return normalize_entity_spans(data.text, data.labels, result, model_text=model_text)
            except NerSpansUnavailable:
                raise HTTPException(503, "ner_spans_unavailable") from None
            except NerSpanInvalid:
                raise HTTPException(422, "ner_span_invalid") from None
        return model.extract_entities(data.text, data.labels, include_confidence=True)
    return model.classify_text(data.text, {"label": data.labels}, include_confidence=True)


def normalize_word_prediction(result, width: int, height: int):
    # PaddleX's OCRResult.json omits text_word_region. Select the original
    # inference fields explicitly so rotated polygons are not lost at export.
    fields = {key: result[key] for key in (
        "rec_texts", "rec_scores", "rec_polys", "text_word",
        "text_word_region", "text_word_boxes",
    )}
    plain = json.loads(json.dumps(fields, default=lambda value: value.tolist()))
    return normalize_word_result(plain, width, height)


def run_ocr(source: Path, return_word_box: bool = False):
    pages = []
    for result in model.predict(str(source)):
        output = result.json
        if isinstance(output, str):
            output = json.loads(output)
        if isinstance(output, dict):
            output.get("res", output).pop("input_path", None)
        pages.append({"result": output, "markdown": result.markdown.get("markdown_texts", "")})
    if return_word_box:
        from PIL import Image
        with Image.open(source) as image:
            width, height = image.size
        word_pages = list(word_model.predict(str(source), return_word_box=True))
        if len(pages) != 1 or len(word_pages) != 1:
            raise RuntimeError("word_ocr_page_count_mismatch")
        pages[0]["word_ocr"] = normalize_word_prediction(word_pages[0], width, height)
    return {"pages": pages}


async def ocr_options(request: Request):
    # Inspect the complete multipart form: FastAPI otherwise ignores unknown fields.
    form = await request.form()
    try:
        return parse_ocr_options(list(form.multi_items()), bool(request.query_params))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


if KIND == "ner":
    @app.post("/v1/entities")
    def entities(data: EntityRequest):
        validate_labels(data)
        acquire()
        try:
            return executor.submit(run_ner, data, "entities").result()
        except HTTPException:
            raise
        except Exception as exc:
            logger.error("inference_failed service=ner error_type=%s", type(exc).__name__)
            raise HTTPException(500, "inference_failed") from None
        finally:
            lock.release()

    @app.post("/v1/classify")
    def classify(data: TextRequest):
        validate_labels(data)
        acquire()
        try:
            return executor.submit(run_ner, data, "classify").result()
        except HTTPException:
            raise
        except Exception as exc:
            logger.error("classification_failed error_type=%s", type(exc).__name__)
            raise HTTPException(500, "inference_failed") from None
        finally:
            lock.release()
else:
    @app.post("/v1/ocr")
    def ocr(file: UploadFile, return_word_box: bool = Depends(ocr_options)):
        # Accept uploaded image bytes only: no arbitrary URLs or server file paths.
        raw = file.file.read(10 * 1024 * 1024 + 1)
        if len(raw) > 10 * 1024 * 1024:
            raise HTTPException(413, "image_too_large")
        from PIL import Image
        try:
            with Image.open(io.BytesIO(raw)) as image:
                if image.format not in {"PNG", "JPEG"} or image.width * image.height > 20_000_000:
                    raise ValueError("unsupported_image")
                image.load()
        except Exception:
            raise HTTPException(422, "valid_png_or_jpeg_required") from None
        acquire()
        try:
            with tempfile.TemporaryDirectory(dir=ROOT / "tmp") as temp:
                source = Path(temp) / "input.png"
                with Image.open(io.BytesIO(raw)) as image:
                    image.convert("RGB").save(source)
                return executor.submit(run_ocr, source, return_word_box).result()
        except Exception as exc:
            logger.error("inference_failed service=ocr error_type=%s", type(exc).__name__)
            raise HTTPException(500, "inference_failed") from None
        finally:
            lock.release()
