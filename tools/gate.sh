#!/usr/bin/env bash
# [TARGET, unit decision] Require complete release pins and npm dependency sets;
# verify frozen offline resolution in disposable trees, for the current Rust host.
set -u

usage() {
    printf '%s\n' \
        'Usage: tools/gate.sh [--leg skeleton|laws|contracts|unit|agents|manifests|js|rust|go|ui|ui-smoke|perf | --self-test]' \
        '  MV_GATE_PERF_LIVE=1 enables the live Electron RSS probe in the perf leg.' >&2
    exit 2
}
selector=skeleton
case $# in
    0) ;;
    1) [[ $1 == --self-test ]] || usage; selector=self-test ;;
    2) [[ $1 == --leg ]] || usage; selector=$2 ;;
    *) usage ;;
esac
case $selector in skeleton|laws|contracts|unit|agents|manifests|js|rust|go|ui|ui-smoke|perf|self-test) ;; *) usage ;; esac
[[ $selector != self-test || ${1:-} == --self-test ]] || usage
root=$(cd -- "${BASH_SOURCE[0]%/*}/.." && pwd -P) || exit 2
if ! command -v python3 >/dev/null; then
    printf 'BLOCKED %s: missing python3\nBLOCKED aggregate\n' "$selector" >&2
    exit 2
fi
export PYTHONDONTWRITEBYTECODE=1
exec python3 - "$root" "$selector" <<'PY'
import ctypes
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import unittest

ROOT = Path(sys.argv[1])
SELECTOR = sys.argv[2]
BASE_LEAVES = ('manifests', 'laws', 'contracts', 'unit', 'agents')
LEAVES = (*BASE_LEAVES, 'js', 'rust', 'go', 'ui', 'ui-smoke', 'perf')
FILES = ('Cargo.toml', 'core/Cargo.toml', 'daemon-adapter/go.mod',
         'agents/pyproject.toml', 'ui/package.json', '.gitignore')
ORIGINAL_IGNORE = ('__pycache__/', '*.py[cod]', '.venv/', 'venv/',
                   '.pytest_cache/', 'target/', 'node_modules/', '*.log')
REQUIRED_IGNORE = ('dist/', 'build/', 'coverage/', '.env', '.env.*',
                   'operator.token', 'launch.token', '*.key', 'auth.json',
                   '.beckett/token', 'cookies/', 'profiles/')
DEPENDENCIES = {'@xterm/addon-fit': '0.11.0', '@xterm/xterm': '6.0.0',
                'dockview-core': '8.4.1', 'dockview-vue': '8.4.1',
                'electron': '44.9.2', 'vue': '3.5.43', 'openvue': '1.0.0',
                '@openvue/themes': '1.0.0', '@openvue/icons': '1.0.0',
                'node-pty': '1.1.0'}
DEV_DEPENDENCIES = {'@vitejs/plugin-vue': '6.0.9', 'typescript': '5.9.3',
                    'vite': '8.3.4', 'vue-tsc': '3.3.12',
                    '@electron/packager': '20.3.0', '@electron/asar': '4.3.1'}
RUST_DEPENDENCIES = {'serde', 'serde_json', 'sha2', 'libc', 'tokio'}
SCRIPTS = {'test': 'node --test --test-timeout=120000 test/*.test.js',
           'check': 'vue-tsc --noEmit -p tsconfig.json', 'build': 'vite build'}


