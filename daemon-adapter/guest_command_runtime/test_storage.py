import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from guest_command_runtime.storage import Store, StorageError


class StoreTests(unittest.TestCase):
    def test_unaccounted_old_spool_cannot_create_fresh_owner(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root,'job-old.stdout').write_bytes(b'residue')
            with self.assertRaisesRegex(StorageError, 'unaccounted'):
                Store(root,'a'*64)

    def test_reopen_fences_replay_and_checks_configuration(self):
        with tempfile.TemporaryDirectory() as root:
            with_store = Store(root, 'a'*64)
            with_store.append({'kind':'intent','request_id':'request-one'})
            with_store.close()
            reopened = Store(root, 'a'*64)
            self.assertTrue(reopened.recovery_required)
            self.assertEqual(len(reopened.rows), 2)
            with self.assertRaises(StorageError): reopened.append({'kind':'replay'})
            reopened.close()
            with self.assertRaises(StorageError): Store(root, 'b'*64)

    def test_binary_outputs_count_hash_and_chunk_order(self):
        with tempfile.TemporaryDirectory() as root:
            store = Store(root, 'a'*64)
            try:
                store.begin_output('job-one')
                store.retain('job-one','stdout',0,b'a\0\xff')
                store.retain('job-one','stderr',0,b'err')
                summary = store.output_summary('job-one')
                self.assertEqual(summary['stdout']['sha256'],hashlib.sha256(b'a\0\xff').hexdigest())
                self.assertEqual(summary['stderr']['bytes'],3)
                with self.assertRaises(StorageError): store.retain('job-one','stdout',0,b'replayed')
                self.assertEqual(Path(root,'job-one.stdout').read_bytes(), b'a\0\xff')
                with self.assertRaises(StorageError): store.begin_output('../foreign')
                with self.assertRaises(StorageError): store.begin_output('job-one')
            finally: store.close()

    def test_limit_and_persistence_failure_are_not_success(self):
        with tempfile.TemporaryDirectory() as root:
            store = Store(root, 'a'*64)
            try:
                store.begin_output('job-one')
                for index in range(4): store.retain('job-one','stdout',index,b'x'*16384)
                with self.assertRaises(StorageError): store.retain('job-one','stderr',0,b'x')
                with patch('guest_command_runtime.storage.os.fsync',side_effect=OSError('storage fault')):
                    with self.assertRaises(OSError): store.append({'kind':'fault'})
                self.assertTrue(store.poisoned)
                with self.assertRaises(StorageError): store.append({'kind':'later'})
            finally: store.close()

    def test_tampered_partial_or_public_journal_rejected(self):
        for mutation in ('partial','hash','mode','hardlink'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as root:
                store=Store(root,'a'*64);store.close()
                file=Path(root,'journal.jsonl')
                if mutation=='partial': file.write_bytes(file.read_bytes()[:-1])
                if mutation=='hash': file.write_bytes(file.read_bytes().replace(b'"seq":1',b'"seq":2'))
                if mutation=='mode': file.chmod(0o644)
                if mutation=='hardlink': os.link(file,Path(root,'other'))
                with self.assertRaises(StorageError): Store(root,'a'*64)


if __name__=='__main__': unittest.main()
