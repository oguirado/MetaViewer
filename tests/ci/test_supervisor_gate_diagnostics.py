"""[TARGET, unit decision] Compilation failure must expose Cargo diagnostics."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class SupervisorDiagnosticsTests(unittest.TestCase):
    def test_compile_failure_keeps_status_and_renders_errors_without_execution(self):
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)
            # The namespace probe alone succeeds; no compiled test may run.
            unshare = directory / 'unshare'
            unshare.write_text('#!/bin/sh\n[ "$*" = "--user --map-root-user --pid --fork --mount-proc true" ] || exit 99\n')
            unshare.chmod(0o700)
            cargo = directory / 'cargo'
            diagnostics = '\n'.join(json.dumps({
                'reason': 'compiler-message',
                'message': {'message': text, 'rendered': text + '\n'},
            }) for text in ('error[E0533]: first fixture error', 'error[E0533]: second fixture error'))
            cargo.write_text('#!/bin/sh\ncat <<\'DIAGNOSTICS\'\n' + diagnostics + '\nDIAGNOSTICS\nexit 101\n')
            cargo.chmod(0o700)
            env = dict(os.environ, CARGO=str(cargo), MV_TEST_PYTHON=sys.executable,
                       PATH=str(directory) + os.pathsep + os.environ['PATH'])
            result = subprocess.run(['bash', str(ROOT / 'tests/supervisor/run_process_gate.sh')],
                                    env=env, text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 101, result.stdout + result.stderr)
            self.assertIn('error[E0533]: first fixture error', result.stderr)
            self.assertIn('error[E0533]: second fixture error', result.stderr)
            self.assertNotIn('expected exactly one test executable', result.stderr)
