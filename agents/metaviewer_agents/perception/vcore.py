"""Local vision-engine subprocess perception adapter (RAM-only).

Maps C2 ``vadapt.cu_describe`` and persistent ``vadapt.vserve`` output
(schemas ``ve.cu_describe/v1``, ``ve.vserve.reply/v1``, ``ve.vserve.hello/v1``)
and the ``vcore`` CLI output (``vqa.*`` family) onto the closed
``vision`` object validated by :func:`base.check_vision`. When the
checkout provides ``vadapt/vserve.py``, live ticks use the persistent
JSON-lines server with raw RGB24 frames in ``/dev/shm``; otherwise (or
on persistent failure) they fall back to one-shot ``vadapt.cu_describe``
with anonymous memfd descriptors (``/proc/self/fd/N``). Marks stay
under ``/dev/shm/vqa-cu``, and children inherit a scrubbed environment.
Never imports ``vision-engine`` or ``wender``: the engine is driven
only through its CLI over an explicit checkout.

[TARGET, unit decision] The projection is the plan's minimal visual table:
schema/frame_sha256/width/height/elements, with bbox/role/name/score_ppm rows.
It is visual evidence, not Wender's richer fused/actionable table. Scores use
nearest-integer ppm (ties to even), matching the local vision boundary.
Optional lock verification requires the environment-selected checkout to match
ve_root and maps resolver failures to typed perception errors.
[TARGET, unit decision] Persistent vserve client lifecycle: lazy spawn with a
pinned numpy>=2.0.0 interpreter, affirmative ve.vserve.hello/v1 caps handshake,
bounded in-flight request queue (cap 1..4, abort backpressure policy),
restart-once on crash, per-frame latency reporting, and one-shot fallback
preserving typed error codes.
"""

from __future__ import annotations

import atexit
import errno
import hashlib
import json
import math
import os
import re
import selectors
import stat
import struct
import subprocess
import sys
import tempfile
import time
import weakref
import zlib
from collections.abc import Mapping, Sequence
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Any

from .deps_lock import DependencyLockError
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
    "VSERVE_REPLY_SCHEMA",
    "VSERVE_HELLO_SCHEMA",
    "VQA_SCHEMAS",
    "VCORE_VERBS",
    "MAX_MARKS",
    "project_element_table",
    "_resolve_pinned_python",
    "_parse_vserve_reply",
]

C2_SCHEMA = "ve.cu_describe/v1"
VSERVE_REPLY_SCHEMA = "ve.vserve.reply/v1"
VSERVE_HELLO_SCHEMA = "ve.vserve.hello/v1"

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
_STDOUT_CAP = 1024 * 1024
_STDERR_RAW_CAP = 1024 * 1024
_VSERVE_MAX_CONTROL_BYTES = 65536
_VSERVE_MAX_FRAME_BYTES = 33554432
_VSERVE_MAX_SESSIONS = 16
_VSERVE_REPLY_KEYS = frozenset((
    "code", "detail", "ok", "op", "rc", "request_id", "result", "schema",
))
_VSERVE_VALID_RCS = frozenset((0, 2, 3, 4, 5, 6))
_STDLIB_RUN = subprocess.run


def _fail(code: str, message: str) -> None:
    raise PerceptionError(code, message)


def _is_int(value: object) -> bool:
    # type() is exact: bool must never pass as an integer.
    return type(value) is int


def _check_int(
    value: object,
    *,
    minimum: int,
    maximum: int | None = None,
    name: str,
) -> int:
    if not _is_int(value):
        _fail("bad_shape", "%s is not an integer" % name)
    assert isinstance(value, int)
    if value < minimum:
        _fail("bad_shape", "%s below minimum" % name)
    if maximum is not None and value > maximum:
        _fail("bad_shape", "%s above maximum" % name)
    return value


def _check_unit_ratio(value: object, *, name: str) -> int | float:
    if type(value) is bool or not isinstance(value, (int, float)):
        _fail("bad_shape", "%s is not a number" % name)
    assert isinstance(value, (int, float))
    try:
        finite = math.isfinite(value)
    except OverflowError:
        _fail("bad_shape", "%s outside [0.0, 1.0]" % name)
        raise AssertionError("unreachable")
    if not finite or value < 0 or value > 1:
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
    if not isinstance(raw, (str, Path)):
        _fail("unavailable", "vision-engine checkout is not a path")
    try:
        root = Path(raw).resolve()
        if not root.is_dir():
            _fail("unavailable", "vision-engine checkout is not a directory")
    except (OSError, ValueError, RuntimeError):
        _fail("unavailable", "vision-engine checkout is not a directory")
        raise AssertionError("unreachable")
    if verify_lock:
        try:
            from .deps_lock import resolve_locked_component
        except ImportError as exc:
            raise PerceptionError("unavailable", "dependency resolver unavailable") from exc
        try:
            locked = resolve_locked_component("vision-engine")
        except DependencyLockError as exc:
            raise PerceptionError(exc.code, str(exc)) from exc
        if not isinstance(locked, (str, Path)):
            _fail("unavailable", "dependency resolver returned no checkout")
        try:
            locked_root = Path(locked).resolve()
            if not locked_root.is_dir():
                _fail("unavailable", "verified checkout is not a directory")
        except (OSError, ValueError, RuntimeError) as exc:
            raise PerceptionError("unavailable", "verified checkout is not a directory") from exc
        if locked_root != root:
            _fail("commit_mismatch", "verified checkout differs from ve_root")
    return root


