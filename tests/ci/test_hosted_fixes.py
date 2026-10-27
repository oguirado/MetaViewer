"""Execute hosted policy and header priming with discriminating controls."""
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import textwrap
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / '.github/workflows/ci.yml'


class HostedFixTests(unittest.TestCase):
    def test_complete_inline_policy_fixture(self):
        source = CI.read_text().split(
            '          python3 - <<\'PYEOF\' >>"$LOG" 2>&1\n', 1
        )[1].split('          PYEOF\n', 1)[0]
        result = subprocess.run(
            [sys.executable, '-c', textwrap.dedent(source)], cwd=ROOT,
            env=dict(os.environ, GITHUB_WORKSPACE=str(ROOT),
                     MV_YAML_PYTHON=sys.executable),
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('PASS f1-vol-timeouts\n', result.stdout)
        self.assertIn('PASS f2-pinned\n', result.stdout)

    def test_volume_policy_exact_map_and_mutations(self):
        source = CI.read_text()
        source = textwrap.dedent(source[source.index('          def top_block_keys('):
                                         source.index('          # F2:')])
        ci = CI.read_text()
        volume = (ROOT / '.github/workflows/volume.yml').read_text()
        for candidate, expected in (
            (volume, True),
            (volume.replace('timeout-minutes: 180', 'timeout-minutes: 60'), False),
            (volume.replace('timeout-minutes: 60', 'timeout-minutes: 61', 1), False),
            (volume.replace('timeout-minutes: 60', 'timeout-minutes: 61'), False),
            (volume.replace('timeout-minutes: 180', '# timeout absent'), False),
            (volume + '\n  extra:\n    timeout-minutes: 60\n', False),
        ):
            checks = {}
            scope = dict(re=re, ci=ci, vol=candidate,
                         check=lambda name, condition, *args: checks.update({name: condition}))
            exec(source, scope)
            self.assertEqual(checks['f1-vol-timeouts'], expected)
            self.assertTrue(all(value for name, value in checks.items()
                                if name.startswith('f1-neg-')))

    def test_header_priming_uses_node_prefix_and_fails_if_headers_absent(self):
        bodies = re.findall(
            r'      - name: Prime locked npm cache\n        working-directory: ui\n'
            r'        run: \|\n((?:          .*\n|\n)+)', CI.read_text())
        self.assertEqual(len(bodies), 2, 'exercise both js and e2e')
        for body in bodies:
            with tempfile.TemporaryDirectory(prefix='hosted Música ') as temporary:
                root = Path(temporary)
                prefix = root / 'node installation'
                headers = prefix / 'include/node'
                headers.mkdir(parents=True)
                for name in ('node.h', 'config.gypi'):
                    (headers / name).touch()
                binary = root / 'bin'
                binary.mkdir()
                for name, script in {
                    'node': 'printf "%s\\n" ' + shlex.quote(str(prefix)),
                    'npm': 'test "$*" = "ci --ignore-scripts --no-audit --no-fund"',
                }.items():
                    tool = binary / name
                    tool.write_text('#!/bin/sh\n' + script + '\n')
                    tool.chmod(0o700)
                destination = root / 'env'
                environment = dict(os.environ, GITHUB_ENV=str(destination),
                                   PATH=str(binary) + os.pathsep + os.environ['PATH'])
                result = subprocess.run(['bash', '-c', textwrap.dedent(body)],
                                        env=environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(destination.read_text(), f'npm_config_nodedir={prefix}\n')
                for name in ('node.h', 'config.gypi'):
                    (headers / name).unlink()
                    destination.unlink()
                    result = subprocess.run(['bash', '-c', textwrap.dedent(body)],
                                            env=environment, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(destination.exists(), 'missing headers must not be exported')
                    (headers / name).touch()
                    destination.touch()

    def test_optional_build_triggers_and_nonblocking_policy(self):
        ci = CI.read_text()
        for job in ('build-macos', 'build-windows'):
            block = re.split(r'\n  [\w-]+:\n', ci.split('  ' + job + ':\n', 1)[1])[0]
            self.assertIn('    continue-on-error: true', block)
            expression = re.search(r'^    if: (.+)$', block, re.M)[1]
            expression = expression.replace('||', 'or').replace('&&', 'and')
            for event, ref, expected in (
                ('workflow_dispatch', 'refs/heads/topic', True),
                ('push', 'refs/heads/bridge/integration', True),
                ('push', 'refs/heads/main', True),
                ('push', 'refs/heads/topic', False),
                ('pull_request', 'refs/heads/main', False),
            ):
                self.assertEqual(eval(expression, {'__builtins__': {}},
                                      {'github': SimpleNamespace(event_name=event, ref=ref)}),
                                 expected, (job, event, ref))


if __name__ == '__main__':
    unittest.main()