class InvalidMetadata(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidMetadata(message)


# Self-tests invoke the shipped CLI and mutate only disposable fixtures.
class GateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fixture = Path(self.temp.name) / 'repo'
        self.fixture.mkdir()
        for name in (*FILES, 'VERSION', 'tools/gate.sh', 'deps.lock',
                     'Cargo.lock', 'ui/package-lock.json'):
            destination = self.fixture / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, destination)
        self.write('CHANGELOG.md', '## ' + (self.fixture / 'VERSION').read_text().strip() + '\n')
        (self.fixture / 'contracts').mkdir()
        self.write('tools/check_laws.py',
                   "import os, pathlib, sys\n"
                   "with open('law.calls', 'a') as f: f.write(repr(sys.argv[1:])+'\\n')\n"
                   "with open('scratch.calls', 'a') as f: f.write(os.environ['TMPDIR']+'\\n')\n")
        self.write('tools/check_contracts.py',
                   "import sys\nassert len(sys.argv) == 1\n"
                   "with open('contract.calls', 'a') as f: f.write('called\\n')\n")
        self.write('tests/test_witness.py',
                   "import unittest\n"
                   "class Witness(unittest.TestCase):\n"
                   "    def test_witness(self):\n"
                   "        with open('unit.calls', 'a') as f: f.write('asserted\\n')\n"
                   "        self.assertEqual(2 + 2, 4)\n")
        self.write('agents/tests/test_witness.py',
                   "import unittest\n"
                   "class AgentsWitness(unittest.TestCase):\n"
                   "    def test_witness(self):\n"
                   "        with open('agents.calls', 'a') as f: f.write('asserted\\n')\n"
                   "        self.assertEqual(2 + 2, 4)\n")
        self.write('agents/tests/run_mutant_harness.py',
                   "with open('mutant.calls', 'a') as f: f.write('asserted\\n')\n")

    def write(self, name, content):
        path = self.fixture / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def call(self, *args, expected=0, env=None):
        # Each fixture invocation owns fresh artifacts, even when the caller
        # supplies a shared target. Keep normal CLI Rust builds unchanged.
        with tempfile.TemporaryDirectory(prefix='cargo-target-', dir=self.temp.name) as target:
            child = dict(os.environ if env is None else env, CARGO_TARGET_DIR=target)
            result = subprocess.run(
                ['bash', str(self.fixture / 'tools/gate.sh'), *args],
                cwd=self.temp.name, env=child, text=True, capture_output=True, timeout=120)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        self.assertNotIn('SKIP', result.stdout)
        return result.stdout + result.stderr

    def refused_manifest(self, name, content):
        path = self.fixture / name
        original = path.read_text()
        try:
            self.write(name, content)
            self.assertIn('FAIL manifests', self.call('--leg', 'manifests', expected=1))
        finally:
            path.write_text(original)

    def test_manifest_parse_and_identity(self):
        self.assertIn('PASS manifests', self.call('--leg', 'manifests'))
        for name in ('Cargo.toml', 'core/Cargo.toml', 'agents/pyproject.toml', 'ui/package.json'):
            with self.subTest(name=name):
                self.refused_manifest(name, '{ broken =')
        for name, before, after in (
            ('VERSION', (self.fixture / 'VERSION').read_text(), '9.9.9\n'),
            ('Cargo.toml', 'members = ["core"]', 'members = []'),
            ('Cargo.toml', 'overflow-checks = true', 'overflow-checks = false'),
            ('Cargo.toml', 'overflow-checks = true', 'overflow-checks = 1'),
            ('Cargo.toml', 'publish = false', 'publish = 0'),
            ('daemon-adapter/go.mod', 'module metaviewer/daemon-adapter', 'module remote'),
            ('daemon-adapter/go.mod', 'go 1.26.0', 'go invalid'),
        ):
            with self.subTest(name=name, before=before):
                self.refused_manifest(name, (self.fixture / name).read_text().replace(before, after))

    def test_release_version_consistency(self):
        version = (self.fixture / 'VERSION').read_text().strip()
        for name in ('Cargo.toml', 'agents/pyproject.toml', 'ui/package.json',
                     'Cargo.lock', 'ui/package-lock.json'):
            with self.subTest(name=name):
                original = (self.fixture / name).read_text()
                self.assertIn(version, original)
                self.refused_manifest(name, original.replace(version, '9.9.9', 1))
        core = (self.fixture / 'core/Cargo.toml').read_text()
        self.assertIn('version.workspace = true', core)
        self.refused_manifest('core/Cargo.toml', core.replace(
            'version.workspace = true', 'version = "9.9.9"'))
        # A coordinated release must pass without editing the gate itself.
        for name in ('VERSION', 'Cargo.toml', 'agents/pyproject.toml',
                     'ui/package.json', 'Cargo.lock', 'ui/package-lock.json'):
            original = (self.fixture / name).read_text()
            self.write(name, original.replace(version, '9.9.9'))
        self.assertIn('PASS manifests', self.call('--leg', 'manifests'))

    def test_dependency_admission(self):
        for value in ('^3.5.43', '~3.5.43', '*', '>=3.5.43', '3.5.42'):
            data = json.loads((self.fixture / 'ui/package.json').read_text())
            data['dependencies']['vue'] = value
            self.refused_manifest('ui/package.json', json.dumps(data))
        data = json.loads((self.fixture / 'ui/package.json').read_text())
        data['dependencies']['unapproved'] = '1.0.0'
        self.refused_manifest('ui/package.json', json.dumps(data))
        data = json.loads((self.fixture / 'ui/package.json').read_text())
        data['private'] = 1
        self.refused_manifest('ui/package.json', json.dumps(data))
        for name, addition in (
            ('core/Cargo.toml', '\nunapproved = "=1.0.0"\n'),
            ('Cargo.toml', '\n[workspace.dependencies]\nunapproved = "=1.0.0"\n'),
            ('daemon-adapter/go.mod', '\nreplace example.org/a => example.org/b v1.0.0\n'),
            ('agents/pyproject.toml', '\n[build-system]\nrequires = ["unapproved"]\n'),
        ):
            self.refused_manifest(name, (self.fixture / name).read_text() + addition)

    def test_rust_dependency_policy(self):
        path = self.fixture / 'core/Cargo.toml'
        identity = path.read_text().split('[dependencies]')[0]
        self.write('core/Cargo.toml', identity + '[dependencies]\nsha2 = "=0.10.9"\n'
                   '[dev-dependencies]\nproptest = "=1.12.0"\n')
        # A changed dependency set requires a corresponding offline frozen lock.
        self.write('core/src/lib.rs', '')
        result = subprocess.run([os.environ.get('CARGO', 'cargo'), 'generate-lockfile', '--offline'],
                                cwd=self.fixture, env=os.environ.copy(),
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.call('--leg', 'manifests')
        for section, dependency in (
            ('dependencies', 'serde = "1.0.229"'),
            ('dependencies', 'serde = { version = "=1.0.229", path = "../serde" }'),
            ('dependencies', 'unapproved = "=1.0.0"'),
            ('dependencies', 'proptest = "=1.12.0"'),
            ('dev-dependencies', 'unapproved = "=1.0.0"'),
        ):
            with self.subTest(dependency=dependency, section=section):
                self.refused_manifest('core/Cargo.toml', identity +
                                      '[' + section + ']\n' + dependency + '\n')

    def test_npm_dependency_subsets(self):
        data = json.loads((self.fixture / 'ui/package.json').read_text())
        data['dependencies'] = {'openvue': '1.0.0', 'node-pty': '1.1.0'}
        data['devDependencies'] = {'@electron/packager': '20.3.0'}
        self.write('ui/package.json', json.dumps(data))
        self.assertIn('dependency closure', self.call('--leg', 'manifests', expected=1))
        data['dependencies']['@electron/packager'] = '20.3.0'
        self.refused_manifest('ui/package.json', json.dumps(data))

    def test_ignore_preservation(self):
        original = (self.fixture / '.gitignore').read_text()
        for line in (*ORIGINAL_IGNORE, *REQUIRED_IGNORE):
            self.refused_manifest('.gitignore', original.replace(line + '\n', ''))
        for pattern in ('*', '*.toml', '*.json', '*.lock', 'ui/', 'VERSION'):
            self.refused_manifest('.gitignore', original + pattern + '\n')

    def test_cli_rejection(self):
        for args in (('--leg', 'unknown'), ('--unknown',), ('unit',),
                     ('--leg',), ('--leg', 'unit', '--leg', 'unit'),
                     ('--self-test', '--leg', 'unit'), ('--self-test', 'extra'),
                     ('--leg', 'self-test')):
            self.assertIn('Usage:', self.call(*args, expected=2))
        self.assertFalse((self.fixture / 'unit.calls').exists())
        for leg in BASE_LEAVES:
            output = self.call('--leg', leg)
            self.assertEqual(output.count('PASS ' + leg + '\n'), 1)
            self.assertEqual(output.count('PASS aggregate\n'), 1)

    def test_harness_rejects_false_pass(self):
        self.write('tools/gate.sh', "#!/usr/bin/env bash\nprintf 'PASS unit\\nPASS aggregate\\n'\nexit 0\n")
        with self.assertRaises(AssertionError):
            self.call('--leg', 'unknown', expected=2)
        self.assertFalse((self.fixture / 'unit.calls').exists())
        with self.assertRaises(FileNotFoundError):
            (self.fixture / 'unit.calls').read_text()

    def test_runner_precondition(self):
        for missing in ('bash', 'python3', 'timeout', 'mktemp'):
            bin_dir = Path(self.temp.name) / ('bin-' + missing)
            bin_dir.mkdir()
            for name in ('bash', 'python3', 'timeout', 'mktemp'):
                if name != missing:
                    (bin_dir / name).symlink_to(shutil.which(name))
            environment = dict(os.environ, PATH=str(bin_dir))
            result = subprocess.run(
                [shutil.which('bash'), str(self.fixture / 'tools/gate.sh'), '--leg', 'unit'],
                cwd=self.temp.name, env=environment, text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn('BLOCKED', result.stdout + result.stderr)
        for leg, target in (('manifests', 'Cargo.toml'), ('laws', 'tools/check_laws.py'),
                            ('contracts', 'tools/check_contracts.py'), ('unit', 'tests')):
            path = self.fixture / target
            moved = path.with_name(path.name + '.held')
            path.rename(moved)
            try:
                self.assertIn('BLOCKED ' + leg, self.call('--leg', leg, expected=2))
            finally:
                moved.rename(path)

    def test_suite_nonvacuity(self):
        self.call('--leg', 'unit')
        self.assertEqual((self.fixture / 'unit.calls').read_text(), 'asserted\n')
        name = 'tests/test_witness.py'
        self.write(name, '')
        self.call('--leg', 'unit', expected=2)
        for source in (
            'raise ImportError("fixture")\n',
            'raise SystemExit(7)\n',
            'import unittest\nclass T(unittest.TestCase):\n def test_x(self): self.fail()\n',
            'import unittest\nclass T(unittest.TestCase):\n @unittest.skip("fixture")\n def test_x(self): pass\n',
            'import unittest\nclass T(unittest.TestCase):\n @unittest.expectedFailure\n def test_x(self): self.fail()\n',
            'import unittest\nclass T(unittest.TestCase):\n @unittest.expectedFailure\n def test_x(self): pass\n',
        ):
            self.write(name, source)
            self.call('--leg', 'unit', expected=1)
        # A producer's PASS text cannot replace the suite witness.
        self.write(name, "print('PASS unit')\n")
        self.call('--leg', 'unit', expected=2)
        self.assertEqual((self.fixture / 'unit.calls').read_text(), 'asserted\n')

    def test_laws_is_not_version_only(self):
        self.call('--leg', 'laws')
        self.assertEqual((self.fixture / 'law.calls').read_text(), "['--version']\n[]\n")
        self.write('tools/check_laws.py',
                   "import sys\nprint('PASS laws')\nsys.exit(0 if '--version' in sys.argv else 7)\n")
        output = self.call('--leg', 'laws', expected=1)
        self.assertIn('child rc=7', output)
        self.assertIn('FAIL laws', output)

    def test_agents_leg_failure_and_missing_directory(self):
        self.assertIn('PASS agents', self.call('--leg', 'agents'))
        self.assertEqual((self.fixture / 'agents.calls').read_text(), 'asserted\n')
        self.assertEqual((self.fixture / 'mutant.calls').read_text(), 'asserted\n')
        self.write('agents/tests/run_mutant_harness.py',
                   'import sys\nprint("planted mutant harness failure", file=sys.stderr)\nsys.exit(1)\n')
        output = self.call('--leg', 'agents', expected=1)
        self.assertIn('planted mutant harness failure', output)
        self.assertIn('FAIL agents\n', output)
        self.assertIn('FAIL aggregate\n', output)
        (self.fixture / 'agents/tests/run_mutant_harness.py').unlink()
        output = self.call('--leg', 'agents', expected=1)
        self.assertIn('missing target: agents/tests/run_mutant_harness.py', output)
        self.assertIn('FAIL agents\n', output)
        self.assertIn('FAIL aggregate\n', output)
        self.write('agents/tests/run_mutant_harness.py',
                   "with open('mutant.calls', 'a') as f: f.write('asserted\\n')\n")
        self.write('agents/tests/test_witness.py',
                   'import unittest\nclass T(unittest.TestCase):\n'
                   ' def test_failure(self): self.fail("planted agents failure")\n')
        output = self.call('--leg', 'agents', expected=1)
        self.assertIn('planted agents failure', output)
        self.assertIn('FAIL agents\n', output)
        self.assertIn('FAIL aggregate\n', output)
        for vacuous in (
            '',
            'import unittest\nclass T(unittest.TestCase):\n'
            ' @unittest.skip("planted skip")\n def test_x(self): pass\n',
            'import unittest\nclass T(unittest.TestCase):\n'
            ' @unittest.expectedFailure\n def test_x(self): self.fail("xfail")\n',
            'import unittest\nclass T(unittest.TestCase):\n'
            ' @unittest.expectedFailure\n def test_x(self): pass\n',
        ):
            self.write('agents/tests/test_witness.py', vacuous)
            output = self.call('--leg', 'agents', expected=1)
            self.assertIn('FAIL agents\n', output)
            self.assertIn('FAIL aggregate\n', output)
            self.assertNotIn('PASS agents', output)
        shutil.rmtree(self.fixture / 'agents/tests')
        output = self.call('--leg', 'agents', expected=1)
        self.assertIn('missing target: agents/tests', output)
        self.assertIn('FAIL agents\n', output)
        self.assertIn('FAIL aggregate\n', output)
        self.assertNotIn('PASS agents', output)

    def test_laws_excludes_only_stash(self):
        shutil.copyfile(ROOT / 'tools/check_laws.py', self.fixture / 'tools/check_laws.py')
        bin_dir = Path(self.temp.name) / 'git-bin'
        bin_dir.mkdir()
        fake_git = bin_dir / 'git'
        fake_git.write_text('#!' + sys.executable + '\n' +
            "import pathlib, sys\n"
            "args = sys.argv[1:]\n"
            "if args[0] == 'rev-list':\n"
            "    print('valid')\n"
            "    if '--exclude=refs/stash' not in args: print('stash')\n"
            "    if pathlib.Path('bad-branch').exists(): print('bad-branch')\n"
            "elif args[0] == 'show':\n"
            "    identity = ['oguirado', '247666607+oguirado@users.noreply.github.com'] * 2\n"
            "    message = 'tools: check history' if args[-1] == 'valid' else 'WIP on local work'\n"
            "    print('\\0'.join(identity + [message]))\n"
            "else: sys.exit(3)\n")
        fake_git.chmod(0o700)
        environment = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ['PATH'])
        # Negative contrast: the unwrapped checker sees the invalid stash commit.
        result = subprocess.run(['python3', 'tools/check_laws.py'], cwd=self.fixture,
                                env=environment, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('stash:', result.stderr)
        self.call('--leg', 'laws', env=environment)
        self.write('bad-branch', '')
        self.assertIn('bad-branch:', self.call('--leg', 'laws', env=environment, expected=1))

    def test_contract_failure_propagates(self):
        self.call('--leg', 'contracts')
        self.assertEqual((self.fixture / 'contract.calls').read_text(), 'called\n')
        self.write('tools/check_contracts.py', "print('PASS contracts')\nraise SystemExit(9)\n")
        self.assertIn('child rc=9', self.call('--leg', 'contracts', expected=1))

    def test_js_leg_kit_absent(self):
        shutil.copyfile(ROOT / 'tools/sync_kit.mjs', self.fixture / 'tools/sync_kit.mjs')
        shutil.copyfile(ROOT / 'ui/kit.lock.json', self.fixture / 'ui/kit.lock.json')
        environment = {key: value for key, value in os.environ.items()
                       if key not in ('MV_KIT_CHECKOUT', 'CAPSULE_UI_KIT_REPO')}
        output = self.call('--leg', 'js', expected=1, env=environment)
        self.assertIn('FAIL js', output)
        self.assertIn('kit absent', output)

    @unittest.skipUnless(shutil.which('node') and shutil.which('git'), 'node and git required')
    def test_js_leg_sync_failure_propagates(self):
        shutil.copyfile(ROOT / 'tools/sync_kit.mjs', self.fixture / 'tools/sync_kit.mjs')
        shutil.copyfile(ROOT / 'ui/kit.lock.json', self.fixture / 'ui/kit.lock.json')
        checkout = Path(self.temp.name) / 'not-a-repo'
        checkout.mkdir()
        environment = dict(os.environ, MV_KIT_CHECKOUT=str(checkout))
        environment.pop('CAPSULE_UI_KIT_REPO', None)
        output = self.call('--leg', 'js', expected=1, env=environment)
        self.assertIn('FAIL js', output)
        self.assertIn('child rc=1', output)

    @unittest.skipUnless(shutil.which('node'), 'node required')
    def test_js_leg_runs_sync_then_check(self):
        self.write('tools/sync_kit.mjs',
                   "import fs from 'node:fs';\n"
                   "fs.appendFileSync('kit.calls', JSON.stringify({argv: process.argv.slice(2), "
                   "checkout: process.env.MV_KIT_CHECKOUT || ''}) + '\\n');\n")
        self.write('ui/kit.lock.json', '{}')
        checkout = str(Path(self.temp.name) / 'checkout')
        for variable in ('MV_KIT_CHECKOUT', 'CAPSULE_UI_KIT_REPO'):
            with self.subTest(variable=variable):
                log = self.fixture / 'kit.calls'
                if log.exists():
                    log.unlink()
                environment = {key: value for key, value in os.environ.items()
                               if key not in ('MV_KIT_CHECKOUT', 'CAPSULE_UI_KIT_REPO')}
                environment[variable] = checkout
                output = self.call('--leg', 'js', env=environment)
                self.assertIn('PASS js', output)
                lines = log.read_text().splitlines()
                self.assertEqual(len(lines), 2)
                first, second = (json.loads(line) for line in lines)
                self.assertEqual(first['argv'], [])
                self.assertEqual(second['argv'], ['--check'])
                self.assertEqual(first['checkout'], checkout)
                self.assertEqual(second['checkout'], checkout)

    @unittest.skipUnless(shutil.which('node'), 'node required')
    def test_kit_check_mode_roundtrip(self):
        shutil.copyfile(ROOT / 'tools/sync_kit.mjs', self.fixture / 'tools/sync_kit.mjs')
        package = self.fixture / 'ui/.kit/capsule-ui-kit'
        package.mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps(
            {'name': 'capsule-ui-kit', 'version': '0.2.1'}))
        (package / 'index.js').write_text('export const value = 1;\n')

        def digest(root):
            result = hashlib.sha256()

            def walk(directory, prefix=''):
                for entry in sorted(directory.iterdir(), key=lambda p: p.name.encode()):
                    if entry.name in ('KIT_SOURCE.json', 'node_modules', '.git'):
                        continue
                    name = prefix + entry.name
                    if entry.is_dir():
                        walk(entry, name + '/')
                    else:
                        key, data = name.encode(), entry.read_bytes()
                        result.update(str(len(key)).encode() + b':' + key)
                        result.update(str(len(data)).encode() + b':' + data)
            walk(root)
            return result.hexdigest()

        content_hash = digest(package)
        (package / 'KIT_SOURCE.json').write_text(json.dumps(
            {'schema': 'capsule-ui-kit-source/v1', 'version': '0.2.1',
             'contentHash': content_hash, 'algorithm': 'sha256-length-framed-tree',
             'direction': 'vendor'}))
        (self.fixture / 'ui/kit.lock.json').write_text(json.dumps(
            {'repo': 'https://example.invalid/kit.git', 'commit': '0' * 40,
             'version': '0.2.1', 'contentHash': content_hash}))
        environment = {key: value for key, value in os.environ.items()
                       if key not in ('MV_KIT_CHECKOUT', 'CAPSULE_UI_KIT_REPO')}

        def run_check():
            return subprocess.run(['node', 'tools/sync_kit.mjs', '--check'],
                                  cwd=self.fixture, env=environment, text=True,
                                  capture_output=True, timeout=30)

        result = run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        (package / 'index.js').write_text('tampered')
        self.assertEqual(run_check().returncode, 1)
        shutil.rmtree(self.fixture / 'ui/.kit')
        result = run_check()
        self.assertEqual(result.returncode, 1)
        self.assertIn('kit absent', result.stderr)

    def prepare_build_fixture(self):
        self.write('Cargo.toml', '[workspace]\nmembers = ["core"]\nresolver = "2"\n')
        self.write('core/Cargo.toml', '[package]\nname = "gate-fixture"\n'
                   'version = "0.1.0"\nedition = "2021"\n')
        self.write('Cargo.lock', 'version = 4\n\n[[package]]\nname = "gate-fixture"\nversion = "0.1.0"\n')
        self.write('core/src/lib.rs', 'pub fn value() -> u32 {\n    1\n}\n')
        package = {'name': 'gate-fixture', 'version': '0.1.0', 'private': True,
                   'devDependencies': {'typescript': '5.9.3', 'vue-tsc': '3.3.12',
                                       'vite': '8.3.4'}}
        self.write('ui/package.json', json.dumps(package))
        # Extract the actual frozen transitive graph without resolving or fetching.
        lock = json.loads((ROOT / 'ui/package-lock.json').read_text())
        lock['name'] = package['name']
        lock['packages'][''] = package
        self.write('ui/package-lock.json', json.dumps(lock))
        self.write('ui/test/fixture.test.js',
                   "const {test} = require('node:test'); test('witness', () => {});\n")
        self.write('ui/tsconfig.json', '{"compilerOptions":{"strict":true},"files":["value.ts"]}')
        self.write('ui/value.ts', 'const value: number = 1;\n')
        self.write('ui/index.html', '<html><body>fixture</body></html>')
        environment = dict(os.environ)
        environment.pop('ELECTRON_OVERRIDE_DIST_PATH', None)
        return environment

    def test_go_leg_negative_controls(self):
        self.write('daemon-adapter/gate_test.go',
                   'package adapter\nimport ("testing"; "net"; "path/filepath"; "os")\n'
                   'func TestCoreHelloPinMismatchRefused(t *testing.T) {\n'
                   ' t.Run("request-before-hello", func(t *testing.T) {\n'
                   '  t.TempDir(); t.TempDir(); root := t.TempDir()\n'
                   '  dir := filepath.Join(root, "metaviewer")\n'
                   '  if err := os.Mkdir(dir, 0700); err != nil { t.Fatal(err) }\n'
                   '  listener, err := net.Listen("unix", filepath.Join(dir, "core.sock"))\n'
                   '  if err != nil { t.Fatal(err) }; listener.Close()\n'
                   ' })\n}\n')
        environment = dict(os.environ)
        self.assertIn('PASS go', self.call('--leg', 'go', env=environment))
        for symbol in ('Fstatat', 'Dup2'):
            self.write('daemon-adapter/xarch_plant_test.go',
                       'package adapter\nimport ("syscall"; "testing")\n'
                       f'var _ = syscall.{symbol}\n'
                       'func TestXArchPlant(t *testing.T) {}\n')
            output = self.call('--leg', 'go', expected=1, env=environment)
            self.assertIn(f'syscall.{symbol}', output)
            self.assertIn('FAIL go', output)
            self.assertIn('FAIL aggregate', output)
        self.assertFalse((ROOT / 'daemon-adapter/xarch_plant_test.go').exists())
        (self.fixture / 'daemon-adapter/xarch_plant_test.go').unlink()
        other_arch = 'amd64' if os.uname().machine in ('aarch64', 'arm64') else 'arm64'
        self.write(f'daemon-adapter/xarch_{other_arch}_test.go',
                   'package adapter\nimport (_ "unsafe"; "testing")\n'
                   '//go:linkname missingXArch syscall.missing_xarch_symbol\n'
                   'func missingXArch()\n'
                   'func TestXArchLink(t *testing.T) { missingXArch() }\n')
        output = self.call('--leg', 'go', expected=1, env=environment)
        self.assertIn('missing_xarch_symbol', output)
        self.assertIn("'-exec'", output)
        self.assertIn('FAIL go', output)
        self.assertIn('FAIL aggregate', output)
        self.assertFalse((ROOT / f'daemon-adapter/xarch_{other_arch}_test.go').exists())
        (self.fixture / f'daemon-adapter/xarch_{other_arch}_test.go').unlink()
        self.write('daemon-adapter/gate_test.go',
                   'package adapter\nimport "testing"\n'
                   'func TestGate(t *testing.T) { t.Fatal("planted Go failure") }\n')
        output = self.call('--leg', 'go', expected=1, env=environment)
        self.assertIn('planted Go failure', output)
        self.assertIn('FAIL go', output)
        self.assertIn('FAIL aggregate', output)
        self.write('daemon-adapter/gate_test.go',
                   'package adapter\nimport "fmt"\n'
                   'func bad() { fmt.Printf("%d", "wrong") }\n')
        output = self.call('--leg', 'go', expected=1, env=environment)
        self.assertIn("'vet'", output)
        self.assertIn('FAIL aggregate', output)
        environment['GO'] = str(self.fixture / 'absent-go')
        output = self.call('--leg', 'go', expected=1, env=environment)
        self.assertIn('missing tool: go', output)
        self.assertIn('FAIL go', output)
        self.assertIn('FAIL aggregate', output)
        # An absent PATH tool also fails when no override is supplied.
        environment.pop('GO')
        self.smoke_runner_path(environment)
        self.assertIn('FAIL go', self.call('--leg', 'go', expected=1, env=environment))

    def smoke_runner_path(self, environment):
        directory = Path(self.temp.name) / 'runner-bin'
        directory.mkdir(exist_ok=True)
        for name in ('bash', 'python3', 'timeout', 'mktemp'):
            target = directory / name
            if not target.exists():
                target.symlink_to(shutil.which(name))
        environment['PATH'] = str(directory)
        return directory

    def prepare_smoke_fixture(self, environment):
        self.write('ui/test/smoke.mjs', 'console.log("METAVIEWER_SMOKE_OK");\n')
        self.write('ui/test/smoke-main.mjs', 'console.log("METAVIEWER_MAIN_SMOKE_OK");\n')
        self.write('electron-dist/electron', '#!/bin/sh\nexit 0\n')
        (self.fixture / 'electron-dist/electron').chmod(0o700)
        environment['ELECTRON_OVERRIDE_DIST_PATH'] = str(self.fixture / 'electron-dist')
        environment['NODE'] = shutil.which('node')
        directory = self.smoke_runner_path(environment)
        self.write('fake-xvfb', '#!/bin/sh\nexit 0\n')
        (self.fixture / 'fake-xvfb').chmod(0o700)
        (directory / 'xvfb-run').symlink_to(self.fixture / 'fake-xvfb')

    def test_ui_smoke_negative_controls(self):
        environment = dict(os.environ)
        self.prepare_smoke_fixture(environment)
        self.assertIn('PASS ui-smoke', self.call('--leg', 'ui-smoke', env=environment))
        self.write('ui/test/smoke-main.mjs', 'throw Error("planted main failure");\n')
        output = self.call('--leg', 'ui-smoke', expected=1, env=environment)
        self.assertIn('planted main failure', output)
        self.assertIn('FAIL aggregate', output)
        self.write('ui/test/smoke-main.mjs', '')
        self.assertIn('marker=False', self.call('--leg', 'ui-smoke', expected=1, env=environment))
        self.write('ui/test/smoke-main.mjs', 'console.log("METAVIEWER_MAIN_SMOKE_OK");\n')
        (Path(environment['PATH']) / 'xvfb-run').unlink()
        output = self.call('--leg', 'ui-smoke', expected=2, env=environment)
        self.assertIn('BLOCKED ui-smoke', output)
        self.assertIn('missing xvfb-run', output)
        self.assertIn('FAIL aggregate', output)
        (Path(environment['PATH']) / 'xvfb-run').symlink_to(self.fixture / 'fake-xvfb')
        environment.pop('ELECTRON_OVERRIDE_DIST_PATH')
        output = self.call('--leg', 'ui-smoke', expected=2, env=environment)
        self.assertIn('no executable local Electron', output)
        self.assertIn('BLOCKED ui-smoke', output)
        self.assertIn('FAIL aggregate', output)
        self.write('ui/node_modules/electron/path.txt', 'electron\n')
        self.write('ui/node_modules/electron/dist/electron', '#!/bin/sh\nexit 0\n')
        binary = self.fixture / 'ui/node_modules/electron/dist/electron'
        binary.chmod(0o700)
        self.assertIn('PASS ui-smoke', self.call('--leg', 'ui-smoke', env=environment))
        binary.chmod(0o600)
        self.assertIn('BLOCKED ui-smoke', self.call('--leg', 'ui-smoke', expected=2, env=environment))

    def prepare_perf_fixture(self, environment):
        shutil.copyfile(ROOT / 'tools/budget_gate.py', self.fixture / 'tools/budget_gate.py')
        shutil.copyfile(ROOT / 'tests/test_budget_gate.py', self.fixture / 'tests/test_budget_gate.py')
        shutil.copytree(ROOT / 'tests/perf', self.fixture / 'tests/perf', dirs_exist_ok=True)
        shutil.copytree(ROOT / 'ui/electron', self.fixture / 'ui/electron', dirs_exist_ok=True)
        self.prepare_smoke_fixture(environment)
        self.write('fake-xvfb',
                   '#!/bin/sh\n'
                   'while [ "$#" -gt 0 ]; do\n'
                   '  case "$1" in -a) shift ;; -s) shift 2 ;; *) break ;; esac\n'
                   'done\n'
                   'exec "$@"\n')
        (self.fixture / 'fake-xvfb').chmod(0o700)
        self.write('electron-dist/electron',
                   '#!' + sys.executable + '\n'
                   'import json, os, pathlib, sys\n'
                   'if "ELECTRON_RUN_AS_NODE" in os.environ:\n'
                   '    sys.exit(99)\n'
                   'source = os.environ.get("MV_FAKE_PROBE_RECEIPT", "clean.json")\n'
                   'receipt = json.loads((pathlib.Path("tests/perf") / source).read_text())\n'
                   'receipt.setdefault("identities", [])\n'
                   'pathlib.Path(os.environ["MV_RSS_OUTPUT"]).write_text(json.dumps(receipt))\n')
        (self.fixture / 'electron-dist/electron').chmod(0o700)

    def test_perf_leg_negative_controls(self):
        environment = dict(os.environ, ELECTRON_RUN_AS_NODE='1')
        environment.pop('MV_GATE_PERF_LIVE', None)
        self.prepare_perf_fixture(environment)
        # When MV_GATE_PERF_LIVE is unset, the live probe is skipped even when
        # all prerequisites resolve and a failing live receipt is planted.
        output = self.call('--leg', 'perf',
                           env=dict(environment, MV_FAKE_PROBE_RECEIPT='leak-renderer.json'))
        self.assertIn('perf: live probe SKIPPED (MV_GATE_PERF_LIVE not set)', output)
        self.assertIn('PASS perf', output)
        self.assertIn('PASS aggregate', output)
        # Offline checks still gate when MV_GATE_PERF_LIVE is unset.
        clean_path = self.fixture / 'tests/perf/clean.json'
        original_clean = clean_path.read_text()
        try:
            mutated = json.loads(original_clean)
            mutated['samples'][0]['rss_renderer_bytes'] = 370000001
            clean_path.write_text(json.dumps(mutated))
            output = self.call('--leg', 'perf', expected=1, env=environment)
            self.assertIn('FAIL perf', output)
            self.assertIn('FAIL aggregate', output)
        finally:
            clean_path.write_text(original_clean)
        environment['MV_GATE_PERF_LIVE'] = '1'
        output = self.call('--leg', 'perf', env=environment)
        self.assertIn('PASS perf', output)
        self.assertNotIn('SKIPPED', output)
        # Planted failing budget evidence in offline matrix forces leg rc 1.
        try:
            mutated = json.loads(original_clean)
            mutated['samples'][0]['rss_renderer_bytes'] = 370000001
            clean_path.write_text(json.dumps(mutated))
            output = self.call('--leg', 'perf', expected=1, env=environment)
            self.assertIn('FAIL perf', output)
            self.assertIn('FAIL aggregate', output)
        finally:
            clean_path.write_text(original_clean)
        # Negative control: leak-renderer.json exiting 0 must fail the leg.
        gate_py = self.fixture / 'tools/budget_gate.py'
        original_gate_py = gate_py.read_text()
        try:
            gate_py.write_text(original_gate_py.replace(
                "return int(bool(summary['failed']))",
                "return 0 if sys.argv[1:] == ['--receipt', 'tests/perf/leak-renderer.json'] "
                "else int(bool(summary['failed']))"))
            output = self.call('--leg', 'perf', expected=1, env=environment)
            self.assertIn('expected 1', output)
            self.assertIn('FAIL perf', output)
            self.assertIn('FAIL aggregate', output)
        finally:
            gate_py.write_text(original_gate_py)
        # Planted failing budget evidence in live probe forces leg rc 1.
        output = self.call('--leg', 'perf', expected=1,
                           env=dict(environment, MV_FAKE_PROBE_RECEIPT='leak-renderer.json'))
        self.assertIn('FAIL perf', output)
        self.assertIn('FAIL aggregate', output)
        # Missing xvfb-run produces the SKIPPED line and leg rc 0 when offline is green.
        (Path(environment['PATH']) / 'xvfb-run').unlink()
        output = self.call('--leg', 'perf', expected=0, env=environment)
        self.assertIn('perf: live probe SKIPPED (missing xvfb-run)', output)
        self.assertIn('PASS perf', output)
        self.assertIn('PASS aggregate', output)
        # Offline failure still fails the leg when live prerequisites are missing.
        try:
            mutated = json.loads(original_clean)
            mutated['samples'][0]['rss_main_bytes'] = 200000001
            clean_path.write_text(json.dumps(mutated))
            output = self.call('--leg', 'perf', expected=1, env=environment)
            self.assertIn('FAIL perf', output)
            self.assertIn('FAIL aggregate', output)
        finally:
            clean_path.write_text(original_clean)
        (Path(environment['PATH']) / 'xvfb-run').symlink_to(self.fixture / 'fake-xvfb')
        # Missing Electron produces the SKIPPED line and leg rc 0 when offline is green.
        environment.pop('ELECTRON_OVERRIDE_DIST_PATH')
        output = self.call('--leg', 'perf', expected=0, env=environment)
        self.assertIn('perf: live probe SKIPPED (missing electron)', output)
        self.assertIn('PASS perf', output)
        self.assertIn('PASS aggregate', output)
        self.write('ui/node_modules/electron/path.txt', 'electron\n')
        self.write('ui/node_modules/electron/dist/electron',
                   (self.fixture / 'electron-dist/electron').read_text())
        binary = self.fixture / 'ui/node_modules/electron/dist/electron'
        binary.chmod(0o700)
        output = self.call('--leg', 'perf', expected=0, env=environment)
        self.assertNotIn('SKIPPED', output)
        self.assertIn('PASS perf', output)
        binary.chmod(0o600)
        output = self.call('--leg', 'perf', expected=0, env=environment)
        self.assertIn('perf: live probe SKIPPED (missing electron)', output)
        self.assertIn('PASS perf', output)

    def test_rust_leg_negative_controls(self):
        environment = self.prepare_build_fixture()
        self.assertIn('PASS rust', self.call('--leg', 'rust', env=environment))
        locked = (self.fixture / 'Cargo.lock').read_text()
        self.write('Cargo.lock', locked.replace('0.1.0', '0.2.0'))
        self.assertIn('FAIL rust', self.call('--leg', 'rust', expected=1, env=environment))
        self.assertIn('0.2.0', (self.fixture / 'Cargo.lock').read_text())
        self.write('Cargo.lock', locked)
        for source, diagnostic in (
            ('pub fn value()->u32{1}\n', 'fmt'),
            ('pub fn value() -> u32 {\n    return 1;\n}\n', 'clippy'),
            ('#[test]\nfn fails() {\n    panic!("planted");\n}\n', 'test'),
        ):
            with self.subTest(defect=diagnostic):
                self.write('core/src/lib.rs', source)
                output = self.call('--leg', 'rust', expected=1, env=environment)
                self.assertIn('FAIL rust', output)
                self.assertIn("'" + diagnostic + "'", output)

    def test_ui_leg_negative_controls(self):
        environment = self.prepare_build_fixture()
        self.assertIn('PASS ui', self.call('--leg', 'ui', env=environment))
        self.write('ui/test/fixture.test.js',
                   "const {test} = require('node:test'); test('planted', () => {throw Error('planted')});\n")
        output = self.call('--leg', 'ui', expected=1, env=environment)
        self.assertIn('FAIL ui', output)
        self.assertIn('planted', output)
        self.write('ui/test/fixture.test.js',
                   "const {test} = require('node:test'); test('witness', () => {});\n")
        self.write('ui/value.ts', 'const value: number = "wrong";\n')
        output = self.call('--leg', 'ui', expected=1, env=environment)
        self.assertIn('FAIL ui', output)
        self.assertIn('vue-tsc', output)
        self.assertIn('TS2322', output)
        self.write('ui/value.ts', 'const value: number = 1;\n')
        self.write('ui/test/fixture.test.js', "require('gate-undeclared-dependency');\n")
        self.assertIn('MODULE_NOT_FOUND', self.call('--leg', 'ui', expected=1, env=environment))

    def test_build_tools_absent_are_blocked(self):
        environment = self.prepare_build_fixture()
        for leg, variable in (('rust', 'RUSTUP'), ('rust', 'CARGO'),
                              ('ui', 'NODE'), ('ui', 'NPM')):
            with self.subTest(tool=variable):
                child = dict(environment, **{variable: str(self.fixture / 'absent')})
                output = self.call('--leg', leg, expected=2, env=child)
                self.assertIn('BLOCKED ' + leg, output)
                self.assertIn('FAIL aggregate', output)
        rustup = self.fixture / 'absent-toolchain'
        rustup.write_text('#!/bin/sh\nexit 1\n')
        rustup.chmod(0o700)
        self.assertIn('pinned formatter unavailable', self.call(
            '--leg', 'rust', expected=2, env=dict(environment, RUSTUP=str(rustup))))

    def test_aggregation_and_isolation(self):
        self.write('core/src/lib.rs', '')
        self.write('ui/tsconfig.json', '{}')
        self.write('ui/test/fixture.test.js', '')
        # Real new legs have separate positive/negative controls below. Here the
        # subprocess contract is stubbed to isolate aggregate ordering/continuation.
        binary = self.fixture / 'fake-tool'
        binary.write_text('#!' + sys.executable + '\nimport sys\n'
                          'if "-p" in sys.argv: print(24)\n')
        binary.chmod(0o700)
        environment = dict(os.environ, **{key: str(binary) for key in
                           ('RUSTUP', 'CARGO', 'GO', 'NODE', 'NPM', 'VUE_TSC', 'VITE')})
        original_path = environment['PATH']
        self.prepare_smoke_fixture(environment)
        environment['PATH'] += os.pathsep + original_path
        environment['NODE'] = str(binary)
        binary.write_text(binary.read_text() +
                          'if any("smoke" in arg for arg in sys.argv):\n'
                          ' print("METAVIEWER_MAIN_SMOKE_OK" if any("smoke-main" in arg for arg in sys.argv) else "METAVIEWER_SMOKE_OK")\n')
        self.write('tools/sync_kit.mjs', '')
        self.write('ui/kit.lock.json', '{}')
        self.write('tools/budget_gate.py',
                   'import sys\nsys.exit(1 if "--receipt" in sys.argv else 0)\n')
        self.write('tests/test_budget_gate.py',
                   'import unittest\nclass PerfWitness(unittest.TestCase):\n'
                   '    def test_witness(self):\n'
                   '        with open("perf.calls", "a") as f: f.write("asserted\\n")\n'
                   '        self.assertEqual(2 + 2, 4)\n')
        self.write('tests/perf/budgets.json', '{}\n')
        self.write('tests/perf/leak-renderer.json', '{}\n')
        self.write('tests/perf/proc_fields.test.mjs', '')
        environment['MV_KIT_CHECKOUT'] = str(self.fixture)
        # Manifests still use the genuine cargo for frozen metadata resolution.
        cargo = self.fixture / 'fixture-cargo'
        cargo.write_text('#!' + sys.executable + '\nimport os, sys\n'
                         'if sys.argv[1] == "metadata": os.execv(' +
                         repr(shutil.which(os.environ.get('CARGO', 'cargo'))) +
                         ', ["cargo", *sys.argv[1:]])\n')
        cargo.chmod(0o700)
        environment['CARGO'] = str(cargo)
        output = self.call(env=environment)
        self.assertEqual([line for line in output.splitlines() if line in
                          ['PASS ' + leg for leg in LEAVES]], ['PASS ' + leg for leg in LEAVES])
        self.assertEqual((self.fixture / 'unit.calls').read_text(), 'asserted\n')
        self.assertEqual((self.fixture / 'contract.calls').read_text(), 'called\n')
        self.assertEqual((self.fixture / 'agents.calls').read_text(), 'asserted\n')
        self.assertEqual((self.fixture / 'mutant.calls').read_text(), 'asserted\n')
        self.assertTrue((self.fixture / 'perf.calls').is_file())
        agents_test = self.fixture / 'agents/tests/test_witness.py'
        original_agents_test = agents_test.read_text()
        original_mutant_harness = (self.fixture / 'agents/tests/run_mutant_harness.py').read_text()
        agents_test.write_text('import unittest\nclass T(unittest.TestCase):\n'
                               ' def test_failure(self): self.fail("planted agents failure")\n')
        output = self.call(expected=1, env=environment)
        self.assertIn('planted agents failure', output)
        self.assertIn('FAIL agents\n', output)
        self.assertIn('FAIL aggregate\n', output)
        self.assertIn('PASS ui-smoke\n', output)
        self.assertIn('PASS perf\n', output)
        shutil.rmtree(agents_test.parent)
        output = self.call(expected=1, env=environment)
        self.assertIn('missing target: agents/tests', output)
        self.assertIn('FAIL agents\n', output)
        self.assertIn('FAIL aggregate\n', output)
        self.assertNotIn('PASS agents', output)
        self.write('agents/tests/test_witness.py', original_agents_test)
        self.write('agents/tests/run_mutant_harness.py', original_mutant_harness)
        self.call('--leg', 'laws')
        scratch = (self.fixture / 'scratch.calls').read_text().splitlines()
        self.assertEqual(scratch[0], scratch[1])
        self.assertNotEqual(scratch[0], scratch[2])
        self.assertTrue(all(not Path(path).exists() for path in scratch))
        self.write('Cargo.toml', 'broken')
        output = self.call('--leg', 'skeleton', expected=1, env=environment)
        self.assertIn('FAIL aggregate', output)
        self.assertIn('PASS unit', output)
        (self.fixture / 'tools/check_contracts.py').unlink()
        self.assertIn('FAIL aggregate', self.call(expected=2, env=environment))

    def test_bounded_cleanup(self):
        saved = {key: os.environ.get(key) for key in SANITIZED_ENV_KEYS}
        try:
            for key in ('LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'PYTHONPATH',
                        'BASH_ENV', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS'):
                os.environ[key] = '/tmp/planted-injected-value'
            with private_environment() as (_, environment):
                for key in ('LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'PYTHONPATH',
                            'BASH_ENV', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS'):
                    self.assertNotIn(key, environment)
                paths = [Path(environment[key]) for key in
                         ('TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR')]
                self.assertEqual(len(set(paths)), len(paths))
                self.assertTrue(all(path.stat().st_mode & 0o777 == 0o700 for path in paths))
                marker = Path(self.temp.name) / 'pid'
                code = ("import os,time,pathlib; pathlib.Path(" + repr(str(marker)) +
                        ").write_text(str(os.getpid())); time.sleep(30)")
                self.assertEqual(bounded([sys.executable, '-c', code], self.fixture,
                                         environment, seconds=0.2), 124)
                pid = int(marker.read_text())
                self.assertFalse(Path('/proc', str(pid)).exists())
                parent_marker = Path(self.temp.name) / 'parent'
                child_marker = Path(self.temp.name) / 'child'
                code = (
                    "import os,pathlib,signal,subprocess,sys,time; "
                    "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); "
                    "pathlib.Path(" + repr(str(parent_marker)) + ").write_text(str(os.getpid())); "
                    "pathlib.Path(" + repr(str(child_marker)) + ").write_text(str(child.pid)); "
                    "signal.signal(signal.SIGTERM,lambda *_: (child.wait(),sys.exit(0))); time.sleep(30)")
                self.assertEqual(bounded([sys.executable, '-c', code], self.fixture,
                                         environment, seconds=0.2), 124)
                for marker_path in (parent_marker, child_marker):
                    self.assertFalse(Path('/proc', marker_path.read_text()).exists())
                late_parent = Path(self.temp.name) / 'late-parent'
                late_child = Path(self.temp.name) / 'late-child'
                late_code = (
                    "import os,pathlib,signal,subprocess,sys,time\n"
                    "def on_term(*_):\n"
                    "    c = subprocess.Popen([sys.executable,'-c','import signal,time; "
                    "signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)'])\n"
                    "    pathlib.Path(" + repr(str(late_child)) + ").write_text(str(c.pid))\n"
                    "    time.sleep(30)\n"
                    "signal.signal(signal.SIGTERM, on_term)\n"
                    "pathlib.Path(" + repr(str(late_parent)) + ").write_text(str(os.getpid()))\n"
                    "time.sleep(30)\n"
                )
                self.assertEqual(bounded([sys.executable, '-c', late_code], self.fixture,
                                         environment, seconds=0.2), 124)
                for marker_path in (late_parent, late_child):
                    self.assertFalse(Path('/proc', marker_path.read_text()).exists())
                setsid_parent = Path(self.temp.name) / 'setsid-parent'
                setsid_grandchild = Path(self.temp.name) / 'setsid-grandchild'
                setsid_code = (
                    "import os,pathlib,sys,time\n"
                    "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\n"
                    "r, w = os.pipe()\n"
                    "mid = os.fork()\n"
                    "if mid == 0:\n"
                    "    os.close(r)\n"
                    "    gc = os.fork()\n"
                    "    if gc == 0:\n"
                    "        os.setsid()\n"
                    "        pathlib.Path(sys.argv[2]).write_text(str(os.getpid()))\n"
                    "        os.close(w)\n"
                    "        time.sleep(30)\n"
                    "    os._exit(0)\n"
                    "os.close(w)\n"
                    "os.waitpid(mid, 0)\n"
                    "os.read(r, 1)\n"
                    "time.sleep(30)\n"
                )
                self.assertEqual(bounded([sys.executable, '-c', setsid_code,
                                          str(setsid_parent), str(setsid_grandchild)],
                                         self.fixture, environment, seconds=0.2), 124)
                for marker_path in (setsid_parent, setsid_grandchild):
                    self.assertFalse(Path('/proc', marker_path.read_text()).exists())
                # Child exiting 0 after spawning a setsid background sleeper must
                # still have its reparented sleeper reaped, while unrelated sibling survives.
                exit0_grandchild = Path(self.temp.name) / 'exit0-setsid-grandchild'
                exit0_code = (
                    "import os,pathlib,sys,time\n"
                    "r, w = os.pipe()\n"
                    "mid = os.fork()\n"
                    "if mid == 0:\n"
                    "    os.close(r)\n"
                    "    gc = os.fork()\n"
                    "    if gc == 0:\n"
                    "        os.setsid()\n"
                    "        pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\n"
                    "        os.close(w)\n"
                    "        time.sleep(2)\n"
                    "        os._exit(0)\n"
                    "    os._exit(0)\n"
                    "os.close(w)\n"
                    "os.waitpid(mid, 0)\n"
                    "os.read(r, 1)\n"
                    "sys.exit(0)\n"
                )
                sentinel = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(2)'],
                                            start_new_session=True)
                try:
                    self.assertEqual(bounded([sys.executable, '-c', exit0_code,
                                              str(exit0_grandchild)],
                                             self.fixture, environment, seconds=5), 0)
                    self.assertTrue(exit0_grandchild.is_file())
                    self.assertFalse(Path('/proc', exit0_grandchild.read_text().strip()).exists())
                    self.assertIsNone(sentinel.poll())
                finally:
                    sentinel.kill()
                    sentinel.wait()
                # Non-LIFO overlapping scopes: Scope A closes before Scope B;
                # subreaper stays enabled until Scope B closes.
                libc = ctypes.CDLL(None)
                scope_a = subreaper_scope()
                scope_b = subreaper_scope()
                scope_a.__enter__()
                scope_b.__enter__()
                scope_a.__exit__(None, None, None)
                subreaper = ctypes.c_int(-1)
                if libc.prctl(37, ctypes.byref(subreaper), 0, 0, 0) == 0:
                    self.assertEqual(subreaper.value, 1)
                scope_b_gc = Path(self.temp.name) / 'scope-b-gc'
                self.assertEqual(bounded([sys.executable, '-c', exit0_code, str(scope_b_gc)],
                                         self.fixture, environment, seconds=5), 0)
                self.assertFalse(Path('/proc', scope_b_gc.read_text().strip()).exists())
                if libc.prctl(37, ctypes.byref(subreaper), 0, 0, 0) == 0:
                    self.assertEqual(subreaper.value, 1)
                scope_b.__exit__(None, None, None)
                if libc.prctl(37, ctypes.byref(subreaper), 0, 0, 0) == 0:
                    self.assertEqual(subreaper.value, 0)
        finally:
            for key, val in saved.items():
                if val is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = val
        self.assertTrue(all(not path.exists() for path in paths))

    def test_descendants_ignores_later_sibling(self):
        first = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'],
                                 start_new_session=True)
        second = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'],
                                  start_new_session=True)
        try:
            self.assertNotIn(second.pid, descendants(first.pid))
        finally:
            for proc in (first, second):
                proc.kill()
                proc.wait()
        libc = ctypes.CDLL(None)
        subreaper = ctypes.c_int(-1)
        if libc.prctl(36, 1, 0, 0, 0) == 0:
            try:
                with private_environment() as (_, environment):
                    self.assertEqual(bounded([sys.executable, '-c', 'pass'],
                                             self.fixture, environment, seconds=5), 0)
                if libc.prctl(37, ctypes.byref(subreaper), 0, 0, 0) == 0:
                    self.assertEqual(subreaper.value, 1)
            finally:
                libc.prctl(36, 0, 0, 0, 0)

    def test_ui_smoke_reaps_setsid_grandchild(self):
        environment = dict(os.environ)
        self.prepare_smoke_fixture(environment)
        environment['NODE'] = sys.executable
        setsid_parent = Path(self.temp.name) / 'smoke-setsid-parent'
        setsid_grandchild = Path(self.temp.name) / 'smoke-setsid-grandchild'
        self.write(
            'ui/test/smoke.mjs',
            "import os,pathlib,time\n"
            f"pathlib.Path({str(setsid_parent)!r}).write_text(str(os.getpid()))\n"
            "r, w = os.pipe()\n"
            "mid = os.fork()\n"
            "if mid == 0:\n"
            "    os.close(r)\n"
            "    gc = os.fork()\n"
            "    if gc == 0:\n"
            "        os.setsid()\n"
            f"        pathlib.Path({str(setsid_grandchild)!r}).write_text(str(os.getpid()))\n"
            "        os.close(w)\n"
            "        time.sleep(30)\n"
            "    os._exit(0)\n"
            "os.close(w)\n"
            "os.waitpid(mid, 0)\n"
            "os.read(r, 1)\n"
            "time.sleep(30)\n",
        )
        self.assertEqual(ui_smoke_leg(self.fixture, environment, timeout=0.2), 124)
        for marker_path in (setsid_parent, setsid_grandchild):
            self.assertTrue(marker_path.is_file())
            self.assertFalse(Path('/proc', marker_path.read_text()).exists())
        exit0_gc = Path(self.temp.name) / 'smoke-exit0-setsid-gc'
        self.write(
            'ui/test/smoke.mjs',
            "import os,pathlib,time\n"
            "r, w = os.pipe()\n"
            "mid = os.fork()\n"
            "if mid == 0:\n"
            "    os.close(r)\n"
            "    gc = os.fork()\n"
            "    if gc == 0:\n"
            "        os.setsid()\n"
            f"        pathlib.Path({str(exit0_gc)!r}).write_text(str(os.getpid()))\n"
            "        os.close(w)\n"
            "        time.sleep(2)\n"
            "        os._exit(0)\n"
            "    os._exit(0)\n"
            "os.close(w)\n"
            "os.waitpid(mid, 0)\n"
            "os.read(r, 1)\n"
            "print('METAVIEWER_SMOKE_OK', flush=True)\n",
        )
        self.write('ui/test/smoke-main.mjs', 'print("METAVIEWER_MAIN_SMOKE_OK", flush=True)\n')
        self.assertEqual(ui_smoke_leg(self.fixture, environment, timeout=5), 0)
        self.assertTrue(exit0_gc.is_file())
        self.assertFalse(Path('/proc', exit0_gc.read_text().strip()).exists())

    def test_frozen_dependencies_scrubbed_environment(self):
        bin_dir = Path(self.temp.name) / 'frozen-bin'
        bin_dir.mkdir()
        env_log = Path(self.temp.name) / 'frozen-env.jsonl'
        for tool_name in ('rustc', 'cargo', 'npm'):
            script = bin_dir / tool_name
            script.write_text(
                '#!' + sys.executable + '\n'
                'import json, os, pathlib, sys\n'
                f'entry = {{"tool": {tool_name!r}, '
                '"NODE_OPTIONS": os.environ.get("NODE_OPTIONS"), '
                '"RUSTFLAGS": os.environ.get("RUSTFLAGS"), '
                '"CARGO_ENCODED_RUSTFLAGS": os.environ.get("CARGO_ENCODED_RUSTFLAGS"), '
                '"TMPDIR": os.environ.get("TMPDIR")}\n'
                f'with open({str(env_log)!r}, "a", encoding="utf-8") as f:\n'
                '    f.write(json.dumps(entry) + "\\n")\n'
                'if "-vV" in sys.argv:\n'
                '    print("rustc 1.97.0\\nhost: aarch64-unknown-linux-gnu")\n'
            )
            script.chmod(0o700)
        saved_node = os.environ.get('NODE_OPTIONS')
        saved_rust = os.environ.get('RUSTFLAGS')
        saved_enc = os.environ.get('CARGO_ENCODED_RUSTFLAGS')
        try:
            os.environ['NODE_OPTIONS'] = '--poisoned-node-option'
            os.environ['RUSTFLAGS'] = '-C poisoned-rustflag'
            os.environ['CARGO_ENCODED_RUSTFLAGS'] = '-C poisoned-encoded'
            with private_environment() as (_, scrubbed):
                scrubbed['PATH'] = str(bin_dir) + os.pathsep + scrubbed.get('PATH', '')
                scrubbed['RUSTC'] = str(bin_dir / 'rustc')
                scrubbed['CARGO'] = str(bin_dir / 'cargo')
                scrubbed['NPM'] = str(bin_dir / 'npm')
                validate_frozen_dependencies(self.fixture, scrubbed)
                records = [json.loads(line) for line in env_log.read_text().splitlines()]
                self.assertEqual([r['tool'] for r in records], ['rustc', 'cargo', 'npm'])
                for rec in records:
                    self.assertIsNone(rec['NODE_OPTIONS'])
                    self.assertIsNone(rec['RUSTFLAGS'])
                    self.assertIsNone(rec['CARGO_ENCODED_RUSTFLAGS'])
                    self.assertEqual(rec['TMPDIR'], scrubbed['TMPDIR'])
        finally:
            for key, val in (('NODE_OPTIONS', saved_node),
                             ('RUSTFLAGS', saved_rust),
                             ('CARGO_ENCODED_RUSTFLAGS', saved_enc)):
                if val is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = val

    def test_leaf_timeout_124_and_precedence(self):
        environment = self.prepare_build_fixture()
        bin_dir = Path(self.temp.name) / 'timeout-bin'
        bin_dir.mkdir()
        stub = bin_dir / 'stub-tool'
        stub.write_text(
            '#!' + sys.executable + '\n'
            'import os, sys\n'
            'if "-p" in sys.argv:\n'
            '    print("24")\n'
            '    sys.exit(0)\n'
            'if "--version" in sys.argv:\n'
            '    sys.exit(0)\n'
            'sys.exit(int(os.environ.get("MV_STUB_RC", "124")))\n'
        )
        stub.chmod(0o700)
        for key in ('RUSTUP', 'CARGO', 'GO', 'NODE', 'NPM', 'VUE_TSC', 'VITE'):
            environment[key] = str(stub)
        with private_environment() as (_, scrubbed):
            scrubbed.update(environment)
            scrubbed['MV_STUB_RC'] = '124'
            self.assertEqual(build_leg('rust', self.fixture, scrubbed), 124)
            self.assertEqual(build_leg('ui', self.fixture, scrubbed), 124)
            self.assertEqual(go_leg(self.fixture, scrubbed), 124)
            # Negative control: normal nonzero exit still maps to 1.
            scrubbed['MV_STUB_RC'] = '7'
            self.assertEqual(build_leg('rust', self.fixture, scrubbed), 1)
            self.assertEqual(build_leg('ui', self.fixture, scrubbed), 1)
            self.assertEqual(go_leg(self.fixture, scrubbed), 1)


