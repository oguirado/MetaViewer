"""Local vision-engine subprocess perception adapter (RAM-only).

Maps C2 ``vadapt.cu_describe`` output (schema ``ve.cu_describe/v1``)
and the ``vcore`` CLI output (``vqa.*`` family) onto the closed
``vision`` object validated by :func:`base.check_vision`. Frame pixels
travel as anonymous memfd descriptors (``/proc/self/fd/N``), marks stay
under ``/dev/shm/vqa-cu``, and children inherit a scrubbed environment.
Never imports ``vision-engine`` or ``wender``: the engine is driven
only through its CLI over an explicit checkout.

[TARGET, unit decision] The projection is the plan's minimal visual table:
schema/frame_sha256/width/height/elements, with bbox/role/name/score_ppm rows.
It is visual evidence, not Wender's richer fused/actionable table. Scores use
nearest-integer ppm (ties to even), matching the local vision boundary.
TODO [TARGET, unit decision]: S1 supplies resolve_locked_component(name);
verified selection requires its environment-selected checkout to match ve_root.
"""

from __future__ import annotations

import json
import math
import os
import struct
import subprocess
import zlib
from collections.abc import Mapping
from contextlib import ExitStack
from pathlib import Path
from typing import Any

from .base import (
    Frame,
    PerceptionAdapter,
    PerceptionError,
    check_vision,
    frame_dims,
)

__all__ = [
    "VCorePerceptionAdapter",
    "C2_SCHEMA",
    "VQA_SCHEMAS",
    "VCORE_VERBS",
    "MAX_MARKS",
    "project_element_table",
]

C2_SCHEMA = "ve.cu_describe/v1"

# Live ticks use C2; the vcore verbs serve offline QA only.
VCORE_VERBS = frozenset((
    "selftest",
    "analyze",
    "pack",
    "cite-check",
    "verify-citations",
    "rejudge",
))

# Known engine output contracts; anything else is a foreign version.
VQA_SCHEMAS = frozenset((
    "vqa.element-table/v1",
    "ve.cu_describe/v1",
    "vqa.vision/v1",
    "vqa.frame/v1",
    "vqa.tile/v1",
    "vqa.core-region/v1",
    "vqa.core-frame/v1",
    "vqa.core-link/v1",
    "vqa.gop/v1",
    "vqa.pack/v2",
    "vqa.judge-input/v2",
    "vqa.judge-output/v2",
    "vqa.cite-verdict/v1",
    "vqa.eval-row/v1",
    "vqa.episode/v1",
    "vqa.profile/v1",
    "vqa.region-hint/v1",
    "vqa.px-mutant/v1",
    "vqa.mutant-manifest/v3",
    "vmem.answer/v1",
    "vmem.catalogue/v1",
    "vmem.manifest/v1",
    "vmem.unit/v1",
))

_FRAME_REF_SCHEMAS = frozenset(("frame_ref/v0.1", "frame_ref/v0.2"))
_MARK_KINDS = frozenset((
    "button", "tab", "field", "row", "icon", "text", "unknown",
))
_CROP_REASONS = frozenset(("changed", "salient"))

MAX_MARKS = 24
_MAX_REGIONS = 16
_MAX_CROPS = 8

_MARKS_ROOT = "/dev/shm/vqa-cu"
_SHM_ROOT = "/dev/shm"
_PROC_FD_PREFIX = "/proc/self/fd/"
_RAMWS_PREFIX = "/dev/shm/"
_NUL = chr(0)
_HEXDIGITS = frozenset("0123456789abcdef")
_STDERR_CAP = 1000


def _fail(code: str, message: str) -> None:
    raise PerceptionError(code, message)


def _is_int(value: object) -> bool:
    # type() is exact: bool must never pass as an integer.
    return type(value) is int


def _check_int(value: object, *, minimum: int, name: str) -> int:
    if not _is_int(value):
        _fail("bad_shape", "%s is not an integer" % name)
    assert isinstance(value, int)
    if value < minimum:
        _fail("bad_shape", "%s below minimum" % name)
    return value


