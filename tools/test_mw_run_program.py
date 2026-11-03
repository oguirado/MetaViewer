"""Program lane custody and core-bound planning, without live host input."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
import contextlib
import io
import os
import stat
import time
import socket
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mw_run_program as program
from metaviewer_agents import mw_run
host = program.host


def frame(generation=1, surface='surface-alice'):
    return dict(schema='frame_ref/v0.2', surface_id=surface, generation=generation,
                tick=0, ts_ns=1, width=100, height=80, format='rgb24',
                ramws_path='/dev/shm/synthetic-frame', sha256='a' * 64, capture_us=0)


def planner_reply():
    target = dict(id='0123456789abcdef', role='button', name='Covered square',
                  depth=0, parent=None, ordinal=0, states={}, actionable=True,
                  box=[10, 20, 30, 20])
    state = dict(schema='wender.state/v1', source=dict(kind='vision', url=None, title='Mines'),
                 prune=dict(name='test', version=1), ax_sha256='b' * 64,
                 ax_stable_sha256='c' * 64, viewport=dict(w=100, h=80), nodes=[target],
                 actionable=[target['id']], counts=dict(raw=1, nodes=1, actionable=1))
    return dict(action=dict(type='click', x=20, y=30, button='left'),
                expectation=dict(type='text_present', text='Ready'),
                state=state, target_node=copy.deepcopy(target))


def element_table():
    return dict(schema='vqa.element-table/v1', frame_sha256='a' * 64,
        width=100, height=80, elements=[dict(bbox=dict(x=10,y=20,w=30,h=20),
            role='button', name='Covered square', score_ppm=900000)])


class ProgramTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir='/dev/shm')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.root.chmod(0o700)
        self.b = object.__new__(program.ProgramBackend)
        self.b.identity, self.b.state, self.b.store = 'alice', self.root, self.root / 'store'
        self.b.binary, self.b.admin = self.root / 'srf-identity-surface', self.root / 'srf-identity-admin'
        self.b.surface_id, self.b.capsule, self.b.client, self.b.pending = None, None, Mock(), {}
        self.b.evidence = self.root
        self.surface = dict(profile_id='alice', state='active', kind='desktop_capsule',
                            surface_id='surface-alice', control='agent')
        self.lease = self.root / 'capsule.json'
        self.lease.write_text(json.dumps(dict(Lease=dict(ProfileID='alice'),
            Capsule=dict(kind='program',container='srf-pg-alice',run_id='alice-run',
                         windows=[dict(id='w1',x=0,y=0,w=100,h=80,title='',url='')]))))
        self.lease.chmod(0o600)
        self.legacy_binding()

    def custody(self):
        return patch.multiple(self.b, native=Mock(return_value=dict(profile_id='alice')))

    def own(self, surface=None, active=b'srf-pg-alice\n'):
        with self.custody(), patch.object(host.tools, 'list_surfaces', return_value=dict(
                surfaces=[surface or self.surface], next_cursor=None)), patch.object(
                    host, 'command', return_value=SimpleNamespace(returncode=0, stdout=active)):
            return self.b.ownership()

    def legacy_binding(self, **changes):
        value=dict(schema='metaviewer.human_binding/v0.3',surface_id='surface-alice',
            profile_id='alice',container='srf-pg-alice',run_id='alice-run',
            control_ready=True,input_epoch=0,width=100,height=80,role='agent')
        value.update(changes)
        directory=self.root/'human-bindings';directory.mkdir(mode=0o700,exist_ok=True)
        path=directory/'surface-alice.json';path.write_text(json.dumps(value));path.chmod(0o600)
        return path

    def publication(self):
        # Public immutable RGB projection, not the native run/frames/w1 source.
        directory=self.root/'frames-synthetic';directory.mkdir(mode=0o700,exist_ok=True)
        path=directory/('a'*32+'.rgb');path.write_bytes(b'x');path.chmod(0o600)
        return dict(frame(),ramws_path=str(path))

    def test_program_custody_and_browser_filter_remain_distinct(self):
        self.assertEqual(self.own()['capsules'], ['srf-pg-alice'])
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_RUN_NO_SURFACE'):
            self.own(dict(self.surface, kind='browser'))
        browser = object.__new__(host.HostBackend)
        browser.client, browser.identity = Mock(), 'alice'
        with patch.object(host.tools, 'list_surfaces', return_value=dict(
                surfaces=[self.surface, dict(self.surface, kind='browser')], next_cursor=None)):
            self.assertEqual([s['kind'] for s in browser.surfaces()], ['browser'])

    def test_legacy_program_requires_matching_adapter_surface_and_native_run(self):
        self.assertEqual(self.own()['native_binding']['run_id'],'alice-run')
        for change in (dict(run_id='foreign-run'),dict(surface_id='foreign'),dict(container='srf-id-alice'),
                       dict(role='human'),dict(control_ready=False)):
            with self.subTest(change=change):
                self.legacy_binding(**change)
                with self.assertRaises(host.OwnerRefused):self.own()
        self.legacy_binding()
        receipt=json.loads(self.lease.read_text());receipt['Capsule']['run_id']='different-run'
        self.lease.write_text(json.dumps(receipt))
        with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_BINDING'):self.own()
        del receipt['Capsule']['run_id'];self.lease.write_text(json.dumps(receipt))
        with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_BINDING'):self.own()

    def test_legacy_program_without_adapter_witness_is_explicitly_unsupported(self):
        (self.root/'human-bindings/surface-alice.json').unlink()
        with self.assertRaisesRegex(host.OwnerRefused,'builtin program transports are unsupported'):
            self.own()
        self.assertTrue(self.lease.is_file())

    def test_human_unsupported_wrong_identity_and_stopped_program_refuse(self):
        for mutation, code in ((dict(control='human'), 'MW_PROGRAM_CONTROL'),
                               (dict(kind='vm'), 'MW_RUN_NO_SURFACE'),
                               (dict(profile_id='bob'), 'MW_RUN_NO_SURFACE')):
            with self.subTest(mutation=mutation), self.assertRaisesRegex(host.OwnerRefused, code):
                self.own(dict(self.surface, **mutation))
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_RUN_NO_SURFACE'):
            self.own(active=b'')

    def test_actual_wire_native_agent_role_with_human_takeover_refuses_until_release(self):
        # Scrubbed shape observed in live list: native Agent role is separate
        # from authoritative wire control, which the UI can temporarily take.
        wire = dict(schema='surface/v0.2', surface_id='surface-alice',
                    kind='desktop_capsule', display=':199', geometry=dict(w=1280,h=900),
                    state='active', visibility='unfolded', control='human', profile_id='alice')
        host.tools._check_surface(wire)
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_CONTROL'):
            self.own(wire)
        released = dict(wire, control='agent')
        host.tools._check_surface(released)
        self.assertEqual(self.own(released)['surface_id'], wire['surface_id'])

    def host_binding(self, **changes):
        # Scrubbed producer shape: capsule/human_binding.go exports this for
        # host-xpra agent programs as well as human viewing roles.
        value = dict(schema='metaviewer.human_binding/v0.3', host_xpra=True,
            surface_id='surface-alice', profile_id='alice', container='srf-pg-hx-alice',
            run_id='run-hw-alice', control_ready=True, input_epoch=0,
            width=1280, height=900, role='agent')
        value.update(changes)
        directory=self.root/'human-bindings'
        directory.mkdir(mode=0o700,exist_ok=True)
        path=directory/'surface-alice.json'
        path.write_text(json.dumps(value));path.chmod(0o600)
        return path

    def test_host_xpra_uses_adapter_binding_without_docker_inventory_or_legacy_lease(self):
        self.lease.unlink()
        self.host_binding()
        with patch.object(self.b,'native',side_effect=AssertionError('host program has no identity store')), \
             patch.object(host.tools,'list_surfaces',return_value=dict(
                surfaces=[self.surface],next_cursor=None)),patch.object(host,'command') as command:
            witness=self.b.ownership()
        command.assert_not_called()
        self.assertEqual(witness['profile'],'host-xpra')
        self.assertEqual(witness['capsules'],[])
        self.assertEqual(self.b.capsule,'srf-pg-hx-alice')

    def test_host_xpra_constructor_uses_only_program_context_without_identity_store(self):
        self.host_binding()
        client=Mock(host_env=dict(MV_SRF_STATE_DIR=str(self.root)))
        with patch('metaviewer_agents.perception.deps_lock.resolve_locked_component',return_value=self.root), \
             patch.object(host.tools,'list_surfaces',return_value=dict(surfaces=[self.surface],next_cursor=None)), \
             patch.object(host,'command',side_effect=AssertionError('native/Docker discovery used')):
            backend=program.ProgramBackend(client,'alice',self.root,{})
        self.assertEqual(backend.program_binding['profile_id'],'alice')
        self.assertIsNone(backend.store)

    def test_host_xpra_observation_retains_the_actual_public_rgb_projection(self):
        self.host_binding()
        published=self.publication();pixels=b'\xff'*(100*80*3)
        Path(published['ramws_path']).write_bytes(pixels)
        published['sha256']=host.hashlib.sha256(pixels).hexdigest()
        with patch.object(host.tools,'list_surfaces',return_value=dict(surfaces=[self.surface],next_cursor=None)), \
             patch.object(host.tools,'observe',return_value=dict(frame_ref=published)), \
             patch.object(host,'command',side_effect=AssertionError('host program used Docker/native lookup')):
            observed=self.b.observe(1000)
            retained=self.b.retain(observed['frame_ref'])
        self.assertEqual(Path(retained['artifact']).read_bytes(),pixels)
        self.assertEqual(retained['surface_id'],'surface-alice')

    def test_host_xpra_foreign_browser_human_unready_and_replaced_bindings_refuse(self):
        for change in (dict(profile_id='bob'),dict(surface_id='other'),dict(container='srf-id-alice'),
                       dict(container='srf-pg-alice'),dict(run_id='run-hw-foreign'),dict(host_xpra=False),
                       dict(role='human'),dict(control_ready=False),dict(input_epoch=True),dict(extra='unknown')):
            with self.subTest(change=change):
                self.host_binding(**change)
                with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_BINDING'):
                    self.own()
        path=self.host_binding()
        self.own()
        path.unlink()
        # A valid Docker lease must not rescue a vanished host binding.
        with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_BINDING'):
            self.own()

    def test_host_xpra_rechecks_authoritative_control_and_surface_before_dispatch(self):
        self.host_binding();self.own()
        for change,code in ((dict(control='human'),'MW_PROGRAM_CONTROL'),
                            (dict(kind='browser'),'MW_RUN_NO_SURFACE'),
                            (dict(kind='vm'),'MW_RUN_NO_SURFACE'),
                            (dict(surface_id='replacement'),'MW_RUN_OWNERSHIP')):
            with self.subTest(change=change),patch.object(host.tools,'propose') as submit:
                with self.assertRaisesRegex(host.OwnerRefused,code):self.own(dict(self.surface,**change))
                submit.assert_not_called()

    def test_host_window_without_exported_custody_does_not_become_a_host_xpra_program(self):
        # Keep a valid old native lease AND active srf-pg container. Neither
        # proves this separately admitted public host window's native transport.
        (self.root/'human-bindings/surface-alice.json').unlink()
        wire=dict(schema='surface/v0.2',profile_id='alice',state='active',kind='desktop_capsule',
            surface_id='surface-alice',control='agent',display=':0.123',
            geometry=dict(w=100,h=80),visibility='unfolded')
        host.tools._check_surface(wire)
        with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_BINDING'):
            self.own(surface=wire,active=b'srf-pg-alice\nsrf-hw-alice-123\n')
        self.assertIsNone(getattr(self.b,'program_binding',None))
        self.assertEqual(json.loads(self.lease.read_text())['Capsule']['container'],'srf-pg-alice')
        with patch.object(self.b,'native'),patch.object(host.tools,'list_surfaces',return_value=dict(
                surfaces=[wire],next_cursor=None)),patch.object(host.tools,'observe') as observe, \
             patch.object(host,'command') as command,patch.object(host.tools,'propose') as submit:
            with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_BINDING'):self.b.observe(1000)
        observe.assert_not_called();command.assert_not_called();submit.assert_not_called()

    def test_host_xpra_frames_require_the_public_publisher_layout_and_current_binding(self):
        valid=self.publication()
        with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_BINDING'):self.b.check_program_frame(valid)
        self.host_binding();self.own()
        path=Path(valid['ramws_path']);directory=path.parent
        self.b.check_program_frame(valid)
        for mutation in (dict(surface_id='foreign'),dict(ramws_path=str(self.root/'run-hw-alice/frames/w1/frame-1.rgb24')),
                         dict(ramws_path=str(path.with_suffix('.rgb24'))),
                         dict(ramws_path=str(path.parent/'..'/directory.name/path.name)),
                         dict(ramws_path='/tmp/frame-1.rgb24')):
            with self.subTest(mutation=mutation),self.assertRaises((host.OwnerRefused,host.tools.ToolValidationError)):
                self.b.check_program_frame(dict(valid,**mutation))
        alias=directory/('b'*32+'.rgb');alias.symlink_to(path)
        with self.assertRaises(host.OwnerRefused):self.b.check_program_frame(dict(valid,ramws_path=str(alias)))
        path.chmod(0o644)
        with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_FRAME_CUSTODY'):self.b.check_program_frame(valid)

    def test_host_xpra_requires_the_actual_verified_result_projection(self):
        self.host_binding();self.own()
        wire=dict(schema='action_receipt/v0.2',proposal_id='p',executed_at_ns=2,
            after_frame=frame(3),verified=True,verification=dict(method='pixel',detail='changed'),error='')
        projected=host.tools._VerifiedReceipt(wire,focus_verified=True,input_mono_ns=1,frame_sha256='a'*64)
        self.assertEqual(self.b.native_witness(projected)['surface_id'],'surface-alice')
        lookalike=dict(wire,native_evidence=dict(surface_id='surface-alice',input_mono_ns=1,input_ts_ns=1))
        with self.assertRaisesRegex(host.OwnerRefused,'MW_RECEIPT_MISMATCH'):
            self.b.native_witness(lookalike)

    def test_program_replacement_and_browser_receipt_do_not_pass_custody(self):
        self.own()
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_RUN_OWNERSHIP'):
            self.own(dict(self.surface, surface_id='replacement'))
        self.lease.write_text(json.dumps(dict(Lease=dict(ProfileID='alice'),
                                              Capsule=dict(container='srf-id-alice'))))
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_RUN_NO_SURFACE'):
            self.own(active=b'srf-id-alice\n')

    def test_unknown_visual_evidence_and_wrong_frame_never_plan(self):
        self.b.surface_id = 'surface-alice'
        self.own()
        self.b.vision = Mock()
        self.b.vision.diagnostics = dict(last_transport='vserve')
        with patch.object(self.b, 'retain', return_value={}), patch.object(
                program, 'project_element_table', return_value=dict(elements=[])):
            with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_UNKNOWN_OBSERVATION'):
                self.b.perceive(dict(frame_ref=self.publication()))
        failed = self.b.program_observations[-1]
        self.assertEqual(failed['status'], 'unknown')
        self.assertEqual(failed['table']['elements'], [])
        self.assertEqual(failed['diagnostics']['last_transport'], 'vserve')
        self.assertEqual(failed['error']['code'], 'MW_PROGRAM_UNKNOWN_OBSERVATION')
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_SURFACE'):
            self.b.perceive(dict(frame_ref=frame(surface='other')))

    def rgb_frame(self, generation, value=120):
        raw = bytes([value]) * (100 * 80 * 3)
        path = self.root / ('pixels-' + str(value) + '.rgb')
        path.write_bytes(raw); path.chmod(0o600)
        return dict(frame(generation), ramws_path=str(path), sha256=host.hashlib.sha256(raw).hexdigest())

    def retained_rgb(self, f):
        return dict(artifact=f['ramws_path'], generation=f['generation'], surface_id=f['surface_id'])

    def changed_frame(self, before, generation):
        raw = bytearray(Path(before['ramws_path']).read_bytes())
        raw[(60 * 100 + 60) * 3] ^= 1
        path = self.root / ('effect-' + str(generation) + '.rgb')
        path.write_bytes(raw); path.chmod(0o600)
        return dict(before, generation=generation, ramws_path=str(path), sha256=host.hashlib.sha256(raw).hexdigest())

    def pixel_rebind_fixture(self, *, over_target=False, changed_row=None):
        old = frame()
        raw = b'x' * (100 * 80 * 3)
        old_path = self.root / 'old.rgb'; old_path.write_bytes(raw)
        old.update(ramws_path=str(old_path), sha256=host.hashlib.sha256(raw).hexdigest())
        pixels = bytearray(raw)
        pixels[((25 * 100 + 20) if over_target else 0) * 3] = ord('y')
        new_path = self.root / 'new.rgb'; new_path.write_bytes(pixels)
        fresh = dict(old, generation=2, ramws_path=str(new_path),
                     sha256=host.hashlib.sha256(pixels).hexdigest())
        planner = self.freshness_fixture([old, fresh])
        def perceive(observed):
            f = observed['frame_ref']; table = element_table()
            table['frame_sha256'] = f['sha256']
            if f['generation'] == 2 and changed_row:
                table['elements'][0].update(changed_row)
            return dict(frame=f, frame_witness=self.b.retain(f),
                        observation=dict(frame_ref=f), table=table)
        self.b.perceive.side_effect = perceive
        return old, fresh, planner

    def test_clock_changes_between_model_and_dispatch_bind_newest_frame(self):
        old, fresh, planner = self.pixel_rebind_fixture()
        def settle(pid, *args, **kwargs):
            return dict(schema='action_receipt/v0.2', proposal_id=pid, executed_at_ns=2,
                after_frame=self.changed_frame(fresh, 3), verified=True,
                verification=dict(method='pixel', detail='changed'), error='',
                native_evidence=dict(surface_id='surface-alice', input_mono_ns=1, input_ts_ns=1))
        with patch.object(self.b, 'ownership'), patch.object(self.b, 'check_program_frame'), \
             patch.object(host.tools, 'propose', return_value=dict(status='admitted')) as submit, \
             patch.object(host.tools, 'wait_verify', side_effect=settle):
            moves = program.run_moves(self.b, planner, 'Covered square', 1, 1000)
        self.assertEqual(len(moves), 1)
        planner.plan_step.assert_called_once()
        self.assertEqual(self.b.perceive.call_count, 1)
        proposal = submit.call_args.args[0]
        self.assertEqual(proposal['based_on_frame'],
                         dict(sha256=fresh['sha256'], generation=2))
        dispatch = json.loads(Path(self.b.program_attempts[0]['dispatch_artifact']).read_text())
        self.assertEqual(dispatch['frame'], fresh)
        self.assertNotEqual(old['sha256'], fresh['sha256'])

    def test_target_pixels_or_ungrounded_identity_refuses_without_proposal(self):
        for over, change in ((True, None), (False, dict(role='text')),
                             (False, dict(name='different')),
                             (False, dict(bbox=dict(x=11, y=20, w=30, h=20)))):
            with self.subTest(over=over, change=change):
                old, fresh, planner = self.pixel_rebind_fixture(over_target=over, changed_row=change)
                with patch.object(self.b, 'ownership'), patch.object(self.b, 'check_program_frame'), \
                     patch.object(host.tools, 'propose') as submit:
                    sensed = self.b.perceive(self.b.observe(1000))
                    reply = planner_reply(); reply['target'] = reply['target_node']
                    if change:
                        sensed['table']['elements'][0].update(change)
                    with self.assertRaises((program.ProgramObservationChanged, host.OwnerRefused)):
                        self.b.propose(sensed, reply, 1000)
                submit.assert_not_called()

    def test_stale_retry_target_change_refuses_and_stale_cap_does_not_replan(self):
        for changed in (True, False):
            with self.subTest(changed=changed):
                old, fresh, planner = self.pixel_rebind_fixture()
                raw = bytearray(Path(fresh['ramws_path']).read_bytes())
                if changed:
                    raw[(25 * 100 + 20) * 3] = ord('z')
                path = self.root / 'retry.rgb'; path.write_bytes(raw)
                latest = dict(fresh, generation=3, ramws_path=str(path),
                              sha256=host.hashlib.sha256(raw).hexdigest())
                self.b.observe = Mock(side_effect=[dict(frame_ref=f) for f in
                                                  (old, fresh, latest, latest)])
                self.b.frame_attempts = []
                self.b.client = Mock()
                expected = program.ProgramObservationChanged if changed else host.tools.ToolRefusal
                with patch.object(self.b, 'ownership'), patch.object(self.b, 'check_program_frame'), \
                     patch.object(host.tools, 'propose',
                                  side_effect=host.tools.ToolRefusal('STALE_FRAME', None)) as submit, \
                     patch.object(host.tools, 'wait_verify') as settle:
                    with self.assertRaises(expected):
                        program.run_moves(self.b, planner, 'Covered square', 1, 1000)
                self.assertEqual(submit.call_count, 1 if changed else 3)
                settle.assert_not_called()
                self.b.perceive.assert_called_once()
                planner.plan_step.assert_called_once()
                if changed:
                    self.assertTrue(self.b.program_clean_refusal)
                    self.assertEqual(self.b.program_attempts[-1]['status'], 'refused_before_dispatch')

    def test_model_rejections_share_the_existing_stale_attempt_cap(self):
        for rejected in (1, 2):
            with self.subTest(rejected=rejected):
                old, fresh, planner = self.pixel_rebind_fixture()
                self.b.frame_attempts = []
                self.b.observe = Mock(side_effect=[dict(frame_ref=f) for f in
                    [old] * (rejected + 1) + [fresh] * 3])
                valid = planner.plan_step.side_effect
                planner.last_decision = {}
                def plan(*args):
                    if planner.plan_step.call_count <= rejected:
                        raise program.ProgramModelReplyRejected('MW_PROGRAM_MODEL_FAILED', 'bad reply')
                    return valid(*args)
                planner.plan_step.side_effect = plan
                with patch.object(self.b, 'ownership'), patch.object(self.b, 'check_program_frame'), \
                     patch.object(host.tools, 'propose',
                                  side_effect=host.tools.ToolRefusal('STALE_FRAME', None)) as submit:
                    with self.assertRaises(host.tools.ToolRefusal):
                        program.run_moves(self.b, planner, 'Covered square', 1, 1000)
                self.assertEqual(submit.call_count, 3 - rejected)
                self.assertEqual(planner.plan_step.call_count, rejected + 1)
                self.assertEqual(self.b.perceive.call_count, rejected + 1)

    def muse_retry_fixture(self):
        from metaviewer_agents.perception.base import Frame
        from metaviewer_agents.perception.vcore import _png_bytes
        temporary = tempfile.TemporaryDirectory(dir='/dev/shm/vqa-cu')
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        raw = b'x' * (100 * 80 * 3)
        path = directory / 'raw.rgb'; path.write_bytes(raw); path.chmod(0o600)
        current = dict(frame(), ramws_path=str(path), sha256=host.hashlib.sha256(raw).hexdigest())
        marks = directory / 'marks.png'
        marks.write_bytes(_png_bytes(Frame(100, 80, raw))); marks.chmod(0o600)
        table = element_table(); table['frame_sha256'] = current['sha256']
        c2 = dict(frame_sha256=current['sha256'], marks_png=str(marks),
            marks=[dict(id=1, x=10, y=20, w=30, h=20, kind='button', ocr_text='Covered square')])
        self.b.surface_id = current['surface_id']; self.b.wender = self.root
        self.b.observe = Mock(return_value=dict(frame_ref=current))
        sensed = dict(frame=current, frame_witness=dict(artifact=str(path)),
                      table=table, observation=dict(frame_ref=current))
        def perceive(observed):
            self.b.program_observations = [dict(sensed, c2=c2)]
            return sensed
        self.b.perceive = Mock(side_effect=perceive)
        custody = Mock(battery_state_sha256='d'*64); reply = planner_reply()
        custody.plan_step.return_value = tuple(reply[k] for k in ('action', 'expectation', 'state', 'target_node'))
        planner = program.MuseProgramPlanner(self.b, custody, 1000)
        good = dict(c3=dict(schema='cu.action/v1', action=dict(kind='click', mark_id=1, x=25, y=30)),
                    model_metadata={})
        return planner, good, current

    def test_invalid_model_replies_retry_before_input_then_accept_or_refuse(self):
        invalids = [dict(error=dict(type='ActionValidationError', message='changed_region requires region')),
                    dict(c3=dict(schema='cu.action/v1', action=dict(kind='click', mark_id=99)),
                         model_metadata={})]
        for invalid in invalids:
            for succeeds in (True, False):
                with self.subTest(invalid=invalid, succeeds=succeeds):
                    planner, good, current = self.muse_retry_fixture()
                    replies = [invalid, invalid, good if succeeds else invalid]
                    results = [SimpleNamespace(returncode=6 if 'error' in r else 0,
                                               stdout=json.dumps(r).encode()) for r in replies]
                    self.b.run_deadline_ns = time.monotonic_ns() + 5_000_000_000
                    deadline = self.b.run_deadline_ns
                    verification = dict(receipt=dict(after_frame=dict(current, generation=2)))
                    with patch.object(program, 'run_model_with_frames', side_effect=results) as model, \
                         patch.object(self.b, 'propose', return_value={}) as submit, \
                         patch.object(self.b, 'wait_verify', return_value=verification), \
                         patch.object(self.b, 'retain', return_value={}):
                        if succeeds:
                            moves = program.run_moves(self.b, planner, 'play', 1, 1000)
                            self.assertEqual(len(moves), 1); submit.assert_called_once()
                        else:
                            with self.assertRaises(program.ProgramModelReplyRejected):
                                program.run_moves(self.b, planner, 'play', 1, 1000)
                            submit.assert_not_called()
                            self.assertTrue(self.b.program_clean_refusal)
                    self.assertEqual(model.call_count, 3)
                    self.assertEqual(self.b.run_deadline_ns, deadline)
                    self.assertEqual(len(self.b.program_attempts), 3)
                    for attempt in self.b.program_attempts[:2 if succeeds else 3]:
                        self.assertEqual(attempt['status'], 'refused_before_dispatch')
                        self.assertFalse(attempt['submitted'])
                        self.assertNotIn('proposal_id', attempt)
                        self.assertEqual(attempt['model_decision'], invalid)

    def test_model_rejection_does_not_extend_absolute_deadline(self):
        planner, good, current = self.muse_retry_fixture()
        clock = [1_000_000_000]; self.b.run_deadline_ns = 2_000_000_000
        def reject(*args, **kwargs):
            clock[0] = self.b.run_deadline_ns
            return SimpleNamespace(returncode=6, stdout=json.dumps(dict(
                error=dict(type='ActionValidationError', message='changed_region requires region'))).encode())
        with patch.object(program.time, 'monotonic_ns', side_effect=lambda: clock[0]), \
             patch.object(program, 'run_model_with_frames', side_effect=reject) as model, \
             patch.object(self.b, 'propose') as submit:
            with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_DEADLINE'):
                program.run_moves(self.b, planner, 'play', 1, 1000)
        model.assert_called_once(); submit.assert_not_called()
        self.assertEqual(self.b.run_deadline_ns, 2_000_000_000)
        self.assertEqual(len(self.b.program_attempts), 1)

    def test_model_refusal_after_verified_move_keeps_code_and_partial_evidence(self):
        self.b.observe = Mock(return_value=dict(frame_ref=frame())); self.b.wender = self.root
        args = SimpleNamespace(identity='alice', goal='play', steps=2, timeout_ms=1000,
                               planner='rules', model_timeout_ms=120000)
        for code in ('MW_PROGRAM_MODEL_FAILED', 'MW_PROGRAM_MODEL_TARGET', 'MW_PROGRAM_DEADLINE'):
            reason = 'MW_PROGRAM_MODEL_TARGET' if code == 'MW_PROGRAM_DEADLINE' else code
            def refused(*unused):
                self.b.program_moves = [dict(status='verified_move')]
                self.b.program_attempts = [dict(status='verified_move'),
                    dict(status='refused_before_dispatch', reason_code=reason, submitted=False)]
                self.b.program_clean_refusal = code != 'MW_PROGRAM_DEADLINE'
                if code == 'MW_PROGRAM_DEADLINE':
                    raise host.OwnerRefused(code)
                raise program.ProgramModelReplyRejected(code, 'invalid model reply')
            with patch.dict(host.os.environ, {'XDG_STATE_HOME': str(self.root)}), \
                 patch.object(host, 'connect', return_value=contextlib.nullcontext(self.b.client)), \
                 patch.object(program, 'ProgramBackend', return_value=self.b), \
                 patch.object(program, 'VCorePerceptionAdapter'), \
                 patch.object(program, 'WenderSubprocessAdapter'), \
                 patch.object(program, 'run_moves', side_effect=refused), \
                 contextlib.redirect_stdout(io.StringIO()) as output, \
                 contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(program.run_entry(args), 6)
            result = json.loads(output.getvalue())
            self.assertEqual(result['verdict_code'], code)
            report = json.loads(Path(result['report']).read_text())
            self.assertEqual(report['status'], 'refused')
            self.assertEqual(len(report['moves']), 1)
            self.assertEqual(report['attempts'][-1]['reason_code'], reason)

    def test_unreleased_message_explains_release_action(self):
        with self.assertRaises(host.OwnerRefused) as caught:
            self.own(dict(self.surface, control='human'))
        self.assertEqual(caught.exception.code, 'MW_PROGRAM_CONTROL')
        self.assertIn('press Release on the tile, then run again', str(caught.exception))

    def test_moving_pixels_do_not_submit_old_coordinates(self):
        self.b.surface_id = 'surface-alice'
        with patch.object(self.b, 'ownership'), patch.object(self.b, 'observe', return_value=dict(
                frame_ref=dict(frame(2), sha256='b' * 64))), patch.object(host.tools, 'propose') as submit:
            with self.assertRaisesRegex(program.ProgramObservationChanged, 'MW_PROGRAM_OBSERVATION_CHANGED'):
                self.b.propose(dict(frame=frame()), planner_reply(), 1000)
            submit.assert_not_called()

    def freshness_fixture(self, frames):
        self.b.surface_id='surface-alice'
        values=iter(frames)
        self.b.observe=Mock(side_effect=lambda _:dict(frame_ref=next(values)))
        def perceive(observed):
            f=observed['frame_ref']; table=element_table();table['frame_sha256']=f['sha256']
            return dict(frame=f,frame_witness={},observation=dict(frame_ref=f),table=table)
        self.b.perceive=Mock(side_effect=perceive)
        reply=planner_reply()
        planner=Mock(battery_state_sha256='d'*64)
        def plan(*args):
            action=copy.deepcopy(reply['action']);action['x']=19+planner.plan_step.call_count
            return action,reply['expectation'],reply['state'],reply['target_node']
        planner.plan_step.side_effect=plan
        return planner

    def test_inherited_propose_changed_pixels_requires_new_perception_and_plan(self):
        b=lambda n:self.rgb_frame(n, 121)
        planner=self.freshness_fixture([frame(1),b(2),b(3),b(4),b(5)])
        def settle(pid,*args,**kwargs):
            return dict(schema='action_receipt/v0.2',proposal_id=pid,executed_at_ns=2,
                after_frame=self.rgb_frame(6, 122),verified=True,verification=dict(method='pixel',detail='changed'),error='',
                native_evidence=dict(surface_id='surface-alice',input_mono_ns=1,input_ts_ns=1))
        with patch.object(self.b,'ownership'),patch.object(self.b,'retain',side_effect=self.retained_rgb), \
             patch.object(host.tools,'propose',return_value=dict(status='admitted')) as submit, \
             patch.object(host.tools,'wait_verify',side_effect=settle):
            moves=program.run_moves(self.b,planner,'Covered square',1,1000)
        self.assertEqual(len(moves),1);self.assertEqual(planner.plan_step.call_count,2)
        self.assertEqual(self.b.perceive.call_count,2);submit.assert_called_once()
        proposal=submit.call_args.args[0]
        self.assertEqual(proposal['based_on_frame'],dict(sha256=b(5)['sha256'],generation=5))
        self.assertEqual(proposal['action']['x'],21) # Fresh second decision, not old x20.
        rejected=self.b.program_attempts[0]
        self.assertEqual(rejected['status'],'refused_before_dispatch')
        self.assertNotIn('proposal_id',rejected)
        self.assertEqual(rejected['rebind']['fresh_frame'],b(2))
        self.assertEqual(rejected['rebind']['mismatches'],dict(sha256=dict(sensed='a'*64,fresh=b(2)['sha256'])))

    def test_persistent_changed_pixels_is_bounded_without_proposals(self):
        f=lambda n,h:dict(frame(n),sha256=h*64)
        planner=self.freshness_fixture([f(1,'a'),f(2,'b'),f(3,'b'),f(4,'b'),
            f(5,'c'),f(6,'c'),f(7,'c'),f(8,'d')])
        with patch.object(self.b,'ownership'),patch.object(host.tools,'propose') as submit:
            with self.assertRaises(program.ProgramObservationChanged):
                program.run_moves(self.b,planner,'Covered square',1,1000)
        submit.assert_not_called();self.assertEqual(planner.plan_step.call_count,3)
        self.assertEqual(len(self.b.program_attempts),3)
        self.assertTrue(all(a['status']=='refused_before_dispatch' for a in self.b.program_attempts))
        self.assertTrue(self.b.program_clean_refusal)

    def test_changed_observation_cannot_reset_deadline(self):
        planner=self.freshness_fixture([frame(1),dict(frame(2),sha256='b'*64)])
        deadline=100000000;self.b.run_deadline_ns=deadline
        clock=[0];observe=self.b.observe.side_effect
        def advancing(timeout):
            result=observe(timeout)
            if result['frame_ref']['generation']==2:clock[0]=deadline
            return result
        self.b.observe.side_effect=advancing
        with patch.object(program.time,'monotonic_ns',side_effect=lambda:clock[0]), \
             patch.object(self.b,'ownership'),patch.object(host.tools,'propose') as submit:
            with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_DEADLINE'):
                program.run_moves(self.b,planner,'Covered square',1,1000)
        submit.assert_not_called();planner.plan_step.assert_called_once()
        self.assertEqual(self.b.run_deadline_ns,deadline)

    def test_typed_signal_after_dispatch_evidence_never_retries(self):
        planner=self.freshness_fixture([frame()])
        def suspect(*args):
            self.b.frame_attempts=[dict(status='dispatch_pending')]
            raise program.ProgramObservationChanged(frame(),frame(2),{})
        with patch.object(self.b,'propose',side_effect=suspect) as propose:
            with self.assertRaises(program.ProgramObservationChanged):
                program.run_moves(self.b,planner,'Covered square',1,1000)
        propose.assert_called_once();self.assertEqual(self.b.program_attempts[0]['status'],'input_uncertain')
        self.assertFalse(self.b.program_clean_refusal)

    def test_partial_verified_actions_only_clean_rebind_refusal_avoids_uncertainty(self):
        self.b.observe=Mock(return_value=dict(frame_ref=frame()))
        self.b.wender=self.root
        args=SimpleNamespace(identity='alice',goal='Covered square',steps=2,timeout_ms=1000,
            planner='rules',model_timeout_ms=120000)
        for clean in (True,False):
            def refused(*args):
                self.b.program_moves=[dict(status='verified_move')]
                self.b.program_attempts=[dict(status='refused_before_dispatch' if clean else 'input_uncertain')]
                self.b.program_clean_refusal=clean
                raise program.ProgramObservationChanged(frame(),frame(2),{})
            with patch.dict(host.os.environ,{'XDG_STATE_HOME':str(self.root)}), \
                 patch.object(host,'connect',return_value=contextlib.nullcontext(self.b.client)), \
                 patch.object(program,'ProgramBackend',return_value=self.b), \
                 patch.object(program,'VCorePerceptionAdapter'),patch.object(program,'WenderSubprocessAdapter'), \
                 patch.object(program,'wait_for_publication',return_value=dict(frame_ref=frame(2))), \
                 patch.object(program,'run_moves',side_effect=refused), \
                 contextlib.redirect_stdout(io.StringIO()) as output,contextlib.redirect_stderr(io.StringIO()):
                rc=program.run_entry(args)
            self.assertEqual(rc,6 if clean else 5)
            result=json.loads(output.getvalue())
            self.assertEqual(result['verdict_code'],'MW_PROGRAM_OBSERVATION_CHANGED' if clean else 'INPUT_UNCERTAIN')
            report=json.loads(Path(result['report']).read_text());self.assertEqual(len(report['moves']),1)

    def test_partial_verified_rebind_journal_or_refresh_failure_remains_uncertain(self):
        real_run_moves=program.run_moves
        real_wait=program.wait_for_publication
        real_write=program.atomic_journal
        args=SimpleNamespace(identity='alice',goal='Covered square',steps=2,timeout_ms=1000,
            planner='rules',model_timeout_ms=120000)
        for failure in ('journal','observe','subscribe'):
            with self.subTest(failure=failure):
                self.b.observe=Mock(return_value=dict(frame_ref=frame()))
                self.b.wender=self.root;self.b.pending={};self.b.frame_attempts=[]
                self.b.client=Mock()
                def run(*unused):
                    fresh=[self.rgb_frame(1),self.rgb_frame(2),self.rgb_frame(3,121),self.rgb_frame(4,121),
                           self.rgb_frame(5,122),self.rgb_frame(6,122)]
                    planner=self.freshness_fixture(fresh)
                    observe=self.b.observe.side_effect;count=[0]
                    def acquire(timeout):
                        count[0]+=1
                        if failure=='observe' and count[0]==6:raise host.ClientError('UNAVAILABLE','refresh unavailable')
                        return observe(timeout)
                    self.b.observe.side_effect=acquire
                    if failure=='subscribe':
                        self.b.client.subscribe_frames.side_effect=[None,host.ClientError('UNAVAILABLE','refresh unavailable')]
                    with patch.object(program,'wait_for_publication',side_effect=real_wait):
                        return real_run_moves(self.b,planner,'Covered square',2,1000)
                def journal(path,value):
                    if failure=='journal' and path.name.startswith('rebind-refused-'):
                        raise OSError('refusal receipt unavailable')
                    return real_write(path,value)
                def settle(pid,*unused,**kwargs):
                    return dict(schema='action_receipt/v0.2',proposal_id=pid,executed_at_ns=2,
                        after_frame=self.rgb_frame(3,121),verified=True,verification=dict(method='pixel',detail='changed'),error='',
                        native_evidence=dict(surface_id='surface-alice',input_mono_ns=1,input_ts_ns=1))
                with patch.dict(host.os.environ,{'XDG_STATE_HOME':str(self.root)}), \
                     patch.object(host,'connect',return_value=contextlib.nullcontext(self.b.client)), \
                     patch.object(program,'ProgramBackend',return_value=self.b), \
                     patch.object(program,'VCorePerceptionAdapter'),patch.object(program,'WenderSubprocessAdapter'), \
                     patch.object(program,'wait_for_publication',return_value=dict(frame_ref=frame(2))), \
                     patch.object(program,'run_moves',side_effect=run), \
                     patch.object(self.b,'ownership'),patch.object(self.b,'retain',side_effect=self.retained_rgb), \
                     patch.object(program,'atomic_journal',side_effect=journal), \
                     patch.object(host.tools,'propose',return_value=dict(status='admitted')) as submit, \
                     patch.object(host.tools,'wait_verify',side_effect=settle), \
                     contextlib.redirect_stdout(io.StringIO()) as output,contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(program.run_entry(args),5)
                result=json.loads(output.getvalue());self.assertEqual(result['verdict_code'],'INPUT_UNCERTAIN')
                report=json.loads(Path(result['report']).read_text())
                self.assertEqual(submit.call_count,1,report)
                self.assertEqual(len(report['moves']),1)
                self.assertFalse(self.b.program_clean_refusal)

    def test_invalid_rebind_identity_or_generation_does_not_request_replanning(self):
        self.b.surface_id='surface-alice'
        for fresh in (dict(frame(2),surface_id='foreign'),dict(frame(1),sha256='b'*64),frame(0)):
            with self.subTest(fresh=fresh),patch.object(self.b,'ownership'), \
                 patch.object(self.b,'observe',return_value=dict(frame_ref=fresh)), \
                 patch.object(host.tools,'propose') as submit:
                with self.assertRaises(host.OwnerRefused):
                    self.b.propose(dict(frame=frame()),planner_reply(),1000)
                submit.assert_not_called()

    def test_real_planner_boundary_and_core_receipt_without_browser_metadata(self):
        # A real pipe fixture exercises the existing Wender validator, including
        # target custody; only perception and the external core are synthetic.
        reply = planner_reply()
        command = [sys.executable, '-c', 'import json,sys; json.load(sys.stdin); print(' +
                   repr(json.dumps(reply)) + ')']
        planner = program.WenderSubprocessAdapter(command=command, wender_root=self.root,
                                                  verify_lock=False)
        self.b.surface_id = 'surface-alice'
        self.b.retain = Mock(side_effect=self.retained_rgb)
        sensed = dict(frame=self.rgb_frame(1), frame_witness={}, observation=program.build_observation(
            self.rgb_frame(1), surface_id='surface-alice', generation=1), table=element_table())

        based={}
        def settlement(proposal_id, *args, **kwargs):
            return dict(schema='action_receipt/v0.2', proposal_id=proposal_id, executed_at_ns=2,
                after_frame=self.rgb_frame(based[proposal_id]+1, 121 if based[proposal_id] < 4 else 122), verified=True, verification=dict(method='pixel', detail='changed'),
                error='', native_evidence=dict(surface_id='surface-alice', input_mono_ns=1, input_ts_ns=1))

        def accept(proposal, **kwargs):
            journal = self.root / ('dispatch-' + proposal['proposal_id'] + '.json')
            saved = json.loads(journal.read_text())
            self.assertEqual(saved['proposal'], proposal)
            self.assertTrue(Path(saved['intent_artifact']).is_file())
            based[proposal['proposal_id']]=proposal['based_on_frame']['generation']
            return dict(status='admitted')

        def acquisition(observed):
            current=observed['frame_ref']
            table=element_table();table['frame_sha256']=current['sha256']
            return dict(sensed,frame=current,table=table,frame_witness=self.b.retain(current),observation=program.build_observation(current,
                surface_id='surface-alice',generation=current['generation']))
        publications=iter([self.rgb_frame(2),self.rgb_frame(2),self.rgb_frame(3,121),self.rgb_frame(4,121),self.rgb_frame(5,121)])
        with patch.object(self.b, 'ownership'), patch.object(self.b, 'observe',
                side_effect=lambda _:dict(frame_ref=next(publications))), \
             patch.object(self.b, 'perceive', side_effect=acquisition), \
             patch.object(self.b, 'ax', side_effect=AssertionError('browser AX used')), \
             patch.object(self.b, 'network_context', side_effect=AssertionError('browser network used')), \
             patch.object(host.tools, 'propose', side_effect=accept) as submit, \
             patch.object(host.tools, 'wait_verify', side_effect=settlement) as wait:
            moves = program.run_moves(self.b, planner, 'Covered square', 2, 1000)
        self.assertEqual(len(moves), 2)
        self.assertEqual(submit.call_count, 2)
        self.assertEqual(wait.call_count, 2)
        self.assertEqual(moves[-1]['status'], 'verified_move')
        self.assertEqual([move['before']['generation'] for move in moves],[2,4])
        self.b.client.subscribe_frames.assert_called_once()
        self.assertEqual(submit.call_args.args[0]['surface_id'], 'surface-alice')
        self.assertEqual(len(list(self.root.glob('receipt-*.json'))), 2)

    def test_planner_or_settlement_failure_never_creates_verified_move(self):
        self.b.observe = Mock(return_value={})
        self.b.perceive = Mock(return_value=dict(frame=frame(),observation={}, table=element_table()))
        planner = Mock(battery_state_sha256='d' * 64)
        planner.plan_step.side_effect = ValueError('planner failed')
        with patch.object(self.b, 'propose') as submit, self.assertRaisesRegex(ValueError, 'planner failed'):
            program.run_moves(self.b, planner, 'Reveal a square', 1, 1000)
        submit.assert_not_called()
        self.assertEqual(self.b.program_moves, [])
        planner.plan_step.side_effect = None
        reply=planner_reply()
        planner.plan_step.return_value = tuple(reply[k] for k in ('action','expectation','state','target_node'))
        with patch.object(self.b, 'propose', return_value={}), patch.object(
                self.b, 'wait_verify', side_effect=ValueError('settlement failed')):
            with self.assertRaisesRegex(ValueError, 'settlement failed'):
                program.run_moves(self.b, planner, 'Covered square', 1, 1000)
        self.assertEqual(self.b.program_moves, [])

    def test_generic_goal_and_ambiguous_label_cannot_authorize_planner_fallback(self):
        target = planner_reply()['target_node']
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_GOAL_UNGROUNDED'):
            program.require_grounded_goal(element_table(), 'Play Mines', target)
        duplicate = element_table()
        duplicate['elements'].append(copy.deepcopy(duplicate['elements'][0]))
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_GOAL_UNGROUNDED'):
            program.require_grounded_goal(duplicate, 'Covered square', target)
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_GOAL_UNGROUNDED'):
            program.require_grounded_goal(element_table(), 'Covered square', dict(target, box=[1,2,3,4]))
        program.require_grounded_goal(element_table(), 'Covered square', target)
        self.b.observe = Mock(return_value={})
        self.b.perceive = Mock(return_value=dict(observation={}, table=element_table()))
        planner = Mock(battery_state_sha256='d' * 64)
        planner.plan_step.return_value = ({}, {}, {}, target)
        with patch.object(self.b, 'propose') as submit, self.assertRaisesRegex(
                host.OwnerRefused, 'MW_PROGRAM_GOAL_UNGROUNDED'):
            program.run_moves(self.b, planner, 'Play Mines', 1, 1000)
        submit.assert_not_called()
        self.assertEqual(self.b.program_attempts[-1]['status'], 'goal_not_grounded')

    def test_unknown_dispatch_never_retries_and_retains_input_uncertainty(self):
        self.b.observe = Mock(return_value={})
        self.b.perceive = Mock(return_value=dict(frame=frame(), observation={}, table=element_table()))
        planner = Mock(battery_state_sha256='d' * 64)
        reply=planner_reply()
        planner.plan_step.return_value = tuple(reply[k] for k in ('action','expectation','state','target_node'))
        self.b.frame_attempts = []
        def uncertain(*args):
            intent = list(self.root.glob('intent-*.json'))
            self.assertEqual(len(intent), 1)
            self.assertEqual(json.loads(intent[0].read_text())['status'], 'pending_dispatch')
            self.b.frame_attempts.append(dict(status='dispatch_pending'))
            raise TimeoutError('unknown delivery')
        with patch.object(self.b, 'propose', side_effect=uncertain) as submit:
            with self.assertRaises(TimeoutError):
                program.run_moves(self.b, planner, 'Covered square', 1, 1000)
        self.assertEqual(submit.call_count, 1)
        self.assertEqual(self.b.program_attempts[-1]['status'], 'input_uncertain')

    def verification_fixture(self, status):
        self.b.surface_id='surface-alice';self.b.wender=self.root
        self.b.ownership=Mock()
        self.b.observe=Mock(return_value=dict(frame_ref=frame(2)))
        self.b.perceive=Mock(return_value=dict(frame=frame(),frame_witness={},observation={},table=element_table()))
        self.b.retain=Mock(return_value={})
        planner=Mock(battery_state_sha256='d'*64);reply=planner_reply()
        planner.plan_step.return_value=tuple(reply[k] for k in ('action','expectation','state','target_node'))
        payloads=[]
        def tool_reply(call,expect,**unused):
            self.assertEqual(call['op'],'wait_verify')
            body=dict(schema='mv_tool_result/v0.2',request_id=call['request_id'],op='wait_verify',status=status)
            if status=='error':body.update(code='VERIFICATION_FAILED',detail='Actual receipt frame remained unchanged')
            else:body.update(proposal_id=call['args']['proposal_id'],verified=False)
            payloads.append(copy.deepcopy(body));return body
        self.b.client.request=Mock(side_effect=tool_reply)
        return planner,payloads

    def test_real_tool_terminal_verification_payload_is_journaled_without_inventing_receipt_fields(self):
        for status in ('error','timeout'):
            with self.subTest(status=status):
                planner,payloads=self.verification_fixture(status)
                with patch.object(host.tools,'propose',return_value=dict(status='admitted')) as submit:
                    with self.assertRaises(host.tools.VerificationFailed):
                        program.run_moves(self.b,planner,'Covered square',2,1000)
                submit.assert_called_once();planner.plan_step.assert_called_once()
                attempt=self.b.program_attempts[0]
                self.assertEqual(attempt['status'],'input_uncertain')
                retained=json.loads(Path(attempt['verification_failure_artifact']).read_text())
                self.assertEqual(retained['payload'],payloads[0])
                dispatch=json.loads(Path(attempt['dispatch_artifact']).read_text())
                self.assertEqual(retained['proposal_id'],dispatch['proposal']['proposal_id'])
                self.assertEqual(retained['proposal_id'],attempt['proposal_id'])
                self.assertEqual(retained['correlation'],'dispatch_wait_call' if status=='error' else 'proposal_id_match')
                if status=='error':self.assertNotIn('proposal_id',retained['payload'])
                self.assertEqual(self.b.program_moves,[])
                self.assertEqual(stat.S_IMODE(Path(attempt['verification_failure_artifact']).stat().st_mode),0o600)

    def test_missing_verification_payload_stays_unknown_and_mismatch_never_retries(self):
        for payload in (None,dict(status='timeout',proposal_id='foreign',verified=False)):
            attempt=dict(status='input_uncertain',proposal_id='known',intent_artifact='retained-intent')
            error=host.tools.VerificationFailed(payload)
            program.journal_verification_failure(self.b,attempt,error,program.uuid.uuid4().hex)
            saved=json.loads(Path(attempt['verification_failure_artifact']).read_text())
            self.assertEqual(saved['status'],'input_uncertain')
            if payload is None:
                self.assertNotIn('payload',saved)
                self.assertEqual(saved['correlation'],'unknown')
                self.assertEqual(saved['payload_status'],'unavailable')
            else:
                self.assertEqual(saved['payload'],payload)
                self.assertEqual(saved['correlation'],'proposal_id_mismatch')

    def test_diagnostic_journal_failure_keeps_public_rc5_and_payload_in_report(self):
        planner,payloads=self.verification_fixture('error')
        args=SimpleNamespace(surface_kind='program',identity='alice',goal='Covered square',steps=2,
            timeout_ms=1000,planner='rules',model_timeout_ms=120000)
        write=program.atomic_journal
        def fail_diagnostic(path,value):
            if path.name.startswith('verification-failure-'):raise OSError('diagnostic output unavailable')
            return write(path,value)
        stdout=io.StringIO()
        with patch.dict(host.os.environ,{'XDG_STATE_HOME':str(self.root)}), \
             patch.object(host,'connect',return_value=contextlib.nullcontext(self.b.client)), \
             patch.object(program,'ProgramBackend',return_value=self.b), \
             patch.object(program,'VCorePerceptionAdapter'), \
             patch.object(program,'WenderSubprocessAdapter',return_value=planner), \
             patch.object(host.tools,'propose',return_value=dict(status='admitted')) as submit, \
             patch.object(program,'atomic_journal',side_effect=fail_diagnostic), \
             contextlib.redirect_stdout(stdout),contextlib.redirect_stderr(io.StringIO()):
            rc=program.run_entry(args)
        self.assertEqual(rc,5);submit.assert_called_once()
        result=json.loads(stdout.getvalue());self.assertEqual(result['verdict_code'],'INPUT_UNCERTAIN')
        report=json.loads(Path(result['report']).read_text())
        self.assertEqual(report['status'],'input_uncertain')
        attempt=report['attempts'][0]
        self.assertEqual(attempt['verification_failure']['payload'],payloads[0])
        self.assertEqual(attempt['verification_failure_journal_error']['type'],'OSError')
        self.assertNotIn('verification_failure_artifact',attempt)

    def test_ticking_frames_drain_and_stale_retry_without_model_or_perception(self):
        old, fresh, planner = self.pixel_rebind_fixture()
        newest = dict(fresh, generation=5)
        later = dict(fresh, generation=6)
        client = Mock(spec=host.ToolClient)
        client._frames = {}
        self.b.client = client
        self.b.subscription = {}
        clock = [0]
        def perceive(observed):
            # A one-second publisher ticks twice during slow perception.
            clock[0] += 2_100_000_000
            client._frames[self.b.surface_id] = dict(fresh, generation=3)
            table = element_table(); table['frame_sha256'] = old['sha256']
            return dict(frame=old, frame_witness=self.b.retain(old),
                        table=table, observation=dict(frame_ref=old))
        self.b.perceive.side_effect = perceive
        self.b.observe = Mock(return_value=dict(frame_ref=old))
        queue = [dict(fresh, generation=4), newest, None, later, None]
        def drain(**kwargs):
            value = queue.pop(0)
            if value is None:
                return False
            client._frames[self.b.surface_id] = value
            return True
        client.drain_frames.side_effect = drain
        submitted = []
        def submit(proposal, **kwargs):
            submitted.append(proposal['based_on_frame']['generation'])
            if len(submitted) == 1:
                raise host.tools.ToolRefusal('STALE_FRAME', None)
            self.assertEqual(submitted[-1], client._frames[self.b.surface_id]['generation'])
            return dict(status='admitted')
        def settle(pid, *args, **kwargs):
            return dict(schema='action_receipt/v0.2', proposal_id=pid, executed_at_ns=2,
                after_frame=self.changed_frame(later, 7), verified=True,
                verification=dict(method='pixel', detail='changed'), error='',
                native_evidence=dict(surface_id='surface-alice', input_mono_ns=1, input_ts_ns=1))
        with patch.object(self.b, 'ownership'), patch.object(self.b, 'check_program_frame'), \
             patch.object(program, 'wait_for_publication', return_value=dict(frame_ref=fresh)), \
             patch.object(program.time, 'monotonic_ns', side_effect=lambda: clock[0]), \
             patch.object(host.tools, 'propose', side_effect=submit), \
             patch.object(host.tools, 'wait_verify', side_effect=settle):
            moves = program.run_moves(self.b, planner, 'Covered square', 1, 10000)
        self.assertEqual(len(moves), 1)
        self.assertEqual(submitted, [5, 6])
        self.assertEqual(client.drain_frames.call_count, 5)
        self.b.perceive.assert_called_once()
        planner.plan_step.assert_called_once()
        self.assertEqual([r['status'] for r in self.b.frame_attempts], ['STALE_FRAME', 'admitted'])
        self.assertEqual(len(self.b.program_attempts[0]['frame_rebinds']), 2)

    def test_each_verified_move_reacquires_and_plans_the_current_target(self):
        self.b.surface_id='surface-alice'
        publications=iter([frame(1),frame(2),frame(2),dict(frame(3),sha256='b'*64)])
        self.b.observe=Mock(side_effect=lambda _:dict(frame_ref=next(publications)))
        def acquire(observed):
            current=observed['frame_ref'];table=element_table()
            table['frame_sha256']=current['sha256']
            if current['generation']>=3:table['elements'][0]['bbox']=dict(x=50,y=40,w=20,h=20)
            return dict(frame=current,frame_witness=dict(generation=current['generation']),
                table=table,observation=dict(frame_ref=current))
        self.b.perceive=Mock(side_effect=acquire)
        planner=Mock(battery_state_sha256='d'*64)
        def decide(observation,table,goal):
            box=table['elements'][0]['bbox'];reply=planner_reply()
            reply['target_node']['box']=[box[k] for k in ('x','y','w','h')]
            reply['action'].update(x=box['x']+box['w']//2,y=box['y']+box['h']//2)
            return tuple(reply[k] for k in ('action','expectation','state','target_node'))
        planner.plan_step.side_effect=decide
        after=iter([frame(2),dict(frame(4),sha256='b'*64)])
        with patch.object(self.b,'propose',return_value={}) as submit,patch.object(
                self.b,'wait_verify',side_effect=lambda *_:dict(receipt=dict(after_frame=next(after)))), \
             patch.object(self.b,'retain',side_effect=lambda f:dict(generation=f['generation'])):
            moves=program.run_moves(self.b,planner,'Covered square',2,1000)
        self.assertEqual([m['action']['x'] for m in moves],[25,60])
        self.assertEqual([call.args[0]['frame']['generation'] for call in submit.call_args_list],[1,3])
        self.assertEqual(planner.plan_step.call_count,2)
        self.assertEqual(self.b.perceive.call_count,2)
        self.b.client.subscribe_frames.assert_called_once_with('surface-alice',timeout_ms=1000)

    def test_repeated_frame_after_settlement_never_authorizes_a_second_plan(self):
        self.b.surface_id='surface-alice'
        self.b.observe=Mock(side_effect=lambda _:dict(frame_ref=frame(1 if not self.b.program_moves else 2)))
        sensed=dict(frame=frame(),frame_witness={},observation={},table=element_table())
        self.b.perceive=Mock(return_value=sensed)
        planner=Mock(battery_state_sha256='d'*64);reply=planner_reply()
        planner.plan_step.return_value=tuple(reply[k] for k in ('action','expectation','state','target_node'))
        with patch.object(self.b,'propose',return_value={}) as submit,patch.object(
                self.b,'wait_verify',return_value=dict(receipt=dict(after_frame=frame(2)))), \
             patch.object(self.b,'retain',return_value={}):
            with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_NO_NEW_PUBLICATION'):
                program.run_moves(self.b,planner,'Covered square',2,20)
        planner.plan_step.assert_called_once();submit.assert_called_once()
        self.assertEqual(len(self.b.program_moves),1)

    def test_new_publication_cannot_rescue_stale_perception_or_foreign_surface(self):
        for publication in (frame(3),frame(3,surface='foreign')):
            with self.subTest(publication=publication):
                self.b.surface_id='surface-alice'
                self.b.observe=Mock(side_effect=[dict(frame_ref=frame()),dict(frame_ref=frame(2)),
                                                dict(frame_ref=publication)])
                self.b.perceive=Mock(return_value=dict(frame=frame(),frame_witness={},observation={},table=element_table()))
                planner=Mock(battery_state_sha256='d'*64);reply=planner_reply()
                planner.plan_step.return_value=tuple(reply[k] for k in ('action','expectation','state','target_node'))
                with patch.object(self.b,'propose',return_value={}) as submit,patch.object(
                        self.b,'wait_verify',return_value=dict(receipt=dict(after_frame=frame(2)))), \
                     patch.object(self.b,'retain',return_value={}):
                    with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_FRESH_FRAME'):
                        program.run_moves(self.b,planner,'Covered square',2,1000)
                planner.plan_step.assert_called_once();submit.assert_called_once()

    def test_model_conversion_requires_unique_current_mark_never_raw_coordinates(self):
        c2 = dict(marks=[dict(id=11,x=10,y=20,w=30,h=20,kind='button')])
        table = element_table()
        table['elements'][0]['name'] = 'mark-11'
        c3 = dict(schema='cu.action/v1',action=dict(kind='click',mark_id=11,x=25,y=30))
        self.assertEqual(program.MuseProgramPlanner.selected_name(c3,c2,table), 'mark-11')
        for doubt in (dict(need_reasoning=True), dict(confidence=0.35)):
            with self.subTest(doubt=doubt), self.assertRaises(host.OwnerRefused):
                program.MuseProgramPlanner.selected_name(dict(c3, **doubt), c2, table)
        self.assertEqual(program.MuseProgramPlanner.selected_name(dict(c3, confidence=0.45), c2, table), 'mark-11')
        for action in (dict(kind='click',x=25,y=30), dict(kind='type',text='unsafe'),
                       dict(kind='click',mark_id=12,x=25,y=30), dict(kind='click',mark_id=11,x=0,y=0)):
            with self.subTest(action=action), self.assertRaises(host.OwnerRefused):
                program.MuseProgramPlanner.selected_name(dict(c3,action=action),c2,table)

    def test_click_must_stay_inside_unique_target(self):
        target=planner_reply()['target_node']
        program.require_click_target(dict(type='click',x=20,y=30),target)
        for action in (dict(type='click',x=0,y=0),dict(type='click',x=True,y=30),dict(type='type',text='x')):
            with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_CLICK_TARGET'):
                program.require_click_target(action,target)

    def test_model_ram_path_rejects_symlink_ancestors_traversal_and_public_files(self):
        from mw_program_muse import private_ram_path
        with program.marks_workspace() as marks:
            marks.write_bytes(b'fixture')
            marks.chmod(0o600)
            self.assertEqual(private_ram_path(marks),marks)
            alias=marks.parent/'alias'
            alias.symlink_to(marks.parent,target_is_directory=True)
            with self.assertRaises(ValueError): private_ram_path(alias/marks.name)
            (marks.parent/'inner').mkdir(mode=0o700)
            with self.assertRaises(ValueError): private_ram_path(marks.parent/'inner'/'..'/marks.name)
            marks.chmod(0o644)
            with self.assertRaises(ValueError): private_ram_path(marks)

    def test_existing_static_subscription_refreshes_after_planning_without_replanning(self):
        client=object.__new__(host.ToolClient)
        client._frame_subscriptions={'surface-alice'}
        client._frames={}
        client.drain_frames=Mock(return_value=False)
        refreshed=[False]
        def refresh(*args,**kwargs): refreshed[0]=True
        client.subscribe_frames=Mock(side_effect=refresh)
        self.b.client=client
        self.b.subscription={}
        self.b.surface_id='surface-alice'
        self.b.observe=Mock(side_effect=lambda timeout_ms: dict(frame_ref=self.rgb_frame(9 if refreshed[0] else 8)))
        sensed=dict(frame=self.rgb_frame(8),frame_witness={},observation={},table=element_table())
        self.b.perceive=Mock(return_value=sensed)
        reply=planner_reply()
        planner=Mock(battery_state_sha256='d'*64)
        planner.plan_step.return_value=tuple(reply[k] for k in ('action','expectation','state','target_node'))
        def accept(proposal,**kwargs):
            self.assertEqual(proposal['based_on_frame']['generation'],9)
            return dict(status='admitted')
        def settle(pid,*args,**kwargs):
            return dict(schema='action_receipt/v0.2',proposal_id=pid,executed_at_ns=2,
                after_frame=self.rgb_frame(10,121),verified=True,verification=dict(method='pixel',detail='changed'),
                error='',native_evidence=dict(surface_id='surface-alice',input_mono_ns=1,input_ts_ns=1))
        with patch.object(self.b,'ownership'),patch.object(self.b,'retain',side_effect=self.retained_rgb), \
             patch.object(self.b,'check_program_frame'), \
             patch.object(host.tools,'propose',side_effect=accept),patch.object(host.tools,'wait_verify',side_effect=settle):
            moves=program.run_moves(self.b,planner,'Covered square',1,1000)
        self.assertEqual(len(moves),1)
        planner.plan_step.assert_called_once()
        client.subscribe_frames.assert_called_once()

    def test_model_group_refuses_reserved_noninteger_self_and_own_group(self):
        with patch.object(program.os, 'getpid', return_value=100), patch.object(
                program.os, 'getpgid', return_value=90), patch.object(program.os, 'killpg') as send:
            for target in (0, 1, -1, True, False, 2.0, '200', None, Mock(), 100, 90):
                with self.subTest(target=repr(target)):
                    with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_MODEL_PROCESS_TARGET'):
                        program.stop_model_group(target)
            send.assert_not_called()

    def test_model_group_signals_only_recorded_target_and_tolerates_already_gone(self):
        with patch.object(program.os, 'getpid', return_value=100), patch.object(
                program.os, 'getpgid', return_value=90), patch.object(program.os, 'killpg') as send:
            program.stop_model_group(200)
            send.assert_called_once_with(200, program.signal.SIGKILL)
            send.reset_mock()
            send.side_effect = ProcessLookupError
            program.stop_model_group(200)
            send.assert_called_once_with(200, program.signal.SIGKILL)

    def test_model_group_is_cleaned_before_reaping_releases_its_identifier(self):
        events = []
        owned = [True]
        streams = [tempfile.TemporaryFile(dir=self.root) for _ in range(3)]
        for stream in streams:
            self.addCleanup(stream.close)
        child = SimpleNamespace(pid=200, stdin=streams[0], stdout=streams[1],
                                stderr=streams[2], returncode=None)
        def observe_exit(kind, pid, flags):
            self.assertEqual((kind, pid), (program.os.P_PID, 200))
            self.assertTrue(flags & program.os.WNOWAIT)
            events.append('observe_unreaped_exit')
            return SimpleNamespace(si_pid=200)
        def signal_group(pid, sig):
            self.assertTrue(owned[0], 'reaping would allow an unrelated group to reuse this id')
            self.assertEqual((pid, sig), (200, program.signal.SIGKILL))
            events.append('cleanup_owned_group')
        def reap():
            events.append('reap')
            owned[0] = False
            child.returncode = 0
        child.wait = reap
        selector = Mock()
        selector.get_map.return_value = {}
        with patch.object(host.subprocess, 'Popen', return_value=child), patch.object(
                program.selectors, 'DefaultSelector', return_value=contextlib.nullcontext(selector)), patch.object(
                program.os, 'waitid', side_effect=observe_exit), patch.object(
                program.os, 'getpid', return_value=100), patch.object(
                program.os, 'getpgid', return_value=90), patch.object(
                program.os, 'killpg', side_effect=signal_group):
            result = program.run_model_with_frames(Mock(), ['synthetic-provider'],
                cwd=self.root, env={}, request=b'{}', timeout=1)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(events, ['observe_unreaped_exit', 'cleanup_owned_group', 'reap'])

    def test_model_pipe_wait_drains_frames_without_input_or_background_reader(self):
        client=Mock()
        client.drain_frames.return_value=False
        command=[sys.executable,'-c','import sys,time; sys.stdin.read(); time.sleep(0.05); print("{}");']
        result=program.run_model_with_frames(client,command,cwd=self.root,
            env={'PATH':os.defpath},request=b'{}',timeout=2)
        self.assertEqual(result.returncode,0)
        self.assertEqual(json.loads(result.stdout),{})
        self.assertGreater(client.drain_frames.call_count,0)

    def test_model_pipe_timeout_and_hostile_output_stop_before_any_action(self):
        client=Mock()
        client.drain_frames.return_value=False
        with self.assertRaises(host.subprocess.TimeoutExpired):
            program.run_model_with_frames(client,[sys.executable,'-c','import time; time.sleep(10)'],
                cwd=self.root,env={'PATH':os.defpath},request=b'{}',timeout=0.05)
        with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_MODEL_OUTPUT_LIMIT'):
            program.run_model_with_frames(client,[sys.executable,'-c','print("x"*1048577)'],
                cwd=self.root,env={'PATH':os.defpath},request=b'{}',timeout=2)

    def model_socket_fixture(self, mode):
        """A preauthenticated ToolClient channel and synthetic core process.

        The core continuously sends frames but expires its inbound idle timer;
        only an actual correlated observe request refreshes that timer.
        """
        self.b.surface_id='surface-alice'
        self.b.program_binding=dict(surface_id='surface-alice')
        current=self.publication()
        local,remote=socket.socketpair()
        client=host.ToolClient(self.root/'unused.sock',session_id='model-session',
            local=dict(endpoint=dict(component='agent',instance='model-agent')),
            core=dict(endpoint=dict(component='core',instance='model-core')),
            dependency_pins=[],sequence_path=self.root/('seq-'+mode),timeout_s=1,
            max_line_bytes=65536,max_reply_bytes=65536)
        client.active._sock=local;client.active._hello_complete=True;client._ready=True
        client._frame_surfaces.add('surface-alice')
        self.b.client=client
        script=r'''
import json,select,socket,sys,time
s=socket.socket(fileno=int(sys.argv[1]));frame=json.loads(sys.argv[2]);mode=sys.argv[3]
seq=0;generation=0;last=time.monotonic();tick=last;buf=b'';muted=False
def send(body):
 global seq
 seq+=1
 e=dict(schema='envelope/v0.2',msg_id='fake-'+str(seq),ts_ns=seq,
  **{'from':dict(component='core',instance='model-core'),'to':dict(component='agent',instance='model-agent')},
  session_id='model-session',seq=seq,nonce='fake-nonce-'+str(seq),body=body)
 s.sendall((json.dumps(e)+'\n').encode())
try:
 while True:
  now=time.monotonic()
  if not muted and now-last>0.18:break
  if not muted and now>=tick:
   generation+=1;frame['generation']=generation
   send(dict(frame));tick=now+0.01
  if not select.select([s],[],[],0.005)[0]:continue
  data=s.recv(65536)
  if not data:break
  buf+=data
  while b'\n' in buf:
   line,buf=buf.split(b'\n',1);e=json.loads(line);b=e['body']
   assert b['op']=='observe' and b['args']==dict(surface_id='surface-alice')
   last=time.monotonic()
   if mode=='eof':sys.exit(0)
   if mode=='timeout':muted=True;continue
   f=dict(frame)
   if mode=='wrong_surface':f['surface_id']='foreign'
   if mode=='malformed':f['width']=0
   send(dict(schema='mv_tool_result/v0.2',request_id=b['request_id'],op='observe',status='ok',
    observation=dict(schema='observation/v0.2',frame_ref=f,
     vision=dict(summary='',changed_regions=[],elements=[]))))
except (BrokenPipeError,ConnectionResetError):pass
finally:s.close()
'''
        server=host.subprocess.Popen([sys.executable,'-c',script,str(remote.fileno()),json.dumps(current),mode],
            pass_fds=(remote.fileno(),),stdin=host.subprocess.DEVNULL,stdout=host.subprocess.DEVNULL,
            stderr=host.subprocess.PIPE)
        remote.close()
        def cleanup():
            client.close()
            try:server.wait(timeout=2)
            except host.subprocess.TimeoutExpired:
                server.terminate();server.wait(timeout=2)
            error=server.stderr.read();server.stderr.close()
            self.assertEqual(server.returncode,0,error.decode())
        self.addCleanup(cleanup)
        return client

    def test_actual_socket_frames_alone_expire_but_observe_keeps_one_model_alive(self):
        command=[sys.executable,'-c','import sys,time;sys.stdin.read();time.sleep(0.4);print("{}");']
        for keep in (False,True):
            with self.subTest(keepalive=keep):
                client=self.model_socket_fixture('ok' if keep else 'idle')
                popen=host.subprocess.Popen
                with patch.object(program,'MODEL_KEEPALIVE_INTERVAL_S',0.04), \
                     patch.object(self.b,'ownership') as ownership,patch.object(self.b,'native') as native, \
                     patch.object(host.tools,'list_surfaces') as listing, \
                     patch.object(host.subprocess,'Popen',wraps=popen) as spawn:
                    if keep:
                        result=program.run_model_with_frames(client,command,cwd=self.root,env={'PATH':os.defpath},
                            request=b'{}',timeout=1,keepalive=self.b.keepalive_observe)
                        self.assertEqual(result.returncode,0)
                        self.assertEqual(json.loads(result.stdout),{})
                    else:
                        with self.assertRaisesRegex(host.ClientError,'peer closed'):
                            program.run_model_with_frames(client,command,cwd=self.root,env={'PATH':os.defpath},
                                request=b'{}',timeout=1)
                    spawn.assert_called_once();ownership.assert_not_called();native.assert_not_called();listing.assert_not_called()

    def test_keepalive_socket_failures_stop_owned_model_without_reconnect_or_input(self):
        for mode in ('eof','timeout','wrong_surface','malformed'):
            with self.subTest(mode=mode):
                client=self.model_socket_fixture(mode);popen=host.subprocess.Popen;children=[]
                def spawn(*args,**kwargs):
                    p=popen(*args,**kwargs);children.append(p);return p
                with patch.object(program,'MODEL_KEEPALIVE_INTERVAL_S',0.03), \
                     patch.object(host.subprocess,'Popen',side_effect=spawn), \
                     patch.object(client.active,'connect') as reconnect,patch.object(host.tools,'propose') as submit:
                    with self.assertRaises((host.ClientError,host.tools.ToolValidationError,host.subprocess.TimeoutExpired)):
                        program.run_model_with_frames(client,[sys.executable,'-c','import time;time.sleep(5)'],
                            cwd=self.root,env={'PATH':os.defpath},request=b'{}',timeout=0.4,
                            keepalive=self.b.keepalive_observe)
                    self.assertEqual(len(children),1);self.assertIsNotNone(children[0].returncode)
                    reconnect.assert_not_called();submit.assert_not_called()

    def test_aged_socket_gets_immediate_keepalive_before_original_idle_expiry(self):
        client=self.model_socket_fixture('ok')
        ready_until=time.monotonic()+1
        while not client.drain_frames(timeout_ms=100):
            self.assertLess(time.monotonic(),ready_until)
            time.sleep(0.005)
        time.sleep(0.1) # Core idle ceiling is 0.18; delayed +0.12 would lose it.
        with patch.object(program,'MODEL_KEEPALIVE_INTERVAL_S',0.12):
            result=program.run_model_with_frames(client,[sys.executable,'-c',
                'import sys,time;sys.stdin.read();time.sleep(0.24);print("{}");'],
                cwd=self.root,env={'PATH':os.defpath},request=b'{}',timeout=1,
                keepalive=self.b.keepalive_observe)
        self.assertEqual(result.returncode,0)

    def test_initial_keepalive_failure_prevents_provider_request_delivery(self):
        client=Mock();children=[];request_writes=[]
        popen=host.subprocess.Popen;write=os.write
        def spawn(*args,**kwargs):
            child=popen(*args,**kwargs);children.append(child);return child
        def traced_write(fd,data):
            if children and fd==children[0].stdin.fileno():request_writes.append(bytes(data))
            return write(fd,data)
        heartbeat=Mock(side_effect=host.ClientError('socket','initial observation failed'))
        with patch.object(host.subprocess,'Popen',side_effect=spawn), \
             patch.object(program.os,'write',side_effect=traced_write):
            with self.assertRaisesRegex(host.ClientError,'initial observation failed'):
                program.run_model_with_frames(client,[sys.executable,'-c',
                    'import sys;sys.stdin.read();print("{}");'],cwd=self.root,
                    env={'PATH':os.defpath},request=b'not-delivered',timeout=1,keepalive=heartbeat)
        heartbeat.assert_called_once();client.drain_frames.assert_not_called()
        self.assertEqual(len(children),1);self.assertIsNotNone(children[0].returncode)
        self.assertEqual(request_writes,[])

    def test_continuous_slow_frame_drain_services_keepalive_inside_batch(self):
        client=Mock();calls=[]
        def drain(**kwargs):time.sleep(0.01);return True
        client.drain_frames.side_effect=drain
        start=time.monotonic()
        def heartbeat(timeout_ms):calls.append((time.monotonic()-start,timeout_ms))
        with patch.object(program,'MODEL_KEEPALIVE_INTERVAL_S',0.02):
            result=program.run_model_with_frames(client,[sys.executable,'-c','print("{}");'],
                cwd=self.root,env={'PATH':os.defpath},request=b'{}',timeout=1,keepalive=heartbeat)
        self.assertEqual(result.returncode,0);self.assertGreater(len(calls),2)
        self.assertLess(calls[0][0],0.1)
        self.assertTrue(all(0<budget<=program.MODEL_KEEPALIVE_RPC_MS for _,budget in calls))

    def test_keepalive_deadline_is_not_reset(self):
        client=self.model_socket_fixture('ok')
        with patch.object(program,'MODEL_KEEPALIVE_INTERVAL_S',0.02):
            with self.assertRaises(host.subprocess.TimeoutExpired):
                program.run_model_with_frames(client,[sys.executable,'-c','import time;time.sleep(5)'],
                    cwd=self.root,env={'PATH':os.defpath},request=b'{}',timeout=0.15,
                    keepalive=self.b.keepalive_observe)
    def test_midmodel_control_revocation_still_blocks_original_target_proposal(self):
        client=self.model_socket_fixture('ok');sensed=dict(frame=frame(),table=element_table())
        original=copy.deepcopy(sensed);revoked=[False]
        def heartbeat(timeout_ms):
            value=self.b.keepalive_observe(timeout_ms);revoked[0]=True;return value
        def ownership():
            if revoked[0]:raise host.OwnerRefused('MW_PROGRAM_CONTROL')
        with patch.object(program,'MODEL_KEEPALIVE_INTERVAL_S',0.02), \
             patch.object(self.b,'ownership',side_effect=ownership) as own, \
             patch.object(host.tools,'propose') as submit:
            result=program.run_model_with_frames(client,[sys.executable,'-c',
                'import sys,time;sys.stdin.read();time.sleep(0.12);print("{}");'],
                cwd=self.root,env={'PATH':os.defpath},request=b'{}',timeout=1,keepalive=heartbeat)
            self.assertEqual(result.returncode,0);self.assertTrue(revoked[0]);own.assert_not_called()
            self.assertEqual(sensed,original)
            with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_CONTROL'):
                self.b.propose(sensed,planner_reply(),1000)
            submit.assert_not_called();own.assert_called_once()

    def test_muse_bridge_heartbeat_is_diagnostic_not_new_model_observation(self):
        from metaviewer_agents.perception.base import Frame
        from metaviewer_agents.perception.vcore import _png_bytes
        current=self.publication();path=Path(current['ramws_path'])
        raw=b'x'*(100*80*3);path.write_bytes(raw)
        current['sha256']=host.hashlib.sha256(raw).hexdigest()
        model_space=tempfile.TemporaryDirectory(dir='/dev/shm/vqa-cu');self.addCleanup(model_space.cleanup)
        marks=Path(model_space.name)/'marks.png';marks.write_bytes(_png_bytes(Frame(100,80,raw)));marks.chmod(0o600)
        table=element_table();table['frame_sha256']=current['sha256']
        c2=dict(schema='ve.cu_describe/v1',frame_sha256=current['sha256'],width=100,height=80,
            changed=None,changed_regions=[],crops=[],timing_us=1,marks_png=str(marks),
            marks=[dict(id=1,x=10,y=20,w=30,h=20,kind='button',score=0.9,ocr_text='Covered square')])
        record=dict(frame=copy.deepcopy(current),frame_witness=dict(artifact=str(path)),c2=c2)
        self.b.program_observations=[record];self.b.wender=self.root
        observed=dict(frame_ref=copy.deepcopy(current));before=copy.deepcopy(observed)
        future=dict(current,generation=2)
        custody=Mock(battery_state_sha256='d'*64);reply=planner_reply()
        custody.plan_step.return_value=tuple(reply[k] for k in ('action','expectation','state','target_node'))
        planner=program.MuseProgramPlanner(self.b,custody,1000)
        decision=dict(c3=dict(schema='cu.action/v1',action=dict(kind='click',mark_id=1,x=25,y=30),
            confidence=0.9,expectation=dict(kind='state_change'),need_reasoning=False,observation='synthetic'),
            model_metadata={})
        def helper(*args,**kwargs):
            kwargs['keepalive'](20)
            return SimpleNamespace(returncode=0,stdout=json.dumps(decision).encode())
        with patch.object(self.b,'keepalive_observe',return_value=dict(frame_ref=future)) as heartbeat, \
             patch.object(program,'run_model_with_frames',side_effect=helper):
            planner.plan_step(observed,table,'Covered square')
        heartbeat.assert_called_once_with(20)
        self.assertEqual(observed,before);self.assertEqual(record['frame'],current)
        self.assertEqual(record['keepalive_frame'],future)
        self.assertEqual(custody.plan_step.call_args.args[0],before)

    def test_expired_program_budget_stops_before_observation_and_dispatch(self):
        self.b.run_deadline_ns = time.monotonic_ns() - 1
        with patch.object(self.b,'observe') as observe, patch.object(self.b,'propose') as submit:
            with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_DEADLINE'):
                program.run_moves(self.b,Mock(),'Covered square',1,1000)
        observe.assert_not_called()
        submit.assert_not_called()

    def test_exact_proposal_journal_failure_prevents_core_dispatch(self):
        reply = planner_reply()
        planner = Mock(battery_state_sha256='d' * 64)
        planner.plan_step.return_value = tuple(reply[k] for k in ('action','expectation','state','target_node'))
        sensed = dict(frame=frame(),observation={},table=element_table())
        self.b.surface_id='surface-alice'
        write = program.atomic_journal
        def fail_dispatch(path,value):
            if path.name.startswith('dispatch-'): raise OSError('journal unavailable')
            return write(path,value)
        with patch.object(self.b,'ownership'), patch.object(self.b,'observe',return_value={}), \
             patch.object(self.b,'perceive',return_value=sensed), patch.object(self.b,'rebind',return_value=sensed), \
             patch.object(program,'atomic_journal',side_effect=fail_dispatch), \
             patch.object(host.tools,'propose') as submit:
            with self.assertRaises(OSError):
                program.run_moves(self.b,planner,'Covered square',1,1000)
        submit.assert_not_called()
        self.assertEqual(self.b.program_attempts[-1]['status'],'refused_before_dispatch')

    def test_delivered_moves_with_missing_output_return_input_uncertain(self):
        self.b.program_moves = [dict(status='verified_move')]
        self.b.observe = Mock(return_value=dict(frame_ref=frame()))
        self.b.wender = self.root
        client = self.b.client
        client._ready = True
        client._frame_subscriptions = {'surface-alice'}
        client.wait_frame.return_value = frame(2)
        args = SimpleNamespace(surface_kind='program',identity='alice',goal='Covered square',steps=1,
            timeout_ms=1000,planner='rules',model_timeout_ms=120000)
        write = host.ReplayOwner.write
        def fail_moves(path, raw):
            if path.name == 'moves.json': raise OSError('output unavailable')
            return write(path,raw)
        with patch.dict(host.os.environ,{'XDG_STATE_HOME':str(self.root)}), \
             patch.object(host,'connect',return_value=contextlib.nullcontext(client)), \
             patch.object(program,'ProgramBackend',return_value=self.b), \
             patch.object(program,'VCorePerceptionAdapter'), patch.object(program,'WenderSubprocessAdapter'), \
             patch.object(program,'run_moves',return_value=self.b.program_moves), \
             patch.object(host.ReplayOwner,'write',side_effect=fail_moves), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(program.run_entry(args),5)

    def test_program_evidence_refuses_disk_symlinks_and_public_mode_before_connect(self):
        args = SimpleNamespace(identity='alice',goal='mark-11',steps=1,timeout_ms=1000,
            planner='rules',model_timeout_ms=120000)
        with tempfile.TemporaryDirectory() as disk:
            with patch.dict(host.os.environ,{'XDG_STATE_HOME':disk}), patch.object(host,'connect') as connect, \
                 contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(program.run_entry(args),6)
            connect.assert_not_called()
        link = self.root / 'alias'
        link.symlink_to(self.root,target_is_directory=True)
        with patch.dict(host.os.environ,{'XDG_STATE_HOME':str(link)}), self.assertRaises(host.OwnerRefused):
            program.private_evidence_base()
        self.root.chmod(0o775)
        try:
            with patch.dict(host.os.environ,{'XDG_STATE_HOME':str(self.root)}), self.assertRaises(host.OwnerRefused):
                program.private_evidence_base()
        finally:
            self.root.chmod(0o700)

    def test_public_entry_accepts_program_and_preserves_browser(self):
        run = Mock(return_value=0)
        self.assertEqual(mw_run.main(['--identity', 'alice', '--surface-kind', 'program',
            '--goal', 'Reveal a square', '--steps', '3'], runner=run), 0)
        self.assertEqual(run.call_args.args[0].surface_kind, 'program')
        self.assertIsNone(run.call_args.args[0].site)
        self.assertEqual(mw_run.main(['--identity', 'alice', '--site', 'example',
                                     '--workflow', 'read'], runner=run), 0)
        self.assertEqual(run.call_args.args[0].surface_kind, 'browser')

    def test_public_entry_refuses_ambiguous_or_invalid_modes_before_connect(self):
        for tail in (['--surface-kind', 'vm'], ['--surface-kind', 'program'],
                     ['--surface-kind', 'program', '--goal', 'play', '--site', 'example'],
                     ['--surface-kind', 'program', '--goal', 'play', '--steps', '0'],
                     ['--site', 'example'], ['--site', 'example', '--workflow', 'read', '--goal', 'play']):
            run = Mock()
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                mw_run.main(['--identity', 'alice', *tail], runner=run)
            run.assert_not_called()

    def test_backend_program_dispatch_skips_memoryweb_home(self):
        entry = Mock(return_value=6)
        args = SimpleNamespace(surface_kind='program')
        with patch.object(host, 'module', return_value=SimpleNamespace(run_entry=entry)), \
             patch.object(host, 'admit_home', side_effect=AssertionError('browser corpus used')):
            self.assertEqual(host.run_entry(args), 6)
        entry.assert_called_once_with(args)

    def test_surface_effect_accepts_display_but_refuses_unchanged_mines_and_clock_only(self):
        self.b.retain=Mock(side_effect=self.retained_rgb)
        before = self.rgb_frame(1)
        unchanged = dict(before, generation=2)
        table = element_table()
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_NO_VISIBLE_EFFECT'):
            program.visible_effect(self.b, before, unchanged, table)
        effect = self.changed_frame(before, 2)
        program.visible_effect(self.b, before, effect, table)
        table['elements'].append(dict(role='text', name='12:34', score_ppm=900000,
                                      bbox=dict(x=55,y=55,w=20,h=20)))
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_NO_VISIBLE_EFFECT'):
            program.visible_effect(self.b, before, effect, table)
        # Display changed outside the excluded clock still proves the click.
        raw=bytearray(Path(effect['ramws_path']).read_bytes());raw[100*40*3] ^= 1
        Path(effect['ramws_path']).write_bytes(raw)
        effect['sha256']=host.hashlib.sha256(raw).hexdigest()
        program.visible_effect(self.b, before, effect, table)
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_FRAME_BINDING'):
            program.visible_effect(self.b, before, dict(effect,sha256='0'*64), table)

    def test_dispatch_retention_survives_baseline_publication_release(self):
        before=self.rgb_frame(1);after=self.changed_frame(before,2)
        retained=self.root/'retained.rgb'
        retained.write_bytes(Path(before['ramws_path']).read_bytes())
        Path(before['ramws_path']).unlink()
        self.b.retain=Mock(side_effect=self.retained_rgb)
        program.visible_effect(self.b,before,after,element_table(),
                               before_witness=dict(artifact=str(retained)))
        self.b.retain.assert_called_once_with(after)

    def test_false_positive_core_receipt_never_certifies_an_unchanged_click(self):
        old,fresh,planner=self.pixel_rebind_fixture()
        def settle(pid,*args,**kwargs):
            return dict(schema='action_receipt/v0.2',proposal_id=pid,executed_at_ns=2,
                after_frame=dict(fresh,generation=3),verified=True,
                verification=dict(method='pixel',detail='changed'),error='',
                native_evidence=dict(surface_id='surface-alice',input_mono_ns=1,input_ts_ns=1))
        with patch.object(self.b,'ownership'),patch.object(self.b,'check_program_frame'), \
             patch.object(host.tools,'propose',return_value=dict(status='admitted')) as submit, \
             patch.object(host.tools,'wait_verify',side_effect=settle):
            with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_NO_VISIBLE_EFFECT'):
                program.run_moves(self.b,planner,'Covered square',1,1000)
        submit.assert_called_once()
        self.assertEqual(submit.call_args.args[0]['expectation'],
                         dict(type='changed_region',bbox=dict(x=0,y=0,w=100,h=80)))
        self.assertEqual(self.b.program_moves,[])
        self.assertEqual(self.b.program_attempts[-1]['status'],'input_uncertain')
        self.assertEqual(self.b.program_attempts[-1]['core_verification']['after_frame']['generation'],3)

    def text_fixture(self, readback='hello', focus=True):
        self.b.surface_id='surface-alice'
        frames=[self.rgb_frame(1),self.rgb_frame(2,121),self.rgb_frame(3,122)]
        current=[0];order=[];submitted={}
        self.b.observe=Mock(side_effect=lambda _:dict(frame_ref=frames[current[0]]))
        self.b.retain=Mock(side_effect=self.retained_rgb)
        reply=planner_reply();reply['target_node'].update(role='field',name='Message')
        table=element_table();table['elements'][0].update(role='field',name='Message')
        def perceive(observed, **kwargs):
            f=observed['frame_ref'];t=dict(table,frame_sha256=f['sha256'])
            return dict(frame=f,frame_witness=self.retained_rgb(f),table=t,
                        observation=program.build_observation(f,surface_id=self.b.surface_id,generation=f['generation']))
        self.b.perceive=Mock(side_effect=perceive)
        planner=Mock(battery_state_sha256='d'*64)
        planner.plan_step.return_value=tuple(reply[k] for k in ('action','expectation','state','target_node'))
        def submit(proposal,**kwargs):
            order.append(proposal['action']['type']);submitted[proposal['proposal_id']]=copy.deepcopy(proposal)
            current[0]+=1;order.append('publish')
            return dict(status='admitted')
        def settle(pid,*args,**kwargs):
            return host.tools._VerifiedReceipt(dict(schema='action_receipt/v0.2',proposal_id=pid,executed_at_ns=2,
                after_frame=frames[current[0]],verified=True,verification=dict(method='pixel',detail='changed'),
                error='',
                native_evidence=dict(surface_id='surface-alice',input_mono_ns=1,input_ts_ns=1)),
                focus_verified=focus,input_mono_ns=1,frame_sha256=frames[current[0]]['sha256'])
        marks=[] if readback is None else [dict(x=10,y=20,w=30,h=20,ocr_text=readback)]
        self.b.vision=Mock(last_c2_payload=dict(marks=marks))
        return planner,submit,settle,order,submitted

    def test_text_core_order_and_ocr_exact_unreadable_mismatch(self):
        for ocr, expected in (('hello','exact'),(None,'not_readable'),('wrong','mismatch')):
            with self.subTest(ocr=ocr):
                self.b.pending={}
                planner,submit,settle,order,submitted=self.text_fixture(ocr)
                with patch.object(self.b,'ownership'),patch.object(self.b,'check_program_frame'), \
                     patch.object(host.tools,'propose',side_effect=submit), \
                     patch.object(host.tools,'wait_verify',side_effect=settle):
                    if expected=='mismatch':
                        with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_TEXT_MISMATCH'):
                            program.run_moves(self.b,planner,'Message',1,1000,text='hello')
                    else:
                        program.run_moves(self.b,planner,'Message',1,1000,text='hello')
                        self.assertEqual(self.b.program_moves[-1]['status'],
                                         'verified_text' if ocr else 'uncertified_text')
                self.assertEqual(order,['click','publish','type','publish'])
                self.assertEqual(self.b.text_readback,expected)
                self.assertEqual([p['action']['type'] for p in submitted.values()],['click','type'])
                self.b.vision.perceive.assert_called_once()
                self.assertEqual(self.b.vision.perceive.call_args.args[0]['generation'],3)

    def test_focused_text_one_admission_without_planner_and_ocr_verdicts(self):
        for ocr, expected in (('hello', 'exact'), (None, 'not_readable'), ('wrong', 'mismatch')):
            with self.subTest(ocr=ocr):
                self.b.pending = {}
                planner, submit, settle, order, submitted = self.text_fixture(ocr)
                perceive = self.b.perceive.side_effect
                def empty(observed, **kwargs):
                    self.assertTrue(kwargs['allow_empty'])
                    sensed = perceive(observed)
                    sensed['table']['elements'] = []
                    return sensed
                self.b.perceive.side_effect = empty
                with patch.object(self.b, 'ownership'), patch.object(self.b, 'check_program_frame'), \
                     patch.object(host.tools, 'propose', side_effect=submit), \
                     patch.object(host.tools, 'wait_verify', side_effect=settle):
                    if expected == 'mismatch':
                        with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_TEXT_MISMATCH'):
                            program.run_moves(self.b, planner, 'focused', 1, 1000, text='hello')
                        self.assertEqual(self.b.program_moves, [])
                    else:
                        moves = program.run_moves(self.b, planner, 'focused', 1, 1000, text='hello')
                        self.assertEqual(len(moves), 1)
                        self.assertEqual(moves[0]['status'], 'verified_text' if ocr else 'uncertified_text')
                planner.plan_step.assert_not_called()
                self.assertEqual(order, ['type', 'publish'])
                self.assertEqual(len(submitted), 1)
                self.assertEqual(self.b.text_readback, expected)
                self.assertEqual(self.b.vision.perceive.call_args.args[0]['generation'], 2)

    def test_focused_ticks_drain_stale_retry_and_clean_exhaustion(self):
        for refuse_all in (False, True):
            with self.subTest(refuse_all=refuse_all):
                self.b.pending = {}; self.b.frame_attempts = []
                planner, _, _, _, _ = self.text_fixture('hello|')
                client = Mock(spec=host.ToolClient); client._frames = {}
                self.b.client = client
                fresh = self.rgb_frame(4, 123)
                later = self.rgb_frame(6, 124)
                latest = self.rgb_frame(8, 125)
                after = self.rgb_frame(9, 126)
                queue = [fresh, None, later, None, latest, None]
                def drain(**kwargs):
                    value = queue.pop(0)
                    if value is None:
                        return False
                    client._frames[self.b.surface_id] = value
                    return True
                client.drain_frames.side_effect = drain
                submitted = []
                def submit(proposal, **kwargs):
                    submitted.append(proposal['based_on_frame'])
                    self.assertEqual(proposal['action'], dict(type='type', text='hello'))
                    self.assertEqual(proposal['based_on_frame'],
                                     {k: client._frames[self.b.surface_id][k] for k in ('sha256', 'generation')})
                    # Publications advance while the core processes this call.
                    client._frames[self.b.surface_id] = later if len(submitted) == 1 else latest
                    if refuse_all or len(submitted) == 1:
                        raise host.tools.ToolRefusal('STALE_FRAME', None)
                    return dict(status='admitted')
                def settle(pid, *args, **kwargs):
                    return dict(schema='action_receipt/v0.2', proposal_id=pid, executed_at_ns=2,
                        after_frame=after, verified=True, verification=dict(method='pixel', detail='changed'),
                        error='', native_evidence=dict(surface_id=self.b.surface_id, input_mono_ns=1, input_ts_ns=1))
                with patch.object(self.b, 'ownership'), patch.object(self.b, 'check_program_frame'), \
                     patch.object(program, 'wait_for_publication') as publication, \
                     patch.object(host.tools, 'propose', side_effect=submit), \
                     patch.object(host.tools, 'wait_verify', side_effect=settle) as receipt:
                    if refuse_all:
                        with self.assertRaises(host.tools.ToolRefusal):
                            program.run_moves(self.b, planner, 'focused', 1, 1000, text='hello')
                        self.assertEqual(len(submitted), 3)
                        self.assertEqual(self.b.program_attempts[-1]['status'], 'refused_before_execution')
                        self.assertTrue(self.b.program_clean_refusal)
                        self.assertEqual(self.b.program_moves, [])
                        self.assertEqual(self.b.pending, {})
                        receipt.assert_not_called()
                        self.b.vision.perceive.assert_not_called()
                    else:
                        program.run_moves(self.b, planner, 'focused', 1, 1000, text='hello')
                        self.assertEqual([p['generation'] for p in submitted], [4, 6])
                        self.assertEqual(self.b.text_readback, 'exact')
                        self.b.vision.perceive.assert_called_once_with(after)
                    self.b.perceive.assert_called_once()
                    planner.plan_step.assert_not_called()
                    publication.assert_not_called()
                    client.subscribe_frames.assert_not_called()

    def test_focused_readback_changed_box_and_caret_without_unrelated_labels(self):
        planner, submit, settle, _, _ = self.text_fixture()
        before = self.b.observe(1000)['frame_ref']
        raw = bytearray(Path(before['ramws_path']).read_bytes())
        for y in range(20, 40):
            for x in range(10, 40):
                raw[(y * 100 + x) * 3] ^= 1
        path = self.root / 'text-effect.rgb'; path.write_bytes(raw)
        after = dict(before, generation=2, ramws_path=str(path), sha256=host.hashlib.sha256(raw).hexdigest())
        def receipt(pid, *args, **kwargs):
            result = settle(pid, *args, **kwargs)
            result['after_frame'] = after
            return result
        self.b.vision.last_c2_payload = dict(marks=[
            dict(x=10, y=20, w=25, h=20, ocr_text='hello'),
            dict(x=36, y=20, w=1, h=20, ocr_text='|'),
            dict(x=60, y=60, w=30, h=10, ocr_text='File')])
        with patch.object(self.b, 'ownership'), patch.object(self.b, 'check_program_frame'), \
             patch.object(host.tools, 'propose', side_effect=submit), \
             patch.object(host.tools, 'wait_verify', side_effect=receipt):
            program.run_moves(self.b, planner, 'focused', 1, 1000, text='hello')
        self.assertEqual(self.b.program_attempts[-1]['readback_box'], [10, 20, 30, 20])
        self.assertEqual(self.b.text_readback, 'exact')
        for observed in ('Hello|', 'hell|', 'hello||', 'hello world|'):
            with self.subTest(observed=observed):
                self.assertEqual(program.classify_text_readback(dict(marks=[
                    dict(x=10, y=20, w=25, h=20, ocr_text=observed)]),
                    dict(box=[10, 20, 30, 20]), 'hello', caret=True), 'mismatch')

    def test_pixel_readback_overrides_missing_or_misleading_marks(self):
        for observed, expected in (('hello', 'exact'), ('wrong', 'mismatch'), ('', 'not_readable')):
            with self.subTest(observed=observed):
                self.b.pending = {}
                planner, submit, settle, _, _ = self.text_fixture('hello')
                pixels = dict(marks=[dict(x=0, y=0, w=100, h=80, ocr_text=observed)])
                with patch.object(self.b, 'ownership'), patch.object(self.b, 'check_program_frame'), \
                     patch.object(host.tools, 'propose', side_effect=submit), \
                     patch.object(host.tools, 'wait_verify', side_effect=settle), \
                     patch.object(program, 'read_text_pixels', return_value=pixels) as reader:
                    if expected == 'mismatch':
                        with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_TEXT_MISMATCH'):
                            program.run_moves(self.b, planner, 'focused', 1, 1000, text='hello')
                    else:
                        program.run_moves(self.b, planner, 'focused', 1, 1000, text='hello')
                    self.assertEqual(self.b.text_readback, expected)
                    self.assertEqual(self.b.program_attempts[-1]['readback_source'], 'pixels_tsv')
                    reader.assert_called_once()

    @unittest.skipUnless(os.environ.get('VQA_VE_ROOT'), 'vision checkout not configured')
    def test_rendered_text_pixels_without_marks_and_wrong_text_control(self):
        from PIL import Image, ImageDraw, ImageFont
        from metaviewer_agents.perception.vcore import _scrubbed_env
        root = Path(os.environ['VQA_VE_ROOT']).resolve()
        self.b.vision = SimpleNamespace(ve_root=root, python=sys.executable, timeout=5,
                                       _child_env=lambda: _scrubbed_env(root))
        self.b.retain = Mock(side_effect=self.retained_rgb)
        for text in ('HOLA DESDE METAVIEWER',
                     'hello world this is a rendered text fixture with more than sixty four bytes of text'):
            with self.subTest(text=text):
                image = Image.new('RGB', (1600, 160), 'white')
                draw = ImageDraw.Draw(image)
                font = ImageFont.load_default(size=26)
                draw.text((50, 55), text, font=font, fill='black')
                draw.text((50, 5), 'File unrelated label', font=font, fill='black')
                left, top, right, bottom = draw.textbbox((50, 55), text, font=font)
                target = dict(box=[left, top, right-left, bottom-top])
                raw = image.tobytes()
                path = self.root / 'rendered.rgb'
                path.write_bytes(raw)
                f = dict(frame(), width=image.width, height=image.height,
                         ramws_path=str(path), sha256=host.hashlib.sha256(raw).hexdigest())
                pixels = program.read_text_pixels(self.b, f, target, 5000)
                self.assertIsNotNone(pixels, 'configured vision OCR must be available')
                self.assertEqual(program.classify_text_readback(pixels, target, text), 'exact')
                self.assertEqual(program.classify_text_readback(pixels, target, 'wrong'), 'mismatch')
                self.assertEqual(program.classify_text_readback(pixels, target, text.upper() + '!'), 'mismatch')
        blank = Image.new('RGB', image.size, 'white').tobytes()
        path.write_bytes(blank)
        f['sha256'] = host.hashlib.sha256(blank).hexdigest()
        pixels = program.read_text_pixels(self.b, f, target, 5000)
        self.assertIsNotNone(pixels)
        self.assertEqual(program.classify_text_readback(pixels, target, text), 'not_readable')

    def test_pixel_reader_bounds_and_unavailable_diagnostics(self):
        self.b.vision = SimpleNamespace(ve_root=self.root, python=sys.executable,
                                       timeout=5, _child_env=lambda: {})
        self.b.retain = Mock(side_effect=self.retained_rgb)
        self.b.active_attempt = {}
        f = self.rgb_frame(1)
        target = dict(box=[10, 20, 30, 20])
        long_text = 'x' * 80
        for payload in (dict(ok=True, reason=None, text=long_text),
                        dict(ok=True, reason=None, text=''),
                        dict(ok=False, reason='tessdata_absent', text='')):
            with self.subTest(payload=payload), patch(
                    'metaviewer_agents.perception.vcore._run_bounded',
                    return_value=SimpleNamespace(returncode=0, stdout=json.dumps(payload).encode())) as run:
                pixels = program.read_text_pixels(self.b, f, target, 1000)
                self.assertEqual(run.call_args.kwargs['timeout'], 1)
                self.assertEqual(json.loads(run.call_args.args[0][-1])[4], target['box'])
                if payload['ok']:
                    self.assertEqual(pixels['marks'][0]['ocr_text'], payload['text'])
                else:
                    self.assertIsNone(pixels)
                    self.assertEqual(self.b.active_attempt['readback_ocr_reason'], 'tessdata_absent')
        corrupted = dict(f, sha256='0' * 64)
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_FRAME_BINDING'):
            program.read_text_pixels(self.b, corrupted, target, 1000)

    def test_focused_stale_exhaustion_entry_is_clean_refusal(self):
        self.text_fixture()
        args = SimpleNamespace(identity='alice', goal='focused', text='hello', steps=1,
            timeout_ms=1000, planner='rules', model_timeout_ms=120000)
        with patch.dict(host.os.environ, {'XDG_STATE_HOME': str(self.root)}), \
             patch.object(host, 'connect', return_value=contextlib.nullcontext(self.b.client)), \
             patch.object(program, 'ProgramBackend', return_value=self.b), \
             patch.object(program, 'VCorePerceptionAdapter', return_value=self.b.vision), \
             patch.object(self.b, 'ownership'), patch.object(self.b, 'check_program_frame'), \
             patch.object(host.tools, 'propose', side_effect=host.tools.ToolRefusal('STALE_FRAME', None)) as submit, \
             patch.object(host.tools, 'wait_verify') as settle, \
             contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(program.run_entry(args), 6)
        result = json.loads(output.getvalue())
        report = json.loads(Path(result['report']).read_text())
        self.assertEqual(result['verdict_code'], 'STALE_FRAME')
        self.assertEqual(report['status'], 'refused')
        self.assertEqual(report['attempts'][0]['status'], 'refused_before_execution')
        self.assertIsNone(report['text_readback'])
        self.assertEqual(report['moves'], [])
        self.assertEqual(submit.call_count, 3)
        settle.assert_not_called()

    def test_focused_rebind_keeps_geometry_surface_generation_and_deadline_gates(self):
        for change in (dict(surface_id='other'), dict(width=101), dict(height=81),
                       dict(generation=0), dict(sha256='b' * 64)):
            with self.subTest(change=change):
                self.text_fixture()
                old = self.b.observe(1000)['frame_ref']
                sensed = self.b.perceive(dict(frame_ref=old))
                self.b.observe.return_value = dict(frame_ref=dict(old, **change))
                self.b.observe.side_effect = None
                with patch.object(host.tools, 'propose') as submit, self.assertRaises(host.OwnerRefused):
                    self.b.rebind(sensed, dict(action=dict(type='type', text='hello'),
                        target=None, focused_text=True), 1000)
                submit.assert_not_called()
        self.text_fixture()
        client = Mock(spec=host.ToolClient); client._frames = {}
        self.b.client = client
        clock = [0]
        def drain(**kwargs):
            clock[0] += 400_000_000
            return True
        client.drain_frames.side_effect = drain
        with patch.object(program.time, 'monotonic_ns', side_effect=lambda: clock[0]), \
             patch.object(self.b, 'ownership'), patch.object(host.tools, 'propose') as submit:
            with self.assertRaisesRegex(host.OwnerRefused, 'MW_STALE_FRAME_EXHAUSTED'):
                program.run_moves(self.b, None, 'focused', 1, 1000, text='hello')
        submit.assert_not_called()
        self.assertEqual(client.drain_frames.call_count, 3)
        self.assertEqual(self.b.program_attempts[-1]['status'], 'refused_before_dispatch')

    def test_focused_unknown_dispatch_outcome_stays_uncertain_without_retry(self):
        planner, _, _, _, _ = self.text_fixture()
        with patch.object(self.b, 'ownership'), \
             patch.object(host.tools, 'propose', side_effect=TimeoutError('core reply lost')) as submit, \
             patch.object(host.tools, 'wait_verify') as settle:
            with self.assertRaisesRegex(TimeoutError, 'core reply lost'):
                program.run_moves(self.b, planner, 'focused', 1, 1000, text='hello')
        self.assertEqual(self.b.program_attempts[-1]['status'], 'input_uncertain')
        self.assertFalse(self.b.program_clean_refusal)
        submit.assert_called_once()
        settle.assert_not_called()

    def test_focused_text_known_password_refuses_without_admission(self):
        for change in (dict(name='Password'), dict(role='password'),
                       dict(states=dict(secret=True)), dict(states=dict(type='password'))):
            with self.subTest(change=change):
                planner, submit, settle, order, _ = self.text_fixture()
                perceive = self.b.perceive.side_effect
                def password(observed, **kwargs):
                    sensed = perceive(observed)
                    sensed['table']['elements'][0].update(change)
                    return sensed
                self.b.perceive.side_effect = password
                with patch.object(host.tools, 'propose') as core:
                    with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_PASSWORD'):
                        program.run_moves(self.b, planner, 'focused', 1, 1000, text='hello')
                core.assert_not_called()
                planner.plan_step.assert_not_called()

    def test_focused_request_guards_and_empty_perception(self):
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_FOCUSED_TEXT_REQUIRED'):
            program.run_moves(self.b, Mock(), 'focused', 1, 1000)
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_TEXT_STEPS'):
            program.run_moves(self.b, Mock(), 'focused', 2, 1000, text='hello')
        self.b.surface_id = 'surface-alice'
        self.b.vision = Mock(last_c2_payload=dict(marks=[]), diagnostics={})
        self.b.vision.last_vserve_error = self.b.vision.last_fallback_error = None
        with patch.object(self.b, 'check_program_frame'), \
             patch.object(self.b, 'retain', return_value={}), \
             patch.object(program, 'project_element_table', return_value=dict(elements=[])), \
             patch.object(program, 'build_observation', return_value={}):
            observed = dict(frame_ref=frame())
            self.assertEqual(self.b.perceive(observed, allow_empty=True)['table']['elements'], [])
            with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_UNKNOWN_OBSERVATION'):
                self.b.perceive(observed)

    def test_text_requires_verified_focus_and_refuses_known_password_before_click(self):
        planner,submit,settle,order,_=self.text_fixture(focus=False)
        with patch.object(self.b,'ownership'),patch.object(self.b,'check_program_frame'), \
             patch.object(host.tools,'propose',side_effect=submit), \
             patch.object(host.tools,'wait_verify',side_effect=settle):
            with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_FOCUS_UNVERIFIED'):
                program.run_moves(self.b,planner,'Message',1,1000,text='hello')
        self.assertEqual(order,['click','publish'])
        for change in (dict(name='Password'),dict(role='password'),dict(states=dict(protected=True)),
                       dict(states=dict(type='password'))):
            with self.subTest(change=change):
                planner,submit,settle,order,_=self.text_fixture()
                action,expectation,state,target=planner.plan_step.return_value
                target.update(change)
                table=element_table();table['elements'][0].update(role=target['role'],name=target['name'])
                old=self.b.perceive.side_effect
                self.b.perceive.side_effect=lambda obs:dict(old(obs),table=table)
                with patch.object(host.tools,'propose',side_effect=submit) as core:
                    with self.assertRaisesRegex(host.OwnerRefused,'MW_PROGRAM_PASSWORD'):
                        program.run_moves(self.b,planner,target['name'],1,1000,text='hello')
                core.assert_not_called()

    def test_ocr_confusions_are_uncertified_and_diagnostics_bounded(self):
        target = dict(box=[0, 0, 100, 100])
        cases = [('LHOLA DESDE C3}', 'not_readable'),
                 ('HOLA DESDE C8', 'not_readable'),
                 ('H0LA DESDE C3', 'not_readable'),
                 ('HOLA DESDE C3', 'exact'),
                 ('WRONG INPUT ENTIRELY', 'mismatch'),
                 (' OCTAVA', 'mismatch')]
        for observed, expected in cases:
            with self.subTest(observed=observed):
                payload = dict(marks=[dict(x=0, y=0, w=100, h=100,
                                          ocr_text=observed)])
                self.assertEqual(program.classify_text_readback(payload, target,
                    'HOLA DESDE C3', caret=True, focused_area=True), expected)
                self.assertEqual(program.readback_text(payload, target), observed)
        payload['marks'][0]['ocr_text'] = 'x' * 5000
        self.assertEqual(len(program.readback_text(payload, target)), 4096)

    def test_ocr_readback_ignores_outside_labels_and_never_normalizes_mismatch(self):
        target=dict(box=[10,20,30,20])
        outside=dict(x=60,y=20,w=20,h=20,ocr_text='hello')
        self.assertEqual(program.classify_text_readback(dict(marks=[outside]),target,'hello'),'not_readable')
        inside=dict(x=10,y=20,w=20,h=20,ocr_text='Hello')
        self.assertEqual(program.classify_text_readback(dict(marks=[inside]),target,'hello'),'mismatch')
        status_bar=dict(x=0,y=0,w=10,h=10,ocr_text='hello| Ln 1, Col 6')
        wide=dict(target,box=[0,0,100,100])
        self.assertEqual(program.classify_text_readback(dict(marks=[status_bar]),wide,'hello',caret=True,focused_area=True),'exact')
        self.assertEqual(program.classify_text_readback(dict(marks=[status_bar]),wide,'hello',caret=True),'mismatch')
        self.assertEqual(program.classify_text_readback(dict(marks=[status_bar]),wide,'hell',caret=True,focused_area=True),'mismatch')

    def test_focused_entry_constructs_no_planner_even_when_muse_selected(self):
        self.text_fixture()
        self.b.wender = self.root
        args = SimpleNamespace(identity='alice', goal='focused', text='hello', steps=1,
                               timeout_ms=1000, planner='muse', model_timeout_ms=120000)
        def run(backend, planner, goal, steps, timeout_ms, **kwargs):
            self.assertIsNone(planner)
            self.assertEqual(goal, 'focused')
            self.assertEqual(kwargs, dict(text='hello'))
            return []
        with patch.dict(host.os.environ, {'XDG_STATE_HOME': str(self.root)}), \
             patch.object(host, 'connect', return_value=contextlib.nullcontext(self.b.client)), \
             patch.object(program, 'ProgramBackend', return_value=self.b), \
             patch.object(program, 'VCorePerceptionAdapter'), \
             patch.object(program, 'WenderSubprocessAdapter') as custody, \
             patch.object(program, 'MuseProgramPlanner') as muse, \
             patch.object(program, 'run_moves', side_effect=run), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(program.run_entry(args), 0)
        custody.assert_not_called()
        muse.assert_not_called()

    def test_text_entry_uncertified_verdict_is_explicit_and_mismatch_nonzero(self):
        for readback,rc,code in (('exact',0,'PROGRAM_BOUNDED_ACTIONS_VERIFIED'),
                ('not_readable',0,'PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE'),('mismatch',5,'INPUT_UNCERTAIN')):
            with self.subTest(readback=readback):
                planner,_,_,_,_=self.text_fixture()
                self.b.wender=self.root
                def run(*args,**kwargs):
                    self.b.text_readback=readback
                    self.b.program_moves=[dict(status='verified_move')]
                    self.b.program_attempts=[dict(status='input_uncertain' if rc else 'verified_text')]
                    if rc:raise host.OwnerRefused('MW_PROGRAM_TEXT_MISMATCH')
                    return self.b.program_moves
                args=SimpleNamespace(identity='alice',goal='Message',text='hello',steps=1,timeout_ms=1000,planner='rules',model_timeout_ms=120000)
                with patch.dict(host.os.environ,{'XDG_STATE_HOME':str(self.root)}), \
                     patch.object(host,'connect',return_value=contextlib.nullcontext(self.b.client)), \
                     patch.object(program,'ProgramBackend',return_value=self.b), \
                     patch.object(program,'VCorePerceptionAdapter'),patch.object(program,'WenderSubprocessAdapter'), \
                     patch.object(program,'run_moves',side_effect=run), \
                     contextlib.redirect_stdout(io.StringIO()) as output,contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(program.run_entry(args),rc)
                result=json.loads(output.getvalue());self.assertEqual(result['verdict_code'],code)
                report=json.loads(Path(result['report']).read_text())
                self.assertEqual(report['text_readback'],readback)

    def test_v027_focused_readback_preserves_literal_spacing(self):
        target = dict(box=[0, 0, 100, 100])
        for observed, requested, expected in (
                ('hello', ' hello', 'mismatch'), ('a b', 'a  b', 'mismatch'),
                ('a b', 'a\tb', 'mismatch'), ('hello', 'hello ', 'mismatch'),
                ('hello|', 'hello|', 'exact'), ('hello| Ln 1', 'hello', 'exact'),
                ('hello world| Ln 1', 'hello world', 'exact'),
                ('hello  world| Ln 1', 'hello  world', 'exact')):
            with self.subTest(observed=observed, requested=requested):
                c2 = dict(marks=[dict(x=0, y=0, w=50, h=10, ocr_text=observed)])
                self.assertEqual(program.classify_text_readback(c2, target, requested,
                    caret=True, focused_area=True), expected)

    def test_v027_verified_dispatch_has_resolvable_settlement(self):
        planner, submit, settle, _, _ = self.text_fixture('hello')
        with patch.object(self.b, 'ownership'), patch.object(self.b, 'check_program_frame'), \
             patch.object(host.tools, 'propose', side_effect=submit), \
             patch.object(host.tools, 'wait_verify', side_effect=settle):
            program.run_moves(self.b, planner, 'Message', 1, 1000)
        attempt = self.b.program_attempts[0]
        dispatch = json.loads(Path(attempt['dispatch_artifact']).read_text())
        self.assertEqual(dispatch['record_kind'], 'immutable_pre_dispatch')
        self.assertEqual(dispatch['settlement_artifact'], attempt['receipt_artifact'])
        self.assertEqual(json.loads(Path(dispatch['settlement_artifact']).read_text())['status'], 'verified_move')

    def test_v027_report_omits_ephemeral_marks_after_workspace_cleanup(self):
        self.text_fixture()
        self.b.wender = self.root
        args = SimpleNamespace(identity='alice', goal='Message', steps=1,
                               timeout_ms=1000, planner='muse', model_timeout_ms=1000)
        vision = Mock()
        workspaces = []
        def adapter(**kwargs):
            marks = kwargs['marks_out']
            marks.write_bytes(b'fixture marks')
            workspaces.append(marks)
            self.b.program_observations = [dict(c2=dict(marks_png=str(marks), marks=[]))]
            return vision
        def moves(*args, **kwargs):
            self.assertEqual(workspaces[0].read_bytes(), b'fixture marks')
            self.assertTrue(workspaces[0].parent.is_dir())
            self.assertEqual(self.b.program_observations[0]['c2']['marks_png'], str(workspaces[0]))
            return []
        with patch.dict(host.os.environ, {'XDG_STATE_HOME': str(self.root)}), \
             patch.object(host, 'connect', return_value=contextlib.nullcontext(self.b.client)), \
             patch.object(program, 'ProgramBackend', return_value=self.b), \
             patch.object(program, 'VCorePerceptionAdapter', side_effect=adapter), \
             patch.object(program, 'WenderSubprocessAdapter'), patch.object(program, 'MuseProgramPlanner'), \
             patch.object(program, 'run_moves', side_effect=moves), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(program.run_entry(args), 0)
        self.assertEqual(len(workspaces), 1)
        self.assertFalse(workspaces[0].exists())
        self.assertFalse(workspaces[0].parent.exists())
        self.assertEqual(self.b.program_observations[0]['c2']['marks_png'], str(workspaces[0]))
        result = json.loads(output.getvalue())
        c2 = json.loads(Path(result['report']).read_text())['observations'][0]['c2']
        self.assertNotIn('marks_png', c2)
        self.assertEqual(c2['marks_png_lifetime'], 'ephemeral_workspace_removed')


if __name__ == '__main__':
    unittest.main()
