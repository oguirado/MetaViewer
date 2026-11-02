"""P18D tool contracts against synthetic public control metadata only."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('p18d_identity', os.environ.get('P18D_IDENTITY_SOURCE', str(ROOT/'tools/mv_identity.py')))
mv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mv)


class P18DToolFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='p18d-control-')
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.root = base/'store'
        for path in [self.root, base/'home', base/'bin']:
            path.mkdir(mode=0o700)
        self.tool = mv.Identities(str(self.root), str(base/'home'), str(base/'bin'))
        self.tool.show = Mock(return_value={'profile_id':'p18d-test'})
        self.tool.native = Mock(return_value={})



class P18DToolTests(P18DToolFixture):
    def test_empty_sites_and_normalized_sites_reach_native_admin(self):
        self.tool.provision = Mock()
        for sites in ['', 'a.com,z.org']:
            self.tool.create('p18d-test', 'Work', sites)
            args = self.tool.native.call_args.args
            self.assertEqual(args[0], 'srf-identity-admin')
            self.assertEqual(args[1], ['create', '--store-root', str(self.root), '--id', 'p18d-test', '--label', 'Work', '--domains', sites])
        for sites in ['z.org,a.com', 'a.com,a.com', 'A.com', 'a.com,', 'bad_host', ','.join('a'+str(i)+'.com' for i in range(17))]:
            self.tool.native.reset_mock()
            with self.assertRaisesRegex(mv.Refused, 'INVALID_DOMAINS'):
                self.tool.create('p18d-test', 'Work', sites)
            self.tool.native.assert_not_called()

    def test_delete_active_identity_refused_then_stopped_identity_deleted(self):
        for name in ['metadata', 'profiles', 'locks']:
            (self.root/name).mkdir(mode=0o700)
        metadata = self.root/'metadata/p18d-test.json'
        metadata.write_text('{}')
        profile = self.root/'profiles/p18d-test'
        profile.mkdir(mode=0o700)
        lock = self.root/'locks/p18d-test.json'
        lock.write_text(json.dumps({'active':True}))
        lock.chmod(0o600)
        with self.assertRaisesRegex(mv.Refused, 'IDENTITY_BOUND'):
            self.tool.delete('p18d-test')
        self.assertTrue(metadata.exists())
        self.assertTrue(profile.exists())
        lock.write_text(json.dumps({'active':False}))
        def remove_profile(identity, remove=False):
            self.assertTrue(remove)
            self.assertTrue(metadata.exists(), 'metadata remains retryable until profile removal succeeds')
            self.assertTrue(lock.exists(), 'inactive lease remains until profile removal succeeds')
            profile.rmdir()
        self.tool.profile_helper = Mock(side_effect=remove_profile)
        self.assertEqual(self.tool.delete('p18d-test'), {'deleted':'p18d-test'})
        self.assertFalse(metadata.exists())
        self.assertFalse(profile.exists())
        self.assertFalse(lock.exists())
        self.assertTrue((self.root/'locks/p18d-test.guard').exists())


class P18DProvisionTests(P18DToolFixture):
    def setUp(self):
        super().setUp()
        for name in ['metadata', 'profiles', 'locks']:
            (self.root/name).mkdir(mode=0o700)
        self.identity = 'p18d-test'
        self.target = self.root/'profiles'/self.identity
        self.target.mkdir(mode=0o700)
        self.metadata = self.root/'metadata'/(self.identity+'.json')
        self.metadata.write_text('{}')
        self.metadata.chmod(0o600)

    def fake_helper(self, command, **kwargs):
        self.assertEqual(command[:4], ['docker', 'run', '--rm', '--pull=never'])
        self.assertEqual(command[command.index('--network')+1], 'none')
        self.assertEqual(command[command.index('--user')+1], '0')
        self.assertEqual(command[command.index('--entrypoint')+1], '/bin/sh')
        self.assertEqual(command[command.index('--mount')+1],
                         'type=bind,src='+str(self.root/'profiles')+',dst=/profiles')
        self.assertEqual(command.count('--mount'), 1)
        self.assertRegex(command[command.index('--name')+1], r'^mv-provision-p18d-test-[a-f0-9]{12}$')
        self.assertEqual(command[-1], self.identity)
        self.assertIn('test ! -L', command[-3])
        self.assertIn('realpath', command[-3])
        self.assertIn('chown 10001:10001', command[-3])
        self.assertIn('chmod 0700', command[-3])
        self.assertEqual(kwargs['timeout'], mv.PROFILE_TIMEOUT)
        return Mock(returncode=0)

    def stat_as(self, uid=10001, mode=0o700, gid=10001):
        original = Path.lstat
        def lstat(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if path == self.target:
                fields = list(result)
                fields[0] = (fields[0] & ~0o7777) | mode
                fields[4], fields[5] = uid, gid
                return os.stat_result(fields)
            return result
        return patch.object(Path, 'lstat', lstat)

    def test_bad_id_refused_before_helper(self):
        with patch.object(mv.subprocess, 'run') as run:
            for identity in ['../outside', '/tmp/outside', 'p18d/a', 'Bad-id', 'x']:
                with self.assertRaisesRegex(mv.Refused, 'INVALID_ID'):
                    self.tool.provision(identity)
            run.assert_not_called()

    def test_symlinked_target_refused_before_helper(self):
        self.target.rmdir()
        outside = self.root.parent/'outside'
        outside.mkdir(mode=0o700)
        self.target.symlink_to(outside, target_is_directory=True)
        with patch.object(mv.subprocess, 'run') as run:
            with self.assertRaisesRegex(mv.Refused, 'UNSAFE_IDENTITY_PATH'):
                self.tool.provision(self.identity)
            run.assert_not_called()
        self.assertTrue(outside.is_dir())

    def test_profiles_outside_root_refused_before_helper(self):
        self.target.rmdir()
        profiles = self.root/'profiles'
        profiles.rmdir()
        outside = self.root.parent/'outside'
        outside.mkdir(mode=0o700)
        profiles.symlink_to(outside, target_is_directory=True)
        with patch.object(mv.subprocess, 'run') as run:
            with self.assertRaisesRegex(mv.Refused, 'UNSAFE_CONTROL_PATH'):
                self.tool.provision(self.identity)
            run.assert_not_called()
        self.assertFalse((outside/self.identity).exists())

    def test_mount_delimiter_refused_before_helper(self):
        moved = self.root.with_name('unsafe,source')
        self.root.rename(moved)
        self.tool.root = moved
        with patch.object(mv.subprocess, 'run') as run:
            with self.assertRaisesRegex(mv.Refused, 'UNSAFE_IDENTITY_PATH'):
                self.tool.provision(self.identity)
            run.assert_not_called()

    def test_missing_target_created_and_verified(self):
        self.target.rmdir()
        def create(command, **kwargs):
            self.fake_helper(command, **kwargs)
            self.target.mkdir(mode=0o700)
            return Mock(returncode=0)
        with patch.object(mv.subprocess, 'run', side_effect=create), self.stat_as():
            self.tool.provision(self.identity)
        self.assertTrue(self.target.is_dir())

    def test_success_requires_stat_owner_and_private_mode(self):
        with patch.object(mv.subprocess, 'run', side_effect=self.fake_helper) as run, self.stat_as():
            self.tool.provision(self.identity)
            run.assert_called_once()
        self.tool.show.assert_called_once_with(self.identity)

    def test_helper_success_with_wrong_owner_mode_or_gid_refused(self):
        for values in [dict(uid=1000), dict(mode=0o750), dict(mode=0o4700), dict(gid=1000)]:
            with self.subTest(values=values), self.stat_as(**values), patch.object(mv.subprocess, 'run', return_value=Mock(returncode=0)):
                with self.assertRaisesRegex(mv.Refused, 'PROFILE_NOT_PROVISIONED'):
                    self.tool.provision(self.identity)

    def test_absent_store_identity_never_runs_helper(self):
        self.tool.show.side_effect = mv.Refused('NATIVE_REFUSED')
        with patch.object(mv.subprocess, 'run') as run:
            with self.assertRaisesRegex(mv.Refused, 'NATIVE_REFUSED'):
                self.tool.provision(self.identity)
            run.assert_not_called()

    def test_post_helper_symlink_swap_refused(self):
        outside = self.root.parent/'outside'
        outside.mkdir(mode=0o700)
        def swap(*args, **kwargs):
            self.target.rmdir()
            self.target.symlink_to(outside, target_is_directory=True)
            return Mock(returncode=0)
        with patch.object(mv.subprocess, 'run', side_effect=swap) as run:
            with self.assertRaisesRegex(mv.Refused, 'PROFILE_NOT_PROVISIONED'):
                self.tool.provision(self.identity)
        self.assertTrue(outside.is_dir())

    def test_timeout_without_cid_never_removes_a_container_and_keeps_sudo_hint(self):
        with patch.object(mv.subprocess, 'run', side_effect=[mv.subprocess.TimeoutExpired('docker', 30), Mock(returncode=0)]) as run:
            with self.assertRaisesRegex(mv.Refused, 'PROFILE_NOT_PROVISIONED'):
                self.tool.provision(self.identity)
            run.assert_called_once()
            self.assertIn('--cidfile',run.call_args.args[0])
        self.assertIn('sudo install -d -m 0700 -o 10001 -g 10001', mv.HINTS['PROFILE_NOT_PROVISIONED'])

    def test_delete_unsafe_path_preserves_store(self):
        self.target.rmdir()
        outside = self.root.parent/'outside'
        outside.mkdir(mode=0o700)
        self.target.symlink_to(outside, target_is_directory=True)
        with patch.object(mv.subprocess, 'run') as run:
            with self.assertRaisesRegex(mv.Refused, 'UNSAFE_IDENTITY_PATH'):
                self.tool.delete(self.identity)
            run.assert_not_called()
        self.assertTrue(self.metadata.exists())
        self.assertTrue(outside.is_dir())

    def test_delete_retains_store_until_helper_success_and_refuses_open(self):
        record = self.root/'locks'/(self.identity+'.json')
        record.write_text(json.dumps({'active': True}))
        record.chmod(0o600)
        with patch.object(mv.subprocess, 'run') as run:
            with self.assertRaisesRegex(mv.Refused, 'IDENTITY_BOUND'):
                self.tool.delete(self.identity)
            run.assert_not_called()
        self.assertTrue(self.metadata.exists())
        self.assertTrue(self.target.exists())
        record.write_text(json.dumps({'active': False}))
        def remove(command, **kwargs):
            self.assertTrue(self.metadata.exists(), 'metadata remains retryable until helper success')
            self.assertIn('rm -rf -- "$p"', command[-3])
            self.target.rmdir()
            return Mock(returncode=0)
        with patch.object(mv.subprocess, 'run', side_effect=remove) as run:
            self.assertEqual(self.tool.delete(self.identity), {'deleted': self.identity})
            run.assert_called_once()
        self.assertFalse(self.target.exists())

    def test_remove_helper_refuses_existing_store_entry(self):
        with patch.object(mv.subprocess, 'run') as run:
            with self.assertRaisesRegex(mv.Refused, 'IDENTITY_BOUND'):
                self.tool.profile_helper(self.identity, remove=True)
            run.assert_not_called()

    def test_create_provisions_before_reporting_success(self):
        with patch.object(self.tool, 'provision') as provision:
            self.assertEqual(self.tool.create(self.identity, 'Work', ''), {'profile_id': self.identity})
            provision.assert_called_once_with(self.identity)
        with patch.object(self.tool, 'provision', side_effect=mv.Refused('PROFILE_NOT_PROVISIONED')):
            with self.assertRaisesRegex(mv.Refused, 'PROFILE_NOT_PROVISIONED'):
                self.tool.create(self.identity, 'Work', '')


if __name__ == '__main__':
    unittest.main()
