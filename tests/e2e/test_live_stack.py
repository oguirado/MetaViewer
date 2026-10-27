"""Offline lifecycle controls; no Docker, X server or host identity is accessed."""

import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import stat
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location(
    "live_stack", Path(__file__).with_name("e2e1_slice") / "stack.py")
stack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stack)


class LiveStackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="stack-tést-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)

    def state(self):
        work = self.root / "run-test"
        work.mkdir()
        return {"schema": "metaviewer.live-stack/v1", "work": str(work),
                "pids": [], "before": ["unrelated"], "capsules": [],
                "ram_before": [], "published": [], "status": "starting"}

    def environment(self):
        env = {key: str(self.root) for key in stack.REQUIRED}
        env.update(MV_E2E_LIVE="1", MV_SRF_LIVE_PROFILE="mv-live-1")
        return env

    def test_ttl_and_parser(self):
        for value, seconds in (("1s", 1), ("45m", 2700), ("24h", 86400)):
            self.assertEqual(stack.ttl_seconds(value), seconds)
        for value in ("0m", "-1s", "1", "1.5h", "25h", "1m;exit"):
            with self.assertRaises(argparse.ArgumentTypeError):
                stack.ttl_seconds(value)
        self.assertEqual(stack.parser().parse_args(["start"]).ttl, 2700)
        self.assertEqual(stack.parser().parse_args(["start", "--ttl", "2s"]).ttl, 2)
        self.assertEqual(stack.parser().parse_args(["stop"]).command, "stop")

    def test_watchdog_expires_using_monotonic_time(self):
        peer = Mock(_sock=object(), _rx=b"")
        tick = Mock()
        with patch.object(stack.time, "monotonic", side_effect=[100, 100, 101, 102]), \
                patch.object(stack.select, "select", return_value=([], [], [])):
            stack.monitor(peer, [Mock(poll=lambda: None)], 2, lambda: False, tick)
        self.assertEqual(tick.call_count, 2)
        peer.recv.assert_not_called()

    def test_watchdog_stop_and_process_failure_controls(self):
        peer, tick = Mock(), Mock()
        stack.monitor(peer, [], 100, lambda: True, tick)
        tick.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, "process exited"):
            stack.monitor(peer, [Mock(poll=lambda: 1)], 100, lambda: False, tick)

    def test_watchdog_drains_buffered_messages_and_refuses_native_errors(self):
        peer = Mock(_sock=object(), _rx=b"buffered\n")
        peer.recv.return_value = {"body": {"event": "error"}}
        with patch.object(stack.select, "select", return_value=([], [], [])), \
                self.assertRaisesRegex(RuntimeError, "native surface error"):
            stack.monitor(peer, [], 100, lambda: False, lambda: None)
        peer.recv.assert_called_once()

    def test_private_atomic_state_roundtrip(self):
        state = self.state()
        stack.save_state(self.root, state)
        path = self.root / "state.json"
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stack.load_state(self.root), state)
        stack.save_state(self.root, dict(state, status="ready"))
        self.assertEqual(stack.load_state(self.root)["status"], "ready")
        self.assertFalse(list(self.root.glob(".state-*")))

    def test_state_rejects_world_readable_unknown_schema_and_symlink(self):
        path = self.root / "state.json"
        stack.save_state(self.root, self.state())
        path.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "unsafe"):
            stack.load_state(self.root)
        path.chmod(0o600)
        path.write_text(json.dumps({"schema": "other"}))
        with self.assertRaisesRegex(RuntimeError, "unknown"):
            stack.load_state(self.root)
        path.unlink()
        path.symlink_to(self.root / "absent")
        with self.assertRaises(OSError):
            stack.load_state(self.root)

    def test_runtime_refuses_absent_public_or_symlink_directory(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(RuntimeError, "AUSENTE"):
            stack.state_root()
        self.root.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, "private"):
            stack.private_dir(self.root)
        self.root.chmod(0o700)
        link = self.root / "link"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "private"):
            stack.private_dir(link)

    def test_missing_env_fails_before_inventory(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(stack, "gw1_active", return_value=False), \
                patch.object(stack, "inventory") as inventory:
            with self.assertRaisesRegex(RuntimeError, "live env AUSENTE"):
                stack.preflight(self.root)
            inventory.assert_not_called()

    def test_existing_state_and_gw1_refuse_before_any_external_command(self):
        for existing in (False, True):
            with self.subTest(existing=existing):
                if existing:
                    stack.save_state(self.root, self.state())
                with patch.object(stack, "gw1_active", return_value=not existing), \
                        patch.object(stack, "checked") as checked:
                    with self.assertRaisesRegex(RuntimeError, "another live"):
                        stack.preflight(self.root)
                    checked.assert_not_called()

    def test_preflight_ownership_and_missing_ui_negative_controls(self):
        env = self.environment()
        with patch.dict(os.environ, env, clear=True), patch.object(stack, "gw1_active", return_value=False), \
                patch.object(stack.shutil, "which", return_value="fake"), \
                patch.object(stack, "inventory", return_value={"unrelated"}), \
                patch.object(stack.live, "profile_containers", return_value={"srf-id-existing"}):
            with self.assertRaisesRegex(RuntimeError, "already allocated"):
                stack.preflight(self.root)
        with patch.dict(os.environ, env, clear=True), patch.object(stack, "gw1_active", return_value=False), \
                patch.object(stack.shutil, "which", return_value="fake"), \
                patch.object(stack, "inventory", return_value=set()), \
                patch.object(stack.live, "profile_containers", return_value=set()), \
                patch.object(stack, "ROOT", self.root):
            with self.assertRaisesRegex(RuntimeError, "shipped UI build AUSENTE"):
                stack.preflight(self.root)
            for name in ("ui/dist/renderer/index.html", "ui/dist/preload/preload.cjs"):
                path = self.root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            self.assertEqual(stack.preflight(self.root), set())

    def test_profile_and_shipped_host_override_refuse(self):
        for changes, message in (({"MV_SRF_LIVE_PROFILE": "other"}, "mv-live-1"),
                                 ({"MV_CORE_BOOTSTRAP": "/override"}, "shipped host")):
            with patch.dict(os.environ, dict(self.environment(), **changes), clear=True), \
                    patch.object(stack, "gw1_active", return_value=False), \
                    patch.object(stack.shutil, "which", return_value="fake"):
                with self.assertRaisesRegex(RuntimeError, message):
                    stack.preflight(self.root)

    def test_electron_environment_excludes_loader_and_runtime_injection(self):
        safe = {"DISPLAY": ":123", "XAUTHORITY": "private", "MV_CORE_CONFIG": "config",
                "XDG_RUNTIME_DIR": "runtime", "PATH": "tools"}
        bad = {"LD_PRELOAD": "inject", "NODE_OPTIONS": "--inspect", "ELECTRON_RUN_AS_NODE": "1",
               "ELECTRON_DISABLE_SANDBOX": "1", "PYTHONPATH": "inject", "BASH_ENV": "inject"}
        self.assertEqual(stack.electron_environment(dict(safe, **bad)), safe)

    def test_signals_require_integer_non_system_pid_and_matching_identity(self):
        with patch.object(stack, "identity", return_value="fresh"), patch.object(stack.os, "kill") as kill, \
                patch.object(stack.os, "getpgid", return_value=-999):
            for pid in (0, 1, -5, "25", True, os.getpid()):
                with self.assertRaisesRegex(RuntimeError, "unsafe"):
                    stack.signal_record({"pid": pid, "identity": "fresh"}, signal.SIGTERM)
            stack.signal_record({"pid": 456789, "identity": "stale"}, signal.SIGTERM)
            stack.signal_record({"pid": 456789, "identity": None}, signal.SIGTERM)
            kill.assert_not_called()
            stack.signal_record({"pid": 456789, "identity": "fresh"}, signal.SIGTERM)
            kill.assert_called_once_with(456789, signal.SIGTERM)
        self.assertFalse(stack.alive({"pid": 456789, "identity": None}))

    def test_same_process_group_is_never_signalled(self):
        with patch.object(stack, "identity", return_value="birth"), \
                patch.object(stack.os, "getpgid", return_value=os.getpgrp()), \
                patch.object(stack.os, "kill") as kill:
            with self.assertRaisesRegex(RuntimeError, "caller process group"):
                stack.signal_record({"pid": 456789, "identity": "birth"}, signal.SIGTERM)
            kill.assert_not_called()

    def test_cleanup_touches_only_owned_capsule_and_new_ram(self):
        state = self.state()
        state["capsules"] = ["srf-id-owned"]
        ram = self.root / "ram"
        ram.mkdir()
        (ram / "srf-id-owned").mkdir()
        (ram / "unrelated").mkdir()
        with patch.dict(os.environ, dict(self.environment(), MV_SRF_LIVE_RAM_ROOT=str(ram)), clear=True), \
                patch.object(stack, "inventory", side_effect=[{"unrelated", "srf-id-owned"}, {"unrelated"}]), \
                patch.object(stack.live, "profile_containers", return_value=set()), \
                patch.object(stack, "checked", return_value="") as checked:
            stack.cleanup(state, self.root)
        self.assertFalse((ram / "srf-id-owned").exists())
        self.assertTrue((ram / "unrelated").exists())
        self.assertFalse((self.root / "state.json").exists())
        self.assertFalse(Path(state["work"]).exists())
        self.assertEqual(checked.call_count, 1)
        self.assertEqual(checked.call_args.args[0][2:4], ["--container", "srf-id-owned"])

    def test_cleanup_leak_retains_receipt_and_existing_ram(self):
        state = self.state()
        state["capsules"] = ["srf-id-owned"]
        state["ram_before"] = ["srf-id-owned"]
        ram = self.root / "ram"
        ram.mkdir()
        (ram / "srf-id-owned").mkdir()
        leak = self.root / "published"
        leak.mkdir()
        state["published"] = [str(leak)]
        with patch.dict(os.environ, dict(self.environment(), MV_SRF_LIVE_RAM_ROOT=str(ram)), clear=True), \
                patch.object(stack, "inventory", return_value={"unrelated"}), \
                patch.object(stack.live, "profile_containers", return_value=set()):
            with self.assertRaisesRegex(RuntimeError, "published RAM cleanup failed"):
                stack.cleanup(state, self.root)
        self.assertTrue((ram / "srf-id-owned").exists())
        self.assertTrue((self.root / "state.json").exists())

    def test_stop_absent_idempotent_and_dead_supervisor_preserves_receipt(self):
        with redirect_stdout(io.StringIO()) as out:
            stack.stop_stack(self.root)
        self.assertIn("already_absent=true", out.getvalue())
        stack.save_state(self.root, self.state())
        with self.assertRaisesRegex(RuntimeError, "supervisor absent"):
            stack.stop_stack(self.root)
        self.assertTrue((self.root / "state.json").exists())

    def test_stop_waits_for_verified_supervisor_cleanup(self):
        state = self.state()
        state["supervisor"] = {"pid": 456789, "identity": "birth"}
        stack.save_state(self.root, state)
        def finish(*_):
            (self.root / "state.json").unlink()
        with patch.object(stack, "identity", return_value="birth"), \
                patch.object(stack, "signal_record", side_effect=finish) as send, \
                redirect_stdout(io.StringIO()) as out:
            stack.stop_stack(self.root)
        send.assert_called_once_with(state["supervisor"], signal.SIGTERM)
        self.assertIn("state=absent", out.getvalue())


if __name__ == "__main__":
    unittest.main()
