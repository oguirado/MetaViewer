"""Closed mvctl tool verbs over a bounded agent mailbox client.

Each verb builds one ``mv_tool_call/v0.2`` body, sends it through the
injected client, and validates the ``mv_tool_result/v0.2`` reply before
interpreting it. This module never opens sockets: envelope framing,
sender identity, sequence, nonce replay and byte caps belong to the
client. Core admission and verification outcomes pass through verbatim;
local failures never fabricate core metadata.

[TARGET, unit decision] Recording verbs ``record_start`` and ``record_stop``
send validated ``record_request/v0.2`` frames and validate ``record_event/v0.2``
stream outcomes without modifying the frozen ``__all__`` MCP tool surface.
"""

from __future__ import annotations

import copy
import math
import re
import secrets
import time
from typing import Protocol

from .observe import ObservationError, validate_observation

__all__ = [
    "ToolClient",
    "ToolRefusal",
    "ToolValidationError",
    "VerificationFailed",
    "list_surfaces",
    "observe",
    "propose",
    "wait_verify",
]

_CALL_SCHEMA = "mv_tool_call/v0.2"
_RESULT_SCHEMA = "mv_tool_result/v0.2"
_CALL_FAMILY = "mv_tool_call/"
_RESULT_FAMILY = "mv_tool_result/"
_PROPOSAL_SCHEMA = "action_proposal/v0.2"
_PROPOSAL_FAMILY = "action_proposal/"
_OBSERVATION_SCHEMA = "observation/v0.2"
_FRAME_SCHEMA = "frame_ref/v0.2"
_VERDICT_SCHEMA = "action_verdict/v0.2"
_RECEIPT_SCHEMA = "action_receipt/v0.2"
_SURFACE_SCHEMA = "surface/v0.2"
_RECORD_REQUEST_SCHEMA = "record_request/v0.2"
_RECORD_REQUEST_FAMILY = "record_request/"
_RECORD_EVENT_SCHEMA = "record_event/v0.2"
_RECORD_EVENT_FAMILY = "record_event/"

_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*")
_SHA_PATTERN = re.compile(r"[0-9a-f]{64}")
_RAMWS_PATTERN = re.compile(r"/dev/shm(/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}){1,8}\Z")
_RAM_RECORD_PATTERN = _RAMWS_PATTERN
_ABS_PATH_PATTERN = re.compile(r"/[^\x00\r\n]*")
_MAX_SAFE_INT = 9007199254740991
_MAX_RING_BYTES = 1073741824
_MAX_FPS = 120
_MAX_RECORD_STREAM_EVENTS = 256
_LIST_LIMIT_MAX = 256
_WAIT_TIMEOUT_MAX_MS = 60000
_MAX_VISION_SUMMARY = 4096

_REFUSAL_CODES = frozenset({
    "STALE_FRAME",
    "SURFACE_NOT_AGENT_CONTROLLED",
    "LOCKED_BY_OTHER",
    "BUDGET_EXCEEDED",
    "OUT_OF_BOUNDS",
    "POLICY",
})
_ERROR_CODES = frozenset({
    "PROTOCOL",
    "UNAVAILABLE",
    "NOT_FOUND",
    "VERIFICATION_FAILED",
})
_VERIFICATION_METHODS = frozenset({"pixel", "element", "state_sha256"})
_SURFACE_KINDS = frozenset({
    "desktop_capsule", "browser", "game_capsule", "vm",
})
_SURFACE_STATES = frozenset({
    "active", "standby", "ceded", "destroyed", "lost",
})
_SURFACE_VISIBILITY = frozenset({"folded", "unfolded", "pinned"})
_SURFACE_CONTROL = frozenset({"agent", "human", "shared"})
_CLICK_BUTTONS = frozenset({"left", "middle", "right"})


class ToolClient(Protocol):
    """Bounded synchronous transport for one tool call at a time."""

    def request(self, body: dict, expect: str, *,
                timeout_ms: int) -> dict:
        """Send one call body; return the validated reply body."""
        ...


class ToolValidationError(ValueError):
    """Local shape, version or correlation failure; nothing was admitted."""

    def __init__(self, detail: str, *, code: str | None = None) -> None:
        super().__init__(detail)
        self.detail = detail
        self.code = code


class ToolOperationalError(ToolValidationError):
    """Core returned an operational error frame (PROTOCOL, UNAVAILABLE, NOT_FOUND)."""

    def __init__(self, code: str, detail: str = "",
                 result: dict | None = None) -> None:
        super().__init__("core error %s" % code, code=code)
        self.error_code = code
        self.error_detail = detail
        self.result = copy.deepcopy(result) if result is not None else None


ToolCoreError = ToolOperationalError


class ToolRefusal(Exception):
    """Core refused the call; the reason code passes through verbatim.

    ``core_seq`` is the core's authoritative sequence when the wire
    result carries one. The frozen ``mv_tool_result/v0.2`` refused
    branch carries no ``core_seq``, so refusals on this path report
    ``None`` instead of a fabricated number.
    """

    def __init__(self, reason_code: str,
                 core_seq: int | None) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code
        self.core_seq = core_seq


class VerificationFailed(Exception):
    """Core reported an unverified terminal outcome; payload retained."""

    def __init__(self, receipt: dict) -> None:
        super().__init__("verification failed")
        self.receipt = receipt


def _fail(detail: str) -> None:
    raise ToolValidationError(detail)


def _check_id(value: object, what: str) -> str:
    if (not isinstance(value, str) or len(value) > 128
            or _ID_PATTERN.fullmatch(value) is None):
        _fail("invalid %s" % what)
    return value  # type: ignore[return-value]


def _check_str(value: object, *, min_length: int, max_length: int,
               pattern: re.Pattern[str] | None, what: str) -> str:
    if (not isinstance(value, str) or len(value) < min_length
            or len(value) > max_length):
        _fail("invalid %s" % what)
    if pattern is not None and pattern.fullmatch(value) is None:
        _fail("invalid %s" % what)
    return value  # type: ignore[return-value]


