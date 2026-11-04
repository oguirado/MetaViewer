"""Normal-session identity helper contracts with synthetic files and fake Docker."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / 'tools/mv_identity.py'
spec = importlib.util.spec_from_file_location('normal_identity', SOURCE)
mv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mv)


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='identity-inventory-', dir='/dev/shm')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / 'store'
        for p in (self.root, self.base/'home', self.base/'bin', self.root/'profiles',
                  self.root/'metadata', self.root/'locks'):
            p.mkdir(mode=0o700)
        self.tool = mv.Identities(str(self.root), str(self.base/'home'), str(self.base/'bin'))
        self.tool.show = Mock(return_value={'profile_id':'account-a','browser':'program'})
        self.target = self.root/'profiles/account-a'
        self.target.mkdir(mode=0o700)
        self.events = []
        self.module = Mock()
        def append(config_path, payload, source_path):
            self.events.append(payload)
            return {'seq':len(self.events)}
        self.module.append_identity_helper.side_effect = append
        self.context = (self.module, self.base/'inventory-config.json',
                        {'run_id':'a'*24,'images':{'browser':'sha256:'+'b'*64}})
        env = patch.dict(os.environ, {'MV_ARM64_CAPSULES':'1'}, clear=False)
        env.start(); self.addCleanup(env.stop)

    def observed_owner(self, path, *args, **kwargs):
        row = self.real_lstat(path, *args, **kwargs)
        if path == self.target:
            fields = list(row)
            fields[4] = fields[5] = 10001
            return os.stat_result(fields)
        return row

    def test_pending_bound_removed_order_and_exact_image(self):
        self.real_lstat = Path.lstat
        def docker(argv, **kwargs):
            if argv[1] == 'run':
                self.assertEqual(self.events[-1]['stage'], 'helper_pending')
                self.assertEqual(argv[0], '/usr/bin/docker')
                self.assertIn(self.context[2]['images']['browser'], argv)
                self.assertNotIn('opensuperficies-identity-browser-arm64:0.2.0', argv)
                cidfile = Path(argv[argv.index('--cidfile')+1])
                cidfile.write_text('c'*64)
                self.assertEqual(stat.S_IMODE(cidfile.stat().st_mode), 0o600)
                return types.SimpleNamespace(returncode=0)
            self.assertEqual(argv[1:3], ['container','ls'])
            self.assertEqual(self.events[-1]['stage'], 'helper_bound')
            return types.SimpleNamespace(returncode=0, stdout=b'')
        with patch.object(mv, 'normal_inventory', return_value=self.context), \
                patch.object(mv.subprocess, 'run', side_effect=docker), \
                patch.object(Path, 'lstat', lambda p, *a, **kw: self.observed_owner(p, *a, **kw)), \
                patch.object(mv, 'profile_image') as fallback:
            self.tool.profile_helper('account-a')
        self.assertEqual([x['stage'] for x in self.events], ['helper_pending','helper_bound','helper_removed'])
        self.assertFalse(list((self.root/'locks/profile-helpers').glob('*.cid')))
        fallback.assert_not_called()

    def test_sealed_writer_refuses_before_docker(self):
        self.module.append_identity_helper.side_effect = ValueError('sealed')
        with patch.object(mv, 'normal_inventory', return_value=self.context), \
                patch.object(mv.subprocess, 'run') as docker:
            with self.assertRaises(ValueError):
                self.tool.profile_helper('account-a')
        docker.assert_not_called()

    def test_missing_normal_config_refuses_before_native_metadata_effect(self):
        with patch.dict(os.environ, {'MV_ARM64_INVENTORY_CONFIG':''}), \
                patch.object(mv.subprocess, 'run') as native:
            with self.assertRaises(mv.Refused):
                self.tool.create('account-a','label',browser='program')
        native.assert_not_called()

    def test_uncertain_malformed_cid_retains_pending_no_cleanup(self):
        def docker(argv, **kwargs):
            Path(argv[argv.index('--cidfile')+1]).write_text('malformed')
            raise subprocess.TimeoutExpired('synthetic', 15)
        with patch.object(mv, 'normal_inventory', return_value=self.context), \
                patch.object(mv.subprocess, 'run', side_effect=docker) as calls:
            with self.assertRaises(mv.Refused):
                self.tool.profile_helper('account-a')
        self.assertEqual(calls.call_count, 1)
        self.assertEqual(self.events[0]['stage'], 'helper_pending')
        self.assertTrue(list((self.root/'locks/profile-helpers').glob('*.cid')))

    def test_foreign_helper_never_force_removed(self):
        def docker(argv, **kwargs):
            if argv[1] == 'run':
                Path(argv[argv.index('--cidfile')+1]).write_text('c'*64)
                return types.SimpleNamespace(returncode=1)
            self.assertEqual(argv[1:3], ['container','inspect'])
            return types.SimpleNamespace(returncode=0,stdout=json.dumps([{'Id':'c'*64,'Name':'/foreign'}]).encode())
        with patch.object(mv, 'normal_inventory', return_value=self.context), \
                patch.object(mv.subprocess, 'run', side_effect=docker) as calls:
            with self.assertRaises(mv.Refused):
                self.tool.profile_helper('account-a')
        self.assertFalse(any(x.args[0][1] == 'rm' for x in calls.call_args_list))
        self.assertEqual(self.events[-1]['stage'], 'unknown')

    def test_direct_surface_mutation_unknown_precedes_effect_but_admin_show_exempt(self):
        def native(argv, **kwargs):
            self.assertEqual(self.events[-1]['stage'], 'unknown')
            return types.SimpleNamespace(returncode=0,stdout=b'{}')
        with patch.object(mv, 'normal_inventory', return_value=self.context), \
                patch.object(mv.subprocess, 'run', side_effect=native):
            self.tool.native('srf-identity-surface', ['stop','--container','srf-id-account-a'])
        self.assertRegex(self.events[0]['id'], '^identity-mutation-[0-9a-f]{24}$')
        self.events.clear()
        with patch.object(mv, 'normal_inventory') as load, \
                patch.object(mv.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0,stdout=b'{}')):
            self.tool.native('srf-identity-admin', ['show','--id','account-a'])
        load.assert_not_called()

    def test_cid_metadata_rejects_hardlink_fifo_and_foreign_owner_mode(self):
        p = self.base/'cid'
        p.write_text('c'*64);p.chmod(0o644)
        with self.assertRaises(mv.Refused):
            mv.normal_cid(p)
        p.chmod(0o600)
        os.link(p,self.base/'alias')
        with self.assertRaises(mv.Refused):
            mv.normal_cid(p)
        fifo = self.base/'fifo';os.mkfifo(fifo,0o600)
        with self.assertRaises(mv.Refused):
            mv.normal_cid(fifo)

    def test_malformed_or_foreign_config_refuses_before_dispatch(self):
        path = self.base/'inventory-config.json'
        for raw in (b'{"root":1,"root":2}', b'{"root":NaN}', b'[]',
                    json.dumps({'root':str(self.base/'foreign'),'images':{'browser':'sha256:'+'b'*64}}).encode()):
            path.write_bytes(raw);path.chmod(0o600)
            (self.base/'foreign').mkdir(mode=0o700,exist_ok=True)
            with patch.dict(os.environ, {'MV_ARM64_INVENTORY_CONFIG':str(path)}), \
                    patch.object(mv.subprocess, 'run') as dispatch:
                with self.assertRaises(mv.Refused):
                    mv.normal_inventory(self.tool)
            dispatch.assert_not_called()

    def test_changed_identity_source_pin_refuses_before_library_import(self):
        snapshot = {'identity_provisioner':{'path':str(SOURCE),'sha256':'0'*64}}
        data = json.dumps(snapshot).encode()
        (self.base/'setup.json').write_bytes(data);(self.base/'setup.json').chmod(0o600)
        config = {'root':str(self.base),'images':{'browser':'sha256:'+'b'*64},
                  'registry_sha256':mv.hashlib.sha256(data).hexdigest(),
                  'identity_provisioner':snapshot['identity_provisioner']}
        path=self.base/'inventory-config.json';path.write_text(json.dumps(config));path.chmod(0o600)
        with patch.dict(os.environ, {'MV_ARM64_INVENTORY_CONFIG':str(path)}), \
                patch.object(mv.importlib.util,'spec_from_file_location') as load:
            with self.assertRaises(mv.Refused):
                mv.normal_inventory(self.tool)
        load.assert_not_called()


if __name__ == '__main__':
    unittest.main()
