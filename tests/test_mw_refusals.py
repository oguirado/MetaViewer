"""Actionable refusal output with byte-exact result compatibility and no live runs."""
import ast
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'agents'))
from metaviewer_agents import mw_refusals, mw_run


def source_codes(source):
    """Include literal MW codes, named code constants and non-MW need codes."""
    tree = ast.parse(source)
    codes = {node.value for node in ast.walk(tree)
             if isinstance(node, ast.Constant) and isinstance(node.value, str)
             and re.fullmatch(r'MW_[A-Z_]+', node.value)}
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = getattr(node.func, 'id', getattr(node.func, 'attr', None))
            if name in ('need', 'refuse', 'OwnerRefused'):
                index = 1 if name == 'need' else 0
                if len(node.args) > index:
                    value = node.args[index]
                    if isinstance(value, ast.Constant) and isinstance(value.value, str):
                        codes.add(value.value)
    return codes


class RefusalTests(unittest.TestCase):
    def test_source_scan_covers_every_local_code(self):
        paths = sorted((ROOT / 'tools').glob('mw_run_*.py'))
        self.assertTrue(paths)
        paths.append(ROOT / 'agents/metaviewer_agents/mw_run.py')
        for path in paths:
            with self.subTest(path=path.name):
                self.assertFalse(source_codes(path.read_text()) - mw_refusals.REFUSALS.keys())
        for code in ('MW_PROGRAM_CONTROL', 'MW_RUN_NO_SURFACE', 'MW_RUN_AMBIGUOUS',
                     'MW_PROGRAM_MODEL_TARGET', 'MW_PROGRAM_NO_VISIBLE_EFFECT',
                     'HUMAN_HANDOFF', 'MW_COMPILED_BROWSER_UNAVAILABLE', 'INPUT_UNCERTAIN'):
            self.assertIn(code, mw_refusals.REFUSALS)

    def test_source_scan_negative_control(self):
        codes = source_codes("need(False, 'MW_NEW_REFUSAL'); raise refuse('NEW_EXTERNAL', 'detail')")
        self.assertEqual(codes - mw_refusals.REFUSALS.keys(), {'MW_NEW_REFUSAL', 'NEW_EXTERNAL'})
        rows = dict(mw_refusals.REFUSALS)
        rows.pop('MW_PROGRAM_CONTROL')
        source = (ROOT / 'tools/mw_run_program.py').read_text()
        self.assertIn('MW_PROGRAM_CONTROL', source_codes(source) - rows.keys())

    def invoke(self, runner, flags=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            rc = mw_run.main(['--identity', 'fixture'] + (flags or
                ['--site', 'fixture', '--workflow', 'read']), runner=runner)
        return rc, stdout.getvalue(), stderr.getvalue()

    def test_every_row_on_all_entry_modes_preserves_wire_and_rc(self):
        for code, sentence in mw_refusals.REFUSALS.items():
            self.assertIn('; ', sentence)
            self.assertTrue(sentence.endswith('.'))
            self.assertNotIn('\n', sentence)
            for flags in (None, ['--surface-kind', 'program', '--goal', 'button'],
                          ['--goal', 'button']):
                with self.subTest(code=code, flags=flags):
                    rc = 4 if code == 'HUMAN_HANDOFF' else 5 if code == 'INPUT_UNCERTAIN' else 6
                    record = dict(schema='metaviewer.mw_run/v1', rc=rc,
                                  verdict_code=code, receipt=None, report=None)
                    wire = json.dumps(record) + '\n'
                    def runner(args):
                        # Also exercise fragmented writes without altering the wire.
                        sys.stdout.write(wire[:17])
                        sys.stdout.write(wire[17:])
                        return rc
                    actual_rc, stdout, stderr = self.invoke(runner, flags)
                    self.assertEqual(actual_rc, rc)
                    self.assertEqual(stdout, wire)
                    self.assertEqual(json.loads(stdout), record)
                    self.assertEqual(stderr.count(sentence), 1)

    def test_real_backend_bare_slot_refusal(self):
        path = ROOT / 'tools/mw_run_backend.py'
        spec = importlib.util.spec_from_file_location('refusal_host', path)
        host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host)
        with patch.object(host, 'connect') as connect:
            rc, stdout, stderr = self.invoke(host.run_entry,
                ['--site', 'fixture', '--workflow', 'read', '--slot', 'invalid'])
        self.assertEqual(rc, 6)
        self.assertEqual(json.loads(stdout)['verdict_code'], 'MW_SLOT')
        self.assertIn(mw_refusals.REFUSALS['MW_SLOT'], stderr)
        connect.assert_not_called()

    def test_wall_fallback_final_private_output_verdict(self):
        def runner(args):
            raise mw_run.WallDeadlineError(1)
        # An invalid state root causes the fallback to replace the deadline code.
        with patch.dict('os.environ', {'XDG_STATE_HOME': 'relative'}):
            rc, stdout, stderr = self.invoke(runner)
        self.assertEqual(rc, 6)
        self.assertEqual(json.loads(stdout)['verdict_code'], 'MW_PRIVATE_OUTPUT')
        self.assertIn(mw_refusals.REFUSALS['MW_PRIVATE_OUTPUT'], stderr)

    def test_nonresults_success_unknown_and_large_lines(self):
        output, errors = io.StringIO(), io.StringIO()
        proxy = mw_refusals.RefusalOutput(output, errors)
        lines = ['invalid\n', '[]\n', '{"schema":"other","rc":6}\n',
                 json.dumps(dict(schema='metaviewer.mw_run/v1', rc=0, verdict_code='VERIFIED')) + '\n',
                 'x' * 70000 + '\n']
        for line in lines:
            proxy.write(line)
        self.assertEqual(errors.getvalue(), '')
        self.assertEqual(output.getvalue(), ''.join(lines))
        code = 'EXTERNAL\nINJECTED'
        wire = json.dumps(dict(schema='metaviewer.mw_run/v1', rc=6, verdict_code=code)) + '\n'
        proxy.write(wire)
        self.assertEqual(len(errors.getvalue().splitlines()), 1)
        self.assertIn('unrecognized code', errors.getvalue())
        self.assertEqual(output.getvalue(), ''.join(lines) + wire)
        self.assertEqual(mw_refusals.refusal_sentence('MW_GATE_SCHEMA'), mw_refusals.REFUSALS['MW_GATE_'])

    def test_existing_diagnostic_and_stream_restored_on_exception(self):
        def runner(args):
            print('existing detail', file=sys.stderr)
            raise ValueError('fixture')
        original = sys.stdout
        errors = io.StringIO()
        with redirect_stderr(errors), self.assertRaisesRegex(ValueError, 'fixture'):
            mw_run.main(['--identity', 'fixture', '--site', 'fixture', '--workflow', 'read'], runner=runner)
        self.assertIs(sys.stdout, original)
        self.assertEqual(errors.getvalue(), 'existing detail\n')


if __name__ == '__main__':
    unittest.main()
