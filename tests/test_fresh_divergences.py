r"""Fresh divergence checks, regex anchor edge cases, and decoder boundary tests.

Covers:
a) $ -> \Z anchor rewrite edge cases ($ vs \$ vs character class containing $).
b) Go ValidateJSON vs ValidateEnvelope integer rails.
c) Python snapshot vs standalone schemas agreement.
d) Schema oneOf exact-one branch rule.
"""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from tools.check_contracts import ROOT, ValidationError, Validator

sys.path.insert(0, str(ROOT / "agents"))
import metaviewer_agents.envelope as envelope_mod


class RegexAnchorTests(unittest.TestCase):
    def setUp(self):
        self.validator = Validator(ROOT / "contracts/v0.2")

    def test_anchor_rewrite_edge_cases(self):
        r"""Test pattern rewrite behavior for $, \$ and character classes."""
        schema_anchor = {"type": "string", "pattern": "^abc$"}
        self.validator.validate("abc", schema_anchor)
        for bad in ("abc\n", "abc\r", "abc\r\n"):
            with self.subTest(bad=repr(bad)):
                with self.assertRaises(ValidationError):
                    self.validator.validate(bad, schema_anchor)

        schema_escaped = {"type": "string", "pattern": r"^abc\$"}
        self.validator.validate("abc$", schema_escaped)
        with self.assertRaises(ValidationError):
            self.validator.validate("abc", schema_escaped)

        schema_class = {"type": "string", "pattern": r"^[a-z$]+$"}
        self.validator.validate("abc$def", schema_class)
        with self.assertRaises(ValidationError):
            self.validator.validate("abc$def\n", schema_class)


class GoIntegerRailVsValidateJsonTests(unittest.TestCase):
    def test_go_validate_json_vs_policy_integer_rails(self):
        """Go ValidateJSON alone admits large ints; ValidateEnvelope policy refuses outside safe-int."""
        go = shutil.which(os.environ.get("GO", "go"))
        self.assertIsNotNone(go, "go must be supplied by PATH or GO")
        with tempfile.TemporaryDirectory(prefix="mv-go-rail-", dir="/tmp") as temp_dir:
            env = dict(
                os.environ,
                GOPROXY="off",
                GOSUMDB="off",
                GOTOOLCHAIN="local",
                TMPDIR=temp_dir,
            )
            res = subprocess.run(
                [go, "test", "-run", "^TestIntegerRailDivergence$", "-count=1", "./internal/ipc"],
                capture_output=True,
                text=True,
                cwd=ROOT / "daemon-adapter",
                env=env,
                timeout=60,
            )
            self.assertEqual(res.returncode, 0, res.stderr + "\n" + res.stdout)


class PythonSnapshotVsStandaloneSchemasTests(unittest.TestCase):
    def setUp(self):
        self.validator = Validator(ROOT / "contracts/v0.2")

    def test_snapshot_vs_standalone_schemas_agreement(self):
        """Python snapshot _contracts_v02 and standalone v0.2 schemas agree on ui_intent control ops."""
        ui_schema = self.validator.load("ui_intent.schema.json")

        for op in ("take_control", "release_control"):
            val_control = {
                "schema": "ui_intent/v0.2",
                "request_id": "req1",
                "op": op,
                "params": {"surface_id": "s1"},
            }
            self.validator.validate(val_control, ui_schema)
            out = envelope_mod.validate_envelope(
                {
                    "schema": "envelope/v0.2",
                    "msg_id": "m1",
                    "ts_ns": 1,
                    "from": {"component": "agent", "instance": "a1"},
                    "to": {"component": "daemon", "instance": "d1"},
                    "session_id": "s1",
                    "seq": 1,
                    "nonce": "n1",
                    "body": val_control,
                }
            )
            self.assertEqual(out["body"]["op"], op)

            bad_control = {**val_control, "params": {"surface_id": "s1", "owner": "human"}}
            with self.assertRaises(ValidationError):
                self.validator.validate(bad_control, ui_schema)
            with self.assertRaises(envelope_mod.EnvelopeError):
                envelope_mod.validate_envelope(
                    {
                        "schema": "envelope/v0.2",
                        "msg_id": "m1",
                        "ts_ns": 1,
                        "from": {"component": "agent", "instance": "a1"},
                        "to": {"component": "daemon", "instance": "d1"},
                        "session_id": "s1",
                        "seq": 1,
                        "nonce": "n1",
                        "body": bad_control,
                    }
                )


class OneOfExactOneTests(unittest.TestCase):
    def setUp(self):
        self.validator = Validator(ROOT / "contracts/v0.2")

    def test_oneof_exact_one_branch_refusal(self):
        """Payload matching 0 or >1 branches in oneOf is refused by exact-one rule."""
        schema_oneof = {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "val": {
                    "oneOf": [
                        {"type": "integer", "minimum": 0},
                        {"type": "number", "minimum": 0},
                    ]
                }
            },
            "required": ["val"],
        }
        self.validator.audit(schema_oneof)

        # Positive control: 5.5 matches only the number branch (1 branch)
        self.validator.validate({"val": 5.5}, schema_oneof)

        # Value matching both integer and number branch is refused because 2 branches match
        with self.assertRaises(ValidationError):
            self.validator.validate({"val": 5}, schema_oneof)

        # Value matching 0 branches is refused
        with self.assertRaises(ValidationError):
            self.validator.validate({"val": -1}, schema_oneof)


if __name__ == "__main__":
    unittest.main()
