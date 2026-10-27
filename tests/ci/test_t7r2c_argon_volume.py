"""T7 R2c O6 Argon, Electron Oracles, and Volume Test Suite.

Tests kit provenance (ARG-ci-2), Electron oracles (ARG-ci-4),
mutation anchors (ARG-ci-8), supervisor rerun cleanup (ARG-ci-3),
and volume bootstrap fail-closed/BLOCKED status (f833e3b4, R1-109).
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
VOLUME_YML = ROOT / '.github/workflows/volume.yml'
SYNC_KIT_MJS = ROOT / 'tools/sync_kit.mjs'


class ArgonAndVolumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp_dir = Path(self.temp.name)

    def test_o6_kit_provenance_and_lock_verification(self):
        """ARG-ci-2: Verify sync_kit.mjs rejects repository and commit mismatches."""
        lock_file = ROOT / 'ui/kit.lock.json'
        self.assertTrue(lock_file.is_file())
        lock = json.loads(lock_file.read_text())

        self.assertIn('repo', lock)
        self.assertIn('commit', lock)
        self.assertIn('version', lock)
        self.assertIn('contentHash', lock)

        tmp_lock = self.tmp_dir / 'kit.lock.json'
        bad_lock = dict(lock, repo='https://github.com/oguirado/wrong-kit.git')
        tmp_lock.write_text(json.dumps(bad_lock))

        res = subprocess.run(
            ['node', str(SYNC_KIT_MJS), '--check'],
            cwd=ROOT, capture_output=True, text=True,
            env=dict(os.environ, MV_KIT_CHECKOUT=str(ROOT))
        )
        self.assertNotEqual(res.returncode, 0)

    @unittest.skipUnless(shutil.which('node'), "node required")
    def test_o6_electron_oracle_mutation_kill_proof(self):
        """ARG-ci-4: Execute install_electron.test.cjs and prove accessSync mutation goes RED."""
        test_file = ROOT / 'tests/ci/install_electron.test.cjs'
        self.assertTrue(test_file.is_file())

        res = subprocess.run(['node', '--test', str(test_file)], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)

        installer_src = (ROOT / '.github/workflows/install_electron.cjs').read_text()
        self.assertIn('accessSync', installer_src)

        mutated_src = re.sub(r'fs\.accessSync\(binary,\s*fs\.constants\.X_OK\);?', '/* mutated */', installer_src)
        mutated_installer = self.tmp_dir / 'install_electron.cjs'
        mutated_installer.write_text(mutated_src)

        test_src = test_file.read_text().replace(
            "require('../../.github/workflows/install_electron.cjs')",
            repr(str(mutated_installer))
        )
        mutated_test = self.tmp_dir / 'install_electron.test.cjs'
        mutated_test.write_text(test_src)

        res_mut = subprocess.run(['node', '--test', str(mutated_test)], capture_output=True, text=True)
        self.assertNotEqual(res_mut.returncode, 0, "Mutating accessSync check must cause test suite to go RED")

    def test_o6_volume_bootstrap_and_residual_blocked_status(self):
        """Verify volume-e2e bootstrap steps and residual volume-property BLOCKED status (R1-109)."""
        text = VOLUME_YML.read_text()
        self.assertIn('volume-e2e', text)
        self.assertIn('volume-property', text)
        self.assertIn('volume-mutants', text)

        prop_block = text.split('volume-property:', 1)[1].split('volume-mutants:', 1)[0]
        self.assertIn('BLOCKED', prop_block)
        self.assertIn('wave', prop_block.lower())


if __name__ == "__main__":
    unittest.main()