def _check_int(value: object, *, minimum: int | None = None,
               maximum: int | None = None, what: str) -> int:
    # type() is exact: booleans are never integers on the wire.
    if type(value) is not int:
        _fail("invalid %s" % what)
    assert type(value) is int
    if minimum is not None and value < minimum:
        _fail("invalid %s" % what)
    if maximum is not None and value > maximum:
        _fail("invalid %s" % what)
    return value


def _check_number(value: object, *, minimum: float, maximum: float,
                  what: str) -> float | int:
    if type(value) is bool or not isinstance(value, (int, float)):
        _fail("invalid %s" % what)
    assert isinstance(value, (int, float)) and not isinstance(value, bool)
    if value < minimum or value > maximum or not math.isfinite(value):
        _fail("invalid %s" % what)
    return value


def _check_const(value: object, const: object, what: str) -> None:
    if type(const) is bool:
        if type(value) is not bool or value is not const:
            _fail("invalid %s" % what)
        return
    if not isinstance(value, str) or value != const:
        _fail("invalid %s" % what)


def _check_closed(value: object, required: frozenset[str],
                  optional: frozenset[str], what: str) -> dict:
    if not isinstance(value, dict):
        _fail("invalid %s" % what)
    assert isinstance(value, dict)
    keys = set(value.keys())
    if not keys.issubset(required | optional) or not required.issubset(keys):
        _fail("invalid %s" % what)
    return value


def _check_exact(value: object, keys: frozenset[str], what: str) -> dict:
    return _check_closed(value, keys, frozenset(), what)


def _check_array(value: object, *, min_items: int, max_items: int,
                 what: str) -> list:
    if not isinstance(value, list):
        _fail("invalid %s" % what)
    assert isinstance(value, list)
    if len(value) < min_items or len(value) > max_items:
        _fail("invalid %s" % what)
    return value


def _check_click(action: dict) -> None:
    _check_exact(action, frozenset({"type", "x", "y", "button"}),
                 "click action")
    _check_int(action["x"], minimum=0, what="click x")
    _check_int(action["y"], minimum=0, what="click y")
    if not isinstance(action["button"], str) or action["button"] not in _CLICK_BUTTONS:
        _fail("invalid click button")


def _check_key(action: dict) -> None:
    _check_exact(action, frozenset({"type", "keys"}), "key action")
    keys = _check_array(action["keys"], min_items=1, max_items=4096,
                        what="key list")
    for key in keys:
        _check_str(key, min_length=1, max_length=65536, pattern=None,
                   what="key name")


def _check_type_text(action: dict) -> None:
    _check_exact(action, frozenset({"type", "text"}), "type action")
    _check_str(action["text"], min_length=1, max_length=65536,
               pattern=None, what="typed text")


def _check_scroll(action: dict) -> None:
    _check_exact(action, frozenset({"type", "dx", "dy"}), "scroll action")
    _check_int(action["dx"], what="scroll dx")
    _check_int(action["dy"], what="scroll dy")


def _check_wait(action: dict) -> None:
    _check_exact(action, frozenset({"type", "ms"}), "wait action")
    _check_int(action["ms"], minimum=1, maximum=3600000, what="wait ms")


def _check_lane_submit(action: dict) -> None:
    _check_exact(action, frozenset({"type", "verb", "payload"}),
                 "lane_submit action")
    _check_str(action["verb"], min_length=1, max_length=128,
               pattern=None, what="lane verb")
    payload = _check_exact(
        action["payload"],
        frozenset({"nonce", "seq", "command", "args"}), "lane payload")
    _check_str(payload["nonce"], min_length=1, max_length=128,
               pattern=None, what="lane nonce")
    _check_int(payload["seq"], minimum=1, what="lane seq")
    _check_str(payload["command"], min_length=1, max_length=128,
               pattern=None, what="lane command")
    args = _check_array(payload["args"], min_items=0, max_items=4096,
                        what="lane args")
    for arg in args:
        _check_str(arg, min_length=0, max_length=65536, pattern=None,
                   what="lane arg")


_ACTION_CHECKS = {
    "click": _check_click,
    "key": _check_key,
    "type": _check_type_text,
    "scroll": _check_scroll,
    "wait": _check_wait,
    "lane_submit": _check_lane_submit,
}


def _check_action(action: object) -> None:
    if not isinstance(action, dict):
        _fail("invalid action")
    assert isinstance(action, dict)
    kind = action.get("type")
    check = _ACTION_CHECKS.get(kind) if isinstance(kind, str) else None  # type: ignore[arg-type]
    if check is None:
        _fail("invalid action")
    check(action)


def _check_changed_region(expectation: dict) -> None:
    _check_exact(expectation, frozenset({"type", "bbox"}),
                 "changed_region expectation")
    bbox = _check_exact(expectation["bbox"], frozenset({"x", "y", "w", "h"}),
                        "expectation bbox")
    _check_int(bbox["x"], minimum=0, what="bbox x")
    _check_int(bbox["y"], minimum=0, what="bbox y")
    _check_int(bbox["w"], minimum=1, maximum=16384, what="bbox w")
    _check_int(bbox["h"], minimum=1, maximum=16384, what="bbox h")


def _check_element_state(expectation: dict) -> None:
    _check_exact(expectation, frozenset({"type", "role", "name", "state"}),
                 "element_state expectation")
    _check_str(expectation["role"], min_length=1, max_length=128,
               pattern=None, what="element role")
    _check_str(expectation["name"], min_length=0, max_length=65536,
               pattern=None, what="element name")
    _check_str(expectation["state"], min_length=1, max_length=128,
               pattern=None, what="element state")


def _check_state_change(expectation: dict) -> None:
    _check_exact(
        expectation,
        frozenset({"type", "before", "min_tick", "max_tick"}),
        "state_sha256_change expectation")
    _check_str(expectation["before"], min_length=64, max_length=65536,
               pattern=_SHA_PATTERN, what="before digest")
    _check_int(expectation["min_tick"], minimum=0, what="min_tick")
    _check_int(expectation["max_tick"], minimum=0, what="max_tick")
    if expectation["min_tick"] > expectation["max_tick"]:
        _fail("inverted tick window")


