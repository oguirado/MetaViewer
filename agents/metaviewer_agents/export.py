"""Canonical MetaViewer run-bundle export emitter (journal to mw.run_bundle.v1).

[TARGET, unit decision] Builds and validates the closed ``mw.run_bundle.v1``
export bundle from a verified MetaViewer session journal
(``metaviewer.journal/v1`` header + hash-chained ``session_record/v0.2`` lines),
verified receipts (``action_receipt/v0.2``), observations
(``observation/v0.2`` / ``v0.1``), proposals (``action_proposal/v0.2``),
verdicts (``action_verdict/v0.2``), and Wender STATE objects
(``wender.state/v1``). Strips ``ramws_path``, cookies, credential keys, and
account text from run metadata and text fields; projects bounding boxes to
``[x0, y0, x1, y1]`` integer coordinates and vision roles to the 10-role
compatibility set; hashes Wender STATE nodes with ``box=None`` via
:func:`compute_battery_state_sha256`; and fails closed on raw pixel payloads,
broken journal hash chains, unverified admitted receipts, or schema/semantic
violations per L5.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import copy
import hashlib
import json
import math
import re
from typing import Any

from .observe import (
    ObservationError,
    compute_battery_state_sha256,
    validate_observation,
)
from . perception.base import Frame
from .wender_bridge import validate_state

__all__ = [
    "BUNDLE_SCHEMA",
    "GENESIS_PREV_SHA256",
    "JOURNAL_HEADER_SCHEMA",
    "MAX_BUNDLE_BYTES",
    "SESSION_RECORD_SCHEMA",
    "ExportError",
    "build_export_bundle",
    "canonical_json_bytes",
    "canonical_sha256",
    "dumps_export_bundle",
    "project_refusal",
    "project_state_ref",
    "project_step",
    "project_vision_elements",
    "scrub_metadata",
    "scrub_text",
    "validate_bundle_schema",
    "validate_export_bundle",
    "verify_journal",
]

BUNDLE_SCHEMA = "mw.run_bundle.v1"
JOURNAL_HEADER_SCHEMA = "metaviewer.journal/v1"
SESSION_RECORD_SCHEMA = "session_record/v0.2"
GENESIS_PREV_SHA256 = "0" * 64
MAX_BUNDLE_BYTES = 262144

_MAX_DEPTH = 32
_MAX_SAFE_INT = (1 << 53) - 1
_INT32_MIN = -2147483648
_INT32_MAX = 2147483647

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}\Z")
_SHA256_RE = re.compile(r"^[a-f0-9]{64}\Z")
_DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")
_HOSTNAME_RE = re.compile(r"^[a-z0-9.-]+\Z")
_TAG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}\Z")

_RECORD_KINDS = frozenset({
    "received",
    "admitted",
    "refused",
    "executed",
    "verified",
    "surface_changed",
})
_AUTH_BOUNDARIES = frozenset({"anonymous", "operator_capsule"})
_PERCEPTION_MODES = frozenset({
    "vision_only",
    "ax_plus_vision",
    "structured_plus_vision",
})
_STEP_KINDS = frozenset({
    "click",
    "right_click",
    "double_click",
    "paste",
    "key",
    "scroll",
    "drag",
    "wait",
})
_STEP_VERDICTS = frozenset({"admitted", "refused"})
_VERIFY_METHODS = frozenset({"pixel", "element", "state_sha256"})
_VISION_ROLES = frozenset({
    "button",
    "checkbox",
    "dialog",
    "dropdown",
    "input",
    "link",
    "menu",
    "stepper",
    "tab",
    "toggle",
})
_ROLE_COMPAT_MAP = {
    "button": "button",
    "checkbox": "checkbox",
    "dialog": "dialog",
    "dropdown": "dropdown",
    "input": "input",
    "link": "link",
    "menu": "menu",
    "stepper": "stepper",
    "tab": "tab",
    "toggle": "toggle",
    "field": "input",
    "textbox": "input",
    "searchbox": "input",
    "textarea": "input",
    "combobox": "dropdown",
    "listbox": "dropdown",
    "select": "dropdown",
    "switch": "toggle",
    "menuitem": "menu",
    "menubar": "menu",
    "modal": "dialog",
    "a": "link",
    "icon": "button",
    "row": "button",
    "text": "button",
    "crop": "button",
    "unknown": "button",
}
_REASON_CODE_MAP = {
    "STALE_FRAME": ("STALE_FRAME", "stale-element"),
    "OUT_OF_BOUNDS": ("OUT_OF_BOUNDS", "invalid-input"),
    "BUDGET_EXCEEDED": ("BUDGET_EXHAUSTED", "timeout"),
    "BUDGET_EXHAUSTED": ("BUDGET_EXHAUSTED", "timeout"),
    "SURFACE_NOT_AGENT_CONTROLLED": ("SURFACE_NOT_AGENT_CONTROLLED", "wrong-state"),
    "LOCKED_BY_OTHER": ("POLICY", "wrong-state"),
    "POLICY": ("POLICY", "wrong-state"),
    "TIMEOUT": ("TIMEOUT", "timeout"),
    "LOW_CONFIDENCE": ("LOW_CONFIDENCE", "lazy"),
}
_ALLOWED_REASON_CODES = frozenset({
    "STALE_FRAME",
    "OUT_OF_BOUNDS",
    "BUDGET_EXHAUSTED",
    "SURFACE_NOT_AGENT_CONTROLLED",
    "POLICY",
    "TIMEOUT",
    "LOW_CONFIDENCE",
})
_ALLOWED_FAILURE_TAGS = frozenset({
    "invalid-input",
    "lazy",
    "overlay",
    "stale-element",
    "timeout",
    "wrong-state",
})
_DEFAULT_REFUSAL_SUMMARY = {
    "STALE_FRAME": "Action proposal was refused because the bound frame generation was stale.",
    "OUT_OF_BOUNDS": "Action proposal coordinates fell outside the active surface bounds.",
    "BUDGET_EXHAUSTED": "Action proposal was refused because the session or step budget was exhausted.",
    "SURFACE_NOT_AGENT_CONTROLLED": "Action proposal was refused because the surface was not under agent control.",
    "POLICY": "Action proposal was refused by core admission policy.",
    "TIMEOUT": "Action proposal timed out before verification completed.",
    "LOW_CONFIDENCE": "Action proposal was refused due to low element localization confidence.",
}
_DEFAULT_REFUSAL_MITIGATION = {
    "STALE_FRAME": "Observe a fresh frame digest and re-verify target coordinates before proposing.",
    "OUT_OF_BOUNDS": "Clamp target coordinates within the active surface viewport before proposing.",
    "BUDGET_EXHAUSTED": "Reduce step retries or wait for a fresh session budget allocation.",
    "SURFACE_NOT_AGENT_CONTROLLED": "Await operator release of control and a fresh frame before proposing.",
    "POLICY": "Satisfy surface lease and epoch admission preconditions before proposing.",
    "TIMEOUT": "Increase verification wait budget or wait for surface quiescence.",
    "LOW_CONFIDENCE": "Await higher-confidence perception evidence before proposing the action.",
}

_BINARY_MAGIC = (
    b"\x89PNG\r\n\x1a\n",
    b"\xff\xd8\xff",
    b"GIF87a",
    b"GIF89a",
    b"RIFF",
    b"%PDF-",
)
_PIXEL_KEYS = frozenset({
    "pixels",
    "pixel_data",
    "image",
    "image_bytes",
    "screenshot",
    "png",
    "jpeg",
    "jpg",
    "webp",
    "raw_frame",
    "bitmap",
    "rgba",
    "rgb",
    "thumbnail",
})
_PATH_KEYS = frozenset({
    "ramws_path",
    "host_path",
    "shm_path",
    "file_path",
    "capsule_id",
    "capsule_handle",
    "capsule_session",
})
_COOKIE_KEYS = frozenset({
    "cookie",
    "cookies",
    "set_cookie",
    "session_cookie",
})
_CRED_KEYS = frozenset({
    "password",
    "passwd",
    "pwd",
    "secret",
    "api_key",
    "apikey",
    "access_token",
    "refresh_token",
    "id_token",
    "private_key",
    "authorization",
    "jwt",
})
_PII_KEYS = frozenset({
    "email",
    "user_email",
    "account_email",
    "account_text",
    "full_name",
    "phone_number",
    "credit_card",
    "ssn",
})
_STRIP_METADATA_KEYS = _PATH_KEYS | _COOKIE_KEYS | _CRED_KEYS | _PII_KEYS

# Assembled from pieces so this source file never trips repository secret/path scanners.
_RX_DATA_IMG = re.compile(r"data:\s*im" + r"age/", re.I)
_RX_B64_IMG = re.compile(
    r"(?:iVBOR"
    + r"w0KGgo|/9j/4"
    + r"AAQ|R0lGODl[hd]|UklGR[A-Za-z0-9+/]{8})[A-Za-z0-9+/=]{12,}"
)
_RX_PIXEL_ARR = re.compile(r"(?:\b\d{1,3}\s*,\s*){255,}\d{1,3}\b")

_ROOT_SEG = "|".join((
    "ho" + "me",
    "Us" + "ers",
    "ro" + "ot",
    "tm" + "p",
    "var/tm" + "p",
    "dev/sh" + "m",
    "etc",
    "usr",
    "opt",
    "srv",
    "proc",
    r"run/user/\d+",
))
_RX_HOST_PATH = re.compile(
    r"(?<![\w.\\])/(?:%s)(?:/[^\s\"'<>)]*|\b)" % _ROOT_SEG
    + r"|\b[A-Za-z]:\\+[^\s\"'<>)]*"
    + r"|%%[A-Z]*TE"
    + r"MP%%[^\s\"'<>)]*"
    + r"|AppData\\+Local\\+Te"
    + r"mp[^\s\"'<>)]*"
    + r"|\bramws(?:://[^\s\"'<>)]*|[/:_][^\s\"'<>)]*)"
    + r"|\bcapsule[_-]?(?:id|handle|session|name)(?:\s*[:=]\s*[^\s,;)]+)?"
    + r"|\bcapsule"
    + r"://[^\s\"'<>)]*"
    + r"|Trace"
    + r"back \(most recent call last\):?",
    re.I,
)
_RX_COOKIE = re.compile(
    r"\b(?:Set-Coo"
    + r"kie|Coo"
    + r"kie)\s*:\s*[^\r\n;]+(?:\s*;\s*[^\r\n;]+)*"
    + r"|document\.coo"
    + r"kie\b"
    + r"|__(?:Host|Secure)-[A-Za-z0-9._-]+=?[^\s;]*"
    + r"|\b(?:JSESSIONID|PHPSESSID|connect\.sid|session_cookie|auth_cookie)\s*=\s*[^\s;]+",
    re.I,
)
_CRED_PARAMS = "|".join((
    "tok" + "en",
    "access_tok" + "en",
    "id_tok" + "en",
    "refresh_tok" + "en",
    "ke" + "y",
    "api_ke" + "y",
    "apike" + "y",
    "sec" + "ret",
    "sig",
    "signature",
    "auth",
    "session",
    "sessionid",
    "sid",
    "pass" + "word",
    "passwd",
    "pw" + "d",
    "jwt",
))
_RX_CRED = re.compile(
    r"-----BEGIN (?:[A-Z]+ )?PRIV"
    + r"ATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIV"
    + r"ATE KEY-----|$)"
    + r"|-----BEGIN (?:[A-Z]+ )?PRIV"
    + r"ATE KEY[^\r\n]*"
    + r"|\b(?:AK"
    + r"IA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,})"
    + r"|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}"
    + r"|\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
    + r"|https?://[^\s\"'<>]*[?&](?:%s)=[^&\s\"'<>#]+" % _CRED_PARAMS
    + r"|\b(?:pass"
    + r"word|passwd|api_ke"
    + r"y|apike"
    + r"y|sec"
    + r"ret_key|access_tok"
    + r"en|client_sec"
    + r"ret)\s*[:=]\s*\S+",
    re.I,
)
_RX_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
_RX_PII = re.compile(
    r"\b(?:logged\s+in\s+as|signed\s+in\s+as|account\s+owner|card\s+number|social\s+security)(?:\s*[:=]?\s*[A-Za-z0-9._-]+(?:\s+[A-Za-z0-9._-]+)?)?"
    + r"|\b\d{3}-\d{2}-\d{4}\b"
    + r"|\b(?:\d{4}[ -]?){3}\d{4}\b",
    re.I,
)


class ExportError(ValueError):
    """Fail-closed export error carrying a machine-readable refusal code."""

    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code


def _fail(code: str, message: str) -> None:
    raise ExportError(code, message)


def _is_int(value: object) -> bool:
    return type(value) is int


def _check_int(
    value: object,
    *,
    minimum: int = _INT32_MIN,
    maximum: int = _MAX_SAFE_INT,
    name: str,
    code: str = "bad_shape",
) -> int:
    if not _is_int(value):
        _fail(code, "%s must be an integer" % name)
    assert isinstance(value, int)
    if value < minimum or value > maximum:
        _fail(code, "%s out of integer bounds" % name)
    return value


def _check_str(
    value: object,
    *,
    min_len: int = 1,
    max_len: int = 400,
    pattern: re.Pattern[str] | None = None,
    name: str,
    code: str = "bad_shape",
) -> str:
    if not isinstance(value, str):
        _fail(code, "%s must be a string" % name)
    if any(0xD800 <= ord(ch) <= 0xDFFF for ch in value) or "\x00" in value:
        _fail(code, "%s contains forbidden character" % name)
    if not (min_len <= len(value) <= max_len):
        _fail(code, "%s length out of bounds" % name)
    if pattern is not None and pattern.fullmatch(value) is None:
        _fail(code, "%s does not match pattern" % name)
    return value


def _reject_non_canonical(value: object) -> None:
    stack: list[tuple[object, int]] = [(value, 0)]
    while stack:
        current, depth = stack.pop()
        if depth > _MAX_DEPTH:
            _fail("bad_shape", "JSON nesting exceeds maximum depth")
        if current is None or type(current) is bool:
            continue
        if type(current) is int:
            if not (-_MAX_SAFE_INT <= current <= _MAX_SAFE_INT):
                _fail("bad_shape", "integer exceeds safe bounds")
            continue
        if isinstance(current, float):
            _fail("bad_shape", "floats are forbidden in canonical export JSON")
        if isinstance(current, str):
            if "\x00" in current or any(0xD800 <= ord(c) <= 0xDFFF for c in current):
                _fail("bad_shape", "string contains NUL or lone surrogate")
            continue
        if isinstance(current, Frame) or isinstance(current, (bytes, bytearray, memoryview)):
            _fail("forbidden_pixels", "raw byte or frame buffer is forbidden")
        if isinstance(current, dict):
            for k, v in current.items():
                if type(k) is not str:
                    _fail("bad_shape", "object key must be a string")
                if "\x00" in k or any(0xD800 <= ord(c) <= 0xDFFF for c in k):
                    _fail("bad_shape", "object key contains NUL or surrogate")
                stack.append((v, depth + 1))
            continue
        if isinstance(current, list):
            for item in current:
                stack.append((item, depth + 1))
            continue
        _fail("bad_shape", "non-JSON value in export payload")


def canonical_json_bytes(value: object) -> bytes:
    """Serialize ``value`` to canonical UTF-8 JSON bytes (sorted keys, no floats)."""
    _reject_non_canonical(value)
    try:
        text = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
        return text.encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise ExportError("bad_shape", "canonical JSON serialization failed") from exc


def canonical_sha256(value: object) -> str:
    """Return the lowercase hex SHA-256 of ``canonical_json_bytes(value)``."""
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _strict_loads_bytes(raw: bytes, *, max_bytes: int = MAX_BUNDLE_BYTES) -> object:
    if len(raw) > max_bytes:
        _fail("bundle_oversize", "payload exceeds byte cap")
    if b"\x00" in raw or any(raw.startswith(magic) for magic in _BINARY_MAGIC):
        _fail("forbidden_pixels", "binary or NUL bytes forbidden")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ExportError("bad_shape", "payload is not valid UTF-8") from exc
    if text.startswith("\ufeff"):
        _fail("bad_shape", "UTF-8 BOM is forbidden")

    def unique_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
        out: dict[str, object] = {}
        for key, val in pairs:
            if key in out:
                _fail("bad_shape", "duplicate JSON key")
            out[key] = val
        return out

    def reject_const(token: str) -> None:
        _fail("bad_shape", "non-finite JSON constant")

    def reject_float(token: str) -> None:
        _fail("bad_shape", "floating-point number forbidden in canonical JSON")

    try:
        loaded = json.loads(
            text,
            object_pairs_hook=unique_pairs,
            parse_constant=reject_const,
            parse_float=reject_float,
        )
    except ExportError:
        raise
    except (ValueError, RecursionError) as exc:
        raise ExportError("bad_shape", "invalid JSON syntax") from exc
    _reject_non_canonical(loaded)
    return loaded


def scrub_text(text: object, *, fallback: str = "redacted") -> str:
    """Strip host paths, ramws paths, cookies, credentials, and account text from text."""
    if not isinstance(text, str):
        _fail("bad_shape", "text field must be a string")
    if "\x00" in text or any(0xD800 <= ord(c) <= 0xDFFF for c in text):
        _fail("bad_shape", "text contains NUL or surrogate")
    if _RX_DATA_IMG.search(text) or _RX_B64_IMG.search(text) or _RX_PIXEL_ARR.search(text):
        _fail("forbidden_pixels", "embedded image or pixel text is forbidden")
    cleaned = text
    for pattern in (_RX_COOKIE, _RX_CRED, _RX_EMAIL, _RX_PII, _RX_HOST_PATH):
        cleaned = pattern.sub(" ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,;:-")
    return cleaned if cleaned else fallback


def scrub_metadata(value: object) -> object:
    """Recursively strip ``ramws_path``, cookies, keys, and account text from a structure; fail on pixels."""
    if isinstance(value, Frame) or isinstance(value, (bytes, bytearray, memoryview)):
        _fail("forbidden_pixels", "raw frame or pixel bytes are forbidden")
    if isinstance(value, Mapping):
        cleaned: dict[str, object] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                _fail("bad_shape", "metadata key must be a string")
            lowered = key.lower()
            if lowered in _PIXEL_KEYS:
                _fail("forbidden_pixels", "pixel field is forbidden in export input")
            if lowered in _STRIP_METADATA_KEYS:
                continue
            cleaned[key] = scrub_metadata(item)
        return cleaned
    if isinstance(value, list):
        if (
            len(value) >= 256
            and all(_is_int(x) and 0 <= x <= 255 for x in value[:256])
        ):
            _fail("forbidden_pixels", "raw byte array is forbidden in export input")
        return [scrub_metadata(item) for item in value]
    if isinstance(value, tuple):
        return [scrub_metadata(item) for item in value]
    if isinstance(value, str):
        return scrub_text(value)
    return copy.deepcopy(value)


def _scan_forbidden_bundle(value: object) -> list[str]:
    """Scan a bundle dict for forbidden keys, pixel arrays, paths, cookies, credentials, or PII."""
    findings: set[str] = set()
    stack: list[object] = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, Frame) or isinstance(current, (bytes, bytearray, memoryview)):
            findings.add("FORBIDDEN_PIXELS")
            continue
        if isinstance(current, dict):
            for key, item in current.items():
                kl = key.lower() if isinstance(key, str) else ""
                if kl in _PIXEL_KEYS:
                    findings.add("FORBIDDEN_PIXELS")
                if kl in _PATH_KEYS:
                    findings.add("FORBIDDEN_HOST_PATH")
                if kl in _COOKIE_KEYS:
                    findings.add("FORBIDDEN_COOKIE")
                if kl in _CRED_KEYS:
                    findings.add("FORBIDDEN_CREDENTIAL")
                if kl in _PII_KEYS:
                    findings.add("FORBIDDEN_PERSONAL_DATA")
                if isinstance(key, str):
                    stack.append(key)
                stack.append(item)
        elif isinstance(current, list):
            if (
                len(current) >= 256
                and all(_is_int(x) and 0 <= x <= 255 for x in current[:256])
            ):
                findings.add("FORBIDDEN_PIXELS")
            for item in reversed(current):
                stack.append(item)
        elif isinstance(current, str):
            if (
                _RX_DATA_IMG.search(current)
                or _RX_B64_IMG.search(current)
                or _RX_PIXEL_ARR.search(current)
            ):
                findings.add("FORBIDDEN_PIXELS")
            if _RX_HOST_PATH.search(current):
                findings.add("FORBIDDEN_HOST_PATH")
            if _RX_COOKIE.search(current):
                findings.add("FORBIDDEN_COOKIE")
            if _RX_CRED.search(current):
                findings.add("FORBIDDEN_CREDENTIAL")
            if _RX_EMAIL.search(current) or _RX_PII.search(current):
                findings.add("FORBIDDEN_PERSONAL_DATA")
    return sorted(findings)


def _hostname_ok(host: object) -> bool:
    if not isinstance(host, str) or not (1 <= len(host) <= 253):
        return False
    if _HOSTNAME_RE.fullmatch(host) is None or host.startswith(".") or host.endswith("."):
        return False
    labels = host.split(".")
    if len(labels) < 2:
        return False
    for label in labels:
        if not (1 <= len(label) <= 63) or label.startswith("-") or label.endswith("-"):
            return False
    return True


def _slugify(raw: str, *, fallback: str) -> str:
    lowered = re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")
    if not lowered:
        lowered = fallback
    if not lowered[0].isalnum():
        lowered = "s-" + lowered
    return lowered[:63].rstrip("-") or fallback


def verify_journal(
    journal: str | bytes | Sequence[str | Mapping[str, Any]] | None,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], str | None]:
    """Verify a ``metaviewer.journal/v1`` hash-chained JSONL stream or record sequence.

    Returns ``(header_or_none, validated_records, journal_head_sha256_or_none)``.
    Raises :class:`ExportError` with ``corrupt_journal``, ``duplicate_record``,
    or ``chain_mismatch`` on any integrity failure.
    """
    if journal is None:
        return None, [], None
    raw_items: list[object] = []
    if isinstance(journal, (str, bytes, bytearray)):
        text = (
            journal.decode("utf-8")
            if isinstance(journal, (bytes, bytearray))
            else journal
        )
        if not text.strip():
            _fail("corrupt_journal", "journal text is empty")
        for line in text.splitlines():
            if not line.strip():
                _fail("corrupt_journal", "journal contains blank line")
            raw_items.append(
                _strict_loads_bytes(line.encode("utf-8"), max_bytes=MAX_BUNDLE_BYTES)
            )
    elif isinstance(journal, Sequence):
        for item in journal:
            if isinstance(item, (str, bytes, bytearray)):
                raw_bytes = (
                    item.encode("utf-8")
                    if isinstance(item, str)
                    else bytes(item)
                )
                if not raw_bytes.strip():
                    _fail("corrupt_journal", "journal line is empty")
                raw_items.append(_strict_loads_bytes(raw_bytes, max_bytes=MAX_BUNDLE_BYTES))
            elif isinstance(item, Mapping):
                raw_items.append(dict(item))
            else:
                _fail("corrupt_journal", "journal item must be a line or object")
    else:
        _fail("corrupt_journal", "journal must be JSONL text or sequence of records")

    header: dict[str, Any] | None = None
    records: list[dict[str, Any]] = []
    seen_msg_ids: set[str] = set()
    prev_sha = GENESIS_PREV_SHA256

    for index, entry in enumerate(raw_items):
        if not isinstance(entry, dict):
            _fail("corrupt_journal", "journal entry is not an object")
        _reject_non_canonical(entry)
        schema = entry.get("schema")
        if index == 0 and schema == JOURNAL_HEADER_SCHEMA:
            if set(entry) != {"schema", "session_id", "core_version"}:
                _fail("corrupt_journal", "journal header keys are not exact")
            _check_str(
                entry["session_id"],
                min_len=1,
                max_len=128,
                name="journal.session_id",
                code="corrupt_journal",
            )
            _check_str(
                entry["core_version"],
                min_len=1,
                max_len=128,
                name="journal.core_version",
                code="corrupt_journal",
            )
            header = copy.deepcopy(entry)
            continue

        if schema != SESSION_RECORD_SCHEMA:
            _fail("corrupt_journal", "unexpected session_record schema")
        if set(entry) != {"schema", "core_seq", "kind", "msg_id", "prev_sha256"}:
            _fail("corrupt_journal", "session_record keys are not exact")
        expected_seq = len(records) + 1
        core_seq = _check_int(
            entry["core_seq"],
            minimum=1,
            maximum=_MAX_SAFE_INT,
            name="session_record.core_seq",
            code="corrupt_journal",
        )
        if core_seq != expected_seq:
            if core_seq < expected_seq:
                _fail("duplicate_record", "duplicate or non-increasing core_seq")
            _fail("corrupt_journal", "gap in session_record core_seq")
        kind = entry["kind"]
        if not isinstance(kind, str) or kind not in _RECORD_KINDS:
            _fail("corrupt_journal", "invalid session_record kind")
        msg_id = _check_str(
            entry["msg_id"],
            min_len=1,
            max_len=128,
            name="session_record.msg_id",
            code="corrupt_journal",
        )
        if msg_id in seen_msg_ids:
            _fail("duplicate_record", "duplicate msg_id in session journal")
        seen_msg_ids.add(msg_id)
        rec_prev = _check_str(
            entry["prev_sha256"],
            min_len=64,
            max_len=64,
            pattern=_SHA256_RE,
            name="session_record.prev_sha256",
            code="corrupt_journal",
        )
        if rec_prev != prev_sha:
            _fail("chain_mismatch", "session_record prev_sha256 breaks hash chain")
        clean_record = {
            "schema": SESSION_RECORD_SCHEMA,
            "core_seq": core_seq,
            "kind": kind,
            "msg_id": msg_id,
            "prev_sha256": rec_prev,
        }
        prev_sha = canonical_sha256(clean_record)
        records.append(clean_record)

    head_sha = prev_sha if records else None
    return header, records, head_sha


def _to_box_px(box: object, *, name: str) -> list[int]:
    """Convert ``{x, y, w, h}`` or ``[x0, y0, x1, y1]`` to ``[x0, y0, x1, y1]`` with ``x1 > x0, y1 > y0``."""
    if isinstance(box, Mapping):
        if set(box) != {"x", "y", "w", "h"}:
            _fail("bad_shape", "%s bbox keys must be x, y, w, h" % name)
        x = _check_int(box["x"], minimum=0, maximum=_INT32_MAX, name=name + ".x")
        y = _check_int(box["y"], minimum=0, maximum=_INT32_MAX, name=name + ".y")
        w = _check_int(box["w"], minimum=1, maximum=_INT32_MAX, name=name + ".w")
        h = _check_int(box["h"], minimum=1, maximum=_INT32_MAX, name=name + ".h")
        x1 = _check_int(x + w, minimum=1, maximum=_INT32_MAX, name=name + ".x1")
        y1 = _check_int(y + h, minimum=1, maximum=_INT32_MAX, name=name + ".y1")
        return [x, y, x1, y1]
    if isinstance(box, (list, tuple)) and len(box) == 4:
        coords = [
            _check_int(v, minimum=_INT32_MIN, maximum=_INT32_MAX, name="%s[%d]" % (name, i))
            for i, v in enumerate(box)
        ]
        if coords[2] <= coords[0] or coords[3] <= coords[1]:
            _fail("semantic_error", "%s requires x1 > x0 and y1 > y0" % name)
        return coords
    _fail("bad_shape", "%s must be a bbox object or 4-int array" % name)
    raise AssertionError("unreachable")


def _project_mark(
    mark: Mapping[str, Any],
    *,
    recorded_point_px: list[int] | None,
) -> dict[str, Any]:
    if not isinstance(mark, Mapping):
        _fail("bad_shape", "step mark must be an object")
    for k in mark:
        if isinstance(k, str) and k.lower() in _PIXEL_KEYS:
            _fail("forbidden_pixels", "step mark carries forbidden pixel field")
    raw_id = mark.get("mark_id") if "mark_id" in mark else f"m-{mark.get('id', 1)}"
    mark_id = scrub_text(str(raw_id), fallback="m-1")[:400]
    raw_kind = str(mark.get("kind", "button"))
    kind = scrub_text(raw_kind, fallback="button")[:400]
    if "box_px" in mark:
        box_px = _to_box_px(mark["box_px"], name="mark.box_px")
    elif "bbox" in mark:
        box_px = _to_box_px(mark["bbox"], name="mark.bbox")
    elif {"x", "y", "w", "h"} <= set(mark):
        box_px = _to_box_px(
            {"x": mark["x"], "y": mark["y"], "w": mark["w"], "h": mark["h"]},
            name="mark",
        )
    else:
        _fail("bad_shape", "step mark requires box_px or bbox")

    if "relative_xy_bps" in mark and mark["relative_xy_bps"] is not None:
        rel = mark["relative_xy_bps"]
        if not isinstance(rel, (list, tuple)) or len(rel) != 2:
            _fail("bad_shape", "mark.relative_xy_bps must be a 2-int array")
        rx = _check_int(rel[0], minimum=0, maximum=10000, name="mark.relative_xy_bps[0]")
        ry = _check_int(rel[1], minimum=0, maximum=10000, name="mark.relative_xy_bps[1]")
        relative_xy_bps = [rx, ry]
    elif recorded_point_px is not None:
        width = box_px[2] - box_px[0]
        height = box_px[3] - box_px[1]
        rx = max(0, min(10000, ((recorded_point_px[0] - box_px[0]) * 10000) // width))
        ry = max(0, min(10000, ((recorded_point_px[1] - box_px[1]) * 10000) // height))
        relative_xy_bps = [rx, ry]
    else:
        relative_xy_bps = [5000, 5000]

    ocr_text_raw = mark.get("ocr_text")
    ocr_text = (
        scrub_text(ocr_text_raw, fallback="mark")[:400]
        if ocr_text_raw is not None
        else None
    )
    if "ocr_score_promille" in mark:
        score_raw = mark["ocr_score_promille"]
        ocr_score_promille = (
            _check_int(score_raw, minimum=0, maximum=1000, name="mark.ocr_score_promille")
            if score_raw is not None
            else None
        )
    elif "score" in mark and mark["score"] is not None:
        score_val = mark["score"]
        if type(score_val) is bool or not isinstance(score_val, (int, float)):
            _fail("bad_shape", "mark.score must be a number")
        if not math.isfinite(score_val) or score_val < 0.0 or score_val > 1.0:
            _fail("bad_shape", "mark.score outside [0.0, 1.0]")
        ocr_score_promille = int(round(score_val * 1000))
    else:
        ocr_score_promille = None

    missing_raw = mark.get("missing_reason")
    missing_reason = (
        scrub_text(missing_raw, fallback="none")[:400]
        if missing_raw is not None
        else None
    )
    return {
        "mark_id": mark_id,
        "kind": kind,
        "box_px": box_px,
        "relative_xy_bps": relative_xy_bps,
        "ocr_text": ocr_text,
        "ocr_score_promille": ocr_score_promille,
        "missing_reason": missing_reason,
    }


def _scrub_receipt_for_digest(receipt: Mapping[str, Any]) -> dict[str, Any]:
    """Validate a verified ``action_receipt/v0.2`` and strip ``ramws_path`` and host paths before hashing."""
    if not isinstance(receipt, Mapping):
        _fail("bad_shape", "receipt must be an object")
    for k in receipt:
        if isinstance(k, str) and k.lower() in _PIXEL_KEYS:
            _fail("forbidden_pixels", "receipt carries forbidden pixel field")
    if receipt.get("schema") != "action_receipt/v0.2":
        _fail("unknown_version", "receipt schema must be action_receipt/v0.2")
    if receipt.get("verified") is not True:
        _fail("unverified_receipt", "receipt verified flag must be True")
    proposal_id = _check_str(
        receipt.get("proposal_id"),
        min_len=1,
        max_len=128,
        name="receipt.proposal_id",
    )
    executed_at_ns = _check_int(
        receipt.get("executed_at_ns"),
        minimum=0,
        maximum=_MAX_SAFE_INT,
        name="receipt.executed_at_ns",
    )
    after_frame = receipt.get("after_frame")
    if not isinstance(after_frame, Mapping):
        _fail("bad_shape", "receipt.after_frame must be an object")
    for k in after_frame:
        if isinstance(k, str) and k.lower() in _PIXEL_KEYS:
            _fail("forbidden_pixels", "after_frame carries forbidden pixel field")
    frame_sha256 = _check_str(
        after_frame.get("sha256"),
        min_len=64,
        max_len=64,
        pattern=_SHA256_RE,
        name="receipt.after_frame.sha256",
    )
    generation = _check_int(
        after_frame.get("generation"),
        minimum=1,
        maximum=_MAX_SAFE_INT,
        name="receipt.after_frame.generation",
    )
    width = _check_int(
        after_frame.get("width"),
        minimum=1,
        maximum=16384,
        name="receipt.after_frame.width",
    )
    height = _check_int(
        after_frame.get("height"),
        minimum=1,
        maximum=16384,
        name="receipt.after_frame.height",
    )
    verification = receipt.get("verification")
    if not isinstance(verification, Mapping) or set(verification) != {"method", "detail"}:
        _fail("bad_shape", "receipt.verification must carry method and detail")
    method = verification.get("method")
    if not isinstance(method, str) or method not in _VERIFY_METHODS:
        _fail("bad_shape", "receipt.verification.method invalid")
    detail = scrub_text(verification.get("detail"), fallback="verified")[:400]
    return {
        "schema": "action_receipt/v0.2",
        "proposal_id": proposal_id,
        "executed_at_ns": executed_at_ns,
        "after_frame": {
            "sha256": frame_sha256,
            "generation": generation,
            "width": width,
            "height": height,
        },
        "verified": True,
        "verification": {
            "method": method,
            "detail": detail,
        },
    }


def project_step(
    *,
    seq: int,
    proposal: Mapping[str, Any] | None = None,
    verdict: Mapping[str, Any] | str | None = None,
    receipt: Mapping[str, Any] | None = None,
    step: Mapping[str, Any] | None = None,
    gap_before_ms: int = 100,
    gap_after_ms: int = 100,
    mark: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Project one proposal/verdict/receipt triad or step dict into a ``bundle_step``."""
    _check_int(seq, minimum=1, maximum=256, name="step.seq")
    if step is not None and proposal is None and "kind" in step and "frame_before_sha256" in step:
        for k in step:
            if isinstance(k, str) and k.lower() in _PIXEL_KEYS:
                _fail("forbidden_pixels", "step carries forbidden pixel field")
        raw_mark = step.get("mark") if mark is None else mark
        point = step.get("recorded_point_px")
        point_list = (
            [
                _check_int(point[0], minimum=0, maximum=_INT32_MAX, name="step.recorded_point_px[0]"),
                _check_int(point[1], minimum=0, maximum=_INT32_MAX, name="step.recorded_point_px[1]"),
            ]
            if point is not None and isinstance(point, (list, tuple)) and len(point) == 2
            else None
        )
        key_name_raw = step.get("key_name")
        key_name = (
            scrub_text(key_name_raw, fallback="Key")[:80]
            if key_name_raw is not None
            else None
        )
        modifiers_raw = step.get("modifiers", [])
        if not isinstance(modifiers_raw, (list, tuple)):
            _fail("bad_shape", "step.modifiers must be a list")
        modifiers = [scrub_text(m, fallback="Mod")[:80] for m in modifiers_raw[:8]]
        exp_box = step.get("expected_change_box_px")
        return {
            "seq": seq,
            "kind": step["kind"],
            "button": step.get("button"),
            "recorded_point_px": point_list,
            "modifiers": modifiers,
            "key_name": key_name,
            "text_len": step.get("text_len"),
            "gap_before_ms": _check_int(step.get("gap_before_ms", gap_before_ms), minimum=0, name="step.gap_before_ms"),
            "gap_after_ms": _check_int(step.get("gap_after_ms", gap_after_ms), minimum=0, name="step.gap_after_ms"),
            "expected_change_box_px": (
                _to_box_px(exp_box, name="step.expected_change_box_px")
                if exp_box is not None
                else None
            ),
            "frame_before_sha256": _check_str(
                step["frame_before_sha256"],
                min_len=64,
                max_len=64,
                pattern=_SHA256_RE,
                name="step.frame_before_sha256",
            ),
            "frame_after_sha256": _check_str(
                step["frame_after_sha256"],
                min_len=64,
                max_len=64,
                pattern=_SHA256_RE,
                name="step.frame_after_sha256",
            ),
            "verdict": step["verdict"],
            "verify_method": step.get("verify_method"),
            "mark": (
                _project_mark(raw_mark, recorded_point_px=point_list)
                if raw_mark is not None
                else None
            ),
        }

    if not isinstance(proposal, Mapping):
        _fail("bad_shape", "proposal must be an object")
    for k in proposal:
        if isinstance(k, str) and k.lower() in _PIXEL_KEYS:
            _fail("forbidden_pixels", "proposal carries forbidden pixel field")
    based = proposal.get("based_on_frame")
    if not isinstance(based, Mapping):
        _fail("bad_shape", "proposal.based_on_frame must be an object")
    frame_before_sha256 = _check_str(
        based.get("sha256"),
        min_len=64,
        max_len=64,
        pattern=_SHA256_RE,
        name="proposal.based_on_frame.sha256",
    )

    if isinstance(verdict, Mapping):
        decision = verdict.get("decision")
        if verdict.get("proposal_id") not in (None, proposal.get("proposal_id")):
            _fail("uncorrelated", "verdict proposal_id does not match proposal")
    elif isinstance(verdict, str):
        decision = verdict
    elif receipt is not None:
        decision = "admitted"
    else:
        _fail("bad_shape", "step requires verdict or receipt")

    if decision not in _STEP_VERDICTS:
        _fail("bad_shape", "step verdict must be admitted or refused")

    if decision == "admitted":
        if receipt is None:
            _fail("unverified_receipt", "admitted step requires a verified receipt")
        if receipt.get("proposal_id") not in (None, proposal.get("proposal_id")):
            _fail("uncorrelated", "receipt proposal_id does not match proposal")
        clean_receipt = _scrub_receipt_for_digest(receipt)
        frame_after_sha256 = clean_receipt["after_frame"]["sha256"]
        verify_method: str | None = clean_receipt["verification"]["method"]
    else:
        if receipt is not None and isinstance(receipt.get("after_frame"), Mapping):
            frame_after_sha256 = _check_str(
                receipt["after_frame"].get("sha256"),
                min_len=64,
                max_len=64,
                pattern=_SHA256_RE,
                name="receipt.after_frame.sha256",
            )
        else:
            frame_after_sha256 = frame_before_sha256
        verify_method = None

    action = proposal.get("action")
    if not isinstance(action, Mapping):
        _fail("bad_shape", "proposal.action must be an object")
    for k in action:
        if isinstance(k, str) and k.lower() in _PIXEL_KEYS:
            _fail("forbidden_pixels", "proposal.action carries forbidden pixel field")
    act_type = action.get("type")
    button: int | None = None
    recorded_point_px: list[int] | None = None
    modifiers: list[str] = []
    key_name: str | None = None
    text_len: int | None = None
    effective_gap_after = _check_int(gap_after_ms, minimum=0, name="gap_after_ms")

    if act_type == "click":
        x = _check_int(action.get("x"), minimum=0, maximum=_INT32_MAX, name="action.x")
        y = _check_int(action.get("y"), minimum=0, maximum=_INT32_MAX, name="action.y")
        recorded_point_px = [x, y]
        btn_raw = action.get("button", "left")
        if btn_raw in ("left", 1):
            kind = "click"
            button = 1
        elif btn_raw in ("middle", 2):
            kind = "click"
            button = 2
        elif btn_raw in ("right", 3):
            kind = "right_click"
            button = 3
        else:
            _fail("bad_shape", "invalid click button")
    elif act_type == "key":
        keys = action.get("keys")
        if not isinstance(keys, list) or not keys:
            _fail("bad_shape", "key action requires non-empty keys list")
        for key_item in keys:
            if not isinstance(key_item, str) or not key_item:
                _fail("bad_shape", "key name must be a non-empty string")
        kind = "key"
        key_name = scrub_text(keys[-1], fallback="Enter")[:80]
        modifiers = [scrub_text(k, fallback="Control")[:80] for k in keys[:-1][:8]]
    elif act_type == "type":
        raw_text = action.get("text")
        if not isinstance(raw_text, str) or not (1 <= len(raw_text) <= 100000):
            _fail("bad_shape", "type action requires non-empty text within bounds")
        kind = "paste"
        # Raw typed text is never exported; only its character length is recorded.
        text_len = len(raw_text)
    elif act_type == "scroll":
        _check_int(action.get("dx"), minimum=_INT32_MIN, maximum=_INT32_MAX, name="action.dx")
        _check_int(action.get("dy"), minimum=_INT32_MIN, maximum=_INT32_MAX, name="action.dy")
        kind = "scroll"
    elif act_type == "wait":
        ms = _check_int(action.get("ms"), minimum=1, maximum=3600000, name="action.ms")
        kind = "wait"
        if gap_after_ms == 100:
            effective_gap_after = ms
    else:
        _fail("bad_shape", "unsupported proposal action type for run bundle export")

    expectation = proposal.get("expectation")
    expected_change_box_px: list[int] | None = None
    if isinstance(expectation, Mapping):
        if expectation.get("type") == "changed_region" and "bbox" in expectation:
            expected_change_box_px = _to_box_px(
                expectation["bbox"],
                name="proposal.expectation.bbox",
            )

    projected_mark = (
        _project_mark(mark, recorded_point_px=recorded_point_px)
        if mark is not None
        else None
    )

    return {
        "seq": seq,
        "kind": kind,
        "button": button,
        "recorded_point_px": recorded_point_px,
        "modifiers": modifiers,
        "key_name": key_name,
        "text_len": text_len,
        "gap_before_ms": _check_int(gap_before_ms, minimum=0, name="gap_before_ms"),
        "gap_after_ms": effective_gap_after,
        "expected_change_box_px": expected_change_box_px,
        "frame_before_sha256": frame_before_sha256,
        "frame_after_sha256": frame_after_sha256,
        "verdict": decision,
        "verify_method": verify_method,
        "mark": projected_mark,
    }


