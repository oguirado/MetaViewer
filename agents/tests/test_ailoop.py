"""Offline loop and strict adapter negative controls."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents.executor import AdmittedExecutor, SurfaceError, SurfaceRefused
from metaviewer_agents.vision import parse_description, VisionBridgeError, describe
from metaviewer_agents.verify import build_proposal, run_loop


def frame():
    return dict(schema='frame_ref/v0.2', surface_id='fixture', generation=1,
                tick=1, ts_ns=1, width=4, height=4, format='rgb24',
                ramws_path='/dev/shm/fixture', sha256=hashlib.sha256(bytes(48)).hexdigest(),
                capture_us=1)


def proposal():
    return build_proposal(frame(), proposal_id='p1', action={'type': 'click', 'x': 1,
        'y': 1, 'button': 'left'}, expectation={'type': 'changed_region',
        'bbox': {'x': 0, 'y': 0, 'w': 4, 'h': 4}}, max_ms=100, max_retries=0)


def description():
    return dict(schema='ve.cu_describe/v1', frame_sha256=frame()['sha256'],
                width=4, height=4, changed=True, changed_regions=[dict(x=0, y=0,
                w=2, h=2, score=0.8)], crops=[], timing_us=3)


class AdapterTests(unittest.TestCase):
    def test_proposal_contract_and_mutants(self):
        from metaviewer_agents.tools import _check_proposal, ToolValidationError
        _check_proposal(proposal())
        for change in ({'unexpected': 1}, {'schema': 'action_proposal/v0.1'},
                       {'budget': {'max_ms': True, 'max_retries': 0}}):
            p = proposal(); p.update(change)
            with self.assertRaises(ToolValidationError):
                _check_proposal(p)

    def test_executor_admission_and_receipt(self):
        calls = []
        def transport(p):
            calls.append(p)
            return {'focus_verified': True, 'input_mono_ns': 5}
        ex = AdmittedExecutor(transport=transport)
        verdict = dict(schema='action_verdict/v0.2', proposal_id='p1',
                       decision='admitted', core_seq=1)
        self.assertEqual(ex.dispatch(proposal(), verdict)['input_mono_ns'], 5)
        for delta in ({'decision': 'refused'}, {'proposal_id': 'other'}, {'core_seq': True}):
            v = dict(verdict); v.update(delta)
            with self.assertRaises((SurfaceRefused, ValueError)):
                ex.dispatch(proposal(), v)
        self.assertEqual(len(calls), 1)
        for receipt in ({'focus_verified': False, 'input_mono_ns': 5},
                        {'focus_verified': 1, 'input_mono_ns': 5},
                        {'focus_verified': True, 'input_mono_ns': True},
                        {'focus_verified': True, 'input_mono_ns': -1},
                        {'focus_verified': True, 'input_mono_ns': '5'}):
            with self.assertRaises(SurfaceError):
                AdmittedExecutor(transport=lambda p: receipt).dispatch(proposal(), verdict)

    def test_target_custody_alignment_and_stop(self):
        target = dict(id='t', name='Go', box=[0, 0, 2, 2])
        ex = AdmittedExecutor(transport=lambda p: {})
        ex.check_target(target, latest=[target], frame=frame())
        for changed, error in ((dict(target, id='other'), ValueError),
                               (dict(target, box=[4, 0, 2, 2]), SurfaceError),
                               (dict(target, name='Detener'), SurfaceRefused)):
            latest = [changed] if error != ValueError else [target]
            with self.assertRaises(error):
                ex.check_target(changed, latest=latest, frame=frame())

    def test_target_custody_pins_name_and_allows_value_drift(self):
        calls = []
        ex = AdmittedExecutor(
            transport=lambda p: (calls.append(p) or {'focus_verified': True, 'input_mono_ns': 7})
        )
        verdict = dict(schema='action_verdict/v0.2', proposal_id='p1',
                       decision='admitted', core_seq=1)
        observed = dict(
            id='btn-1',
            role='button',
            name='Go',
            box=[0, 0, 2, 2],
            bbox={'x': 0, 'y': 0, 'w': 2, 'h': 2},
            value='initial',
        )
        # Control: value changes while id, role, bbox, box, and name stay identical -> custody passes
        latest_value_changed = [dict(observed, value='updated')]
        ex.check_target(observed, latest=latest_value_changed, frame=frame())
        ex.dispatch(proposal(), verdict)
        self.assertEqual(len(calls), 1)

        # Target name changes from "Go" to "Delete" while id, role, and bbox stay identical -> custody refuses before click
        calls.clear()
        latest_name_changed = [dict(observed, name='Delete')]
        with self.assertRaisesRegex(ValueError, 'target custody'):
            ex.check_target(observed, latest=latest_name_changed, frame=frame())
            ex.dispatch(proposal(), verdict)
        self.assertEqual(calls, [])

    def test_vision_golden_and_caps(self):
        self.assertEqual(parse_description(json.dumps(description()))['changed_regions'][0]['score_ppm'], 800000)
        for field, row, cap in [('changed_regions', description()['changed_regions'][0], 16),
                                ('crops', dict(x=0,y=0,w=1,h=1,reason='changed'), 8),
                                ('marks', dict(id=1,x=0,y=0,w=1,h=1,kind='button',score=1),24)]:
            d=description(); d[field]=[row]*(cap+1)
            if field=='marks': d['marks_png']='/dev/shm/vqa-cu/marks.png'
            with self.assertRaises(VisionBridgeError): parse_description(json.dumps(d))

    def test_vision_shape_paths_order_and_refusal(self):
        for delta in ({'width': True}, {'extra': 1}, {'frame_sha256': 'bad'},
                      {'marks': [], 'marks_png': '/tmp/marks.png'},
                      {'changed_regions': [dict(x=0,y=0,w=1,h=1,score=0.1),dict(x=0,y=0,w=1,h=1,score=0.9)]},
                      {'marks': [dict(id=2,x=0,y=0,w=1,h=1,kind='button',score=1)], 'marks_png':'/dev/shm/vqa-cu/m.png'}):
            d=description(); d.update(delta)
            with self.assertRaises(VisionBridgeError): parse_description(json.dumps(d))
        with self.assertRaises(VisionBridgeError): parse_description('{"schema":1,"schema":2}')
        with self.assertRaises(VisionBridgeError): parse_description(' ' * 1048577)
        with self.assertRaises(VisionBridgeError):
            describe(frame(), transport=lambda f: (2, ''))
        with self.assertRaises(VisionBridgeError):
            describe(dict(frame(), sha256='a'*64), transport=lambda f: (0,json.dumps(description())))

    def test_vision_observation_ocr_and_score_rounding(self):
        from metaviewer_agents.vision import describe_observation
        observation = describe_observation(frame(), transport=lambda f: (0,json.dumps(description())))
        self.assertEqual(observation['schema'],'observation/v0.2')
        self.assertEqual(observation['vision']['changed_regions'],[dict(x=0,y=0,w=2,h=2)])
        d=description(); d['marks']=[dict(id=1,x=0,y=0,w=1,h=1,kind='text',score=1,
            ocr_text='Ready',ocr_score_promille=999,visual_kind='textline',missing_reason=None)]
        d['marks_png']='/dev/shm/vqa-cu/m.png'
        self.assertEqual(parse_description(json.dumps(d))['marks'][0]['ocr_text'],'Ready')
        d['marks'][0]['ocr_score_promille']=True
        with self.assertRaises(VisionBridgeError): parse_description(json.dumps(d))
        d=description(); d['changed_regions']=[dict(x=0,y=0,w=1,h=1,score=v) for v in (0.8000001,0.8000002)]
        with self.assertRaises(VisionBridgeError): parse_description(json.dumps(d))

    def test_proposal_fixtures_and_inverted_window(self):
        from metaviewer_agents.tools import _check_proposal, ToolValidationError
        root=Path(__file__).resolve().parents[2]/'contracts/examples/v0.2'
        _check_proposal(json.loads((root/'action_proposal.valid.json').read_text()))
        with self.assertRaises(ToolValidationError):
            _check_proposal(json.loads((root/'action_proposal.invalid.schema.json').read_text()))
        with self.assertRaises(ValueError):
            build_proposal(frame(),proposal_id='p1',action=proposal()['action'],
                expectation=dict(type='state_sha256_change',before='a'*64,min_tick=6,max_tick=5),max_ms=100)

    def test_offline_browser_and_lane_loop_with_core_refusals(self):
        from metaviewer_agents.tools import ToolRefusal, ToolValidationError
        class Core:
            def __init__(self, *, refusal=None, missing=False):
                self.ops=[]; self.refusal=refusal; self.missing=missing
            def request(self, call, schema, *, timeout_ms):
                self.ops.append(call['op'])
                result=dict(schema=schema,request_id=call['request_id'],op=call['op'])
                if call['op']=='observe':
                    result.update(status='ok',observation=dict(schema='observation/v0.2',frame_ref=frame()))
                elif call['op']=='propose':
                    self.proposal=call['args']['proposal']
                    if self.refusal:
                        result.update(status='refused',reason_code=self.refusal,detail='offline refusal')
                    else:
                        result.update(status='admitted',verdict=dict(schema='action_verdict/v0.2',
                            proposal_id='p1',decision='admitted',core_seq=1))
                else:
                    after=dict(frame(),generation=2,tick=2,sha256='a'*64)
                    result.update(status='verified',focus_verified=True,input_mono_ns=2,frame_sha256=after['sha256'],
                        receipt=dict(schema='action_receipt/v0.2',proposal_id='p1',executed_at_ns=2,
                        after_frame=after,verified=not self.missing,
                        verification=dict(method='pixel',detail='offline core witness'),error=''))
                return result
        for lane in (False,True):
            action=({'type':'lane_submit','verb':'submit','payload':dict(nonce='n1',seq=1,command='step',args=[])}
                    if lane else proposal()['action'])
            expectation=(dict(type='state_sha256_change',before='b'*64,min_tick=1,max_tick=2)
                         if lane else proposal()['expectation'])
            client=Core()
            result=run_loop(client=client,surface_id='fixture',proposal_id='p1',
                            planner=lambda o:(action,expectation),timeout_ms=100)
            self.assertTrue(result['verified'])
            self.assertEqual(client.ops,['observe','propose','wait_verify'])
        for reason in ('STALE_FRAME','POLICY','OUT_OF_BOUNDS','SURFACE_NOT_AGENT_CONTROLLED'):
            client=Core(refusal=reason)
            with self.assertRaises(ToolRefusal) as caught:
                run_loop(client=client,surface_id='fixture',proposal_id='p1',
                    planner=lambda o:(proposal()['action'],proposal()['expectation']),timeout_ms=100)
            self.assertEqual(caught.exception.reason_code,reason)
            self.assertEqual(client.ops,['observe','propose'])
        with self.assertRaises(ToolValidationError):
            run_loop(client=Core(missing=True),surface_id='fixture',proposal_id='p1',
                planner=lambda o:(proposal()['action'],proposal()['expectation']),timeout_ms=100)

    def test_loop_orders_calls_and_never_retries_refusal(self):
        from unittest.mock import patch
        observed = {'schema':'observation/v0.2', 'frame_ref':frame()}
        with patch('metaviewer_agents.verify.tools.observe',return_value=observed), \
             patch('metaviewer_agents.verify.tools.propose',return_value={'decision':'admitted'}) as admit, \
             patch('metaviewer_agents.verify.tools.wait_verify',return_value={'verified':True}) as verify:
            self.assertTrue(run_loop(client=object(), surface_id='fixture', proposal_id='p1',
                planner=lambda o: (proposal()['action'],proposal()['expectation']), timeout_ms=100)['verified'])
            self.assertEqual(admit.call_count,1); self.assertEqual(verify.call_count,1)
            admit.side_effect=ValueError('refused')
            with self.assertRaises(ValueError):
                run_loop(client=object(),surface_id='fixture',proposal_id='p1',
                         planner=lambda o:(proposal()['action'],proposal()['expectation']),timeout_ms=100)
            self.assertEqual(verify.call_count,1)


if __name__ == '__main__': unittest.main()
