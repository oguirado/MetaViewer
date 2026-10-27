"""U14 process boundary: malformed peers cannot mutate the real core archive.

[TARGET, unit decision] Foreign-UID policy is already exercised against kernel
credentials in core/tests/socket_hostile.rs and handshake.rs. This unprivileged
journey covers both handshake and authenticated-stream decoding plus recovery.
Mutations: remove Envelope's deny_unknown_fields in wire/mod.rs -> the outer
property is accepted; increase MAX_FRAME_BYTES above the injected payload ->
the oversized peer waits instead of closing; remove the unknown-version guard
in decode_envelope_with_limits -> foreign-schema hello can authenticate.
"""
import hashlib
import json
import socket
import unittest

from test_e2e_startup import build_core, core_process


def archive_hashes(root):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob("*") if path.is_file()}


class IpcPolicyEndToEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = build_core()

    def test_malformed_frames_close_before_state_change_and_valid_peer_recovers(self):
        with core_process(self.binary) as core:
            core.ready()
            initial = json.loads(core.exchange(core.envelope(nonce="initial-readiness")))
            self.assertEqual(initial["body"], core.config["core"]["hello"])
            before = archive_hashes(core.state)
            self.assertTrue(before, "E2E_IPC: journal must exist before attack")
            for authenticated in (False, True):
                for mutation in ("unknown-envelope", "unknown-body", "version", "oversized"):
                    with self.subTest(authenticated=authenticated, mutation=mutation):
                        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
                            peer.settimeout(3)
                            peer.connect(str(core.path))
                            nonce = f"{authenticated}-{mutation}"
                            if authenticated:
                                peer.sendall((json.dumps(core.envelope(nonce="auth-" + nonce)) + "\n").encode())
                            with peer.makefile("rb") as reader:
                                if authenticated:
                                    hello = json.loads(reader.readline((1 << 20) + 1))
                                    self.assertEqual(hello["body"], core.config["core"]["hello"])
                                bad = core.envelope(nonce="attack-" + nonce)
                                if authenticated:
                                    bad["seq"] = 2
                                    bad["body"] = {"schema": "mv_tool_call/v0.2", "request_id": nonce,
                                                   "op": "observe", "args": {"surface_id": "absent"}}
                                if mutation == "unknown-envelope":
                                    bad["unexpected_property"] = True
                                elif mutation == "unknown-body":
                                    bad["body"]["unexpected_property"] = True
                                elif mutation == "version":
                                    bad["schema"] = "envelope/v9.9"
                                raw = (json.dumps(bad) + "\n").encode()
                                if mutation == "oversized":
                                    # No newline: limit must close before parse/idle timeout.
                                    raw = b" " * ((1 << 20) + 1)
                                try:
                                    peer.sendall(raw)
                                    reply = reader.readline((1 << 20) + 1)
                                except (BrokenPipeError, ConnectionResetError):
                                    reply = b""
                                self.assertEqual(reply, b"", "E2E_IPC: malformed input received a reply")
                        self.assertIsNone(core.process.poll(), core.diagnostics())
                        recovery = json.loads(core.exchange(core.envelope(nonce="recover-" + nonce)))
                        self.assertEqual(recovery["body"], core.config["core"]["hello"])
                        self.assertEqual(archive_hashes(core.state), before,
                                         "E2E_IPC: malformed peer changed durable authority")


if __name__ == "__main__":
    unittest.main()
