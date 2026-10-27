#!/usr/bin/env python3
"""Real-process LIVE admission probe; all evidence is emitted to stdout.

[TARGET, unit decision] Use the admitted agents CoreClient for v0.2 transport.
There is no new product API. The first measured failure stops the scenario; cleanup always runs.
"""

import hashlib
import json
import os
from pathlib import Path
import re
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
CAPSULE_ID_RE = re.compile(r"^srf-id-[a-z0-9][a-z0-9-]{0,39}$")
sys.path.insert(0, str(ROOT / "agents"))
from metaviewer_agents.client import CoreClient  # noqa: E402
from metaviewer_agents.envelope import (  # noqa: E402
    EnvelopeError,
    make_envelope,
    validate_envelope,
)


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


def capsule_from_receipt(receipt, profile="mv-live-1"):
    """Extract only an identity-surface capsule ID bound to the admitted profile."""
    if not isinstance(receipt, dict):
        return None
    if "Lease" in receipt or "Capsule" in receipt:
        lease = receipt.get("Lease")
        capsule = receipt.get("Capsule")
        if not isinstance(lease, dict) or lease.get("ProfileID") != profile or not isinstance(capsule, dict):
            return None
    else:
        profile_val = receipt.get("profile_id", receipt.get("profile", receipt.get("identity")))
        if profile_val != profile:
            return None
        capsule = receipt
    name = capsule.get("container")
    run_id = capsule.get("run_id")
    if not isinstance(name, str) or not CAPSULE_ID_RE.fullmatch(name):
        return None
    if run_id is not None and (not isinstance(run_id, str) or run_id != name):
        return None
    return name


def profile_containers(profile):
    """Project only identity ownership from native control JSON, never env files.

    Container names are opaque. Name substrings cannot prove native ownership.
    """
    names = set()
    state_dir = os.environ.get("MV_SRF_STATE_DIR", "")
    if not state_dir:
        return names
    for path in Path(state_dir).glob("*.json"):
        try:
            value = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(value, dict) and "Lease" in value:
            name = capsule_from_receipt(value, profile)
            if name is not None:
                names.add(name)
    return names


def cleanup_capsule_ram(ram_root, capsules, published=(), active_containers=()):
    """Remove only the RAM allocation directories of owned destroyed srf-id capsules."""
    root = Path(ram_root)
    if root.is_symlink():
        raise RuntimeError("unsafe symlink RAM root: " + str(root))
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise RuntimeError("RAM root directory required: " + str(root))
    owned = sorted(set(capsules))
    active = set(active_containers)
    removed = []
    owned_paths = []
    for name in owned:
        if not isinstance(name, str) or not CAPSULE_ID_RE.fullmatch(name):
            raise RuntimeError("unsafe or non-identity capsule allocation: " + repr(name))
        path = root / name
        owned_paths.append(str(path))
        if path.is_symlink():
            raise RuntimeError("unsafe RAM allocation: " + str(path))
        if name not in active and path.exists():
            if not path.is_dir() or path.resolve().parent != root:
                raise RuntimeError("unsafe RAM allocation: " + str(path))
            shutil.rmtree(path)
            removed.append(str(path))
    published_dirs = sorted(str(p) for p in set(published))
    remaining = [p for p in owned_paths + published_dirs if Path(p).exists() or Path(p).is_symlink()]
    ram_absent = len(remaining) == 0 and all(not Path(p).exists() and not Path(p).is_symlink() for p in owned_paths)
    return {
        "status": "PASS" if ram_absent else "FAIL",
        "ram_absent": ram_absent,
        "capsules": owned,
        "owned_allocations": owned_paths,
        "owned_allocations_removed": removed,
        "published_directories": published_dirs,
        "remaining": remaining,
    }


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
    version = (ROOT / "VERSION").read_text().strip() if component == "core" else "0.1.1"
    return {"endpoint": {"component": component, "instance": component + "-" + suffix},
            "hello": {"schema": "hello/v0.2", "contract_version": "v0.2",
                      "component": component, "component_version": version,
                      "component_commit": commit, "dependencies": []}}


