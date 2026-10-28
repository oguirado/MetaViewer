"""MetaViewer-side Holdings and element-table planner and pipe CLI.

[TARGET, unit decision] Wender keeps no planner CLI by decision, so the
in-tree planner lives on the MetaViewer side under ``metaviewer_agents.planner``.
For Holdings observations carrying ``ground_truth`` (``source == "holdings_lane"``),
``plan(observation)`` / ``plan_holdings(observation)`` emits one validated
``action_proposal/v0.2`` with an ``input`` action (never ``lane_submit``) and a
``state_sha256_change`` expectation bound to ``ground_truth.state_sha256`` and an
explicit ``[min_tick, max_tick]`` window. When called as
``plan(observation, element_table, goal)``, it validates closed keys on the
observation and element table, requires a non-empty goal, binds the element
table to the observation frame, rejects out-of-frame bboxes and generation-control
labels, selects the highest-scoring matching element, places a left-click at
the bbox midpoint, and pairs it with ``state_sha256_change`` (when
``ground_truth`` is present) or ``changed_region`` plus a deterministic
``wender.state/v1`` witness so ``python3 -m metaviewer_agents.planner`` serves
both as a standalone observation->proposal CLI and as an ``MV_WENDER_PLANNER_CMD``
target.
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
    _check_proposal,
)
from metaviewer_agents.wender_bridge import _run_bounded, validate_state  # noqa: E402

__all__ = [
    "DEFAULT_HOLDINGS_MAX_MS",
    "DEFAULT_HOLDINGS_PROPOSAL_ID",
    "DEFAULT_TICK_WINDOW",
    "EXIT_CODES",
    "PlannerError",
    "canonical_json",
    "invoke_planner_cmd",
    "main",
    "plan",
    "plan_holdings",
    "plan_holdings_step",
    "recheck_holdings_proposal",
    "recheck_plan",
    "validate_plan_response",
]

DEFAULT_TICK_WINDOW = 5
DEFAULT_HOLDINGS_PROPOSAL_ID = "holdings-proposal-1"
DEFAULT_HOLDINGS_MAX_MS = 5000

_MAX_STDIN_BYTES = 1024 * 1024
_HEX64_RE = re.compile(r"[0-9a-f]{64}\Z")
_STOP_RE = re.compile(r"^\s*(?:Stop|Detener)\b", re.IGNORECASE)
_SURROGATE_RE = re.compile(r"[\ud800-\udfff]")

_REQUEST_KEYS = frozenset({"observation", "element_table", "goal"})
_OBSERVATION_WRAPPER_KEYS = frozenset(
    {"observation", "proposal_id", "tick_window", "max_ms", "max_retries"}
)
_RESPONSE_KEYS = frozenset({"action", "expectation", "state", "target_node"})
_TABLE_KEYS = frozenset({"schema", "frame_sha256", "width", "height", "elements"})
_ROW_KEYS = frozenset({"bbox", "role", "name", "score_ppm"})
_BBOX_KEYS = frozenset({"x", "y", "w", "h"})
_HOLDINGS_INPUT_TYPES = frozenset({"click", "key", "type", "scroll"})

EXIT_CODES: dict[str, int] = {
    "bad_shape": 1,
    "empty_goal": 2,
    "frame_mismatch": 3,
    "out_of_bounds": 4,
    "no_target": 5,
    "generation_control": 6,
    "alignment": 7,
    "policy": 8,
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


def _validate_holdings_observation(observation: object) -> tuple[dict, dict]:
    if not isinstance(observation, dict) or not isinstance(observation.get("frame_ref"), dict):
        _fail("bad_shape", "observation frame_ref missing")
    frame = observation["frame_ref"]
    try:
        _reject_non_canonical(frame, 0)
        if "ground_truth" in observation:
            _reject_non_canonical(observation["ground_truth"], 0)
    except ObservationError as exc:
        _fail("bad_shape", str(exc))

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

    truth = observation.get("ground_truth")
    if not isinstance(truth, dict) or truth.get("source") != "holdings_lane":
        _fail("bad_shape", "Holdings observation requires ground_truth with source holdings_lane")
    return frame, truth


def _select_holdings_click_from_vision(frame: dict, vision: dict) -> dict:
    elements = vision.get("elements")
    if isinstance(elements, list) and elements:
        candidates: list[tuple[int, dict]] = []
        for idx, elem in enumerate(elements):
            if not isinstance(elem, dict):
                continue
            name = elem.get("name", "")
            if isinstance(name, str) and _STOP_RE.search(name) is not None:
                continue
            candidates.append((idx, elem))
        if not candidates:
            _fail("generation_control", "refusing generation-control target")
        _, chosen = max(
            candidates,
            key=lambda item: (float(item[1].get("confidence", 0.0)), -item[0]),
        )
        box = chosen["bbox"]
        bx, by, bw, bh = box["x"], box["y"], box["w"], box["h"]
        click_x = bx + bw // 2
        click_y = by + bh // 2
        if not (0 <= click_x < frame["width"] and 0 <= click_y < frame["height"]):
            _fail("out_of_bounds", "computed click escapes frame bounds")
        return {"type": "click", "x": click_x, "y": click_y, "button": "left"}

    click_x = frame["width"] // 2
    click_y = frame["height"] // 2
    return {"type": "click", "x": click_x, "y": click_y, "button": "left"}


def plan_holdings_step(
    observation: dict,
    *,
    tick_window: int = DEFAULT_TICK_WINDOW,
    action: dict | None = None,
) -> tuple[dict, dict]:
    """Emit (action, expectation) for a Holdings observation; never lane_submit."""
    frame, truth = _validate_holdings_observation(observation)
    if type(tick_window) is not int or tick_window < 1:
        _fail("bad_shape", "tick_window must be a positive integer")

    if action is not None:
        try:
            _reject_non_canonical(action, 0)
        except ObservationError as exc:
            _fail("bad_shape", str(exc))
        if not isinstance(action, dict):
            _fail("bad_shape", "action must be a dict")
        if action.get("type") == "lane_submit":
            _fail("policy", "lane_submit is forbidden for Holdings")
        try:
            _check_action(action)
        except ToolValidationError as exc:
            _fail("bad_shape", str(exc))
        if action.get("type") not in _HOLDINGS_INPUT_TYPES:
            _fail("policy", "Holdings action must be an input action")
        if action["type"] == "click":
            if not (0 <= action["x"] < frame["width"] and 0 <= action["y"] < frame["height"]):
                _fail("out_of_bounds", "click coordinates outside frame bounds")
        chosen_action = copy.deepcopy(action)
    elif "vision" in observation and isinstance(observation.get("vision"), dict):
        chosen_action = _select_holdings_click_from_vision(frame, observation["vision"])
    else:
        chosen_action = {
            "type": "click",
            "x": frame["width"] // 2,
            "y": frame["height"] // 2,
            "button": "left",
        }

    base_tick = truth["tick"]
    expectation = {
        "type": "state_sha256_change",
        "before": truth["state_sha256"],
        "min_tick": base_tick + 1,
        "max_tick": base_tick + tick_window,
    }
    try:
        _check_action(chosen_action)
        _check_expectation(expectation)
    except ToolValidationError as exc:
        _fail("bad_shape", str(exc))
    return copy.deepcopy(chosen_action), copy.deepcopy(expectation)


def plan_holdings(
    observation: dict,
    *,
    proposal_id: str = DEFAULT_HOLDINGS_PROPOSAL_ID,
    tick_window: int = DEFAULT_TICK_WINDOW,
    max_ms: int = DEFAULT_HOLDINGS_MAX_MS,
    max_retries: int = 0,
    action: dict | None = None,
) -> dict:
    """Emit one action_proposal/v0.2 for a Holdings observation; never lane_submit."""
    frame, _ = _validate_holdings_observation(observation)
    _check_clean_str(proposal_id, what="proposal_id")
    if not 1 <= len(proposal_id) <= 128:
        _fail("bad_shape", "proposal_id length invalid")
    if type(max_ms) is not int or not 1 <= max_ms <= 3_600_000:
        _fail("bad_shape", "max_ms out of range")
    if type(max_retries) is not int or not 0 <= max_retries <= 10:
        _fail("bad_shape", "max_retries out of range")

    chosen_action, expectation = plan_holdings_step(
        observation,
        tick_window=tick_window,
        action=action,
    )
    proposal = {
        "schema": "action_proposal/v0.2",
        "proposal_id": proposal_id,
        "surface_id": frame["surface_id"],
        "based_on_frame": {
            "sha256": frame["sha256"],
            "generation": frame["generation"],
        },
        "action": chosen_action,
        "expectation": expectation,
        "budget": {
            "max_ms": max_ms,
            "max_retries": max_retries,
        },
    }
    recheck_holdings_proposal(proposal, observation)
    return copy.deepcopy(proposal)


def recheck_holdings_proposal(proposal: object, observation: dict | None = None) -> dict:
    """Caller-side validation of a Holdings action_proposal/v0.2 against observation."""
    if observation is None:
        _fail("bad_shape", "observation required for Holdings proposal recheck")
    frame, truth = _validate_holdings_observation(observation)
    try:
        _reject_non_canonical(proposal, 0)
    except ObservationError as exc:
        _fail("bad_shape", str(exc))

    if not isinstance(proposal, dict):
        _fail("bad_shape", "proposal must be a dict")
    action = proposal.get("action")
    if isinstance(action, dict) and action.get("type") == "lane_submit":
        _fail("policy", "lane_submit is forbidden for Holdings")

    try:
        _check_proposal(proposal)
    except ToolValidationError as exc:
        _fail("bad_shape", str(exc))

    if proposal["surface_id"] != frame["surface_id"]:
        _fail("frame_mismatch", "proposal surface_id disagrees with observation frame")
    based = proposal["based_on_frame"]
    if based["sha256"] != frame["sha256"] or based["generation"] != frame["generation"]:
        _fail("frame_mismatch", "proposal based_on_frame disagrees with observation frame")

    if action["type"] not in _HOLDINGS_INPUT_TYPES:
        _fail("policy", "Holdings proposal action must be an input action")
    if action["type"] == "click":
        if not (0 <= action["x"] < frame["width"] and 0 <= action["y"] < frame["height"]):
            _fail("out_of_bounds", "click coordinates outside frame bounds")

    expectation = proposal["expectation"]
    if expectation.get("type") != "state_sha256_change":
        _fail("bad_shape", "Holdings expectation must be state_sha256_change")
    if expectation["before"] != truth["state_sha256"]:
        _fail("frame_mismatch", "expectation before digest disagrees with ground_truth")
    if expectation["min_tick"] < truth["tick"] + 1:
        _fail("bad_shape", "expectation min_tick must advance past observed ground_truth tick")
    if expectation["min_tick"] > expectation["max_tick"]:
        _fail("bad_shape", "expectation tick window is inverted")

    return copy.deepcopy(proposal)


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


def plan(
    observation: dict,
    element_table: dict | None = None,
    goal: str | None = None,
    *,
    proposal_id: str = DEFAULT_HOLDINGS_PROPOSAL_ID,
    tick_window: int = DEFAULT_TICK_WINDOW,
    max_ms: int = DEFAULT_HOLDINGS_MAX_MS,
    max_retries: int = 0,
    action: dict | None = None,
) -> dict:
    """Produce a Holdings action_proposal/v0.2 or an element-table click plan."""
    if element_table is None and goal is None:
        return plan_holdings(
            observation,
            proposal_id=proposal_id,
            tick_window=tick_window,
            max_ms=max_ms,
            max_retries=max_retries,
            action=action,
        )

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
    click_action = {
        "type": "click",
        "x": click_x,
        "y": click_y,
        "button": "left",
    }
    if "ground_truth" in observation:
        if type(tick_window) is not int or tick_window < 1:
            _fail("bad_shape", "tick_window must be a positive integer")
        truth = observation["ground_truth"]
        expectation = {
            "type": "state_sha256_change",
            "before": truth["state_sha256"],
            "min_tick": truth["tick"] + 1,
            "max_tick": truth["tick"] + tick_window,
        }
    else:
        expectation = {
            "type": "changed_region",
            "bbox": {"x": bx, "y": by, "w": bw, "h": bh},
        }
    response = {
        "action": click_action,
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
    if (
        element_table is None
        and isinstance(response, dict)
        and response.get("schema") == "action_proposal/v0.2"
    ):
        return recheck_holdings_proposal(response, observation)

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

    if isinstance(action, dict) and action.get("type") == "lane_submit":
        _fail("policy", "lane_submit is forbidden")

    try:
        _check_action(action)
        _check_expectation(expectation)
    except ToolValidationError as exc:
        _fail("bad_shape", str(exc))

    if action.get("type") != "click" or action.get("button") != "left":
        _fail("bad_shape", "planner action must be a left click")

    click_x, click_y = action["x"], action["y"]
    if not (0 <= click_x < frame["width"] and 0 <= click_y < frame["height"]):
        _fail("out_of_bounds", "click coordinates outside frame bounds")

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
    if "ground_truth" in observation and expectation.get("type") == "state_sha256_change":
        truth = observation["ground_truth"]
        if expectation["before"] != truth["state_sha256"]:
            _fail("frame_mismatch", "expectation before digest disagrees with ground_truth")
        if expectation["min_tick"] < truth["tick"] + 1:
            _fail("bad_shape", "expectation min_tick must advance past observed tick")
    else:
        if expectation.get("type") != "changed_region":
            _fail("bad_shape", "planner expectation must be changed_region")
        exp_bbox = expectation["bbox"]
        if (
            exp_bbox["x"] < 0
            or exp_bbox["y"] < 0
            or exp_bbox["x"] + exp_bbox["w"] > frame["width"]
            or exp_bbox["y"] + exp_bbox["h"] > frame["height"]
        ):
            _fail("out_of_bounds", "expectation bbox outside frame bounds")
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


def _read_stdin_request(stream) -> tuple[str, dict]:
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

    if not isinstance(parsed, dict) or not parsed:
        _fail("bad_shape", "planner input must be a JSON object")

    keys = set(parsed)
    if keys == _REQUEST_KEYS:
        return "wender_envelope", parsed
    if "schema" in parsed and "frame_ref" in parsed:
        return "observation", parsed
    if "observation" in parsed and keys <= _OBSERVATION_WRAPPER_KEYS:
        return "observation_wrapper", parsed

    _fail("bad_shape", "planner request must be an observation or {observation, element_table, goal}")
    raise AssertionError("unreachable")


def invoke_planner_cmd(
    observation: dict,
    *,
    command: list[str] | tuple[str, ...],
    proposal_id: str = DEFAULT_HOLDINGS_PROPOSAL_ID,
    max_ms: int = DEFAULT_HOLDINGS_MAX_MS,
    max_retries: int = 0,
    timeout_s: float = 10.0,
) -> dict:
    """Invoke an external planner command over stdin/stdout using wender_bridge._run_bounded."""
    parsed_cmd = list(command) if isinstance(command, (list, tuple)) else None
    if (
        not isinstance(parsed_cmd, list)
        or not parsed_cmd
        or any(
            not isinstance(arg, str)
            or not arg
            or "\x00" in arg
            or _SURROGATE_RE.search(arg)
            for arg in parsed_cmd
        )
    ):
        _fail("bad_shape", "planner command must be a non-empty JSON argv list")

    frame, _ = _validate_holdings_observation(observation)
    payload_bytes = canonical_json(observation).encode("utf-8")
    agents_root = str(Path(__file__).resolve().parents[1])
    env: dict[str, str] = {
        "PYTHONPATH": agents_root,
        "PYTHONDONTWRITEBYTECODE": "1",
    }

    try:
        completed = _run_bounded(
            parsed_cmd,
            cwd=agents_root,
            env=env,
            request=payload_bytes,
            timeout=timeout_s,
        )
    except Exception as exc:
        raise PlannerError("bad_shape", f"external planner execution failed: {exc}") from exc

    if completed.returncode != 0:
        _fail("bad_shape", "external planner exited nonzero")

    try:
        decoded = json.loads(
            completed.stdout.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_constant,
            parse_float=_checked_float,
        )
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise PlannerError("bad_shape", "external planner output is not valid JSON") from exc

    if not isinstance(decoded, dict):
        _fail("bad_shape", "external planner output must be a JSON object")

    if decoded.get("schema") == "action_proposal/v0.2":
        proposal = copy.deepcopy(decoded)
        if proposal_id != DEFAULT_HOLDINGS_PROPOSAL_ID:
            proposal["proposal_id"] = proposal_id
        return recheck_holdings_proposal(proposal, observation)

    if set(decoded) >= {"action", "expectation"}:
        proposal = {
            "schema": "action_proposal/v0.2",
            "proposal_id": proposal_id,
            "surface_id": frame["surface_id"],
            "based_on_frame": {
                "sha256": frame["sha256"],
                "generation": frame["generation"],
            },
            "action": decoded["action"],
            "expectation": decoded["expectation"],
            "budget": {
                "max_ms": max_ms,
                "max_retries": max_retries,
            },
        }
        return recheck_holdings_proposal(proposal, observation)

    _fail("bad_shape", "external planner output is not a valid proposal")
    raise AssertionError("unreachable")


def main(
    argv: list[str] | tuple[str, ...] | None = None,
    *,
    stdin=None,
    stdout=None,
    stderr=None,
) -> int:
    """Pipe CLI entry: read request or observation JSON on stdin, write JSON on stdout."""
    args = list(sys.argv[1:] if argv is None else argv)
    in_stream = sys.stdin if stdin is None else stdin
    out_stream = sys.stdout if stdout is None else stdout
    err_stream = sys.stderr if stderr is None else stderr

    if args:
        print("bad_shape: planner CLI takes no positional arguments or flags", file=err_stream)
        return EXIT_CODES["bad_shape"]

    try:
        mode, request = _read_stdin_request(in_stream)
        if mode == "wender_envelope":
            response = plan(
                request["observation"],
                request["element_table"],
                request["goal"],
            )
        elif mode == "observation":
            response = plan_holdings(request)
        else:
            kwargs = {k: v for k, v in request.items() if k != "observation"}
            response = plan_holdings(request["observation"], **kwargs)
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
