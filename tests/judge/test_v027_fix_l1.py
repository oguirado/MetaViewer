"""Offline regression controls for the judge install path (B5-01 through B5-05)."""
from pathlib import Path
import os
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from judge_sandbox import Sandbox


class JudgeFixL1(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.sb = Sandbox(temp.name)
        self.addCleanup(self.sb.cleanup)

    def functions(self, body, *, preflight=False, env=None, timeout=5):
        name = 'preflight.sh' if preflight else 'metaviewer-judge.sh'
        source = (self.sb.kit / 'judge' / name).read_text()
        marker = '# --------------------------------------------------------------------- modes' if preflight else '# ------------------------------------------------------------------- dispatch'
        harness = self.sb.kit / 'judge' / 'l1-harness.sh'
        harness.write_text(source.split(marker)[0] + '\n' + body + '\n')
        process = subprocess.Popen(['bash', str(harness), *([] if preflight else ['install', '--yes'])],
                                   env=self.sb.env(env), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, start_new_session=True)
        try:
            out, err = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            raise
        return subprocess.CompletedProcess(process.args, process.returncode, out, err)

    def test_b501_nonreturning_docker_is_a_typed_refusal(self):
        self.sb.write_exec(self.sb.bin / 'docker', '#!/bin/bash\nexec sleep 30\n')
        result = self.functions('chk_docker; [ "$FAILS" -eq 0 ] || exit 2', preflight=True,
                                env={'MV_JUDGE_DOCKER_TIMEOUT': '0.1'})
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('JUDGE_DOCKER:', result.stderr)
        self.assertIn('-- fix:', result.stderr)
        self.assertNotIn('app_env', self.sb.log('node.log'))

    def test_b501_context_failure_is_not_local_endpoint_proof(self):
        self.sb.write_exec(self.sb.bin / 'docker', '#!/bin/bash\n[ "$1" = info ] && { echo "[]|Linux|/var/lib/docker"; exit 0; }\nexit 1\n')
        result = self.functions('chk_docker; [ "$FAILS" -eq 0 ] || exit 2', preflight=True)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('JUDGE_DOCKER:', result.stderr)

    def test_b502_stalled_download_is_refused_and_partial_removed(self):
        (self.sb.assets / 'SHA256SUMS').write_text('0' * 64 + '  missing.tar\n')
        # Model curl's low-speed deadline; absence of the options models an
        # indefinitely stalled connection, caught by the outer test deadline.
        self.sb.write_exec(self.sb.bin / 'curl', '''#!/bin/bash
stall=; out=
while [ $# -gt 0 ]; do
    case $1 in --speed-time) stall=$2; shift 2;; --output) out=$2; shift 2;; *) shift;; esac
done
printf partial > "$out"
[ -n "$stall" ] || exec sleep 30
sleep "$stall"
exit 28
''')
        result = self.functions('ensure_assets missing.tar', env={'MV_JUDGE_DOWNLOAD_STALL': '0.1'})
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('JUDGE_ASSET:', result.stderr)
        self.assertFalse((self.sb.assets / '.missing.tar.part').exists())

    def test_b502_interrupt_removes_partial(self):
        (self.sb.assets / 'SHA256SUMS').write_text('0' * 64 + '  missing.tar\n')
        self.sb.write_exec(self.sb.bin / 'curl', '''#!/bin/bash
while [ $# -gt 0 ]; do case $1 in --output) out=$2; shift 2;; *) shift;; esac; done
printf partial > "$out"
kill -TERM "$PPID"
exit 1
''')
        result = self.functions('ensure_assets missing.tar')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.sb.assets / '.missing.tar.part').exists())

    def test_b503_incomplete_module_tree_runs_npm_repair(self):
        ui = self.sb.kit / 'ui'
        (ui / 'node_modules/@electron/asar').mkdir(parents=True)
        (ui / 'package-lock.json').write_text('{}')
        # A successful probe must import the actual package tool; a probe of
        # asar alone cannot establish that its transitive import closure works.
        self.sb.write_exec(self.sb.bin / 'node', '#!/bin/bash\n[ -f "$MV_FAKE_DIR/repaired" ] && exit 0\nexit 1\n')
        self.sb.write_exec(self.sb.bin / 'npm', '#!/bin/bash\necho "$*" > "$MV_FAKE_DIR/npm.log"\ntouch "$MV_FAKE_DIR/repaired"\n')
        self.sb.jh.mkdir(exist_ok=True)
        result = self.functions('NODE_BIN=$(command -v node); ensure_pkg_tool_deps "$JUDGE_HOME/npm.log"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('ci --ignore-scripts', self.sb.log('npm.log'))

    def test_b503_real_import_closure_and_ready_tree_skip_without_running_cli(self):
        ui = self.sb.kit / 'ui'
        asar = ui / 'node_modules/@electron/asar'
        asar.mkdir(parents=True)
        (ui / 'package.json').write_text('{"type":"module"}')
        (ui / 'package-lock.json').write_text('{}')
        (asar / 'package.json').write_text('{"type":"module"}')
        (asar / 'index.js').write_text("import './missing.js';")
        (ui / 'tools/package.js').write_text(
            "import {fileURLToPath} from 'node:url';\n"
            "import '../node_modules/@electron/asar/index.js';\n"
            "if (process.argv[1] === fileURLToPath(import.meta.url)) throw Error('CLI_MUST_NOT_RUN');\n")
        node = ui / 'real-node-bin/node'
        node.parent.mkdir()
        node.symlink_to(shutil.which('node'))
        self.sb.write_exec(self.sb.bin / 'npm', '#!/bin/bash\n'
            'echo repair >> "$MV_FAKE_DIR/npm.log"\n'
            'touch "$MV_JUDGE_KIT/ui/node_modules/@electron/asar/missing.js"\n')
        self.sb.jh.mkdir(exist_ok=True)
        body = 'NODE_BIN=' + shlex.quote(str(node)) + '; ensure_pkg_tool_deps "$JUDGE_HOME/npm.log"'
        result = self.functions(body)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.sb.log('npm.log').splitlines(), ['repair'])
        ready = self.functions(body)
        self.assertEqual(ready.returncode, 0, ready.stderr)
        self.assertEqual(self.sb.log('npm.log').splitlines(), ['repair'])

    def test_b504_admin_failure_is_not_success(self):
        admin = self.sb.jh / 'deps/opensuperficies/bin/srf-identity-admin'
        admin.parent.mkdir(parents=True)
        self.sb.write_exec(admin, '#!/bin/bash\nexit 1\n')
        result = self.functions('step_profile; say JUDGE_INSTALL_OK')
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('JUDGE_PROFILE:', result.stderr)
        self.assertNotIn('JUDGE_INSTALL_OK', result.stdout)

    def test_b504_fallback_failure_is_not_success(self):
        store = self.sb.home / 'store'
        (store / 'identities').mkdir(parents=True)
        (store / 'identities/judge.json').symlink_to('/dev/full')
        result = self.functions('step_profile; say JUDGE_INSTALL_OK')
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('JUDGE_PROFILE:', result.stderr)
        self.assertNotIn('JUDGE_INSTALL_OK', result.stdout)

    def test_b505_failed_runtime_mkdir_or_chmod_never_spawns_app(self):
        self.sb.full_kit(t2=True)
        install = self.sb.judge('install', '--capsules', '--no-firewall', '--yes')
        self.assertEqual(install.rc, 0, install.text)
        for tool in ('mkdir', 'chmod'):
            for name in ('recordings', 'os-cu-0'):
                with self.subTest(tool=tool, name=name):
                    real = shutil.which(tool)
                    (self.sb.bin / tool).unlink()
                    self.sb.write_exec(self.sb.bin / tool,
                        '#!/bin/bash\nfor arg in "$@"; do case "$arg" in */' + name + ') exit 1;; esac; done\nexec ' + real + ' "$@"\n')
                    result = self.sb.judge('run')
                    self.assertEqual(result.rc, 2, result.text)
                    self.assertIn('JUDGE_PROFILE:', result.err)
                    self.assertFalse((self.sb.fake / 'app_env.txt').exists())
                    (self.sb.bin / tool).unlink()
                    (self.sb.bin / tool).symlink_to(real)