def _check_unit_ratio(value: object, *, name: str) -> int | float:
    if type(value) is bool or not isinstance(value, (int, float)):
        _fail("bad_shape", "%s is not a number" % name)
    assert isinstance(value, (int, float))
    if not math.isfinite(value) or value < 0 or value > 1:
        _fail("bad_shape", "%s outside [0.0, 1.0]" % name)
    return value


def _check_box(row: object, *, width: int, height: int, name: str) -> None:
    if not isinstance(row, dict):
        _fail("bad_shape", "%s is not an object" % name)
    assert isinstance(row, dict)
    try:
        x = row["x"]
        y = row["y"]
        w = row["w"]
        h = row["h"]
    except KeyError:
        _fail("bad_shape", "%s misses a coordinate" % name)
        raise AssertionError("unreachable")
    _check_int(x, minimum=0, name=name + ".x")
    _check_int(y, minimum=0, name=name + ".y")
    _check_int(w, minimum=1, name=name + ".w")
    _check_int(h, minimum=1, name=name + ".h")
    assert _is_int(x) and _is_int(y) and _is_int(w) and _is_int(h)
    if x + w > width or y + h > height:
        _fail("bad_shape", "%s escapes the frame" % name)


def _check_hex64(value: object, *, name: str) -> None:
    if (not isinstance(value, str) or len(value) != 64
            or any(char not in _HEXDIGITS for char in value)):
        _fail("bad_shape", "%s is not 64 lowercase hex" % name)


def _png_bytes(frame: Frame) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data)))

    stride = frame.width * 3
    raw = b"".join(b"\x00" + frame.data[i:i + stride]
                   for i in range(0, len(frame.data), stride))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", frame.width,
                                        frame.height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _resolve_ve_root(ve_root: str | Path | None, *,
                     verify_lock: bool = False) -> Path:
    if type(verify_lock) is not bool:
        _fail("bad_shape", "verify_lock must be a boolean")
    raw = ve_root if ve_root is not None else os.environ.get("VQA_VE_ROOT")
    if raw is None or (isinstance(raw, str) and not raw):
        _fail("unavailable", "ve_root or VQA_VE_ROOT is required")
    assert raw is not None
    try:
        root = Path(raw).resolve()
    except OSError:
        _fail("unavailable", "vision-engine checkout is not a directory")
        raise AssertionError("unreachable")
    if not root.is_dir():
        _fail("unavailable", "vision-engine checkout is not a directory")
    if verify_lock:
        try:
            from .deps_lock import resolve_locked_component
        except ImportError as exc:
            raise PerceptionError("unavailable", "dependency resolver unavailable") from exc
        locked_root = Path(resolve_locked_component("vision-engine")).resolve()
        if locked_root != root:
            _fail("commit_mismatch", "verified checkout differs from ve_root")
    return root


def _scrubbed_env(ve_root: Path) -> dict[str, str]:
    # Children get a minimal environment so in-memory credentials held
    # by the parent process are never inherited across the spawn.
    env: dict[str, str] = {}
    for key in ("PATH", "HOME", "LANG"):
        value = os.environ.get(key)
        if value is not None:
            env[key] = value
    env["PYTHONPATH"] = str(ve_root)
    return env


def _ram_marks_path(value: object) -> Path:
    if isinstance(value, Path):
        candidate: str | Path = value
    elif isinstance(value, str) and value:
        candidate = value
    else:
        _fail("bad_shape", "marks path malformed")
        raise AssertionError("unreachable")
    try:
        destination = Path(candidate).resolve()
    except OSError:
        _fail("bad_shape", "marks path malformed")
        raise AssertionError("unreachable")
    if not destination.is_relative_to(_MARKS_ROOT):
        _fail("bad_shape", "marks path must stay under /dev/shm/vqa-cu")
    return destination


def _bound_dims(frame_ref: Mapping[str, Any]) -> tuple[int, int]:
    if not isinstance(frame_ref, Mapping):
        _fail("bad_shape", "frame_ref is not an object")
    assert isinstance(frame_ref, Mapping)
    if "schema" in frame_ref:
        schema = frame_ref["schema"]
        if schema not in _FRAME_REF_SCHEMAS:
            if isinstance(schema, str) and schema:
                _fail("unknown_version", "unknown frame_ref version")
            _fail("bad_shape", "frame_ref schema malformed")
    return frame_dims(frame_ref)


