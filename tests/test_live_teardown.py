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


if __name__ == "__main__":
    unittest.main()
