"""Unit tests for the agent-side envelope codecs and core mailbox client.

Covers envelope construction and validation, bounded NDJSON framing,
owner-only Unix socket setup with peer verification, monotonic sequencing,
deadlines and the failure-terminal lifecycle. Every behaviour pairs a
positive control with a negative control that must fail for the stated
reason; no test is skipped under any condition.
"""

import collections
import copy
import json
import os
import shutil
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent.parent))
for _candidate in list(_HERE.parents)[:6]:
    if (_candidate / "tools" / "check_contracts.py").is_file():
        sys.path.insert(0, str(_candidate))
        break

from metaviewer_agents.client import ClientError, CoreClient
from metaviewer_agents.envelope import (
    COMPONENTS,
    SCHEMA,
    EnvelopeError,
    dumps_envelope,
    loads_envelope,
    make_envelope,
    validate_envelope,
)
from tools.check_contracts import ROOT as REPO_ROOT
from tools.check_contracts import Validator, ValidationError

# Fixture-only transport limits; production caps are frozen by the contract
# owner, so these values must never be read as protocol constants.
_LINE_CAP = 65536
_REPLY_CAP = 65536
_TIMEOUT_S = 2.0

_SHA256 = "0123456789abcdef" * 4
_HEX64 = "9" * 64


def _frame_ref(**over):
    body = {
        "schema": "frame_ref/v0.1",
        "surface_id": "surface-demo",
        "generation": 1,
        "tick": 7,
        "ts_ns": 1000000,
        "width": 800,
        "height": 600,
        "format": "rgb24",
        "ramws_path": "/dev/shm/ramws/demo.rgb",
        "sha256": _SHA256,
        "capture_us": 120,
    }
    body.update(over)
    return body


def _surface(**over):
    body = {
        "schema": "surface/v0.1",
        "surface_id": "surface-demo",
        "kind": "game_capsule",
        "display": ":101",
        "geometry": {"w": 800, "h": 600},
        "state": "active",
        "visibility": "unfolded",
        "control": "agent",
        "profile_id": "profile-demo",
    }
    body.update(over)
    return body


def _proposal(**over):
    body = {
        "schema": "action_proposal/v0.1",
        "proposal_id": "proposal-demo",
        "surface_id": "surface-demo",
        "based_on_frame": {"sha256": _SHA256, "generation": 1},
        "action": {"type": "click", "x": 20, "y": 30, "button": "left"},
        "expectation": {
            "type": "changed_region",
            "bbox": {"x": 10, "y": 20, "w": 80, "h": 30},
        },
        "budget": {"max_ms": 1000, "max_retries": 1},
    }
    body.update(over)
    return body


def _verdict(admitted=True, **over):
    body = {
        "schema": "action_verdict/v0.1",
        "proposal_id": "proposal-demo",
        "decision": "admitted" if admitted else "refused",
        "core_seq": 2,
    }
    if not admitted:
        body["reason_code"] = "STALE_FRAME"
    body.update(over)
    return body


def _receipt(**over):
    body = {
        "schema": "action_receipt/v0.1",
        "proposal_id": "proposal-demo",
        "executed_at_ns": 2000000,
        "after_frame": _frame_ref(tick=8, ts_ns=2000000, sha256=_HEX64),
        "verified": True,
        "verification": {"method": "pixel", "detail": "region changed"},
        "error": "",
    }
    body.update(over)
    return body


def _observation(full=True, **over):
    body = {"schema": "observation/v0.1", "frame_ref": _frame_ref()}
    if full:
        body["vision"] = {
            "summary": "Ready button visible",
            "changed_regions": [],
            "elements": [
                {
                    "bbox": {"x": 10, "y": 20, "w": 80, "h": 30},
                    "role": "button",
                    "name": "Ready",
                    "confidence": 0.95,
                }
            ],
        }
        body["ground_truth"] = {
            "source": "holdings_lane",
            "state_sha256": _HEX64,
            "tick": 7,
        }
    body.update(over)
    return body


def _surface_request(op="create", params=None, **over):
    if params is None:
        params = {
            "kind": "game_capsule",
            "geometry": {"w": 800, "h": 600},
            "profile_id": "profile-demo",
        }
    body = {"schema": "surface_request/v0.1", "op": op, "params": params}
    body.update(over)
    return body


def _surface_event(event="frame_ready", data=None, **over):
    if data is None:
        data = {"frame_ref": _frame_ref()}
    body = {"schema": "surface_event/v0.1", "event": event, "data": data}
    body.update(over)
    return body


_ALL_BODIES = (
    ("surface", _surface),
    ("frame_ref", _frame_ref),
    ("surface_request", _surface_request),
    ("surface_event", _surface_event),
    ("observation", _observation),
    ("action_proposal", _proposal),
    ("action_verdict", _verdict),
    ("action_receipt", _receipt),
)


def _wrap(body, seq=1, **over):
    args = {
        "msg_id": "message-demo",
        "from_component": "agent",
        "from_instance": "agent-test",
        "to_component": "core",
        "to_instance": "core-test",
        "session_id": "session-test",
        "seq": seq,
        "body": body,
    }
    args.update(over)
    return make_envelope(**args)


def _reply_bytes(body, seq=1):
    env = make_envelope(
        msg_id="reply-demo",
        from_component="core",
        from_instance="core-test",
        to_component="agent",
        to_instance="agent-test",
        session_id="session-test",
        seq=seq,
        body=body,
    )
    return dumps_envelope(env, max_bytes=_LINE_CAP)