UI_INBOUND_SCHEMAS = frozenset({"surface_event/v0.2"})
AGENT_INBOUND_SCHEMAS = frozenset({
    "surface_event/v0.2",
    "mv_tool_result/v0.2",
    "action_verdict/v0.2",
    "action_receipt/v0.2",
})


def _lane_state(peer):
    state = getattr(peer, "_mv_lane_state", None)
    if state is None:
        state = {
            "inbound_seq": 0,
            "seen_msg_ids": set(),
            "seen_nonces": set(),
            "active_requests": set(),
            "retired_requests": set(),
            "active_proposals": set(),
            "settled_proposals": set(),
            "refused_proposals": set(),
            "seen_verdicts": set(),
            "last_verdict_core_seq": 0,
            "endpoint": None,
            "core_endpoint": None,
            "session_id": None,
        }
        try:
            setattr(peer, "_mv_lane_state", state)
        except AttributeError:
            pass
    return state


def send(peer, reg, config, body):
    state = _lane_state(peer)
    state["endpoint"] = reg["endpoint"]
    state["core_endpoint"] = config["core"]["endpoint"]
    state["session_id"] = config["session_id"]
    if isinstance(body, dict):
        if body.get("schema") == "mv_tool_call/v0.2":
            req_id = body.get("request_id")
            if req_id in state["retired_requests"] or req_id in state["active_requests"]:
                raise RuntimeError(f"duplicate tool request_id: {req_id}")
            state["active_requests"].add(req_id)
        elif body.get("schema") == "action_proposal/v0.2":
            prop_id = body.get("proposal_id")
            if (
                prop_id in state["settled_proposals"]
                or prop_id in state["refused_proposals"]
                or prop_id in state["active_proposals"]
            ):
                raise RuntimeError(f"duplicate proposal_id: {prop_id}")
            state["active_proposals"].add(prop_id)
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


def receive(peer, predicate, report, reject_errors=True, schemas=None):
    state = _lane_state(peer)
    allowed_schemas = (
        UI_INBOUND_SCHEMAS
        if schemas is None and isinstance(peer, UIWire)
        else AGENT_INBOUND_SCHEMAS
        if schemas is None
        else frozenset(schemas)
    )
    for _ in range(100):
        env = peer.recv()
        try:
            validate_envelope(env)
        except EnvelopeError as exc:
            raise RuntimeError(f"malformed inbound envelope: {exc}") from exc
        if env.get("schema") != "envelope/v0.2":
            raise RuntimeError(f"unexpected envelope schema: {env.get('schema')}")
        if state["core_endpoint"] is not None and env.get("from") != state["core_endpoint"]:
            raise RuntimeError("inbound envelope sender mismatch")
        if state["endpoint"] is not None and env.get("to") != state["endpoint"]:
            raise RuntimeError("inbound envelope recipient mismatch")
        if state["session_id"] is not None and env.get("session_id") != state["session_id"]:
            raise RuntimeError("inbound envelope session mismatch")
        seq = env["seq"]
        if seq <= state["inbound_seq"]:
            raise RuntimeError(f"non-monotonic inbound envelope seq: {seq} <= {state['inbound_seq']}")
        if env["msg_id"] in state["seen_msg_ids"] or env["nonce"] in state["seen_nonces"]:
            raise RuntimeError("duplicate inbound envelope msg_id or nonce")
        body = env["body"]
        body_schema = body.get("schema")
        if body_schema not in allowed_schemas:
            raise RuntimeError(f"unexpected inbound body schema: {body_schema}")
        if body_schema == "mv_tool_result/v0.2":
            req_id = body.get("request_id")
            if req_id in state["retired_requests"]:
                raise RuntimeError(f"duplicate or stale tool result for retired request_id: {req_id}")
            if state["active_requests"] and req_id not in state["active_requests"]:
                raise RuntimeError(f"uncorrelated tool result request_id: {req_id}")
            state["retired_requests"].add(req_id)
            state["active_requests"].discard(req_id)
        elif body_schema == "action_verdict/v0.2":
            prop_id = body.get("proposal_id")
            decision = body.get("decision")
            core_seq = body.get("core_seq", 0)
            if (
                core_seq <= state["last_verdict_core_seq"]
                or prop_id in state["refused_proposals"]
                or prop_id in state["settled_proposals"]
                or (prop_id, decision) in state["seen_verdicts"]
            ):
                raise RuntimeError(f"reordered or duplicate verdict for proposal_id: {prop_id}")
            if state["active_proposals"] and prop_id not in state["active_proposals"]:
                raise RuntimeError(f"uncorrelated verdict proposal_id: {prop_id}")
            state["last_verdict_core_seq"] = core_seq
            state["seen_verdicts"].add((prop_id, decision))
            if decision == "refused":
                state["refused_proposals"].add(prop_id)
                state["active_proposals"].discard(prop_id)
        elif body_schema == "action_receipt/v0.2":
            prop_id = body.get("proposal_id")
            if prop_id in state["settled_proposals"]:
                raise RuntimeError(f"duplicate receipt for settled proposal_id: {prop_id}")
            if (
                state["active_proposals"]
                and prop_id not in state["active_proposals"]
                and prop_id not in state["refused_proposals"]
            ):
                raise RuntimeError(f"uncorrelated receipt proposal_id: {prop_id}")
            state["settled_proposals"].add(prop_id)
            state["active_proposals"].discard(prop_id)
        state["inbound_seq"] = seq
        state["seen_msg_ids"].add(env["msg_id"])
        state["seen_nonces"].add(env["nonce"])
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


