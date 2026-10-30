"""Entry syntax and the real owner summary boundary, with hosted fakes only."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents import mw_run


def host_module():
    path = Path(__file__).resolve().parents[2] / 'tools/mw_run_backend.py'
    spec = importlib.util.spec_from_file_location('test_entry_backend', path)
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    return host


class EntryTests(unittest.TestCase):
    def test_exact_flags_and_private_slots(self):
        runner = Mock(return_value=0)
        self.assertEqual(mw_run.main(['--identity', 'alice', '--site', 'example', '--workflow', 'read',
                                     '--slot', 'query=Música'], runner=runner), 0)
        self.assertEqual(runner.call_args.args[0].slot, ['query=Música'])
        for flag in ('--extra', '--help', '--ident', '--no-such-flag'):
            runner.reset_mock()
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                mw_run.main(['--identity', 'alice', '--site', 'example', '--workflow', 'read', flag], runner=runner)
            runner.assert_not_called()

    def test_home_profile_before_core(self):
        import tempfile
        host = host_module()
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            home.chmod(0o700)
            (home / 'Cookies').write_text('profile')
            # Exercise entry ordering: moving connect ahead of home admission
            # must make this test fail, even if check_home still refuses Cookies.
            def admitted(*argv, **kwargs):
                return SimpleNamespace(returncode=0 if 'check-ignore' in argv[0] else 1)
            args = mw_run.build_parser().parse_args(['--identity', 'alice', '--site', 'example', '--workflow', 'read'])
            output = io.StringIO()
            with patch.object(host, 'command', side_effect=admitted), \
                 patch.dict(os.environ, {'MV_MW_HOME': str(home)}), \
                 patch.object(host, 'connect') as core, contextlib.redirect_stdout(output):
                self.assertNotEqual(host.run_entry(args), 0)
                self.assertEqual(json.loads(output.getvalue())['verdict_code'], 'MW_HOME_PROFILE')
                core.assert_not_called()


class SummaryTests(unittest.TestCase):
    def setUp(self):
        # Reuse canonical fixtures, preserving their locked dependency and cleanup.
        path = Path(__file__).with_name('test_mw_owner.py')
        spec = importlib.util.spec_from_file_location('entry_owner_fixture', path)
        owner_tests = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(owner_tests)
        self.fixture = owner_tests.OwnerTests('test_real_gate_accepts_canonical_fixture_before_backend')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.install_backend()
        self.host = host_module()
        original = self.fixture.owner.backend.call
        self.fixture.owner.backend.call = lambda stage, **args: {'mode': 'open'} if stage == 'network_context' else original(stage, **args)
        self.args = SimpleNamespace(identity='alice', site='fixture', workflow='form', slot=[])

    def execute(self, owner_factory=None):
        fixture = self.fixture
        return self.host.execute(self.args, fixture.root, fixture.evidence, fixture.owner.backend,
                                 corpus_factory=lambda *args: fixture.corpus,
                                 owner_factory=owner_factory or self.host.ReplayOwner)

    def test_real_summary_exists_and_verifies(self):
        rc, code, path = self.execute()
        self.assertEqual(rc, 0, code)
        self.assertTrue(Path(path).is_file())
        self.assertEqual(json.loads(Path(path).read_text())['rc'], 0)
        self.assertTrue(self.fixture.proposals)

    def test_native_ax_geometry_builds_real_wender_state(self):
        from metaviewer_agents.perception.deps_lock import resolve_locked_component
        backend = object.__new__(self.host.HostBackend)
        backend.wender = resolve_locked_component('wender-agent')
        frame = dict(surface_id='owned', width=640, height=360, generation=1, sha256='a' * 64)
        tree = dict(window=dict(title='fixture', url=None), elements=[
            dict(name='Operator Name', role='button', box=[10, 20, 80, 30], states={})])
        backend.ax = lambda: tree
        backend.retain = lambda value: dict(value, bytes=1, artifact='hosted-frame')
        sensed = backend.perceive(dict(frame_ref=frame))
        state = backend.state_for(sensed)
        self.assertEqual([node['name'] for node in state['nodes']], ['Operator Name'])
        self.assertTrue(state['actionable'])

    def test_mut_receipt_path(self):
        owner = Mock()
        owner.run.return_value = SimpleNamespace(rc=0, verdict_code='PASS', summary={}, handoff_path=None)
        with self.assertRaisesRegex(self.host.OwnerRefused, 'receipt path absent'):
            self.execute(lambda *args, **kwargs: owner)

    def test_mut_receipt_contents(self):
        factory = self.host.ReplayOwner
        def changed(*args, **kwargs):
            owner = factory(*args, **kwargs)
            run = owner.run
            def forged():
                result = run()
                owner.output.write_text('{}\n')
                return result
            owner.run = forged
            return owner
        with self.assertRaisesRegex(self.host.OwnerRefused, 'MW_RUN_RECEIPT'):
            self.execute(changed)

    def test_captcha_handoff_path(self):
        original = self.fixture.owner.backend.call
        def wall(stage, **args):
            result = original(stage, **args)
            if stage == 'observe':
                result['observed_wall'] = dict(observed=True, kind='captcha_wall')
            return result
        self.fixture.owner.backend.call = wall
        rc, code, path = self.execute()
        self.assertEqual((rc, code), (4, 'HUMAN_HANDOFF'))
        self.assertEqual(json.loads(Path(path).read_text())['reason'], 'captcha_wall')
        self.assertEqual(self.fixture.proposals, [])


if __name__ == '__main__':
    unittest.main()
