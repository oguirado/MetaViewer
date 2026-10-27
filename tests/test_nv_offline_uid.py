"""ARG-n_e2e-1: non-root offline execution and mandatory CI runtime probes."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / '.github/workflows/offline.sh'


class OfflineUIDTests(unittest.TestCase):
    def run_wrapper(self, *command, wrapper=WRAPPER, env=None):
        return subprocess.run(['bash', str(wrapper), *command], env=env,
                              capture_output=True, text=True, timeout=15)

    def test_arg_n_e2e_1_nonroot_loopback_and_isolation(self):
        probe = '''import os, socket, subprocess
assert os.getuid() != 0, "offline command runs as root"
assert os.getuid() == int(os.environ['EXPECTED_UID'])
assert os.getgid() == int(os.environ['EXPECTED_GID'])
assert {name for _, name in socket.if_nameindex()} == {'lo'}
link = subprocess.check_output(['ip', 'link', 'show', 'lo'], text=True)
assert 'UP,LOWER_UP' in link, link
with socket.socket() as server:
    server.bind(('127.0.0.1', 0))
    server.listen()
    with socket.create_connection(server.getsockname(), timeout=1):
        connection, _ = server.accept()
        connection.close()
'''
        result = self.run_wrapper('python3', '-c', probe, env=dict(
            os.environ, EXPECTED_UID=str(os.getuid()), EXPECTED_GID=str(os.getgid())))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_arg_n_e2e_1_root_mapping_negative_control(self):
        # Restore the confirmed defect in a disposable wrapper, never in-place.
        source = WRAPPER.read_text()
        mutant = source.replace('--map-current-user', '--map-root-user')
        with tempfile.TemporaryDirectory() as tmp:
            wrapper = Path(tmp) / 'offline.sh'
            wrapper.write_text(mutant)
            result = self.run_wrapper('sh', '-c', 'test "$(id -u)" != 0', wrapper=wrapper)
            self.assertEqual(result.returncode, 1, result.stderr)

    def test_arg_n_e2e_1_loopback_failure_never_executes_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            ip = directory / 'ip'
            ip.write_text('#!/bin/sh\nexit 71\n')
            ip.chmod(0o755)
            marker = directory / 'executed'
            result = self.run_wrapper('touch', str(marker), env=dict(
                os.environ, PATH=str(directory) + os.pathsep + os.environ['PATH']))
            self.assertEqual(result.returncode, 71, result.stderr)
            self.assertFalse(marker.exists())

    def test_arg_n_e2e_1_root_caller_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / 'executed'
            result = subprocess.run(['unshare', '--user', '--map-root-user',
                                     'bash', str(WRAPPER), 'touch', str(marker)],
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn('non-root caller required', result.stderr)
            self.assertFalse(marker.exists())

    def check_ci_probes(self, workflow):
        # Exercise the actual workflow statements, with a fake installer and
        # wrapper: the offline verification must run and its failure must win.
        js = re.search(r'^          (.*node \.github/workflows/install_electron\.cjs.*; r=\$\?)$',
                       workflow, re.M)
        self.assertIsNotNone(js, 'JS installer statement absent')
        e2e = workflow.split('      - name: Install and verify pinned Electron binary\n', 1)[1]
        block = e2e.split('      - name:', 1)[0]
        self.assertIn('        run: |\n', block, 'E2E needs mandatory offline verification')
        script = '\n'.join(line[10:] for line in block.split('        run: |\n', 1)[1].splitlines()
                           if line.startswith('          '))
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            wrapper = directory / '.github/workflows/offline.sh'
            wrapper.parent.mkdir(parents=True)
            wrapper.write_text('#!/bin/sh\nexport MV_PROBE_OFFLINE=1\nexec "$@"\n')
            node = directory / 'node'
            node.write_text('#!/bin/sh\nprintf "%s\\n" "${MV_PROBE_OFFLINE:-0}" >> "$TRACE"\n'
                            '[ "${MV_PROBE_OFFLINE:-0}" != 1 ] || exit "${PROBE_RC:-0}"\n')
            node.chmod(0o755)
            env = dict(os.environ, GITHUB_WORKSPACE=str(directory), LOG=str(directory / 'log'),
                       TRACE=str(directory / 'trace'), PATH=str(directory) + os.pathsep + os.environ['PATH'])
            prelude = 'offline() { bash "$GITHUB_WORKSPACE/.github/workflows/offline.sh" "$@"; }; '
            for statement in (js[1] + '\nexit "$r"', script):
                for failure in (0, 9):
                    trace = directory / 'trace'
                    trace.unlink(missing_ok=True)
                    result = subprocess.run(['bash', '-c', prelude + statement], cwd=directory,
                                            env=dict(env, PROBE_RC=str(failure)),
                                            capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, failure, result.stderr)
                    self.assertEqual(trace.read_text().splitlines(), ['0', '1'])

    def test_arg_n_e2e_1_ci_requires_offline_electron_probe(self):
        self.check_ci_probes((ROOT / '.github/workflows/ci.yml').read_text())

    def test_arg_n_e2e_1_missing_offline_probe_negative_control(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        mutant = workflow.replace('offline timeout 1200 node .github/workflows/install_electron.cjs',
                                  'timeout 1200 node .github/workflows/install_electron.cjs')
        with self.assertRaises(AssertionError):
            self.check_ci_probes(mutant)
