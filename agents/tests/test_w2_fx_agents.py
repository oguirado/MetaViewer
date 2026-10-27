"""Confirmed day-2 findings: rejection gates and valid-wire controls."""
import copy
import tempfile
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from tests import test_wender_bridge as fixtures
from tests.test_wender_bridge import observation, reply
from metaviewer_agents.observe import ObservationError, compute_battery_state_sha256
from metaviewer_agents.perception.base import PerceptionError
from metaviewer_agents.perception.deps_lock import DependencyLockError
from metaviewer_agents.perception.vcore import VCorePerceptionAdapter, project_element_table
from metaviewer_agents.wender_bridge import WenderSubprocessAdapter, validate_state


class Day2Regressions(unittest.TestCase):
    setUp = fixtures.WenderBridgeTests.setUp
    adapter = fixtures.WenderBridgeTests.adapter
    run_plan = fixtures.WenderBridgeTests.run_plan

    def test_element_rows_closed_before_spawn(self):
        adapter = self.adapter()
        projected = project_element_table(observation()['frame_ref'], {
            'summary': '', 'changed_regions': [], 'elements': [{
                'bbox': {'x': 0, 'y': 0, 'w': 100, 'h': 80},
                'role': 'button', 'name': 'Continue', 'confidence': 1}]})
        original = copy.deepcopy(projected)
        adapter.plan_step(observation(), projected, 'Continue')
        self.assertEqual(projected, original)
        rows = [{'malformed': -999}, None]
        good = projected['elements'][0]
        for delta in ({'extra': 1}, {'role': 1}, {'name': None}, {'score_ppm': True},
                      {'score_ppm': -1}, {'score_ppm': 1000001}, {'bbox': {}},
                      *({'bbox': dict(good['bbox'], **d)} for d in (
                          {'extra': 1}, {'x': -1}, {'y': -1}, {'w': 0}, {'h': 0},
                          {'w': 101}, {'h': 81}, {'x': True}))):
            rows.append(dict(good, **delta))
        candidates = [dict(projected, elements=[row]) for row in rows]
        candidates.append(dict(projected, extra=1))
        with patch('metaviewer_agents.wender_bridge.subprocess.Popen',
                   side_effect=AssertionError('must never spawn')), patch(
                       'metaviewer_agents.wender_bridge.subprocess.run',
                       side_effect=AssertionError('must never spawn')):
            for candidate in candidates:
                with self.subTest(candidate=candidate), self.assertRaises(ObservationError) as caught:
                    adapter.plan_step(observation(), candidate, 'Continue')
                self.assertEqual(caught.exception.code, 'bad_shape')

    def test_state_closed_nested_keys_and_geometry(self):
        good = reply()['state']
        self.assertEqual(validate_state(good), compute_battery_state_sha256(good))
        self.assertEqual(validate_state(good),
                         '61b34d07efb16ae859b1d85f41165d0b9ec3f8c1e3bc31939738ce236e983931')
        for field in ('source', 'prune', 'counts'):
            bad = copy.deepcopy(good); bad[field]['extra'] = 1
            with self.subTest(field=field), self.assertRaises(ObservationError):
                validate_state(bad)
        for viewport in ({}, {'w': -1, 'h': 80}, {'w': 100, 'h': -1},
                         {'w': 100, 'h': 80, 'extra': 1}, {'w': True, 'h': 80}):
            with self.subTest(viewport=viewport), self.assertRaises(ObservationError):
                validate_state(dict(good, viewport=viewport))
        for box in ([0, 0, -1, 1], [0, 0, 1, -1], [0, 0, 0, 1]):
            bad = copy.deepcopy(good)
            bad['nodes'][0].update(box=box, actionable=False)
            bad.update(actionable=[], counts={'raw': 1, 'nodes': 1, 'actionable': 0})
            with self.subTest(box=box), self.assertRaises(ObservationError):
                validate_state(bad)
        validate_state(dict(good, viewport=None))
        validate_state(dict(good, viewport={'w': 0, 'h': 0}))

    def test_invalid_roots_are_typed(self):
        loop = self.root / 'loop'; loop.symlink_to(loop)
        for raw in ('\x00', 123, b'bytes', loop):
            for adapter, error, kw in (
                (WenderSubprocessAdapter, ObservationError, {'wender_root': raw, 'command': [sys.executable]}),
                (VCorePerceptionAdapter, PerceptionError, {'ve_root': raw})):
                with self.subTest(raw=repr(raw), adapter=adapter), self.assertRaises(error) as caught:
                    adapter(**kw)
                self.assertEqual(caught.exception.code, 'unavailable')
        WenderSubprocessAdapter(wender_root=self.root, command=[sys.executable])
        VCorePerceptionAdapter(self.root)

    def test_lock_errors_returns_mismatch_and_symlink(self):
        link = self.root / 'alias'; link.symlink_to(self.root, target_is_directory=True)
        for adapter, error, kw, component in (
            (VCorePerceptionAdapter, PerceptionError, {'ve_root': link}, 'vision-engine'),
            (WenderSubprocessAdapter, ObservationError,
             {'wender_root': link, 'command': [sys.executable]}, 'wender-agent')):
            with patch('metaviewer_agents.perception.deps_lock.resolve_locked_component') as resolver:
                adapter(**kw)
                resolver.assert_not_called()
                resolver.return_value = self.root
                adapter(**kw, verify_lock=True)
                resolver.assert_called_once_with(component)
                for code in ('dirty_tree', 'bad_lockfile', 'commit_mismatch', 'unavailable'):
                    resolver.side_effect = DependencyLockError(code, 'lock rejected')
                    with self.subTest(adapter=adapter, code=code), self.assertRaises(error) as caught:
                        adapter(**kw, verify_lock=True)
                    self.assertEqual(caught.exception.code, code)
                resolver.side_effect = None
                for invalid in (None, 123, b'bytes', '\x00'):
                    resolver.return_value = invalid
                    with self.subTest(invalid=invalid), self.assertRaises(error) as caught:
                        adapter(**kw, verify_lock=True)
                    self.assertEqual(caught.exception.code, 'unavailable')
                with tempfile.TemporaryDirectory() as foreign:
                    resolver.return_value = Path(foreign)
                    with self.assertRaises(error) as caught:
                        adapter(**kw, verify_lock=True)
                    self.assertEqual(caught.exception.code, 'commit_mismatch')

    def test_output_floods_are_bounded(self):
        self.run_plan(self.adapter())
        for stream, size in (('stdout', 5 * 1024 * 1024), ('stderr', 65 * 1024)):
            adapter = self.adapter(prelude=f"sys.{stream}.write('x' * {size}); sys.{stream}.flush()")
            with self.subTest(stream=stream), self.assertRaisesRegex(
                    ObservationError, 'planner output exceeds maximum size') as caught:
                self.run_plan(adapter)
            self.assertEqual(caught.exception.code, 'bad_shape')
            self.assertIsNone(adapter.battery_state_sha256)

    def test_output_caps_inclusive_and_bidirectional_io(self):
        # Valid JSON padded to exactly the stdout cap remains admissible.
        import json
        raw = json.dumps(reply())
        self.run_plan(self.adapter(raw=raw + ' ' * (1024 * 1024 - len(raw)),
                                   prelude="sys.stderr.write('x' * (64 * 1024))"))
        # Fill stderr before reading a request larger than the stdin pipe.
        command = [sys.executable, '-c',
                   "import sys,json; sys.stderr.write('x'*65536); sys.stderr.flush(); "
                   "json.load(sys.stdin); sys.stdout.write(" + repr(raw) + ")"]
        adapter = WenderSubprocessAdapter(command=command, wender_root=self.root, timeout=2)
        projected = project_element_table(observation()['frame_ref'], {
            'summary': '', 'changed_regions': [], 'elements': [{
                'bbox': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
                'role': 'button', 'name': 'Continue', 'confidence': 1}]})
        adapter.plan_step(observation(), projected, 'x' * 131072)

    def test_wender_lock_verification_independent_control(self):
        with patch('metaviewer_agents.perception.deps_lock.resolve_locked_component') as resolver:
            resolver.return_value = self.root
            WenderSubprocessAdapter(command=[sys.executable], wender_root=self.root,
                                    verify_lock=True)
            resolver.assert_called_once_with('wender-agent')
            with tempfile.TemporaryDirectory() as foreign:
                resolver.return_value = Path(foreign)
                with self.assertRaises(ObservationError) as caught:
                    WenderSubprocessAdapter(command=[sys.executable], wender_root=self.root,
                                            verify_lock=True)
                self.assertEqual(caught.exception.code, 'commit_mismatch')
