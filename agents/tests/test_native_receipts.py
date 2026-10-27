"""Native receipt fixtures and malformed evidence exercise the wire decoder."""

import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agents"))
sys.path.insert(0, str(ROOT))

from metaviewer_agents.envelope import EnvelopeError, loads_envelope
from tools.check_contracts import Validator, ValidationError

EXAMPLES = ROOT / "contracts/examples/v0.2"
LIMIT = 1 << 20


def decode(envelope):
    return loads_envelope((json.dumps(envelope) + "\n").encode(), max_bytes=LIMIT)


class NativeReceiptTests(unittest.TestCase):
    def setUp(self):
        self.envelope = json.loads(
            (EXAMPLES / "envelope.valid.native-receipt-click.json").read_text(encoding="utf-8"))
        self.oracle = Validator(ROOT / "contracts/v0.2")

    def test_native_fixtures_decode(self):
        for kind in ("click", "key", "text"):
            for pattern in ("action_receipt.valid.native-{}", "envelope.valid.native-receipt-{}"):
                filename = pattern.format(kind) + ".json"
                with self.subTest(fixture=filename):
                    value = json.loads((EXAMPLES / filename).read_text(encoding="utf-8"))
                    envelope = copy.deepcopy(self.envelope)
                    if "body" in value:
                        envelope = value
                    else:
                        envelope["body"] = value
                    self.assertEqual(decode(envelope), envelope)

    def test_optional_fields_and_boundaries(self):
        for evidence in (
            None,
            {"surface_id": "s", "input_mono_ns": 0, "input_ts_ns": 0},
            {"surface_id": "s" * 128, "native_surface_id": "n" * 128,
             "kind": "text", "result": "ok", "focus_verified": False,
             "input_mono_ns": (1 << 53) - 1, "input_ts_ns": (1 << 53) - 1},
        ):
            with self.subTest(evidence=evidence):
                envelope = copy.deepcopy(self.envelope)
                if evidence is None:
                    del envelope["body"]["native_evidence"]
                else:
                    envelope["body"]["native_evidence"] = evidence
                self.oracle.validate(envelope, self.oracle.load("envelope.schema.json"))
                self.assertEqual(decode(envelope), envelope)

    def assert_rejected(self, envelope):
        with self.assertRaises(ValidationError):
            self.oracle.validate(envelope, self.oracle.load("envelope.schema.json"))
        with self.assertRaises(EnvelopeError) as caught:
            decode(envelope)
        self.assertEqual(caught.exception.code, "bad_shape")

    def test_missing_required_fields(self):
        for field in ("surface_id", "input_mono_ns", "input_ts_ns"):
            with self.subTest(field=field):
                envelope = copy.deepcopy(self.envelope)
                del envelope["body"]["native_evidence"][field]
                self.assert_rejected(envelope)

    def test_invalid_values(self):
        cases = {
            "surface_id": ["", "s" * 129, 1, None],
            "native_surface_id": ["", "s" * 129, 1, None],
            "kind": ["scroll", "type", "x" * 129, 1, None],
            "result": ["error", "x" * 129, True, None],
            "focus_verified": [0, 1, "true", None],
            "input_mono_ns": [-1, 1 << 53, True, 1.5, "1", None],
            "input_ts_ns": [-1, 1 << 53, True, 1.5, "1", None],
        }
        for field, values in cases.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    envelope = copy.deepcopy(self.envelope)
                    envelope["body"]["native_evidence"][field] = value
                    self.assert_rejected(envelope)

    def test_extra_fields_and_nonobjects(self):
        for scope in ("receipt", "evidence"):
            envelope = copy.deepcopy(self.envelope)
            target = envelope["body"]
            if scope == "evidence":
                target = target["native_evidence"]
            target["unknown"] = True
            with self.subTest(scope=scope):
                self.assert_rejected(envelope)
        for value in (None, [], "evidence", 1, True):
            with self.subTest(value=value):
                envelope = copy.deepcopy(self.envelope)
                envelope["body"]["native_evidence"] = value
                self.assert_rejected(envelope)


if __name__ == "__main__":
    unittest.main()
