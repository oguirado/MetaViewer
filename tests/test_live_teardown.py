"""Unit tests for live runner RAM allocation teardown and bounded stack state."""

from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, rel: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


live = _load("mv_e2e_live", "tests/e2e/e2e1_slice/live.py")
stack = _load("mv_e2e_stack", "tests/e2e/e2e1_slice/stack.py")
g_ai_stack = _load("mv_e2e_g_ai_stack", "tests/e2e/e2e1_slice/g_ai_stack.py")
gate_g_ai = _load("mv_gate_g_ai", "tools/gate_g_ai.py")
test_live_stack = _load("mv_test_live_stack", "tests/e2e/test_live_stack.py")

LiveStackTests = test_live_stack.LiveStackTests


class LiveRunnerTeardownTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="teardown-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.ram = self.root / "ram"
        self.ram.mkdir()
        self.state_dir = self.root / "srf-state"
        self.state_dir.mkdir()

    def test_capsule_from_receipt_identifies_only_owned_srf_id(self):
        lease_receipt = {
            "Lease": {"ProfileID": "mv-live-1"},
            "Capsule": {"container": "srf-id-a1b2c3d4", "run_id": "srf-id-a1b2c3d4"},
        }
        direct_receipt = {"profile": "mv-live-1", "container": "srf-id-e5f60718"}
        self.assertEqual(live.capsule_from_receipt(lease_receipt, "mv-live-1"), "srf-id-a1b2c3d4")
        self.assertEqual(live.capsule_from_receipt(direct_receipt, "mv-live-1"), "srf-id-e5f60718")

        for rejected in (
            {"Lease": {"ProfileID": "other-profile"}, "Capsule": {"container": "srf-id-a1b2c3d4"}},
            {"Lease": {"ProfileID": "mv-live-1"}, "Capsule": {"container": "srf-pg-postgres01"}},
            {"Lease": {"ProfileID": "mv-live-1"}, "Capsule": {"container": "../srf-id-escape"}},
            {"Lease": {"ProfileID": "mv-live-1"}, "Capsule": {"container": "srf-id-a1b2c3d4", "run_id": "srf-id-other"}},
            {"container": "srf-id-no-profile"},
            {"profile": "mv-live-1", "container": "srf-pg-1234"},
        ):
            self.assertIsNone(live.capsule_from_receipt(rejected, "mv-live-1"))

    def test_profile_containers_reads_only_matching_create_receipts(self):
        (self.state_dir / "srf-id-owned01.json").write_text(json.dumps({
            "Lease": {"ProfileID": "mv-live-1"},
            "Capsule": {"container": "srf-id-owned01", "run_id": "srf-id-owned01"},
        }), encoding="utf-8")
        (self.state_dir / "srf-id-foreign02.json").write_text(json.dumps({
            "Lease": {"ProfileID": "other-profile"},
            "Capsule": {"container": "srf-id-foreign02", "run_id": "srf-id-foreign02"},
        }), encoding="utf-8")
        (self.state_dir / "srf-pg-db01.json").write_text(json.dumps({
            "Lease": {"ProfileID": "mv-live-1"},
            "Capsule": {"container": "srf-pg-db01", "run_id": "srf-pg-db01"},
        }), encoding="utf-8")
        (self.state_dir / "corrupt.json").write_text("{not-json", encoding="utf-8")

        with patch.dict(os.environ, {"MV_SRF_STATE_DIR": str(self.state_dir)}, clear=False):
            found = live.profile_containers("mv-live-1")
        self.assertEqual(found, {"srf-id-owned01"})

    def test_cleanup_capsule_ram_removes_only_destroyed_owned_dir_and_preserves_foreign(self):
        owned = self.ram / "srf-id-owned01"
        foreign_id = self.ram / "srf-id-foreign02"
        foreign_pg = self.ram / "srf-pg-cluster9"
        pub = self.root / "published-frames"
        for d in (owned, foreign_id, foreign_pg):
            d.mkdir()
            (d / "payload.bin").write_bytes(b"data")

        receipt = live.cleanup_capsule_ram(
            self.ram,
            capsules=["srf-id-owned01"],
            published=[str(pub)],
            active_containers={"srf-id-foreign02", "srf-pg-cluster9"},
        )
        self.assertEqual(receipt["status"], "PASS")
        self.assertTrue(receipt["ram_absent"])
        self.assertEqual(receipt["capsules"], ["srf-id-owned01"])
        self.assertEqual(receipt["owned_allocations"], [str(owned)])
        self.assertEqual(receipt["owned_allocations_removed"], [str(owned)])
        self.assertEqual(receipt["remaining"], [])
        self.assertFalse(owned.exists())
        self.assertTrue((foreign_id / "payload.bin").is_file())
        self.assertTrue((foreign_pg / "payload.bin").is_file())

        with self.assertRaisesRegex(RuntimeError, "unsafe or non-identity capsule allocation"):
            live.cleanup_capsule_ram(self.ram, capsules=["srf-pg-cluster9"], published=[], active_containers=set())

    def test_cleanup_capsule_ram_refuses_removal_while_capsule_active(self):
        owned = self.ram / "srf-id-active01"
        foreign_id = self.ram / "srf-id-foreign02"
        foreign_pg = self.ram / "srf-pg-cluster9"
        for d in (owned, foreign_id, foreign_pg):
            d.mkdir()

        receipt = live.cleanup_capsule_ram(
            self.ram,
            capsules=["srf-id-active01"],
            published=[],
            active_containers={"srf-id-active01", "srf-id-foreign02"},
        )
        self.assertEqual(receipt["status"], "FAIL")
        self.assertFalse(receipt["ram_absent"])
        self.assertEqual(receipt["owned_allocations_removed"], [])
        self.assertEqual(receipt["remaining"], [str(owned)])
        self.assertTrue(owned.exists())
        self.assertTrue(foreign_id.exists())
        self.assertTrue(foreign_pg.exists())

    def test_g_ai_stack_session_exit_destroys_capsule_and_removes_only_owned_ram(self):
        owned = self.ram / "srf-id-gai0001"
        foreign_id = self.ram / "srf-id-foreign02"
        foreign_pg = self.ram / "srf-pg-cluster9"
        for d in (owned, foreign_id, foreign_pg):
            d.mkdir()
        state_root = self.root / "state"
        state_root.mkdir(mode=0o700)
        work = state_root / "run-g-ai"
        work.mkdir(mode=0o700)

        sess = g_ai_stack.Session()
        sess.root = state_root
        sess.work = work
        sess.surface_id = "surf-1"
        sess.regs = {
            c: live.registration(c, "a" * 40, "test")
            for c in ("core", "ui", "agent", "daemon")
        }
        sess.config = {
            "session_id": "g-ai-test",
            "core": sess.regs["core"],
            "peers": [sess.regs[c] for c in ("ui", "agent", "daemon")],
        }
        sess.ui = MagicMock()
        sess.ui.recv.return_value = {
            "body": {"event": "state_changed", "data": {"surface": {"state": "destroyed"}}}
        }
        sess.agent = MagicMock()
        sess.peers = [sess.ui, sess.agent]
        sess.processes = []
        sess.state = {
            "schema": "metaviewer.live-stack/v1",
            "status": "ready",
            "pids": [],
            "capsules": ["srf-id-gai0001"],
            "published": [],
            "work": str(work),
            "surface_id": "surf-1",
        }
        g_ai_stack.stack.save_state(state_root, sess.state)

        env = {key: str(self.root) for key in stack.REQUIRED}
        env.update(
            MV_E2E_LIVE="1",
            MV_SRF_LIVE_PROFILE="mv-live-1",
            MV_SRF_LIVE_RAM_ROOT=str(self.ram),
            MV_SRF_STATE_DIR=str(self.state_dir),
        )
        with patch.dict(os.environ, env, clear=True), \
                patch.object(g_ai_stack.stack, "inventory", return_value={"srf-id-foreign02"}), \
                patch.object(g_ai_stack.stack.live, "profile_containers", return_value=set()), \
                patch.object(g_ai_stack.stack, "remember_tree"), \
                patch.object(g_ai_stack.live, "send") as mock_send:
            sess.__exit__(None, None, None)

        mock_send.assert_called_once_with(
            sess.ui,
            sess.regs["ui"],
            sess.config,
            {"schema": "surface_request/v0.2", "op": "destroy", "params": {"surface_id": "surf-1"}},
        )
        self.assertTrue(sess.cleanup["ram_absent"])
        self.assertEqual(sess.cleanup["remaining"], [])
        self.assertEqual(sess.cleanup["owned_allocations_removed"], [str(owned)])
        self.assertFalse(owned.exists())
        self.assertTrue(foreign_id.exists())
        self.assertTrue(foreign_pg.exists())

    def test_gate_g_ai_requires_ram_absent_in_cleanup_receipt(self):
        class _FakeSession:
            def __init__(self, ram_absent: bool, remaining: list[str]):
                self.report = {}
                self.cleanup = {
                    "capsules": ["srf-id-owned01"],
                    "owned_allocations": ["/dev/shm/srf-id-owned01"],
                    "owned_allocations_removed": ["/dev/shm/srf-id-owned01"] if ram_absent else [],
                    "ram_absent": ram_absent,
                    "remaining": remaining,
                }

            def __enter__(self):
                return self

            def prepare_fixture(self):
                raise gate_g_ai.GateFailure("probe_stop", "stop before live steps")

            def __exit__(self, *exc):
                return True

        report_ok = {"assertions": {}, "negative_controls": {}}
        gate_g_ai.run_gate(report_ok, {}, session_factory=lambda: _FakeSession(True, []))
        self.assertTrue(report_ok["cleanup"]["ram_absent"])

        report_leak = {"assertions": {}, "negative_controls": {}}
        with self.assertRaisesRegex(gate_g_ai.GateFailure, "cleanup proof missing"):
            gate_g_ai.run_gate(
                report_leak,
                {},
                session_factory=lambda: _FakeSession(False, ["/dev/shm/srf-id-owned01"]),
            )

    def test_t8_r2_013_receive_enforces_envelope_seq_schema_and_correlation(self):
        regs = {
            c: live.registration(c, "a" * 40, "r2013")
            for c in ("core", "ui", "agent", "daemon")
        }
        config = {
            "session_id": "gw1-r2013",
            "core": regs["core"],
            "peers": [regs[c] for c in ("ui", "agent", "daemon")],
        }

        def make_core_env(to_role, seq, body, msg_id=None, nonce=None):
            return {
                "schema": "envelope/v0.2",
                "msg_id": msg_id or f"core-1-{seq}",
                "ts_ns": seq * 10,
                "from": regs["core"]["endpoint"],
                "to": regs[to_role]["endpoint"],
                "session_id": config["session_id"],
                "seq": seq,
                "nonce": nonce or f"nonce-1-{seq}",
                "body": body,
            }

        class _StubPeer:
            def __init__(self, frames):
                self._frames = list(frames)
                self.next_seq = 1
                self.sent = []

            def send(self, env):
                self.sent.append(env)
                self.next_seq += 1

            def recv(self):
                return self._frames.pop(0)

        # Negative control 1: malformed body must raise before predicate match.
        malformed_peer = _StubPeer([
            make_core_env("agent", 1, {"schema": "mv_tool_result/v0.2", "request_id": "bad"})
        ])
        live.send(
            malformed_peer,
            regs["agent"],
            config,
            {"schema": "mv_tool_call/v0.2", "request_id": "bad", "op": "observe", "args": {"surface_id": "s1"}},
        )
        pred_spy = MagicMock(return_value=True)
        with self.assertRaises((RuntimeError, ValueError)):
            live.receive(malformed_peer, pred_spy, {})
        pred_spy.assert_not_called()

        # Negative control 2: reordered or duplicate envelope from a prior phase must not match.
        valid_obs = {
            "schema": "mv_tool_result/v0.2",
            "request_id": "obs-1",
            "op": "observe",
            "status": "ok",
            "observation": {
                "schema": "observation/v0.2",
                "frame_ref": {
                    "schema": "frame_ref/v0.2",
                    "surface_id": "surf-1",
                    "generation": 1,
                    "tick": 1,
                    "ts_ns": 10,
                    "width": 2,
                    "height": 1,
                    "format": "rgb24",
                    "ramws_path": "/dev/shm/f1.rgb",
                    "sha256": "b" * 64,
                    "capture_us": 5,
                },
            },
        }
        dup_peer = _StubPeer([
            make_core_env("agent", 2, valid_obs, msg_id="m-2", nonce="n-2"),
            # Reordered/duplicate seq <= 2 from prior phase:
            make_core_env("agent", 2, valid_obs, msg_id="m-3", nonce="n-3"),
        ])
        live.send(
            dup_peer,
            regs["agent"],
            config,
            {"schema": "mv_tool_call/v0.2", "request_id": "obs-1", "op": "observe", "args": {"surface_id": "surf-1"}},
        )
        report = {}
        first = live.receive(dup_peer, lambda b: b.get("request_id") == "obs-1", report)
        self.assertEqual(first["request_id"], "obs-1")
        pred_dup = MagicMock(return_value=True)
        with self.assertRaises(RuntimeError):
            live.receive(dup_peer, pred_dup, report)
        pred_dup.assert_not_called()

        # Negative control 3: duplicate retired request_id even with higher seq must not match.
        retired_peer = _StubPeer([
            make_core_env("agent", 1, valid_obs, msg_id="m-10", nonce="n-10"),
            make_core_env("agent", 2, valid_obs, msg_id="m-11", nonce="n-11"),
        ])
        live.send(
            retired_peer,
            regs["agent"],
            config,
            {"schema": "mv_tool_call/v0.2", "request_id": "obs-1", "op": "observe", "args": {"surface_id": "surf-1"}},
        )
        live.receive(retired_peer, lambda b: b.get("request_id") == "obs-1", {})
        pred_retired = MagicMock(return_value=True)
        with self.assertRaises(RuntimeError):
            live.receive(retired_peer, pred_retired, {})
        pred_retired.assert_not_called()

    def test_t8_r2_009_release_proposes_stale_before_refresh_then_readmits(self):
        self.assertTrue(
            hasattr(live, "release_stale_probe"),
            "live.py must expose release_stale_probe for post-release stale-before-refresh verification",
        )
        archive = self.root / "archive-r2009"
        (archive / "events").mkdir(parents=True)
        base_state = {
            "surfaces": {"surf-1": {"agent_controlled": True, "live": True}},
            "leases": {},
            "pending": {},
            "draining": {},
            "remaining_budget": 9999,
            "epoch": 1,
            "core_seq": 5,
        }
        (archive / "events" / "5.json").write_text(json.dumps({
            "state": base_state,
            "outcome": {"core_seq": 5, "reason": None, "dispatch": False},
        }))
        (archive / "journal.jsonl").write_text(
            json.dumps({"schema": "metaviewer.journal/v1", "session_id": "gw1-r2009", "core_version": "0.1.1"}) + "\n"
            + json.dumps({
                "schema": "session_record/v0.2",
                "core_seq": 5,
                "kind": "surface_changed",
                "msg_id": "release-1",
                "prev_sha256": "0" * 64,
            }) + "\n"
        )
        native_log = self.root / "native-actions.log"
        native_log.write_bytes(b"action-1\n")

        regs = {
            c: live.registration(c, "a" * 40, "r2009")
            for c in ("core", "ui", "agent", "daemon")
        }
        config = {
            "session_id": "gw1-r2009",
            "core": regs["core"],
            "peers": [regs[c] for c in ("ui", "agent", "daemon")],
        }
        pre_frame = {"generation": 2, "sha256": "c" * 64}

        class _FakeAgent:
            def __init__(self, on_send):
                self.next_seq = 1
                self._on_send = on_send
                self._SingleReply = None

            def send(self, env):
                self.next_seq += 1
                self._SingleReply = self._on_send(env)

            def recv(self):
                return self._SingleReply

        def record_refusal(env, dispatch=False, mutate_native=False):
            stale_state = dict(base_state, core_seq=6)
            (archive / "events" / "6.json").write_text(json.dumps({
                "state": stale_state,
                "outcome": {"core_seq": 6, "reason": "STALE_FRAME", "dispatch": dispatch},
            }))
            with open(archive / "journal.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "schema": "session_record/v0.2",
                    "core_seq": 6,
                    "kind": "executed" if dispatch else "refused",
                    "msg_id": env["msg_id"],
                    "prev_sha256": "1" * 64,
                }) + "\n")
            if mutate_native:
                native_log.write_bytes(b"action-1\nstale-dispatched\n")
            return {
                "schema": "envelope/v0.2",
                "msg_id": "core-1-6",
                "ts_ns": 60,
                "from": regs["core"]["endpoint"],
                "to": regs["agent"]["endpoint"],
                "session_id": config["session_id"],
                "seq": 6,
                "nonce": "nonce-6",
                "body": {
                    "schema": "action_verdict/v0.2",
                    "proposal_id": env["body"]["proposal_id"],
                    "decision": "refused",
                    "reason_code": "STALE_FRAME",
                    "core_seq": 6,
                },
            }

        report = {"assertions": {}}
        agent_ok = _FakeAgent(lambda env: record_refusal(env, dispatch=False, mutate_native=False))
        live.release_stale_probe(
            report, agent_ok, regs["agent"], config, "surf-1", pre_frame, archive,
            native_actions_path=native_log,
        )
        self.assertEqual(report["assertions"]["release_stale_before_refresh"], "PASS")
        self.assertEqual(native_log.read_bytes(), b"action-1\n")

        # Negative control 1: if stale proposal record dispatches, probe must fail.
        agent_bad_dispatch = _FakeAgent(lambda env: record_refusal(env, dispatch=True, mutate_native=False))
        with self.assertRaises(AssertionError):
            live.release_stale_probe(
                {"assertions": {}}, agent_bad_dispatch, regs["agent"], config, "surf-1", pre_frame, archive,
                proposal_id="live-release-stale-bad1", native_actions_path=native_log,
            )

        # Negative control 2: if native-actions bytes change on stale proposal, probe must fail.
        agent_bad_native = _FakeAgent(lambda env: record_refusal(env, dispatch=False, mutate_native=True))
        with self.assertRaises(AssertionError):
            live.release_stale_probe(
                {"assertions": {}}, agent_bad_native, regs["agent"], config, "surf-1", pre_frame, archive,
                proposal_id="live-release-stale-bad2", native_actions_path=native_log,
            )

    def test_t8_r2_015_expired_publication_refused_daemon_kept_and_fresh_delivered(self):
        self.assertTrue(
            hasattr(live, "verify_expiry_recovery"),
            "live.py must expose verify_expiry_recovery for publication-expiry recovery verification",
        )
        archive = self.root / "archive-r2015"
        (archive / "events").mkdir(parents=True)
        (archive / "artifacts").mkdir(parents=True)
        pub_dir = self.ram / "frames-r2015"
        pub_dir.mkdir(mode=0o700)

        expired_bytes = b"\xff\x00\x00\x00\xff\x00"
        expired_sha = live.hashlib.sha256(expired_bytes).hexdigest()
        expired_path = pub_dir / "expired-gen3.rgb"
        # Expired publication was already unlinked before core read it:
        self.assertFalse(expired_path.exists())

        fresh_bytes = b"\x00\x00\xff\xff\xff\x00"
        fresh_sha = live.hashlib.sha256(fresh_bytes).hexdigest()
        fresh_path = pub_dir / "fresh-gen4.rgb"
        fresh_path.write_bytes(fresh_bytes)
        (archive / "artifacts" / fresh_sha).write_bytes(fresh_bytes)

        state = {
            "surfaces": {
                "surf-1": {
                    "agent_controlled": True,
                    "live": True,
                    "frame": {"generation": 4, "sha256": fresh_sha, "width": 2, "height": 1},
                }
            },
            "leases": {},
            "pending": {},
            "draining": {},
            "remaining_budget": 9998,
            "epoch": 1,
            "core_seq": 8,
        }
        (archive / "events" / "7.json").write_text(json.dumps({
            "state": state,
            "outcome": {"core_seq": 7, "reason": None, "dispatch": False},
        }))
        (archive / "events" / "8.json").write_text(json.dumps({
            "state": state,
            "outcome": {"core_seq": 8, "reason": "STALE_FRAME", "dispatch": False},
        }))
        (archive / "journal.jsonl").write_text(
            json.dumps({"schema": "metaviewer.journal/v1", "session_id": "gw1-r2015", "core_version": "0.1.1"}) + "\n"
            + json.dumps({
                "schema": "session_record/v0.2",
                "core_seq": 7,
                "kind": "surface_changed",
                "msg_id": "frame-4",
                "prev_sha256": "0" * 64,
            }) + "\n"
            + json.dumps({
                "schema": "session_record/v0.2",
                "core_seq": 8,
                "kind": "refused",
                "msg_id": "live-expired-frame",
                "prev_sha256": "1" * 64,
            }) + "\n"
        )

        regs = {
            c: live.registration(c, "a" * 40, "r2015")
            for c in ("core", "ui", "agent", "daemon")
        }
        config = {
            "session_id": "gw1-r2015",
            "core": regs["core"],
            "peers": [regs[c] for c in ("ui", "agent", "daemon")],
        }
        fresh_ref = {
            "schema": "frame_ref/v0.2",
            "surface_id": "surf-1",
            "generation": 4,
            "tick": 4,
            "ts_ns": 40,
            "width": 2,
            "height": 1,
            "format": "rgb24",
            "ramws_path": str(fresh_path),
            "sha256": fresh_sha,
            "capture_us": 5,
        }

        class _ExpiryAgent:
            def __init__(self):
                self.next_seq = 1

            def send(self, env):
                self.next_seq += 1
                self._pid = env["body"]["proposal_id"]

            def recv(self):
                return {
                    "schema": "envelope/v0.2",
                    "msg_id": "core-1-8",
                    "ts_ns": 80,
                    "from": regs["core"]["endpoint"],
                    "to": regs["agent"]["endpoint"],
                    "session_id": config["session_id"],
                    "seq": 8,
                    "nonce": "nonce-8",
                    "body": {
                        "schema": "action_verdict/v0.2",
                        "proposal_id": self._pid,
                        "decision": "refused",
                        "reason_code": "STALE_FRAME",
                        "core_seq": 8,
                    },
                }

        report = {
            "assertions": {},
            "wire_evidence": [{"schema": "surface_event/v0.2", "event": "frame_ready", "data": {"frame_ref": fresh_ref}}],
        }
        live.verify_expiry_recovery(
            report,
            _ExpiryAgent(),
            regs["agent"],
            config,
            "surf-1",
            expired_path,
            3,
            expired_sha,
            fresh_ref,
            archive,
            epoch_before=1,
        )
        self.assertEqual(report["assertions"]["expired_publication_recovery"], "PASS")

        # Negative control 1: if expired publication pixels reached UI wire_evidence, fail closed.
        leaked_report = {
            "assertions": {},
            "wire_evidence": [
                {
                    "schema": "surface_event/v0.2",
                    "event": "frame_ready",
                    "data": {
                        "frame_ref": dict(fresh_ref, generation=3, ramws_path=str(expired_path), sha256=expired_sha)
                    },
                },
                {"schema": "surface_event/v0.2", "event": "frame_ready", "data": {"frame_ref": fresh_ref}},
            ],
        }
        with self.assertRaises(AssertionError):
            live.verify_expiry_recovery(
                leaked_report,
                _ExpiryAgent(),
                regs["agent"],
                config,
                "surf-1",
                expired_path,
                3,
                expired_sha,
                fresh_ref,
                archive,
                epoch_before=1,
            )

        # Negative control 2: if expired publication bytes were retained in artifacts, fail closed.
        (archive / "artifacts" / expired_sha).write_bytes(expired_bytes)
        try:
            with self.assertRaises(AssertionError):
                live.verify_expiry_recovery(
                    {"assertions": {}, "wire_evidence": []},
                    _ExpiryAgent(),
                    regs["agent"],
                    config,
                    "surf-1",
                    expired_path,
                    3,
                    expired_sha,
                    fresh_ref,
                    archive,
                    epoch_before=1,
                )
        finally:
            (archive / "artifacts" / expired_sha).unlink()


if __name__ == "__main__":
    unittest.main()
