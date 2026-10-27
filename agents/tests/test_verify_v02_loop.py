"""Public wire loop with real fake subprocesses, no private imports."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents import tools
from metaviewer_agents.executor import AdmittedExecutor
from metaviewer_agents.observe import ObservationError
from metaviewer_agents.perception.base import PerceptionError
from metaviewer_agents.perception.deps_lock import DependencyLockError
from metaviewer_agents.perception.vcore import VCorePerceptionAdapter
from metaviewer_agents.verify import build_proposal, run_loop


def plan_reply():
    target = dict(id='0123456789abcdef', role='button', name='Continue',
                  depth=0, parent=None, ordinal=0, states={}, actionable=True,
                  box=[0, 0, 2, 2])
    state = dict(schema='wender.state/v1', source=dict(kind='vision', url=None, title=None),
                 prune=dict(name='fixture', version=1), ax_sha256='b' * 64,
                 ax_stable_sha256='c' * 64, viewport=dict(w=4, h=4),
                 nodes=[target], actionable=[target['id']],
                 counts=dict(raw=1, nodes=1, actionable=1))
    return dict(action=dict(type='click', x=1, y=1, button='left'),
                expectation=dict(type='text_present', text='Ready'),
                state=state, target_node=copy.deepcopy(target))


class Core:
    """Supervisor fixture: admission precedes dispatch; only core verifies."""
    def __init__(self, frame):
        self.frame = frame
        self.ops = []
        self.dispatched = []
        self.refuse = False
        self.wrong_verdict = False
        self.verified = True
        self.native_delta = {}
        self.executor = AdmittedExecutor(transport=self.execute)

    def execute(self, proposal):
        self.dispatched.append(copy.deepcopy(proposal))
        return dict(focus_verified=True, input_mono_ns=10)

    def request(self, call, expect, *, timeout_ms):
        assert call['schema'] == 'mv_tool_call/v0.2'
        assert expect == 'mv_tool_result/v0.2' and timeout_ms > 0
        op = call['op']
        self.ops.append(op)
        result = dict(schema=expect, request_id=call['request_id'], op=op)
        if op == 'observe':
            result.update(status='ok', observation=dict(schema='observation/v0.2',
                                                       frame_ref=copy.deepcopy(self.frame)))
        elif op == 'propose':
            self.proposal = call['args']['proposal']
            if self.refuse:
                result.update(status='refused', reason_code='POLICY', detail='fixture refusal')
                return result
            verdict = dict(schema='action_verdict/v0.2', proposal_id='p1',
                           decision='admitted', core_seq=1)
            if self.wrong_verdict:
                verdict['proposal_id'] = 'other'
            else:
                self.execution = self.executor.dispatch(self.proposal, verdict)
            result.update(status='admitted', verdict=verdict)
        else:
            assert op == 'wait_verify' and self.dispatched
            after = dict(self.frame, generation=2, tick=2, sha256='d' * 64)
            native = dict(surface_id='fixture', native_surface_id='native-1', kind='click',
                          input_mono_ns=10, input_ts_ns=5, result='ok')
            native.update(self.native_delta)
            self.receipt = dict(schema='action_receipt/v0.2', proposal_id='p1',
                                executed_at_ns=5, after_frame=after, verified=self.verified,
                                verification=dict(method='pixel', detail='core witness'),
                                error='', native_evidence=native)
            result.update(status='verified', receipt=self.receipt, **self.execution,
                          frame_sha256=after['sha256'])
        return result


class V02LoopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='loop-café-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ram = tempfile.TemporaryDirectory(prefix='mv-loop-', dir='/dev/shm')
        self.addCleanup(self.ram.cleanup)
        pixels = bytes(48)
        path = Path(self.ram.name) / 'frame.rgb'
        path.write_bytes(pixels)
        self.frame = dict(schema='frame_ref/v0.2', surface_id='fixture', generation=1,
                          tick=1, ts_ns=1, width=4, height=4, format='rgb24',
                          ramws_path=str(path), sha256=hashlib.sha256(pixels).hexdigest(),
                          capture_us=1)
        self.core = Core(self.frame)
        # Fake distribution provenance uses the public lock, never private code.
        lock = json.loads((Path(__file__).resolve().parents[2] / 'deps.lock').read_text())
        self.provenance = {}
        for entry in lock['components']:
            if entry['name'] not in ('vision-engine', 'wender-agent'):
                continue
            metadata = self.root / (entry['name'].replace('-', '_') + '-0.0.dist-info')
            metadata.mkdir()
            record = metadata / 'direct_url.json'
            record.write_text(json.dumps(dict(vcs_info=dict(vcs='git', commit_id=entry['commit']))))
            self.provenance[entry['name']] = record
        package = self.root / 'vadapt'
        package.mkdir()
        (package / '__init__.py').write_text('')
        c2 = dict(schema='ve.cu_describe/v1', frame_sha256=self.frame['sha256'],
                  width=4, height=4, changed=None, changed_regions=[],
                  crops=[dict(x=0, y=0, w=2, h=2, reason='salient')], timing_us=1)
        (package / 'cu_describe.py').write_text(
            'import pathlib, sys\n'
            'p = sys.argv[sys.argv.index("--frame") + 1]\n'
            'assert pathlib.Path(p).read_bytes().startswith(bytes.fromhex("89504e47"))\n'
            'print(' + repr(json.dumps(c2)) + ')\n')
        self.cli = self.root / 'planner.py'
        self.write_planner()
        self.environment = patch.dict(os.environ, dict(
            MV_WENDER_ROOT=str(self.root), VQA_VE_ROOT=str(self.root),
            MV_WENDER_PLANNER_CMD=json.dumps([sys.executable, str(self.cli)])))
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.adapter = VCorePerceptionAdapter(python=sys.executable, verify_lock=True)

    def write_planner(self, *, raw=None, prelude=''):
        self.cli.write_text(
            'import json, sys\nr = json.load(sys.stdin)\n'
            'assert r["goal"] == "Continue"\n'
            'assert r["observation"]["vision"]["elements"]\n'
            'assert r["element_table"]["elements"][0]["score_ppm"] == 500000\n'
            + prelude + '\nprint(' + repr(json.dumps(plan_reply()) if raw is None else raw) + ')\n')

    def run_loop(self, **kwargs):
        options = dict(client=self.core, surface_id='fixture', proposal_id='p1',
                       timeout_ms=5000, perception_adapter=self.adapter, goal='Continue')
        options.update(kwargs)
        return run_loop(**options)

    def test_full_subprocess_loop_records_only_core_receipt(self):
        start = time.monotonic()
        receipt = self.run_loop()
        self.assertLess(time.monotonic() - start, 5)
        self.assertEqual(self.core.ops, ['observe', 'propose', 'wait_verify'])
        self.assertEqual(len(self.core.dispatched), 1)
        self.assertTrue(receipt['verified'])
        self.assertEqual(receipt, self.core.receipt)
        receipt['native_evidence']['surface_id'] = 'mutated'
        self.assertEqual(self.core.receipt['native_evidence']['surface_id'], 'fixture')
        self.assertFalse(any(n == 'wender' or n.startswith('wender.') for n in sys.modules))
        self.core.verified = False
        with self.assertRaises(tools.ToolValidationError):
            self.run_loop()

    def test_refusal_and_verdict_correlation_never_dispatch(self):
        self.core.refuse = True
        with self.assertRaises(tools.ToolRefusal) as caught:
            self.run_loop()
        self.assertEqual(caught.exception.reason_code, 'POLICY')
        self.assertEqual(self.core.dispatched, [])
        self.assertNotIn('wait_verify', self.core.ops)
        self.core.refuse = False
        self.core.wrong_verdict = True
        with self.assertRaisesRegex(tools.ToolValidationError, 'proposal_id'):
            self.run_loop()
        self.assertEqual(self.core.dispatched, [])

    def test_perception_unavailable_and_dependency_mismatch(self):
        Path(self.frame['ramws_path']).unlink()
        with self.assertRaises(PerceptionError) as caught:
            self.run_loop()
        self.assertEqual(caught.exception.code, 'unavailable')
        self.assertNotIn('propose', self.core.ops)
        Path(self.frame['ramws_path']).write_bytes(bytes(48))
        self.provenance['wender-agent'].write_text(json.dumps(
            dict(vcs_info=dict(vcs='git', commit_id='0' * 40))))
        with self.assertRaises(DependencyLockError) as caught:
            self.run_loop()
        self.assertEqual(caught.exception.code, 'commit_mismatch')
        self.assertNotIn('propose', self.core.ops)

    def test_planner_timeout_malformed_plan_and_no_fallback(self):
        self.write_planner(prelude='import time; time.sleep(1)')
        with self.assertRaises(ObservationError) as caught:
            self.run_loop(timeout_ms=200, planner=lambda o: self.fail('must not fall back'))
        self.assertEqual(caught.exception.code, 'timeout')
        self.assertNotIn('propose', self.core.ops)
        self.write_planner(raw='{}')
        with self.assertRaises(ObservationError) as caught:
            self.run_loop()
        self.assertEqual(caught.exception.code, 'bad_shape')
        self.assertNotIn('propose', self.core.ops)

    def test_local_planner_receives_enrichment_and_exhaustion_stops_proposal(self):
        del os.environ['MV_WENDER_PLANNER_CMD']
        def local(observation):
            self.assertIn('vision', observation)
            observation['frame_ref']['generation'] = 999
            return plan_reply()['action'], plan_reply()['expectation']
        self.assertTrue(self.run_loop(planner=local)['verified'])
        self.assertEqual(self.core.proposal['based_on_frame']['generation'], 1)
        self.core.ops.clear()
        def slow(observation):
            time.sleep(0.1)
            return plan_reply()['action'], plan_reply()['expectation']
        with self.assertRaises(TimeoutError):
            self.run_loop(planner=slow, timeout_ms=60, perception_adapter=None)
        self.assertNotIn('propose', self.core.ops)
        with self.assertRaises(ObservationError):
            self.run_loop(planner=lambda o: None)

    def test_command_is_explicit_argv_and_missing_vision_refused(self):
        for command in ('echo unsafe | sh', '"shell text"', '[]', '[1]', 'null', '[""]'):
            os.environ['MV_WENDER_PLANNER_CMD'] = command
            with self.subTest(command=command), self.assertRaises(ObservationError):
                self.run_loop()
        os.environ['MV_WENDER_PLANNER_CMD'] = json.dumps([sys.executable, str(self.cli)])
        with self.assertRaises(ObservationError) as caught:
            self.run_loop(perception_adapter=None)
        self.assertEqual(caught.exception.code, 'unavailable')
        self.assertNotIn('propose', self.core.ops)

    def test_tick_window_and_native_evidence_negative_controls(self):
        expectation = dict(type='state_sha256_change', before='a' * 64, min_tick=1, max_tick=2)
        proposal = build_proposal(self.frame, proposal_id='p1', action=plan_reply()['action'],
                                  expectation=expectation, max_ms=100)
        proposal['expectation']['min_tick'] = 3
        with self.assertRaisesRegex(tools.ToolValidationError, 'inverted tick'):
            tools.propose(proposal, client=self.core, timeout_ms=100)
        self.assertEqual(self.core.ops, [])
        self.assertTrue(self.run_loop()['verified'])
        for delta in ({'surface_id': 'other'}, {'input_ts_ns': True}, {'kind': 'unknown'},
                      {'extra': 1}, {'focus_verified': 1}, {'result': 'failed'}):
            self.core.native_delta = delta
            with self.subTest(delta=delta), self.assertRaises(tools.ToolValidationError):
                self.run_loop()


if __name__ == '__main__':
    unittest.main()
