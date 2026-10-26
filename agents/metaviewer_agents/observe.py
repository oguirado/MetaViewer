"""Agent-side observation/v0.1 construction and validation.

Builds and runtime-validates ``observation/v0.1`` payloads against the
frozen v0.1 contract: exactly one bound ``frame_ref/v0.1`` plus optional
closed ``vision`` and ``ground_truth`` objects. Every value is checked
explicitly (exact key sets, strict integer/boolean separation, finite
confidence, frame bounds); anything else is refused with
:data:`ObservationError`. Metadata checks cannot prove frame bytes,
freshness or producer provenance; those stay with the core and adapters.

Also provides the Holdings battery digest: SHA-256 over canonical JSON
bytes of a STATE clone with every ``node.box`` replaced by ``None``.
This digest is geometry-free by construction and is never a substitute
for the core ``state_sha256`` witness.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re

__all__ = [
    "ObservationError",
    "validate_observation",
    "build_observation",
    "compute_battery_state_sha256",
]

_OBSERVATION_SCHEMA = "observation/v0.1"
_FRAME_REF_SCHEMA = "frame_ref/v0.1"
_RGB24 = "rgb24"
_HOLDINGS_SOURCE = "holdings_lane"
_RAMWS_PREFIX = "/dev/shm/"
# NUL spelled as code: shared-memory paths must exclude it.
_NUL = chr(0)
_HEX64 = re.compile(r"[0-9a-f]{64}")
_MAX_DEPTH = 100
_MAX_SURFACE_ID = 128
_MAX_ROLE = 128

_FRAME_KEYS = frozenset((
    "schema", "surface_id", "generation", "tick", "ts_ns", "width",
    "height", "format", "ramws_path", "sha256", "capture_us",
))
_OBSERVATION_REQUIRED = frozenset(("schema", "frame_ref"))
_OBSERVATION_KEYS = frozenset(
    ("schema", "frame_ref", "vision", "ground_truth"))
_VISION_REQUIRED = frozenset(("summary", "changed_regions", "elements"))
_BBOX_KEYS = frozenset(("x", "y", "w", "h"))
_ELEMENT_REQUIRED = frozenset(("bbox", "role", "name", "confidence"))
_GROUND_TRUTH_KEYS = frozenset(("source", "state_sha256", "tick"))


class ObservationError(ValueError):
    """Closed observation failure carrying a machine-readable code.

    ``unknown_version`` names a well-formed payload for a foreign
    contract version, ``identity_mismatch`` a broken trusted binding,
    and ``bad_shape`` any other deviation.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _fail(code: str, message: str) -> None:
    raise ObservationError(code, message)


def _check_int(value: object, *, minimum: int, name: str) -> int:
    # type() is exact: bool must never pass as an integer.
    if type(value) is not int:
        _fail("bad_shape", "%s is not an integer" % name)
    assert isinstance(value, int)
    if value < minimum:
        _fail("bad_shape", "%s below minimum" % name)
    return value


def _check_box(box: object, *, width: int, height: int, name: str) -> None:
    if not isinstance(box, dict) or set(box) != _BBOX_KEYS:
        _fail("bad_shape", "%s keys are not exact" % name)
    assert isinstance(box, dict)
    x = _check_int(box["x"], minimum=0, name=name + ".x")
    y = _check_int(box["y"], minimum=0, name=name + ".y")
    w = _check_int(box["w"], minimum=1, name=name + ".w")
    h = _check_int(box["h"], minimum=1, name=name + ".h")
    if x + w > width or y + h > height:
        _fail("bad_shape", "%s escapes the frame" % name)


def _check_hex64(value: object, *, name: str) -> None:
    if not isinstance(value, str) or _HEX64.fullmatch(value) is None:
        _fail("bad_shape", "%s is not 64 lowercase hex" % name)


def _check_ramws_path(value: object) -> None:
    if (not isinstance(value, str) or not value.startswith(_RAMWS_PREFIX)
            or len(value) <= len(_RAMWS_PREFIX) or _NUL in value):
        _fail("bad_shape", "ramws_path leaves shared memory")


