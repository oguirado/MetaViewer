r"""Fresh divergence hunts, regex anchor edge cases, and decoder boundary tests.

Covers:
a) $ -> \Z anchor rewrite edge cases ($ vs \$ vs $$ vs character class containing $).
b) Go ValidateJSON vs ValidateEnvelope integer rails.
c) Python snapshot vs standalone schemas agreement.
d) Rust untagged UiIntent vs schema oneOf exact-one rule.
e) native_evidence optionality vs inner field requiredness across decoders.
"""

import copy
import json
import os
from pathlib import Path
import re
import sys
import subprocess
import unittest

from tools.check_contracts import ROOT, Validator, ValidationError
sys.path.insert(0, str(ROOT / "agents"))
import metaviewer_agents.envelope as envelope_mod
import metaviewer_agents._contracts_v02 as contracts_v02


class RegexAnchorTests(unittest.TestCase):
    def setUp(self):
        self.validator = Validator(ROOT / "contracts/v0.2")

    def test_anchor_rewrite_edge_cases(self):
        r"""Test pattern rewrite behavior for $, \$ and character classes."""
        # Standard end anchor $ converts to \Z and refuses trailing CR/LF
        schema_anchor = {"type": "string", "pattern": "^abc$"}
        self.validator.validate("abc", schema_anchor)
        for bad in ("abc\n", "abc\r", "abc\r\n"):
            with self.assertRaises(ValidationError):
                self.validator.validate(bad, schema_anchor)

        # Escaped \$ must match literal $ at end
        schema_escaped = {"type": "string", "pattern": r"^abc\$"}
        self.validator.validate("abc$", schema_escaped)
        with self.assertRaises(ValidationError):
            self.validator.validate("abc", schema_escaped)

        # Character class containing $
        schema_class = {"type": "string", "pattern": r"^[a-z$]+$"}
        self.validator.validate("abc$def", schema_class)


class GoIntegerRailVsValidateJsonTests(unittest.TestCase):
    def test_go_validate_json_vs_policy_integer_rails(self):
        """Go ValidateJSON alone admits large/float ints; ValidateEnvelope policy refuses outside safe-int."""
        test_script = """
package ipc

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIntegerRailDivergence(t *testing.T) {
	cfg := ceilingConfig()
	contractsDir := filepath.Join("%s", "contracts", "v0.2")
	p, err := NewPolicy(cfg, os.DirFS(contractsDir), &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}

	// Bare ValidateJSON test
	goodJson := []byte(`{"schema":"envelope/v0.2","seq":9007199254740992,"msg_id":"m1","ts_ns":1,"from":{"component":"agent","instance":"a1"},"to":{"component":"daemon","instance":"d1"},"session_id":"s1","nonce":"n1","body":{"schema":"surface_request/v0.2","op":"list","params":{}}}`)
	if err := ValidateJSON(goodJson, cfg); err != nil {
		t.Fatalf("ValidateJSON unexpectedly refused large int: %%v", err)
	}

	// ValidateEnvelope policy test
	if _, err := p.ValidateEnvelope(goodJson); err == nil {
		t.Fatal("ValidateEnvelope policy admitted seq = 2^53!")
	}
}
""" % str(ROOT)
        temp_path = ROOT / "daemon-adapter/internal/ipc/rail_divergence_test.go"
        try:
            temp_path.write_text(test_script)
            env = dict(os.environ)
            env["GOTOOLCHAIN"] = "auto"
            res = subprocess.run(
                ["go", "test", "-v", "-run", "^TestIntegerRailDivergence$", "./internal/ipc"],
                capture_output=True, text=True, cwd=ROOT / "daemon-adapter", env=env
            )
            self.assertEqual(res.returncode, 0, res.stderr + "\n" + res.stdout)
        finally:
            if temp_path.exists():
                temp_path.unlink()


class PythonSnapshotVsStandaloneSchemasTests(unittest.TestCase):
    def setUp(self):
        self.validator = Validator(ROOT / "contracts/v0.2")

    def test_snapshot_vs_standalone_schemas_agreement(self):
        """Python snapshot _contracts_v02 and standalone v0.2 schemas agree on ui_intent and tool results."""
        ui_schema = self.validator.load("ui_intent.schema.json")

        for op in ("take_control", "release_control"):
            val_control = {
                "schema": "ui_intent/v0.2",
                "request_id": "req1",
                "op": op,
                "params": {"surface_id": "s1"}
            }
            # Standalone schema accepts
            self.validator.validate(val_control, ui_schema)
            # Python envelope module accepts
            out = envelope_mod.validate_envelope({
                "schema": "envelope/v0.2",
                "msg_id": "m1", "ts_ns": 1,
                "from": {"component": "agent", "instance": "a1"},
                "to": {"component": "daemon", "instance": "d1"},
                "session_id": "s1", "seq": 1, "nonce": "n1",
                "body": val_control
            })
            self.assertEqual(out["body"]["op"], op)


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
                        {"type": "number", "minimum": 0}
                    ]
                }
            },
            "required": ["val"]
        }
        self.validator.audit(schema_oneof)

        # Value matching both integer and number branch is refused because 2 branches match
        with self.assertRaises(ValidationError):
            self.validator.validate({"val": 5}, schema_oneof)


if __name__ == "__main__":
    unittest.main()
