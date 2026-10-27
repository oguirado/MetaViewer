"""CLI tool-protocol integration against an owner-only fake core socket.

[TARGET, unit decision] --v02 selects tool verbs with explicit identity/caps;
--json-arg holds a proposal for propose or an expectation for wait-verify.
"""

import contextlib
import copy
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from metaviewer_agents.envelope import make_envelope, validate_envelope

DIGEST = "a" * 64
FRAME = {"schema": "frame_ref/v0.2", "surface_id": "surf-1",
         "generation": 2, "tick": 11, "ts_ns": 55, "width": 8,
         "height": 8, "format": "rgb24", "ramws_path": "/dev/shm/mv-frame",
         "sha256": DIGEST, "capture_us": 9}
OBSERVATION = {"schema": "observation/v0.2", "frame_ref": FRAME}
EXPECTATION = {"type": "text_present", "text": "done"}
PROPOSAL = {"schema": "action_proposal/v0.2", "proposal_id": "p-1",
            "surface_id": "surf-1",
            "based_on_frame": {"sha256": DIGEST, "generation": 2},
            "action": {"type": "click", "x": 4, "y": 5, "button": "left"},
            "expectation": EXPECTATION,
            "budget": {"max_ms": 500, "max_retries": 1}}
VERDICT = {"schema": "action_verdict/v0.2", "proposal_id": "p-1",
           "decision": "admitted", "core_seq": 7}
RECEIPT = {"schema": "action_receipt/v0.2", "proposal_id": "p-1",
           "executed_at_ns": 2000000, "after_frame": FRAME, "verified": True,
           "verification": {"method": "pixel", "detail": "region changed"},
           "error": ""}


