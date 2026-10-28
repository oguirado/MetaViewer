"""Wender planning over an explicit, pipe-only subprocess boundary.

[TARGET, unit decision] The pinned package has no planner CLI entry point.
The host must supply ``command`` (an argv sequence, never a shell string).
It reads {observation, element_table, goal} and writes exactly
{action, expectation, state, target_node} as UTF-8 JSON. Only click plans
are admitted here; their coordinates must fall inside the custody-checked
actionable target. This adapter does not dispatch or confer admission.
State fields follow the pinned wender.state/v1 wire schema; no private
implementation is imported or embedded. Optional verify_lock checks checkout
pinning before planning. Depth-tree consistency remains deferred for planner
compatibility; the adapter has no consumer for that invariant.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import selectors
import time
import subprocess

from .perception.deps_lock import DependencyLockError
from .executor import AdmittedExecutor, SurfaceError
from .observe import (
    ObservationError, _reject_non_canonical, compute_battery_state_sha256,
    validate_observation,
)
from .tools import ToolValidationError, _check_action, _check_expectation


def _require(condition, message):
    if not condition:
        raise ObservationError("bad_shape", message)


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

    def __init__(self, *, command, wender_root=None, timeout=10, verify_lock=False):
        raw = wender_root if wender_root is not None else os.environ.get("MV_WENDER_ROOT")
        if not isinstance(raw, (str, Path)) or not str(raw):
            raise ObservationError("unavailable", "MV_WENDER_ROOT or wender_root required")
        try:
            self.wender_root = Path(raw).resolve()
            if not self.wender_root.is_dir():
                raise ObservationError("unavailable", "Wender checkout is not a directory")
        except (OSError, ValueError, RuntimeError) as exc:
            raise ObservationError("unavailable", "Wender checkout is not a directory") from exc
        _require(type(verify_lock) is bool, "verify_lock must be a boolean")
        if verify_lock:
            from .perception.deps_lock import resolve_locked_component
            try:
                locked = resolve_locked_component("wender-agent")
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
        if (not isinstance(command, (list, tuple)) or not command
                or any(not isinstance(arg, str) or not arg or "\x00" in arg for arg in command)):
            raise ValueError("command must be a nonempty argv sequence")
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be positive and finite")
        self.command = tuple(command)
        self.timeout = timeout
        self.battery_state_sha256 = None

    def plan_step(self, observation, element_table, goal):
        self.battery_state_sha256 = None
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
        request = json.dumps(dict(observation=observation, element_table=element_table, goal=goal),
                             sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                             allow_nan=False).encode("utf-8")
        env = {}
        for key in ("PATH", "LANG"):
            value = os.environ.get(key)
            if value is not None:
                env[key] = value
        env.update(PYTHONPATH=str(self.wender_root), PYTHONDONTWRITEBYTECODE="1")
        try:
            result = _run_bounded(self.command, cwd=self.wender_root, env=env,
                                  request=request, timeout=self.timeout)
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
