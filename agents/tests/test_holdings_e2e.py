"""Hosted AC-05 loop: real release core, deterministic Holdings executor.

[TARGET, unit decision] H4's closed observation wire uses owner-only canonical
STATE sidecars, not an observation.state member. A separate bootstrap input
primes the core's pending-input-only ground-truth intake before each measured
trial. Bootstrap is excluded from trial dispatch and latency counts. No display,
live capsule, network, planner service or daemon binary is required.
"""

import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import ExitStack
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agents"))

from metaviewer_agents import tools
from metaviewer_agents.client import ToolClient
from metaviewer_agents.envelope import make_envelope
from metaviewer_agents.loop_trials import run_holdings_trials, validate_report
from metaviewer_agents.planner import plan_holdings_step
from metaviewer_agents.verify import build_proposal


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def registration(component):
    return {"endpoint": {"component": component, "instance": component + "-e2e"},
            "hello": {"schema": "hello/v0.2", "contract_version": "v0.2",
                      "component": component,
                      "component_version": (ROOT / "VERSION").read_text().strip(),
                      "component_commit": "0123456789abcdef0123456789abcdef01234567",
                      "dependencies": []}}


class HoldingsCapsule:
    """Execute only core-issued input; forward every tool reply unmodified."""

    surface_id = "surface-holdings"

    def __init__(self, case, binary, stack, fault):
        self.case, self.fault = case, fault
        self.ops, self.proposals, self.dispatches, self.replies = [], [], [], []
        self.seq = 0
        self.directory = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="ac05-")))
        self.shm = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="ac05-", dir="/dev/shm")))
        runtime = self.directory / "runtime"
        runtime.mkdir(mode=0o700)
        config = {"session_id": "holdings-e2e", "core": registration("core"),
                  "peers": [registration("daemon"), registration("agent")]}
        config_file = self.directory / "config.json"
        config_file.write_text(json.dumps(config))
        self.artifacts = self.directory / "state/metaviewer/sessions/holdings-e2e/artifacts"
        self.log = stack.enter_context(tempfile.TemporaryFile())
        process = subprocess.Popen([binary], cwd=ROOT, stdout=self.log, stderr=self.log,
                                   env=dict(os.environ, MV_CORE_CONFIG=str(config_file),
                                            XDG_RUNTIME_DIR=str(runtime),
                                            XDG_STATE_HOME=str(self.directory / "state")))

        def stop():
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)

        stack.callback(stop)
        path = runtime / "metaviewer/core.sock"
        deadline = time.monotonic() + 10
        while not path.exists():
            if process.poll() is not None or time.monotonic() >= deadline:
                self.log.seek(0)
                raise AssertionError("core startup: " + self.log.read().decode())
            time.sleep(0.01)
        self.daemon = stack.enter_context(socket.socket(socket.AF_UNIX, socket.SOCK_STREAM))
        self.daemon.settimeout(5)
        self.daemon.connect(str(path))
        self.reader = stack.enter_context(self.daemon.makefile("rb"))
        self.send(registration("daemon")["hello"])
        case.assertEqual(self.receive(), registration("core")["hello"])
        self.client = stack.enter_context(ToolClient(
            path, session_id="holdings-e2e", local=registration("agent"),
            core=registration("core"), dependency_pins=[],
            sequence_path=self.directory / "sequence", timeout_s=5,
            max_line_bytes=65536, max_reply_bytes=65536))
        surface = json.loads((ROOT / "contracts/examples/v0.2/surface.valid.json").read_text())
        surface.update(surface_id=self.surface_id, profile_id="holdings-v0.2")
        self.send({"schema": "surface_event/v0.2", "event": "created",
                   "data": {"surface": surface}})
        self.before_bytes = canonical({"meta": {"tick": 3}, "nodes": {"level": 1}})
        self.before = self.frame(1, 3, self.before_bytes)
        self.publish(self.before)
        self.barrier()
        # Intake requires a dispatched pending input; settle this primer as false.
        action, expectation = plan_holdings_step(self.observation(self.before, digest(self.before_bytes)))
        primer = build_proposal(self.before, proposal_id="bootstrap", action=action,
                                expectation=expectation, max_ms=5000)
        tools.propose(primer, client=self.client, timeout_ms=5000)
        case.assertEqual(self.receive()["op"], "input")
        self.send(self.observation(self.before, digest(self.before_bytes)))
        self.send(self.receipt("bootstrap", self.before))
        self.barrier()
        with case.assertRaises(tools.VerificationFailed):
            tools.wait_verify("bootstrap", expectation, 5000, client=self.client,
                              surface_id=self.surface_id)

    def send(self, body):
        self.seq += 1
        envelope = make_envelope(msg_id=f"daemon-{self.seq}", from_component="daemon",
                                 from_instance="daemon-e2e", to_component="core",
                                 to_instance="core-e2e", session_id="holdings-e2e",
                                 seq=self.seq, body=body)
        self.daemon.sendall(json.dumps(envelope).encode() + b"\n")

    def receive(self):
        raw = self.reader.readline(65537)
        self.case.assertTrue(raw.endswith(b"\n"), raw)
        return json.loads(raw)["body"]

    def barrier(self):
        self.send({"schema": "mv_tool_call/v0.2", "request_id": f"barrier-{self.seq}",
                   "op": "list", "args": {"cursor": None, "limit": 1}})
        self.case.assertEqual(self.receive()["reason_code"], "POLICY")

    def frame(self, generation, tick, state):
        path = self.shm / f"frame-{generation}"
        pixels = bytes([generation]) * 12
        path.write_bytes(pixels)
        path.chmod(0o600)
        sidecar = self.shm / (".state-" + path.name)
        sidecar.write_bytes(state)
        sidecar.chmod(0o600)
        return {"schema": "frame_ref/v0.2", "surface_id": self.surface_id,
                "generation": generation, "tick": tick, "ts_ns": generation * 1000000,
                "width": 2, "height": 2, "format": "rgb24", "ramws_path": str(path),
                "sha256": digest(pixels), "capture_us": 1}

    def publish(self, frame):
        self.send({"schema": "surface_event/v0.2", "event": "frame_ready",
                   "data": {"frame_ref": frame}})

    def observation(self, frame, sha):
        return {"schema": "observation/v0.2", "frame_ref": frame,
                "ground_truth": {"source": "holdings_lane", "state_sha256": sha,
                                 "tick": frame["tick"]}}

    def receipt(self, proposal_id, frame):
        return {"schema": "action_receipt/v0.2", "proposal_id": proposal_id,
                "executed_at_ns": 1500000, "after_frame": frame, "verified": False,
                "verification": {"method": "pixel", "detail": "executor capture only"},
                "native_evidence": {"surface_id": self.surface_id,
                                    "input_mono_ns": 1500000, "input_ts_ns": 1500000},
                "error": ""}

    def request(self, body, expect, *, timeout_ms):
        op = body["op"]
        self.ops.append(op)
        if op == "observe":
            self.started = time.perf_counter_ns()
        result = self.client.request(body, expect, timeout_ms=timeout_ms)
        if op == "propose":
            self.case.assertEqual(result["status"], "admitted", result)
            proposal = copy.deepcopy(body["args"]["proposal"])
            self.proposals.append(proposal)
            dispatched = self.receive()
            self.case.assertEqual(dispatched["op"], "input", dispatched)
            self.case.assertEqual(dispatched["params"]["proposal_id"], proposal["proposal_id"])
            self.case.assertEqual(dispatched["params"]["action"], proposal["action"])
            self.dispatches.append(dispatched)
            # Pin both witnesses while this input is pending.
            self.send(self.observation(self.before, digest(self.before_bytes)))
            changed = canonical({"meta": {"tick": 5}, "nodes": {"level": 2}})
            state = self.before_bytes if self.fault in ("STATE_MISMATCH", "unchanged") else changed
            tick = 99 if self.fault == "fabricated_tick" else 5
            self.after = self.frame(2, tick, state)
            self.publish(self.after)
            self.send(self.observation(self.after, digest(changed if self.fault == "STATE_MISMATCH" else state)))
            if self.fault == "STATE_MISMATCH":
                refusal = self.receive()
                self.case.assertEqual(refusal["decision"], "refused", refusal)
                self.case.assertEqual(refusal["reason_code"], "POLICY")
            self.send(self.receipt(proposal["proposal_id"], self.after))
            self.barrier()
            if self.fault is None:
                for raw in (self.before_bytes, changed):
                    self.case.assertEqual((self.artifacts / digest(raw)).read_bytes(), raw)
        if op == "wait_verify":
            self.latency_ms = (time.perf_counter_ns() - self.started) / 1000000
            self.replies.append(copy.deepcopy(result))
            settled = self.client._receipts[body["args"]["proposal_id"]]
            self.settled = copy.deepcopy(settled)
        return result


