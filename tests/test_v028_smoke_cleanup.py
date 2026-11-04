"""Focused offline smoke ownership and stop regressions."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent / 'judge'))
from judge_sandbox import Sandbox


class SmokeStop(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.sb = Sandbox(tmp.name)
        self.addCleanup(self.sb.cleanup)

    def test_unverified_smoke_process_record_prevents_clean_stop(self):
        records = self.sb.jh / 'run' / 'smoke-processes'
        records.mkdir(parents=True)
        (records / 'record.pid').write_text('unverified identity\n')
        result = self.sb.judge('stop')
        self.assertEqual(result.rc, 2, result.text)
        self.assertIn('JUDGE_STOP_LEAK', result.codes)
        self.assertNotIn('JUDGE_STOP_CLEAN', result.text)
        self.assertTrue((records / 'record.pid').exists())

    def test_smoke_private_runtime_prevents_clean_stop(self):
        runtime = self.sb.jh / 'run' / 'smoke-tmp' / 'mv-pkg-leftover'
        runtime.mkdir(parents=True)
        result = self.sb.judge('stop')
        self.assertEqual(result.rc, 2, result.text)
        self.assertNotIn('JUDGE_STOP_CLEAN', result.text)
        self.assertTrue(runtime.exists())
