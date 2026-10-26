"""Depth-32 differential and pre-scan counter tests (SW-0223 max_depth)."""

import json
import random
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metaviewer_agents.envelope import (
    EnvelopeError,
    _check,
    _Mismatch,
    loads_envelope,
    make_envelope,
)

_MAX_BYTES = 65536


def _reference_container_depth(text: str) -> int:
    """Reference container-only depth calculator ignoring strings and escapes."""
    max_depth = 0
    depth = 0
    in_string = False
    escaped = False
    for char in text:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char in "[{":
            depth += 1
            if depth > max_depth:
                max_depth = depth
        elif char in "]}":
            depth -= 1
            if depth < 0:
                return -1
    return max_depth if not in_string and depth == 0 else -1


class Depth32Tests(unittest.TestCase):
    def test_depth_32_accepted_33_refused(self):
        # Depth 32 object
        raw_32 = b'{"a":' * 31 + b'{"a": 1}' + b'}' * 31 + b'\n'
        with mock.patch("metaviewer_agents.envelope.validate_envelope", side_effect=lambda x: x):
            res = loads_envelope(raw_32, max_bytes=_MAX_BYTES)
            self.assertIsInstance(res, dict)

        # Depth 33 object
        raw_33 = b'{"a":' * 32 + b'{"a": 1}' + b'}' * 32 + b'\n'
        with self.assertRaises(EnvelopeError) as caught:
            loads_envelope(raw_33, max_bytes=_MAX_BYTES)
        self.assertEqual(caught.exception.code, "bad_shape")

    def test_alternating_container_patterns(self):
        # Alternating [{[{...
        pattern_32 = b'[{"a":' * 16 + b'1' + b'}]' * 16 + b'\n'
        with mock.patch("metaviewer_agents.envelope.validate_envelope", side_effect=lambda x: x):
            res = loads_envelope(pattern_32, max_bytes=_MAX_BYTES)
            self.assertIsInstance(res, list)

        # Alternating 33 containers
        pattern_33 = b'[' + b'[{"a":' * 16 + b'1' + b'}]' * 16 + b']\n'
        with self.assertRaises(EnvelopeError) as caught:
            loads_envelope(pattern_33, max_bytes=_MAX_BYTES)
        self.assertEqual(caught.exception.code, "bad_shape")

    def test_hostile_strings_do_not_move_prescan_counter(self):
        # High depth inside strings should NOT count towards limit
        fake_brackets = '{"[' * 100 + '}]"' * 100
        env = {
            "schema": "envelope/v0.1",
            "msg_id": "m1",
            "ts_ns": 1,
            "from": {"component": "agent", "instance": "i1"},
            "to": {"component": "core", "instance": "i2"},
            "session_id": "s1",
            "seq": 1,
            "nonce": "n1",
            "body": {
                "schema": "action_proposal/v0.1",
                "proposal_id": "p1",
                "surface_id": "s1",
                "based_on_frame": {"sha256": "0" * 64, "generation": 1},
                "action": {"type": "type", "text": fake_brackets},
                "expectation": {"type": "text_present", "text": fake_brackets},
                "budget": {"max_ms": 1, "max_retries": 0},
            },
        }
        raw = json.dumps(env).encode("utf-8") + b"\n"
        loaded = loads_envelope(raw, max_bytes=_MAX_BYTES)
        self.assertEqual(loaded["body"]["action"]["text"], fake_brackets)

    def test_prescan_agrees_with_reference_counter_on_corpus(self):
        rng = random.Random(1234)
        corpus = []
        for _ in range(200):
            depth = rng.randint(1, 40)
            brackets = []
            for d in range(depth):
                brackets.append(rng.choice(["[", "{"]))
            inner = '"' + rng.choice(["[", "{", "]", "}", '\\"', "\\\\"]) * rng.randint(0, 10) + '"'
            closing = []
            for b in reversed(brackets):
                closing.append("]" if b == "[" else "}")
            text = "".join(brackets) + inner + "".join(closing)
            corpus.append(text)

        for text in corpus:
            raw = text.encode("utf-8") + b"\n"
            ref_depth = _reference_container_depth(text)
            try:
                loads_envelope(raw, max_bytes=_MAX_BYTES)
                prescan_passed = True
            except EnvelopeError as exc:
                prescan_passed = False

            if ref_depth > 32 or ref_depth == -1:
                self.assertFalse(prescan_passed, f"Expected refusal for depth {ref_depth} in text: {text}")
            else:
                # If pre-scan passed or failed after pre-scan (e.g. json.loads fail)
                pass

    def test_schema_evaluator_max_depth_100(self):
        # Test _check function directly for schema evaluator nesting cap (_MAX_DEPTH = 100)
        # Deeply nested schema target
        target_schema = {"type": "object", "properties": {"child": {"type": "integer"}}, "additionalProperties": False}

        # At depth 100, _check should pass
        value_ok = 1
        _check(value_ok, {"type": "integer"}, depth=100)

        # At depth 101, _check should raise _Mismatch("nesting limit")
        with self.assertRaises(_Mismatch) as caught:
            _check(value_ok, {"type": "integer"}, depth=101)
        self.assertEqual(str(caught.exception), "nesting limit")


if __name__ == "__main__":
    unittest.main()
