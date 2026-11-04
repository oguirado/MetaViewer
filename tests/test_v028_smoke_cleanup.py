"""Focused offline smoke ownership and stop regressions."""
import json
import os
import signal
import subprocess
import time
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent / 'judge'))
from judge_sandbox import Sandbox


class SmokeStop(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.sb = Sandbox(tmp.name)
        self.addCleanup(self.sb.cleanup)

    def test_unverified_smoke_process_record_prevents_clean_stop(self):
        records = self.sb.jh / 'run' / 'smoke-processes'
        records.mkdir(parents=True)
        (records / 'record.pid').write_text('unverified identity\n')
        result = self.sb.judge('stop')
        self.assertEqual(result.rc, 2, result.text)
        self.assertIn('JUDGE_STOP_LEAK', result.codes)
        self.assertNotIn('JUDGE_STOP_CLEAN', result.text)
        self.assertTrue((records / 'record.pid').exists())

    def test_smoke_private_runtime_prevents_clean_stop(self):
        runtime = self.sb.jh / 'run' / 'smoke-tmp' / 'mv-pkg-leftover'
        runtime.mkdir(parents=True)
        result = self.sb.judge('stop')
        self.assertEqual(result.rc, 2, result.text)
        self.assertNotIn('JUDGE_STOP_CLEAN', result.text)
        self.assertTrue(runtime.exists())


    def test_long_judge_home_uses_short_recorded_private_smoke_runtime(self):
        self.sb.full_kit()
        self.sb.jh = self.sb.home / ('reviewer-name-' * 8) / '.local/share/metaviewer-judge'
        node = self.sb.bin / 'node'
        source = node.read_text().replace('--smoke) echo', '--smoke) printf "%s\\n" "$TMPDIR" > "$MV_FAKE_DIR/smoke-tmp"; stat -c %a "$TMPDIR" > "$MV_FAKE_DIR/smoke-mode"; ls "$MV_JUDGE_HOME/run/smoke-roots" > "$MV_FAKE_DIR/smoke-roots"; cat "$MV_JUDGE_HOME/run/smoke-roots/"*.json > "$MV_FAKE_DIR/smoke-owner.json"; echo')
        node.write_text(source)
        result = self.sb.judge('install', '--yes')
        self.assertEqual(result.rc, 0, result.text)
        root = Path((self.sb.fake / 'smoke-tmp').read_text().strip())
        self.assertEqual(root.parent, Path('/tmp'))
        self.assertTrue(root.name.startswith('mvj.'))
        self.assertEqual((self.sb.fake / 'smoke-mode').read_text().strip(), '700')
        self.assertTrue((self.sb.fake / 'smoke-roots').read_text().strip())
        owner = json.loads((self.sb.fake / 'smoke-owner.json').read_text())
        self.assertEqual(owner.get('phase'), 'running')
        self.assertEqual(owner['pid'], owner['group'])
        self.assertEqual(owner['pid'], owner['session'])
        self.assertFalse(root.exists(), 'successful smoke releases its short runtime')
        self.assertEqual(self.sb.judge('stop').rc, 0)

    def test_install_reconciles_dead_smoke_but_preserves_live_group(self):
        self.sb.full_kit()
        records = self.sb.jh / 'run/smoke-processes'
        records.mkdir(parents=True, mode=0o700)
        child = subprocess.Popen(['sleep', '30'], start_new_session=True)
        def reap():
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
        self.addCleanup(reap)
        fields = Path(f'/proc/{child.pid}/stat').read_text().rsplit(')', 1)[1].split()
        record = records / f'{child.pid}.pid'
        record.write_text(f'{child.pid} {fields[19]}\n')
        record.chmod(0o600)
        live = self.sb.judge('install', '--yes')
        self.assertEqual(live.rc, 2, live.text)
        self.assertIn('JUDGE_SMOKE_ACTIVE', live.codes)
        self.assertTrue(record.exists())
        self.assertIsNone(child.poll(), 'reconciliation never kills a recorded process')
        child.kill()
        child.wait(timeout=5)
        leftover = self.sb.jh / 'run/smoke-tmp/mv-clean-interrupted'
        leftover.mkdir(parents=True, mode=0o700)
        leftover.parent.chmod(0o700)
        (leftover / 'residue').write_text('interrupted')
        dead = self.sb.judge('install', '--yes')
        self.assertEqual(dead.rc, 0, dead.text)
        self.assertFalse(record.exists())
        self.assertFalse(leftover.exists())
        self.assertEqual(self.sb.judge('stop').rc, 0)


    def test_reused_pid_witness_is_preserved_without_signalling(self):
        self.sb.full_kit()
        records = self.sb.jh / 'run/smoke-processes'
        records.mkdir(parents=True, mode=0o700)
        record = records / f'{os.getpid()}.pid'
        record.write_text(f'{os.getpid()} 1\n')
        record.chmod(0o600)
        result = self.sb.judge('install', '--yes')
        self.assertEqual(result.rc, 2, result.text)
        self.assertIn('identity changed', result.text)
        self.assertTrue(record.exists())
        self.assertNotIn('--smoke', self.sb.log('node.log'))

    def test_short_runtime_receipt_prevents_clean_stop(self):
        roots = self.sb.jh / 'run/smoke-roots'
        roots.mkdir(parents=True, mode=0o700)
        (roots / 'interrupted.json').write_text('{}')
        result = self.sb.judge('stop')
        self.assertEqual(result.rc, 2, result.text)
        self.assertIn('JUDGE_STOP_LEAK', result.codes)
        self.assertTrue((roots / 'interrupted.json').exists())


    def test_unrepresentable_judge_home_is_refused_before_install(self):
        self.sb.full_kit()
        result = self.sb.judge('install', '--yes', env={'MV_JUDGE_HOME':str(self.sb.home / ('x' * 256))})
        self.assertEqual(result.rc, 2, result.text)
        self.assertIn('JUDGE_HOME_PATH', result.codes)
        self.assertIn('MV_JUDGE_HOME', result.text)
        self.assertIn('-- fix:', result.text)
        self.assertNotIn('--smoke', self.sb.log('node.log'))


    def test_install_removes_exited_short_root_by_recorded_directory_identity(self):
        self.sb.full_kit()
        child = subprocess.Popen(['sleep', '0.01'], start_new_session=True)
        fields = Path(f'/proc/{child.pid}/stat').read_text().rsplit(')', 1)[1].split()
        child.wait(timeout=5)
        roots = self.sb.jh / 'run/smoke-roots'
        roots.mkdir(parents=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix='mvj.', dir='/tmp') as tmp:
            root = Path(tmp)
            st = root.stat()
            (root / 'residue').write_text('interrupted')
            receipt = roots / (root.name + '.json')
            receipt.write_text(json.dumps(dict(path=str(root), dev=st.st_dev, ino=st.st_ino,
                pid=child.pid, start=fields[19], group=child.pid, session=child.pid)))
            receipt.chmod(0o600)
            result = self.sb.judge('install', '--yes')
            self.assertEqual(result.rc, 0, result.text)
            self.assertFalse(root.exists())
            self.assertFalse(receipt.exists())
            self.assertEqual(self.sb.judge('stop').rc, 0)
