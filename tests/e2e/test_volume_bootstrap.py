import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('volume', ROOT / 'scripts/volume_e2e.py')
volume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(volume)


class VolumeBootstrap(unittest.TestCase):
    def test_prerequisites_use_file_mode_not_executable_bit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = root / 'tests/e2e/run.py'
            runner.parent.mkdir(parents=True)
            runner.write_text('')
            runner.chmod(0o644)
            self.assertEqual(volume.prerequisites(root, {'MV_KIT_CHECKOUT': directory}), directory)
            with self.assertRaisesRegex(RuntimeError, 'E2E_PREREQ'):
                volume.prerequisites(root, {})
            runner.unlink()
            with self.assertRaisesRegex(RuntimeError, 'BLOCKED'):
                volume.prerequisites(root, {'MV_KIT_CHECKOUT': directory})

    def test_main_exit_matrix_is_closed(self):
        for error, rc in [('BLOCKED: run.py absent', 2), ('E2E_PREREQ: kit absent', 1)]:
            with patch.object(volume, 'prepare', side_effect=RuntimeError(error)):
                self.assertEqual(volume.main(['--prepare-only']), rc)

    def test_bootstrap_has_offline_npm_kit_and_electron_version_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = root / 'tests/e2e/run.py'
            runner.parent.mkdir(parents=True)
            runner.write_text('')
            package = root / 'ui/node_modules/electron'
            (package / 'dist').mkdir(parents=True)
            (package / 'package.json').write_text('{"version":"44.9.2"}')
            binary = package / 'dist/electron'
            binary.write_text('')
            binary.chmod(0o755)
            calls = []
            def run(command, **kwargs):
                calls.append(command)
                return SimpleNamespace(stdout='v24.0.0\n' if command == ['node', '--version'] else 'v44.9.2\n')
            volume.prepare(root, {'MV_KIT_CHECKOUT': directory}, run=run)
            self.assertEqual(calls[0], ['node', 'tools/sync_kit.mjs', directory])
            self.assertEqual(calls[1], ['node', '--version'])
            self.assertEqual(calls[2], ['npm', 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'])
            self.assertEqual(calls[3], ['xvfb-run', '-a', str(binary), '--version'])
            def wrong_version(command, **kwargs):
                return SimpleNamespace(stdout='v24.0.0\n' if command == ['node', '--version'] else 'v0.0.0\n')
            with self.assertRaisesRegex(RuntimeError, 'version mismatch'):
                volume.prepare(root, {'MV_KIT_CHECKOUT': directory}, run=wrong_version)

    def test_workflow_guard_rejects_mode_and_missing_bootstrap_mutants(self):
        job = ('  volume-e2e:\n    [ ! -f "$HARNESS" ]\n'
               '    setup-node@PIN\n    kit-checkout\n    npm ci --offline\n'
               '    node .github/workflows/install_electron.cjs\n')
        volume.check_workflow(job)
        for token in ('-f', 'setup-node@', 'kit-checkout', 'npm ci', 'install_electron.cjs'):
            with self.subTest(token=token), self.assertRaisesRegex(RuntimeError, 'E2E_PREREQ'):
                volume.check_workflow(job.replace(token, 'mutated'))
