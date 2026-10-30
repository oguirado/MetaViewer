"""Offline inventories only: never query the host Docker daemon."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("mv_ram_admission", Path(__file__).resolve().parent.parent / "tools" / "mv_ram_admission.py")
ram = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ram)
NAME = "12345-" + "a" * 32 + "-" + "b" * 64


class Inventory:
    def __init__(self, absent):
        self.value = absent

    def absent(self):
        return self.value


class ReclaimTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / NAME
        self.path.touch(mode=0o600)

    def run_reclaim(self, absent=True, dead=True, apply=False):
        return ram.reclaim(self.root, apply, Inventory(absent), lambda pid: dead)[0]

    def test_dead_and_absent_dry_run_then_apply(self):
        result = self.run_reclaim()
        self.assertEqual(result["action"], "would_remove")
        self.assertTrue(self.path.exists())
        self.assertEqual(self.run_reclaim(apply=True)["action"], "removed")
        self.assertFalse(self.path.exists())

    def test_mut_reclaim_unverified(self):
        for absent in (False, None, 0, "absent"):
            for apply in (False, True):
                with self.subTest(absent=absent, apply=apply):
                    self.assertEqual(self.run_reclaim(absent, apply=apply)["action"], "keep")
                    self.assertTrue(self.path.exists())

    def test_alive_or_permission_unknown_kept(self):
        self.assertEqual(self.run_reclaim(dead=False, apply=True)["action"], "keep")
        for error in (PermissionError(), OSError()):
            with patch.object(ram.os, "kill", side_effect=error):
                self.assertFalse(ram.pid_dead(12345))
        with patch.object(ram.os, "kill", side_effect=ProcessLookupError()):
            self.assertTrue(ram.pid_dead(12345))

    def test_pid_probe_rejects_reserved_and_caller_ids(self):
        with patch.object(ram.os, "kill") as send:
            for pid in (0, 1, -1, True, "12345", os.getpid(), os.getpgid(0)):
                self.assertFalse(ram.pid_dead(pid))
            send.assert_not_called()

    def test_explicit_local_endpoint_scrubs_context_and_tls(self):
        argv = ["docker", "--host", "unix:///fake/docker.sock", "container", "ls"]
        with patch.dict(os.environ, {"DOCKER_CONTEXT": "remote", "DOCKER_TLS_VERIFY": "1"}):
            with patch.object(ram.subprocess, "run") as run:
                run.return_value.stdout = ""
                self.assertEqual(ram.command(argv), "")
                environment = run.call_args.kwargs["env"]
                self.assertNotIn("DOCKER_CONTEXT", environment)
                self.assertNotIn("DOCKER_TLS_VERIFY", environment)
                self.assertEqual(run.call_args.args[0], argv)

    def test_changed_owner_after_inventory_kept(self):
        states = iter([True, False])
        result = ram.reclaim(self.root, True, Inventory(True), lambda pid: next(states))
        self.assertEqual(result[0]["action"], "keep")
        self.assertTrue(self.path.exists())

    def test_unsafe_files_and_unknown_names_kept(self):
        self.path.unlink()
        self.path.symlink_to("unknown")
        (self.root / "unknown").touch(mode=0o600)
        results = ram.reclaim(self.root, True, Inventory(True), lambda pid: True)
        self.assertTrue(all(item["action"] == "keep" for item in results))
        self.assertTrue(self.path.is_symlink())
        with self.assertRaises(OSError):
            ram.reclaim(self.path, True, Inventory(True))

    def test_nonzero_and_wrong_mode_kept(self):
        self.path.write_bytes(b"unknown")
        self.assertEqual(self.run_reclaim(apply=True)["action"], "keep")
        self.path.write_bytes(b"")
        self.path.chmod(0o644)
        self.assertEqual(self.run_reclaim(apply=True)["action"], "keep")
        self.root.chmod(0o755)
        with self.assertRaises(ValueError):
            self.run_reclaim(apply=True)

    def test_changed_reservation_kept(self):
        path = self.path
        class ChangingInventory:
            def absent(self):
                path.write_bytes(b"changed")
                return True
        result = ram.reclaim(self.root, True, ChangingInventory(), lambda pid: True)
        self.assertEqual(result[0]["action"], "keep")
        self.assertTrue(path.exists())

    def test_fixed_readonly_inventory_argv_and_stopped_capsules(self):
        for raw, expected in (("", True), ("unrelated\n", True),
                              ("srf-id-demo\n", False), ("srf-ng-hcap-hc-abcdef123456-1\n", False),
                              ("bad name\n", None)):
            calls = []
            def run(argv):
                calls.append(argv)
                return '"unix:///fake/docker.sock"' if argv[1] == "context" else raw
            with patch.dict(os.environ, {}, clear=True):
                self.assertIs(ram.NativeInventory(run).absent(), expected)
            self.assertEqual(calls, [
                ["docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
                ["docker", "--host", "unix:///fake/docker.sock", "container", "ls", "--all", "--no-trunc", "--format", "{{.Names}}"],
            ])

    def test_inventory_failure_or_remote_is_unknown(self):
        for value in ('"tcp://remote:2375"', 'null', 'broken'):
            with patch.dict(os.environ, {}, clear=True):
                self.assertIsNone(ram.NativeInventory(lambda argv: value).absent())
        def failure(argv):
            raise subprocess.CalledProcessError(1, argv)
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(ram.NativeInventory(failure).absent())
        with patch.dict(os.environ, {"DOCKER_HOST": "tcp://remote:2375"}, clear=True):
            self.assertIsNone(ram.NativeInventory(lambda argv: self.fail("remote call")).absent())

    def test_per_profile_inventory_ignores_protected_and_unrelated(self):
        import hashlib
        profile = 'mv-example'
        self.path.unlink()
        self.path = self.root / ("12345-" + "a" * 32 + "-" +
            hashlib.sha256(profile.encode()).hexdigest() + "--" + profile)
        self.path.touch(mode=0o600)
        protected = "srf-id-cuentas-1\nsrf-id-perplexity-1\nsrf-pg-notepad-1\nsrf-egress-proxy\nsrf-id-other\n"
        for extra, expected in (("", "would_remove"), ("srf-id-mv-example\n", "keep"),
                                ("srf-pg-mv-example\n", "keep"),
                                ("srf-ng-hcap-hc-abcdef123456-1\n", "keep")):
            def run(argv):
                return '"unix:///fake/docker.sock"' if argv[1] == 'context' else protected + extra
            with patch.dict(os.environ, {}, clear=True):
                result = ram.reclaim(self.root, False, ram.NativeInventory(run), lambda pid: True)
            self.assertEqual(result[0]['action'], expected)
            self.assertTrue(self.path.exists())

    def test_legacy_only_blocks_metaviewer_capsules(self):
        for raw, expected in (("srf-id-cuentas-1\nsrf-egress-proxy\n", "removed"),
                              ("srf-id-mv-live\n", "keep"), ("srf-pg-mv-live\n", "keep"),
                              ("srf-vm-mv-x\n", "keep")):
            self.path.touch(mode=0o600)
            def run(argv):
                return '"unix:///fake/docker.sock"' if argv[1] == 'context' else raw
            with patch.dict(os.environ, {}, clear=True):
                result = ram.reclaim(self.root, True, ram.NativeInventory(run), lambda pid: True)
            self.assertEqual(result[0]['action'], expected)

    def test_vm_profile_reclaim_requires_matching_capsule_absence(self):
        import hashlib
        profile = "mv-vm1"
        self.path.unlink()
        self.path = self.root / ("12345-" + "a" * 32 + "-" +
            hashlib.sha256(profile.encode()).hexdigest() + "--" + profile)
        unrelated = "srf-id-cuentas-1\nsrf-egress-proxy\nsrf-vm-other\n"
        for extra, expected in (("srf-vm-mv-vm1\n", "keep"), ("", "removed")):
            with self.subTest(capsule_present=bool(extra)):
                self.path.touch(mode=0o600)
                def run(argv):
                    return ('"unix:///fake/docker.sock"' if argv[1] == "context"
                            else unrelated + extra)
                with patch.dict(os.environ, {}, clear=True):
                    result = ram.reclaim(self.root, True, ram.NativeInventory(run), lambda pid: True)
                self.assertEqual(result[0]["action"], expected)
                self.assertEqual(self.path.exists(), expected == "keep")

    def test_cli_requires_explicit_mode(self):
        with self.assertRaises(SystemExit) as result:
            ram.main(["reclaim"])
        self.assertEqual(result.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
