"""CI G-AI probes use temporary subprocesses, never private checkouts."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('gate_g_ai', ROOT / 'tools/gate_g_ai.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class Session:
    def __init__(self, frame, post, state):
        self.frame, self.post, self.state = frame, post, state
        self.surface_id = frame['surface_id']
        self.report = {'commands': []}
        self.ops = []
        self.cleanup = None

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        self.cleanup = dict(ram_absent=True, processes_absent=True, state_absent=True)

    def native_tree(self):
        return dict(state=copy.deepcopy(self.state))

    def canvas(self, frame):
        gate.checked_frame(frame)
        self.ops.append('canvas')

    def dispatched(self, proposal):
        self.ops.append('dispatch')
        return dict(focus_verified=True, input_mono_ns=10)

    def request(self, call, expect, *, timeout_ms):
        op = call['op']
        self.ops.append(op)
        result = dict(schema=expect, request_id=call['request_id'], op=op)
        if op == 'observe':
            result.update(status='ok', observation=dict(schema='observation/v0.2', frame_ref=self.frame))
        elif op == 'propose':
            if call['args']['proposal']['proposal_id'].endswith('-stale'):
                result.update(status='refused', reason_code='STALE_FRAME', detail='fixture stale generation')
                return result
            self.proposal = call['args']['proposal']
            result.update(status='admitted', verdict=dict(schema='action_verdict/v0.2',
                proposal_id=self.proposal['proposal_id'], decision='admitted', core_seq=1))
        else:
            assert op == 'wait_verify'
            self.state['source']['title'] = 'changed'
            native = dict(surface_id='fixture', native_surface_id='w1', kind='click',
                          input_mono_ns=10, input_ts_ns=5, result='ok', focus_verified=True)
            receipt = dict(schema='action_receipt/v0.2', proposal_id=self.proposal['proposal_id'],
                           executed_at_ns=5, after_frame=self.post, verified=True,
                           verification=dict(method='pixel', detail='fixture pixel witness'), error='', native_evidence=native)
            result.update(status='verified', receipt=receipt, focus_verified=True,
                          input_mono_ns=10, frame_sha256=self.post['sha256'])
        return result


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='g-ai-café-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        ram = tempfile.TemporaryDirectory(prefix='g-ai-test-', dir='/dev/shm')
        self.addCleanup(ram.cleanup)
        self.ram = Path(ram.name)
        self.frame = self.make_frame('pre', bytes(48), 1)
        self.post = self.make_frame('post', bytes([255]) * 48, 2)
        self.raw = dict(schema='ve.cu_describe/v1', frame_sha256=self.frame['sha256'],
                        width=4, height=4, changed=None, changed_regions=[],
                        crops=[dict(x=0, y=0, w=4, h=4, reason='salient')], timing_us=5)
        module = self.root / 'vadapt'
        module.mkdir()
        (module / '__init__.py').write_text('')
        (module / 'cu_describe.py').write_text(
            'import hashlib,json,struct,sys,zlib\n'
            'from pathlib import Path\n'
            'png=Path(sys.argv[sys.argv.index("--frame")+1]).read_bytes()\n'
            'offset=8; packed=b""\n'
            'while offset<len(png):\n'
            ' size=struct.unpack(">I",png[offset:offset+4])[0]\n'
            ' if png[offset+4:offset+8]==b"IDAT": packed+=png[offset+8:offset+8+size]\n'
            ' offset+=size+12\n'
            'pixels=zlib.decompress(packed)\n'
            'rgb=b"".join(pixels[i+1:i+13] for i in range(0,len(pixels),13))\n'
            'raw=json.loads(' + repr(gate.canonical(self.raw)) + ')\n'
            'raw["frame_sha256"]=hashlib.sha256(rgb).hexdigest()\n'
            'print(json.dumps(raw))\n')
        self.fake_wender = self.root / 'fake-wender.py'
        self.fake_wender.write_text("import json,sys\nr=json.load(sys.stdin)\nprint(json.dumps(r['tree']['state'],sort_keys=True,separators=(',',':'),ensure_ascii=False))\n")
        target = dict(id='0123456789abcdef', role='button', name='Continue', depth=0,
                      parent=None, ordinal=0, states={}, actionable=True, box=[0, 0, 2, 2])
        self.state = dict(schema='wender.state/v1', source=dict(kind='vision', url=None, title='before'),
                          prune=dict(name='fixture', version=1), ax_sha256='b' * 64, ax_stable_sha256='c' * 64,
                          viewport=dict(w=4, h=4), nodes=[target], actionable=[target['id']],
                          counts=dict(raw=1, nodes=1, actionable=1))
        self.session = Session(self.frame, self.post, self.state)
        pins = json.loads((ROOT / 'deps.lock').read_text())['components']
        for pin in pins:
            if pin['name'] == 'opensuperficies':
                continue
            info = self.root / (pin['name'].replace('-', '_') + '-0.dist-info')
            info.mkdir()
            (info / 'direct_url.json').write_text(json.dumps(dict(vcs_info=dict(vcs='git', commit_id=pin['commit']))))
        self.env = patch.dict(os.environ, VQA_VE_ROOT=str(self.root), MV_WENDER_ROOT=str(self.root))
        self.env.start()
        os.environ.pop('MV_WENDER_PLANNER_CMD', None)
        self.addCleanup(self.env.stop)
        self.report = dict(assertions={f'A{i}': False for i in range(1, 9)}, negative_controls={})
        self.roots = gate.preflight(self.report)

    def make_frame(self, name, pixels, generation):
        path = self.ram / (name + '.rgb')
        path.write_bytes(pixels)
        return dict(schema='frame_ref/v0.2', surface_id='fixture', generation=generation,
                    tick=generation, ts_ns=generation, width=4, height=4, format='rgb24',
                    ramws_path=str(path), sha256=hashlib.sha256(pixels).hexdigest(), capture_us=0)

    def run_harness(self):
        original = gate.wender_state
        def subprocess_state(root, table, tree):
            return original(root, table, tree, command=[sys.executable, str(self.fake_wender)])
        with patch.object(gate, 'wender_state', side_effect=subprocess_state):
            gate.run_gate(self.report, self.roots, session_factory=lambda: self.session)

    def test_all_assertions_and_negative_controls_with_real_fake_subprocesses(self):
        self.run_harness()
        self.assertTrue(all(self.report['assertions'].values()), self.report)
        self.assertTrue(all(self.report['negative_controls'].values()))
        self.assertGreaterEqual(len(self.report['negative_controls']), 17)
        self.assertEqual(self.session.ops, ['observe', 'propose', 'dispatch', 'wait_verify', 'propose', 'canvas'])
        self.assertEqual(self.report['planner'], 'local:custody_click/v1')
        self.assertTrue(self.report['verified_receipt']['verified'])
        self.assertTrue(self.report['cleanup']['ram_absent'])
        self.assertFalse(any(m.split('.')[0] in ('wender', 'visioncore', 'vadapt') for m in sys.modules))

    def test_configured_planner_is_a_real_fake_subprocess(self):
        response = dict(state=self.state, target_node=self.state['nodes'][0],
                        action=dict(type='click', x=1, y=1, button='left'),
                        expectation=dict(type='changed_region', bbox=dict(x=0, y=0, w=4, h=4)))
        planner = self.root / 'planner.py'
        planner.write_text('import json,sys\njson.load(sys.stdin)\nprint(' + repr(gate.canonical(response)) + ')\n')
        with patch.dict(os.environ, MV_WENDER_PLANNER_CMD=json.dumps([sys.executable, str(planner)])):
            self.run_harness()
        self.assertEqual(self.report['planner'], 'configured:MV_WENDER_PLANNER_CMD')
        self.assertTrue(all(self.report['assertions'].values()))

    def test_mismatched_pin_stops_before_stack(self):
        with patch.object(gate, 'run_gate') as run, patch.object(gate, 'resolve_locked_component',
                side_effect=gate.DependencyLockError('commit_mismatch', 'fixture pin mismatch')):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                rc = gate.main(['--surface', 'mv-live-1'])
            self.assertEqual(rc, 5)
            self.assertEqual(json.loads(output.getvalue())['error']['code'], 'commit_mismatch')
            run.assert_not_called()

    def test_corrupt_ram_stops_before_propose_and_cleans(self):
        Path(self.frame['ramws_path']).write_bytes(bytes([1]) * 48)
        with self.assertRaises(gate.PerceptionError):
            self.run_harness()
        self.assertEqual(self.session.ops, ['observe'])
        self.assertTrue(self.report['cleanup']['ram_absent'])

    def test_no_target_stops_before_propose(self):
        self.state['nodes'] = []
        self.state['actionable'] = []
        self.state['counts'] = dict(raw=0, nodes=0, actionable=0)
        with self.assertRaisesRegex(gate.GateFailure, 'actionable list empty'):
            self.run_harness()
        self.assertNotIn('propose', self.session.ops)
        self.assertTrue(self.report['cleanup']['ram_absent'])

    def test_missing_state_transition_does_not_pass_on_pixel_receipt(self):
        self.state['source']['title'] = 'changed'
        with self.assertRaisesRegex(gate.GateFailure, 'state did not change'):
            self.run_harness()
        self.assertTrue(self.report['receipt_verified'])
        self.assertFalse(self.report['assertions']['A8'])
        self.assertTrue(self.report['cleanup']['ram_absent'])

    def test_receipt_write_error_stays_canonical_and_fail_closed(self):
        with patch.object(gate, 'preflight', side_effect=gate.GateFailure('unavailable', 'fixture')):
            stream = io.StringIO()
            with contextlib.redirect_stdout(stream):
                rc = gate.main(['--surface', 'mv-live-1', '--receipt-out', str(self.root / 'missing/receipt.json')])
        self.assertEqual(rc, 5)
        self.assertEqual(json.loads(stream.getvalue())['error']['code'], 'receipt_write_failed')

    def test_usage_and_canonical_failure_receipt_file(self):
        result = subprocess.run([sys.executable, str(ROOT / 'tools/gate_g_ai.py'), '--surface', 'other'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, '')
        out = self.root / 'receipt.json'
        with patch.object(gate, 'preflight', side_effect=gate.GateFailure('unavailable', 'fixture')):
            stream = io.StringIO()
            with contextlib.redirect_stdout(stream):
                self.assertEqual(gate.main(['--surface', 'mv-live-1', '--receipt-out', str(out)]), 5)
        self.assertEqual(out.read_text(), stream.getvalue())
        self.assertEqual(stream.getvalue().strip(), gate.canonical(json.loads(stream.getvalue())))


if __name__ == '__main__':
    unittest.main()