class MvctlV02Tests(unittest.TestCase):
    @contextlib.contextmanager
    def core(self, replies):
        # A short private directory also keeps AF_UNIX paths below the OS cap.
        with tempfile.TemporaryDirectory(prefix="mvctl-") as directory:
            path = Path(directory) / "core.sock"
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(str(path))
                path.chmod(0o600)
                listener.listen()
                listener.settimeout(5)
                calls, errors = [], []

                def serve():
                    try:
                        for builders in replies:
                            conn, _ = listener.accept()
                            with conn:
                                conn.settimeout(5)
                                with conn.makefile("rb") as reader:
                                    for builder in builders:
                                        raw = reader.readline(65537)
                                        self.assertTrue(raw.endswith(b"\n"))
                                        request = validate_envelope(json.loads(raw))
                                        calls.append(request)
                                        body = builder(request["body"])
                                        reply = make_envelope(
                                            msg_id="reply", from_component="core",
                                            from_instance="core-1", to_component="agent",
                                            to_instance="agent-1", session_id="sess-1",
                                            seq=len(calls), body=body)
                                        if getattr(self, "_unknown_reply", False):
                                            reply["body"]["schema"] = "mv_tool_result/v9.9"
                                        conn.sendall((json.dumps(reply) + "\n").encode())
                                    self.assertEqual(reader.read(1), b"")
                    except BaseException as error:
                        errors.append(error)

                thread = threading.Thread(target=serve, daemon=True)
                thread.start()
                try:
                    yield path, calls
                finally:
                    thread.join(6)
                    self.assertFalse(thread.is_alive(), "fake core did not stop")
                    if errors:
                        raise errors[0]

    def cli(self, socket_path, command, *flags):
        return subprocess.run(
            [sys.executable, "-m", "metaviewer_agents.mvctl", "--v02", command,
             "--socket", str(socket_path), "--session-id", "sess-1",
             "--agent-instance", "agent-1", "--core-instance", "core-1",
             "--timeout-ms", "2000", "--max-line-bytes", "65536",
             "--max-reply-bytes", "65536", *flags],
            env=dict(os.environ, PYTHONPATH=str(ROOT)), capture_output=True,
            text=True, timeout=8)

    def line(self, result, rc):
        self.assertEqual(result.returncode, rc, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertTrue(result.stdout.endswith("\n"))
        self.assertEqual(result.stdout.count("\n"), 1)
        return json.loads(result.stdout)

    @staticmethod
    def reply(op, **fields):
        return lambda call: {"schema": "mv_tool_result/v0.2",
                             "request_id": call["request_id"], "op": op, **fields}

    def test_observe_propose_wait_verify_loop(self):
        replies = [[self.reply("observe", status="ok", observation=OBSERVATION)],
                   [self.reply("propose", status="admitted", verdict=VERDICT)],
                   [self.reply("wait_verify", status="pending", proposal_id="p-1",
                               retry_after_ms=1),
                    self.reply("wait_verify", status="verified", receipt=RECEIPT,
                               focus_verified=True, input_mono_ns=1995000,
                               frame_sha256=DIGEST)]]
        with self.core(replies) as (path, calls):
            observation = self.line(self.cli(path, "observe", "--surface-id", "surf-1"), 0)
            self.assertEqual(observation, OBSERVATION)
            proposal = copy.deepcopy(PROPOSAL)
            frame = observation["frame_ref"]
            proposal["based_on_frame"] = {key: frame[key] for key in ("sha256", "generation")}
            payload = path.parent / "request.json"
            payload.write_text(json.dumps(proposal))
            verdict = self.line(self.cli(path, "propose", "--json-arg", str(payload)), 0)
            self.assertEqual(verdict, VERDICT)
            payload.write_text(json.dumps(EXPECTATION))
            receipt = self.line(self.cli(path, "wait-verify", "--proposal-id",
                                         verdict["proposal_id"], "--json-arg", str(payload)), 0)
            self.assertEqual(receipt, RECEIPT)
        self.assertEqual([call["body"]["op"] for call in calls],
                         ["observe", "propose", "wait_verify", "wait_verify"])
        self.assertEqual([call["seq"] for call in calls], [1, 1, 1, 2])
        self.assertEqual(calls[0]["body"]["args"], {"surface_id": "surf-1"})
        self.assertEqual(calls[1]["body"]["args"], {"proposal": proposal})
        self.assertEqual(calls[2]["body"]["args"]["proposal_id"], "p-1")
        self.assertEqual(calls[3]["body"]["args"]["proposal_id"], "p-1")
        self.assertEqual(len({call["nonce"] for call in calls}), len(calls))
        self.assertEqual(len({call["body"]["request_id"] for call in calls}), len(calls))

    def test_stale_frame_exit_one_with_reason(self):
        with self.core([[self.reply("propose", status="refused",
                                    reason_code="STALE_FRAME", detail="stale")]]) as (path, calls):
            payload = path.parent / "proposal.json"
            payload.write_text(json.dumps(PROPOSAL))
            result = self.line(self.cli(path, "propose", "--json-arg", str(payload)), 1)
            self.assertEqual(result, {"verdict": "refuse", "reason_code": "STALE_FRAME"})
        self.assertEqual(len(calls), 1, "refusal must not retry")

    def test_unknown_version_exit_two_stdout_empty(self):
        # Correlated, otherwise valid result: version is the only rejection cause.
        for command, op, fields in (
            ("observe", "observe", {"status": "ok", "observation": OBSERVATION}),
            ("propose", "propose", {"status": "admitted", "verdict": VERDICT}),
            ("wait-verify", "wait_verify", {"status": "verified", "receipt": RECEIPT,
              "focus_verified": True, "input_mono_ns": 1995000, "frame_sha256": DIGEST}),
        ):
            with self.subTest(command=command):
                # The fake intentionally bypasses the encoder for this invalid frame.
                with self.core([[self.reply(op, **fields)]]) as (path, calls):
                    payload = path.parent / "request.json"
                    payload.write_text(json.dumps(PROPOSAL if command == "propose" else EXPECTATION))
                    flags = (["--surface-id", "surf-1"] if command == "observe" else
                             ["--json-arg", str(payload)] +
                             (["--proposal-id", "p-1"] if command == "wait-verify" else []))
                    # Set the fake's outgoing discriminator after its valid construction.
                    self._unknown_reply = True
                    result = self.cli(path, command, *flags)
                    self._unknown_reply = False
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertEqual(result.stdout, "")
                    self.assertEqual(json.loads(result.stderr)["code"], "unknown_version")
                self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