def _check_frame_arg(value: object, *, name: str,
                     width: int, height: int) -> None:
    if value is None:
        return
    if isinstance(value, Frame):
        Frame.__post_init__(value)
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


def _fd_path(value: str) -> str | None:
    # /proc/self/fd/N paths are validated lexically: resolving them
    # would escape the descriptor to its target.
    if not value.startswith(_PROC_FD_PREFIX):
        return None
    rest = value[len(_PROC_FD_PREFIX):]
    if not rest.isdigit():
        _fail("bad_shape", "frame descriptor path malformed")
    return value


def _existing_frame_path(value: str | Path) -> str:
    if isinstance(value, str):
        direct = _fd_path(value)
        if direct is not None:
            return direct
    try:
        resolved = Path(value).resolve()
    except OSError:
        _fail("bad_shape", "frame path malformed")
        raise AssertionError("unreachable")
    if not resolved.is_relative_to(_SHM_ROOT):
        _fail("bad_shape", "frame path leaves shared memory")
    return str(resolved)


def _ramws_frame(frame_ref: Mapping[str, Any],
                 width: int, height: int) -> Frame:
    # A missing frame falls back to the bound ramws bytes; the digest
    # is never verified here because freshness stays with the core.
    raw_path = frame_ref.get("ramws_path")
    if (not isinstance(raw_path, str) or not raw_path.startswith(_RAMWS_PREFIX)
            or len(raw_path) <= len(_RAMWS_PREFIX) or _NUL in raw_path):
        _fail("bad_shape", "ramws_path leaves shared memory")
    assert isinstance(raw_path, str)
    try:
        data = Path(raw_path).read_bytes()
    except OSError as exc:
        raise PerceptionError(
            "unavailable", "bound ramws bytes are not readable") from exc
    expected = width * height * 3
    if len(data) != expected:
        _fail("bad_shape", "ramws bytes disagree with frame_ref dimensions")
    return Frame(width=width, height=height, data=data)


def _parse_json_object(stdout: bytes, *, what: str) -> dict[str, Any]:
    try:
        payload = json.loads(stdout)
    except (ValueError, TypeError) as exc:
        raise PerceptionError(
            "bad_shape", "%s response is not JSON" % what) from exc
    if not isinstance(payload, dict):
        _fail("bad_shape", "%s response is not an object" % what)
    assert isinstance(payload, dict)
    return payload


