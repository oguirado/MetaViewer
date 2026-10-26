"""Closed mvctl tool verbs over a bounded agent mailbox client.

Each verb builds one ``mv_tool_call/v0.2`` body, sends it through the
injected client, and validates the ``mv_tool_result/v0.2`` reply before
interpreting it. This module never opens sockets: envelope framing,
sender identity, sequence, nonce replay and byte caps belong to the
client. Core admission and verification outcomes pass through verbatim;
local failures never fabricate core metadata.
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
_OBSERVATION_SCHEMA = "observation/v0.1"
_FRAME_SCHEMA = "frame_ref/v0.1"
_VERDICT_SCHEMA = "action_verdict/v0.1"
_RECEIPT_SCHEMA = "action_receipt/v0.1"
_SURFACE_SCHEMA = "surface/v0.1"

_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*")
_SHA_PATTERN = re.compile(r"[0-9a-f]{64}")
_RAMWS_PATTERN = re.compile(r"/dev/shm/[^\x00]+")
_MAX_SAFE_INT = 9007199254740991
_LIST_LIMIT_MAX = 256
_WAIT_TIMEOUT_MAX_MS = 60000

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

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


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
    _check_int(action["ms"], minimum=1, what="wait ms")


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
    _check_int(bbox["w"], minimum=1, what="bbox w")
    _check_int(bbox["h"], minimum=1, what="bbox h")


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
    _check_int(budget["max_ms"], minimum=1, what="budget max_ms")
    _check_int(budget["max_retries"], minimum=0, what="budget max_retries")
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
    _check_str(body["ramws_path"], min_length=10, max_length=4096,
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
    _check_str(body["summary"], min_length=0, max_length=4096,
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
                             generation=body["frame_ref"]["generation"])
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


def _check_receipt_verified(receipt: object) -> dict:
    body = _check_exact(
        receipt,
        frozenset({"schema", "proposal_id", "executed_at_ns", "after_frame",
                   "verified", "verification", "error"}),
        "receipt")
    _check_const(body["schema"], _RECEIPT_SCHEMA, "receipt schema")
    _check_id(body["proposal_id"], "receipt proposal_id")
    _check_int(body["executed_at_ns"], minimum=0, maximum=_MAX_SAFE_INT,
               what="executed_at_ns")
    _check_frame(body["after_frame"])
    _check_const(body["verified"], True, "receipt verified")
    verification = _check_exact(body["verification"],
                                frozenset({"method", "detail"}),
                                "verification")
    if not isinstance(verification["method"], str) or verification["method"] not in _VERIFICATION_METHODS:
        _fail("invalid verification method")
    _check_str(verification["detail"], min_length=1, max_length=4096,
               pattern=None, what="verification detail")
    _check_const(body["error"], "", "receipt error")
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
    _fail("core error %s" % code)


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
            timeout_ms: int) -> dict:
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


def wait_verify(proposal_id: str, expectation: dict, timeout_ms: int,
                *, client: ToolClient) -> dict:
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
    _check_expectation(expectation)
    budget = _check_int(timeout_ms, minimum=1,
                        maximum=_WAIT_TIMEOUT_MAX_MS, what="timeout_ms")
    deadline = time.monotonic() + budget / 1000
    while True:
        remaining_ms = math.ceil((deadline - time.monotonic()) * 1000)
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
            receipt = _check_receipt_verified(body["receipt"])
            if receipt["proposal_id"] != want_proposal:
                _fail("uncorrelated proposal_id")
            _check_const(body["focus_verified"], True, "focus_verified")
            _check_int(body["input_mono_ns"], minimum=0,
                       maximum=_MAX_SAFE_INT, what="input_mono_ns")
            _check_str(body["frame_sha256"], min_length=64, max_length=64,
                       pattern=_SHA_PATTERN, what="frame_sha256")
            return copy.deepcopy(receipt)
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
            left_ms = math.ceil((deadline - time.monotonic()) * 1000)
            if left_ms <= 0:
                raise TimeoutError("wait_verify budget exhausted")
            # Never sleep past the budget: a hostile retry_after_ms
            # must not turn a bounded wait into a long stall.
            time.sleep(min(retry_ms, left_ms) / 1000)
            continue
        if status == "refused":
            _raise_refused(head)
        if status == "error":
            _raise_error(head)
        _fail("invalid wait_verify status")
