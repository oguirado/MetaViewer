"""Ordered offline regressions for automation custody and evidence."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'agents'))
sys.path.insert(0, str(ROOT / 'tools'))
import mw_run_backend as host
import mw_run_browser_goal as browser
import mw_run_program as program


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class TriageTests(unittest.TestCase):
    def fixture(self, filename, classname, method):
        module = load('v027_' + classname, filename)
        fixture = getattr(module, classname)(method)
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        return fixture

    def test_mb01_stopped_receipt_then_active_replacement(self):
        f = self.fixture('tests/test_mw_run_backend.py', 'BackendTests',
                         'test_identity_ownership_and_native_ax')
        f.write(f.root / 'old.json', dict(Lease=dict(ProfileID='alice'),
                                        Capsule=dict(container='srf-id-alice-old')))
        with f.custody():
            witness = f.backend.ownership()
        self.assertEqual(witness['capsules'], ['srf-id-alice'])
        original = f.invocation
        def both(argv, **kwargs):
            if argv[0] == 'docker':
                return SimpleNamespace(returncode=0, stdout=b'srf-id-alice\nsrf-id-alice-old\n')
            return original(argv, **kwargs)
        f.invocation = both
        with f.custody(), self.assertRaisesRegex(host.OwnerRefused, 'MW_RUN_AMBIGUOUS'):
            f.backend.ownership()

    def test_mb02_common_login_cues_and_ordinary_heading(self):
        fixtures = [
            [dict(role='heading', name='Sign in with Google')],
            [dict(role='textbox', name='Enter password'), dict(role='button', name='Sign in')],
        ]
        for rows in fixtures:
            with self.subTest(rows=rows):
                self.assertEqual(host.wall_kind(dict(elements=rows)), 'login_wall')
        for name in ('Sign in statistics', 'Password policies', 'Welcome to the dashboard'):
            self.assertIsNone(host.wall_kind(dict(elements=[dict(role='heading', name=name)])))
        self.assertIsNone(host.wall_kind(dict(elements=[dict(role='textbox', name='Enter password')])))

    def test_mb04_inventory_timeout_has_structured_report(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(os.environ, XDG_STATE_HOME=directory), \
             patch.object(host, 'admit_home', return_value=Path(directory) / 'home'), \
             patch.object(host, 'connect'), \
             patch.object(host, 'HostBackend', side_effect=subprocess.TimeoutExpired(['docker', 'ps'], 30)), \
             contextlib.redirect_stdout(io.StringIO()) as output, \
             contextlib.redirect_stderr(io.StringIO()):
            rc = host.run_entry(SimpleNamespace(slot=[], identity='fixture'))
            result = json.loads(output.getvalue())
            self.assertEqual(rc, 6)
            self.assertEqual(result['verdict_code'], 'MW_RUN_NATIVE')
            self.assertTrue(Path(result['report']).is_file())

    def test_mb05_wall_appears_only_during_proposal_rebind(self):
        f = self.fixture('agents/tests/test_mw_owner.py', 'OwnerTests',
                         'test_real_gate_accepts_canonical_fixture_before_backend')
        f.install_backend()
        original = f.owner.backend.call
        def call(stage, **kwargs):
            if stage == 'propose':
                sensed = kwargs['sensed']
                fresh = dict(sensed, ax=[dict(role='heading', name='Sign in to your account')])
                b = object.__new__(host.HostBackend)
                b.observe_for_rebind = Mock(return_value={})
                b.perceive = Mock(return_value=fresh)
                return b.rebind(sensed, kwargs['plan'], kwargs['max_ms'])
            return original(stage, **kwargs)
        f.owner.backend.call = call
        result = f.owner.run()
        self.assertEqual((result.rc, result.verdict_code), (4, 'HUMAN_HANDOFF'))
        self.assertTrue(f.owner.handoff.latched)
        self.assertEqual(json.loads(Path(result.handoff_path).read_text())['reason'], 'login_wall')
        self.assertEqual(f.proposals, [])
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_HANDOFF_REQUIRED'):
            f.owner.run()

    def test_owner_failed_handoff_write_never_advertises_artifact(self):
        for rebind in (False, True):
            with self.subTest(rebind=rebind):
                f = self.fixture('agents/tests/test_mw_owner.py', 'OwnerTests',
                                 'test_real_gate_accepts_canonical_fixture_before_backend')
                f.install_backend()
                original = f.owner.backend.call
                def call(stage, **kwargs):
                    if rebind and stage == 'propose':
                        sensed = kwargs['sensed']
                        fresh = dict(sensed, ax=[dict(role='heading', name='Sign in to your account')])
                        b = object.__new__(host.HostBackend)
                        b.observe_for_rebind = Mock(return_value={})
                        b.perceive = Mock(return_value=fresh)
                        return b.rebind(sensed, kwargs['plan'], kwargs['max_ms'])
                    value = original(stage, **kwargs)
                    if not rebind and stage == 'observe':
                        value['observed_wall'] = dict(observed=True, kind='login_wall')
                    return value
                f.owner.backend.call = call
                write = f.owner.write
                def fail_handoff(path, raw):
                    if path == f.owner.handoff.path:
                        raise OSError('disk full')
                    return write(path, raw)
                with patch.object(f.owner, 'write', side_effect=fail_handoff):
                    result = f.owner.run()
                self.assertTrue(f.owner.handoff.latched)
                self.assertIs(f.owner.handoff.persisted, False)
                self.assertFalse(f.owner.handoff.path.exists())
                self.assertIsNone(result.handoff_path)
                if not rebind:
                    self.assertIsNotNone(result.summary)
                    self.assertNotIn(f.owner.handoff.path.name, result.summary['evidence_refs'])
                self.assertEqual(f.proposals, [])
                if rebind:
                    self.assertEqual((result.rc, result.verdict_code), (4, 'HUMAN_HANDOFF'))
                with self.assertRaisesRegex(host.OwnerRefused, 'MW_HANDOFF_REQUIRED'):
                    f.owner.run()

    def browser_fixture(self):
        return self.fixture('tests/test_mw_browser_goal.py', 'BrowserGoalTests',
                            'test_real_planner_click_and_journals')

    def test_br01_stale_then_exact_text_retries_readback_not_input(self):
        f = self.browser_fixture()
        f.args.steps, f.args.text = 2, 'Música Ω'
        original = f.readback
        reads = []
        def read(row):
            reads.append(row['id'])
            if len(reads) == 1:
                row['value_len'] = 0
                return ''
            return original(row)
        f.b.slot_text.side_effect = read
        moves = browser.run_moves(f.b, f.planner, f.args)
        self.assertEqual([a['type'] for a in f.inputs], ['click', 'type'])
        self.assertEqual(len(reads), 2)
        self.assertEqual(moves[-1]['text_gate']['status'], 'exact_native_readback')

    def test_br02_click_does_not_read_unrelated_focused_text(self):
        f = self.browser_fixture()
        unrelated = dict(id='other', role='textbox', name='Other field', focused=True,
                         box=[60, 20, 20, 20])
        f.b.ownership = Mock()
        f.b.binary, f.b.capsule, f.b.state = Path('/synthetic/srf'), 'owned', f.root
        f.b.native = Mock(return_value=dict(elements=[dict(f.row), unrelated]))
        f.b.slot_text.side_effect = host.OwnerRefused('MW_SLOT_LENGTH_TRUNCATED_TEXT')
        f.b.observe = browser.BrowserGoalBackend.observe.__get__(f.b)
        with patch.object(host.tools, 'observe', return_value=dict(frame_ref=f.frame)):
            moves = browser.run_moves(f.b, f.planner, f.args)
        self.assertEqual(moves[0]['action']['type'], 'click')
        f.b.slot_text.assert_not_called()

    def test_br03_wall_persistence_failure_remains_handoff(self):
        f = self.browser_fixture()
        f.args.planner, f.args.model_timeout_ms, f.args.identity = 'rules', 1000, 'fixture'
        f.row.update(role='heading', name='Sign in to your account')
        write = browser.host.ReplayOwner.write
        def fail_handoff(path, raw):
            if path == f.b.handoff.path:
                raise OSError('disk full')
            return write(path, raw)
        with patch.object(browser, 'private_evidence_base', return_value=f.root), \
             patch.object(browser.host, 'connect'), \
             patch.object(browser, 'BrowserGoalBackend', return_value=f.b), \
             patch.object(browser.host.ReplayOwner, 'write', side_effect=fail_handoff), \
             contextlib.redirect_stdout(io.StringIO()) as output, \
             contextlib.redirect_stderr(io.StringIO()):
            rc = browser.run_entry(f.args)
        result = json.loads(output.getvalue())
        self.assertEqual((rc, result['verdict_code']), (4, 'HUMAN_HANDOFF'))
        self.assertIsNone(result['receipt'])
        report = json.loads(Path(result['report']).read_text())
        self.assertEqual(report['handoff_persistence'], 'failed')
        self.assertTrue(f.b.handoff.latched)
        self.assertFalse(f.b.handoff.path.exists())
        f.b.propose.assert_not_called()

    def program_fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        frame = dict(surface_id='surface-fixture', generation=1, sha256='a' * 64,
                     width=100, height=80)
        target = dict(name='Editor', role='textbox', box=[10, 10, 30, 30])
        sensed = dict(frame=frame, table=dict(elements=[target]), frame_witness={}, observation={})
        backend = SimpleNamespace(evidence=Path(temporary.name), surface_id='surface-fixture', client=Mock(),
            observe=Mock(return_value=dict(frame_ref=frame)), perceive=Mock(return_value=sensed),
            propose=Mock(return_value=dict(proposal_id='click')),
            wait_verify=Mock(return_value=dict(receipt=dict(after_frame=frame))), retain=Mock(return_value={}))
        planner = SimpleNamespace(battery_state_sha256='b' * 64, plan_step=Mock(return_value=(
            dict(type='click', x=20, y=20, button='left'), {}, {}, target)))
        return backend, planner, sensed, target

    def test_program_early_failures_preserve_original_exception(self):
        for stage in ('observe', 'perceive', 'plan_step'):
            with self.subTest(stage=stage):
                backend, planner, sensed, target = self.program_fixture()
                failure = host.OwnerRefused('MW_PROGRAM_EARLY_REFUSAL')
                source = planner if stage == 'plan_step' else backend
                getattr(source, stage).side_effect = failure
                with self.assertRaises(host.OwnerRefused) as caught:
                    program.run_moves(backend, planner, 'Editor', 1, 1000)
                self.assertIs(caught.exception, failure)
                self.assertEqual(backend.program_attempts, [])
                backend.propose.assert_not_called()

    def test_mp03_verified_click_survives_subsequent_type_failure(self):
        backend, planner, sensed, target = self.program_fixture()
        backend.vision = Mock()
        backend.wait_verify.return_value['focus_verified'] = True
        typed = dict(sensed, table=dict(elements=[dict(target,
            bbox=dict(zip(('x', 'y', 'w', 'h'), target['box'])))]))
        backend.perceive.side_effect = [sensed, typed]
        pixels = dict(marks=[dict(x=10, y=10, w=30, h=30, ocr_text='wrong')])
        with patch.object(program, 'require_grounded_goal'), \
             patch.object(program, 'read_text_pixels', return_value=pixels), \
             self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_TEXT_MISMATCH'):
            program.run_moves(backend, planner, 'Editor', 1, 1000, text='hello')
        self.assertEqual(backend.program_moves[0]['status'], 'verified_move')
        self.assertEqual(backend.program_attempts[0]['status'], 'verified_move')
        self.assertEqual(backend.program_attempts[1]['status'], 'input_uncertain')

    def test_mp05_acquisition_failure_after_delivery_remains_uncertain(self):
        backend, planner, sensed, target = self.program_fixture()
        backend.wender = backend.evidence
        backend.perceive.side_effect = [sensed, host.OwnerRefused('MW_PROGRAM_NO_TARGETS')]
        args = SimpleNamespace(goal='Editor', steps=2, timeout_ms=1000, identity='fixture',
                               planner='rules', model_timeout_ms=1000)
        with patch.object(program, 'private_evidence_base', return_value=backend.evidence), \
             patch.object(program.host, 'connect'), \
             patch.object(program, 'ProgramBackend', return_value=backend), \
             patch.object(program, 'VCorePerceptionAdapter'), \
             patch.object(program, 'WenderSubprocessAdapter', return_value=planner), \
             patch.object(program, 'require_grounded_goal'), \
             patch.object(program, 'wait_for_publication', return_value=dict(frame_ref=dict(sensed['frame'], generation=2))), \
             contextlib.redirect_stdout(io.StringIO()) as output, \
             contextlib.redirect_stderr(io.StringIO()):
            rc = program.run_entry(args)
        result = json.loads(output.getvalue())
        self.assertEqual((rc, result['verdict_code']), (5, 'INPUT_UNCERTAIN'), Path(result['report']).read_text())
        self.assertEqual(len(backend.program_moves), 1)
        self.assertEqual(backend.program_attempts[0]['status'], 'verified_move')
        backend.propose.assert_called_once()

    def test_mp06_persistent_state_home_is_refused(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, XDG_STATE_HOME=directory):
            with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_RAM_REQUIRED'):
                program.private_evidence_base()

    def test_mb08_supported_workflow_names_missing_invocation_slot(self):
        f = self.fixture('agents/tests/test_mw_owner.py', 'OwnerTests',
                         'test_real_gate_accepts_canonical_fixture_before_backend')
        f.prepare_text()
        f.owner.slots.values = {}
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_SLOT_MISSING: prompt'):
            f.owner.validate_corpus()
        self.assertEqual(f.proposals, [])

    def test_mp07_failed_text_retains_verification_payload(self):
        backend, planner, sensed, target = self.program_fixture()
        backend.program_attempts, backend.program_moves = [], []
        failure = host.tools.VerificationFailed(dict(proposal_id='text', detail='settlement failed'))
        def propose(*args):
            backend.active_attempt['proposal_id'] = 'text'
            backend.frame_attempts = [dict(status='admitted', proposal_id='text')]
            raise failure
        backend.propose.side_effect = propose
        with self.assertRaises(host.tools.VerificationFailed):
            program.dispatch_text(backend, sensed, target, 'hello', 1000)
        attempt = backend.program_attempts[0]
        self.assertEqual(attempt['status'], 'input_uncertain')
        evidence = attempt['verification_failure']
        self.assertEqual(evidence['payload'], failure.receipt)
        self.assertEqual(evidence['proposal_id'], 'text')
        self.assertEqual(evidence['correlation'], 'proposal_id_match')
        self.assertEqual(json.loads(Path(attempt['verification_failure_artifact']).read_text())['payload'],
                         failure.receipt)

    def test_mp08_stale_dispatch_artifact_records_nonexecution_and_correlation(self):
        f = self.fixture('tests/test_mw_stale_frame.py', 'StaleFrameTests',
                         'test_stale_then_reperceive_revalidate_and_rebind_success')
        with tempfile.TemporaryDirectory() as directory:
            b = object.__new__(program.ProgramBackend)
            b.evidence, b.client, b.surface_id = Path(directory), Mock(), f.backend.surface_id
            b.pending, b.program_attempts = {}, []
            b.active_attempt = dict(intent_artifact='synthetic-intent')
            sent = []
            def submit(proposal, **kwargs):
                sent.append(proposal['proposal_id'])
                if len(sent) == 1:
                    raise host.tools.ToolRefusal('STALE_FRAME', None)
                return dict(decision='admitted')
            with patch.object(b, 'ownership'), patch.object(b, 'network_context'), \
                 patch.object(b, 'rebind', return_value=f.sensed), \
                 patch.object(host.tools, 'propose', side_effect=submit), \
                 patch.object(host.tools, 'wait_verify', return_value=dict(native_evidence=dict(surface_id=b.surface_id))):
                b.propose(f.sensed, f.plan, 1000)
            stale = json.loads((b.evidence / ('dispatch-' + sent[0] + '.json')).read_text())
            self.assertEqual(stale['status'], 'refused_before_execution')
            self.assertEqual(stale['reason_code'], 'STALE_FRAME')
            self.assertIs(stale['submitted'], True)
            self.assertEqual([r['proposal_id'] for r in b.frame_attempts], sent)
            self.assertEqual(len(set(sent)), 2)

    def test_br01_retry_refuses_replaced_editor_without_more_input(self):
        f = self.browser_fixture()
        f.args.steps, f.args.text = 2, 'hello'
        def stale_and_replace(row):
            row['value_len'] = 0
            f.row['id'] = 'replacement-editor'
            return ''
        f.b.slot_text.side_effect = stale_and_replace
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_BROWSER_FOCUS'):
            browser.run_moves(f.b, f.planner, f.args)
        self.assertEqual([a['type'] for a in f.inputs], ['click', 'type'])
        self.assertEqual(f.b.slot_text.call_count, 1)

    def test_br01_persistent_text_mismatch_expires(self):
        target = dict(native_editor_id='editor', role='textbox', name='Editor', box=[0, 0, 10, 10])
        sensed = dict(ax=[dict(target, id='editor', focused=True)])
        backend = SimpleNamespace(slot_text=Mock(return_value='stale'))
        with patch.object(browser.time, 'monotonic_ns', side_effect=[0, 2_000_000_000]), \
             self.assertRaisesRegex(host.OwnerRefused, 'MW_BROWSER_TEXT_MISMATCH'):
            browser.exact_readback(backend, sensed, target, 'hello')
        backend.slot_text.assert_called_once()

    def test_br02_selected_text_still_requires_untruncated_readback(self):
        f = self.browser_fixture()
        f.args.steps, f.args.text = 2, 'hello'
        f.b.slot_text.side_effect = host.OwnerRefused('MW_SLOT_LENGTH_TRUNCATED_TEXT')
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_SLOT_LENGTH_TRUNCATED_TEXT'):
            browser.run_moves(f.b, f.planner, f.args)
        self.assertEqual([a['type'] for a in f.inputs], ['click', 'type'])

    def test_mp05_submitted_action_without_settlement_remains_uncertain(self):
        backend, planner, sensed, target = self.program_fixture()
        backend.wender = backend.evidence
        def submitted(*args):
            backend.active_attempt['proposal_id'] = 'click'
            backend.frame_attempts = [dict(status='admitted', proposal_id='click')]
            return dict(proposal_id='click')
        backend.propose.side_effect = submitted
        backend.wait_verify.side_effect = host.tools.VerificationFailed(
            dict(proposal_id='click', detail='missing settlement'))
        args = SimpleNamespace(goal='Editor', steps=1, timeout_ms=1000, identity='fixture',
                               planner='rules', model_timeout_ms=1000)
        with patch.object(program, 'private_evidence_base', return_value=backend.evidence), \
             patch.object(program.host, 'connect'), \
             patch.object(program, 'ProgramBackend', return_value=backend), \
             patch.object(program, 'VCorePerceptionAdapter'), \
             patch.object(program, 'WenderSubprocessAdapter', return_value=planner), \
             patch.object(program, 'require_grounded_goal'), \
             contextlib.redirect_stdout(io.StringIO()) as output, \
             contextlib.redirect_stderr(io.StringIO()):
            rc = program.run_entry(args)
        self.assertEqual((rc, json.loads(output.getvalue())['verdict_code']), (5, 'INPUT_UNCERTAIN'))
        self.assertEqual(backend.program_attempts[0]['status'], 'input_uncertain')
        backend.propose.assert_called_once()
        backend.wait_verify.assert_called_once_with(dict(proposal_id='click'), unittest.mock.ANY)
        self.assertEqual(backend.frame_attempts, [dict(status='admitted', proposal_id='click')])
        self.assertEqual(backend.program_moves, [])
        attempt = backend.program_attempts[0]
        self.assertEqual(attempt['verification_failure']['correlation'], 'proposal_id_match')
        self.assertTrue(Path(attempt['verification_failure_artifact']).is_file())

    def test_br03_total_evidence_write_failure_keeps_handoff_verdict(self):
        f = self.browser_fixture()
        f.args.planner, f.args.model_timeout_ms, f.args.identity = 'rules', 1000, 'fixture'
        f.row.update(role='heading', name='Sign in to your account')
        with patch.object(browser, 'private_evidence_base', return_value=f.root), \
             patch.object(browser.host, 'connect'), \
             patch.object(browser, 'BrowserGoalBackend', return_value=f.b), \
             patch.object(browser.host.ReplayOwner, 'write', side_effect=OSError('disk full')), \
             contextlib.redirect_stdout(io.StringIO()) as output, \
             contextlib.redirect_stderr(io.StringIO()):
            rc = browser.run_entry(f.args)
        result = json.loads(output.getvalue())
        self.assertEqual((rc, result['verdict_code']), (4, 'HUMAN_HANDOFF'))
        self.assertIsNone(result['receipt'])
        self.assertIsNone(result['report'])
        self.assertTrue(f.b.handoff.latched)
        f.b.propose.assert_not_called()
