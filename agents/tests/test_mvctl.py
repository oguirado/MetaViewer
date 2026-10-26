"""Unit tests for the mvctl command skeleton (standard library only)."""

import contextlib
import copy
import io
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import metaviewer_agents
from metaviewer_agents import mvctl

_DIGEST = "0123456789abcdef" * 4
_CANARY = "MVCTL-CANARY-7f3a9c21-never-echo"
_MISSING = object()
_FIXED_TEXT = {
    "usage_error": "invalid command line",
    "input_error": "invalid input file",
    "schema_error": "schema validation failed",
    "unknown_version": "unknown contract version",
    "endpoint_error": "invalid endpoint",
    "transport_unavailable": "transport unavailable",
    "transport_error": "transport error",
    "timeout": "request timed out",
    "unexpected_reply": "unexpected reply",
    "unsupported_operation": "unsupported operation",
}
_REASONS = (
    "STALE_FRAME",
    "SURFACE_NOT_AGENT_CONTROLLED",
    "LOCKED_BY_OTHER",
    "BUDGET_EXCEEDED",
    "OUT_OF_BOUNDS",
    "POLICY",
)


def _proposal_body(**over):
    body = {
        "schema": "action_proposal/v0.1",
        "proposal_id": "p-1",
        "surface_id": "surf-1",
        "based_on_frame": {"sha256": _DIGEST, "generation": 3},
        "action": {"type": "click", "x": 4, "y": 5, "button": "left"},
        "expectation": {"type": "text_present", "text": "done"},
        "budget": {"max_ms": 500, "max_retries": 1},
    }
    body.update(over)
    return body


def _request_envelope(**over):
    envelope = {
        "schema": "envelope/v0.1",
        "msg_id": "m-1",
        "ts_ns": 42,
        "from": {"component": "agent", "instance": "agent-1"},
        "to": {"component": "core", "instance": "core-1"},
        "session_id": "sess-1",
        "seq": 1,
        "nonce": "n-1",
        "body": _proposal_body(),
    }
    envelope.update(over)
    return envelope


def _verdict_body(decision="admitted", **over):
    body = {
        "schema": "action_verdict/v0.1",
        "proposal_id": "p-1",
        "decision": decision,
        "core_seq": 7,
    }
    if decision == "refused":
        body["reason_code"] = "POLICY"
    body.update(over)
    return body


def _reply_envelope(body=None, **over):
    envelope = {
        "schema": "envelope/v0.1",
        "msg_id": "m-9",
        "ts_ns": 77,
        "from": {"component": "core", "instance": "core-1"},
        "to": {"component": "agent", "instance": "agent-1"},
        "session_id": "sess-1",
        "seq": 9,
        "nonce": "n-9",
        "body": body if body is not None else _verdict_body(),
    }
    envelope.update(over)
    return envelope


def _observation_body():
    return {
        "schema": "observation/v0.1",
        "frame_ref": {
            "schema": "frame_ref/v0.1",
            "surface_id": "surf-1",
            "generation": 2,
            "tick": 11,
            "ts_ns": 55,
            "width": 8,
            "height": 8,
            "format": "rgb24",
            "ramws_path": "/dev/shm/mv-test-frame",
            "sha256": _DIGEST,
            "capture_us": 9,
        },
    }


class _FakeSend:
    """Injected transport double recording every envelope it receives."""

    def __init__(self, reply=None, error=None):
        self.calls = []
        self.reply = _reply_envelope() if reply is None else reply
        self.error = error

    def __call__(self, envelope):
        self.calls.append(envelope)
        if self.error is not None:
            raise self.error
        return copy.deepcopy(self.reply)


class _FakeClientError(Exception):
    def __init__(self, code, message="fake client failure"):
        super().__init__(message)
        self.code = code


