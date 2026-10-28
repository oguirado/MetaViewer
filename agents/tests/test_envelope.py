"""Unit tests for v0.2 envelope discriminator taxonomy and schema parity."""

import copy
import json
from pathlib import Path
import sys
import unittest

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent.parent))

from metaviewer_agents.envelope import EnvelopeError, validate_envelope


class EnvelopeV02TaxonomyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        repo_root = _HERE.parents[2]
        cls.base_envelope = json.loads(
            (repo_root / "contracts/examples/v0.2/envelope.valid.json").read_text()
        )

    def assertEnvelopeCode(self, code: str, env: dict) -> EnvelopeError:
        with self.assertRaises(EnvelopeError) as ctx:
            validate_envelope(env)
        self.assertEqual(ctx.exception.code, code)
        return ctx.exception

    def test_valid_v02_envelope_accepted(self):
        env = copy.deepcopy(self.base_envelope)
        self.assertIs(validate_envelope(env), env)

    def test_known_family_foreign_version_refused_as_unknown_version(self):
        for tag in (
            "action_proposal/v9.9",
            "action_proposal/v0.1",
            "hello/v9.9",
            "mv_tool_result/v0.1",
        ):
            with self.subTest(tag=tag):
                env = copy.deepcopy(self.base_envelope)
                env["body"]["schema"] = tag
                self.assertEnvelopeCode("unknown_version", env)

    def test_unknown_family_and_malformed_tags_refused_as_bad_shape(self):
        for tag in (
            "unknown_family/v0.2",
            "unknown_family/v9.9",
            "surface_input/v0.2",
            "surface_input/v9.9",
            "action_proposal",
            "envelope/v9.9",
        ):
            with self.subTest(tag=tag):
                env = copy.deepcopy(self.base_envelope)
                env["body"]["schema"] = tag
                exc = self.assertEnvelopeCode("bad_shape", env)
                self.assertIn("malformed", str(exc))

    def test_surface_input_v02_envelope_body_refused_as_bad_shape(self):
        repo_root = _HERE.parents[2]
        surface_input_valid = json.loads(
            (repo_root / "contracts/examples/v0.2/surface_input.valid.json").read_text()
        )
        env = copy.deepcopy(self.base_envelope)
        env["body"] = surface_input_valid
        self.assertEnvelopeCode("bad_shape", env)

    def test_ui_intent_invalid_op_refused_as_bad_shape(self):
        env = copy.deepcopy(self.base_envelope)
        env["body"] = {
            "schema": "ui_intent/v0.2",
            "request_id": "req-1",
            "op": "unknown_layout_op",
            "params": {"slot_id": "surface-demo"},
        }
        self.assertEnvelopeCode("bad_shape", env)


if __name__ == "__main__":
    unittest.main()
