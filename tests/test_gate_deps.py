"""R1-012/R1-091/R1-100: exercise the shipped manifest CLI on private fixtures."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class DependencyAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ('tools/gate.sh', 'VERSION', '.gitignore', 'Cargo.toml',
                     'core/Cargo.toml', 'Cargo.lock', 'deps.lock',
                     'agents/pyproject.toml', 'daemon-adapter/go.mod',
                     'ui/package.json', 'ui/package-lock.json'):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)

    def gate(self, rc=0, diagnostic='PASS manifests', env=None):
        before = {str(p.relative_to(self.root)): p.read_bytes()
                  for p in self.root.rglob('*') if p.is_file()}
        result = subprocess.run(['bash', str(self.root / 'tools/gate.sh'),
                                 '--leg', 'manifests'], cwd=self.temp.name,
                                capture_output=True, text=True, timeout=60, env=env)
        self.assertEqual(result.returncode, rc, result.stdout + result.stderr)
        self.assertIn(diagnostic, result.stdout + result.stderr)
        after = {str(p.relative_to(self.root)): p.read_bytes()
                 for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after, 'admission must never rewrite manifests or locks')

    def mutate_json(self, name, mutation):
        path = self.root / name
        data = json.loads(path.read_text())
        mutation(data)
        path.write_text(json.dumps(data))

    def test_clean_tree(self):
        self.gate()

    def test_toolchain_path_and_explicit_missing_overrides(self):
        environment = dict(os.environ)
        environment.pop('CARGO', None)
        environment.pop('RUSTC', None)
        self.gate(env=environment)
        for name in ('CARGO', 'RUSTC'):
            with self.subTest(tool=name):
                missing = str(self.root / 'missing-tool')
                self.gate(1, 'Cargo.lock: missing Rust toolchain',
                          env=dict(environment, **{name: missing}))

    def test_component_commit_mutants(self):
        for index, name in enumerate(('vision-engine', 'wender-agent', 'opensuperficies')):
            for bad in ('123abcd', 'g' * 40):
                with self.subTest(component=name, commit=bad):
                    shutil.copyfile(ROOT / 'deps.lock', self.root / 'deps.lock')
                    self.mutate_json('deps.lock', lambda d: d['components'][index].update(commit=bad))
                    self.gate(1, name)

    def test_component_closure_and_tag_drift(self):
        for mutation in (lambda d: d['components'].pop(),
                         lambda d: d['components'].append(d['components'][0]),
                         lambda d: d['components'][2].update(version='os-cu-w9-mv0'),
                         lambda d: d['components'][0].update(commit='a' * 40)):
            shutil.copyfile(ROOT / 'deps.lock', self.root / 'deps.lock')
            self.mutate_json('deps.lock', mutation)
            self.gate(1, 'deps.lock')

    def test_missing_locks(self):
        for name in ('deps.lock', 'Cargo.lock', 'ui/package-lock.json'):
            with self.subTest(lock=name):
                path = self.root / name
                original = path.read_bytes()
                path.unlink()
                self.gate(1, name)
                path.write_bytes(original)

    def test_dropped_npm_dependency(self):
        for section in ('dependencies', 'devDependencies'):
            with self.subTest(section=section):
                shutil.copyfile(ROOT / 'ui/package.json', self.root / 'ui/package.json')
                self.mutate_json('ui/package.json', lambda d: d[section].pop(next(iter(d[section]))))
                self.gate(1, 'package.json')

    def test_stale_npm_root_and_transitive_locks(self):
        for mutation in (lambda d: d['packages']['']['dependencies'].update(vue='3.5.42'),
                         lambda d: d['packages']['node_modules/vue'].update(version='3.5.42'),
                         lambda d: d['packages'].pop('node_modules/@babel/parser')):
            shutil.copyfile(ROOT / 'ui/package-lock.json', self.root / 'ui/package-lock.json')
            self.mutate_json('ui/package-lock.json', mutation)
            self.gate(1, 'package-lock.json')

    def test_stale_cargo_lock(self):
        path = self.root / 'Cargo.lock'
        path.write_text(path.read_text().replace('version = "1.0.229"', 'version = "1.0.228"'))
        self.gate(1, 'Cargo.lock')

    def git(self, *args):
        result = subprocess.run(['git', '-C', str(self.root), *args],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_mut_second_lock(self):
        """MUT-SECOND-LOCK: inspect tracked working bytes, not only the root/index."""
        self.git('init', '-q')
        path = self.root / 'tests' / 'supervisor Música' / 'Cargo.lock'
        path.parent.mkdir(parents=True)
        version = (self.root / 'VERSION').read_text().strip()
        clean = ('version = 4\n[[package]]\nname = "metaviewer-core"\n'
                 f'version = "{version}"\n')
        path.write_text(clean)
        self.git('add', '.')
        self.gate()
        path.write_text(clean.replace(version, '0.0.0'))
        self.gate(1, 'LOCK_VERSION_DRIFT: tests/supervisor Música/Cargo.lock')
        path.write_text(clean)
        self.gate()

    def test_untracked_lock_and_unrelated_registry_package(self):
        self.git('init', '-q')
        self.git('add', '.')
        path = self.root / 'scratch' / 'Cargo.lock'
        path.parent.mkdir()
        path.write_text('[[package]]\nname = "metaviewer-core"\nversion = "0.0.0"\n')
        self.gate()
        path.write_text('[[package]]\nname = "serde"\nversion = "0.0.0"\n'
                        'source = "registry+https://example.invalid/index"\n')
        self.git('add', 'scratch/Cargo.lock')
        self.gate()

    def test_tracked_lock_parse_and_missing_file_fail_closed(self):
        self.git('init', '-q')
        path = self.root / 'secondary' / 'Cargo.lock'
        path.parent.mkdir()
        path.write_text('[[package]]\nname = "unrelated"\nversion = "0.0.0"\n')
        self.git('add', '.')
        path.write_text('invalid = [')
        self.gate(1, 'LOCK_METADATA_ERROR: secondary/Cargo.lock')
        path.unlink()
        self.gate(1, 'LOCK_METADATA_ERROR: secondary/Cargo.lock')

    def test_other_workspace_path_package_and_registry_namesake(self):
        source = (ROOT / 'tools/gate.sh').read_text().split("<<'PY'\n", 1)[1]
        source = source.rsplit('\nsys.exit(main())', 1)[0]
        namespace = {'__name__': 'release_lock_fixture'}
        with patch.object(sys, 'argv', ['gate.sh', str(self.root), 'manifests']):
            exec(compile(source, str(ROOT / 'tools/gate.sh'), 'exec'), namespace)
        manifest = self.root / 'Cargo.toml'
        manifest.write_text(manifest.read_text().replace('members = ["core"]',
                                                        'members = ["core", "extra-*"]'))
        member = self.root / 'extra-member'
        member.mkdir()
        (member / 'Cargo.toml').write_text('[package]\nname = "workspace-helper"\nversion = "0.2.0"\n')
        self.git('init', '-q')
        path = self.root / 'secondary' / 'Cargo.lock'
        path.parent.mkdir()
        package = '[[package]]\nname = "workspace-helper"\nversion = "0.0.0"\n'
        path.write_text(package + 'source = "registry+https://example.invalid/index"\n')
        self.git('add', '.')
        validate = namespace['validate_release_locks']
        version = (self.root / 'VERSION').read_text().strip()
        validate(self.root, version)
        path.write_text(package)
        with self.assertRaisesRegex(namespace['InvalidMetadata'],
                                    'LOCK_VERSION_DRIFT: secondary/Cargo.lock: workspace-helper'):
            validate(self.root, version)
        path.write_text(package.replace('0.0.0', version))
        validate(self.root, version)


if __name__ == '__main__':
    unittest.main()