def release_stale_probe(
    report,
    agent,
    reg,
    config,
    surface_id,
    pre_release_frame,
    archive,
    proposal_id="live-release-stale",
    native_actions_path=None,
):
    before_domain = domain(snapshot(archive))
    before_native = (
        Path(native_actions_path).read_bytes()
        if native_actions_path is not None and Path(native_actions_path).exists()
        else None
    )
    send(agent, reg, config, proposal(surface_id, pre_release_frame, proposal_id))
    stale = receive(
        agent,
        lambda b: b.get("proposal_id") == proposal_id,
        report,
        schemas=("action_verdict/v0.2",),
    )
    assert (
        stale.get("decision") == "refused" and stale.get("reason_code") == "STALE_FRAME"
    ), f"pre-refresh frame after release was not refused with STALE_FRAME: {stale}"
    after_domain = domain(snapshot(archive))
    assert before_domain == after_domain, "post-release stale refusal mutated domain state"
    core_seq = stale["core_seq"]
    event_path = archive / "events" / f"{core_seq}.json"
    assert event_path.is_file(), f"missing journal event for stale core_seq {core_seq}"
    event_doc = json.loads(event_path.read_text())
    outcome = event_doc.get("outcome", {})
    assert outcome.get("reason") == "STALE_FRAME", f"unexpected stale outcome reason: {outcome}"
    assert outcome.get("dispatch") is False, "stale proposal outcome must not dispatch"
    records = [
        json.loads(line)
        for line in (archive / "journal.jsonl").read_text().splitlines()[1:]
        if line.strip()
    ]
    matching = [r for r in records if r.get("core_seq") == core_seq]
    assert len(matching) == 1 and matching[0].get("kind") == "refused", (
        f"stale proposal journal record must be refused: {matching}"
    )
    if before_native is not None:
        assert Path(native_actions_path).read_bytes() == before_native, (
            "stale proposal dispatched native actions"
        )
    report.setdefault("assertions", {})["release_stale_before_refresh"] = "PASS"
    report["release_stale_evidence"] = {
        "verdict": stale,
        "domain_sha256": digest(after_domain),
    }
    return stale


