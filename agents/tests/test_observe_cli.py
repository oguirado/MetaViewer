"""CLI observe remains unavailable; no transport or partial output is permitted."""
import os
from pathlib import Path
import subprocess
import sys
import unittest

class ObserveCLI(unittest.TestCase):
    def test_closed_refusal_with_or_without_arguments(self):
        root = Path(__file__).resolve().parents[1]
        for args in ([], ["extra"], ["--json", "-"], ["--help"]):
            with self.subTest(args=args):
                result = subprocess.run([sys.executable, "-m", "metaviewer_agents.mvctl", "observe", *args],
                    env=dict(os.environ, PYTHONPATH=str(root)), capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertIn("unsupported_operation", result.stderr)