def _check_text_present(expectation: dict) -> None:
    _check_exact(expectation, frozenset({"type", "text"}),
                 "text_present expectation")
    _check_str(expectation["text"], min_length=1, max_length=65536,
               pattern=None, what="expected text")


_EXPECTATION_CHECKS = {
    "changed_region": _check_changed_region,
    "element_state": _check_element_state,
    "state_sha256_change": _check_state_change,
    "text_present": _check_text_present,
}


def _check_expectation(expectation: object) -> None:
    if not isinstance(expectation, dict):
        _fail("invalid expectation")
    assert isinstance(expectation, dict)
    kind = expectation.get("type")
    check = _EXPECTATION_CHECKS.get(kind) if isinstance(kind, str) else None  # type: ignore[arg-type]
    if check is None:
        _fail("invalid expectation")
    check(expectation)


def _check_proposal(proposal: object) -> dict:
    body = _check_exact(
        proposal,
        frozenset({"schema", "proposal_id", "surface_id", "based_on_frame",
                   "action", "expectation", "budget"}),
        "proposal")
    schema = body["schema"]
    if schema != _PROPOSAL_SCHEMA:
        if isinstance(schema, str) and schema.startswith(_PROPOSAL_FAMILY):
            _fail("unknown proposal version")
        _fail("invalid proposal")
    _check_str(body["proposal_id"], min_length=1, max_length=128,
               pattern=None, what="proposal_id")
    _check_str(body["surface_id"], min_length=1, max_length=128,
               pattern=None, what="proposal surface_id")
    frame = _check_exact(body["based_on_frame"],
                         frozenset({"sha256", "generation"}),
                         "based_on_frame")
    _check_str(frame["sha256"], min_length=64, max_length=65536,
               pattern=_SHA_PATTERN, what="frame digest")
    _check_int(frame["generation"], minimum=1, what="frame generation")
    _check_action(body["action"])
    _check_expectation(body["expectation"])
    budget = _check_exact(body["budget"], frozenset({"max_ms", "max_retries"}),
                          "budget")
    _check_int(budget["max_ms"], minimum=1, maximum=3600000,
               what="budget max_ms")
    _check_int(budget["max_retries"], minimum=0, maximum=10,
               what="budget max_retries")
    return body


def _check_frame(frame: object) -> dict:
    body = _check_exact(
        frame,
        frozenset({"schema", "surface_id", "generation", "tick", "ts_ns",
                   "width", "height", "format", "ramws_path", "sha256",
                   "capture_us"}),
        "frame_ref")
    _check_const(body["schema"], _FRAME_SCHEMA, "frame schema")
    _check_id(body["surface_id"], "frame surface_id")
    _check_int(body["generation"], minimum=1, maximum=_MAX_SAFE_INT,
               what="frame generation")
    _check_int(body["tick"], minimum=0, maximum=_MAX_SAFE_INT,
               what="frame tick")
    _check_int(body["ts_ns"], minimum=0, maximum=_MAX_SAFE_INT,
               what="frame ts_ns")
    _check_int(body["width"], minimum=1, maximum=16384, what="frame width")
    _check_int(body["height"], minimum=1, maximum=16384, what="frame height")
    _check_const(body["format"], "rgb24", "frame format")
    _check_str(body["ramws_path"], min_length=10, max_length=255,
               pattern=_RAMWS_PATTERN, what="frame ramws_path")
    _check_str(body["sha256"], min_length=64, max_length=64,
               pattern=_SHA_PATTERN, what="frame sha256")
    _check_int(body["capture_us"], minimum=0, maximum=_MAX_SAFE_INT,
               what="frame capture_us")
    return body


def _check_result_bbox(bbox: object) -> None:
    body = _check_exact(bbox, frozenset({"x", "y", "w", "h"}), "bbox")
    _check_int(body["x"], minimum=0, maximum=16383, what="bbox x")
    _check_int(body["y"], minimum=0, maximum=16383, what="bbox y")
    _check_int(body["w"], minimum=1, maximum=16384, what="bbox w")
    _check_int(body["h"], minimum=1, maximum=16384, what="bbox h")


def _check_vision(vision: object) -> None:
    body = _check_exact(
        vision, frozenset({"summary", "changed_regions", "elements"}),
        "vision")
    _check_str(body["summary"], min_length=0, max_length=_MAX_VISION_SUMMARY,
               pattern=None, what="vision summary")
    regions = _check_array(body["changed_regions"], min_items=0,
                           max_items=256, what="changed_regions")
    for region in regions:
        _check_result_bbox(region)
    elements = _check_array(body["elements"], min_items=0, max_items=256,
                            what="vision elements")
    for element in elements:
        item = _check_exact(
            element, frozenset({"bbox", "role", "name", "confidence"}),
            "vision element")
        _check_result_bbox(item["bbox"])
        _check_str(item["role"], min_length=1, max_length=128,
                   pattern=None, what="element role")
        _check_str(item["name"], min_length=0, max_length=4096,
                   pattern=None, what="element name")
        _check_number(item["confidence"], minimum=0.0, maximum=1.0,
                      what="element confidence")


def _check_ground_truth(ground_truth: object) -> None:
    body = _check_exact(
        ground_truth, frozenset({"source", "state_sha256", "tick"}),
        "ground_truth")
    _check_const(body["source"], "holdings_lane", "witness source")
    _check_str(body["state_sha256"], min_length=64, max_length=64,
               pattern=_SHA_PATTERN, what="state_sha256")
    _check_int(body["tick"], minimum=0, maximum=_MAX_SAFE_INT,
               what="witness tick")


