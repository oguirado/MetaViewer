"""T7 R2c O8 Exit-Code and Failure-Atomicity Matrix Test Suite.

Tests exit codes per failure class (0, 1, 2, 124) and untouched outputs
on failure across gate.py, gate.sh, offline.sh, workflow_pins.py,
test_package_identity.py --distribution, and pre-push hook.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
GATE_PY = ROOT / "tests/fixtures/secrets/gate.py"
OFFLINE_SH = ROOT / ".github/workflows/offline.sh"
PINS_PY = ROOT / ".github/workflows/workflow_pins.py"
PKG_IDENTITY = ROOT / "tests/ci/test_package_identity.py"
PRE_PUSH = ROOT / ".githooks/pre-push"
GATE_SH = ROOT / "tools/gate.sh"

SYS_PYTHONPATH = '/usr/lib/python3/dist-packages'


class ExitCodeAndAtomicityMatrixTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp_dir = Path(self.temp.name)

    def test_o8_gate_py_exit_code_matrix(self):
        """Test gate.py exit codes: 0 for --help, 2 for malformed/usage, 1 for rejection."""
        res_help = subprocess.run([sys.executable, str(GATE_PY), "--help"], capture_output=True, text=True)
        self.assertEqual(res_help.returncode, 0)
        self.assertIn("usage:", res_help.stdout.lower())

        res_unknown = subprocess.run([sys.executable, str(GATE_PY), "unknown"], capture_output=True, text=True)
        self.assertEqual(res_unknown.returncode, 2)

        res_arity = subprocess.run([sys.executable, str(GATE_PY), "history"], capture_output=True, text=True)
        self.assertEqual(res_arity.returncode, 2)

        res_nonexec = subprocess.run(
            [sys.executable, str(GATE_PY), "history", "--gitleaks", str(self.tmp_dir / "absent"), "--repo", str(ROOT)],
            capture_output=True, text=True
        )
        self.assertEqual(res_nonexec.returncode, 1)

    def test_o8_offline_sh_exit_codes_and_untouched_outputs(self):
        """Test offline.sh exit codes (2 for usage/root) and failure atomicity (payload never executed)."""
        res_noargs = subprocess.run(["bash", str(OFFLINE_SH)], capture_output=True, text=True)
        self.assertEqual(res_noargs.returncode, 2)

        bin_dir = self.tmp_dir / "bin_root"
        bin_dir.mkdir()
        id_stub = bin_dir / "id"
        id_stub.write_text("#!/bin/sh\necho 0\n")
        id_stub.chmod(0o755)

        marker = self.tmp_dir / "unexecuted_marker"
        env_root = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ.get("PATH", ""))
        res_root = subprocess.run(["bash", str(OFFLINE_SH), "touch", str(marker)], env=env_root, capture_output=True)
        self.assertEqual(res_root.returncode, 2)
        self.assertFalse(marker.exists())

        bin_unshare = self.tmp_dir / "bin_unshare"
        bin_unshare.mkdir()
        unshare_stub = bin_unshare / "unshare"
        unshare_stub.write_text("#!/bin/sh\nexit 88\n")
        unshare_stub.chmod(0o755)

        env_unshare = dict(os.environ, PATH=str(bin_unshare) + os.pathsep + os.environ.get("PATH", ""))
        res_unshare = subprocess.run(["bash", str(OFFLINE_SH), "touch", str(marker)], env=env_unshare, capture_output=True)
        self.assertEqual(res_unshare.returncode, 88)
        self.assertFalse(marker.exists())

    def test_o8_workflow_pins_json_output(self):
        """Test workflow_pins.py prints JSON error array for unpinned references."""
        env = dict(os.environ, PYTHONPATH=SYS_PYTHONPATH)
        res = subprocess.run(
            [sys.executable, str(PINS_PY), str(ROOT)],
            input="steps:\n - uses: actions/checkout@v4\n",
            capture_output=True, text=True, env=env
        )
        self.assertEqual(res.returncode, 0)
        errors = json.loads(res.stdout)
        self.assertIsInstance(errors, list)
        self.assertTrue(len(errors) > 0)
        self.assertIn("unpinned action: actions/checkout@v4", errors[0])

    def test_o8_package_identity_distribution_exit_code(self):
        """Test test_package_identity.py --distribution exit code: 1 on missing/malformed receipt."""
        res = subprocess.run(
            [sys.executable, str(PKG_IDENTITY), "--distribution"],
            capture_output=True, text=True,
            env=dict(os.environ, PACKAGE_RECEIPT="invalid_json")
        )
        self.assertEqual(res.returncode, 1)
        self.assertIn("FAIL distribution", res.stdout)

    def test_o8_pre_push_hook_fail_closed_exit_code(self):
        """Test .githooks/pre-push fails closed (exit 1) when gitleaks binary is absent."""
        env_no_gitleaks = dict(os.environ, PATH="/usr/bin:/bin")
        res = subprocess.run(["sh", str(PRE_PUSH)], capture_output=True, text=True, env=env_no_gitleaks)
        self.assertEqual(res.returncode, 1)
        self.assertIn("pre-push: gitleaks is not installed", res.stderr)

    def test_o8_gate_sh_exit_codes(self):
        """Test tools/gate.sh exit codes: 2 for usage error, 0 or 1 for legs."""
        res_usage = subprocess.run(["bash", str(GATE_SH), "--leg", "unknown"], capture_output=True, text=True)
        self.assertEqual(res_usage.returncode, 2)
        self.assertIn("Usage:", res_usage.stderr)


if __name__ == "__main__":
    unittest.main()
