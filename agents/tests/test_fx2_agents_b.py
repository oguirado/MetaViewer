"""Regression tests and negative controls for FX2-AGENTS-B round-2 findings."""

from __future__ import annotations

import contextlib
import copy
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest import mock

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent.parent))
for _candidate in list(_HERE.parents)[:6]:
    if (_candidate / "tools" / "check_contracts.py").is_file():
        sys.path.insert(0, str(_candidate))
        break

from metaviewer_agents import _contracts_v02, envelope
from metaviewer_agents.client import ClientError, CoreClient, ToolClient
from metaviewer_agents.envelope import (
    EnvelopeError,
    loads_envelope,
    make_envelope,
    validate_envelope,
)
from tools.check_contracts import ROOT as REPO_ROOT
from tools.check_contracts import ValidationError, Validator

_DIGEST = "a" * 64


def _registration(component: str) -> dict:
    return {
        "endpoint": {"component": component, "instance": component + "-1"},
        "hello": {
            "schema": "hello/v0.2",
            "contract_version": "v0.2",
            "component": component,
            "component_version": "0.1.2",
            "component_commit": "0123456789abcdef0123456789abcdef01234567",
            "dependencies": [],
        },
    }


def _frame_v02(**over) -> dict:
    frame = {
        "schema": "frame_ref/v0.2",
        "surface_id": "surf-1",
        "generation": 1,
        "tick": 0,
        "ts_ns": 100,
        "width": 8,
        "height": 8,
        "format": "rgb24",
        "ramws_path": "/dev/shm/mv-frame",
        "sha256": _DIGEST,
        "capture_us": 5,
    }
    frame.update(over)
    return frame


def _proposal_v02(**over) -> dict:
    body = {
        "schema": "action_proposal/v0.2",
        "proposal_id": "prop-1",
        "surface_id": "surf-1",
        "based_on_frame": {"sha256": _DIGEST, "generation": 1},
        "action": {"type": "type", "text": "hello"},
        "expectation": {"type": "text_present", "text": "done"},
        "budget": {"max_ms": 500, "max_retries": 1},
    }
    body.update(over)
    return body


def _wrap_v02(body: dict, **over) -> dict:
    args = {
        "msg_id": "msg-1",
        "from_component": "agent",
        "from_instance": "agent-1",
        "to_component": "core",
        "to_instance": "core-1",
        "session_id": "sess-1",
        "seq": 1,
        "ts_ns": 1,
        "body": body,
    }
    args.update(over)
    return make_envelope(**args)


