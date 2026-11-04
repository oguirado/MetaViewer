"""Synthetic files and mocked closes only; no host native effects."""
import copy
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from .config import BROKER_SHA, APPROVED, validate
from .native import Native, pin

CONFIG={'schema':'rewind-host-config/v1','runtime_admitted':False,'owner_id':'actor-test','runtime_root':'/dev/shm/synthetic','external_cgroup':'/sys/fs/cgroup/synthetic','startup_seconds':5,'stop_seconds':5,
'artifacts':{k:{'path':'/synthetic/'+k,'sha256':APPROVED[k]} for k in ('engine','kernel','broker','busybox')}}
class Tests(unittest.TestCase):
    def test_config_closed_pinned_and_typed(self):
        validate(CONFIG)
        for key,value in [('runtime_admitted',1),('startup_seconds',True),('runtime_root','//dev/shm/x')]:
            bad=copy.deepcopy(CONFIG);bad[key]=value
            with self.assertRaises(ValueError):validate(bad)
        bad=copy.deepcopy(CONFIG);bad['artifacts']['broker']['sha256']='b'*64
        with self.assertRaises(ValueError):validate(bad)
    def test_private_point_custody(self):
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            path=Path(d)/'point';path.write_bytes(b'SYNTHETIC');path.chmod(0o600);self.assertEqual(pin(path)['bytes'],9)
            os.link(path,Path(d)/'alias')
            with self.assertRaises(RuntimeError):pin(path)
    def synthetic_ring(self,root):
        native=Native(CONFIG);native.root=root;native.paused=True;native.point_order=2;native.record=Mock()
        for order,key in enumerate(('point-a','point-b'),1):
            for suffix in ('.state','.mem'):
                path=root/(key+suffix);path.write_bytes(b'SYNTHETIC');path.chmod(0o600)
            native.points[key]={'point_id':key,'created_order':order,'compatibility_hash':native.compatibility,'counter':1,'state':pin(root/(key+'.state')),'memory':pin(root/(key+'.mem'))}
        return native
    def test_rotation_never_unlinks_active_point(self):
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            root=Path(d);native=self.synthetic_ring(root);native.mapped='point-a'
            def write(*args):
                for suffix in ('.state','.mem'):
                    path=root/('point-c'+suffix);path.write_bytes(b'NEW');path.chmod(0o600)
            native._api=Mock(side_effect=write);point=native.snapshot('point-c');native.finalize_mark('point-c')
            self.assertEqual(set(native.points),{'point-a','point-c'});self.assertEqual(point['created_order'],3)
            self.assertTrue((root/'point-a.mem').exists());self.assertFalse((root/'point-b.mem').exists())
    def test_owner_commit_failure_can_restore_prior_ring(self):
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            root=Path(d);native=self.synthetic_ring(root)
            def write(*args):
                for suffix in ('.state','.mem'):
                    p=root/('point-c'+suffix);p.write_bytes(b'NEW');p.chmod(0o600)
            native._api=Mock(side_effect=write);native.snapshot('point-c');native.rollback_mark('point-c')
            self.assertEqual(set(native.points),{'point-a','point-b'});self.assertIn('point-c',native.staged)
            self.assertTrue((root/'point-a.mem').exists());self.assertTrue((root/'point-b.mem').exists())
    def test_missing_created_clock_preserves_prior_points(self):
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            root=Path(d);native=self.synthetic_ring(root)
            def write(*args):
                for suffix in ('.state','.mem'):
                    p=root/('point-c'+suffix);p.write_bytes(b'NEW');p.chmod(0o600)
            native._api=Mock(side_effect=write)
            with patch('rewind_runtime.native.time.monotonic_ns',return_value=0),self.assertRaises(RuntimeError):native.snapshot('point-c')
            self.assertEqual(set(native.points),{'point-a','point-b'})
    def test_failed_staging_preserves_both_good_points(self):
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            root=Path(d);native=self.synthetic_ring(root);native._api=Mock(side_effect=OSError('snapshot failure'))
            with self.assertRaises(OSError):native.snapshot('point-c')
            self.assertEqual(set(native.points),{'point-a','point-b'})
            self.assertTrue((root/'point-a.mem').exists());self.assertTrue((root/'point-b.mem').exists())
    def test_unpaused_snapshot_refused(self):
        native=Native(CONFIG);native._api=Mock()
        with self.assertRaises(RuntimeError):native.snapshot('point-one')
        native._api.assert_not_called()
    def test_poisoned_ledger_still_closes_but_never_releases(self):
        native=Native(CONFIG);native.poisoned=True;native.close_process=Mock(return_value={})
        with self.assertRaises(RuntimeError):native.stop()
        native.close_process.assert_called_once();self.assertFalse(native.closed)
    def test_failed_journal_prevents_process_launch(self):
        native=Native(CONFIG);native.record=Mock(side_effect=OSError('synthetic journal failure'))
        with patch('rewind_runtime.native.scope'),patch('rewind_runtime.native.subprocess.Popen') as popen:
            with self.assertRaises(OSError):native._spawn()
            popen.assert_not_called()
    def test_unknown_close_prevents_replacement_process(self):
        native=Native(CONFIG);native.mapped='point-old';native.record=Mock();native.verify_point=Mock()
        native.close_process=Mock(side_effect=RuntimeError('closure unknown'));native._spawn=Mock()
        with self.assertRaises(RuntimeError):native.restore('point-new')
        native._spawn.assert_not_called();self.assertEqual(native.mapped,'point-old')
    def test_base_owner_excludes_second_actor_and_stale_runtime(self):
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            root=Path(d);first=Native(CONFIG);first._claim_base(root);second=Native(CONFIG)
            with self.assertRaises(BlockingIOError):second._claim_base(root)
            os.close(first.base_owner);first.base_owner=None
            (root/'old-runtime').mkdir()
            with self.assertRaises(RuntimeError):second._claim_base(root)
    def test_stop_intent_write_failure_still_attempts_close(self):
        native=Native(CONFIG);native.ledger=123;native.close_process=Mock()
        with patch('rewind_runtime.native.os.fstat',return_value=type('Stat',(),{'st_size':0})()),patch('rewind_runtime.native.os.write',side_effect=OSError('disk failure')):
            with self.assertRaises(RuntimeError):native.stop()
        native.close_process.assert_called_once();self.assertTrue(native.poisoned);self.assertFalse(native.closed)
    def test_stop_before_allocation_fences_future_effects(self):
        native=Native(CONFIG);self.assertTrue(native.stop()['closed'])
        with self.assertRaises(RuntimeError):native.allocate()
        self.assertIsNone(native.root)
