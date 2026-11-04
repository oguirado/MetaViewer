"""Synthetic SDK checks, not proof of a running guest."""
import hashlib
import unittest
from types import SimpleNamespace
from metaviewer_agents.headless import HeadlessSession, HeadlessError
from metaviewer_agents.client import ToolClient
from metaviewer_agents.envelope import _resolve_reference


class Stub:
    local = {"endpoint": {"component": "agent", "instance": "agent-one"},
             "hello": {"component": "agent", "dependencies": []}}

    def __init__(self):
        self.calls = []
        self.fail = False

    def request(self, body, expect, *, timeout_ms):
        self.calls.append(body)
        if self.fail:
            raise TimeoutError("unknown outcome")
        op = body["op"]
        session = {"workload_id": "workload-one", "generation": 1,
                   "owner_id": "actor-" + hashlib.sha256(b"agent:agent-one").hexdigest(),
                   "phase": {"create": "ready", "run": "completed", "stop": "stopped"}[op],
                   "ownership": "released" if op == "stop" else "held", "job": None}
        if op == "run":
            n = body["params"]["n"]
            session["job"] = dict(body["params"], value=n*(n+1)*(2*n+1)//6)
        return {"schema": expect, "request_id": body["request_id"],
                "event": "completed" if op == "run" else "state_changed",
                "data": {"session": session}}


class HeadlessSDKTests(unittest.TestCase):
    def test_actual_toolclient_registration_shape_binds_owner(self):
        stub = Stub()
        client = ToolClient('/not-connected/core.sock', session_id='test',
                            local=stub.local, core={}, dependency_pins=[],
                            sequence_path='/not-connected/sequence', timeout_s=1,
                            max_line_bytes=65536, max_reply_bytes=65536)
        client.request = stub.request
        session = HeadlessSession(client).create()
        self.assertEqual(session['owner_id'],
                         'actor-' + hashlib.sha256(b'agent:agent-one').hexdigest())

    def test_only_embedded_sibling_definition_refs_resolve(self):
        generation = _resolve_reference("v0.2/headless_session.schema.json#/$defs/generation")
        self.assertEqual(generation["minimum"], 1)
        self.assertIsNone(_resolve_reference("https://example.invalid/schema#/$defs/generation"))
        self.assertIsNone(_resolve_reference("../headless_session.schema.json#/$defs/generation"))
        self.assertIsNone(_resolve_reference("v0.2/headless_session.schema.json#/$defs/missing"))

    def test_single_job_and_idempotent_local_close(self):
        client = Stub(); session = HeadlessSession(client)
        session.create(); self.assertEqual(session.run(10)["value"], 385)
        with self.assertRaises(HeadlessError): session.run(11)
        self.assertEqual(session.stop()["phase"], "stopped")
        session.stop(); self.assertEqual(len(client.calls), 3)

    def test_unknown_is_not_retried_but_known_identity_can_stop(self):
        client = Stub(); session = HeadlessSession(client); session.create()
        client.fail = True
        with self.assertRaises(TimeoutError): session.run(10)
        with self.assertRaises(HeadlessError): session.run(10)
        client.fail = False; session.stop()
        self.assertEqual([c["op"] for c in client.calls], ["create", "run", "stop"])

    def test_invalid_n_never_sent(self):
        client = Stub(); session = HeadlessSession(client); session.create()
        for n in (True, -1, 10001, 1.5):
            with self.assertRaises(ValueError): session.run(n)
        self.assertEqual(len(client.calls), 1)

    def test_client_consumes_accepted_before_terminal(self):
        local = {"component": "agent", "instance": "a"}
        core = {"component": "core", "instance": "c"}
        request = {"schema": "headless_request/v0.2", "request_id": "request-one",
                   "op": "create", "params": {"template": "headless-sumsq"}}
        session = {"workload_id": "workload-one", "generation": 1, "owner_id": "actor-one"}
        frames = [{"from": core, "to": local, "session_id": "s", "body": body} for body in (
            {"schema": "headless_event/v0.2", "request_id": "request-one",
             "event": "accepted", "data": {"op": "create", "session": dict(session, phase="starting")}},
            {"schema": "headless_event/v0.2", "request_id": "request-one",
             "event": "state_changed", "data": {"session": dict(session, phase="ready")}})]
        client = ToolClient.__new__(ToolClient)
        client._ready = True; client.session_id = "s"
        sent = []
        client.active = SimpleNamespace(_timeout_s=5, send=sent.append, recv=lambda: frames.pop(0))
        client._envelope = lambda body, key: {"from": local, "to": core, "body": body}
        client._reserve = lambda: None; client._accept_frame_event = lambda body: False
        result = client.request(request, "headless_event/v0.2", timeout_ms=1000)
        self.assertEqual(result["event"], "state_changed")
        self.assertEqual(len(sent), 1); self.assertEqual(frames, [])
