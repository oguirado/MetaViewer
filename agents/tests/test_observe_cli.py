"""Observe rejects incomplete/unknown arguments without partial output."""
import os
from pathlib import Path
import subprocess
import sys
import unittest

class ObserveCLI(unittest.TestCase):
    def test_closed_refusal_with_or_without_arguments(self):
        root = Path(__file__).resolve().parents[1]
        for args in ([], ["extra"], ["--json", "-"], ["--surface-id", "surf-1"]):
            with self.subTest(args=args):
                result = subprocess.run([sys.executable, "-m", "metaviewer_agents.mvctl", "observe", *args],
                    env=dict(os.environ, PYTHONPATH=str(root)), capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertEqual(result.stderr,
                    '{"verdict":"refuse","code":"usage_error",'
                    '"error":"invalid command line"}\n')
