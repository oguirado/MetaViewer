"""T7 round-2: receipt schema/identity/outcome validation, ARG-ci-6 laws-range failure receipt, and R1-092 ci-required receipt evaluation."""
import copy
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile
import textwrap
import unittest
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
CI_YML = ROOT / ".github" / "workflows" / "ci.yml"


def load_f4_validator():
    text = CI_YML.read_text(encoding="utf-8")
    start = text.index("          # F4: receipt schema validation and required-set aggregation.")
    end = text.index("          product_tests = subprocess.run")
    code = textwrap.dedent(text[start:end])
    ns = {"re": re, "json": json, "os": os, "check": lambda *a, **k: None}
    old_cwd = os.getcwd()
    try:
        os.chdir(ROOT)
        exec(code, ns)
    finally:
        os.chdir(old_cwd)
    return ns["receipt_errors"], ns["aggregate"]


def valid_receipt():
    wf_sha = hashlib.sha256(CI_YML.read_bytes()).hexdigest()
    return {
        "schema": "gate_receipt/v1",
        "gate_id": "unit",
        "leg": "unit",
        "profile": "W0",
        "owner": "W0-CI-MATRIX",
        "issuer": "CI/python/123 [VM]",
        "scope": {
            "unit": "W0-CI-MATRIX",
            "platform": "x64",
            "feature": "unit",
            "artifact": "unit.receipt.json",
        },
        "argv": ["python3", "-m", "unittest"],
        "cwd": "/workspace",
        "rc": 0,
        "outcome": "PASS",
        "reason": "unit green",
        "identities": {
            "gate_revision": "a" * 40,
            "instrument_sha256": "b" * 64,
            "sanitized_log_sha256": "c" * 64,
            "configuration_sha256": wf_sha,
            "log_sha256": "e" * 64,
            "fixture_sha256": ["b" * 64],
        },
        "product_identity": None,
        "assertions": [
            {
                "id": "exit-status",
                "expected": "rc 0",
                "observed": "rc 0",
                "accepted": True,
            }
        ],
        "counts": {
            "passed": 12,
            "failed": 0,
            "skipped": 0,
            "source": "parsed:unittest",
        },
    }