def _check_pythonpath_root(ve_root: Path) -> None:
    try:
        entries = list(os.scandir(ve_root))
    except OSError as exc:
        raise PerceptionError(
            "unavailable", "vision-engine checkout is not readable") from exc
    for entry in entries:
        lowered = entry.name.lower()
        if (lowered in ("sitecustomize.py", "usercustomize.py")
                or lowered.startswith(("sitecustomize.", "usercustomize."))
                or lowered.endswith(".pth")):
            _fail("dirty_tree",
                  "vision-engine root contains forbidden startup hook")


def _scrubbed_env(ve_root: Path) -> dict[str, str]:
    # Children get a minimal environment so in-memory credentials held
    # by the parent process are never inherited across the spawn.
    _check_pythonpath_root(ve_root)
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
    except (OSError, ValueError):
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
    except (OSError, ValueError):
        _fail("bad_shape", "frame path malformed")
        raise AssertionError("unreachable")
    if not resolved.is_relative_to(_SHM_ROOT):
        _fail("bad_shape", "frame path leaves shared memory")
    return str(resolved)


def _ramws_frame(frame_ref: Mapping[str, Any],
                 width: int, height: int, *, deadline: float | None = None) -> Frame:
    # A missing frame loads regular RAM bytes; perceive() binds their digest
    # to frame_ref before launching C2.
    raw_path = frame_ref.get("ramws_path")
    if (not isinstance(raw_path, str) or not raw_path.startswith(_RAMWS_PREFIX)
            or len(raw_path) <= len(_RAMWS_PREFIX) or _NUL in raw_path):
        _fail("bad_shape", "ramws_path leaves shared memory")
    assert isinstance(raw_path, str)
    candidate = Path(raw_path)
    try:
        if candidate.is_symlink():
            _fail("bad_shape", "ramws_path leaves shared memory")
        resolved = candidate.resolve()
    except OSError:
        _fail("bad_shape", "ramws_path malformed")
        raise AssertionError("unreachable")
    if (
        not resolved.is_relative_to(_SHM_ROOT)
        or resolved == Path(_SHM_ROOT)
        or resolved != candidate
    ):
        _fail("bad_shape", "ramws_path leaves shared memory")
    expected = width * height * 3
    flags = (
        os.O_RDONLY | os.O_NONBLOCK
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
    )
    try:
        fd = os.open(str(resolved), flags)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            _fail("bad_shape", "ramws_path leaves shared memory")
        raise PerceptionError(
            "unavailable", "bound ramws bytes are not readable") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size != expected:
            _fail("bad_shape", "ramws descriptor is not a regular RGB24 file")
        chunks: list[bytes] = []
        remaining = expected + 1
        while remaining > 0:
            if deadline is not None and time.monotonic() >= deadline:
                _fail("timeout", "RAM acquisition timed out")
            chunk = os.read(fd, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
    except OSError as exc:
        raise PerceptionError(
            "unavailable", "bound ramws bytes are not readable") from exc
    finally:
        os.close(fd)
    if len(data) != expected:
        _fail("bad_shape", "ramws bytes disagree with frame_ref dimensions")
    return Frame(width=width, height=height, data=data)


def _parse_json_object(stdout: bytes, *, what: str) -> dict[str, Any]:
    try:
        payload = json.loads(stdout)
    except (ValueError, TypeError, RecursionError) as exc:
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
        if not isinstance(crop.get("reason"), str) or crop["reason"] not in _CROP_REASONS:
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
            if not isinstance(candidate.get("kind"), str) or candidate["kind"] not in _MARK_KINDS:
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
        "frame_sha256": payload["frame_sha256"],
        "changed": changed,
        "regions": regions,
        "crops": crops,
        "marks": marks,
        "timing_us": payload["timing_us"],
        "mark_cap_reached": bool(cap_reached),
    }


# [TARGET, unit decision] Closed vision JSON retains provenance only in-process.
class _BoundVision(dict):
    def __init__(self, vision: dict[str, Any], frame_sha256: str):
        super().__init__(vision)
        self.frame_sha256 = frame_sha256


def _validate_timeout(timeout: float) -> None:
    try:
        valid = (not isinstance(timeout, bool) and isinstance(timeout, (int, float))
                 and math.isfinite(timeout) and 0 < timeout <= 60)
    except OverflowError:
        valid = False
    if not valid:
        _fail("bad_shape", "timeout must be positive and at most 60 seconds")


