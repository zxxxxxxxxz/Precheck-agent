"""Occurrence-preserving optional GLiNER2 span contract.

Offsets are Python Unicode code points in the original request, half-open.
GLiNER2 2.1.0 can trim the surface while keeping its token-boundary offsets;
only that exact edge whitespace is adjusted here. Its processor also appends
one sentence period. Span requests supply that period explicitly, and only
that known suffix may be removed when projecting back to the request.
Never search for a matching
string elsewhere, infer offsets, merge repeated names, or filter short entities.
"""
import inspect
import math


class NerSpanInvalid(ValueError):
    pass


class NerSpansUnavailable(RuntimeError):
    pass


def require_native_spans(model):
    try:
        parameter = inspect.signature(model.extract_entities).parameters.get("include_spans")
    except (TypeError, ValueError, AttributeError):
        parameter = None
    if parameter is None or parameter.kind not in (
        inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY,
    ):
        raise NerSpansUnavailable("ner_spans_unavailable")


def native_span_input(text):
    """Make the pinned processor's suffix explicit; all source offsets stay put."""
    return text if text.endswith((".", "!", "?")) else text + "."


def normalize_entity_spans(text, labels, response, *, model_text=None):
    # Without an explicitly supplied model input, retain the original strict
    # contract. Never guess a transformation from a provider's returned text.
    if model_text is None:
        model_text = text
    if model_text not in (text, native_span_input(text)):
        raise NerSpanInvalid("ner_span_invalid")
    if not isinstance(response, dict) or not isinstance(response.get("entities"), dict):
        raise NerSpanInvalid("ner_span_invalid")
    entities = response["entities"]
    if any(label not in labels for label in entities):
        raise NerSpanInvalid("ner_span_invalid")
    normalized = {}
    for label, values in entities.items():
        if not isinstance(values, list):
            raise NerSpanInvalid("ner_span_invalid")
        normalized[label] = []
        for value in values:
            if not isinstance(value, dict):
                raise NerSpanInvalid("ner_span_invalid")
            start, end = value.get("start"), value.get("end")
            confidence, supplied = value.get("confidence"), value.get("text")
            if (type(start) is not int or type(end) is not int or
                    not 0 <= start < end <= len(model_text) or
                    type(confidence) not in (int, float) or
                    not math.isfinite(confidence) or not 0 <= confidence <= 1 or
                    not isinstance(supplied, str)):
                raise NerSpanInvalid("ner_span_invalid")
            surface = model_text[start:end]
            trimmed = surface.strip()
            if not trimmed or supplied not in (surface, trimmed):
                raise NerSpanInvalid("ner_span_invalid")
            # The sole permitted non-source character is the period we passed
            # to the pinned processor. Validate against that input first, then
            # clip its suffix; a suffix-only prediction must still fail closed.
            end = min(end, len(text))
            if start >= end:
                raise NerSpanInvalid("ner_span_invalid")
            surface = text[start:end]
            trimmed = surface.strip()
            if not trimmed:
                raise NerSpanInvalid("ner_span_invalid")
            left = len(surface) - len(surface.lstrip())
            right = len(surface) - len(surface.rstrip())
            start, end = start + left, end - right
            if text[start:end] != trimmed:
                raise NerSpanInvalid("ner_span_invalid")
            normalized[label].append({
                "text": trimmed, "confidence": confidence, "start": start, "end": end,
            })
    # This marker distinguishes empty native span results from an old server
    # silently ignoring include_spans. Consumers must require it.
    return {"entities": normalized, "offset_unit": "unicode_code_point"}
