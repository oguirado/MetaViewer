"""Offline unit and CLI tests for metaviewer_agents.loop_trials."""

from __future__ import annotations

import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

AGENTS_ROOT = Path(__file__).resolve().parents[1]
if str(AGENTS_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENTS_ROOT))

from metaviewer_agents import loop_trials  # noqa: E402
from metaviewer_agents.loop_trials import (  # noqa: E402
    LoopReportError,
    REPORT_SCHEMA,
    canonical_json,
    make_scripted_double,
    run_trials,
    validate_receipt,
    validate_report,
)


class LoopTrialsTests(unittest.TestCase):
    def run_cli_subprocess(self, *args: str) -> subprocess.CompletedProcess:
        env = {
            key: os.environ[key]
            for key in ("PATH", "LANG")
            if key in os.environ
        }
        env["PYTHONPATH"] = str(AGENTS_ROOT)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        return subprocess.run(
            [sys.executable, "-m", "metaviewer_agents.loop_trials", *args],
            cwd=str(AGENTS_ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

    def test_10_of_10_and_9_of_10_pass_and_alternate_kinds(self) -> None:
        for verified_target in (10, 9):
            with self.subTest(verified_target=verified_target):
                factory, planner_fn, clients = make_scripted_double(
                    trials=10,
                    verified_count=verified_target,
                    refusal_code="STALE_FRAME",
                )
                report = run_trials(
                    client_factory=factory,
                    planner=planner_fn,
                    trials=10,
                    min_verified=9,
                    timeout_ms=1000,
                )
                self.assertEqual(
                    set(report),
                    {"schema", "trials", "verified", "pass", "results"},
                )
                self.assertEqual(report["schema"], REPORT_SCHEMA)
                self.assertEqual(report["trials"], 10)
                self.assertEqual(report["verified"], verified_target)
                self.assertTrue(report["pass"])
                self.assertEqual(len(report["results"]), 10)
                self.assertEqual(len(clients), 10)

                for idx, row in enumerate(report["results"], start=1):
                    self.assertEqual(row["trial"], idx)
                    expected_kind = "holdings" if idx % 2 == 1 else "browser"
                    self.assertEqual(row["kind"], expected_kind)
                    if idx <= verified_target:
                        self.assertTrue(row["verified"])
                        self.assertEqual(row["status"], "verified")
                        self.assertEqual(row["code"], "OK")
                        self.assertEqual(
                            clients[idx - 1].ops,
                            ["observe", "propose", "wait_verify"],
                        )
                    else:
                        self.assertFalse(row["verified"])
                        self.assertEqual(row["status"], "refused")
                        self.assertEqual(row["code"], "STALE_FRAME")
                        self.assertEqual(
                            clients[idx - 1].ops,
                            ["observe", "propose"],
                        )

                self.assertEqual(validate_report(report), report)

        self.assertFalse(
            any(
                mod.split(".")[0] in ("visioncore", "vadapt", "wender")
                for mod in sys.modules
            )
        )

    def test_never_retries_refused_proposal_and_records_terminal_codes(self) -> None:
        outcomes = [
            ("verified", "OK"),
            ("refused", "STALE_FRAME"),
            ("refused", "POLICY"),
            ("refused", "OUT_OF_BOUNDS"),
            ("refused", "SURFACE_NOT_AGENT_CONTROLLED"),
            ("timeout", "TIMEOUT"),
            ("unverified", "VERIFICATION_FAILED"),
            ("verified", "OK"),
            ("verified", "OK"),
            ("verified", "OK"),
        ]
        clients = []

        def factory(trial: int, kind: str):
            mode, code = outcomes[trial - 1]
            if mode == "verified":
                client_f, _, created = make_scripted_double(
                    trials=trial, verified_count=trial
                )
                client = client_f(trial, kind)
            elif mode == "refused":
                client_f, _, _ = make_scripted_double(
                    trials=trial,
                    verified_count=0,
                    failure_mode="refused",
                    refusal_code=code,
                )
                client = client_f(trial, kind)
            elif mode == "timeout":
                client_f, _, _ = make_scripted_double(
                    trials=trial,
                    verified_count=0,
                    failure_mode="timeout",
                )
                client = client_f(trial, kind)
            else:
                client_f, _, _ = make_scripted_double(
                    trials=trial,
                    verified_count=0,
                    failure_mode="unverified",
                )
                client = client_f(trial, kind)
            clients.append(client)
            return client

        _, planner_fn, _ = make_scripted_double(trials=10, verified_count=10)
        report = run_trials(
            client_factory=factory,
            planner=planner_fn,
            trials=10,
            min_verified=9,
            timeout_ms=1000,
        )
        self.assertEqual(report["verified"], 4)
        self.assertFalse(report["pass"])

        for idx, (expected_status, expected_code) in enumerate(outcomes):
            row = report["results"][idx]
            client = clients[idx]
            self.assertEqual(row["status"], expected_status)
            self.assertEqual(row["code"], expected_code)
            self.assertEqual(row["verified"], expected_status == "verified")
            # Each trial submits at most one proposal; refusals never retry or call wait_verify
            self.assertEqual(len(client.proposals), 1)
            if expected_status == "refused":
                self.assertEqual(client.ops, ["observe", "propose"])
            else:
                self.assertEqual(client.ops, ["observe", "propose", "wait_verify"])

    def test_scripted_8_of_10_negative_control_gives_pass_false_and_nonzero_exit(self) -> None:
        factory, planner_fn, clients = make_scripted_double(
            trials=10,
            verified_count=8,
            refusal_code="STALE_FRAME",
        )
        report = run_trials(
            client_factory=factory,
            planner=planner_fn,
            trials=10,
            min_verified=9,
            timeout_ms=1000,
        )
        self.assertEqual(report["trials"], 10)
        self.assertEqual(report["verified"], 8)
        self.assertFalse(report["pass"])
        self.assertEqual(len(clients), 10)
        self.assertFalse(report["results"][8]["verified"])
        self.assertFalse(report["results"][9]["verified"])

        # In-process CLI exit check for 8/10 vs 9/10
        out_fail = io.StringIO()
        err_fail = io.StringIO()
        rc_fail = loop_trials.main(
            ["--scripted-verified", "8"],
            stdout=out_fail,
            stderr=err_fail,
        )
        self.assertNotEqual(rc_fail, 0)
        self.assertEqual(rc_fail, 1)
        parsed_fail = json.loads(out_fail.getvalue())
        self.assertEqual(parsed_fail["verified"], 8)
        self.assertFalse(parsed_fail["pass"])

        out_pass = io.StringIO()
        err_pass = io.StringIO()
        rc_pass = loop_trials.main(
            ["--scripted-verified", "9"],
            stdout=out_pass,
            stderr=err_pass,
        )
        self.assertEqual(rc_pass, 0)
        parsed_pass = json.loads(out_pass.getvalue())
        self.assertEqual(parsed_pass["verified"], 9)
        self.assertTrue(parsed_pass["pass"])

        # Subprocess CLI exit check for 8/10
        proc_fail = self.run_cli_subprocess("--scripted-verified", "8")
        self.assertNotEqual(proc_fail.returncode, 0)
        self.assertEqual(proc_fail.returncode, 1)
        sub_report = json.loads(proc_fail.stdout)
        self.assertEqual(sub_report["schema"], REPORT_SCHEMA)
        self.assertEqual(sub_report["verified"], 8)
        self.assertFalse(sub_report["pass"])

    def test_tampered_verified_count_and_mutated_receipts_fail_revalidation(self) -> None:
        factory, planner_fn, _ = make_scripted_double(
            trials=10,
            verified_count=8,
        )
        report_8 = run_trials(
            client_factory=factory,
            planner=planner_fn,
            trials=10,
            min_verified=9,
            timeout_ms=1000,
        )
        self.assertEqual(validate_receipt(report_8), report_8)

        # Tamper verified count from 8 to 9
        tampered_verified = copy.deepcopy(report_8)
        tampered_verified["verified"] = 9
        with self.assertRaises(LoopReportError) as ctx:
            validate_report(tampered_verified)
        self.assertEqual(ctx.exception.code, "tampered_verified")

        # Tamper verified count to 9 AND pass to True while rows still have 8 verified
        tampered_both = copy.deepcopy(report_8)
        tampered_both["verified"] = 9
        tampered_both["pass"] = True
        with self.assertRaises(LoopReportError) as ctx:
            validate_report(tampered_both)
        self.assertEqual(ctx.exception.code, "tampered_verified")

        # Tamper pass to True while verified count stays 8
        tampered_pass = copy.deepcopy(report_8)
        tampered_pass["pass"] = True
        with self.assertRaises(LoopReportError) as ctx:
            validate_report(tampered_pass)
        self.assertEqual(ctx.exception.code, "tampered_pass")

        # CLI --verify-receipt rejects tampered receipt file with nonzero exit
        with tempfile.TemporaryDirectory(prefix="mv-loop-receipt-") as tmp_dir:
            receipt_path = Path(tmp_dir) / "receipt.json"
            receipt_path.write_text(
                canonical_json(tampered_verified),
                encoding="utf-8",
            )
            out_buf = io.StringIO()
            err_buf = io.StringIO()
            rc = loop_trials.main(
                ["--verify-receipt", str(receipt_path)],
                stdout=out_buf,
                stderr=err_buf,
            )
            self.assertNotEqual(rc, 0)
            self.assertEqual(rc, 2)
            self.assertEqual(out_buf.getvalue(), "")
            self.assertTrue(err_buf.getvalue().startswith("tampered_verified: "))

        # Structural mutations on report
        bad_extra = copy.deepcopy(report_8)
        bad_extra["extra"] = 1
        with self.assertRaises(LoopReportError) as ctx:
            validate_report(bad_extra)
        self.assertEqual(ctx.exception.code, "bad_shape")

        bad_kind = copy.deepcopy(report_8)
        bad_kind["results"][0]["kind"] = "browser"
        with self.assertRaises(LoopReportError) as ctx:
            validate_report(bad_kind)
        self.assertEqual(ctx.exception.code, "bad_shape")

        bad_row_status = copy.deepcopy(report_8)
        bad_row_status["results"][0]["status"] = "refused"
        with self.assertRaises(LoopReportError) as ctx:
            validate_report(bad_row_status)
        self.assertEqual(ctx.exception.code, "bad_shape")


if __name__ == "__main__":
    unittest.main()
