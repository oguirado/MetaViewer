"""Regression gates for R1-119 and R9, executing volume.yml probes and entry points."""
from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tests.ci.test_ci_counts import _load_workflow_doc, _unquote_yaml_scalar

ROOT = Path(__file__).resolve().parents[1]
CI_YML = ROOT / ".github" / "workflows" / "ci.yml"
VOLUME_YML = ROOT / ".github" / "workflows" / "volume.yml"

spec = importlib.util.spec_from_file_location("volume_e2e", ROOT / "scripts" / "volume_e2e.py")
volume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(volume)


def load_ci_f4_namespace() -> dict:
    text = CI_YML.read_text(encoding="utf-8")
    source = textwrap.dedent(
        text[text.index("          RKEYS = ") : text.index("          product_tests = ")]
    )
    namespace = {
        "re": re,
        "json": json,
        "os": os,
        "hashlib": hashlib,
        "check": lambda *args, **kwargs: None,
    }
    exec(source, namespace)
    return namespace


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


F4_NS = load_ci_f4_namespace()
RECEIPT_ERRORS = F4_NS["receipt_errors"]


def _job_dict(workflow_text: str, job_name: str) -> dict:
    parsed = _load_workflow_doc(workflow_text)
    jobs = (parsed or {}).get("jobs") or {}
    job = jobs.get(job_name)
    if not isinstance(job, dict):
        raise ValueError(f"job {job_name!r} absent from workflow")
    steps = job.get("steps")
    if isinstance(steps, list):
        m_job = re.search(rf"^  {re.escape(job_name)}:\n(.*?)(?=^  [\w-]+:|\Z)", workflow_text, re.M | re.S)
        if m_job:
            in_steps = False
            step_idx = -1
            in_with = False
            for line in m_job.group(1).splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                indent = len(line) - len(line.lstrip(" "))
                if indent == 4:
                    in_steps = stripped == "steps:"
                    in_with = False
                elif in_steps and indent == 6 and stripped.startswith("- "):
                    step_idx += 1
                    in_with = False
                elif in_steps and 0 <= step_idx < len(steps):
                    if indent == 8:
                        in_with = stripped == "with:"
                        if in_with:
                            steps[step_idx]["with"] = {}
                    elif in_with and indent == 10 and ":" in stripped:
                        wk, wv = stripped.split(":", 1)
                        steps[step_idx]["with"][wk.strip()] = _unquote_yaml_scalar(wv)
                    elif indent <= 8:
                        in_with = False
    return job


def _matrix_legs(workflow_text: str, job_name: str) -> list[dict[str, str]]:
    job = _job_dict(workflow_text, job_name)
    include = ((job.get("strategy") or {}).get("matrix") or {}).get("include")
    if not isinstance(include, list):
        return []
    return [entry for entry in include if isinstance(entry, dict)]


def _step_script(workflow_text: str, job_name: str, step_name: str) -> str:
    job = _job_dict(workflow_text, job_name)
    for step in job.get("steps") or []:
        if isinstance(step, dict) and step.get("name") == step_name and isinstance(step.get("run"), str):
            return step["run"]
    raise ValueError(f"step {step_name!r} absent in job {job_name!r}")


