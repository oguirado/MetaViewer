"""Closed envelope/v0.2 and legacy v0.1 frames with bounded NDJSON codecs.

Transport-only validation for the agent side of the core mailbox. Every
inbound or outbound frame is runtime-validated against the embedded versioned
contract data before any effect; unknown contract versions are refused and
byte caps gate before any parse or write. The embedded data mirrors the
frozen schemas; the repository contract checker stays
the independent oracle for parity tests.

[TARGET, unit decision] v0.1 and v0.2 remain isolated by discriminator.
Both versions require safe JSON integers and Unicode scalar strings.
The v0.2 mv_tool_result snapshot upgrades its stale nested v0.1 pins;
the source contract requires the matching change outside this unit surface.
"""

from __future__ import annotations

from ._contracts_v02 import FILES as _V02_FILES

import copy
import json
import math
import re
import secrets
import time

__all__ = [
    "SCHEMA",
    "COMPONENTS",
    "EnvelopeError",
    "make_envelope",
    "validate_envelope",
    "dumps_envelope",
    "loads_envelope",
]

SCHEMA = "envelope/v0.2"
_LEGACY_SCHEMA = "envelope/v0.1"
_MAX_SAFE_INT = (1 << 53) - 1
COMPONENTS = frozenset({"core", "ui", "daemon", "agent", "vision", "wender"})

_OUTER_KEYS = frozenset((
    "schema", "msg_id", "ts_ns", "from", "to", "session_id", "seq",
    "nonce", "body",
))
_ENDPOINT_KEYS = frozenset(("component", "instance"))
_MAX_STRING = 128
_MAX_DEPTH = 100
# NUL spelled as code: the ramws pattern excludes it from shared paths.
_NUL = chr(0)


