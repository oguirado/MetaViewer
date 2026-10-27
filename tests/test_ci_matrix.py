"""Execute receipt controls and enforce the hosted runner policy."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / '.github/workflows'


def script(name):
    source = (WORKFLOWS / name).read_text()
    return textwrap.dedent(source.split('      - name: Execute gate and publish receipt\n')[1].split('        run: |\n', 1)[1])


class MatrixTests(unittest.TestCase):
    def test_runner_policy(self):
        package = (WORKFLOWS / 'package.yml').read_text()
        other = (WORKFLOWS / 'build-other.yml').read_text()
        self.assertIn('push:', package)
        self.assertIn('pull_request:', package)
        for runner in ('ubuntu-24.04', 'ubuntu-24.04-arm'):
            self.assertIn('runner: ' + runner + '\n', package)
        self.assertNotIn('continue-on-error:', package)
        self.assertIn('fail-fast: false', package)
        self.assertIn('continue-on-error: true', other)
        self.assertIn("if: github.event_name == 'workflow_dispatch'", other)
        self.assertNotIn('  push:', other)
        for runner in ('macos-latest', 'windows-latest'):
            self.assertIn('runner: ' + runner + '\n', other)

    def test_shell_syntax_and_sanitizer_parity(self):
        canonical = re.search(r'          sanitize\(\) \{.*?\n          \}',
                              (WORKFLOWS / 'ci.yml').read_text(), re.S)[0]
        for name in ('package.yml', 'build-other.yml'):
            source = (WORKFLOWS / name).read_text()
            self.assertIn(canonical, source)
            for block in re.findall(r'        run: \|\n((?:          .*\n|\n)+)', source):
                result = subprocess.run(['bash', '-n'], input=textwrap.dedent(block),
                                        text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)

    def run_control(self, name, platform, setup, expected, outcome, failing_build=False):
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            summary = temp / 'summary'
            env = dict(os.environ, RUNNER_TEMP=tmp, GITHUB_STEP_SUMMARY=str(summary),
                       GITHUB_SHA='fixture', GITHUB_RUN_ID='fixture', PLATFORM=platform,
                       JOB_ID='fixture', SETUP_RESULT=setup, MV_PKG_OUT='')
            if failing_build:
                for tool, body in {
                    'node': 'exit 0',
                    'npm': 'case "$*" in *test) printf "# pass 1\\n# fail 1\\n# skipped 0\\nFAIL synthetic build\\n"; exit 7;; esac\nexit 0',
                }.items():
                    target = temp / tool
                    target.write_text('#!/bin/sh\n' + body + '\n')
                    target.chmod(0o700)
                env['PATH'] = str(temp) + os.pathsep + env['PATH']
            result = subprocess.run(['bash', '-c', script(name)], cwd=ROOT,
                                    env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
            receipt = json.loads(next(temp.rglob('*.receipt.json')).read_text())
            self.assertEqual(receipt['outcome'], outcome)
            self.assertEqual(receipt['schema'], 'gate_receipt/v1')
            self.assertIn('passed', summary.read_text())
            self.assertIn('failed', summary.read_text())
            return receipt

    def test_failed_setup_is_failure_on_both_workflows(self):
        for name in ('package.yml', 'build-other.yml'):
            receipt = self.run_control(name, 'arm64', 'failure', 1, 'FAIL')
            self.assertNotEqual(receipt['rc'], 0)
            self.assertIsNone(receipt['counts']['passed'])

    def test_missing_output_fails_actual_package_command(self):
        for arch in ('arm64', 'x64'):
            with self.subTest(arch=arch):
                self.run_control('package.yml', arch, 'success', 1, 'FAIL')

    def test_supported_arches_execute_package_gate(self):
        raw_script = script('package.yml')
        shim = (
            'offline_shim() {\n'
            '  if [ "${1:-}" = node ] && [ "${3:-}" = --smoke ]; then\n'
            '    printf \'{"marker":"METAVIEWER_MAIN_SMOKE_OK"}\\n\'\n'
            '  fi\n'
            '  return 0\n'
            '}\n'
        )
        shimmed = shim + raw_script.replace('bash .github/workflows/offline.sh', 'offline_shim')
        for arch in ('arm64', 'x64'):
            with self.subTest(arch=arch), tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                summary = temp / 'summary'
                env = dict(os.environ, RUNNER_TEMP=tmp, GITHUB_STEP_SUMMARY=str(summary),
                           GITHUB_SHA='fixture', GITHUB_RUN_ID='fixture', PLATFORM=arch,
                           JOB_ID='linux-package', SETUP_RESULT='success',
                           MV_PKG_OUT=str(temp / 'pkg-out'),
                           CARGO_TARGET_DIR=str(temp / 'cargo-target'))
                result = subprocess.run(['bash', '-c', shimmed], cwd=ROOT,
                                        env=env, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                receipt = json.loads(next(temp.rglob('*.receipt.json')).read_text())
                self.assertEqual(receipt['outcome'], 'PASS')
                self.assertEqual(receipt['rc'], 0)
                self.assertEqual(receipt['scope']['platform'], arch)

    def test_unsupported_arch_never_passes(self):
        for arch in ('riscv64', 's390x'):
            with self.subTest(arch=arch):
                receipt = self.run_control('package.yml', arch, 'success', 1, 'BLOCKED')
                self.assertEqual(receipt['counts']['source'], 'unexecuted')
                self.assertIsNone(receipt['rc'])

    def test_other_build_failure_publishes_measured_counts(self):
        receipt = self.run_control('build-other.yml', 'darwin', 'success', 7, 'FAIL',
                                   failing_build=True)
        self.assertEqual(receipt['counts']['passed'], 1)
        self.assertEqual(receipt['counts']['failed'], 1)
