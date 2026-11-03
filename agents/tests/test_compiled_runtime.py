"""Source-free runtime admission and executable discovery negative controls."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from metaviewer_agents.perception import compiled
from metaviewer_agents.perception.deps_lock import DependencyLockError, resolve_locked_component
from metaviewer_agents.wender_bridge import WenderSubprocessAdapter
from metaviewer_agents.perception.vcore import VCorePerceptionAdapter


class CompiledRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root / 'wender-agent'
        self.runtime.mkdir()
        self.exe = self.runtime / 'wender-runtime'
        self.exe.write_bytes(b'compiled test fixture')
        self.exe.chmod(0o755)
        self.lib = self.runtime / 'libpython.so'
        self.lib.write_bytes(b'library fixture')
        self.deps = self.root / 'deps.lock'
        self.deps.write_text(json.dumps({'components': [dict(name='wender-agent', commit='a'*40),dict(name='vision-engine',commit='c'*40)]}))
        self.lock = self.root / 'compiled.lock.json'
        self.lock.write_text(json.dumps({'components': {'wender-agent': dict(
            commit='a'*40, executable='wender-runtime', files={
                p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (self.exe, self.lib)})}}))
        for context in (patch.object(compiled, 'LOCK', self.lock),
                        patch.object(compiled.platform, 'machine', return_value='x86_64'),
                        patch.object(compiled.platform, 'system', return_value='Linux'),
                        patch.dict(os.environ, {'MV_WENDER_EXECUTABLE': str(self.exe)}, clear=True)):
            context.start()
            self.addCleanup(context.stop)

    def resolve(self):
        return resolve_locked_component('wender-agent', lock_path=self.deps)

    def test_compiled_root_and_default_plan_argv(self):
        self.assertEqual(self.resolve(), self.runtime)
        bridge = WenderSubprocessAdapter(lock_path=self.deps)
        self.assertEqual(bridge.command, (str(self.exe), 'plan'))

    def test_absent_executable_refuses_without_checkout_fallback(self):
        self.exe.unlink()
        with self.assertRaisesRegex(DependencyLockError, 'MV_WENDER_EXECUTABLE'):
            self.resolve()

    def test_binary_and_shared_library_hash_mutants_refuse(self):
        for path in (self.exe, self.lib):
            with self.subTest(path=path.name):
                prior = path.read_bytes()
                path.write_bytes(prior + b'mutant')
                with self.assertRaises(DependencyLockError) as caught:
                    self.resolve()
                self.assertEqual(caught.exception.code, 'hash_mismatch')
                path.write_bytes(prior)

    def test_missing_library_unpinned_source_and_symlink_refuse(self):
        self.lib.unlink()
        with self.assertRaisesRegex(DependencyLockError, 'missing pinned files'):
            self.resolve()
        self.lib.write_bytes(b'library fixture')
        extra = self.runtime / 'private.py'
        extra.write_text('raise RuntimeError()')
        with self.assertRaisesRegex(DependencyLockError, 'unpinned compiled file'):
            self.resolve()
        extra.unlink()
        self.lib.unlink()
        self.lib.symlink_to(self.exe)
        with self.assertRaises(DependencyLockError):
            self.resolve()

    def test_source_commit_mismatch_refuses(self):
        self.deps.write_text(json.dumps({'components': [dict(name='wender-agent', commit='b'*40),dict(name='vision-engine',commit='c'*40)]}))
        with self.assertRaises(DependencyLockError) as caught:
            self.resolve()
        self.assertEqual(caught.exception.code, 'commit_mismatch')

    def test_explicit_root_cannot_silently_select_another_runtime(self):
        with self.assertRaises(DependencyLockError) as caught:
            compiled.compiled_executable('wender-agent', root=self.root, lock_path=self.deps)
        self.assertEqual(caught.exception.code, 'commit_mismatch')

    def test_compiled_vision_skips_python_numpy_probe(self):
        with patch.object(compiled, 'compiled_executable', return_value=self.exe), \
                patch('metaviewer_agents.perception.vcore._resolve_pinned_python',
                      side_effect=AssertionError('must not probe Python for compiled runtime')):
            adapter = VCorePerceptionAdapter(pin_python=True)
            self.addCleanup(adapter.close)
            self.assertEqual(adapter.ve_root, self.runtime)
            self.assertTrue(adapter._vserve_available())


if __name__ == '__main__':
    unittest.main()
