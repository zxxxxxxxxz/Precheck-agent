"""Model-independent request and word-coordinate validation for the OCR adapter."""

import math
from typing import Any


def parse_ocr_options(items: list[tuple[str, Any]], has_query: bool) -> bool:
    """Accept only one upload and an optional, explicit multipart boolean.

    FastAPI validates the upload's type. Errors are fixed codes so neither an
    unexpected parameter name nor its value enters the HTTP error response.
    """
    if has_query:
        raise ValueError("ocr_query_parameters_not_supported")
    fields = {}
    for name, value in items:
        if name not in ("file", "return_word_box"):
            raise ValueError("ocr_unknown_form_field")
        if name in fields:
            raise ValueError("ocr_duplicate_form_field")
        fields[name] = value
    if "file" not in fields:
        raise ValueError("ocr_file_required")
    if "return_word_box" not in fields:
        return False
    value = fields["return_word_box"]
    if not isinstance(value, str) or value not in ("true", "false"):
        raise ValueError("ocr_invalid_return_word_box")
    return value == "true"


def _invalid() -> None:
    raise ValueError("ocr_invalid_word_result")


def _number(value: Any) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _invalid()
    try:
        finite = math.isfinite(value)
    except (OverflowError, TypeError, ValueError):
        _invalid()
    if not finite:
        _invalid()
    return value


def _array(value: Any, length: int | None = None) -> list:
    if not isinstance(value, list) or (length is not None and len(value) != length):
        _invalid()
    return value


def _quad(value: Any) -> list[list[int | float]]:
    return [[_number(c) for c in _array(point, 2)] for point in _array(value, 4)]


def _box(value: Any) -> list[int | float]:
    box = [_number(c) for c in _array(value, 4)]
    if box[0] > box[2] or box[1] > box[3]:
        _invalid()
    return box


def normalize_word_result(output: dict, width: int, height: int) -> dict:
    """Validate PP-OCR JSON and return only the documented coordinate fields.

    The producer disables geometric preprocessing: positions are original-image
    pixels. Preserve the upstream line/unit order, text and whitespace, and do
    not manufacture unit confidence from the available line confidence. Near-
    edge boxes may extend beyond the image and are intentionally not clipped.
    """
    if any(type(size) is not int or size <= 0 for size in (width, height)):
        _invalid()
    if not isinstance(output, dict):
        _invalid()
    result = output.get("res", output)
    if not isinstance(result, dict):
        _invalid()
    keys = (
        "rec_texts", "rec_scores", "rec_polys", "text_word",
        "text_word_region", "text_word_boxes",
    )
    if any(key not in result for key in keys):
        _invalid()
    rows = {key: _array(result[key]) for key in keys}
    line_count = len(rows["rec_texts"])
    if any(len(value) != line_count for value in rows.values()):
        _invalid()

    normalized = {key: [] for key in keys}
    for index in range(line_count):
        text = rows["rec_texts"][index]
        if not isinstance(text, str):
            _invalid()
        words = _array(rows["text_word"][index])
        regions = _array(rows["text_word_region"][index], len(words))
        boxes = _array(rows["text_word_boxes"][index], len(words))
        if any(not isinstance(word, str) for word in words):
            _invalid()
        normalized["rec_texts"].append(text)
        normalized["rec_scores"].append(_number(rows["rec_scores"][index]))
        normalized["rec_polys"].append(_quad(rows["rec_polys"][index]))
        normalized["text_word"].append(list(words))
        normalized["text_word_region"].append([_quad(region) for region in regions])
        normalized["text_word_boxes"].append([_box(box) for box in boxes])

    return {
        "model": "PP-OCRv6",
        "detector": "PP-OCRv6_medium_det",
        "recognizer": "PP-OCRv6_medium_rec",
        "coordinate_system": "original_image_pixels",
        "width": width,
        "height": height,
        "granularity": "latin_word_cjk_character",
        "method": "ctc_alignment",
        **normalized,
    }
