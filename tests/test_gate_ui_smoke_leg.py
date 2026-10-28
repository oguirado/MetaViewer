"""GATES-1: ui_smoke_leg marker line verification and mutation controls."""
import ast
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load_gate_smoke_api(mutate_witnessed_true=False):
    source = (ROOT / 'tools/gate.sh').read_text().split("<<'PY'\n", 1)[1]
    source = source.rsplit('\nsys.exit(main())', 1)[0]
    tree = ast.parse(source)
    names = {'electron_dist', 'ui_smoke_leg'}
    found = {
        node.name
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in names
    }
    if found != names:
        raise ValueError('ui_smoke_leg primitives absent')
    if mutate_witnessed_true:
        mutated = 0
        for func in tree.body:
            if not (isinstance(func, ast.FunctionDef) and func.name == 'ui_smoke_leg'):
                continue
            for parent in ast.walk(func):
                for attr in ('body', 'orelse', 'finalbody'):
                    body = getattr(parent, attr, None)
                    if not isinstance(body, list):
                        continue
                    for idx, stmt in enumerate(body):
                        if (
                            isinstance(stmt, ast.AugAssign)
                            and isinstance(stmt.target, ast.Name)
                            and stmt.target.id == 'witnessed'
                            and isinstance(stmt.op, ast.BitOr)
                        ):
                            replacement = ast.Assign(
                                targets=[ast.Name(id='witnessed', ctx=ast.Store())],
                                value=ast.Constant(value=True),
                            )
                            ast.copy_location(replacement, stmt)
                            ast.fix_missing_locations(replacement)
                            body[idx] = replacement
                            mutated += 1
        if mutated != 1:
            raise AssertionError(f'expected 1 witnessed|= mutation target, found {mutated}')
    namespace = {'__name__': 'gate_ui_smoke_leg_test'}
    ast.fix_missing_locations(tree)
    with patch.object(sys, 'argv', ['gate.sh', str(ROOT), 'self-test']):
        exec(compile(tree, str(ROOT / 'tools/gate.sh'), 'exec'), namespace)
    namespace['stop_process_tree'] = lambda process: None
    return namespace


def make_popen_stub(outputs_by_script, recorded_calls):
    class FakeProcess:
        def __init__(self, argv, cwd=None, env=None, stdout=None, stderr=None, start_new_session=None):
            script_arg = argv[1] if len(argv) > 1 else ''
            script_name = Path(script_arg).name
            entry = outputs_by_script.get(script_name, ('', 0))
            text, rc = entry if isinstance(entry, tuple) else (entry, 0)
            recorded_calls.append({
                'argv': list(argv),
                'cwd': cwd,
                'env': dict(env or {}),
                'start_new_session': start_new_session,
            })
            if stdout is not None:
                stdout.write(text)
                stdout.flush()
            self._rc = rc
            self.pid = 42424

        def wait(self, timeout=None):
            return self._rc

        def poll(self):
            return self._rc

    return FakeProcess


class GateUiSmokeLegTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'repo'
        (self.root / 'ui').mkdir(parents=True)
        self.dist_dir = Path(self.temp.name) / 'electron-dist'
        self.dist_dir.mkdir(parents=True)
        self.electron_bin = self.dist_dir / 'electron'
        self.electron_bin.write_text('#!/bin/sh\nexit 0\n')
        self.electron_bin.chmod(0o755)
        self.env = {
            'PATH': '/usr/bin:/bin',
            'ELECTRON_OVERRIDE_DIST_PATH': str(self.dist_dir),
            'ELECTRON_RUN_AS_NODE': '1',
        }

    def which_stub(self, cmd, path=None):
        if cmd in ('node', 'xvfb-run'):
            return f'/stub/bin/{cmd}'
        return None

    def test_electron_dist_resolves_override_and_local_package(self):
        api = load_gate_smoke_api()
        self.assertEqual(api['electron_dist'](self.root, self.env), self.dist_dir)

        pkg_dir = self.root / 'ui/node_modules/electron'
        (pkg_dir / 'dist').mkdir(parents=True)
        (pkg_dir / 'path.txt').write_text('electron\n')
        local_bin = pkg_dir / 'dist/electron'
        local_bin.write_text('#!/bin/sh\nexit 0\n')
        local_bin.chmod(0o755)
        self.assertEqual(api['electron_dist'](self.root, {}), pkg_dir / 'dist')

    def test_missing_marker_fails_even_when_rc_is_zero(self):
        api = load_gate_smoke_api()
        for missing_script, outputs in (
            ('smoke.mjs', {
                'smoke.mjs': ('booting smoke\nno marker emitted\n', 0),
                'smoke-main.mjs': ('METAVIEWER_MAIN_SMOKE_OK\n', 0),
            }),
            ('smoke-main.mjs', {
                'smoke.mjs': ('METAVIEWER_SMOKE_OK\n', 0),
                'smoke-main.mjs': ('main smoke finished without marker\n', 0),
            }),
        ):
            with self.subTest(missing_script=missing_script):
                calls = []
                stderr = io.StringIO()
                stdout = io.StringIO()
                with patch.object(shutil, 'which', side_effect=self.which_stub), \
                        patch.object(subprocess, 'Popen', side_effect=make_popen_stub(outputs, calls)), \
                        patch.object(sys, 'stderr', stderr), \
                        patch.object(sys, 'stdout', stdout):
                    rc = api['ui_smoke_leg'](self.root, self.env, timeout=5)
                self.assertEqual(rc, 1)
                self.assertIn(f'ui-smoke: {missing_script}: child rc=0, marker=False', stderr.getvalue())

    def test_exact_markers_pass_and_surviving_mutation_is_killed(self):
        api = load_gate_smoke_api()
        valid_outputs = {
            'smoke.mjs': ('log line\nMETAVIEWER_SMOKE_OK\n', 0),
            'smoke-main.mjs': ('log line\nMETAVIEWER_MAIN_SMOKE_OK\n', 0),
        }
        calls = []
        stderr = io.StringIO()
        stdout = io.StringIO()
        with patch.object(shutil, 'which', side_effect=self.which_stub), \
                patch.object(subprocess, 'Popen', side_effect=make_popen_stub(valid_outputs, calls)), \
                patch.object(sys, 'stderr', stderr), \
                patch.object(sys, 'stdout', stdout):
            rc = api['ui_smoke_leg'](self.root, self.env, timeout=5)
        self.assertEqual(rc, 0, stderr.getvalue())
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]['argv'], ['/stub/bin/node', 'test/smoke.mjs'])
        self.assertEqual(calls[1]['argv'], ['/stub/bin/node', 'test/smoke-main.mjs'])
        for call in calls:
            self.assertNotIn('ELECTRON_RUN_AS_NODE', call['env'])
            self.assertEqual(call['env']['ELECTRON_OVERRIDE_DIST_PATH'], str(self.dist_dir.resolve()))

        # Negative/mutation control: mutating `witnessed |= line.strip() == marker`
        # to `witnessed = True` on an in-memory AST copy lets missing-marker output pass (rc 0 != 1).
        mutated_api = load_gate_smoke_api(mutate_witnessed_true=True)
        missing_marker_outputs = {
            'smoke.mjs': ('log line without marker\n', 0),
            'smoke-main.mjs': ('log line without marker\n', 0),
        }
        with patch.object(shutil, 'which', side_effect=self.which_stub), \
                patch.object(subprocess, 'Popen', side_effect=make_popen_stub(missing_marker_outputs, [])), \
                patch.object(sys, 'stderr', io.StringIO()), \
                patch.object(sys, 'stdout', io.StringIO()):
            unmutated_rc = api['ui_smoke_leg'](self.root, self.env, timeout=5)
            mutated_rc = mutated_api['ui_smoke_leg'](self.root, self.env, timeout=5)
        self.assertEqual(unmutated_rc, 1)
        self.assertNotEqual(mutated_rc, 1, 'Surviving mutation witnessed = True was not detected')


if __name__ == '__main__':
    unittest.main()