def _parse_c2_payload(stdout: bytes, *, width: int, height: int,
                      prev_given: bool, marks_out: Path | None,
                      ocr_requested: bool) -> dict[str, Any]:
    try:
        payload = _parse_json_object(stdout, what="C2")
    except PerceptionError:
        raise
    if "schema" not in payload:
        _fail("bad_shape", "C2 response has no schema")
    schema = payload["schema"]
    if schema != C2_SCHEMA:
        if isinstance(schema, str) and schema:
            _fail("unknown_version", "unknown C2 schema version")
        _fail("bad_shape", "C2 schema malformed")
    _check_hex64(payload.get("frame_sha256"), name="C2 frame_sha256")
    _check_int(payload.get("width"), minimum=1, name="C2 width")
    _check_int(payload.get("height"), minimum=1, name="C2 height")
    if (payload["width"], payload["height"]) != (width, height):
        _fail("bad_shape", "C2 frame dimensions disagree with input")
    changed = payload.get("changed")
    if changed is not None and type(changed) is not bool:
        _fail("bad_shape", "C2 changed flag malformed")
    if (changed is None) != (not prev_given):
        _fail("bad_shape", "C2 changed flag disagrees with --prev")
    regions = payload.get("changed_regions")
    if not isinstance(regions, list) or len(regions) > _MAX_REGIONS:
        _fail("bad_shape", "C2 changed regions malformed")
    assert isinstance(regions, list)
    scores: list[float] = []
    for index, region in enumerate(regions):
        name = "C2 changed_regions[%d]" % index
        _check_box(region, width=width, height=height, name=name)
        assert isinstance(region, dict)
        score = _check_unit_ratio(region.get("score"), name=name + ".score")
        scores.append(float(score))
    if any(a < b for a, b in zip(scores, scores[1:])):
        _fail("bad_shape", "C2 regions out of score order")
    crops = payload.get("crops")
    if not isinstance(crops, list) or len(crops) > _MAX_CROPS:
        _fail("bad_shape", "C2 crops malformed")
    assert isinstance(crops, list)
    for index, crop in enumerate(crops):
        name = "C2 crops[%d]" % index
        _check_box(crop, width=width, height=height, name=name)
        assert isinstance(crop, dict)
        if crop.get("reason") not in _CROP_REASONS:
            _fail("bad_shape", name + " reason unknown")
    marks: list[dict[str, Any]] = []
    marks_png: str | None = None
    if ocr_requested or "marks" in payload or "marks_png" in payload:
        candidates = payload.get("marks")
        marks_png = payload.get("marks_png")
        if not isinstance(candidates, list) or len(candidates) > MAX_MARKS:
            _fail("bad_shape", "C2 marks malformed")
        if not isinstance(marks_png, str):
            _fail("bad_shape", "C2 marks_png malformed")
        assert isinstance(candidates, list)
        assert isinstance(marks_png, str)
        marks_png_path = _ram_marks_path(marks_png)
        if marks_out is not None and marks_png_path != marks_out:
            _fail("bad_shape", "C2 marks output disagrees with --marks-out")
        for position, candidate in enumerate(candidates, 1):
            name = "C2 marks[%d]" % position
            if not isinstance(candidate, dict):
                _fail("bad_shape", "%s is not an object" % name)
            if candidate.get("id") != position:
                _fail("bad_shape", "%s id is not sequential" % name)
            _check_box(candidate, width=width, height=height, name=name)
            if candidate.get("kind") not in _MARK_KINDS:
                _fail("bad_shape", name + " kind unknown")
            _check_unit_ratio(candidate.get("score"), name=name + ".score")
            ocr_text = candidate.get("ocr_text")
            if ocr_text is not None:
                if (not isinstance(ocr_text, str) or not ocr_text
                        or len(ocr_text.encode("utf-8")) > 64):
                    _fail("bad_shape", name + " ocr_text malformed")
            marks.append(candidate)
    _check_int(payload.get("timing_us"), minimum=0, name="C2 timing_us")
    if "mark_cap_reached" in payload:
        if type(payload["mark_cap_reached"]) is not bool:
            _fail("bad_shape", "C2 mark_cap_reached malformed")
        cap_reached = payload["mark_cap_reached"]
    else:
        # The engine does not emit the cap flag; the caller derives it.
        cap_reached = len(marks) == MAX_MARKS
    return {
        "changed": changed,
        "regions": regions,
        "crops": crops,
        "marks": marks,
        "timing_us": payload["timing_us"],
        "mark_cap_reached": bool(cap_reached),
    }


def _vision_from_c2(parsed: dict[str, Any],
                    width: int, height: int) -> dict[str, Any]:
    regions = [
        {"x": region["x"], "y": region["y"],
         "w": region["w"], "h": region["h"]}
        for region in parsed["regions"]
    ]
    elements: list[dict[str, Any]] = []
    if parsed["marks"]:
        for mark in parsed["marks"]:
            elements.append({
                "bbox": {"x": mark["x"], "y": mark["y"],
                         "w": mark["w"], "h": mark["h"]},
                "role": mark["kind"],
                "name": mark.get("ocr_text") or "mark-%d" % mark["id"],
                "confidence": mark["score"],
            })
    else:
        # Without marks, crops are the only element-localization path.
        for crop in parsed["crops"]:
            elements.append({
                "bbox": {"x": crop["x"], "y": crop["y"],
                         "w": crop["w"], "h": crop["h"]},
                "role": "crop",
                "name": crop["reason"],
                "confidence": 0.5,
            })
    summary = ("C2 %s %dx%d changed=%s regions=%d marks=%d crops=%d "
               "mark_cap_reached=%s timing_us=%d"
               % (C2_SCHEMA, width, height, parsed["changed"],
                  len(regions), len(parsed["marks"]), len(parsed["crops"]),
                  parsed["mark_cap_reached"], parsed["timing_us"]))
    return {"summary": summary,
            "changed_regions": regions, "elements": elements}