def validate_rust_dependencies(table, section):
    require(isinstance(table, dict), section + ': expected dependency table')
    allowed = RUST_DEPENDENCIES | ({'proptest'} if section == 'dev-dependencies' else set())
    for name, specification in table.items():
        require(name in allowed, section + ': unlisted dependency: ' + name)
        if isinstance(specification, dict):
            require(set(specification) <= {'version', 'features', 'optional', 'default-features'},
                    name + ': unsupported dependency source or option')
            if 'features' in specification:
                require(isinstance(specification['features'], list) and
                        all(isinstance(feature, str) for feature in specification['features']),
                        name + ': invalid features')
            for flag in ('optional', 'default-features'):
                if flag in specification:
                    require(type(specification[flag]) is bool, name + ': invalid ' + flag)
            specification = specification.get('version')
        require(isinstance(specification, str) and re.fullmatch(
            r'=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)'
            r'(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', specification),
            name + ': Rust dependency must use an exact =version')


def validate_npm_dependencies(table, pins):
    require(isinstance(table, dict), 'package.json: expected dependency object')
    for name, version in table.items():
        require(name in pins and version == pins[name],
                'package.json: unlisted or unpinned dependency: ' + name)
    require(set(table) == set(pins), 'package.json: incomplete dependency closure: ' +
            ', '.join(sorted(set(pins) - set(table))))


