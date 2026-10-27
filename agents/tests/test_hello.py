"""Hello exchange over an owner-only socket, including fail-closed pins."""

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_client import _FakeCore, _reply_bytes, _wrap
from metaviewer_agents.client import ClientError, CoreClient


class HelloTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[2]
        pins = json.loads((root / "deps.lock").read_text())["components"]
        self.pins = [{key: pin[key] for key in ("name", "version", "commit")}
                     for pin in pins]
        self.hello = {
            "schema": "hello/v0.2", "contract_version": "v0.2",
            "component": "agent", "component_version": "0.1.1",
            "component_commit": "0123456789abcdef0123456789abcdef01234567",
            "dependencies": copy.deepcopy(self.pins),
        }
        self.peer = dict(self.hello, component="core")
        self.new_channel()

    def new_channel(self):
        self.core = _FakeCore(self)
        self.client = CoreClient(self.core.path, timeout_s=2,
                                 max_line_bytes=65536, max_reply_bytes=65536)
        self.addCleanup(self.client.close)

    def handshake(self):
        return self.client.handshake(_wrap(self.hello),
                                     expected_peer=self.peer,
                                     dependency_pins=self.pins)

    def assert_terminal(self):
        self.assertFalse(self.client.connected)
        for operation in (self.client.connect, self.client.recv,
                          lambda: self.client.send(_wrap(self.hello, seq=2))):
            with self.assertRaises(ClientError) as caught:
                operation()
            self.assertEqual(caught.exception.code, "socket")

    def test_hello_v02_handshake_completes(self):
        self.assertFalse(self.client.connected)
        self.core.queue(_reply_bytes(self.peer))
        reply = self.handshake()
        self.assertEqual(reply["body"], self.peer)
        self.assertTrue(self.client.connected)
        self.assertEqual(self.client.next_seq, 2)
        sent, = self.core.received_envelopes()
        self.assertEqual(sent["schema"], "envelope/v0.2")
        self.assertEqual(sent["body"], self.hello)
        self.assertEqual(sent["body"]["dependencies"], self.pins)
        # Connecting again preserves the accepted channel without another hello.
        self.client.connect()
        self.assertTrue(self.client.connected)
        self.assertEqual(self.core.received_count(), 1)

    def test_pin_mismatch_version_error_before_any_verb(self):
        self.hello["dependencies"][0]["commit"] = "f" * 40
        with self.assertRaises(ClientError) as caught:
            self.handshake()
        self.assertEqual(caught.exception.code, "version")
        self.assert_terminal()
        self.assertEqual(self.core.received_count(), 0)

    def test_unknown_hello_version_terminal(self):
        raw = _reply_bytes(self.peer).replace(b"hello/v0.2", b"hello/v9.9")
        self.core.queue(raw)
        with self.assertRaises(ClientError) as caught:
            self.handshake()
        self.assertEqual(caught.exception.code, "unknown_version")
        self.assert_terminal()
        self.assertEqual(self.core.received_count(), 1)

    def test_peer_pin_mismatch_is_terminal(self):
        wrong = copy.deepcopy(self.peer)
        wrong["component_commit"] = "f" * 40
        self.core.queue(_reply_bytes(wrong))
        with self.assertRaises(ClientError) as caught:
            self.handshake()
        self.assertEqual(caught.exception.code, "version")
        self.assert_terminal()
        self.assertEqual(self.core.received_count(), 1)

    def test_reply_endpoint_and_session_are_bound(self):
        for index, (key, value) in enumerate((("session_id", "other"),
                           ("from", {"component": "core", "instance": "other"}),
                           ("to", {"component": "agent", "instance": "other"}))):
            with self.subTest(key=key):
                if index:
                    self.new_channel()
                reply = json.loads(_reply_bytes(self.peer))
                reply[key] = value
                self.core.queue(json.dumps(reply).encode() + b"\n")
                with self.assertRaises(ClientError) as caught:
                    self.handshake()
                self.assertEqual(caught.exception.code, "version")
                self.assert_terminal()


if __name__ == "__main__":
    unittest.main()
