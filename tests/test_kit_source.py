import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'tools/sync_kit.mjs'
EXCLUDED = {'KIT_SOURCE.json', 'node_modules', '.git'}


def digest(root):
    result = hashlib.sha256()

    def walk(directory, prefix=''):
        for entry in sorted(directory.iterdir(), key=lambda p: p.name.encode()):
            if entry.name in EXCLUDED:
                continue
            name = prefix + entry.name
            if entry.is_symlink():
                raise ValueError('Symlink rejected')
            if entry.is_dir():
                walk(entry, name + '/')
            elif entry.is_file():
                key, data = name.encode(), entry.read_bytes()
                result.update(str(len(key)).encode() + b':' + key)
                result.update(str(len(data)).encode() + b':' + data)
            else:
                raise ValueError('Unsupported entry')
    walk(root)
    return result.hexdigest()


class KitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'source'
        self.pkg = self.repo / 'packages/capsule-ui-kit'
        self.pkg.mkdir(parents=True)
        (self.pkg / 'package.json').write_text(json.dumps({
            'name': 'capsule-ui-kit', 'version': '0.2.1',
            'exports': {'.': './index.js'}}))
        (self.pkg / 'index.js').write_text('export const value = 1;\n')
        (self.pkg / 'é.txt').write_text('byte framing')
        self.hash = digest(self.pkg)
        self.record = {'schema': 'capsule-ui-kit-source/v1', 'version': '0.2.1',
                       'contentHash': self.hash, 'algorithm': 'sha256-length-framed-tree',
                       'direction': 'export'}
        (self.pkg / 'KIT_SOURCE.json').write_text(json.dumps(self.record))
        # Build a local identity fixture without creating repository commits via git.
        git = self.repo / '.git'
        (git / 'objects').mkdir(parents=True)
        def object_id(kind, payload):
            raw = kind.encode() + b' ' + str(len(payload)).encode() + b'\0' + payload
            oid = hashlib.sha1(raw).hexdigest()
            directory = git / 'objects' / oid[:2]
            directory.mkdir(exist_ok=True)
            (directory / oid[2:]).write_bytes(zlib.compress(raw))
            return oid
        tree = object_id('tree', b'')
        commit = object_id('commit', (
            f'tree {tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\n'
            'committer Fixture <fixture@example.invalid> 1 +0000\n\nfixture\n').encode())
        (git / 'refs').mkdir()
        (git / 'HEAD').write_text(commit + '\n')
        (git / 'config').write_text('[core]\nrepositoryformatversion = 0\n'
                                  '[remote "origin"]\nurl = https://example.invalid/kit.git\n')
        self.pin = self.root / 'kit.lock.json'
        self.pin.write_text(json.dumps({'repo': 'https://example.invalid/kit.git',
                                       'commit': commit, 'version': '0.2.1',
                                       'contentHash': self.hash}))
        self.dest = self.root / 'destination' / 'capsule-ui-kit'

    def invoke(self, check=False, failures=()):
        expression = '''import {syncKit} from %s;
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const rename = fs.rename;
let calls = 0;
const failures = JSON.parse(process.argv[5]);
fs.rename = async (...args) => {
  if (failures.includes(++calls)) throw new Error('Injected rename failure');
  return rename(...args);
};
syncBuiltinESMExports();
try { await syncKit({kitRepo:process.argv[1], dest:process.argv[2],
lockPath:process.argv[3], check:process.argv[4] === 'true'}); }
catch(error) { console.error('ERROR: ' + error.message); process.exitCode = 1; }'''
        return subprocess.run(['node', '--input-type=module', '-e',
                               expression % json.dumps(SCRIPT.as_uri()), str(self.repo),
                               str(self.dest), str(self.pin), str(check).lower(), json.dumps(failures)],
                              text=True, capture_output=True, timeout=20)

    def assert_refused(self, check=False):
        result = self.invoke(check)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn('ERROR:', result.stderr)

    def test_sync_and_read_only_check(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(digest(self.dest), self.hash)
        before = {p.relative_to(self.dest): (p.read_bytes(), p.stat().st_mtime_ns)
                  for p in self.dest.rglob('*') if p.is_file()}
        self.assertEqual(self.invoke(True).returncode, 0)
        self.assertEqual(before, {p.relative_to(self.dest): (p.read_bytes(), p.stat().st_mtime_ns)
                                 for p in self.dest.rglob('*') if p.is_file()})
        (self.dest / 'index.js').write_text('tampered')
        self.assert_refused(True)
        self.assertEqual((self.dest / 'index.js').read_text(), 'tampered')

    def test_source_mutants_preserve_destination(self):
        self.assertEqual(self.invoke().returncode, 0)
        target = self.pkg / 'index.js'
        for mutant in ('changed', None):
            with self.subTest(mutant=mutant):
                if mutant is None:
                    target.unlink()
                else:
                    target.write_text(mutant)
                self.assert_refused()
                self.assertEqual(digest(self.dest), self.hash)
        target.write_text('export const value = 1;\n')
        (self.pkg / 'extra').write_text('extra')
        self.assert_refused()
        (self.pkg / 'extra').unlink()
        target.unlink()
        target.symlink_to(self.pkg / 'é.txt')
        self.assert_refused()

    def test_metadata_and_pin_mutants(self):
        for field, value in [('version', '9.0.0'), ('contentHash', '0' * 64),
                             ('algorithm', 'other'), ('schema', 'other')]:
            with self.subTest(field=field):
                record = dict(self.record, **{field: value})
                (self.pkg / 'KIT_SOURCE.json').write_text(json.dumps(record))
                self.assert_refused()
        (self.pkg / 'KIT_SOURCE.json').write_text(json.dumps(self.record))
        pin = json.loads(self.pin.read_text())
        for field, value in [('commit', '0' * 40), ('repo', 'other'),
                             ('version', '9.0.0'), ('contentHash', '0' * 64),
                             ('extra', 'unexpected')]:
            with self.subTest(pin=field):
                self.pin.write_text(json.dumps(dict(pin, **{field: value})))
                self.assert_refused()

    def test_missing_check_and_symlink_destination(self):
        self.assert_refused(True)
        self.assertFalse(self.dest.parent.exists())
        self.dest.parent.mkdir()
        self.dest.symlink_to(self.pkg, target_is_directory=True)
        self.assert_refused()
        self.assertTrue(self.dest.is_symlink())

    def test_overlap_and_symlink_ancestor(self):
        self.dest = self.pkg / 'nested'
        self.assert_refused()
        self.assertFalse(self.dest.exists())
        alias = self.root / 'alias'
        alias.symlink_to(self.root / 'source', target_is_directory=True)
        self.dest = alias / 'new' / 'capsule-ui-kit'
        self.assert_refused()
        self.assertFalse((self.repo / 'new').exists())

    def test_digest_exclusions_and_empty_directories(self):
        (self.pkg / 'empty').mkdir()
        (self.pkg / 'node_modules').mkdir()
        (self.pkg / 'node_modules' / 'ignored').write_text('ignored')
        self.assertEqual(digest(self.pkg), self.hash)
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.dest / 'node_modules').exists())

    def test_activation_failure_restores_previous_tree(self):
        self.assertEqual(self.invoke().returncode, 0)
        before = digest(self.dest)
        result = self.invoke(failures=(2,))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Injected rename failure', result.stderr)
        self.assertEqual(digest(self.dest), before)
        self.assertEqual(list(self.dest.parent.glob('.kit-sync-*')), [])

    def test_restoration_failure_preserves_backup(self):
        self.assertEqual(self.invoke().returncode, 0)
        result = self.invoke(failures=(2, 3))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('preserved backup:', result.stderr)
        backups = list(self.dest.parent.glob('.kit-sync-*.previous'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(digest(backups[0]), self.hash)
        self.assertFalse(self.dest.exists())

    def test_self_consistent_rehash_cannot_replace_pin(self):
        (self.pkg / 'index.js').write_text('tampered')
        record = dict(self.record, contentHash=digest(self.pkg))
        (self.pkg / 'KIT_SOURCE.json').write_text(json.dumps(record))
        self.assert_refused()
        self.assertFalse(self.dest.exists())

    def test_cli_usage_failure_does_not_write(self):
        result = subprocess.run(['node', str(SCRIPT), '--unknown'],
                                text=True, capture_output=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ERROR: Usage:', result.stderr)

    def test_pinned_lock(self):
        pin = json.loads((ROOT / 'ui/kit.lock.json').read_text())
        self.assertEqual(set(pin), {'repo', 'commit', 'version', 'contentHash'})
        self.assertEqual(pin['commit'], 'bf31bc201987206d16dbd88d93102f9d5ce026f9')
        self.assertEqual(pin['version'], '0.2.1')
        self.assertEqual(pin['contentHash'],
                         '1bee78c76a0a2a41d085beed918ca6ca791beaf53b952d4a9367dad660fd6dc2')
        self.assertIn('ui/.kit/', (ROOT / '.gitignore').read_text().splitlines())


if __name__ == '__main__':
    unittest.main()
