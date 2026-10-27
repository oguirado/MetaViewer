"""ARG-s_adapter-3: CLI polls share the wait-verify timeout budget."""

import contextlib
import io
import json
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest

from metaviewer_agents import mvctl
from test_mvctl_v02 import config, registration
from metaviewer_agents.envelope import make_envelope, validate_envelope


class MvctlTimeoutTests(unittest.TestCase):
    def run_wait(self, budget_ms, delays, *, verified=False):
        """Use the real CLI entry point and transport; time excludes setup."""
        with tempfile.TemporaryDirectory(prefix="mv-deadline-") as directory:
            path = Path(directory) / "core.sock"
            expectation = Path(directory) / "expectation.json"
            expectation.write_text(json.dumps({"type": "text_present", "text": "done"}))
            frame = {"schema": "frame_ref/v0.2", "surface_id": "surf-1",
                     "generation": 2, "tick": 11, "ts_ns": 55, "width": 8,
                     "height": 8, "format": "rgb24", "ramws_path": "/dev/shm/mv-frame",
                     "sha256": "a" * 64, "capture_us": 9}
            receipt = {"schema": "action_receipt/v0.2", "proposal_id": "p-1",
                       "executed_at_ns": 2000000, "after_frame": frame,
                       "verified": True, "verification": {"method": "pixel",
                       "detail": "region changed"}, "error": ""}
            trusted = Path(directory) / "config.json"
            trusted.write_text(json.dumps(config()))
            errors, calls = [], []
            second_reply_ready = threading.Event()
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(str(path))
                path.chmod(0o600)
                listener.listen()
                listener.settimeout(2)

                def serve():
                    try:
                        conn, _ = listener.accept()
                        with conn, conn.makefile("rb") as reader:
                            conn.settimeout(2)
                            hello = validate_envelope(json.loads(reader.readline(65537)))
                            self.assertEqual(hello["body"], registration("agent")["hello"])
                            response = make_envelope(
                                msg_id="hello", from_component="core", from_instance="core-1",
                                to_component="agent", to_instance="agent-1", session_id="sess-1",
                                seq=1, body=registration("core")["hello"])
                            conn.sendall((json.dumps(response) + "\n").encode())
                            for seq, delay in enumerate(delays, 1):
                                request = validate_envelope(json.loads(reader.readline(65537)))
                                call = request["body"]
                                calls.append(call)
                                time.sleep(delay)
                                if seq == 2:
                                    second_reply_ready.set()
                                body = {"schema": "mv_tool_result/v0.2",
                                        "request_id": call["request_id"], "op": "wait_verify"}
                                if verified and seq == len(delays):
                                    body.update(status="verified", receipt=receipt,
                                                focus_verified=True, input_mono_ns=1995000,
                                                frame_sha256="a" * 64)
                                else:
                                    body.update(status="pending", proposal_id="p-1",
                                                retry_after_ms=1)
                                reply = make_envelope(
                                    msg_id="reply", from_component="core", from_instance="core-1",
                                    to_component="agent", to_instance="agent-1",
                                    session_id="sess-1", seq=seq, body=body)
                                try:
                                    conn.sendall((json.dumps(reply) + "\n").encode())
                                except BrokenPipeError:
                                    return  # Expected when the client's budget expires.
                    except BaseException as error:
                        errors.append(error)

                thread = threading.Thread(target=serve, daemon=True)
                thread.start()
                out, err = io.StringIO(), io.StringIO()
                try:
                    started = time.monotonic()
                    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                        rc = mvctl.main([
                            "wait-verify", "--config", str(trusted), "--socket", str(path),
                            "--session-id", "sess-1", "--agent-instance", "agent-1",
                            "--core-instance", "core-1", "--timeout-ms", str(budget_ms),
                            "--max-line-bytes", "65536", "--max-reply-bytes", "65536",
                            "--proposal-id", "p-1", "--json-arg", str(expectation)])
                    elapsed = time.monotonic() - started
                    returned_before_second_reply = not second_reply_ready.is_set()
                finally:
                    thread.join(3)
                self.assertFalse(thread.is_alive(), "fake core did not stop")
                if errors:
                    raise errors[0]
            return (rc, elapsed, out.getvalue(), err.getvalue(), calls, receipt,
                    returned_before_second_reply)

    def test_two_delayed_pending_replies_share_budget(self):
        rc, elapsed, out, err, calls, _, before_reply = self.run_wait(200, [0.120, 0.120])
        self.assertEqual(rc, 2, err)
        self.assertEqual(out, "")
        self.assertEqual(json.loads(err)["code"], "timeout")
        self.assertEqual(len(calls), 2)
        self.assertLess(calls[1]["args"]["timeout_ms"], 100)
        print(f"T1 elapsed_ms={elapsed * 1000:.3f} rc={rc}")
        self.assertLess(elapsed, 0.250, "per-poll timeout exceeded cumulative budget")
        self.assertTrue(before_reply, "must time out before the over-budget reply arrives")

    def test_pending_then_verified_receipt_within_budget(self):
        rc, elapsed, out, err, calls, receipt, _ = self.run_wait(
            1000, [0.075, 0.075], verified=True)
        self.assertEqual(rc, 0, err)
        self.assertEqual(err, "")
        self.assertEqual(json.loads(out), receipt)
        self.assertEqual(len(calls), 2)
        self.assertLess(elapsed, 1)
        print(f"T2 elapsed_ms={elapsed * 1000:.3f} rc={rc}")


if __name__ == "__main__":
    unittest.main()
