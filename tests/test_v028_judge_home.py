"""Judge home whitespace must be refused before installation side effects."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent / 'judge'))
from judge_sandbox import Sandbox


class JudgeHome(unittest.TestCase):
    def test_whitespace_is_refused_before_host_checks_or_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            sb = Sandbox(tmp)
            self.addCleanup(sb.cleanup)
            for whitespace in (' ', '\t', '\n', '\r', '\v', '\f'):
                with self.subTest(whitespace=repr(whitespace)):
                    home = sb.home / ('install' + whitespace + 'dir')
                    result = sb.judge('install', env={'MV_JUDGE_HOME': str(home)})
                    self.assertEqual(result.rc, 2, result.text)
                    self.assertIn('JUDGE_USAGE', result.codes)
                    self.assertIn('whitespace', result.err)
                    self.assertFalse(home.exists())
                    self.assertEqual(sb.log('sudo.log'), '')
                    self.assertEqual(sb.log('node.log'), '')

    def test_non_ascii_without_whitespace_is_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            sb = Sandbox(tmp)
            self.addCleanup(sb.cleanup)
            home = sb.home / 'instalación'
            result = sb.judge('doctor', '--before-install', env={'MV_JUDGE_HOME': str(home)})
            self.assertEqual(result.rc, 0, result.text)
            self.assertFalse(home.exists())