# [TARGET, unit decision] Admission pins the complete component release identities.
# Frozen package-manager resolution runs only in disposable manifest-only trees;
# no installs, lifecycle scripts, network access or repository writes are admitted.
COMPONENT_PINS = {
    'vision-engine': ('python_package', 'oguirado/vision-engine', 'v0.2.0',
                      '3bb54835db8a2e545311cfcc45185a0dfbd9313a'),
    'wender-agent': ('python_package', 'oguirado/wender-agent', 'v0.3.0',
                     '96120967b435b72fc6d29635f3844dae140388a9'),
    'opensuperficies': ('go_binary', 'oguirado/OpenSuperficies', 'os-cu-w9-mv1',
                       'a9ac1ac8543872b428990ea23fa2629cd0a6d1d5'),
}


def validate_frozen_dependencies(root, environment=None):
    if environment is None:
        with private_environment() as (_, scrubbed):
            return validate_frozen_dependencies(root, scrubbed)
    child_env = dict(environment)
    for key in SANITIZED_ENV_KEYS:
        child_env.pop(key, None)
    data = json.loads((root / 'deps.lock').read_text())
    require(isinstance(data, dict) and set(data) == {'components'} and
            isinstance(data['components'], list), 'deps.lock: expected component list')
    seen = set()
    for component in data['components']:
        require(isinstance(component, dict), 'deps.lock: expected component object')
        name = component.get('name')
        require(isinstance(name, str) and name in COMPONENT_PINS,
                'deps.lock: unknown component: ' + str(name))
        require(name not in seen, 'deps.lock: duplicate component: ' + name)
        seen.add(name)
        commit = component.get('commit')
        require(isinstance(commit, str) and re.fullmatch(r'[0-9a-f]{40}', commit),
                'deps.lock: ' + name + ': commit must be full 40-character lowercase hex')
        expected = dict(zip(('kind', 'repo', 'version', 'commit'), COMPONENT_PINS[name]))
        require(component == dict(name=name, **expected), 'deps.lock: ' + name + ': release pin drift')
    require(seen == set(COMPONENT_PINS), 'deps.lock: incomplete component closure')
    for name in ('Cargo.lock', 'ui/package-lock.json'):
        require((root / name).is_file(), name + ': missing frozen resolution')
    package = json.loads((root / 'ui/package.json').read_text())
    lock = json.loads((root / 'ui/package-lock.json').read_text())
    require(isinstance(lock, dict) and lock.get('lockfileVersion') == 3 and
            isinstance(lock.get('packages'), dict), 'package-lock.json: invalid lock format')
    locked_root = lock['packages'].get('')
    require(isinstance(locked_root, dict), 'package-lock.json: missing root package')
    require(lock.get('version') == package.get('version'),
            'package-lock.json: stale release version')
    for key in ('name', 'version', 'dependencies', 'devDependencies', 'engines'):
        require(locked_root.get(key) == package.get(key), 'package-lock.json: stale root ' + key)
    # Cargo resolves only the current host's graph: cross-platform archives need not
    # be present in the offline cache. --locked still checks the full lock resolution.
    rustc = shutil.which(child_env.get('RUSTC', 'rustc'), path=child_env.get('PATH'))
    cargo = shutil.which(child_env.get('CARGO', 'cargo'), path=child_env.get('PATH'))
    require(rustc is not None and cargo is not None, 'Cargo.lock: missing Rust toolchain')
    identity = subprocess.run([rustc, '-vV'], env=child_env,
                              capture_output=True, text=True, timeout=30)
    host = re.search(r'^host: (\S+)$', identity.stdout, re.MULTILINE)
    require(identity.returncode == 0 and host is not None, 'Cargo.lock: unproven Rust host')
    npm = shutil.which(child_env.get('NPM', 'npm'), path=child_env.get('PATH'))
    require(npm is not None, 'package-lock.json: missing npm')
    with tempfile.TemporaryDirectory(prefix='metaviewer-frozen-') as temporary:
        scratch = Path(temporary)
        for name in ('Cargo.toml', 'core/Cargo.toml', 'Cargo.lock',
                     'ui/package.json', 'ui/package-lock.json'):
            target = scratch / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / name, target)
        (scratch / 'core/src').mkdir()
        (scratch / 'core/src/lib.rs').write_text('')
        commands = (
            ('Cargo.lock', [cargo, 'metadata', '--offline', '--locked', '--format-version', '1',
                            '--filter-platform', host.group(1)], scratch),
            ('package-lock.json', [npm, 'ci', '--offline', '--ignore-scripts', '--dry-run',
                                  '--no-audit', '--no-fund'], scratch / 'ui'),
        )
        for name, command, directory in commands:
            result = subprocess.run(command, cwd=directory, env=child_env,
                                    capture_output=True, text=True, timeout=60)
            require(result.returncode == 0, name + ': frozen offline resolution failed: ' +
                    (result.stderr + result.stdout)[-4000:])


