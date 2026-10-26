"""Client state machine terminal absorbing states and security boundary tests (SW-0147 I-ABS)."""

import os
import socket
import stat
import tempfile
import time
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metaviewer_agents.client import ClientError, CoreClient
from metaviewer_agents.envelope import make_envelope


def _sample_envelope(seq=1, from_inst="i1"):
    return make_envelope(
        msg_id="m1",
        from_component="agent",
        from_instance=from_inst,
        to_component="core",
        to_instance="c1",
        session_id="s1",
        seq=seq,
        body={
            "schema": "action_proposal/v0.1",
            "proposal_id": "p1",
            "surface_id": "surf1",
            "based_on_frame": {"sha256": "0" * 64, "generation": 1},
            "action": {"type": "click", "x": 0, "y": 0, "button": "left"},
            "expectation": {"type": "text_present", "text": "ok"},
            "budget": {"max_ms": 100, "max_retries": 0},
        },
        nonce="a" * 32,
        ts_ns=1000,
    )


class ClientStateMachineTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.sock_dir = Path(self.tmpdir.name) / "sock_dir"
        self.sock_dir.mkdir(mode=0o700)
        self.sock_path = str(self.sock_dir / "core.sock")

        # Create UNIX domain socket server
        self.server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server_sock.bind(self.sock_path)
        os.chmod(self.sock_path, 0o600)
        self.server_sock.listen(1)
        self.clients = []

    def tearDown(self):
        for c in self.clients:
            c.close()
        self.server_sock.close()
        self.tmpdir.cleanup()

    def test_absorbing_terminal_state_after_failures(self):
        client = CoreClient(
            self.sock_path, timeout_s=0.2, max_line_bytes=4096, max_reply_bytes=4096
        )
        self.clients.append(client)
        client.connect()
        conn, _ = self.server_sock.accept()

        conn.close()

        with self.assertRaises(ClientError) as caught:
            client.recv()
        self.assertEqual(caught.exception.code, "socket")
        self.assertTrue(client._terminal)
        self.assertIsNone(client._sock)

        for op in (
            lambda: client.recv(),
            lambda: client.send(_sample_envelope()),
            lambda: client.connect(),
        ):
            with self.assertRaises(ClientError) as caught:
                op()
            self.assertEqual(caught.exception.code, "socket")

    def test_identity_pinning_after_first_send(self):
        client = CoreClient(
            self.sock_path, timeout_s=0.2, max_line_bytes=4096, max_reply_bytes=4096
        )
        self.clients.append(client)
        client.connect()
        conn, _ = self.server_sock.accept()

        client.send(_sample_envelope(seq=1, from_inst="i1"))

        changed_env = _sample_envelope(seq=2, from_inst="CHANGED_INSTANCE")
        with self.assertRaises(ClientError) as caught:
            client.send(changed_env)
        self.assertEqual(caught.exception.code, "schema")
        self.assertFalse(client._terminal)

        conn.close()

    def test_sequence_gap_refused_and_consumes_nothing(self):
        client = CoreClient(
            self.sock_path, timeout_s=0.2, max_line_bytes=4096, max_reply_bytes=4096
        )
        self.clients.append(client)
        client.connect()
        conn, _ = self.server_sock.accept()

        gap_env = _sample_envelope(seq=99)
        with self.assertRaises(ClientError) as caught:
            client.send(gap_env)
        self.assertEqual(caught.exception.code, "schema")
        self.assertEqual(client.next_seq, 1)

        conn.close()

    def test_recv_monotonic_deadline_fake_slow_peer(self):
        client = CoreClient(
            self.sock_path, timeout_s=0.1, max_line_bytes=4096, max_reply_bytes=4096
        )
        self.clients.append(client)
        client.connect()
        conn, _ = self.server_sock.accept()

        client.send(_sample_envelope(seq=1))

        conn.sendall(b'{"schema": "envelop')
        time.sleep(0.05)
        conn.sendall(b'e/v0.1"')

        t0 = time.monotonic()
        with self.assertRaises(ClientError) as caught:
            client.recv()
        t1 = time.monotonic()

        self.assertEqual(caught.exception.code, "timeout")
        self.assertTrue(t1 - t0 >= 0.08)
        self.assertTrue(client._terminal)

        conn.close()

    def test_endpoint_checks_reject_unsecure_modes_and_symlinks(self):
        sym_dir = Path(self.tmpdir.name) / "sym_dir"
        sym_dir.symlink_to(self.sock_dir)
        sym_sock_path = str(sym_dir / "core.sock")

        client = CoreClient(
            sym_sock_path, timeout_s=0.2, max_line_bytes=4096, max_reply_bytes=4096
        )
        self.clients.append(client)
        with self.assertRaises(ClientError) as caught:
            client.connect()
        self.assertEqual(caught.exception.code, "socket")

        os.chmod(self.sock_dir, 0o777)
        client2 = CoreClient(
            self.sock_path, timeout_s=0.2, max_line_bytes=4096, max_reply_bytes=4096
        )
        self.clients.append(client2)
        with self.assertRaises(ClientError) as caught:
            client2.connect()
        self.assertEqual(caught.exception.code, "socket")


if __name__ == "__main__":
    unittest.main()
