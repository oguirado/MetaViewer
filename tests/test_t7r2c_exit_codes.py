"""T7 round-2: exit code and signal semantics across gate.sh and CI receipt harnesses."""
import contextlib
import ctypes
import io
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
GATE_SH = ROOT / "tools" / "gate.sh"


def load_gate_module(text=None):
    if text is None:
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


class TestT7R2CExitCodes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gate = load_gate_module()

    @staticmethod
    def _run_main_aggregate(gate_mod, results):
        leaves = tuple(f"leg-{idx}" for idx in range(len(results)))
        iterator = iter(results)
        called = []

        def fake_leaf(leg, root, environment):
            called.append(leg)
            return next(iterator)

        old_sigterm = signal.getsignal(signal.SIGTERM)
        old_sigint = signal.getsignal(signal.SIGINT)
        buf = io.StringIO()
        try:
            with (
                patch.object(gate_mod, "SELECTOR", "skeleton"),
                patch.object(gate_mod, "LEAVES", leaves),
                patch.object(gate_mod, "leaf", side_effect=fake_leaf),
                contextlib.redirect_stdout(buf),
            ):
                rc = gate_mod.main()
        finally:
            signal.signal(signal.SIGTERM, old_sigterm)
            signal.signal(signal.SIGINT, old_sigint)
        if tuple(called) != leaves:
            raise AssertionError(f"main() visited {called!r}, expected {leaves!r}")
        lines = buf.getvalue().strip().splitlines()
        expected_footer = "PASS aggregate" if rc == 0 else "FAIL aggregate"
        if not lines or lines[-1] != expected_footer:
            raise AssertionError(f"unexpected aggregate output: {lines!r}")
        return rc

    def test_o4_status_mapping_0_1_2_124(self):
        self.assertEqual(self.gate.status(0), "PASS")
        self.assertEqual(self.gate.status(2), "BLOCKED")
        self.assertEqual(self.gate.status(1), "FAIL")
        self.assertEqual(self.gate.status(124), "FAIL")

    def test_o4_interrupted_handler_raises_128_plus_signum(self):
        for sig in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(sig=sig):
                with self.assertRaises(SystemExit) as cm:
                    self.gate.interrupted(sig, None)
                self.assertEqual(cm.exception.code, 128 + int(sig))

    def test_o4_aggregate_precedence_124_over_2_over_1_over_0(self):
        vectors = (
            ([0, 0, 0], 0),
            ([0, 1, 0], 1),
            ([0, 1, 2], 2),
            ([0, 1, 2, 124], 124),
        )
        for results, expected in vectors:
            with self.subTest(results=results):
                self.assertEqual(self._run_main_aggregate(self.gate, results), expected)

        # Negative control: a mutant swapping the production precedence order
        # to (1, 2, 124) in gate.sh must fail the precedence check.
        raw_gate = GATE_SH.read_text(encoding="utf-8")
        if "(124, 2, 1)" in raw_gate:
            mutant_gate = load_gate_module(raw_gate.replace("(124, 2, 1)", "(1, 2, 124)", 1))
            with self.assertRaises(AssertionError):
                for results, expected in vectors:
                    self.assertEqual(self._run_main_aggregate(mutant_gate, results), expected)

    def test_o4_missing_target_returns_blocked_2(self):
        with tempfile.TemporaryDirectory(prefix="t7r2c-rc2-") as tmp:
            with self.gate.private_environment() as (_, env):
                rc = self.gate.leaf("contracts", pathlib.Path(tmp), env)
                self.assertEqual(rc, 2)

    def test_r1_106_exit0_setsid_sleeper_reaped_and_sibling_survives(self):
        with tempfile.TemporaryDirectory(prefix="t7r3-reap-") as tmp:
            tmp_path = pathlib.Path(tmp)
            handshake = tmp_path / "setsid.pid"
            child_code = (
                "import os, pathlib, sys, time\n"
                "r, w = os.pipe()\n"
                "mid = os.fork()\n"
                "if mid == 0:\n"
                "    os.close(r)\n"
                "    gc = os.fork()\n"
                "    if gc == 0:\n"
                "        os.setsid()\n"
                "        pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\n"
                "        os.close(w)\n"
                "        time.sleep(2)\n"
                "        os._exit(0)\n"
                "    os._exit(0)\n"
                "os.close(w)\n"
                "os.waitpid(mid, 0)\n"
                "os.read(r, 1)\n"
                "sys.exit(0)\n"
            )
            sentinel = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(2)"],
                start_new_session=True,
            )
            try:
                with self.gate.private_environment() as (_, env):
                    rc = self.gate.bounded(
                        [sys.executable, "-c", child_code, str(handshake)],
                        tmp_path,
                        env,
                        seconds=5,
                    )
                    self.assertEqual(rc, 0)
                    self.assertTrue(handshake.is_file())
                    sleeper_pid = int(handshake.read_text(encoding="utf-8").strip())
                    self.assertFalse(pathlib.Path("/proc", str(sleeper_pid)).exists())
                    self.assertIsNone(sentinel.poll())
            finally:
                sentinel.kill()
                sentinel.wait()

    def test_r1_106_overlapping_non_lifo_bounded_scopes(self):
        libc = ctypes.CDLL(None)
        with tempfile.TemporaryDirectory(prefix="t7r3-nonlifo-") as tmp:
            tmp_path = pathlib.Path(tmp)
            with self.gate.private_environment() as (_, env):
                a_entered = threading.Event()
                b_entered = threading.Event()
                release_a = tmp_path / "release-a"
                release_b = tmp_path / "release-b"
                gc_b_pid_file = tmp_path / "gc-b.pid"
                results = {}

                code_a = (
                    "import pathlib, sys, time\n"
                    "pathlib.Path(sys.argv[1]).write_text('ready')\n"
                    "deadline = time.monotonic() + 5\n"
                    "while not pathlib.Path(sys.argv[2]).exists() and time.monotonic() < deadline:\n"
                    "    time.sleep(0.01)\n"
                    "sys.exit(0)\n"
                )
                code_b = (
                    "import os, pathlib, sys, time\n"
                    "pathlib.Path(sys.argv[1]).write_text('ready')\n"
                    "deadline = time.monotonic() + 5\n"
                    "while not pathlib.Path(sys.argv[2]).exists() and time.monotonic() < deadline:\n"
                    "    time.sleep(0.01)\n"
                    "r, w = os.pipe()\n"
                    "mid = os.fork()\n"
                    "if mid == 0:\n"
                    "    os.close(r)\n"
                    "    gc = os.fork()\n"
                    "    if gc == 0:\n"
                    "        os.setsid()\n"
                    "        pathlib.Path(sys.argv[3]).write_text(str(os.getpid()))\n"
                    "        os.close(w)\n"
                    "        time.sleep(2)\n"
                    "        os._exit(0)\n"
                    "    os._exit(0)\n"
                    "os.close(w)\n"
                    "os.waitpid(mid, 0)\n"
                    "os.read(r, 1)\n"
                    "sys.exit(0)\n"
                )
                ready_a = tmp_path / "ready-a"
                ready_b = tmp_path / "ready-b"

                def run_a():
                    a_entered.set()
                    results["a"] = self.gate.bounded(
                        [sys.executable, "-c", code_a, str(ready_a), str(release_a)],
                        tmp_path,
                        env,
                        seconds=5,
                    )

                def run_b():
                    b_entered.set()
                    results["b"] = self.gate.bounded(
                        [sys.executable, "-c", code_b, str(ready_b), str(release_b), str(gc_b_pid_file)],
                        tmp_path,
                        env,
                        seconds=5,
                    )

                thread_a = threading.Thread(target=run_a)
                thread_b = threading.Thread(target=run_b)
                thread_a.start()
                self.assertTrue(a_entered.wait(timeout=5))
                while not ready_a.exists():
                    pass
                thread_b.start()
                self.assertTrue(b_entered.wait(timeout=5))
                while not ready_b.exists():
                    pass
                # Finish Scope A first while Scope B is still active (non-LIFO).
                release_a.write_text("go", encoding="utf-8")
                thread_a.join(timeout=5)
                self.assertEqual(results.get("a"), 0)
                subreaper = ctypes.c_int(-1)
                if libc.prctl(37, ctypes.byref(subreaper), 0, 0, 0) == 0:
                    self.assertEqual(subreaper.value, 1)
                # Now let Scope B spawn its setsid grandchild and exit 0.
                release_b.write_text("go", encoding="utf-8")
                thread_b.join(timeout=5)
                self.assertEqual(results.get("b"), 0)
                self.assertTrue(gc_b_pid_file.is_file())
                self.assertFalse(pathlib.Path("/proc", gc_b_pid_file.read_text().strip()).exists())
                if libc.prctl(37, ctypes.byref(subreaper), 0, 0, 0) == 0:
                    self.assertEqual(subreaper.value, 0)

    def test_r1_107_frozen_dependencies_scrubs_poisoned_env(self):
        with tempfile.TemporaryDirectory(prefix="t7r3-env-") as tmp:
            tmp_path = pathlib.Path(tmp)
            repo = tmp_path / "repo"
            repo.mkdir()
            for name in ("deps.lock", "Cargo.toml", "core/Cargo.toml", "Cargo.lock",
                         "ui/package.json", "ui/package-lock.json"):
                dst = repo / name
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, dst)
            bin_dir = tmp_path / "bin"
            bin_dir.mkdir()
            log_path = tmp_path / "env.jsonl"
            for tool in ("rustc", "cargo", "npm"):
                wrapper = bin_dir / tool
                wrapper.write_text(
                    f"#!{sys.executable}\n"
                    "import json, os, sys\n"
                    f"rec = {{'tool': {tool!r}, "
                    "'NODE_OPTIONS': os.environ.get('NODE_OPTIONS'), "
                    "'RUSTFLAGS': os.environ.get('RUSTFLAGS'), "
                    "'CARGO_ENCODED_RUSTFLAGS': os.environ.get('CARGO_ENCODED_RUSTFLAGS'), "
                    "'TMPDIR': os.environ.get('TMPDIR')}\n"
                    f"with open({str(log_path)!r}, 'a', encoding='utf-8') as f:\n"
                    "    f.write(json.dumps(rec) + '\\n')\n"
                    "if '-vV' in sys.argv:\n"
                    "    print('rustc 1.97.0\\nhost: aarch64-unknown-linux-gnu')\n",
                    encoding="utf-8",
                )
                wrapper.chmod(0o700)
            with patch.dict(
                os.environ,
                {
                    "NODE_OPTIONS": "--poisoned-node-opt",
                    "RUSTFLAGS": "-C poisoned-rustflag",
                    "CARGO_ENCODED_RUSTFLAGS": "-C poisoned-encoded",
                },
            ):
                with self.gate.private_environment() as (_, env):
                    env["PATH"] = str(bin_dir) + os.pathsep + env.get("PATH", "")
                    env["RUSTC"] = str(bin_dir / "rustc")
                    env["CARGO"] = str(bin_dir / "cargo")
                    env["NPM"] = str(bin_dir / "npm")
                    self.gate.validate_frozen_dependencies(repo, env)
                    records = [json.loads(line) for line in log_path.read_text().splitlines()]
                    self.assertEqual([r["tool"] for r in records], ["rustc", "cargo", "npm"])
                    for rec in records:
                        self.assertIsNone(rec["NODE_OPTIONS"])
                        self.assertIsNone(rec["RUSTFLAGS"])
                        self.assertIsNone(rec["CARGO_ENCODED_RUSTFLAGS"])
                        self.assertEqual(rec["TMPDIR"], env["TMPDIR"])

    def test_t7r3_001_agents_leaf_rejects_empty_skipped_xfail(self):
        with tempfile.TemporaryDirectory(prefix="t7r3-agents-") as tmp:
            repo = pathlib.Path(tmp)
            tests_dir = repo / "agents" / "tests"
            tests_dir.mkdir(parents=True)
            harness = tests_dir / "run_mutant_harness.py"
            harness.write_text("raise SystemExit(0)\n", encoding="utf-8")
            test_file = tests_dir / "test_sample.py"
            with self.gate.private_environment() as (_, env):
                for label, source in (
                    ("empty", ""),
                    (
                        "all-skipped",
                        "import unittest\nclass T(unittest.TestCase):\n"
                        " @unittest.skip('skip')\n def test_x(self): pass\n",
                    ),
                    (
                        "all-xfail",
                        "import unittest\nclass T(unittest.TestCase):\n"
                        " @unittest.expectedFailure\n def test_x(self): self.fail('xfail')\n",
                    ),
                    (
                        "unexpected-success",
                        "import unittest\nclass T(unittest.TestCase):\n"
                        " @unittest.expectedFailure\n def test_x(self): pass\n",
                    ),
                ):
                    with self.subTest(case=label):
                        test_file.write_text(source, encoding="utf-8")
                        self.assertEqual(self.gate.leaf("agents", repo, env), 1)
                # Negative control: real passing test + passing mutant harness returns 0.
                test_file.write_text(
                    "import unittest\nclass T(unittest.TestCase):\n"
                    " def test_ok(self): self.assertEqual(1 + 1, 2)\n",
                    encoding="utf-8",
                )
                self.assertEqual(self.gate.leaf("agents", repo, env), 0)

    def test_t7r3_002_leaf_timeout_124_preserved_and_dominates_2_and_1(self):
        with tempfile.TemporaryDirectory(prefix="t7r3-rc124-") as tmp:
            fixture = self.gate.GateTests()
            fixture.setUp()
            try:
                env = fixture.prepare_build_fixture()
                bin_dir = pathlib.Path(tmp) / "bin"
                bin_dir.mkdir()
                stub = bin_dir / "stub"
                stub.write_text(
                    f"#!{sys.executable}\n"
                    "import os, sys\n"
                    "if '-p' in sys.argv:\n"
                    "    print('24')\n"
                    "    sys.exit(0)\n"
                    "if '--version' in sys.argv:\n"
                    "    sys.exit(0)\n"
                    "sys.exit(int(os.environ.get('MV_STUB_RC', '124')))\n",
                    encoding="utf-8",
                )
                stub.chmod(0o700)
                for key in ("RUSTUP", "CARGO", "GO", "NODE", "NPM", "VUE_TSC", "VITE"):
                    env[key] = str(stub)
                with self.gate.private_environment() as (_, scrubbed):
                    scrubbed.update(env)
                    scrubbed["MV_STUB_RC"] = "124"
                    self.assertEqual(self.gate.build_leg("rust", fixture.fixture, scrubbed), 124)
                    self.assertEqual(self.gate.build_leg("ui", fixture.fixture, scrubbed), 124)
                    self.assertEqual(self.gate.go_leg(fixture.fixture, scrubbed), 124)
                    # Negative controls: normal failure returns 1, missing tool returns 2.
                    scrubbed["MV_STUB_RC"] = "1"
                    self.assertEqual(self.gate.build_leg("rust", fixture.fixture, scrubbed), 1)
                    self.assertEqual(self.gate.build_leg("ui", fixture.fixture, scrubbed), 1)
                    self.assertEqual(self.gate.go_leg(fixture.fixture, scrubbed), 1)
                    missing = dict(scrubbed, RUSTUP=str(bin_dir / "missing"))
                    self.assertEqual(self.gate.build_leg("rust", fixture.fixture, missing), 2)
                # ui-smoke timeout returns 124 and reaps child; normal failure returns 1.
                smoke_env = dict(os.environ)
                fixture.prepare_smoke_fixture(smoke_env)
                smoke_env["NODE"] = sys.executable
                fixture.write("ui/test/smoke.mjs", "import time; time.sleep(2)\n")
                self.assertEqual(self.gate.ui_smoke_leg(fixture.fixture, smoke_env, timeout=0.2), 124)
                fixture.write("ui/test/smoke.mjs", "import sys; sys.exit(1)\n")
                self.assertEqual(self.gate.ui_smoke_leg(fixture.fixture, smoke_env, timeout=5), 1)
            finally:
                fixture.doCleanups()
        self.assertEqual(self._run_main_aggregate(self.gate, [2, 124]), 124)
        self.assertEqual(self._run_main_aggregate(self.gate, [1, 2, 124, 0]), 124)


if __name__ == "__main__":
    unittest.main()
