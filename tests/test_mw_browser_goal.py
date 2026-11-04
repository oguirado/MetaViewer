"""Browser goal gates with the real locked planner and synthetic native AX."""
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import signal
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import mw_run_browser_goal as goal
from metaviewer_agents import mw_run
from metaviewer_agents.perception.deps_lock import resolve_locked_component


class BrowserGoalTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir='/dev/shm', prefix='mv-browser-goal-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        checkout = os.environ.get('MV_MW_WENDER_ROOT') or os.environ.get('MV_WENDER_ROOT')
        self.assertTrue(checkout, 'explicit pinned Wender checkout required')
        environment = patch.dict(os.environ, MV_WENDER_ROOT=checkout)
        environment.start()
        self.addCleanup(environment.stop)
        self.wender = resolve_locked_component('wender-agent')
        sys.path.insert(0, str(self.wender))
        self.addCleanup(lambda: sys.path.remove(str(self.wender)))
        self.row = dict(id='native-editor', name='Operator Name', role='textbox',
                        box=[10, 20, 40, 20], actionable=True, focused=False,
                        states=dict(focused=False), value='', value_len=0)
        raw = b'\xff' * (100*80*3)
        path = self.root / 'frame.rgb'
        path.write_bytes(raw)
        self.frame = dict(schema='frame_ref/v0.2', surface_id='surface-fixture',
            generation=1, tick=1, ts_ns=1, width=100, height=80, format='rgb24',
            ramws_path=str(path), sha256=hashlib.sha256(raw).hexdigest(), capture_us=1)
        self.b = object.__new__(goal.BrowserGoalBackend)
        self.b.evidence, self.b.surface_id, self.b.wender = self.root, 'surface-fixture', self.wender
        self.b.handoff = goal.HandoffLatch(self.root / 'handoff.json')
        self.b.moves, self.b.attempts, self.b.program_observations = [], [], []
        self.b.client = Mock()
        self.b.observe = self.observe
        self.b.slot_text = Mock(side_effect=self.readback)
        self.b.propose = Mock(side_effect=self.propose)
        self.b.wait_verify = Mock(side_effect=self.verify)
        self.inputs, self.reads = [], []
        self.args = SimpleNamespace(goal='Operator Name', steps=1, timeout_ms=1000,
                                    text=None, key=None)
        self.planner = goal.WenderSubprocessAdapter(wender_root=self.wender,
                                                   timeout=5, verify_lock=True)

    def observe(self, timeout_ms):
        self.frame['generation'] += 1
        tree = dict(elements=[copy.deepcopy(self.row)], window=dict(url='http://fixture.local/'))
        observed = dict(frame_ref=dict(self.frame), ax_snapshot=tree)
        self.b.guard_wall(observed, dict(frame=observed['frame_ref'], ax=tree['elements']))
        return observed

    def readback(self, row):
        self.reads.append(row['id'])
        row['value_len'] = len(self.row['value'])
        return self.row['value']

    def propose(self, sensed, plan, timeout_ms):
        action = plan['action']
        proposal = dict(proposal_id='test-' + str(len(self.inputs)), action=action)
        self.b.before_propose(proposal, sensed)
        # Exercise native revalidation before synthetic dispatch too.
        goal.host.HostBackend.revalidate_action(sensed, self.b.perceive(self.observe(timeout_ms)), action)
        self.inputs.append(action)
        if action['type'] == 'click':
            self.row['focused'] = self.row['states']['focused'] = True
        elif action['type'] == 'type':
            self.row['value'] = action['text']
            self.row['value_len'] = len(action['text'])
        return dict(proposal_id=proposal['proposal_id'])

    def verify(self, admitted, timeout_ms):
        return dict(status='verified', receipt=dict(after_frame=dict(self.frame)))

    def test_cli_goal_and_text_budget(self):
        runner = Mock(return_value=0)
        argv = ['--identity', 'fixture', '--goal', 'Operator Name', '--steps', '3',
                '--text', 'Música Ω', '--key', 'Enter']
        self.assertEqual(mw_run.main(argv, runner=runner), 0)
        self.assertEqual(runner.call_args.args[0].text, 'Música Ω')
        for extra in (['--site', 'x'], ['--slot', 'x=y'], ['--surface-kind', 'program'],
                      ['--steps', '1']):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                mw_run.main(argv + extra, runner=runner)

    def test_real_planner_click_and_journals(self):
        moves = goal.run_moves(self.b, self.planner, self.args)
        self.assertEqual(len(moves), 1)
        self.assertEqual(self.inputs[0]['type'], 'click')
        for prefix in ('intent-', 'dispatch-', 'receipt-'):
            self.assertEqual(len(list(self.root.glob(prefix + '*.json'))), 1)
        self.assertEqual(self.b.attempts[0]['status'], 'verified_move')

    def test_unmatched_or_ambiguous_goal_never_dispatches(self):
        self.args.goal = 'do something'
        with self.assertRaisesRegex(goal.host.OwnerRefused, 'GOAL_UNGROUNDED'):
            goal.run_moves(self.b, self.planner, self.args)
        self.assertEqual(self.inputs, [])
        self.args.goal = 'Operator Name'
        original = self.b.state_for
        def duplicate(sensed):
            state = original(sensed)
            state['nodes'] *= 2
            return state
        self.b.state_for = duplicate
        with self.assertRaisesRegex(goal.host.OwnerRefused, 'GOAL_UNGROUNDED'):
            goal.run_moves(self.b, self.planner, self.args)
        self.assertEqual(self.inputs, [])

    def test_focus_type_exact_readback_then_enter(self):
        self.args.text, self.args.key, self.args.steps = 'Música Ω', 'Enter', 3
        moves = goal.run_moves(self.b, self.planner, self.args)
        self.assertEqual([a['type'] for a in self.inputs], ['click', 'type', 'key'])
        self.assertEqual(self.inputs[-1]['keys'], ['Return'])
        self.assertEqual(moves[1]['text_gate']['status'], 'exact_native_readback')
        self.assertEqual(self.reads, ['native-editor', 'native-editor'])

    def test_enter_terminal_failure_is_unverified_effect_not_pending_input(self):
        self.args.text, self.args.key, self.args.steps = 'Música Ω', 'Enter', 3
        original = self.propose
        def settled(sensed, plan, timeout_ms):
            result = original(sensed, plan, timeout_ms)
            if plan['action']['type'] == 'key':
                self.assertEqual(plan['expectation']['type'], 'changed_region')
                raise goal.host.tools.VerificationFailed(dict(
                    code='VERIFICATION_FAILED', detail='verification failed'))
            return result
        self.b.propose.side_effect = settled
        with self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_PROGRAM_NO_VISIBLE_EFFECT'):
            goal.run_moves(self.b, self.planner, self.args)
        self.assertEqual([a['type'] for a in self.inputs], ['click', 'type', 'key'])
        self.assertEqual(len(self.b.moves), 2)
        attempt = self.b.attempts[-1]
        self.assertEqual(attempt['status'], 'key_effect_unverified')
        self.assertIsNone(attempt['delivery_verified'])
        self.assertFalse(attempt['effect_verified'])
        self.assertTrue(Path(attempt['receipt_artifact']).is_file())

    def test_enter_timeout_remains_pending_and_never_retries(self):
        self.args.text, self.args.key, self.args.steps = 'Música Ω', 'Enter', 3
        original = self.propose
        def timeout(sensed, plan, timeout_ms):
            result = original(sensed, plan, timeout_ms)
            if plan['action']['type'] == 'key':
                raise goal.host.tools.VerificationFailed(dict(status='timeout', verified=False))
            return result
        self.b.propose.side_effect = timeout
        with self.assertRaises(goal.host.tools.VerificationFailed):
            goal.run_moves(self.b, self.planner, self.args)
        self.assertEqual(self.b.attempts[-1]['status'], 'dispatch_pending')
        self.assertEqual(len(self.inputs), 3)

    def test_wrong_text_prevents_enter_and_preserves_delivered_receipt(self):
        self.args.text, self.args.key, self.args.steps = 'Música Ω', 'Enter', 3
        self.b.slot_text.side_effect = lambda row: self.args.text.swapcase()
        with self.assertRaisesRegex(goal.host.OwnerRefused, 'TEXT_MISMATCH'):
            goal.run_moves(self.b, self.planner, self.args)
        self.assertEqual([a['type'] for a in self.inputs], ['click', 'type'])
        self.assertEqual(len(self.b.moves), 2)
        self.assertEqual(len(list(self.root.glob('receipt-*.json'))), 2)

    def test_editor_replacement_refuses(self):
        self.args.text, self.args.steps = 'hello', 2
        original = self.verify
        def replaced(*args):
            result = original(*args)
            self.row['id'] = 'replacement'
            return result
        self.b.wait_verify.side_effect = replaced
        with self.assertRaisesRegex(goal.host.OwnerRefused, 'FOCUS'):
            goal.run_moves(self.b, self.planner, self.args)
        self.assertEqual([a['type'] for a in self.inputs], ['click'])

    def test_model_wait_keepalive_observes_without_ax(self):
        self.b.ax = Mock(side_effect=AssertionError('no AX read in maintenance'))
        with patch.object(goal.host.tools, 'observe', return_value=dict(frame_ref=self.frame)) as observe:
            self.assertEqual(self.b.keepalive_observe(500)['frame_ref'], self.frame)
        observe.assert_called_once_with('surface-fixture', client=self.b.client, timeout_ms=500)
        other = dict(self.frame, surface_id='surface-other')
        with patch.object(goal.host.tools, 'observe', return_value=dict(frame_ref=other)):
            with self.assertRaises(Exception):
                self.b.keepalive_observe(500)

    def test_muse_uses_bound_ax_marks_and_rejects_invented_target(self):
        sensed = goal.planning_view(self.b, self.b.perceive(self.observe(1000)))
        with goal.marks_workspace() as path:
            goal.annotate_ax(self.b, sensed, path)
            self.assertTrue(path.read_bytes().startswith(b'\x89PNG\r\n\x1a\n'))
            c2 = self.b.program_observations[-1]['c2']
            c3 = dict(schema='cu.action/v1', action=dict(kind='click', mark_id=1, x=30, y=30))
            self.assertEqual(goal.MuseProgramPlanner.selected_name(c3, c2, sensed['table']),
                             'Operator Name')
            for change in (dict(mark_id=2), dict(x=99)):
                bad = dict(c3, action=dict(c3['action'], **change))
                with self.assertRaisesRegex(goal.host.OwnerRefused, 'MODEL_TARGET'):
                    goal.MuseProgramPlanner.selected_name(bad, c2, sensed['table'])

    def test_changed_ax_target_refuses_before_input(self):
        original = self.b.propose.side_effect
        def changed(*args):
            self.row['box'] = [20, 20, 40, 20]
            return original(*args)
        self.b.propose.side_effect = changed
        with self.assertRaisesRegex(goal.host.OwnerRefused, 'REBIND_TARGET'):
            goal.run_moves(self.b, self.planner, self.args)
        self.assertEqual(self.inputs, [])

    def test_goal_rebind_acquires_ax_before_pixels_without_extra_native_read(self):
        events = []
        self.b.ax = Mock(side_effect=lambda: events.append('ax') or
                         dict(elements=[self.row], window={}))
        self.b.observe = goal.BrowserGoalBackend.observe.__get__(self.b)
        with patch.object(goal.host.tools, 'observe', side_effect=lambda *a, **kw:
                          events.append('pixels') or dict(frame_ref=self.frame)):
            result = goal.BrowserGoalBackend.observe_for_rebind(self.b, 1000)
        self.assertEqual(events, ['ax', 'pixels'])
        self.assertEqual(result['ax_snapshot']['elements'], [self.row])

    def test_explicit_stale_refusals_are_not_uncertain_input(self):
        def refused(sensed, plan, timeout_ms):
            self.b.before_propose(dict(proposal_id='stale', **plan), sensed)
            self.b.frame_attempts = [dict(status='STALE_FRAME'),
                dict(status='MW_REBIND_PIXELS', submitted=False)]
            raise goal.host.OwnerRefused('MW_STALE_FRAME_EXHAUSTED')
        self.b.propose.side_effect = refused
        with self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_STALE_FRAME_EXHAUSTED'):
            goal.run_moves(self.b, self.planner, self.args)
        self.assertEqual(self.b.attempts[0]['status'], 'refused_before_execution')
        self.assertEqual(self.inputs, [])

    def test_wall_fixtures_absorb_without_input(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('goal_wall_fixture',
            ROOT / 'tests/e2e/test_mw_run_chatgpt_offline.py')
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        for page in ('login', 'captcha'):
            self.b.handoff = goal.HandoffLatch(self.root / (page + '.handoff.json'))
            tree = fixture.Capsule(start=page).tree()
            observed = dict(frame_ref=self.frame, ax_snapshot=tree,
                observed_wall=dict(observed=True, kind=goal.host.wall_kind(tree)))
            sensed = dict(frame=self.frame, ax=tree['elements'])
            for _ in range(2):
                with self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_HANDOFF_REQUIRED'):
                    self.b.guard_wall(observed, sensed)
            self.assertTrue(self.b.handoff.path.is_file())
        self.b.propose.assert_not_called()

    def test_report_deadline_after_uncertain_move_keeps_rc5(self):
        self.b.attempts = [dict(status='dispatch_pending')]
        real_journal = goal.atomic_journal
        report_timers = []

        def write(path, payload):
            if path.name == 'report.json':
                remaining = signal.getitimer(signal.ITIMER_REAL)[0]
                report_timers.append(remaining)
                if remaining > 0:
                    signal.raise_signal(signal.SIGALRM)
            return real_journal(path, payload)

        with patch.object(goal, 'private_evidence_base', return_value=self.root), \
             patch.object(goal.host, 'connect'), \
             patch.object(goal, 'BrowserGoalBackend', return_value=self.b), \
             patch.object(goal, 'WenderSubprocessAdapter'), \
             patch.object(goal, 'run_moves', side_effect=RuntimeError('uncertain move')), \
             patch.object(goal, 'atomic_journal', side_effect=write), \
             contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
            rc = mw_run.main(['--identity', 'fixture', '--goal', 'Operator Name'],
                             runner=goal.run_entry)
        self.assertEqual(rc, 5)
        result = json.loads(output.getvalue())
        self.assertEqual(result['verdict_code'], 'INPUT_UNCERTAIN')
        self.assertEqual(json.loads(Path(result['report']).read_text())['rc'], 5)
        self.assertEqual(report_timers, [0])

    def test_wall_entry_returns_four(self):
        self.b.observe = Mock(side_effect=goal.host.OwnerRefused('MW_HANDOFF_REQUIRED'))
        self.b.handoff.latched = True
        self.b.handoff.path.write_text('{}')
        self.args.planner, self.args.model_timeout_ms, self.args.identity = 'rules', 1000, 'fixture'
        with patch.object(goal, 'private_evidence_base', return_value=self.root), \
             patch.object(goal.host, 'connect'), \
             patch.object(goal, 'BrowserGoalBackend', return_value=self.b), \
             contextlib.redirect_stdout(io.StringIO()) as output, \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(goal.run_entry(self.args), 4)
        self.assertEqual(json.loads(output.getvalue())['verdict_code'], 'HUMAN_HANDOFF')

    def test_v027_browser_errors_have_typed_remedies_without_losing_uncertainty(self):
        cases = [
            (goal.host.tools.ToolRefusal('SURFACE_NOT_AGENT_CONTROLLED', 1), 'MW_PROGRAM_CONTROL', 'Release'),
            (goal.host.subprocess.TimeoutExpired('native', 1), 'MW_RUN_NATIVE', 'timed out'),
            (goal.host.ClientError('disconnected', 'socket closed'), 'MW_RUN_CORE', 'running MetaViewer core'),
            (goal.host.DependencyLockError('commit_mismatch', 'wrong pin'), 'MW_DEPENDENCY', 'MV_WENDER_ROOT'),
            (goal.host.OwnerRefused('MW_PROGRAM_MODEL_TIMEOUT'), 'MW_PROGRAM_MODEL_TIMEOUT', 'model'),
        ]
        self.args.planner, self.args.model_timeout_ms, self.args.identity = 'rules', 1000, 'fixture'
        for error, expected, remedy in cases:
            for pending in (False, True):
                with self.subTest(error=expected, pending=pending):
                    self.b.attempts = [dict(status='dispatch_pending')] if pending else []
                    self.b.observe = Mock(side_effect=error)
                    with patch.object(goal, 'private_evidence_base', return_value=self.root), \
                         patch.object(goal.host, 'connect'), \
                         patch.object(goal, 'BrowserGoalBackend', return_value=self.b), \
                         contextlib.redirect_stdout(io.StringIO()) as output, \
                         contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(goal.run_entry(self.args), 5 if pending else 6)
                    result = json.loads(output.getvalue())
                    self.assertEqual(result['verdict_code'], 'INPUT_UNCERTAIN' if pending else expected)
                    report = json.loads(Path(result['report']).read_text())
                    self.assertIn(remedy, report['message'])
                    if expected == 'MW_PROGRAM_MODEL_TIMEOUT':
                        if pending:
                            self.assertIn('do not retry', report['message'])
                            self.assertIn('inspect', report['message'])
                            self.assertNotIn('before dispatch', report['message'])
                        else:
                            self.assertIn('before dispatch', report['message'])
                            self.assertIn('retry', report['message'])
                    self.b.propose.assert_not_called()


class BrowserTimeoutRemedyTests(unittest.TestCase):
    def test_v027_model_timeout_after_dispatch_never_recommends_retry(self):
        for pending in (False, True):
            with self.subTest(pending=pending), tempfile.TemporaryDirectory(dir='/dev/shm') as directory:
                backend = SimpleNamespace(surface_id='fixture', wender=Path(directory),
                    observe=Mock(), client=Mock(), attempts=[], moves=[])
                def moves(*args):
                    if pending:
                        backend.attempts.append(dict(status='dispatch_pending'))
                    raise goal.host.OwnerRefused('MW_PROGRAM_MODEL_TIMEOUT')
                args = SimpleNamespace(goal='Operator Name', steps=1, timeout_ms=1000,
                    text=None, key=None, planner='rules', model_timeout_ms=1000, identity='fixture')
                with patch.object(goal, 'private_evidence_base', return_value=Path(directory)), \
                     patch.object(goal.host, 'connect'), \
                     patch.object(goal, 'BrowserGoalBackend', return_value=backend), \
                     patch.object(goal, 'WenderSubprocessAdapter'), \
                     patch.object(goal, 'run_moves', side_effect=moves), \
                     contextlib.redirect_stdout(io.StringIO()) as output, \
                     contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(goal.run_entry(args), 5 if pending else 6)
                result = json.loads(output.getvalue())
                report = json.loads(Path(result['report']).read_text())
                self.assertEqual(result['verdict_code'], 'INPUT_UNCERTAIN' if pending else 'MW_PROGRAM_MODEL_TIMEOUT')
                if pending:
                    self.assertIn('do not retry', report['message'])
                    self.assertIn('inspect', report['message'])
                    self.assertNotIn('before dispatch', report['message'])
                else:
                    self.assertIn('before dispatch', report['message'])
                    self.assertIn('retry', report['message'])


if __name__ == '__main__':
    unittest.main()