class EnvelopeError(ValueError):
    """Closed envelope failure carrying a fixed machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class _Mismatch(Exception):
    """Internal marker: a value does not satisfy an embedded schema."""


# Shared fragments below mirror byte-identical JSON objects repeated across
# the v0.1 schema files; sharing them cannot change validation semantics.
_GEOMETRY = {
    "type": "object",
    "properties": {
        "w": {"type": "integer", "minimum": 1},
        "h": {"type": "integer", "minimum": 1},
    },
    "required": ["w", "h"],
    "additionalProperties": False,
}

_BBOX = {
    "type": "object",
    "properties": {
        "x": {"type": "integer", "minimum": 0},
        "y": {"type": "integer", "minimum": 0},
        "w": {"type": "integer", "minimum": 1},
        "h": {"type": "integer", "minimum": 1},
    },
    "required": ["x", "y", "w", "h"],
    "additionalProperties": False,
}

_ACTION_VARIANTS = [
    {
        "type": "object",
        "properties": {
            "type": {"const": "click"},
            "x": {"type": "integer", "minimum": 0},
            "y": {"type": "integer", "minimum": 0},
            "button": {"type": "string",
                       "enum": ["left", "middle", "right"]},
        },
        "required": ["type", "x", "y", "button"],
        "additionalProperties": False,
    },
    {
        "type": "object",
        "properties": {
            "type": {"const": "key"},
            "keys": {
                "type": "array",
                "items": {"type": "string", "minLength": 1},
                "minItems": 1,
            },
        },
        "required": ["type", "keys"],
        "additionalProperties": False,
    },
    {
        "type": "object",
        "properties": {
            "type": {"const": "type"},
            "text": {"type": "string", "minLength": 1},
        },
        "required": ["type", "text"],
        "additionalProperties": False,
    },
    {
        "type": "object",
        "properties": {
            "type": {"const": "scroll"},
            "dx": {"type": "integer"},
            "dy": {"type": "integer"},
        },
        "required": ["type", "dx", "dy"],
        "additionalProperties": False,
    },
    {
        "type": "object",
        "properties": {
            "type": {"const": "wait"},
            "ms": {"type": "integer", "minimum": 1},
        },
        "required": ["type", "ms"],
        "additionalProperties": False,
    },
    {
        "type": "object",
        "properties": {
            "type": {"const": "lane_submit"},
            "verb": {"type": "string", "minLength": 1, "maxLength": 128},
            "payload": {
                "type": "object",
                "properties": {
                    "nonce": {"type": "string", "minLength": 1,
                              "maxLength": 128},
                    "seq": {"type": "integer", "minimum": 1},
                    "command": {"type": "string", "minLength": 1,
                                "maxLength": 128},
                    "args": {"type": "array",
                             "items": {"type": "string"}},
                },
                "required": ["nonce", "seq", "command", "args"],
                "additionalProperties": False,
            },
        },
        "required": ["type", "verb", "payload"],
        "additionalProperties": False,
    },
]

_SCHEMA_SURFACE = {
    "type": "object",
    "properties": {
        "schema": {"const": "surface/v0.1"},
        "surface_id": {"type": "string", "minLength": 1, "maxLength": 128},
        "kind": {"type": "string",
                 "enum": ["desktop_capsule", "browser", "game_capsule",
                          "vm"]},
        "display": {"type": "string", "minLength": 1},
        "geometry": _GEOMETRY,
        "state": {"type": "string",
                  "enum": ["active", "standby", "ceded", "destroyed",
                           "lost"]},
        "visibility": {"type": "string",
                       "enum": ["folded", "unfolded", "pinned"]},
        "control": {"type": "string", "enum": ["agent", "human", "shared"]},
        "profile_id": {"type": "string", "minLength": 1, "maxLength": 128},
    },
    "required": ["schema", "surface_id", "kind", "display", "geometry",
                 "state", "visibility", "control", "profile_id"],
    "additionalProperties": False,
}

_SCHEMA_FRAME_REF = {
    "type": "object",
    "properties": {
        "schema": {"const": "frame_ref/v0.1"},
        "surface_id": {"type": "string", "minLength": 1, "maxLength": 128},
        "generation": {"type": "integer", "minimum": 1},
        "tick": {"type": "integer", "minimum": 0},
        "ts_ns": {"type": "integer", "minimum": 0},
        "width": {"type": "integer", "minimum": 1},
        "height": {"type": "integer", "minimum": 1},
        "format": {"const": "rgb24"},
        "ramws_path": {"type": "string",
                       "pattern": "^/dev/shm/[^" + _NUL + "]+$"},
        "sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
        "capture_us": {"type": "integer", "minimum": 0},
    },
    "required": ["schema", "surface_id", "generation", "tick", "ts_ns",
                 "width", "height", "format", "ramws_path", "sha256",
                 "capture_us"],
    "additionalProperties": False,
}

_SCHEMA_ACTION_PROPOSAL = {
    "type": "object",
    "properties": {
        "schema": {"const": "action_proposal/v0.1"},
        "proposal_id": {"type": "string", "minLength": 1, "maxLength": 128},
        "surface_id": {"type": "string", "minLength": 1, "maxLength": 128},
        "based_on_frame": {
            "type": "object",
            "properties": {
                "sha256": {"type": "string",
                           "pattern": "^[0-9a-f]{64}$"},
                "generation": {"type": "integer", "minimum": 1},
            },
            "required": ["sha256", "generation"],
            "additionalProperties": False,
        },
        "action": {"oneOf": _ACTION_VARIANTS},
        "expectation": {
            "oneOf": [
                {
                    "type": "object",
                    "properties": {
                        "type": {"const": "changed_region"},
                        "bbox": _BBOX,
                    },
                    "required": ["type", "bbox"],
                    "additionalProperties": False,
                },
                {
                    "type": "object",
                    "properties": {
                        "type": {"const": "element_state"},
                        "role": {"type": "string", "minLength": 1,
                                 "maxLength": 128},
                        "name": {"type": "string"},
                        "state": {"type": "string", "minLength": 1,
                                  "maxLength": 128},
                    },
                    "required": ["type", "role", "name", "state"],
                    "additionalProperties": False,
                },
                {
                    "type": "object",
                    "properties": {
                        "type": {"const": "state_sha256_change"},
                        "before": {"type": "string",
                                   "pattern": "^[0-9a-f]{64}$"},
                        "min_tick": {"type": "integer", "minimum": 0},
                        "max_tick": {"type": "integer", "minimum": 0},
                    },
                    "required": ["type", "before", "min_tick", "max_tick"],
                    "additionalProperties": False,
                },
                {
                    "type": "object",
                    "properties": {
                        "type": {"const": "text_present"},
                        "text": {"type": "string", "minLength": 1},
                    },
                    "required": ["type", "text"],
                    "additionalProperties": False,
                },
            ]
        },
        "budget": {
            "type": "object",
            "properties": {
                "max_ms": {"type": "integer", "minimum": 1},
                "max_retries": {"type": "integer", "minimum": 0},
            },
            "required": ["max_ms", "max_retries"],
            "additionalProperties": False,
        },
    },
    "required": ["schema", "proposal_id", "surface_id", "based_on_frame",
                 "action", "expectation", "budget"],
    "additionalProperties": False,
}

_SCHEMA_ACTION_VERDICT = {
    "oneOf": [
        {
            "type": "object",
            "properties": {
                "schema": {"const": "action_verdict/v0.1"},
                "proposal_id": {"type": "string", "minLength": 1,
                                 "maxLength": 128},
                "decision": {"const": "refused"},
                "reason_code": {
                    "type": "string",
                    "enum": ["STALE_FRAME", "SURFACE_NOT_AGENT_CONTROLLED",
                             "LOCKED_BY_OTHER", "BUDGET_EXCEEDED",
                             "OUT_OF_BOUNDS", "POLICY"],
                },
                "core_seq": {"type": "integer", "minimum": 1},
            },
            "required": ["schema", "proposal_id", "decision", "reason_code",
                         "core_seq"],
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "schema": {"const": "action_verdict/v0.1"},
                "proposal_id": {"type": "string", "minLength": 1,
                                 "maxLength": 128},
                "decision": {"const": "admitted"},
                "core_seq": {"type": "integer", "minimum": 1},
            },
            "required": ["schema", "proposal_id", "decision", "core_seq"],
            "additionalProperties": False,
        },
    ]
}

_SCHEMA_ACTION_RECEIPT = {
    "type": "object",
    "properties": {
        "schema": {"const": "action_receipt/v0.1"},
        "proposal_id": {"type": "string", "minLength": 1, "maxLength": 128},
        "executed_at_ns": {"type": "integer", "minimum": 0},
        "after_frame": {"$ref": "frame_ref.schema.json"},
        "verified": {"type": "boolean"},
        "verification": {
            "type": "object",
            "properties": {
                "method": {"type": "string",
                           "enum": ["pixel", "element", "state_sha256"]},
                "detail": {"type": "string", "minLength": 1},
            },
            "required": ["method", "detail"],
            "additionalProperties": False,
        },
        "error": {"type": "string"},
    },
    "required": ["schema", "proposal_id", "executed_at_ns",
                 "after_frame", "verified", "verification", "error"],
    "additionalProperties": False,
}

_SCHEMA_OBSERVATION = {
    "type": "object",
    "properties": {
        "schema": {"const": "observation/v0.1"},
        "frame_ref": {"$ref": "frame_ref.schema.json"},
        "vision": {
            "type": "object",
            "properties": {
                "summary": {"type": "string"},
                "changed_regions": {"type": "array", "items": _BBOX},
                "elements": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "bbox": _BBOX,
                            "role": {"type": "string", "minLength": 1,
                                     "maxLength": 128},
                            "name": {"type": "string"},
                            "confidence": {"type": "number", "minimum": 0,
                                           "maximum": 1},
                        },
                        "required": ["bbox", "role", "name", "confidence"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["summary", "changed_regions", "elements"],
            "additionalProperties": False,
        },
        "ground_truth": {
            "type": "object",
            "properties": {
                "source": {"const": "holdings_lane"},
                "state_sha256": {"type": "string",
                                 "pattern": "^[0-9a-f]{64}$"},
                "tick": {"type": "integer", "minimum": 0},
            },
            "required": ["source", "state_sha256", "tick"],
            "additionalProperties": False,
        },
    },
    "required": ["schema", "frame_ref"],
    "additionalProperties": False,
}


def _event_branch(event, data_properties, data_required):
    return {
        "type": "object",
        "properties": {
            "schema": {"const": "surface_event/v0.1"},
            "event": {"const": event},
            "data": {
                "type": "object",
                "properties": data_properties,
                "required": data_required,
                "additionalProperties": False,
            },
        },
        "required": ["schema", "event", "data"],
        "additionalProperties": False,
    }


_SCHEMA_SURFACE_EVENT = {
    "oneOf": [
        _event_branch("created", {"surface": {
            "$ref": "surface.schema.json"}}, ["surface"]),
        _event_branch("state_changed", {"surface": {
            "$ref": "surface.schema.json"}}, ["surface"]),
        _event_branch("frame_ready", {"frame_ref": {
            "$ref": "frame_ref.schema.json"}}, ["frame_ref"]),
        _event_branch("input_applied", {
            "surface_id": {"type": "string", "minLength": 1,
                           "maxLength": 128},
            "proposal_id": {"type": "string", "minLength": 1,
                             "maxLength": 128},
        }, ["surface_id", "proposal_id"]),
        _event_branch("error", {
            "surface_id": {"type": "string", "minLength": 1,
                           "maxLength": 128},
            "code": {"type": "string", "minLength": 1, "maxLength": 128},
            "detail": {"type": "string", "minLength": 1},
        }, ["surface_id", "code", "detail"]),
    ]
}


def _request_branch(op, params_properties, params_required):
    return {
        "type": "object",
        "properties": {
            "schema": {"const": "surface_request/v0.1"},
            "op": {"const": op},
            "params": {
                "type": "object",
                "properties": params_properties,
                "required": params_required,
                "additionalProperties": False,
            },
        },
        "required": ["schema", "op", "params"],
        "additionalProperties": False,
    }


_SURFACE_ID_PROP = {"type": "string", "minLength": 1, "maxLength": 128}

_SCHEMA_SURFACE_REQUEST = {
    "oneOf": [
        _request_branch("create", {
            "kind": {"type": "string",
                     "enum": ["desktop_capsule", "browser", "game_capsule",
                              "vm"]},
            "geometry": _GEOMETRY,
            "profile_id": {"type": "string", "minLength": 1,
                           "maxLength": 128},
        }, ["kind", "geometry", "profile_id"]),
        _request_branch("list", {}, []),
        _request_branch("destroy", {"surface_id": _SURFACE_ID_PROP},
                        ["surface_id"]),
        _request_branch("frame_subscribe", {"surface_id": _SURFACE_ID_PROP},
                        ["surface_id"]),
        _request_branch("frame_unsubscribe",
                        {"surface_id": _SURFACE_ID_PROP}, ["surface_id"]),
        _request_branch("input", {
            "surface_id": _SURFACE_ID_PROP,
            "proposal_id": {"type": "string", "minLength": 1,
                             "maxLength": 128},
            "action": {"oneOf": _ACTION_VARIANTS},
        }, ["surface_id", "proposal_id", "action"]),
        _request_branch("record_start", {
            "surface_id": _SURFACE_ID_PROP,
            "recording_id": {"type": "string", "minLength": 1,
                             "maxLength": 128},
        }, ["surface_id", "recording_id"]),
        _request_branch("record_stop", {
            "surface_id": _SURFACE_ID_PROP,
            "recording_id": {"type": "string", "minLength": 1,
                             "maxLength": 128},
        }, ["surface_id", "recording_id"]),
        _request_branch("take_control", {
            "surface_id": _SURFACE_ID_PROP,
            "owner": {"type": "string",
                      "enum": ["agent", "human", "shared"]},
        }, ["surface_id", "owner"]),
        _request_branch("release_control", {"surface_id": _SURFACE_ID_PROP},
                        ["surface_id"]),
    ]
}

_BODIES = {
    "surface/v0.1": _SCHEMA_SURFACE,
    "frame_ref/v0.1": _SCHEMA_FRAME_REF,
    "surface_request/v0.1": _SCHEMA_SURFACE_REQUEST,
    "surface_event/v0.1": _SCHEMA_SURFACE_EVENT,
    "observation/v0.1": _SCHEMA_OBSERVATION,
    "action_proposal/v0.1": _SCHEMA_ACTION_PROPOSAL,
    "action_verdict/v0.1": _SCHEMA_ACTION_VERDICT,
    "action_receipt/v0.1": _SCHEMA_ACTION_RECEIPT,
}

_FILES = {
    "surface.schema.json": _SCHEMA_SURFACE,
    "frame_ref.schema.json": _SCHEMA_FRAME_REF,
    "surface_request.schema.json": _SCHEMA_SURFACE_REQUEST,
    "surface_event.schema.json": _SCHEMA_SURFACE_EVENT,
    "observation.schema.json": _SCHEMA_OBSERVATION,
    "action_proposal.schema.json": _SCHEMA_ACTION_PROPOSAL,
    "action_verdict.schema.json": _SCHEMA_ACTION_VERDICT,
    "action_receipt.schema.json": _SCHEMA_ACTION_RECEIPT,
}

_KEYWORDS = frozenset((
    "$ref", "type", "properties", "required", "additionalProperties",
    "enum", "const", "oneOf", "items", "minItems", "minimum", "maximum",
    "minLength", "maxLength", "pattern", "maxItems", "maxProperties",
))
_TYPES = frozenset(("object", "array", "string", "integer", "number",
                    "boolean", "null"))
_PATTERNS: dict = {}


def _audit(schema, seen=None):
    """Fail fast at import if the embedded data misuses the subset."""
    if seen is None:
        seen = set()
    if id(schema) in seen:
        return
    seen.add(id(schema))
    if not isinstance(schema, dict) or set(schema) - _KEYWORDS:
        raise AssertionError("embedded schema uses an unknown keyword")
    kind = schema.get("type")
    if kind is not None and kind not in _TYPES:
        raise AssertionError("embedded schema uses an unknown type")
    if kind == "object" or "properties" in schema:
        if schema.get("additionalProperties") is not False:
            raise AssertionError("embedded object left open")
        props = schema.get("properties", {})
        required = schema.get("required", [])
        if any(name not in props for name in required):
            raise AssertionError("embedded required names undeclared key")
        for child in props.values():
            _audit(child, seen)
    for key in ("minimum", "maximum"):
        if key in schema and type(schema[key]) not in (int, float):
            raise AssertionError("embedded numeric bound is not numeric")
    for key in ("minLength", "maxLength", "minItems"):
        if key in schema and (type(schema[key]) is not int
                              or schema[key] < 0):
            raise AssertionError("embedded length bound invalid")
    if "pattern" in schema:
        try:
            _PATTERNS.setdefault(schema["pattern"],
                                 re.compile(schema["pattern"]))
        except re.error:
            raise AssertionError("embedded pattern invalid") from None
    if "enum" in schema and (not isinstance(schema["enum"], list)
                             or not schema["enum"]):
        raise AssertionError("embedded enum invalid")
    if "$ref" in schema and schema["$ref"] not in _FILES:
        raise AssertionError("embedded reference escapes siblings")
    if "oneOf" in schema:
        if not isinstance(schema["oneOf"], list) or not schema["oneOf"]:
            raise AssertionError("embedded oneOf invalid")
        for child in schema["oneOf"]:
            _audit(child, seen)
    if "items" in schema:
        _audit(schema["items"], seen)


_V02_FILES = copy.deepcopy(_V02_FILES)
_FILES = {**_FILES, **{f"v0.2/{k}": v for k, v in _V02_FILES.items()}}

def _version_refs(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "$ref":
                value[key] = "v0.2/" + child
            elif key == "const" and isinstance(child, str) and child.endswith("/v0.1"):
                value[key] = child.removesuffix("/v0.1") + "/v0.2"
            else:
                _version_refs(child)
    elif isinstance(value, list):
        for child in value:
            _version_refs(child)

for _schema in _V02_FILES.values():
    _version_refs(_schema)
for _name, _schema in _V02_FILES.items():
    if _name != "envelope.schema.json":
        _BODIES[_name.removesuffix(".schema.json") + "/v0.2"] = _schema

for _schema in _BODIES.values():
    _audit(_schema)
del _schema


def _const_equal(first, second):
    # JSON booleans must never compare equal to numbers.
    if type(first) is bool or type(second) is bool:
        return type(first) is type(second) and first == second
    if isinstance(first, dict) and isinstance(second, dict):
        return (first.keys() == second.keys()
                and all(_const_equal(first[k], second[k]) for k in first))
    if isinstance(first, list) and isinstance(second, list):
        return (len(first) == len(second)
                and all(_const_equal(x, y) for x, y in zip(first, second)))
    return first == second


def _type_matches(kind, value):
    if kind == "object":
        return isinstance(value, dict)
    if kind == "array":
        return isinstance(value, list)
    if kind == "string":
        return isinstance(value, str)
    if kind == "integer":
        return type(value) is int
    if kind == "number":
        return type(value) in (int, float)
    if kind == "boolean":
        return type(value) is bool
    return value is None


def _check(value, schema, depth):
    if depth > _MAX_DEPTH:
        raise _Mismatch("nesting limit")
    if "$ref" in schema:
        target = _FILES.get(schema["$ref"])
        if target is None:
            raise _Mismatch("unresolvable reference")
        _check(value, target, depth + 1)
    kind = schema.get("type")
    if kind is not None and not _type_matches(kind, value):
        raise _Mismatch("type")
    if "const" in schema and not _const_equal(value, schema["const"]):
        raise _Mismatch("const")
    if "enum" in schema and not any(_const_equal(value, each)
                                    for each in schema["enum"]):
        raise _Mismatch("enum")
    if "oneOf" in schema:
        matches = 0
        for branch in schema["oneOf"]:
            try:
                _check(value, branch, depth + 1)
                matches += 1
            except _Mismatch:
                pass
        if matches != 1:
            raise _Mismatch("oneOf")
    if isinstance(value, dict):
        if len(value) > schema.get("maxProperties", math.inf):
            raise _Mismatch("maxProperties")
        for key in schema.get("required", []):
            if key not in value:
                raise _Mismatch("required")
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in props:
                    raise _Mismatch("closed")
        for key in value.keys() & props.keys():
            _check(value[key], props[key], depth + 1)
    if isinstance(value, list):
        if len(value) > schema.get("maxItems", math.inf):
            raise _Mismatch("maxItems")
        if len(value) < schema.get("minItems", 0):
            raise _Mismatch("minItems")
        if "items" in schema:
            for item in value:
                _check(item, schema["items"], depth + 1)
    if isinstance(value, str):
        if (len(value) < schema.get("minLength", 0)
                or len(value) > schema.get("maxLength", math.inf)):
            raise _Mismatch("length")
        if "pattern" in schema and not _PATTERNS[schema["pattern"]].search(
                value):
            raise _Mismatch("pattern")
    if type(value) in (int, float):
        if type(value) is float and not math.isfinite(value):
            raise _Mismatch("non-finite")
        if (value < schema.get("minimum", -math.inf)
                or value > schema.get("maximum", math.inf)):
            raise _Mismatch("bounds")


def _valid_endpoint(value):
    return (
        isinstance(value, dict)
        and set(value) == _ENDPOINT_KEYS
        and isinstance(value["component"], str)
        and value["component"] in COMPONENTS
        and isinstance(value["instance"], str)
        and 1 <= len(value["instance"]) <= _MAX_STRING
    )


def _valid_name(value):
    return isinstance(value, str) and 1 <= len(value) <= _MAX_STRING


def _check_json_values(value, depth=0):
    # [TARGET, unit decision] Both versions use exact safe JSON integers and
    # Unicode scalar strings; validate without converting integers to float.
    if depth > _MAX_DEPTH:
        raise _Mismatch("nesting limit")
    if type(value) is int and not -_MAX_SAFE_INT <= value <= _MAX_SAFE_INT:
        raise _Mismatch("unsafe integer")
    if type(value) is float and not math.isfinite(value):
        raise _Mismatch("non-finite")
    if isinstance(value, str) and any(0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise _Mismatch("surrogate")
    if isinstance(value, dict):
        for key, child in value.items():
            _check_json_values(key, depth + 1)
            _check_json_values(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            _check_json_values(child, depth + 1)


def validate_envelope(value: object) -> dict:
    """Runtime-validate a closed envelope; returns it unchanged.

    Raises EnvelopeError with ``unknown_version`` for a well-formed frame
    naming a contract this build does not speak, ``bad_shape`` for any
    other deviation, and never mutates its input.
    """
    if not isinstance(value, dict) or set(value) != _OUTER_KEYS:
        raise EnvelopeError("bad_shape", "envelope keys are not exact")
    try:
        _check_json_values(value)
    except _Mismatch:
        raise EnvelopeError("bad_shape", "envelope contains invalid JSON values") from None
    schema = value["schema"]
    if not isinstance(schema, str) or not schema:
        raise EnvelopeError("bad_shape", "envelope schema malformed")
    if schema not in (SCHEMA, _LEGACY_SCHEMA):
        raise EnvelopeError("unknown_version", "unknown envelope version")
    if not _valid_endpoint(value["from"]) or not _valid_endpoint(value["to"]):
        raise EnvelopeError("bad_shape", "envelope endpoint malformed")
    seq = value["seq"]
    if type(seq) is not int or seq < 1:
        raise EnvelopeError("bad_shape", "envelope sequence malformed")
    ts_ns = value["ts_ns"]
    if type(ts_ns) is not int or ts_ns < 0:
        raise EnvelopeError("bad_shape", "envelope timestamp malformed")
    for key in ("msg_id", "session_id", "nonce"):
        if not _valid_name(value[key]):
            raise EnvelopeError("bad_shape", "envelope name malformed")
    body = value["body"]
    if not isinstance(body, dict):
        raise EnvelopeError("bad_shape", "envelope body malformed")
    discriminator = body.get("schema")
    if not isinstance(discriminator, str) or not discriminator:
        raise EnvelopeError("bad_shape", "body discriminator malformed")
    target = _BODIES.get(discriminator)
    if target is None or discriminator.rsplit("/", 1)[-1] != schema.rsplit("/", 1)[-1]:
        raise EnvelopeError("unknown_version", "unknown body version")
    try:
        _check(body, target, 0)
    except _Mismatch:
        raise EnvelopeError("bad_shape", "body violates contract") from None
    return value


def make_envelope(*, msg_id: str, from_component: str,
                  from_instance: str, to_component: str, to_instance: str,
                  session_id: str, seq: int, body: dict,
                  nonce: str | None = None,
                  ts_ns: int | None = None) -> dict:
    """Build a validated envelope, generating nonce and clock when omitted.

    The nonce defaults to 32 lowercase hex characters and the timestamp to
    the monotonic session clock; supplied values pass through validation
    unchanged. The body is deep-copied so later caller mutation cannot
    corrupt the returned frame.
    """
    if nonce is None:
        nonce = secrets.token_hex(16)
    if ts_ns is None:
        ts_ns = time.monotonic_ns()
    envelope = {
        "schema": (_LEGACY_SCHEMA if isinstance(body, dict) and str(body.get("schema", "")).endswith("/v0.1") else SCHEMA),
        "msg_id": msg_id,
        "ts_ns": ts_ns,
        "from": {"component": from_component, "instance": from_instance},
        "to": {"component": to_component, "instance": to_instance},
        "session_id": session_id,
        "seq": seq,
        "nonce": nonce,
        "body": copy.deepcopy(body),
    }
    return validate_envelope(envelope)


def _check_cap(max_bytes: int) -> None:
    if type(max_bytes) is not int or max_bytes <= 0:
        raise EnvelopeError("bad_shape", "byte cap is not a positive int")


def dumps_envelope(env: dict, *, max_bytes: int) -> bytes:
    """Encode one validated envelope as a single LF-terminated UTF-8 line.

    The cap covers the complete frame including its terminator and gates
    before the bytes are handed to any transport.
    """
    _check_cap(max_bytes)
    validate_envelope(env)
    try:
        text = json.dumps(env, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":"))
        raw = text.encode("utf-8") + b"\n"
    except (ValueError, TypeError):
        raise EnvelopeError("bad_shape",
                            "envelope is not JSON-encodable") from None
    if b"\n" in raw[:-1] or b"\r" in raw[:-1]:
        raise EnvelopeError("bad_shape", "encoded frame is not one line")
    if len(raw) > max_bytes:
        raise EnvelopeError("length", "frame exceeds byte cap")
    return raw


def _reject_duplicate_keys(pairs):
    found: dict = {}
    for key, val in pairs:
        if key in found:
            raise ValueError("duplicate object key")
        found[key] = val
    return found


def _reject_constant(word):
    raise ValueError("non-finite literal: " + word)


def loads_envelope(line: bytes, *, max_bytes: int) -> dict:
    """Decode one LF- or CRLF-terminated NDJSON frame into an envelope.

    Byte length gates before UTF-8 decoding and JSON parsing; embedded raw
    carriage returns or line feeds, blank frames, duplicate keys,
    non-finite numbers and trailing values are all refused without any
    silent normalization.
    """
    if not isinstance(line, bytes):
        raise EnvelopeError("bad_shape", "frame is not bytes")
    _check_cap(max_bytes)
    if len(line) > max_bytes:
        raise EnvelopeError("length", "frame exceeds byte cap")
    if not line.endswith(b"\n"):
        raise EnvelopeError("bad_shape", "frame lacks its terminator")
    payload = line[:-1]
    if payload.endswith(b"\r"):
        payload = payload[:-1]
    if not payload:
        raise EnvelopeError("bad_shape", "frame is blank")
    if b"\n" in payload or b"\r" in payload:
        raise EnvelopeError("bad_shape", "frame spans more than one line")
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        raise EnvelopeError("bad_shape", "frame is not valid UTF-8"
                            ) from None
    # Transport nesting counts containers only (root is level one), unlike
    # the schema evaluator's separate recursion budget.
    depth = 0
    in_string = False
    escaped = False
    for char in text:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char in "[{":
            depth += 1
            if depth > 32:
                raise EnvelopeError("bad_shape", "frame exceeds JSON nesting cap")
        elif char in "]}":
            depth -= 1
            if depth < 0:
                raise EnvelopeError("bad_shape", "frame has unmatched container")
    try:
        value = json.loads(text,
                           object_pairs_hook=_reject_duplicate_keys,
                           parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        raise EnvelopeError("bad_shape", "frame is not valid JSON"
                            ) from None
    return validate_envelope(value)