def _check_observation(observation: object) -> dict:
    body = _check_closed(
        observation,
        frozenset({"schema", "frame_ref"}),
        frozenset({"vision", "ground_truth"}),
        "observation")
    _check_const(body["schema"], _OBSERVATION_SCHEMA, "observation schema")
    _check_frame(body["frame_ref"])
    if "vision" in body:
        _check_vision(body["vision"])
    if "ground_truth" in body:
        _check_ground_truth(body["ground_truth"])
    try:
        validate_observation(body, surface_id=body["frame_ref"]["surface_id"],
                             generation=body["frame_ref"]["generation"],
                             contract_version="v0.2")
    except ObservationError as exc:
        _fail(str(exc))
    return body


def _check_surface(surface: object) -> None:
    body = _check_exact(
        surface,
        frozenset({"schema", "surface_id", "kind", "display", "geometry",
                   "state", "visibility", "control", "profile_id"}),
        "surface")
    _check_const(body["schema"], _SURFACE_SCHEMA, "surface schema")
    _check_id(body["surface_id"], "surface_id")
    if not isinstance(body["kind"], str) or body["kind"] not in _SURFACE_KINDS:
        _fail("invalid surface kind")
    _check_str(body["display"], min_length=1, max_length=256,
               pattern=None, what="surface display")
    geometry = _check_exact(body["geometry"], frozenset({"w", "h"}),
                            "surface geometry")
    _check_int(geometry["w"], minimum=1, maximum=16384,
               what="surface width")
    _check_int(geometry["h"], minimum=1, maximum=16384,
               what="surface height")
    if not isinstance(body["state"], str) or body["state"] not in _SURFACE_STATES:
        _fail("invalid surface state")
    if not isinstance(body["visibility"], str) or body["visibility"] not in _SURFACE_VISIBILITY:
        _fail("invalid surface visibility")
    if not isinstance(body["control"], str) or body["control"] not in _SURFACE_CONTROL:
        _fail("invalid surface control")
    _check_id(body["profile_id"], "profile_id")


def _check_verdict_admitted(verdict: object) -> dict:
    body = _check_exact(
        verdict,
        frozenset({"schema", "proposal_id", "decision", "core_seq"}),
        "verdict")
    _check_const(body["schema"], _VERDICT_SCHEMA, "verdict schema")
    _check_id(body["proposal_id"], "verdict proposal_id")
    _check_const(body["decision"], "admitted", "verdict decision")
    _check_int(body["core_seq"], minimum=1, maximum=_MAX_SAFE_INT,
               what="core_seq")
    return body


def _check_receipt_verified(receipt: object, *,
                            surface_id: str | None = None) -> dict:
    body = _check_closed(
        receipt,
        frozenset({"schema", "proposal_id", "executed_at_ns", "after_frame",
                   "verified", "verification", "error"}),
        frozenset({"native_evidence"}),
        "receipt")
    _check_const(body["schema"], _RECEIPT_SCHEMA, "receipt schema")
    _check_id(body["proposal_id"], "receipt proposal_id")
    _check_int(body["executed_at_ns"], minimum=0, maximum=_MAX_SAFE_INT,
               what="executed_at_ns")
    _check_frame(body["after_frame"])
    if surface_id is not None:
        want_surface = _check_id(surface_id, "surface_id")
        if body["after_frame"]["surface_id"] != want_surface:
            _fail("uncorrelated surface_id")
    _check_const(body["verified"], True, "receipt verified")
    verification = _check_exact(body["verification"],
                                frozenset({"method", "detail"}),
                                "verification")
    if not isinstance(verification["method"], str) or verification["method"] not in _VERIFICATION_METHODS:
        _fail("invalid verification method")
    _check_str(verification["detail"], min_length=1, max_length=4096,
               pattern=None, what="verification detail")
    _check_const(body["error"], "", "receipt error")
    if "native_evidence" in body:
        evidence = _check_closed(
            body["native_evidence"],
            frozenset({"surface_id", "input_mono_ns", "input_ts_ns"}),
            frozenset({"native_surface_id", "kind", "focus_verified", "result"}),
            "native_evidence")
        for key in ("surface_id", "native_surface_id"):
            if key in evidence:
                _check_str(evidence[key], min_length=1, max_length=128,
                           pattern=None, what=key)
        if evidence["surface_id"] != body["after_frame"]["surface_id"]:
            _fail("uncorrelated native surface_id")
        for key in ("input_mono_ns", "input_ts_ns"):
            _check_int(evidence[key], minimum=0, maximum=_MAX_SAFE_INT, what=key)
        if "kind" in evidence and evidence["kind"] not in ("click", "key", "text"):
            _fail("invalid native kind")
        if "focus_verified" in evidence and type(evidence["focus_verified"]) is not bool:
            _fail("invalid native focus_verified")
        if "result" in evidence:
            _check_const(evidence["result"], "ok", "native result")
    return body


def _check_result_head(result: object, *, request_id: str, op: str) -> dict:
    if not isinstance(result, dict):
        _fail("invalid result")
    assert isinstance(result, dict)
    schema = result.get("schema")
    if schema != _RESULT_SCHEMA:
        if isinstance(schema, str) and schema.startswith(_RESULT_FAMILY):
            _fail("unknown result version")
        _fail("invalid result")
    if result.get("request_id") != request_id:
        _fail("uncorrelated request_id")
    if result.get("op") != op:
        _fail("uncorrelated op")
    return result


def _raise_refused(result: dict) -> None:
    body = _check_exact(
        result,
        frozenset({"schema", "request_id", "op", "status", "reason_code",
                   "detail"}),
        "refused result")
    reason = body["reason_code"]
    if not isinstance(reason, str) or reason not in _REFUSAL_CODES:
        _fail("invalid reason_code")
    _check_str(body["detail"], min_length=0, max_length=4096,
               pattern=None, what="refusal detail")
    raise ToolRefusal(reason, None)


