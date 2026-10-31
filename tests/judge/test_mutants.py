"""One mutant per JUDGE_* code: negating the deciding predicate must break its scenario pair.

For every code the original scripts must (a) fire the code in the bad scenario and
(b) stay silent for it in the good scenario. The mutant negates the predicate on the
line the script marks `# MUT:<code>`; at least one of (a) or (b) must then fail, which
proves the scenario pair is able to tell a working check from a broken one.
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from judge_sandbox import JUDGE_SRC, Result, Sandbox, mutate_text  # noqa: E402
import judge_scenarios as sc  # noqa: E402

TABLE_CODES = {
    "JUDGE_OS", "JUDGE_ARCH", "JUDGE_BUNDLE_ARCH", "JUDGE_SYSDEP", "JUDGE_NODE", "JUDGE_USERNS",
    "JUDGE_DISPLAY", "JUDGE_XDG_RUNTIME", "JUDGE_RAM", "JUDGE_SHM", "JUDGE_CPUSET", "JUDGE_DOCKER",
    "JUDGE_DOCKER_HOST", "JUDGE_DOCKER_DESKTOP", "JUDGE_IMAGE", "JUDGE_NET", "JUDGE_PROFILE",
    "JUDGE_RAM_STALE", "JUDGE_DISK",
}
FLOW_ONLY = {"JUDGE_ASSET", "JUDGE_SUDO", "JUDGE_SMOKE", "JUDGE_NOT_INSTALLED", "JUDGE_RUNNING",
             "JUDGE_STOP_TIMEOUT", "JUDGE_STOP_LEAK", "JUDGE_USAGE"}


def run_pair(code, runner, mutant):
    """Returns (fires_when_bad, silent_when_good, mutation_hits)."""
    results, hits = [], 0
    for good in (False, True):
        with tempfile.TemporaryDirectory() as tmp:
            sb = Sandbox(tmp, mutant=mutant)
            try:
                try:
                    results.append(runner(sb, good))
                except AssertionError as error:  # a mutant may break the scenario's own preparation
                    results.append(Result(-1, "", "SCENARIO_ERROR " + str(error)))
            finally:
                sb.cleanup()
            hits = max(hits, getattr(sb, "mutant_hits", 0))
    bad, good = results
    return code in bad.codes, code not in good.codes, hits


def preflight_runner(code):
    args, bad, good = sc.PREFLIGHT[code]

    def runner(sb, is_good):
        env = sc.env_of((good if is_good else bad)(sb))
        use_args = sc.PREFLIGHT_GOOD_ARGS.get(code, args) if is_good else args
        return sb.preflight(*use_args, env=env)
    return runner


class TestScenarioCoverage(unittest.TestCase):
    def test_every_spec_table_code_has_a_scenario_and_exists_in_the_script(self):
        self.assertEqual(TABLE_CODES - set(sc.PREFLIGHT), set())
        source = (JUDGE_SRC / "preflight.sh").read_text() + (JUDGE_SRC / "metaviewer-judge.sh").read_text()
        for code in TABLE_CODES | FLOW_ONLY:
            with self.subTest(code=code):
                self.assertIn(code, source)
                self.assertIn("# MUT:" + code, source, "the deciding predicate must carry its mutation marker")

    def test_flow_scenarios_cover_the_flow_only_codes(self):
        self.assertEqual(FLOW_ONLY, set(sc.FLOW))

    def test_mutation_helper_negates_only_marked_lines(self):
        text = 'if [ a ]; then # MUT:JUDGE_X\nif [ b ]; then\nelif c; then # MUT:JUDGE_X\nx # MUT:JUDGE_XY\n'
        out, hits = mutate_text(text, "JUDGE_X")
        self.assertEqual(hits, 2)
        self.assertEqual(out, 'if ! [ a ]; then # MUT:JUDGE_X\nif [ b ]; then\nelif ! c; then # MUT:JUDGE_X\nx # MUT:JUDGE_XY\n')


class TestPreflightMutants(unittest.TestCase):
    def test_original_scripts_pass_every_scenario_pair(self):
        for code in sorted(sc.PREFLIGHT):
            with self.subTest(code=code):
                fires, silent, _ = run_pair(code, preflight_runner(code), None)
                self.assertTrue(fires, f"{code} must fire in its bad scenario")
                self.assertTrue(silent, f"{code} must stay silent in its good scenario")

    def test_each_mutant_is_killed(self):
        for code in sorted(sc.PREFLIGHT):
            with self.subTest(code=code):
                fires, silent, hits = run_pair(code, preflight_runner(code), code)
                self.assertGreaterEqual(hits, 1, f"no line carries # MUT:{code}")
                self.assertFalse(fires and silent, f"mutant of {code} survived")


class TestFlowMutants(unittest.TestCase):
    def test_original_scripts_pass_every_flow_scenario_pair(self):
        for code in sorted(sc.FLOW):
            with self.subTest(code=code):
                fires, silent, _ = run_pair(code, sc.FLOW[code], None)
                self.assertTrue(fires, f"{code} must fire in its bad scenario")
                self.assertTrue(silent, f"{code} must stay silent in its good scenario")

    def test_each_mutant_is_killed(self):
        for code in sorted(sc.FLOW):
            with self.subTest(code=code):
                fires, silent, hits = run_pair(code, sc.FLOW[code], code)
                self.assertGreaterEqual(hits, 1, f"no line carries # MUT:{code}")
                self.assertFalse(fires and silent, f"mutant of {code} survived")


class TestConsentMutant(unittest.TestCase):
    """The consent gate itself: with it negated, a declined step would run sudo."""

    def _declined_sudo_calls(self, mutant):
        with tempfile.TemporaryDirectory() as tmp:
            sb = Sandbox(tmp, mutant=mutant)
            try:
                sc.need_profile_bad(sb)
                res = sb.judge("install", stdin="n\n")
                return res, sb.log("sudo.log")
            finally:
                sb.cleanup()

    def test_declined_step_never_reaches_sudo_in_the_original(self):
        res, log = self._declined_sudo_calls(None)
        self.assertEqual(log, "")
        self.assertEqual(res.rc, 2)

    def test_negated_gate_is_detected_because_sudo_runs_after_a_no(self):
        _, log = self._declined_sudo_calls("JUDGE_SUDO")
        self.assertNotEqual(log, "", "the mutant must reach sudo, which the original test forbids")


if __name__ == "__main__":
    unittest.main()