def validate_manifests(root, environment=None):
    version = (root / 'VERSION').read_text().strip()
    require(bool(version), 'VERSION: missing release version')
    expected = {
        'Cargo.toml': {
            'workspace': {'resolver': '2', 'members': ['core'], 'package': {
                'version': version, 'edition': '2021', 'publish': False, 'rust-version': '1.97'}},
            'profile': {'release': {'overflow-checks': True}}},
        'core/Cargo.toml': {'package': {'name': 'metaviewer-core', **{
            key: {'workspace': True} for key in ('version', 'edition', 'publish', 'rust-version')}},
            },
        'agents/pyproject.toml': {'project': {'name': 'metaviewer-agents', 'version': version,
                                            'requires-python': '>=3.11', 'dependencies': []}},
    }
    for name, wanted in expected.items():
        actual = tomllib.loads((root / name).read_text())
        if name in ('Cargo.toml', 'core/Cargo.toml'):
            for section in ('dependencies', 'dev-dependencies', 'build-dependencies'):
                if section in actual:
                    validate_rust_dependencies(actual.pop(section), section)
            workspace = actual.get('workspace', {})
            if 'dependencies' in workspace:
                validate_rust_dependencies(workspace.pop('dependencies'), 'dependencies')
        require(json.dumps(actual, sort_keys=True) == json.dumps(wanted, sort_keys=True),
                name + ': metadata drift')
    require(re.fullmatch(r'module metaviewer/daemon-adapter[ \t]*\n(?:[ \t]*\n)*go 1\.26\.0[ \t]*\n?',
                         (root / 'daemon-adapter/go.mod').read_text()), 'go.mod: metadata drift')
    package = json.loads((root / 'ui/package.json').read_text())
    require(isinstance(package, dict), 'package.json: expected object')
    validate_npm_dependencies(package.pop('dependencies', {}), DEPENDENCIES)
    validate_npm_dependencies(package.pop('devDependencies', {}), DEV_DEPENDENCIES)
    # The shell's admitted smoke command is optional; all other scripts stay pinned.
    if isinstance(package.get('scripts'), dict) and 'smoke' in package['scripts']:
        require(package['scripts'].pop('smoke') == 'node test/smoke.mjs',
                'package.json: smoke script drift')
    # The nested package build command is optional and admitted verbatim.
    if isinstance(package.get('scripts'), dict) and 'package' in package['scripts']:
        require(package['scripts'].pop('package') == 'node tools/package.js',
                'package.json: package script drift')
    wanted = {'name': 'metaviewer-ui', 'version': version, 'private': True,
                        'type': 'module', 'main': 'electron/main.js', 'engines': {'node': '>=24'},
                        'scripts': SCRIPTS}
    require(json.dumps(package, sort_keys=True) == json.dumps(wanted, sort_keys=True),
            'package.json: metadata drift')
    validate_frozen_dependencies(root, environment)
    patterns = (root / '.gitignore').read_text().splitlines()
    require(all(pattern in patterns for pattern in (*ORIGINAL_IGNORE, *REQUIRED_IGNORE)),
            '.gitignore: missing exclusion')
    protected = ('VERSION', 'deps.lock', *FILES[:-1], 'Cargo.lock',
                 'ui/package-lock.json', 'daemon-adapter/go.sum')
    for pattern in patterns:
        if not pattern or pattern.startswith(('#', '!')):
            continue
        pattern = pattern.lstrip('/').rstrip('/')
        for name in protected:
            parts = Path(name).parts
            candidates = ['/'.join(parts[:i]) for i in range(1, len(parts) + 1)]
            if '/' not in pattern:
                candidates += list(parts)
            require(not any(fnmatch.fnmatchcase(value, pattern) for value in candidates),
                    '.gitignore: protected file exclusion: ' + name)