def _raise_error(result: dict) -> None:
    body = _check_exact(
        result,
        frozenset({"schema", "request_id", "op", "status", "code", "detail"}),
        "error result")
    code = body["code"]
    if not isinstance(code, str) or code not in _ERROR_CODES:
        _fail("invalid error code")
    _check_str(body["detail"], min_length=0, max_length=4096,
               pattern=None, what="error detail")
    if code == "VERIFICATION_FAILED":
        raise VerificationFailed(copy.deepcopy(body))
    raise ToolOperationalError(code, body["detail"], body)


def _check_timeout(value: object, what: str) -> int:
    return _check_int(value, minimum=1, what=what)


def _checked_client(client: object) -> ToolClient:
    request = getattr(client, "request", None)
    if not callable(request):
        _fail("invalid client")
    return client  # type: ignore[return-value]


def _new_request_id() -> str:
    return secrets.token_hex(16)


def _send(client: ToolClient, op: str, args: dict,
          timeout_ms: int) -> tuple[dict, str]:
    call = {
        "schema": _CALL_SCHEMA,
        "request_id": _new_request_id(),
        "op": op,
        "args": args,
    }
    result = client.request(call, _RESULT_SCHEMA, timeout_ms=timeout_ms)
    return result, call["request_id"]


def observe(surface_id: str, *, client: ToolClient,
            timeout_ms: int, perception_adapter=None) -> dict:
    """Return the validated observation for one surface.

    Raises ToolValidationError on any shape, version or correlation
    failure, ToolRefusal on a core refusal, and propagates transport
    failures (including TimeoutError) unchanged.
    """
    active = _checked_client(client)
    want_surface = _check_id(surface_id, "surface_id")
    budget = _check_timeout(timeout_ms, "timeout_ms")
    result, request_id = _send(active, "observe",
                               {"surface_id": want_surface}, budget)
    head = _check_result_head(result, request_id=request_id, op="observe")
    status = head.get("status")
    if status == "ok":
        body = _check_exact(
            head, frozenset({"schema", "request_id", "op", "status",
                             "observation"}),
            "observe result")
        observation = _check_observation(body["observation"])
        if observation["frame_ref"]["surface_id"] != want_surface:
            _fail("uncorrelated surface_id")
        observation = copy.deepcopy(observation)
        if perception_adapter is not None:
            # Adapter failures retain their typed codes; private code stays
            # across the adapter's subprocess boundary.
            observation["vision"] = perception_adapter.perceive(
                copy.deepcopy(observation["frame_ref"]))
            _check_observation(observation)
        return copy.deepcopy(observation)
    if status == "refused":
        _raise_refused(head)
    if status == "error":
        _raise_error(head)
    _fail("invalid observe status")
    raise AssertionError("unreachable")


def list_surfaces(*, cursor: str | None, limit: int,
                  client: ToolClient, timeout_ms: int) -> dict:
    """Return one validated page of surfaces exactly as the core sent it.

    Errors behave as in observe; pagination stays with the caller, so
    one call never drains more than the single page it requested.
    """
    active = _checked_client(client)
    if cursor is not None:
        _check_id(cursor, "cursor")
    count = _check_int(limit, minimum=1, maximum=_LIST_LIMIT_MAX,
                       what="limit")
    budget = _check_timeout(timeout_ms, "timeout_ms")
    result, request_id = _send(active, "list",
                               {"cursor": cursor, "limit": count}, budget)
    head = _check_result_head(result, request_id=request_id, op="list")
    status = head.get("status")
    if status == "ok":
        body = _check_exact(
            head, frozenset({"schema", "request_id", "op", "status",
                             "surfaces", "next_cursor"}),
            "list result")
        surfaces = _check_array(body["surfaces"], min_items=0,
                                max_items=256, what="surfaces")
        for surface in surfaces:
            _check_surface(surface)
        if body["next_cursor"] is not None:
            _check_id(body["next_cursor"], "next_cursor")
        return copy.deepcopy(body)
    if status == "refused":
        _raise_refused(head)
    if status == "error":
        _raise_error(head)
    _fail("invalid list status")
    raise AssertionError("unreachable")


def propose(proposal: dict, *, client: ToolClient,
            timeout_ms: int) -> dict:
    """Submit one proposal; return the admitted verdict.

    Admission is not completion. A refused verdict raises ToolRefusal
    with the core reason code and no automatic retry.
    """
    active = _checked_client(client)
    checked = _check_proposal(proposal)
    budget = _check_timeout(timeout_ms, "timeout_ms")
    result, request_id = _send(active, "propose",
                               {"proposal": copy.deepcopy(checked)}, budget)
    head = _check_result_head(result, request_id=request_id, op="propose")
    status = head.get("status")
    if status == "admitted":
        body = _check_exact(
            head, frozenset({"schema", "request_id", "op", "status",
                             "verdict"}),
            "propose result")
        verdict = _check_verdict_admitted(body["verdict"])
        if verdict["proposal_id"] != checked["proposal_id"]:
            _fail("uncorrelated proposal_id")
        return copy.deepcopy(verdict)
    if status == "refused":
        _raise_refused(head)
    if status == "error":
        _raise_error(head)
    _fail("invalid propose status")
    raise AssertionError("unreachable")


class _VerifiedReceipt(dict):
    """Verified action_receipt/v0.2 dict carrying top-level tool-result witnesses.

    Preserves exact action_receipt/v0.2 dictionary keys for schema/equality
    checks and JSON serialization while exposing validated top-level
    ``input_mono_ns``, ``focus_verified``, and ``frame_sha256`` from
    ``mv_tool_result/v0.2`` via attributes and ``.get()``.
    """

    def __init__(self, mapping: dict, *, focus_verified: bool,
                 input_mono_ns: int, frame_sha256: str) -> None:
        super().__init__(mapping)
        self.focus_verified = focus_verified
        self.input_mono_ns = input_mono_ns
        self.frame_sha256 = frame_sha256

    def get(self, key: str, default: object = None) -> object:
        if key in self:
            return super().get(key, default)
        if key == "focus_verified":
            return self.focus_verified
        if key == "input_mono_ns":
            return self.input_mono_ns
        if key == "frame_sha256":
            return self.frame_sha256
        return default

    def __copy__(self) -> "_VerifiedReceipt":
        return _VerifiedReceipt(
            super().copy(),
            focus_verified=self.focus_verified,
            input_mono_ns=self.input_mono_ns,
            frame_sha256=self.frame_sha256,
        )

    def __deepcopy__(self, memo: dict) -> "_VerifiedReceipt":
        return _VerifiedReceipt(
            {copy.deepcopy(k, memo): copy.deepcopy(v, memo)
             for k, v in self.items()},
            focus_verified=self.focus_verified,
            input_mono_ns=self.input_mono_ns,
            frame_sha256=self.frame_sha256,
        )


