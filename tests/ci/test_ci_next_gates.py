import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

from tests.ci.test_round2_t7_regressions import load_ci_f4_namespace


ROOT = Path(__file__).resolve().parents[2]
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
VOLUME_WORKFLOW = ROOT / ".github" / "workflows" / "volume.yml"
BUDGETS_PATH = ROOT / "tests" / "perf" / "budgets.json"


def job_block(workflow_text: str, job_name: str) -> str:
    lines = workflow_text.splitlines(keepends=True)
    in_jobs = False
    start = None
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            in_jobs = stripped == "jobs:"
            if start is not None:
                return "".join(lines[start:idx])
            continue
        if in_jobs and indent == 2 and stripped.startswith(f"{job_name}:"):
            start = idx
        elif in_jobs and indent == 2 and start is not None and stripped.endswith(":"):
            return "".join(lines[start:idx])
    if start is not None:
        return "".join(lines[start:])
    raise AssertionError(f"job {job_name} not found")


def step_run(workflow_text: str, job_name: str, step_name: str) -> str:
    parsed = yaml.safe_load(workflow_text)
    jobs = (parsed or {}).get("jobs") or {}
    job = jobs.get(job_name)
    if not isinstance(job, dict):
        raise AssertionError(f"job {job_name} not found")
    for step in job.get("steps") or []:
        if isinstance(step, dict) and step.get("name") == step_name and isinstance(step.get("run"), str):
            return step["run"]
    raise AssertionError(f"step {step_name!r} in job {job_name!r} not found")


def top_on_triggers(workflow_text: str) -> set[str]:
    lines = workflow_text.splitlines()
    triggers: set[str] = set()
    in_on = False
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            in_on = stripped == "on:"
            continue
        if in_on and indent == 2 and ":" in stripped:
            triggers.add(stripped.split(":", 1)[0].strip())
    return triggers


def validate_ac14_workflow_wiring(ci_text: str) -> list[str]:
    errors: list[str] = []
    try:
        req_block = job_block(ci_text, "ci-required")
    except AssertionError:
        return ["missing_ci_required_job"]
    if "ubuntu-24.04" not in req_block or "ubuntu-24.04-arm" not in req_block:
        errors.append("ci_required_missing_linux_matrix")
    if "platform: x64" not in req_block or "platform: arm64" not in req_block:
        errors.append("ci_required_missing_arch_platforms")
    try:
        budget_step = step_run(ci_text, "ci-required", "Run AC-14 budget gate")
    except AssertionError:
        errors.append("missing_ci_required_budget_step")
        return errors
    if "tools/budget_gate.py --self-test" not in budget_step:
        errors.append("missing_budget_gate_self_test")
    if "tests/e2e/e2e18_budgets.test.js" not in budget_step:
        errors.append("missing_e2e18_budgets_journey")
    if "tests/e2e/e2e14_perf.test.js" not in budget_step:
        errors.append("missing_e2e14_perf_journey")
    if "tests/perf/budgets.json" not in budget_step:
        errors.append("missing_frozen_budgets_json")
    if "finish_gate budgets" not in budget_step:
        errors.append("missing_budgets_receipt_emission")
    if req_block.find("name: Run AC-14 budget gate") > req_block.find("name: Aggregate required results"):
        errors.append("budget_gate_after_aggregator")
    try:
        e2e_step = step_run(ci_text, "e2e", "Run E2E gate under xvfb")
    except AssertionError:
        errors.append("missing_e2e_step")
        return errors
    if "tests/perf/budgets.json" not in e2e_step or "RSS_CAPS" not in e2e_step:
        errors.append("e2e_missing_budget_verification")
    return errors


def validate_ac02_soak_workflow_wiring(volume_text: str) -> list[str]:
    errors: list[str] = []
    triggers = top_on_triggers(volume_text)
    if triggers != {"schedule", "workflow_dispatch"}:
        errors.append(f"invalid_volume_triggers:{sorted(triggers)}")
    try:
        ve2e_step = step_run(volume_text, "volume-e2e", "Run E2E repeat x20 then qualification x300")
    except AssertionError:
        errors.append("missing_volume_e2e_step")
        return errors
    if 'SOAK_SECS="${MV_SOAK_SECS:-600}"' not in ve2e_step:
        errors.append("missing_600s_soak_default")
    if "timeout 660" not in ve2e_step:
        errors.append("missing_soak_timeout_bound")
    if "tests/e2e/perf-main.cjs" not in ve2e_step:
        errors.append("missing_soak_perf_main_runner")
    if "finish_gate volume-wall-soak" not in ve2e_step:
        errors.append("missing_soak_receipt_emission")
    if "frames_per_tile" not in ve2e_step or "stalls_per_tile" not in ve2e_step:
        errors.append("missing_soak_tile_metrics")
    return errors