class Fx2AgentsBTests(unittest.TestCase):
    @contextlib.contextmanager
    def _tool_core(self, replies=(), max_conns=1):
        with tempfile.TemporaryDirectory(prefix="mv-fx2-") as directory:
            root = Path(directory)
            root.chmod(0o700)
            sock_path = root / "core.sock"
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(str(sock_path))
                sock_path.chmod(0o600)
                listener.listen()
                listener.settimeout(2.0)
                stop = threading.Event()
                received = []

                def serve():
                    conns = 0
                    while not stop.is_set() and conns < max_conns:
                        try:
                            conn, _ = listener.accept()
                        except OSError:
                            break
                        conns += 1
                        with conn:
                            conn.settimeout(2.0)
                            with conn.makefile("rb") as reader:
                                line = reader.readline(65537)
                                if not line:
                                    continue
                                hello = json.loads(line)
                                received.append(hello)
                                reply = make_envelope(
                                    msg_id="hello-reply",
                                    from_component="core",
                                    from_instance="core-1",
                                    to_component="agent",
                                    to_instance="agent-1",
                                    session_id="sess-1",
                                    seq=1,
                                    ts_ns=1,
                                    body=_registration("core")["hello"],
                                )
                                conn.sendall((json.dumps(reply) + "\n").encode("utf-8"))
                                for idx, builder in enumerate(replies, start=2):
                                    req_line = reader.readline(65537)
                                    if not req_line:
                                        break
                                    req = json.loads(req_line)
                                    received.append(req)
                                    out = make_envelope(
                                        msg_id="reply-" + str(idx),
                                        from_component="core",
                                        from_instance="core-1",
                                        to_component="agent",
                                        to_instance="agent-1",
                                        session_id="sess-1",
                                        seq=idx,
                                        ts_ns=idx,
                                        body=builder(req["body"]),
                                    )
                                    conn.sendall((json.dumps(out) + "\n").encode("utf-8"))

                thread = threading.Thread(target=serve, daemon=True)
                thread.start()
                try:
                    yield sock_path, received
                finally:
                    stop.set()
                    thread.join(timeout=3.0)

    def _make_tool_client(self, sock_path: Path, seq_path: Path) -> ToolClient:
        return ToolClient(
            str(sock_path),
            session_id="sess-1",
            local=_registration("agent"),
            core=_registration("core"),
            dependency_pins=[],
            sequence_path=str(seq_path),
            timeout_s=2.0,
            max_line_bytes=65536,
            max_reply_bytes=65536,
        )

    def test_ag2_06_raw_snapshot_has_no_v01_consts_and_no_rewrite(self):
        def walk_v01(node):
            hits = []
            if isinstance(node, dict):
                for key, val in node.items():
                    if key == "const" and isinstance(val, str) and val.endswith("/v0.1"):
                        hits.append(val)
                    else:
                        hits.extend(walk_v01(val))
            elif isinstance(node, list):
                for item in node:
                    hits.extend(walk_v01(item))
            return hits

        self.assertEqual(walk_v01(_contracts_v02.FILES), [])
        probe = {"const": "observation/v0.1", "$ref": "frame_ref.schema.json"}
        envelope._version_refs(probe)
        self.assertEqual(probe["$ref"], "v0.2/frame_ref.schema.json")
        self.assertEqual(probe["const"], "observation/v0.1")

        # Negative control: valid v0.2 tool result passes; nested v0.1 is refused.
        good_result = {
            "schema": "mv_tool_result/v0.2",
            "request_id": "req-1",
            "op": "observe",
            "status": "ok",
            "observation": {
                "schema": "observation/v0.2",
                "frame_ref": _frame_v02(),
            },
        }
        env = _wrap_v02(good_result)
        self.assertIs(validate_envelope(env), env)
        bad_env = copy.deepcopy(env)
        bad_env["body"]["observation"]["schema"] = "observation/v0.1"
        with self.assertRaises(EnvelopeError) as ctx:
            validate_envelope(bad_env)
        self.assertEqual(ctx.exception.code, "bad_shape")

    def test_ag2_15_noncanonical_sequence_refused(self):
        with self._tool_core() as (sock_path, received):
            seq_path = sock_path.parent / "state.seq"
            for bad_raw in (b"01", b"0", b"00", b"007", b" 1", b"1\n"):
                seq_path.write_bytes(bad_raw)
                seq_path.chmod(0o600)
                client = self._make_tool_client(sock_path, seq_path)
                with self.subTest(raw=bad_raw):
                    with self.assertRaises(ClientError) as ctx:
                        with client:
                            pass
                    self.assertEqual(ctx.exception.code, "schema")
            self.assertEqual(received, [])

            # Negative control: canonical b"1" resumes cleanly at seq=1.
            seq_path.write_bytes(b"1")
            seq_path.chmod(0o600)
            with self._make_tool_client(sock_path, seq_path) as client:
                self.assertEqual(client.active.next_seq, 2)
            self.assertEqual(len(received), 1)
            self.assertEqual(received[0]["seq"], 1)

    def test_ag2_16_request_timeout_ms_bounded(self):
        reply_builder = lambda call: {
            "schema": "mv_tool_result/v0.2",
            "request_id": call["request_id"],
            "op": "list",
            "status": "ok",
            "surfaces": [],
            "next_cursor": None,
        }
        with self._tool_core(replies=[reply_builder]) as (sock_path, _):
            seq_path = sock_path.parent / "timeout.seq"
            with self._make_tool_client(sock_path, seq_path) as client:
                body = {
                    "schema": "mv_tool_call/v0.2",
                    "request_id": "req-1",
                    "op": "list",
                    "args": {"cursor": None, "limit": 1},
                }
                for bad_timeout in (60001, 10**400, 0, -1, True):
                    with self.subTest(timeout_ms=bad_timeout):
                        with self.assertRaises(ClientError) as ctx:
                            client.request(
                                body,
                                "mv_tool_result/v0.2",
                                timeout_ms=bad_timeout,
                            )
                        self.assertEqual(ctx.exception.code, "timeout")
                # Negative control: timeout_ms=100 proceeds and succeeds.
                res = client.request(
                    body, "mv_tool_result/v0.2", timeout_ms=100
                )
                self.assertEqual(res["status"], "ok")

    def test_ag2_17_missing_request_id_raises_typed_error_without_writes(self):
        reply_builder = lambda call: {
            "schema": "mv_tool_result/v0.2",
            "request_id": call["request_id"],
            "op": "list",
            "status": "ok",
            "surfaces": [],
            "next_cursor": None,
        }
        with self._tool_core(replies=[reply_builder]) as (sock_path, _):
            seq_path = sock_path.parent / "reqid.seq"
            with self._make_tool_client(sock_path, seq_path) as client:
                before_seq_bytes = seq_path.read_bytes()
                self.assertEqual(before_seq_bytes, b"2")
                for bad_body in (
                    {"schema": "mv_tool_call/v0.2", "op": "list", "args": {"cursor": None, "limit": 1}},
                    {"schema": "mv_tool_call/v0.2", "request_id": "", "op": "list", "args": {"cursor": None, "limit": 1}},
                    {"schema": "mv_tool_call/v0.2", "request_id": None, "op": "list", "args": {"cursor": None, "limit": 1}},
                    None,
                ):
                    with self.subTest(body=bad_body):
                        with self.assertRaises(ClientError) as ctx:
                            client.request(
                                bad_body, "mv_tool_result/v0.2", timeout_ms=100
                            )
                        self.assertEqual(ctx.exception.code, "bad_shape")
                        self.assertEqual(seq_path.read_bytes(), before_seq_bytes)

                # Negative control: valid body with request_id succeeds and advances sequence file.
                good_body = {
                    "schema": "mv_tool_call/v0.2",
                    "request_id": "req-ok",
                    "op": "list",
                    "args": {"cursor": None, "limit": 1},
                }
                res = client.request(
                    good_body, "mv_tool_result/v0.2", timeout_ms=100
                )
                self.assertEqual(res["request_id"], "req-ok")
                self.assertEqual(seq_path.read_bytes(), b"3")

    def test_ag2_18_core_client_huge_timeout_s_raises_client_error(self):
        with self.assertRaises(ClientError) as ctx:
            CoreClient(
                "/unused/core.sock",
                timeout_s=10**400,
                max_line_bytes=65536,
                max_reply_bytes=65536,
            )
        self.assertEqual(ctx.exception.code, "timeout")

        # Negative control: 1.5 accepted.
        client = CoreClient(
            "/unused/core.sock",
            timeout_s=1.5,
            max_line_bytes=65536,
            max_reply_bytes=65536,
        )
        self.addCleanup(client.close)
        self.assertEqual(client.next_seq, 1)

    def test_t6r2_003_ramws_path_crlf_refused(self):
        validator = Validator(REPO_ROOT / "contracts" / "v0.2")
        frame_schema = validator.load("frame_ref.schema.json")
        result_schema = validator.load("mv_tool_result.schema.json")
        self.assertEqual(
            frame_schema["properties"]["ramws_path"]["pattern"],
            "^/dev/shm(/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}){1,8}$",
        )
        self.assertEqual(
            result_schema["$defs"]["frame"]["properties"]["ramws_path"]["pattern"],
            "^/dev/shm(/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}){1,8}$",
        )
        for bad_path in (
            "/dev/shm/a\nb",
            "/dev/shm/a\rb",
            "/dev/shm/ab\n",
            "/dev/shm/ab\r",
            "/dev/shm/../etc/x",
            "/dev/shm/a//b",
            "/dev/shm/.x",
            "/dev/shm",
        ):
            with self.subTest(ramws_path=bad_path):
                bad_frame = _frame_v02(ramws_path=bad_path)
                with self.assertRaises(ValidationError):
                    validator.validate(bad_frame, frame_schema)
                env = _wrap_v02(_frame_v02())
                env["body"] = bad_frame
                with self.assertRaises(EnvelopeError) as ctx:
                    validate_envelope(env)
                self.assertEqual(ctx.exception.code, "bad_shape")

        # Negative control: clean path admitted.
        for good_path in (
            "/dev/shm/clean-frame",
            "/dev/shm/ramws/demo.rgb",
            "/dev/shm/mv-adapter-1/frames-123456/0123456789abcdef0123456789abcdef.rgb",
        ):
            clean_frame = _frame_v02(ramws_path=good_path)
            validator.validate(clean_frame, frame_schema)
            clean_env = _wrap_v02(clean_frame)
            self.assertIs(validate_envelope(clean_env), clean_env)

    def test_t6r2_004_sha256_trailing_lf_refused(self):
        env = _wrap_v02(_frame_v02())
        env["body"]["sha256"] = _DIGEST + "\n"
        with self.assertRaises(EnvelopeError) as ctx:
            validate_envelope(env)
        self.assertEqual(ctx.exception.code, "bad_shape")

        # Negative control: exact 64-hex admitted.
        good = _wrap_v02(_frame_v02(sha256=_DIGEST))
        self.assertIs(validate_envelope(good), good)

    def test_t6r2_005_utf8_byte_ceiling_enforced(self):
        validator = Validator(REPO_ROOT / "contracts" / "v0.2")
        proposal_schema = validator.load("action_proposal.schema.json")
        over_bytes = "é" * 32769  # 32769 chars, 65538 UTF-8 bytes
        self.assertEqual(len(over_bytes), 32769)
        self.assertEqual(len(over_bytes.encode("utf-8")), 65538)

        bad_proposal = _proposal_v02(action={"type": "type", "text": over_bytes})
        with self.assertRaises(ValidationError):
            validator.validate(bad_proposal, proposal_schema)
        env = _wrap_v02(_proposal_v02())
        env["body"] = bad_proposal
        with self.assertRaises(EnvelopeError) as ctx:
            validate_envelope(env)
        self.assertEqual(ctx.exception.code, "bad_shape")

        # Negative control: 65536-byte ASCII admitted by both.
        max_ascii = "a" * 65536
        good_proposal = _proposal_v02(action={"type": "type", "text": max_ascii})
        validator.validate(good_proposal, proposal_schema)
        good_env = _wrap_v02(good_proposal)
        self.assertIs(validate_envelope(good_env), good_env)

    def test_t6r2_008_make_envelope_session_relative_clock_past_safe_int(self):
        base = 1 << 53
        with mock.patch("metaviewer_agents.envelope.time.monotonic_ns", side_effect=[base, base + 125]):
            first = make_envelope(
                msg_id="m1",
                from_component="agent",
                from_instance="agent-1",
                to_component="core",
                to_instance="core-1",
                session_id="sess-1",
                seq=1,
                body=_proposal_v02(),
            )
            second = make_envelope(
                msg_id="m2",
                from_component="agent",
                from_instance="agent-1",
                to_component="core",
                to_instance="core-1",
                session_id="sess-1",
                seq=2,
                body=_proposal_v02(),
            )
        self.assertEqual(first["ts_ns"], 0)
        self.assertEqual(second["ts_ns"], 125)

        # Negative control: explicit huge ts_ns still refused.
        with self.assertRaises(EnvelopeError) as ctx:
            make_envelope(
                msg_id="m-bad",
                from_component="agent",
                from_instance="agent-1",
                to_component="core",
                to_instance="core-1",
                session_id="sess-1",
                seq=1,
                ts_ns=base,
                body=_proposal_v02(),
            )
        self.assertEqual(ctx.exception.code, "bad_shape")

    def test_t6r2_006_lone_surrogate_refused(self):
        receipt_body = json.loads(
            (REPO_ROOT / "contracts" / "examples" / "v0.2" / "action_receipt.valid.json").read_text(encoding="utf-8")
        )
        env = _wrap_v02(receipt_body)
        for bad_err in ("x\ud800y", "\ud800", "\udfff"):
            bad_env = copy.deepcopy(env)
            bad_env["body"]["error"] = bad_err
            with self.subTest(error=repr(bad_err)):
                with self.assertRaises(EnvelopeError) as ctx:
                    validate_envelope(bad_env)
                self.assertEqual(ctx.exception.code, "bad_shape")
        raw_line = (
            json.dumps(env, separators=(",", ":")).replace('"error":""', '"error":"x\\ud800y"') + "\n"
        ).encode("utf-8")
        with self.assertRaises(EnvelopeError) as ctx:
            loads_envelope(raw_line, max_bytes=65536)
        self.assertEqual(ctx.exception.code, "bad_shape")

        # Negative control: accented UTF-8 and valid astral surrogate pair admitted.
        for good_literal in ('"é"', '"\\ud83d\\ude00"'):
            good_line = (
                json.dumps(env, separators=(",", ":")).replace('"error":""', '"error":' + good_literal) + "\n"
            ).encode("utf-8")
            decoded = loads_envelope(good_line, max_bytes=65536)
            self.assertIs(validate_envelope(decoded), decoded)

    def test_t6r2_007_terminal_byte_count_cross_check(self):
        for bad_body in (
            {
                "schema": "terminal_session/v0.2",
                "request_id": "req-1",
                "op": "write",
                "params": {
                    "session_id": "s-1",
                    "terminal_generation": 1,
                    "input_seq": 1,
                    "b64": "YQ==",
                    "byte_count": 2,
                },
            },
            {
                "schema": "terminal_session/v0.2",
                "request_id": "req-1",
                "op": "write",
                "params": {
                    "session_id": "s-1",
                    "terminal_generation": 1,
                    "input_seq": 1,
                    "b64": "YQ==",
                    "byte_count": 0,
                },
            },
            {
                "schema": "terminal_session/v0.2",
                "request_id": "req-1",
                "op": "data",
                "params": {
                    "session_id": "s-1",
                    "terminal_generation": 1,
                    "seq": 1,
                    "b64": "YQ==",
                    "byte_count": 2,
                    "truncated": False,
                    "gap": False,
                },
            },
        ):
            env = _wrap_v02(_proposal_v02())
            env["body"] = bad_body
            with self.subTest(op=bad_body["op"], byte_count=bad_body["params"]["byte_count"]):
                with self.assertRaises(EnvelopeError) as ctx:
                    validate_envelope(env)
                self.assertEqual(ctx.exception.code, "bad_shape")

        # Negative controls: matching decoded byte counts admitted for write and data.
        for good_body in (
            {
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
            },
            {
                "schema": "terminal_session/v0.2",
                "request_id": "req-1",
                "op": "data",
                "params": {
                    "session_id": "s-1",
                    "terminal_generation": 1,
                    "seq": 1,
                    "b64": "YQ==",
                    "byte_count": 1,
                    "truncated": False,
                    "gap": False,
                },
            },
        ):
            good_env = _wrap_v02(good_body)
            self.assertIs(validate_envelope(good_env), good_env)


if __name__ == "__main__":
    unittest.main()