def _build_hermetic_bin(bin_dir: Path, *, include_xvfb: bool) -> None:
    bin_dir.mkdir(parents=True, exist_ok=True)
    # Lightweight timeout wrapper so 320 loop iterations do not spawn 320 external timeout binaries.
    timeout_stub = bin_dir / "timeout"
    timeout_stub.write_text("#!/bin/sh\nshift\nexec \"$@\"\n", encoding="utf-8")
    timeout_stub.chmod(0o755)

    if include_xvfb:
        xvfb_stub = bin_dir / "xvfb-run"
        xvfb_stub.write_text(
            "#!/bin/sh\n"
            "set -eu\n"
            "if [ \"${1:-}\" != \"-a\" ] || [ \"${2:-}\" != \"-s\" ]; then\n"
            "  echo \"unexpected xvfb-run flags: $*\" >&2\n"
            "  exit 64\n"
            "fi\n"
            "shift 3\n"
            "if [ \"${1:-}\" = \"python3\" ] && [ \"${2:-}\" = \"tests/e2e/run.py\" ]; then\n"
            "  if [ ! -f \"tests/e2e/run.py\" ]; then\n"
            "    echo \"missing tests/e2e/run.py\" >&2\n"
            "    exit 2\n"
            "  fi\n"
            "  smoke_done=0\n"
            "  qual_done=0\n"
            "  [ -f \"${TEST_EVDIR}/volume-e2e.receipt.json\" ] && smoke_done=1\n"
            "  [ -f \"${TEST_EVDIR}/volume-e2e-qualification.receipt.json\" ] && qual_done=1\n"
            "  idx=1\n"
            "  if [ -f \"${TEST_CALL_LOG}\" ]; then\n"
            "    lines=$(wc -l < \"${TEST_CALL_LOG}\")\n"
            "    idx=$((lines + 1))\n"
            "  fi\n"
            "  printf '%d %d %d\\n' \"$idx\" \"$smoke_done\" \"$qual_done\" >> \"${TEST_CALL_LOG}\"\n"
            "  if [ -n \"${FAKE_E2E_FAIL_AT:-}\" ] && [ \"$idx\" -eq \"${FAKE_E2E_FAIL_AT}\" ]; then\n"
            "    exit 1\n"
            "  fi\n"
            "  exit 0\n"
            "fi\n"
            "exec \"$@\"\n",
            encoding="utf-8",
        )
        xvfb_stub.chmod(0o755)
    else:
        for tool in (
            "bash",
            "sh",
            "python3",
            "seq",
            "mkdir",
            "cat",
            "tail",
            "grep",
            "head",
            "cp",
            "pwd",
            "rm",
            "wc",
            "tr",
            "sed",
            "awk",
            "date",
            "uname",
            "dirname",
            "basename",
        ):
            resolved = shutil.which(tool)
            if resolved and not (bin_dir / tool).exists():
                (bin_dir / tool).symlink_to(resolved)