def _install_fake_client(test, *, next_seq=1, reply=None, call_error=None,
                         enter_error=None, init_error=None):
    """Point metaviewer_agents.client at a recording fake; restore after."""
    created = []

    class FakeCoreClient:
        def __init__(self, socket_path, *, timeout_s, max_line_bytes,
                     max_reply_bytes):
            if init_error is not None:
                raise init_error
            self.socket_path = socket_path
            self.timeout_s = timeout_s
            self.max_line_bytes = max_line_bytes
            self.max_reply_bytes = max_reply_bytes
            self.calls = []
            self.closed = False
            created.append(self)

        @property
        def next_seq(self):
            return next_seq

        def __enter__(self):
            if enter_error is not None:
                raise enter_error
            return self

        def __exit__(self, exc_type, exc, tb):
            self.closed = True
            return None

        def call(self, envelope):
            self.calls.append(envelope)
            if call_error is not None:
                raise call_error
            return copy.deepcopy(reply)

        def close(self):
            self.closed = True

    module = types.ModuleType("metaviewer_agents.client")
    module.CoreClient = FakeCoreClient
    module.ClientError = _FakeClientError
    key = "metaviewer_agents.client"
    saved = sys.modules.get(key, _MISSING)
    sys.modules[key] = module

    def restore():
        if saved is _MISSING:
            sys.modules.pop(key, None)
        else:
            sys.modules[key] = saved

    test.addCleanup(restore)
    return created


def _hide_module(test, name):
    """Make an exact sibling import fail; restore afterwards."""
    saved = sys.modules.get(name, _MISSING)
    sys.modules[name] = None

    def restore():
        if saved is _MISSING:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = saved

    test.addCleanup(restore)


class MvctlTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._sock = os.path.join(self._tmp.name, "core.sock")
        self._serial = 0
        patcher = mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": self._tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _write(self, data):
        self._serial += 1
        path = os.path.join(self._tmp.name, "input-%d.json" % (self._serial,))
        with open(path, "wb") as handle:
            handle.write(data)
        return path

    def _propose(self, path, *, timeout="500", line="16384", reply="16384",
                 socket="default"):
        argv = ["propose", "--json-arg", path, "--timeout-ms", timeout,
               "--max-line-bytes", line, "--max-reply-bytes", reply]
        if socket == "default":
            argv += ["--socket", self._sock]
        elif socket is not None:
            argv += ["--socket", socket]
        return argv

    def _run(self, argv, send=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            if send is None:
                code = mvctl.run(list(argv))
            else:
                code = mvctl.run(list(argv), send)
        return code, out.getvalue(), err.getvalue()

    def _main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = mvctl.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def _assert_refusal(self, err, code):
        self.assertEqual(err.count("\n"), 1, err)
        record = json.loads(err)
        self.assertEqual(record["verdict"], "refuse")
        self.assertEqual(record["code"], code)
        self.assertEqual(record["error"], _FIXED_TEXT[code])
        self.assertEqual(set(record), {"verdict", "code", "error"})
        self.assertNotIn(_CANARY, err)
        return record

    def _assert_valid_envelope_file(self, envelope):
        data = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
        return self._write(data), data

    def test_help_and_closed_argv(self):
        send = _FakeSend()
        code, out, err = self._run(["--help"], send)
        self.assertEqual(code, 0)
        self.assertIn("propose", out)
        self.assertIn("observe", out)
        self.assertEqual(err, "")
        self.assertEqual(send.calls, [])
        code, out, err = self._main(["--help"])
        self.assertEqual(code, 0)
        self.assertIn("propose", out)
        self.assertEqual(err, "")
        missing = os.path.join(self._tmp.name, "missing.json")
        full = self._propose(missing)
        cases = [
            [],
            ["list"],
            ["wait-verify"],
            ["mcp"],
            ["foo"],
            ["propose"],
            full + ["--unknown", "x"],
            full + ["extra-positional"],
            ["propose", "--json-arg", missing, "--timeout-ms", "500",
             "--max-line-bytes", "16384", "--max-reply-bytes", "16384",
             "--socket", self._sock, "--timeout-ms", "600"],
            ["propose", "--json-arg", missing, "--time", "5",
             "--max-line-bytes", "16384", "--max-reply-bytes", "16384"],
            ["propose", "--json-arg"],
            ["--socket", self._sock, "propose"],
            ["--token", "abc"],
            ["propose", "--token", "abc"],
            full + ["--token", "abc"],
            full + ["--profile-content", "abc"],
            ["observe", "--socket", self._sock],
            ["observe", "extra"],
        ]
        for argv in cases:
            with self.subTest(argv=argv):
                probe = _FakeSend()
                code, out, err = self._run(argv, probe)
                self.assertEqual(code, 2, argv)
                self.assertEqual(out, "")
                self._assert_refusal(err, "usage_error")
                self.assertEqual(probe.calls, [])

    def test_transport_parameters(self):
        envelope = _request_envelope()
        path, _ = self._assert_valid_envelope_file(envelope)
        send = _FakeSend()
        code, out, err = self._run(self._propose(path), send)
        self.assertEqual(code, 0)
        self.assertEqual(len(send.calls), 1)
        via_default = _FakeSend()
        code, out, err = self._run(self._propose(path, socket=None), via_default)
        self.assertEqual(code, 0, err)
        self.assertEqual(len(via_default.calls), 1)
        self.assertEqual(err, "")
        bad_numbers = ["0", "-1", "01", "1.5", "True", "", "1" * 11, "9" * 5000]
        flags = ["--timeout-ms", "--max-line-bytes", "--max-reply-bytes"]
        for flag in flags:
            for bad in bad_numbers:
                with self.subTest(flag=flag, bad=bad[:12]):
                    argv = self._propose(path)
                    argv[argv.index(flag) + 1] = bad
                    probe = _FakeSend()
                    code, out, err = self._run(argv, probe)
                    self.assertEqual(code, 2)
                    self.assertEqual(out, "")
                    self._assert_refusal(err, "usage_error")
                    self.assertEqual(probe.calls, [])
        for drop in ("--json-arg", "--timeout-ms", "--max-line-bytes",
                     "--max-reply-bytes"):
            with self.subTest(drop=drop):
                argv = self._propose(path)
                pos = argv.index(drop)
                del argv[pos:pos + 2]
                probe = _FakeSend()
                code, out, err = self._run(argv, probe)
                self.assertEqual(code, 2)
                self.assertEqual(out, "")
                self._assert_refusal(err, "usage_error")
                self.assertEqual(probe.calls, [])
        with mock.patch.dict(os.environ):
            os.environ.pop("XDG_RUNTIME_DIR", None)
            probe = _FakeSend()
            code, out, err = self._run(self._propose(path, socket=None), probe)
            self.assertEqual(code, 2)
            self.assertEqual(out, "")
            self._assert_refusal(err, "endpoint_error")
            self.assertEqual(probe.calls, [])
        with mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": ""}):
            probe = _FakeSend()
            code, out, err = self._run(self._propose(path, socket=None), probe)
            self.assertEqual(code, 2)
            self._assert_refusal(err, "endpoint_error")
            self.assertEqual(probe.calls, [])
        for bad_socket in ["rel/path.sock", ""]:
            with self.subTest(socket=bad_socket):
                probe = _FakeSend()
                code, out, err = self._run(
                    self._propose(path, socket=bad_socket), probe)
                self.assertEqual(code, 2)
                self.assertEqual(out, "")
                self._assert_refusal(err, "usage_error")
                self.assertEqual(probe.calls, [])

    def test_strict_bounded_input(self):
        envelope = _request_envelope()
        base = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
        cap = len(base) + 64
        path = self._write(base + b" " * 64)
        send = _FakeSend()
        code, out, err = self._run(
            self._propose(path, line=str(cap)), send)
        self.assertEqual(code, 0, err)
        self.assertEqual(len(send.calls), 1)
        self.assertEqual(send.calls[0], envelope)
        oversize = base + b" " * 65
        probe = _FakeSend()
        code, out, err = self._run(
            self._propose(self._write(oversize),
                           line=str(len(oversize) - 1)), probe)
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self._assert_refusal(err, "input_error")
        self.assertEqual(probe.calls, [])
        bad_inputs = [
            base[:-10] + b"\xff\xfe",
            base + b"{}",
            base + b" 5",
            b'{"schema": "envelope/v0.1", "schema": "x"}',
            b'{"a": {"b": 1, "b": 2}}',
            b'{"a": NaN}',
            b'{"a": Infinity}',
            b'{"a": -Infinity}',
            b'{"a": 1e999}',
            b'5',
            b'"x"',
            b'[1]',
            b'null',
            b'',
            b'   ',
            json.dumps(_proposal_body(), separators=(",", ":")).encode("utf-8"),
        ]
        for raw in bad_inputs:
            with self.subTest(raw=raw[:24]):
                probe = _FakeSend()
                code, out, err = self._run(
                    self._propose(self._write(raw)), probe)
                self.assertEqual(code, 2, raw[:24])
                self.assertEqual(out, "")
                self._assert_refusal(err, "input_error")
                self.assertEqual(probe.calls, [])

    def _mutate_request(self, mutate):
        envelope = _request_envelope()
        mutate(envelope)
        return self._write(
            json.dumps(envelope, separators=(",", ":")).encode("utf-8"))

    def test_full_request_validation(self):
        envelope = _request_envelope()
        path, raw = self._assert_valid_envelope_file(envelope)
        send = _FakeSend()
        code, out, err = self._run(self._propose(path), send)
        self.assertEqual(code, 0, err)
        self.assertEqual(len(send.calls), 1)
        self.assertEqual(send.calls[0], json.loads(raw.decode("utf-8")))

        def drop_instance(env):
            del env["from"]["instance"]

        def extra_nested(env):
            env["body"]["budget"]["extra"] = 1

        def bool_seq(env):
            env["seq"] = True

        def float_seq(env):
            env["seq"] = 1.5

        def bad_digest(env):
            env["body"]["based_on_frame"]["sha256"] = "Z" * 64

        def short_digest(env):
            env["body"]["based_on_frame"]["sha256"] = "abc"

        def zero_generation(env):
            env["body"]["based_on_frame"]["generation"] = 0

        def bad_action(env):
            env["body"]["action"] = {"type": "click", "x": 1}

        def drop_proposal(env):
            del env["body"]["proposal_id"]

        def drop_msg(env):
            del env["msg_id"]

        def swap_endpoints(env):
            env["from"], env["to"] = env["to"], env["from"]

        def wrong_direction(env):
            env["from"] = {"component": "core", "instance": "core-1"}
            env["to"] = {"component": "agent", "instance": "agent-1"}

        def observation_body(env):
            env["body"] = _observation_body()

        def missing_schema(env):
            del env["schema"]

        def numeric_schema(env):
            env["schema"] = 5

        cases = [drop_instance, extra_nested, bool_seq, float_seq, bad_digest,
                 short_digest, zero_generation, bad_action, drop_proposal,
                 drop_msg, swap_endpoints, wrong_direction, observation_body,
                 missing_schema, numeric_schema]
        for mutate in cases:
            with self.subTest(case=mutate.__name__):
                probe = _FakeSend()
                code, out, err = self._run(
                    self._propose(self._mutate_request(mutate)), probe)
                self.assertEqual(code, 2, mutate.__name__)
                self.assertEqual(out, "")
                self._assert_refusal(err, "schema_error")
                self.assertEqual(probe.calls, [])

    def test_unknown_version(self):
        path, _ = self._assert_valid_envelope_file(_request_envelope())

        def outer_request(env):
            env["schema"] = "envelope/v9.9"

        def body_request(env):
            env["body"]["schema"] = "action_proposal/v9.9"

        def foreign_body_request(env):
            env["body"]["schema"] = "surface/v9.9"

        for mutate in (outer_request, body_request, foreign_body_request):
            with self.subTest(case=mutate.__name__):
                probe = _FakeSend()
                code, out, err = self._run(
                    self._propose(self._mutate_request(mutate)), probe)
                self.assertEqual(code, 2)
                self.assertEqual(out, "")
                self._assert_refusal(err, "unknown_version")
                self.assertEqual(probe.calls, [])
        reply = _reply_envelope()
        reply["schema"] = "envelope/v9.9"
        probe = _FakeSend(reply=reply)
        code, out, err = self._run(self._propose(path), probe)
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self._assert_refusal(err, "unknown_version")
        self.assertEqual(len(probe.calls), 1)
        reply = _reply_envelope(_verdict_body())
        reply["body"]["schema"] = "action_verdict/v9.9"
        probe = _FakeSend(reply=reply)
        code, out, err = self._run(self._propose(path), probe)
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self._assert_refusal(err, "unknown_version")
        self.assertEqual(len(probe.calls), 1)
        reply = _reply_envelope(_observation_body())
        reply["body"]["schema"] = "observation/v9.9"
        probe = _FakeSend(reply=reply)
        code, out, err = self._run(self._propose(path), probe)
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self._assert_refusal(err, "unknown_version")
        self.assertEqual(len(probe.calls), 1)
        reply = _reply_envelope()
        reply["future"] = 1
        probe = _FakeSend(reply=reply)
        code, out, err = self._run(self._propose(path), probe)
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self._assert_refusal(err, "schema_error")
        self.assertEqual(len(probe.calls), 1)

    def test_admitted_and_each_refusal(self):
        path, _ = self._assert_valid_envelope_file(_request_envelope())
        admitted = _reply_envelope()
        send = _FakeSend(reply=admitted)
        code, out, err = self._run(self._propose(path), send)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), admitted)
        self.assertEqual(out.count("\n"), 1)
        self.assertEqual(err, "")
        self.assertEqual(len(send.calls), 1)
        for reason in _REASONS:
            with self.subTest(reason=reason):
                refused = _reply_envelope(
                    _verdict_body("refused", reason_code=reason, core_seq=11))
                probe = _FakeSend(reply=refused)
                code, out, err = self._run(self._propose(path), probe)
                self.assertEqual(code, 1)
                shown = json.loads(out)
                self.assertEqual(shown["body"]["reason_code"], reason)
                self.assertEqual(shown["body"]["core_seq"], 11)
                self.assertEqual(shown, refused)
                self.assertEqual(out.count("\n"), 1)
                self.assertEqual(err, "")

        def missing_reason(body):
            del body["reason_code"]

        def admitted_with_reason(body):
            body["decision"] = "admitted"
            body["reason_code"] = "POLICY"

        def missing_proposal(body):
            del body["proposal_id"]

        def zero_core_seq(body):
            body["core_seq"] = 0

        def unknown_reason(body):
            body["reason_code"] = "MADE_UP"

        def extra_member(body):
            body["extra"] = 1

        for mutate in (missing_reason, admitted_with_reason, missing_proposal,
                       zero_core_seq, unknown_reason, extra_member):
            with self.subTest(case=mutate.__name__):
                body = _verdict_body("refused")
                mutate(body)
                probe = _FakeSend(reply=_reply_envelope(body))
                code, out, err = self._run(self._propose(path), probe)
                self.assertEqual(code, 2, mutate.__name__)
                self.assertEqual(out, "")
                self._assert_refusal(err, "schema_error")

    def test_reply_identity(self):
        path, _ = self._assert_valid_envelope_file(_request_envelope())
        send = _FakeSend()
        code, out, err = self._run(self._propose(path), send)
        self.assertEqual(code, 0, err)

        def other_from(env):
            env["from"]["instance"] = "core-2"

        def other_to(env):
            env["to"]["instance"] = "agent-2"

        def other_session(env):
            env["session_id"] = "other"

        def other_proposal(env):
            env["body"]["proposal_id"] = "p-9"

        def flipped(env):
            env["from"] = {"component": "agent", "instance": "agent-1"}
            env["to"] = {"component": "core", "instance": "core-1"}

        def observation(env):
            env["body"] = _observation_body()

        def proposal(env):
            env["body"] = _proposal_body()

        for mutate in (other_from, other_to, other_session, other_proposal,
                       flipped, observation, proposal):
            with self.subTest(case=mutate.__name__):
                reply = _reply_envelope()
                mutate(reply)
                probe = _FakeSend(reply=reply)
                code, out, err = self._run(self._propose(path), probe)
                self.assertEqual(code, 2, mutate.__name__)
                self.assertEqual(out, "")
                self._assert_refusal(err, "unexpected_reply")
                self.assertEqual(len(probe.calls), 1)
        probe = _FakeSend(reply="not-a-dict")
        code, out, err = self._run(self._propose(path), probe)
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self._assert_refusal(err, "schema_error")

    def test_timeout_and_cleanup(self):
        path, _ = self._assert_valid_envelope_file(_request_envelope())
        admitted = _reply_envelope()
        created = _install_fake_client(self, reply=admitted)
        code, out, err = self._run(self._propose(path))
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out), admitted)
        self.assertEqual(len(created), 1)
        client = created[0]
        self.assertTrue(client.closed)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(client.socket_path, self._sock)
        self.assertEqual(client.timeout_s, 0.5)
        self.assertEqual(client.max_line_bytes, 16384)
        self.assertEqual(client.max_reply_bytes, 16384)
        failures = [
            (TimeoutError("silent"), "timeout"),
            (_FakeClientError("timeout"), "timeout"),
            (_FakeClientError("socket"), "transport_error"),
            (_FakeClientError("schema"), "schema_error"),
            (_FakeClientError("unknown_version"), "unknown_version"),
            (_FakeClientError("length"), "transport_error"),
            (OSError("broken"), "transport_error"),
            (EOFError("cut"), "transport_error"),
            (ValueError("bad frame"), "schema_error"),
        ]
        for error, want in failures:
            with self.subTest(code=want, error=type(error).__name__):
                made = _install_fake_client(self, call_error=error)
                code, out, err = self._run(self._propose(path))
                self.assertEqual(code, 2)
                self.assertEqual(out, "")
                self._assert_refusal(err, want)
                self.assertEqual(len(made), 1)
                self.assertTrue(made[0].closed)
                self.assertEqual(len(made[0].calls), 1)
        made = _install_fake_client(
            self, enter_error=_FakeClientError("socket"))
        code, out, err = self._run(self._propose(path))
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self._assert_refusal(err, "endpoint_error")
        self.assertEqual(made[0].calls, [])
        made = _install_fake_client(self, init_error=TypeError("shape"))
        code, out, err = self._run(self._propose(path))
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self._assert_refusal(err, "transport_unavailable")
        self.assertEqual(made, [])
        empty = types.ModuleType("metaviewer_agents.client")
        key = "metaviewer_agents.client"
        saved = sys.modules.get(key, _MISSING)
        sys.modules[key] = empty
        try:
            code, out, err = self._run(self._propose(path))
        finally:
            if saved is _MISSING:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = saved
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self._assert_refusal(err, "transport_unavailable")
        _hide_module(self, "metaviewer_agents.client")
        code, out, err = self._run(self._propose(path))
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self._assert_refusal(err, "transport_unavailable")

    def test_missing_validator_is_unavailable(self):
        path, _ = self._assert_valid_envelope_file(_request_envelope())
        _hide_module(self, "metaviewer_agents.envelope")
        code, out, err = self._run(self._propose(path), _FakeSend())
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self._assert_refusal(err, "transport_unavailable")

    def test_seq_mismatch_never_sends(self):
        path, _ = self._assert_valid_envelope_file(_request_envelope())
        created = _install_fake_client(self, next_seq=5)
        code, out, err = self._run(self._propose(path))
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self._assert_refusal(err, "input_error")
        self.assertEqual(len(created), 1)
        self.assertTrue(created[0].closed)
        self.assertEqual(created[0].calls, [])

    def test_streams_and_canary(self):
        path, _ = self._assert_valid_envelope_file(_request_envelope())
        admitted = _reply_envelope()
        code, out, err = self._run(self._propose(path), _FakeSend(reply=admitted))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), admitted)
        self.assertEqual(out.count("\n"), 1)
        self.assertEqual(err, "")
        refused = _reply_envelope(_verdict_body("refused"))
        code, out, err = self._run(self._propose(path), _FakeSend(reply=refused))
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out), refused)
        self.assertEqual(out.count("\n"), 1)
        self.assertEqual(err, "")
        probe = _FakeSend()
        code, out, err = self._run(["list"], probe)
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self._assert_refusal(err, "usage_error")
        argv = self._propose(path)
        argv[argv.index("--timeout-ms") + 1] = _CANARY
        code, out, err = self._run(argv, _FakeSend())
        self.assertEqual(code, 2)
        self.assertNotIn(_CANARY, out)
        self.assertNotIn(_CANARY, err)
        code, out, err = self._run(["--token", _CANARY], _FakeSend())
        self.assertEqual(code, 2)
        self.assertNotIn(_CANARY, out)
        self.assertNotIn(_CANARY, err)
        poisoned = b'{"broken": "' + _CANARY.encode("utf-8")
        code, out, err = self._run(
            self._propose(self._write(poisoned)), _FakeSend())
        self.assertEqual(code, 2)
        self.assertNotIn(_CANARY, out)
        self.assertNotIn(_CANARY, err)
        with mock.patch.dict(os.environ, {"MVCTL_PROBE": _CANARY}):
            code, out, err = self._run(["list"], _FakeSend())
        self.assertEqual(code, 2)
        self.assertNotIn(_CANARY, out)
        self.assertNotIn(_CANARY, err)
        failures = [(ValueError("boom " + _CANARY), "schema_error"),
                    (RuntimeError("boom " + _CANARY), "transport_error"),
                    (OSError("boom " + _CANARY), "transport_error")]
        for error, want in failures:
            with self.subTest(error=type(error).__name__):
                probe = _FakeSend(error=error)
                code, out, err = self._run(self._propose(path), probe)
                self.assertEqual(code, 2)
                self.assertEqual(out, "")
                self._assert_refusal(err, want)
                self.assertEqual(len(probe.calls), 1)
                self.assertNotIn(_CANARY, err)

    def test_reserved_observe(self):
        send = _FakeSend()
        code, out, err = self._run(["observe"], send)
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self._assert_refusal(err, "unsupported_operation")
        self.assertEqual(send.calls, [])
        code, out, err = self._main(["observe"])
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self._assert_refusal(err, "unsupported_operation")
        with mock.patch.dict(os.environ):
            os.environ.pop("XDG_RUNTIME_DIR", None)
            probe = _FakeSend()
            code, out, err = self._run(["observe"], probe)
            self.assertEqual(code, 2)
            self._assert_refusal(err, "unsupported_operation")
            self.assertEqual(probe.calls, [])

    def test_package_surface(self):
        self.assertEqual(metaviewer_agents.__all__, ["build_parser", "run", "main"])
        self.assertTrue(callable(metaviewer_agents.build_parser))
        self.assertTrue(callable(metaviewer_agents.run))
        self.assertTrue(callable(metaviewer_agents.main))
        for leaked in ("sys", "os", "json", "argparse", "__version__",
                       "mvctl_probe", "ClientError", "EnvelopeError"):
            with self.subTest(name=leaked):
                with self.assertRaises(AttributeError):
                    getattr(metaviewer_agents, leaked)
        script = (
            "import sys\n"
            "sys.path.insert(0, %r)\n"
            "import metaviewer_agents as pkg\n"
            "assert pkg.__all__ == ['build_parser', 'run', 'main'], pkg.__all__\n"
            "assert 'metaviewer_agents.mvctl' not in sys.modules\n"
            "assert callable(pkg.run)\n"
            "assert callable(pkg.main)\n"
            "assert callable(pkg.build_parser)\n"
            "print('surface-ok')\n"
        ) % (str(ROOT),)
        proc = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "surface-ok\n")
        self.assertEqual(proc.stderr, "")
        proc = subprocess.run(
            [sys.executable, "-m", "metaviewer_agents.mvctl", "--help"],
            capture_output=True, text=True, timeout=30, cwd=str(ROOT))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("propose", proc.stdout)
        self.assertEqual(proc.stderr, "")


if __name__ == "__main__":
    unittest.main()