_DEFAULT_WAIT_CLOCK = time.monotonic


def _resolve_wait_clock(clock: object) -> object:
    active_clock = time.monotonic if clock is _DEFAULT_WAIT_CLOCK else clock
    if not callable(active_clock):
        _fail("invalid clock")
    return active_clock


def _read_wait_clock(clock: object) -> float:
    now = clock()  # type: ignore[operator]
    if (type(now) is bool or not isinstance(now, (int, float))
            or not math.isfinite(now)):
        _fail("invalid clock reading")
    return float(now)


def _remaining_wait_ms(deadline: float, clock: object,
                       budget_ms: int) -> int:
    """Recompute remaining milliseconds from the single monotonic deadline."""
    del budget_ms
    return math.ceil(round((deadline - _read_wait_clock(clock)) * 1000, 6))


def _wait_clock_sleep_fn(clock: object, *, custom_clock: bool) -> object | None:
    sleep_fn = getattr(clock, "sleep", None)
    if sleep_fn is None and hasattr(clock, "__self__"):
        sleep_fn = getattr(getattr(clock, "__self__"), "sleep", None)
    if callable(sleep_fn):
        return sleep_fn
    if not custom_clock:
        return time.sleep
    return None


def wait_verify(proposal_id: str, expectation: dict, timeout_ms: int,
                *, client: ToolClient,
                surface_id: str | None = None,
                clock: object = _DEFAULT_WAIT_CLOCK) -> dict:
    """Block until the core reports a verified receipt or a deadline.

    The frozen call carries no expectation slot, so the expectation is
    shape-validated before dispatch but not transmitted. Polls repeat
    only the wait on core-directed ``pending`` results within the
    monotonic budget; an action is never resubmitted. Returns the
    verified receipt; raises VerificationFailed on an unverified
    terminal outcome and TimeoutError when the budget is exhausted.
    """
    active = _checked_client(client)
    want_proposal = _check_id(proposal_id, "proposal_id")
    want_surface = (
        _check_id(surface_id, "surface_id")
        if surface_id is not None else None
    )
    _check_expectation(expectation)
    budget = _check_int(timeout_ms, minimum=1,
                        maximum=_WAIT_TIMEOUT_MAX_MS, what="timeout_ms")
    active_clock = _resolve_wait_clock(clock)
    custom_clock = clock is not _DEFAULT_WAIT_CLOCK
    sleep_fn = _wait_clock_sleep_fn(active_clock, custom_clock=custom_clock)
    deadline = _read_wait_clock(active_clock) + budget / 1000
    while True:
        remaining_ms = _remaining_wait_ms(deadline, active_clock, budget)
        if remaining_ms <= 0:
            raise TimeoutError("wait_verify budget exhausted")
        call = {
            "schema": _CALL_SCHEMA,
            "request_id": _new_request_id(),
            "op": "wait_verify",
            "args": {"proposal_id": want_proposal,
                     "timeout_ms": remaining_ms},
        }
        result = active.request(call, _RESULT_SCHEMA,
                                timeout_ms=remaining_ms)
        head = _check_result_head(result, request_id=call["request_id"],
                                      op="wait_verify")
        status = head.get("status")
        if status == "verified":
            body = _check_exact(
                head, frozenset({"schema", "request_id", "op", "status",
                                 "receipt", "focus_verified",
                                 "input_mono_ns", "frame_sha256"}),
                "verified result")
            receipt = _check_receipt_verified(
                body["receipt"], surface_id=want_surface)
            if receipt["proposal_id"] != want_proposal:
                _fail("uncorrelated proposal_id")
            _check_const(body["focus_verified"], True, "focus_verified")
            focus_verified = True
            input_mono_ns = _check_int(
                body["input_mono_ns"], minimum=0,
                maximum=_MAX_SAFE_INT, what="input_mono_ns")
            frame_sha256 = _check_str(
                body["frame_sha256"], min_length=64, max_length=64,
                pattern=_SHA_PATTERN, what="frame_sha256")
            if frame_sha256 != receipt["after_frame"]["sha256"]:
                _fail("uncorrelated frame_sha256")
            if "native_evidence" in receipt:
                native_ev = receipt["native_evidence"]
                if native_ev["input_mono_ns"] != input_mono_ns:
                    _fail("uncorrelated input_mono_ns")
                if native_ev.get("focus_verified", True) is not True:
                    _fail("uncorrelated focus_verified")
            return _VerifiedReceipt(
                copy.deepcopy(receipt),
                focus_verified=focus_verified,
                input_mono_ns=input_mono_ns,
                frame_sha256=frame_sha256,
            )
        if status == "timeout":
            body = _check_exact(
                head, frozenset({"schema", "request_id", "op", "status",
                                 "proposal_id", "verified"}),
                "timeout result")
            if body["proposal_id"] != want_proposal:
                _fail("uncorrelated proposal_id")
            _check_const(body["verified"], False, "timeout verified")
            raise VerificationFailed(copy.deepcopy(body))
        if status == "pending":
            body = _check_exact(
                head, frozenset({"schema", "request_id", "op", "status",
                                 "proposal_id", "retry_after_ms"}),
                "pending result")
            if body["proposal_id"] != want_proposal:
                _fail("uncorrelated proposal_id")
            retry_ms = _check_int(body["retry_after_ms"], minimum=1,
                                  maximum=_WAIT_TIMEOUT_MAX_MS,
                                  what="retry_after_ms")
            if sleep_fn is not None:
                left_ms = _remaining_wait_ms(deadline, active_clock, budget)
                if left_ms <= 0:
                    raise TimeoutError("wait_verify budget exhausted")
                # Never sleep past the budget: a hostile retry_after_ms
                # must not turn a bounded wait into a long stall.
                sleep_fn(min(retry_ms, left_ms) / 1000)  # type: ignore[operator]
            continue
        if status == "refused":
            _raise_refused(head)
        if status == "error":
            _raise_error(head)
        _fail("invalid wait_verify status")