def project_element_table(frame_ref: Mapping[str, Any],
                          vision_or_c2: dict[str, Any]) -> dict[str, Any]:
    """Project validated vision or a raw C2 response into integer-only evidence.

    Raw C2 evidence must carry the same RGB24 digest as the caller's frame_ref.
    Normalized vision relies on the caller's existing frame binding.
    """
    width, height = _bound_dims(frame_ref)
    _check_hex64(frame_ref.get("sha256"), name="frame_ref.sha256")
    if not isinstance(vision_or_c2, dict):
        _fail("bad_shape", "vision or C2 must be an object")
    vision = vision_or_c2
    if "schema" in vision_or_c2:
        parsed = _parse_c2_payload(
            json.dumps(vision_or_c2).encode("utf-8"), width=width, height=height,
            prev_given=vision_or_c2.get("changed") is not None,
            marks_out=None, ocr_requested=False)
        if vision_or_c2["frame_sha256"] != frame_ref["sha256"]:
            _fail("identity_mismatch", "C2 digest disagrees with frame_ref")
        vision = _vision_from_c2(parsed, width, height)
    check_vision(vision, width=width, height=height)
    return {
        "schema": "vqa.element-table/v1",
        "frame_sha256": frame_ref["sha256"],
        "width": width,
        "height": height,
        "elements": [
            {"bbox": dict(element["bbox"]), "role": element["role"],
             "name": element["name"],
             "score_ppm": round(element["confidence"] * 1_000_000)}
            for element in vision["elements"]
        ],
    }


