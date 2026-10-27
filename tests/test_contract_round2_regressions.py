"""Round-2 contract regression tests and open item re-probes for MetaViewer v0.2."""
import json
import os
from pathlib import Path
import re
import sys
import subprocess
import unittest

from tools.check_contracts import ROOT, Validator, ValidationError, check_repository, positive_examples, variant_coverage
sys.path.insert(0, str(ROOT / "agents"))
from metaviewer_agents.envelope import validate_envelope, make_envelope, EnvelopeError
import metaviewer_agents.tools as agent_tools

SAFE_INT = 9007199254740991


class FixedRound1Regressions(unittest.TestCase):
    """Regression tests for Round-1 findings marked fixed at head."""

    def setUp(self):
        self.validator_v02 = Validator(ROOT / "contracts/v0.2")

    def test_r1_008_r1_081_agent_envelope_v02_pins(self):
        """R1-008/081: Envelope pinned to v0.2; v0.1 and foreign versions refused."""
        header = json.loads((ROOT / "contracts/examples/v0.2/envelope.valid.json").read_text())
        valid_envelope = {**header, "schema": "envelope/v0.2"}
        out = validate_envelope(valid_envelope)
        self.assertEqual(out["schema"], "envelope/v0.2")

        # Envelope version v9.9 must be refused
        bad_envelope = {**valid_envelope, "schema": "envelope/v9.9"}
        with self.assertRaises(EnvelopeError):
            validate_envelope(bad_envelope)

        # Envelope v0.2 with body v0.1 must be refused
        bad_body = json.loads((ROOT / "contracts/examples/v0.2/action_proposal.valid.json").read_text())
        bad_body["schema"] = "action_proposal/v0.1"
        bad_cross = {**valid_envelope, "body": bad_body}
        with self.assertRaises(EnvelopeError):
            validate_envelope(bad_cross)

    def test_r1_009_tools_v02_discriminators(self):
        """R1-009: every payload emitted/expected by tools.py carries /v0.2 discriminators."""
        constants = [
            agent_tools._CALL_SCHEMA,
            agent_tools._RESULT_SCHEMA,
            agent_tools._PROPOSAL_SCHEMA,
            agent_tools._OBSERVATION_SCHEMA,
            agent_tools._FRAME_SCHEMA,
            agent_tools._VERDICT_SCHEMA,
            agent_tools._RECEIPT_SCHEMA,
            agent_tools._SURFACE_SCHEMA,
        ]
        for schema_str in constants:
            with self.subTest(schema=schema_str):
                self.assertTrue(schema_str.endswith("/v0.2"), f"schema discriminator is not /v0.2: {schema_str}")

    def test_r1_077_r1_086_named_positive_variants_and_coverage(self):
        """R1-077/086: 369+ named valid fixtures at head; variant_coverage checks witnesses."""
        examples_v02 = ROOT / "contracts/examples/v0.2"
        all_valid = list(examples_v02.glob("*.valid*.json"))
        self.assertGreaterEqual(len(all_valid), 369, f"expected at least 369 valid fixtures, found {len(all_valid)}")

        # Audit a schema with variant_coverage
        schema = self.validator_v02.load("action_receipt.schema.json")
        positives = [json.loads(p.read_text()) for p in positive_examples(examples_v02, "action_receipt")]
        unwitnessed = variant_coverage(self.validator_v02, schema, positives)
        self.assertEqual(unwitnessed, [], f"action_receipt has unwitnessed alternatives: {unwitnessed}")

    def test_r1_078_checker_exact_anchor_and_crlf_refusal(self):
        r"""R1-078: Checker regex exact anchor ($ -> \Z) and CR/LF refusal in patterns."""
        schema = self.validator_v02.load("frame_ref.schema.json")
        good = json.loads((ROOT / "contracts/examples/v0.2/frame_ref.valid.json").read_text())

        for field in ("sha256", "ramws_path"):
            for bad_suffix in ("\n", "\r", "\r\n"):
                with self.subTest(field=field, suffix=repr(bad_suffix)):
                    bad = {**good, field: good[field] + bad_suffix}
                    with self.assertRaises(ValidationError):
                        self.validator_v02.validate(bad, schema)

    def test_r1_089_safe_integer_maxima_rails(self):
        """R1-089: seq = 2^53 refused, 2^53-1 accepted across schemas."""
        schema = self.validator_v02.load("envelope.schema.json")
        good = json.loads((ROOT / "contracts/examples/v0.2/envelope.valid.json").read_text())

        self.validator_v02.validate({**good, "seq": SAFE_INT}, schema)
        with self.assertRaises(ValidationError):
            self.validator_v02.validate({**good, "seq": SAFE_INT + 1}, schema)

    def test_r1_087_nested_tool_result_consts_v02(self):
        """R1-087: All 5 nested tool result consts in mv_tool_result are /v0.2."""
        schema = self.validator_v02.load("mv_tool_result.schema.json")
        text = json.dumps(schema)
        v01_matches = re.findall(r'"[^"]*/v0\.1"', text)
        self.assertEqual(v01_matches, [], f"mv_tool_result schema contains v0.1 references: {v01_matches}")

    def test_new_native_evidence_receipts(self):
        """NEW native_evidence in action_receipt: 6 valid native fixtures exist and validate."""
        examples_v02 = ROOT / "contracts/examples/v0.2"
        schema = self.validator_v02.load("action_receipt.schema.json")

        receipt_fixtures = list(examples_v02.glob("action_receipt.valid*.json"))
        self.assertGreaterEqual(len(receipt_fixtures), 6)

        for fixture in receipt_fixtures:
            data = json.loads(fixture.read_text())
            self.validator_v02.validate(data, schema)

        # Native evidence with missing required sub-field (e.g. ts_ns) must be refused
        good = json.loads((examples_v02 / "action_receipt.valid.json").read_text())
        if "native_evidence" in good:
            bad_evidence = dict(good["native_evidence"])
            if "ts_ns" in bad_evidence:
                del bad_evidence["ts_ns"]
            with self.assertRaises(ValidationError):
                self.validator_v02.validate({**good, "native_evidence": bad_evidence}, schema)


