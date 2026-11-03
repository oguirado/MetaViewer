"""Offline regressions for judge automation recovery, in refusal/recovery order."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import mw_run_backend as host
import mw_run_browser_goal as browser
import mw_run_program as program
from metaviewer_agents.mw_refusals import refusal_sentence


class AutomationDiagnosisTests(unittest.TestCase):
    def fixture(self, path, name):
        spec = importlib.util.spec_from_file_location('j4_' + name, ROOT / path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        fixture = getattr(module, name)()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        return fixture

    def assert_control_remedy(self, message):
        self.assertIn('Switch to agent mode', message)
        self.assertIn('Human', message)
        self.assertIn('Agent', message)
        self.assertIn('Release', message)

    def test_program_human_role_release_then_switch_and_agent_takeover(self):
        f = self.fixture('tools/test_mw_run_program.py', 'ProgramTests')
        # Release does not change a Human role; the core still reports human
        # control. Only switching the role supplies an agent custody witness.
        for stage in ('Human role', 'Human role after Release', 'Agent takeover'):
            with self.subTest(stage=stage):
                f.legacy_binding(role='agent' if stage == 'Agent takeover' else 'human')
                with patch.object(f.b, 'native') as native, \
                     patch.object(host, 'command') as command, \
                     patch.object(host.tools, 'list_surfaces', return_value=dict(
                         surfaces=[dict(f.surface, control='human')], next_cursor=None)), \
                     self.assertRaises(host.OwnerRefused) as caught:
                    f.b.ownership()
                self.assertEqual(caught.exception.code, 'MW_PROGRAM_CONTROL')
                self.assert_control_remedy(str(caught.exception))
                native.assert_not_called()
                command.assert_not_called()
        f.legacy_binding(role='agent')
        self.assertEqual(f.own()['surface_id'], f.surface['surface_id'])

    def test_browser_core_control_refusal_reports_both_repairs_before_input(self):
        f = self.fixture('tools/test_mw_run_program.py', 'ProgramTests')
        backend = object.__new__(browser.BrowserGoalBackend)
        backend.client, backend.surface_id = Mock(), f.surface['surface_id']
        backend.ax = Mock(return_value=dict(elements=[]))
        backend.propose = Mock()
        args = SimpleNamespace(goal='Editor', steps=1, timeout_ms=1000,
                               identity='alice', planner='rules', model_timeout_ms=1000)
        with patch.object(browser, 'private_evidence_base', return_value=f.root), \
             patch.object(host, 'connect'), \
             patch.object(browser, 'BrowserGoalBackend', return_value=backend), \
             patch.object(host.tools, 'observe', side_effect=host.tools.ToolRefusal(
                 'SURFACE_NOT_AGENT_CONTROLLED', 1)), \
             contextlib.redirect_stdout(io.StringIO()) as output, \
             contextlib.redirect_stderr(io.StringIO()) as diagnostic:
            self.assertEqual(browser.run_entry(args), 6)
        result = json.loads(output.getvalue())
        self.assertEqual(result['verdict_code'], 'MW_PROGRAM_CONTROL')
        report = json.loads(Path(result['report']).read_text())
        self.assert_control_remedy(report['message'])
        self.assert_control_remedy(diagnostic.getvalue())
        backend.propose.assert_not_called()
        backend.client.subscribe_frames.assert_not_called()

    def test_cli_static_control_remedy_does_not_override_role_repair(self):
        self.assert_control_remedy(refusal_sentence('MW_PROGRAM_CONTROL'))

    def test_failed_docker_inventory_is_diagnosed_before_binding_selection(self):
        f = self.fixture('tests/test_mw_run_backend.py', 'BackendTests')
        args = SimpleNamespace(goal='Editor', steps=1, timeout_ms=1000,
                               identity='alice', planner='rules', model_timeout_ms=1000)
        for stderr in (b'permission denied', b'Cannot connect to the Docker daemon'):
            with self.subTest(stderr=stderr):
                reply = SimpleNamespace(returncode=1, stdout=b'', stderr=stderr)
                original = f.invocation
                def invoke(argv, **kwargs):
                    return reply if argv[0] == 'docker' else original(argv, **kwargs)
                with patch.object(f, 'invocation', side_effect=invoke), f.custody(), \
                     patch.object(browser, 'private_evidence_base', return_value=f.root), \
                     patch.object(host, 'connect'), \
                     patch.object(browser, 'BrowserGoalBackend',
                         side_effect=lambda *a: f.backend.ownership()), \
                     contextlib.redirect_stdout(io.StringIO()) as output, \
                     contextlib.redirect_stderr(io.StringIO()) as diagnostic:
                    self.assertEqual(browser.run_entry(args), 6)
                result = json.loads(output.getvalue())
                self.assertEqual(result['verdict_code'], 'MW_RUN_OWNERSHIP')
                message = json.loads(Path(result['report']).read_text())['message']
                self.assertIn('Docker', message)
                self.assertIn('doctor --capsules', message)
                self.assertIn('Docker', diagnostic.getvalue())
                self.assertIsNone(f.backend.surface_id)
                self.assertIsNone(f.backend.capsule)
                self.assertFalse(any('input' in argv for argv in f.argv))
        # Repairing inventory permits the original binding, never a replacement.
        with f.custody():
            self.assertEqual(f.backend.ownership()['capsules'], ['srf-id-alice'])
            f.surface['surface_id'] = 'replacement'
            with self.assertRaises(host.OwnerRefused) as caught:
                f.backend.ownership()
        self.assertEqual(caught.exception.code, 'MW_RUN_OWNERSHIP')
        self.assertNotIn('Docker', str(caught.exception))
        self.assertEqual(f.backend.surface_id, 'surface-alice')


if __name__ == '__main__':
    unittest.main()
