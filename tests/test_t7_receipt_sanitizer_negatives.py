import json
import re
import unittest


def receipt_errors(r, reg):
    RKEYS = {"schema", "gate_id", "leg", "profile", "owner", "issuer", "scope", "argv", "cwd",
             "rc", "outcome", "reason", "identities", "assertions", "counts"}
    OUTCOMES = {"PASS", "FAIL", "BLOCKED", "UNKNOWN", "NOT_APPLICABLE"}

    errs = []
    if set(r) != RKEYS:
        errs.append("keys")
        return errs
    if r["schema"] != "gate_receipt/v1":
        errs.append("schema")
    for k in ("gate_id", "leg", "profile", "owner", "issuer", "reason", "cwd"):
        if not isinstance(r[k], str) or not r[k]:
            errs.append(k)
    if r["outcome"] not in OUTCOMES:
        errs.append("outcome")
    if r["outcome"] in ("PASS", "FAIL"):
        if type(r["rc"]) is not int:
            errs.append("rc-int")
    elif r["rc"] is not None:
        errs.append("rc-null")
    if not isinstance(r["argv"], list) or not r["argv"] or any(not isinstance(a, str) or not a for a in r["argv"]):
        errs.append("argv")
    if set(r["scope"]) != {"unit", "platform", "feature", "artifact"} or any(not isinstance(v, str) or not v for v in r["scope"].values()):
        errs.append("scope")
    ids = r["identities"]
    if set(ids) != {"gate_revision", "instrument_sha256", "artifact_sha256", "configuration_sha256",
                    "log_sha256", "fixture_sha256"}:
        errs.append("identities-keys")
        return errs
    hexok = lambda v: isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v) is not None
    for k in ("instrument_sha256", "artifact_sha256", "configuration_sha256", "log_sha256"):
        if not hexok(ids[k]):
            errs.append("identities-" + k)
    if not isinstance(ids["fixture_sha256"], list) or not ids["fixture_sha256"] or any(not hexok(v) for v in ids["fixture_sha256"]):
        errs.append("fixture_sha256")
    if not isinstance(r["assertions"], list) or not r["assertions"]:
        errs.append("assertions-empty")
    else:
        for a in r["assertions"]:
            if set(a) != {"id", "expected", "observed", "accepted"} or type(a["accepted"]) is not bool:
                errs.append("assertion-shape")
    c = r["counts"]
    if set(c) != {"passed", "failed", "skipped", "source"} or not isinstance(c["source"], str) or not c["source"]:
        errs.append("counts")
    else:
        for k in ("passed", "failed", "skipped"):
            if c[k] is not None and (type(c[k]) is not int or c[k] < 0):
                errs.append("counts-" + k)
    for k, v in reg.items():
        if ids.get(k) != v:
            errs.append("oracle-" + k)
    return errs


def ci_yml_sanitizer(text):
    """Baseline sanitizer from ci.yml line 365-377."""
    for prefix in ("gh" + "p_", "github_" + "pat_", "AK" + "IA", "xox" + "b-", "MV0-SYNTHETIC-SENTINEL-"):
        text = re.sub(prefix + r"[A-Za-z0-9_\-]{4,}", "[REDACTED]", text)
    return text.replace("__MV0_PRIVATE_SOURCE_SENTINEL__", "[REDACTED]")


def robust_sanitizer(text):
    """Extended robust sanitizer that redacts case-insensitive, URL-encoded, and line-chunked secrets."""
    # Redact URL-encoded prefixes like ghp%5F
    text = re.sub(r"(?i)(ghp|github_pat|AKIA|xoxb|MV0-SYNTHETIC-SENTINEL)(%5F|_)[A-Za-z0-9_\-%]{4,}", "[REDACTED]", text)
    for prefix in ("gh" + "p_", "github_" + "pat_", "AK" + "IA", "xox" + "b-", "MV0-SYNTHETIC-SENTINEL-"):
        text = re.sub(prefix + r"[\s\S]{0,4}[A-Za-z0-9_\-]{32,}", "[REDACTED]", text, flags=re.IGNORECASE)
    return text.replace("__MV0_PRIVATE_SOURCE_SENTINEL__", "[REDACTED]")


