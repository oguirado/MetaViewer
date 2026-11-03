"""V027-FIX-K3: offline lifecycle order, contention and terminal verdicts."""
import contextlib
import fcntl
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
sys.path.insert(0, str(ROOT / 'tests'))
import mw_run_browser_goal as goal
import mw_run_program as program
from metaviewer_agents.client import ToolClient
import test_mw_run_backend as custody


class ControlTests(unittest.TestCase):
    setUp = custody.BackendTests.setUp
    write = custody.BackendTests.write
    invocation = custody.BackendTests.invocation
    custody = custody.BackendTests.custody

    def test_v027_fix_k3_takeover_during_readback_and_publication(self):
        self.surface['control'] = 'agent'
        b = self.backend
        b.__class__ = goal.BrowserGoalBackend
        target = dict(native_editor_id='editor', id='editor', role='textbox',
                      name='Name', box=[0, 0, 10, 10], focused=True)
        sensed = dict(ax=[target])
        for phase in ('readback', 'publication'):
            with self.subTest(phase=phase), self.custody():
                self.surface['control'] = 'agent'
                b.ownership()
                self.surface['control'] = 'human'
                if phase == 'readback':
                    with self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_PROGRAM_CONTROL'):
                        goal.exact_readback(b, sensed, target, 'expected')
                else:
                    b.observe = lambda timeout: dict(frame_ref=dict(generation=(b.ax() or {}).get('generation', 1)))
                    with self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_PROGRAM_CONTROL'):
                        program.wait_for_publication(b, 1, 100)
                self.assertFalse(any(argv[1] == 'ax' for argv in self.argv))
        self.surface['control'] = 'agent'
        with self.custody(), self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_PROGRAM_NO_NEW_PUBLICATION'):
            program.wait_for_publication(b, 1, 1)
        self.surface.pop('control')
        with self.custody(), self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_PROGRAM_CONTROL'):
            b.ownership()


class ContentionTests(unittest.TestCase):
    def client(self, directory):
        def registration(component):
            return dict(endpoint=dict(component=component, instance=component + '-1'),
                hello=dict(component=component, dependencies=[]))
        client = ToolClient(directory / 'socket', session_id='session',
            local=registration('agent'), core=registration('core'), dependency_pins=[],
            sequence_path=directory / 'sequence', timeout_s=1,
            max_line_bytes=65536, max_reply_bytes=65536)
        client.active._check_endpoint = Mock()
        client.active.connect = Mock()
        return client

    def test_v027_fix_k3_exclusive_lane_busy_and_configuration(self):
        for lane in (goal, program):
            for malformed in (False, True):
                with self.subTest(lane=lane.__name__, malformed=malformed), tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    client = self.client(root)
                    path = root / 'sequence'
                    path.write_text('7')
                    path.chmod(0o600)
                    with path.open('r+') as owner:
                        fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        if malformed:
                            client.local['hello']['component'] = 'core'
                        args = SimpleNamespace(goal='Name', steps=1, timeout_ms=1000,
                            text=None, key=None, planner='rules', model_timeout_ms=1000, identity='fixture')
                        with patch.object(lane, 'private_evidence_base', return_value=root), \
                             patch.object(lane.host, 'connect', return_value=client), \
                             contextlib.redirect_stdout(io.StringIO()) as output, \
                             contextlib.redirect_stderr(io.StringIO()):
                            self.assertEqual(lane.run_entry(args), 6)
                        result = json.loads(output.getvalue())
                        expected = ('MW_RUN_CORE' if lane is goal else 'version') if malformed else 'busy'
                        self.assertEqual(result['verdict_code'], expected)
                        report = json.loads(Path(result['report']).read_text())
                        if not malformed:
                            self.assertIn('agent-1', report['message'])
                            self.assertIn('running', report['message'])
                        self.assertEqual(path.read_text(), '7')
                        self.assertIsNone(client._sequence_fd)
                        client.active.connect.assert_not_called()


class TerminalTests(unittest.TestCase):
    def test_v027_fix_k3_terminal_and_uncertain_in_propose_and_wait(self):
        for kind in ('click', 'type', 'key'):
            for phase in ('propose', 'wait'):
                for terminal in (True, False):
                    with self.subTest(kind=kind, phase=phase, terminal=terminal), tempfile.TemporaryDirectory() as tmp:
                        root = Path(tmp)
                        row = dict(id='editor', native_editor_id='editor', role='textbox',
                            name='Name', box=[0, 0, 10, 10], focused=True, value_len=5)
                        frame = dict(surface_id='surface', generation=1, width=10, height=10)
                        sensed = dict(ax=[row], frame=frame, table={})
                        b = SimpleNamespace(evidence=root, surface_id='surface', wender=root,
                            attempts=[], moves=[], client=Mock(), perceive=lambda value: sensed,
                            slot_text=lambda row: 'hello')
                        count = []
                        def observe(timeout):
                            frame['generation'] += 1
                            return dict(frame_ref=dict(frame))
                        b.observe = observe
                        def failure():
                            raise goal.host.tools.VerificationFailed(dict(
                                code='VERIFICATION_FAILED') if terminal else dict(status='timeout', verified=False))
                        def propose(sensed, plan, timeout):
                            action = plan['action']
                            count.append(action['type'])
                            b.active_attempt['status'] = 'dispatch_pending'
                            if action['type'] == kind and phase == 'propose':
                                failure()
                            return dict(proposal_id='proposal')
                        def wait(admitted, timeout):
                            if count[-1] == kind and phase == 'wait':
                                failure()
                            return dict(status='verified')
                        b.propose, b.wait_verify = propose, wait
                        planner = Mock()
                        planner.plan_step.return_value = (dict(type='click'), {}, {}, row)
                        args = SimpleNamespace(goal='Name', steps=3 if kind == 'key' else 2 if kind == 'type' else 1,
                            timeout_ms=1000, text='hello' if kind != 'click' else None,
                            key='Enter' if kind == 'key' else None, planner='rules',
                            model_timeout_ms=1000, identity='fixture')
                        with patch.object(goal, 'private_evidence_base', return_value=root), \
                             patch.object(goal.host, 'connect'), \
                             patch.object(goal, 'BrowserGoalBackend', return_value=b), \
                             patch.object(goal, 'WenderSubprocessAdapter', return_value=planner), \
                             patch.object(goal, 'planning_view', side_effect=lambda b, s: dict(s, observation={})), \
                             patch.object(goal, 'require_grounded_goal'), patch.object(goal, 'require_click_target'), \
                             contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
                            self.assertEqual(goal.run_entry(args), 6 if terminal else 5)
                        result = json.loads(output.getvalue())
                        self.assertEqual(result['verdict_code'], 'MW_PROGRAM_NO_VISIBLE_EFFECT' if terminal else 'INPUT_UNCERTAIN')
                        self.assertEqual(count, ['click', 'type', 'key'][:args.steps])
                        attempt = json.loads(Path(result['report']).read_text())['attempts'][-1]
                        if terminal:
                            self.assertFalse(attempt['effect_verified'])
                            self.assertIsNone(attempt['delivery_verified'])
                            receipt = json.loads(Path(attempt['receipt_artifact']).read_text())
                            self.assertEqual(receipt['settlement']['code'], 'VERIFICATION_FAILED')
                        else:
                            self.assertIn(attempt['status'], ('dispatch_pending', 'settlement_pending'))


if __name__ == '__main__':
    unittest.main()
