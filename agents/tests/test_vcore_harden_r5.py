"""Extra-site trust oracles and named negative controls (R5)."""
import os
import inspect
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents.perception import vcore
from metaviewer_agents.perception.base import PerceptionError
from test_vcore_harden import _setup_harden_ve_root, _make_frame
import test_mut_vcore


def secure_temp():
    # /tmp's sticky writable ancestor is deliberately inadmissible.
    for base in (Path.home(), Path.cwd(), *Path.cwd().parents):
        try:
            vcore._check_site_chain(str(base.resolve()))
            return tempfile.TemporaryDirectory(dir=base)
        except (PerceptionError, OSError):
            continue
    raise AssertionError("no writable trusted fixture ancestor")


class ExtraSiteR5Tests(unittest.TestCase):
    def setUp(self):
        previous = os.umask(0o022)
        self.addCleanup(os.umask, previous)
        self.temp = secure_temp()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.base.chmod(0o755)
        self.site = self.base / 'site'
        self.site.mkdir(mode=0o755)

    def admitted(self):
        self.assertEqual(vcore._resolve_extra_site(self.site), str(self.site))

    def refused(self):
        self.assertIsNone(vcore._resolve_extra_site(self.site))

    def test_parent_chain_and_mutation(self):
        self.admitted()
        for mode in (0o775, 0o777, 0o1777):
            self.base.chmod(mode)
            self.refused()
            with mock.patch.object(vcore, '_check_site_chain', return_value=self.site.stat()):
                with self.assertRaises(AssertionError, msg='MUT-NO-PARENT-CHECK'):
                    self.refused()
        self.base.chmod(0o755)
        self.admitted()

    def test_swap_and_mutation(self):
        root = _setup_harden_ve_root(self)
        with mock.patch.dict(os.environ, {'MV_VCORE_SITE': str(self.site)}):
            adapter = vcore.VCorePerceptionAdapter(root)
        self.addCleanup(adapter.close)
        self.site.rename(self.base / 'old')
        self.site.mkdir(mode=0o755)

        def oracle():
            with mock.patch.object(vcore, '_bounded_probe') as probe:
                with self.assertRaisesRegex(PerceptionError, 'identity changed'):
                    adapter._ensure_pinned_python()
                probe.assert_not_called()
            with self.assertRaisesRegex(PerceptionError, 'identity changed'):
                adapter._child_env()
        oracle()
        with mock.patch.object(adapter, '_child_env', return_value=adapter._spawn_env), \
                mock.patch.object(vcore, '_resolve_pinned_python', return_value=sys.executable):
            with self.assertRaises(AssertionError, msg='MUT-NO-REVALIDATE'):
                oracle()

    def test_contents_and_mutation(self):
        package = self.site / 'pkg'
        package.mkdir()
        child = package / '__init__.py'
        child.write_text('')
        for mode in (0o664, 0o646):
            child.chmod(mode)
            self.refused()
            with mock.patch.object(vcore, '_check_site_contents'):
                with self.assertRaises(AssertionError, msg='MUT-NO-CHILD-SCAN'):
                    self.refused()
        child.chmod(0o644)
        self.admitted()
        with mock.patch.object(vcore, '_SITE_ENTRY_CAP', 1):
            self.refused()

    def test_hooks_and_mutation(self):
        for name, contents in (('sitecustomize.py', ''), ('usercustomize.py', '')):
            hook = self.site / name
            hook.write_text(contents)
            self.refused()
            with mock.patch.object(vcore, '_check_extra_hooks'):
                with self.assertRaises(AssertionError, msg='MUT-NO-EXTRA-HOOK-SCAN'):
                    self.refused()
            hook.unlink()
        (self.site / 'data.pth').write_text('# comment\n./package')
        self.admitted()

    def test_executable_pth_is_inert_in_real_child_and_mutations(self):
        root = _setup_harden_ve_root(self)
        # Put the extra site at this child's actual user site so removing
        # PYTHONNOUSERSITE is an executable negative control on hosted Python.
        with mock.patch.object(vcore, '_PINNED_HOME', str(self.base)):
            env = vcore._scrubbed_env()
            result = subprocess.run(
                [sys.executable, '-c', 'import site; print(site.getusersitepackages())'],
                env=env, cwd=self.base, text=True, capture_output=True,
                check=True, timeout=10)
            self.site = Path(result.stdout.strip())
            self.site.mkdir(parents=True, mode=0o755)
            marker = self.base / 'pth-ran'
            (self.site / 'executable.pth').write_text(
                f'import pathlib; pathlib.Path({str(marker)!r}).write_text("ran")\n')
            (self.site / 'data.pth').write_text('# inert data path\n./package\n')
            self.admitted()
            with mock.patch.dict(os.environ, {'MV_VCORE_SITE': str(self.site)}):
                with vcore.VCorePerceptionAdapter(root) as adapter:
                    child_env = adapter._child_env()
                    self.assertEqual(child_env['PYTHONPATH'].split(os.pathsep)[-1],
                                     str(self.site))

                    def launch(code, environment):
                        subprocess.run([sys.executable, '-c', code],
                                       env=environment, cwd=self.base,
                                       check=True, capture_output=True, timeout=10)
                        self.assertFalse(marker.exists(), 'executable .pth ran')

                    launch('pass', child_env)
                    with self.assertRaises(AssertionError, msg='MUT-ADDSITEDIR'):
                        launch(f'import site; site.addsitedir({str(self.site)!r})',
                               child_env)
                    marker.unlink()
                    mutant_env = dict(child_env)
                    mutant_env.pop('PYTHONNOUSERSITE', None)
                    with self.assertRaises(AssertionError, msg='MUT-NO-NOUSERSITE'):
                        launch('pass', mutant_env)

    def test_positive_probe_spawn_and_cache(self):
        root = _setup_harden_ve_root(self, numpy_version=None)
        numpy = self.site / 'numpy'
        numpy.mkdir()
        (numpy / '__init__.py').write_text('__version__ = "2.4.2"\n')
        with mock.patch.dict(os.environ, {'MV_VCORE_SITE': str(self.site)}):
            with vcore.VCorePerceptionAdapter(root, fallback_oneshot=False) as adapter:
                ref, frame = _make_frame()
                adapter.perceive(ref, frame)
                self.assertEqual(adapter.last_transport, 'vserve')
                with mock.patch.object(vcore, '_check_site_contents') as scan:
                    adapter._child_env()
                    adapter._child_env()
                    scan.assert_not_called()
                self.base.chmod(0o775)
                with self.assertRaisesRegex(PerceptionError, 'parent-chain'):
                    adapter._child_env()

    def test_env_shape_and_canonicalizer(self):
        for value in (42, '', 'one' + os.pathsep + 'two', 'bad\x00'):
            with self.assertRaises(PerceptionError):
                vcore._scrubbed_env(extra_site=value)
        with mock.patch.object(vcore.os.path, 'realpath', side_effect=ValueError):
            self.assertIsNone(vcore._canonicalize_python_candidate('/python'))