# Keep the shared laws checker unchanged: exclude only the local stash ref from
# its all-ref walk. Branch/tag commits remain checked, even if also in the stash.
LAWS_CODE = '''import runpy, subprocess
from unittest.mock import patch
original = subprocess.check_output
def history_output(argv, *args, **kwargs):
    if argv == ['git', 'rev-list', '--all']:
        argv = ['git', 'rev-list', '--exclude=refs/stash', '--all']
    return original(argv, *args, **kwargs)
with patch('subprocess.check_output', side_effect=history_output):
    runpy.run_path('tools/check_laws.py', run_name='__main__')
'''


# [TARGET, unit decision] Discover offline unit suites in tests/e2e/e2e1_slice
# (which is not a Python package under tests/) alongside top-level tests/.
UNIT_CODE = '''import os, sys, unittest
suite = unittest.defaultTestLoader.discover(start_dir="tests")
if os.path.isdir("tests/e2e/e2e1_slice"):
    suite.addTests(unittest.defaultTestLoader.discover(
        start_dir="tests/e2e/e2e1_slice", top_level_dir="tests/e2e/e2e1_slice"))
if suite.countTestCases() == 0:
    print("empty test selection; refusing silent pass", file=sys.stderr)
    sys.exit(2)
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(0 if result.wasSuccessful() and not
         (result.skipped or result.expectedFailures or result.unexpectedSuccesses) else 1)
'''

AGENTS_UNIT_CODE = '''import sys, unittest
suite = unittest.defaultTestLoader.discover(start_dir="agents/tests")
if suite.countTestCases() == 0:
    print("empty test selection; refusing silent pass", file=sys.stderr)
    sys.exit(1)
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(0 if result.wasSuccessful() and result.testsRun > 0 and not
         (result.skipped or result.expectedFailures or result.unexpectedSuccesses) else 1)
'''


SANITIZED_ENV_KEYS = (
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG',
    'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONINSPECT',
    'BASH_ENV', 'ENV', 'DYLD_INSERT_LIBRARIES',
    'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTDOCFLAGS',
    'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER',
)

