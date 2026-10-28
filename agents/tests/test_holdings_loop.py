"""Hosted-safe tests for Holdings planner and 10-trial loop runner (AC05-H3)."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

AGENTS_ROOT = Path(__file__).resolve().parents[1]
if str(AGENTS_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENTS_ROOT))

from metaviewer_agents import loop_trials, planner, tools  # noqa: E402
from metaviewer_agents.loop_trials import (  # noqa: E402
    FakeHoldingsToolClient,
    LoopReportError,
    REPORT_SCHEMA,
    compute_ratio,
    make_holdings_double,
    make_scripted_double,
    run_holdings_trials,
    run_trials,
    validate_report,
)
from metaviewer_agents.planner import (  # noqa: E402
    DEFAULT_TICK_WINDOW,
    EXIT_CODES,
    PlannerError,
    canonical_json,
    invoke_planner_cmd,
    plan,
    plan_holdings,
    plan_holdings_step,
    recheck_holdings_proposal,
    recheck_plan,
)
from metaviewer_agents.wender_bridge import WenderSubprocessAdapter  # noqa: E402


def _holdings_frame(
    *,
    surface_id: str = "holdings-1",
    generation: int = 1,
    tick: int = 10,
    width: int = 128,
    height: int = 96,
) -> dict:
    seed = f"holdings-frame:{surface_id}:{generation}:{tick}".encode("utf-8")
    return {
        "schema": "frame_ref/v0.2",
        "surface_id": surface_id,
        "generation": generation,
        "tick": tick,
        "ts_ns": tick * 100,
        "width": width,
        "height": height,
        "format": "rgb24",
        "ramws_path": "/dev/shm/holdings-fixture",
        "sha256": hashlib.sha256(seed).hexdigest(),
        "capture_us": 12,
    }


def _holdings_observation(
    *,
    frame: dict | None = None,
    tick: int | None = None,
    state_sha256: str | None = None,
    with_vision: bool = False,
) -> dict:
    active_frame = _holdings_frame() if frame is None else copy.deepcopy(frame)
    gt_tick = active_frame["tick"] if tick is None else tick
    gt_sha = (
        hashlib.sha256(f"holdings-state:{gt_tick}".encode("utf-8")).hexdigest()
        if state_sha256 is None
        else state_sha256
    )
    obs: dict = {
        "schema": "observation/v0.2",
        "frame_ref": active_frame,
        "ground_truth": {
            "source": "holdings_lane",
            "state_sha256": gt_sha,
            "tick": gt_tick,
        },
    }
    if with_vision:
        obs["vision"] = {
            "summary": "holdings capsule view",
            "changed_regions": [{"x": 8, "y": 12, "w": 32, "h": 24}],
            "elements": [
                {
                    "bbox": {"x": 8, "y": 12, "w": 32, "h": 24},
                    "role": "button",
                    "name": "Advance",
                    "confidence": 0.95,
                }
            ],
        }
    return obs


class HoldingsLoopTests(unittest.TestCase):
    def run_planner_cli(self, payload: str | bytes) -> subprocess.CompletedProcess:
        raw = payload.encode("utf-8") if isinstance(payload, str) else payload
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
            input=raw,
            capture_output=True,
            timeout=30,
            check=False,
        )

    def test_planner_emits_input_action_and_state_sha256_change_never_lane_submit(self) -> None:
        obs = _holdings_observation()
        proposal = plan(obs, proposal_id="p-holdings-1", tick_window=4)

        self.assertEqual(proposal["schema"], "action_proposal/v0.2")
        self.assertEqual(proposal["proposal_id"], "p-holdings-1")
        self.assertEqual(proposal["surface_id"], "holdings-1")
        self.assertEqual(
            proposal["based_on_frame"],
            {
                "sha256": obs["frame_ref"]["sha256"],
                "generation": obs["frame_ref"]["generation"],
            },
        )
        self.assertNotEqual(proposal["action"]["type"], "lane_submit")
        self.assertEqual(
            proposal["action"],
            {"type": "click", "x": 64, "y": 48, "button": "left"},
        )
        self.assertEqual(
            proposal["expectation"],
            {
                "type": "state_sha256_change",
                "before": obs["ground_truth"]["state_sha256"],
                "min_tick": obs["ground_truth"]["tick"] + 1,
                "max_tick": obs["ground_truth"]["tick"] + 4,
            },
        )
        self.assertEqual(recheck_holdings_proposal(proposal, obs), proposal)
        self.assertEqual(recheck_plan(proposal, obs), proposal)
        self.assertEqual(tools._check_proposal(proposal), proposal)

        # With vision elements present, planner clicks inside the highest-confidence target bbox
        obs_vis = _holdings_observation(with_vision=True)
        proposal_vis = plan_holdings(obs_vis, proposal_id="p-holdings-vis")
        self.assertEqual(
            proposal_vis["action"],
            {"type": "click", "x": 24, "y": 24, "button": "left"},
        )
        self.assertEqual(
            proposal_vis["expectation"]["before"],
            obs_vis["ground_truth"]["state_sha256"],
        )

        # Explicitly reject lane_submit in all Holdings planner entry points
        lane_action = {
            "type": "lane_submit",
            "verb": "submit",
            "payload": {"nonce": "n-1", "seq": 1, "command": "step", "args": []},
        }
        with self.assertRaises(PlannerError) as ctx_step:
            plan_holdings_step(obs, action=lane_action)
        self.assertEqual(ctx_step.exception.code, "policy")
        self.assertEqual(ctx_step.exception.exit_code, EXIT_CODES["policy"])

        with self.assertRaises(PlannerError) as ctx_prop:
            plan_holdings(obs, action=lane_action)
        self.assertEqual(ctx_prop.exception.code, "policy")

        mutated_lane = copy.deepcopy(proposal)
        mutated_lane["action"] = lane_action
        with self.assertRaises(PlannerError) as ctx_recheck:
            recheck_holdings_proposal(mutated_lane, obs)
        self.assertEqual(ctx_recheck.exception.code, "policy")

        # Out-of-bounds click action rejected by planner
        oob_action = {"type": "click", "x": 500, "y": 20, "button": "left"}
        with self.assertRaises(PlannerError) as ctx_oob:
            plan_holdings(obs, action=oob_action)
        self.assertEqual(ctx_oob.exception.code, "out_of_bounds")

        # Missing ground_truth rejected for Holdings planner
        obs_no_gt = {"schema": "observation/v0.2", "frame_ref": _holdings_frame()}
        with self.assertRaises(PlannerError) as ctx_no_gt:
            plan(obs_no_gt)
        self.assertEqual(ctx_no_gt.exception.code, "bad_shape")

    def test_external_planner_cli_and_mv_wender_planner_cmd_contracts(self) -> None:
        obs = _holdings_observation()
        proc = self.run_planner_cli(canonical_json(obs))
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", errors="replace"))
        self.assertEqual(proc.stderr, b"")
        proposal = json.loads(proc.stdout.decode("utf-8"))
        self.assertEqual(proposal["schema"], "action_proposal/v0.2")
        self.assertNotEqual(proposal["action"]["type"], "lane_submit")
        self.assertEqual(proposal["expectation"]["type"], "state_sha256_change")
        self.assertEqual(
            proposal["expectation"]["before"],
            obs["ground_truth"]["state_sha256"],
        )
        self.assertEqual(
            proposal["expectation"]["min_tick"],
            obs["ground_truth"]["tick"] + 1,
        )
        self.assertEqual(
            proposal["expectation"]["max_tick"],
            obs["ground_truth"]["tick"] + DEFAULT_TICK_WINDOW,
        )
        self.assertEqual(recheck_holdings_proposal(proposal, obs), proposal)

        # Also verify invoke_planner_cmd and run_holdings_trials with MV_WENDER_PLANNER_CMD set
        cmd_argv = [sys.executable, "-m", "metaviewer_agents.planner"]
        invoked = invoke_planner_cmd(obs, command=cmd_argv, proposal_id="p-ext-1")
        self.assertEqual(invoked["proposal_id"], "p-ext-1")
        self.assertEqual(invoked["action"], proposal["action"])
        self.assertEqual(invoked["expectation"], proposal["expectation"])

        cmd_json = json.dumps(cmd_argv)
        with patch.dict(os.environ, {"MV_WENDER_PLANNER_CMD": cmd_json}), patch(
            "metaviewer_agents.perception.deps_lock.resolve_locked_component",
            return_value=AGENTS_ROOT,
        ):
            factory, _, clients = make_holdings_double(
                trials=10,
                verified_count=10,
                with_vision=True,
            )
            report = run_holdings_trials(
                client_factory=factory,
                planner=None,
                trials=10,
                min_verified=9,
                timeout_ms=5000,
                goal="Advance",
            )
            self.assertTrue(report["pass"])
            self.assertEqual(report["verified"], 10)
            for client in clients:
                self.assertEqual(client.ops, ["observe", "propose", "wait_verify"])
                self.assertNotEqual(client.proposals[0]["action"]["type"], "lane_submit")
                self.assertEqual(
                    client.proposals[0]["expectation"]["type"],
                    "state_sha256_change",
                )

        # WenderSubprocessAdapter compatibility when element_table is also provided
        obs_vis = _holdings_observation(with_vision=True)
        element_table = {
            "schema": "vqa.element-table/v1",
            "frame_sha256": obs_vis["frame_ref"]["sha256"],
            "width": obs_vis["frame_ref"]["width"],
            "height": obs_vis["frame_ref"]["height"],
            "elements": [
                {
                    "bbox": {"x": 8, "y": 12, "w": 32, "h": 24},
                    "role": "button",
                    "name": "Advance",
                    "score_ppm": 950_000,
                }
            ],
        }
        bridge = WenderSubprocessAdapter(
            command=[sys.executable, "-m", "metaviewer_agents.planner"],
            wender_root=AGENTS_ROOT,
            timeout=30,
        )
        action, expectation, _, _ = bridge.plan_step(obs_vis, element_table, "Advance")
        self.assertEqual(action, {"type": "click", "x": 24, "y": 24, "button": "left"})
        self.assertEqual(
            expectation,
            {
                "type": "state_sha256_change",
                "before": obs_vis["ground_truth"]["state_sha256"],
                "min_tick": obs_vis["ground_truth"]["tick"] + 1,
                "max_tick": obs_vis["ground_truth"]["tick"] + DEFAULT_TICK_WINDOW,
            },
        )

    def test_10_trial_holdings_loop_passes_at_10_of_10_and_9_of_10_with_witness_present(self) -> None:
        for target_verified in (10, 9):
            with self.subTest(target_verified=target_verified):
                factory, holdings_planner, clients = make_holdings_double(
                    trials=10,
                    verified_count=target_verified,
                    fault="stale_frame",
                )
                report = run_holdings_trials(
                    client_factory=factory,
                    planner=holdings_planner,
                    trials=10,
                    min_verified=9,
                    timeout_ms=1000,
                )
                self.assertEqual(report["schema"], REPORT_SCHEMA)
                self.assertEqual(report["trials"], 10)
                self.assertEqual(report["verified"], target_verified)
                self.assertTrue(report["pass"])
                self.assertEqual(len(report["results"]), 10)
                self.assertEqual(len(clients), 10)

                for idx, row in enumerate(report["results"], start=1):
                    client = clients[idx - 1]
                    self.assertEqual(row["trial"], idx)
                    self.assertEqual(row["kind"], "holdings")
                    self.assertEqual(len(client.proposals), 1)
                    submitted = client.proposals[0]
                    self.assertNotEqual(submitted["action"]["type"], "lane_submit")
                    self.assertEqual(
                        submitted["expectation"]["type"],
                        "state_sha256_change",
                    )
                    if idx <= target_verified:
                        self.assertTrue(row["verified"])
                        self.assertTrue(row["witness_present"])
                        self.assertEqual(row["status"], "verified")
                        self.assertEqual(row["code"], "OK")
                        self.assertEqual(
                            client.ops,
                            ["observe", "propose", "wait_verify"],
                        )
                        self.assertEqual(len(client.admitted_verdicts), 1)
                        self.assertEqual(len(client.dispatched_actions), 1)
                    else:
                        self.assertFalse(row["verified"])
                        self.assertFalse(row["witness_present"])
                        self.assertEqual(row["status"], "refused")
                        self.assertEqual(row["code"], "STALE_FRAME")
                        self.assertEqual(client.ops, ["observe", "propose"])
                        self.assertEqual(client.admitted_verdicts, [])
                        self.assertEqual(client.dispatched_actions, [])

                self.assertEqual(validate_report(report, kind="holdings"), report)

        # Also verify make_scripted_double never emits lane_submit for holdings
        s_factory, s_planner, s_clients = make_scripted_double(
            trials=10,
            verified_count=10,
        )
        s_report = run_trials(
            client_factory=s_factory,
            planner=s_planner,
            trials=10,
            min_verified=9,
            timeout_ms=1000,
        )
        self.assertTrue(s_report["pass"])
        for idx, client in enumerate(s_clients, start=1):
            self.assertNotEqual(
                client.proposals[0]["action"]["type"],
                "lane_submit",
                f"trial {idx} emitted forbidden lane_submit",
            )

    def test_ac05_negative_controls_stale_frame_replayed_nonce_oob_and_missing_witness(self) -> None:
        faults_by_trial = {
            2: "stale_frame",
            4: "replayed_nonce",
            6: "out_of_bounds",
            8: "missing_witness",
            9: "unverified_receipt",
            10: "wrong_witness_method",
        }
        factory, holdings_planner, clients = make_holdings_double(
            trials=10,
            verified_count=10,
            faults_by_trial=faults_by_trial,
        )
        report = run_holdings_trials(
            client_factory=factory,
            planner=holdings_planner,
            trials=10,
            min_verified=9,
            timeout_ms=1000,
        )

        # Only trials 1, 3, 5, 7 have a valid witness and verify -> 4/10 -> fails gate
        self.assertEqual(report["trials"], 10)
        self.assertEqual(report["verified"], 4)
        self.assertFalse(report["pass"])

        # Trial 2: stale frame -> STALE_FRAME refusal, no act, no wait_verify
        r2 = report["results"][1]
        self.assertFalse(r2["verified"])
        self.assertFalse(r2["witness_present"])
        self.assertEqual(r2["status"], "refused")
        self.assertEqual(r2["code"], "STALE_FRAME")
        self.assertEqual(clients[1].ops, ["observe", "propose"])
        self.assertEqual(clients[1].dispatched_actions, [])

        # Trial 4: replayed nonce -> POLICY refusal, no act, no wait_verify
        r4 = report["results"][3]
        self.assertFalse(r4["verified"])
        self.assertFalse(r4["witness_present"])
        self.assertEqual(r4["status"], "refused")
        self.assertEqual(r4["code"], "POLICY")
        self.assertEqual(clients[3].ops, ["observe", "propose"])
        self.assertEqual(clients[3].dispatched_actions, [])

        # Trial 6: out-of-bounds -> OUT_OF_BOUNDS refusal, no act, no wait_verify
        r6 = report["results"][5]
        self.assertFalse(r6["verified"])
        self.assertFalse(r6["witness_present"])
        self.assertEqual(r6["status"], "refused")
        self.assertEqual(r6["code"], "OUT_OF_BOUNDS")
        self.assertEqual(clients[5].ops, ["observe", "propose"])
        self.assertEqual(clients[5].dispatched_actions, [])

        # Trial 8: missing witness (wait_verify timeout) -> verified=False, witness_present=False
        r8 = report["results"][7]
        self.assertFalse(r8["verified"])
        self.assertFalse(r8["witness_present"])
        self.assertEqual(r8["status"], "timeout")
        self.assertEqual(r8["code"], "TIMEOUT")
        self.assertEqual(clients[7].ops, ["observe", "propose", "wait_verify"])

        # Trial 9: receipt verified=False -> verified=False, witness_present=False
        r9 = report["results"][8]
        self.assertFalse(r9["verified"])
        self.assertFalse(r9["witness_present"])
        self.assertEqual(r9["status"], "unverified")

        # Trial 10: pixel method instead of state_sha256 witness -> verified=False, witness_present=False
        r10 = report["results"][9]
        self.assertFalse(r10["verified"])
        self.assertFalse(r10["witness_present"])
        self.assertEqual(r10["status"], "unverified")
        self.assertEqual(r10["code"], "MISSING_WITNESS")

    def test_8_of_10_holdings_fixture_fails_ratio_gate_and_integer_ratio_controls(self) -> None:
        factory, holdings_planner, clients = make_holdings_double(
            trials=10,
            verified_count=8,
            fault="missing_witness",
        )
        report = run_holdings_trials(
            client_factory=factory,
            planner=holdings_planner,
            trials=10,
            min_verified=9,
            timeout_ms=1000,
        )
        self.assertEqual(report["trials"], 10)
        self.assertEqual(report["verified"], 8)
        self.assertFalse(report["pass"])
        self.assertEqual(sum(1 for r in report["results"] if r["witness_present"]), 8)
        self.assertEqual(sum(1 for r in report["results"] if r["verified"]), 8)
        self.assertFalse(report["results"][8]["verified"])
        self.assertFalse(report["results"][8]["witness_present"])
        self.assertFalse(report["results"][9]["verified"])
        self.assertFalse(report["results"][9]["witness_present"])
        self.assertEqual(len(clients), 10)

        # CLI --kind holdings with 8/10 exits 1, 9/10 exits 0
        out_8 = io.StringIO()
        err_8 = io.StringIO()
        rc_8 = loop_trials.main(
            ["--kind", "holdings", "--scripted-verified", "8"],
            stdout=out_8,
            stderr=err_8,
        )
        self.assertEqual(rc_8, 1)
        parsed_8 = json.loads(out_8.getvalue())
        self.assertEqual(parsed_8["verified"], 8)
        self.assertFalse(parsed_8["pass"])

        out_9 = io.StringIO()
        err_9 = io.StringIO()
        rc_9 = loop_trials.main(
            ["--kind", "holdings", "--scripted-verified", "9"],
            stdout=out_9,
            stderr=err_9,
        )
        self.assertEqual(rc_9, 0)
        parsed_9 = json.loads(out_9.getvalue())
        self.assertEqual(parsed_9["verified"], 9)
        self.assertTrue(parsed_9["pass"])

        # Exact integer ratio checks and rejection of booleans/floats
        self.assertEqual(compute_ratio(8, 10, min_verified=9), (8, 10, False))
        self.assertEqual(compute_ratio(9, 10, min_verified=9), (9, 10, True))
        self.assertEqual(compute_ratio(10, 10, min_verified=9), (10, 10, True))
        for bad_verified in (True, False, 9.0, -1, 11):
            with self.assertRaises(ValueError):
                compute_ratio(bad_verified, 10, min_verified=9)  # type: ignore[arg-type]

        # Tampering witness_present on report fails validate_report
        tampered_witness = copy.deepcopy(report)
        tampered_witness["results"][0]["witness_present"] = False
        with self.assertRaises(LoopReportError) as ctx:
            validate_report(tampered_witness, kind="holdings")
        self.assertEqual(ctx.exception.code, "bad_shape")


if __name__ == "__main__":
    unittest.main()
