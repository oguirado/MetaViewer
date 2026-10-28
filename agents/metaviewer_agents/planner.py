"""MetaViewer-side element-table planner and pipe CLI.

[TARGET, unit decision] Wender keeps no planner CLI by decision, so the
in-tree planner lives on the MetaViewer side under ``metaviewer_agents.planner``.
``plan(observation, element_table, goal)`` validates closed keys on the
observation and element table, requires a non-empty goal, binds the element
table to the observation frame, rejects out-of-frame bboxes and generation-control
labels, selects the highest-scoring matching element, places a left-click at
the bbox midpoint, and pairs it with a ``changed_region`` expectation and a
deterministic ``wender.state/v1`` witness so ``python3 -m metaviewer_agents.planner``
serves directly as an ``MV_WENDER_PLANNER_CMD`` target. ``recheck_plan``
provides caller-side re-validation against the original observation and
element table.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
from pathlib import Path
import re
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metaviewer_agents.executor import AdmittedExecutor, SurfaceError, SurfaceRefused  # noqa: E402
from metaviewer_agents.observe import (  # noqa: E402
    ObservationError,
    _reject_non_canonical,
    validate_observation,
)
from metaviewer_agents.tools import (  # noqa: E402
    ToolValidationError,
    _check_action,
    _check_expectation,
)
from metaviewer_agents.wender_bridge import validate_state  # noqa: E402

__all__ = [
    "EXIT_CODES",
    "PlannerError",
    "canonical_json",
    "main",
    "plan",
    "recheck_plan",
    "validate_plan_response",
]

_MAX_STDIN_BYTES = 1024 * 1024
_HEX64_RE = re.compile(r"[0-9a-f]{64}\Z")
_STOP_RE = re.compile(r"^\s*(?:Stop|Detener)\b", re.IGNORECASE)
_SURROGATE_RE = re.compile(r"[\ud800-\udfff]")

_REQUEST_KEYS = frozenset({"observation", "element_table", "goal"})
_RESPONSE_KEYS = frozenset({"action", "expectation", "state", "target_node"})
_TABLE_KEYS = frozenset({"schema", "frame_sha256", "width", "height", "elements"})
_ROW_KEYS = frozenset({"bbox", "role", "name", "score_ppm"})
_BBOX_KEYS = frozenset({"x", "y", "w", "h"})

EXIT_CODES: dict[str, int] = {
    "bad_shape": 1,
    "empty_goal": 2,
    "frame_mismatch": 3,
    "out_of_bounds": 4,
    "no_target": 5,
    "generation_control": 6,
    "alignment": 7,
}


class PlannerError(ObservationError):
    """Typed planner refusal carrying a distinct code and exit status."""

    def __init__(self, code: str, detail: str) -> None:
        self.detail = detail
        self.exit_code = EXIT_CODES.get(code, 1)
        super().__init__(code, detail)


def _fail(code: str, detail: str) -> None:
    raise PlannerError(code, detail)


def _check_clean_str(value: object, *, what: str) -> str:
    if not isinstance(value, str) or "\x00" in value or _SURROGATE_RE.search(value):
        _fail("bad_shape", f"{what} must be a valid UTF-8 string")
    return value


def canonical_json(value: object) -> str:
    """Serialize value to canonical compact UTF-8 JSON without floats."""
    _reject_non_canonical(value, 0)
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def _validate_inputs(
    observation: object,
    element_table: object,
    goal: object,
) -> tuple[dict, dict, str]:
    if not isinstance(goal, str):
        _fail("empty_goal", "goal must be a non-empty string")
    _check_clean_str(goal, what="goal")
    cleaned_goal = goal.strip()
    if not cleaned_goal:
        _fail("empty_goal", "goal must not be empty or whitespace")

    if not isinstance(observation, dict) or not isinstance(observation.get("frame_ref"), dict):
        _fail("bad_shape", "observation frame_ref missing")
    frame = observation["frame_ref"]
    _reject_non_canonical(frame, 0)
    if "ground_truth" in observation:
        _reject_non_canonical(observation["ground_truth"], 0)
    obs_schema = observation.get("schema")
    contract_version = "v0.1" if obs_schema == "observation/v0.1" else "v0.2"
    try:
        validate_observation(
            observation,
            surface_id=frame.get("surface_id"),
            generation=frame.get("generation"),
            contract_version=contract_version,
        )
    except ObservationError as exc:
        _fail("bad_shape", str(exc))

    try:
        _reject_non_canonical(element_table, 0)
    except ObservationError as exc:
        _fail("bad_shape", str(exc))

    if not isinstance(element_table, dict) or set(element_table) != _TABLE_KEYS:
        _fail("bad_shape", "element table keys invalid")
    if element_table.get("schema") != "vqa.element-table/v1":
        _fail("bad_shape", "element table schema invalid")
    if not isinstance(element_table.get("elements"), list):
        _fail("bad_shape", "element table elements must be a list")

    table_sha = element_table.get("frame_sha256")
    table_w = element_table.get("width")
    table_h = element_table.get("height")
    if (
        not isinstance(table_sha, str)
        or _HEX64_RE.fullmatch(table_sha) is None
        or type(table_w) is not int
        or type(table_h) is not int
        or table_w < 1
        or table_h < 1
    ):
        _fail("bad_shape", "element table frame metadata malformed")

    if (
        table_sha != frame["sha256"]
        or table_w != frame["width"]
        or table_h != frame["height"]
    ):
        _fail("frame_mismatch", "element table frame mismatch")

    for row in element_table["elements"]:
        if not isinstance(row, dict) or set(row) != _ROW_KEYS:
            _fail("bad_shape", "element row keys invalid")
        role = _check_clean_str(row.get("role"), what="element role")
        if not 1 <= len(role) <= 128:
            _fail("bad_shape", "element role length invalid")
        _check_clean_str(row.get("name"), what="element name")
        score = row.get("score_ppm")
        if type(score) is not int or not 0 <= score <= 1_000_000:
            _fail("bad_shape", "element score_ppm invalid")
        box = row.get("bbox")
        if not isinstance(box, dict) or set(box) != _BBOX_KEYS:
            _fail("bad_shape", "element bbox keys invalid")
        if not all(type(box[k]) is int for k in ("x", "y", "w", "h")):
            _fail("bad_shape", "element bbox coordinates must be integers")
        bx, by, bw, bh = box["x"], box["y"], box["w"], box["h"]
        if bw < 1 or bh < 1:
            _fail("bad_shape", "element bbox dimensions must be positive")
        if bx < 0 or by < 0 or bx + bw > frame["width"] or by + bh > frame["height"]:
            _fail("out_of_bounds", "element bbox escapes frame bounds")

    return frame, element_table, cleaned_goal


def _build_state_and_nodes(frame: dict, element_table: dict) -> tuple[dict, list[dict]]:
    nodes: list[dict] = []
    actionable: list[str] = []
    for idx, row in enumerate(element_table["elements"]):
        seed = f"{frame['sha256']}:{idx}:{row['role']}:{row['name']}".encode("utf-8")
        node_id = hashlib.sha256(seed).hexdigest()[:16]
        is_stop = _STOP_RE.search(row["name"]) is not None
        box = row["bbox"]
        node = {
            "id": node_id,
            "role": row["role"],
            "name": row["name"],
            "depth": 0,
            "parent": None,
            "ordinal": idx,
            "states": {},
            "actionable": not is_stop,
            "box": [box["x"], box["y"], box["w"], box["h"]],
        }
        nodes.append(node)
        if not is_stop:
            actionable.append(node_id)

    ax_sha256 = hashlib.sha256(canonical_json(nodes).encode("utf-8")).hexdigest()
    stable_nodes = [
        {k: (None if k == "box" else v) for k, v in node.items()}
        for node in nodes
    ]
    ax_stable_sha256 = hashlib.sha256(
        canonical_json(stable_nodes).encode("utf-8")
    ).hexdigest()
    state = {
        "schema": "wender.state/v1",
        "source": {"kind": "vision", "url": None, "title": None},
        "prune": {"name": "vqa.element-table", "version": 1},
        "ax_sha256": ax_sha256,
        "ax_stable_sha256": ax_stable_sha256,
        "viewport": {"w": frame["width"], "h": frame["height"]},
        "nodes": nodes,
        "actionable": actionable,
        "counts": {
            "raw": len(nodes),
            "nodes": len(nodes),
            "actionable": len(actionable),
        },
    }
    return state, nodes


def _select_target_index(elements: list[dict], goal: str) -> int:
    if not elements:
        _fail("no_target", "element table contains no elements")
    candidates: list[tuple[int, dict]] = [
        (idx, row)
        for idx, row in enumerate(elements)
        if _STOP_RE.search(row["name"]) is None
    ]
    if not candidates:
        _fail("generation_control", "refusing generation-control target")

    needle = goal.lower()
    exact = [
        (idx, row)
        for idx, row in candidates
        if row["name"].strip().lower() == needle or row["role"].strip().lower() == needle
    ]
    if exact:
        pool = exact
    else:
        partial = [
            (idx, row)
            for idx, row in candidates
            if (row["name"] and needle in row["name"].lower())
            or (row["role"] and needle in row["role"].lower())
        ]
        pool = partial if partial else candidates

    best_idx, _ = max(pool, key=lambda item: (item[1]["score_ppm"], -item[0]))
    return best_idx


def plan(observation: dict, element_table: dict, goal: str) -> dict:
    """Produce a deterministic, frame-bound click plan over the element table."""
    frame, checked_table, cleaned_goal = _validate_inputs(
        observation, element_table, goal
    )
    chosen_idx = _select_target_index(checked_table["elements"], cleaned_goal)
    chosen = checked_table["elements"][chosen_idx]
    box = chosen["bbox"]
    bx, by, bw, bh = box["x"], box["y"], box["w"], box["h"]
    click_x = bx + bw // 2
    click_y = by + bh // 2
    if not (0 <= click_x < frame["width"] and 0 <= click_y < frame["height"]):
        _fail("out_of_bounds", "computed click escapes frame bounds")
    if not (bx <= click_x < bx + bw and by <= click_y < by + bh):
        _fail("alignment", "computed click escapes target bbox")

    state, nodes = _build_state_and_nodes(frame, checked_table)
    target_node = copy.deepcopy(nodes[chosen_idx])
    action = {
        "type": "click",
        "x": click_x,
        "y": click_y,
        "button": "left",
    }
    expectation = {
        "type": "changed_region",
        "bbox": {"x": bx, "y": by, "w": bw, "h": bh},
    }
    response = {
        "action": action,
        "expectation": expectation,
        "state": state,
        "target_node": target_node,
    }
    recheck_plan(response, observation=observation, element_table=element_table)
    return copy.deepcopy(response)


def recheck_plan(
    response: object,
    observation: dict | None = None,
    element_table: dict | None = None,
) -> dict:
    """Caller-side re-validation of a planner response against frame and table."""
    if observation is None or element_table is None:
        _fail("bad_shape", "observation and element_table required for recheck")
    frame, checked_table, _ = _validate_inputs(
        observation, element_table, "recheck"
    )
    try:
        _reject_non_canonical(response, 0)
    except ObservationError as exc:
        _fail("bad_shape", str(exc))

    if not isinstance(response, dict) or set(response) != _RESPONSE_KEYS:
        _fail("bad_shape", "planner response keys invalid")

    action = response["action"]
    expectation = response["expectation"]
    state = response["state"]
    target_node = response["target_node"]

    try:
        _check_action(action)
        _check_expectation(expectation)
    except ToolValidationError as exc:
        _fail("bad_shape", str(exc))

    if action.get("type") != "click" or action.get("button") != "left":
        _fail("bad_shape", "planner action must be a left click")
    if expectation.get("type") != "changed_region":
        _fail("bad_shape", "planner expectation must be changed_region")

    click_x, click_y = action["x"], action["y"]
    if not (0 <= click_x < frame["width"] and 0 <= click_y < frame["height"]):
        _fail("out_of_bounds", "click coordinates outside frame bounds")

    exp_bbox = expectation["bbox"]
    if (
        exp_bbox["x"] < 0
        or exp_bbox["y"] < 0
        or exp_bbox["x"] + exp_bbox["w"] > frame["width"]
        or exp_bbox["y"] + exp_bbox["h"] > frame["height"]
    ):
        _fail("out_of_bounds", "expectation bbox outside frame bounds")

    try:
        validate_state(state)
    except ObservationError as exc:
        _fail("bad_shape", str(exc))

    if state.get("viewport") != {"w": frame["width"], "h": frame["height"]}:
        _fail("frame_mismatch", "state viewport disagrees with frame")

    try:
        AdmittedExecutor.check_target(
            target_node, latest=state["nodes"], frame=frame
        )
    except SurfaceRefused as exc:
        _fail(exc.code, str(exc))
    except SurfaceError as exc:
        _fail(
            "out_of_bounds" if exc.code == "alignment" else exc.code,
            str(exc),
        )
    except ValueError as exc:
        _fail("bad_shape", str(exc))

    if (
        target_node.get("actionable") is not True
        or target_node.get("id") not in state["actionable"]
    ):
        _fail("bad_shape", "target_node is not actionable")

    tx, ty, tw, th = target_node["box"]
    if not (tx <= click_x < tx + tw and ty <= click_y < ty + th):
        _fail("alignment", "click falls outside target_node box")

    target_bbox = {"x": tx, "y": ty, "w": tw, "h": th}
    if exp_bbox != target_bbox:
        _fail("alignment", "expectation bbox disagrees with target_node box")

    ordinal = target_node.get("ordinal")
    elements = checked_table["elements"]
    if (
        type(ordinal) is not int
        or not 0 <= ordinal < len(elements)
        or elements[ordinal]["bbox"] != target_bbox
        or elements[ordinal]["role"] != target_node.get("role")
        or elements[ordinal]["name"] != target_node.get("name")
    ):
        _fail("bad_shape", "target_node does not match element_table row")

    expected_state, _ = _build_state_and_nodes(frame, checked_table)
    if state != expected_state:
        _fail("bad_shape", "state witness disagrees with element_table")

    return copy.deepcopy(response)


validate_plan_response = recheck_plan


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            _fail("bad_shape", "duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(token: str) -> None:
    _fail("bad_shape", f"non-finite JSON constant: {token}")


def _checked_float(token: str) -> float:
    value = float(token)
    if not math.isfinite(value):
        _fail("bad_shape", "non-finite float")
    return value


def _read_stdin_request(stream) -> dict:
    if hasattr(stream, "buffer"):
        raw = stream.buffer.read(_MAX_STDIN_BYTES + 1)
        if len(raw) > _MAX_STDIN_BYTES:
            _fail("bad_shape", "planner input exceeds maximum size")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            _fail("bad_shape", "planner input is not valid UTF-8")
    else:
        text = stream.read(_MAX_STDIN_BYTES + 1)
        if not isinstance(text, str):
            _fail("bad_shape", "planner input is not text")
        if len(text.encode("utf-8", errors="surrogatepass")) > _MAX_STDIN_BYTES:
            _fail("bad_shape", "planner input exceeds maximum size")

    if not text or not text.strip():
        _fail("bad_shape", "planner input is empty")
    try:
        parsed = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_constant,
            parse_float=_checked_float,
        )
    except PlannerError:
        raise
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise PlannerError("bad_shape", "planner input is not valid JSON") from exc

    if not isinstance(parsed, dict) or set(parsed) != _REQUEST_KEYS:
        _fail("bad_shape", "planner request keys must be observation, element_table, goal")
    return parsed


def main(
    argv: list[str] | tuple[str, ...] | None = None,
    *,
    stdin=None,
    stdout=None,
    stderr=None,
) -> int:
    """Pipe CLI entry: read request JSON on stdin, write response JSON on stdout."""
    args = list(sys.argv[1:] if argv is None else argv)
    in_stream = sys.stdin if stdin is None else stdin
    out_stream = sys.stdout if stdout is None else stdout
    err_stream = sys.stderr if stderr is None else stderr

    if args:
        print("bad_shape: planner CLI takes no positional arguments or flags", file=err_stream)
        return EXIT_CODES["bad_shape"]

    try:
        request = _read_stdin_request(in_stream)
        response = plan(
            request["observation"],
            request["element_table"],
            request["goal"],
        )
        output = canonical_json(response)
    except PlannerError as exc:
        print(f"{exc.code}: {exc.detail}", file=err_stream)
        return exc.exit_code
    except ObservationError as exc:
        code = getattr(exc, "code", "bad_shape")
        print(f"{code}: {exc}", file=err_stream)
        return EXIT_CODES.get(code, 1)
    except Exception as exc:
        print(f"bad_shape: {exc}", file=err_stream)
        return EXIT_CODES["bad_shape"]

    print(output, file=out_stream)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