class ReceiptAndSanitizerNegativesTests(unittest.TestCase):
    def setUp(self):
        self.genuine = {
            "schema": "gate_receipt/v1", "gate_id": "g", "leg": "g", "profile": "W0",
            "owner": "W0-CI-MATRIX", "issuer": "CI/g/1 [VM]", "argv": ["true"], "cwd": "/tmp",
            "rc": 0, "outcome": "PASS", "reason": "ok",
            "scope": {"unit": "u", "platform": "x64", "feature": "g", "artifact": "g.receipt.json"},
            "identities": {"gate_revision": "r", "instrument_sha256": "a" * 64, "artifact_sha256": "b" * 64,
                           "configuration_sha256": "c" * 64, "log_sha256": "d" * 64, "fixture_sha256": ["a" * 64]},
            "assertions": [{"id": "exit-status", "expected": "rc 0", "observed": "rc 0", "accepted": True}],
            "counts": {"passed": 1, "failed": 0, "skipped": 0, "source": "parsed:true"}
        }
        self.reg = {
            "instrument_sha256": "a" * 64, "artifact_sha256": "b" * 64,
            "configuration_sha256": "c" * 64, "log_sha256": "d" * 64
        }

    def test_genuine_receipt_passes(self):
        self.assertEqual(receipt_errors(self.genuine, self.reg), [])

    def test_receipt_negative_controls(self):
        """O8: Receipt negative controls (unknown outcome, empty argv, negative counts, extra key, tampered artifact_sha256)."""
        # 1. Unknown outcome
        bad_outcome = json.loads(json.dumps(self.genuine))
        bad_outcome["outcome"] = "INVALID_OUTCOME"
        self.assertIn("outcome", receipt_errors(bad_outcome, self.reg))

        # 2. Empty argv
        empty_argv = json.loads(json.dumps(self.genuine))
        empty_argv["argv"] = []
        self.assertIn("argv", receipt_errors(empty_argv, self.reg))

        # 3. Negative counts
        neg_counts = json.loads(json.dumps(self.genuine))
        neg_counts["counts"]["passed"] = -1
        self.assertIn("counts-passed", receipt_errors(neg_counts, self.reg))

        # 4. Extra key
        extra_key = json.loads(json.dumps(self.genuine))
        extra_key["extra_field"] = "value"
        self.assertIn("keys", receipt_errors(extra_key, self.reg))

        # 5. Tampered artifact_sha256
        tampered_hash = json.loads(json.dumps(self.genuine))
        tampered_hash["identities"]["artifact_sha256"] = "f" * 64
        self.assertIn("oracle-artifact_sha256", receipt_errors(tampered_hash, self.reg))

    def test_ci_yml_sanitizer_finding_on_encoded_and_chunked_secrets(self):
        """Verify finding in ci.yml:365-377: URL-encoded secrets leak through baseline ci.yml sanitizer."""
        secret_body = "9" * 36
        encoded_token = "gh" + "p%5F" + secret_body
        out = ci_yml_sanitizer(encoded_token)
        # Baseline ci.yml sanitizer fails to redact URL-encoded token
        self.assertIn(secret_body, out)

    def test_robust_sanitizer_redacts_encoded_and_chunked_secrets(self):
        """O8: Robust sanitizer redacts uppercase prefix, URL-encoded tokens, and chunked secrets."""
        secret_body = "9" * 36

        # Uppercase prefix
        upper_token = "GH" + "P_" + secret_body
        sanitized_upper = robust_sanitizer(upper_token)
        self.assertNotIn(secret_body, sanitized_upper)

        # URL-encoded token
        encoded_token = "gh" + "p%5F" + secret_body
        sanitized_encoded = robust_sanitizer(encoded_token)
        self.assertNotIn(secret_body, sanitized_encoded)

        # Chunked secret
        chunked_token = "gh" + "p_\n" + secret_body
        sanitized_chunked = robust_sanitizer(chunked_token)
        self.assertNotIn(secret_body, sanitized_chunked)


if __name__ == "__main__":
    unittest.main()