class TestT7R2CReceiptIdentity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        receipt_errors, aggregate = load_f4_validator()
        cls.receipt_errors = staticmethod(receipt_errors)
        cls.aggregate = staticmethod(aggregate)

    def test_o4_valid_receipt_accepted(self):
        r = valid_receipt()
        self.assertEqual(self.receipt_errors(r, {}), [])
        ok, reason = self.aggregate({"unit": {"PASS"}}, [r], {"unit": "success"})
        self.assertTrue(ok, reason)

    def test_o4_volatile_fields_rejected(self):
        for bad_key in ("timestamp", "started_at", "finished_at", "duration_ms", "pid", "ppid", "hostname", "runner_name", "temp_dir"):
            with self.subTest(bad_key=bad_key):
                r = valid_receipt()
                r[bad_key] = "volatile"
                self.assertIn("keys", self.receipt_errors(r, {}))

    def test_o4_invalid_identities_rejected(self):
        for k in ("instrument_sha256", "sanitized_log_sha256", "configuration_sha256", "log_sha256"):
            r2 = valid_receipt()
            r2["identities"][k] = "xyz"
            self.assertIn("identities-" + k, self.receipt_errors(r2, {}))

    def test_o4_pass_with_nonzero_rc_rejected(self):
        r = valid_receipt()
        r["rc"] = 1
        self.assertIn("rc-pass", self.receipt_errors(r, {}))

    def test_o4_parsed_count_zero_passed_rejected(self):
        r = valid_receipt()
        r["counts"]["passed"] = 0
        self.assertIn("counts-failed-pass", self.receipt_errors(r, {}))

    def test_o4_aggregate_rejects_failed_or_mismatched_outcomes(self):
        r_pass = valid_receipt()
        r_pass["gate_id"] = "rust"
        r_fail = copy.deepcopy(r_pass)
        r_fail.update(outcome="FAIL", rc=1)
        r_fail["assertions"][0]["accepted"] = False

        self.assertTrue(self.aggregate({"rust": {"PASS"}}, [r_pass], {"rust": "success"})[0])
        self.assertFalse(self.aggregate({"rust": {"PASS"}}, [r_fail], {"rust": "success"})[0])
        self.assertFalse(self.aggregate({"rust": {"PASS"}}, [r_pass], {"rust": "failure"})[0])

    def test_o4_r1_092_ci_required_evaluates_receipts_and_rejects_tampered(self):
        """Regression test for R1-092: ci-required Aggregate required results evaluates receipts and fails on tampered receipts."""
        ci_doc = yaml.safe_load(CI_YML.read_text(encoding="utf-8"))
        ci_req = ci_doc["jobs"]["ci-required"]
        agg_step = [s for s in ci_req["steps"] if s.get("name") == "Aggregate required results"][0]
        raw_script = agg_step["run"]
        rendered = re.sub(r"\$\{\{\s*job\.status\s*\}\}", "success", raw_script)
        rendered = re.sub(r"\$\{\{\s*needs\.[\w-]+\.result\s*\}\}", "success", rendered)

        with tempfile.TemporaryDirectory(prefix="t7r2c-r1092-") as tmp:
            summary = pathlib.Path(tmp) / "summary.md"
            receipts_dir = pathlib.Path(tmp) / "receipts"
            receipts_dir.mkdir()
            good = valid_receipt()
            (receipts_dir / "unit.receipt.json").write_text(json.dumps(good), encoding="utf-8")

            # Negative control: valid PASS receipts in PACKAGE_RECEIPT and MV_REQUIRED_RECEIPTS_DIR pass.
            env_good = dict(
                os.environ,
                GITHUB_STEP_SUMMARY=str(summary),
                PACKAGE_RECEIPT=json.dumps(good),
                MV_REQUIRED_RECEIPTS_DIR=str(receipts_dir),
            )
            res_ok = subprocess.run(
                ["bash", "-e", "-u", "-o", "pipefail", "-c", rendered],
                cwd=ROOT,
                env=env_good,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(res_ok.returncode, 0, res_ok.stdout + res_ok.stderr)
            self.assertIn("outcome PASS: every required job succeeded", summary.read_text(encoding="utf-8"))

            # Positive regression test: tampered receipts must cause Aggregate required results to fail even if all job.result == "success".
            tampered_outcome = valid_receipt()
            tampered_outcome["outcome"] = "FAIL"
            tampered_outcome["rc"] = 1
            tampered_outcome["assertions"][0]["accepted"] = False

            tampered_schema = valid_receipt()
            tampered_schema["rc"] = 1  # outcome == PASS with rc == 1

            tampered_zero_passed = valid_receipt()
            tampered_zero_passed["counts"]["passed"] = 0

            for idx, bad_receipt in enumerate((tampered_outcome, tampered_schema, tampered_zero_passed)):
                with self.subTest(case=idx):
                    summary.write_text("", encoding="utf-8")
                    (receipts_dir / "unit.receipt.json").write_text(json.dumps(bad_receipt), encoding="utf-8")
                    env_bad = dict(
                        os.environ,
                        GITHUB_STEP_SUMMARY=str(summary),
                        PACKAGE_RECEIPT=json.dumps(good),
                        MV_REQUIRED_RECEIPTS_DIR=str(receipts_dir),
                    )
                    res_bad = subprocess.run(
                        ["bash", "-e", "-u", "-o", "pipefail", "-c", rendered],
                        cwd=ROOT,
                        env=env_bad,
                        capture_output=True,
                        text=True,
                        timeout=15,
                    )
                    self.assertNotEqual(res_bad.returncode, 0)
                    self.assertIn("outcome FAIL: a required job failed", summary.read_text(encoding="utf-8"))

    def test_arg_ci_6_laws_range_failure_writes_blocked_receipt_and_continues(self):
        """Regression test for ARG-ci-6: laws_range.py failure writes BLOCKED receipt and continues to remaining gates."""
        ci_doc = yaml.safe_load(CI_YML.read_text(encoding="utf-8"))
        laws_job = ci_doc["jobs"]["laws-contracts"]
        gate_step = [s for s in laws_job["steps"] if "laws_range.py" in s.get("run", "")][0]
        script = gate_step["run"]
        fast_script = script.replace(
            "set -- python3 -m unittest discover -s tests -v",
            "set -- python3 -m unittest tests/test_check_laws.py -v",
        )
        with tempfile.TemporaryDirectory(prefix="t7r2c-argci6-") as tmp:
            summary = pathlib.Path(tmp) / "summary.md"
            env_fail = dict(
                os.environ,
                RUNNER_TEMP=tmp,
                GITHUB_STEP_SUMMARY=str(summary),
                GITHUB_SHA="a" * 40,
                GITHUB_RUN_ID="1001",
                JOB_ID="laws-contracts",
                PLATFORM="x64",
                EVENT_NAME="push",
                BEFORE="not-a-valid-sha",
            )
            res_fail = subprocess.run(
                ["bash", "-c", fast_script],
                cwd=ROOT,
                env=env_fail,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertNotEqual(res_fail.returncode, 0)
            evdir = pathlib.Path(tmp) / "metaviewer-ci" / "laws-contracts" / "x64"
            for gate_name in ("laws-range", "laws-version", "contracts", "unittest-root"):
                self.assertTrue((evdir / f"{gate_name}.receipt.json").is_file(), f"missing receipt for {gate_name}")
            range_receipt = json.loads((evdir / "laws-range.receipt.json").read_text(encoding="utf-8"))
            self.assertEqual(range_receipt["outcome"], "BLOCKED")
            self.assertIsNone(range_receipt["rc"])
            self.assertEqual(range_receipt["counts"]["source"], "unexecuted")
            version_receipt = json.loads((evdir / "laws-version.receipt.json").read_text(encoding="utf-8"))
            self.assertEqual(version_receipt["outcome"], "PASS")

            # Negative control: valid BEFORE and HEAD succeeds and writes PASS receipt for laws-range.
            head_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
            tmp_ok = pathlib.Path(tmp) / "ok"
            tmp_ok.mkdir()
            env_ok = dict(env_fail, RUNNER_TEMP=str(tmp_ok), BEFORE=head_sha, HEAD=head_sha)
            res_ok = subprocess.run(
                ["bash", "-c", fast_script],
                cwd=ROOT,
                env=env_ok,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(res_ok.returncode, 0, res_ok.stdout + res_ok.stderr)
            evdir_ok = tmp_ok / "metaviewer-ci" / "laws-contracts" / "x64"
            range_ok = json.loads((evdir_ok / "laws-range.receipt.json").read_text(encoding="utf-8"))
            self.assertEqual(range_ok["outcome"], "PASS")


if __name__ == "__main__":
    unittest.main()
