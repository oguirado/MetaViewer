"""Muse Spark perception adapter with an injected runtime transport.

The Meta model wire protocol is absent from every API pack, so this
module defines a minimal in-process transport protocol instead of
hardcoding an external endpoint: the integrator supplies a callable
that turns a closed request dict plus a runtime-only credential into
one bounded JSON response line. The adapter owns wire bounds, strict
output validation against the closed ``vision`` contract, and
credential hygiene; admission, freshness, and witnesses stay with
the core.
"""

from __future__ import annotations

import copy
import json
import os
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from metaviewer_agents.perception.base import (
    Frame,
    PerceptionAdapter,
    PerceptionError,
    check_vision,
)

__all__ = ["MetaMusePerceptionAdapter"]

# Unit-decision wire tags: no Meta endpoint exists in the API packs,
# so request/response versions are owned by this unit, not by Meta.
_REQUEST_SCHEMA = "muse.vision.request/v1"
_RESPONSE_SCHEMA = "muse.vision/v1"
_REQUEST_KEYS = frozenset(("schema", "frame_ref", "frame", "prev"))
_RESPONSE_KEYS = frozenset(("schema", "vision"))

# Single-line bound carried over from the Cafe connector framing.
_DEFAULT_MAX_LINE = 16384

_KNOWN_FRAME_SCHEMAS = ("frame_ref/v0.1", "frame_ref/v0.2")

_RAM_PREFIXES = ("/dev/shm/", "/proc/self/fd/")
_NUL = chr(0)

# Transport turns (request, credential) into one JSON response line.
Transport = Callable[[dict[str, Any], bytes | None], bytes]


def _fail(code: str, message: str) -> None:
    raise PerceptionError(code, message)


def _reject_constant(value: str) -> None:
    raise ValueError("non-strict JSON constant")


def _check_int(value: object, *, minimum: int, name: str) -> int:
    # type() is exact: bool must never pass as an integer.
    if type(value) is not int:
        _fail("bad_shape", "%s is not an integer" % name)
    assert isinstance(value, int)
    if value < minimum:
        _fail("bad_shape", "%s below minimum" % name)
    return value


def _frame_dims(frame_ref: object) -> tuple[int, int]:
    # The adapter binds only schema generation and dimensions; the
    # full trusted binding stays with the core observation check.
    if not isinstance(frame_ref, Mapping):
        _fail("bad_shape", "frame_ref is not an object")
    assert isinstance(frame_ref, Mapping)
    schema = frame_ref.get("schema")
    if schema not in _KNOWN_FRAME_SCHEMAS:
        if isinstance(schema, str) and schema.startswith("frame_ref/v"):
            _fail("unknown_version", "unknown frame_ref version")
        _fail("bad_shape", "frame_ref schema malformed")
    width = _check_int(frame_ref.get("width"), minimum=1,
                       name="frame_ref.width")
    height = _check_int(frame_ref.get("height"), minimum=1,
                        name="frame_ref.height")
    return width, height


def _check_frame_arg(value: object, *, name: str,
                     width: int, height: int) -> None:
    # The adapter never opens frame paths itself; the containment
    # check just keeps non-RAM inputs from reaching the transport.
    if value is None:
        return
    if isinstance(value, Frame):
        if value.width != width or value.height != height:
            _fail("bad_shape",
                  name + " dimensions disagree with frame_ref")
        return
    if isinstance(value, Path):
        value = str(value)
    if isinstance(value, str) and value and _NUL not in value:
        normal = os.path.normpath(value)
        for prefix in _RAM_PREFIXES:
            if normal.startswith(prefix) and len(normal) > len(prefix):
                return
    _fail("bad_shape", name + " is not a bound frame or RAM path")


class MetaMusePerceptionAdapter(PerceptionAdapter):
    """Perception adapter fronting Muse Spark through injection.

    ``transport`` maps a closed request dict and the runtime
    credential to one UTF-8 JSON response line of at most
    ``max_line`` bytes; ``credential`` lives in memory only and is
    never logged, serialized, echoed in exceptions, or shown by
    ``repr``. ``perceive`` returns a closed ``vision`` dict accepted
    by the observation contract, or raises :data:`PerceptionError`.
    """

    def __init__(self, *, transport: Transport,
                 credential: bytes | bytearray | None = None,
                 max_line: int = _DEFAULT_MAX_LINE) -> None:
        if not callable(transport):
            _fail("bad_shape", "muse transport is not callable")
        if credential is not None:
            if (not isinstance(credential, (bytes, bytearray))
                    or not credential):
                _fail("bad_shape",
                      "muse credential must be nonempty bytes")
            credential = bytes(credential)
        if type(max_line) is not int or max_line < 1:
            _fail("bad_shape", "max_line must be a positive integer")
        self._transport = transport
        self._credential = credential
        self._max_line = max_line

    def __repr__(self) -> str:
        # Never name the transport or the key: either may carry secrets.
        configured = getattr(self, "_credential", None) is not None
        return "MetaMusePerceptionAdapter(credential_set=%r)" % configured

    __str__ = __repr__

    def clear_credential(self) -> None:
        """Drop the runtime credential; the adapter then refuses."""
        self._credential = None

    def perceive(self, frame_ref: Mapping[str, Any],
                 frame: Frame | str | Path | None = None, *,
                 prev: Frame | str | Path | None = None
                 ) -> dict[str, Any]:
        """Describe the bound frame as a closed ``vision`` dict."""
        width, height = _frame_dims(frame_ref)
        _check_frame_arg(frame, name="frame", width=width, height=height)
        _check_frame_arg(prev, name="prev", width=width, height=height)
        if self._credential is None:
            _fail("unavailable", "muse credential not configured")
        request = {
            "schema": _REQUEST_SCHEMA,
            "frame_ref": copy.deepcopy(dict(frame_ref)),
            "frame": frame,
            "prev": prev,
        }
        assert set(request) == _REQUEST_KEYS
        try:
            raw = self._transport(request, self._credential)
        except Exception as error:
            # Only the exception type crosses the boundary: transport
            # messages may echo credential or account material.
            _fail("unavailable",
                  "muse transport failed: %s" % type(error).__name__)
        if not isinstance(raw, (bytes, bytearray)):
            _fail("bad_shape", "muse response is not bytes")
        assert isinstance(raw, (bytes, bytearray))
        if len(raw) > self._max_line:
            _fail("bad_shape", "muse response exceeds line bound")
        try:
            text = bytes(raw).decode("utf-8")
        except UnicodeDecodeError:
            _fail("bad_shape", "muse response is not utf-8")
        try:
            payload = json.loads(text, parse_constant=_reject_constant)
        except (ValueError, RecursionError):
            _fail("bad_shape", "muse response is not strict JSON")
        if not isinstance(payload, dict) or set(payload) != _RESPONSE_KEYS:
            _fail("bad_shape", "muse response keys are not exact")
        schema = payload["schema"]
        if not isinstance(schema, str) or not schema:
            _fail("bad_shape", "muse response schema malformed")
        if schema != _RESPONSE_SCHEMA:
            _fail("unknown_version", "unknown muse response version")
        vision = payload["vision"]
        # Single validation source: v0.2 caps plus the consumer's own
        # observation check, re-raised as PerceptionError by base.
        check_vision(vision, width=width, height=height)
        assert isinstance(vision, dict)
        return copy.deepcopy(vision)
