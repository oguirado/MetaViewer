"""Version-skew pin tests and contract checker subset property tests.

Locks expected version skew behavior across Python agents, Go adapter, and Rust core,
and tests Validator property invariants on schema subsets.
"""

import json
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "agents"))

from tools.check_contracts import Validator, ValidationError, check_repository
from metaviewer_agents.envelope import SCHEMA as PY_ENV_SCHEMA, EnvelopeError, validate_envelope
import metaviewer_agents.tools as tools


class VersionSkewPinTests(unittest.TestCase):
    def test_python_envelope_supports_v02(self):
        """The migrated agent accepts v0.2 and refuses foreign versions."""
        self.assertEqual(PY_ENV_SCHEMA, "envelope/v0.2")

        v02_envelope = json.loads((ROOT / "contracts/examples/v0.2/envelope.valid.json").read_text())
        validate_envelope(v02_envelope)
        with self.assertRaises(EnvelopeError) as ctx:
            validate_envelope({**v02_envelope, "schema": "envelope/v9.9"})
        self.assertEqual(ctx.exception.code, "unknown_version")

    def test_python_tools_discriminators_use_v02(self):
        """Migrated tool discriminators consistently advertise v0.2."""
        self.assertEqual(tools._CALL_SCHEMA, "mv_tool_call/v0.2")
        self.assertEqual(tools._RESULT_SCHEMA, "mv_tool_result/v0.2")
        self.assertEqual(tools._OBSERVATION_SCHEMA, "observation/v0.2")
        self.assertEqual(tools._FRAME_SCHEMA, "frame_ref/v0.2")
        self.assertEqual(tools._VERDICT_SCHEMA, "action_verdict/v0.2")
        self.assertEqual(tools._RECEIPT_SCHEMA, "action_receipt/v0.2")
        self.assertEqual(tools._SURFACE_SCHEMA, "surface/v0.2")

    def test_go_adapter_has_production_validate_envelope_impl(self):
        """The adapter supplies an authoritative production envelope policy."""
        adapter_dir = ROOT / "daemon-adapter"
        impl_files = []
        pattern = re.compile(r"func\s+\(.*\)\s+ValidateEnvelope\b")
        for p in adapter_dir.glob("**/*.go"):
            if not p.name.endswith("_test.go"):
                content = p.read_text()
                if pattern.search(content):
                    impl_files.append(str(p.relative_to(adapter_dir)))
        self.assertTrue(impl_files, "Missing production ValidateEnvelope implementation")


class CheckerSubsetPropertyTests(unittest.TestCase):
    def setUp(self):
        self.v02 = Validator(ROOT / "contracts/v0.2")

    def test_audit_rejects_unsupported_keywords(self):
        for bad_schema in [
            {"type": "object", "additionalProperties": False, "oneOf": [], "properties": {}},
            {"type": "object", "additionalProperties": True},
            {"type": "object", "additionalProperties": False, "properties": {}, "unsupported_keyword": True},
            {"type": "integer", "minimum": 10, "maximum": 5},  # inverted bounds
        ]:
            with self.subTest(schema=bad_schema):
                with self.assertRaises(ValidationError):
                    self.v02.audit(bad_schema)

    def test_reference_traversal_is_sibling_local_and_bounded(self):
        for bad_ref in [
            "../v0.1/envelope.schema.json",
            "http://example.com/schema.json",
            "nonexistent.schema.json",
            "#/$defs/missing",
        ]:
            with self.subTest(ref=bad_ref):
                with self.assertRaises((ValidationError, OSError)):
                    self.v02.audit({"$ref": bad_ref})

    def test_check_repository_empty_and_invalid_version_selections(self):
        for bad_versions in [(), ("v9.9",), ("v0.1", "v0.1")]:
            with self.subTest(versions=bad_versions):
                errors = check_repository(ROOT, versions=bad_versions)
                self.assertTrue(errors)


if __name__ == "__main__":
    unittest.main()
