"""T7 round-2: exit code and signal semantics across gate.sh and CI receipt harnesses."""
import contextlib
import io
import pathlib
import signal
import subprocess
import sys
import tempfile
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


if __name__ == "__main__":
    unittest.main()
