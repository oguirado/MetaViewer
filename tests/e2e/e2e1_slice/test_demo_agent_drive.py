"""Offline unit tests for demo_agent_drive.py with an injected peer."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "demo_agent_drive", Path(__file__).with_name("demo_agent_drive.py")
)
assert SPEC is not None and SPEC.loader is not None
demo_agent_drive = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(demo_agent_drive)

ROOT = demo_agent_drive.ROOT
LOCAL_PLANNER_ID = demo_agent_drive.LOCAL_PLANNER_ID
SUBPROCESS_PLANNER_ID = demo_agent_drive.SUBPROCESS_PLANNER_ID
ORDERED_CHECKPOINTS = demo_agent_drive.ORDERED_CHECKPOINTS
POST_FRAME_CHANGE_MAX_S = demo_agent_drive.POST_FRAME_CHANGE_MAX_S
POST_FRAME_CHANGE_POLL_S = demo_agent_drive.POST_FRAME_CHANGE_POLL_S
POST_FRAME_CHANGE_METHOD = demo_agent_drive.POST_FRAME_CHANGE_METHOD
AttachedLiveStackSession = demo_agent_drive.AttachedLiveStackSession
WenderSubprocessAdapter = demo_agent_drive.WenderSubprocessAdapter
_canonical_sha256 = demo_agent_drive._canonical_sha256
run_demo_agent_drive = demo_agent_drive.run_demo_agent_drive
stack = demo_agent_drive.stack
tools = demo_agent_drive.tools
validate_partial_receipt = demo_agent_drive.validate_partial_receipt
validate_transcript_and_receipt = demo_agent_drive.validate_transcript_and_receipt


class InjectedDemoPeer:
    """Deterministic injected ToolClient peer for unit testing demo_agent_drive."""

    def __init__(
        self,
        *,
        surface_id: str = "surface-demo-1",
        transient_stale_on_nav_step1: int = 0,
        transient_stale_on_click: int = 0,
        accept_stale_negative_control: bool = False,
        noop_focus_on_nav_step1: bool = False,
        unverified_nav_steps: tuple[int, ...] = (),
        unverified_nav_step_changes_frame: bool = False,
        late_frame_change_polls_by_nav_step: dict[int, int] | None = None,
    ) -> None:
        self.surface_id = surface_id
        self.transient_stale_on_nav_step1 = transient_stale_on_nav_step1
        self.transient_stale_on_click = transient_stale_on_click
        self.accept_stale_negative_control = accept_stale_negative_control
        self.noop_focus_on_nav_step1 = noop_focus_on_nav_step1
        self.unverified_nav_steps = set(unverified_nav_steps)
        self.unverified_nav_step_changes_frame = unverified_nav_step_changes_frame
        self.late_frame_change_polls_by_nav_step = dict(
            late_frame_change_polls_by_nav_step or {}
        )
        self.generation = 1
        self.calls: list[dict] = []
        self.proposals: dict[str, dict] = {}
        self.report: dict = {"wire_evidence": []}
        self.frames: dict[int, dict] = {1: self._make_frame(1, b"initial-frame-gen-1")}
        self._nav1_attempts = 0
        self._click_attempts = 0
        self._clicked = False
        self._pending_late_frame_change: dict | None = None
        self.late_frame_poll_counts: dict[int, int] = {}

    def _make_frame(self, generation: int, seed: bytes, *, digest: str | None = None) -> dict:
        sha = hashlib.sha256(seed).hexdigest() if digest is None else digest
        return {
            "schema": "frame_ref/v0.2",
            "surface_id": self.surface_id,
            "generation": generation,
            "tick": generation,
            "ts_ns": generation * 1_000_000,
            "width": 1280,
            "height": 900,
            "format": "rgb24",
            "ramws_path": f"/dev/shm/mv-demo-{self.surface_id}-{generation}.rgb",
            "sha256": sha,
            "capture_us": 100,
        }

    def current_frame(self) -> dict:
        return copy.deepcopy(self.frames[self.generation])

    def advance_frame(self, tag: str, *, same_digest: bool = False) -> dict:
        prev_digest = self.frames[self.generation]["sha256"]
        self.generation += 1
        frame = self._make_frame(
            self.generation,
            f"frame-{self.generation}-{tag}".encode("utf-8"),
            digest=prev_digest if same_digest else None,
        )
        self.frames[self.generation] = frame
        return copy.deepcopy(frame)

    def settle_latest_frame(self, current_frame: dict) -> dict:
        return self.current_frame()

    def request(self, call: dict, result_schema: str, *, timeout_ms: int) -> dict:
        assert result_schema == "mv_tool_result/v0.2"
        assert timeout_ms >= 1
        self.calls.append(copy.deepcopy(call))
        req_id = call["request_id"]
        op = call["op"]
        args = call["args"]

        if op == "observe":
            if self._pending_late_frame_change is not None:
                pending = self._pending_late_frame_change
                step_idx = int(pending["nav_step"])
                self.late_frame_poll_counts[step_idx] = (
                    self.late_frame_poll_counts.get(step_idx, 0) + 1
                )
                pending["polls_remaining"] -= 1
                if pending["polls_remaining"] <= 0:
                    self._pending_late_frame_change = None
                    late_frame = self.advance_frame(
                        f"{pending['prop_id']}-late-paint",
                        same_digest=False,
                    )
                    self.report["wire_evidence"].append(
                        {
                            "schema": "surface_event/v0.2",
                            "event": "frame_ready",
                            "data": {"frame_ref": copy.deepcopy(late_frame)},
                        }
                    )
                else:
                    unchanged_frame = self.advance_frame(
                        f"{pending['prop_id']}-unchanged-poll-{pending['polls_remaining']}",
                        same_digest=True,
                    )
                    self.report["wire_evidence"].append(
                        {
                            "schema": "surface_event/v0.2",
                            "event": "frame_ready",
                            "data": {"frame_ref": copy.deepcopy(unchanged_frame)},
                        }
                    )
            return {
                "schema": "mv_tool_result/v0.2",
                "request_id": req_id,
                "op": "observe",
                "status": "ok",
                "observation": {
                    "schema": "observation/v0.2",
                    "frame_ref": self.current_frame(),
                },
            }

        if op == "propose":
            proposal = args["proposal"]
            prop_id = proposal["proposal_id"]
            based = proposal["based_on_frame"]
            current = self.current_frame()

            if prop_id.startswith("demo-nav-1-"):
                self._nav1_attempts += 1
                if self._nav1_attempts <= self.transient_stale_on_nav_step1:
                    self.advance_frame(f"bg-tick-nav-{self._nav1_attempts}")
                    return {
                        "schema": "mv_tool_result/v0.2",
                        "request_id": req_id,
                        "op": "propose",
                        "status": "refused",
                        "reason_code": "STALE_FRAME",
                        "detail": "Live frame advanced before nav step 1 admission",
                    }

            if prop_id.startswith("demo-click-"):
                self._click_attempts += 1
                if self._click_attempts <= self.transient_stale_on_click:
                    self.advance_frame(f"bg-tick-click-{self._click_attempts}")
                    return {
                        "schema": "mv_tool_result/v0.2",
                        "request_id": req_id,
                        "op": "propose",
                        "status": "refused",
                        "reason_code": "STALE_FRAME",
                        "detail": "Live frame advanced before click admission",
                    }

            is_stale = (
                int(based["generation"]) != int(current["generation"])
                or str(based["sha256"]) != str(current["sha256"])
            )
            if is_stale and not self.accept_stale_negative_control:
                return {
                    "schema": "mv_tool_result/v0.2",
                    "request_id": req_id,
                    "op": "propose",
                    "status": "refused",
                    "reason_code": "STALE_FRAME",
                    "detail": "Proposal pinned to stale frame generation or digest",
                }

            nav_step = None
            for idx in (1, 2, 3):
                if prop_id.startswith(f"demo-nav-{idx}-"):
                    nav_step = idx
                    break

            is_noop_focus = nav_step == 1 and self.noop_focus_on_nav_step1
            has_late_frame_change = nav_step in self.late_frame_change_polls_by_nav_step
            is_unverified_nav = (
                nav_step in self.unverified_nav_steps or has_late_frame_change
            )
            same_digest = (
                is_noop_focus
                or has_late_frame_change
                or (is_unverified_nav and not self.unverified_nav_step_changes_frame)
            )
            step_verified = not (is_noop_focus or is_unverified_nav)

            after = self.advance_frame(prop_id, same_digest=same_digest)
            if has_late_frame_change:
                self._pending_late_frame_change = {
                    "nav_step": int(nav_step),
                    "prop_id": prop_id,
                    "polls_remaining": int(self.late_frame_change_polls_by_nav_step[int(nav_step)]),
                }
            else:
                self._pending_late_frame_change = None
            if prop_id.startswith("demo-click-"):
                self._clicked = True
            daemon_receipt = {
                "schema": "action_receipt/v0.2",
                "proposal_id": prop_id,
                "executed_at_ns": int(after["ts_ns"]),
                "after_frame": copy.deepcopy(after),
                "verified": step_verified,
                "verification": {
                    "method": "pixel",
                    "detail": "changed_region verified" if step_verified else "unchanged frame",
                },
                "error": "",
                "native_evidence": {
                    "surface_id": self.surface_id,
                    "input_mono_ns": int(after["ts_ns"]) + 500,
                    "input_ts_ns": int(after["ts_ns"]) + 500,
                    "focus_verified": True,
                    "kind": (
                        "text"
                        if proposal["action"]["type"] == "type"
                        else proposal["action"]["type"]
                    ),
                    "result": "ok",
                },
            }
            self.report["wire_evidence"].append(copy.deepcopy(daemon_receipt))
            self.proposals[prop_id] = {
                "proposal": copy.deepcopy(proposal),
                "after_frame": after,
                "verified": step_verified,
                "receipt": daemon_receipt,
            }
            return {
                "schema": "mv_tool_result/v0.2",
                "request_id": req_id,
                "op": "propose",
                "status": "admitted",
                "verdict": {
                    "schema": "action_verdict/v0.2",
                    "proposal_id": prop_id,
                    "decision": "admitted",
                    "core_seq": len(self.calls),
                },
            }

        if op == "wait_verify":
            prop_id = args["proposal_id"]
            stored = self.proposals[prop_id]
            after = stored["after_frame"]
            if not stored.get("verified", True):
                return {
                    "schema": "mv_tool_result/v0.2",
                    "request_id": req_id,
                    "op": "wait_verify",
                    "status": "error",
                    "code": "VERIFICATION_FAILED",
                    "detail": "Missing, stale or unmatched native/frame evidence",
                }
            receipt = copy.deepcopy(stored["receipt"])
            return {
                "schema": "mv_tool_result/v0.2",
                "request_id": req_id,
                "op": "wait_verify",
                "status": "verified",
                "receipt": receipt,
                "focus_verified": True,
                "input_mono_ns": int(after["ts_ns"]) + 500,
                "frame_sha256": str(after["sha256"]),
            }

        raise AssertionError(f"unsupported tool op: {op!r}")

    def make_reader(self):
        """Return a deterministic reader producing vision marks, element table, and state."""

        def read_fn(frame: dict, *, include_raw: bool = True) -> dict:
            label = "Gate changed" if self._clicked else "Advance gate"
            title = "G-AI Changed" if self._clicked else "G-AI Ready"
            bbox = {"x": 80, "y": 80, "w": 260, "h": 64}
            mark = {
                "mark_id": 1,
                "node_id": "n1",
                "role": "button",
                "label": label,
                "bbox": dict(bbox),
            }
            element = {
                "node_id": "n1",
                "mark_id": 1,
                "role": "button",
                "label": label,
                "bbox": dict(bbox),
                "actionable": True,
                "confidence": 0.99,
            }
            table = {
                "schema": "vqa.element-table/v1",
                "frame_sha256": str(frame["sha256"]),
                "width": int(frame["width"]),
                "height": int(frame["height"]),
                "elements": [element],
            }
            vision = {
                "summary": f"Page {title} with button {label}",
                "changed_regions": [dict(bbox)],
                "elements": [
                    {
                        "bbox": dict(bbox),
                        "role": "button",
                        "name": label,
                        "confidence": 0.99,
                    }
                ],
            }
            target_node = {
                "id": "n1",
                "node_id": "0",
                "role": "button",
                "name": label,
                "box": [80, 80, 260, 64],
                "states": {},
            }
            wender_state = {
                "schema": "wender.state/v1",
                "title": title,
                "frame_sha256": str(frame["sha256"]),
                "actionable": ["n1"],
                "nodes": [target_node],
            }
            state_sha = _canonical_sha256(wender_state)
            battery_sha = _canonical_sha256({"battery": title, "state_sha": state_sha})
            return {
                "vision": vision,
                "raw": {"marks": [mark], "elements": [element]} if include_raw else vision,
                "vision_marks": {
                    "count": 1,
                    "marks": [mark],
                    "marks_sha256": _canonical_sha256([mark]),
                },
                "element_table": table,
                "wender_state": wender_state,
                "state_sha256": state_sha,
                "battery_state_sha256": battery_sha,
                "roots": {"wender-agent": ROOT},
            }

        return read_fn


class DemoAgentDriveUnitTests(unittest.TestCase):
    """Offline unit tests for demo_agent_drive with an injected peer."""

    def test_ordered_checkpoints_stale_negative_control_and_receipt_schema(self) -> None:
        peer = InjectedDemoPeer()
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = Path(tmp) / "demo-receipt.json"
            receipt = run_demo_agent_drive(
                peer,
                peer.surface_id,
                stack_meta={
                    "capsule": "srf-id-unit01",
                    "display": ":99",
                    "display_mode": "private",
                    "record_path": "/tmp/demo.mp4",
                    "started_by_runner": False,
                },
                read_fn=peer.make_reader(),
                receipt_out=receipt_path,
                out_stream=out,
                env={},
            )
            saved = json.loads(receipt_path.read_text(encoding="utf-8"))

        lines = [json.loads(line) for line in out.getvalue().strip().splitlines()]
        self.assertEqual(len(lines), len(ORDERED_CHECKPOINTS))
        self.assertEqual(tuple(item["checkpoint"] for item in lines), ORDERED_CHECKPOINTS)
        self.assertEqual(receipt, saved)
        validate_transcript_and_receipt(lines, receipt)

        # Verify read checkpoint printed vision marks and element table
        read_cp = lines[3]
        self.assertEqual(read_cp["checkpoint"], "read")
        self.assertEqual(read_cp["vision_marks"]["count"], 1)
        self.assertEqual(read_cp["element_table"]["schema"], "vqa.element-table/v1")
        self.assertEqual(read_cp["element_table"]["elements"][0]["label"], "Advance gate")

        # Verify negative control recorded STALE_FRAME and run continued
        neg_cp = lines[4]
        self.assertEqual(neg_cp["checkpoint"], "stale_negative_control")
        self.assertEqual(neg_cp["decision"], "refused")
        self.assertEqual(neg_cp["reason_code"], "STALE_FRAME")
        self.assertTrue(neg_cp["continued"])

        # Verify default planner is local custody click and post-state hashes changed
        click_cp = lines[5]
        self.assertEqual(click_cp["planner_id"], LOCAL_PLANNER_ID)
        verify_cp = lines[6]
        self.assertTrue(verify_cp["verified"])
        self.assertNotEqual(verify_cp["pre_frame_sha256"], verify_cp["post_frame_sha256"])
        post_cp = lines[7]
        self.assertTrue(post_cp["verified"])
        self.assertTrue(post_cp["frame_sha256_changed"])
        self.assertTrue(post_cp["state_sha256_changed"])
        self.assertNotEqual(post_cp["pre_frame_sha256"], post_cp["post_frame_sha256"])
        self.assertNotEqual(post_cp["pre_state_sha256"], post_cp["post_state_sha256"])

    def test_transient_live_stale_frame_retries_up_to_tick_max_attempts(self) -> None:
        peer = InjectedDemoPeer(
            transient_stale_on_nav_step1=2,
            transient_stale_on_click=2,
        )
        out = io.StringIO()
        receipt = run_demo_agent_drive(
            peer,
            peer.surface_id,
            read_fn=peer.make_reader(),
            out_stream=out,
            env={},
            max_attempts=stack.TICK_MAX_ATTEMPTS,
        )
        lines = [json.loads(line) for line in out.getvalue().strip().splitlines()]
        nav_cp = lines[2]
        self.assertEqual(nav_cp["steps"][0]["attempts"], 3)
        self.assertEqual(nav_cp["steps"][0]["stale_retries"], 2)
        click_cp = lines[5]
        self.assertEqual(click_cp["attempts"], 3)
        self.assertEqual(click_cp["stale_retries"], 2)
        self.assertTrue(receipt["verified"])

        # Exceeding TICK_MAX_ATTEMPTS fails closed with ToolRefusal(STALE_FRAME)
        failing_peer = InjectedDemoPeer(transient_stale_on_click=stack.TICK_MAX_ATTEMPTS)
        with self.assertRaises(tools.ToolRefusal) as ctx:
            run_demo_agent_drive(
                failing_peer,
                failing_peer.surface_id,
                read_fn=failing_peer.make_reader(),
                out_stream=io.StringIO(),
                env={},
                max_attempts=stack.TICK_MAX_ATTEMPTS,
            )
        self.assertEqual(ctx.exception.reason_code, "STALE_FRAME")

    def test_negative_control_fails_closed_when_stale_frame_not_refused(self) -> None:
        peer = InjectedDemoPeer(accept_stale_negative_control=True)
        with self.assertRaisesRegex(RuntimeError, "negative control failed"):
            run_demo_agent_drive(
                peer,
                peer.surface_id,
                read_fn=peer.make_reader(),
                out_stream=io.StringIO(),
                env={},
            )

    def test_honors_mv_wender_planner_cmd_when_configured(self) -> None:
        peer = InjectedDemoPeer()
        out = io.StringIO()
        reader = peer.make_reader()

        def fake_plan_step(observation, table, goal):
            bundle = reader(observation["frame_ref"], include_raw=False)
            state = bundle["wender_state"]
            target = state["nodes"][0]
            action = {"type": "click", "x": 210, "y": 112, "button": "left"}
            expectation = {
                "type": "changed_region",
                "bbox": {"x": 80, "y": 80, "w": 260, "h": 64},
            }
            return action, expectation, state, target

        with patch.object(WenderSubprocessAdapter, "plan_step", side_effect=fake_plan_step) as plan_mock:
            receipt = run_demo_agent_drive(
                peer,
                peer.surface_id,
                read_fn=reader,
                out_stream=out,
                env={"MV_WENDER_PLANNER_CMD": json.dumps([sys.executable, "-c", "pass"])},
            )
        self.assertGreaterEqual(plan_mock.call_count, 1)
        self.assertEqual(receipt["planner_id"], SUBPROCESS_PLANNER_ID)
        lines = [json.loads(line) for line in out.getvalue().strip().splitlines()]
        self.assertEqual(lines[5]["planner_id"], SUBPROCESS_PLANNER_ID)

    def test_transcript_validator_rejects_corrupted_checkpoints(self) -> None:
        peer = InjectedDemoPeer()
        out = io.StringIO()
        receipt = run_demo_agent_drive(
            peer,
            peer.surface_id,
            read_fn=peer.make_reader(),
            out_stream=out,
            env={},
        )
        lines = [json.loads(line) for line in out.getvalue().strip().splitlines()]

        bad_order = copy.deepcopy(lines)
        bad_order[2], bad_order[3] = bad_order[3], bad_order[2]
        with self.assertRaisesRegex(ValueError, "checkpoint step"):
            validate_transcript_and_receipt(bad_order, receipt)

        bad_neg = copy.deepcopy(lines)
        bad_neg[4]["reason_code"] = "OTHER"
        with self.assertRaisesRegex(ValueError, "STALE_FRAME"):
            validate_transcript_and_receipt(bad_neg, receipt)

        bad_post = copy.deepcopy(lines)
        bad_post[7]["post_frame_sha256"] = bad_post[7]["pre_frame_sha256"]
        with self.assertRaisesRegex(ValueError, "must differ"):
            validate_transcript_and_receipt(bad_post, receipt)

    def test_noop_focus_step_recorded_as_noop_verified_false_and_sequence_passes(self) -> None:
        peer = InjectedDemoPeer(noop_focus_on_nav_step1=True)
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = Path(tmp) / "noop-focus-receipt.json"
            receipt = run_demo_agent_drive(
                peer,
                peer.surface_id,
                read_fn=peer.make_reader(),
                receipt_out=receipt_path,
                out_stream=out,
                env={},
            )
            saved = json.loads(receipt_path.read_text(encoding="utf-8"))

        lines = [json.loads(line) for line in out.getvalue().strip().splitlines()]
        self.assertEqual(len(lines), len(ORDERED_CHECKPOINTS))
        self.assertEqual(receipt, saved)
        validate_transcript_and_receipt(lines, receipt)

        nav_cp = lines[2]
        self.assertEqual(nav_cp["checkpoint"], "navigate")
        self.assertIs(nav_cp["noop_verified"], False)
        step1, step2, step3 = nav_cp["steps"]
        self.assertEqual(step1["label"], "key:ctrl+l")
        self.assertIs(step1["verified"], False)
        self.assertIs(step1["noop_verified"], False)
        self.assertEqual(step1["before_frame_sha256"], step1["after_frame_sha256"])
        self.assertGreater(step1["after_generation"], lines[1]["generation"])
        self.assertEqual(step2["label"], "type:data-url")
        self.assertIs(step2["verified"], True)
        self.assertEqual(step3["label"], "key:Return")
        self.assertIs(step3["verified"], True)
        self.assertNotEqual(nav_cp["pre_frame_sha256"], nav_cp["post_navigate_frame_sha256"])

    def test_late_frame_change_accepted_within_bound_for_type_and_return_steps(self) -> None:
        clock = [100.0]
        sleeps: list[float] = []

        def fake_monotonic() -> float:
            return clock[0]

        def fake_sleep(seconds: float) -> None:
            sleeps.append(seconds)
            clock[0] += seconds

        peer = InjectedDemoPeer(
            noop_focus_on_nav_step1=True,
            unverified_nav_steps=(2, 3),
            late_frame_change_polls_by_nav_step={2: 3, 3: 2},
        )
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = Path(tmp) / "late-frame-change-receipt.json"
            receipt = run_demo_agent_drive(
                peer,
                peer.surface_id,
                read_fn=peer.make_reader(),
                receipt_out=receipt_path,
                out_stream=out,
                env={},
                monotonic_fn=fake_monotonic,
                sleep_fn=fake_sleep,
            )
            saved = json.loads(receipt_path.read_text(encoding="utf-8"))

        lines = [json.loads(line) for line in out.getvalue().strip().splitlines()]
        self.assertEqual(len(lines), len(ORDERED_CHECKPOINTS))
        self.assertEqual(receipt, saved)
        validate_transcript_and_receipt(lines, receipt)

        nav_cp = lines[2]
        self.assertEqual(nav_cp["checkpoint"], "navigate")
        self.assertIs(nav_cp["verified"], True)
        self.assertIs(nav_cp["noop_verified"], False)
        step1, step2, step3 = nav_cp["steps"]

        self.assertEqual(step1["label"], "key:ctrl+l")
        self.assertIs(step1["verified"], False)
        self.assertIs(step1["noop_verified"], False)
        self.assertEqual(step1["before_frame_sha256"], step1["after_frame_sha256"])

        self.assertEqual(step2["label"], "type:data-url")
        self.assertIs(step2["verified"], True)
        self.assertEqual(step2["verification"]["method"], POST_FRAME_CHANGE_METHOD)
        self.assertNotEqual(step2["before_frame_sha256"], step2["after_frame_sha256"])
        self.assertEqual(peer.late_frame_poll_counts[2], 3)

        self.assertEqual(step3["label"], "key:Return")
        self.assertIs(step3["verified"], True)
        self.assertEqual(step3["verification"]["method"], POST_FRAME_CHANGE_METHOD)
        self.assertEqual(step3["before_frame_sha256"], step2["after_frame_sha256"])
        self.assertNotEqual(step3["before_frame_sha256"], step3["after_frame_sha256"])
        self.assertEqual(peer.late_frame_poll_counts[3], 2)

        self.assertEqual(nav_cp["post_navigate_frame_sha256"], step3["after_frame_sha256"])
        self.assertNotEqual(nav_cp["pre_frame_sha256"], nav_cp["post_navigate_frame_sha256"])
        self.assertEqual(len(sleeps), 3)
        self.assertLess(sum(sleeps), POST_FRAME_CHANGE_MAX_S)

    def test_unverified_type_step_blocks_and_writes_partial_receipt_negative_control(self) -> None:
        clock = [200.0]
        sleeps: list[float] = []

        def fake_monotonic() -> float:
            return clock[0]

        def fake_sleep(seconds: float) -> None:
            sleeps.append(seconds)
            clock[0] += seconds

        peer = InjectedDemoPeer(
            noop_focus_on_nav_step1=True,
            unverified_nav_steps=(2,),
        )
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = Path(tmp) / "partial-receipt.json"
            with self.assertRaises(tools.VerificationFailed) as ctx:
                run_demo_agent_drive(
                    peer,
                    peer.surface_id,
                    read_fn=peer.make_reader(),
                    receipt_out=receipt_path,
                    out_stream=out,
                    env={},
                    monotonic_fn=fake_monotonic,
                    sleep_fn=fake_sleep,
                )
            self.assertTrue(receipt_path.is_file())
            partial = json.loads(receipt_path.read_text(encoding="utf-8"))

        self.assertAlmostEqual(sum(sleeps), POST_FRAME_CHANGE_MAX_S, places=6)
        lines = [json.loads(line) for line in out.getvalue().strip().splitlines()]
        self.assertEqual(len(lines), 3)
        self.assertEqual([item["checkpoint"] for item in lines], ["LIVE_STACK_READY", "observe", "navigate"])
        validate_partial_receipt(lines, partial)
        self.assertEqual(partial, getattr(ctx.exception, "partial_receipt"))
        self.assertEqual(partial["status"], "BLOCKED")
        self.assertIs(partial["partial"], True)
        self.assertIs(partial["verified"], False)
        self.assertEqual(partial["failed_step"], 3)
        self.assertEqual(partial["failed_checkpoint"], "navigate")
        self.assertEqual(partial["completed_checkpoints"], ["LIVE_STACK_READY", "observe"])

        failed_cp = lines[2]
        self.assertEqual(failed_cp["status"], "BLOCKED")
        self.assertIs(failed_cp["verified"], False)
        self.assertEqual(failed_cp["failed_step_index"], 2)
        self.assertEqual(failed_cp["failed_step_label"], "type:data-url")
        self.assertEqual(len(failed_cp["steps"]), 2)
        self.assertIs(failed_cp["steps"][0]["noop_verified"], False)
        self.assertIs(failed_cp["steps"][1]["verified"], False)
        self.assertEqual(failed_cp["steps"][1]["verification"]["method"], "pixel")
        self.assertEqual(
            failed_cp["steps"][1]["before_frame_sha256"],
            failed_cp["steps"][1]["after_frame_sha256"],
        )
        self.assertNotIn("noop_verified", failed_cp["steps"][1])
        self.assertEqual(partial["verdict_id"], failed_cp["steps"][1]["verdict_id"])
        self.assertEqual(partial["receipt_id"], failed_cp["steps"][1]["receipt_id"])
        self.assertEqual(
            partial["verdict_ids"],
            [failed_cp["steps"][0]["verdict_id"], failed_cp["steps"][1]["verdict_id"]],
        )
        self.assertEqual(
            partial["receipt_ids"],
            [failed_cp["steps"][0]["receipt_id"], failed_cp["steps"][1]["receipt_id"]],
        )

        # Unverified focus step whose frame changed must also block (not a no-op).
        changed_focus_peer = InjectedDemoPeer(
            unverified_nav_steps=(1,),
            unverified_nav_step_changes_frame=True,
        )
        changed_out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp2:
            changed_receipt_path = Path(tmp2) / "changed-focus-partial.json"
            with self.assertRaises(tools.VerificationFailed):
                run_demo_agent_drive(
                    changed_focus_peer,
                    changed_focus_peer.surface_id,
                    read_fn=changed_focus_peer.make_reader(),
                    receipt_out=changed_receipt_path,
                    out_stream=changed_out,
                    env={},
                    monotonic_fn=fake_monotonic,
                    sleep_fn=fake_sleep,
                )
            changed_partial = json.loads(changed_receipt_path.read_text(encoding="utf-8"))
        changed_lines = [json.loads(line) for line in changed_out.getvalue().strip().splitlines()]
        validate_partial_receipt(changed_lines, changed_partial)
        self.assertEqual(changed_lines[2]["failed_step_index"], 1)
        self.assertNotIn("noop_verified", changed_lines[2]["steps"][0])

    def test_unverified_return_step_and_late_change_past_bound_block_negative_control(self) -> None:
        clock = [300.0]
        sleeps: list[float] = []

        def fake_monotonic() -> float:
            return clock[0]

        def fake_sleep(seconds: float) -> None:
            sleeps.append(seconds)
            clock[0] += seconds

        # Step 2 (type) recovers within bound; step 3 (Return) never changes sha -> BLOCKED.
        peer_return_unchanged = InjectedDemoPeer(
            noop_focus_on_nav_step1=True,
            unverified_nav_steps=(2, 3),
            late_frame_change_polls_by_nav_step={2: 2},
        )
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = Path(tmp) / "return-blocked-partial.json"
            with self.assertRaises(tools.VerificationFailed):
                run_demo_agent_drive(
                    peer_return_unchanged,
                    peer_return_unchanged.surface_id,
                    read_fn=peer_return_unchanged.make_reader(),
                    receipt_out=receipt_path,
                    out_stream=out,
                    env={},
                    monotonic_fn=fake_monotonic,
                    sleep_fn=fake_sleep,
                )
            partial = json.loads(receipt_path.read_text(encoding="utf-8"))

        lines = [json.loads(line) for line in out.getvalue().strip().splitlines()]
        validate_partial_receipt(lines, partial)
        failed_cp = lines[2]
        self.assertEqual(failed_cp["failed_step_index"], 3)
        self.assertEqual(failed_cp["failed_step_label"], "key:Return")
        self.assertEqual(len(failed_cp["steps"]), 3)
        self.assertIs(failed_cp["steps"][1]["verified"], True)
        self.assertEqual(failed_cp["steps"][1]["verification"]["method"], POST_FRAME_CHANGE_METHOD)
        self.assertIs(failed_cp["steps"][2]["verified"], False)
        self.assertEqual(failed_cp["steps"][2]["verification"]["method"], "pixel")
        self.assertEqual(
            failed_cp["steps"][2]["before_frame_sha256"],
            failed_cp["steps"][2]["after_frame_sha256"],
        )

        # Late frame change scheduled after the bound expires (poll 10 > 3 polls in 0.1 s bound) -> BLOCKED.
        peer_past_bound = InjectedDemoPeer(
            noop_focus_on_nav_step1=True,
            unverified_nav_steps=(2,),
            late_frame_change_polls_by_nav_step={2: 10},
        )
        past_out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp2:
            past_receipt_path = Path(tmp2) / "past-bound-partial.json"
            with self.assertRaises(tools.VerificationFailed):
                run_demo_agent_drive(
                    peer_past_bound,
                    peer_past_bound.surface_id,
                    read_fn=peer_past_bound.make_reader(),
                    receipt_out=past_receipt_path,
                    out_stream=past_out,
                    env={},
                    post_frame_change_max_s=0.1,
                    post_frame_change_poll_s=POST_FRAME_CHANGE_POLL_S,
                    monotonic_fn=fake_monotonic,
                    sleep_fn=fake_sleep,
                )
            past_partial = json.loads(past_receipt_path.read_text(encoding="utf-8"))

        past_lines = [json.loads(line) for line in past_out.getvalue().strip().splitlines()]
        validate_partial_receipt(past_lines, past_partial)
        self.assertEqual(past_lines[2]["failed_step_index"], 2)
        self.assertEqual(past_lines[2]["failed_step_label"], "type:data-url")
        self.assertIs(past_lines[2]["steps"][1]["verified"], False)

    def test_partial_receipt_written_on_later_checkpoint_block(self) -> None:
        failing_peer = InjectedDemoPeer(transient_stale_on_click=stack.TICK_MAX_ATTEMPTS)
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = Path(tmp) / "click-blocked-receipt.json"
            with self.assertRaises(tools.ToolRefusal):
                run_demo_agent_drive(
                    failing_peer,
                    failing_peer.surface_id,
                    read_fn=failing_peer.make_reader(),
                    receipt_out=receipt_path,
                    out_stream=out,
                    env={},
                    max_attempts=stack.TICK_MAX_ATTEMPTS,
                )
            partial = json.loads(receipt_path.read_text(encoding="utf-8"))

        lines = [json.loads(line) for line in out.getvalue().strip().splitlines()]
        self.assertEqual(len(lines), 6)
        validate_partial_receipt(lines, partial)
        self.assertEqual(partial["failed_checkpoint"], "custody_click")
        self.assertEqual(
            partial["completed_checkpoints"],
            ["LIVE_STACK_READY", "observe", "navigate", "read", "stale_negative_control"],
        )
        self.assertTrue(str(partial["proposal_id"]).startswith("demo-click-"))
        self.assertIsNone(partial["verdict_id"])
        self.assertIsNone(partial["receipt_id"])

    def test_attached_session_rejects_unready_state_and_dead_supervisor(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "live-stack"
            root.mkdir(mode=0o700)
            with self.assertRaisesRegex(RuntimeError, "not ready"):
                AttachedLiveStackSession(root)
            stack.save_state(
                root,
                {
                    "schema": "metaviewer.live-stack/v1",
                    "status": "ready",
                    "work": str(root / "work"),
                    "surface_id": "surface-1",
                    "capsules": ["srf-id-cap1"],
                    "supervisor": {"pid": 99999999, "identity": "dead"},
                },
            )
            with self.assertRaisesRegex(RuntimeError, "supervisor is not alive"):
                AttachedLiveStackSession(root)

    def test_attached_session_scm_rights_handoff_seq_continuity_and_second_attach_refused(self) -> None:
        # Verify pidfd_getfd helpers were removed from demo_agent_drive.
        self.assertFalse(hasattr(demo_agent_drive, "_find_supervisor_core_socket_fd"))
        self.assertFalse(hasattr(demo_agent_drive, "_pidfd_getfd"))

        with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
            os.chmod(tmp, 0o700)
            root = Path(tmp) / "metaviewer-live-stack"
            root.mkdir(mode=0o700)
            work = root / "run-1"
            work.mkdir(mode=0o700)
            (work / "runtime/metaviewer").mkdir(parents=True, mode=0o700)

            commit = "a" * 40
            regs = {
                c: stack.live.registration(c, commit, f"{c}-inst-1")
                for c in ("core", "ui", "agent", "daemon")
            }
            config = {
                "session_id": "stack-test-session",
                "core": regs["core"],
                "peers": [regs[c] for c in ("ui", "agent", "daemon")],
            }
            (work / "core-config.json").write_text(json.dumps(config), encoding="utf-8")

            state = {
                "schema": "metaviewer.live-stack/v1",
                "status": "ready",
                "work": str(work),
                "surface_id": "surface-live-1",
                "capsules": ["srf-id-12345678"],
                "supervisor": {
                    "pid": os.getpid(),
                    "identity": stack.identity(os.getpid()),
                },
            }
            stack.save_state(root, state)

            core_agent_sock, core_server_sock = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            control_sock = stack.open_control_socket(root)
            try:
                sup_peer = stack.live.CoreClient(
                    str(work / "runtime/metaviewer/core.sock"),
                    timeout_s=20,
                    max_line_bytes=1 << 20,
                    max_reply_bytes=1 << 20,
                )
                sup_peer._sock = core_agent_sock
                sup_peer._next_seq = 6
                sup_peer._hello_complete = True
                stack.live._lane_state(sup_peer)["inbound_seq"] = 9
                peer_holder = {"peer": sup_peer}

                def serve_requests(count: int) -> None:
                    for _ in range(count):
                        conn, _ = control_sock.accept()
                        stack.handle_control_connection(conn, peer_holder, state, root)

                server_thread = threading.Thread(target=serve_requests, args=(2,))
                server_thread.start()

                with AttachedLiveStackSession(root, started_by_runner=False) as session:
                    # Supervisor relinquished its fd and recorded handoff in state.json.
                    self.assertIsNone(peer_holder["peer"])
                    self.assertIsNone(sup_peer._sock)
                    persisted = stack.load_state(root)
                    self.assertEqual(persisted["agent_handoff"]["next_seq"], 6)
                    self.assertEqual(persisted["agent_handoff"]["inbound_seq"], 9)

                    # Read the frame_subscribe envelope sent on __enter__ from core_server_sock:
                    # sequence continues at seq=6 without any second hello/v0.2.
                    core_server_sock.settimeout(2.0)
                    raw_line = b""
                    while b"\n" not in raw_line:
                        raw_line += core_server_sock.recv(4096)
                    env = json.loads(raw_line.split(b"\n", 1)[0].decode("utf-8"))
                    self.assertEqual(env["schema"], "envelope/v0.2")
                    self.assertEqual(env["from"], regs["agent"]["endpoint"])
                    self.assertEqual(env["seq"], 6)
                    self.assertEqual(
                        env["body"],
                        {
                            "schema": "surface_request/v0.2",
                            "op": "frame_subscribe",
                            "params": {"surface_id": "surface-live-1"},
                        },
                    )
                    self.assertEqual(session.peer.next_seq, 7)

                    # Negative control: second attach is refused with ALREADY_HANDED_OFF.
                    with self.assertRaisesRegex(RuntimeError, "ALREADY_HANDED_OFF"):
                        with AttachedLiveStackSession(root, started_by_runner=False):
                            pass

                server_thread.join(timeout=2.0)

                # On runner exit, session closes its peer fd and core_server_sock sees clean EOF.
                self.assertEqual(core_server_sock.recv(16), b"")
            finally:
                stack.close_control_socket(control_sock, root)
                core_server_sock.close()


if __name__ == "__main__":
    unittest.main()
