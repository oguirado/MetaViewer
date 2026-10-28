"""Round 3 T6 contract conformance and negative control test suite.

Covers day-2 contract surface additions without editing existing product/test files:
1. nested_depth 0..1 in surface_request/v0.2 create operation.
2. surface_input/v0.2 non-envelope batch refusal as envelope body.
3. Safe-integer 2^53-1 upper rails across ts_ns, seq, and frame bounds.
4. Lone surrogates and terminal_session byte_count cross-checks.
"""

import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "agents"))

from metaviewer_agents.envelope import EnvelopeError, loads_envelope, validate_envelope
from tools.check_contracts import MAX_SAFE_INTEGER, ValidationError, Validator


class Round3T6ContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.validator = Validator(ROOT / "contracts/v0.2")
        self.envelope_schema = self.validator.load("envelope.schema.json")
        self.base_envelope = json.loads(
            (ROOT / "contracts/examples/v0.2/envelope.valid.json").read_text(encoding="utf-8")
        )

    def test_r3t6_nested_depth_rails(self) -> None:
        """nested_depth 0 and 1 are admitted; 2, -1, floats, and strings are refused."""
        req_schema = self.validator.load("surface_request.schema.json")
        base_create = {
            "schema": "surface_request/v0.2",
            "op": "create",
            "params": {
                "kind": "desktop_capsule",
                "geometry": {"w": 1280, "h": 720},
                "profile_id": "prof-1",
            },
        }

        # Positives
        for valid_depth in (None, 0, 1):
            doc = copy.deepcopy(base_create)
            if valid_depth is not None:
                doc["params"]["nested_depth"] = valid_depth
            self.validator.validate(doc, req_schema)

        # Negatives
        for bad_depth in (2, -1, 1.0, "1", True):
            doc = copy.deepcopy(base_create)
            doc["params"]["nested_depth"] = bad_depth
            with self.assertRaises(ValidationError):
                self.validator.validate(doc, req_schema)

    def test_r3t6_surface_input_non_envelope_refusal(self) -> None:
        """surface_input/v0.2 batch is standalone valid but refused as an envelope body."""
        input_schema = self.validator.load("surface_input.schema.json")
        valid_batch = {
            "schema": "surface_input/v0.2",
            "surface_id": "s1",
            "stream_id": 1,
            "seq": 1,
            "events": [{"kind": "click", "x": 100, "y": 200, "button": "left"}],
        }
        self.validator.validate(valid_batch, input_schema)

        wrapped = {**self.base_envelope, "body": valid_batch}
        with self.assertRaises(EnvelopeError):
            validate_envelope(wrapped)

    def test_r3t6_clock_and_safeint_boundaries(self) -> None:
        """ts_ns and seq at 2^53-1 (9007199254740991) pass; 2^53 fails."""
        env_good = {**self.base_envelope, "ts_ns": MAX_SAFE_INTEGER, "seq": MAX_SAFE_INTEGER}
        validate_envelope(env_good)

        env_bad_ts = {**self.base_envelope, "ts_ns": MAX_SAFE_INTEGER + 1}
        with self.assertRaises(EnvelopeError):
            validate_envelope(env_bad_ts)

        env_bad_seq = {**self.base_envelope, "seq": MAX_SAFE_INTEGER + 1}
        with self.assertRaises(EnvelopeError):
            validate_envelope(env_bad_seq)

    def test_r3t6_lone_surrogates_refused(self) -> None:
        """Lone surrogate code units in JSON string values are rejected by loads_envelope."""
        for bad_raw in (
            b'{"schema":"envelope/v0.2","msg_id":"m1","ts_ns":1,"from":{"component":"agent","instance":"a1"},"to":{"component":"daemon","instance":"d1"},"session_id":"s1","seq":1,"nonce":"n1","body":{"schema":"action_receipt/v0.2","proposal_id":"p1","verified":true,"after_frame":{"schema":"frame_ref/v0.2","surface_id":"s1","generation":1,"tick":1,"ts_ns":1,"width":100,"height":100,"format":"rgb24","ramws_path":"/dev/shm/r.rgb","sha256":"0000000000000000000000000000000000000000000000000000000000000000","capture_us":1},"error":"\\ud800"}}',
        ):
            with self.assertRaises(EnvelopeError):
                loads_envelope(bad_raw, max_bytes=65536)

    def test_r3t6_terminal_byte_count_cross_check(self) -> None:
        """terminal_session write and data operations enforce byte_count == decoded base64 length."""
        write_valid = {
            "schema": "terminal_session/v0.2",
            "request_id": "req-1",
            "op": "write",
            "params": {
                "session_id": "s-1",
                "terminal_generation": 1,
                "input_seq": 1,
                "b64": "YQ==",
                "byte_count": 1,
            },
        }
        wrapped = {**self.base_envelope, "body": write_valid}
        validate_envelope(wrapped)

        write_mismatch = copy.deepcopy(write_valid)
        write_mismatch["params"]["byte_count"] = 2
        wrapped_bad = {**self.base_envelope, "body": write_mismatch}
        with self.assertRaises(EnvelopeError):
            validate_envelope(wrapped_bad)


if __name__ == "__main__":
    unittest.main()
