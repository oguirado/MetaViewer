"""GATES-2: perf_leg live RSS --probe invocation and mutation controls."""
import ast
import io
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load_gate_perf_api(bounded_fn, mutate_skip_always_true=False):
    source = (ROOT / 'tools/gate.sh').read_text().split("<<'PY'\n", 1)[1]
    source = source.rsplit('\nsys.exit(main())', 1)[0]
    tree = ast.parse(source)
    names = {'electron_dist', 'perf_leg'}
    found = {
        node.name
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in names
    }
    if found != names:
        raise ValueError('perf_leg primitives absent')
    if mutate_skip_always_true:
        mutated = 0
        for func in tree.body:
            if not (isinstance(func, ast.FunctionDef) and func.name == 'perf_leg'):
                continue
            for stmt in func.body:
                if (
                    isinstance(stmt, ast.If)
                    and isinstance(stmt.test, ast.Compare)
                    and 'MV_GATE_PERF_LIVE' in ast.unparse(stmt.test)
                ):
                    stmt.test = ast.Constant(value=True)
                    ast.fix_missing_locations(stmt)
                    mutated += 1
        if mutated != 1:
            raise AssertionError(f'expected 1 MV_GATE_PERF_LIVE guard to mutate, found {mutated}')
    namespace = {'__name__': 'gate_perf_leg_test'}
    ast.fix_missing_locations(tree)
    with patch.object(sys, 'argv', ['gate.sh', str(ROOT), 'self-test']):
        exec(compile(tree, str(ROOT / 'tools/gate.sh'), 'exec'), namespace)
    namespace['bounded'] = bounded_fn
    return namespace


class GatePerfLegTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'repo'
        self.root.mkdir(parents=True)
        self.dist_dir = Path(self.temp.name) / 'electron-dist'
        self.dist_dir.mkdir(parents=True)
        self.electron_bin = self.dist_dir / 'electron'
        self.electron_bin.write_text('#!/bin/sh\nexit 0\n')
        self.electron_bin.chmod(0o755)
        self.base_env = {
            'PATH': '/usr/bin:/bin',
            'ELECTRON_OVERRIDE_DIST_PATH': str(self.dist_dir),
            'ELECTRON_RUN_AS_NODE': '1',
        }

    def which_stub(self, cmd, path=None):
        if cmd in ('node', 'xvfb-run'):
            return f'/stub/bin/{cmd}'
        return None

    def make_bounded_recorder(self, probe_rc=0):
        calls = []

        def fake_bounded(argv, cwd, env, seconds=300):
            calls.append({
                'argv': list(argv),
                'cwd': cwd,
                'env': dict(env),
                'seconds': seconds,
            })
            if '--probe' in argv:
                return probe_rc
            if '--receipt' in argv and 'tests/perf/leak-renderer.json' in argv:
                return 1
            return 0

        return calls, fake_bounded

    def test_perf_leg_live_probe_invoked_and_propagates_rc(self):
        env = dict(self.base_env, MV_GATE_PERF_LIVE='1')

        # Positive control: probe returns 0 -> perf_leg returns 0.
        calls_ok, bounded_ok = self.make_bounded_recorder(probe_rc=0)
        api_ok = load_gate_perf_api(bounded_ok)
        stderr_ok = io.StringIO()
        with patch.object(shutil, 'which', side_effect=self.which_stub), \
                patch.object(sys, 'stderr', stderr_ok):
            rc_ok = api_ok['perf_leg'](self.root, env)
        self.assertEqual(rc_ok, 0, stderr_ok.getvalue())
        probe_calls = [c for c in calls_ok if '--probe' in c['argv']]
        self.assertEqual(len(probe_calls), 1)
        probe_call = probe_calls[0]
        self.assertEqual(
            probe_call['argv'],
            [
                '/stub/bin/xvfb-run', '-a', '-s', '-screen 0 1280x900x24',
                'python3', 'tools/budget_gate.py', '--probe', '--electron',
                str(self.electron_bin.resolve()),
            ],
        )
        self.assertEqual(probe_call['seconds'], 600)
        self.assertNotIn('ELECTRON_RUN_AS_NODE', probe_call['env'])
        self.assertEqual(probe_call['env']['ELECTRON_OVERRIDE_DIST_PATH'], str(self.dist_dir.resolve()))

        # Negative control on probe rc: probe returns 1 -> perf_leg returns 1.
        calls_fail, bounded_fail = self.make_bounded_recorder(probe_rc=1)
        api_fail = load_gate_perf_api(bounded_fail)
        stderr_fail = io.StringIO()
        with patch.object(shutil, 'which', side_effect=self.which_stub), \
                patch.object(sys, 'stderr', stderr_fail):
            rc_fail = api_fail['perf_leg'](self.root, env)
        self.assertEqual(rc_fail, 1)
        self.assertEqual(len([c for c in calls_fail if '--probe' in c['argv']]), 1)
        self.assertIn('perf: child rc=1:', stderr_fail.getvalue())

    def test_perf_leg_skips_probe_when_unset_and_kills_always_skip_mutation(self):
        # Negative control: MV_GATE_PERF_LIVE unset -> skips --probe and returns 0.
        calls_unset, bounded_unset = self.make_bounded_recorder(probe_rc=0)
        api_unset = load_gate_perf_api(bounded_unset)
        stderr_unset = io.StringIO()
        with patch.object(shutil, 'which', side_effect=self.which_stub), \
                patch.object(sys, 'stderr', stderr_unset):
            rc_unset = api_unset['perf_leg'](self.root, dict(self.base_env))
        self.assertEqual(rc_unset, 0)
        self.assertEqual([c for c in calls_unset if '--probe' in c['argv']], [])
        self.assertIn('MV_GATE_PERF_LIVE not set', stderr_unset.getvalue())

        # Surviving mutation check: mutating `if environment.get('MV_GATE_PERF_LIVE') != '1':`
        # to `if True:` fails the `--probe` invocation assertion when MV_GATE_PERF_LIVE=1.
        calls_mut, bounded_mut = self.make_bounded_recorder(probe_rc=0)
        mutated_api = load_gate_perf_api(bounded_mut, mutate_skip_always_true=True)
        with patch.object(shutil, 'which', side_effect=self.which_stub), \
                patch.object(sys, 'stderr', io.StringIO()):
            rc_mut = mutated_api['perf_leg'](self.root, dict(self.base_env, MV_GATE_PERF_LIVE='1'))
        self.assertEqual(rc_mut, 0)
        self.assertEqual(
            [c for c in calls_mut if '--probe' in c['argv']],
            [],
            'Mutated perf_leg(if True:) unexpectedly invoked --probe',
        )


if __name__ == '__main__':
    unittest.main()