def _default_reply():
    return _reply_bytes(_verdict())


class _FakeCore:
    """In-process owner-only UDS peer speaking envelope/v0.1 frames."""

    def __init__(self, testcase):
        self._case = testcase
        self.root = tempfile.mkdtemp(prefix="mv-core-")
        os.chmod(self.root, 0o700)
        self.path = os.path.join(self.root, "core.sock")
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        os.chmod(self.path, 0o600)
        self.server.listen(8)
        self.server.settimeout(0.2)
        self.received = []
        self._lock = threading.Lock()
        self.script = collections.deque()
        self.stop = threading.Event()
        self.thread = threading.Thread(
            target=self._run, name="fake-core", daemon=True
        )
        testcase.addCleanup(self.close)
        self.thread.start()

    def queue(self, *items):
        """Program raw byte replies or callables taking the connection."""
        with self._lock:
            self.script.extend(items)

    def received_count(self):
        with self._lock:
            return len(self.received)

    def received_envelopes(self):
        with self._lock:
            lines = list(self.received)
        return [loads_envelope(line, max_bytes=_LINE_CAP) for line in lines]

    def _answer(self, conn, raw):
        del raw
        with self._lock:
            item = self.script.popleft() if self.script else None
        if item is None:
            conn.sendall(_default_reply())
            return
        if isinstance(item, (bytes, bytearray)):
            conn.sendall(bytes(item))
        else:
            item(conn)

    def _run(self):
        while not self.stop.is_set():
            try:
                conn, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            try:
                conn.settimeout(1.0)
                buf = b""
                while not self.stop.is_set():
                    try:
                        data = conn.recv(65536)
                    except socket.timeout:
                        continue
                    except OSError:
                        break
                    if not data:
                        break
                    buf += data
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        with self._lock:
                            self.received.append(line + b"\n")
                        try:
                            self._answer(conn, line + b"\n")
                        except OSError:
                            break
            finally:
                try:
                    conn.close()
                except OSError:
                    pass

    def close(self):
        self.stop.set()
        try:
            self.server.close()
        except OSError:
            pass
        self.thread.join(timeout=5.0)
        self._case.assertFalse(
            self.thread.is_alive(), "fake core thread did not stop"
        )
        shutil.rmtree(self.root, ignore_errors=True)
        self._case.assertFalse(
            os.path.exists(self.root), "fake core dir was not removed"
        )


class ClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.oracle = Validator(REPO_ROOT / "contracts" / "v0.1")
        cls.envelope_schema = cls.oracle.load("envelope.schema.json")
        cls.examples = REPO_ROOT / "contracts" / "examples"

    def _client(self, core, timeout_s=_TIMEOUT_S, line=_LINE_CAP,
                reply=_REPLY_CAP, path=None):
        client = CoreClient(
            core.path if path is None else path,
            timeout_s=timeout_s,
            max_line_bytes=line,
            max_reply_bytes=reply,
        )
        self.addCleanup(client.close)
        return client

    def _example(self, name):
        return json.loads((self.examples / name).read_text())

    def assertOracleAccepts(self, value):
        self.oracle.validate(value, self.envelope_schema)

    def assertOracleRejects(self, value):
        with self.assertRaises(ValidationError):
            self.oracle.validate(value, self.envelope_schema)

    def assertEnvelopeCode(self, code, value):
        with self.assertRaises(EnvelopeError) as ctx:
            validate_envelope(value)
        self.assertEqual(ctx.exception.code, code)
        return ctx.exception

    def assertClientCode(self, code, func, *args, **kwargs):
        with self.assertRaises(ClientError) as ctx:
            func(*args, **kwargs)
        self.assertEqual(ctx.exception.code, code)
        return ctx.exception

    def assertReceivedSettlesAt(self, core, count, settle_s=0.3):
        deadline = time.monotonic() + settle_s
        while time.monotonic() < deadline:
            if core.received_count() != count:
                break
            time.sleep(0.02)
        self.assertEqual(core.received_count(), count)

    def assertTerminal(self, client):
        probe = _wrap(_proposal(), seq=client.next_seq)
        self.assertClientCode("socket", client.send, probe)
        self.assertClientCode("socket", client.recv)
        self.assertClientCode("socket", client.connect)

    # Contract corpus parity: both validators agree on every example.

    def test_valid_outer_example_accepted_by_both(self):
        value = self._example("envelope.valid.json")
        self.assertIs(validate_envelope(value), value)
        self.assertOracleAccepts(value)

    def test_every_body_variant_round_trips_through_oracle(self):
        self.assertEqual(len(_ALL_BODIES), 8)
        for name, factory in _ALL_BODIES:
            with self.subTest(body=name):
                env = _wrap(factory())
                self.assertIs(validate_envelope(env), env)
                self.assertOracleAccepts(env)
                raw = dumps_envelope(env, max_bytes=_LINE_CAP)
                back = loads_envelope(raw, max_bytes=_LINE_CAP)
                self.assertEqual(back, env)
                self.assertOracleAccepts(back)

    def test_body_corpus_examples_accepted_by_both(self):
        for name, _ in _ALL_BODIES:
            with self.subTest(body=name):
                env = _wrap(self._example(name + ".valid.json"))
                self.assertOracleAccepts(env)

    def test_invalid_examples_rejected_by_both(self):
        bad_outer = self._example("envelope.invalid.schema.json")
        self.assertEnvelopeCode("unknown_version", bad_outer)
        self.assertOracleRejects(bad_outer)
        for name, _ in _ALL_BODIES:
            with self.subTest(body=name):
                env = _wrap(_proposal())
                env["body"] = self._example(name + ".invalid.schema.json")
                self.assertEnvelopeCode("unknown_version", env)
                self.assertOracleRejects(env)

    # Version and shape: exact versions accepted, anything else refused.

    def test_constants_match_contract(self):
        self.assertEqual(SCHEMA, "envelope/v0.1")
        self.assertEqual(
            COMPONENTS, {"core", "ui", "daemon", "agent", "vision", "wender"}
        )

    def test_unknown_outer_version_refused(self):
        for schema in ("wrong/v0.1", "envelope/v0.2", "envelope/v0.10"):
            with self.subTest(schema=schema):
                env = _wrap(_proposal())
                env["schema"] = schema
                self.assertEnvelopeCode("unknown_version", env)
                self.assertOracleRejects(env)

    def test_malformed_outer_schema_is_shape_error(self):
        for schema in ("", None, 7, True, ["envelope/v0.1"]):
            with self.subTest(schema=schema):
                env = _wrap(_proposal())
                env["schema"] = schema
                self.assertEnvelopeCode("bad_shape", env)
                self.assertOracleRejects(env)
        env = _wrap(_proposal())
        del env["schema"]
        self.assertEnvelopeCode("bad_shape", env)

    def test_unknown_body_version_refused(self):
        cases = [
            _proposal(schema="action_proposal/v0.2"),
            _proposal(schema="future/v9.9"),
            {
                "schema": "session_record/v0.1",
                "session_id": "s",
                "surface_id": "s",
            },
        ]
        for body in cases:
            with self.subTest(body=body["schema"]):
                env = _wrap(_proposal())
                env["body"] = body
                self.assertEnvelopeCode("unknown_version", env)
                self.assertOracleRejects(env)

    def test_malformed_body_is_shape_error(self):
        for body in (
            {"proposal_id": "p"},
            {"schema": ""},
            {"schema": None},
            {"schema": "action_verdict/v0.1"},
            [("schema", "action_verdict/v0.1")],
            "action_verdict/v0.1",
            None,
        ):
            with self.subTest(body=body):
                env = _wrap(_proposal())
                env["body"] = body
                self.assertEnvelopeCode("bad_shape", env)
                if isinstance(body, dict):
                    self.assertOracleRejects(env)

    def test_closed_keys(self):
        env = _wrap(_proposal())
        extra = copy.deepcopy(env)
        extra["unexpected"] = 1
        self.assertEnvelopeCode("bad_shape", extra)
        self.assertOracleRejects(extra)
        for key in ("schema", "msg_id", "ts_ns", "from", "to", "session_id",
                    "seq", "nonce", "body"):
            with self.subTest(missing=key):
                missing = copy.deepcopy(env)
                del missing[key]
                self.assertEnvelopeCode("bad_shape", missing)
        for end in ("from", "to"):
            with self.subTest(endpoint=end):
                bad_end = copy.deepcopy(env)
                bad_end[end]["unexpected"] = "x"
                self.assertEnvelopeCode("bad_shape", bad_end)
                bad_end = copy.deepcopy(env)
                del bad_end[end]["instance"]
                self.assertEnvelopeCode("bad_shape", bad_end)
                bad_end = copy.deepcopy(env)
                bad_end[end] = "agent:test"
                self.assertEnvelopeCode("bad_shape", bad_end)
                bad_end = copy.deepcopy(env)
                bad_end[end]["component"] = "bogus"
                self.assertEnvelopeCode("bad_shape", bad_end)
                self.assertOracleRejects(bad_end)

    def test_scalar_types_and_bounds(self):
        env = _wrap(_proposal())
        bad_values = {
            "seq": (True, False, 0, -1, "1", 1.0, None),
            "ts_ns": (True, False, -1, "0", 1.5, None),
            "msg_id": ("", "x" * 129, 7, None, True),
            "session_id": ("", "x" * 129, 7, None),
            "nonce": ("", "x" * 129, 7, None),
        }
        for key, values in bad_values.items():
            for bad in values:
                with self.subTest(key=key, bad=bad):
                    mutant = copy.deepcopy(env)
                    mutant[key] = bad
                    self.assertEnvelopeCode("bad_shape", mutant)
        for bad in ("", "x" * 129, 7, None):
            with self.subTest(instance=bad):
                mutant = copy.deepcopy(env)
                mutant["from"]["instance"] = bad
                self.assertEnvelopeCode("bad_shape", mutant)
        self.assertIs(validate_envelope(env), env)

    def test_legacy_nonce_accepted_and_generated_nonce_is_hex(self):
        env = _wrap(_proposal(), nonce="nonce-demo")
        self.assertEqual(env["nonce"], "nonce-demo")
        seen = set()
        for _ in range(50):
            nonce = _wrap(_proposal())["nonce"]
            self.assertEqual(len(nonce), 32)
            self.assertTrue(all(c in "0123456789abcdef" for c in nonce))
            seen.add(nonce)
        self.assertEqual(len(seen), 50)

    def test_make_envelope_deep_copies_body(self):
        body = _proposal()
        env = _wrap(body)
        body["proposal_id"] = "mutated-after-build"
        body["budget"]["max_ms"] = -1
        self.assertEqual(env["body"]["proposal_id"], "proposal-demo")
        self.assertEqual(env["body"]["budget"]["max_ms"], 1000)
        self.assertIs(validate_envelope(env), env)

    def test_validate_envelope_does_not_mutate(self):
        env = _wrap(_proposal())
        before = copy.deepcopy(env)
        validate_envelope(env)
        self.assertEqual(env, before)

    def test_body_mutants_rejected_by_both(self):
        def remove_budget(body):
            del body["budget"]

        def extra_nested(body):
            body["budget"]["unexpected"] = 1

        def bad_enum(body):
            body["action"] = {"type": "click", "x": 0, "y": 0,
                              "button": "sideways"}

        def bad_pattern(body):
            body["based_on_frame"]["sha256"] = "ZZZ"

        def bool_as_int(body):
            body["based_on_frame"]["generation"] = True

        def empty_keys(body):
            body["action"] = {"type": "key", "keys": []}

        def over_confident(body):
            body["vision"]["elements"][0]["confidence"] = 2.0

        def verdict_no_reason(body):
            body["decision"] = "refused"

        def verdict_extra_reason(body):
            body["reason_code"] = "POLICY"

        def receipt_bool_as_int(body):
            body["after_frame"]["width"] = 0

        def surface_bad_state(body):
            body["state"] = "vaporized"

        def request_bad_op(body):
            body["op"] = "teleport"

        def event_bad_data(body):
            body["data"] = {"surface_id": "s", "proposal_id": "p",
                            "unexpected": True}

        def frame_bad_path(body):
            body["ramws_path"] = "relative/path.rgb"

        mutants = [
            ("action_proposal", _proposal, remove_budget),
            ("action_proposal", _proposal, extra_nested),
            ("action_proposal", _proposal, bad_enum),
            ("action_proposal", _proposal, bad_pattern),
            ("action_proposal", _proposal, bool_as_int),
            ("action_proposal", _proposal, empty_keys),
            ("observation", _observation, over_confident),
            ("action_verdict", _verdict, verdict_no_reason),
            ("action_verdict", _verdict, verdict_extra_reason),
            ("action_receipt", _receipt, receipt_bool_as_int),
            ("surface", _surface, surface_bad_state),
            ("surface_request", _surface_request, request_bad_op),
            ("surface_event", _surface_event, event_bad_data),
            ("frame_ref", _frame_ref, frame_bad_path),
        ]
        for name, factory, mutate in mutants:
            with self.subTest(body=name, mutant=mutate.__name__):
                body = factory()
                mutate(body)
                env = _wrap(_proposal())
                env["body"] = body
                self.assertEnvelopeCode("bad_shape", env)
                self.assertOracleRejects(env)

    def test_all_request_ops_and_actions_validate(self):
        surface = {"surface_id": "s"}
        params = {
            "create": {"kind": "game_capsule",
                       "geometry": {"w": 800, "h": 600}, "profile_id": "p"},
            "list": {},
            "destroy": dict(surface),
            "frame_subscribe": dict(surface),
            "frame_unsubscribe": dict(surface),
            "record_start": {**surface, "recording_id": "r"},
            "record_stop": {**surface, "recording_id": "r"},
            "take_control": {**surface, "owner": "human"},
            "release_control": dict(surface),
            "input": {**surface, "proposal_id": "p",
                      "action": {"type": "wait", "ms": 1}},
        }
        self.assertEqual(len(params), 10)
        for op, value in params.items():
            with self.subTest(op=op):
                env = _wrap(_surface_request(op=op, params=value))
                self.assertOracleAccepts(env)
        actions = [
            {"type": "click", "x": 0, "y": 0, "button": "left"},
            {"type": "key", "keys": ["CTRL", "A"]},
            {"type": "type", "text": "hello"},
            {"type": "scroll", "dx": -1, "dy": 2},
            {"type": "wait", "ms": 1},
            {"type": "lane_submit", "verb": "submit",
             "payload": {"nonce": "n", "seq": 1, "command": "move",
                         "args": ["left"]}},
        ]
        for action in actions:
            with self.subTest(action=action["type"]):
                env = _wrap(_proposal(action=action))
                self.assertOracleAccepts(env)
                bad = _wrap(_proposal())
                bad["body"]["action"] = {**action, "unexpected": True}
                self.assertEnvelopeCode("bad_shape", bad)
                self.assertOracleRejects(bad)

    # Serialization: strict UTF-8 NDJSON with no silent normalization.

    def test_utf8_and_escaped_newline_round_trip(self):
        body = _proposal(action={"type": "type", "text": "héllo\nworld ✓"})
        env = _wrap(body)
        raw = dumps_envelope(env, max_bytes=_LINE_CAP)
        self.assertTrue(raw.endswith(b"\n"))
        self.assertNotIn(b"\r", raw[:-1])
        self.assertNotIn(b"\n", raw[:-1])
        back = loads_envelope(raw, max_bytes=_LINE_CAP)
        self.assertEqual(back, env)
        self.assertEqual(back["body"]["action"]["text"], "héllo\nworld ✓")

    def test_wire_rejects_malformed_json(self):
        good = dumps_envelope(_wrap(_proposal()), max_bytes=_LINE_CAP)
        cases = [
            b"not json\n",
            b'{"schema": NaN}\n',
            b'{"schema": Infinity}\n',
            b'{"schema": "envelope/v0.1", "n": 1e999}\n',
            b'{"a": 1, "a": 2}\n',
            good[:-1] + b" " + good,
            b"\xff\xfe invalid utf-8 \n",
            good[:-1],
            good[:-1] + b"\r\r\n",
            good[:-1][:40] + b"\n" + good[:-1][40:] + b"\n",
            good[:-1][:40] + b"\r" + good[:-1][40:] + b"\n",
            b"\n",
            b"\r\n",
            b"",
        ]
        obs = dumps_envelope(_wrap(_observation()), max_bytes=_LINE_CAP)
        cases.append(obs.replace(b"0.95", b"1e999", 1))
        for raw in cases:
            with self.subTest(raw=raw[:32]):
                with self.assertRaises(EnvelopeError) as ctx:
                    loads_envelope(raw, max_bytes=_LINE_CAP)
                self.assertEqual(ctx.exception.code, "bad_shape")
        crlf = good[:-1] + b"\r\n"
        self.assertEqual(loads_envelope(crlf, max_bytes=_LINE_CAP + 1),
                         loads_envelope(good, max_bytes=_LINE_CAP))

    def test_loads_requires_bytes_and_explicit_cap(self):
        good = dumps_envelope(_wrap(_proposal()), max_bytes=_LINE_CAP)
        for bad in ("text", bytearray(good), None, 7, ["x"]):
            with self.subTest(line=type(bad).__name__):
                with self.assertRaises(EnvelopeError) as ctx:
                    loads_envelope(bad, max_bytes=_LINE_CAP)
                self.assertEqual(ctx.exception.code, "bad_shape")
        for cap in (0, -1, True, False, "100", None, 1.5):
            with self.subTest(cap=cap):
                with self.assertRaises(EnvelopeError) as ctx:
                    loads_envelope(good, max_bytes=cap)
                self.assertEqual(ctx.exception.code, "bad_shape")
                with self.assertRaises(EnvelopeError) as ctx:
                    dumps_envelope(_wrap(_proposal()), max_bytes=cap)
                self.assertEqual(ctx.exception.code, "bad_shape")

    def test_nonfinite_numbers_rejected(self):
        body = _observation()
        body["vision"]["elements"][0]["confidence"] = float("nan")
        with self.assertRaises(EnvelopeError) as ctx:
            _wrap(body)
        self.assertEqual(ctx.exception.code, "bad_shape")
        body["vision"]["elements"][0]["confidence"] = float("inf")
        with self.assertRaises(EnvelopeError) as ctx:
            _wrap(body)
        self.assertEqual(ctx.exception.code, "bad_shape")

    # Byte boundaries: caps gate before any parse or write.

    def test_frame_exactly_at_cap_accepted(self):
        env = _wrap(_proposal())
        raw = dumps_envelope(env, max_bytes=_LINE_CAP)
        cap = len(raw)
        self.assertEqual(loads_envelope(raw, max_bytes=cap), env)
        self.assertEqual(dumps_envelope(env, max_bytes=cap), raw)

    def test_oversize_rejected_before_parse(self):
        good = dumps_envelope(_wrap(_proposal()), max_bytes=_LINE_CAP)
        with self.assertRaises(EnvelopeError) as ctx:
            loads_envelope(good, max_bytes=len(good) - 1)
        self.assertEqual(ctx.exception.code, "length")
        with self.assertRaises(EnvelopeError) as ctx:
            loads_envelope(good[:-1], max_bytes=len(good) - 2)
        self.assertEqual(ctx.exception.code, "length")
        invalid = b"{oops, invalid json but over the cap!!}\n"
        with self.assertRaises(EnvelopeError) as ctx:
            loads_envelope(invalid, max_bytes=len(invalid) - 1)
        self.assertEqual(ctx.exception.code, "length")
        with mock.patch("json.loads",
                        side_effect=AssertionError("parsed over cap")):
            with self.assertRaises(EnvelopeError) as ctx:
                loads_envelope(good, max_bytes=len(good) - 1)
            self.assertEqual(ctx.exception.code, "length")

    def test_multibyte_counted_in_bytes(self):
        body = _proposal(action={"type": "type", "text": "é" * 64})
        env = _wrap(body)
        raw = dumps_envelope(env, max_bytes=_LINE_CAP)
        text = raw.decode("utf-8")
        self.assertLess(len(text), len(raw))
        with self.assertRaises(EnvelopeError) as ctx:
            loads_envelope(raw, max_bytes=len(text))
        self.assertEqual(ctx.exception.code, "length")
        self.assertEqual(loads_envelope(raw, max_bytes=len(raw)), env)

    def test_outbound_oversize_sends_nothing(self):
        core = _FakeCore(self)
        small = _wrap(_observation(full=False))
        small_raw = dumps_envelope(small, max_bytes=_LINE_CAP)
        big = _wrap(_proposal(action={"type": "type", "text": "y" * 4096}))
        self.assertGreater(
            len(dumps_envelope(big, max_bytes=_LINE_CAP)), len(small_raw))
        client = self._client(core, line=len(small_raw))
        client.connect()
        self.assertClientCode("length", client.send, big)
        self.assertReceivedSettlesAt(core, 0)
        self.assertEqual(client.next_seq, 1)
        self.assertEqual(client.send(small), 1)
        reply = client.recv()
        self.assertEqual(reply["body"]["schema"], "action_verdict/v0.1")

    # Sequence and identity lifecycle over a live connection.

    def test_call_round_trip(self):
        core = _FakeCore(self)
        core.queue(_reply_bytes(_verdict()))
        client = self._client(core)
        client.connect()
        reply = client.call(_wrap(_proposal()))
        self.assertEqual(reply["schema"], "envelope/v0.1")
        self.assertEqual(reply["body"]["schema"], "action_verdict/v0.1")
        self.assertEqual(reply["body"]["decision"], "admitted")
        self.assertOracleAccepts(reply)
        sent = core.received_envelopes()
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["seq"], 1)
        self.assertEqual(
            set(sent[0]["body"]["based_on_frame"]), {"sha256", "generation"})
        self.assertOracleAccepts(sent[0])

    def test_monotonic_seq_and_unique_nonce(self):
        core = _FakeCore(self)
        client = self._client(core)
        self.assertEqual(client.next_seq, 1)
        client.connect()
        stamps = []
        for seq in (1, 2, 3):
            env = _wrap(_proposal(), seq=seq)
            stamps.append(env["ts_ns"])
            self.assertEqual(client.send(env), seq)
            client.recv()
            self.assertEqual(client.next_seq, seq + 1)
        sent = core.received_envelopes()
        self.assertEqual([frame["seq"] for frame in sent], [1, 2, 3])
        nonces = [frame["nonce"] for frame in sent]
        self.assertEqual(len(set(nonces)), 3)
        for nonce in nonces:
            self.assertEqual(len(nonce), 32)
        self.assertLessEqual(stamps[0], stamps[1])
        self.assertLessEqual(stamps[1], stamps[2])

    def test_wrong_seq_rejected_before_send(self):
        core = _FakeCore(self)
        client = self._client(core)
        client.connect()
        self.assertClientCode("schema", client.send, _wrap(_proposal(), seq=2))
        self.assertReceivedSettlesAt(core, 0)
        self.assertEqual(client.next_seq, 1)
        self.assertEqual(client.send(_wrap(_proposal(), seq=1)), 1)
        client.recv()
        self.assertClientCode("schema", client.send, _wrap(_proposal(), seq=1))
        self.assertClientCode("schema", client.send, _wrap(_proposal(), seq=5))
        self.assertReceivedSettlesAt(core, 1)
        self.assertEqual(client.next_seq, 2)

    def test_malformed_send_leaves_counter_and_socket_usable(self):
        core = _FakeCore(self)
        client = self._client(core)
        client.connect()
        bad = _wrap(_proposal())
        bad["body"] = {"schema": "action_verdict/v0.1"}
        self.assertClientCode("bad_shape", client.send, bad)
        self.assertEqual(client.next_seq, 1)
        self.assertReceivedSettlesAt(core, 0)
        self.assertEqual(client.send(_wrap(_proposal(), seq=1)), 1)
        reply = client.recv()
        self.assertEqual(reply["body"]["decision"], "admitted")

    def test_identity_pinned_after_first_send(self):
        core = _FakeCore(self)
        client = self._client(core)
        client.connect()
        self.assertEqual(client.send(_wrap(_proposal(), seq=1)), 1)
        client.recv()
        other_instance = _wrap(_proposal(), seq=2,
                               from_instance="agent-other")
        self.assertClientCode("schema", client.send, other_instance)
        other_session = _wrap(_proposal(), seq=2, session_id="session-other")
        self.assertClientCode("schema", client.send, other_session)
        self.assertEqual(client.next_seq, 2)
        self.assertReceivedSettlesAt(core, 1)
        self.assertEqual(client.send(_wrap(_proposal(), seq=2)), 2)

    def test_call_returns_next_frame_intact(self):
        core = _FakeCore(self)
        core.queue(_reply_bytes(_frame_ref(), seq=9),
                   _reply_bytes(_verdict(), seq=10))
        client = self._client(core)
        client.connect()
        first = client.call(_wrap(_proposal(), seq=1))
        self.assertEqual(first["body"]["schema"], "frame_ref/v0.1")
        self.assertEqual(first["seq"], 9)
        second = client.call(_wrap(_proposal(), seq=2))
        self.assertEqual(second["body"]["schema"], "action_verdict/v0.1")

    # Stream segmentation: fragments, coalescing and dirty boundaries.

    def test_fragmented_frame_reassembled(self):
        reply = _reply_bytes(_verdict())
        text_reply = _reply_bytes(_proposal(
            action={"type": "type", "text": "split-héré ✓"}))
        crlf = reply[:-1] + b"\r\n"
        cut_text = text_reply.index("✓".encode("utf-8")) + 1
        cases = [
            (reply[:len(reply) // 2], reply[len(reply) // 2:],
             "action_verdict/v0.1"),
            (text_reply[:cut_text], text_reply[cut_text:],
             "action_proposal/v0.1"),
            (crlf[:-1], crlf[-1:], "action_verdict/v0.1"),
        ]
        for head, tail, expected in cases:
            with self.subTest(split=len(head)):
                core = _FakeCore(self)

                def drip(conn, head=head, tail=tail):
                    conn.sendall(head)
                    time.sleep(0.15)
                    conn.sendall(tail)

                core.queue(drip)
                client = self._client(core)
                client.connect()
                got = client.call(_wrap(_proposal()))
                self.assertEqual(got["body"]["schema"], expected)

    def test_coalesced_frames_returned_in_order(self):
        core = _FakeCore(self)
        first = _reply_bytes(_frame_ref(), seq=11)
        second = _reply_bytes(_verdict(), seq=12)
        core.queue(first + second)
        client = self._client(core)
        client.connect()
        client.send(_wrap(_proposal(), seq=1))
        self.assertEqual(client.recv()["seq"], 11)
        self.assertEqual(client.recv()["body"]["schema"],
                         "action_verdict/v0.1")

    def test_partial_eof_rejected(self):
        core = _FakeCore(self)
        reply = _reply_bytes(_verdict())

        def truncate(conn):
            conn.sendall(reply[:len(reply) // 2])
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            conn.close()

        core.queue(truncate)
        client = self._client(core)
        client.connect()
        client.send(_wrap(_proposal(), seq=1))
        self.assertClientCode("schema", client.recv)
        self.assertTerminal(client)

    def test_blank_frame_rejected(self):
        for raw in (b"\n", b"\r\n"):
            with self.subTest(raw=raw):
                core = _FakeCore(self)
                core.queue(raw)
                client = self._client(core)
                client.connect()
                client.send(_wrap(_proposal(), seq=1))
                self.assertClientCode("bad_shape", client.recv)
                self.assertTerminal(client)

    def test_valid_then_malformed_frame(self):
        core = _FakeCore(self)
        core.queue(_reply_bytes(_verdict()) + b"not json\n")
        client = self._client(core)
        client.connect()
        client.send(_wrap(_proposal(), seq=1))
        first = client.recv()
        self.assertEqual(first["body"]["decision"], "admitted")
        self.assertClientCode("bad_shape", client.recv)
        self.assertTerminal(client)

    def test_inbound_oversize_closes_without_parse(self):
        core = _FakeCore(self)
        reply = _reply_bytes(_verdict())
        core.queue(reply)
        client = self._client(core, reply=len(reply) - 1)
        client.connect()
        client.send(_wrap(_proposal(), seq=1))
        with mock.patch("json.loads",
                        side_effect=AssertionError("parsed over cap")):
            self.assertClientCode("length", client.recv)
        self.assertTerminal(client)

    def test_inbound_oversize_without_delimiter(self):
        core = _FakeCore(self)
        chunk = b"x" * (_REPLY_CAP + 64)

        def flood(conn):
            conn.sendall(chunk)

        core.queue(flood)
        client = self._client(core)
        client.connect()
        client.send(_wrap(_proposal(), seq=1))
        self.assertClientCode("length", client.recv)
        self.assertTerminal(client)

    # Owner and peer security: every check precedes the first write.

    def test_parent_mode_must_be_owner_only(self):
        core = _FakeCore(self)
        os.chmod(core.root, 0o755)
        self.addCleanup(os.chmod, core.root, 0o700)
        client = self._client(core)
        self.assertClientCode("socket", client.connect)
        self.assertEqual(core.received_count(), 0)

    def test_socket_mode_must_be_owner_only(self):
        core = _FakeCore(self)
        os.chmod(core.path, 0o666)
        client = self._client(core)
        self.assertClientCode("socket", client.connect)
        self.assertEqual(core.received_count(), 0)

    def test_paths_hardened(self):
        core = _FakeCore(self)
        plain = os.path.join(core.root, "plain.sock")
        with open(plain, "w") as handle:
            handle.write("not a socket")
        os.chmod(plain, 0o600)
        link = os.path.join(core.root, "link.sock")
        os.symlink(core.path, link)
        link_parent = os.path.join(core.root, "alias")
        os.symlink(core.root, link_parent)
        cases = [
            os.path.join("relative", "core.sock"),
            core.path + "\x00",
            os.path.join(core.root, "missing.sock"),
            plain,
            link,
            os.path.join(link_parent, "core.sock"),
        ]
        for path in cases:
            with self.subTest(path=path):
                client = self._client(core, path=path)
                self.assertClientCode("socket", client.connect)
        self.assertEqual(core.received_count(), 0)

    def test_foreign_filesystem_uid_refused(self):
        core = _FakeCore(self)
        foreign = (os.getuid() + 1) % 2**31
        client = self._client(core)
        with mock.patch("os.getuid", return_value=foreign):
            self.assertClientCode("socket", client.connect)
        self.assertEqual(core.received_count(), 0)

    def test_foreign_peer_uid_refused_before_first_write(self):
        core = _FakeCore(self)
        foreign = struct.pack("3i", 1, (os.getuid() + 1) % 2**31, 1)
        client = self._client(core)
        with mock.patch.object(socket.socket, "getsockopt",
                               return_value=foreign):
            self.assertClientCode("socket", client.connect)
        self.assertReceivedSettlesAt(core, 0)

    def test_missing_peer_verification_refused(self):
        core = _FakeCore(self)
        client = self._client(core)
        real = socket.SO_PEERCRED
        try:
            del socket.SO_PEERCRED
            self.assertClientCode("socket", client.connect)
        finally:
            socket.SO_PEERCRED = real
        self.assertReceivedSettlesAt(core, 0)

    # Deadline, cleanup and terminal lifecycle.

    def test_silent_peer_times_out(self):
        core = _FakeCore(self)

        def silent(conn):
            del conn
            core.stop.wait(timeout=5.0)

        core.queue(silent)
        client = self._client(core, timeout_s=0.3)
        client.connect()
        client.send(_wrap(_proposal(), seq=1))
        self.assertClientCode("timeout", client.recv)
        self.assertTerminal(client)

    def test_byte_drip_does_not_extend_deadline(self):
        core = _FakeCore(self)

        def drip(conn):
            for _ in range(6):
                if core.stop.wait(0.25):
                    return
                try:
                    conn.sendall(b"x")
                except OSError:
                    return

        core.queue(drip)
        client = self._client(core, timeout_s=0.6)
        client.connect()
        client.send(_wrap(_proposal(), seq=1))
        start = time.monotonic()
        self.assertClientCode("timeout", client.recv)
        self.assertLess(time.monotonic() - start, 0.6 + 2.0)
        self.assertTerminal(client)

    def test_close_is_idempotent_and_terminal(self):
        core = _FakeCore(self)
        client = self._client(core)
        client.connect()
        client.close()
        client.close()
        self.assertTerminal(client)

    def test_connect_idempotent_while_connected(self):
        core = _FakeCore(self)
        client = self._client(core)
        client.connect()
        client.connect()
        reply = client.call(_wrap(_proposal()))
        self.assertEqual(reply["body"]["decision"], "admitted")

    def test_context_manager_connects_and_closes(self):
        core = _FakeCore(self)
        with self._client(core) as client:
            reply = client.call(_wrap(_proposal()))
            self.assertEqual(reply["body"]["decision"], "admitted")
        self.assertTerminal(client)

    def test_io_without_connect_refused(self):
        core = _FakeCore(self)
        client = self._client(core)
        self.assertClientCode("socket", client.send, _wrap(_proposal()))
        self.assertClientCode("socket", client.recv)
        self.assertEqual(core.received_count(), 0)

    def test_unknown_version_reply_is_terminal(self):
        core = _FakeCore(self)
        bad = _reply_bytes(_verdict())[:-1]
        wrong = bad.replace(b"envelope/v0.1", b"wrong/v0.1", 1) + b"\n"
        core.queue(wrong)
        client = self._client(core)
        client.connect()
        client.send(_wrap(_proposal(), seq=1))
        self.assertClientCode("unknown_version", client.recv)
        self.assertTerminal(client)

    def test_inbound_schema_error_is_terminal(self):
        core = _FakeCore(self)
        core.queue(b"not json\n")
        client = self._client(core)
        client.connect()
        client.send(_wrap(_proposal(), seq=1))
        self.assertClientCode("bad_shape", client.recv)
        self.assertTerminal(client)

    def test_send_failure_is_terminal(self):
        core = _FakeCore(self)

        def drop_first(conn):
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            conn.close()

        core.queue(drop_first)
        client = self._client(core)
        client.connect()
        failures = 0
        for _ in range(10):
            try:
                client.send(_wrap(_proposal(), seq=client.next_seq))
            except ClientError as exc:
                self.assertIn(exc.code, ("socket", "timeout"))
                failures += 1
                break
            try:
                client.recv()
            except ClientError as exc:
                self.assertIn(exc.code, ("socket", "timeout", "schema"))
                failures += 1
                break
        self.assertEqual(failures, 1)
        self.assertTerminal(client)

    def test_constructor_rejects_bad_limits(self):
        unused = "/unused/core.sock"
        for cap in (0, -1, True, False, "100", None, 8.5):
            with self.subTest(cap=cap):
                with self.assertRaises(ClientError) as ctx:
                    CoreClient(unused, timeout_s=_TIMEOUT_S,
                               max_line_bytes=cap, max_reply_bytes=_REPLY_CAP)
                self.assertEqual(ctx.exception.code, "length")
                with self.assertRaises(ClientError) as ctx:
                    CoreClient(unused, timeout_s=_TIMEOUT_S,
                               max_line_bytes=_LINE_CAP, max_reply_bytes=cap)
                self.assertEqual(ctx.exception.code, "length")
        for timeout in (0, -1, True, False, "2", None,
                        float("inf"), float("nan")):
            with self.subTest(timeout=timeout):
                with self.assertRaises(ClientError) as ctx:
                    CoreClient(unused, timeout_s=timeout,
                               max_line_bytes=_LINE_CAP,
                               max_reply_bytes=_REPLY_CAP)
                self.assertEqual(ctx.exception.code, "timeout")
        client = CoreClient(unused, timeout_s=2,
                            max_line_bytes=_LINE_CAP,
                            max_reply_bytes=_REPLY_CAP)
        self.addCleanup(client.close)
        self.assertEqual(client.next_seq, 1)

    def test_connect_rejects_unusable_path_types(self):
        for path in (12345, None, ["x"], b"\x00"):
            with self.subTest(path=path):
                client = CoreClient(path, timeout_s=_TIMEOUT_S,
                                    max_line_bytes=_LINE_CAP,
                                    max_reply_bytes=_REPLY_CAP)
                self.addCleanup(client.close)
                self.assertClientCode("socket", client.connect)


if __name__ == "__main__":
    unittest.main()