def probe_volume_job_step(
    workflow_text: str,
    job_name: str,
    step_name: str,
    platform: str,
    *,
    harness_present: bool = True,
    xvfb_present: bool = True,
    fail_at_call: int | None = None,
    property_entry_present: bool = False,
    mutants_entry_present: bool = False,
) -> dict:
    script = _step_script(workflow_text, job_name, step_name)
    with tempfile.TemporaryDirectory(prefix="mv-vol-probe-") as td:
        tmp = Path(td)
        ws = tmp / "ws"
        (ws / ".github" / "workflows").mkdir(parents=True)
        wf_file = ws / ".github" / "workflows" / "volume.yml"
        wf_file.write_text(workflow_text, encoding="utf-8")

        if harness_present:
            (ws / "tests" / "e2e").mkdir(parents=True, exist_ok=True)
            (ws / "tests" / "e2e" / "run.py").write_text("# stub e2e runner\n", encoding="utf-8")
            (ws / "tests" / "e2e" / "e2e14_perf.test.js").write_text("// stub soak\n", encoding="utf-8")
        if property_entry_present:
            (ws / "tools").mkdir(parents=True, exist_ok=True)
            (ws / "tools" / "volume_property.py").write_text("# stub property\n", encoding="utf-8")
        if mutants_entry_present:
            (ws / "tests").mkdir(parents=True, exist_ok=True)
            (ws / "tests" / "test_contract_mutants.py").write_text(
                "import unittest\nclass T(unittest.TestCase):\n    def test_ok(self): pass\n",
                encoding="utf-8",
            )

        bin_dir = tmp / "bin"
        _build_hermetic_bin(bin_dir, include_xvfb=xvfb_present)

        evdir = tmp / "metaviewer-ci" / job_name / platform
        call_log = tmp / "e2e-calls.log"
        soak_fixture = tmp / "soak-report.json"
        soak_fixture.write_text(json.dumps(make_soak_report()), encoding="utf-8")
        summary = tmp / "summary.md"
        summary.write_text("", encoding="utf-8")

        env = os.environ.copy()
        env.update(
            {
                "PATH": str(bin_dir) if not xvfb_present else f"{bin_dir}{os.pathsep}{env.get('PATH', '')}",
                "RUNNER_TEMP": str(tmp),
                "GITHUB_WORKSPACE": str(ws),
                "GITHUB_RUN_ID": "707",
                "GITHUB_SHA": "a" * 40,
                "GITHUB_STEP_SUMMARY": str(summary),
                "JOB_ID": job_name,
                "PLATFORM": platform,
                "MV_SOAK_SECS": "3",
                "MV_SOAK_REPORT_FIXTURE": str(soak_fixture),
                "TEST_EVDIR": str(evdir),
                "TEST_CALL_LOG": str(call_log),
            }
        )
        if fail_at_call is not None:
            env["FAKE_E2E_FAIL_AT"] = str(fail_at_call)
        else:
            env.pop("FAKE_E2E_FAIL_AT", None)

        proc = subprocess.run(
            ["bash", "-c", script],
            cwd=ws,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

        wf_sha = hashlib.sha256(wf_file.read_bytes()).hexdigest()
        receipts: dict[str, dict] = {}
        if evdir.is_dir():
            for receipt_file in sorted(evdir.glob("*.receipt.json")):
                data = json.loads(receipt_file.read_text(encoding="utf-8"))
                errs = RECEIPT_ERRORS(
                    data,
                    {
                        "gate_revision": "a" * 40,
                        "configuration_sha256": wf_sha,
                    },
                )
                if errs:
                    raise AssertionError(f"receipt schema errors for {receipt_file.name}: {errs}")
                receipts[data["gate_id"]] = data

        calls: list[tuple[int, int, int]] = []
        if call_log.is_file():
            for line in call_log.read_text(encoding="utf-8").splitlines():
                parts = line.split()
                if len(parts) == 3:
                    calls.append((int(parts[0]), int(parts[1]), int(parts[2])))

        return {
            "rc": proc.returncode,
            "platform": platform,
            "receipts": receipts,
            "calls": calls,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "summary": summary.read_text(encoding="utf-8"),
        }


def probe_volume_e2e_workflow(
    workflow_text: str,
    *,
    harness_present: bool = True,
    xvfb_present: bool = True,
    fail_at_call: int | None = None,
) -> dict:
    try:
        volume.check_workflow(workflow_text)
        job = _job_dict(workflow_text, "volume-e2e")
        steps = [s for s in (job.get("steps") or []) if isinstance(s, dict)]
    except (RuntimeError, ValueError) as err:
        return {"verdict": "FAIL", "reason": str(err), "legs": {}}

    has_go = any(
        isinstance(s.get("uses"), str)
        and s["uses"].startswith("actions/setup-go@")
        and (s.get("with") or {}).get("go-version-file") == "daemon-adapter/go.mod"
        for s in steps
    )
    if not has_go:
        return {"verdict": "FAIL", "reason": "missing setup-go step for daemon-adapter/go.mod", "legs": {}}

    has_rust_fetch = any(
        isinstance(s.get("run"), str) and "cargo fetch --locked" in s["run"]
        for s in steps
    )
    if not has_rust_fetch:
        return {"verdict": "FAIL", "reason": "missing cargo fetch --locked step", "legs": {}}

    legs = _matrix_legs(workflow_text, "volume-e2e")
    expected_pairs = {("ubuntu-24.04", "x64"), ("ubuntu-24.04-arm", "arm64")}
    observed_pairs = {(leg.get("runner"), leg.get("platform")) for leg in legs}
    if observed_pairs != expected_pairs or len(legs) != 2:
        return {
            "verdict": "FAIL",
            "reason": f"architecture matrix mismatch: {observed_pairs!r}",
            "legs": {},
        }

    leg_results: dict[str, dict] = {}
    for leg in legs:
        platform = str(leg["platform"])
        try:
            res = probe_volume_job_step(
                workflow_text,
                "volume-e2e",
                "Run E2E repeat x20 then qualification x300",
                platform,
                harness_present=harness_present,
                xvfb_present=xvfb_present,
                fail_at_call=fail_at_call,
            )
        except ValueError as err:
            return {"verdict": "FAIL", "reason": str(err), "legs": leg_results}
        leg_results[platform] = res

    for platform, res in leg_results.items():
        receipts = res["receipts"]
        smoke = receipts.get("volume-e2e")
        if res["rc"] == 2 and smoke and smoke.get("outcome") == "BLOCKED":
            return {"verdict": "BLOCKED", "reason": smoke["reason"], "legs": leg_results}
        if smoke is None:
            return {
                "verdict": "FAIL",
                "reason": f"missing_smoke_receipt:volume-e2e ({platform})",
                "legs": leg_results,
            }
        if smoke.get("outcome") != "PASS" or smoke.get("rc") != 0:
            return {
                "verdict": "FAIL",
                "reason": smoke.get("reason", f"smoke failed on {platform}"),
                "legs": leg_results,
            }
        qual = receipts.get("volume-e2e-qualification")
        if qual is None:
            return {
                "verdict": "FAIL",
                "reason": f"missing_qualification_receipt:volume-e2e-qualification ({platform})",
                "legs": leg_results,
            }
        if qual.get("outcome") != "PASS" or qual.get("rc") != 0:
            return {
                "verdict": "FAIL",
                "reason": qual.get("reason", f"qualification failed on {platform}"),
                "legs": leg_results,
            }
        soak = receipts.get("volume-wall-soak")
        if soak is None or soak.get("outcome") != "PASS" or soak.get("rc") != 0:
            return {
                "verdict": "FAIL",
                "reason": (soak or {}).get("reason", f"missing_or_failed_soak ({platform})"),
                "legs": leg_results,
            }
        if res["rc"] != 0:
            return {
                "verdict": "FAIL",
                "reason": f"nonzero_step_rc:{res['rc']} ({platform})",
                "legs": leg_results,
            }

        calls = res["calls"]
        smoke_calls = [idx for idx, s_done, q_done in calls if s_done == 0 and q_done == 0]
        qual_calls = [idx for idx, s_done, q_done in calls if s_done == 1 and q_done == 0]
        if len(smoke_calls) != 20 or len(qual_calls) != 300 or len(calls) != 320:
            return {
                "verdict": "FAIL",
                "reason": (
                    f"rung_iteration_mismatch ({platform}): "
                    f"smoke={len(smoke_calls)}, qual={len(qual_calls)}, total={len(calls)}"
                ),
                "legs": leg_results,
            }
        if max(smoke_calls) >= min(qual_calls):
            return {
                "verdict": "FAIL",
                "reason": f"rung_ordering_violation ({platform})",
                "legs": leg_results,
            }

    return {
        "verdict": "PASS",
        "reason": "20 e2e repetitions green; 300 e2e repetitions green; 3s synthetic wall soak green",
        "legs": leg_results,
    }


def _delete_e2e_rung(workflow_text: str, rung: str) -> str:
    if rung == "smoke":
        pattern = re.compile(
            r"\n          LOG=\"\$EVDIR/volume-e2e\.log\"\n.*?"
            r"finish_gate volume-e2e [^\n]+\n"
            r"          \[ \"\$rc\" -eq 0 \] \|\| exit \"\$rc\"",
            re.S,
        )
    elif rung == "qualification":
        pattern = re.compile(
            r"\n          LOG=\"\$EVDIR/volume-e2e-qualification\.log\"\n.*?"
            r"finish_gate volume-e2e-qualification [^\n]+\n"
            r"          \[ \"\$rc\" -eq 0 \] \|\| exit \"\$rc\"",
            re.S,
        )
    else:
        raise ValueError(f"unknown rung {rung!r}")
    mutated, count = pattern.subn("", workflow_text, count=1)
    if count != 1:
        raise AssertionError(f"failed to delete rung {rung!r} from fixture workflow")
    return mutated


class VolumeE2EWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow_text = VOLUME_YML.read_text(encoding="utf-8")

    def test_real_workflow_bootstrap_and_file_prerequisite(self) -> None:
        volume.check_workflow(self.workflow_text)
        self.assertEqual(volume.main(["--check-workflow"]), 0)

        # Execute scripts/volume_e2e.py entry points for BLOCKED and PASS verdicts.
        with tempfile.TemporaryDirectory(prefix="mv-vol-entry-") as td:
            root = Path(td)
            err_buf = io.StringIO()
            with (
                patch.object(volume, "ROOT", root),
                patch.dict(os.environ, {"MV_KIT_CHECKOUT": str(root)}, clear=False),
                contextlib.redirect_stderr(err_buf),
            ):
                self.assertEqual(volume.main(["--prepare-only"]), 2)
            self.assertIn("BLOCKED: tests/e2e/run.py absent", err_buf.getvalue())

            runner = root / "tests" / "e2e" / "run.py"
            runner.parent.mkdir(parents=True, exist_ok=True)
            runner.write_text("", encoding="utf-8")
            package = root / "ui" / "node_modules" / "electron"
            (package / "dist").mkdir(parents=True, exist_ok=True)
            (package / "package.json").write_text('{"version":"44.9.2"}', encoding="utf-8")
            binary = package / "dist" / "electron"
            binary.write_text("", encoding="utf-8")
            binary.chmod(0o755)

            def fake_prepare_run(cmd, **kwargs):
                return SimpleNamespace(stdout="v24.14.0\n" if cmd == ["node", "--version"] else "v44.9.2\n")

            volume.prepare(root, {"MV_KIT_CHECKOUT": str(root)}, run=fake_prepare_run)

            iter_calls: list[list[str]] = []

            def fake_iter_run(cmd, **kwargs):
                iter_calls.append(list(cmd))
                return SimpleNamespace(returncode=0)

            out_buf = io.StringIO()
            with (
                patch.object(volume, "ROOT", root),
                patch.object(volume, "prepare", return_value=None),
                patch.object(volume.subprocess, "run", side_effect=fake_iter_run),
                contextlib.redirect_stdout(out_buf),
            ):
                self.assertEqual(volume.main(["--iterations", "20"]), 0)
            self.assertEqual(len(iter_calls), 20)
            self.assertIn("volume-e2e 20/20 PASS", out_buf.getvalue())

        # Execute the real workflow probes in volume.yml across both arch legs for BLOCKED preconditions.
        for platform in ("x64", "arm64"):
            with self.subTest(job="volume-property-absent", platform=platform):
                prop_abs = probe_volume_job_step(
                    self.workflow_text,
                    "volume-property",
                    "Probe property entrypoint",
                    platform,
                    property_entry_present=False,
                )
                self.assertEqual(prop_abs["rc"], 2)
                rec = prop_abs["receipts"]["volume-property"]
                self.assertEqual(rec["outcome"], "BLOCKED")
                self.assertEqual(
                    rec["reason"],
                    "no registered property entrypoint for 100000 cases, owned by a future wave",
                )
                self.assertEqual(rec["scope"]["platform"], platform)

            with self.subTest(job="volume-property-interface-absent", platform=platform):
                prop_iface = probe_volume_job_step(
                    self.workflow_text,
                    "volume-property",
                    "Probe property entrypoint",
                    platform,
                    property_entry_present=True,
                )
                self.assertEqual(prop_iface["rc"], 2)
                rec = prop_iface["receipts"]["volume-property"]
                self.assertEqual(rec["outcome"], "BLOCKED")
                self.assertEqual(
                    rec["reason"],
                    "entrypoint present but the registered 100000-case interface is ABSENT",
                )
                self.assertEqual(rec["scope"]["platform"], platform)

            with self.subTest(job="volume-mutants-absent", platform=platform):
                mut_abs = probe_volume_job_step(
                    self.workflow_text,
                    "volume-mutants",
                    "Run contract mutants x100",
                    platform,
                    mutants_entry_present=False,
                )
                self.assertEqual(mut_abs["rc"], 2)
                rec = mut_abs["receipts"]["volume-mutants"]
                self.assertEqual(rec["outcome"], "BLOCKED")
                self.assertEqual(rec["reason"], "tests/test_contract_mutants.py ABSENT, owned by W1-T-MUT")
                self.assertEqual(rec["scope"]["platform"], platform)

        # Missing E2E harness or xvfb-run in volume-e2e yields BLOCKED with exact reasons on both legs.
        blocked_no_harness = probe_volume_e2e_workflow(self.workflow_text, harness_present=False)
        self.assertEqual(blocked_no_harness["verdict"], "BLOCKED")
        self.assertEqual(blocked_no_harness["reason"], "E2E harness tests/e2e/run.py ABSENT")
        self.assertEqual(set(blocked_no_harness["legs"]), {"x64", "arm64"})

        blocked_no_xvfb = probe_volume_e2e_workflow(self.workflow_text, xvfb_present=False)
        self.assertEqual(blocked_no_xvfb["verdict"], "BLOCKED")
        self.assertEqual(blocked_no_xvfb["reason"], "xvfb-run not installed on runner")
        self.assertEqual(set(blocked_no_xvfb["legs"]), {"x64", "arm64"})

    def test_qualification_rung_follows_smoke_and_keeps_architectures(self) -> None:
        result = probe_volume_e2e_workflow(self.workflow_text)
        self.assertEqual(result["verdict"], "PASS", result["reason"])
        self.assertIn("20 e2e repetitions green", result["reason"])
        self.assertIn("300 e2e repetitions green", result["reason"])
        self.assertEqual(set(result["legs"]), {"x64", "arm64"})

        for platform, leg in result["legs"].items():
            with self.subTest(platform=platform):
                self.assertEqual(leg["rc"], 0)
                smoke = leg["receipts"]["volume-e2e"]
                qual = leg["receipts"]["volume-e2e-qualification"]
                soak = leg["receipts"]["volume-wall-soak"]

                self.assertEqual(smoke["outcome"], "PASS")
                self.assertEqual(smoke["reason"], "20 e2e repetitions green")
                self.assertEqual(smoke["counts"]["source"], "volume:20-iters")
                self.assertEqual(smoke["scope"]["platform"], platform)

                self.assertEqual(qual["outcome"], "PASS")
                self.assertEqual(qual["reason"], "300 e2e repetitions green")
                self.assertEqual(qual["counts"]["source"], "volume:300-iters")
                self.assertEqual(qual["scope"]["platform"], platform)

                self.assertEqual(soak["outcome"], "PASS")
                self.assertEqual(soak["reason"], "3s synthetic wall soak green")
                self.assertEqual(soak["counts"]["source"], "volume:soak-3s")
                self.assertIn("tests/e2e/perf-main.cjs", soak["argv"])
                self.assertNotIn("tests/e2e/e2e14_perf.test.js", soak["argv"])
                self.assertEqual(soak["product_identity"]["evidence_mode"], "synthetic")
                self.assertEqual(soak["scope"]["platform"], platform)

                smoke_calls = [idx for idx, s_done, q_done in leg["calls"] if s_done == 0 and q_done == 0]
                qual_calls = [idx for idx, s_done, q_done in leg["calls"] if s_done == 1 and q_done == 0]
                self.assertEqual(len(smoke_calls), 20)
                self.assertEqual(len(qual_calls), 300)
                self.assertLess(max(smoke_calls), min(qual_calls))

        # Negative control 1: deleting the E2E smoke rung from a fixture workflow fails the probe.
        no_smoke_wf = _delete_e2e_rung(self.workflow_text, "smoke")
        no_smoke_res = probe_volume_e2e_workflow(no_smoke_wf)
        self.assertEqual(no_smoke_res["verdict"], "FAIL")
        self.assertIn("missing_smoke_receipt:volume-e2e", no_smoke_res["reason"])

        # Negative control 2: deleting the E2E qualification rung from a fixture workflow fails the probe.
        no_qual_wf = _delete_e2e_rung(self.workflow_text, "qualification")
        no_qual_res = probe_volume_e2e_workflow(no_qual_wf)
        self.assertEqual(no_qual_res["verdict"], "FAIL")
        self.assertIn("missing_qualification_receipt:volume-e2e-qualification", no_qual_res["reason"])

        # Negative control 3: dropping an architecture leg from the matrix fails the probe.
        no_arm_wf = self.workflow_text.replace(
            "          - runner: ubuntu-24.04-arm\n            platform: arm64\n",
            "",
        )
        no_arm_res = probe_volume_e2e_workflow(no_arm_wf)
        self.assertEqual(no_arm_res["verdict"], "FAIL")
        self.assertIn("architecture matrix mismatch", no_arm_res["reason"])

        # Negative control 4: a failure in the 20-iteration smoke rung halts before the 300-iteration qualification rung.
        smoke_fail_res = probe_volume_e2e_workflow(self.workflow_text, fail_at_call=5)
        self.assertEqual(smoke_fail_res["verdict"], "FAIL")
        self.assertEqual(smoke_fail_res["reason"], "1 of 20 e2e repetitions failed")
        for platform, leg in smoke_fail_res["legs"].items():
            self.assertEqual(leg["receipts"]["volume-e2e"]["outcome"], "FAIL")
            self.assertNotIn("volume-e2e-qualification", leg["receipts"])
            self.assertEqual(len(leg["calls"]), 20)

    def test_t8_r3_10_cross_route_mutant_classifier_rejects_prereq_and_gate_failures(self) -> None:
        """T8-R3-10: tests/e2e/run.py classifier distinguishes live E2E_ROUTING failure from passing subtest titles and E2E_PREREQ/E2E_GATE."""
        import importlib.util
        spec = importlib.util.spec_from_file_location("e2e_run", ROOT / "tests" / "e2e" / "run.py")
        assert spec and spec.loader
        e2e_run = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(e2e_run)
        classify = e2e_run.is_cross_route_mutant_killed

        # Positive control: live wall journey fails with E2E_ROUTING.
        genuine_stdout = (
            "✔ e2e1 wall harness contract (10ms)\n"
            "▶ e2e1 live wall journey\n"
            "  ✖ wall renders four tiles without cross-routing (AC-02) (5ms)\n"
            "✖ e2e1 live wall journey (5ms)\n"
            "✔ malformed publisher ledger refuses with E2E_ROUTING (0.1ms)\n"
            "✖ failing tests:\n"
            "✖ wall renders four tiles without cross-routing (AC-02) (5ms)\n"
            "  Error [E2EError]: E2E_ROUTING: cross-routed frame detected\n"
            "    code: 'E2E_ROUTING'\n"
        )
        self.assertTrue(classify(1, genuine_stdout, ""))

        # Negative 1: returncode 0 (mutant survived).
        self.assertFalse(classify(0, genuine_stdout, ""))

        # Negative 2: E2E_GATE failure alongside passing "malformed publisher ledger refuses with E2E_ROUTING" subtest.
        gate_fail_stdout = (
            "▶ e2e1 live wall journey\n"
            "  ✖ wall renders four tiles without cross-routing (AC-02) (0.2ms)\n"
            "✖ e2e1 live wall journey (0.3ms)\n"
            "✔ malformed publisher ledger refuses with E2E_ROUTING (0.1ms)\n"
            "✖ failing tests:\n"
            "✖ wall renders four tiles without cross-routing (AC-02) (0.2ms)\n"
            "  Error [E2EError]: E2E_GATE: live journey needs MV_E2E_LIVE=1 under the G-E2E gate\n"
            "    code: 'E2E_GATE'\n"
        )
        self.assertFalse(classify(1, gate_fail_stdout, ""))

        # Negative 3: E2E_PREREQ failure alongside passing "malformed publisher ledger refuses with E2E_ROUTING" subtest.
        prereq_fail_stdout = gate_fail_stdout.replace("E2E_GATE", "E2E_PREREQ")
        self.assertFalse(classify(1, prereq_fail_stdout, ""))

        # Negative 4: Unrelated crash where only the passing subtest mentions E2E_ROUTING.
        unrelated_crash = (
            "✔ malformed publisher ledger refuses with E2E_ROUTING (0.1ms)\n"
            "✖ wall renders four tiles without cross-routing (AC-02) (1ms)\n"
            "✖ failing tests:\n"
            "✖ wall renders four tiles without cross-routing (AC-02) (1ms)\n"
            "  TypeError: Cannot read properties of undefined\n"
        )
        self.assertFalse(classify(1, unrelated_crash, ""))

    def test_t8_r3_11_and_t7r3_010_soak_validator_rejects_nan_inf_bool_and_null_pixels(self) -> None:
        """T8-R3-11 / T7R3-010: volume-wall-soak validator rejects NaN, Inf, booleans, and null pixels."""
        step_script = _step_script(
            self.workflow_text,
            "volume-e2e",
            "Run E2E repeat x20 then qualification x300",
        )
        prefix_end = step_script.index('HARNESS="tests/e2e/run.py"')
        soak_start = step_script.index('LOG="$EVDIR/volume-wall-soak.log"')
        soak_only_script = step_script[:prefix_end] + "\n" + step_script[soak_start:]

        def run_soak_raw(report_json_text: str) -> tuple[int, dict]:
            with tempfile.TemporaryDirectory(prefix="mv-soak-nan-") as td:
                tmp = Path(td)
                ws = tmp / "ws"
                (ws / ".github" / "workflows").mkdir(parents=True, exist_ok=True)
                (ws / "tests" / "e2e").mkdir(parents=True, exist_ok=True)
                (ws / ".github" / "workflows" / "volume.yml").write_text(self.workflow_text, encoding="utf-8")
                (ws / "tests" / "e2e" / "e2e14_perf.test.js").write_text("// stub\n", encoding="utf-8")
                fixture_p = tmp / "soak.json"
                fixture_p.write_text(report_json_text, encoding="utf-8")
                summary_p = tmp / "summary.md"
                summary_p.write_text("", encoding="utf-8")
                env = dict(
                    os.environ,
                    RUNNER_TEMP=str(tmp),
                    GITHUB_WORKSPACE=str(ws),
                    GITHUB_RUN_ID="777",
                    GITHUB_SHA="a" * 40,
                    GITHUB_STEP_SUMMARY=str(summary_p),
                    JOB_ID="volume-e2e",
                    PLATFORM="x64",
                    MV_SOAK_SECS="3",
                    MV_SOAK_REPORT_FIXTURE=str(fixture_p),
                )
                proc = subprocess.run(
                    ["bash", "-c", soak_only_script],
                    cwd=str(ws),
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=20,
                )
                rec_p = tmp / "metaviewer-ci" / "volume-e2e" / "x64" / "volume-wall-soak.receipt.json"
                self.assertTrue(rec_p.is_file(), proc.stdout + proc.stderr)
                return proc.returncode, json.loads(rec_p.read_text(encoding="utf-8"))

        base_report = make_soak_report()
        ok_rc, ok_rec = run_soak_raw(json.dumps(base_report))
        self.assertEqual(ok_rc, 0)
        self.assertEqual(ok_rec["outcome"], "PASS")

        # 1. NaN timestamp in tile times must FAIL.
        nan_time_report = json.loads(json.dumps(base_report))
        nan_time_report["visible"][0]["times"][2] = float("nan")
        rc1, rec1 = run_soak_raw(json.dumps(nan_time_report, allow_nan=True))
        self.assertNotEqual(rc1, 0)
        self.assertEqual(rec1["outcome"], "FAIL")

        # 2. NaN started window must FAIL.
        nan_start_report = json.loads(json.dumps(base_report))
        nan_start_report["started"] = float("nan")
        rc2, rec2 = run_soak_raw(json.dumps(nan_start_report, allow_nan=True))
        self.assertNotEqual(rc2, 0)
        self.assertEqual(rec2["outcome"], "FAIL")

        # 3. Boolean timestamp in tile times must FAIL.
        bool_time_report = json.loads(json.dumps(base_report))
        bool_time_report["visible"][0]["times"][0] = True
        rc3, rec3 = run_soak_raw(json.dumps(bool_time_report))
        self.assertNotEqual(rc3, 0)
        self.assertEqual(rec3["outcome"], "FAIL")

        # 4. Null pixel and expectedPixel (None == None) must FAIL.
        null_pixel_report = json.loads(json.dumps(base_report))
        null_pixel_report["visible"][0]["pixel"] = None
        null_pixel_report["visible"][0]["expectedPixel"] = None
        rc4, rec4 = run_soak_raw(json.dumps(null_pixel_report))
        self.assertNotEqual(rc4, 0)
        self.assertEqual(rec4["outcome"], "FAIL")

    def test_t8_r3_12_volume_e2e_preflight_budget_validation(self) -> None:
        """T8-R3-12: volume-e2e aligns per-attempt timeout >= 600s and blocks infeasible repetition budgets."""
        self.assertIn('ATTEMPT_TIMEOUT_SECS="${MV_VOLUME_ATTEMPT_TIMEOUT_SECS:-1200}"', self.workflow_text)
        infeasible_wf = self.workflow_text.replace(
            'PER_ATTEMPT_BUDGET_SECS="${MV_VOLUME_PER_ATTEMPT_BUDGET_SECS:-30}"',
            'PER_ATTEMPT_BUDGET_SECS="120"',
            1,
        )
        res = probe_volume_job_step(
            infeasible_wf,
            "volume-e2e",
            "Run E2E repeat x20 then qualification x300",
            "x64",
        )
        self.assertEqual(res["rc"], 2)
        self.assertEqual(res["receipts"]["volume-e2e"]["outcome"], "BLOCKED")
        self.assertIn("budget exceeds job timeout", res["receipts"]["volume-e2e"]["reason"])
        self.assertEqual(res["calls"], [])


if __name__ == "__main__":
    unittest.main()
