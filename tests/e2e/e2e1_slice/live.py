#!/usr/bin/env python3
"""Real-process LIVE admission probe; all evidence is emitted to stdout.

[TARGET, unit decision] Use the admitted agents CoreClient for v0.2 transport.
There is no new product API. The first measured failure stops the scenario; cleanup always runs.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import traceback
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "agents"))
from metaviewer_agents.client import CoreClient  # noqa: E402
from metaviewer_agents.envelope import make_envelope  # noqa: E402


class UIWire:
    """[TARGET, unit decision] Minimal test UI socket, not an agent API.

    The agent package's frozen UI schema predates take/release. UI envelopes
    use the shipped v0.2 contract and are closed-decoded by the real core.
    The agent lane continues to use the unmodified production CoreClient.
    """

    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(20)
        self.sock.connect(str(path))
        self.reader = self.sock.makefile("rb")
        self.next_seq = 1

    def send(self, value):
        self.sock.sendall(json.dumps(value, separators=(",", ":")).encode() + b"\n")
        self.next_seq += 1

    def recv(self):
        raw = self.reader.readline((1 << 20) + 1)
        if not raw.endswith(b"\n") or len(raw) > (1 << 20):
            raise RuntimeError("UI reply missing or oversized")
        return json.loads(raw)

    def close(self):
        self.reader.close()
        self.sock.close()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()


def profile_containers(profile):
    """Project only identity ownership from native control JSON, never env files.

    Container names are opaque. Name substrings cannot prove native ownership.
    """
    names = set()
    for path in Path(os.environ["MV_SRF_STATE_DIR"]).glob("*.json"):
        value = json.loads(path.read_text())
        if isinstance(value, dict) and value.get("Lease", {}).get("ProfileID") == profile:
            name = value.get("Capsule", {}).get("container")
            if isinstance(name, str) and name.startswith("srf-id-"):
                names.add(name)
    return names


def run(report, argv, **kwargs):
    result = subprocess.run([str(x) for x in argv], capture_output=True,
                            text=True, timeout=30, **kwargs)
    report["commands"].append({"argv": [str(x) for x in argv],
                               "rc": result.returncode,
                               "stdout": result.stdout.strip(),
                               "stderr": result.stderr.strip()})
    return result


def wait_for(predicate, processes, detail):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if any(p.poll() is not None for p in processes):
            raise RuntimeError("process exited before " + detail)
        if predicate():
            return
        time.sleep(0.02)
    raise RuntimeError("timeout waiting for " + detail)


def registration(component, commit, suffix):
    return {"endpoint": {"component": component, "instance": component + "-" + suffix},
            "hello": {"schema": "hello/v0.2", "contract_version": "v0.2",
                      "component": component, "component_version": "0.1.1",
                      "component_commit": commit, "dependencies": []}}


def send(peer, reg, config, body):
    if isinstance(peer, UIWire) and body.get("schema") == "ui_intent/v0.2":
        assert set(body) == {"schema", "request_id", "op", "params"}
        assert body["op"] in ("take_control", "release_control")
        assert set(body["params"]) == {"surface_id"}
        peer.send({"schema": "envelope/v0.2", "msg_id": body["request_id"], "ts_ns": 0,
                   "from": reg["endpoint"], "to": config["core"]["endpoint"],
                   "session_id": config["session_id"], "seq": peer.next_seq,
                   "nonce": uuid.uuid4().hex, "body": body})
        return
    peer.send(make_envelope(msg_id=body.get("request_id", reg["endpoint"]["instance"] + "-" + str(peer.next_seq)),
                           from_component=reg["endpoint"]["component"],
                           from_instance=reg["endpoint"]["instance"],
                           to_component="core", to_instance=config["core"]["endpoint"]["instance"],
                           session_id=config["session_id"], seq=peer.next_seq,
                           body=body, ts_ns=0))


def replay_probe(report, archive, replay, scratch):
    # The caller holds both owned processes at a completed observe boundary.
    # Replay the intact archive, including its product-generated checkpoint.
    journal = archive / "journal.jsonl"
    record_count = len(journal.read_text().splitlines()) - 1
    state = json.loads((archive / "events" / f"{record_count}.json").read_text())["state"]
    expected = digest(state)
    outputs = [run(report, [replay, "--journal", journal, "--witness-root", archive])
               for _ in range(2)]
    assert all(p.returncode == 0 and p.stdout.strip() == expected for p in outputs), "replay digest mismatch"
    # Replay requires private state/sessions/archive directories even for copies.
    bad_state = scratch / "corrupt-state"
    bad_state.mkdir(mode=0o700)
    (bad_state / "sessions").mkdir(mode=0o700)
    bad = bad_state / "sessions" / "corrupted-session"
    shutil.copytree(archive, bad)
    lines = (bad / "journal.jsonl").read_text().splitlines()
    record = json.loads(lines[-1])
    record["prev_sha256"] = "f" * 64
    lines[-1] = json.dumps(record, separators=(",", ":"))
    (bad / "journal.jsonl").write_text("\n".join(lines) + "\n")
    corrupt = run(report, [replay, "--journal", bad / "journal.jsonl", "--witness-root", bad])
    assert corrupt.returncode != 0 and not corrupt.stdout.strip(), "corrupt journal accepted"
    report["replay_probe"] = {"status": "PASS", "digest": expected,
                               "committed_records": record_count,
                               "corrupt_rc": corrupt.returncode,
                               "scope": "real-process durable journal"}


def receive(peer, predicate, report, reject_errors=True):
    for _ in range(100):
        body = peer.recv()["body"]
        report.setdefault("wire_evidence", []).append(body)
        if reject_errors and body.get("event") == "error":
            raise RuntimeError("daemon surface error: " + json.dumps(body, sort_keys=True))
        if predicate(body):
            return body
    raise RuntimeError("mailbox response cap exceeded")


def snapshot(archive):
    paths = list((archive / "events").glob("*.json"))
    return json.loads(max(paths, key=lambda p: int(p.stem)).read_text())["state"]


def domain(state):
    # Match CoreState::domain_snapshot; transport replay bookkeeping advances
    # for a refusal and is intentionally outside the domain equality oracle.
    return {k: state[k] for k in ("surfaces", "leases", "pending", "draining",
                                  "remaining_budget", "epoch")}


def proposal(surface_id, frame, proposal_id):
    return {"schema": "action_proposal/v0.2", "proposal_id": proposal_id,
            "surface_id": surface_id,
            "based_on_frame": {"generation": frame["generation"], "sha256": frame["sha256"]},
            "action": {"type": "key", "keys": ["Escape"]},
            "expectation": {"type": "text_present", "text": "ready"},
            "budget": {"max_ms": 10000, "max_retries": 0}}


def electron_probe(report, scratch, frame, surface):
    binary = os.environ.get("MV_E2E_ELECTRON_BIN")
    if not binary or not shutil.which("xvfb-run"):
        raise RuntimeError("local Electron or xvfb-run AUSENTE")
    fixture = scratch / "electron-frame.json"
    fixture.write_text(json.dumps({"frame": frame, "surface": surface}))
    child_env = dict(os.environ, MV_E2E_FRAME_FIXTURE=str(fixture))
    child_env.pop("ELECTRON_RUN_AS_NODE", None)
    result = run(report, ["xvfb-run", "-a", binary, Path(__file__).with_name("electron-relay.mjs"),
                          "--user-data-dir=" + str(scratch / "electron-profile")], env=child_env)
    report["electron_relay"] = {"rc": result.returncode, "stdout": result.stdout.strip()}
    report["assertions"]["electron_tile"] = "FAIL" if result.returncode else "PASS"
    assert result.returncode == 0, "Electron relay: " + result.stdout.strip()


def main():
    report = {"status": "BLOCKED", "mode": "live", "commands": [], "assertions": {
        "capsule_frame_ui_fanout": "BLOCKED", "observe_propose_dispatch_receipt": "BLOCKED",
        "stale_no_state_change": "BLOCKED", "human_cancel_release_refresh": "BLOCKED",
        "action_journal_replay_corruption": "BLOCKED", "electron_tile": "PENDING"}}
    processes, peers, owned = [], [], set()
    profile = os.environ["MV_SRF_LIVE_PROFILE"]
    with tempfile.TemporaryDirectory(prefix="mv-gw1-") as temp:
        scratch = Path(temp)
        try:
            if os.environ.get("MV_E2E_LIVE") != "1" or profile != "mv-live-1":
                raise RuntimeError("explicit MV_E2E_LIVE=1 and mv-live-1 profile required")
            before = run(report, ["docker", "ps", "--format", "{{.Names}}"])
            assert before.returncode == 0, "docker inventory unavailable"
            assert not profile_containers(profile), "profile already allocated; refusing to touch it"
            assert not any(profile in name for name in before.stdout.splitlines()), "profile already running; refusing to touch it"
            ram_root = Path(os.environ["MV_SRF_LIVE_RAM_ROOT"]).resolve(strict=True)
            original_ram_dirs = {p.name for p in ram_root.iterdir()}
            commit = run(report, ["git", "rev-parse", "HEAD"], cwd=ROOT)
            assert commit.returncode == 0, "build pin unavailable"
            suffix = uuid.uuid4().hex
            regs = {c: registration(c, commit.stdout.strip(), suffix) for c in ("core", "ui", "agent", "daemon")}
            config = {"session_id": "gw1-" + suffix, "core": regs["core"],
                      "peers": [regs[c] for c in ("ui", "agent", "daemon")]}
            config_file = scratch / "core-config.json"
            config_file.write_text(json.dumps(config))
            env = dict(os.environ, MV_CORE_CONFIG=str(config_file),
                       XDG_RUNTIME_DIR=str(scratch / "runtime"), XDG_STATE_HOME=str(scratch / "state"),
                       MV_SESSION_ID=config["session_id"],
                       MV_CORE_INSTANCE=regs["core"]["endpoint"]["instance"],
                       MV_DAEMON_INSTANCE=regs["daemon"]["endpoint"]["instance"],
                       MV_COMPONENT_COMMIT=commit.stdout.strip(), MV_SRF_PROFILES="",
                       MV_CONTRACT_DIR=str(ROOT / "contracts/v0.2"))
            (scratch / "runtime").mkdir(mode=0o700)
            socket_path = scratch / "runtime/metaviewer/core.sock"
            logs = []
            for name, key in (("core", "MV_E2E_CORE_BIN"), ("adapter", "MV_E2E_ADAPTER_BIN")):
                binary = str(Path(env[key]).resolve(strict=True))
                log = open(scratch / (name + ".log"), "w+")
                logs.append(log)
                proc = subprocess.Popen([binary], cwd=ROOT, env=env, stdout=log, stderr=log)
                processes.append(proc)
                report["commands"].append({"argv": [binary], "rc": None})
                if name == "core":
                    wait_for(socket_path.exists, processes, "core socket")
            archive = scratch / "state/metaviewer/sessions" / config["session_id"]
            wait_for(lambda: (archive / "events/1.json").exists(), processes, "adapter Connect journal event")
            report["real_process_handshake"] = "PASS"
            for role in ("ui", "agent"):
                peer = UIWire(socket_path) if role == "ui" else CoreClient(
                    str(socket_path), timeout_s=20, max_line_bytes=1 << 20, max_reply_bytes=1 << 20)
                peers.append(peer)
                if role == "agent":
                    peer.connect()
                send(peer, regs[role], config, regs[role]["hello"])
                assert peer.recv()["body"] == regs["core"]["hello"], "core pin mismatch"
            ui, agent = peers
            create = {"schema": "surface_request/v0.2", "op": "create", "params": {
                "kind": "browser", "geometry": {"w": 1280, "h": 900}, "profile_id": profile}}
            report["create_request"] = create
            send(ui, regs["ui"], config, create)
            created = receive(ui, lambda b: b.get("event") == "created", report)
            surface_id = created["data"]["surface"]["surface_id"]
            owned = profile_containers(profile) - set(before.stdout.splitlines())
            assert owned, "native capsule ownership witness absent"
            report["owned_containers"] = sorted(owned)
            frame_body = receive(ui, lambda b: b.get("event") == "frame_ready", report)
            frame = frame_body["data"]["frame_ref"]
            pixels = Path(frame["ramws_path"]).read_bytes()
            assert hashlib.sha256(pixels).hexdigest() == frame["sha256"], "UI frame bytes mismatch"
            assert (archive / "artifacts" / frame["sha256"]).read_bytes() == pixels, "retained witness mismatch"
            report["frame_witness"] = {"sha256": frame["sha256"], "generation": frame["generation"],
                                       "bytes": len(pixels), "surface_id": surface_id}
            report["assertions"]["capsule_frame_ui_fanout"] = "PASS"
            electron_probe(report, scratch, frame, created["data"]["surface"])
            send(agent, regs["agent"], config, {"schema": "mv_tool_call/v0.2", "request_id": "observe-1",
                                               "op": "observe", "args": {"surface_id": surface_id}})
            observed = receive(agent, lambda b: b.get("schema") in
                               ("mv_tool_result/v0.2", "action_verdict/v0.2"), report)
            report["observe_response"] = observed
            assert observed.get("schema") == "mv_tool_result/v0.2" and observed.get("status") == "ok", "observe refused: " + str(observed)
            send(agent, regs["agent"], config, proposal(surface_id, frame, "live-action-1"))
            verdict = receive(agent, lambda b: b.get("proposal_id") == "live-action-1", report)
            assert verdict.get("decision") == "admitted", "fresh action refused: " + str(verdict)
            receipt = receive(agent, lambda b: b.get("schema") == "action_receipt/v0.2"
                              and b.get("proposal_id") == "live-action-1", report)
            report["action_receipt"] = receipt
            report["assertions"]["propose_dispatch_receipt"] = "PASS"
            report["assertions"]["observe_propose_dispatch_receipt"] = (
                "PASS" if not report.get("production_blockers") else "FAIL: observe unavailable; action receipt PASS")
            advanced = receive(ui, lambda b: b.get("event") == "frame_ready"
                               and b["data"]["frame_ref"]["generation"] > frame["generation"], report)["data"]["frame_ref"]
            before_state = domain(snapshot(archive))
            send(agent, regs["agent"], config, proposal(surface_id, frame, "live-stale"))
            stale = receive(agent, lambda b: b.get("proposal_id") == "live-stale", report)
            assert stale.get("reason_code") == "STALE_FRAME", "stale frame accepted"
            after_state = domain(snapshot(archive))
            assert before_state == after_state, "stale refusal changed domain state"
            report["assertions"]["stale_no_state_change"] = "PASS"
            report["stale_evidence"] = {"verdict": stale, "domain_sha256": digest(after_state)}
            # [TARGET, unit decision] Pause only our real adapter to hold a
            # dispatched proposal pending deterministically. No fake receipts.
            processes[1].send_signal(signal.SIGSTOP)
            report["commands"].append({"argv": ["signal", "SIGSTOP", "owned-adapter"], "rc": 0})
            send(agent, regs["agent"], config, proposal(surface_id, advanced, "live-pending"))
            pending = receive(agent, lambda b: b.get("proposal_id") == "live-pending", report)
            assert pending.get("decision") == "admitted", "pending action not admitted"
            send(ui, regs["ui"], config, {"schema": "ui_intent/v0.2", "request_id": "take-1",
                                          "op": "take_control", "params": {"surface_id": surface_id}})
            cancelled = receive(agent, lambda b: b.get("proposal_id") == "live-pending", report)
            assert cancelled.get("reason_code") == "SURFACE_NOT_AGENT_CONTROLLED", "pending not cancelled"
            assert not snapshot(archive)["pending"], "take_control retained pending action"
            report["pending_cancellation"] = cancelled
            report["assertions"]["pending_cancellation"] = "PASS"
            processes[1].send_signal(signal.SIGCONT)
            report["commands"].append({"argv": ["signal", "SIGCONT", "owned-adapter"], "rc": 0})
            receive(ui, lambda b: b.get("event") == "state_changed"
                    and b["data"]["surface"]["control"] == "human", report)
            receive(agent, lambda b: b.get("schema") == "action_receipt/v0.2"
                    and b.get("proposal_id") == "live-pending", report)
            send(agent, regs["agent"], config, proposal(surface_id, advanced, "live-human"))
            human = receive(agent, lambda b: b.get("proposal_id") == "live-human", report)
            assert human.get("reason_code") == "SURFACE_NOT_AGENT_CONTROLLED", "human ownership not enforced"
            report["human_refusal"] = human
            send(ui, regs["ui"], config, {"schema": "ui_intent/v0.2", "request_id": "release-1",
                                          "op": "release_control", "params": {"surface_id": surface_id}})
            receive(ui, lambda b: b.get("event") == "state_changed"
                    and b["data"]["surface"]["control"] == "agent", report)
            report["assertions"]["human_refusal_release"] = "PASS"
            send(agent, regs["agent"], config, {"schema": "surface_request/v0.2", "op": "frame_subscribe",
                                               "params": {"surface_id": surface_id}})
            # The production path must supply the fresh frame after release.
            try:
                refresh = receive(ui, lambda b: b.get("event") in ("error", "frame_ready"),
                                  report, reject_errors=False)
                if refresh.get("event") == "error":
                    raise RuntimeError(json.dumps(refresh, sort_keys=True))
                fresh = receive(agent, lambda b: b.get("event") == "frame_ready", report)["data"]["frame_ref"]
                assert fresh == refresh["data"]["frame_ref"], "refresh fan-out mismatch"
                # [TARGET, unit decision] The subscription keeps publishing.
                # Hold our adapter and observe the core's current generation;
                # queued fan-out is evidence, not a promise it is still current.
                processes[1].send_signal(signal.SIGSTOP)
                report["commands"].append({"argv": ["signal", "SIGSTOP", "owned-adapter"], "rc": 0})
                send(agent, regs["agent"], config, {"schema": "mv_tool_call/v0.2",
                    "request_id": "observe-refresh", "op": "observe", "args": {"surface_id": surface_id}})
                current = receive(agent, lambda b: b.get("request_id") == "observe-refresh", report)
                assert current.get("status") == "ok", "post-release observe refused: " + str(current)
                fresh = current["observation"]["frame_ref"]
                send(agent, regs["agent"], config, proposal(surface_id, fresh, "live-readmitted"))
                admitted = receive(agent, lambda b: b.get("proposal_id") == "live-readmitted", report)
                assert admitted.get("decision") == "admitted", "fresh post-release action refused: " + str(admitted)
                processes[1].send_signal(signal.SIGCONT)
                report["commands"].append({"argv": ["signal", "SIGCONT", "owned-adapter"], "rc": 0})
                receive(agent, lambda b: b.get("schema") == "action_receipt/v0.2"
                        and b.get("proposal_id") == "live-readmitted", report)
                report["assertions"]["human_cancel_release_refresh"] = "PASS"
            except Exception as error:
                report["assertions"]["human_cancel_release_refresh"] = "FAIL: " + str(error)
                raise RuntimeError("post-release frame_subscribe: " + str(error)) from error
            # [TARGET, unit decision] Freeze only owned processes after an
            # observe barrier, preserving the full journal/checkpoint closure.
            processes[1].send_signal(signal.SIGSTOP)
            report["commands"].append({"argv": ["signal", "SIGSTOP", "owned-adapter"], "rc": 0})
            send(agent, regs["agent"], config, {"schema": "mv_tool_call/v0.2",
                "request_id": "replay-barrier", "op": "observe", "args": {"surface_id": surface_id}})
            barrier = receive(agent, lambda b: b.get("request_id") == "replay-barrier", report)
            assert barrier.get("status") == "ok", "replay observe barrier refused: " + str(barrier)
            processes[0].send_signal(signal.SIGSTOP)
            report["commands"].append({"argv": ["signal", "SIGSTOP", "owned-core"], "rc": 0})
            replay_probe(report, archive, env["MV_E2E_REPLAY_BIN"], scratch)
            report["assertions"]["action_journal_replay_corruption"] = "PASS"
        except Exception as error:
            report["error"] = str(error)
            report["traceback"] = traceback.format_exc()
        finally:
            if processes and processes[0].poll() is None:
                processes[0].send_signal(signal.SIGCONT)
            if len(processes) > 1 and processes[1].poll() is None:
                processes[1].send_signal(signal.SIGCONT)
            if "surface_id" in locals():
                try:
                    send(ui, regs["ui"], config, {"schema": "surface_request/v0.2", "op": "destroy",
                                                  "params": {"surface_id": surface_id}})
                    receive(ui, lambda b: b.get("event") == "state_changed"
                            and b["data"]["surface"]["state"] == "destroyed", report)
                except Exception as error:
                    report["destroy_error"] = str(error)
            for peer in peers:
                peer.close()
            for proc in reversed(processes):
                if proc.poll() is None:
                    proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
            launch_rows = [r for r in report["commands"] if r["rc"] is None]
            for row, proc in zip(launch_rows, processes):
                row["rc"] = proc.returncode
            for log in locals().get("logs", []):
                log.seek(0)
                report.setdefault("process_logs", []).append(log.read()[-4000:])
                log.close()
            after = run(report, ["docker", "ps", "--format", "{{.Names}}"])
            # Native control state binds opaque names to the admitted profile;
            # never stop an unrelated container or one present before launch.
            if "before" in locals() and before.returncode == 0 and after.returncode == 0:
                owned |= profile_containers(profile) - set(before.stdout.splitlines())
                leftovers = owned & set(after.stdout.splitlines())
                for name in sorted(leftovers):
                    run(report, [Path(os.environ["MV_SRF_BIN_DIR"]) / "srf-identity-surface",
                                 "stop", "--container", name, "--state-dir", os.environ["MV_SRF_STATE_DIR"]])
                if leftovers:
                    after = run(report, ["docker", "ps", "--format", "{{.Names}}"])
            # Native stop retains source captures. Delete only this run's
            # ownership-proven allocation; pre-existing allocations are excluded.
            ram_paths = []
            if "ram_root" in locals():
                for name in sorted(owned):
                    path = ram_root / name
                    if name not in original_ram_dirs and path.exists() and not path.is_symlink():
                        assert path.resolve().parent == ram_root, "allocation escaped RAM root"
                        if name not in after.stdout.splitlines():
                            shutil.rmtree(path)
                            ram_paths.append(str(path))
                published_dirs = {str(Path(b["data"]["frame_ref"]["ramws_path"]).parent)
                                  for b in report.get("wire_evidence", []) if b.get("event") == "frame_ready"}
                remaining = [p for p in ram_paths + list(published_dirs) if Path(p).exists()]
                report["ram_cleanup"] = {"status": "FAIL" if remaining else "PASS",
                                         "owned_allocations_removed": ram_paths,
                                         "published_directories": sorted(published_dirs), "remaining": remaining}
            report["container_cleanup"] = "PASS" if after.returncode == 0 and not (
                owned & set(after.stdout.splitlines())) and not profile_containers(profile) else "FAIL"
    report["process_cleanup"] = {"status": "PASS" if all(p.poll() is not None for p in processes) else "FAIL",
                                  "pids": [p.pid for p in processes], "temporary_tree_absent": not scratch.exists(),
                                  "socket_absent": not locals().get("socket_path", scratch).exists()}
    if report["container_cleanup"] == "PASS" and report["process_cleanup"]["status"] == "PASS" and report.get("ram_cleanup", {}).get("status") == "PASS" and all(v == "PASS" for v in report["assertions"].values()):
        report["status"] = "DONE"
    print(json.dumps(report, sort_keys=True))
    return 0 if report["status"] == "DONE" else 1


if __name__ == "__main__":
    sys.exit(main())