class subreaper_scope:
    def __init__(self):
        self._token = None

    def __enter__(self):
        import threading
        state = stop_process_tree.__dict__
        lock = state.setdefault('_lock', threading.Lock())
        with lock:
            scopes = state.setdefault('_scopes', set())
            token = object()
            self._token = token
            try:
                import ctypes
                libc = ctypes.CDLL(None)
                if not scopes:
                    current = ctypes.c_int(0)
                    state['_prior'] = (
                        current.value if libc.prctl(37, ctypes.byref(current), 0, 0, 0) == 0 else None
                    )
                libc.prctl(36, 1, 0, 0, 0)
            except Exception:
                pass
            scopes.add(token)
        return self

    def __exit__(self, kind, value, traceback):
        import threading
        state = stop_process_tree.__dict__
        lock = state.setdefault('_lock', threading.Lock())
        with lock:
            scopes = state.setdefault('_scopes', set())
            if self._token is not None:
                scopes.discard(self._token)
                self._token = None
                if not scopes:
                    prior = state.pop('_prior', None)
                    try:
                        import ctypes
                        ctypes.CDLL(None).prctl(36, 1 if prior else 0, 0, 0, 0)
                    except Exception:
                        pass


def register_subreaper_token(process, token):
    token_bytes = token if isinstance(token, bytes) else f'MV_SUBREAPER_TOKEN={token}'.encode()
    ident = process_identity(process.pid)
    process._subreaper_token = token_bytes
    process._start_time = ident
    tokens = descendants.__dict__.setdefault('_tokens', {})
    tokens[process.pid] = (token_bytes, ident)
    if ident is not None:
        tokens[(process.pid, ident)] = token_bytes


def descendants(parent):
    children = {}
    caller_pid = os.getpid()
    caller_pgrp = os.getpgrp()
    parent_start = process_identity(parent) if type(parent) is int and parent > 1 else None
    tokens = descendants.__dict__.setdefault('_tokens', {})
    parent_token = None
    if type(parent) is int and parent > 1:
        try:
            for item in Path('/proc', str(parent), 'environ').read_bytes().split(b'\0'):
                if item.startswith(b'MV_SUBREAPER_TOKEN=') and len(item) > 19:
                    parent_token = item
                    if parent_start is not None:
                        tokens[(parent, parent_start)] = item
                        tokens[parent] = (item, parent_start)
                    break
        except OSError:
            pass
        if parent_token is None and parent_start is not None:
            parent_token = tokens.get((parent, parent_start))
        if parent_token is None:
            recorded = tokens.get(parent)
            if isinstance(recorded, tuple):
                parent_token, recorded_start = recorded
                if parent_start is None:
                    parent_start = recorded_start
            elif isinstance(recorded, bytes):
                parent_token = recorded
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            pid = int(path.parent.name)
            fields = path.read_text().rsplit(')', 1)[1].split()
            ppid = int(fields[1])
            children.setdefault(ppid, []).append(pid)
            if type(parent) is int and parent > 1 and parent != caller_pgrp and len(fields) > 19:
                pgrp, sid = int(fields[2]), int(fields[3])
                if pgrp == parent or sid == parent:
                    children.setdefault(parent, []).append(pid)
                elif (parent_token is not None and ppid == caller_pid and pgrp != caller_pgrp and
                      (parent_start is None or int(fields[19]) >= int(parent_start))):
                    try:
                        if parent_token in path.parent.joinpath('environ').read_bytes().split(b'\0'):
                            children.setdefault(parent, []).append(pid)
                    except OSError:
                        pass
        except (FileNotFoundError, ProcessLookupError, ValueError):
            continue
    found = []
    seen = set()
    pending = [parent]
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        found.append(current)
        pending.extend(children.get(current, ()))
    return found


def stop_process_tree(process):
    # Only a recorded child tree in a separate session may receive signals.
    import threading
    state = stop_process_tree.__dict__
    lock = state.setdefault('_lock', threading.Lock())
    scope_token = object()
    with lock:
        scopes = state.setdefault('_scopes', set())
        try:
            import ctypes
            libc = ctypes.CDLL(None)
            if not scopes:
                current = ctypes.c_int(0)
                state['_prior'] = (
                    current.value if libc.prctl(37, ctypes.byref(current), 0, 0, 0) == 0 else None
                )
            libc.prctl(36, 1, 0, 0, 0)
        except Exception:
            pass
        scopes.add(scope_token)
    token = getattr(process, '_subreaper_token', None)
    ident = getattr(process, '_start_time', None) or process_identity(process.pid)
    tokens = descendants.__dict__.setdefault('_tokens', {}) if hasattr(descendants, '__dict__') else {}
    if isinstance(token, bytes):
        tokens[process.pid] = (token, ident)
        if ident is not None:
            tokens[(process.pid, ident)] = token
    pids = {}

    def refresh_pids():
        roots = [process.pid, *[pid for pid, pid_ident in pids.items()
                                if pid_ident is not None and process_identity(pid) == pid_ident]]
        visited = set()
        for root_pid in roots:
            if root_pid in visited:
                continue
            for pid in descendants(root_pid):
                visited.add(pid)
                if pid not in pids:
                    pids[pid] = process_identity(pid)

    try:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            refresh_pids()
            signaled = False
            for pid in reversed(list(pids)):
                if type(pid) is not int or pid <= 1 or pid == os.getpid():
                    raise ValueError('unsafe child pid')
                try:
                    if pids[pid] is None or process_identity(pid) != pids[pid]:
                        continue
                    if os.getpgid(pid) == os.getpgrp():
                        raise ValueError('child shares caller process group')
                    os.kill(pid, sig)
                    signaled = True
                except ProcessLookupError:
                    continue
            if sig == signal.SIGTERM and signaled:
                for _ in range(5):
                    time.sleep(0.01)
                    refresh_pids()
        refresh_pids()
        process.wait()
        for pid in pids:
            if type(pid) is int and pid > 1 and pid != process.pid:
                for _ in range(20):
                    try:
                        wpid, _ = os.waitpid(pid, os.WNOHANG)
                        if wpid == pid or not Path('/proc', str(pid)).exists():
                            break
                        time.sleep(0.005)
                    except ChildProcessError:
                        if not Path('/proc', str(pid)).exists():
                            break
                        time.sleep(0.005)
    finally:
        tokens.pop(process.pid, None)
        if ident is not None:
            tokens.pop((process.pid, ident), None)
        with lock:
            scopes = state.setdefault('_scopes', set())
            scopes.discard(scope_token)
            if not scopes:
                prior = state.pop('_prior', None)
                try:
                    import ctypes
                    ctypes.CDLL(None).prctl(36, 1 if prior else 0, 0, 0, 0)
                except Exception:
                    pass


def process_identity(pid):
    try:
        return Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def bounded(argv, cwd, environment, seconds=300):
    import threading
    state = stop_process_tree.__dict__
    lock = state.setdefault('_lock', threading.Lock())
    scope_token = object()
    with lock:
        scopes = state.setdefault('_scopes', set())
        try:
            import ctypes
            libc = ctypes.CDLL(None)
            if not scopes:
                current = ctypes.c_int(0)
                state['_prior'] = (
                    current.value if libc.prctl(37, ctypes.byref(current), 0, 0, 0) == 0 else None
                )
            libc.prctl(36, 1, 0, 0, 0)
        except Exception:
            pass
        scopes.add(scope_token)
    process = None
    token = f'{os.getpid()}:{time.monotonic_ns()}:{os.urandom(8).hex()}'
    child_env = dict(environment, MV_SUBREAPER_TOKEN=token)
    try:
        process = subprocess.Popen(argv, cwd=cwd, env=child_env, start_new_session=True)
        token_bytes = f'MV_SUBREAPER_TOKEN={token}'.encode()
        ident = process_identity(process.pid)
        process._subreaper_token = token_bytes
        process._start_time = ident
        if hasattr(descendants, '__dict__'):
            tokens = descendants.__dict__.setdefault('_tokens', {})
            tokens[process.pid] = (token_bytes, ident)
            if ident is not None:
                tokens[(process.pid, ident)] = token_bytes
        try:
            return process.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            print('timeout: ' + repr(argv), file=sys.stderr)
            return 124
    finally:
        try:
            if process is not None:
                stop_process_tree(process)
        finally:
            with lock:
                scopes = state.setdefault('_scopes', set())
                scopes.discard(scope_token)
                if not scopes:
                    prior = state.pop('_prior', None)
                    try:
                        import ctypes
                        ctypes.CDLL(None).prctl(36, 1 if prior else 0, 0, 0, 0)
                    except Exception:
                        pass


class private_environment:
    def __enter__(self):
        path = subprocess.check_output(['mktemp', '-d'], text=True).strip()
        self.path = Path(path)
        self.path.chmod(0o700)
        environment = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
        for key in SANITIZED_ENV_KEYS:
            environment.pop(key, None)
        for key in ('TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'):
            target = self.path / key.lower()
            target.mkdir(mode=0o700)
            environment[key] = str(target)
        return self.path, environment

    def __exit__(self, kind, value, traceback):
        shutil.rmtree(self.path)


# [TARGET, unit decision] Offline installs may run native build scripts, but
# Electron's network downloader is disabled; smoke requires an explicit local dist.
# All tool overrides are executable paths/names, never shell command fragments.
def build_leg(leg, root, environment):
    names = ('rustup', 'cargo') if leg == 'rust' else ('node', 'npm')
    tools = {}
    for name in names:
        tool = shutil.which(environment.get(name.upper(), name), path=environment.get('PATH'))
        if tool is None:
            print(f'{leg}: missing tool: {name}', file=sys.stderr)
            return 2
        tools[name] = tool
    child = dict(environment)
    if leg == 'rust':
        # rustup run must never attempt to fetch an absent pinned toolchain.
        probe = subprocess.run([tools['rustup'], 'run', '1.92.0', 'cargo', 'fmt', '--version'],
                               env=child, capture_output=True, text=True, timeout=30)
        if probe.returncode:
            print('rust: pinned formatter unavailable: ' + probe.stderr, file=sys.stderr)
            return 2
        probe = subprocess.run([tools['cargo'], 'clippy', '--version'], env=child,
                               capture_output=True, text=True, timeout=30)
        if probe.returncode:
            print('rust: clippy toolchain unavailable: ' + probe.stderr, file=sys.stderr)
            return 2
        child['CARGO_TARGET_DIR'] = environment.get('CARGO_TARGET_DIR') or str(
            Path(environment['TMPDIR']) / 'cargo-target')
        commands = [
            [tools['rustup'], 'run', '1.92.0', 'cargo', 'fmt', '--all', '--check'],
            [tools['cargo'], 'clippy', '--locked', '--offline', '--all-targets', '--', '-D', 'warnings'],
            [tools['cargo'], 'test', '--locked', '--offline'],
        ]
        directory = root
    else:
        version = subprocess.run([tools['node'], '-p', 'process.versions.node.split(".")[0]'],
                                 env=child, capture_output=True, text=True, timeout=30)
        if version.returncode or not version.stdout.strip().isdigit() or int(version.stdout) < 24:
            print('ui: Node >=24 required', file=sys.stderr)
            return 2
        directory = root / 'ui'
        tests = sorted(directory.glob('test/*.test.js'))
        if not tests:
            print('ui: missing node test suite', file=sys.stderr)
            return 2
        # npm ci removes an installed Electron binary. Preserve access to the
        # caller's offline archive cache across the gate's private XDG tree.
        child.setdefault('electron_config_cache', str(Path(os.environ.get(
            'XDG_CACHE_HOME', str(Path.home() / '.cache'))) / 'electron'))
        child.update(ELECTRON_SKIP_BINARY_DOWNLOAD='1', npm_config_offline='true',
                     npm_config_audit='false', npm_config_fund='false')
        installed = electron_dist(root, environment)
        if installed is not None and not environment.get('ELECTRON_OVERRIDE_DIST_PATH'):
            preserved = Path(environment['TMPDIR']) / 'electron-dist'
            shutil.copytree(installed, preserved)
            environment['ELECTRON_OVERRIDE_DIST_PATH'] = str(preserved)
        commands = [[tools['npm'], 'ci', '--offline'],
                    [tools['node'], '--test', '--test-timeout=120000', *[str(p.relative_to(directory)) for p in tests]]]
    for command in commands:
        rc = bounded(command, directory, child)
        if rc:
            print(f'{leg}: child rc={rc}: {command!r}', file=sys.stderr)
            return 124 if rc == 124 else 1
    if leg == 'ui':
        for name, arguments in (('vue-tsc', ['--noEmit']), ('vite', ['build'])):
            tool = shutil.which(environment.get(name.upper().replace('-', '_'),
                                str(directory / 'node_modules/.bin' / name)),
                                path=environment.get('PATH'))
            if tool is None:
                print(f'ui: missing tool: {name}', file=sys.stderr)
                return 2
            rc = bounded([tool, *arguments], directory, child)
            if rc:
                print(f'ui: child rc={rc}: {name}', file=sys.stderr)
                return 124 if rc == 124 else 1
    return 0


