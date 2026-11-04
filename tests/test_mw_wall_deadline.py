"""Run-level wall deadline tests and mutant negative controls for mw_run."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / 'agents') not in sys.path:
    sys.path.insert(0, str(ROOT / 'agents'))

from metaviewer_agents import mw_run  # noqa: E402


def load_host():
    spec = importlib.util.spec_from_file_location('wall_deadline_host', ROOT / 'tools' / 'mw_run_backend.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextlib.contextmanager
def test_level_watchdog(timeout_s):
    """Interrupt main-thread sleep via SIGUSR1 if the wall deadline fails to fire."""
    main_thread_id = threading.main_thread().ident

    def _on_usr1(signum, frame):
        raise AssertionError(
            f'test-level timeout expired ({timeout_s:g} s): wall deadline did not interrupt blocked runner'
        )

    previous = signal.signal(signal.SIGUSR1, _on_usr1)
    # Signal the main thread directly; os.kill on our own pid is refused by the AC-10 kill guard.
    timer = threading.Timer(timeout_s, lambda: signal.pthread_kill(main_thread_id, signal.SIGUSR1))
    timer.daemon = True
    timer.start()
    try:
        yield
    finally:
        timer.cancel()
        signal.signal(signal.SIGUSR1, previous)


class WallDeadlineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mv-wall-dl-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.state_home = self.root / 'state'
        self.state_home.mkdir(mode=0o700)
        self.home = self.root / 'memoryweb'
        self.home.mkdir(mode=0o700)

    def _run_blocked_entry(self, *, budget_override_s='0.5', watchdog_s=2.5):
        host = load_host()
        env = dict(
            os.environ,
            XDG_STATE_HOME=str(self.state_home),
            MV_MW_HOME=str(self.home),
            MV_CORE_CONFIG=str(self.root / 'core.json'),
            XDG_RUNTIME_DIR=str(self.root / 'runtime'),
            MV_MW_WALL_DEADLINE_S=str(budget_override_s),
        )

        @contextlib.contextmanager
        def blocking_connect(active_env, trace=None):
            if trace is not None:
                trace['attach'] = 'environment'
            time.sleep(3600)
            yield SimpleNamespace(host_env=active_env)

        stdout = io.StringIO()
        stderr = io.StringIO()
        start = time.monotonic()
        with patch.dict(os.environ, env, clear=False), \
             patch.object(host, 'admit_home', return_value=self.home), \
             patch.object(host, 'connect', side_effect=blocking_connect), \
             contextlib.redirect_stdout(stdout), \
             contextlib.redirect_stderr(stderr), \
             test_level_watchdog(watchdog_s):
            rc = mw_run.main(
                ['--identity', 'mv-live-1', '--site', 'meta-ai', '--workflow', 'ask'],
                runner=host.run_entry,
            )
        elapsed = time.monotonic() - start
        return rc, elapsed, stdout.getvalue(), stderr.getvalue()

    def test_blocked_runner_ends_with_wall_deadline_report(self):
        rc, elapsed, out, err = self._run_blocked_entry(budget_override_s='0.6', watchdog_s=3.0)
        self.assertEqual(rc, mw_run.WALL_DEADLINE_RC)
        self.assertLess(elapsed, 2.5)
        lines = out.strip().splitlines()
        self.assertEqual(len(lines), 1, out)
        result = json.loads(lines[0])
        self.assertEqual(result['schema'], 'metaviewer.mw_run/v1')
        self.assertEqual(result['rc'], 6)
        self.assertEqual(result['verdict_code'], 'MW_WALL_DEADLINE')
        self.assertIsNone(result['receipt'])
        self.assertIsNotNone(result['report'])
        report_path = Path(result['report'])
        self.assertTrue(report_path.is_file())
        self.assertEqual(report_path.stat().st_mode & 0o777, 0o600)
        report = json.loads(report_path.read_text(encoding='utf-8'))
        self.assertEqual(report['schema'], 'metaviewer.mw_run/v1')
        self.assertEqual(report['rc'], 6)
        self.assertEqual(report['verdict_code'], 'MW_WALL_DEADLINE')
        self.assertEqual(report['attach'], 'environment')
        self.assertIn('MW_WALL_DEADLINE:', report['message'])
        self.assertIn('inspect report.json and check core and capsule responsiveness before retrying', report['message'])
        self.assertIn('mw_run: MW_WALL_DEADLINE:', err)

        # Also exercise a bare fake runner that does not wrap run_entry.
        bare_out = io.StringIO()
        bare_err = io.StringIO()
        env = dict(
            os.environ,
            HOME=str(self.root),
            XDG_STATE_HOME=str(self.state_home),
            MV_MW_HOME=str(self.home),
            MV_MW_WALL_DEADLINE_S='0.25',
        )
        with patch.dict(os.environ, env, clear=False), \
             contextlib.redirect_stdout(bare_out), \
             contextlib.redirect_stderr(bare_err), \
             test_level_watchdog(2.0):
            bare_rc = mw_run.main(
                ['--identity', 'mv-live-1', '--site', 'meta-ai', '--workflow', 'ask'],
                runner=lambda _args: time.sleep(3600),
            )
        self.assertEqual(bare_rc, 6)
        bare_result = json.loads(bare_out.getvalue().strip())
        self.assertEqual(bare_result['verdict_code'], 'MW_WALL_DEADLINE')
        bare_report_path = Path(bare_result['report'])
        self.assertTrue(bare_report_path.is_file())
        self.assertTrue(bare_report_path.is_relative_to(self.state_home / 'metaviewer/runs'))

    def test_terminal_json_is_published_with_deadline_disarmed(self):
        host = load_host()
        output = io.StringIO()
        fired = []

        class ExpireOnPublication(io.StringIO):
            def write(stream, text):
                count = super().write(text)
                if text.startswith('{') and not fired and signal.getitimer(signal.ITIMER_REAL)[0] > 0:
                    fired.append(True)
                    signal.raise_signal(signal.SIGALRM)
                return count

        output = ExpireOnPublication()
        with patch.dict(os.environ, XDG_STATE_HOME=str(self.state_home)), \
             patch.object(host, 'admit_home', return_value=self.home), \
             patch.object(host, 'connect'), \
             patch.object(host, 'HostBackend', return_value=SimpleNamespace()), \
             patch.object(host, 'execute', return_value=(0, 'PASS', None)), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            rc = mw_run.main(['--identity', 'fixture', '--site', 'meta-ai', '--workflow', 'ask'],
                             runner=host.run_entry)
        self.assertEqual(rc, 0)
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertEqual(json.loads(output.getvalue())['rc'], 0)
        self.assertEqual(fired, [])
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL)[0], 0)

    def test_budget_from_workflow(self):
        host = load_host()
        shutil.copytree(ROOT / 'memoryweb-builtin/sites/meta-ai', self.home / 'sites/meta-ai')
        evidence = self.root / 'staged-evidence'
        evidence.mkdir(mode=0o700)
        staged_root, basis = host.stage_corpus(self.home, 'meta-ai', evidence)
        self.assertEqual(basis, 'staged_builtin_schemas')

        # meta-ai/ask: min_notice_s = max(0, 0) = 0;
        # 3 steps * (5000 + 30000 + 30000) ms = 195.0 s; + 30.0 s margin = 225.0 s.
        ask_budget = mw_run.budget_from_workflow(staged_root, 'meta-ai/ask')
        self.assertEqual(ask_budget, 225.0)

        # meta-ai/new-chat: min_notice_s = 0; 1 step * 65000 ms = 65.0 s; + 30.0 s margin = 95.0 s.
        new_chat_budget = mw_run.budget_from_workflow(staged_root, 'meta-ai', 'new-chat')
        self.assertEqual(new_chat_budget, 95.0)

        # perplexity/ask fixture: site min_notice_s = 10, workflow min_notice_s = 0 -> 10 s;
        # steps: 50000 + 70000 + 190000 = 310000 ms (310.0 s); + 30.0 s margin + 10 s notice = 350.0 s.
        perplexity_home = self.root / 'perplexity-home'
        shutil.copytree(ROOT / 'tests/e2e/fixtures/mw_perplexity/site', perplexity_home / 'sites/perplexity')
        perplexity_budget = mw_run.budget_from_workflow(perplexity_home, 'perplexity/ask')
        self.assertEqual(perplexity_budget, 350.0)

        args = mw_run.build_parser().parse_args(
            ['--identity', 'mv-live-1', '--site', 'perplexity', '--workflow', 'ask']
        )
        self.assertEqual(
            mw_run.resolve_wall_deadline_s(args, env={}, home=perplexity_home, repo_root=ROOT),
            350.0,
        )

        # Missing workflow falls back to the conservative ceiling (360.0 s).
        unknown_args = mw_run.build_parser().parse_args(
            ['--identity', 'mv-live-1', '--site', 'unknown-site', '--workflow', 'ask']
        )
        self.assertEqual(
            mw_run.resolve_wall_deadline_s(unknown_args, env={}, home=self.home, repo_root=ROOT),
            mw_run.WALL_DEADLINE_CEILING_S,
        )

    def test_override_cannot_raise_budget(self):
        args = mw_run.build_parser().parse_args(
            ['--identity', 'mv-live-1', '--site', 'meta-ai', '--workflow', 'ask']
        )
        base_budget = mw_run.resolve_wall_deadline_s(args, env={}, home=self.home, repo_root=ROOT)
        self.assertEqual(base_budget, 225.0)

        # Lower override is honoured.
        lowered = mw_run.resolve_wall_deadline_s(
            args,
            env={mw_run.WALL_DEADLINE_ENV: '1.25'},
            home=self.home,
            repo_root=ROOT,
        )
        self.assertEqual(lowered, 1.25)

        # Higher override cannot raise the derived budget.
        raised = mw_run.resolve_wall_deadline_s(
            args,
            env={mw_run.WALL_DEADLINE_ENV: '999.0'},
            home=self.home,
            repo_root=ROOT,
        )
        self.assertEqual(raised, base_budget)
        self.assertLessEqual(raised, base_budget)

        # Non-positive or malformed overrides are ignored and never raise or zero the budget.
        for invalid in ('0', '-10', 'nan', 'inf', 'invalid', ''):
            with self.subTest(invalid=invalid):
                effective = mw_run.resolve_wall_deadline_s(
                    args,
                    env={mw_run.WALL_DEADLINE_ENV: invalid},
                    home=self.home,
                    repo_root=ROOT,
                )
                self.assertEqual(effective, base_budget)

    def test_normal_run_disarms_deadline(self):
        sentinel = lambda signum, frame: None
        previous = signal.signal(signal.SIGALRM, sentinel)
        try:
            env = dict(os.environ, MV_MW_WALL_DEADLINE_S='0.2')
            with patch.dict(os.environ, env, clear=False):
                rc = mw_run.main(
                    ['--identity', 'mv-live-1', '--site', 'meta-ai', '--workflow', 'ask'],
                    runner=lambda _args: 0,
                )
            self.assertEqual(rc, 0)
            remaining, interval = signal.getitimer(signal.ITIMER_REAL)
            self.assertEqual((remaining, interval), (0.0, 0.0))
            self.assertIs(signal.getsignal(signal.SIGALRM), sentinel)
            # Sleeping past the 0.2 s budget after return must not trigger any stray alarm.
            time.sleep(0.3)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0.0, 0.0)
            signal.signal(signal.SIGALRM, previous)

    def test_interrupted_subprocess_kills_child(self):
        host = load_host()
        pid_file = self.root / 'child.pid'
        child_code = (
            f'import os, pathlib, time; '
            f'pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid())); '
            f'time.sleep(60)'
        )

        @contextlib.contextmanager
        def blocking_subprocess_connect(active_env, trace=None):
            if trace is not None:
                trace['attach'] = 'environment'
            subprocess.run(
                [sys.executable, '-c', child_code],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=30,
                check=False,
            )
            yield SimpleNamespace(host_env=active_env)

        env = dict(
            os.environ,
            XDG_STATE_HOME=str(self.state_home),
            MV_MW_HOME=str(self.home),
            MV_MW_WALL_DEADLINE_S='0.4',
        )
        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch.dict(os.environ, env, clear=False), \
             patch.object(host, 'admit_home', return_value=self.home), \
             patch.object(host, 'connect', side_effect=blocking_subprocess_connect), \
             contextlib.redirect_stdout(stdout), \
             contextlib.redirect_stderr(stderr), \
             test_level_watchdog(3.0):
            rc = mw_run.main(
                ['--identity', 'mv-live-1', '--site', 'meta-ai', '--workflow', 'ask'],
                runner=host.run_entry,
            )
        self.assertEqual(rc, 6)
        result = json.loads(stdout.getvalue().strip())
        self.assertEqual(result['verdict_code'], 'MW_WALL_DEADLINE')
        self.assertTrue(pid_file.is_file(), 'child process did not start before deadline')
        child_pid = int(pid_file.read_text(encoding='utf-8').strip())
        # /proc lookup instead of a signal-0 probe (AC-10: no kill site in tests); a zombie still counts as present.
        self.assertFalse(Path(f'/proc/{child_pid}').exists(), 'child process survived the deadline')

    def test_mutant_disarmed_handler_fails_by_test_timeout(self):
        with patch.object(mw_run, '_arm_itimer', lambda _seconds: None):
            with self.assertRaisesRegex(
                AssertionError,
                r'test-level timeout expired \(0\.35 s\): wall deadline did not interrupt blocked runner',
            ):
                self._run_blocked_entry(budget_override_s='0.1', watchdog_s=0.35)

    def test_mutant_override_allowed_to_raise_budget_fails(self):
        def permissive_override(budget_s, override=None):
            if override is None or str(override).strip() == '':
                return float(budget_s)
            try:
                value = float(override)
            except (TypeError, ValueError):
                return float(budget_s)
            return value if value > 0 and value != float('inf') and value == value else float(budget_s)

        with patch.object(mw_run, 'apply_budget_override', side_effect=permissive_override):
            with self.assertRaisesRegex(AssertionError, r'999\.0 != 225\.0'):
                self.test_override_cannot_raise_budget()

    def test_blocked_inside_wender_run_workflow_surfaces_wall_deadline(self):
        host = load_host()
        owner_test_path = ROOT / 'agents/tests/test_mw_owner.py'
        spec = importlib.util.spec_from_file_location('wall_dl_owner_fixture', owner_test_path)
        owner_tests = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(owner_tests)
        fixture = owner_tests.OwnerTests('test_real_gate_accepts_canonical_fixture_before_backend')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.install_backend()
        original_call = fixture.owner.backend.call

        def blocking_observe(stage, **kwargs):
            if stage == 'network_context':
                return {'mode': 'open'}
            if stage == 'observe':
                time.sleep(3600)
            return original_call(stage, **kwargs)

        fixture.owner.backend.call = blocking_observe

        @contextlib.contextmanager
        def fake_connect(active_env, trace=None):
            if trace is not None:
                trace['attach'] = 'environment'
            yield SimpleNamespace(host_env=active_env)

        real_execute = host.execute

        def execute_with_fixture(args, _home, evidence, _backend, *, trace=None, **_kw):
            return real_execute(
                args,
                fixture.root,
                evidence,
                fixture.owner.backend,
                corpus_factory=lambda *_a: fixture.corpus,
                owner_factory=host.ReplayOwner,
                trace=trace,
            )

        env = dict(
            os.environ,
            XDG_STATE_HOME=str(self.state_home),
            MV_MW_HOME=str(self.home),
            MV_MW_WALL_DEADLINE_S='0.4',
        )
        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch.dict(os.environ, env, clear=False), \
             patch.object(host, 'admit_home', return_value=self.home), \
             patch.object(host, 'connect', side_effect=fake_connect), \
             patch.object(host, 'HostBackend', return_value=fixture.owner.backend), \
             patch.object(host, 'execute', side_effect=execute_with_fixture), \
             contextlib.redirect_stdout(stdout), \
             contextlib.redirect_stderr(stderr), \
             test_level_watchdog(3.0):
            rc = mw_run.main(
                ['--identity', 'alice', '--site', 'fixture', '--workflow', 'form'],
                runner=host.run_entry,
            )
        self.assertEqual(rc, 6)
        result = json.loads(stdout.getvalue().strip())
        self.assertEqual(result['verdict_code'], 'MW_WALL_DEADLINE')
        report = json.loads(Path(result['report']).read_text(encoding='utf-8'))
        self.assertEqual(report['verdict_code'], 'MW_WALL_DEADLINE')
        self.assertEqual(report['rc'], 6)

    def _run_blocked_in_propose_dispatch(self):
        host = load_host()
        owner_test_path = ROOT / 'agents/tests/test_mw_owner.py'
        spec = importlib.util.spec_from_file_location('wall_dl_owner_propose_fixture', owner_test_path)
        owner_tests = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(owner_tests)
        fixture = owner_tests.OwnerTests('test_real_gate_accepts_canonical_fixture_before_backend')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.install_backend()
        original_call = fixture.owner.backend.call

        def blocking_propose(stage, **kwargs):
            if stage == 'network_context':
                return {'mode': 'open'}
            if stage == 'propose':
                time.sleep(3600)
            return original_call(stage, **kwargs)

        fixture.owner.backend.call = blocking_propose

        @contextlib.contextmanager
        def fake_connect(active_env, trace=None):
            if trace is not None:
                trace['attach'] = 'environment'
            yield SimpleNamespace(host_env=active_env)

        real_execute = host.execute

        def execute_with_fixture(args, _home, evidence, _backend, *, trace=None, **_kw):
            return real_execute(
                args,
                fixture.root,
                evidence,
                fixture.owner.backend,
                corpus_factory=lambda *_a: fixture.corpus,
                owner_factory=host.ReplayOwner,
                trace=trace,
            )

        env = dict(
            os.environ,
            XDG_STATE_HOME=str(self.state_home),
            MV_MW_HOME=str(self.home),
            MV_MW_WALL_DEADLINE_S='0.4',
        )
        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch.dict(os.environ, env, clear=False), \
             patch.object(host, 'admit_home', return_value=self.home), \
             patch.object(host, 'connect', side_effect=fake_connect), \
             patch.object(host, 'HostBackend', return_value=fixture.owner.backend), \
             patch.object(host, 'execute', side_effect=execute_with_fixture), \
             contextlib.redirect_stdout(stdout), \
             contextlib.redirect_stderr(stderr), \
             test_level_watchdog(3.0):
            rc = mw_run.main(
                ['--identity', 'alice', '--site', 'fixture', '--workflow', 'form'],
                runner=host.run_entry,
            )
        result = json.loads(stdout.getvalue().strip())
        report = json.loads(Path(result['report']).read_text(encoding='utf-8'))
        return rc, result, report

    def test_blocked_in_propose_dispatch_preserves_input_uncertain(self):
        rc, result, report = self._run_blocked_in_propose_dispatch()
        self.assertEqual((rc, result['verdict_code']), (5, 'INPUT_UNCERTAIN'))
        self.assertEqual(result['rc'], 5)
        self.assertIsNone(result['receipt'])
        self.assertEqual(report['rc'], 5)
        self.assertEqual(report['verdict_code'], 'INPUT_UNCERTAIN')
        self.assertIn('MW_WALL_DEADLINE:', report['diagnostic'])
        self.assertIn('inspect report.json and check core and capsule responsiveness before retrying', report['diagnostic'])

    def test_mutant_drop_input_uncertain_preservation_fails(self):
        with patch.object(mw_run, 'PRESERVE_INPUT_UNCERTAIN_ON_DEADLINE', False):
            with self.assertRaisesRegex(
                AssertionError,
                r"\(6, 'MW_WALL_DEADLINE'\) != \(5, 'INPUT_UNCERTAIN'\)",
            ):
                self.test_blocked_in_propose_dispatch_preserves_input_uncertain()



if __name__ == '__main__':
    unittest.main()