_RECORD_MODES = frozenset({"ram", "disk", "screenshot"})


def _check_record_request(request: object, *,
                          expected_op: str | None = None) -> dict:
    body = _check_exact(
        request,
        frozenset({"schema", "request_id", "op", "params"}),
        "record_request")
    schema = body["schema"]
    if schema != _RECORD_REQUEST_SCHEMA:
        if (isinstance(schema, str)
                and schema.startswith(_RECORD_REQUEST_FAMILY)):
            _fail("unknown record_request version")
        _fail("invalid record_request")
    _check_id(body["request_id"], "request_id")
    op = body["op"]
    if not isinstance(op, str):
        _fail("invalid record_request op")
    if expected_op is not None and op != expected_op:
        _fail("unexpected record_request op")
    params = body["params"]
    if op == "ram_start":
        checked_params = _check_exact(
            params,
            frozenset({"surface_id", "recording_id", "ring_bytes", "max_fps"}),
            "ram_start params")
        _check_id(checked_params["surface_id"], "surface_id")
        _check_id(checked_params["recording_id"], "recording_id")
        _check_int(checked_params["ring_bytes"], minimum=1,
                   maximum=_MAX_RING_BYTES, what="ring_bytes")
        _check_int(checked_params["max_fps"], minimum=1,
                   maximum=_MAX_FPS, what="max_fps")
    elif op in ("ram_stop", "disk_stop"):
        checked_params = _check_exact(
            params,
            frozenset({"surface_id", "recording_id"}),
            "%s params" % op)
        _check_id(checked_params["surface_id"], "surface_id")
        _check_id(checked_params["recording_id"], "recording_id")
    elif op == "disk_start":
        checked_params = _check_exact(
            params,
            frozenset({"surface_id", "recording_id",
                       "destination_capability_id", "destination_path",
                       "max_fps"}),
            "disk_start params")
        _check_id(checked_params["surface_id"], "surface_id")
        _check_id(checked_params["recording_id"], "recording_id")
        _check_id(checked_params["destination_capability_id"],
                  "destination_capability_id")
        _check_str(checked_params["destination_path"], min_length=1,
                   max_length=4096, pattern=_ABS_PATH_PATTERN,
                   what="destination_path")
        _check_int(checked_params["max_fps"], minimum=1,
                   maximum=_MAX_FPS, what="max_fps")
    elif op == "screenshot":
        checked_params = _check_exact(
            params,
            frozenset({"surface_id", "capture_id"}),
            "screenshot params")
        _check_id(checked_params["surface_id"], "surface_id")
        _check_id(checked_params["capture_id"], "capture_id")
    else:
        _fail("invalid record_request op")
    return body


def _check_record_event(event_obj: object, *, request_id: str,
                        surface_id: str, recording_id: str) -> dict:
    if not isinstance(event_obj, dict):
        _fail("invalid record_event")
    assert isinstance(event_obj, dict)
    schema = event_obj.get("schema")
    if schema != _RECORD_EVENT_SCHEMA:
        if isinstance(schema, str) and schema.startswith(_RECORD_EVENT_FAMILY):
            _fail("unknown record_event version")
        _fail("invalid record_event")
    _check_id(event_obj.get("request_id"), "request_id")
    if event_obj["request_id"] != request_id:
        _fail("uncorrelated request_id")
    _check_id(event_obj.get("surface_id"), "surface_id")
    if event_obj["surface_id"] != surface_id:
        _fail("uncorrelated surface_id")
    _check_id(event_obj.get("recording_id"), "recording_id")
    if event_obj["recording_id"] != recording_id:
        _fail("uncorrelated recording_id")
    _check_int(event_obj.get("mono_ns"), minimum=0, maximum=_MAX_SAFE_INT,
               what="mono_ns")
    kind = event_obj.get("event")
    if kind == "started":
        body = _check_exact(
            event_obj,
            frozenset({"schema", "request_id", "surface_id", "recording_id",
                       "event", "mono_ns", "mode"}),
            "started record_event")
        if not isinstance(body["mode"], str) or body["mode"] not in _RECORD_MODES:
            _fail("invalid record mode")
        return body
    if kind == "stopped":
        body = _check_exact(
            event_obj,
            frozenset({"schema", "request_id", "surface_id", "recording_id",
                       "event", "mono_ns", "frame_count", "byte_count"}),
            "stopped record_event")
        _check_int(body["frame_count"], minimum=0, maximum=_MAX_SAFE_INT,
                   what="frame_count")
        _check_int(body["byte_count"], minimum=0, maximum=_MAX_RING_BYTES,
                   what="byte_count")
        return body
    if kind == "frame_captured":
        body = _check_exact(
            event_obj,
            frozenset({"schema", "request_id", "surface_id", "recording_id",
                       "event", "mono_ns", "ram_path", "sha256",
                       "byte_count"}),
            "frame_captured record_event")
        _check_str(body["ram_path"], min_length=10, max_length=255,
                   pattern=_RAM_RECORD_PATTERN, what="ram_path")
        _check_str(body["sha256"], min_length=64, max_length=64,
                   pattern=_SHA_PATTERN, what="sha256")
        _check_int(body["byte_count"], minimum=0, maximum=_MAX_RING_BYTES,
                   what="byte_count")
        return body
    if kind == "exported":
        body = _check_exact(
            event_obj,
            frozenset({"schema", "request_id", "surface_id", "recording_id",
                       "event", "mono_ns", "destination_capability_id",
                       "destination_path", "sha256", "byte_count"}),
            "exported record_event")
        _check_id(body["destination_capability_id"],
                  "destination_capability_id")
        _check_str(body["destination_path"], min_length=1, max_length=4096,
                   pattern=_ABS_PATH_PATTERN, what="destination_path")
        _check_str(body["sha256"], min_length=64, max_length=64,
                   pattern=_SHA_PATTERN, what="sha256")
        _check_int(body["byte_count"], minimum=0, maximum=_MAX_RING_BYTES,
                   what="byte_count")
        return body
    if kind == "dropped":
        body = _check_exact(
            event_obj,
            frozenset({"schema", "request_id", "surface_id", "recording_id",
                       "event", "mono_ns", "dropped_frames", "policy"}),
            "dropped record_event")
        _check_int(body["dropped_frames"], minimum=1, maximum=_MAX_SAFE_INT,
                   what="dropped_frames")
        _check_const(body["policy"], "ram_ring_oldest", "drop policy")
        return body
    if kind == "refused":
        body = _check_exact(
            event_obj,
            frozenset({"schema", "request_id", "surface_id", "recording_id",
                       "event", "mono_ns", "reason_code", "detail"}),
            "refused record_event")
        reason = body["reason_code"]
        if not isinstance(reason, str) or reason not in _REFUSAL_CODES:
            _fail("invalid reason_code")
        _check_str(body["detail"], min_length=0, max_length=4096,
                   pattern=None, what="refusal detail")
        raise ToolRefusal(reason, None)
    _fail("invalid record_event kind")
    raise AssertionError("unreachable")