class HoldingsE2ETests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix="ac05-release-")
        cls.addClassCleanup(cls.build.cleanup)
        cargo = shutil.which(os.environ.get("CARGO", "cargo"))
        if cargo is None:
            raise RuntimeError("AUSENTE — cargo required for offline release build")
        target = os.environ.get("CARGO_TARGET_DIR", cls.build.name)
        result = subprocess.run([cargo, "build", "--offline", "--release", "--locked",
                                 "--bin", "metaviewer-core"], cwd=ROOT,
                                env=dict(os.environ, CARGO_TARGET_DIR=target),
                                capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise RuntimeError(result.stderr)
        cls.binary = str(Path(target).resolve() / "release/metaviewer-core")

    def scenario(self, faults, expected_verified):
        clients = []
        with ExitStack() as lifetime:
            active = lifetime.enter_context(ExitStack())

            def factory(trial, kind):
                self.assertEqual(kind, "holdings")
                active.close()
                capsule = HoldingsCapsule(self, self.binary, active, faults[trial - 1])
                clients.append(capsule)
                return capsule

            # Select the repository's deterministic local planner explicitly.
            env = {k: v for k, v in os.environ.items()
                   if k not in ("MV_WENDER_PLANNER_CMD", "MV_WENDER_ROOT")}
            with patch.dict(os.environ, env, clear=True):
                report = run_holdings_trials(client_factory=factory, planner=plan_holdings_step,
                                             trials=10, min_verified=9, timeout_ms=5000,
                                             surface_id=HoldingsCapsule.surface_id)
            self.assertEqual(validate_report(report, kind="holdings"), report)
            self.assertEqual(report["verified"], expected_verified)
            self.assertEqual(report["pass"], expected_verified >= 9)
            for row, client, fault in zip(report["results"], clients, faults):
                with self.subTest(trial=row["trial"], fault=fault):
                    self.assertEqual(client.ops, ["observe", "propose", "wait_verify"])
                    self.assertEqual(len(client.dispatches), 1)
                    proposal, = client.proposals
                    self.assertEqual(proposal["action"]["type"], "click")
                    self.assertEqual(proposal["expectation"]["type"], "state_sha256_change")
                    self.assertEqual(proposal["expectation"]["before"], digest(client.before_bytes))
                    self.assertEqual(row["verified"], fault is None)
                    self.assertEqual(row["witness_present"], fault is None)
                    self.assertEqual(client.settled["verified"], fault is None)
                    self.assertEqual(client.settled["verification"]["method"], "state_sha256")
                    self.assertTrue(client.settled["verification"]["detail"])
                    if fault is None:
                        self.assertEqual(client.replies[0]["status"], "verified")
                        self.assertEqual(client.settled["verification"]["detail"], "frame-bound witness matched")
                    else:
                        self.assertEqual((row["status"], row["code"]),
                                         ("unverified", "VERIFICATION_FAILED"))
                    print(json.dumps({"scenario": faults, "trial": row["trial"],
                                      "latency_ms": round(client.latency_ms, 3),
                                      "provenance": "MEASURED", "result": row}), flush=True)

    def test_hosted_ratio_boundaries(self):
        for failures in (0, 1, 2):
            with self.subTest(failures=failures):
                self.scenario([None] * (10 - failures) + ["unchanged"] * failures, 10 - failures)

    def test_STATE_MISMATCH_never_verifies(self):
        self.scenario(["STATE_MISMATCH"] * 10, 0)

    def test_fabricated_tick_never_verifies(self):
        self.scenario(["fabricated_tick"] * 10, 0)


if __name__ == "__main__":
    unittest.main()
