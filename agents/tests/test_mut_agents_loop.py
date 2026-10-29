"""Regression oracles for single-shot loop boundaries; no private providers."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents import tools, verify, wender_bridge
from metaviewer_agents.loop_trials import _wrap_planner
from metaviewer_agents.observe import ObservationError
from metaviewer_agents.planner import PlannerError
from test_wender_bridge import observation, table, reply
from test_tools import _FakeClient, _admitted, _proposal


class LoopBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.observation = observation()
        self.action = reply()['action']
        self.expectation = reply()['expectation']
        self.ops = []
        self.receipt = {'proposal_id': 'p1', 'after_frame': {'surface_id': 'test'}}
        for mocker in (
            patch.dict(os.environ, {}, clear=True),
            patch.object(verify.time, 'monotonic', return_value=10),
            patch.object(tools, 'observe', side_effect=self.observe),
            patch.object(tools, 'propose', side_effect=self.propose),
            patch.object(tools, 'wait_verify', side_effect=self.wait),
        ):
            mocker.start()
            self.addCleanup(mocker.stop)

    def observe(self, *args, **kwargs):
        self.ops.append('observe')
        return copy.deepcopy(self.observation)

    def propose(self, *args, **kwargs):
        self.ops.append('propose')

    def wait(self, *args, **kwargs):
        self.ops.append('wait_verify')
        return copy.deepcopy(self.receipt)

    def run_loop(self, **overrides):
        options = dict(client=object(), surface_id='test', proposal_id='p1',
                       planner=lambda obs: (self.action, self.expectation),
                       provider='local', timeout_ms=1000)
        options.update(overrides)
        return verify.run_loop(**options)

    def test_local_arity_is_typed_and_stops_before_propose(self):
        with self.assertRaises(ObservationError) as caught:
            self.run_loop(planner=lambda obs: (self.action, self.expectation, None))
        self.assertEqual(caught.exception.code, 'bad_shape')
        self.assertEqual(self.ops, ['observe'])

    def test_receipt_proposal_correlation(self):
        self.receipt['proposal_id'] = 'other'
        with self.assertRaisesRegex(tools.ToolValidationError, 'uncorrelated proposal_id'):
            self.run_loop()
        self.assertEqual(self.ops, ['observe', 'propose', 'wait_verify'])

    def test_receipt_after_surface_correlation(self):
        self.receipt['after_frame']['surface_id'] = 'other'
        with self.assertRaisesRegex(tools.ToolValidationError, 'uncorrelated surface_id'):
            self.run_loop()

    def test_legacy_wait_signature_returns_correlated_receipt(self):
        def legacy(proposal_id, expectation, timeout_ms, *, client):
            self.assertEqual(proposal_id, 'p1')
            self.assertEqual(expectation, self.expectation)
            return self.wait()
        with patch.object(tools, 'wait_verify', side_effect=legacy) as wait:
            self.assertEqual(self.run_loop(), self.receipt)
        self.assertEqual(wait.call_count, 2)
        self.assertEqual(self.ops, ['observe', 'propose', 'wait_verify'])

    def test_explicit_root_pin_precedes_bridge_and_matching_pin_runs(self):
        self.observation['vision'] = {}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch('metaviewer_agents.perception.deps_lock.resolve_locked_component', return_value=root), \
                    patch('metaviewer_agents.perception.vcore.project_element_table', return_value={}), \
                    patch.object(wender_bridge, 'WenderSubprocessAdapter') as bridge:
                bridge.return_value.plan_step.return_value = (self.action, self.expectation, {}, {})
                with self.assertRaises(ObservationError) as caught:
                    self.run_loop(provider='wender', wender_root=root / 'other')
                self.assertEqual(caught.exception.code, 'commit_mismatch')
                self.assertEqual(self.ops, ['observe'])
                bridge.assert_not_called()
                self.ops.clear()
                self.assertEqual(self.run_loop(provider='wender', wender_root=root), self.receipt)
                bridge.return_value.plan_step.assert_called_once()
                self.assertEqual(self.ops, ['observe', 'propose', 'wait_verify'])

    def test_no_provider_no_planner_defaults_to_wender(self):
        # Missing vision distinguishes Wender selection before dependency lookup/spawn.
        with patch.object(wender_bridge, 'WenderSubprocessAdapter') as bridge:
            with self.assertRaises(ObservationError) as caught:
                self.run_loop(provider=None, planner=None)
        self.assertEqual(caught.exception.code, 'unavailable')
        self.assertIn('perception evidence', str(caught.exception))
        self.assertEqual(self.ops, ['observe'])
        bridge.assert_not_called()

    def test_trial_ground_truth_and_kind_guard_before_submit(self):
        for kind, truth, refused in (('browser', True, True), ('holdings', False, True),
                                     ('browser', False, False)):
            with self.subTest(kind=kind, truth=truth):
                self.ops.clear()
                self.observation = observation()
                if truth:
                    self.observation['ground_truth'] = {}
                context = {}
                action = dict(type='lane_submit', verb='submit',
                              payload=dict(nonce='fixture', seq=1, command='noop', args=[]))
                wrapped = _wrap_planner(lambda obs: (action, self.expectation), 1, kind, context)
                if refused:
                    with self.assertRaises(PlannerError) as caught:
                        self.run_loop(planner=wrapped)
                    self.assertEqual(caught.exception.code, 'POLICY')
                    self.assertEqual(self.ops, ['observe'])
                    self.assertNotIn('action', context)
                else:
                    self.assertEqual(self.run_loop(planner=wrapped), self.receipt)
                    self.assertEqual(self.ops, ['observe', 'propose', 'wait_verify'])


class ToolAndBridgeBoundaryTests(unittest.TestCase):
    def test_equal_tick_window_dispatch_and_inverted_window_no_dispatch(self):
        expectation = dict(type='state_sha256_change', before='a' * 64, min_tick=7, max_tick=7)
        client = _FakeClient([lambda call: _admitted(call['request_id'])])
        proposal = _proposal(expectation=expectation)
        self.assertEqual(tools.propose(proposal, client=client, timeout_ms=500)['proposal_id'], 'p-1')
        self.assertEqual(client.calls[0][0]['args']['proposal']['expectation'], expectation)
        inverted = _proposal(expectation=dict(expectation, min_tick=8))
        with self.assertRaisesRegex(tools.ToolValidationError, 'inverted tick window'):
            tools.propose(inverted, client=client, timeout_ms=500)
        self.assertEqual(len(client.calls), 1)

    def test_empty_and_whitespace_command_fail_closed(self):
        for raw in ('', '   '):
            with self.subTest(raw=raw):
                with self.assertRaises(ObservationError) as caught:
                    wender_bridge.resolve_planner_command(configured_env=raw, use_env=False)
                self.assertEqual(caught.exception.code, 'bad_shape')
        argv = [sys.executable, '-m', 'fixture']
        self.assertEqual(wender_bridge.resolve_planner_command(
            configured_env=json.dumps(argv), use_env=False), tuple(argv))

    def test_height_and_blank_goal_rejected_before_spawn_and_edges_accepted(self):
        payload = reply()
        payload['action'].update(x=10, y=20)
        with tempfile.TemporaryDirectory(prefix='mut-café-') as directory:
            script = Path(directory) / 'planner.py'
            script.write_text('import json,sys\njson.load(sys.stdin)\nprint(' + repr(json.dumps(payload)) + ')\n')
            adapter = wender_bridge.WenderSubprocessAdapter(
                command=[sys.executable, str(script)], wender_root=directory)
            for element_table, goal, detail in ((dict(table(), height=81), 'Continue', 'frame mismatch'),
                                                 (table(), '   ', 'goal required')):
                with self.subTest(detail=detail), patch.object(wender_bridge, '_run_bounded') as spawn:
                    with self.assertRaises(ObservationError) as caught:
                        adapter.plan_step(observation(), element_table, goal)
                    self.assertEqual(caught.exception.code, 'bad_shape')
                    self.assertIn(detail, str(caught.exception))
                    spawn.assert_not_called()
            action, expectation, _, _ = adapter.plan_step(observation(), table(), 'Continue')
            self.assertEqual(action, payload['action'])
            self.assertEqual(expectation, payload['expectation'])


if __name__ == '__main__':
    unittest.main()