def validate_scheduled_mutant_workflow_wiring(ci_text: str, volume_text: str) -> list[str]:
    errors: list[str] = []
    ci_triggers = top_on_triggers(ci_text)
    if "schedule" not in ci_triggers:
        errors.append("ci_missing_schedule_trigger")
    try:
        py_block = job_block(ci_text, "python")
        py_step = step_run(ci_text, "python", "Run Python agent gates")
    except AssertionError:
        errors.append("missing_python_job_or_step")
        return errors
    if "GITHUB_EVENT_NAME: ${{ github.event_name }}" not in py_block:
        errors.append("python_job_missing_event_name_env")
    sched_guard = re.search(
        r'if\s+\[\s*"\$\{GITHUB_EVENT_NAME:-\}"\s*=\s*"schedule"\s*\];\s*then(.*?)fi',
        py_step,
        re.S,
    )
    if not sched_guard or "agents/tests/run_mutant_harness.py" not in sched_guard.group(1):
        errors.append("python_step_mutant_harness_not_schedule_gated")
    outside = py_step[: sched_guard.start()] + py_step[sched_guard.end() :] if sched_guard else py_step
    if "run_mutant_harness.py" in outside:
        errors.append("python_step_mutant_harness_runs_outside_schedule")
    try:
        vmut_step = step_run(volume_text, "volume-mutants", "Run contract mutants x100")
    except AssertionError:
        errors.append("missing_volume_mutants_step")
        return errors
    if "agents/tests/run_mutant_harness.py" not in vmut_step:
        errors.append("volume_mutants_missing_mutant_harness")
    return errors


def extract_soak_segment(volume_step: str) -> str:
    idx = volume_step.find("finish_gate volume-e2e ")
    assert idx != -1, "finish_gate volume-e2e not found"
    soak_idx = volume_step.find('LOG="$EVDIR/volume-wall-soak.log"', idx)
    assert soak_idx != -1, "volume-wall-soak segment not found"
    prefix_end = volume_step.find('HARNESS="tests/e2e/run.py"')
    assert prefix_end != -1, "HARNESS preamble not found"
    return volume_step[:prefix_end] + "\n" + volume_step[soak_idx:]


def make_soak_report(
    *,
    started: float = 1000.0,
    ended: float = 4200.0,
    tile_fps: float = 20.0,
    stall_tile_id: str | None = None,
    folded_advance: bool = True,
) -> dict:
    duration_ms = ended - started
    frame_count = max(2, int(round(duration_ms * tile_fps / 1000.0)))
    step_ms = duration_ms / frame_count
    visible = []
    for i in range(1, 5):
        tid = f"tile-{i}"
        if tid == stall_tile_id:
            times = [started + 100.0, ended - 50.0]
        else:
            times = [round(started + (k + 0.5) * step_ms, 2) for k in range(frame_count)]
        visible.append(
            {
                "id": tid,
                "times": times,
                "pixel": [20 * i, 40, 80, 255],
                "expectedPixel": [20 * i, 40, 80, 255],
                "info": {
                    "presentCount": len(times),
                    "lastCaptureGeneration": len(times),
                },
            }
        )
    return {
        "schema": "metaviewer.perf-wall/v1",
        "capture": "synthetic-rgb24",
        "started": started,
        "ended": ended,
        "visible": visible,
        "folded": {
            "id": "tile-5",
            "hidden": True,
            "before": {
                "folded": True,
                "captureLeaseActive": True,
                "lastCaptureGeneration": 5,
                "drawSubmissions": 3,
            },
            "after": {
                "folded": True,
                "captureLeaseActive": True,
                "lastCaptureGeneration": 15 if folded_advance else 5,
                "drawSubmissions": 3,
            },
        },
    }


class CiNextGatesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.ci_text = CI_WORKFLOW.read_text(encoding="utf-8")
        cls.volume_text = VOLUME_WORKFLOW.read_text(encoding="utf-8")
        cls.f4_ns = load_ci_f4_namespace()
        cls.receipt_errors = staticmethod(cls.f4_ns["receipt_errors"])

    def _prepare_workspace(self, tmp: Path) -> Path:
        ws = tmp / "ws"
        (ws / ".github" / "workflows").mkdir(parents=True)
        shutil.copy2(CI_WORKFLOW, ws / ".github" / "workflows" / "ci.yml")
        shutil.copy2(VOLUME_WORKFLOW, ws / ".github" / "workflows" / "volume.yml")
        (ws / "tools").mkdir(parents=True)
        shutil.copy2(ROOT / "tools" / "budget_gate.py", ws / "tools" / "budget_gate.py")
        (ws / "tests" / "perf").mkdir(parents=True)
        shutil.copy2(BUDGETS_PATH, ws / "tests" / "perf" / "budgets.json")
        (ws / "tests" / "e2e").mkdir(parents=True)
        (ws / "tests" / "e2e" / "e2e14_perf.test.js").write_text("// stub\n", encoding="utf-8")
        (ws / "agents").mkdir(parents=True)
        shutil.copy2(ROOT / "agents" / "pyproject.toml", ws / "agents" / "pyproject.toml")
        return ws

    def _run_budget_step(self, log_lines: list[str], fixture_rc: int = 0) -> tuple[int, dict, Path]:
        step_script = step_run(self.ci_text, "ci-required", "Run AC-14 budget gate")
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            ws = self._prepare_workspace(tmp)
            fixture_log = tmp / "budget-fixture.log"
            fixture_log.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
            summary = tmp / "summary.md"
            summary.write_text("", encoding="utf-8")
            env = os.environ.copy()
            env.update(
                {
                    "RUNNER_TEMP": str(tmp),
                    "GITHUB_WORKSPACE": str(ws),
                    "GITHUB_RUN_ID": "901",
                    "GITHUB_SHA": "b" * 40,
                    "GITHUB_STEP_SUMMARY": str(summary),
                    "JOB_ID": "ci-required",
                    "PLATFORM": "x64",
                    "MV_BUDGET_LOG_FIXTURE": str(fixture_log),
                    "MV_BUDGET_FIXTURE_RC": str(fixture_rc),
                }
            )
            proc = subprocess.run(
                ["bash", "-c", step_script],
                cwd=ws,
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )
            receipt_path = tmp / "metaviewer-ci" / "ci-required" / "x64" / "budgets.receipt.json"
            self.assertTrue(receipt_path.is_file(), proc.stdout + proc.stderr)
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            wf_sha = hashlib.sha256((ws / ".github" / "workflows" / "ci.yml").read_bytes()).hexdigest()
            inst_sha = hashlib.sha256((ws / "tests" / "perf" / "budgets.json").read_bytes()).hexdigest()
            errs = self.receipt_errors(
                receipt,
                {
                    "gate_revision": "b" * 40,
                    "configuration_sha256": wf_sha,
                    "instrument_sha256": inst_sha,
                },
            )
            self.assertEqual(errs, [], f"receipt schema errors: {errs}")
            return proc.returncode, receipt, receipt_path

    def test_ac14_budget_gate_workflow_and_execution_positive_and_negative_controls(self) -> None:
        self.assertEqual(validate_ac14_workflow_wiring(self.ci_text), [])

        good_rss = {
            "rss_main_bytes": 125000000,
            "rss_renderer_bytes": 265000000,
            "rss_tree_bytes": 710000000,
        }
        good_perf = [
            {"id": "tile-1", "frames": 60, "fps": 19.8, "maxGapMs": 120, "presentCount": 60, "lastCaptureGeneration": 60},
            {"id": "tile-2", "frames": 59, "fps": 19.5, "maxGapMs": 130, "presentCount": 59, "lastCaptureGeneration": 59},
            {"id": "tile-3", "frames": 61, "fps": 20.1, "maxGapMs": 115, "presentCount": 61, "lastCaptureGeneration": 61},
            {"id": "tile-4", "frames": 58, "fps": 19.2, "maxGapMs": 140, "presentCount": 58, "lastCaptureGeneration": 58},
        ]
        rc, receipt, _ = self._run_budget_step(
            [
                f"RSS_CAPS [MEASURED]: {json.dumps(good_rss)}",
                f"PERF_WALL [MEASURED]: {json.dumps(good_perf)}",
            ]
        )
        self.assertEqual(rc, 0)
        self.assertEqual(receipt["outcome"], "PASS")
        self.assertEqual(receipt["product_identity"]["rss_caps_measured"], good_rss)
        self.assertEqual(receipt["product_identity"]["perf_wall_measured"], good_perf)
        self.assertEqual(
            receipt["product_identity"]["frozen_budgets_bytes"],
            {
                "rss_main_bytes": 200000000,
                "rss_renderer_bytes": 370000000,
                "rss_tree_bytes": 1150000000,
            },
        )
        by_id = {a["id"]: a for a in receipt["assertions"]}
        for key in ("rss_main_bytes", "rss_renderer_bytes", "rss_tree_bytes"):
            self.assertIn(key, by_id)
            self.assertTrue(by_id[key]["accepted"])
            self.assertIn("[MEASURED]", by_id[key]["observed"])

        # Negative controls: planted over-budget values fail the gate.
        for over_key, over_val in (
            ("rss_main_bytes", 200000001),
            ("rss_renderer_bytes", 370000001),
            ("rss_tree_bytes", 1150000001),
        ):
            planted = dict(good_rss, **{over_key: over_val})
            bad_rc, bad_receipt, _ = self._run_budget_step(
                [
                    f"RSS_CAPS [MEASURED]: {json.dumps(planted)}",
                    f"PERF_WALL [MEASURED]: {json.dumps(good_perf)}",
                ]
            )
            self.assertNotEqual(bad_rc, 0, f"{over_key} over-budget must fail")
            self.assertEqual(bad_receipt["outcome"], "FAIL")
            self.assertIn(over_key, bad_receipt["product_identity"]["failures"])
            bad_assertions = {a["id"]: a for a in bad_receipt["assertions"]}
            self.assertFalse(bad_assertions[over_key]["accepted"])

        # Negative control: planted under-budget FPS in PERF_WALL fails the gate.
        low_fps_perf = [dict(good_perf[0], fps=8.5), *good_perf[1:]]
        fps_rc, fps_receipt, _ = self._run_budget_step(
            [
                f"RSS_CAPS [MEASURED]: {json.dumps(good_rss)}",
                f"PERF_WALL [MEASURED]: {json.dumps(low_fps_perf)}",
            ]
        )
        self.assertNotEqual(fps_rc, 0)
        self.assertEqual(fps_receipt["outcome"], "FAIL")
        self.assertIn("perf_wall_fps:tile-1", fps_receipt["product_identity"]["failures"])

        # Negative control: missing measured output lines fails closed.
        miss_rc, miss_receipt, _ = self._run_budget_step(["no measurements printed"])
        self.assertNotEqual(miss_rc, 0)
        self.assertEqual(miss_receipt["outcome"], "FAIL")

        # Negative control: workflow mutations are rejected by wiring validator.
        self.assertNotEqual(
            validate_ac14_workflow_wiring(self.ci_text.replace("Run AC-14 budget gate", "Run other step")),
            [],
        )
        self.assertNotEqual(
            validate_ac14_workflow_wiring(self.ci_text.replace("tests/e2e/e2e18_budgets.test.js", "")),
            [],
        )

    def test_ac02_soak_workflow_and_execution_positive_and_negative_controls(self) -> None:
        self.assertEqual(validate_ac02_soak_workflow_wiring(self.volume_text), [])

        volume_step = step_run(self.volume_text, "volume-e2e", "Run E2E repeat x20 then qualification x300")
        soak_script = extract_soak_segment(volume_step)

        def run_soak(report_obj: dict, soak_secs: int = 3) -> tuple[int, dict]:
            with tempfile.TemporaryDirectory() as td:
                tmp = Path(td)
                ws = self._prepare_workspace(tmp)
                report_fixture = tmp / "soak-report-fixture.json"
                report_fixture.write_text(json.dumps(report_obj), encoding="utf-8")
                summary = tmp / "summary.md"
                summary.write_text("", encoding="utf-8")
                env = os.environ.copy()
                env.update(
                    {
                        "RUNNER_TEMP": str(tmp),
                        "GITHUB_WORKSPACE": str(ws),
                        "GITHUB_RUN_ID": "902",
                        "GITHUB_SHA": "c" * 40,
                        "GITHUB_STEP_SUMMARY": str(summary),
                        "JOB_ID": "volume-e2e",
                        "PLATFORM": "x64",
                        "MV_SOAK_SECS": str(soak_secs),
                        "MV_SOAK_REPORT_FIXTURE": str(report_fixture),
                    }
                )
                proc = subprocess.run(
                    ["bash", "-c", soak_script],
                    cwd=ws,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                receipt_path = tmp / "metaviewer-ci" / "volume-e2e" / "x64" / "volume-wall-soak.receipt.json"
                self.assertTrue(receipt_path.is_file(), proc.stdout + proc.stderr)
                receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                wf_sha = hashlib.sha256((ws / ".github" / "workflows" / "volume.yml").read_bytes()).hexdigest()
                inst_sha = hashlib.sha256((ws / "tests" / "e2e" / "e2e14_perf.test.js").read_bytes()).hexdigest()
                errs = self.receipt_errors(
                    receipt,
                    {
                        "gate_revision": "c" * 40,
                        "configuration_sha256": wf_sha,
                        "instrument_sha256": inst_sha,
                    },
                )
                self.assertEqual(errs, [], f"soak receipt schema errors: {errs}")
                return proc.returncode, receipt

        # Positive control: 4 live tiles >= 10 fps, 0 stalls.
        ok_rc, ok_receipt = run_soak(make_soak_report())
        self.assertEqual(ok_rc, 0)
        self.assertEqual(ok_receipt["outcome"], "PASS")
        prod = ok_receipt["product_identity"]
        self.assertEqual(prod["total_stalls"], 0)
        self.assertEqual(prod["stalled_tiles"], [])
        self.assertEqual(set(prod["frames_per_tile"]), {"tile-1", "tile-2", "tile-3", "tile-4"})
        self.assertEqual(prod["stalls_per_tile"], {"tile-1": 0, "tile-2": 0, "tile-3": 0, "tile-4": 0})
        tile_assertions = {a["id"]: a for a in ok_receipt["assertions"] if a["id"].startswith("soak-tile-")}
        self.assertEqual(len(tile_assertions), 4)
        self.assertTrue(all(a["accepted"] for a in tile_assertions.values()))

        # Negative control 1: stalled tile (frame gap > 2000ms) fails the soak.
        stall_rc, stall_receipt = run_soak(make_soak_report(stall_tile_id="tile-2"))
        self.assertNotEqual(stall_rc, 0)
        self.assertEqual(stall_receipt["outcome"], "FAIL")
        self.assertIn("tile-2", stall_receipt["product_identity"]["stalled_tiles"])
        self.assertGreater(stall_receipt["product_identity"]["total_stalls"], 0)
        stall_assertions = {a["id"]: a for a in stall_receipt["assertions"]}
        self.assertFalse(stall_assertions["soak-tile-tile-2"]["accepted"])

        # Negative control 2: low FPS (< 10 fps) fails the soak.
        fps_rc, fps_receipt = run_soak(make_soak_report(tile_fps=5.0))
        self.assertNotEqual(fps_rc, 0)
        self.assertEqual(fps_receipt["outcome"], "FAIL")
        self.assertEqual(len(fps_receipt["product_identity"]["stalled_tiles"]), 4)

        # Negative control 3: folded tile capture stall fails the soak.
        fold_rc, fold_receipt = run_soak(make_soak_report(folded_advance=False))
        self.assertNotEqual(fold_rc, 0)
        self.assertEqual(fold_receipt["outcome"], "FAIL")
        self.assertIn("folded_capture_stall", fold_receipt["product_identity"]["failures"])

        # Negative control 4: workflow mutations (push trigger, missing timeout, wrong soak default) fail.
        self.assertNotEqual(
            validate_ac02_soak_workflow_wiring(self.volume_text.replace("workflow_dispatch:", "push:")),
            [],
        )
        self.assertNotEqual(
            validate_ac02_soak_workflow_wiring(self.volume_text.replace("timeout 660", "timeout 60")),
            [],
        )
        self.assertNotEqual(
            validate_ac02_soak_workflow_wiring(
                self.volume_text.replace('SOAK_SECS="${MV_SOAK_SECS:-600}"', 'SOAK_SECS="60"')
            ),
            [],
        )

    def test_scheduled_mutant_harness_workflow_and_execution_positive_and_negative_controls(self) -> None:
        self.assertEqual(validate_scheduled_mutant_workflow_wiring(self.ci_text, self.volume_text), [])

        py_step = step_run(self.ci_text, "python", "Run Python agent gates")

        def run_python_step(event_name: str, mutant_rc: int) -> tuple[int, dict, bool]:
            with tempfile.TemporaryDirectory() as td:
                tmp = Path(td)
                ws = self._prepare_workspace(tmp)
                (ws / "agents" / "tests" / "test_unit_ passing.py").parent.mkdir(parents=True)
                (ws / "agents" / "tests" / "test_unit_passing.py").write_text(
                    "import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n",
                    encoding="utf-8",
                )
                marker = tmp / "mutant-harness-ran"
                (ws / "agents" / "tests" / "run_mutant_harness.py").write_text(
                    "import pathlib, sys\n"
                    f"pathlib.Path({str(marker)!r}).write_text('ran', encoding='utf-8')\n"
                    f"sys.exit({mutant_rc})\n",
                    encoding="utf-8",
                )
                summary = tmp / "summary.md"
                summary.write_text("", encoding="utf-8")
                env = os.environ.copy()
                env.update(
                    {
                        "RUNNER_TEMP": str(tmp),
                        "GITHUB_WORKSPACE": str(ws),
                        "GITHUB_RUN_ID": "903",
                        "GITHUB_SHA": "d" * 40,
                        "GITHUB_STEP_SUMMARY": str(summary),
                        "JOB_ID": "python",
                        "PLATFORM": "x64",
                        "EXPECT_ARCH": os.uname().machine,
                        "GITHUB_EVENT_NAME": event_name,
                    }
                )
                # Stub offline.sh in the temp workspace to execute directly.
                offline_sh = ws / ".github" / "workflows" / "offline.sh"
                offline_sh.write_text('#!/usr/bin/env bash\nexec "$@"\n', encoding="utf-8")
                offline_sh.chmod(0o755)
                proc = subprocess.run(
                    ["bash", "-c", py_step],
                    cwd=ws,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                receipt_path = tmp / "metaviewer-ci" / "python" / "x64" / "python-agents.receipt.json"
                self.assertTrue(receipt_path.is_file(), proc.stdout + proc.stderr)
                receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                return proc.returncode, receipt, marker.exists()

        # Non-schedule event (push): mutant harness does NOT run even if mutant_rc=1.
        push_rc, push_receipt, push_ran = run_python_step("push", mutant_rc=1)
        self.assertEqual(push_rc, 0)
        self.assertEqual(push_receipt["outcome"], "PASS")
        self.assertFalse(push_ran)

        # Schedule event with all mutants killed (mutant_rc=0): passes.
        sched_ok_rc, sched_ok_receipt, sched_ok_ran = run_python_step("schedule", mutant_rc=0)
        self.assertEqual(sched_ok_rc, 0)
        self.assertEqual(sched_ok_receipt["outcome"], "PASS")
        self.assertTrue(sched_ok_ran)

        # Negative control: Schedule event with surviving mutant (mutant_rc=1) fails the job.
        sched_fail_rc, sched_fail_receipt, sched_fail_ran = run_python_step("schedule", mutant_rc=1)
        self.assertNotEqual(sched_fail_rc, 0)
        self.assertEqual(sched_fail_receipt["outcome"], "FAIL")
        self.assertTrue(sched_fail_ran)

        # Negative control: workflow mutations are caught by the validator.
        unconditional = self.ci_text.replace(
            'if [ "${GITHUB_EVENT_NAME:-}" = "schedule" ]; then',
            'if [ "${GITHUB_EVENT_NAME:-}" != "" ]; then',
        )
        self.assertNotEqual(
            validate_scheduled_mutant_workflow_wiring(unconditional, self.volume_text),
            [],
        )


if __name__ == "__main__":
    unittest.main()
