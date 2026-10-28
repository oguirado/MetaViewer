"""Synthetic overlapping-branch oneOf parity tests for envelope._check."""

from pathlib import Path
import sys
import unittest

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent.parent))

from metaviewer_agents.envelope import _Mismatch, _check


class OneOfOverlappingBranchesTests(unittest.TestCase):
    def setUp(self):
        self.schema = {
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["kind"],
                    "properties": {
                        "kind": {"type": "string", "enum": ["shared", "only_a"]},
                        "extra": {"type": "integer", "minimum": 1, "maximum": 10},
                    },
                },
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["kind"],
                    "properties": {
                        "kind": {"type": "string", "enum": ["shared", "only_b"]},
                        "extra": {"type": "integer", "minimum": 5, "maximum": 20},
                    },
                },
            ]
        }

    def test_single_match_admitted(self):
        self.assertIsNone(_check({"kind": "only_a", "extra": 3}, self.schema, 0))
        self.assertIsNone(_check({"kind": "shared", "extra": 15}, self.schema, 0))

    def test_double_match_refused(self):
        with self.assertRaises(_Mismatch) as ctx:
            _check({"kind": "shared", "extra": 7}, self.schema, 0)
        self.assertEqual(str(ctx.exception), "oneOf")

    def test_zero_match_refused(self):
        with self.assertRaises(_Mismatch) as ctx:
            _check({"kind": "neither", "extra": 7}, self.schema, 0)
        self.assertEqual(str(ctx.exception), "oneOf")


if __name__ == "__main__":
    unittest.main()
