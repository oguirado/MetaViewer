"""Wender planning over an explicit, pipe-only subprocess boundary.

[TARGET, unit decision] Default planner CLI entry point is
``(sys.executable, "-m", "wender.plan.cli")`` with precedence: explicit
``command`` argument -> ``MV_WENDER_PLANNER_CMD`` JSON argv environment
override -> ``DEFAULT_WENDER_PLANNER_CMD``. It reads
``{observation, element_table, goal}`` and writes
``{action, expectation, state, target_node}`` as UTF-8 JSON. Only click plans
are admitted here; their coordinates must fall inside the custody-checked
actionable target. This adapter does not dispatch or confer admission.
State fields follow the pinned ``wender.state/v1`` wire schema; no private
implementation is imported or embedded. Lock verification checks
``resolve_locked_component("wender-agent")`` before planning. Optional
``WenderModelBackend`` hooks local Muse Spark CLI (``"muse_cli"``) or demo
``"baseten"`` via in-memory runtime credential buffers only (never disk or env).
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import selectors
import sys
import time
import subprocess

from .perception.deps_lock import DependencyLockError
from .executor import AdmittedExecutor, SurfaceError
from .observe import (
    ObservationError, _reject_non_canonical, compute_battery_state_sha256,
    validate_observation,
)
from .tools import ToolValidationError, _check_action, _check_expectation

__all__ = [
    "ALLOWED_MODEL_BACKENDS",
    "DEFAULT_WENDER_PLANNER_CMD",
    "WenderModelBackend",
    "WenderSubprocessAdapter",
    "coerce_model_backend",
    "has_configured_wender_root",
    "resolve_planner_command",
    "validate_state",
]

_MAX_TIMEOUT = 86400.0
DEFAULT_WENDER_PLANNER_CMD: tuple[str, ...] = (
    sys.executable,
    "-m",
    "wender.plan.cli",
)
ALLOWED_MODEL_BACKENDS: frozenset[str] = frozenset((
    "muse_cli",
    "muse_spark",
    "baseten",
))


def _is_valid_argv_token(value: object) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and "\x00" not in value
        and not any(0xD800 <= ord(c) <= 0xDFFF for c in value)
    )


def has_configured_wender_root(wender_root: str | Path | None = None) -> bool:
    """Return True when an explicit wender_root or MV_WENDER_ROOT is configured."""
    raw = wender_root if wender_root is not None else os.environ.get("MV_WENDER_ROOT")
    return isinstance(raw, (str, Path)) and bool(str(raw).strip())


def resolve_planner_command(
    command: list[str] | tuple[str, ...] | None = None,
    *,
    configured_env: str | None = None,
    use_env: bool = True,
) -> tuple[str, ...]:
    """Resolve the planner argv with precedence: explicit command -> env -> default."""
    if command is not None:
        if (
            not isinstance(command, (list, tuple))
            or not command
            or any(not _is_valid_argv_token(arg) for arg in command)
        ):
            raise ObservationError("bad_shape", "command must be a nonempty argv sequence")
        return tuple(command)

    raw_env = configured_env
    if raw_env is None and use_env:
        from .verify import get_configured_planner_cmd

        raw_env = get_configured_planner_cmd()

    if raw_env is not None:
        try:
            parsed = json.loads(raw_env)
        except (ValueError, TypeError, RecursionError) as exc:
            raise ObservationError("bad_shape", "planner command must be JSON argv") from exc
        if (
            not isinstance(parsed, list)
            or not parsed
            or any(not _is_valid_argv_token(arg) for arg in parsed)
        ):
            raise ObservationError("bad_shape", "planner command must be nonempty JSON argv")
        return tuple(parsed)

    default_cmd = DEFAULT_WENDER_PLANNER_CMD
    if (
        not isinstance(default_cmd, (list, tuple))
        or not default_cmd
        or any(not _is_valid_argv_token(arg) for arg in default_cmd)
    ):
        raise ObservationError("bad_shape", "command must be a nonempty argv sequence")
    return tuple(default_cmd)


class WenderModelBackend:
    """Runtime-only model backend hook for local Muse Spark CLI or Baseten demo.

    [TARGET, unit decision] Credentials are accepted exclusively as in-memory
    ``bytes`` or ``bytearray`` buffers. Strings, Paths, filenames (e.g. ``.env``,
    ``auth.json``, ``*.key``), and environment lookups are rejected. Credentials
    are never serialized to ``repr``, ``str``, logs, errors, or subprocess env.
    """

    def __init__(
        self,
        provider: str = "muse_cli",
        *,
        credential: bytes | bytearray | None = None,
        endpoint: str | None = None,
        command: list[str] | tuple[str, ...] | None = None,
        transport=None,
        require_credential: bool = False,
    ) -> None:
        if not isinstance(provider, str) or provider not in ALLOWED_MODEL_BACKENDS:
            raise ObservationError(
                "bad_shape",
                "model backend provider must be 'muse_cli', 'muse_spark', or 'baseten'",
            )
        self.provider: str = provider
        self.kind: str = "baseten" if provider == "baseten" else "muse_cli"

        if endpoint is not None:
            if not _is_valid_argv_token(endpoint) or not endpoint.strip():
                raise ObservationError("bad_shape", "model backend endpoint must be a valid string")
        self.endpoint: str | None = endpoint

        if command is not None:
            if (
                not isinstance(command, (list, tuple))
                or not command
                or any(not _is_valid_argv_token(arg) for arg in command)
            ):
                raise ObservationError("bad_shape", "model backend command must be nonempty argv")
            self.command: tuple[str, ...] | None = tuple(command)
        else:
            self.command = None

        if transport is not None and not callable(transport):
            raise ObservationError("bad_shape", "model backend transport must be callable")
        self._transport = transport

        self._credential_buf = bytearray()
        if credential is not None:
            if isinstance(credential, (str, Path, os.PathLike)) or not isinstance(
                credential, (bytes, bytearray)
            ):
                raise ObservationError(
                    "bad_shape",
                    "credential must be an in-memory bytes buffer, never a string, path, or key file",
                )
            raw_bytes = bytes(credential)
            if not raw_bytes or b"\x00" in raw_bytes or not raw_bytes.strip():
                raise ObservationError(
                    "bad_shape",
                    "credential buffer must be non-empty and NUL-free",
                )
            self._credential_buf = bytearray(raw_bytes)
        elif require_credential:
            raise ObservationError(
                "unavailable",
                "model backend requires an in-memory credential buffer",
            )

    @property
    def has_credential(self) -> bool:
        return bool(self._credential_buf)

    def credential_handle(self) -> memoryview:
        if not self._credential_buf:
            raise ObservationError("unavailable", "model backend credential is not loaded")
        return memoryview(self._credential_buf).toreadonly()

    def clear_credential(self) -> None:
        for index in range(len(self._credential_buf)):
            self._credential_buf[index] = 0
        self._credential_buf.clear()

    def redact(self) -> dict[str, object]:
        return {
            "provider": self.provider,
            "kind": self.kind,
            "endpoint": self.endpoint,
            "has_credential": self.has_credential,
            "credential": "<redacted>" if self.has_credential else None,
        }

    to_metadata = redact

    def invoke(self, request: dict[str, object]) -> dict[str, object]:
        _reject_non_canonical(request, 0)
        if not isinstance(request, dict):
            raise ObservationError("bad_shape", "model backend request must be a JSON object")
        if self.kind == "baseten" and not self.has_credential:
            raise ObservationError(
                "unavailable",
                "baseten model backend requires an in-memory credential buffer",
            )
        if self._transport is None:
            raise ObservationError("unavailable", "model backend transport is not configured")
        cred_view = self.credential_handle() if self.has_credential else None
        response = self._transport(
            request,
            provider=self.provider,
            endpoint=self.endpoint,
            credential=cred_view,
        )
        _reject_non_canonical(response, 0)
        if not isinstance(response, dict):
            raise ObservationError("bad_shape", "model backend response must be a JSON object")
        return response

    def __repr__(self) -> str:
        cred_state = "<redacted>" if self.has_credential else "None"
        return (
            f"WenderModelBackend(provider={self.provider!r}, "
            f"endpoint={self.endpoint!r}, credential={cred_state})"
        )

    __str__ = __repr__


def coerce_model_backend(
    model_backend: WenderModelBackend | dict[str, object] | str | None,
) -> WenderModelBackend | None:
    if model_backend is None:
        return None
    if isinstance(model_backend, WenderModelBackend):
        return model_backend
    if isinstance(model_backend, str):
        return WenderModelBackend(model_backend)
    if isinstance(model_backend, dict):
        allowed = {"provider", "credential", "endpoint", "command", "transport", "require_credential"}
        if not set(model_backend) <= allowed:
            raise ObservationError("bad_shape", "model_backend dict contains unsupported keys")
        kwargs = dict(model_backend)
        provider = kwargs.pop("provider", "muse_cli")
        return WenderModelBackend(provider, **kwargs)
    raise ObservationError("bad_shape", "model_backend must be WenderModelBackend, dict, str, or None")


def _require(condition, message):
    if not condition:
        raise ObservationError("bad_shape", message)


def _validate_timeout(timeout):
    if type(timeout) not in (int, float):
        raise ObservationError("bad_shape", "timeout must be positive and finite")
    try:
        timeout_f = float(timeout)
    except OverflowError as exc:
        raise ObservationError("bad_shape", "timeout must be positive and finite") from exc
    if not math.isfinite(timeout_f) or timeout_f <= 0 or timeout_f > _MAX_TIMEOUT:
        raise ObservationError("bad_shape", "timeout must be positive and finite")
    return timeout_f


def _hex(value, length):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{%d}" % length, value) is not None


def validate_state(state):
    """Validate the closed state wire shape and return its battery digest.

    AX digests are producer witnesses, not recomputed from flattened nodes.
    Geometry against the bound frame is checked separately by the executor.
    """
    _reject_non_canonical(state, 0)
    _require(isinstance(state, dict) and set(state) == {
        "schema", "source", "prune", "ax_sha256", "ax_stable_sha256",
        "viewport", "nodes", "actionable", "counts",
    }, "state keys invalid")
    _require(state["schema"] == "wender.state/v1", "state schema invalid")
    for key in ("ax_sha256", "ax_stable_sha256"):
        _require(_hex(state[key], 64), key + " invalid")
    source, prune = state["source"], state["prune"]
    _require(isinstance(source, dict) and set(source) == {"kind", "url", "title"},
             "state source invalid")
    _require(source["kind"] in ("cdp", "atspi", "godot", "vision")
             and all(source[k] is None or isinstance(source[k], str)
                     for k in ("url", "title")), "state source invalid")
    _require(isinstance(prune, dict) and set(prune) == {"name", "version"}
             and isinstance(prune.get("name"), str)
             and type(prune.get("version")) is int, "state prune invalid")
    viewport = state["viewport"]
    _require(viewport is None or (isinstance(viewport, dict)
             and set(viewport) == {"w", "h"}
             and all(type(v) is int and v >= 0 for v in viewport.values())), "state viewport invalid")
    _require(isinstance(state["nodes"], list), "state nodes invalid")
    seen, actionable = set(), []
    for node in state["nodes"]:
        _require(isinstance(node, dict) and set(node) == {
            "id", "role", "name", "depth", "parent", "ordinal", "states",
            "actionable", "box",
        }, "state node keys invalid")
        ident, parent = node["id"], node["parent"]
        _require(_hex(ident, 16) and ident not in seen, "state node id invalid")
        _require(parent is None or (isinstance(parent, str) and parent in seen),
                 "state node parent invalid")
        seen.add(ident)
        _require(all(type(node[k]) is int and node[k] >= 0 for k in ("depth", "ordinal")),
                 "state node integer invalid")
        _require(all(isinstance(node[k], str) for k in ("role", "name")),
                 "state node text invalid")
        _require(isinstance(node["states"], dict)
                 and all(isinstance(v, str) for v in node["states"].values()),
                 "state node states invalid")
        _require(type(node["actionable"]) is bool, "state node actionable invalid")
        box = node["box"]
        _require(box is None or (isinstance(box, list) and len(box) == 4
                 and all(type(v) is int for v in box)
                 and box[2] >= 1 and box[3] >= 1), "state node box invalid")
        if node["actionable"]:
            actionable.append(ident)
    _require(isinstance(state["actionable"], list) and state["actionable"] == actionable,
             "state actionable membership invalid")
    counts = state["counts"]
    _require(isinstance(counts, dict) and set(counts) == {"raw", "nodes", "actionable"}
             and all(type(v) is int and v >= 0 for v in counts.values()), "state counts invalid")
    _require(counts["nodes"] == len(seen) and counts["actionable"] == len(actionable)
             and counts["raw"] >= len(seen), "state counts disagree")
    return compute_battery_state_sha256(state)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def _run_bounded(command, *, cwd, env, request, timeout):
    """Drain both outputs while feeding stdin, with fixed byte ceilings."""
    timeout = _validate_timeout(timeout)
    deadline = time.monotonic() + timeout
    with subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
        try:
            outputs = {process.stdout: bytearray(), process.stderr: bytearray()}
            limits = {process.stdout: 1024 * 1024, process.stderr: 64 * 1024}
            pending = memoryview(request)
            with selectors.DefaultSelector() as selector:
                for stream in (process.stdin, process.stdout, process.stderr):
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, selectors.EVENT_WRITE if stream is process.stdin
                                      else selectors.EVENT_READ)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(command, timeout)
                    for key, _ in selector.select(remaining):
                        stream = key.fileobj
                        if stream is process.stdin:
                            try:
                                written = os.write(stream.fileno(), pending[:4096])
                                pending = pending[written:]
                            except BrokenPipeError:
                                pending = pending[:0]
                            if not pending:
                                selector.unregister(stream)
                                stream.close()
                        else:
                            buffer = outputs[stream]
                            chunk = os.read(stream.fileno(), min(65536, limits[stream] - len(buffer) + 1))
                            if not chunk:
                                selector.unregister(stream)
                            else:
                                buffer.extend(chunk)
                                if len(buffer) > limits[stream]:
                                    raise ObservationError("bad_shape", "planner output exceeds maximum size")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout)
            process.wait(timeout=remaining)
            return subprocess.CompletedProcess(command, process.returncode,
                                               bytes(outputs[process.stdout]), b"")
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


class WenderSubprocessAdapter:
    """Host-configured planner with no files, shell, or inherited credentials.

    ``timeout`` is a positive, finite duration in seconds, enforced across pipe I/O and process exit.
    ``battery_state_sha256`` is cleared before each attempt, and populated
    only after every response and custody check succeeds.
    """

    def __init__(
        self,
        *,
        command=None,
        wender_root=None,
        timeout=10,
        verify_lock=None,
        lock_path=None,
        model_backend=None,
    ):
        raw = wender_root if wender_root is not None else os.environ.get("MV_WENDER_ROOT")
        if not isinstance(raw, (str, Path)) or not str(raw):
            raise ObservationError("unavailable", "MV_WENDER_ROOT or wender_root required")
        try:
            self.wender_root = Path(raw).resolve()
            if not self.wender_root.is_dir():
                raise ObservationError("unavailable", "Wender checkout is not a directory")
        except (OSError, ValueError, RuntimeError) as exc:
            raise ObservationError("unavailable", "Wender checkout is not a directory") from exc
        if verify_lock is None:
            verify_lock = wender_root is None or command is None
        _require(type(verify_lock) is bool, "verify_lock must be a boolean")
        if lock_path is not None and not isinstance(lock_path, (str, Path)):
            raise ObservationError("bad_shape", "lock_path must be a path")
        self.lock_path = Path(lock_path) if lock_path is not None else None
        self.verify_lock = verify_lock
        self.model_backend = coerce_model_backend(model_backend)
        if verify_lock:
            from .perception.deps_lock import resolve_locked_component
            try:
                if self.lock_path is None:
                    locked = resolve_locked_component("wender-agent")
                else:
                    locked = resolve_locked_component("wender-agent", lock_path=self.lock_path)
            except DependencyLockError as exc:
                raise ObservationError(exc.code, str(exc)) from exc
            if not isinstance(locked, (str, Path)):
                raise ObservationError("unavailable", "dependency resolver returned no checkout")
            try:
                locked_root = Path(locked).resolve()
                if not locked_root.is_dir():
                    raise ObservationError("unavailable", "verified checkout is not a directory")
            except (OSError, ValueError, RuntimeError) as exc:
                raise ObservationError("unavailable", "verified checkout is not a directory") from exc
            if locked_root != self.wender_root:
                raise ObservationError("commit_mismatch", "verified checkout differs from wender_root")
        self.command = resolve_planner_command(command)
        self.timeout = _validate_timeout(timeout)
        self.battery_state_sha256 = None

    def plan_step(self, observation, element_table, goal):
        self.battery_state_sha256 = None
        timeout = _validate_timeout(self.timeout)
        _require(isinstance(observation, dict) and isinstance(observation.get("frame_ref"), dict),
                 "observation frame missing")
        frame = observation["frame_ref"]
        validate_observation(observation, surface_id=frame.get("surface_id"),
                             generation=frame.get("generation"), contract_version="v0.2")
        _reject_non_canonical(element_table, 0)
        _require(isinstance(element_table, dict)
                 and set(element_table) == {"schema", "frame_sha256", "width", "height", "elements"}
                 and element_table.get("schema") == "vqa.element-table/v1"
                 and isinstance(element_table.get("elements"), list), "element table invalid")
        for key, expected in (("frame_sha256", frame["sha256"]),
                              ("width", frame["width"]), ("height", frame["height"])):
            _require(type(element_table.get(key)) is type(expected)
                     and element_table[key] == expected, "element table frame mismatch")
        for row in element_table["elements"]:
            _require(isinstance(row, dict) and set(row) == {"bbox", "role", "name", "score_ppm"},
                     "element row keys invalid")
            box = row["bbox"]
            _require(isinstance(box, dict) and set(box) == {"x", "y", "w", "h"}
                     and all(type(v) is int for v in box.values())
                     and box["x"] >= 0 and box["y"] >= 0
                     and box["w"] >= 1 and box["h"] >= 1
                     and box["x"] + box["w"] <= frame["width"]
                     and box["y"] + box["h"] <= frame["height"], "element bbox invalid")
            _require(isinstance(row["role"], str) and isinstance(row["name"], str)
                     and type(row["score_ppm"]) is int
                     and 0 <= row["score_ppm"] <= 1_000_000, "element fields invalid")
        _require(isinstance(goal, str) and bool(goal.strip()), "goal required")
        _reject_non_canonical(goal, 0)
        try:
            request = json.dumps(dict(observation=observation, element_table=element_table, goal=goal),
                                 sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                                 allow_nan=False).encode("utf-8")
        except (UnicodeEncodeError, ValueError, TypeError) as exc:
            raise ObservationError("bad_shape", "planner request is not valid UTF-8 JSON") from exc
        env = {}
        for key in ("PATH", "LANG"):
            value = os.environ.get(key)
            if value is not None:
                env[key] = value
        env.update(PYTHONPATH=str(self.wender_root), PYTHONDONTWRITEBYTECODE="1")
        try:
            result = _run_bounded(self.command, cwd=self.wender_root, env=env,
                                  request=request, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise ObservationError("timeout", "Wender planner timed out") from exc
        except OSError as exc:
            raise ObservationError("unavailable", "Wender planner launch failed") from exc
        if result.returncode:
            raise ObservationError("subprocess_failed", "Wender planner exited unsuccessfully")
        try:
            response = json.loads(result.stdout.decode("utf-8"), object_pairs_hook=_unique_object)
        except (ValueError, UnicodeError, RecursionError) as exc:
            raise ObservationError("bad_shape", "Wender response is not unique UTF-8 JSON") from exc
        _require(isinstance(response, dict) and set(response) == {
            "action", "expectation", "state", "target_node",
        }, "planner response keys invalid")
        state, action, expectation, target = (response[k] for k in (
            "state", "action", "expectation", "target_node"))
        digest = validate_state(state)
        _reject_non_canonical(target, 0)
        try:
            _check_action(action)
            _check_expectation(expectation)
        except ToolValidationError as exc:
            raise ObservationError("bad_shape", str(exc)) from exc
        _require(action["type"] == "click", "only custody-bound clicks supported")
        AdmittedExecutor.check_target(target, latest=state["nodes"], frame=frame)
        _require(target.get("actionable") is True and target["id"] in state["actionable"],
                 "target is not actionable")
        x, y, w, h = target["box"]
        if not (x <= action["x"] < x + w and y <= action["y"] < y + h):
            raise SurfaceError("alignment", "click")
        self.battery_state_sha256 = digest
        return action, expectation, state, target