def _remaining_timeout(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        _fail("timeout", "perception deadline exhausted")
    return remaining


def _run_bounded(
    command: list[str],
    *,
    cwd: str,
    env: dict[str, str],
    stdin: int,
    timeout: float,
    pass_fds: tuple[int, ...] = (),
) -> subprocess.CompletedProcess[bytes]:
    _validate_timeout(timeout)
    if any(not isinstance(arg, str) or _NUL in arg for arg in command):
        _fail("bad_shape", "subprocess argv malformed")
    if subprocess.run is not _STDLIB_RUN:
        if pass_fds:
            return subprocess.run(
                command, cwd=cwd, env=env, capture_output=True,
                stdin=stdin, timeout=timeout, pass_fds=pass_fds)
        return subprocess.run(
            command, cwd=cwd, env=env, capture_output=True,
            stdin=stdin, timeout=timeout)
    deadline = time.monotonic() + timeout
    proc = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        pass_fds=pass_fds,
    )
    assert proc.stdout is not None and proc.stderr is not None
    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []
    stdout_len = 0
    stderr_len = 0
    try:
        with selectors.DefaultSelector() as sel:
            os.set_blocking(proc.stdout.fileno(), False)
            os.set_blocking(proc.stderr.fileno(), False)
            sel.register(proc.stdout, selectors.EVENT_READ, "stdout")
            sel.register(proc.stderr, selectors.EVENT_READ, "stderr")
            while sel.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    proc.kill()
                    proc.wait()
                    raise subprocess.TimeoutExpired(command, timeout)
                events = sel.select(timeout=remaining)
                if not events:
                    proc.kill()
                    proc.wait()
                    raise subprocess.TimeoutExpired(command, timeout)
                for key, _ in events:
                    stream = key.fileobj
                    chunk = os.read(stream.fileno(), 65536)  # type: ignore[union-attr]
                    if not chunk:
                        sel.unregister(stream)
                        continue
                    if key.data == "stdout":
                        stdout_len += len(chunk)
                        if stdout_len > _STDOUT_CAP:
                            proc.kill()
                            proc.wait()
                            _fail("bad_shape", "subprocess output exceeds maximum size")
                        stdout_chunks.append(chunk)
                    else:
                        stderr_len += len(chunk)
                        if stderr_len > _STDERR_RAW_CAP:
                            proc.kill()
                            proc.wait()
                            _fail("bad_shape", "subprocess output exceeds maximum size")
                        stderr_chunks.append(chunk)
        remaining = max(0.0, deadline - time.monotonic())
        try:
            proc.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            raise
    finally:
        proc.stdout.close()
        proc.stderr.close()
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    return subprocess.CompletedProcess(
        command,
        proc.returncode,
        b"".join(stdout_chunks),
        b"".join(stderr_chunks),
    )


_bounded_probe = _run_bounded


def _parse_numpy_version(raw: object) -> tuple[int, int, int] | None:
    if not isinstance(raw, str) or not raw or _NUL in raw:
        return None
    match = re.match(r"^\s*(\d+)\.(\d+)(?:\.(\d+))?", raw)
    if match is None:
        return None
    major = int(match.group(1))
    minor = int(match.group(2))
    patch = int(match.group(3) or "0")
    return (major, minor, patch)


