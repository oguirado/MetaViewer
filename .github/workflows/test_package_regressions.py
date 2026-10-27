"""ARG-s_ci-1/8: hosted admission and executable receipt sanitizer controls.

Run: python3 .github/workflows/test_package_regressions.py
"""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

WORKFLOWS = Path(__file__).resolve().parent
ROOT = WORKFLOWS.parents[1]


def source(name='package.yml'):
    return (WORKFLOWS / name).read_text(encoding='utf-8')


def gate(text):
    return textwrap.dedent(text.split('      - name: Execute gate and publish receipt\n')[1]
                           .split('        run: |\n', 1)[1])


class PackageRegressions(unittest.TestCase):
    def assert_admission(self, text):
        job = text.split('  linux-package:\n', 1)[1]
        header = job.split('    strategy:', 1)[0]
        self.assertIn("if: github.event_name != 'pull_request' || !github.event.pull_request.head.repo.fork", header)
        steps = re.split(r'^      - ', job.split('    steps:\n', 1)[1], flags=re.M)[1:]
        self.assertTrue(steps)
        for step in steps:
            condition = re.search(r'^        if: (.*)$', step, re.M)
            self.assertIsNotNone(condition, step)
            self.assertIn("matrix.platform == 'arm64'", condition[1])
            if step.startswith('name: Execute gate'):
                self.assertEqual(condition[1], "always() && matrix.platform == 'arm64'")
            else:
                self.assertEqual(condition[1], "matrix.platform == 'arm64'")

    def test_ARG_s_ci_1_admission(self):
        self.assert_admission(source())

    def test_admission_negative_controls(self):
        text = source()
        for mutant in (text.replace("matrix.platform == 'arm64'", 'true'),
                       text.replace('!github.event.pull_request.head.repo.fork', 'true')):
            with self.assertRaises(AssertionError):
                self.assert_admission(mutant)

    def assert_local_product_handoff(self, text):
        package = text.split('  package:\n', 1)[1].split('  build-macos:\n', 1)[0]
        required = text.split('  ci-required:\n', 1)[1]
        for job in (package, required):
            self.assertIn('runs-on: ${{ matrix.runner }}', job)
            self.assertIn('matrix.platform', job)
            self.assertIn('runner: ubuntu-24.04\n            platform: x64', job)
            self.assertIn('runner: ubuntu-24.04-arm\n            platform: arm64', job)
            self.assertIn('go-version-file: daemon-adapter/go.mod', job)
            self.assertIn('cargo fetch --locked', job)
            self.assertIn('CARGO_TARGET_DIR:', job)
            self.assertIn('CAPSULE_UI_KIT_REPO:', job)
            self.assertIn('node .github/workflows/install_electron.cjs', job)
            self.assertIn('python3 tests/ci/test_package_identity.py --build', job)
            self.assertNotRegex(job, r'uses: actions/(?:upload|download)-artifact')
            self.assertLess(job.index('Prime locked dependencies'), job.index('test_package_identity.py --build'))
        for arch in ('x64', 'arm64'):
            self.assertIn(f'receipt_{arch}: ${{{{ steps.package-evidence.outputs.receipt_{arch} }}}}', package)
            self.assertIn(f'needs.package.outputs.receipt_{arch}', required)
        self.assertIn("output.write('receipt_' + e['PLATFORM'] + '='", package)
        self.assertIn('PLATFORM: ${{ matrix.platform }}', required)

        self.assertLess(required.index('test_package_identity.py --build'),
                        required.index('test_package_identity.py --distribution'))
        self.assertIn('check_distribution="${{ job.status }}"', required)
        self.assertIn('      - name: Aggregate required results\n        if: always()', required)
        self.assertIn('      - name: Build and witness package\n        if: always()', package)
        self.assertIn("'product_identity': (json.load", package)

    def test_path_2b_local_product_handoff(self):
        self.assert_local_product_handoff(source('ci.yml'))

    def test_local_handoff_negative_controls(self):
        text = source('ci.yml')
        for mutant in (text.replace('runner: ubuntu-24.04-arm', 'runner: ubuntu-24.04'),
                       text.replace('python3 tests/ci/test_package_identity.py --build', 'true'),
                       text.replace('needs.package.outputs.receipt', 'needs.package.result'),
                       text.replace('receipt_x64:', 'receipt_duplicate:'),
                       text.replace('platform: x64', 'platform: arm64'),
                       text.replace('check_distribution="${{ job.status }}"', 'check_distribution=success')):
            with self.assertRaises(AssertionError):
                self.assert_local_product_handoff(mutant)

    def sanitize(self, text, payload):
        function = textwrap.dedent(re.search(
            r'^          sanitize\(\) \{.*?^          \}', text, re.M | re.S)[0])
        with tempfile.TemporaryDirectory(prefix='workflow-sanitize-') as tmp:
            raw, sane = Path(tmp) / 'raw', Path(tmp) / 'sane'
            raw.write_bytes(payload)
            result = subprocess.run(['bash', '-c', function + '\nsanitize "$1" "$2"',
                                     'sanitize', str(raw), str(sane)], cwd=ROOT,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return sane.read_bytes()

    def test_ci_encoded_underscore_sanitizers(self):
        functions = re.findall(r'^          sanitize\(\) \{.*?^          \}',
                               source('ci.yml'), re.M | re.S)
        self.assertTrue(functions)
        for index, function in enumerate(functions):
            for family in ('ghp', 'ghs', 'gho', 'ghu', 'ghr', 'github_pat'):
                for underscore in ('_', '%5F', '%5f'):
                    with self.subTest(block=index, family=family, underscore=underscore):
                        token = (family + '_Ab12cd34').replace('_', underscore).encode()
                        self.assertEqual(self.sanitize(function, token), b'[REDACTED]')
            benign = b'ghosts_of_tokens prose\nghs_abc gho_ab ghu_a ghr_\n'
            self.assertEqual(self.sanitize(function, benign), benign)

    def test_ARG_s_ci_8_token_families(self):
        for name in ('package.yml', 'build-other.yml'):
            for prefix in ('ghp_', 'ghs_', 'gho_', 'ghu_', 'ghr_', 'github_pat_', 'AKIA', 'xoxb-'):
                for spelling in (prefix, prefix.upper(), prefix.replace('_', '%5F'),
                                 prefix.replace('_', '%5f')):
                    with self.subTest(workflow=name, prefix=spelling):
                        self.assertEqual(self.sanitize(source(name), (spelling + 'Ab12cd34').encode()),
                                         b'[REDACTED]')

    def test_benign_log_is_byte_identical(self):
        payload = b'ghosts_of_tokens prose\nghs_abc gho_ab ghu_a ghr_\nplain log\n'
        for name in ('package.yml', 'build-other.yml'):
            self.assertEqual(self.sanitize(source(name), payload), payload)

    def test_arm64_receipt_and_failure_control(self):
        # Stub only the external build calls; execute the actual receipt writer.
        script = gate(source())
        build = re.search(r'^\(\n  set -e\n.*?^\) > "\$LOG" 2>&1', script, re.M | re.S)[0]
        for rc in (0, 7):
            with self.subTest(rc=rc), tempfile.TemporaryDirectory() as tmp:
                env = dict(os.environ, RUNNER_TEMP=tmp, GITHUB_STEP_SUMMARY=tmp + '/summary',
                           GITHUB_SHA='fixture', GITHUB_RUN_ID='fixture', PLATFORM='arm64',
                           JOB_ID='linux-package', SETUP_RESULT='success')
                result = subprocess.run(['bash', '-c', script.replace(build,
                                        f'(exit {rc}) > "$LOG" 2>&1')], cwd=ROOT,
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, rc, result.stderr)
                receipt = json.loads(next(Path(tmp).rglob('*.receipt.json')).read_text())
                self.assertEqual(receipt['schema'], 'gate_receipt/v1')
                self.assertEqual(receipt['argv'], ['bash', 'scripts/bootstrap.sh', 'and', 'package', 'verification'])
                self.assertEqual(receipt['rc'], rc)
                self.assertEqual(receipt['outcome'], 'PASS' if rc == 0 else 'FAIL')
                self.assertEqual(receipt['scope']['platform'], 'arm64')


if __name__ == '__main__':
    unittest.main(verbosity=2)
