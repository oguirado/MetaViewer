"""[TARGET, unit decision] Execute FX2-PACKAGE regression suite under tests/ci unit leg."""
import os
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]


class Fx2PackageRegressionTests(unittest.TestCase):
    def test_package_clean_install_and_round2_regressions(self):
        node = os.environ.get('NODE') or shutil.which('node') or 'node'
        result = subprocess.run(
            [node, '--test', str(ROOT / 'ui/tools/test_package_clean_install.mjs')],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            0,
            msg=f"ui/tools/test_package_clean_install.mjs failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}",
        )


if __name__ == '__main__':
    unittest.main()
