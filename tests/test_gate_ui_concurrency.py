"""Pure argv controls: no install, build, process or UI launch."""
import inspect
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def namespace(transform=lambda source: source):
    source = (ROOT / 'tools/gate.sh').read_text().split("<<'PY'\n", 1)[1]
    source = transform(source.rsplit('\nsys.exit(main())', 1)[0])
    result = {'__name__': 'gate_ui_concurrency_test'}
    with patch.object(sys, 'argv', ['gate.sh', str(ROOT), 'self-test']):
        exec(compile(source, str(ROOT / 'tools/gate.sh'), 'exec'), result)
    return result


class GateUiConcurrencyTests(unittest.TestCase):
    def assert_ui_plan(self, transform=lambda source: source):
        api = namespace(transform)
        self.assertEqual(inspect.signature(api['bounded']).parameters['seconds'].default, 300)
        calls = []
        def bounded(argv, cwd, environment, seconds=300):
            calls.append((argv, cwd, environment, seconds))
            return 0
        api['bounded'] = bounded
        api['electron_dist'] = lambda *args: None
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            testdir = root / 'ui/test'
            testdir.mkdir(parents=True)
            for name in ('b.test.js', 'a.test.js', 'not-a-test.txt'):
                (testdir / name).write_text('// synthetic argv fixture\n')
            env = {'PATH': '/synthetic', 'TMPDIR': temporary}
            with patch.object(api['shutil'], 'which', side_effect=lambda name, **kwargs: '/synthetic/' + Path(name).name), patch.object(api['subprocess'], 'run', return_value=subprocess.CompletedProcess([], 0, '24\n', '')):
                self.assertEqual(api['build_leg']('ui', root, env), 0)
            self.assertEqual(calls[0][0], ['/synthetic/npm', 'ci', '--offline'])
            self.assertEqual(calls[1][0], ['/synthetic/node', '--test', '--test-concurrency=2', '--test-timeout=120000', 'test/a.test.js', 'test/b.test.js'])
            self.assertEqual([call[3] for call in calls], [300, 300, 300, 300])
            self.assertEqual([call[0][-1] for call in calls[2:]], ['--noEmit', 'build'])
            self.assertTrue(all(call[2]['npm_config_offline'] == 'true' for call in calls))
            self.assertTrue(all(call[2]['ELECTRON_SKIP_BINARY_DOWNLOAD'] == '1' for call in calls))

    def test_explicit_two_preserves_all_files_and_limits(self):
        self.assert_ui_plan()

    def test_original_implicit_concurrency_is_detected(self):
        with self.assertRaises(AssertionError):
            self.assert_ui_plan(lambda s: s.replace("'--test-concurrency=2', ", '', 1))

    def test_omitted_test_file_is_detected(self):
        with self.assertRaises(AssertionError):
            self.assert_ui_plan(lambda s: s.replace('for p in tests]]]', 'for p in tests[:-1]]]]', 1))

    def test_relaxed_per_test_timeout_is_detected(self):
        with self.assertRaises(AssertionError):
            self.assert_ui_plan(lambda s: s.replace("'--test-timeout=120000'", "'--test-timeout=120001'"))

    def test_relaxed_command_timeout_is_detected(self):
        with self.assertRaises(AssertionError):
            self.assert_ui_plan(lambda s: s.replace('def bounded(argv, cwd, environment, seconds=300):', 'def bounded(argv, cwd, environment, seconds=301):'))


if __name__ == '__main__':
    unittest.main()
