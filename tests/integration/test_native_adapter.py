"""Run fake CLI output through the committed Go adapter, without capsules.

[TARGET, unit decision] Go overlay keeps the native fixture in tests/**;
no generated source or executable is written into the adapter surface.
"""
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

# The Go toolchain from PATH (hosted runners), else the host install.
GO = shutil.which("go") or "/usr/local/go/bin/go"

ROOT = Path(__file__).resolve().parents[2]


class NativeAdapterTests(unittest.TestCase):
    def test_fake_cli_and_mutants_through_committed_adapter(self):
        module = ROOT / "daemon-adapter"
        with tempfile.TemporaryDirectory(prefix="mv-native-adapter-") as scratch:
            overlay = Path(scratch) / "overlay.json"
            overlay.write_text(json.dumps({"Replace": {
                str(module / "internal/cli/w1_contract_test.go"):
                str(Path(__file__).with_name("adapter_contract_test.go"))}}))
            env = dict(os.environ, GOPROXY="off", GOSUMDB="off", GOTOOLCHAIN="local",
                       MV_W1_FAKE_CLI=str(Path(__file__).with_name("fake_capsule.py")),
                       MV_W1_PYTHON=sys.executable)
            proc = subprocess.run([GO, "test", "-count=1",
                                   "-overlay", str(overlay), "-run", "^TestW1FakeCLIContract$",
                                   "-v", "./internal/cli"], cwd=module, env=env,
                                  capture_output=True, text=True, timeout=60)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertIn("--- PASS: TestW1FakeCLIContract", proc.stdout)