def verify_expiry_recovery(
    report,
    agent,
    reg,
    config,
    surface_id,
    expired_path,
    expired_gen,
    expired_sha256,
    recovered_frame,
    archive,
    epoch_before,
    proposal_id="live-expired-frame",
):
    expired_path = Path(expired_path)
    assert not expired_path.exists(), f"expired publication still present: {expired_path}"
    for body in report.get("wire_evidence", ()):
        if body.get("event") == "frame_ready":
            ref = body.get("data", {}).get("frame_ref", {})
            assert ref.get("ramws_path") != str(expired_path), (
                "expired publication ramws_path reached UI/agent wire evidence"
            )
            assert ref.get("generation") != expired_gen, (
                "expired publication generation reached UI/agent wire evidence"
            )
    admitted_shas = set()
    for event_file in sorted((archive / "events").glob("*.json"), key=lambda p: int(p.stem)):
        doc = json.loads(event_file.read_text())
        surf = doc.get("state", {}).get("surfaces", {}).get(surface_id, {})
        frame = surf.get("frame")
        if isinstance(frame, dict):
            assert frame.get("generation") != expired_gen, (
                f"expired generation {expired_gen} committed in authority state"
            )
            if isinstance(frame.get("sha256"), str):
                admitted_shas.add(frame["sha256"])
    if expired_sha256 and expired_sha256 not in admitted_shas:
        assert not (archive / "artifacts" / expired_sha256).exists(), (
            "expired publication pixels were retained as an authority witness"
        )
    send(
        agent,
        reg,
        config,
        proposal(
            surface_id,
            {"generation": expired_gen, "sha256": expired_sha256 or ("0" * 64)},
            proposal_id,
        ),
    )
    refused = receive(
        agent,
        lambda b: b.get("proposal_id") == proposal_id,
        report,
        schemas=("action_verdict/v0.2",),
    )
    assert (
        refused.get("decision") == "refused"
        and refused.get("reason_code") == "STALE_FRAME"
    ), f"expired publication proposal was not refused with STALE_FRAME: {refused}"
    current_state = snapshot(archive)
    assert current_state["epoch"] == epoch_before, "expired publication retired daemon epoch"
    assert recovered_frame["generation"] > expired_gen, (
        "recovered frame generation did not advance past expired publication"
    )
    ui_pixels = Path(recovered_frame["ramws_path"]).read_bytes()
    assert hashlib.sha256(ui_pixels).hexdigest() == recovered_frame["sha256"], (
        "recovered frame digest mismatch"
    )
    retained = (archive / "artifacts" / recovered_frame["sha256"]).read_bytes()
    assert retained == ui_pixels, "recovered frame retained witness mismatch"
    report.setdefault("assertions", {})["expired_publication_recovery"] = "PASS"
    report["expiry_recovery"] = {
        "status": "PASS",
        "expired_generation": expired_gen,
        "expired_ramws_path": str(expired_path),
        "recovered_generation": recovered_frame["generation"],
        "epoch": current_state["epoch"],
        "refusal": refused,
    }
    return recovered_frame


