"""T7 R2c O3 Locked/Offline Enforcement and Hosted Fixes Test Suite.

Tests workflow flags (--locked, --offline, GOPROXY=off), offline.sh enforcement,
userns net unsharing, root caller guard, missing unshare fail-closed behavior,
and hosted runner fixes.
"""
import errno
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import sys
import tempfile
import textwrap
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / '.github/workflows/ci.yml'
OFFLINE_SH = ROOT / '.github/workflows/offline.sh'


class OfflineEnforcementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp_dir = Path(self.temp.name)

    def test_o3_workflow_offline_flags_present(self):
        """Assert required flags exist in ci.yml workflow steps."""
        ci_text = CI.read_text()
        self.assertIn("cargo clippy --locked --offline", ci_text)
        self.assertIn("cargo test --locked --offline", ci_text)
        self.assertIn('GOPROXY: "off"', ci_text)
        self.assertIn("npm ci --offline", ci_text)
        self.assertIn("offline.sh", ci_text)

    def test_o3_offline_sh_no_args_fails(self):
        """offline.sh with no args returns rc 2."""
        result = subprocess.run(["bash", str(OFFLINE_SH)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("offline: command required", result.stderr + result.stdout)

    def test_o3_offline_sh_unshare_absent_never_executes_payload(self):
        """When unshare is absent in PATH, payload is NEVER executed and fails closed."""
        bin_dir = self.tmp_dir / "bin"
        bin_dir.mkdir()

        unshare_stub = bin_dir / "unshare"
        unshare_stub.write_text("#!/bin/sh\nexit 73\n")
        unshare_stub.chmod(0o755)

        marker = self.tmp_dir / "marker"
        env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ.get("PATH", ""))

        result = subprocess.run(["bash", str(OFFLINE_SH), "touch", str(marker)], env=env)
        self.assertEqual(result.returncode, 73)
        self.assertFalse(marker.exists(), "Payload was executed despite unshare failure")

    def test_o3_offline_sh_userns_egress_blocked_loopback_kept(self):
        """Under userns, offline.sh blocks egress while keeping loopback socket working."""
        probe = textwrap.dedent("""
            import errno, socket, sys
            names = {name for _, name in socket.if_nameindex()}
            assert 'lo' in names, f"lo not in {names}"
            assert not ({'eth0', 'eth1', 'wlan0', 'ens3'} & names), f"External interface present: {names}"
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
                    assert error.errno in (errno.ENETUNREACH, errno.EPERM), f"Unexpected error: {error}"
                else:
                    raise AssertionError("External network reachable")
        """)
        result = subprocess.run(
            ["bash", str(OFFLINE_SH), "python3", "-c", probe],
            capture_output=True, text=True, timeout=10
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_o3_offline_sh_root_caller_guard(self):
        """offline.sh refuses uid 0 caller with exit code 2 and executes nothing."""
        sh_text = OFFLINE_SH.read_text()
        self.assertIn("id -u", sh_text)
        self.assertIn("exit 2", sh_text)

        if os.getuid() != 0:
            bin_dir = self.tmp_dir / "root_bin"
            bin_dir.mkdir()
            id_stub = bin_dir / "id"
            id_stub.write_text("#!/bin/sh\necho 0\n")
            id_stub.chmod(0o755)

            marker = self.tmp_dir / "root_marker"
            env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ.get("PATH", ""))

            result = subprocess.run(["bash", str(OFFLINE_SH), "touch", str(marker)], env=env)
            self.assertEqual(result.returncode, 2)
            self.assertFalse(marker.exists(), "Root caller executed payload despite guard")


class HostedFixesEnforcementTests(unittest.TestCase):
    def test_o3_volume_timeout_map_exact_and_mutants(self):
        """Execute F1 volume policy checking exact timeout map {property:60,mutants:60,e2e:180}."""
        source = CI.read_text()
        source = textwrap.dedent(source[source.index('          def top_block_keys('):
                                         source.index('          # F2:')])
        ci = CI.read_text()
        volume = (ROOT / '.github/workflows/volume.yml').read_text()

        checks = {}
        scope = dict(re=re, ci=ci, vol=volume,
                     check=lambda name, condition, *args: checks.update({name: condition}))
        exec(source, scope)
        self.assertTrue(checks['f1-vol-timeouts'])

        mutants = [
            volume.replace('timeout-minutes: 60', 'timeout-minutes: 61', 1),
            volume.replace('timeout-minutes: 180', 'timeout-minutes: 181', 1),
            volume.replace('timeout-minutes: 180', '# timeout missing'),
        ]
        for idx, mutant in enumerate(mutants):
            with self.subTest(mutant=idx):
                m_checks = {}
                m_scope = dict(re=re, ci=ci, vol=mutant,
                               check=lambda name, condition, *args: m_checks.update({name: condition}))
                exec(source, m_scope)
                self.assertFalse(m_checks['f1-vol-timeouts'], f"Mutant {idx} was accepted")

    def test_o3_node_header_priming_and_mutant_kill_proof(self):
        """Node header priming sets npm_config_nodedir and kills mutant if header assert deleted."""
        bodies = re.findall(
            r'      - name: Prime locked npm cache\n        working-directory: ui\n'
            r'        run: \|\n((?:          .*\n|\n)+)', CI.read_text())
        self.assertEqual(len(bodies), 2, "Expected 2 header priming blocks (js and e2e)")

        for body in bodies:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                prefix = root / "node_dist"
                headers = prefix / "include/node"
                headers.mkdir(parents=True)
                (headers / "node.h").touch()
                (headers / "config.gypi").touch()

                bin_dir = root / "bin"
                bin_dir.mkdir()
                node_stub = bin_dir / "node"
                node_stub.write_text(f"#!/bin/sh\nprintf '%s\\n' {shlex.quote(str(prefix))}\n")
                node_stub.chmod(0o755)

                npm_stub = bin_dir / "npm"
                npm_stub.write_text("#!/bin/sh\nexit 0\n")
                npm_stub.chmod(0o755)

                env_file = root / "env"
                env = dict(os.environ, GITHUB_ENV=str(env_file),
                           PATH=str(bin_dir) + os.pathsep + os.environ["PATH"])

                res = subprocess.run(["bash", "-c", textwrap.dedent(body)], env=env, capture_output=True, text=True)
                self.assertEqual(res.returncode, 0, res.stderr)
                self.assertEqual(env_file.read_text().strip(), f"npm_config_nodedir={prefix}")

                (headers / "node.h").unlink()
                env_file.unlink()
                res_missing = subprocess.run(["bash", "-c", textwrap.dedent(body)], env=env, capture_output=True, text=True)
                self.assertNotEqual(res_missing.returncode, 0, "Missing node.h must fail priming")

                mutant_body = re.sub(r'test -f "\$node_prefix/include/node/.*"', 'true', body)
                env_file_mut = root / "env_mut"
                env_mut = dict(env, GITHUB_ENV=str(env_file_mut))
                res_mut = subprocess.run(["bash", "-c", textwrap.dedent(mutant_body)], env=env_mut, capture_output=True, text=True)
                self.assertEqual(res_mut.returncode, 0, f"Mutant failed: {res_mut.stderr}")
                self.assertEqual(env_file_mut.read_text().strip(), f"npm_config_nodedir={prefix}")

    def test_o3_build_macos_windows_push_conditions(self):
        """build-macos and build-windows if: conditions admit push on bridge/integration or main."""
        ci_text = CI.read_text()
        for job in ('build-macos', 'build-windows'):
            block = re.split(r'\n  [\w-]+:\n', ci_text.split('  ' + job + ':\n', 1)[1])[0]
            self.assertIn('    continue-on-error: true', block)
            expr = re.search(r'^    if: (.+)$', block, re.M)[1]
            expr = expr.replace('||', 'or').replace('&&', 'and')

            for event, ref, expected in (
                ('workflow_dispatch', 'refs/heads/feature', True),
                ('push', 'refs/heads/bridge/integration', True),
                ('push', 'refs/heads/main', True),
                ('push', 'refs/heads/feature', False),
                ('pull_request', 'refs/heads/main', False),
            ):
                with self.subTest(job=job, event=event, ref=ref):
                    act = eval(expr, {'__builtins__': {}},
                               {'github': SimpleNamespace(event_name=event, ref=ref)})
                    self.assertEqual(act, expected)


if __name__ == "__main__":
    unittest.main()