def _check_frame_ref(frame: object, *, version="v0.1") -> dict:
    if not isinstance(frame, dict) or set(frame) != _FRAME_KEYS:
        _fail("bad_shape", "frame_ref keys are not exact")
    assert isinstance(frame, dict)
    schema = frame["schema"]
    if not isinstance(schema, str) or not schema:
        _fail("bad_shape", "frame_ref schema malformed")
    if schema != "frame_ref/" + version:
        _fail("unknown_version", "unknown frame_ref version")
    surface_id = frame["surface_id"]
    if (not isinstance(surface_id, str)
            or not 1 <= len(surface_id) <= _MAX_SURFACE_ID):
        _fail("bad_shape", "frame_ref surface_id malformed")
    _check_int(frame["generation"], minimum=1,
               name="frame_ref.generation")
    _check_int(frame["tick"], minimum=0, name="frame_ref.tick")
    _check_int(frame["ts_ns"], minimum=0, name="frame_ref.ts_ns")
    _check_int(frame["width"], minimum=1, name="frame_ref.width")
    _check_int(frame["height"], minimum=1, name="frame_ref.height")
    if frame["format"] != _RGB24:
        _fail("bad_shape", "frame_ref format is not rgb24")
    _check_ramws_path(frame["ramws_path"])
    _check_hex64(frame["sha256"], name="frame_ref.sha256")
    _check_int(frame["capture_us"], minimum=0,
               name="frame_ref.capture_us")
    return frame


def _check_confidence(value: object) -> None:
    # Schema "number" admits ints; bool is never a number here.
    if type(value) not in (int, float):
        _fail("bad_shape", "confidence is not a number")
    assert isinstance(value, (int, float))
    if value < 0 or value > 1 or not math.isfinite(value):
        _fail("bad_shape", "confidence outside [0.0, 1.0]")


def _check_vision(vision: object, *, width: int, height: int) -> None:
    if (not isinstance(vision, dict)
            or set(vision) != _VISION_REQUIRED):
        _fail("bad_shape", "vision keys are not exact")
    assert isinstance(vision, dict)
    if not isinstance(vision["summary"], str):
        _fail("bad_shape", "vision summary is not a string")
    regions = vision["changed_regions"]
    if not isinstance(regions, list):
        _fail("bad_shape", "changed_regions is not an array")
    for index, region in enumerate(regions):
        _check_box(region, width=width, height=height,
                   name="changed_regions[%d]" % index)
    elements = vision["elements"]
    if not isinstance(elements, list):
        _fail("bad_shape", "elements is not an array")
    for index, element in enumerate(elements):
        name = "elements[%d]" % index
        if (not isinstance(element, dict)
                or set(element) != _ELEMENT_REQUIRED):
            _fail("bad_shape", "%s keys are not exact" % name)
        _check_box(element["bbox"], width=width, height=height,
                   name=name + ".bbox")
        role = element["role"]
        if not isinstance(role, str) or not 1 <= len(role) <= _MAX_ROLE:
            _fail("bad_shape", name + " role malformed")
        if not isinstance(element["name"], str):
            _fail("bad_shape", name + " name is not a string")
        _check_confidence(element["confidence"])


def _check_ground_truth(truth: object) -> None:
    if (not isinstance(truth, dict)
            or set(truth) != _GROUND_TRUTH_KEYS):
        _fail("bad_shape", "ground_truth keys are not exact")
    assert isinstance(truth, dict)
    if truth["source"] != _HOLDINGS_SOURCE:
        _fail("bad_shape", "ground_truth source is not holdings_lane")
    _check_hex64(truth["state_sha256"], name="ground_truth.state_sha256")
    _check_int(truth["tick"], minimum=0, name="ground_truth.tick")


def _check_trusted(surface_id: object, generation: object) -> None:
    if (not isinstance(surface_id, str)
            or not 1 <= len(surface_id) <= _MAX_SURFACE_ID):
        _fail("identity_mismatch", "trusted surface_id malformed")
    if type(generation) is not int or generation < 1:
        _fail("identity_mismatch", "trusted generation malformed")


