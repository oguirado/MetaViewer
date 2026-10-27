"""Provider-agnostic perception plugin base: frames, errors, ABC, fake, registry.

Perception populates only the closed ``vision`` sub-object of an
observation from a bound ``frame_ref``; admission, freshness and
witnesses stay with the core. Every adapter implements the narrow
:meth:`PerceptionAdapter.perceive` entry point and returns a vision
dict accepted by :func:`check_vision` (key sets, geometry and types
from ``observe._check_vision`` plus the v0.2 wire caps). Failures
carry a typed :class:`PerceptionError` code; providers are selected
through an explicit registry that never falls back silently.
"""

from __future__ import annotations

import abc
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .. import observe as _observe

__all__ = [
    "PerceptionError",
    "Frame",
    "PerceptionAdapter",
    "FakePerceptionAdapter",
    "frame_dims",
    "check_vision",
    "register_perception_adapter",
    "create_perception_adapter",
    "available_perception_adapters",
]

# v0.2 wire caps on the vision sub-object (aligned with mv_tool_result.schema.json / tools.py).
_MAX_SUMMARY = 4096
_MAX_REGIONS = 4096
_MAX_ELEMENTS = 4096
_MAX_NAME = 65536


class PerceptionError(ValueError):
    """Typed perception failure carrying a machine-readable code.

    ``unknown_version`` names a well-formed payload for a foreign
    contract version, ``bad_shape`` any type, key-set or bounds
    deviation, ``unavailable`` a missing or misconfigured provider,
    credential or engine, and ``timeout`` an expired engine or
    transport call. Messages never carry credential material.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _fail(code: str, message: str) -> None:
    raise PerceptionError(code, message)


def _is_int(value: object) -> bool:
    # type() is exact: bool must never pass as an integer.
    return type(value) is int


@dataclass(frozen=True)
class Frame:
    """In-memory RGB24 row-major frame buffer."""

    width: int
    height: int
    data: bytes

    def __post_init__(self) -> None:
        if not _is_int(self.width) or not _is_int(self.height):
            _fail("bad_shape", "Frame width and height must be integers")
        assert isinstance(self.width, int) and isinstance(self.height, int)
        if self.width <= 0 or self.height <= 0:
            _fail("bad_shape", "Frame width and height must be positive")
        if not isinstance(self.data, bytes):
            _fail("bad_shape", "Frame data must be bytes")
        expected = self.width * self.height * 3
        if len(self.data) != expected:
            _fail("bad_shape", "Frame data length %d != %d"
                  % (len(self.data), expected))


def frame_dims(frame_ref: object) -> tuple[int, int]:
    """Return the bound ``(width, height)`` of a frame reference.

    Only the dimensions are read here; surface binding and freshness
    stay with the core. Anything but strict positive integers is
    refused with ``bad_shape``.
    """
    if not isinstance(frame_ref, Mapping):
        _fail("bad_shape", "frame_ref is not an object")
    assert isinstance(frame_ref, Mapping)
    width = frame_ref.get("width")
    height = frame_ref.get("height")
    if not _is_int(width) or width <= 0:
        _fail("bad_shape", "frame_ref width malformed")
    if not _is_int(height) or height <= 0:
        _fail("bad_shape", "frame_ref height malformed")
    assert _is_int(width) and _is_int(height)
    return (width, height)


def check_vision(vision: object, *, width: int, height: int) -> None:
    """Validate a closed vision dict against the consumer contract.

    Enforces the v0.2 wire caps first so no unbounded array is ever
    scanned, then delegates key sets, geometry, roles and confidence
    to ``observe._check_vision``; its failures are re-raised as
    :class:`PerceptionError` with the same code.
    """
    if (not _is_int(width) or width <= 0
            or not _is_int(height) or height <= 0):
        _fail("bad_shape", "check_vision frame dimensions malformed")
    if not isinstance(vision, dict):
        _fail("bad_shape", "vision is not an object")
    assert isinstance(vision, dict)
    summary = vision.get("summary")
    if not isinstance(summary, str) or len(summary) > _MAX_SUMMARY:
        _fail("bad_shape", "vision summary malformed")
    regions = vision.get("changed_regions")
    if not isinstance(regions, list) or len(regions) > _MAX_REGIONS:
        _fail("bad_shape", "changed_regions malformed")
    elements = vision.get("elements")
    if not isinstance(elements, list) or len(elements) > _MAX_ELEMENTS:
        _fail("bad_shape", "elements malformed")
    for index, element in enumerate(elements):
        if isinstance(element, dict):
            name = element.get("name")
            if isinstance(name, str) and len(name) > _MAX_NAME:
                _fail("bad_shape", "elements[%d] name too long" % index)
    try:
        _observe._check_vision(vision, width=width, height=height)
    except _observe.ObservationError as exc:
        raise PerceptionError(exc.code, str(exc)) from exc


def _check_frame_arg(value: object, *, name: str,
                     width: int, height: int) -> None:
    # Pixel buffers must already match the bound frame; paths stay
    # opaque here because decoding or confining them is each
    # adapter's job.
    if value is None:
        return
    if isinstance(value, Frame):
        if (value.width, value.height) != (width, height):
            _fail("bad_shape", name + " dimensions do not match frame_ref")
        return
    if isinstance(value, Path):
        return
    if isinstance(value, str):
        if not value:
            _fail("bad_shape", name + " path is empty")
        return
    _fail("bad_shape", name + " must be a Frame, path or None")


class PerceptionAdapter(abc.ABC):
    """Narrow interface between the agent loop and a vision provider."""

    @abc.abstractmethod
    def perceive(self, frame_ref: Mapping[str, Any],
                 frame: Frame | str | Path | None = None, *,
                 prev: Frame | str | Path | None = None) -> dict[str, Any]:
        """Return the closed vision dict for a bound frame reference.

        The result carries exactly ``summary``, ``changed_regions``
        and ``elements`` and must pass :func:`check_vision` for the
        bound dimensions; failures raise :class:`PerceptionError`.
        """
        raise NotImplementedError


class FakePerceptionAdapter(PerceptionAdapter):
    """Deterministic stdlib-only adapter for tests and offline runs."""

    def perceive(self, frame_ref: Mapping[str, Any],
                 frame: Frame | str | Path | None = None, *,
                 prev: Frame | str | Path | None = None) -> dict[str, Any]:
        width, height = frame_dims(frame_ref)
        _check_frame_arg(frame, name="frame", width=width, height=height)
        _check_frame_arg(prev, name="prev", width=width, height=height)
        vision = {
            "summary": "fake perception: no change",
            "changed_regions": [],
            "elements": [],
        }
        check_vision(vision, width=width, height=height)
        return vision


_REGISTRY: dict[str, Callable[..., PerceptionAdapter]] = {}


def register_perception_adapter(
        name: str, factory: Callable[..., PerceptionAdapter]) -> None:
    """Bind a provider name to its adapter factory.

    The last registration for a name wins so tests can substitute
    fakes; unknown or misconfigured providers are refused at
    selection time, never replaced silently.
    """
    if not isinstance(name, str) or not name:
        _fail("bad_shape", "provider name malformed")
    if not callable(factory):
        _fail("bad_shape", "provider factory is not callable")
    _REGISTRY[name] = factory


def _vcore_factory(*args: Any, **kwargs: Any) -> PerceptionAdapter:
    try:
        from .vcore import VCorePerceptionAdapter
    except ImportError as exc:
        raise PerceptionError(
            "unavailable",
            "perception provider 'vcore' is not installed") from exc
    return VCorePerceptionAdapter(*args, **kwargs)


def _meta_muse_factory(*args: Any, **kwargs: Any) -> PerceptionAdapter:
    try:
        from .meta_muse import MetaMusePerceptionAdapter
    except ImportError as exc:
        raise PerceptionError(
            "unavailable",
            "perception provider 'meta_muse' is not installed") from exc
    return MetaMusePerceptionAdapter(*args, **kwargs)


register_perception_adapter("fake", FakePerceptionAdapter)
register_perception_adapter("vcore", _vcore_factory)
register_perception_adapter("meta_muse", _meta_muse_factory)


def available_perception_adapters() -> tuple[str, ...]:
    """Return the registered provider names in sorted order."""
    return tuple(sorted(_REGISTRY))


def create_perception_adapter(name: str, *args: Any,
                              **kwargs: Any) -> PerceptionAdapter:
    """Build the named provider's adapter without silent fallback.

    Unknown names are refused with ``unavailable``; factory errors
    propagate unchanged so misconfiguration is never hidden.
    """
    if not isinstance(name, str) or name not in _REGISTRY:
        _fail("unavailable", "unknown perception provider %r" % (name,))
    assert isinstance(name, str)
    return _REGISTRY[name](*args, **kwargs)
