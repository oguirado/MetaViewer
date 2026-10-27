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
import yaml
import workflow_pins

WORKFLOWS = Path(__file__).resolve().parent
ROOT = WORKFLOWS.parents[1]


def source(name='package.yml'):
    return (WORKFLOWS / name).read_text(encoding='utf-8')


def gate(text):
    return textwrap.dedent(text.split('      - name: Execute gate and publish receipt\n')[1]
                           .split('        run: |\n', 1)[1])


class PackageRegressions(unittest.TestCase):
    def assert_admission(self, text):
        self.assertEqual(workflow_pins.pin_errors(text, ROOT), [])
        workflow = yaml.safe_load(text)
        linux_package = workflow['jobs']['linux-package']
        members = linux_package['strategy']['matrix']['include']
        self.assertEqual(members, [
            {'runner': 'ubuntu-24.04', 'platform': 'x64'},
            {'runner': 'ubuntu-24.04-arm', 'platform': 'arm64'},
        ])
        yaml_steps = linux_package['steps']
        self.assertGreaterEqual(len(yaml_steps), 11)
        # No matrix member may skip any prerequisite step or the gate step.
        for member in members:
            platform = member['platform']
            for step in yaml_steps[:-1]:
                self.assertNotIn('if', step, f'prerequisite step skipped or conditional for {platform}: {step}')
            gate_step = yaml_steps[-1]
            self.assertEqual(gate_step.get('name'), 'Execute gate and publish receipt')
            self.assertEqual(gate_step.get('if'), 'always()',
                             f'gate step must run unconditionally via always() for {platform}')

        job = text.split('  linux-package:\n', 1)[1]
        header = job.split('    strategy:', 1)[0]
        self.assertIn("if: github.event_name != 'pull_request' || !github.event.pull_request.head.repo.fork", header)
        self.assertIn('fail-fast: false', job)
        self.assertIn('runs-on: ${{ matrix.runner }}', job)
        self.assertIn('timeout-minutes: 25', job)
        self.assertIn('runner: ubuntu-24.04\n            platform: x64', job)
        self.assertIn('runner: ubuntu-24.04-arm\n            platform: arm64', job)
        steps = re.split(r'^      - ', job.split('    steps:\n', 1)[1], flags=re.M)[1:]
        self.assertEqual(len(steps), len(yaml_steps))
        for step in steps[:-1]:
            self.assertIsNone(re.search(r'^        if: (.*)$', step, re.M), step)
        gate_condition = re.search(r'^        if: (.*)$', steps[-1], re.M)
        self.assertIsNotNone(gate_condition, steps[-1])
        self.assertEqual(gate_condition[1], 'always()')

        for required in (
            'go-version-file: daemon-adapter/go.mod',
            'rustup toolchain install 1.97.0 --profile minimal',
            'rustup override set 1.97.0',
            'cargo fetch --locked',
            '(cd daemon-adapter && go mod download)',
            'command -v xvfb-run',
            'command -v strace',
            'command -v zip',
            'npm ci --ignore-scripts --no-audit --no-fund',
            'bash .github/workflows/offline.sh npm --prefix ui ci --offline --ignore-scripts --no-audit --no-fund',
            'node .github/workflows/install_electron.cjs',
            'PLATFORM: ${{ matrix.platform }}',
            'SETUP_RESULT: ${{ job.status }}',
            'MV_PKG_OUT: ${{ runner.temp }}/metaviewer-package',
            'CAPSULE_UI_KIT_REPO: ${{ github.workspace }}/kit-checkout',
            'ELECTRON_OVERRIDE_DIST_PATH: ${{ github.workspace }}/ui/node_modules/electron/dist',
            'CARGO_TARGET_DIR: ${{ runner.temp }}/package-cargo-target',
        ):
            self.assertIn(required, job)
        self.assertLess(job.index('Prime locked dependencies'), job.index('Execute gate and publish receipt'))
        self.assertLess(job.index('Prepare verified Electron and offline namespace'),
                        job.index('Execute gate and publish receipt'))
        self.assertLess(job.index('Prime native toolchains'), job.index('Execute gate and publish receipt'))

        body = gate(text)
        self.assertIn('if [ "$PLATFORM" != arm64 ] && [ "$PLATFORM" != x64 ]; then', body)
        self.assertNotIn('x64 packaging interface absent', body)
        self.assertNotIn('MetaViewer-linux-arm64', body)
        build_cmd = 'bash .github/workflows/offline.sh bash scripts/bootstrap.sh'
        verify_cmd = 'bash .github/workflows/offline.sh node ui/tools/package.js --verify-install "$MV_PKG_OUT/MetaViewer-linux-$PLATFORM"'
        smoke_cmd = 'bash .github/workflows/offline.sh node ui/tools/package.js --smoke "$MV_PKG_OUT/MetaViewer-linux-$PLATFORM.tar"'
        self.assertIn(build_cmd, body)
        self.assertIn(verify_cmd, body)
        self.assertIn(smoke_cmd, body)
        self.assertIn('METAVIEWER_MAIN_SMOKE_OK', body)
        self.assertLess(body.index(build_cmd), body.index(verify_cmd))
        self.assertLess(body.index(verify_cmd), body.index(smoke_cmd))

    def test_ARG_s_ci_1_admission(self):
        self.assert_admission(source())

    def test_admission_negative_controls(self):
        text = source()
        for mutant in (
            text.replace('        if: always()', "        if: always() && matrix.platform == 'arm64'"),
            text.replace('        if: always()', "        if: always() && matrix.platform == 'x64'"),
            text.replace('        if: always()', '        if: false'),
            text.replace('        if: always()\n', ''),
            text.replace('      - name: Prime native toolchains\n',
                         "      - name: Prime native toolchains\n        if: matrix.platform == 'arm64'\n"),
            text.replace('!github.event.pull_request.head.repo.fork', 'true'),
            text.replace('runner: ubuntu-24.04-arm', 'runner: ubuntu-24.04'),
            text.replace('platform: x64', 'platform: arm64'),
            text.replace('CARGO_TARGET_DIR: ${{ runner.temp }}/package-cargo-target\n', ''),
            text.replace('CARGO_TARGET_DIR: ${{ runner.temp }}/package-cargo-target',
                         'CARGO_TARGET_DIR: relative-target'),
            text.replace('go-version-file: daemon-adapter/go.mod', 'go-version: "1.26"'),
            text.replace('cargo fetch --locked\n', ''),
            text.replace('bash .github/workflows/offline.sh bash scripts/bootstrap.sh', 'true'),
            text.replace('--verify-install "$MV_PKG_OUT/MetaViewer-linux-$PLATFORM"',
                         '--verify "$MV_PKG_OUT/MetaViewer-linux-arm64"'),
            text.replace('node ui/tools/package.js --smoke "$MV_PKG_OUT/MetaViewer-linux-$PLATFORM.tar"', 'true'),
        ):
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
        for platform in ('arm64', 'x64'):
            for rc in (0, 7):
                with self.subTest(platform=platform, rc=rc), tempfile.TemporaryDirectory() as tmp:
                    env = dict(os.environ, RUNNER_TEMP=tmp, GITHUB_STEP_SUMMARY=tmp + '/summary',
                               GITHUB_SHA='fixture', GITHUB_RUN_ID='fixture', PLATFORM=platform,
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
                    self.assertEqual(receipt['scope']['platform'], platform)

    def test_both_arches_execute_full_gate_and_fail_closed(self):
        raw_script = gate(source())
        shim = (
            'offline_shim() {\n'
            '  python3 -c \'import json, os, sys; open(os.environ["CALLS_LOG"], "a").write(json.dumps(sys.argv[1:]) + "\\n")\' "$@"\n'
            '  if [ "${1:-}" = node ] && [ "${3:-}" = --smoke ]; then\n'
            '    printf \'%s\\n\' "${SMOKE_OUT:-{\\"marker\\":\\"METAVIEWER_MAIN_SMOKE_OK\\",\\"source_access\\":false,\\"negative_controls\\":\\"PASS\\"}}"\n'
            '  fi\n'
            '  return "${SHIM_RC:-0}"\n'
            '}\n'
        )
        script = shim + raw_script.replace('bash .github/workflows/offline.sh', 'offline_shim')
        for platform in ('arm64', 'x64'):
            with self.subTest(platform=platform, mode='valid'), tempfile.TemporaryDirectory() as tmp:
                calls_log = Path(tmp) / 'calls.jsonl'
                pkg_out = str(Path(tmp) / 'pkg-out')
                cargo_target = str(Path(tmp) / 'cargo-target')
                env = dict(os.environ, RUNNER_TEMP=tmp, GITHUB_STEP_SUMMARY=tmp + '/summary',
                           GITHUB_SHA='fixture', GITHUB_RUN_ID='fixture', PLATFORM=platform,
                           JOB_ID='linux-package', SETUP_RESULT='success',
                           MV_PKG_OUT=pkg_out, CARGO_TARGET_DIR=cargo_target,
                           CALLS_LOG=str(calls_log))
                result = subprocess.run(['bash', '-c', script], cwd=ROOT,
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                calls = [json.loads(line) for line in calls_log.read_text().splitlines()]
                self.assertEqual(calls, [
                    ['bash', 'scripts/bootstrap.sh'],
                    ['node', 'ui/tools/package.js', '--verify-install', f'{pkg_out}/MetaViewer-linux-{platform}'],
                    ['node', 'ui/tools/package.js', '--smoke', f'{pkg_out}/MetaViewer-linux-{platform}.tar'],
                ])
                receipt = json.loads(next(Path(tmp).rglob('*.receipt.json')).read_text())
                self.assertEqual(receipt['outcome'], 'PASS')
                self.assertEqual(receipt['scope']['platform'], platform)

        for mode in ('missing-cargo-target', 'relative-cargo-target', 'missing-smoke-marker',
                     'failed-setup', 'unsupported-arch'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                calls_log = Path(tmp) / 'calls.jsonl'
                pkg_out = str(Path(tmp) / 'pkg-out')
                cargo_target = ('' if mode == 'missing-cargo-target'
                                else 'relative/target' if mode == 'relative-cargo-target'
                                else str(Path(tmp) / 'cargo-target'))
                env = dict(os.environ, RUNNER_TEMP=tmp, GITHUB_STEP_SUMMARY=tmp + '/summary',
                           GITHUB_SHA='fixture', GITHUB_RUN_ID='fixture',
                           PLATFORM='riscv64' if mode == 'unsupported-arch' else 'x64',
                           JOB_ID='linux-package',
                           SETUP_RESULT='failure' if mode == 'failed-setup' else 'success',
                           MV_PKG_OUT=pkg_out, CARGO_TARGET_DIR=cargo_target,
                           CALLS_LOG=str(calls_log))
                if mode == 'missing-smoke-marker':
                    env['SMOKE_OUT'] = '{"marker":""}'
                result = subprocess.run(['bash', '-c', script], cwd=ROOT,
                                        env=env, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                receipt = json.loads(next(Path(tmp).rglob('*.receipt.json')).read_text())
                if mode == 'unsupported-arch':
                    self.assertEqual(receipt['outcome'], 'BLOCKED')
                    self.assertIsNone(receipt['rc'])
                    self.assertEqual(receipt['counts']['source'], 'unexecuted')
                else:
                    self.assertEqual(receipt['outcome'], 'FAIL')
                if mode in ('missing-cargo-target', 'relative-cargo-target'):
                    self.assertFalse(calls_log.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
