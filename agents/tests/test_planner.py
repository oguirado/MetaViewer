"""Offline unit and pipe-CLI tests for metaviewer_agents.planner."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

AGENTS_ROOT = Path(__file__).resolve().parents[1]
if str(AGENTS_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENTS_ROOT))

from metaviewer_agents import planner  # noqa: E402
from metaviewer_agents.planner import (  # noqa: E402
    EXIT_CODES,
    PlannerError,
    canonical_json,
    plan,
    recheck_plan,
)
from metaviewer_agents.perception.vcore import _BoundVision  # noqa: E402
from metaviewer_agents.verify import run_loop  # noqa: E402
from metaviewer_agents.wender_bridge import WenderSubprocessAdapter  # noqa: E402


def _frame_ref(*, width: int = 120, height: int = 80, sha256: str | None = None) -> dict:
    digest = sha256 or hashlib.sha256(b"planner-fixture-frame").hexdigest()
    return {
        "schema": "frame_ref/v0.2",
        "surface_id": "fixture",
        "generation": 1,
        "tick": 5,
        "ts_ns": 1000,
        "width": width,
        "height": height,
        "format": "rgb24",
        "ramws_path": "/dev/shm/planner-fixture",
        "sha256": digest,
        "capture_us": 12,
    }


def _observation(*, frame: dict | None = None) -> dict:
    active_frame = _frame_ref() if frame is None else copy.deepcopy(frame)
    return {
        "schema": "observation/v0.2",
        "frame_ref": active_frame,
        "vision": _BoundVision(
            {
                "summary": "fixture vision",
                "changed_regions": [{"x": 10, "y": 20, "w": 40, "h": 20}],
                "elements": [
                    {
                        "bbox": {"x": 10, "y": 20, "w": 40, "h": 20},
                        "role": "button",
                        "name": "Continue",
                        "confidence": 0.9,
                    }
                ],
            },
            active_frame["sha256"],
        ),
    }


def _element_table(*, frame: dict | None = None, elements: list[dict] | None = None) -> dict:
    active_frame = _frame_ref() if frame is None else frame
    rows = (
        [
            {
                "bbox": {"x": 10, "y": 20, "w": 40, "h": 20},
                "role": "button",
                "name": "Continue",
                "score_ppm": 900_000,
            },
            {
                "bbox": {"x": 60, "y": 10, "w": 30, "h": 16},
                "role": "link",
                "name": "Details",
                "score_ppm": 700_000,
            },
        ]
        if elements is None
        else copy.deepcopy(elements)
    )
    return {
        "schema": "vqa.element-table/v1",
        "frame_sha256": active_frame["sha256"],
        "width": active_frame["width"],
        "height": active_frame["height"],
        "elements": rows,
    }


class PlannerTests(unittest.TestCase):
    def run_cli_subprocess(self, request_payload: str | bytes) -> subprocess.CompletedProcess:
        data = (
            request_payload.encode("utf-8")
            if isinstance(request_payload, str)
            else request_payload
        )
        env = {
            key: os.environ[key]
            for key in ("PATH", "LANG")
            if key in os.environ
        }
        env["PYTHONPATH"] = str(AGENTS_ROOT)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        return subprocess.run(
            [sys.executable, "-m", "metaviewer_agents.planner"],
            cwd=str(AGENTS_ROOT),
            env=env,
            input=data,
            capture_output=True,
            timeout=30,
            check=False,
        )

    def test_pure_plan_closed_keys_click_inside_bbox_and_changed_region(self) -> None:
        obs = _observation()
        table = _element_table()
        obs_snapshot = copy.deepcopy(obs)
        table_snapshot = copy.deepcopy(table)

        result = plan(obs, table, "Continue")
        self.assertEqual(obs, obs_snapshot)
        self.assertEqual(table, table_snapshot)
        self.assertEqual(
            set(result),
            {"action", "expectation", "state", "target_node"},
        )

        action = result["action"]
        expectation = result["expectation"]
        target = result["target_node"]
        chosen_bbox = table["elements"][0]["bbox"]

        self.assertEqual(set(action), {"type", "x", "y", "button"})
        self.assertEqual(action["type"], "click")
        self.assertEqual(action["button"], "left")
        self.assertTrue(
            chosen_bbox["x"] <= action["x"] < chosen_bbox["x"] + chosen_bbox["w"]
        )
        self.assertTrue(
            chosen_bbox["y"] <= action["y"] < chosen_bbox["y"] + chosen_bbox["h"]
        )
        self.assertEqual(action["x"], 30)
        self.assertEqual(action["y"], 30)

        self.assertEqual(set(expectation), {"type", "bbox"})
        self.assertEqual(expectation["type"], "changed_region")
        self.assertEqual(expectation["bbox"], chosen_bbox)
        self.assertEqual(target["name"], "Continue")
        self.assertEqual(recheck_plan(result, obs, table), result)

        # Select second element when goal matches "Details"
        result_details = plan(obs, table, "Details")
        self.assertEqual(result_details["target_node"]["name"], "Details")
        self.assertEqual(result_details["action"]["x"], 75)
        self.assertEqual(result_details["action"]["y"], 18)
        self.assertEqual(
            result_details["expectation"]["bbox"],
            table["elements"][1]["bbox"],
        )

        # No private packages imported
        self.assertFalse(
            any(
                mod.split(".")[0] in ("visioncore", "vadapt", "wender")
                for mod in sys.modules
            )
        )

    def test_equal_score_tie_breaks_to_earliest_index_and_higher_score_wins(self) -> None:
        obs = _observation()

        # Two actionable rows with identical score_ppm and distinct bboxes: index 0 wins
        two_way_tie_table = _element_table(
            elements=[
                {
                    "bbox": {"x": 10, "y": 20, "w": 40, "h": 20},
                    "role": "button",
                    "name": "Continue",
                    "score_ppm": 800_000,
                },
                {
                    "bbox": {"x": 60, "y": 10, "w": 30, "h": 16},
                    "role": "button",
                    "name": "Continue",
                    "score_ppm": 800_000,
                },
            ]
        )
        tie_result = plan(obs, two_way_tie_table, "Continue")
        self.assertEqual(tie_result["target_node"]["ordinal"], 0)
        self.assertEqual(tie_result["action"]["x"], 30)
        self.assertEqual(tie_result["action"]["y"], 30)
        self.assertEqual(
            tie_result["expectation"]["bbox"],
            {"x": 10, "y": 20, "w": 40, "h": 20},
        )

        # Three-element crop-fallback tie at score_ppm = 500_000: index 0 wins
        crop_tie_table = _element_table(
            elements=[
                {
                    "bbox": {"x": 4, "y": 6, "w": 20, "h": 10},
                    "role": "crop",
                    "name": "",
                    "score_ppm": 500_000,
                },
                {
                    "bbox": {"x": 30, "y": 20, "w": 24, "h": 12},
                    "role": "crop",
                    "name": "",
                    "score_ppm": 500_000,
                },
                {
                    "bbox": {"x": 70, "y": 40, "w": 30, "h": 20},
                    "role": "crop",
                    "name": "",
                    "score_ppm": 500_000,
                },
            ]
        )
        crop_result = plan(obs, crop_tie_table, "Continue")
        self.assertEqual(crop_result["target_node"]["ordinal"], 0)
        self.assertEqual(crop_result["action"]["x"], 14)
        self.assertEqual(crop_result["action"]["y"], 11)
        self.assertEqual(
            crop_result["expectation"]["bbox"],
            {"x": 4, "y": 6, "w": 20, "h": 10},
        )

        # Negative control: index 1 has strictly higher score_ppm and wins
        higher_idx1_table = _element_table(
            elements=[
                {
                    "bbox": {"x": 10, "y": 20, "w": 40, "h": 20},
                    "role": "button",
                    "name": "Continue",
                    "score_ppm": 800_000,
                },
                {
                    "bbox": {"x": 60, "y": 10, "w": 30, "h": 16},
                    "role": "button",
                    "name": "Continue",
                    "score_ppm": 800_001,
                },
            ]
        )
        higher_result = plan(obs, higher_idx1_table, "Continue")
        self.assertEqual(higher_result["target_node"]["ordinal"], 1)
        self.assertEqual(higher_result["action"]["x"], 75)
        self.assertEqual(higher_result["action"]["y"], 18)
        self.assertEqual(
            higher_result["expectation"]["bbox"],
            {"x": 60, "y": 10, "w": 30, "h": 16},
        )

    def test_pipe_cli_roundtrip_and_mv_wender_planner_cmd_compatibility(self) -> None:
        obs = _observation()
        table = _element_table()
        request_json = json.dumps(
            {"observation": obs, "element_table": table, "goal": "Continue"},
            sort_keys=True,
            separators=(",", ":"),
        )
        proc = self.run_cli_subprocess(request_json)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", errors="replace"))
        self.assertEqual(proc.stderr, b"")
        parsed = json.loads(proc.stdout.decode("utf-8"))
        self.assertEqual(proc.stdout.decode("utf-8").strip(), canonical_json(parsed))
        self.assertEqual(recheck_plan(parsed, obs, table), parsed)

        # Verify usability via WenderSubprocessAdapter and verify.run_loop with MV_WENDER_PLANNER_CMD
        bridge = WenderSubprocessAdapter(
            command=[sys.executable, "-m", "metaviewer_agents.planner"],
            wender_root=AGENTS_ROOT,
            timeout=30,
        )
        action, expectation, state, target = bridge.plan_step(
            obs, table, "Continue"
        )
        self.assertEqual(action, parsed["action"])
        self.assertEqual(expectation, parsed["expectation"])
        self.assertEqual(state, parsed["state"])
        self.assertEqual(target, parsed["target_node"])

        class _FakeCore:
            def __init__(self, obs_payload: dict) -> None:
                self.obs_payload = obs_payload
                self.ops: list[str] = []

            def request(self, call: dict, expect: str, *, timeout_ms: int) -> dict:
                op = call["op"]
                self.ops.append(op)
                reply = {"schema": expect, "request_id": call["request_id"], "op": op}
                if op == "observe":
                    reply.update(status="ok", observation=copy.deepcopy(self.obs_payload))
                elif op == "propose":
                    reply.update(
                        status="admitted",
                        verdict={
                            "schema": "action_verdict/v0.2",
                            "proposal_id": call["args"]["proposal"]["proposal_id"],
                            "decision": "admitted",
                            "core_seq": 1,
                        },
                    )
                else:
                    after = dict(self.obs_payload["frame_ref"], generation=2, tick=6, sha256="b" * 64)
                    reply.update(
                        status="verified",
                        focus_verified=True,
                        input_mono_ns=10,
                        frame_sha256=after["sha256"],
                        receipt={
                            "schema": "action_receipt/v0.2",
                            "proposal_id": call["args"]["proposal_id"],
                            "executed_at_ns": 10,
                            "after_frame": after,
                            "verified": True,
                            "verification": {"method": "pixel", "detail": "ok"},
                            "error": "",
                        },
                    )
                return reply

        fake_core = _FakeCore(obs)
        cmd_json = json.dumps([sys.executable, "-m", "metaviewer_agents.planner"])
        with patch.dict(os.environ, {"MV_WENDER_PLANNER_CMD": cmd_json}), patch(
            "metaviewer_agents.perception.deps_lock.resolve_locked_component",
            return_value=AGENTS_ROOT,
        ):
            receipt = run_loop(
                client=fake_core,
                surface_id="fixture",
                proposal_id="p-cli-1",
                timeout_ms=5000,
                goal="Continue",
            )
        self.assertTrue(receipt["verified"])
        self.assertEqual(fake_core.ops, ["observe", "propose", "wait_verify"])

    def test_negative_controls_distinct_nonzero_exit_codes_and_stderr_format(self) -> None:
        obs = _observation()
        good_table = _element_table()

        # 1. Empty goal
        empty_goal_req = json.dumps(
            {"observation": obs, "element_table": good_table, "goal": "   "}
        )
        # 2. Frame-mismatched table
        mismatched_table = dict(good_table, frame_sha256="f" * 64)
        mismatch_req = json.dumps(
            {"observation": obs, "element_table": mismatched_table, "goal": "Continue"}
        )
        # 3. Out-of-frame click / element bbox
        oob_table = _element_table(
            elements=[
                {
                    "bbox": {"x": 110, "y": 20, "w": 20, "h": 20},
                    "role": "button",
                    "name": "Continue",
                    "score_ppm": 900_000,
                }
            ]
        )
        oob_req = json.dumps(
            {"observation": obs, "element_table": oob_table, "goal": "Continue"}
        )

        cases = [
            ("empty_goal", empty_goal_req, lambda: plan(obs, good_table, "   ")),
            ("frame_mismatch", mismatch_req, lambda: plan(obs, mismatched_table, "Continue")),
            ("out_of_bounds", oob_req, lambda: plan(obs, oob_table, "Continue")),
        ]
        seen_exit_codes: set[int] = set()
        seen_error_codes: set[str] = set()

        for expected_code, payload, direct_call in cases:
            with self.subTest(control=expected_code):
                with self.assertRaises(PlannerError) as ctx:
                    direct_call()
                self.assertEqual(ctx.exception.code, expected_code)
                self.assertEqual(ctx.exception.exit_code, EXIT_CODES[expected_code])

                proc = self.run_cli_subprocess(payload)
                self.assertNotEqual(proc.returncode, 0)
                self.assertEqual(proc.returncode, EXIT_CODES[expected_code])
                self.assertEqual(proc.stdout, b"")
                stderr_line = proc.stderr.decode("utf-8").strip()
                self.assertTrue(
                    stderr_line.startswith(f"{expected_code}: "),
                    f"unexpected stderr: {stderr_line!r}",
                )
                code_prefix, _, detail = stderr_line.partition(": ")
                self.assertEqual(code_prefix, expected_code)
                self.assertTrue(bool(detail))
                seen_exit_codes.add(proc.returncode)
                seen_error_codes.add(code_prefix)

        self.assertEqual(len(seen_exit_codes), 3)
        self.assertEqual(len(seen_error_codes), 3)

    def test_mutated_planner_response_fails_caller_side_recheck(self) -> None:
        obs = _observation()
        table = _element_table()
        baseline = plan(obs, table, "Continue")
        self.assertEqual(recheck_plan(baseline, obs, table), baseline)

        mutations: list[tuple[str, object, str]] = []

        # Out-of-frame click in response
        m_oob = copy.deepcopy(baseline)
        m_oob["action"]["x"] = obs["frame_ref"]["width"] + 5
        mutations.append(("click_out_of_frame", m_oob, "out_of_bounds"))

        # Click outside target bbox (still inside frame)
        m_align = copy.deepcopy(baseline)
        m_align["action"]["x"] = 95
        mutations.append(("click_outside_target_bbox", m_align, "alignment"))

        # Expectation bbox mismatching target bbox
        m_exp_bbox = copy.deepcopy(baseline)
        m_exp_bbox["expectation"]["bbox"]["w"] = 10
        mutations.append(("expectation_bbox_mismatch", m_exp_bbox, "alignment"))

        # Non-click action
        m_action = copy.deepcopy(baseline)
        m_action["action"] = {"type": "wait", "ms": 10}
        mutations.append(("non_click_action", m_action, "bad_shape"))

        # Wrong expectation type
        m_exp_type = copy.deepcopy(baseline)
        m_exp_type["expectation"] = {"type": "text_present", "text": "Continue"}
        mutations.append(("wrong_expectation_type", m_exp_type, "bad_shape"))

        # Target node role mutated relative to element table
        m_target = copy.deepcopy(baseline)
        m_target["target_node"]["role"] = "checkbox"
        mutations.append(("target_custody_mismatch", m_target, "bad_shape"))

        # State ax_sha256 tampered
        m_state = copy.deepcopy(baseline)
        m_state["state"]["ax_sha256"] = "0" * 64
        mutations.append(("state_digest_tampered", m_state, "bad_shape"))

        # Extra key in response
        m_extra = copy.deepcopy(baseline)
        m_extra["extra"] = 1
        mutations.append(("extra_response_key", m_extra, "bad_shape"))

        # Non-canonical float in action
        m_float = copy.deepcopy(baseline)
        m_float["action"]["x"] = 30.0
        mutations.append(("float_coordinate", m_float, "bad_shape"))

        for label, mutated, expected_code in mutations:
            with self.subTest(mutation=label):
                with self.assertRaises(PlannerError) as ctx:
                    recheck_plan(mutated, obs, table)
                self.assertEqual(ctx.exception.code, expected_code)

    def test_additional_input_and_cli_hygiene_rails(self) -> None:
        obs = _observation()
        table = _element_table()

        # Generation control target refused
        stop_table = _element_table(
            elements=[
                {
                    "bbox": {"x": 10, "y": 20, "w": 40, "h": 20},
                    "role": "button",
                    "name": "Stop generating",
                    "score_ppm": 950_000,
                }
            ]
        )
        with self.assertRaises(PlannerError) as ctx:
            plan(obs, stop_table, "Stop")
        self.assertEqual(ctx.exception.code, "generation_control")

        # Empty element list refused
        empty_table = _element_table(elements=[])
        with self.assertRaises(PlannerError) as ctx:
            plan(obs, empty_table, "Continue")
        self.assertEqual(ctx.exception.code, "no_target")

        # Duplicate JSON keys and invalid CLI args refused via main()
        for raw_in in (
            "",
            "{}",
            '{"observation":{},"element_table":{},"goal":"a","goal":"b"}',
            '{"observation":{},"element_table":{},"goal":"a","extra":1}',
        ):
            in_buf = io.StringIO(raw_in)
            out_buf = io.StringIO()
            err_buf = io.StringIO()
            rc = planner.main([], stdin=in_buf, stdout=out_buf, stderr=err_buf)
            self.assertEqual(rc, EXIT_CODES["bad_shape"])
            self.assertEqual(out_buf.getvalue(), "")
            self.assertTrue(err_buf.getvalue().startswith("bad_shape: "))

        out_buf = io.StringIO()
        err_buf = io.StringIO()
        rc = planner.main(["--unexpected"], stdin=io.StringIO("{}"), stdout=out_buf, stderr=err_buf)
        self.assertEqual(rc, EXIT_CODES["bad_shape"])
        self.assertEqual(out_buf.getvalue(), "")
        self.assertTrue(err_buf.getvalue().startswith("bad_shape: "))

    def test_invoke_planner_cmd_default_wender_and_lock_verification(self) -> None:
        holdings_obs = {
            "schema": "observation/v0.2",
            "frame_ref": _frame_ref(),
            "ground_truth": {
                "source": "holdings_lane",
                "state_sha256": "c" * 64,
                "tick": 10,
            },
        }
        expected_proposal = planner.plan_holdings(holdings_obs, proposal_id="p-lock-1")

        with tempfile.TemporaryDirectory(prefix="planner-lock-") as tmp_dir:
            repo = Path(tmp_dir).resolve()
            pkg = repo / "wender" / "plan"
            pkg.mkdir(parents=True)
            (repo / "wender" / "__init__.py").write_text("", encoding="utf-8")
            (pkg / "__init__.py").write_text("", encoding="utf-8")
            (pkg / "cli.py").write_text(
                "import sys\nsys.stdout.write("
                + repr(canonical_json(expected_proposal))
                + ")\n",
                encoding="utf-8",
            )
            git_env = {
                "PATH": os.environ.get("PATH", os.defpath),
                "HOME": os.devnull,
                "LANG": "C",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_AUTHOR_NAME": "Test",
                "GIT_AUTHOR_EMAIL": "test@example.invalid",
                "GIT_COMMITTER_NAME": "Test",
                "GIT_COMMITTER_EMAIL": "test@example.invalid",
            }
            for args in (
                ["init", "-q"],
                ["add", "."],
                ["commit", "-q", "-m", "init"],
            ):
                subprocess.run(["git", "-C", str(repo), *args], env=git_env, check=True)
            head = subprocess.run(
                ["git", "-C", str(repo), "rev-parse", "HEAD"],
                env=git_env,
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()

            with tempfile.TemporaryDirectory(prefix="planner-lockfile-") as lock_dir:
                good_lock = Path(lock_dir) / "good.lock"
                good_lock.write_text(
                    json.dumps(
                        {
                            "components": [
                                {"name": "vision-engine", "commit": "a" * 40},
                                {"name": "wender-agent", "commit": head},
                            ]
                        }
                    ),
                    encoding="utf-8",
                )
                bad_lock = Path(lock_dir) / "bad.lock"
                bad_lock.write_text(
                    json.dumps(
                        {
                            "components": [
                                {"name": "vision-engine", "commit": "a" * 40},
                                {"name": "wender-agent", "commit": "f" * 40},
                            ]
                        }
                    ),
                    encoding="utf-8",
                )

                with patch.dict(
                    os.environ, {"MV_WENDER_ROOT": str(repo)}, clear=False
                ):
                    os.environ.pop("MV_WENDER_PLANNER_CMD", None)
                    result = planner.invoke_planner_cmd(
                        holdings_obs,
                        proposal_id="p-lock-1",
                        lock_path=good_lock,
                    )
                    self.assertEqual(result, expected_proposal)

                    with self.assertRaises(PlannerError) as ctx:
                        planner.invoke_planner_cmd(
                            holdings_obs,
                            proposal_id="p-lock-1",
                            lock_path=bad_lock,
                        )
                    self.assertEqual(ctx.exception.code, "commit_mismatch")

                    (pkg / "untracked.py").write_text("x = 1\n", encoding="utf-8")
                    with self.assertRaises(PlannerError) as ctx:
                        planner.invoke_planner_cmd(
                            holdings_obs,
                            proposal_id="p-lock-1",
                            lock_path=good_lock,
                        )
                    self.assertEqual(ctx.exception.code, "dirty_tree")


if __name__ == "__main__":
    unittest.main()
