"""Exercise CI binary admission without downloading or launching Electron."""
from pathlib import Path
import shutil
import subprocess
import unittest


class CIElectronTests(unittest.TestCase):
    def test_installer_and_negative_controls(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "CI installer tests require Node")
        root = Path(__file__).resolve().parents[1]
        proc = subprocess.run([node, "--test", "tests/ci/install_electron.test.cjs"],
                              cwd=root, capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
