"""STALE_FRAME is non-execution; only revalidated, newly bound proposals retry."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'agents'))
spec = importlib.util.spec_from_file_location('stale_host', ROOT / 'tools/mw_run_backend.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class StaleFrameTests(unittest.TestCase):
    def setUp(self):
        self.backend = object.__new__(host.HostBackend)
        self.backend.client = object()
        self.backend.surface_id = 'surface-demo'
        self.backend.pending = {}
        self.frame = json.loads((ROOT / 'contracts/examples/v0.2/frame_ref.valid.json').read_text())
        self.frame['surface_id'] = self.backend.surface_id
        self.frame['generation'] = 1
        self.row = dict(id='composer', role='textbox', name='Composer', box=[0, 0, 80, 40],
                        actionable=True, focused=True, states={})
        self.sensed = dict(frame=self.frame, ax=[self.row])
        self.plan = dict(action=dict(type='click', x=20, y=20, button='left'),
                         expectation=dict(type='changed_region', bbox=dict(x=0, y=0, w=80, h=40)))

    def test_stale_then_reperceive_revalidate_and_rebind_success(self):
        frames = []
        for generation in (2, 3, 4, 5, 6, 7):
            frames.append(dict(self.frame, generation=generation))
        submitted = []
        def submit(proposal, **kwargs):
            submitted.append(proposal)
            if len(submitted) == 1:
                raise host.tools.ToolRefusal('STALE_FRAME', None)
            self.assertEqual(proposal['based_on_frame']['generation'], 7)
            return dict(decision='admitted')
        with patch.object(self.backend, 'ownership'), patch.object(self.backend, 'network_context'), \
             patch.object(host.tools, 'observe', side_effect=[dict(frame_ref=f) for f in frames]) as observe, \
             patch.object(self.backend, 'perceive', side_effect=lambda o: dict(frame=o['frame_ref'], ax=[self.row])) as perceive, \
             patch.object(self.backend, 'retain', return_value={}), \
             patch.object(host.tools, 'propose', side_effect=submit), \
             patch.object(host.tools, 'wait_verify', return_value=dict(native_evidence=dict(surface_id='surface-demo'))):
            result = self.backend.propose(self.sensed, self.plan, 5000)
        self.assertEqual(len(submitted), 2)
        self.assertNotEqual(submitted[0]['proposal_id'], submitted[1]['proposal_id'])
        self.assertEqual(perceive.call_count, 2)
        self.assertEqual(observe.call_count, 6)
        self.assertEqual(self.backend.pending[result['proposal_id']][1]['generation'], 7)

    def test_moved_replaced_or_unfocused_target_refuses(self):
        for changed in (dict(box=[40, 0, 80, 40]), dict(id='replacement'), dict(focused=False)):
            fresh = dict(self.sensed, ax=[dict(self.row, **changed)])
            with self.subTest(changed=changed), self.assertRaisesRegex(host.OwnerRefused, 'MW_REBIND_TARGET'):
                self.backend.revalidate_action(self.sensed, fresh, self.plan['action'])
        fresh = dict(self.sensed, ax=[dict(self.row, focused=False)])
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_REBIND_TARGET'):
            self.backend.revalidate_action(self.sensed, fresh, dict(type='key', keys=['Return']))

    def test_changed_surface_or_geometry_refuses(self):
        for changed in (dict(surface_id='surface-other'), dict(width=self.sensed['frame']['width'] + 1),
                        dict(height=self.sensed['frame']['height'] + 1)):
            fresh = dict(self.sensed, frame=dict(self.sensed['frame'], **changed))
            with self.subTest(changed=changed), self.assertRaisesRegex(host.OwnerRefused, 'MW_REBIND_SURFACE'):
                self.backend.revalidate_action(self.sensed, fresh, self.plan['action'])

    def test_intervening_pixels_and_human_wall_refuse_before_submit(self):
        for wall in (False, True):
            latest = dict(self.frame, generation=2, sha256='f' * 64)
            with patch.object(host.tools, 'observe', side_effect=[dict(frame_ref=self.frame), dict(frame_ref=latest)]), \
                 patch.object(self.backend, 'perceive', return_value=self.sensed), \
                 patch.object(host, 'wall_kind', return_value='login' if wall else None), \
                 self.assertRaisesRegex(host.OwnerRefused, 'MW_HANDOFF_REQUIRED' if wall else 'MW_REBIND_PIXELS'):
                self.backend.rebind(self.sensed, self.plan, 1000)

    def test_nonstale_or_uncertain_submission_never_retries(self):
        for error in (host.tools.ToolRefusal('POLICY', None), TimeoutError('uncertain')):
            with patch.object(self.backend, 'ownership'), patch.object(self.backend, 'network_context'), \
                 patch.object(self.backend, 'rebind', return_value=self.sensed), \
                 patch.object(host.tools, 'propose', side_effect=error) as submit, \
                 patch.object(host.tools, 'wait_verify') as verify:
                with self.assertRaises(type(error)):
                    self.backend.propose(self.sensed, self.plan, 1000)
                self.assertEqual(submit.call_count, 1)
                verify.assert_not_called()

    def test_no_rebinding_mutant_is_input_uncertain_in_real_owner(self):
        # Reuse the canonical Wender corpus builder, then exercise its real owner
        # failure mapping. No native input or external service is involved.
        spec = importlib.util.spec_from_file_location('owner_fixture', ROOT / 'agents/tests/test_mw_owner.py')
        fixture_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture_module)
        fixture = fixture_module.OwnerTests('test_run_click_key_scroll_sequence_and_run_schema')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.install_backend()
        original = fixture.owner.backend.call
        def call(stage, **kwargs):
            if stage == 'propose':
                return self.backend.propose(self.sensed, self.plan, 1000)
            return original(stage, **kwargs)
        fixture.owner.backend.call = call
        with patch.object(self.backend, 'ownership'), patch.object(self.backend, 'network_context'), \
             patch.object(self.backend, 'rebind', return_value=self.sensed), \
             patch.object(host.tools, 'propose', side_effect=host.tools.ToolRefusal('STALE_FRAME', None)) as submit, \
             patch.object(host.tools, 'wait_verify') as verify:
            result = fixture.owner.run()
        self.assertEqual(result.verdict_code, 'INPUT_UNCERTAIN')
        self.assertEqual(submit.call_count, 3)
        self.assertEqual(fixture.proposals, [])
        verify.assert_not_called()

    def test_answer_only_ax_controls_and_prose_preserved(self):
        rows = [dict(role='button', name='Copiar', container=dict(id='answer')),
                dict(role='link', name='Sources', container=dict(id='answer')),
                dict(role='button', name='Outside', container=dict(id='other'))]
        text = 'Use Copiar to copy this answer.\nParis.\nCopiar\nSources\nOutside'
        self.assertEqual(host.HostBackend.answer_only(text, rows, 'answer'),
                         'Use Copiar to copy this answer.\nParis.\nOutside')
        self.assertNotEqual(text, host.HostBackend.answer_only(text, rows, 'answer'))  # no stripping mutant
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_ANSWER_CAPTION_AMBIGUOUS'):
            host.HostBackend.answer_only('Copiar\nProse\nCopiar', rows[:1], 'answer')
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_ANSWER_CAPTION_AMBIGUOUS'):
            host.HostBackend.answer_only('Paris. Copiar', rows[:1], 'answer')

    def test_capture_writes_answer_only_file(self):
        with tempfile.TemporaryDirectory() as directory:
            self.backend.evidence = Path(directory)
            self.backend.binary, self.backend.capsule, self.backend.state = 'native', 'owned', Path(directory)
            row = dict(role='button', name='Copiar', container=dict(id='answer'))
            workflow = dict(oracle=dict(postconditions=[dict(capability_id='mv.ax.present.v1',
                              bindings=[dict(name='name', value='Copiar')])]))
            with patch.object(self.backend, 'ax', return_value=dict(elements=[row])), \
                 patch.object(self.backend, 'native', return_value=dict(text=dict(container_id='answer', text='Paris.\nCopiar'))):
                result = self.backend.capture_answer(workflow)
            self.assertTrue(result['captured'], result)
            self.assertEqual((Path(directory) / 'answer.txt').read_text(), 'Paris.')


if __name__ == '__main__':
    unittest.main()
