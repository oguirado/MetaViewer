"""Fixture-only hardening regressions; never opens a real identity store."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('p18g_identity', os.environ.get('P18G_IDENTITY_SOURCE', str(Path(__file__).resolve().parents[1]/'tools/mv_identity.py')))
mv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mv)
FOREIGN = ['cuentas-new', 'perplexity-new', 'srf-id-cuentas-new', 'srf-id-perplexity-new', 'srf-pg-new', *mv.PROTECTED_HOLDERS]

class Hardening(unittest.TestCase):
    def test_foreign_operations_refuse_before_store_access(self):
        tool = mv.Identities.__new__(mv.Identities)
        tool.live_profile = 'mv-live-3'
        tool.show = Mock(side_effect=AssertionError('STORE_TOUCHED'))
        for identity in FOREIGN:
            for method,args in [('login',()), ('create',('Label','')), ('provision',()), ('delete',()), ('release',('srf-id-fixture',)), ('profile_helper',())]:
                with self.subTest(identity=identity,method=method):
                    with self.assertRaisesRegex(mv.Refused, '^IDENTITY_PROTECTED$'):
                        getattr(tool, method)(identity,*args)
        tool.show.assert_not_called()

    def test_foreign_lease_holders_never_receive_login_or_release_commands(self):
        tool,_,_=self.fixture()
        state=tool.root/'state';state.mkdir(mode=0o700);tool.state_dir=str(state)
        tool.native=Mock(side_effect=AssertionError('FOREIGN_HOLDER_TOUCHED'))
        tool.bin_dir=tool.root
        guard=patch.object(mv.subprocess,'Popen',side_effect=AssertionError('FOREIGN_HOLDER_TOUCHED'))
        spawn=guard.start();self.addCleanup(guard.stop)
        for holder in ['srf-id-cuentas-other','srf-id-perplexity-other','srf-pg-other']:
            tool.lease=Mock(return_value={'active':True,'holder':holder})
            with self.subTest(holder=holder):
                with self.assertRaisesRegex(mv.Refused,'IDENTITY_PROTECTED'):
                    tool.login('fixture-owned')
                with self.assertRaisesRegex(mv.Refused,'PROTECTED_CONTAINER'):
                    tool.release('fixture-owned',holder)
        tool.native.assert_not_called()
        spawn.assert_not_called()

    def test_failed_helper_creation_never_removes_an_unproven_container_name(self):
        tool,_,_=self.fixture()
        with patch.object(mv.subprocess,'run',side_effect=[Mock(returncode=125),Mock(returncode=0)]) as run:
            with self.assertRaisesRegex(mv.Refused,'PROFILE_NOT_PROVISIONED'):
                tool.provision('fixture-owned')
        self.assertEqual(run.call_count,1,'a failed create without a CID must never remove a name')

    def test_helper_timeout_cleans_only_recorded_cid_and_persists_failed_cleanup(self):
        for cleanup_rc in [0,1,"timeout"]:
            tool,_,_=self.fixture();cid='a'*64;calls=[]
            def run(command,**kwargs):
                calls.append(command)
                if command[1]=='run':
                    if '--cidfile' in command:
                        path=Path(command[command.index('--cidfile')+1]);path.write_text(cid);path.chmod(0o600)
                    raise mv.subprocess.TimeoutExpired('docker',15)
                if cleanup_rc == "timeout":
                    raise mv.subprocess.TimeoutExpired("docker-rm",5)
                return Mock(returncode=cleanup_rc)
            with patch.object(mv.subprocess,'run',side_effect=run):
                with self.assertRaisesRegex(mv.Refused,'PROFILE_NOT_PROVISIONED'):
                    tool.provision('fixture-owned')
            self.assertEqual(calls[1],['docker','rm','-f',cid])
            receipts=list((tool.root/'locks/profile-helpers').glob('*.json'))
            self.assertEqual(len(receipts),int(cleanup_rc!=0))
            if receipts:
                record=__import__('json').loads(receipts[0].read_text())
                self.assertEqual(record['container_id'],cid)
                self.assertEqual(record['state'],'cleanup_pending')
                self.assertEqual(receipts[0].stat().st_mode & 0o777,0o600)

    def fixture(self):
        temp = tempfile.TemporaryDirectory(prefix='p18g-fixture-')
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        root.chmod(0o700)
        for name in ['metadata','profiles','locks']:
            (root/name).mkdir(mode=0o700)
        tool = mv.Identities.__new__(mv.Identities)
        tool.root=root; tool.live_profile='mv-live-3'; tool.profile_uid=os.getuid()
        tool.show=Mock(return_value={'profile_id':'fixture-owned'})
        metadata=root/'metadata/fixture-owned.json'
        profile=root/'profiles/fixture-owned'
        profile.mkdir(mode=0o700)
        return tool,metadata,profile

    def test_create_rolls_back_metadata_when_provision_fails(self):
        tool,metadata,_=self.fixture()
        def create_entry(*a,**kw):
            metadata.write_text('{}'); metadata.chmod(0o600)
        tool.native=Mock(side_effect=create_entry)
        tool.profile_helper=Mock(side_effect=mv.Refused('PROFILE_NOT_PROVISIONED'))
        with self.assertRaisesRegex(mv.Refused,'PROFILE_NOT_PROVISIONED'):
            tool.create('fixture-owned','Label','')
        self.assertFalse(metadata.exists())

    def test_delete_can_finish_after_crash_between_profile_and_metadata_removal(self):
        tool,metadata,profile=self.fixture()
        metadata.write_text('{}');profile.rmdir()
        tool.profile_helper=Mock()
        self.assertEqual(tool.delete('fixture-owned'),{'deleted':'fixture-owned'})
        self.assertFalse(metadata.exists())

    def test_delete_helper_failure_can_be_retried(self):
        tool,metadata,profile=self.fixture()
        metadata.write_text('{}')
        tool.profile_helper=Mock(side_effect=mv.Refused('PROFILE_NOT_PROVISIONED'))
        with self.assertRaisesRegex(mv.Refused,'PROFILE_NOT_PROVISIONED'):
            tool.delete('fixture-owned')
        self.assertTrue(metadata.exists())
        tool.profile_helper=Mock(side_effect=lambda *a,**kw: profile.rmdir())
        self.assertEqual(tool.delete('fixture-owned'),{'deleted':'fixture-owned'})
        self.assertFalse(metadata.exists())
        self.assertFalse(profile.exists())

if __name__ == '__main__': unittest.main()
