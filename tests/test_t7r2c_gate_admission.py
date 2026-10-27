"""T7 round-2: tools/gate.sh dependency admission, target isolation, R1-106 descendant rescanning, and R1-107 env scrubbing."""
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
GATE_SH = ROOT / "tools" / "gate.sh"


def load_gate_module():
    text = GATE_SH.read_text(encoding="utf-8")
    py_body = text.split("exec python3 - \"$root\" \"$selector\" <<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
    py_body = py_body.replace("sys.exit(main())", "pass")
    mod = types.ModuleType("gate_mod")
    old_argv = sys.argv[:]
    try:
        sys.argv = ["gate.py", str(ROOT), "unit"]
        exec(compile(py_body, str(GATE_SH), "exec"), mod.__dict__)
    finally:
        sys.argv = old_argv
    return mod


class TestT7R2CGateAdmission(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gate = load_gate_module()

    def test_o1_rust_dependency_admission_rejects_unpinned_or_unlisted(self):
        with self.assertRaises(self.gate.InvalidMetadata):
            self.gate.validate_rust_dependencies({"serde": "1.0.229"}, "dependencies")
        with self.assertRaises(self.gate.InvalidMetadata):
            self.gate.validate_rust_dependencies({"serde": "^1.0.229"}, "dependencies")
        with self.assertRaises(self.gate.InvalidMetadata):
            self.gate.validate_rust_dependencies({"unlisted_crate": "=1.0.0"}, "dependencies")
        with self.assertRaises(self.gate.InvalidMetadata):
            self.gate.validate_rust_dependencies({"proptest": "=1.12.0"}, "dependencies")
        self.gate.validate_rust_dependencies({"serde": "=1.0.229"}, "dependencies")
        self.gate.validate_rust_dependencies({"proptest": "=1.12.0"}, "dev-dependencies")

    def test_o2_npm_dependency_admission_rejects_drift_and_incomplete_closure(self):
        pins = dict(self.gate.DEPENDENCIES)
        self.gate.validate_npm_dependencies(dict(pins), pins)
        drifted = dict(pins, vue="^3.5.43")
        with self.assertRaises(self.gate.InvalidMetadata):
            self.gate.validate_npm_dependencies(drifted, pins)
        incomplete = dict(pins)
        incomplete.pop("vue")
        with self.assertRaises(self.gate.InvalidMetadata):
            self.gate.validate_npm_dependencies(incomplete, pins)

    def test_o3_cli_selector_rejects_invalid_and_missing_runner(self):
        for bad_args in (["--leg", "nonexistent"], ["--unknown"], ["--self-test", "--leg", "unit"]):
            res = subprocess.run(
                ["bash", str(GATE_SH), *bad_args],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(res.returncode, 2)
            self.assertIn("Usage:", res.stderr)

    def test_o4_bounded_timeout_kills_process_tree_and_returns_124(self):
        with self.gate.private_environment() as (scratch, env):
            parent_p = scratch / "parent.pid"
            child_p = scratch / "child.pid"
            code = (
                "import os, pathlib, signal, subprocess, sys, time\n"
                f"c = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
                f"pathlib.Path({str(parent_p)!r}).write_text(str(os.getpid()))\n"
                f"pathlib.Path({str(child_p)!r}).write_text(str(c.pid))\n"
                "signal.signal(signal.SIGTERM, lambda *_: (c.wait(), sys.exit(0)))\n"
                "time.sleep(30)\n"
            )
            rc = self.gate.bounded([sys.executable, "-c", code], ROOT, env, seconds=0.2)
            self.assertEqual(rc, 124)
            for pfile in (parent_p, child_p):
                if pfile.exists():
                    pid = int(pfile.read_text().strip())
                    self.assertFalse(pathlib.Path(f"/proc/{pid}").exists(), f"PID {pid} survived")

    def test_o5_target_isolation(self):
        """Execute build_leg('rust', ...) with stubbed rustup/cargo and verify CARGO_TARGET_DIR isolation."""
        with self.gate.private_environment() as (scratch, env):
            bin_dir = scratch / "bin"
            bin_dir.mkdir()
            calls_log = scratch / "cargo_calls.jsonl"
            for tool in ("rustup", "cargo"):
                shim = bin_dir / tool
                shim.write_text(
                    f"#!{sys.executable}\n"
                    "import json, os, sys\n"
                    f"with open({str(calls_log)!r}, 'a', encoding='utf-8') as f:\n"
                    "    f.write(json.dumps({'tool': os.path.basename(sys.argv[0]), 'argv': sys.argv[1:], "
                    "'CARGO_TARGET_DIR': os.environ.get('CARGO_TARGET_DIR')}) + '\\n')\n"
                    "sys.exit(0)\n",
                    encoding="utf-8",
                )
                shim.chmod(0o755)
            # Case 1: CARGO_TARGET_DIR unset -> defaults to TMPDIR/cargo-target inside private_environment.
            env_unset = dict(env, RUSTUP=str(bin_dir / "rustup"), CARGO=str(bin_dir / "cargo"))
            env_unset.pop("CARGO_TARGET_DIR", None)
            rc = self.gate.build_leg("rust", ROOT, env_unset)
            self.assertEqual(rc, 0)
            records = [json.loads(line) for line in calls_log.read_text(encoding="utf-8").splitlines()]
            self.assertGreaterEqual(len(records), 3)
            expected_default = str(pathlib.Path(env_unset["TMPDIR"]) / "cargo-target")
            for rec in records[-3:]:
                self.assertEqual(rec["CARGO_TARGET_DIR"], expected_default)

            # Case 2: Negative control — explicit CARGO_TARGET_DIR is preserved for isolated worktree target dirs.
            calls_log.write_text("", encoding="utf-8")
            custom_target = str(scratch / "explicit-target")
            env_explicit = dict(env_unset, CARGO_TARGET_DIR=custom_target)
            rc2 = self.gate.build_leg("rust", ROOT, env_explicit)
            self.assertEqual(rc2, 0)
            records2 = [json.loads(line) for line in calls_log.read_text(encoding="utf-8").splitlines()]
            for rec in records2[-3:]:
                self.assertEqual(rec["CARGO_TARGET_DIR"], custom_target)

    def test_o6_unit_runner_rejects_skipped_and_empty_suites(self):
        with tempfile.TemporaryDirectory(prefix="t7r2c-unit-") as tmp:
            tdir = pathlib.Path(tmp) / "tests"
            tdir.mkdir()
            res_empty = subprocess.run(
                [sys.executable, "-c", self.gate.UNIT_CODE],
                cwd=tmp,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(res_empty.returncode, 2)

            (tdir / "test_skip.py").write_text(
                "import unittest\nclass S(unittest.TestCase):\n @unittest.skip('no')\n def test_a(self): pass\n",
                encoding="utf-8",
            )
            res_skip = subprocess.run(
                [sys.executable, "-c", self.gate.UNIT_CODE],
                cwd=tmp,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(res_skip.returncode, 1)

    def test_r1_106_stop_process_tree_rescans_descendants_each_round(self):
        """Regression test for R1-106: stop_process_tree rescans descendants on each signal round and skips recycled PIDs."""
        killed = []
        scan_calls = []
        id_calls_300 = 0

        def fake_descendants(pid):
            scan_calls.append(pid)
            if len(scan_calls) == 1:
                return [100]
            return [100, 200, 300]

        def fake_identity(pid):
            nonlocal id_calls_300
            if pid == 300:
                id_calls_300 += 1
                return "starttime_300" if id_calls_300 == 1 else "recycled_starttime_300"
            return f"starttime_{pid}"

        def fake_kill(pid, sig):
            killed.append((pid, sig))

        proc = MagicMock()
        proc.pid = 100
        with patch.object(self.gate, "descendants", side_effect=fake_descendants), \
             patch.object(self.gate, "process_identity", side_effect=fake_identity), \
             patch.object(self.gate.os, "getpgid", return_value=99999), \
             patch.object(self.gate.os, "getpgrp", return_value=11111), \
             patch.object(self.gate.os, "kill", side_effect=fake_kill), \
             patch.object(self.gate.time, "sleep"):
            self.gate.stop_process_tree(proc)

        self.assertGreaterEqual(len(scan_calls), 2)
        self.assertIn((100, signal.SIGTERM), killed)
        self.assertIn((200, signal.SIGKILL), killed)
        # Negative control: recycled PID 300 (whose identity changed after discovery) must not be killed.
        self.assertNotIn((300, signal.SIGKILL), killed)

    def test_r1_107_private_environment_scrubs_loader_and_debug_env(self):
        """Regression test for R1-107: private_environment scrubs loader/debug variables while keeping benign env."""
        with patch.dict(
            os.environ,
            {
                "LD_PRELOAD": "/tmp/evil.so",
                "LD_LIBRARY_PATH": "/tmp/evil-lib",
                "NODE_OPTIONS": "--require /tmp/evil.js",
                "PYTHONPATH": "/tmp/evil-py",
                "BASH_ENV": "/tmp/evil.sh",
                "MV_BENIGN_TEST_VAR": "kept_value",
            },
        ):
            with self.gate.private_environment() as (_, env):
                for key in ("LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS", "PYTHONPATH", "BASH_ENV"):
                    self.assertNotIn(key, env)
                self.assertEqual(env.get("MV_BENIGN_TEST_VAR"), "kept_value")


if __name__ == "__main__":
    unittest.main()
