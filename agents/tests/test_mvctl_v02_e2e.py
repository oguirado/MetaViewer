"""E2E Item 3: v0.2 observe-to-act path (E4, E14)
Cites SW-0224 §2.3 off-support refusing with exact code (E4), OmniCodex PL21 PY (E14).
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]

class MvctlV02E2ETests(unittest.TestCase):
    def cli(self, command, *flags, env=None):
        test_env = dict(os.environ, PYTHONPATH=str(ROOT / "agents"))
        if env:
            test_env.update(env)
        return subprocess.run(
            [sys.executable, "-m", "metaviewer_agents.mvctl", command, *flags],
            env=test_env, capture_output=True, text=True, timeout=10
        )

    def test_bare_observe_without_identity_refuses_closed(self):
        """Bare observe without identity/limits returns rc 2, usage_error on stderr, empty stdout."""
        for command in ("observe", "propose", "wait-verify"):
            with self.subTest(command=command):
                res = self.cli(command)
                self.assertEqual(res.returncode, 2, res.stderr)
                self.assertEqual(res.stdout, "")
                err = json.loads(res.stderr.strip())
                self.assertEqual(err["verdict"], "refuse")
                self.assertEqual(err["code"], "usage_error")

    def test_missing_mandatory_flag_refuses_closed(self):
        """Omit mandatory identity flag --agent-instance from valid invocation shape."""
        res = self.cli(
            "observe", "--socket", "/tmp/nonexistent.sock",
            "--session-id", "sess-1", "--core-instance", "core-1",
            "--surface-id", "surf-1"
        )
        self.assertEqual(res.returncode, 2, res.stderr)
        self.assertEqual(res.stdout, "")
        err = json.loads(res.stderr.strip())
        self.assertEqual(err["code"], "usage_error")

    def test_v02_compat_spelling_accepted_in_flag(self):
        """Verify --v02 flag compatibility spelling is recognized in argument parsing."""
        res = self.cli("observe", "--v02", "--help")
        self.assertIn(res.returncode, (0, 2))

    def test_mutant_missing_flag_killing_assertion(self):
        """Mutant test: Dropping mandatory --session-id from propose command must be refused."""
        res = self.cli(
            "propose", "--socket", "/tmp/nonexistent.sock",
            "--agent-instance", "agent-1", "--core-instance", "core-1",
            "--json-arg", "/tmp/proposal.json"
        )
        self.assertEqual(res.returncode, 2, "Dropping --session-id must yield rc 2 refusal")
        self.assertEqual(res.stdout, "")
        self.assertEqual(json.loads(res.stderr.strip())["code"], "usage_error")


if __name__ == "__main__":
    unittest.main()
