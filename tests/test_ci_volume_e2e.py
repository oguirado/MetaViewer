"""Regression gates for R1-119, scoped to the volume E2E job."""
from pathlib import Path
import importlib.util
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("volume_e2e", ROOT / "scripts/volume_e2e.py")
volume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(volume)


class VolumeE2EWorkflow(unittest.TestCase):
    def test_real_workflow_bootstrap_and_file_prerequisite(self):
        volume.check_workflow((ROOT / ".github/workflows/volume.yml").read_text())

    def test_qualification_rung_follows_smoke_and_keeps_architectures(self):
        text = (ROOT / ".github/workflows/volume.yml").read_text().split("  volume-e2e:\n", 1)[1]
        self.assertIn("seq 1 20", text)
        self.assertIn("seq 1 300", text)
        self.assertLess(text.index("seq 1 20"), text.index("seq 1 300"))
        self.assertIn("platform: x64", text)
        self.assertIn("platform: arm64", text)
        self.assertIn("cargo fetch --locked", text)
        self.assertIn("Install Go", text)