def record_start(surface_id: str, recording_id: str, *, mode: str = "ram",
                 ring_bytes: int | None = None, max_fps: int = 30,
                 destination_capability_id: str | None = None,
                 destination_path: str | None = None,
                 client: ToolClient, timeout_ms: int,
                 events: list[dict] | None = None) -> dict:
    """Start a RAM ring or host disk recording; return the started event.

    Disk recording requires both destination_capability_id and an absolute
    destination_path; missing or malformed destination fields fail closed
    locally before transport dispatch and without writing to disk.
    """
    active = _checked_client(client)
    budget = _check_timeout(timeout_ms, "timeout_ms")
    if mode == "ram":
        if destination_capability_id is not None or destination_path is not None:
            _fail("ram recording forbids disk destination")
        op = "ram_start"
        params = {
            "surface_id": surface_id,
            "recording_id": recording_id,
            "ring_bytes": ring_bytes,
            "max_fps": max_fps,
        }
    elif mode == "disk":
        if ring_bytes is not None:
            _fail("disk recording forbids ring_bytes")
        if destination_capability_id is None or destination_path is None:
            _fail("disk recording requires destination_path and destination_capability_id")
        op = "disk_start"
        params = {
            "surface_id": surface_id,
            "recording_id": recording_id,
            "destination_capability_id": destination_capability_id,
            "destination_path": destination_path,
            "max_fps": max_fps,
        }
    else:
        _fail("invalid record mode")
        raise AssertionError("unreachable")
    call = {
        "schema": _RECORD_REQUEST_SCHEMA,
        "request_id": _new_request_id(),
        "op": op,
        "params": params,
    }
    _check_record_request(call, expected_op=op)
    reply = active.request(copy.deepcopy(call), _RECORD_EVENT_SCHEMA,
                           timeout_ms=budget)
    checked = _check_record_event(
        reply, request_id=call["request_id"],
        surface_id=surface_id, recording_id=recording_id)
    if checked["event"] != "started" or checked["mode"] != mode:
        _fail("unexpected record_start event")
    out = copy.deepcopy(checked)
    if events is not None:
        events.append(copy.deepcopy(out))
    return out


def record_stop(surface_id: str, recording_id: str, *, mode: str = "ram",
                client: ToolClient, timeout_ms: int,
                events: list[dict] | None = None) -> dict:
    """Drain intermediate recording events and stop a RAM or disk recording.

    Any malformed or uncorrelated event in the stream raises
    ToolValidationError immediately and aborts further stream consumption.
    """
    active = _checked_client(client)
    budget = _check_int(timeout_ms, minimum=1, maximum=_WAIT_TIMEOUT_MAX_MS,
                        what="timeout_ms")
    if mode == "ram":
        op = "ram_stop"
        allowed_stream = frozenset({"frame_captured", "dropped"})
    elif mode == "disk":
        op = "disk_stop"
        allowed_stream = frozenset({"exported"})
    else:
        _fail("invalid record mode")
        raise AssertionError("unreachable")
    deadline = time.monotonic() + budget / 1000
    params = {"surface_id": surface_id, "recording_id": recording_id}
    for _ in range(_MAX_RECORD_STREAM_EVENTS):
        remaining_ms = math.ceil((deadline - time.monotonic()) * 1000)
        if remaining_ms <= 0:
            raise TimeoutError("record_stop budget exhausted")
        call = {
            "schema": _RECORD_REQUEST_SCHEMA,
            "request_id": _new_request_id(),
            "op": op,
            "params": copy.deepcopy(params),
        }
        _check_record_request(call, expected_op=op)
        reply = active.request(copy.deepcopy(call), _RECORD_EVENT_SCHEMA,
                               timeout_ms=remaining_ms)
        checked = _check_record_event(
            reply, request_id=call["request_id"],
            surface_id=surface_id, recording_id=recording_id)
        if checked["event"] in allowed_stream:
            if events is not None:
                events.append(copy.deepcopy(checked))
            continue
        if checked["event"] == "stopped":
            out = copy.deepcopy(checked)
            if events is not None:
                events.append(copy.deepcopy(out))
            return out
        _fail("unexpected record_stop event")
    _fail("record event stream exceeded cap")
    raise AssertionError("unreachable")
