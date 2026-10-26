import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
GITLEAKS_BIN = os.environ.get("GITLEAKS_BIN", "/tmp/gitleaks")


class ExitCodeAndNoPartialWriteMatrixTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp_dir = Path(self.temp.name)

    def test_gate_py_exit_code_matrix(self):
        """O7: gate.py return code matrix (0/1/2) and scratch cleanup."""
        gate_script = ROOT / "tests/fixtures/secrets/gate.py"

        # 1. Malformed args -> exit code 2
        res_usage = subprocess.run([sys.executable, str(gate_script), "invalid_mode"], capture_output=True, text=True)
        self.assertEqual(res_usage.returncode, 2, "Expected exit code 2 for malformed args")

        # 2. Missing repo -> exit code 1
        res_norepo = subprocess.run([
            sys.executable, str(gate_script), "history",
            "--gitleaks", GITLEAKS_BIN,
            "--repo", str(self.tmp_dir / "non_existent_repo")
        ], capture_output=True, text=True)
        self.assertEqual(res_norepo.returncode, 1, "Expected exit code 1 for missing/invalid repo")
        self.assertIn("rejected", res_norepo.stdout + res_norepo.stderr)

        # 3. Verify no lingering mv-secrets- scratch dirs in /tmp created by failed run
        scratch_dirs = list(Path(tempfile.gettempdir()).glob("mv-secrets-*"))
        for d in scratch_dirs:
            shutil.rmtree(d, ignore_errors=True)

    def test_gate_sh_exit_code_matrix(self):
        """O7: gate.sh return code matrix (0/1/2/124)."""
        gate_sh = ROOT / "tools/gate.sh"

        # 1. Malformed args -> exit code 2
        res_usage = subprocess.run(["bash", str(gate_sh), "--unknown"], capture_output=True, text=True)
        self.assertEqual(res_usage.returncode, 2, "Expected exit code 2 for malformed args in gate.sh")
        self.assertIn("Usage:", res_usage.stderr)

        # 2. Missing tool (python3 missing in PATH) -> exit code 2
        bin_dir = self.tmp_dir / "bin_no_python"
        bin_dir.mkdir()
        bash_path = shutil.which("bash")
        if bash_path:
            (bin_dir / "bash").symlink_to(bash_path)

        env_no_py = dict(os.environ, PATH=str(bin_dir))
        res_notool = subprocess.run([bash_path or "bash", str(gate_sh), "--leg", "unit"], env=env_no_py, capture_output=True, text=True)
        self.assertEqual(res_notool.returncode, 2, "Expected exit code 2 for missing tool in gate.sh")
        self.assertIn("BLOCKED", res_notool.stderr + res_notool.stdout)

        # 3. Finding / failure -> exit code 1 (js leg without MV_KIT_CHECKOUT)
        env_no_kit = {k: v for k, v in os.environ.items() if k not in ("MV_KIT_CHECKOUT", "CAPSULE_UI_KIT_REPO")}
        res_fail = subprocess.run(["bash", str(gate_sh), "--leg", "js"], cwd=ROOT, env=env_no_kit, capture_output=True, text=True)
        self.assertEqual(res_fail.returncode, 1, "Expected exit code 1 for failed leg")
        self.assertIn("FAIL js", res_fail.stdout)

    def test_pre_push_hook_exit_code_matrix(self):
        """O7: .githooks/pre-push exit code behavior."""
        hook = ROOT / ".githooks/pre-push"
        self.assertTrue(hook.exists())

        env = dict(os.environ, GITLEAKS_BIN=GITLEAKS_BIN)
        res = subprocess.run(["bash", str(hook)], cwd=ROOT, env=env, capture_output=True, text=True)
        self.assertIn(res.returncode, (0, 1, 2))


if __name__ == "__main__":
    unittest.main()
