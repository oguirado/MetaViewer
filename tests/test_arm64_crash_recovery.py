"""Synthetic crash recovery only; no native process, Docker or systemd queries."""
import importlib.util
import fcntl
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import test_arm64_capsule_reconcile as fixture

SPEC = importlib.util.spec_from_file_location('crash_session', Path(__file__).resolve().parents[1] / 'tools/arm64_capsule_session.py')
session = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(session)
r = fixture.r


class CrashRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture.InventoryTests('test_new_contract_clean_proof_releases_only_exact_marker')
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.f.native_resource()
        journal = self.f.root / 'allocations.jsonl'
        # Model a crash after authenticated binding, before native closure/seals.
        journal.write_bytes(b'\n'.join(journal.read_bytes().splitlines()[:-1]) + b'\n')

    def recover(self, observer=None):
        with self.f.payload_metadata():
            return r.reconcile_held(self.f.marker, recover_crashed=True,
                                    observer=observer or self.f.Absent())

    def test_crashed_bound_inventory_recovers_only_explicitly_without_rewriting(self):
        before = (self.f.root / 'allocations.jsonl').read_bytes()
        with self.assertRaises(r.Refused):
            r.reconcile_held(self.f.marker, release=True, observer=self.f.Absent())
        result = self.recover()
        self.assertEqual(result['status'], 'released')
        self.assertFalse(self.f.marker.exists())
        self.assertEqual((self.f.root / 'allocations.jsonl').read_bytes(), before)
        proof = json.loads(Path(result['proof']).read_text())
        self.assertEqual(proof['recovery_mode'], 'crashed-owner')
        self.assertFalse(proof['coordinator_sealed'])
        self.assertEqual(proof['producer_seals'], [])
        self.assertTrue(self.f.root.exists())

    def test_live_or_unknown_process_and_container_remain_held(self):
        f = self.f
        class Live(f.Absent):
            def pid_start(self, pid):
                return 77 if pid == 9999 else None
        class Unknown(f.Absent):
            def pid_start(self, pid):
                return False
        class Container(f.Absent):
            def docker_ids(self):
                return {f.cid}
        for observer in (Live(), Unknown(), Container()):
            with self.subTest(observer=type(observer).__name__):
                with self.assertRaises(r.Refused):
                    self.recover(observer)
                self.assertTrue(f.marker.exists())

    def test_reused_pid_is_absence_but_replaced_unit_is_not(self):
        class Replaced(self.f.Absent):
            def unit(self, unit):
                return {'LoadState': 'loaded', 'ActiveState': 'inactive',
                        'ControlGroup': '', 'InvocationID': 'b' * 32, 'MainPID': '0'}
        with self.assertRaises(r.Refused):
            self.recover(Replaced())
        class Reused(self.f.Absent):
            def pid_start(self, pid):
                return 999
        self.assertEqual(self.recover(Reused())['status'], 'released')

    def test_unknown_and_unbound_rows_never_recover(self):
        f = self.f
        journal = f.root / 'allocations.jsonl'
        bound = journal.read_bytes()
        journal.write_bytes(b'\n'.join(bound.splitlines()[:-1]) + b'\n')
        with self.assertRaises(r.Refused):
            self.recover()
        journal.write_bytes(bound)
        f.append('graphical', {'stage': 'unknown', 'producer': 'graphical',
                              'id': 'unresolved', 'reason': 'synthetic crash uncertainty'})
        with self.assertRaises(r.Refused):
            self.recover()
        self.assertTrue(f.marker.exists())

    def test_torn_prefix_source_change_and_missing_root_remain_held(self):
        f = self.f
        journal = f.root / 'allocations.jsonl'
        raw = journal.read_bytes()
        journal.write_bytes(raw[:-5])
        with self.assertRaises(r.Refused):
            self.recover()
        journal.write_bytes(raw)
        helper = Path(f.setup_pin['path'])
        saved = helper.read_bytes()
        helper.write_bytes(saved + b'changed')
        with self.assertRaises(r.Refused):
            self.recover()
        helper.write_bytes(saved)
        moved = f.root.with_name(f.root.name + '-gone')
        f.root.rename(moved)
        self.addCleanup(lambda: moved.rename(f.root))
        with self.assertRaises((r.Refused, OSError)):
            self.recover()
        self.assertTrue(f.marker.exists())

    def test_custody_change_during_proofs_remains_held(self):
        f = self.f
        class Racing(f.Absent):
            def docker_ids(self):
                with (f.root / 'allocations.jsonl').open('ab') as stream:
                    stream.write(b'\n')
                return set()
        with self.assertRaises(r.Refused):
            self.recover(Racing())
        self.assertTrue(f.marker.exists())

    def test_replaced_marker_and_changed_source_during_proofs_remain_held(self):
        f = self.f
        class MarkerRace(f.Absent):
            def docker_ids(self):
                raw = f.marker.read_bytes()
                f.marker.unlink()
                f.marker.write_bytes(raw)
                f.marker.chmod(0o600)
                return set()
        with self.assertRaises(r.Refused):
            self.recover(MarkerRace())
        class SourceRace(f.Absent):
            def docker_ids(self):
                Path(f.setup_pin['path']).write_bytes(b'changed source')
                return set()
        with self.assertRaises(r.Refused):
            self.recover(SourceRace())
        self.assertTrue(f.marker.exists())

    def test_active_inventory_writer_remains_held(self):
        with (self.f.root / 'allocations.lock').open('rb') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.recover()
        self.assertTrue(self.f.marker.exists())

    def test_durable_proof_precedes_marker_removal(self):
        original = os.unlink
        observed = []
        def unlink(path, *args, **kwargs):
            if Path(path) == self.f.marker:
                proofs = list(self.f.registry.glob('reconciled-*.json'))
                self.assertEqual(len(proofs), 1)
                self.assertEqual(json.loads(proofs[0].read_text())['recovery_mode'], 'crashed-owner')
                observed.append(True)
            return original(path, *args, **kwargs)
        with patch.object(r.os, 'unlink', side_effect=unlink):
            self.assertEqual(self.recover()['status'], 'released')
        self.assertEqual(observed, [True])

    def test_proof_sync_failure_keeps_marker(self):
        with patch.object(r.os, 'fsync', side_effect=OSError('synthetic proof failure')):
            with self.assertRaises(OSError):
                self.recover()
        self.assertTrue(self.f.marker.exists())