def _resolve_pinned_python(
    python: str = "python3",
    *,
    ve_root: Path | str | None = None,
    timeout: float = 2.0,
    candidates: Sequence[str] | None = None,
) -> str:
    """Resolve a Python interpreter whose ``import numpy`` resolves ``>=2.0.0``.

    Rejects NUL or empty strings with ``bad_shape``, rejects isolated flag
    forms such as ``python3 -I`` (which see only system numpy ``1.26.4``), and
    raises ``unavailable`` when no candidate satisfies ``numpy>=2.0.0``.
    """
    _validate_timeout(timeout)
    if not isinstance(python, str) or not python or _NUL in python:
        _fail("bad_shape", "python interpreter malformed")
    if candidates is not None:
        if not isinstance(candidates, (tuple, list)) or not candidates:
            _fail("bad_shape", "python candidates must be a non-empty sequence")
        ordered: list[str] = []
        for item in candidates:
            if not isinstance(item, str) or not item or _NUL in item:
                _fail("bad_shape", "python candidate malformed")
            if item not in ordered:
                ordered.append(item)
    else:
        ordered = [python]
        if (python in ("python3", "python")
                and isinstance(sys.executable, str)
                and sys.executable
                and _NUL not in sys.executable
                and sys.executable not in ordered):
            ordered.append(sys.executable)

    resolved_root: Path | None = None
    if ve_root is not None:
        resolved_root = Path(ve_root).resolve()
    env = (_scrubbed_env(resolved_root)
           if resolved_root is not None
           else {
               "PATH": os.environ.get("PATH", os.defpath),
               "HOME": "/nonexistent",
               "LANG": "C.UTF-8",
           })
    cwd = str(resolved_root) if resolved_root is not None else "/"
    probe_code = (
        "import json, numpy, sys; "
        " flags = getattr(sys, 'flags', None); "
        " isolated = bool(getattr(flags, 'isolated', 0) or getattr(flags, 'no_user_site', 0)); "
        " print(json.dumps({'version': getattr(numpy, '__version__', ''), 'isolated': isolated}))"
    )
    for candidate in ordered:
        # Reject flag-bearing strings like "python3 -I" or "python3 -s".
        if any(ch.isspace() for ch in candidate):
            continue
        argv = [candidate, "-c", probe_code]
        try:
            proc = _bounded_probe(
                argv, cwd=cwd, env=env,
                stdin=subprocess.DEVNULL, timeout=timeout)
        except (PerceptionError, subprocess.TimeoutExpired, OSError):
            continue
        if proc.returncode != 0:
            continue
        try:
            info = json.loads(proc.stdout.decode("utf-8", errors="strict"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if not isinstance(info, dict):
            continue
        if info.get("isolated") is True:
            continue
        parsed_ver = _parse_numpy_version(info.get("version"))
        if parsed_ver is not None and parsed_ver >= (2, 0, 0):
            return candidate
    _fail("unavailable", "no python interpreter with numpy>=2.0.0 available")
    raise AssertionError("unreachable")


def _parse_vserve_reply(
    raw: bytes | str,
    *,
    expected_id: int | str | None = None,
    expected_op: str | None = None,
) -> dict[str, Any]:
    """Validate and decode one ``ve.vserve.reply/v1`` JSON line."""
    if isinstance(raw, bytes):
        if len(raw) == 0:
            _fail("unavailable", "vserve reply empty (EOF)")
        if len(raw) > _STDOUT_CAP:
            _fail("BUDGET_EXCEEDED", "vserve reply exceeds maximum size")
        try:
            text = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise PerceptionError("bad_shape", "vserve reply is not UTF-8") from exc
    elif isinstance(raw, str):
        if not raw:
            _fail("unavailable", "vserve reply empty (EOF)")
        if len(raw.encode("utf-8")) > _STDOUT_CAP:
            _fail("BUDGET_EXCEEDED", "vserve reply exceeds maximum size")
        text = raw
    else:
        _fail("bad_shape", "vserve reply must be bytes or str")

    text_stripped = text.strip()
    if not text_stripped:
        _fail("bad_shape", "vserve reply blank")
    try:
        payload = json.loads(text_stripped)
    except json.JSONDecodeError as exc:
        raise PerceptionError("bad_shape", "vserve reply is not valid JSON") from exc
    if not isinstance(payload, dict):
        _fail("bad_shape", "vserve reply must be a JSON object")
    if set(payload.keys()) != _VSERVE_REPLY_KEYS:
        _fail("bad_shape", "vserve reply keys do not match ve.vserve.reply/v1")

    schema = payload.get("schema")
    if schema != VSERVE_REPLY_SCHEMA:
        if isinstance(schema, str) and schema:
            _fail("unknown_version", "unknown vserve schema %r" % (schema,))
        _fail("bad_shape", "vserve schema malformed")

    req_id = payload.get("request_id")
    if req_id is None:
        if expected_id is not None and payload.get("ok") is True:
            _fail("bad_shape", "vserve reply missing request_id")
    elif _is_int(req_id):
        if req_id < 1:
            _fail("bad_shape", "vserve request_id must be positive")
    elif isinstance(req_id, str):
        if not req_id or _NUL in req_id:
            _fail("bad_shape", "vserve request_id malformed")
    else:
        _fail("bad_shape", "vserve request_id bad type")

    if expected_id is not None and req_id is not None:
        if type(req_id) is not type(expected_id) or req_id != expected_id:
            _fail("bad_shape", "vserve request_id mismatch")

    op = payload.get("op")
    if not isinstance(op, str) or not op:
        _fail("bad_shape", "vserve op malformed")
    if expected_op is not None and op != expected_op and payload.get("ok") is True:
        _fail("bad_shape", "vserve op mismatch")

    ok = payload.get("ok")
    if type(ok) is not bool:
        _fail("bad_shape", "vserve ok must be a boolean")

    rc = payload.get("rc")
    if not _is_int(rc) or rc not in _VSERVE_VALID_RCS:
        _fail("bad_shape", "vserve rc invalid: %r" % (rc,))

    code = payload.get("code")
    if not isinstance(code, str) or not code:
        _fail("bad_shape", "vserve code malformed")

    detail = payload.get("detail")
    if not isinstance(detail, (dict, str)):
        _fail("bad_shape", "vserve detail must be an object or string")

    result = payload.get("result")
    if ok:
        if (rc != 0 or code != "OK"
                or detail not in ({}, "")
                or not isinstance(result, dict)):
            _fail("bad_shape", "vserve ok reply fields inconsistent")
        if expected_id is not None and req_id is None:
            _fail("bad_shape", "vserve ok reply missing request_id")
        return payload

    if rc == 0 or code == "OK" or result is not None:
        _fail("bad_shape", "vserve error reply fields inconsistent")
    if isinstance(detail, dict):
        reason = detail.get("reason")
        detail_text = (reason if isinstance(reason, str) and reason
                       else json.dumps(detail, sort_keys=True))
    else:
        detail_text = detail
    short_detail = detail_text[:_STDERR_CAP]
    if rc == 4 or code == "E_STALE":
        _fail("STALE_FRAME", short_detail or "vserve reported stale input")
    if rc == 5:
        _fail("unavailable", short_detail or "vserve gate failed")
    if rc == 6 or code == "E_BUDGET":
        _fail("BUDGET_EXCEEDED", short_detail or "vserve reported budget exhausted")
    _fail("bad_shape", short_detail or ("vserve refused (rc=%d)" % rc))
    raise AssertionError("unreachable")


def _validate_hello_result(result: object) -> dict[str, Any]:
    if not isinstance(result, dict):
        _fail("bad_shape", "vserve hello result must be an object")
    schema = result.get("schema")
    if schema != VSERVE_HELLO_SCHEMA:
        if isinstance(schema, str) and schema:
            _fail("unknown_version", "unknown vserve hello schema %r" % (schema,))
        _fail("bad_shape", "vserve hello schema malformed")
    caps = result.get("capabilities")
    if (not isinstance(caps, list)
            or not caps
            or any(not isinstance(item, str) or not item for item in caps)):
        _fail("bad_shape", "vserve capabilities malformed")
    if "describe" not in caps or "frame_raw" not in caps:
        _fail("bad_shape", "vserve missing required capabilities")
    if result.get("raw_shm") is not True or result.get("frame_raw") is not True:
        _fail("bad_shape", "vserve raw_shm/frame_raw capability missing")
    if type(result.get("ring")) is not bool:
        _fail("bad_shape", "vserve ring flag must be boolean")
    max_ctl = _check_int(
        result.get("max_control_line_bytes"),
        minimum=1, maximum=_VSERVE_MAX_CONTROL_BYTES,
        name="vserve max_control_line_bytes")
    max_frm = _check_int(
        result.get("max_frame_bytes"),
        minimum=1, maximum=_VSERVE_MAX_FRAME_BYTES,
        name="vserve max_frame_bytes")
    max_sess = _check_int(
        result.get("max_sessions"),
        minimum=1, maximum=_VSERVE_MAX_SESSIONS,
        name="vserve max_sessions")
    active_sess = _check_int(
        result.get("active_sessions"),
        minimum=0, maximum=max_sess,
        name="vserve active_sessions")
    return {
        "schema": VSERVE_HELLO_SCHEMA,
        "capabilities": list(caps),
        "raw_shm": True,
        "frame_raw": True,
        "ring": bool(result["ring"]),
        "max_control_line_bytes": max_ctl,
        "max_frame_bytes": max_frm,
        "max_sessions": max_sess,
        "active_sessions": active_sess,
    }


def _validate_status_result(result: object) -> dict[str, Any]:
    if not isinstance(result, dict):
        _fail("bad_shape", "vserve status result must be an object")
    max_sess = _check_int(
        result.get("max_sessions"),
        minimum=1, maximum=_VSERVE_MAX_SESSIONS,
        name="vserve status max_sessions")
    active_sess = _check_int(
        result.get("active_sessions"),
        minimum=0, maximum=max_sess,
        name="vserve status active_sessions")
    session_ids = result.get("session_ids")
    if session_ids is None:
        session_ids = result.get("sessions")
    if not isinstance(session_ids, list) or len(session_ids) != active_sess:
        _fail("bad_shape", "vserve status session_ids malformed")
    return {
        "active_sessions": active_sess,
        "max_sessions": max_sess,
        "session_ids": list(session_ids),
    }


class _BoundedRequestQueue:
    """Bounded in-flight request queue with ``abort`` backpressure policy."""

    def __init__(self, capacity: int = 2) -> None:
        self._capacity = _check_int(
            capacity, minimum=1, maximum=4, name="queue_cap")
        self._in_flight = 0
        self.policy = "abort"

    @property
    def capacity(self) -> int:
        return self._capacity

    @property
    def in_flight(self) -> int:
        return self._in_flight

    def __len__(self) -> int:
        return self._in_flight

    def acquire(self) -> None:
        if self._in_flight >= self._capacity:
            _fail(
                "BUDGET_EXCEEDED",
                "vserve request queue capacity (%d) exhausted (policy=abort)"
                % self._capacity,
            )
        self._in_flight += 1

    def release(self) -> None:
        if self._in_flight > 0:
            self._in_flight -= 1

    @contextmanager
    def slot(self):
        self.acquire()
        try:
            yield self._in_flight
        finally:
            self.release()


def _spawn_vserve_proc(
    command: list[str],
    *,
    cwd: str,
    env: dict[str, str],
) -> subprocess.Popen[bytes]:
    if any(not isinstance(arg, str) or _NUL in arg for arg in command):
        _fail("bad_shape", "vserve subprocess argv malformed")
    popen = subprocess.Popen
    return popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def _write_raw_shm_frame(frame: Frame, stack: ExitStack) -> str:
    expected = frame.width * frame.height * 3
    if len(frame.data) != expected:
        _fail("bad_shape", "Frame RGB24 byte length disagrees with dimensions")
    if expected > _VSERVE_MAX_FRAME_BYTES:
        _fail("BUDGET_EXCEEDED", "Frame exceeds vserve max_frame_bytes")
    try:
        fd, path = tempfile.mkstemp(
            prefix="mv-vcore-raw-", suffix=".rgb", dir=_SHM_ROOT)
    except OSError as exc:
        raise PerceptionError(
            "unavailable", "RAM raw frame allocation failed") from exc

    def _cleanup() -> None:
        try:
            os.unlink(path)
        except OSError:
            pass

    stack.callback(_cleanup)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(frame.data)
            stream.flush()
    except OSError as exc:
        raise PerceptionError(
            "unavailable", "RAM raw frame write failed") from exc
    return "%s,%d,%d" % (path, frame.width, frame.height)


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
    Normalized vision must retain the adapter's in-process pixel binding.
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
    if "schema" not in vision_or_c2 and (
            not isinstance(vision, _BoundVision) or vision.frame_sha256 != frame_ref["sha256"]):
        _fail("identity_mismatch", "normalized vision has no matching frame binding")
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


def _close_weak_adapter(ref: weakref.ReferenceType[VCorePerceptionAdapter]) -> None:
    adapter = ref()
    if adapter is not None:
        adapter.close()


class VCorePerceptionAdapter(PerceptionAdapter):
    """Subprocess adapter over the pinned vision-engine checkout.

    Live ticks prefer persistent ``vadapt.vserve`` when present in the
    checkout and fall back to one-shot C2 (``vadapt.cu_describe``);
    :meth:`run_vcore` covers the ``vcore`` verbs for offline QA.
    ``last_mark_cap_reached`` records whether the most recent tick hit
    the 24-mark cap, since the closed ``vision`` object has no room for
    the flag itself.
    """

    def __init__(self, ve_root: str | Path | None = None, *,
                 timeout: float = 2.0,
                 python: str = "python3",
                 marks_out: str | Path | None = None,
                 ocr_marks: bool = False,
                 verify_lock: bool = False,
                 queue_cap: int = 2,
                 max_restarts: int = 1,
                 fallback_oneshot: bool = True,
                 pin_python: bool = False) -> None:
        _validate_timeout(timeout)
        if not isinstance(python, str) or not python or _NUL in python:
            _fail("bad_shape", "python interpreter malformed")
        if type(ocr_marks) is not bool:
            _fail("bad_shape", "ocr_marks must be a boolean")
        if ocr_marks and marks_out is None:
            _fail("bad_shape", "OCR requires a RAM marks output")
        if type(fallback_oneshot) is not bool:
            _fail("bad_shape", "fallback_oneshot must be a boolean")
        if type(pin_python) is not bool:
            _fail("bad_shape", "pin_python must be a boolean")
        _check_int(max_restarts, minimum=0, maximum=4, name="max_restarts")
        self.ve_root = _resolve_ve_root(ve_root, verify_lock=verify_lock)
        self.timeout = timeout
        self.python = python
        self.marks_out = (_ram_marks_path(marks_out)
                          if marks_out is not None else None)
        self.ocr_marks = ocr_marks
        self.last_mark_cap_reached = False
        self.last_timing_us: int | None = None
        self.last_latency_us: int | None = None
        self.last_transport: str | None = None
        self.last_vserve_error: PerceptionError | None = None
        self.last_fallback_error: PerceptionError | None = None
        self._vserve_queue = _BoundedRequestQueue(capacity=queue_cap)
        self._max_restarts = max_restarts
        self._vserve_restarts = 0
        self._fallback_oneshot = fallback_oneshot
        self._pinned_python: str | None = None
        self._vserve_proc: subprocess.Popen[bytes] | None = None
        self._vserve_hello_info: dict[str, Any] | None = None
        self._vserve_req_seq = 0
        self._vserve_rx_buf = bytearray()
        if pin_python:
            self._pinned_python = _resolve_pinned_python(
                self.python, ve_root=self.ve_root, timeout=self.timeout)
            self.python = self._pinned_python
        atexit.register(_close_weak_adapter, weakref.ref(self))

    def _vserve_available(self) -> bool:
        try:
            script = self.ve_root / "vadapt" / "vserve.py"
            return script.is_file() and not script.is_symlink()
        except OSError:
            return False

    def _ensure_pinned_python(self, *, deadline: float | None = None) -> str:
        if self._pinned_python is not None:
            return self._pinned_python
        rem = (_remaining_timeout(deadline)
               if deadline is not None else self.timeout)
        self._pinned_python = _resolve_pinned_python(
            self.python, ve_root=self.ve_root, timeout=rem)
        return self._pinned_python

    def _next_request_id(self) -> int:
        self._vserve_req_seq += 1
        return self._vserve_req_seq

    def _vserve_close_proc(self) -> None:
        proc = self._vserve_proc
        self._vserve_proc = None
        self._vserve_hello_info = None
        self._vserve_rx_buf.clear()
        if proc is None:
            return
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
        try:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=0.5)
        except (OSError, subprocess.TimeoutExpired):
            try:
                proc.kill()
                proc.wait(timeout=0.2)
            except (OSError, subprocess.TimeoutExpired):
                pass

    def close(self) -> None:
        """Close and reap the persistent ``vserve`` process if running."""
        self._vserve_close_proc()

    def __enter__(self) -> VCorePerceptionAdapter:
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def _vserve_roundtrip(
        self,
        request: dict[str, Any],
        *,
        deadline: float,
    ) -> dict[str, Any]:
        proc = self._vserve_proc
        if proc is None or proc.poll() is not None:
            _fail("unavailable", "vserve process is not running")
        assert proc.stdin is not None and proc.stdout is not None
        req_id = request.get("request_id")
        op = request.get("op")
        try:
            encoded = (json.dumps(request, separators=(",", ":")) + "\n").encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise PerceptionError("bad_shape", "vserve request is not JSON-serializable") from exc
        if len(encoded) > _VSERVE_MAX_CONTROL_BYTES:
            _fail("BUDGET_EXCEEDED", "vserve request exceeds max_control_line_bytes")
        _remaining_timeout(deadline)
        try:
            proc.stdin.write(encoded)
            proc.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            self._vserve_close_proc()
            raise PerceptionError("unavailable", "vserve stdin write failed") from exc

        stdout_fd = proc.stdout.fileno()
        try:
            os.set_blocking(stdout_fd, False)
        except OSError:
            pass
        try:
            with selectors.DefaultSelector() as sel:
                sel.register(proc.stdout, selectors.EVENT_READ)
                while True:
                    nl_idx = self._vserve_rx_buf.find(b"\n")
                    if nl_idx != -1:
                        line = bytes(self._vserve_rx_buf[:nl_idx + 1])
                        del self._vserve_rx_buf[:nl_idx + 1]
                        break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        self._vserve_close_proc()
                        _fail("timeout", "vserve request timed out")
                    events = sel.select(timeout=remaining)
                    if not events:
                        self._vserve_close_proc()
                        _fail("timeout", "vserve request timed out")
                    try:
                        chunk = os.read(stdout_fd, 65536)
                    except BlockingIOError:
                        continue
                    except OSError as exc:
                        self._vserve_close_proc()
                        raise PerceptionError(
                            "unavailable", "vserve stdout read failed") from exc
                    if not chunk:
                        stderr_detail = ""
                        if proc.stderr is not None:
                            try:
                                os.set_blocking(proc.stderr.fileno(), False)
                                stderr_detail = os.read(
                                    proc.stderr.fileno(), _STDERR_CAP
                                ).decode("utf-8", errors="replace")[:_STDERR_CAP]
                            except OSError:
                                stderr_detail = ""
                        self._vserve_close_proc()
                        _fail(
                            "unavailable",
                            "vserve process closed stdout (EOF)%s"
                            % (": " + stderr_detail if stderr_detail else ""),
                        )
                    self._vserve_rx_buf.extend(chunk)
                    if len(self._vserve_rx_buf) > _STDOUT_CAP:
                        self._vserve_close_proc()
                        _fail("BUDGET_EXCEEDED", "vserve reply exceeds maximum size")
        except PerceptionError:
            raise
        except Exception as exc:
            self._vserve_close_proc()
            raise PerceptionError("unavailable", "vserve I/O failure") from exc

        return _parse_vserve_reply(
            line,
            expected_id=req_id if isinstance(req_id, (int, str)) else None,
            expected_op=op if isinstance(op, str) else None,
        )

    def _vserve_start(self, *, deadline: float | None = None) -> dict[str, Any]:
        """Start the persistent ``vserve`` process lazily and verify ``hello``."""
        _validate_timeout(self.timeout)
        active_deadline = (deadline if deadline is not None
                           else time.monotonic() + self.timeout)
        if (self._vserve_proc is not None
                and self._vserve_proc.poll() is None
                and self._vserve_hello_info is not None):
            return dict(self._vserve_hello_info)
        self._vserve_close_proc()
        if not self._vserve_available():
            _fail("unavailable", "vadapt/vserve.py not available in checkout")
        pinned = self._ensure_pinned_python(deadline=active_deadline)
        _remaining_timeout(active_deadline)
        argv = [pinned, "-m", "vadapt.vserve"]
        try:
            proc = _spawn_vserve_proc(
                argv,
                cwd=str(self.ve_root),
                env=_scrubbed_env(self.ve_root),
            )
        except OSError as exc:
            raise PerceptionError(
                "unavailable", "vserve subprocess could not execute") from exc
        self._vserve_proc = proc
        try:
            req_id = self._next_request_id()
            reply = self._vserve_roundtrip(
                {"request_id": req_id, "op": "hello"},
                deadline=active_deadline,
            )
            hello_info = _validate_hello_result(reply["result"])
        except Exception:
            self._vserve_close_proc()
            raise
        self._vserve_hello_info = hello_info
        return dict(hello_info)

    def _vserve_health(
        self,
        *,
        include_status: bool = True,
        deadline: float | None = None,
    ) -> dict[str, Any]:
        """Verify persistent ``vserve`` health via ``ping`` (and ``status``)."""
        _validate_timeout(self.timeout)
        active_deadline = (deadline if deadline is not None
                           else time.monotonic() + self.timeout)
        if (self._vserve_proc is None
                or self._vserve_proc.poll() is not None
                or self._vserve_hello_info is None):
            self._vserve_start(deadline=active_deadline)
        try:
            with self._vserve_queue.slot():
                ping_id = self._next_request_id()
                ping_reply = self._vserve_roundtrip(
                    {"request_id": ping_id, "op": "ping"},
                    deadline=active_deadline,
                )
                hello_info = _validate_hello_result(ping_reply["result"])
                if include_status:
                    status_id = self._next_request_id()
                    status_reply = self._vserve_roundtrip(
                        {"request_id": status_id, "op": "status"},
                        deadline=active_deadline,
                    )
                    status_info = _validate_status_result(status_reply["result"])
                    hello_info["status"] = status_info
        except PerceptionError:
            self._vserve_close_proc()
            raise
        return hello_info

    def _vserve_restart(self, *, deadline: float | None = None) -> dict[str, Any]:
        """Kill, reap, respawn, and re-hello ``vserve`` within bounded restarts."""
        _validate_timeout(self.timeout)
        active_deadline = (deadline if deadline is not None
                           else time.monotonic() + self.timeout)
        self._vserve_close_proc()
        if self._vserve_restarts >= self._max_restarts:
            _fail("unavailable", "vserve restart budget exhausted")
        self._vserve_restarts += 1
        return self._vserve_start(deadline=active_deadline)

    def _perceive_vserve(
        self,
        frame_ref: Mapping[str, Any],
        frame: Frame | str | Path,
        *,
        prev: Frame | str | Path | None,
        width: int,
        height: int,
        expected_sha: str,
        deadline: float,
        started_at: float,
    ) -> dict[str, Any]:
        with self._vserve_queue.slot(), ExitStack() as stack:
            req_body: dict[str, Any] = {"op": "describe"}
            if isinstance(frame, Frame):
                req_body["frame_raw"] = _write_raw_shm_frame(frame, stack)
            else:
                path_str = _existing_frame_path(frame)
                if path_str.startswith(_PROC_FD_PREFIX):
                    _fail("unavailable", "procfd requires one-shot pass_fds")
                req_body["frame"] = path_str

            if prev is not None:
                if isinstance(prev, Frame):
                    req_body["prev_raw"] = _write_raw_shm_frame(prev, stack)
                else:
                    prev_str = _existing_frame_path(prev)
                    if prev_str.startswith(_PROC_FD_PREFIX):
                        _fail("unavailable", "procfd prev requires one-shot pass_fds")
                    req_body["prev"] = prev_str

            if self.marks_out is not None:
                req_body["marks_out"] = str(self.marks_out)
            if self.ocr_marks:
                req_body["ocr_marks"] = True

            self._vserve_start(deadline=deadline)
            try:
                req_id = self._next_request_id()
                req = {"request_id": req_id, **req_body}
                reply = self._vserve_roundtrip(req, deadline=deadline)
            except PerceptionError as exc:
                if (exc.code == "unavailable"
                        and self._vserve_proc is None
                        and self._vserve_restarts < self._max_restarts):
                    self._vserve_restart(deadline=deadline)
                    req_id = self._next_request_id()
                    req = {"request_id": req_id, **req_body}
                    reply = self._vserve_roundtrip(req, deadline=deadline)
                else:
                    raise

        c2_bytes = json.dumps(reply["result"]).encode("utf-8")
        parsed = _parse_c2_payload(
            c2_bytes,
            width=width,
            height=height,
            prev_given=prev is not None,
            marks_out=self.marks_out,
            ocr_requested=self.ocr_marks,
        )
        if parsed["frame_sha256"] != expected_sha:
            _fail("identity_mismatch", "C2 digest disagrees with input frame")
        self.last_mark_cap_reached = parsed["mark_cap_reached"]
        self.last_timing_us = parsed["timing_us"]
        self.last_latency_us = max(
            0, int(round((time.monotonic() - started_at) * 1_000_000)))
        self.last_transport = "vserve"
        self.last_vserve_error = None
        self.last_fallback_error = None
        vision = _vision_from_c2(parsed, width, height)
        check_vision(vision, width=width, height=height)
        return _BoundVision(vision, frame_ref["sha256"])

    def perceive(self, frame_ref: Mapping[str, Any],
                 frame: Frame | str | Path | None = None, *,
                 prev: Frame | str | Path | None = None) -> dict[str, Any]:
        started_at = time.monotonic()
        _validate_timeout(self.timeout)
        deadline = time.monotonic() + self.timeout
        width, height = _bound_dims(frame_ref)
        _check_hex64(frame_ref.get("sha256"), name="frame_ref.sha256")
        _check_frame_arg(frame, name="frame", width=width, height=height)
        _check_frame_arg(prev, name="prev", width=width, height=height)
        if frame is None:
            frame = _ramws_frame(frame_ref, width, height, deadline=deadline)
        if isinstance(frame, Frame):
            expected_sha = hashlib.sha256(frame.data).hexdigest()
            if expected_sha != frame_ref["sha256"]:
                _fail("identity_mismatch", "pixels disagree with frame_ref")
        else:
            _check_hex64(frame_ref.get("sha256"), name="frame_ref.sha256")
            expected_sha = frame_ref["sha256"]
        vserve_error: PerceptionError | None = None
        if self._vserve_available():
            try:
                return self._perceive_vserve(
                    frame_ref, frame, prev=prev,
                    width=width, height=height,
                    expected_sha=expected_sha,
                    deadline=deadline, started_at=started_at)
            except PerceptionError as exc:
                self.last_vserve_error = exc
                if exc.code == "identity_mismatch" or not self._fallback_oneshot:
                    raise
                vserve_error = exc
        env = _scrubbed_env(self.ve_root)
        try:
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
                timeout = _remaining_timeout(deadline)
                try:
                    result = _run_bounded(
                        command, cwd=str(self.ve_root), env=env,
                        stdin=subprocess.DEVNULL,
                        timeout=timeout, pass_fds=tuple(fds))
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
                if vserve_error is not None:
                    if result.returncode == 4:
                        raise PerceptionError(
                            "STALE_FRAME",
                            "C2 fallback reported stale input: %s" % detail)
                    if result.returncode == 5:
                        raise PerceptionError(
                            "unavailable",
                            "C2 fallback gate failed: %s" % detail)
                    if result.returncode == 6:
                        raise PerceptionError(
                            "BUDGET_EXCEEDED",
                            "C2 fallback reported budget exhausted: %s" % detail)
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
            if parsed["frame_sha256"] != expected_sha:
                _fail("identity_mismatch", "C2 digest disagrees with input frame")
        except PerceptionError as fb_exc:
            self.last_fallback_error = fb_exc
            if vserve_error is not None:
                if fb_exc.code == "identity_mismatch":
                    raise
                if (vserve_error.code != "unavailable"
                        and fb_exc.code in ("unavailable", "bad_shape")):
                    raise PerceptionError(
                        vserve_error.code,
                        "%s (fallback failed: %s)" % (vserve_error, fb_exc),
                    ) from fb_exc
            raise
        self.last_mark_cap_reached = parsed["mark_cap_reached"]
        self.last_timing_us = parsed["timing_us"]
        self.last_latency_us = max(
            0, int(round((time.monotonic() - started_at) * 1_000_000)))
        self.last_transport = "oneshot"
        vision = _vision_from_c2(parsed, width, height)
        check_vision(vision, width=width, height=height)
        return _BoundVision(vision, frame_ref["sha256"])

    def run_vcore(self, verb: str,
                  args: tuple[str, ...] | list[str] = ()) -> dict[str, Any]:
        """Run one ``vcore`` verb and return its JSON object.

        Exit classes map onto typed errors: 2/3 refuse the call, 4 is a
        stale frame, 5 is unavailable, and 6 exhausts the budget; the
        engine never uses exit 1, so it is refused as malformed.
        """
        if not isinstance(verb, str) or verb not in VCORE_VERBS:
            _fail("bad_shape", "unknown vcore verb %r" % (verb,))
        if not isinstance(args, (tuple, list)):
            _fail("bad_shape", "vcore args must be a sequence")
        assert isinstance(args, (tuple, list))
        for index, item in enumerate(args):
            if not isinstance(item, str) or _NUL in item:
                _fail("bad_shape", "vcore arg[%d] is not a string" % index)
        command = [self.python, "-m", "visioncore.cli", verb, *args]
        try:
            result = _run_bounded(
                command, cwd=str(self.ve_root),
                env=_scrubbed_env(self.ve_root),
                stdin=subprocess.DEVNULL,
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
