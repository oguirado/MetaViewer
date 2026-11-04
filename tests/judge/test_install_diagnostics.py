"""Installer diagnostics distinguish unavailable privileges and capsule tooling."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from judge_sandbox import Sandbox


class InstallDiagnosticsTests(unittest.TestCase):
    def test_failed_docker_info_points_to_the_app_only_route(self):
        with tempfile.TemporaryDirectory() as tmp:
            sb = Sandbox(tmp)
            self.addCleanup(sb.cleanup)
            sb.make_t2_ready()
            sb.put('docker_info_rc', '1\n')
            result = sb.preflight('--tier', 'T2', '--phase', 'static')
            self.assertEqual(result.rc, 2, result.text)
            self.assertIn('JUDGE_DOCKER', result.codes)
            self.assertIn('without Docker, omit --capsules (docs/JUDGE_NO_DOCKER.md)', result.err)
            sb.put('docker_info_rc', '0\n')
            result = sb.preflight('--tier', 'T2', '--phase', 'static')
            self.assertEqual(result.rc, 0, result.text)

    def test_failed_sudo_is_not_reported_as_proven_apt_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            sb = Sandbox(tmp)
            self.addCleanup(sb.cleanup)
            sb.full_kit()
            sb.drop_tool('zip')
            sb.put('sudo_rc', '1\n')
            result = sb.judge('install', '--yes')
            self.assertEqual(result.rc, 2, result.text)
            self.assertIn('JUDGE_SUDO', result.codes)
            self.assertIn('sudo authorization or apt-get may have failed', result.err)
            self.assertIn('ask an administrator', result.err)
            self.assertNotIn('JUDGE_SYSDEP: apt-get failed', result.err)
            self.assertEqual(sb.log('apt.log'), '')
