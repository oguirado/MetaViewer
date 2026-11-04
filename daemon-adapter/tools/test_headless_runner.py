"""Pure synthetic resource/file guards; never starts a service or guest."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import os
import signal
import unittest

spec = importlib.util.spec_from_file_location('runner', Path(__file__).with_name('headless_runner.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class Guards(unittest.TestCase):
    def test_fifo_refuses_without_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fifo'
            os.mkfifo(path, 0o600)
            def timeout(*_):
                raise TimeoutError('FIFO open blocked')
            old = signal.signal(signal.SIGALRM, timeout)
            signal.setitimer(signal.ITIMER_REAL, 0.5)
            try:
                with self.assertRaises(ValueError):
                    runner.checked(path, '0' * 64)
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, old)

    def test_caps_and_each_negative(self):
        expected = {'memory.max': '536870912', 'memory.swap.max': '0', 'pids.max': '64', 'cpu.max': '100000 100000'}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, value in expected.items():
                (root / name).write_text(value)
            runner.verify_caps(root)
            for name, wrong in [('memory.max', 'max'), ('memory.swap.max', '1'), ('pids.max', '65'), ('cpu.max', '200000 100000'), ('cpu.max', '0 100000')]:
                (root / name).write_text(wrong)
                with self.assertRaises(ValueError):
                    runner.verify_caps(root)
                (root / name).write_text(expected[name])

    def test_source_paths(self):
        self.assertEqual(str(runner.relative_source('mc06-controller/controller.py')), 'mc06-controller/controller.py')
        for value in ('/tmp/code.py', '../code.py', 'a/../code.py', 'a//code.py', 'cache.pyc'):
            with self.assertRaises(ValueError):
                runner.relative_source(value)

    def test_pin_mutation_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.py'
            source.write_bytes(b'pass\n')
            source.chmod(0o600)
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            self.assertEqual(runner.checked(source, digest), b'pass\n')
            source.write_bytes(b'fail\n')
            with self.assertRaises(ValueError):
                runner.checked(source, digest)
            alias = source.with_name('alias.py')
            alias.symlink_to(source)
            with self.assertRaises(ValueError):
                runner.checked(alias, digest)


if __name__ == '__main__':
    unittest.main()
