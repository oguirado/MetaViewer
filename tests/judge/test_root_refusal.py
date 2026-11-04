"""Refuse unsafe root sessions before installer work; keep normal users working."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from judge_sandbox import Sandbox


class RootRefusalTests(unittest.TestCase):
    def test_root_refuses_before_session_checks_or_administrator_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            sb = Sandbox(tmp)
            self.addCleanup(sb.cleanup)
            (sb.bin / 'id').unlink()
            sb.write_exec(sb.bin / 'id', '#!/bin/bash\nprintf "0\\n"\n')
            for tier in ('T1', 'T2'):
                result = sb.preflight('--tier', tier, '--phase', 'static')
                self.assertEqual(result.rc, 2, result.text)
                self.assertEqual(result.codes, {'JUDGE_ROOT'}, result.text)
                self.assertIn('normal user', result.err)
                self.assertIn('never --no-sandbox', result.err)
            result = sb.judge('install', '--yes')
            self.assertEqual(result.rc, 2, result.text)
            self.assertIn('JUDGE_ROOT', result.codes)
            self.assertEqual(sb.log('sudo.log'), '')
            self.assertEqual(sb.log('apt.log'), '')
            self.assertFalse((sb.jh / 'node').exists())

    def test_normal_user_static_preflight_is_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            sb = Sandbox(tmp)
            self.addCleanup(sb.cleanup)
            result = sb.preflight('--tier', 'T1', '--phase', 'static')
            self.assertEqual(result.rc, 0, result.text)
            self.assertNotIn('JUDGE_ROOT', result.codes)