class ReconciledMutationTests(unittest.TestCase):
    """The revised integration oracles must still reject executable mutants."""

    def killed(self, case_class, method):
        result = unittest.TestResult()
        case_class(method).run(result)
        self.assertEqual(result.errors, [], result.errors)
        self.assertEqual(len(result.failures), 1, result.failures)

    def test_mut_vs_empty_release(self):
        def clamped_release(queue):
            with queue._lock:
                queue._in_flight = max(0, queue._in_flight - 1)

        with mock.patch.object(vcore._BoundedRequestQueue, 'release', clamped_release):
            self.killed(test_mut_vcore.MutVServeBoundedQueueTests,
                        'test_release_on_empty_slot_yield_and_exception_cleanup')

    def test_mut_vs_noncanonical_probe(self):
        with mock.patch.object(vcore, '_canonicalize_python_candidate', side_effect=lambda c: c):
            self.killed(test_mut_vcore.MutVServePinnedPythonBoundaryTests,
                        'test_isolated_probe_skip_and_tab_candidate_and_pin_once_caching')

    def test_mut_vs_isolated_accept(self):
        source = inspect.getsource(vcore._resolve_pinned_python)
        branch = '        if info.get("isolated") is True:\n            continue\n'
        self.assertEqual(source.count(branch), 1)
        namespace = dict(vars(vcore))
        exec(compile(source.replace(branch, ''), '<MUT-VS-ISOLATED-ACCEPT>', 'exec'), namespace)
        mutant = namespace['_resolve_pinned_python']
        # Keep dynamic probe/canonicalizer patches visible to the mutant.
        mutant = type(mutant)(mutant.__code__, vars(vcore), mutant.__name__, mutant.__defaults__)
        mutant.__kwdefaults__ = namespace['_resolve_pinned_python'].__kwdefaults__
        with mock.patch.object(test_mut_vcore, '_resolve_pinned_python', mutant):
            self.killed(test_mut_vcore.MutVServePinnedPythonBoundaryTests,
                        'test_isolated_probe_skip_and_tab_candidate_and_pin_once_caching')

    def test_mut_vs_caller_path(self):
        original = vcore._verify_and_pin_frame_path

        def caller_path(value, **kwargs):
            kwargs['stack'] = None
            return original(value, **kwargs)

        with mock.patch.object(vcore, '_verify_and_pin_frame_path', caller_path):
            self.killed(test_mut_vcore.MutVServeRawShmAndIdentityGateTests,
                        'test_procfd_refused_by_vserve_and_shm_path_and_ramws_and_marks_forwarded')
