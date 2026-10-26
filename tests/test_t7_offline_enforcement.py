import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class OfflineEnforcementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp_dir = Path(self.temp.name)

    def test_gate_sh_scrubbed_env_offline_success(self):
        """O4(a): Run gate.sh in scrubbed environment (env -i) with local inputs."""
        scrubbed_env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self.tmp_dir),
            "TMPDIR": str(self.tmp_dir),
            "PYTHONDONTWRITEBYTECODE": "1",
            "HTTP_PROXY": "http://127.0.0.1:1",
            "HTTPS_PROXY": "http://127.0.0.1:1",
        }

        # Try unshare -n if available
        cmd = ["bash", str(ROOT / "tools/gate.sh"), "--leg", "manifests"]
        if shutil.which("unshare"):
            proc_check = subprocess.run(["unshare", "-n", "true"], capture_output=True)
            if proc_check.returncode == 0:
                cmd = ["unshare", "-n"] + cmd

        res = subprocess.run(
            cmd,
            cwd=ROOT,
            env=scrubbed_env,
            capture_output=True,
            text=True,
            timeout=30
        )
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertIn("PASS manifests", res.stdout)

    def test_bootstrap_missing_required_variables_fail_closed(self):
        """O4: Assert bootstrap.sh fail-closed refusal on missing required env vars."""
        bootstrap_script = ROOT / "scripts/bootstrap.sh"
        self.assertTrue(bootstrap_script.exists())

        pkg_out = self.tmp_dir / "out"
        pkg_out.mkdir()
        kit_repo = self.tmp_dir / "kit"
        kit_repo.mkdir()
        zip_dir = self.tmp_dir / "zip"
        zip_dir.mkdir()

        base_env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self.tmp_dir),
        }

        # 1. Missing MV_PKG_OUT
        env_missing_pkg = dict(base_env, CAPSULE_UI_KIT_REPO=str(kit_repo), MV_ELECTRON_ZIP_DIR=str(zip_dir))
        res1 = subprocess.run(["bash", str(bootstrap_script)], cwd=ROOT, env=env_missing_pkg, capture_output=True, text=True)
        self.assertNotEqual(res1.returncode, 0)
        self.assertIn("MV_PKG_OUT", res1.stderr)

        # 2. Missing CAPSULE_UI_KIT_REPO
        env_missing_kit = dict(base_env, MV_PKG_OUT=str(pkg_out), MV_ELECTRON_ZIP_DIR=str(zip_dir))
        res2 = subprocess.run(["bash", str(bootstrap_script)], cwd=ROOT, env=env_missing_kit, capture_output=True, text=True)
        self.assertNotEqual(res2.returncode, 0)
        self.assertIn("CAPSULE_UI_KIT_REPO", res2.stderr)

        # 3. Missing both MV_ELECTRON_ZIP_DIR and ELECTRON_OVERRIDE_DIST_PATH
        env_missing_electron = dict(base_env, MV_PKG_OUT=str(pkg_out), CAPSULE_UI_KIT_REPO=str(kit_repo))
        res3 = subprocess.run(["bash", str(bootstrap_script)], cwd=ROOT, env=env_missing_electron, capture_output=True, text=True)
        self.assertNotEqual(res3.returncode, 0)
        self.assertIn("MV_ELECTRON_ZIP_DIR", res3.stderr)


if __name__ == "__main__":
    unittest.main()
