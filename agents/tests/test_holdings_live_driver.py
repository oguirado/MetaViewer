"""AC05-H4 hosted controls: no capsule, Docker, live socket or subprocess planner."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agents"))
from metaviewer_agents import loop_trials  # noqa: E402

DRIVER = ROOT / "tests/e2e/e2e1_slice/holdings_live_trials.py"
spec = importlib.util.spec_from_file_location("holdings_live_trials", DRIVER)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


HOSTED_DOUBLE = loop_trials.make_holdings_double


class StubSession:
    outcome = "verified"
    instances = []

    def __init__(self, root):
        factory, _, _ = HOSTED_DOUBLE(trials=1, verified_count=1)
        self.inner = factory(1, "holdings")
        self.surface_id = self.inner.surface_id
        self.closed = False
        self.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True

    def request(self, call, expect, *, timeout_ms):
        reply = self.inner.request(call, expect, timeout_ms=timeout_ms)
        if call["op"] == "wait_verify" and self.outcome == "pixel":
            reply["receipt"]["verification"]["method"] = "pixel"
        if call["op"] == "observe" and self.outcome == "browser":
            reply["observation"].pop("ground_truth", None)
        return reply


class HoldingsLiveDriverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.receipt = Path(self.temp.name) / "receipt.json"
        self.args = ["--trials", "1", "--min-verified", "1", "--timeout-ms", "1000",
                     "--receipt-out", str(self.receipt)]
        self.out, self.err = io.StringIO(), io.StringIO()
        self.stack = SimpleNamespace(
            state_root=Mock(return_value=Path(self.temp.name)),
            load_state=Mock(return_value={"status": "ready", "supervisor": {"pid": 42}}),
            alive=Mock(return_value=True),
        )
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {"MV_LIVE_HOLDINGS": "1"}, clear=True).start()
        self.runtime = patch.object(driver, "_runtime", return_value=(self.stack, StubSession)).start()
        StubSession.instances = []
        StubSession.outcome = "verified"

    def run_driver(self):
        return driver.main(self.args, stdout=self.out, stderr=self.err)

    def test_refuses_without_explicit_opt_in_before_runtime_or_output(self):
        for value in (None, "", "0", "true"):
            with self.subTest(value=value):
                if value is None:
                    os.environ.pop("MV_LIVE_HOLDINGS", None)
                else:
                    os.environ["MV_LIVE_HOLDINGS"] = value
                self.assertEqual(self.run_driver(), 2)
                self.assertIn("BLOCKED HOLDINGS_OPT_IN", self.err.getvalue())
                self.assertFalse(self.receipt.exists())
        self.runtime.assert_not_called()

    def test_no_arguments_without_opt_in_is_also_a_typed_block(self):
        os.environ.pop("MV_LIVE_HOLDINGS")
        self.assertEqual(driver.main([], stderr=self.err), 2)
        self.assertIn("BLOCKED HOLDINGS_OPT_IN", self.err.getvalue())
        self.runtime.assert_not_called()

    def test_not_ready_dead_or_already_handed_off_never_attaches(self):
        for state, alive in (({"status": "starting"}, True),
                             ({"status": "ready"}, False),
                             ({"status": "ready", "agent_handoff": {}}, True)):
            with self.subTest(state=state, alive=alive):
                self.stack.load_state.return_value = state
                self.stack.alive.return_value = alive
                self.assertEqual(self.run_driver(), 2)
                self.assertIn("BLOCKED HOLDINGS_STACK_NOT_READY", self.err.getvalue())
        self.assertFalse(StubSession.instances)
        self.assertFalse(self.receipt.exists())

    def test_missing_stack_state_is_typed_block(self):
        self.stack.load_state.side_effect = FileNotFoundError("state absent")
        self.assertEqual(self.run_driver(), 2)
        self.assertIn("BLOCKED HOLDINGS_STACK_NOT_READY", self.err.getvalue())

    def test_MUT_SCRIPTED_DEFAULT_refuses_both_double_families(self):
        for make_double in (loop_trials.make_holdings_double, loop_trials.make_scripted_double):
            factory, _, _ = make_double(trials=1, verified_count=1)
            fake = factory(1, "holdings")
            self.runtime.return_value = (self.stack, lambda root: fake)
            self.assertEqual(self.run_driver(), 2)
            self.assertIn("BLOCKED HOLDINGS_LIVE_CLIENT", self.err.getvalue())
            self.assertEqual(fake.ops, [])
            self.assertFalse(self.receipt.exists())

    def test_receipt_round_trips_through_cli_no_scripted_fallback(self):
        with contextlib.ExitStack() as guards:
            for name in ("make_holdings_double", "make_scripted_double"):
                guards.enter_context(patch.object(loop_trials, name, side_effect=AssertionError("scripted fallback")))
            self.assertEqual(self.run_driver(), 0, self.err.getvalue())
        session = StubSession.instances[0]
        self.assertTrue(session.closed)
        self.assertIn("propose", session.inner.ops)
        self.assertIn("wait_verify", session.inner.ops)
        report = json.loads(self.receipt.read_text())
        self.assertEqual(report["schema"], "metaviewer.ai-loop-report/v1")
        self.assertTrue(report["results"][0]["witness_present"])
        self.assertEqual(json.loads(self.out.getvalue()), report)
        result = subprocess.run(
            [sys.executable, "-m", "metaviewer_agents.loop_trials", "--verify-receipt",
             str(self.receipt), "--kind", "holdings", "--trials", "1", "--min-verified", "1"],
            cwd=ROOT / "agents", text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        # MUT-RECEIPT-SHAPE: wrappers/extra keys cannot pass re-verification.
        report["live"] = True
        self.receipt.write_text(json.dumps(report))
        self.assertEqual(loop_trials.main(
            ["--verify-receipt", str(self.receipt), "--kind", "holdings",
             "--trials", "1", "--min-verified", "1"], stdout=io.StringIO(), stderr=io.StringIO()), 2)

    def test_browser_ready_surface_refused_before_any_action(self):
        StubSession.outcome = "browser"
        self.assertEqual(self.run_driver(), 2)
        self.assertIn("BLOCKED HOLDINGS_STATE_PREFLIGHT", self.err.getvalue())
        self.assertEqual(StubSession.instances[0].inner.ops, ["observe"])
        self.assertTrue(StubSession.instances[0].closed)

    def test_pixel_witness_never_counts_as_state_verification(self):
        StubSession.outcome = "pixel"
        self.assertEqual(self.run_driver(), 1, self.err.getvalue())
        report = json.loads(self.receipt.read_text())
        self.assertFalse(report["pass"])
        self.assertFalse(report["results"][0]["witness_present"])

    def test_invalid_bounds_and_planner_override_refused_before_attachment(self):
        for change in ("bounds", "planner"):
            with self.subTest(change=change):
                if change == "bounds":
                    self.args[1] = "0"
                else:
                    self.args[1] = "1"
                    os.environ["MV_WENDER_ROOT"] = "/configured"
                self.assertEqual(self.run_driver(), 2)
        self.runtime.assert_not_called()


if __name__ == "__main__":
    unittest.main()