class HeldPublicationTests(unittest.TestCase):
    def test_atomic_publication_failure_leaves_no_empty_final(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            with patch.object(session, '_rename_noreplace', side_effect=OSError('synthetic interruption')):
                with self.assertRaises(OSError):
                    session.publish_held_marker(directory, {'status': 'closure-unproven'})
            self.assertFalse((directory / 'held-session.json').exists())
            self.assertEqual(list(directory.iterdir()), [])

    def test_publication_is_private_complete_and_no_replace(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            value = {'root': '/synthetic', 'unit': 'synthetic.scope', 'status': 'closure-unproven'}
            session.publish_held_marker(directory, value)
            path = directory / 'held-session.json'
            self.assertEqual(json.loads(path.read_text()), value)
            self.assertEqual(path.stat().st_nlink, 1)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(OSError):
                session.publish_held_marker(directory, {'changed': True})
            self.assertEqual(json.loads(path.read_text()), value)
            path.unlink()
            victim = directory / 'victim'
            victim.write_text('unchanged')
            path.symlink_to(victim)
            with self.assertRaises(OSError):
                session.publish_held_marker(directory, value)
            self.assertEqual(victim.read_text(), 'unchanged')

    def test_sync_failure_before_publication_never_exposes_partial_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            with patch.object(session.os, 'fsync', side_effect=OSError('synthetic write failure')):
                with self.assertRaises(OSError):
                    session.publish_held_marker(directory, {'status': 'closure-unproven'})
            self.assertFalse((directory / 'held-session.json').exists())
            self.assertEqual(list(directory.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