# [TARGET, unit decision] Go is mandatory; production smoke is independently
# reported and requires an executable local Electron plus the Xvfb harness used
# by both shipped smoke scripts. A zero exit without the main marker is a failure.
def go_leg(root, environment):
    go = shutil.which(environment.get('GO', 'go'), path=environment.get('PATH'))
    if go is None:
        print('go: missing tool: go', file=sys.stderr)
        return 1
    child = dict(environment, GOPROXY='off', GOSUMDB='off', GOTOOLCHAIN='local')
    host_arch = environment.get('GOARCH') or (
        'arm64' if os.uname().machine in ('aarch64', 'arm64') else 'amd64')
    other_arch = 'amd64' if host_arch == 'arm64' else 'arm64'
    cross = dict(child, GOOS='linux', GOARCH=other_arch)
    # Go appends test/subtest names to TMPDIR; keep Unix socket paths short.
    with tempfile.TemporaryDirectory(prefix='g-', dir='/tmp') as temporary:
        child['TMPDIR'] = temporary
        cross['TMPDIR'] = temporary
        for env, arguments in (
            (child, ['vet', './...']),
            (child, ['test', '-race', '-count=1', './...']),
            (cross, ['vet', './...']),
            (cross, ['test', '-run', '^$', '-exec', '/bin/true', './...']),
        ):
            rc = bounded([go, *arguments], root / 'daemon-adapter', env)
            if rc:
                print(f'go: child rc={rc}: {arguments!r}', file=sys.stderr)
                return 124 if rc == 124 else 1
    return 0


def electron_dist(root, environment):
    override = environment.get('ELECTRON_OVERRIDE_DIST_PATH')
    if override:
        return Path(override)
    package = root / 'ui/node_modules/electron'
    marker = package / 'path.txt'
    if marker.is_file():
        binary = package / 'dist' / marker.read_text().strip()
        if binary.is_file() and os.access(binary, os.X_OK):
            return binary.parent
    return None


def ui_smoke_leg(root, environment, timeout=90):
    node = shutil.which(environment.get('NODE', 'node'), path=environment.get('PATH'))
    dist = electron_dist(root, environment)
    if node is None:
        print('ui-smoke: missing tool: node', file=sys.stderr)
        return 2
    if dist is None or not (dist / 'electron').is_file() or not os.access(dist / 'electron', os.X_OK):
        print('ui-smoke: no executable local Electron; set ELECTRON_OVERRIDE_DIST_PATH '
              'or install its local binary', file=sys.stderr)
        return 2
    if shutil.which('xvfb-run', path=environment.get('PATH')) is None:
        print('ui-smoke: no display harness: missing xvfb-run', file=sys.stderr)
        return 2
    child = dict(environment, ELECTRON_OVERRIDE_DIST_PATH=str(dist.resolve()))
    child.pop('ELECTRON_RUN_AS_NODE', None)
    for script, marker in (('smoke.mjs', 'METAVIEWER_SMOKE_OK'),
                           ('smoke-main.mjs', 'METAVIEWER_MAIN_SMOKE_OK')):
        # Spool output to disk so diagnostics and marker checks remain bounded.
        with tempfile.TemporaryFile(mode='w+') as output:
            with subreaper_scope():
                token = f'{os.getpid()}:{time.monotonic_ns()}:{os.urandom(8).hex()}'
                smoke_env = dict(child, MV_SUBREAPER_TOKEN=token)
                process = None
                try:
                    process = subprocess.Popen([node, 'test/' + script], cwd=root / 'ui',
                                               env=smoke_env, stdout=output, stderr=subprocess.STDOUT,
                                               start_new_session=True)
                    register_subreaper_token(process, token)
                    try:
                        rc = process.wait(timeout=timeout)
                    except subprocess.TimeoutExpired:
                        rc = 124
                finally:
                    if process is not None:
                        stop_process_tree(process)
            output.seek(0)
            witnessed = False
            for line in output:
                witnessed |= line.strip() == marker
                print(line[-4000:], end='', flush=True)
        if rc or not witnessed:
            print(f'ui-smoke: {script}: child rc={rc}, marker={witnessed}', file=sys.stderr)
            return 124 if rc == 124 else 1
    return 0


# [TARGET, unit decision] The perf leg always runs offline AC-14 budget checks
# and negative controls; the live Electron RSS probe is opt-in via
# MV_GATE_PERF_LIVE=1 (and requires node, xvfb-run, and a local Electron binary).
def perf_leg(root, environment):
    node = shutil.which(environment.get('NODE', 'node'), path=environment.get('PATH'))
    if node is None:
        print('perf: missing tool: node', file=sys.stderr)
        return 2
    child = dict(environment)
    node_dir = str(Path(node).resolve().parent)
    child['PATH'] = node_dir + (os.pathsep + child['PATH'] if child.get('PATH') else '')
    for command, expected in (
        (['python3', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_budget_gate*.py'], 0),
        (['python3', 'tools/budget_gate.py', '--self-test'], 0),
        ([node, '--test', 'tests/perf/proc_fields.test.mjs'], 0),
        (['python3', 'tools/budget_gate.py', '--receipt', 'tests/perf/leak-renderer.json'], 1),
    ):
        rc = bounded(command, root, child)
        if rc != expected:
            print(f'perf: child rc={rc} (expected {expected}): {command!r}', file=sys.stderr)
            return 124 if rc == 124 else 1
    if environment.get('MV_GATE_PERF_LIVE') != '1':
        print('perf: live probe SKIPPED (MV_GATE_PERF_LIVE not set)', file=sys.stderr)
        return 0
    dist = electron_dist(root, environment)
    electron = (dist / 'electron') if dist is not None else None
    has_electron = electron is not None and electron.is_file() and os.access(electron, os.X_OK)
    xvfb = shutil.which('xvfb-run', path=environment.get('PATH'))
    missing = [name for name, ok in (
        ('node', node is not None),
        ('xvfb-run', xvfb is not None),
        ('electron', has_electron),
    ) if not ok]
    if missing:
        print(f"perf: live probe SKIPPED (missing {', '.join(missing)})", file=sys.stderr)
        return 0
    live_env = dict(child, ELECTRON_OVERRIDE_DIST_PATH=str(dist.resolve()))
    live_env.pop('ELECTRON_RUN_AS_NODE', None)
    command = [
        xvfb, '-a', '-s', '-screen 0 1280x900x24',
        'python3', 'tools/budget_gate.py', '--probe', '--electron', str(electron.resolve()),
    ]
    rc = bounded(command, root, live_env, seconds=600)
    if rc:
        print(f'perf: child rc={rc}: {command!r}', file=sys.stderr)
        return 124 if rc == 124 else 1
    return 0


def leaf(leg, root, environment):
    # [TARGET, unit decision] Match CI discovery with a bounded run; an absent
    # agents suite is a failed gate, rather than successful empty discovery.
    if leg == 'agents':
        if not (root / 'agents/tests').is_dir():
            print('missing target: agents/tests', file=sys.stderr)
            return 1
        if not (root / 'agents/tests/run_mutant_harness.py').is_file():
            print('missing target: agents/tests/run_mutant_harness.py', file=sys.stderr)
            return 1
        deadline = time.monotonic() + 300
        for command in (
            ['python3', '-c', AGENTS_UNIT_CODE],
            ['python3', 'agents/tests/run_mutant_harness.py'],
        ):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return 124
            rc = bounded(command, root, environment, seconds=remaining)
            if rc:
                print(f'{leg}: child rc={rc}', file=sys.stderr)
                return 124 if rc == 124 else 1
        return 0
    targets = {
        'manifests': ('VERSION', *FILES),
        'laws': ('VERSION', 'CHANGELOG.md', 'tools/check_laws.py'),
        'contracts': ('tools/check_contracts.py', 'contracts'),
        'unit': ('tests',),
        'js': ('tools/sync_kit.mjs', 'ui/kit.lock.json'),
        'rust': ('Cargo.toml', 'core/Cargo.toml'),
        'go': ('daemon-adapter/go.mod',),
        'ui-smoke': ('ui/test/smoke.mjs', 'ui/test/smoke-main.mjs'),
        'ui': ('ui/package.json', 'ui/package-lock.json', 'ui/tsconfig.json'),
        'perf': ('tools/budget_gate.py', 'tests/perf/budgets.json',
                 'tests/perf/leak-renderer.json', 'tests/perf/proc_fields.test.mjs'),
    }
    for name in targets[leg]:
        path = root / name
        directory = name in ('tests', 'contracts')
        if not (path.is_dir() if directory else path.is_file()):
            print(f'missing target: {name}', file=sys.stderr)
            return 2
    if leg == 'go':
        return go_leg(root, environment)
    if leg == 'ui-smoke':
        return ui_smoke_leg(root, environment)
    if leg == 'perf':
        return perf_leg(root, environment)
    if leg in ('rust', 'ui'):
        return build_leg(leg, root, environment)
    if leg == 'manifests':
        previous = signal.signal(signal.SIGALRM, manifest_timeout)
        signal.setitimer(signal.ITIMER_REAL, 300)
        try:
            validate_manifests(root, environment)
        except (TimeoutError, subprocess.TimeoutExpired):
            print('manifests: timeout', file=sys.stderr)
            return 124
        except (OSError, ValueError, TypeError) as error:
            print(str(error), file=sys.stderr)
            return 1
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
        return 0
    if leg == 'js':
        checkout = (environment.get('MV_KIT_CHECKOUT') or
                    environment.get('CAPSULE_UI_KIT_REPO') or '').strip()
        if not checkout:
            print('kit absent: set MV_KIT_CHECKOUT (or CAPSULE_UI_KIT_REPO) to the pinned '
                  'capsule-ui-kit checkout', file=sys.stderr)
            return 1
        if shutil.which('node') is None:
            print('missing target: node', file=sys.stderr)
            return 2
        deadline = time.monotonic() + 300
        child = dict(environment, MV_KIT_CHECKOUT=checkout)
        for command in (['node', 'tools/sync_kit.mjs'], ['node', 'tools/sync_kit.mjs', '--check']):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return 124
            rc = bounded(command, root, child, seconds=remaining)
            if rc:
                print(f'{leg}: child rc={rc}', file=sys.stderr)
                return rc if rc in (2, 124) else 1
        return 0
    if leg == 'unit':
        rc = bounded(['python3', '-c', UNIT_CODE], root, environment)
        if rc:
            print(f'{leg}: child rc={rc}', file=sys.stderr)
        return rc if rc in (0, 2, 124) else 1
    commands = [['python3', 'tools/check_contracts.py']] if leg == 'contracts' else [
        ['python3', 'tools/check_laws.py', '--version'], ['python3', '-c', LAWS_CODE]]
    deadline = time.monotonic() + 300
    for command in commands:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return 124
        rc = bounded(command, root, environment, seconds=remaining)
        if rc:
            print(f'{leg}: child rc={rc}', file=sys.stderr)
            return rc if rc in (2, 124) else 1
    return 0


def status(rc):
    return 'PASS' if rc == 0 else 'BLOCKED' if rc == 2 else 'FAIL'


def interrupted(signum, frame):
    raise SystemExit(128 + signum)


def manifest_timeout(signum, frame):
    raise TimeoutError('metadata deadline exceeded')


def main():
    for runner in ('bash', 'python3', 'timeout', 'mktemp'):
        if shutil.which(runner) is None:
            print(f'BLOCKED {SELECTOR}: missing {runner}\nBLOCKED aggregate')
            return 2
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    with private_environment() as (_, environment):
        if SELECTOR == 'self-test':
            suite = unittest.defaultTestLoader.loadTestsFromTestCase(GateTests)
            result = unittest.TextTestRunner(verbosity=2).run(suite)
            rc = 0 if result.wasSuccessful() else 1
            print(f'{status(rc)} self-test\n{status(rc)} aggregate', flush=True)
            return rc
        results = []
        for leg in LEAVES if SELECTOR == 'skeleton' else (SELECTOR,):
            rc = leaf(leg, ROOT, environment)
            results.append(rc)
            print(f'{status(rc)} {leg}', flush=True)
        aggregate = next((rc for rc in (124, 2, 1) if rc in results), 0)
        print(f'{"PASS" if aggregate == 0 else "FAIL"} aggregate', flush=True)
        return aggregate


sys.exit(main())
PY