def validate_observation(observation: object, *, surface_id: str,
                         generation: int, contract_version: str = "v0.1") -> None:
    """Runtime-validate an observation against its trusted binding.

    The payload must be a closed ``observation/v0.1`` object whose
    ``frame_ref`` carries exactly the trusted ``surface_id`` and
    ``generation``. Raises :data:`ObservationError` on any deviation.
    """
    _check_trusted(surface_id, generation)
    if not isinstance(observation, dict):
        _fail("bad_shape", "observation is not an object")
    assert isinstance(observation, dict)
    keys = set(observation)
    if not _OBSERVATION_REQUIRED <= keys <= _OBSERVATION_KEYS:
        _fail("bad_shape", "observation keys are not exact")
    schema = observation["schema"]
    if not isinstance(schema, str) or not schema:
        _fail("bad_shape", "observation schema malformed")
    if contract_version not in ("v0.1", "v0.2") or schema != "observation/" + contract_version:
        _fail("unknown_version", "unknown observation version")
    frame = _check_frame_ref(observation["frame_ref"], version=contract_version)
    if (frame["surface_id"] != surface_id
            or frame["generation"] != generation):
        _fail("identity_mismatch", "frame_ref breaks trusted binding")
    if "vision" in observation:
        _check_vision(observation["vision"], width=frame["width"],
                      height=frame["height"])
    if "ground_truth" in observation:
        _check_ground_truth(observation["ground_truth"])


def build_observation(frame_ref: dict, *, surface_id: str,
                      generation: int, vision: dict | None = None,
                      ground_truth: dict | None = None) -> dict:
    """Build an isolated observation from trusted parts.

    Emits only ``schema``/``frame_ref`` plus the optionals actually
    given. Inputs are deep-copied, so later caller mutation cannot
    corrupt the returned payload; the result is validated before it
    is returned. Raises :data:`ObservationError` on any deviation.
    """
    if not isinstance(frame_ref, dict):
        _fail("bad_shape", "frame_ref is not an object")
    if vision is not None and not isinstance(vision, dict):
        _fail("bad_shape", "vision is not an object")
    if ground_truth is not None and not isinstance(ground_truth, dict):
        _fail("bad_shape", "ground_truth is not an object")
    observation: dict = {
        "schema": _OBSERVATION_SCHEMA,
        "frame_ref": copy.deepcopy(frame_ref),
    }
    if vision is not None:
        observation["vision"] = copy.deepcopy(vision)
    if ground_truth is not None:
        observation["ground_truth"] = copy.deepcopy(ground_truth)
    validate_observation(observation, surface_id=surface_id,
                         generation=generation)
    return observation


def _reject_non_canonical(value: object, depth: int) -> None:
    if depth > _MAX_DEPTH:
        _fail("bad_shape", "state nesting exceeds limit")
    if value is None or type(value) in (bool, int, str):
        return
    if isinstance(value, float):
        _fail("bad_shape", "state carries a float")
    if isinstance(value, dict):
        for key, item in value.items():
            if type(key) is not str:
                _fail("bad_shape", "state key is not a string")
            _reject_non_canonical(item, depth + 1)
        return
    if isinstance(value, list):
        for item in value:
            _reject_non_canonical(item, depth + 1)
        return
    _fail("bad_shape", "state carries a non-JSON value")


def _canonical_bytes(value: object) -> bytes:
    _reject_non_canonical(value, 0)
    text = json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)
    return text.encode("utf-8")


def compute_battery_state_sha256(state: dict) -> str:
    """Hash canonical STATE bytes with every node box stripped.

    Clones ``state["nodes"]``, sets each ``node["box"]`` to ``None``
    without touching the input or any other field, then returns the
    hex SHA-256 of the canonical UTF-8 JSON bytes (sorted keys,
    compact separators, booleans preserved, floats refused). The
    result is geometry-free and distinct from ``state_sha256``.
    Cross-language equality with the native encoder additionally
    needs its golden fixture and safe-integer domain; absent that,
    this function promises determinism within its documented form.
    """
    if not isinstance(state, dict) or not isinstance(
            state.get("nodes"), list):
        _fail("bad_shape", "state must carry nodes array")
    assert isinstance(state, dict)
    assert isinstance(state["nodes"], list)
    stripped_nodes = []
    for node in state["nodes"]:
        if not isinstance(node, dict):
            _fail("bad_shape", "state node must be an object")
        clone = dict(node)
        clone["box"] = None
        stripped_nodes.append(clone)
    stripped = dict(state)
    stripped["nodes"] = stripped_nodes
    return hashlib.sha256(_canonical_bytes(stripped)).hexdigest()
