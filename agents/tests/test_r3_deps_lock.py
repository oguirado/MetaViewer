"""Pinned dependency bytes cannot hide behind index flags or stat hints."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents.perception.deps_lock import DependencyLockError, resolve_locked_component


class DependencyTreeRegressionTests(unittest.TestCase):
    def test_suppression_flags_dirty_bytes_and_negative_controls(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / 'repo'
            repo.mkdir()
            def git(*args):
                return subprocess.run(['git', '-C', str(repo), *args], check=True,
                    capture_output=True, text=True, timeout=10,
                    env={'PATH': os.environ.get('PATH', os.defpath), 'HOME': str(root),
                         'LANG': 'C', 'GIT_CONFIG_NOSYSTEM': '1'}).stdout.strip()
            git('init', '-q')
            file = repo / 'tracked'
            file.write_bytes(b'original')
            git('add', 'tracked')
            # Fixture commits are confined to the disposable repository.
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                'commit', '-qm', 'fixture')
            commit = git('rev-parse', 'HEAD')
            lock = root / 'deps.lock'
            lock.write_text(json.dumps({'components': [dict(name=name, commit=commit)
                for name in ('vision-engine', 'wender-agent')]}))
            with mock.patch.dict(os.environ, {'VQA_VE_ROOT': str(repo)}):
                def resolve():
                    return resolve_locked_component('vision-engine', lock_path=lock)
                (repo / 'untracked').write_text('allowed')
                self.assertEqual(resolve(), repo)
                for flag in ('assume-unchanged', 'skip-worktree'):
                    git('update-index', '--' + flag, 'tracked')
                    file.write_bytes(b'modified')
                    self.assertEqual(git('status', '--porcelain', '--untracked-files=no'), '')
                    with self.assertRaises(DependencyLockError) as caught:
                        resolve()
                    self.assertEqual(caught.exception.code, 'dirty_tree')
                    file.write_bytes(b'original')
                    git('update-index', '--no-' + flag, 'tracked')
                    self.assertEqual(resolve(), repo)
                # Equal size and restored mtime exercise direct byte verification.
                original_stat = file.stat()
                file.write_bytes(b'changed!')
                os.utime(file, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
                with self.assertRaises(DependencyLockError) as caught:
                    resolve()
                self.assertEqual(caught.exception.code, 'dirty_tree')
                file.write_bytes(b'original')
                self.assertEqual(resolve(), repo)


if __name__ == '__main__':
    unittest.main()
