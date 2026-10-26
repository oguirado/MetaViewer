"""Probe missing width bound (SW-0223 max_members) for 10k+ member objects."""

import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metaviewer_agents.envelope import EnvelopeError, loads_envelope


class WidthProbeTests(unittest.TestCase):
    def test_probe_10k_member_object_resource_usage(self):
        # Construct raw envelope json with an object having 10,000 distinct keys
        members_count = 10000
        big_body = {
            "schema": "action_proposal/v0.1",
            "proposal_id": "p-probe",
            "surface_id": "s-probe",
            "based_on_frame": {"sha256": "0" * 64, "generation": 1},
            "action": {"type": "click", "x": 0, "y": 0, "button": "left"},
            "expectation": {"type": "text_present", "text": "ok"},
            "budget": {"max_ms": 100, "max_retries": 0},
        }
        for i in range(members_count):
            big_body[f"extra_key_{i}"] = i

        env = {
            "schema": "envelope/v0.1",
            "msg_id": "m1",
            "ts_ns": 1,
            "from": {"component": "agent", "instance": "i1"},
            "to": {"component": "core", "instance": "i2"},
            "session_id": "s1",
            "seq": 1,
            "nonce": "a" * 32,
            "body": big_body,
        }
        raw = json.dumps(env).encode("utf-8") + b"\n"
        max_bytes = len(raw) + 1024

        t0 = time.perf_counter()
        # Expect loads_envelope to raise EnvelopeError("bad_shape") due to additionalProperties: False
        with self.assertRaises(EnvelopeError) as caught:
            loads_envelope(raw, max_bytes=max_bytes)
        t1 = time.perf_counter()

        elapsed_ms = (t1 - t0) * 1000
        self.assertEqual(caught.exception.code, "bad_shape")
        # Time to parse & validate 10k members
        print(f"\n[Probe Finding] 10k members validation time: {elapsed_ms:.2f} ms")


if __name__ == "__main__":
    unittest.main()
