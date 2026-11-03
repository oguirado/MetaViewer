"""Independent read-back bounds, deadline and focus-oracle negative controls."""
import importlib.util
import json
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('readback_receipt', ROOT / 'tests/test_mw_e1_receipt.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
HOST = fixture.host
from metaviewer_agents import mw_owner as owner


class ReadbackDeadlineTests(unittest.TestCase):
    def runner(self, clock, duration):
        mw = ModuleType('readback_fake')
        exec('''
def _observe(predicate, state, owners, deadline):
    assert clock[0] < deadline, 'old paste deadline used'
    clock[0] += duration
    return 'exact native text'
def run_workflow(predicate, state, owners, deadline):
    return _observe(predicate, state, owners, deadline)
''', mw.__dict__)
        mw.clock, mw.duration = clock, duration
        instance = SimpleNamespace(slot_readback_deadline_ns=200)
        bounded = HOST.readback_runner(mw, instance)
        def run(*args):
            with patch.object(owner.time, 'monotonic_ns', side_effect=lambda: clock[0]):
                return bounded(*args)
        return mw, instance, run

    def test_expired_paste_does_not_consume_readback_window(self):
        mw, instance, run = self.runner([100], 50)
        self.assertEqual(run({'capability_id': 'mv.ax.length.v1'}, None,
                             SimpleNamespace(observations=instance), 99), 'exact native text')
        self.assertIsNone(instance.slot_readback_deadline_ns)
        # A global deadline override mutant would also let this unrelated read pass.
        with self.assertRaisesRegex(AssertionError, 'old paste'):
            mw.run_workflow({}, None, None, 99)

    def test_expiry_refuses_typed_and_no_bound_mutant_is_killed(self):
        for duration in (100, 101):
            _, instance, run = self.runner([100], duration)
            with self.subTest(duration=duration), self.assertRaisesRegex(
                    owner.OwnerRefused, '^MW_SLOT_READBACK_DEADLINE$'):
                run({'capability_id': 'mv.ax.length.v1'}, None,
                    SimpleNamespace(observations=instance), 99)
            self.assertIsNone(instance.slot_readback_deadline_ns)

    def test_window_already_expired_never_acquires(self):
        _, instance, run = self.runner([100], 0)
        instance.slot_readback_deadline_ns = 100
        with patch.object(owner.time, 'monotonic_ns', return_value=100):
            with self.assertRaisesRegex(owner.OwnerRefused, 'MW_SLOT_READBACK_DEADLINE'):
                run({'capability_id': 'mv.ax.length.v1'}, None,
                    SimpleNamespace(observations=instance), 99)

    def test_window_scaling_and_paste_budget_unchanged(self):
        self.assertEqual(owner.SLOT_READBACK_WINDOW_MS, 10_000)
        self.assertEqual(owner.slot_readback_window_ns(), 10_000_000_000)
        self.assertEqual(owner.slot_readback_window_ns(ci=True), 20_000_000_000)
        workflow = json.loads((ROOT / 'tests/e2e/fixtures/mw_perplexity/site/workflows/ask.json').read_text())
        self.assertEqual(workflow['text_slots'][0]['budget_ms'], 30_000)
        self.assertEqual(workflow['steps'][1]['action']['delivery_budget_ms'], 30_000)

    def test_real_workflow_expiry_surfaces_typed_error_and_never_enters(self):
        spec = importlib.util.spec_from_file_location(
            'readback_owner_fixture', ROOT / 'agents/tests/test_mw_owner.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        fixture = module.OwnerTests('test_private_text_run_and_no_content_in_evidence')
        fixture.setUp()
        try:
            fixture.prepare_text('éΩ🙂')
            fixture.owner.readback_runner = HOST.readback_runner
            original_observe = fixture.owner.mw._observe
            with patch.object(owner, 'slot_readback_window_ns', return_value=0):
                with self.assertRaisesRegex(owner.OwnerRefused, '^MW_SLOT_READBACK_DEADLINE$'):
                    fixture.owner.run()
            self.assertEqual([p['type'] for p in fixture.proposals], ['click', 'type'])
            self.assertTrue(fixture.owner.receipts[-1]['receipt']['verified'])
            self.assertIs(fixture.owner.mw._observe, original_observe)
        finally:
            fixture.doCleanups()

    def test_oracle_rejects_skip_without_explicit_false(self):
        import tempfile
        spec = importlib.util.spec_from_file_location('readback_probe', ROOT / 'tests/e2e/rehearse_e1_packaged.py')
        probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(probe)
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            answer, report, receipt = (work / n for n in ('answer.txt', 'report.json', 'receipt.json'))
            answer.write_text(probe.ANSWER)
            receipt.write_text(json.dumps(dict(rc=0, verdict_code='VERIFIED', steps_total=3,
                                               steps_verified=2, steps_failed=0, steps_skipped_satisfied=1)))
            result = SimpleNamespace(returncode=0, stderr='in 10 s; interrupt now to cancel',
                stdout=json.dumps(dict(schema='metaviewer.mw_run/v1', rc=0,
                    verdict_code='VERIFIED', report=str(report), receipt=str(receipt))))
            for evidence in ({'seq': 1, 'core_action_verified': False}, {'seq': 1},
                             {'seq': 1, 'core_action_verified': True},
                             {'seq': 1, 'core_action_verified': 0}):
                report.write_text(json.dumps(dict(attach='discovered', focus_steps=[evidence],
                    answer=dict(captured=True, path=str(answer)))))
                if evidence.get('core_action_verified') is False:
                    probe.validate_run(result, (0, 'VERIFIED'))
                else:
                    with self.assertRaisesRegex(RuntimeError, 'core_action_verified:false'):
                        probe.validate_run(result, (0, 'VERIFIED'))

    def test_readback_ci_must_be_boolean(self):
        for invalid in ('yes', 1, 0, None):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(owner.OwnerRefused, '^MW_SLOT_READBACK_CONFIG$'):
                    owner.ReplayOwner(None, None, None, readback_ci=invalid)
        for valid in (True, False):
            with self.subTest(valid=valid):
                # The guard admits booleans; construction then fails on the absent corpus.
                with self.assertRaises(AttributeError):
                    owner.ReplayOwner(None, None, None, readback_ci=valid)


if __name__ == '__main__':
    unittest.main()