def expiry_recovery_probe(report, ui, agent, regs, config, surface_id, baseline_frame, archive, processes):
    pub_dir = Path(baseline_frame["ramws_path"]).parent
    baseline_gen = baseline_frame["generation"]
    epoch_before = snapshot(archive)["epoch"]
    initial_rgb = set(pub_dir.glob("*.rgb"))
    discovered = []
    discovered_shas = {}
    processes[0].send_signal(signal.SIGSTOP)
    report["commands"].append({"argv": ["signal", "SIGSTOP", "owned-core-expiry"], "rc": 0})
    try:
        deadline = time.monotonic() + 10
        expired_path = None
        while time.monotonic() < deadline:
            if processes[1].poll() is not None:
                raise RuntimeError("adapter exited during expiry probe")
            current_rgb = set(pub_dir.glob("*.rgb"))
            for path in sorted(current_rgb - initial_rgb):
                if path not in discovered:
                    discovered.append(path)
                    try:
                        discovered_shas[path] = hashlib.sha256(path.read_bytes()).hexdigest()
                    except OSError:
                        pass
            unlinked = [p for p in discovered if p not in current_rgb]
            if unlinked and (current_rgb - initial_rgb):
                expired_path = unlinked[0]
                break
            time.sleep(0.005)
        if expired_path is None:
            raise RuntimeError("timed out waiting for adapter lease rotation to expire a publication")
        processes[1].send_signal(signal.SIGSTOP)
        report["commands"].append({"argv": ["signal", "SIGSTOP", "owned-adapter"], "rc": 0})
    finally:
        processes[0].send_signal(signal.SIGCONT)
        report["commands"].append({"argv": ["signal", "SIGCONT", "owned-core-expiry"], "rc": 0})
    expired_gen = baseline_gen + 1
    expired_sha = discovered_shas.get(expired_path, baseline_frame["sha256"])
    wait_for(
        lambda: snapshot(archive)["surfaces"][surface_id]["frame"]["generation"] > expired_gen,
        [processes[0]],
        "post-expiry fresh frame commit",
    )
    send(
        agent,
        regs["agent"],
        config,
        {
            "schema": "mv_tool_call/v0.2",
            "request_id": "observe-refresh",
            "op": "observe",
            "args": {"surface_id": surface_id},
        },
    )
    current = receive(agent, lambda b: b.get("request_id") == "observe-refresh", report)
    assert current.get("status") == "ok", "post-release observe refused: " + str(current)
    recovered = current["observation"]["frame_ref"]
    ui_recovered = receive(
        ui,
        lambda b: b.get("event") == "frame_ready"
        and b["data"]["frame_ref"]["generation"] == recovered["generation"],
        report,
    )["data"]["frame_ref"]
    assert ui_recovered == recovered, "post-expiry UI/agent fresh frame mismatch"
    return verify_expiry_recovery(
        report,
        agent,
        regs["agent"],
        config,
        surface_id,
        expired_path,
        expired_gen,
        expired_sha,
        recovered,
        archive,
        epoch_before,
    )


