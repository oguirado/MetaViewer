"""Seeded NDJSON fuzz harness for loads_envelope and dumps_envelope."""

import json
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metaviewer_agents.envelope import (
    EnvelopeError,
    dumps_envelope,
    loads_envelope,
    make_envelope,
)

_MAX_BYTES = 4096


def _sample_proposal_body():
    return {
        "schema": "action_proposal/v0.1",
        "proposal_id": "p-fuzz-001",
        "surface_id": "s-fuzz-001",
        "based_on_frame": {
            "sha256": "0" * 64,
            "generation": 1,
        },
        "action": {
            "type": "click",
            "x": 10,
            "y": 20,
            "button": "left",
        },
        "expectation": {
            "type": "changed_region",
            "bbox": {"x": 0, "y": 0, "w": 50, "h": 50},
        },
        "budget": {
            "max_ms": 1000,
            "max_retries": 0,
        },
    }


def _valid_envelope():
    return make_envelope(
        msg_id="msg-fuzz-1",
        from_component="agent",
        from_instance="inst-1",
        to_component="core",
        to_instance="inst-core",
        session_id="sess-1",
        seq=1,
        body=_sample_proposal_body(),
        nonce="a" * 32,
        ts_ns=1000000000,
    )


class FuzzEnvelopeTests(unittest.TestCase):
    def setUp(self):
        self.valid_env = _valid_envelope()
        self.valid_bytes = dumps_envelope(self.valid_env, max_bytes=_MAX_BYTES)

    def test_roundtrip_valid_frames(self):
        loaded = loads_envelope(self.valid_bytes, max_bytes=_MAX_BYTES)
        self.assertEqual(loaded, self.valid_env)
        dumped_again = dumps_envelope(loaded, max_bytes=_MAX_BYTES)
        self.assertEqual(dumped_again, self.valid_bytes)

    def test_truncation_at_every_length(self):
        raw = self.valid_bytes
        for i in range(len(raw)):
            truncated = raw[:i]
            with self.assertRaises(EnvelopeError) as caught:
                loads_envelope(truncated, max_bytes=_MAX_BYTES)
            self.assertIn(caught.exception.code, ("bad_shape", "length"))

    def test_over_cap_refused_before_decode(self):
        raw_over = self.valid_bytes + b" "
        cap = len(self.valid_bytes) - 1
        with self.assertRaises(EnvelopeError) as caught:
            loads_envelope(raw_over, max_bytes=cap)
        self.assertEqual(caught.exception.code, "length")

        # Prove over-cap is refused even if payload is completely invalid JSON
        garbage_over = b"X" * (cap + 5) + b"\n"
        with self.assertRaises(EnvelopeError) as caught:
            loads_envelope(garbage_over, max_bytes=cap)
        self.assertEqual(caught.exception.code, "length")

    def test_blank_lines_and_lone_cr(self):
        blanks = [b"\n", b"\r\n", b"   \n", b"\t\n", b"\r"]
        for b in blanks:
            with self.subTest(blank=b):
                with self.assertRaises(EnvelopeError) as caught:
                    loads_envelope(b, max_bytes=_MAX_BYTES)
                self.assertEqual(caught.exception.code, "bad_shape")

    def test_duplicate_keys_refused(self):
        raw = b'{"schema":"envelope/v0.1","msg_id":"m1","msg_id":"m2"}\n'
        with self.assertRaises(EnvelopeError) as caught:
            loads_envelope(raw, max_bytes=_MAX_BYTES)
        self.assertEqual(caught.exception.code, "bad_shape")

    def test_nan_infinity_refused(self):
        bad_numbers = [
            b'{"seq": NaN}\n',
            b'{"seq": Infinity}\n',
            b'{"seq": -Infinity}\n',
        ]
        for raw in bad_numbers:
            with self.subTest(raw=raw):
                with self.assertRaises(EnvelopeError) as caught:
                    loads_envelope(raw, max_bytes=_MAX_BYTES)
                self.assertEqual(caught.exception.code, "bad_shape")

    def test_invalid_utf8_and_surrogates(self):
        bad_bytes = [
            b"\x80\x81\n",
            b"\xff\xfe\xfd\n",
            rb'{"msg_id": "\ud800"}' + b"\n",
        ]
        for raw in bad_bytes:
            with self.subTest(raw=raw):
                with self.assertRaises(EnvelopeError) as caught:
                    loads_envelope(raw, max_bytes=_MAX_BYTES)
                self.assertEqual(caught.exception.code, "bad_shape")

    def test_trailing_values_and_embedded_newlines(self):
        multiline = [
            self.valid_bytes[:-1] + b"\n" + self.valid_bytes,
            self.valid_bytes[:-1] + b"\r" + self.valid_bytes,
            b'{"a":1}{"b":2}\n',
        ]
        for raw in multiline:
            with self.subTest(raw=raw):
                with self.assertRaises(EnvelopeError) as caught:
                    loads_envelope(raw, max_bytes=_MAX_BYTES)
                self.assertEqual(caught.exception.code, "bad_shape")

    def test_seeded_random_mutation_fuzzing(self):
        rng = random.Random(42)
        base = self.valid_bytes
        for _ in range(500):
            mutated = bytearray(base)
            num_mutations = rng.randint(1, 5)
            for _ in range(num_mutations):
                pos = rng.randint(0, len(mutated) - 1)
                mutation_type = rng.choice(["flip", "delete", "insert", "replace"])
                if mutation_type == "flip":
                    mutated[pos] ^= rng.randint(1, 255)
                elif mutation_type == "delete":
                    del mutated[pos]
                elif mutation_type == "insert":
                    mutated.insert(pos, rng.randint(0, 255))
                elif mutation_type == "replace":
                    mutated[pos] = rng.randint(0, 255)

            raw = bytes(mutated)
            try:
                res = loads_envelope(raw, max_bytes=_MAX_BYTES)
                # If loads_envelope succeeded, it must equal a valid envelope and roundtrip
                self.assertIsInstance(res, dict)
                roundtrip = dumps_envelope(res, max_bytes=_MAX_BYTES)
                self.assertEqual(loads_envelope(roundtrip, max_bytes=_MAX_BYTES), res)
            except EnvelopeError as err:
                self.assertIn(err.code, ("bad_shape", "unknown_version", "length"))
            except Exception as exc:
                self.fail(f"Fuzzing raised unexpected exception {type(exc)}: {exc}")


if __name__ == "__main__":
    unittest.main()