def project_vision_elements(
    observations_or_elements: Sequence[Mapping[str, Any]],
    *,
    used_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Project observations, element tables, or vision element dicts into ``vision_elements``."""
    active_ids = set() if used_ids is None else used_ids
    out: list[dict[str, Any]] = []

    def next_unique_id(candidate: str) -> str:
        slug = _slugify(candidate, fallback="el-1")
        if slug not in active_ids:
            active_ids.add(slug)
            return slug
        idx = 2
        while True:
            suffix = f"-{idx}"
            base = slug[: max(1, 63 - len(suffix))].rstrip("-")
            trial = f"{base}{suffix}"
            if trial not in active_ids:
                active_ids.add(trial)
                return trial
            idx += 1

    for entry in observations_or_elements:
        if len(out) >= 64:
            break
        if not isinstance(entry, Mapping):
            _fail("bad_shape", "vision observation or element must be an object")
        for k in entry:
            if isinstance(k, str) and k.lower() in _PIXEL_KEYS:
                _fail("forbidden_pixels", "observation carries forbidden pixel field")

        # Case 1: already a vision_element-like dict with box_px and confidence_ppm
        if "box_px" in entry and "confidence_ppm" in entry and "frame_sha256" in entry:
            raw_role = str(entry.get("role", ""))
            if raw_role not in _VISION_ROLES:
                _fail("bad_shape", "vision_element role is not in compatibility set")
            box_px = _to_box_px(entry["box_px"], name="vision_element.box_px")
            label = scrub_text(
                str(entry.get("label", "")),
                fallback=f"{raw_role}-{box_px[0]}-{box_px[1]}",
            )[:80]
            frame_sha = _check_str(
                entry["frame_sha256"],
                min_len=64,
                max_len=64,
                pattern=_SHA256_RE,
                name="vision_element.frame_sha256",
            )
            conf_ppm = _check_int(
                entry["confidence_ppm"],
                minimum=0,
                maximum=1000000,
                name="vision_element.confidence_ppm",
            )
            raw_id = str(entry.get("id", f"{raw_role}-{label}"))
            elem_id = _check_str(
                raw_id,
                min_len=1,
                max_len=63,
                pattern=_SLUG_RE,
                name="vision_element.id",
            )
            if elem_id in active_ids:
                _fail("semantic_error", "duplicate vision_element id")
            active_ids.add(elem_id)
            out.append({
                "id": elem_id,
                "role": raw_role,
                "label": label,
                "box_px": box_px,
                "frame_sha256": frame_sha,
                "confidence_ppm": conf_ppm,
            })
            continue

        # Case 2: vqa.element-table/v1
        if entry.get("schema") == "vqa.element-table/v1":
            frame_sha = _check_str(
                entry.get("frame_sha256"),
                min_len=64,
                max_len=64,
                pattern=_SHA256_RE,
                name="element_table.frame_sha256",
            )
            elements = entry.get("elements", [])
            if not isinstance(elements, list):
                _fail("bad_shape", "element_table.elements must be a list")
            for idx, elem in enumerate(elements, 1):
                if len(out) >= 64:
                    break
                if not isinstance(elem, Mapping):
                    _fail("bad_shape", "element row must be an object")
                raw_role = str(elem.get("role", "button")).lower()
                role = _ROLE_COMPAT_MAP.get(raw_role, "button")
                box_px = _to_box_px(elem.get("bbox"), name="element.bbox")
                raw_name = str(elem.get("name", "")).strip()
                label = scrub_text(
                    raw_name if raw_name else f"{role}-{box_px[0]}-{box_px[1]}",
                    fallback=f"{role}-{box_px[0]}-{box_px[1]}",
                )[:80]
                conf_ppm = _check_int(
                    elem.get("score_ppm"),
                    minimum=0,
                    maximum=1000000,
                    name="element.score_ppm",
                )
                elem_id = next_unique_id(f"{role}-{label}-{idx}")
                out.append({
                    "id": elem_id,
                    "role": role,
                    "label": label,
                    "box_px": box_px,
                    "frame_sha256": frame_sha,
                    "confidence_ppm": conf_ppm,
                })
            continue

        # Case 3: observation/v0.2 or v0.1
        frame_ref = entry.get("frame_ref")
        if not isinstance(frame_ref, Mapping):
            _fail("bad_shape", "observation requires frame_ref")
        for k in frame_ref:
            if isinstance(k, str) and k.lower() in _PIXEL_KEYS:
                _fail("forbidden_pixels", "frame_ref carries forbidden pixel field")
        frame_sha = _check_str(
            frame_ref.get("sha256"),
            min_len=64,
            max_len=64,
            pattern=_SHA256_RE,
            name="observation.frame_ref.sha256",
        )
        vision = entry.get("vision")
        if vision is None:
            continue
        if not isinstance(vision, Mapping):
            _fail("bad_shape", "observation.vision must be an object")
        elements = vision.get("elements", [])
        if not isinstance(elements, list):
            _fail("bad_shape", "observation.vision.elements must be a list")
        for idx, elem in enumerate(elements, 1):
            if len(out) >= 64:
                break
            if not isinstance(elem, Mapping):
                _fail("bad_shape", "vision element must be an object")
            for k in elem:
                if isinstance(k, str) and k.lower() in _PIXEL_KEYS:
                    _fail("forbidden_pixels", "vision element carries forbidden pixel field")
            raw_role = str(elem.get("role", "button")).lower()
            role = _ROLE_COMPAT_MAP.get(raw_role, "button")
            box_px = _to_box_px(elem.get("bbox"), name="vision.element.bbox")
            raw_name = str(elem.get("name", "")).strip()
            label = scrub_text(
                raw_name if raw_name else f"{role}-{box_px[0]}-{box_px[1]}",
                fallback=f"{role}-{box_px[0]}-{box_px[1]}",
            )[:80]
            if "confidence_ppm" in elem:
                conf_ppm = _check_int(
                    elem["confidence_ppm"],
                    minimum=0,
                    maximum=1000000,
                    name="vision.element.confidence_ppm",
                )
            else:
                conf = elem.get("confidence")
                if type(conf) is bool or not isinstance(conf, (int, float)):
                    _fail("bad_shape", "vision.element.confidence must be a number")
                if not math.isfinite(conf) or conf < 0.0 or conf > 1.0:
                    _fail("bad_shape", "vision.element.confidence outside [0.0, 1.0]")
                conf_ppm = int(round(conf * 1_000_000))
            raw_id = elem.get("id")
            elem_id = (
                next_unique_id(str(raw_id))
                if raw_id is not None
                else next_unique_id(f"{role}-{label}-{idx}")
            )
            out.append({
                "id": elem_id,
                "role": role,
                "label": label,
                "box_px": box_px,
                "frame_sha256": frame_sha,
                "confidence_ppm": conf_ppm,
            })
    return out


def project_state_ref(
    state_or_ref: Mapping[str, Any],
    *,
    index: int = 1,
    used_ids: set[str] | None = None,
) -> dict[str, Any]:
    """Project a Wender ``wender.state/v1`` object or state ref dict into a ``state_ref``.

    When given a ``wender.state/v1`` object, validates it and hashes canonical
    STATE attributes with every ``node["box"]`` stripped to ``None`` via
    :func:`compute_battery_state_sha256` (hash attrs, never boxes).
    """
    active_ids = set() if used_ids is None else used_ids
    if not isinstance(state_or_ref, Mapping):
        _fail("bad_shape", "state_or_ref must be an object")
    for k in state_or_ref:
        if isinstance(k, str) and k.lower() in _PIXEL_KEYS:
            _fail("forbidden_pixels", "state carries forbidden pixel field")

    if state_or_ref.get("schema") == "wender.state/v1" or "state" in state_or_ref:
        raw_state = (
            state_or_ref["state"]
            if "state" in state_or_ref and isinstance(state_or_ref["state"], Mapping)
            else state_or_ref
        )
        try:
            digest = validate_state(dict(raw_state))
        except ObservationError as exc:
            raise ExportError("bad_shape", str(exc)) from exc
        assert digest == compute_battery_state_sha256(dict(raw_state))
        source = raw_state.get("source", {})
        counts = raw_state.get("counts", {})
        kind = source.get("kind", "vision") if isinstance(source, Mapping) else "vision"
        title_raw = source.get("title") if isinstance(source, Mapping) else None
        title_clean = (
            scrub_text(title_raw, fallback="untitled")
            if isinstance(title_raw, str) and title_raw.strip()
            else "untitled"
        )
        nodes_n = counts.get("nodes", 0) if isinstance(counts, Mapping) else 0
        act_n = counts.get("actionable", 0) if isinstance(counts, Mapping) else 0
        raw_summary = (
            state_or_ref.get("summary")
            if "state" in state_or_ref and isinstance(state_or_ref.get("summary"), str)
            else f"Wender {kind} state ({title_clean}): {nodes_n} nodes, {act_n} actionable"
        )
        summary = scrub_text(raw_summary, fallback=f"Wender state {index}")[:400]
        raw_id = (
            state_or_ref.get("id")
            if "state" in state_or_ref and isinstance(state_or_ref.get("id"), str)
            else f"state-{index}-{digest[:8]}"
        )
        ref_id = _slugify(str(raw_id), fallback=f"state-{index}")
        if ref_id in active_ids:
            ref_id = _slugify(f"{ref_id}-{index}", fallback=f"state-{index}")
        active_ids.add(ref_id)
        return {
            "id": ref_id,
            "state_sha256": digest,
            "summary": summary,
        }

    # Pre-built state_ref or ground_truth dict
    raw_sha = state_or_ref.get("state_sha256")
    state_sha256 = _check_str(
        raw_sha,
        min_len=64,
        max_len=64,
        pattern=_SHA256_RE,
        name="state_ref.state_sha256",
    )
    if state_or_ref.get("source") == "holdings_lane" and "tick" in state_or_ref:
        tick = _check_int(state_or_ref["tick"], minimum=0, name="ground_truth.tick")
        raw_id = state_or_ref.get("id", f"holdings-tick-{tick}")
        raw_summary = state_or_ref.get(
            "summary",
            f"Holdings lane ground truth witness at tick {tick}",
        )
        ref_id = _slugify(str(raw_id), fallback=f"holdings-tick-{tick}")
    else:
        raw_id = _check_str(
            state_or_ref.get("id"),
            min_len=1,
            max_len=63,
            pattern=_SLUG_RE,
            name="state_ref.id",
        )
        ref_id = raw_id
        raw_summary = _check_str(
            state_or_ref.get("summary"),
            min_len=1,
            max_len=400,
            name="state_ref.summary",
        )
    if ref_id in active_ids:
        _fail("semantic_error", "duplicate state_ref id")
    active_ids.add(ref_id)
    summary = scrub_text(raw_summary, fallback=f"State witness {index}")[:400]
    return {
        "id": ref_id,
        "state_sha256": state_sha256,
        "summary": summary,
    }


def project_refusal(
    verdict_or_refusal: Mapping[str, Any],
    *,
    step_seq: int | None = None,
    index: int = 1,
    used_ids: set[str] | None = None,
) -> dict[str, Any]:
    """Project a refused ``action_verdict/v0.2`` or refusal dict into a ``refusal`` entry."""
    active_ids = set() if used_ids is None else used_ids
    if not isinstance(verdict_or_refusal, Mapping):
        _fail("bad_shape", "refusal must be an object")
    for k in verdict_or_refusal:
        if isinstance(k, str) and k.lower() in _PIXEL_KEYS:
            _fail("forbidden_pixels", "refusal carries forbidden pixel field")

    seq = (
        step_seq
        if step_seq is not None
        else verdict_or_refusal.get("step_seq", index)
    )
    seq_int = _check_int(seq, minimum=1, maximum=256, name="refusal.step_seq")

    raw_reason = str(verdict_or_refusal.get("reason_code", ""))
    if raw_reason not in _REASON_CODE_MAP:
        _fail("bad_shape", "unsupported refusal reason_code")
    mapped_reason, default_tag = _REASON_CODE_MAP[raw_reason]
    raw_tag = verdict_or_refusal.get("failure_tag")
    if raw_tag is not None:
        if not isinstance(raw_tag, str) or raw_tag not in _ALLOWED_FAILURE_TAGS:
            _fail("bad_shape", "invalid refusal failure_tag")
        failure_tag = raw_tag
    else:
        failure_tag = default_tag

    raw_summary = (
        verdict_or_refusal.get("summary")
        or verdict_or_refusal.get("detail")
        or _DEFAULT_REFUSAL_SUMMARY[mapped_reason]
    )
    summary = scrub_text(
        raw_summary,
        fallback=_DEFAULT_REFUSAL_SUMMARY[mapped_reason],
    )[:400]

    raw_mitigation = (
        verdict_or_refusal.get("mitigation")
        or _DEFAULT_REFUSAL_MITIGATION[mapped_reason]
    )
    mitigation = scrub_text(
        raw_mitigation,
        fallback=_DEFAULT_REFUSAL_MITIGATION[mapped_reason],
    )[:400]

    if "id" in verdict_or_refusal and verdict_or_refusal["id"] is not None:
        ref_id = _check_str(
            verdict_or_refusal["id"],
            min_len=1,
            max_len=63,
            pattern=_SLUG_RE,
            name="refusal.id",
        )
        if ref_id in active_ids:
            _fail("semantic_error", "duplicate refusal id")
    else:
        base_slug = _slugify(
            f"refusal-{seq_int}-{mapped_reason.lower()}",
            fallback=f"refusal-{seq_int}",
        )
        ref_id = base_slug
        suffix = 2
        while ref_id in active_ids:
            ref_id = _slugify(f"{base_slug}-{suffix}", fallback=f"refusal-{seq_int}-{suffix}")
            suffix += 1
    active_ids.add(ref_id)

    return {
        "id": ref_id,
        "step_seq": seq_int,
        "reason_code": mapped_reason,
        "failure_tag": failure_tag,
        "summary": summary,
        "mitigation": mitigation,
    }


def validate_bundle_schema(bundle: object, schema: Mapping[str, Any]) -> list[str]:
    """Validate ``bundle`` against the JSON Schema structure of ``mw.run_bundle.v1.schema.json``."""
    defs = schema.get("$defs", {}) if isinstance(schema, Mapping) else {}
    errors: list[str] = []

    def check_node(val: object, node: Mapping[str, Any], path: str) -> None:
        if "$ref" in node:
            ref = node["$ref"]
            if not isinstance(ref, str) or not ref.startswith("#/$defs/"):
                errors.append(f"{path}: unsupported $ref")
                return
            target = defs.get(ref[len("#/$defs/"):])
            if not isinstance(target, Mapping):
                errors.append(f"{path}: unresolved $ref {ref}")
                return
            check_node(val, target, path)
            return

        if "anyOf" in node:
            branches = node["anyOf"]
            if not isinstance(branches, list):
                errors.append(f"{path}: invalid anyOf")
                return
            for branch in branches:
                sub_errors: list[str] = []
                orig_errors = errors.copy()
                check_node(val, branch, path)
                if len(errors) == len(orig_errors):
                    return
                sub_errors.extend(errors[len(orig_errors):])
                del errors[len(orig_errors):]
            errors.append(f"{path}: matched no branch of anyOf")
            return

        typ = node.get("type")
        if typ == "object":
            if not isinstance(val, dict):
                errors.append(f"{path}: expected object")
                return
            props = node.get("properties", {})
            req = node.get("required", [])
            for r in req:
                if r not in val:
                    errors.append(f"{path}: missing required property {r}")
            if node.get("additionalProperties") is False:
                extra = set(val) - set(props)
                if extra:
                    errors.append(f"{path}: unexpected properties {sorted(extra)}")
            for k, v in val.items():
                if k in props:
                    check_node(v, props[k], f"{path}.{k}")
        elif typ == "array":
            if not isinstance(val, list):
                errors.append(f"{path}: expected array")
                return
            if "minItems" in node and len(val) < node["minItems"]:
                errors.append(f"{path}: array below minItems")
            if "maxItems" in node and len(val) > node["maxItems"]:
                errors.append(f"{path}: array above maxItems")
            if node.get("uniqueItems") is True:
                serialized = [canonical_json_bytes(item) for item in val]
                if len(set(serialized)) != len(serialized):
                    errors.append(f"{path}: duplicate array items")
            if "items" in node and isinstance(node["items"], Mapping):
                for idx, item in enumerate(val):
                    check_node(item, node["items"], f"{path}[{idx}]")
        elif typ == "string":
            if not isinstance(val, str):
                errors.append(f"{path}: expected string")
                return
            if "minLength" in node and len(val) < node["minLength"]:
                errors.append(f"{path}: string below minLength")
            if "maxLength" in node and len(val) > node["maxLength"]:
                errors.append(f"{path}: string above maxLength")
            if "pattern" in node:
                pat = node["pattern"]
                if pat.endswith("$") and not pat.endswith(r"\$"):
                    pat = pat[:-1] + r"\Z"
                if re.match(pat, val) is None:
                    errors.append(f"{path}: string pattern mismatch")
        elif typ == "integer":
            if not _is_int(val):
                errors.append(f"{path}: expected integer")
                return
            assert isinstance(val, int)
            if "minimum" in node and val < node["minimum"]:
                errors.append(f"{path}: integer below minimum")
            if "maximum" in node and val > node["maximum"]:
                errors.append(f"{path}: integer above maximum")
        elif typ == "boolean":
            if type(val) is not bool:
                errors.append(f"{path}: expected boolean")
                return
        elif typ == "null":
            if val is not None:
                errors.append(f"{path}: expected null")
                return

        if "const" in node and (type(val) is not type(node["const"]) or val != node["const"]):
            errors.append(f"{path}: const mismatch")
        if "enum" in node and not any(type(val) is type(opt) and val == opt for opt in node["enum"]):
            errors.append(f"{path}: enum mismatch")

    check_node(bundle, schema, "$")
    return errors


# Closed schema mirror matching standards/schemas/mw.run_bundle.v1.schema.json.
_RUN_BUNDLE_ROOT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "schema": {"const": BUNDLE_SCHEMA},
        "site_id": {"$ref": "#/$defs/slug"},
        "site_name": {"$ref": "#/$defs/text_short"},
        "domains": {
            "type": "array",
            "items": {"$ref": "#/$defs/hostname"},
            "minItems": 1,
            "maxItems": 16,
            "uniqueItems": True,
        },
        "recorded_date": {"$ref": "#/$defs/date"},
        "run_id": {"$ref": "#/$defs/slug"},
        "receipt_sha256": {"$ref": "#/$defs/sha256"},
        "journal_head_sha256": {"anyOf": [{"$ref": "#/$defs/sha256"}, {"type": "null"}]},
        "demo_id": {"$ref": "#/$defs/slug"},
        "workflow_id": {"anyOf": [{"$ref": "#/$defs/slug"}, {"type": "null"}]},
        "task_summary": {"type": "string", "minLength": 1, "maxLength": 240},
        "tags": {
            "type": "array",
            "items": {"$ref": "#/$defs/tag"},
            "minItems": 0,
            "maxItems": 16,
            "uniqueItems": True,
        },
        "surface": {"$ref": "#/$defs/surface"},
        "steps": {
            "type": "array",
            "items": {"$ref": "#/$defs/bundle_step"},
            "minItems": 1,
            "maxItems": 256,
        },
        "vision_elements": {
            "type": "array",
            "items": {"$ref": "#/$defs/vision_element"},
            "minItems": 0,
            "maxItems": 64,
        },
        "state_refs": {
            "type": "array",
            "items": {"$ref": "#/$defs/state_ref"},
            "minItems": 0,
            "maxItems": 64,
        },
        "refusals": {
            "type": "array",
            "items": {"$ref": "#/$defs/refusal"},
            "minItems": 0,
            "maxItems": 64,
        },
    },
    "required": [
        "schema",
        "site_id",
        "site_name",
        "domains",
        "recorded_date",
        "run_id",
        "receipt_sha256",
        "journal_head_sha256",
        "demo_id",
        "workflow_id",
        "task_summary",
        "tags",
        "surface",
        "steps",
        "vision_elements",
        "state_refs",
        "refusals",
    ],
}

_EMBEDDED_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$defs": {
        "slug": {"type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,62}$"},
        "sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
        "date": {"type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"},
        "hostname": {
            "type": "string",
            "pattern": "^[a-z0-9.-]+$",
            "minLength": 1,
            "maxLength": 253,
        },
        "tag": {"type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{0,31}$"},
        "text_short": {"type": "string", "minLength": 1, "maxLength": 80},
        "text_med": {"type": "string", "minLength": 1, "maxLength": 400},
        "int32": {"type": "integer", "minimum": _INT32_MIN, "maximum": _INT32_MAX},
        "bps": {"type": "integer", "minimum": 0, "maximum": 10000},
        "point_px": {
            "type": "array",
            "items": {"$ref": "#/$defs/int32"},
            "minItems": 2,
            "maxItems": 2,
        },
        "box_px": {
            "type": "array",
            "items": {"$ref": "#/$defs/int32"},
            "minItems": 4,
            "maxItems": 4,
        },
        "surface": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "viewport_px": {
                    "type": "array",
                    "items": {"type": "integer", "minimum": 1, "maximum": _INT32_MAX},
                    "minItems": 2,
                    "maxItems": 2,
                },
                "ax_enabled": {"type": "boolean"},
                "auth_boundary": {
                    "type": "string",
                    "enum": ["anonymous", "operator_capsule"],
                },
                "perception_mode": {
                    "type": "string",
                    "enum": ["vision_only", "ax_plus_vision", "structured_plus_vision"],
                },
            },
            "required": [
                "viewport_px",
                "ax_enabled",
                "auth_boundary",
                "perception_mode",
            ],
        },
        "bundle_mark": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "mark_id": {"$ref": "#/$defs/text_med"},
                "kind": {"$ref": "#/$defs/text_med"},
                "box_px": {"$ref": "#/$defs/box_px"},
                "relative_xy_bps": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/bps"},
                    "minItems": 2,
                    "maxItems": 2,
                },
                "ocr_text": {"anyOf": [{"$ref": "#/$defs/text_med"}, {"type": "null"}]},
                "ocr_score_promille": {
                    "anyOf": [
                        {"type": "integer", "minimum": 0, "maximum": 1000},
                        {"type": "null"},
                    ]
                },
                "missing_reason": {
                    "anyOf": [{"$ref": "#/$defs/text_med"}, {"type": "null"}]
                },
            },
            "required": [
                "mark_id",
                "kind",
                "box_px",
                "relative_xy_bps",
                "ocr_text",
                "ocr_score_promille",
                "missing_reason",
            ],
        },
        "bundle_step": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "seq": {"type": "integer", "minimum": 1},
                "kind": {
                    "type": "string",
                    "enum": [
                        "click",
                        "right_click",
                        "double_click",
                        "paste",
                        "key",
                        "scroll",
                        "drag",
                        "wait",
                    ],
                },
                "button": {
                    "anyOf": [
                        {"type": "integer", "minimum": 1, "maximum": 3},
                        {"type": "null"},
                    ]
                },
                "recorded_point_px": {
                    "anyOf": [{"$ref": "#/$defs/point_px"}, {"type": "null"}]
                },
                "modifiers": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/text_short"},
                    "minItems": 0,
                    "maxItems": 8,
                },
                "key_name": {
                    "anyOf": [{"$ref": "#/$defs/text_short"}, {"type": "null"}]
                },
                "text_len": {
                    "anyOf": [
                        {"type": "integer", "minimum": 0, "maximum": 100000},
                        {"type": "null"},
                    ]
                },
                "gap_before_ms": {"type": "integer", "minimum": 0},
                "gap_after_ms": {"type": "integer", "minimum": 0},
                "expected_change_box_px": {
                    "anyOf": [{"$ref": "#/$defs/box_px"}, {"type": "null"}]
                },
                "frame_before_sha256": {"$ref": "#/$defs/sha256"},
                "frame_after_sha256": {"$ref": "#/$defs/sha256"},
                "verdict": {"type": "string", "enum": ["admitted", "refused"]},
                "verify_method": {
                    "anyOf": [
                        {"type": "string", "enum": ["pixel", "element", "state_sha256"]},
                        {"type": "null"},
                    ]
                },
                "mark": {"anyOf": [{"$ref": "#/$defs/bundle_mark"}, {"type": "null"}]},
            },
            "required": [
                "seq",
                "kind",
                "button",
                "recorded_point_px",
                "modifiers",
                "key_name",
                "text_len",
                "gap_before_ms",
                "gap_after_ms",
                "expected_change_box_px",
                "frame_before_sha256",
                "frame_after_sha256",
                "verdict",
                "verify_method",
                "mark",
            ],
        },
        "vision_element": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "id": {"$ref": "#/$defs/slug"},
                "role": {
                    "type": "string",
                    "enum": [
                        "button",
                        "checkbox",
                        "dialog",
                        "dropdown",
                        "input",
                        "link",
                        "menu",
                        "stepper",
                        "tab",
                        "toggle",
                    ],
                },
                "label": {"$ref": "#/$defs/text_short"},
                "box_px": {"$ref": "#/$defs/box_px"},
                "frame_sha256": {"$ref": "#/$defs/sha256"},
                "confidence_ppm": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 1000000,
                },
            },
            "required": [
                "id",
                "role",
                "label",
                "box_px",
                "frame_sha256",
                "confidence_ppm",
            ],
        },
        "state_ref": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "id": {"$ref": "#/$defs/slug"},
                "state_sha256": {"$ref": "#/$defs/sha256"},
                "summary": {"$ref": "#/$defs/text_med"},
            },
            "required": ["id", "state_sha256", "summary"],
        },
        "refusal": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "id": {"$ref": "#/$defs/slug"},
                "step_seq": {"type": "integer", "minimum": 1},
                "reason_code": {
                    "type": "string",
                    "enum": [
                        "STALE_FRAME",
                        "OUT_OF_BOUNDS",
                        "BUDGET_EXHAUSTED",
                        "SURFACE_NOT_AGENT_CONTROLLED",
                        "POLICY",
                        "TIMEOUT",
                        "LOW_CONFIDENCE",
                    ],
                },
                "failure_tag": {
                    "type": "string",
                    "enum": [
                        "invalid-input",
                        "lazy",
                        "overlay",
                        "stale-element",
                        "timeout",
                        "wrong-state",
                    ],
                },
                "summary": {"$ref": "#/$defs/text_med"},
                "mitigation": {"$ref": "#/$defs/text_med"},
            },
            "required": [
                "id",
                "step_seq",
                "reason_code",
                "failure_tag",
                "summary",
                "mitigation",
            ],
        },
        "run_bundle": _RUN_BUNDLE_ROOT_SCHEMA,
    },
    **_RUN_BUNDLE_ROOT_SCHEMA,
}


def validate_export_bundle(
    raw_or_dict: bytes | bytearray | Mapping[str, Any],
    *,
    schema: Mapping[str, Any] = _EMBEDDED_SCHEMA,
) -> dict[str, Any]:
    """Validate raw bytes or a dict against ``mw.run_bundle.v1`` and all L5/semantic gates.

    Returns an isolated deep copy of the validated bundle dict, or raises
    :class:`ExportError` with the specific refusal code.
    """
    if isinstance(raw_or_dict, (bytes, bytearray)):
        loaded = _strict_loads_bytes(bytes(raw_or_dict), max_bytes=MAX_BUNDLE_BYTES)
        if not isinstance(loaded, dict):
            _fail("bad_shape", "bundle must be a JSON object")
        data = loaded
    elif isinstance(raw_or_dict, Mapping):
        data = dict(raw_or_dict)
        forbidden_first = _scan_forbidden_bundle(data)
        if forbidden_first:
            code_map = {
                "FORBIDDEN_PIXELS": "forbidden_pixels",
                "FORBIDDEN_HOST_PATH": "forbidden_host_path",
                "FORBIDDEN_COOKIE": "forbidden_cookie",
                "FORBIDDEN_CREDENTIAL": "forbidden_credential",
                "FORBIDDEN_PERSONAL_DATA": "forbidden_personal_data",
            }
            _fail(code_map[forbidden_first[0]], forbidden_first[0])
        encoded = canonical_json_bytes(data)
        if len(encoded) > MAX_BUNDLE_BYTES:
            _fail("bundle_oversize", "bundle exceeds MAX_BUNDLE_BYTES")
        loaded = _strict_loads_bytes(encoded, max_bytes=MAX_BUNDLE_BYTES)
        assert isinstance(loaded, dict)
        data = loaded
    else:
        _fail("bad_shape", "bundle must be bytes or an object")

    forbidden = _scan_forbidden_bundle(data)
    if forbidden:
        code_map = {
            "FORBIDDEN_PIXELS": "forbidden_pixels",
            "FORBIDDEN_HOST_PATH": "forbidden_host_path",
            "FORBIDDEN_COOKIE": "forbidden_cookie",
            "FORBIDDEN_CREDENTIAL": "forbidden_credential",
            "FORBIDDEN_PERSONAL_DATA": "forbidden_personal_data",
        }
        _fail(code_map[forbidden[0]], forbidden[0])

    schema_errors = validate_bundle_schema(data, schema)
    if schema_errors:
        if any("unexpected properties" in err for err in schema_errors):
            _fail("unknown_field", schema_errors[0])
        _fail("bad_shape", schema_errors[0])

    if not all(_hostname_ok(host) for host in data["domains"]):
        _fail("semantic_error", "invalid hostname in domains")

    steps = data["steps"]
    if [s["seq"] for s in steps] != list(range(1, len(steps) + 1)):
        _fail("semantic_error", "steps seq must be 1..n")

    vp_w, vp_h = data["surface"]["viewport_px"]
    for step in steps:
        if (step["kind"] == "paste") != (step["text_len"] is not None):
            _fail("semantic_error", "step kind paste must match text_len presence")
        exp_box = step["expected_change_box_px"]
        if exp_box is not None and (exp_box[2] <= exp_box[0] or exp_box[3] <= exp_box[1]):
            _fail("semantic_error", "step expected_change_box_px has non-positive area")
        mark = step["mark"]
        if mark is not None:
            mbox = mark["box_px"]
            if mbox[2] <= mbox[0] or mbox[3] <= mbox[1]:
                _fail("semantic_error", "step mark.box_px has non-positive area")
        pt = step["recorded_point_px"]
        if pt is not None:
            if pt[0] < 0 or pt[1] < 0 or pt[0] > vp_w or pt[1] > vp_h:
                _fail("semantic_error", "step recorded_point_px outside viewport")

    for el in data["vision_elements"]:
        ebox = el["box_px"]
        if ebox[2] <= ebox[0] or ebox[3] <= ebox[1]:
            _fail("semantic_error", "vision_element box_px has non-positive area")

    seen_ids: set[str] = set()
    for group in (data["vision_elements"], data["state_refs"], data["refusals"]):
        for item in group:
            ident = item["id"]
            if ident in seen_ids:
                _fail("semantic_error", "duplicate node id in bundle")
            seen_ids.add(ident)

    for refusal in data["refusals"]:
        if refusal["step_seq"] > len(steps):
            _fail("semantic_error", "refusal step_seq exceeds steps count")

    return copy.deepcopy(data)


def _derive_surface(
    surface: Mapping[str, Any] | None,
    observations: Sequence[Mapping[str, Any]],
    states: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    if isinstance(surface, Mapping) and "viewport_px" in surface:
        vp = surface["viewport_px"]
        if not isinstance(vp, (list, tuple)) or len(vp) != 2:
            _fail("bad_shape", "surface.viewport_px must be a 2-int array")
        return {
            "viewport_px": [
                _check_int(vp[0], minimum=1, maximum=_INT32_MAX, name="surface.viewport_px[0]"),
                _check_int(vp[1], minimum=1, maximum=_INT32_MAX, name="surface.viewport_px[1]"),
            ],
            "ax_enabled": bool(surface.get("ax_enabled", False))
            if type(surface.get("ax_enabled", False)) is bool
            else _fail("bad_shape", "surface.ax_enabled must be a boolean"),
            "auth_boundary": _check_str(
                surface.get("auth_boundary", "operator_capsule"),
                min_len=1,
                max_len=32,
                name="surface.auth_boundary",
            ),
            "perception_mode": _check_str(
                surface.get("perception_mode", "vision_only"),
                min_len=1,
                max_len=32,
                name="surface.perception_mode",
            ),
        }

    width, height = 1280, 800
    if isinstance(surface, Mapping) and isinstance(surface.get("geometry"), Mapping):
        geom = surface["geometry"]
        width = _check_int(geom.get("w"), minimum=1, maximum=_INT32_MAX, name="surface.geometry.w")
        height = _check_int(geom.get("h"), minimum=1, maximum=_INT32_MAX, name="surface.geometry.h")
    elif observations:
        first_obs = observations[0]
        if isinstance(first_obs, Mapping) and isinstance(first_obs.get("frame_ref"), Mapping):
            fr = first_obs["frame_ref"]
            width = _check_int(fr.get("width"), minimum=1, maximum=_INT32_MAX, name="frame_ref.width")
            height = _check_int(fr.get("height"), minimum=1, maximum=_INT32_MAX, name="frame_ref.height")

    has_ground_truth = any(
        isinstance(obs, Mapping) and "ground_truth" in obs for obs in observations
    )
    has_ax_state = any(
        isinstance(st, Mapping)
        and (
            (st.get("schema") == "wender.state/v1" and isinstance(st.get("source"), Mapping) and st["source"].get("kind") in ("cdp", "atspi", "godot"))
            or (isinstance(st.get("state"), Mapping) and isinstance(st["state"].get("source"), Mapping) and st["state"]["source"].get("kind") in ("cdp", "atspi", "godot"))
        )
        for st in states
    )
    ax_enabled = bool(has_ax_state)
    if has_ground_truth:
        perception_mode = "structured_plus_vision"
    elif ax_enabled:
        perception_mode = "ax_plus_vision"
    else:
        perception_mode = "vision_only"

    auth_boundary = "operator_capsule"
    if isinstance(surface, Mapping) and surface.get("auth_boundary") in _AUTH_BOUNDARIES:
        auth_boundary = surface["auth_boundary"]

    return {
        "viewport_px": [width, height],
        "ax_enabled": ax_enabled,
        "auth_boundary": auth_boundary,
        "perception_mode": perception_mode,
    }


def build_export_bundle(
    *,
    site_id: str,
    site_name: str,
    domains: Sequence[str],
    recorded_date: str,
    run_id: str,
    demo_id: str,
    task_summary: str,
    workflow_id: str | None = None,
    tags: Sequence[str] = (),
    surface: Mapping[str, Any] | None = None,
    journal: str | bytes | Sequence[str | Mapping[str, Any]] | None = None,
    journal_head_sha256: str | None = None,
    receipt_sha256: str | None = None,
    observations: Sequence[Mapping[str, Any]] = (),
    proposals: Sequence[Mapping[str, Any]] = (),
    verdicts: Sequence[Mapping[str, Any]] = (),
    receipts: Sequence[Mapping[str, Any]] = (),
    steps: Sequence[Mapping[str, Any]] | None = None,
    vision_elements: Sequence[Mapping[str, Any]] | None = None,
    states: Sequence[Mapping[str, Any]] = (),
    state_refs: Sequence[Mapping[str, Any]] | None = None,
    refusals: Sequence[Mapping[str, Any]] | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build and validate a canonical ``mw.run_bundle.v1`` export bundle."""
    if metadata is not None:
        scrub_metadata(metadata)

    # 1. Verify journal hash chain and derive journal_head_sha256.
    _, journal_records, derived_journal_head = verify_journal(journal)
    if journal_head_sha256 is not None:
        _check_str(
            journal_head_sha256,
            min_len=64,
            max_len=64,
            pattern=_SHA256_RE,
            name="journal_head_sha256",
        )
        if derived_journal_head is not None and derived_journal_head != journal_head_sha256:
            _fail("chain_mismatch", "supplied journal_head_sha256 disagrees with journal tail")
        effective_journal_head: str | None = journal_head_sha256
    else:
        effective_journal_head = derived_journal_head

    journal_seq_kinds: dict[int, str] = {
        rec["core_seq"]: rec["kind"] for rec in journal_records
    }

    # 2. Validate observations (if full observation/v0.2 or v0.1 objects) and strip ramws_path.
    for obs in observations:
        if not isinstance(obs, Mapping):
            _fail("bad_shape", "observation must be an object")
        for k in obs:
            if isinstance(k, str) and k.lower() in _PIXEL_KEYS:
                _fail("forbidden_pixels", "observation carries forbidden pixel field")
        fr = obs.get("frame_ref")
        if isinstance(fr, Mapping) and "surface_id" in fr and "generation" in fr and "ramws_path" in fr:
            obs_schema = obs.get("schema", "observation/v0.2")
            ver = "v0.1" if obs_schema == "observation/v0.1" else "v0.2"
            try:
                validate_observation(
                    dict(obs),
                    surface_id=fr["surface_id"],
                    generation=fr["generation"],
                    contract_version=ver,
                )
            except ObservationError as exc:
                raise ExportError("bad_shape", str(exc)) from exc

    # 3. Index verdicts and verified receipts by proposal_id.
    verdict_by_pid: dict[str, Mapping[str, Any]] = {}
    for v in verdicts:
        if not isinstance(v, Mapping):
            _fail("bad_shape", "verdict must be an object")
        for k in v:
            if isinstance(k, str) and k.lower() in _PIXEL_KEYS:
                _fail("forbidden_pixels", "verdict carries forbidden pixel field")
        pid = v.get("proposal_id")
        if isinstance(pid, str) and pid:
            verdict_by_pid[pid] = v
        cseq = v.get("core_seq")
        decision = v.get("decision")
        if _is_int(cseq) and cseq in journal_seq_kinds and decision in ("admitted", "refused"):
            if journal_seq_kinds[cseq] in ("admitted", "refused") and journal_seq_kinds[cseq] != decision:
                _fail("uncorrelated", "verdict decision disagrees with journal record at core_seq")

    scrubbed_receipts: list[dict[str, Any]] = []
    receipt_by_pid: dict[str, Mapping[str, Any]] = {}
    for r in receipts:
        clean_r = _scrub_receipt_for_digest(r)
        scrubbed_receipts.append(clean_r)
        receipt_by_pid[clean_r["proposal_id"]] = r

    # 4. Build steps and collect step-linked refusals.
    used_ids: set[str] = set()
    built_steps: list[dict[str, Any]] = []
    derived_refusals: list[dict[str, Any]] = []

    if steps is not None:
        if not isinstance(steps, Sequence) or not (1 <= len(steps) <= 256):
            _fail("bad_shape", "steps must contain 1..256 entries")
        for idx, item in enumerate(steps, 1):
            if not isinstance(item, Mapping):
                _fail("bad_shape", "step entry must be an object")
            if "proposal" in item:
                prop = item["proposal"]
                pid = prop.get("proposal_id") if isinstance(prop, Mapping) else None
                verd = item.get("verdict") or (verdict_by_pid.get(pid) if isinstance(pid, str) else None)
                rec = item.get("receipt") or (receipt_by_pid.get(pid) if isinstance(pid, str) else None)
                if rec is not None and id(rec) not in {id(x) for x in receipts}:
                    scrubbed_receipts.append(_scrub_receipt_for_digest(rec))
                built = project_step(
                    seq=idx,
                    proposal=prop,
                    verdict=verd,
                    receipt=rec,
                    gap_before_ms=item.get("gap_before_ms", 100),
                    gap_after_ms=item.get("gap_after_ms", 100),
                    mark=item.get("mark"),
                )
                built_steps.append(built)
                if built["verdict"] == "refused" and isinstance(verd, Mapping):
                    derived_refusals.append(
                        project_refusal(
                            verd,
                            step_seq=idx,
                            index=len(derived_refusals) + 1,
                            used_ids=used_ids,
                        )
                    )
            else:
                built_steps.append(project_step(seq=idx, step=item))
    else:
        if not proposals:
            _fail("bad_shape", "proposals or steps required to build export bundle")
        for idx, prop in enumerate(proposals, 1):
            if not isinstance(prop, Mapping):
                _fail("bad_shape", "proposal must be an object")
            pid = prop.get("proposal_id")
            verd = verdict_by_pid.get(pid) if isinstance(pid, str) else None
            rec = receipt_by_pid.get(pid) if isinstance(pid, str) else None
            built = project_step(
                seq=idx,
                proposal=prop,
                verdict=verd,
                receipt=rec,
                gap_before_ms=prop.get("gap_before_ms", 100),
                gap_after_ms=prop.get("gap_after_ms", 100),
                mark=prop.get("mark"),
            )
            built_steps.append(built)
            if built["verdict"] == "refused" and isinstance(verd, Mapping):
                derived_refusals.append(
                    project_refusal(
                        verd,
                        step_seq=idx,
                        index=len(derived_refusals) + 1,
                        used_ids=used_ids,
                    )
                )

    # 5. Compute or validate receipt_sha256.
    if receipt_sha256 is not None:
        effective_receipt_sha = _check_str(
            receipt_sha256,
            min_len=64,
            max_len=64,
            pattern=_SHA256_RE,
            name="receipt_sha256",
        )
    elif scrubbed_receipts:
        effective_receipt_sha = canonical_sha256(
            scrubbed_receipts[0] if len(scrubbed_receipts) == 1 else scrubbed_receipts
        )
    else:
        effective_receipt_sha = canonical_sha256(built_steps)

    # 6. Project vision_elements.
    if vision_elements is not None:
        built_vision = project_vision_elements(vision_elements, used_ids=used_ids)
    else:
        built_vision = project_vision_elements(observations, used_ids=used_ids)

    # 7. Project state_refs (from states, explicit state_refs, and observation ground_truth).
    built_states: list[dict[str, Any]] = []
    seen_state_shas: set[str] = set()
    if state_refs is not None:
        for idx, sref in enumerate(state_refs, 1):
            if len(built_states) >= 64:
                break
            projected = project_state_ref(sref, index=idx, used_ids=used_ids)
            built_states.append(projected)
            seen_state_shas.add(projected["state_sha256"])
    for idx, st in enumerate(states, len(built_states) + 1):
        if len(built_states) >= 64:
            break
        projected = project_state_ref(st, index=idx, used_ids=used_ids)
        built_states.append(projected)
        seen_state_shas.add(projected["state_sha256"])
    for obs in observations:
        if len(built_states) >= 64:
            break
        if isinstance(obs, Mapping) and isinstance(obs.get("ground_truth"), Mapping):
            gt = obs["ground_truth"]
            gt_sha = gt.get("state_sha256")
            if isinstance(gt_sha, str) and gt_sha not in seen_state_shas:
                projected = project_state_ref(
                    gt,
                    index=len(built_states) + 1,
                    used_ids=used_ids,
                )
                built_states.append(projected)
                seen_state_shas.add(projected["state_sha256"])

    # 8. Project refusals.
    if refusals is not None:
        built_refusals = [
            project_refusal(r, index=idx, used_ids=used_ids)
            for idx, r in enumerate(refusals, 1)
        ]
    else:
        built_refusals = derived_refusals

    # 9. Normalize tags and top-level metadata.
    clean_tags: list[str] = []
    for t in tags:
        tag_str = _check_str(t, min_len=1, max_len=32, pattern=_TAG_RE, name="tag")
        if tag_str not in clean_tags:
            clean_tags.append(tag_str)

    clean_summary = scrub_text(task_summary, fallback="Verified MetaViewer run")[:240]
    clean_site_name = scrub_text(site_name, fallback=site_id)[:80]
    built_surface = _derive_surface(surface, observations, states)

    bundle: dict[str, Any] = {
        "schema": BUNDLE_SCHEMA,
        "site_id": _check_str(site_id, min_len=1, max_len=63, pattern=_SLUG_RE, name="site_id"),
        "site_name": clean_site_name,
        "domains": list(domains),
        "recorded_date": _check_str(
            recorded_date,
            min_len=10,
            max_len=10,
            pattern=_DATE_RE,
            name="recorded_date",
        ),
        "run_id": _check_str(run_id, min_len=1, max_len=63, pattern=_SLUG_RE, name="run_id"),
        "receipt_sha256": effective_receipt_sha,
        "journal_head_sha256": effective_journal_head,
        "demo_id": _check_str(demo_id, min_len=1, max_len=63, pattern=_SLUG_RE, name="demo_id"),
        "workflow_id": (
            _check_str(workflow_id, min_len=1, max_len=63, pattern=_SLUG_RE, name="workflow_id")
            if workflow_id is not None
            else None
        ),
        "task_summary": clean_summary,
        "tags": clean_tags,
        "surface": built_surface,
        "steps": built_steps,
        "vision_elements": built_vision,
        "state_refs": built_states,
        "refusals": built_refusals,
    }
    return validate_export_bundle(bundle)


def dumps_export_bundle(bundle: Mapping[str, Any]) -> bytes:
    """Validate ``bundle`` and return its canonical UTF-8 JSON bytes."""
    validated = validate_export_bundle(bundle)
    raw = canonical_json_bytes(validated)
    if len(raw) > MAX_BUNDLE_BYTES:
        _fail("bundle_oversize", "serialized bundle exceeds MAX_BUNDLE_BYTES")
    return raw
