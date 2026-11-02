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
import time
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
                                              Capsule=dict(container='srf-pg-alice'))))
        self.lease.chmod(0o600)

    def custody(self):
        return patch.multiple(self.b, native=Mock(return_value=dict(profile_id='alice')))

    def own(self, surface=None, active=b'srf-pg-alice\n'):
        with self.custody(), patch.object(host.tools, 'list_surfaces', return_value=dict(
                surfaces=[surface or self.surface], next_cursor=None)), patch.object(
                    host, 'command', return_value=SimpleNamespace(returncode=0, stdout=active)):
            return self.b.ownership()

    def test_program_custody_and_browser_filter_remain_distinct(self):
        self.assertEqual(self.own()['capsules'], ['srf-pg-alice'])
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_RUN_NO_SURFACE'):
            self.own(dict(self.surface, kind='browser'))
        browser = object.__new__(host.HostBackend)
        browser.client, browser.identity = Mock(), 'alice'
        with patch.object(host.tools, 'list_surfaces', return_value=dict(
                surfaces=[self.surface, dict(self.surface, kind='browser')], next_cursor=None)):
            self.assertEqual([s['kind'] for s in browser.surfaces()], ['browser'])

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
        self.b.vision = Mock()
        self.b.vision.diagnostics = dict(last_transport='vserve')
        with patch.object(self.b, 'retain', return_value={}), patch.object(
                program, 'project_element_table', return_value=dict(elements=[])):
            with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_UNKNOWN_OBSERVATION'):
                self.b.perceive(dict(frame_ref=frame()))
        failed = self.b.program_observations[-1]
        self.assertEqual(failed['status'], 'unknown')
        self.assertEqual(failed['table']['elements'], [])
        self.assertEqual(failed['diagnostics']['last_transport'], 'vserve')
        self.assertEqual(failed['error']['code'], 'MW_PROGRAM_UNKNOWN_OBSERVATION')
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_PROGRAM_SURFACE'):
            self.b.perceive(dict(frame_ref=frame(surface='other')))

    def test_moving_pixels_do_not_submit_old_coordinates(self):
        self.b.surface_id = 'surface-alice'
        with patch.object(self.b, 'ownership'), patch.object(host.tools, 'observe', return_value=dict(
                frame_ref=dict(frame(2), sha256='b' * 64))), patch.object(host.tools, 'propose') as submit:
            with self.assertRaisesRegex(host.OwnerRefused, 'MW_STALE_FRAME_EXHAUSTED'):
                self.b.propose(dict(frame=frame()), planner_reply(), 1000)
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
        self.b.retain = Mock(side_effect=lambda f: dict(surface_id=f['surface_id'], generation=f['generation']))
        sensed = dict(frame=frame(), frame_witness={}, observation=program.build_observation(
            frame(), surface_id='surface-alice', generation=1), table=element_table())

        def settlement(proposal_id, *args, **kwargs):
            return dict(schema='action_receipt/v0.2', proposal_id=proposal_id, executed_at_ns=2,
                after_frame=frame(3), verified=True, verification=dict(method='pixel', detail='changed'),
                error='', native_evidence=dict(surface_id='surface-alice', input_mono_ns=1, input_ts_ns=1))

        def accept(proposal, **kwargs):
            journal = self.root / ('dispatch-' + proposal['proposal_id'] + '.json')
            saved = json.loads(journal.read_text())
            self.assertEqual(saved['proposal'], proposal)
            self.assertTrue(Path(saved['intent_artifact']).is_file())
            return dict(status='admitted')

        with patch.object(self.b, 'ownership'), patch.object(self.b, 'observe', return_value=dict(frame_ref=frame(2))), \
             patch.object(self.b, 'perceive', return_value=sensed), \
             patch.object(self.b, 'ax', side_effect=AssertionError('browser AX used')), \
             patch.object(self.b, 'network_context', side_effect=AssertionError('browser network used')), \
             patch.object(host.tools, 'propose', side_effect=accept) as submit, \
             patch.object(host.tools, 'wait_verify', side_effect=settlement) as wait:
            moves = program.run_moves(self.b, planner, 'Covered square', 2, 1000)
        self.assertEqual(len(moves), 2)
        self.assertEqual(submit.call_count, 2)
        self.assertEqual(wait.call_count, 2)
        self.assertEqual(moves[-1]['status'], 'verified_move')
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

    def test_only_explicit_stale_nonexecution_replans_after_new_publication(self):
        sensed = dict(frame=frame(), frame_witness={}, observation={}, table=element_table())
        self.b.observe = Mock(side_effect=[{},dict(frame_ref=frame()),dict(frame_ref=frame(2)),{}])
        self.b.perceive = Mock(side_effect=[sensed, dict(sensed,frame=frame(2))])
        self.b.surface_id = 'surface-alice'
        planner = Mock(battery_state_sha256='d' * 64)
        reply=planner_reply()
        planner.plan_step.return_value = tuple(reply[k] for k in ('action','expectation','state','target_node'))
        self.b.frame_attempts = []
        def submit(*args):
            status = 'STALE_FRAME' if not self.b.frame_attempts else 'admitted'
            self.b.frame_attempts.append(dict(status=status))
            if status == 'STALE_FRAME':
                raise host.tools.ToolRefusal(status, None)
            return {}
        with patch.object(self.b, 'propose', side_effect=submit), patch.object(
                self.b, 'wait_verify', return_value=dict(receipt=dict(after_frame=frame(3)))), \
             patch.object(self.b, 'retain', return_value={}):
            moves = program.run_moves(self.b, planner, 'Covered square', 1, 1000)
        self.assertEqual(len(moves), 1)
        self.assertEqual(planner.plan_step.call_count, 2)
        self.assertEqual(self.b.observe.call_count, 4)
        self.assertEqual(self.b.program_attempts[0]['status'], 'refused_before_execution')

    def test_model_conversion_requires_unique_current_mark_never_raw_coordinates(self):
        c2 = dict(marks=[dict(id=11,x=10,y=20,w=30,h=20,kind='button')])
        table = element_table()
        table['elements'][0]['name'] = 'mark-11'
        c3 = dict(schema='cu.action/v1',action=dict(kind='click',mark_id=11,x=25,y=30))
        self.assertEqual(program.MuseProgramPlanner.selected_name(c3,c2,table), 'mark-11')
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
        refreshed=[False]
        def refresh(*args,**kwargs): refreshed[0]=True
        client.subscribe_frames=Mock(side_effect=refresh)
        self.b.client=client
        self.b.subscription={}
        self.b.surface_id='surface-alice'
        self.b.observe=Mock(side_effect=lambda timeout_ms: dict(frame_ref=frame(9 if refreshed[0] else 8)))
        sensed=dict(frame=frame(8),frame_witness={},observation={},table=element_table())
        self.b.perceive=Mock(return_value=sensed)
        reply=planner_reply()
        planner=Mock(battery_state_sha256='d'*64)
        planner.plan_step.return_value=tuple(reply[k] for k in ('action','expectation','state','target_node'))
        def accept(proposal,**kwargs):
            self.assertEqual(proposal['based_on_frame']['generation'],9)
            return dict(status='admitted')
        def settle(pid,*args,**kwargs):
            return dict(schema='action_receipt/v0.2',proposal_id=pid,executed_at_ns=2,
                after_frame=frame(10),verified=True,verification=dict(method='pixel',detail='changed'),
                error='',native_evidence=dict(surface_id='surface-alice',input_mono_ns=1,input_ts_ns=1))
        with patch.object(self.b,'ownership'),patch.object(self.b,'retain',return_value={}), \
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


if __name__ == '__main__':
    unittest.main()