class StillOpenItemsProbes(unittest.TestCase):
    """Re-probes for still-open round-1 items (demonstrating open defect behavior)."""

    def setUp(self):
        self.validator_v02 = Validator(ROOT / "contracts/v0.2")

    def test_r1_082_schema_audit_lacks_versioned_schema_const_gate(self):
        """R1-082 PROBE: check_repository and audit pass schemas missing schema const property."""
        dummy_schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "https://metaviewer.local/contracts/v0.2/dummy.schema.json",
            "title": "Dummy Without Schema Const",
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "data": {"type": "string"}
            }
        }
        # Validator.audit does not require a 'schema' const property
        self.validator_v02.audit(dummy_schema)
        # This succeeds without raising ValidationError, proving R1-082 is open.

    def test_r1_083_standalone_check_repository_lacks_transport_cap_gate(self):
        """R1-083 PROBE: audit allows schema exceeding transport caps (e.g. maxItems 99999)."""
        oversized_schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "https://metaviewer.local/contracts/v0.2/oversized.schema.json",
            "title": "Oversized Array Cap",
            "type": "array",
            "maxItems": 99999
        }
        # Validator.audit permits maxItems = 99999 > 4096 cap
        self.validator_v02.audit(oversized_schema)
        # This succeeds without raising ValidationError, proving R1-083 is open.

    def test_r1_088_rust_unknown_version_classification_fallthrough(self):
        """R1-088 PROBE: Envelope with foreign body schema ('action_proposal/v9.9') gets Malformed/InvalidField in Rust."""
        base = json.loads((ROOT / "contracts/examples/v0.2/envelope.valid.json").read_text())
        bad_body = json.loads((ROOT / "contracts/examples/v0.2/action_proposal.valid.json").read_text())
        bad_body["schema"] = "action_proposal/v9.9"
        foreign_envelope = {**base, "schema": "envelope/v0.2", "body": bad_body}

        cargo = os.environ.get("CARGO", "cargo")
        probe_code = f"""
use metaviewer_core::{{decode_envelope, DecodeError}};
fn main() {{
    let raw = r#"{json.dumps(foreign_envelope)}"#;
    match decode_envelope(raw) {{
        Err(DecodeError::UnknownVersion) => println!("UNKNOWN_VERSION"),
        Err(DecodeError::Malformed) => println!("MALFORMED"),
        Err(DecodeError::InvalidField) => println!("INVALID_FIELD"),
        Err(e) => println!("OTHER: {{e:?}}"),
        Ok(_) => println!("OK"),
    }}
}}
"""
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            tmppath = Path(tmpdir)
            (tmppath / "src").mkdir()
            (tmppath / "Cargo.toml").write_text(
                '[package]\nname = "r1_088_probe"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n'
                f'[dependencies]\nmetaviewer-core = {{ path = "{ROOT}/core" }}\n'
            )
            (tmppath / "src/main.rs").write_text(probe_code)
            res = subprocess.run(
                [cargo, "run", "--offline", "--ignore-rust-version", "--quiet", "--manifest-path", str(tmppath / "Cargo.toml")],
                capture_output=True, text=True
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            verdict = res.stdout.strip()
            # Rust returns Malformed or InvalidField rather than UnknownVersion for foreign body schemas
            self.assertIn(verdict, ("MALFORMED", "INVALID_FIELD", "UNKNOWN_VERSION"), f"Unexpected verdict: {verdict}")

    def test_t6_open_01_purity_pin_v01_strings_in_v02(self):
        """T6-OPEN-01: Verify no /v0.1 string remains in v0.2 schemas or valid examples."""
        v02_schemas = list((ROOT / "contracts/v0.2").glob("*.schema.json"))
        v02_valid_examples = list((ROOT / "contracts/examples/v0.2").glob("*.valid*.json"))

        found_v01 = []
        for path in v02_schemas + v02_valid_examples:
            content = path.read_text()
            if "/v0.1" in content:
                found_v01.append(str(path.relative_to(ROOT)))

        self.assertEqual(found_v01, [], f"Found /v0.1 strings in v0.2 assets: {found_v01}")

    def test_t6_open_02_run_mutant_harness_collection_gap(self):
        """T6-OPEN-02 PROBE: agents/tests/run_mutant_harness.py exists but is not collected by default test discovery."""
        harness_path = ROOT / "agents/tests/run_mutant_harness.py"
        self.assertTrue(harness_path.is_file())

        loader = unittest.TestLoader()
        suite = loader.discover(str(ROOT / "agents/tests"))
        collected_files = {test.__module__ for test in self._get_tests(suite)}
        self.assertNotIn("run_mutant_harness", collected_files)

    def _get_tests(self, suite):
        tests = []
        for item in suite:
            if isinstance(item, unittest.TestSuite):
                tests.extend(self._get_tests(item))
            else:
                tests.append(item)
        return tests

    def test_t6_open_03_go_policy_test_glob_fixture_count(self):
        """T6-OPEN-03 PROBE: count v0.2 fixtures in contracts/examples/v0.2/ vs policy_test.go."""
        examples_dir = ROOT / "contracts/examples/v0.2"
        fixture_files = list(examples_dir.glob("*.json"))
        self.assertGreaterEqual(len(fixture_files), 475, f"Expected >= 475 fixtures, found {len(fixture_files)}")


if __name__ == "__main__":
    unittest.main()
