"""Synthetic setup fixtures only; no host/guest commands execute."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / 'tools'
spec = importlib.util.spec_from_file_location('capsules', TOOLS / 'arm64_capsules.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='arm64-setup-test-', dir='/dev/shm')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        self.source.mkdir(mode=0o700)
        elf = bytearray(64)
        elf[:6] = b'\x7fELF\x02\x01'
        elf[18:20] = (183).to_bytes(2, 'little')
        self.elf = bytes(elf)
        self.value = {'schema': c.SCHEMA, 'source_commit': 'a' * 40, 'source_root': str(self.source),
                      'package': {'app': self.file('app', self.elf), 'asar': self.file('resources/app.asar', b'package')},
                      'python': self.file('python', self.elf), 'python_prefix': str(self.source),
                      'artifacts': {k: self.file(k, self.elf) for k in ('engine', 'broker', 'busybox')},
                      'native': {k: self.file('bin/' + k, self.elf) for k in c.NATIVE},
                      'runner': self.file('source/daemon-adapter/tools/guest_command_runner.py', b'runner'),
                      'files': [], 'vm_image': 'sha256:' + 'b' * 64,
                      'legal': {'scope': 'operator-provided-local-only', 'operator_local_use_confirmed': True,
                                'redistribute': False, 'assets': {k: {'license': 'synthetic', 'source': 'synthetic',
                                                                   'evidence': 'synthetic fixture only'}
                                for k in ('engine', 'kernel', 'broker', 'busybox', 'vm_image', 'native')}}}
        adapter = self.file('resources/bin/mv-daemon-adapter', self.elf)
        self.value['producer_pins'] = {'setup': self.file('source/tools/arm64_capsule_session.py', b'# synthetic'),
                                      'graphical': adapter, 'guestcommand': adapter.copy()}
        self.value['package_manifest'] = self.file('package.sha256', b'synthetic manifest\n')
        self.value['reconciler'] = self.file('source/tools/arm64_capsule_reconcile.py', b'# synthetic reconciler')
        self.value['identity_provisioner'] = self.file('source/tools/mv_identity.py', b'# synthetic identity helper')
        kernel = bytearray(64)
        kernel[56:60] = b'ARM\x64'
        self.value['artifacts']['kernel'] = self.file('kernel', kernel)
        for rel in c.MODULES:
            self.value['files'].append({'relative': rel, **self.file('source/daemon-adapter/' + rel, b'# synthetic\n')})

    def file(self, name, data):
        p = self.root / name
        p.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        p.write_bytes(data)
        p.chmod(0o700)
        return {'path': str(p), 'sha256': c.digest(data)}


class SetupTests(Fixture):
    def test_complete_local_descriptor(self):
        self.assertEqual(c.validate(self.value), self.value)

    def test_wrong_isa_changed_hash_and_missing_module(self):
        for kind in ('isa', 'hash', 'missing'):
            v = copy.deepcopy(self.value)
            if kind == 'isa':
                raw = bytearray(self.elf)
                raw[18:20] = (62).to_bytes(2, 'little')
                v['artifacts']['broker'] = self.file('wrong-isa', raw)
            elif kind == 'hash':
                v['artifacts']['engine']['sha256'] = '0' * 64
            else:
                v['files'].pop()
            with self.subTest(kind=kind), self.assertRaises(c.Refused):
                c.validate(v)

    def test_legal_scope_is_explicit_no_redistribution(self):
        for key, bad in [('redistribute', True), ('operator_local_use_confirmed', 1), ('scope', 'public')]:
            v = copy.deepcopy(self.value)
            v['legal'][key] = bad
            with self.subTest(key=key), self.assertRaises(c.Refused):
                c.validate(v)

    def test_symlinks_hardlinks_fifo_and_double_slash_refused(self):
        p = self.root / 'app'
        alias = self.root / 'alias'
        alias.symlink_to(p)
        hard = self.root / 'hard'
        os.link(p, hard)
        fifo = self.root / 'fifo'
        os.mkfifo(fifo, 0o600)
        for path in (alias, hard, fifo, '/' + str(p)):
            with self.subTest(path=path), self.assertRaises((c.Refused, OSError)):
                c.read(path)

    def test_strict_json(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{} {}', b'\xff'):
            with self.subTest(raw=raw), self.assertRaises((ValueError, UnicodeError)):
                c.decode(raw)

    def test_atomic_configure_does_not_overwrite(self):
        env = {'XDG_DATA_HOME': str(self.root / 'data')}
        with patch.object(c, 'host_check', return_value={}), patch.object(c, 'interpreter_check'):
            p = c.configure(self.value, env)
            before = p.read_bytes()
            self.assertEqual(c.load_registry(env), self.value)
            with self.assertRaises(FileExistsError):
                c.configure(self.value, env)
            self.assertEqual(p.read_bytes(), before)
            self.assertEqual(p.stat().st_nlink, 1)
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)

    def test_no_registry_write_if_host_gate_fails(self):
        env = {'XDG_DATA_HOME': str(self.root / 'absent')}
        with patch.object(c, 'host_check', side_effect=c.Refused('KVM')), patch.object(c, 'interpreter_check'):
            with self.assertRaises(c.Refused):
                c.configure(self.value, env)
        self.assertFalse((self.root / 'absent').exists())

    def test_extra_key_and_foreign_module_path(self):
        for extra in (True, False):
            v = copy.deepcopy(self.value)
            if extra:
                v['command'] = 'arbitrary'
            else:
                v['files'][0]['path'] = v['runner']['path']
            with self.assertRaises(c.Refused):
                c.validate(v)

    def test_nonexecutable_text_interpreter_and_writable_files_refuse(self):
        for bad in ('noexec', 'text', 'writable'):
            v = copy.deepcopy(self.value)
            p = Path(v['python']['path'])
            if bad == 'noexec':
                p.chmod(0o600)
            elif bad == 'text':
                p.write_bytes(b'not an interpreter')
                v['python']['sha256'] = c.digest(p.read_bytes())
            else:
                p.chmod(0o720)
            with self.subTest(bad=bad), self.assertRaises(c.Refused):
                c.validate(v)
            p.write_bytes(self.elf)
            p.chmod(0o700)

    def test_isolated_interpreter_probe_exact_prefix_and_timeout(self):
        def fake(argv, env, timeout):
            self.assertEqual(argv, [self.value['python']['path'], '-I', '-B', '-c', c.PYTHON_PROBE])
            self.assertEqual(env, {'PATH': '/usr/bin:/bin'})
            self.assertEqual(timeout, 5)
            return json.dumps({'executable': self.value['python']['path'], 'prefix': self.value['python_prefix'],
                               'isolated': 1, 'no_bytecode': True, 'version': [3, 12]}).encode()
        c.interpreter_check(self.value, fake)
        raw = json.loads(fake([self.value['python']['path'], '-I', '-B', '-c', c.PYTHON_PROBE], {'PATH': '/usr/bin:/bin'}, 5))
        raw['prefix'] = '/wrong-prefix'
        with self.assertRaises(c.Refused):
            c.interpreter_check(self.value, lambda *a, **kw: json.dumps(raw).encode())

    def test_owner_without_execute_cannot_borrow_other_execute_bit(self):
        for key in ('app', 'native'):
            v = copy.deepcopy(self.value)
            asset = v['package']['app'] if key == 'app' else v['native']['srf-identity-admin']
            p = Path(asset['path'])
            p.chmod(0o601)
            self.assertFalse(os.access(p, os.X_OK, effective_ids=True))
            with self.subTest(key=key), self.assertRaises(c.Refused):
                c.validate(v)
            p.chmod(0o700)

    def test_normal_profile_recipe_refuses_unpinned_or_static_program_only(self):
        v = copy.deepcopy(self.value)
        facts = {'license': 'synthetic', 'source': 'synthetic', 'evidence': 'synthetic'}
        v['normal_profiles'] = {'browser': {'image_id': 'sha256:' + 'c' * 64,
            'domains': ['example.com'], 'legal': facts}, 'program': {'image_id': 'sha256:' + 'c' * 64, 'legal': facts}}
        c.validate(v)
        del v['normal_profiles']['browser']
        with self.assertRaises(c.Refused):
            c.validate(v)


if __name__ == '__main__':
    unittest.main()