def verify_probe(report, agent, reg, config, action, frame, receipt, archive, scratch):
    send(agent, reg, config, {"schema": "mv_tool_call/v0.2", "request_id": "verify-live",
                             "op": "wait_verify", "args": {
                                 "proposal_id": action["proposal_id"], "timeout_ms": 10000}})
    verdict = receive(agent, lambda b: b.get("request_id") == "verify-live", report)
    report["verify_verdict"] = verdict
    assert verdict.get("status") == "verified" and verdict.get("receipt", {}).get("verified") is True, (
        "positive wait_verify failed: " + json.dumps(verdict, sort_keys=True))
    assert verdict["receipt"]["proposal_id"] == receipt["proposal_id"], "verification correlation mismatch"
    assert verdict["focus_verified"] is True, "verification lacks focus proof"
    assert verdict["input_mono_ns"] == receipt["native_evidence"]["input_mono_ns"], "input witness mismatch"
    assert verdict["frame_sha256"] == receipt["after_frame"]["sha256"], "verified frame mismatch"
    report["assertions"]["observe_propose_dispatch_receipt"] = "PASS"
    # [TARGET, unit decision] The frozen wait call has no surface/generation
    # override. Apply the public core verifier to this SAME real receipt and
    # retained bytes; only its comparison context is changed. No fake daemon.
    fixture = scratch / "verify-context.json"
    fixture.write_text(json.dumps({"proposal": action, "before": frame, "receipt": receipt}))
    result = run(report, [os.environ["MV_E2E_VERIFY_BIN"], fixture, archive / "artifacts"])
    assert result.returncode == 0, "receipt binding negative control failed: " + result.stderr
    report["verify_negative_control"] = json.loads(result.stdout)
    assert report["verify_negative_control"]["status"] == "PASS", "negative verifier did not pass"
    report["assertions"]["receipt_binding_negative_control"] = "PASS"


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
        "receipt_binding_negative_control": "BLOCKED",
        "stale_no_state_change": "BLOCKED", "release_stale_before_refresh": "BLOCKED",
        "expired_publication_recovery": "BLOCKED", "human_cancel_release_refresh": "BLOCKED",
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
                hello_reply = peer.recv()
                assert hello_reply["body"] == regs["core"]["hello"], "core pin mismatch"
                lane = _lane_state(peer)
                lane["inbound_seq"] = hello_reply["seq"]
                lane["seen_msg_ids"].add(hello_reply["msg_id"])
                lane["seen_nonces"].add(hello_reply["nonce"])
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
            # [TARGET, unit decision] F6 changes browser focus visibly. Verify
            # retained pixels, rather than requesting unavailable OCR evidence.
            action = proposal(surface_id, frame, "live-action-1")
            action["action"] = {"type": "key", "keys": ["F6"]}
            action["expectation"] = {"type": "changed_region", "bbox": {
                "x": 0, "y": 0, "w": frame["width"], "h": frame["height"]}}
            send(agent, regs["agent"], config, action)
            verdict = receive(agent, lambda b: b.get("proposal_id") == "live-action-1", report)
            assert verdict.get("decision") == "admitted", "fresh action refused: " + str(verdict)
            receipt = receive(agent, lambda b: b.get("schema") == "action_receipt/v0.2"
                              and b.get("proposal_id") == "live-action-1", report)
            report["action_receipt"] = receipt
            report["assertions"]["propose_dispatch_receipt"] = "PASS"
            report["assertions"]["observe_propose_dispatch_receipt"] = "FAIL"
            verify_probe(report, agent, regs["agent"], config, action, frame, receipt, archive, scratch)
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
            release_stale_probe(report, agent, regs["agent"], config, surface_id, advanced, archive)
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
                # [TARGET, unit decision] Expire one subscribed publication past
                # the 2-generation lease window while core is held, then verify
                # core drops the expired publication, keeps the daemon, and
                # delivers the fresh frame on the same session.
                fresh = expiry_recovery_probe(
                    report, ui, agent, regs, config, surface_id, fresh, archive, processes
                )
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
            if "before" in locals() and before.returncode == 0:
                owned |= profile_containers(profile) - set(before.stdout.splitlines())
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
            # ownership-proven allocation after the capsule is destroyed.
            if "ram_root" in locals():
                published_dirs = {str(Path(b["data"]["frame_ref"]["ramws_path"]).parent)
                                  for b in report.get("wire_evidence", []) if b.get("event") == "frame_ready"}
                active = set(after.stdout.splitlines()) if after.returncode == 0 else set(owned)
                try:
                    report["ram_cleanup"] = cleanup_capsule_ram(ram_root, owned, published_dirs, active)
                except Exception as error:
                    report["ram_cleanup"] = {"status": "FAIL", "ram_absent": False, "error": str(error)}
            report["container_cleanup"] = "PASS" if after.returncode == 0 and not (
                owned & set(after.stdout.splitlines())) and not profile_containers(profile) else "FAIL"
    report["process_cleanup"] = {"status": "PASS" if all(p.poll() is not None for p in processes) else "FAIL",
                                  "pids": [p.pid for p in processes], "temporary_tree_absent": not scratch.exists(),
                                  "socket_absent": not locals().get("socket_path", scratch).exists()}
    if (report["container_cleanup"] == "PASS"
            and report["process_cleanup"]["status"] == "PASS"
            and report.get("ram_cleanup", {}).get("status") == "PASS"
            and report.get("ram_cleanup", {}).get("ram_absent") is True
            and all(v == "PASS" for v in report["assertions"].values())):
        report["status"] = "DONE"
    print(json.dumps(report, sort_keys=True))
    return 0 if report["status"] == "DONE" else 1


if __name__ == "__main__":
    sys.exit(main())
