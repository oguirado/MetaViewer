"""T7 R2c O4 Receipt, Product Identity, and Aggregation Closure Test Suite.

Tests F4 receipt_errors and aggregate logic extracted from ci.yml,
demonstrates the live ci-required path gap, and tests package.yml/build-other.yml.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / '.github/workflows/ci.yml'


def extract_f4_receipt_validator():
    """Extract receipt_errors and aggregate functions directly from ci.yml."""
    text = CI.read_text()
    f4_src = textwrap.dedent(text[text.index('          RKEYS = {"schema"'):
                                  text.index('          check("f4-agg-ok"')])

    spec = importlib.util.spec_from_file_location("package_identity", ROOT / "tests/ci/test_package_identity.py")
    pkg_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pkg_mod)

    scope = dict(
        re=re,
        json=json,
        importlib=importlib,
        distribution_errors=pkg_mod.distribution_errors,
        check=lambda name, cond, *args: None,
    )
    exec(f4_src, scope)
    return scope['receipt_errors'], scope['aggregate'], scope['genuine'], scope['reg']


class ReceiptIdentityAndAggregationTests(unittest.TestCase):
    def setUp(self):
        self.receipt_errors, self.aggregate, self.genuine, self.reg = extract_f4_receipt_validator()

    def test_o4_receipt_errors_validation_cases(self):
        """Test F4 receipt_errors validation against malformed and tampered inputs."""
        self.assertEqual(self.receipt_errors(self.genuine, self.reg), [])

        invalid_counts = json.loads(json.dumps(self.genuine))
        invalid_counts["counts"]["passed"] = "invalid"
        self.assertIn("counts-passed", self.receipt_errors(invalid_counts, self.reg))

        tampered_log = json.loads(json.dumps(self.genuine))
        tampered_log["identities"]["sanitized_log_sha256"] = "0" * 64
        self.assertIn("oracle-sanitized_log_sha256", self.receipt_errors(tampered_log, self.reg))

        missing_product_id = json.loads(json.dumps(self.genuine))
        del missing_product_id["product_identity"]
        self.assertIn("keys", self.receipt_errors(missing_product_id, self.reg))

        extra_key = json.loads(json.dumps(self.genuine))
        extra_key["extra_field"] = "value"
        self.assertIn("keys", self.receipt_errors(extra_key, self.reg))

        empty_argv = json.loads(json.dumps(self.genuine))
        empty_argv["argv"] = []
        self.assertIn("argv", self.receipt_errors(empty_argv, self.reg))

        unknown_outcome = json.loads(json.dumps(self.genuine))
        unknown_outcome["outcome"] = "INVALID"
        unknown_outcome["rc"] = None
        self.assertIn("outcome", self.receipt_errors(unknown_outcome, self.reg))

    def test_o4_aggregate_closure_and_set_equality(self):
        """Test aggregate() receipt closure, outcome check, and identity-set equality."""
        req = {"rust": {"PASS"}, "novac": {"PASS", "NOT_APPLICABLE"}}

        rust_rcpt = json.loads(json.dumps(self.genuine))
        rust_rcpt["gate_id"] = "rust"

        novac_rcpt = json.loads(json.dumps(self.genuine))
        novac_rcpt.update({"gate_id": "novac", "rc": None, "outcome": "NOT_APPLICABLE", "reason": "w1"})

        ok, reason = self.aggregate(req, [rust_rcpt, novac_rcpt], {"rust": "success", "novac": "success"})
        self.assertTrue(ok, reason)

        dup_rust = json.loads(json.dumps(rust_rcpt))
        ok_dup, reason_dup = self.aggregate(req, [rust_rcpt, dup_rust], {"rust": "success", "novac": "success"})
        self.assertFalse(ok_dup)
        self.assertEqual(reason_dup, "identity-set")

        ok_miss, reason_miss = self.aggregate(req, [rust_rcpt], {"rust": "success", "novac": "success"})
        self.assertFalse(ok_miss)
        self.assertEqual(reason_miss, "identity-set")

        ok_fail, reason_fail = self.aggregate(req, [rust_rcpt, novac_rcpt], {"rust": "failure", "novac": "success"})
        self.assertFalse(ok_fail)
        self.assertEqual(reason_fail, "job-rust")

        rust_na = json.loads(json.dumps(rust_rcpt))
        rust_na.update({"rc": None, "outcome": "NOT_APPLICABLE"})
        ok_na, reason_na = self.aggregate(req, [rust_na, novac_rcpt], {"rust": "success", "novac": "success"})
        self.assertFalse(ok_na)
        self.assertEqual(reason_na, "outcome-rust")

    def test_o4_live_ci_required_path_gap_counterexample(self):
        """Demonstrate live ci-required path gap: checks result strings instead of evaluating receipts."""
        ci_text = CI.read_text()
        required_block = ci_text.split("  ci-required:", 1)[1]

        self.assertIn('check rust "${{ needs.rust.result }}"', required_block)
        self.assertIn('check package "${{ needs.package.result }}"', required_block)

        job_result = "success"
        tampered_receipt = json.loads(json.dumps(self.genuine))
        tampered_receipt["gate_id"] = "rust"
        tampered_receipt["outcome"] = "FAIL"

        req = {"rust": {"PASS"}}

        f4_ok, f4_reason = self.aggregate(req, [tampered_receipt], {"rust": job_result})
        self.assertFalse(f4_ok)
        self.assertEqual(f4_reason, "outcome-rust")

        ci_required_check_passes = (job_result == "success")
        self.assertTrue(ci_required_check_passes, "Live ci-required string check accepted tampered job result")


if __name__ == "__main__":
    unittest.main()