class VCorePerceptionAdapter(PerceptionAdapter):
    """Subprocess adapter over the pinned vision-engine checkout.

    Live ticks shell C2 (``vadapt.cu_describe``); :meth:`run_vcore`
    covers the ``vcore`` verbs for offline QA. ``last_mark_cap_reached``
    records whether the most recent tick hit the 24-mark cap, since the
    closed ``vision`` object has no room for the flag itself.
    """

    def __init__(self, ve_root: str | Path | None = None, *,
                 timeout: float = 2.0,
                 python: str = "python3",
                 marks_out: str | Path | None = None,
                 ocr_marks: bool = False,
                 verify_lock: bool = False) -> None:
        if (isinstance(timeout, bool)
                or not isinstance(timeout, (int, float))
                or not math.isfinite(timeout) or timeout <= 0):
            _fail("bad_shape", "timeout must be positive and finite")
        if not isinstance(python, str) or not python:
            _fail("bad_shape", "python interpreter malformed")
        if type(ocr_marks) is not bool:
            _fail("bad_shape", "ocr_marks must be a boolean")
        if ocr_marks and marks_out is None:
            _fail("bad_shape", "OCR requires a RAM marks output")
        self.ve_root = _resolve_ve_root(ve_root, verify_lock=verify_lock)
        self.timeout = timeout
        self.python = python
        self.marks_out = (_ram_marks_path(marks_out)
                          if marks_out is not None else None)
        self.ocr_marks = ocr_marks
        self.last_mark_cap_reached = False
        self.last_timing_us: int | None = None

    def perceive(self, frame_ref: Mapping[str, Any],
                 frame: Frame | str | Path | None = None, *,
                 prev: Frame | str | Path | None = None) -> dict[str, Any]:
        width, height = _bound_dims(frame_ref)
        _check_frame_arg(frame, name="frame", width=width, height=height)
        _check_frame_arg(prev, name="prev", width=width, height=height)
        if frame is None:
            frame = _ramws_frame(frame_ref, width, height)
        env = _scrubbed_env(self.ve_root)
        with ExitStack() as stack:
            fds: list[int] = []

            def png_path(value: Frame | str | Path) -> str:
                if not isinstance(value, Frame):
                    return _existing_frame_path(value)
                try:
                    fd = os.memfd_create("metaviewer-vcore-frame",
                                         os.MFD_CLOEXEC)
                except (AttributeError, OSError) as exc:
                    raise PerceptionError(
                        "unavailable",
                        "RAM frame allocation failed") from exc
                fds.append(fd)
                stream = stack.enter_context(os.fdopen(fd, "wb"))
                stream.write(_png_bytes(value))
                stream.flush()
                stream.seek(0)
                return "%s%d" % (_PROC_FD_PREFIX, fd)

            assert isinstance(frame, (Frame, str, Path))
            command = [self.python, "-m", "vadapt.cu_describe",
                       "--frame", png_path(frame)]
            if prev is not None:
                assert isinstance(prev, (Frame, str, Path))
                command += ["--prev", png_path(prev)]
            if self.marks_out is not None:
                command += ["--marks-out", str(self.marks_out)]
            if self.ocr_marks:
                command.append("--ocr-marks")
            command.append("--json")
            try:
                result = subprocess.run(
                    command, cwd=str(self.ve_root), env=env,
                    capture_output=True, stdin=subprocess.DEVNULL,
                    timeout=self.timeout, pass_fds=tuple(fds))
            except subprocess.TimeoutExpired as exc:
                raise PerceptionError(
                    "timeout", "C2 subprocess timed out") from exc
            except OSError as exc:
                raise PerceptionError(
                    "unavailable",
                    "C2 subprocess could not execute") from exc
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8",
                                          errors="replace")[:_STDERR_CAP]
            if result.returncode == 2:
                raise PerceptionError(
                    "bad_shape", "C2 subprocess refused: %s" % detail)
            raise PerceptionError(
                "bad_shape", "C2 subprocess exited with code %d: %s"
                % (result.returncode, detail))
        parsed = _parse_c2_payload(
            result.stdout, width=width, height=height,
            prev_given=prev is not None, marks_out=self.marks_out,
            ocr_requested=self.ocr_marks)
        self.last_mark_cap_reached = parsed["mark_cap_reached"]
        self.last_timing_us = parsed["timing_us"]
        vision = _vision_from_c2(parsed, width, height)
        check_vision(vision, width=width, height=height)
        return vision

    def run_vcore(self, verb: str,
                  args: tuple[str, ...] | list[str] = ()) -> dict[str, Any]:
        """Run one ``vcore`` verb and return its JSON object.

        Exit classes map onto typed errors: 2/3 refuse the call, 4 is a
        stale frame, 5 is unavailable, and 6 exhausts the budget; the
        engine never uses exit 1, so it is refused as malformed.
        """
        if verb not in VCORE_VERBS:
            _fail("bad_shape", "unknown vcore verb %r" % (verb,))
        if not isinstance(args, (tuple, list)):
            _fail("bad_shape", "vcore args must be a sequence")
        assert isinstance(args, (tuple, list))
        for index, item in enumerate(args):
            if not isinstance(item, str):
                _fail("bad_shape", "vcore arg[%d] is not a string" % index)
        command = [self.python, "-m", "visioncore.cli", verb, *args]
        try:
            result = subprocess.run(
                command, cwd=str(self.ve_root),
                env=_scrubbed_env(self.ve_root),
                capture_output=True, stdin=subprocess.DEVNULL,
                timeout=self.timeout)
        except subprocess.TimeoutExpired as exc:
            raise PerceptionError(
                "timeout", "vcore subprocess timed out") from exc
        except OSError as exc:
            raise PerceptionError(
                "unavailable", "vcore subprocess could not execute") from exc
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8",
                                          errors="replace")[:_STDERR_CAP]
            if result.returncode in (2, 3):
                raise PerceptionError(
                    "bad_shape", "vcore refused (rc=%d): %s"
                    % (result.returncode, detail))
            if result.returncode == 4:
                raise PerceptionError("STALE_FRAME",
                                      "vcore reported stale input")
            if result.returncode == 5:
                raise PerceptionError(
                    "unavailable", "vcore gate failed: %s" % detail)
            if result.returncode == 6:
                raise PerceptionError("BUDGET_EXCEEDED",
                                      "vcore reported budget exhausted")
            raise PerceptionError(
                "bad_shape", "vcore exited with code %d: %s"
                % (result.returncode, detail))
        payload = _parse_json_object(result.stdout, what="vcore")
        if "schema" in payload:
            schema = payload["schema"]
            if schema not in VQA_SCHEMAS:
                if isinstance(schema, str) and schema:
                    _fail("unknown_version", "unknown vqa schema version")
                _fail("bad_shape", "vqa schema malformed")
        if "rc" in payload and payload["rc"] != result.returncode:
            _fail("bad_shape", "vcore rc disagrees with exit code")
        return payload
