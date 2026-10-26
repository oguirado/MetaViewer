#!/usr/bin/env bash
# [TARGET, unit decision] Require complete release pins and npm dependency sets;
# verify frozen offline resolution in disposable trees, for the current Rust host.
set -u

usage() {
    printf '%s\n' 'Usage: tools/gate.sh [--leg skeleton|laws|contracts|unit|manifests|js | --self-test]' >&2
    exit 2
}
selector=skeleton
case $# in
    0) ;;
    1) [[ $1 == --self-test ]] || usage; selector=self-test ;;
    2) [[ $1 == --leg ]] || usage; selector=$2 ;;
    *) usage ;;
esac
case $selector in skeleton|laws|contracts|unit|manifests|js|self-test) ;; *) usage ;; esac
[[ $selector != self-test || ${1:-} == --self-test ]] || usage
root=$(cd -- "${BASH_SOURCE[0]%/*}/.." && pwd -P) || exit 2
if ! command -v python3 >/dev/null; then
    printf 'BLOCKED %s: missing python3\nBLOCKED aggregate\n' "$selector" >&2
    exit 2
fi
export PYTHONDONTWRITEBYTECODE=1
exec python3 - "$root" "$selector" <<'PY'
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
import time
import tomllib
import unittest

ROOT = Path(sys.argv[1])
SELECTOR = sys.argv[2]
LEAVES = ('manifests', 'laws', 'contracts', 'unit')
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
SCRIPTS = {'test': 'node --test test/*.test.js',
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

    def write(self, name, content):
        path = self.fixture / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def call(self, *args, expected=0, env=None):
        result = subprocess.run(
            ['bash', str(self.fixture / 'tools/gate.sh'), *args],
            cwd=self.temp.name, env=env, text=True, capture_output=True, timeout=30)
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
        result = subprocess.run(['/home/admin/.cargo/bin/cargo', 'generate-lockfile', '--offline'],
                                cwd=self.fixture, env=dict(os.environ,
                                CARGO_TARGET_DIR='/home/admin/.cache/cargo-target/metaviewer-workers'),
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
        for leg in LEAVES:
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
            {'name': 'capsule-ui-kit', 'version': '0.2.0'}))
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
            {'schema': 'capsule-ui-kit-source/v1', 'version': '0.2.0',
             'contentHash': content_hash, 'algorithm': 'sha256-length-framed-tree',
             'direction': 'vendor'}))
        (self.fixture / 'ui/kit.lock.json').write_text(json.dumps(
            {'repo': 'https://example.invalid/kit.git', 'commit': '0' * 40,
             'version': '0.2.0', 'contentHash': content_hash}))
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

    def test_aggregation_and_isolation(self):
        output = self.call()
        self.assertEqual([line for line in output.splitlines() if line in
                          ['PASS ' + leg for leg in LEAVES]], ['PASS ' + leg for leg in LEAVES])
        self.assertEqual((self.fixture / 'unit.calls').read_text(), 'asserted\n')
        self.assertEqual((self.fixture / 'contract.calls').read_text(), 'called\n')
        self.call('--leg', 'laws')
        scratch = (self.fixture / 'scratch.calls').read_text().splitlines()
        self.assertEqual(scratch[0], scratch[1])
        self.assertNotEqual(scratch[0], scratch[2])
        self.assertTrue(all(not Path(path).exists() for path in scratch))
        self.write('Cargo.toml', 'broken')
        output = self.call('--leg', 'skeleton', expected=1)
        self.assertIn('FAIL aggregate', output)
        self.assertIn('PASS unit', output)
        (self.fixture / 'tools/check_contracts.py').unlink()
        self.assertIn('BLOCKED aggregate', self.call(expected=2))

    def test_bounded_cleanup(self):
        with private_environment() as (_, environment):
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
        self.assertTrue(all(not path.exists() for path in paths))


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
                      '9bbb49f220837388e1ab90c34ae0eedee27a66eb'),
    'wender-agent': ('python_package', 'oguirado/wender-agent', 'v0.3.0',
                     '7648b258d1d04953bacffe8627de5acd7c75d817'),
    'opensuperficies': ('go_binary', 'oguirado/OpenSuperficies', 'os-cu-w9-mv1',
                       'a9ac1ac8543872b428990ea23fa2629cd0a6d1d5'),
}


