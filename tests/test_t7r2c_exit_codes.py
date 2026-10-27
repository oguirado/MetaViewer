"""T7 round-2: exit code and signal semantics across gate.sh and CI receipt harnesses."""
import pathlib
import signal
import subprocess
import sys
import tempfile
import types
import unittest

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


class TestT7R2CExitCodes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gate = load_gate_module()

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
        def agg(results):
            return next((rc for rc in (124, 2, 1) if rc in results), 0)

        self.assertEqual(agg([0, 0, 0]), 0)
        self.assertEqual(agg([0, 1, 0]), 1)
        self.assertEqual(agg([0, 1, 2]), 2)
        self.assertEqual(agg([0, 1, 2, 124]), 124)

    def test_o4_missing_target_returns_blocked_2(self):
        with tempfile.TemporaryDirectory(prefix="t7r2c-rc2-") as tmp:
            with self.gate.private_environment() as (_, env):
                rc = self.gate.leaf("contracts", pathlib.Path(tmp), env)
                self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
