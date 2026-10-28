"""Real core admission loop and negative controls, entirely offline.

[TARGET, unit decision] The fake adapter publishes immutable frame bytes and
settles actual input requests. The current core deliberately rejects tool
verification without focus/timestamp evidence; this limitation is asserted,
never converted to a successful receipt by the client.
"""

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

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agents"))
from metaviewer_agents.envelope import make_envelope


def registration(component):
    return {"endpoint": {"component": component, "instance": component + "-cli"},
            "hello": {"schema": "hello/v0.2", "contract_version": "v0.2",
                      "component": component,
                      "component_version": (ROOT / "VERSION").read_text().strip(),
                      "component_commit": "0123456789abcdef0123456789abcdef01234567",
                      "dependencies": []}}


class MvctlCoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        binary = os.environ.get("MV_E2E_CORE_BIN")
        cls.build_temp = tempfile.TemporaryDirectory(prefix="mvctl-build-")
        if binary:
            cls.binary = str(Path(binary).resolve(strict=True))
            return
        cargo = shutil.which(os.environ.get("CARGO", "cargo"))
        if cargo is None:
            raise RuntimeError("AUSENTE — cargo or MV_E2E_CORE_BIN required")
        target = os.environ.get("CARGO_TARGET_DIR", cls.build_temp.name)
        result = subprocess.run([cargo, "build", "--offline", "--bin", "metaviewer-core"],
                                cwd=ROOT, env=dict(os.environ, CARGO_TARGET_DIR=target),
                                capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise RuntimeError("offline core build failed: " + result.stderr)
        cls.binary = str(Path(target).resolve() / "debug/metaviewer-core")

    @classmethod
    def tearDownClass(cls):
        cls.build_temp.cleanup()

    def setUp(self):
        self.ram = None
        temporary = tempfile.TemporaryDirectory(prefix="mvctl-real-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.runtime = self.directory / "runtime"
        self.runtime.mkdir(mode=0o700)
        self.path = self.runtime / "metaviewer/core.sock"
        self.config = {"session_id": "mvctl-session", "core": registration("core"),
                       "peers": [registration("daemon"), registration("agent")]}
        self.config_file = self.directory / "config.json"
        self.config_file.write_text(json.dumps(self.config))
        self.env = dict(os.environ, MV_CORE_CONFIG=str(self.config_file),
                        XDG_RUNTIME_DIR=str(self.runtime),
                        XDG_STATE_HOME=str(self.directory / "state"),
                        PYTHONPATH=str(ROOT / "agents"))
        self.log = tempfile.TemporaryFile()
        self.addCleanup(self.log.close)
        self.process = subprocess.Popen([self.binary], env=self.env, cwd=ROOT,
                                        stdout=self.log, stderr=self.log)
        self.addCleanup(self.stop_core)
        deadline = time.monotonic() + 10
        while not self.path.exists():
            if self.process.poll() is not None or time.monotonic() >= deadline:
                self.log.seek(0)
                self.fail("core startup failed: " + self.log.read().decode())
            time.sleep(0.01)
        self.daemon = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.daemon.settimeout(5)
        self.daemon.connect(str(self.path))
        self.addCleanup(self.daemon.close)
        self.reader = self.daemon.makefile("rb")
        self.addCleanup(self.reader.close)
        self.seq = 0
        self.send(registration("daemon")["hello"])
        self.assertEqual(self.receive()["schema"], "hello/v0.2")
        self.surface = self.fixture("surface")
        self.send({"schema": "surface_event/v0.2", "event": "created",
                   "data": {"surface": self.surface}})
        self.ram = tempfile.NamedTemporaryFile(prefix="mvctl-frame-", dir="/dev/shm")
        self.addCleanup(self.ram.close)
        os.chmod(self.ram.name, 0o600)
        frame_bytes = b"mvctl-rgb24!"
        self.ram.write(frame_bytes)
        self.ram.flush()
        self.frame = self.fixture("frame_ref")
        self.frame.update(width=2, height=2, ramws_path=self.ram.name, generation=2,
                          sha256=hashlib.sha256(frame_bytes).hexdigest())
        self.send(self.frame)
        self.barrier()

    def tearDown(self):
        if getattr(self, "ram", None) is not None:
            self.ram.close()

    def stop_core(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)

    def fixture(self, name):
        return json.loads((ROOT / "contracts/examples/v0.2" / (name + ".valid.json")).read_text())

    def send(self, body):
        self.seq += 1
        value = make_envelope(msg_id="daemon-" + str(self.seq), from_component="daemon",
                              from_instance="daemon-cli", to_component="core",
                              to_instance="core-cli", session_id=self.config["session_id"],
                              seq=self.seq, body=body)
        self.daemon.sendall((json.dumps(value) + "\n").encode())

    def receive(self):
        raw = self.reader.readline((1 << 20) + 1)
        self.assertTrue(raw.endswith(b"\n"), raw)
        return json.loads(raw)["body"]

    def barrier(self):
        self.send({"schema": "mv_tool_call/v0.2", "request_id": "barrier",
                   "op": "list", "args": {"cursor": None, "limit": 1}})
        self.assertEqual(self.receive()["reason_code"], "POLICY")

    def cli(self, command, *flags):
        result = subprocess.run([sys.executable, "-m", "metaviewer_agents.mvctl", command,
                                 "--socket", str(self.path), "--session-id", "mvctl-session",
                                 "--agent-instance", "agent-cli", "--core-instance", "core-cli",
                                 "--timeout-ms", "3000", "--max-line-bytes", "65536",
                                 "--max-reply-bytes", "65536", *flags],
                                env=self.env, capture_output=True, text=True, timeout=8)
        return result

    def proposal_file(self, generation=2, schema="action_proposal/v0.2"):
        proposal = self.fixture("action_proposal")
        proposal["schema"] = schema
        proposal["based_on_frame"] = {"sha256": self.frame["sha256"],
                                      "generation": generation}
        proposal["action"] = {"type": "click", "x": 0, "y": 0, "button": "left"}
        proposal["expectation"] = {"type": "changed_region",
                                   "bbox": {"x": 0, "y": 0, "w": 1, "h": 1}}
        path = self.directory / "proposal.json"
        path.write_text(json.dumps(proposal))
        return path, proposal

    def test_default_cli_observe_propose_and_real_receipt(self):
        observed = self.cli("observe", "--surface-id", "surface-demo")
        self.assertEqual(observed.returncode, 0, observed.stderr)
        observation = json.loads(observed.stdout)
        self.assertEqual(observation["schema"], "observation/v0.2")
        self.assertEqual(observation["frame_ref"], self.frame)
        path, proposal = self.proposal_file(observation["frame_ref"]["generation"])
        admitted = self.cli("propose", "--json-arg", str(path))
        self.assertEqual(admitted.returncode, 0, admitted.stderr)
        self.assertEqual(json.loads(admitted.stdout)["decision"], "admitted")
        dispatched = self.receive()
        self.assertEqual(dispatched["op"], "input")
        self.assertEqual(dispatched["params"]["proposal_id"], proposal["proposal_id"])
        # Negative control: when native_evidence is omitted from the receipt,
        # the core refuses verification with VERIFICATION_FAILED.
        after_frame = dict(self.frame, generation=3, tick=self.frame["tick"] + 1,
                           ts_ns=self.frame["ts_ns"] + 1)
        self.send({"schema": "surface_event/v0.2", "event": "frame_ready",
                   "data": {"frame_ref": after_frame}})
        receipt = {"schema": "action_receipt/v0.2",
                   "proposal_id": proposal["proposal_id"],
                   "executed_at_ns": after_frame["ts_ns"] - 1,
                   "after_frame": after_frame, "verified": False,
                   "verification": {"method": "pixel", "detail":
                       "post-input capture only; expectation verification belongs to core"},
                   "error": ""}
        self.send(receipt)
        self.barrier()
        expectation = self.directory / "expectation.json"
        expectation.write_text(json.dumps(proposal["expectation"]))
        waited = self.cli("wait-verify", "--proposal-id", proposal["proposal_id"],
                          "--json-arg", str(expectation))
        self.assertEqual(waited.returncode, 1, waited.stderr)
        self.assertEqual(waited.stderr, "")
        failure = json.loads(waited.stdout)
        self.assertEqual(failure["code"], "VERIFICATION_FAILED")
        self.assertEqual(failure["detail"],
                         "Receipt settled execution; focus proof and input_mono_ns are absent")
        # Actual daemon receipt is durably witnessed, not synthesized by the CLI.
        events = self.directory / "state/metaviewer/sessions/mvctl-session/events"
        witnessed = []
        for event_path in events.glob("*.json"):
            event = json.loads(event_path.read_text())
            for witness in event["witnesses"]:
                artifact = events.parent / "artifacts" / witness["sha256"]
                data = artifact.read_bytes()
                self.assertEqual(hashlib.sha256(data).hexdigest(), witness["sha256"])
                try:
                    witnessed.append(json.loads(data).get("body"))
                except (ValueError, AttributeError):
                    pass  # Frame bytes are also content-addressed witnesses.
        self.assertIn(receipt, witnessed)

    def test_cli_rerun_with_native_evidence_verifies_and_rejects_bad_evidence(self):
        # First run: evidence-free receipt fails with VERIFICATION_FAILED (negative control).
        first_path, first_proposal = self.proposal_file(self.frame["generation"])
        self.assertEqual(self.cli("propose", "--json-arg", str(first_path)).returncode, 0)
        self.assertEqual(self.receive()["params"]["proposal_id"], first_proposal["proposal_id"])
        frame_g3 = dict(self.frame, generation=3, tick=self.frame["tick"] + 1,
                        ts_ns=self.frame["ts_ns"] + 1)
        self.send({"schema": "surface_event/v0.2", "event": "frame_ready",
                   "data": {"frame_ref": frame_g3}})
        self.send({"schema": "action_receipt/v0.2",
                   "proposal_id": first_proposal["proposal_id"],
                   "executed_at_ns": frame_g3["ts_ns"],
                   "after_frame": frame_g3, "verified": False,
                   "verification": {"method": "pixel", "detail": "unverified"},
                   "error": ""})
        self.barrier()
        exp_path = self.directory / "expectation-rerun.json"
        exp_path.write_text(json.dumps(first_proposal["expectation"]))
        unverified = self.cli("wait-verify", "--proposal-id", first_proposal["proposal_id"],
                              "--json-arg", str(exp_path))
        self.assertEqual(unverified.returncode, 1, unverified.stderr)
        self.assertEqual(json.loads(unverified.stdout)["code"], "VERIFICATION_FAILED")

        # Rerun over the same CLI session with real frame RGB witnesses and native_evidence.
        before_ram = tempfile.NamedTemporaryFile(prefix="mvctl-before-", dir="/dev/shm")
        self.addCleanup(before_ram.close)
        before_bytes = bytes([255, 0, 0, 0, 255, 0])
        before_ram.write(before_bytes)
        before_ram.flush()
        before_frame = dict(self.frame, generation=4, tick=10, ts_ns=3000000,
                            width=2, height=1, ramws_path=before_ram.name,
                            sha256=hashlib.sha256(before_bytes).hexdigest())
        self.send({"schema": "surface_event/v0.2", "event": "frame_ready",
                   "data": {"frame_ref": before_frame}})
        self.barrier()

        observed = self.cli("observe", "--surface-id", "surface-demo")
        self.assertEqual(observed.returncode, 0, observed.stderr)
        self.assertEqual(json.loads(observed.stdout)["frame_ref"], before_frame)

        rerun_proposal = self.fixture("action_proposal")
        rerun_proposal.update(
            proposal_id="proposal-rerun-verified",
            based_on_frame={"sha256": before_frame["sha256"], "generation": before_frame["generation"]},
            action={"type": "click", "x": 0, "y": 0, "button": "left"},
            expectation={"type": "changed_region", "bbox": {"x": 0, "y": 0, "w": 1, "h": 1}},
        )
        rerun_path = self.directory / "proposal-rerun.json"
        rerun_path.write_text(json.dumps(rerun_proposal))
        exp_path.write_text(json.dumps(rerun_proposal["expectation"]))

        admitted = self.cli("propose", "--json-arg", str(rerun_path))
        self.assertEqual(admitted.returncode, 0, admitted.stderr)
        self.assertEqual(json.loads(admitted.stdout)["decision"], "admitted")
        dispatched = self.receive()
        self.assertEqual(dispatched["op"], "input")
        self.assertEqual(dispatched["params"]["proposal_id"], "proposal-rerun-verified")

        after_ram = tempfile.NamedTemporaryFile(prefix="mvctl-after-", dir="/dev/shm")
        self.addCleanup(after_ram.close)
        after_bytes = bytes([0, 0, 255, 0, 255, 0])
        after_ram.write(after_bytes)
        after_ram.flush()
        after_frame = dict(before_frame, generation=5, tick=11, ts_ns=3000010,
                           ramws_path=after_ram.name,
                           sha256=hashlib.sha256(after_bytes).hexdigest())
        self.send({"schema": "surface_event/v0.2", "event": "frame_ready",
                   "data": {"frame_ref": after_frame}})
        verified_receipt = {
            "schema": "action_receipt/v0.2",
            "proposal_id": "proposal-rerun-verified",
            "executed_at_ns": 3000008,
            "after_frame": after_frame,
            "verified": False,
            "verification": {
                "method": "pixel",
                "detail": "post-input capture only; expectation verification belongs to core",
            },
            "error": "",
            "native_evidence": {
                "surface_id": "surface-demo",
                "native_surface_id": "native-surface-demo",
                "kind": "click",
                "input_mono_ns": 5000005,
                "input_ts_ns": 3000005,
                "focus_verified": True,
                "result": "ok",
            },
        }
        self.send(verified_receipt)
        self.barrier()

        waited = self.cli("wait-verify", "--proposal-id", "proposal-rerun-verified",
                          "--json-arg", str(exp_path))
        self.assertEqual(waited.returncode, 0, waited.stderr)
        self.assertEqual(waited.stderr, "")
        verified = json.loads(waited.stdout)
        self.assertTrue(verified["verified"])
        self.assertEqual(verified["proposal_id"], "proposal-rerun-verified")
        self.assertEqual(verified["after_frame"], after_frame)
        self.assertEqual(verified["verification"],
                         {"method": "pixel", "detail": "frame-bound witness matched"})

        # Negative control: present but unfocused native_evidence is rejected.
        bad_proposal = dict(
            rerun_proposal,
            proposal_id="proposal-rerun-unfocused",
            based_on_frame={"sha256": after_frame["sha256"], "generation": after_frame["generation"]},
        )
        rerun_path.write_text(json.dumps(bad_proposal))
        self.assertEqual(self.cli("propose", "--json-arg", str(rerun_path)).returncode, 0)
        self.assertEqual(self.receive()["params"]["proposal_id"], "proposal-rerun-unfocused")
        frame_g6 = dict(before_frame, generation=6, tick=12, ts_ns=3000020)
        self.send({"schema": "surface_event/v0.2", "event": "frame_ready",
                   "data": {"frame_ref": frame_g6}})
        bad_receipt = dict(
            verified_receipt,
            proposal_id="proposal-rerun-unfocused",
            executed_at_ns=3000018,
            after_frame=frame_g6,
            native_evidence=dict(
                verified_receipt["native_evidence"],
                input_mono_ns=5000015,
                input_ts_ns=3000015,
                focus_verified=False,
            ),
        )
        self.send(bad_receipt)
        self.barrier()
        failed = self.cli("wait-verify", "--proposal-id", "proposal-rerun-unfocused",
                          "--json-arg", str(exp_path))
        self.assertEqual(failed.returncode, 1, failed.stderr)
        self.assertEqual(json.loads(failed.stdout)["code"], "VERIFICATION_FAILED")
        self.assertEqual(json.loads(failed.stdout)["detail"],
                         "Missing, stale or unmatched native/frame evidence")

    def test_stale_generation_refused_without_daemon_input(self):
        path, _ = self.proposal_file(generation=1)
        stale = self.cli("propose", "--json-arg", str(path))
        self.assertEqual(stale.returncode, 1, stale.stderr)
        self.assertEqual(json.loads(stale.stdout)["reason_code"], "STALE_FRAME")
        # The barrier is ordered after admission. Any input would precede its
        # POLICY reply and fail receive(), avoiding a timing-based absence test.
        self.barrier()

    def test_old_envelope_and_unknown_version_never_reach_daemon(self):
        for schema in ("envelope/v0.1", "action_proposal/v0.1", "action_proposal/v9.9"):
            path, proposal = self.proposal_file(schema=schema)
            if schema == "envelope/v0.1":
                proposal["schema"] = "action_proposal/v0.1"
                envelope = make_envelope(
                    msg_id="legacy", from_component="agent", from_instance="agent-cli",
                    to_component="core", to_instance="core-cli", session_id="mvctl-session",
                    seq=1, body=proposal)
                path.write_text(json.dumps(envelope))
            result = self.cli("propose", "--json-arg", str(path))
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertEqual(json.loads(result.stderr)["code"], "unknown_version")
        self.barrier()


if __name__ == "__main__":
    unittest.main()