def validate_frozen_dependencies(root):
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
    for key in ('name', 'version', 'dependencies', 'devDependencies', 'engines'):
        require(locked_root.get(key) == package.get(key), 'package-lock.json: stale root ' + key)
    # Cargo resolves only the current host's graph: cross-platform archives need not
    # be present in the offline cache. --locked still checks the full lock resolution.
    rustc = '/home/admin/.cargo/bin/rustc'
    cargo = '/home/admin/.cargo/bin/cargo'
    require(Path(rustc).is_file() and Path(cargo).is_file(), 'Cargo.lock: missing Rust toolchain')
    identity = subprocess.run([rustc, '-vV'], capture_output=True, text=True, timeout=30)
    host = re.search(r'^host: (\S+)$', identity.stdout, re.MULTILINE)
    require(identity.returncode == 0 and host is not None, 'Cargo.lock: unproven Rust host')
    npm = shutil.which('npm')
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
        environment = dict(os.environ,
                           CARGO_TARGET_DIR='/home/admin/.cache/cargo-target/metaviewer-workers')
        commands = (
            ('Cargo.lock', [cargo, 'metadata', '--offline', '--locked', '--format-version', '1',
                            '--filter-platform', host.group(1)], scratch),
            ('package-lock.json', [npm, 'ci', '--offline', '--ignore-scripts', '--dry-run',
                                  '--no-audit', '--no-fund'], scratch / 'ui'),
        )
        for name, command, directory in commands:
            result = subprocess.run(command, cwd=directory, env=environment,
                                    capture_output=True, text=True, timeout=60)
            require(result.returncode == 0, name + ': frozen offline resolution failed: ' +
                    (result.stderr + result.stdout)[-4000:])


def validate_manifests(root):
    version = (root / 'VERSION').read_text().strip()
    require(version == '0.1.1', 'VERSION: metadata drift')
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
    validate_frozen_dependencies(root)
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


UNIT_CODE = '''import sys, unittest
suite = unittest.defaultTestLoader.discover(start_dir="tests")
if suite.countTestCases() == 0:
    print("empty test selection; refusing silent pass", file=sys.stderr)
    sys.exit(2)
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(0 if result.wasSuccessful() and not
         (result.skipped or result.expectedFailures or result.unexpectedSuccesses) else 1)
'''


def descendants(parent):
    children = {}
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            fields = path.read_text().rsplit(')', 1)[1].split()
            children.setdefault(int(fields[1]), []).append(int(path.parent.name))
        except (FileNotFoundError, ProcessLookupError):
            continue
    found = []
    pending = [parent]
    while pending:
        current = pending.pop()
        found.append(current)
        pending.extend(children.get(current, ()))
    return found


def stop_process_tree(process):
    # Only a recorded child tree in a separate session may receive signals.
    pids = {pid: process_identity(pid) for pid in descendants(process.pid)}
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in reversed(pids):
            if type(pid) is not int or pid <= 1 or pid == os.getpid():
                raise ValueError('unsafe child pid')
            try:
                if pids[pid] is None or process_identity(pid) != pids[pid]:
                    continue
                if os.getpgid(pid) == os.getpgrp():
                    raise ValueError('child shares caller process group')
                os.kill(pid, sig)
            except ProcessLookupError:
                continue
        if sig == signal.SIGTERM:
            time.sleep(0.05)
    process.wait()


def process_identity(pid):
    try:
        return Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def bounded(argv, cwd, environment, seconds=300):
    process = subprocess.Popen(argv, cwd=cwd, env=environment, start_new_session=True)
    try:
        try:
            return process.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            print('timeout: ' + repr(argv), file=sys.stderr)
            return 124
    finally:
        if process.poll() is None:
            stop_process_tree(process)


class private_environment:
    def __enter__(self):
        path = subprocess.check_output(['mktemp', '-d'], text=True).strip()
        self.path = Path(path)
        self.path.chmod(0o700)
        environment = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
        for key in ('TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'):
            target = self.path / key.lower()
            target.mkdir(mode=0o700)
            environment[key] = str(target)
        return self.path, environment

    def __exit__(self, kind, value, traceback):
        shutil.rmtree(self.path)


def leaf(leg, root, environment):
    targets = {
        'manifests': ('VERSION', *FILES),
        'laws': ('VERSION', 'CHANGELOG.md', 'tools/check_laws.py'),
        'contracts': ('tools/check_contracts.py', 'contracts'),
        'unit': ('tests',),
        'js': ('tools/sync_kit.mjs', 'ui/kit.lock.json'),
    }
    for name in targets[leg]:
        path = root / name
        directory = name in ('tests', 'contracts')
        if not (path.is_dir() if directory else path.is_file()):
            print(f'missing target: {name}', file=sys.stderr)
            return 2
    if leg == 'manifests':
        previous = signal.signal(signal.SIGALRM, manifest_timeout)
        signal.setitimer(signal.ITIMER_REAL, 300)
        try:
            validate_manifests(root)
        except TimeoutError:
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
        print(f'{status(aggregate)} aggregate', flush=True)
        return aggregate


sys.exit(main())
PY
