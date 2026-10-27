"""Regression tests execute the workflow's F2 and sanitizer implementations."""
import os
import json
import glob
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / '.github/workflows/ci.yml'
SHA = '11bd71901bbe5b1630ceea73d27597364c9af683'


def f2_source():
    text = CI.read_text()
    return textwrap.dedent(text[text.index('          def pin_errors('):
                                text.index('          # F3')])


class WorkflowPinTests(unittest.TestCase):
    def pins(self, text, root=ROOT):
        source = f2_source().split('\nreal = []')[0]
        scope = dict(os=os, re=re, glob=glob, json=json, subprocess=subprocess, sys=__import__('sys'))
        exec(source, scope)
        return scope['pin_errors'](text, str(root))

    def test_r1_090_semantic_uses(self):
        for key in ('uses', 'uses ', '"uses"', "'uses'", '\\u0075ses'):
            if key.startswith('\\'):
                key = '"' + key + '"'
            with self.subTest(key=key):
                self.assertTrue(self.pins('steps:\n - ' + key + ': actions/checkout@v4\n'))
        self.assertTrue(self.pins('steps: [{uses: actions/checkout@v4}]'))
        self.assertEqual(self.pins('steps: [{uses: actions/checkout@' + SHA + '}]'), [])

    def test_r1_090_yaml_extension_scanned(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.github/workflows').mkdir(parents=True)
            (root / '.github/workflows/float.yaml').write_text('steps: [{uses: actions/checkout@v4}]')
            checks = {}
            scope = dict(os=os, re=re, glob=glob, json=json, subprocess=subprocess, sys=__import__('sys'),
                         check=lambda name, cond, *args: checks.update({name: cond}))
            previous = Path.cwd()
            old_workspace = os.environ.get("GITHUB_WORKSPACE")
            try:
                os.environ["GITHUB_WORKSPACE"] = str(ROOT)
                os.chdir(root)
                exec(f2_source(), scope)
            finally:
                os.chdir(previous)
                if old_workspace is None:
                    os.environ.pop("GITHUB_WORKSPACE", None)
                else:
                    os.environ["GITHUB_WORKSPACE"] = old_workspace
            self.assertFalse(checks['f2-pinned'])

    def test_r1_013_docker_rejected_checkout_accepted(self):
        for text in ('steps: [{uses: docker://alpine@' + SHA + '}]',
                     'steps:\n - uses: docker://alpine@' + SHA):
            self.assertTrue(self.pins(text))
        self.assertEqual(self.pins('steps:\n - uses: actions/checkout@' + SHA), [])

    def test_r1_090_local_requires_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'action').mkdir()
            text = 'steps: [{uses: ./action}]'
            self.assertTrue(self.pins(text, root))
            (root / 'action/action.yaml').write_text('name: local\nruns: {using: composite, steps: []}')
            self.assertEqual(self.pins(text, root), [])
            self.assertTrue(self.pins('steps: [{uses: ../action}]', root))

    def test_r1_090_malformed_and_duplicate_keys_fail_closed(self):
        self.assertTrue(self.pins('steps: [broken'))
        self.assertTrue(self.pins('steps: [{uses: actions/checkout@v4, uses: actions/checkout@' + SHA + '}]'))
        self.assertTrue(self.pins('steps: [{uses: null}]'))


class SanitizerTests(unittest.TestCase):
    def test_r1_014_all_actual_sanitizers(self):
        for workflow in ('ci.yml', 'volume.yml'):
            text = (CI.parent / workflow).read_text()
            bodies = re.findall(r"python3 - \"\$1\" \"\$2\" <<'PYEOF'\n(.*?)\n          PYEOF", text, re.S)
            self.assertTrue(bodies)
            for number, body in enumerate(bodies):
                with self.subTest(workflow=workflow, copy=number), tempfile.TemporaryDirectory() as tmp:
                    raw, sane = Path(tmp) / 'raw', Path(tmp) / 'sane'
                    tokens = ['ghp%5F' + 'a' * 36, 'GHP_' + 'b' * 36,
                              'github%5fpat%5F' + 'c' * 36, 'ghp_' + 'd' * 36,
                              'ghs_' + 'e' * 36, 'gho_' + 'f' * 36,
                              'ghu_' + 'g' * 36, 'ghr_' + 'h' * 36]
                    raw.write_text('\n'.join(tokens) + '\nclean line 42\n')
                    result = subprocess.run(['python3', '-c', textwrap.dedent(body), str(raw), str(sane)],
                                            capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(sane.read_text(), '[REDACTED]\n' * len(tokens) + 'clean line 42\n')


class OfflinePolicyTests(unittest.TestCase):
    def test_r1_095_build_commands_and_sandbox(self):
        text = CI.read_text()
        for command in ('cargo clippy --locked --offline --all-targets',
                        'cargo test --locked --offline', 'npm ci --offline',
                        'GOPROXY: "off"', 'GOTOOLCHAIN: local', 'GOFLAGS: -mod=readonly'):
            self.assertTrue(command in text, command)
        self.assertIn('offline timeout 1200 cargo', text)
        self.assertIn('offline timeout 1200 go', text)
        self.assertIn('offline timeout 1200 npm', text)
        wrapper = CI.parent / 'offline.sh'
        self.assertTrue(wrapper.is_file())
        result = subprocess.run(['bash', str(wrapper)], capture_output=True)
        self.assertNotEqual(result.returncode, 0, 'empty command must fail closed')

    def test_r1_095_namespace_blocks_egress_keeps_loopback(self):
        probe = """import errno, socket
assert {name for _, name in socket.if_nameindex()} == {'lo'}
with socket.socket() as server:
    server.bind(('127.0.0.1', 0))
    server.listen()
    with socket.create_connection(server.getsockname(), timeout=1):
        connection, _ = server.accept()
        connection.close()
with socket.socket() as remote:
    remote.settimeout(1)
    try:
        remote.connect(('192.0.2.1', 9))
    except OSError as error:
        assert error.errno == errno.ENETUNREACH, error
    else:
        raise AssertionError('external network reachable')
"""
        result = subprocess.run(['bash', str(CI.parent / 'offline.sh'), 'python3', '-c', probe],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_r1_095_namespace_failure_never_executes_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            unshare = root / 'unshare'
            unshare.write_text('#!/bin/sh\nexit 73\n')
            unshare.chmod(0o755)
            marker = root / 'executed'
            result = subprocess.run(['bash', str(CI.parent / 'offline.sh'), 'touch', str(marker)],
                                    env=dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH']))
            self.assertEqual(result.returncode, 73)
            self.assertFalse(marker.exists())


if __name__ == '__main__':
    unittest.main()
