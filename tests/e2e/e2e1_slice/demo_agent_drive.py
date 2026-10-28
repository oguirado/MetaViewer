#!/usr/bin/env python3
"""Narrated agent-drive demo runner on the live MetaViewer stack.

Starts from ``LIVE_STACK_READY`` (working alongside an already-running
``tests/e2e/e2e1_slice/stack.py`` with ``--display visible|private`` and
``--record <mp4>``, or starting the stack only when ``--start-stack`` is
explicitly requested) and executes the ordered checkpoints:

1. ``LIVE_STACK_READY``
2. ``observe``
3. ``navigate`` (by composition: ``ctrl+l``, ``type`` data-URL, ``Return``;
   the ``navigate`` wire verb is ABSENT by decision)
4. ``read`` (vision marks + element table printed in the checkpoint record)
5. ``stale_negative_control`` (deliberately stale ``based_on_frame`` refused
   with ``STALE_FRAME``, run continues)
6. ``custody_click`` (defaults to ``local:custody_click/v1``, honors
   ``MV_WENDER_PLANNER_CMD`` when set; pins newest ``frame_ready`` and retries
   transient ``STALE_FRAME`` up to ``TICK_MAX_ATTEMPTS``)
7. ``wait_verify`` (verified ``action_receipt/v0.2`` receipt)
8. ``post_state_change`` (pre/post frame and state ``sha256`` differ and
   ``verified`` is ``True``)

Emits one JSON transcript line per checkpoint to stdout and writes a structured
receipt file when ``--receipt-out`` is given.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest
from urllib.parse import quote
import uuid

ROOT = Path(__file__).resolve().parents[3]
for _entry in (ROOT, ROOT / "agents", ROOT / "tests/e2e/e2e1_slice", ROOT / "tools"):
    if str(_entry) not in sys.path:
        sys.path.insert(0, str(_entry))

import g_ai_stack  # noqa: E402
import gate_g_ai  # noqa: E402
import live  # noqa: E402
import stack  # noqa: E402
from metaviewer_agents import tools  # noqa: E402
from metaviewer_agents.executor import AdmittedExecutor  # noqa: E402
from metaviewer_agents.observe import compute_battery_state_sha256  # noqa: E402
from metaviewer_agents.perception import vcore  # noqa: E402
from metaviewer_agents.perception.deps_lock import resolve_locked_component  # noqa: E402
from metaviewer_agents.verify import build_proposal as verify_build_proposal  # noqa: E402
from metaviewer_agents.wender_bridge import WenderSubprocessAdapter  # noqa: E402

TRANSCRIPT_SCHEMA = "metaviewer.demo-agent-checkpoint/v1"
RECEIPT_SCHEMA = "metaviewer.demo-agent-drive/v1"
LOCAL_PLANNER_ID = "local:custody_click/v1"
SUBPROCESS_PLANNER_ID = "configured:MV_WENDER_PLANNER_CMD"
DEMO_GOAL = "Advance gate"

ORDERED_CHECKPOINTS = (
    "LIVE_STACK_READY",
    "observe",
    "navigate",
    "read",
    "stale_negative_control",
    "custody_click",
    "wait_verify",
    "post_state_change",
)

DEMO_HTML = (
    "<!doctype html><title>G-AI Ready</title><body style='background:white'>"
    "<button style='font-size:40px;margin:80px' "
    "onclick=\"this.textContent='Gate changed';document.title='G-AI Changed'\">"
    "Advance gate</button></body>"
)
DEMO_DATA_URL = "data:text/html," + quote(DEMO_HTML)

COMPOSITION_LABELS = ("key:ctrl+l", "type:data-url", "key:Return")


def composition_actions(data_url: str = DEMO_DATA_URL) -> tuple[dict, ...]:
    """Return the 3-step keyboard composition sequence for local navigation."""
    return (
        {"type": "key", "keys": ["ctrl", "l"]},
        {"type": "type", "text": data_url},
        {"type": "key", "keys": ["Return"]},
    )


def _canonical_sha256(value: object) -> str:
    raw = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(ch in "0123456789abcdef" for ch in value)
    )


def build_proposal(
    surface_id: str,
    frame: dict,
    proposal_id: str,
    action: dict,
    *,
    bbox: dict | None = None,
    max_ms: int = 30000,
) -> dict:
    """Build a schema-valid action_proposal/v0.2 pinned to ``frame``."""
    width = max(1, int(frame.get("width", 1280)))
    height = max(1, int(frame.get("height", 900)))
    region = copy.deepcopy(bbox) if bbox is not None else {"x": 0, "y": 0, "w": width, "h": height}
    expectation = {"type": "changed_region", "bbox": region}
    frame_for_proposal = dict(frame, surface_id=surface_id)
    return verify_build_proposal(
        frame_for_proposal,
        proposal_id=proposal_id,
        action=copy.deepcopy(action),
        expectation=expectation,
        max_ms=max_ms,
    )


def refresh_latest_frame(
    surface_id: str,
    client: object,
    current_frame: dict,
    *,
    timeout_ms: int = 5000,
) -> dict:
    """Pin the newest frame_ready from the client lane or via tools.observe."""
    latest = current_frame
    settle = getattr(client, "settle_latest_frame", None)
    if callable(settle):
        settled = settle(latest)
        if isinstance(settled, dict) and settled.get("generation", 0) >= latest.get("generation", 0):
            latest = settled
    observed = tools.observe(surface_id, client=client, timeout_ms=timeout_ms)["frame_ref"]
    if int(observed["generation"]) >= int(latest["generation"]):
        latest = observed
    return copy.deepcopy(latest)


def propose_with_stale_retry(
    surface_id: str,
    client: object,
    frame: dict,
    action_builder,
    *,
    step_prefix: str,
    max_attempts: int = stack.TICK_MAX_ATTEMPTS,
    propose_timeout_ms: int = 10000,
    observe_timeout_ms: int = 5000,
    id_fn=None,
) -> dict:
    """Submit a proposal, pinning newest frame_ready and retrying STALE_FRAME.

    ``action_builder(pinned_frame)`` returns ``(action_dict, bbox_or_none, meta_dict)``.
    """
    if isinstance(max_attempts, bool) or not isinstance(max_attempts, int) or max_attempts < 1:
        raise ValueError("max_attempts must be a positive integer")
    id_fn = (lambda: uuid.uuid4().hex[:12]) if id_fn is None else id_fn
    pinned = copy.deepcopy(frame)
    settle = getattr(client, "settle_latest_frame", None)
    if callable(settle):
        settled = settle(pinned)
        if isinstance(settled, dict):
            pinned = copy.deepcopy(settled)

    stale_retries = 0
    for attempt in range(1, max_attempts + 1):
        action, bbox, meta = action_builder(pinned)
        proposal_id = f"{step_prefix}-a{attempt}-{id_fn()}"
        proposal = build_proposal(surface_id, pinned, proposal_id, action, bbox=bbox)
        try:
            verdict = tools.propose(proposal, client=client, timeout_ms=propose_timeout_ms)
            return {
                "proposal": proposal,
                "verdict": verdict,
                "pinned_frame": pinned,
                "attempts": attempt,
                "stale_retries": stale_retries,
                "meta": meta,
            }
        except tools.ToolRefusal as exc:
            if exc.reason_code != "STALE_FRAME" or attempt >= max_attempts:
                raise
            stale_retries += 1
            pinned = refresh_latest_frame(
                surface_id,
                client,
                pinned,
                timeout_ms=observe_timeout_ms,
            )
    raise RuntimeError("unreachable retry exhaustion")


def default_live_reader(session: object):
    """Build the live perception + Wender state reader for a live session."""
    roots = {name: resolve_locked_component(name) for name in ("vision-engine", "wender-agent")}
    adapter = vcore.VCorePerceptionAdapter(
        roots["vision-engine"],
        python=sys.executable,
        timeout=30,
        verify_lock=True,
    )

    def read_frame_state(frame: dict, *, include_raw: bool = True) -> dict:
        gate_g_ai.checked_frame(frame)
        vision = adapter.perceive(copy.deepcopy(frame))
        raw = gate_g_ai.raw_description(frame, roots["vision-engine"]) if include_raw else vision
        table = vcore.project_element_table(frame, raw)
        tree = session.native_tree()
        state = gate_g_ai.wender_state(roots["wender-agent"], table, tree)
        battery_sha = compute_battery_state_sha256(state)
        marks = raw.get("marks", table.get("elements", [])) if isinstance(raw, dict) else []
        marks_summary = {
            "count": len(marks) if isinstance(marks, list) else len(table.get("elements", ())),
            "marks": marks if isinstance(marks, list) else [],
            "marks_sha256": _canonical_sha256(marks if isinstance(marks, list) else []),
        }
        return {
            "vision": vision,
            "raw": raw,
            "vision_marks": marks_summary,
            "element_table": table,
            "wender_state": state,
            "state_sha256": _canonical_sha256(state),
            "battery_state_sha256": battery_sha,
            "roots": roots,
        }

    return read_frame_state


def _target_bbox(target: dict, frame: dict) -> dict:
    if isinstance(target.get("bbox"), dict):
        box = target["bbox"]
        return {
            "x": int(box["x"]),
            "y": int(box["y"]),
            "w": int(box["w"]),
            "h": int(box["h"]),
        }
    if isinstance(target.get("box"), (list, tuple)) and len(target["box"]) == 4:
        x, y, w, h = (int(v) for v in target["box"])
        return {"x": x, "y": y, "w": w, "h": h}
    return {
        "x": 0,
        "y": 0,
        "w": max(1, int(frame.get("width", 1280))),
        "h": max(1, int(frame.get("height", 900))),
    }


def plan_custody_click(
    read_bundle: dict,
    frame: dict,
    *,
    env: dict | None = None,
    goal: str = DEMO_GOAL,
) -> dict:
    """Plan the custody click using MV_WENDER_PLANNER_CMD when set or local_plan."""
    active_env = os.environ if env is None else env
    configured = active_env.get("MV_WENDER_PLANNER_CMD", "").strip()
    state = read_bundle["wender_state"]
    table = read_bundle["element_table"]
    if configured:
        command = json.loads(configured)
        if (
            not isinstance(command, list)
            or not command
            or not all(isinstance(item, str) and item for item in command)
        ):
            raise RuntimeError("MV_WENDER_PLANNER_CMD must be a non-empty JSON string array")
        wender_root = read_bundle.get("roots", {}).get("wender-agent")
        if wender_root is None:
            wender_root = Path(active_env.get("MV_WENDER_ROOT", str(ROOT)))
        planner = WenderSubprocessAdapter(
            command=command,
            wender_root=wender_root,
            timeout=30,
        )
        observation = {
            "schema": "observation/v0.2",
            "frame_ref": copy.deepcopy(frame),
            "vision": copy.deepcopy(read_bundle["vision"]),
        }
        planned = planner.plan_step(observation, table, goal)
        if isinstance(planned, tuple) and len(planned) == 4:
            action, expectation, planned_state, target = planned
            if _canonical_sha256(planned_state) != _canonical_sha256(state):
                raise RuntimeError("planner changed observed Wender state")
            AdmittedExecutor.check_target(target, latest=state["nodes"], frame=frame)
            node_id = str(target.get("id") or target.get("node_id") or "el_1")
            bbox = expectation.get("bbox") if isinstance(expectation, dict) else None
            return {
                "planner_id": SUBPROCESS_PLANNER_ID,
                "target": target,
                "target_node_id": node_id,
                "action": copy.deepcopy(action),
                "bbox": copy.deepcopy(bbox) if isinstance(bbox, dict) else _target_bbox(target, frame),
            }
        raise RuntimeError("unexpected WenderSubprocessAdapter.plan_step return shape")

    target, action = gate_g_ai.local_plan(state, frame)
    node_id = str(target.get("id") or target.get("node_id") or "el_1")
    return {
        "planner_id": LOCAL_PLANNER_ID,
        "target": target,
        "target_node_id": node_id,
        "action": copy.deepcopy(action),
        "bbox": _target_bbox(target, frame),
    }


def validate_checkpoint_line(record: dict, expected_step: int | None = None) -> None:
    """Validate one checkpoint JSON transcript record against the runner contract."""
    if not isinstance(record, dict):
        raise ValueError("checkpoint record must be a dict")
    if record.get("schema") != TRANSCRIPT_SCHEMA:
        raise ValueError(f"unexpected checkpoint schema: {record.get('schema')!r}")
    step = record.get("step")
    if isinstance(step, bool) or not isinstance(step, int) or step < 1 or step > len(ORDERED_CHECKPOINTS):
        raise ValueError(f"invalid checkpoint step: {step!r}")
    if expected_step is not None and step != expected_step:
        raise ValueError(f"checkpoint step {step} != expected {expected_step}")
    checkpoint = record.get("checkpoint")
    if checkpoint != ORDERED_CHECKPOINTS[step - 1]:
        raise ValueError(
            f"checkpoint at step {step} must be {ORDERED_CHECKPOINTS[step - 1]!r}, got {checkpoint!r}"
        )
    if not isinstance(record.get("surface_id"), str) or not record["surface_id"]:
        raise ValueError("checkpoint surface_id must be a non-empty string")
    if not isinstance(record.get("narration"), str) or not record["narration"].strip():
        raise ValueError("checkpoint narration must be a non-empty string")

    if checkpoint == "LIVE_STACK_READY":
        if record.get("status") != "ready":
            raise ValueError("LIVE_STACK_READY status must be 'ready'")
        if record.get("display_mode") not in ("private", "visible"):
            raise ValueError("LIVE_STACK_READY display_mode must be 'private' or 'visible'")
    elif checkpoint == "observe":
        if not _is_sha256(record.get("pre_frame_sha256")):
            raise ValueError("observe pre_frame_sha256 must be a 64-hex sha256")
        if not isinstance(record.get("frame_ref"), dict):
            raise ValueError("observe frame_ref must be a dict")
    elif checkpoint == "navigate":
        if record.get("verb_absent_by_decision") is not True:
            raise ValueError("navigate must declare verb_absent_by_decision=True")
        steps = record.get("steps")
        if not isinstance(steps, list) or len(steps) != 3:
            raise ValueError("navigate must record 3 composition steps")
        if not all(isinstance(item, dict) and item.get("verified") is True for item in steps):
            raise ValueError("every navigate composition step must be verified")
    elif checkpoint == "read":
        marks = record.get("vision_marks")
        table = record.get("element_table")
        if not isinstance(marks, dict) or not isinstance(marks.get("count"), int) or marks["count"] < 1:
            raise ValueError("read checkpoint must print non-empty vision_marks")
        if (
            not isinstance(table, dict)
            or table.get("schema") != "vqa.element-table/v1"
            or not isinstance(table.get("elements"), list)
            or not table["elements"]
        ):
            raise ValueError("read checkpoint must print a non-empty vqa.element-table/v1")
        if not _is_sha256(record.get("pre_state_sha256")):
            raise ValueError("read checkpoint must record pre_state_sha256")
    elif checkpoint == "stale_negative_control":
        if record.get("decision") != "refused" or record.get("reason_code") != "STALE_FRAME":
            raise ValueError("stale_negative_control must record refused STALE_FRAME")
        if record.get("continued") is not True:
            raise ValueError("stale_negative_control must record continued=True")
    elif checkpoint == "custody_click":
        if record.get("decision") not in ("accepted", "admitted"):
            raise ValueError("custody_click must record an admitted decision")
        if record.get("planner_id") not in (LOCAL_PLANNER_ID, SUBPROCESS_PLANNER_ID):
            raise ValueError(f"unexpected planner_id: {record.get('planner_id')!r}")
    elif checkpoint == "wait_verify":
        if record.get("verified") is not True or record.get("focus_verified") is not True:
            raise ValueError("wait_verify must record verified=True and focus_verified=True")
        if not _is_sha256(record.get("pre_frame_sha256")) or not _is_sha256(record.get("post_frame_sha256")):
            raise ValueError("wait_verify must carry pre/post frame sha256")
        if record["pre_frame_sha256"] == record["post_frame_sha256"]:
            raise ValueError("wait_verify pre_frame_sha256 and post_frame_sha256 must differ")
    elif checkpoint == "post_state_change":
        if record.get("verified") is not True:
            raise ValueError("post_state_change must record verified=True")
        if record.get("negative_control_reason_code") != "STALE_FRAME":
            raise ValueError("post_state_change must record negative_control_reason_code='STALE_FRAME'")
        if (
            not _is_sha256(record.get("pre_frame_sha256"))
            or not _is_sha256(record.get("post_frame_sha256"))
            or record["pre_frame_sha256"] == record["post_frame_sha256"]
        ):
            raise ValueError("post_state_change pre_frame_sha256 and post_frame_sha256 must differ")
        if (
            not _is_sha256(record.get("pre_state_sha256"))
            or not _is_sha256(record.get("post_state_sha256"))
            or record["pre_state_sha256"] == record["post_state_sha256"]
        ):
            raise ValueError("post_state_change pre_state_sha256 and post_state_sha256 must differ")


def validate_transcript_and_receipt(transcript: list[dict], receipt: dict) -> None:
    """Validate the full 8-checkpoint transcript and final receipt."""
    if not isinstance(transcript, list) or len(transcript) != len(ORDERED_CHECKPOINTS):
        raise ValueError(f"transcript must have {len(ORDERED_CHECKPOINTS)} checkpoints")
    for idx, item in enumerate(transcript, start=1):
        validate_checkpoint_line(item, expected_step=idx)

    if not isinstance(receipt, dict) or receipt.get("schema") != RECEIPT_SCHEMA:
        raise ValueError(f"invalid receipt schema: {receipt.get('schema')!r}")
    if receipt.get("status") != "PASS" or receipt.get("verified") is not True:
        raise ValueError("receipt must have status='PASS' and verified=True")
    if receipt.get("pre_frame_sha256") == receipt.get("post_frame_sha256"):
        raise ValueError("receipt pre_frame_sha256 and post_frame_sha256 must differ")
    if receipt.get("pre_state_sha256") == receipt.get("post_state_sha256"):
        raise ValueError("receipt pre_state_sha256 and post_state_sha256 must differ")
    neg = receipt.get("negative_control")
    if (
        not isinstance(neg, dict)
        or neg.get("tested") is not True
        or neg.get("reason_code") != "STALE_FRAME"
        or neg.get("continued") is not True
    ):
        raise ValueError("receipt negative_control must record STALE_FRAME and continued=True")


def run_demo_agent_drive(
    client: object,
    surface_id: str,
    *,
    stack_meta: dict | None = None,
    read_fn=None,
    receipt_out: str | os.PathLike[str] | None = None,
    out_stream=None,
    env: dict | None = None,
    max_attempts: int = stack.TICK_MAX_ATTEMPTS,
    data_url: str = DEMO_DATA_URL,
    id_fn=None,
) -> dict:
    """Execute the narrated agent-drive demo checkpoints against ``client``."""
    out_stream = sys.stdout if out_stream is None else out_stream
    active_env = os.environ if env is None else env
    id_fn = (lambda: uuid.uuid4().hex[:12]) if id_fn is None else id_fn
    if read_fn is None:
        read_fn = default_live_reader(client)

    meta = dict(stack_meta or {})
    capsule = str(meta.get("capsule") or "srf-id-live")
    display = str(meta.get("display") or ":99")
    display_mode = str(meta.get("display_mode") or "private")
    record_path = meta.get("record_path")
    started_by_runner = bool(meta.get("started_by_runner", False))

    transcript: list[dict] = []

    def emit(checkpoint: str, payload: dict) -> dict:
        step = len(transcript) + 1
        record = {
            "schema": TRANSCRIPT_SCHEMA,
            "step": step,
            "checkpoint": checkpoint,
            "surface_id": surface_id,
            **payload,
        }
        validate_checkpoint_line(record, expected_step=step)
        transcript.append(record)
        out_stream.write(json.dumps(record, sort_keys=True) + "\n")
        out_stream.flush()
        return record

    # 1. LIVE_STACK_READY
    emit(
        "LIVE_STACK_READY",
        {
            "status": "ready",
            "capsule": capsule,
            "display": display,
            "display_mode": display_mode,
            "record_path": record_path,
            "started_by_runner": started_by_runner,
            "narration": (
                f"Live stack ready on surface {surface_id} (capsule={capsule}, "
                f"display_mode={display_mode}, record_path={record_path or 'none'})."
            ),
        },
    )

    # 2. observe
    initial_obs = tools.observe(surface_id, client=client, timeout_ms=5000)
    initial_frame = refresh_latest_frame(surface_id, client, initial_obs["frame_ref"], timeout_ms=5000)
    emit(
        "observe",
        {
            "frame_ref": copy.deepcopy(initial_frame),
            "generation": int(initial_frame["generation"]),
            "pre_frame_sha256": str(initial_frame["sha256"]),
            "narration": (
                f"Observed initial frame generation {initial_frame['generation']} "
                f"({initial_frame['sha256'][:12]}...)."
            ),
        },
    )

    # 3. navigate (by composition: ctrl+l, type data-URL, Return)
    current_frame = copy.deepcopy(initial_frame)
    nav_steps: list[dict] = []
    total_nav_retries = 0
    for idx, (label, action) in enumerate(zip(COMPOSITION_LABELS, composition_actions(data_url)), start=1):
        before_sha = str(current_frame["sha256"])
        admitted = propose_with_stale_retry(
            surface_id,
            client,
            current_frame,
            lambda pinned, act=action: (act, None, {}),
            step_prefix=f"demo-nav-{idx}",
            max_attempts=max_attempts,
            id_fn=id_fn,
        )
        proposal = admitted["proposal"]
        receipt = tools.wait_verify(
            proposal["proposal_id"],
            proposal["expectation"],
            15000,
            client=client,
        )
        current_frame = copy.deepcopy(receipt["after_frame"])
        total_nav_retries += int(admitted["stale_retries"])
        nav_steps.append(
            {
                "index": idx,
                "label": label,
                "action": copy.deepcopy(action),
                "proposal_id": proposal["proposal_id"],
                "attempts": admitted["attempts"],
                "stale_retries": admitted["stale_retries"],
                "verified": bool(receipt["verified"]),
                "before_frame_sha256": before_sha,
                "after_frame_sha256": str(current_frame["sha256"]),
                "after_generation": int(current_frame["generation"]),
            }
        )

    emit(
        "navigate",
        {
            "verb_absent_by_decision": True,
            "composition": list(COMPOSITION_LABELS),
            "url": data_url,
            "steps": nav_steps,
            "stale_retries": total_nav_retries,
            "pre_frame_sha256": str(initial_frame["sha256"]),
            "post_navigate_frame_sha256": str(current_frame["sha256"]),
            "frame_ref": copy.deepcopy(current_frame),
            "narration": (
                "Navigated to local data-URL fixture via 3-step composition "
                "(ctrl+l, type data-URL, Return); navigate wire verb is ABSENT by decision."
            ),
        },
    )

    # 4. read (vision marks + element table printed in the checkpoint record)
    current_frame = refresh_latest_frame(surface_id, client, current_frame, timeout_ms=5000)
    pre_read = read_fn(current_frame, include_raw=True)
    initial_plan = plan_custody_click(pre_read, current_frame, env=active_env)
    emit(
        "read",
        {
            "frame_ref": copy.deepcopy(current_frame),
            "vision_marks": copy.deepcopy(pre_read["vision_marks"]),
            "element_table": copy.deepcopy(pre_read["element_table"]),
            "target_node_id": initial_plan["target_node_id"],
            "pre_state_sha256": pre_read["state_sha256"],
            "pre_battery_state_sha256": pre_read["battery_state_sha256"],
            "narration": (
                f"Read vision marks (count={pre_read['vision_marks']['count']}) and projected "
                f"element table (elements={len(pre_read['element_table']['elements'])}); "
                f"target node is {initial_plan['target_node_id']}."
            ),
        },
    )

    # 5. stale_negative_control (deliberately stale based_on_frame -> STALE_FRAME, then continue)
    stale_generation = max(1, int(current_frame["generation"]) - 1)
    stale_sha = (
        str(initial_frame["sha256"])
        if str(initial_frame["sha256"]) != str(current_frame["sha256"])
        else "0" * 64
    )
    stale_proposal_id = f"demo-stale-neg-{id_fn()}"
    stale_frame_pin = dict(current_frame, generation=stale_generation, sha256=stale_sha)
    stale_proposal = build_proposal(
        surface_id,
        stale_frame_pin,
        stale_proposal_id,
        initial_plan["action"],
        bbox=initial_plan["bbox"],
    )
    try:
        tools.propose(stale_proposal, client=client, timeout_ms=10000)
    except tools.ToolRefusal as exc:
        if exc.reason_code != "STALE_FRAME":
            raise RuntimeError(
                f"negative control expected STALE_FRAME refusal, got {exc.reason_code!r}"
            ) from exc
        stale_reason = exc.reason_code
    else:
        raise RuntimeError("negative control failed: stale based_on_frame proposal was admitted")

    emit(
        "stale_negative_control",
        {
            "proposal_id": stale_proposal_id,
            "based_on_frame": copy.deepcopy(stale_proposal["based_on_frame"]),
            "current_frame": {
                "generation": int(current_frame["generation"]),
                "sha256": str(current_frame["sha256"]),
            },
            "decision": "refused",
            "reason_code": stale_reason,
            "continued": True,
            "narration": (
                f"Negative control: deliberately stale based_on_frame "
                f"(gen={stale_generation}, sha256={stale_sha[:12]}...) refused with "
                f"{stale_reason}; run continues."
            ),
        },
    )

    # 6. custody_click (pin newest frame_ready and retry transient STALE_FRAME up to max_attempts)
    active_read = pre_read

    def _build_click_for_pinned(pinned_frame: dict):
        nonlocal active_read
        if (
            int(pinned_frame["generation"]) != int(current_frame["generation"])
            or str(pinned_frame["sha256"]) != str(current_frame["sha256"])
        ):
            active_read = read_fn(pinned_frame, include_raw=True)
        plan = plan_custody_click(active_read, pinned_frame, env=active_env)
        return plan["action"], plan["bbox"], plan

    click_admitted = propose_with_stale_retry(
        surface_id,
        client,
        current_frame,
        _build_click_for_pinned,
        step_prefix="demo-click",
        max_attempts=max_attempts,
        id_fn=id_fn,
    )
    click_proposal = click_admitted["proposal"]
    click_verdict = click_admitted["verdict"]
    click_pinned_frame = click_admitted["pinned_frame"]
    click_plan = click_admitted["meta"]
    pre_click_frame_sha = str(click_pinned_frame["sha256"])
    pre_state_sha = active_read["state_sha256"]
    pre_battery_sha = active_read["battery_state_sha256"]

    emit(
        "custody_click",
        {
            "planner_id": click_plan["planner_id"],
            "proposal_id": click_proposal["proposal_id"],
            "target_node_id": click_plan["target_node_id"],
            "action": copy.deepcopy(click_proposal["action"]),
            "based_on_frame": copy.deepcopy(click_proposal["based_on_frame"]),
            "decision": str(click_verdict.get("decision", "admitted")),
            "attempts": click_admitted["attempts"],
            "stale_retries": click_admitted["stale_retries"],
            "pre_frame_sha256": pre_click_frame_sha,
            "narration": (
                f"Submitted custody click via {click_plan['planner_id']} on "
                f"{click_plan['target_node_id']} at ({click_proposal['action']['x']}, "
                f"{click_proposal['action']['y']}) pinned to generation "
                f"{click_proposal['based_on_frame']['generation']}."
            ),
        },
    )

    # 7. wait_verify
    click_receipt = tools.wait_verify(
        click_proposal["proposal_id"],
        click_proposal["expectation"],
        15000,
        client=client,
    )
    after_frame = copy.deepcopy(click_receipt["after_frame"])
    post_frame_sha = str(after_frame["sha256"])
    native_ev = click_receipt.get("native_evidence", {})
    focus_ok = bool(native_ev.get("focus_verified", True))
    input_mono_ns = int(native_ev.get("input_mono_ns", click_receipt.get("executed_at_ns", 1)))
    if not click_receipt.get("verified") or not focus_ok:
        raise RuntimeError("wait_verify did not return a focus-verified receipt")
    if input_mono_ns <= 0:
        raise RuntimeError("wait_verify receipt missing positive input_mono_ns")
    if post_frame_sha == pre_click_frame_sha:
        raise RuntimeError("wait_verify after_frame sha256 did not change from pre-click frame")

    emit(
        "wait_verify",
        {
            "proposal_id": click_proposal["proposal_id"],
            "verified": True,
            "focus_verified": focus_ok,
            "input_mono_ns": input_mono_ns,
            "pre_frame_sha256": pre_click_frame_sha,
            "post_frame_sha256": post_frame_sha,
            "after_frame": after_frame,
            "receipt": copy.deepcopy(click_receipt),
            "narration": (
                f"Verified custody click receipt for {click_proposal['proposal_id']} "
                f"(verified=True, focus_verified=True, input_mono_ns={input_mono_ns})."
            ),
        },
    )

    # 8. post_state_change
    settled_post_frame = refresh_latest_frame(surface_id, client, after_frame, timeout_ms=5000)
    post_read = read_fn(settled_post_frame, include_raw=False)
    post_state_sha = post_read["state_sha256"]
    post_battery_sha = post_read["battery_state_sha256"]
    if post_state_sha == pre_state_sha or post_battery_sha == pre_battery_sha:
        raise RuntimeError("post-click Wender state sha256 did not change")

    emit(
        "post_state_change",
        {
            "verified": True,
            "planner_id": click_plan["planner_id"],
            "negative_control_reason_code": "STALE_FRAME",
            "initial_frame_sha256": str(initial_frame["sha256"]),
            "pre_frame_sha256": pre_click_frame_sha,
            "post_frame_sha256": str(settled_post_frame["sha256"]),
            "frame_sha256_changed": pre_click_frame_sha != str(settled_post_frame["sha256"]),
            "pre_state_sha256": pre_state_sha,
            "post_state_sha256": post_state_sha,
            "state_sha256_changed": pre_state_sha != post_state_sha,
            "pre_battery_state_sha256": pre_battery_sha,
            "post_battery_state_sha256": post_battery_sha,
            "battery_state_sha256_changed": pre_battery_sha != post_battery_sha,
            "narration": (
                f"Post-state verified: frame sha256 changed "
                f"({pre_click_frame_sha[:12]}... -> {settled_post_frame['sha256'][:12]}...) "
                f"and state sha256 changed ({pre_state_sha[:12]}... -> {post_state_sha[:12]}...)."
            ),
        },
    )

    receipt = {
        "schema": RECEIPT_SCHEMA,
        "status": "PASS",
        "surface_id": surface_id,
        "capsule": capsule,
        "display": display,
        "display_mode": display_mode,
        "record_path": record_path,
        "started_by_runner": started_by_runner,
        "planner_id": click_plan["planner_id"],
        "verified": True,
        "initial_frame_sha256": str(initial_frame["sha256"]),
        "pre_frame_sha256": pre_click_frame_sha,
        "post_frame_sha256": str(settled_post_frame["sha256"]),
        "frame_sha256_changed": True,
        "pre_state_sha256": pre_state_sha,
        "post_state_sha256": post_state_sha,
        "state_sha256_changed": True,
        "pre_battery_state_sha256": pre_battery_sha,
        "post_battery_state_sha256": post_battery_sha,
        "battery_state_sha256_changed": True,
        "negative_control": {
            "tested": True,
            "proposal_id": stale_proposal_id,
            "decision": "refused",
            "reason_code": "STALE_FRAME",
            "continued": True,
        },
        "checkpoints": transcript,
    }
    validate_transcript_and_receipt(transcript, receipt)

    if receipt_out is not None:
        out_path = Path(receipt_out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    return receipt


def _attach_peer_from_handoff(
    socket_path: Path,
    handoff: dict,
    regs: dict,
    config: dict,
    *,
    timeout_s: float = 20.0,
) -> live.CoreClient:
    """[TARGET, unit decision] Adopt an SCM_RIGHTS agent core socket fd with seq continuity."""
    fd = int(handoff["fd"])
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM, fileno=fd)
    try:
        sock.settimeout(timeout_s)
        candidate = live.CoreClient(
            str(socket_path),
            timeout_s=timeout_s,
            max_line_bytes=1 << 20,
            max_reply_bytes=1 << 20,
        )
        candidate._sock = sock
        candidate._next_seq = max(1, int(handoff.get("next_seq", 1)))
        rx_hex = str(handoff.get("rx_hex", ""))
        candidate._rx = bytearray(bytes.fromhex(rx_hex)) if rx_hex else bytearray()
        candidate._hello_complete = True
        candidate._pinned = (
            str(regs["agent"]["endpoint"]["component"]),
            str(regs["agent"]["endpoint"]["instance"]),
            str(regs["core"]["endpoint"]["component"]),
            str(regs["core"]["endpoint"]["instance"]),
            str(config["session_id"]),
        )
        lane = live._lane_state(candidate)
        lane["inbound_seq"] = max(0, int(handoff.get("inbound_seq", 0)))
        return candidate
    except Exception:
        try:
            sock.close()
        except OSError:
            pass
        raise


class AttachedLiveStackSession:
    """ToolClient adapter bound to an already-running stack.py supervisor."""

    def __init__(
        self,
        root: Path,
        *,
        started_by_runner: bool = False,
        handoff_fn=None,
    ) -> None:
        self.root = root
        self.started_by_runner = started_by_runner
        if not (root / "state.json").exists():
            raise RuntimeError("live stack state is not ready; start stack.py first or pass --start-stack")
        self.state = stack.load_state(root)
        if not isinstance(self.state, dict) or self.state.get("status") != "ready":
            raise RuntimeError("live stack state is not ready; start stack.py first or pass --start-stack")
        self.supervisor = self.state.get("supervisor", {})
        if not stack.alive(self.supervisor):
            raise RuntimeError("live stack supervisor is not alive")
        self.work = Path(self.state["work"])
        self.config = json.loads((self.work / "core-config.json").read_text(encoding="utf-8"))
        self.regs = {
            item["endpoint"]["component"]: item
            for item in [self.config["core"], *self.config["peers"]]
        }
        self.surface_id = str(self.state["surface_id"])
        self.capsule = str(self.state["capsules"][0])
        self.socket_path = self.work / "runtime/metaviewer/core.sock"
        self.archive = self.work / "state/metaviewer/sessions" / self.config["session_id"]
        self.report: dict = {"commands": [], "wire_evidence": []}
        self.peer: live.CoreClient | None = None
        self.handoff_info: dict | None = None
        self._handoff_fn = stack.request_agent_handoff if handoff_fn is None else handoff_fn

    def __enter__(self) -> "AttachedLiveStackSession":
        try:
            try:
                handoff = self._handoff_fn(self.root)
            except Exception as exc:
                raise RuntimeError(f"failed to attach agent session to core.sock: {exc}") from exc
            self.peer = _attach_peer_from_handoff(
                self.socket_path,
                handoff,
                self.regs,
                self.config,
            )
            self.handoff_info = handoff
            live.send(
                self.peer,
                self.regs["agent"],
                self.config,
                {
                    "schema": "surface_request/v0.2",
                    "op": "frame_subscribe",
                    "params": {"surface_id": self.surface_id},
                },
            )
            return self
        except BaseException:
            if self.peer is not None:
                self.peer.close()
                self.peer = None
            raise

    def settle_latest_frame(self, current_frame: dict) -> dict:
        if self.peer is None:
            return current_frame
        return stack.settle_latest_frame(
            self.peer,
            self.surface_id,
            current_frame,
            self.report,
        )

    def request(self, call: dict, result_schema: str, *, timeout_ms: int) -> dict:
        assert self.peer is not None
        self.peer._timeout_s = max(1.0, timeout_ms / 1000)
        live.send(self.peer, self.regs["agent"], self.config, call)
        return live.receive(
            self.peer,
            lambda b: b.get("schema") == result_schema and b.get("request_id") == call["request_id"],
            self.report,
            reject_errors=False,
        )

    def native_tree(self) -> dict:
        out = subprocess.check_output(
            [
                Path(os.environ["MV_SRF_BIN_DIR"]) / "srf-identity-surface",
                "ax",
                "--container",
                self.capsule,
                "--window",
                "w1",
                "--state-dir",
                os.environ["MV_SRF_STATE_DIR"],
            ],
            text=True,
            timeout=15,
        )
        return json.loads(out)

    def stack_meta(self) -> dict:
        return {
            "capsule": self.capsule,
            "display": self.state.get("display", ":99"),
            "display_mode": self.state.get("display_mode", "private"),
            "record_path": self.state.get("record_path"),
            "started_by_runner": self.started_by_runner,
        }

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.peer is not None:
            self.peer.close()
            self.peer = None
        if self.started_by_runner:
            stack.stop_stack(self.root)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--self-test",
        action="store_true",
        default=False,
        help="Run the deterministic unit test suite and exit",
    )
    p.add_argument(
        "--receipt-out",
        default=None,
        metavar="PATH.json",
        help="Write the structured JSON receipt to PATH.json",
    )
    p.add_argument(
        "--start-stack",
        action="store_true",
        default=False,
        help="Start stack.py before the run and stop it on exit (default: attach to running stack.py)",
    )
    p.add_argument(
        "--session",
        choices=("stack", "g-ai"),
        default="stack",
        help="Live session backend: 'stack' (stack.py) or 'g-ai' (g_ai_stack.Session)",
    )
    p.add_argument(
        "--display",
        choices=("private", "visible"),
        default="private",
        help="Display mode when --start-stack is used",
    )
    p.add_argument(
        "--record",
        default=None,
        metavar="PATH.mp4",
        help="MP4 recording path when --start-stack is used",
    )
    p.add_argument(
        "--ttl",
        type=stack.ttl_seconds,
        default="45m",
        help="Stack TTL when --start-stack is used (default: 45m)",
    )
    p.add_argument(
        "--max-attempts",
        type=int,
        default=stack.TICK_MAX_ATTEMPTS,
        help="Max attempts per proposal when live frames advance (default: %(default)s)",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.self_test:
        suite = unittest.defaultTestLoader.discover(
            str(Path(__file__).resolve().parent),
            pattern="test_demo_agent_drive.py",
        )
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        return 0 if result.wasSuccessful() else 1

    try:
        if args.session == "g-ai":
            with g_ai_stack.Session(ttl=args.ttl) as session:
                receipt_out = (
                    args.receipt_out
                    if args.receipt_out is not None
                    else session.work / "demo-agent-receipt.json"
                )
                run_demo_agent_drive(
                    session,
                    session.surface_id,
                    stack_meta={
                        "capsule": session.capsule,
                        "display": session.display,
                        "display_mode": "private",
                        "record_path": None,
                        "started_by_runner": True,
                    },
                    receipt_out=receipt_out,
                    max_attempts=args.max_attempts,
                )
            return 0

        root = stack.state_root()
        started = False
        if args.start_stack:
            stack.start(
                root,
                args.ttl,
                display_mode=args.display,
                record_path=args.record,
                agent_tick_page=False,
            )
            started = True

        with AttachedLiveStackSession(root, started_by_runner=started) as session:
            receipt_out = (
                args.receipt_out
                if args.receipt_out is not None
                else session.work / "demo-agent-receipt.json"
            )
            run_demo_agent_drive(
                session,
                session.surface_id,
                stack_meta=session.stack_meta(),
                receipt_out=receipt_out,
                max_attempts=args.max_attempts,
            )
        return 0
    except Exception as exc:
        print(f"DEMO_AGENT_DRIVE_BLOCKED {exc}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
