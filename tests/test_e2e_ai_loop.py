"""U07: fake provider CLI -> real core observe/admit/dispatch/native verify.

[TARGET, unit decision] The adapter seam publishes immutable RAM RGB24 and
native evidence; the provider controls proposals only. This qualifies a hosted
loop, not the U26 native Holdings/browser tasks. 9/10 is the [TARGET] boundary.
Mutation: change verified_native_fields' `if !verified.verified {` in
core/src/serve/tools.rs to `if true {` -> the clean batch cannot verify.
Mutation: remove the stale-frame refusal in admission/mod.rs -> the negative
batch dispatches input instead of returning STALE_FRAME.
"""
import copy
import hashlib
import json
import socket
import subprocess
import sys
import tempfile
import unittest

from test_e2e_startup import ROOT, build_core, core_process


class Peer:
    def __init__(self, core, role):
        self.core = core
        self.registration = next(r for r in core.config["peers"]
                                 if r["endpoint"]["component"] == role)
        self.seq = 0
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(5)
        self.socket.connect(str(core.path))
        self.reader = self.socket.makefile("rb")
        self.send(self.registration["hello"])
        hello = self.receive()
        if hello != core.config["core"]["hello"]:
            self.close()
            raise AssertionError("E2E_PEER: authenticated core hello mismatch")

    def send(self, body):
        self.seq += 1
        role = self.registration["endpoint"]["component"]
        nonce = role + "-loop-" + str(self.seq)
        envelope = {"schema": "envelope/v0.2", "msg_id": nonce, "ts_ns": 0,
                    "from": self.registration["endpoint"],
                    "to": self.core.config["core"]["endpoint"],
                    "session_id": self.core.config["session_id"],
                    "seq": self.seq, "nonce": nonce, "body": body}
        self.socket.sendall((json.dumps(envelope) + "\n").encode())
        return nonce

    def receive(self):
        raw = self.reader.readline((1 << 20) + 1)
        if not raw.endswith(b"\n"):
            raise AssertionError("E2E_PEER: core closed before reply: " + self.core.diagnostics())
        return json.loads(raw)["body"]

    def close(self):
        self.reader.close()
        self.socket.close()


def require_batch(outcomes):
    if len(outcomes) != 10 or sum(outcomes) < 9:
        raise AssertionError("E2E_AI_BATCH: fewer than 9 verified actions in 10 attempts")


class AiLoopEndToEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = build_core()

    def run_batch(self, stale_count):
        with core_process(self.binary) as core:
            core.ready()
            daemon = Peer(core, "daemon")
            self.addCleanup(daemon.close)
            surface = json.loads((ROOT / "contracts/examples/v0.2/surface.valid.json").read_text())
            surface["geometry"] = {"w": 2, "h": 1}
            daemon.send({"schema": "surface_event/v0.2", "event": "created", "data": {"surface": surface}})
            publications = []
            try:
                def publish(generation):
                    # Every publication is immutable for the lifetime of this core.
                    ram = tempfile.NamedTemporaryFile(prefix="mv-ai-loop-", dir="/dev/shm")
                    publications.append(ram)
                    data = bytes([255, 0, 0, 0, 255, 0]) if generation % 2 else bytes([0, 0, 255, 0, 255, 0])
                    ram.write(data)
                    ram.flush()
                    frame = {"schema": "frame_ref/v0.2", "surface_id": surface["surface_id"],
                             "generation": generation, "tick": generation, "ts_ns": generation * 1000000,
                             "width": 2, "height": 1, "format": "rgb24", "ramws_path": ram.name,
                             "sha256": hashlib.sha256(data).hexdigest(), "capture_us": 1}
                    daemon.send(frame)
                    return frame

                def barrier():
                    daemon.send({"schema": "mv_tool_call/v0.2", "request_id": "barrier",
                                 "op": "list", "args": {"cursor": None, "limit": 1}})
                    self.assertEqual(daemon.receive()["reason_code"], "POLICY",
                                     "unexpected daemon input before ordered barrier")

                frame = publish(2)
                barrier()
                agent = Peer(core, "agent")
                self.addCleanup(agent.close)
                outcomes = []
                for index in range(10):
                    agent.send({"schema": "mv_tool_call/v0.2", "request_id": f"observe-{index}",
                                "op": "observe", "args": {"surface_id": surface["surface_id"]}})
                    observed = agent.receive()
                    self.assertEqual(observed["status"], "ok")
                    observation = observed["observation"]
                    self.assertEqual(observation["frame_ref"], frame)
                    command = [sys.executable, str(ROOT / "tests/e2e/ai-provider.py"),
                               "--proposal-id", f"loop-{index}"]
                    stale = index < stale_count
                    if stale:
                        command.append("--stale")
                    provider = subprocess.run(command, input=json.dumps(observation),
                                              capture_output=True, text=True, timeout=5)
                    self.assertEqual(provider.returncode, 0, provider.stderr)
                    proposal = json.loads(provider.stdout)
                    agent.send(proposal)
                    verdict = agent.receive()
                    self.assertEqual(verdict["proposal_id"], proposal["proposal_id"])
                    if stale:
                        self.assertEqual(verdict["decision"], "refused")
                        self.assertEqual(verdict["reason_code"], "STALE_FRAME")
                        barrier()  # Any mistakenly dispatched input fails this ordering check.
                        outcomes.append(False)
                        continue
                    self.assertEqual(verdict["decision"], "admitted")
                    dispatched = daemon.receive()
                    self.assertEqual(dispatched["op"], "input")
                    self.assertEqual(dispatched["params"]["proposal_id"], proposal["proposal_id"])
                    before = copy.deepcopy(frame)
                    frame = publish(before["generation"] + 1)
                    receipt = json.loads((ROOT / "contracts/examples/v0.2/action_receipt.valid.native-key.json").read_text())
                    receipt.update(proposal_id=proposal["proposal_id"], after_frame=frame,
                                   executed_at_ns=before["ts_ns"] + 100000)
                    receipt["native_evidence"].update(input_ts_ns=before["ts_ns"] + 100000,
                                                       input_mono_ns=1000000000 + before["ts_ns"] + 100000)
                    daemon.send(receipt)
                    barrier()
                    forwarded = agent.receive()
                    self.assertEqual(forwarded, receipt,
                                     "executor receipt must be forwarded without a verified claim")
                    wait_id = agent.send({"schema": "mv_tool_call/v0.2", "request_id": f"wait-{index}",
                                "op": "wait_verify", "args": {"proposal_id": proposal["proposal_id"],
                                                              "timeout_ms": 1000}})
                    settled = agent.receive()
                    self.assertEqual(settled["status"], "verified", settled)
                    self.assertIs(settled["receipt"]["verified"], True)
                    self.assertEqual(settled["receipt"]["proposal_id"], proposal["proposal_id"])
                    self.assertEqual(settled["request_id"], wait_id)
                    self.assertIs(settled["focus_verified"], True)
                    self.assertEqual(settled["frame_sha256"], frame["sha256"])
                    outcomes.append(True)
                return outcomes
            finally:
                for publication in publications:
                    publication.close()
                daemon.close()

    def test_ten_run_loop_and_stale_attempts_cross_the_batch_boundary(self):
        clean = self.run_batch(0)
        self.assertEqual(clean, [True] * 10)
        require_batch(clean)
        edge = self.run_batch(1)
        self.assertEqual(edge, [False] + [True] * 9)
        require_batch(edge)
        refused = self.run_batch(2)
        self.assertEqual(refused, [False] * 2 + [True] * 8)
        with self.assertRaisesRegex(AssertionError, "E2E_AI_BATCH"):
            require_batch(refused)


if __name__ == "__main__":
    unittest.main()
