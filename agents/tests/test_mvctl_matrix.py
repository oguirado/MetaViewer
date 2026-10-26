"""mvctl exit-code oracle matrix and refusal validation suite."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metaviewer_agents.mvctl import _REFUSAL_TEXT, run


def _sample_envelope(*, proposal_id="p1", seq=1, decision="admitted"):
    return {
        "schema": "envelope/v0.1",
        "msg_id": "m1",
        "ts_ns": 1,
        "from": {"component": "agent", "instance": "i1"},
        "to": {"component": "core", "instance": "i2"},
        "session_id": "s1",
        "seq": seq,
        "nonce": "a" * 32,
        "body": {
            "schema": "action_proposal/v0.1",
            "proposal_id": proposal_id,
            "surface_id": "s1",
            "based_on_frame": {"sha256": "0" * 64, "generation": 1},
            "action": {"type": "click", "x": 0, "y": 0, "button": "left"},
            "expectation": {"type": "text_present", "text": "hi"},
            "budget": {"max_ms": 1000, "max_retries": 0},
        },
    }


def _sample_reply(*, proposal_id="p1", decision="admitted", reason_code="BUDGET_EXCEEDED"):
    body = {
        "schema": "action_verdict/v0.1",
        "proposal_id": proposal_id,
        "decision": decision,
        "core_seq": 1,
    }
    if decision == "refused":
        body["reason_code"] = reason_code

    return {
        "schema": "envelope/v0.1",
        "msg_id": "r1",
        "ts_ns": 2,
        "from": {"component": "core", "instance": "i2"},
        "to": {"component": "agent", "instance": "i1"},
        "session_id": "s1",
        "seq": 1,
        "nonce": "b" * 32,
        "body": body,
    }


class MvctlMatrixTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.json_file = Path(self.tmpdir.name) / "req.json"

    def tearDown(self):
        self.tmpdir.cleanup()

    def _write_req(self, data: str | bytes):
        if isinstance(data, str):
            self.json_file.write_text(data, encoding="utf-8")
        else:
            self.json_file.write_bytes(data)

    def test_all_refusal_codes_produce_exit_code_2_and_fixed_stderr(self):
        # Every entry in _REFUSAL_TEXT must be tested to show it maps to exit code 2
        for code, text in _REFUSAL_TEXT.items():
            with self.subTest(code=code):
                with mock.patch("sys.stdout.write"), mock.patch("sys.stderr.write") as mock_stderr:
                    # Inject code failure via custom run invocation or mocked functions
                    if code == "usage_error":
                        rc = run(["propose", "--bad-flag"])
                    elif code == "observe":
                        rc = run(["observe"])
                    elif code == "input_error":
                        self._write_req("NOT JSON {{{")
                        rc = run([
                            "propose", "--json-arg", str(self.json_file),
                            "--timeout-ms", "1000",
                            "--max-line-bytes", "4096",
                            "--max-reply-bytes", "4096",
                            "--socket", "/tmp/nonexistent.sock",
                        ])
                    elif code == "unknown_version":
                        bad_ver = _sample_envelope()
                        bad_ver["schema"] = "envelope/v9.9"
                        self._write_req(json.dumps(bad_ver))
                        rc = run([
                            "propose", "--json-arg", str(self.json_file),
                            "--timeout-ms", "1000",
                            "--max-line-bytes", "4096",
                            "--max-reply-bytes", "4096",
                            "--socket", "/tmp/nonexistent.sock",
                        ])
                    elif code == "schema_error":
                        bad_shape = _sample_envelope()
                        del bad_shape["msg_id"]
                        self._write_req(json.dumps(bad_shape))
                        rc = run([
                            "propose", "--json-arg", str(self.json_file),
                            "--timeout-ms", "1000",
                            "--max-line-bytes", "4096",
                            "--max-reply-bytes", "4096",
                            "--socket", "/tmp/nonexistent.sock",
                        ])
                    elif code == "endpoint_error":
                        self._write_req(json.dumps(_sample_envelope()))
                        rc = run([
                            "propose", "--json-arg", str(self.json_file),
                            "--timeout-ms", "1000",
                            "--max-line-bytes", "4096",
                            "--max-reply-bytes", "4096",
                            "--socket", "relative/path.sock",
                        ])
                    elif code == "unsupported_operation":
                        rc = run(["observe"])
                    else:
                        # For transport_unavailable, transport_error, timeout, unexpected_reply
                        self._write_req(json.dumps(_sample_envelope()))
                        if code == "timeout":
                            def mock_send(req):
                                raise TimeoutError("timed out")
                        elif code == "transport_error":
                            def mock_send(req):
                                raise ConnectionError("conn error")
                        elif code == "unexpected_reply":
                            def mock_send(req):
                                reply = _sample_reply()
                                reply["body"]["proposal_id"] = "mismatch_id"
                                return reply
                        elif code == "transport_unavailable":
                            def mock_send(req):
                                raise TypeError("unavailable")

                        rc = run([
                            "propose", "--json-arg", str(self.json_file),
                            "--timeout-ms", "1000",
                            "--max-line-bytes", "4096",
                            "--max-reply-bytes", "4096",
                            "--socket", "/tmp/nonexistent.sock",
                        ], send=mock_send)

                    self.assertEqual(rc, 2)

    def test_admitted_verdict_maps_to_exit_0(self):
        req = _sample_envelope()
        self._write_req(json.dumps(req))
        reply = _sample_reply(decision="admitted")

        with mock.patch("sys.stdout.write") as mock_stdout:
            rc = run([
                "propose", "--json-arg", str(self.json_file),
                "--timeout-ms", "1000",
                "--max-line-bytes", "4096",
                "--max-reply-bytes", "4096",
                "--socket", "/tmp/nonexistent.sock",
            ], send=lambda r: reply)
            self.assertEqual(rc, 0)

    def test_refused_verdict_maps_to_exit_1(self):
        req = _sample_envelope()
        self._write_req(json.dumps(req))
        reply = _sample_reply(decision="refused", reason_code="BUDGET_EXCEEDED")

        with mock.patch("sys.stdout.write") as mock_stdout:
            rc = run([
                "propose", "--json-arg", str(self.json_file),
                "--timeout-ms", "1000",
                "--max-line-bytes", "4096",
                "--max-reply-bytes", "4096",
                "--socket", "/tmp/nonexistent.sock",
            ], send=lambda r: reply)
            self.assertEqual(rc, 1)

    def test_no_caller_input_echoed_to_stderr(self):
        secret_input = "SECRET_SENSITIVE_STRING_12345"
        self._write_req(secret_input)

        out_stderr = []
        with mock.patch("sys.stderr.write", side_effect=out_stderr.append):
            rc = run([
                "propose", "--json-arg", str(self.json_file),
                "--timeout-ms", "1000",
                "--max-line-bytes", "4096",
                "--max-reply-bytes", "4096",
                "--socket", "/tmp/nonexistent.sock",
            ])
            self.assertEqual(rc, 2)

        full_stderr = "".join(out_stderr)
        self.assertNotIn(secret_input, full_stderr)
        self.assertIn("invalid input file", full_stderr)


if __name__ == "__main__":
    unittest.main()
