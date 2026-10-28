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
        self.current_frame = frame
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
            result.update(status='ok', observation=dict(schema='observation/v0.2', frame_ref=self.current_frame))
        elif op == 'propose':
            proposal = call['args']['proposal']
            based = proposal.get('based_on_frame')
            frame_id_mismatch = (
                ('frame_id' in proposal or 'frame_id' in self.current_frame)
                and proposal.get('frame_id') != self.current_frame.get('frame_id')
            )
            if (not isinstance(based, dict)
                    or based.get('sha256') != self.current_frame['sha256']
                    or based.get('generation') != self.current_frame['generation']
                    or frame_id_mismatch):
                result.update(status='refused', reason_code='STALE_FRAME', detail='fixture stale generation')
                return result
            self.proposal = proposal
            result.update(status='admitted', verdict=dict(schema='action_verdict/v0.2',
                proposal_id=self.proposal['proposal_id'], decision='admitted', core_seq=1))
        else:
            assert op == 'wait_verify'
            self.current_frame = self.post
            self.state['source']['title'] = 'changed'
            native = dict(surface_id='fixture', native_surface_id='w1', kind='click',
                          input_mono_ns=10, input_ts_ns=5, result='ok', focus_verified=True)
            receipt = dict(schema='action_receipt/v0.2', proposal_id=self.proposal['proposal_id'],
                           executed_at_ns=5, after_frame=self.post, verified=True,
                           verification=dict(method='pixel', detail='fixture pixel witness'), error='', native_evidence=native)
            result.update(status='verified', receipt=receipt, focus_verified=True,
                          input_mono_ns=10, frame_sha256=self.post['sha256'])
        return result


def _record_line(site_root: Path, file_path: Path) -> str:
    data = file_path.read_bytes()
    rel = file_path.relative_to(site_root).as_posix()
    return f'{rel},sha256={hashlib.sha256(data).hexdigest()},{len(data)}'


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
            direct_url = info / 'direct_url.json'
            direct_url.write_text(json.dumps(dict(vcs_info=dict(vcs='git', commit_id=pin['commit']))))
            if pin['name'] == 'vision-engine':
                entries = [module / '__init__.py', module / 'cu_describe.py', direct_url]
            else:
                entries = [self.fake_wender, direct_url]
            record_lines = [_record_line(self.root, entry) for entry in entries]
            record_lines.append(f'{info.name}/RECORD,,')
            (info / 'RECORD').write_text('\n'.join(record_lines) + '\n')
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
        self.assertEqual(set(self.report['negative_controls'].keys()), gate.REQUIRED_NEGATIVE_CONTROLS)
        self.assertEqual(len(gate.REQUIRED_NEGATIVE_CONTROLS), 19)
        self.assertIn('A4_float_validate', gate.REQUIRED_NEGATIVE_CONTROLS)
        self.assertIn('A4_float_digest', gate.REQUIRED_NEGATIVE_CONTROLS)
        self.assertTrue(all(self.report['negative_controls'][k] is True for k in gate.REQUIRED_NEGATIVE_CONTROLS))
        self.assertEqual(self.session.ops, ['observe', 'propose', 'dispatch', 'wait_verify', 'propose', 'canvas'])
        self.assertEqual(self.report['planner'], 'local:custody_click/v1')
        self.assertTrue(self.report['verified_receipt']['verified'])
        self.assertTrue(self.report['cleanup']['ram_absent'])
        self.assertFalse(any(m.split('.')[0] in ('wender', 'visioncore', 'vadapt') for m in sys.modules))

    def test_configured_planner_is_a_real_fake_subprocess(self):
        response = dict(state=self.state, target_node=self.state['nodes'][0],
                        action=dict(type='click', x=1, y=1, button='left'),
                        expectation=dict(type='changed_region', bbox=dict(x=0, y=0, w=4, h=4)))
        planner = self.ram / 'planner.py'
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

    def test_untracked_sitecustomize_and_wheel_tampering_refused(self):
        # 1. Wheel root: untracked sitecustomize.py, .pth, unrecorded .py, or modified wheel file fails closed.
        for bad_name in ('sitecustomize.py', 'usercustomize.py', 'evil.pth', 'unrecorded.py'):
            planted = self.root / bad_name
            planted.write_text('raise RuntimeError("owned")\n')
            try:
                with self.assertRaises(gate.DependencyLockError) as caught:
                    gate.resolve_locked_component('vision-engine')
                self.assertEqual(caught.exception.code, 'dirty_tree')
                if bad_name in ('sitecustomize.py', 'usercustomize.py', 'evil.pth'):
                    with self.assertRaises(gate.PerceptionError) as vcore_exc:
                        gate.vcore._scrubbed_env(self.root)
                    self.assertEqual(vcore_exc.exception.code, 'dirty_tree')
            finally:
                planted.unlink()
        cu_describe = self.root / 'vadapt' / 'cu_describe.py'
        orig_bytes = cu_describe.read_bytes()
        try:
            cu_describe.write_bytes(orig_bytes + b'\n# tampered\n')
            with self.assertRaises(gate.DependencyLockError) as caught:
                gate.resolve_locked_component('vision-engine')
            self.assertEqual(caught.exception.code, 'dirty_tree')
        finally:
            cu_describe.write_bytes(orig_bytes)
        self.assertEqual(gate.resolve_locked_component('vision-engine'), self.root.resolve())

        # 2. Git checkout root: untracked sitecustomize.py / .pth / .py / .so fails closed; backed __pycache__ passes.
        repo = self.ram / 'checkout-repo'
        repo.mkdir()
        git_env = {
            'PATH': os.environ.get('PATH', os.defpath),
            'HOME': str(self.ram),
            'LANG': 'C',
            'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_AUTHOR_NAME': 'Fixture',
            'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
            'GIT_COMMITTER_NAME': 'Fixture',
            'GIT_COMMITTER_EMAIL': 'fixture@example.invalid',
        }
        def run_git(*args):
            return subprocess.run(
                ['git', '-C', str(repo), *args],
                env=git_env, check=True, capture_output=True, text=True, timeout=5,
            ).stdout.strip()
        run_git('init', '--quiet')
        tracked_py = repo / 'mod.py'
        tracked_py.write_text('X = 1\n')
        blob = run_git('hash-object', '-w', 'mod.py')
        run_git('update-index', '--add', '--cacheinfo', '100644', blob, 'mod.py')
        tree = run_git('write-tree')
        commit = run_git('commit-tree', tree, '-m', 'fixture')
        run_git('update-ref', 'HEAD', commit)
        lock_file = self.ram / 'deps.lock'
        lock_file.write_text(json.dumps({'components': [
            {'name': 'vision-engine', 'commit': commit},
            {'name': 'wender-agent', 'commit': commit},
        ]}))
        with patch.dict(os.environ, VQA_VE_ROOT=str(repo)):
            self.assertEqual(gate.resolve_locked_component('vision-engine', lock_path=lock_file), repo.resolve())
            pycache = repo / '__pycache__'
            pycache.mkdir()
            (pycache / 'mod.cpython-312.pyc').write_bytes(b'bytecode')
            self.assertEqual(gate.resolve_locked_component('vision-engine', lock_path=lock_file), repo.resolve())
            for bad_rel in ('sitecustomize.py', 'hook.pth', 'extra.py', 'native.so', '__pycache__/evil.cpython-312.pyc'):
                bad_path = repo / bad_rel
                bad_path.write_text('payload\n')
                try:
                    with self.assertRaises(gate.DependencyLockError) as caught:
                        gate.resolve_locked_component('vision-engine', lock_path=lock_file)
                    self.assertEqual(caught.exception.code, 'dirty_tree')
                finally:
                    bad_path.unlink()

    def test_dropping_a4_negative_control_fails_oracle(self):
        orig_controls = gate.controls
        for dropped in ('A4_float_validate', 'A4_float_digest'):
            self.state['source']['title'] = 'before'
            self.report = dict(assertions={f'A{i}': False for i in range(1, 9)}, negative_controls={})
            self.roots = gate.preflight(self.report)
            self.session = Session(self.frame, self.post, self.state)
            def incomplete_controls(frame, raw, state, target, proposal, verdict, _drop=dropped):
                flags = orig_controls(frame, raw, state, target, proposal, verdict)
                flags.pop(_drop, None)
                return flags
            with patch.object(gate, 'controls', side_effect=incomplete_controls):
                with self.assertRaisesRegex(gate.GateFailure, 'incomplete negative controls'):
                    self.run_harness()

    def test_frame_identity_stale_and_fresh_negative_controls(self):
        action = dict(type='click', x=1, y=1, button='left')
        expectation = dict(type='changed_region', bbox=dict(x=0, y=0, w=4, h=4))
        # Negative control (b1): fresh proposal matching current frame_ref is accepted even with '-stale' suffix.
        fresh_with_stale_suffix = gate.build_proposal(
            self.frame, proposal_id='p-fresh-stale', action=action, expectation=expectation, max_ms=5000,
        )
        verdict = gate.tools.propose(fresh_with_stale_suffix, client=self.session, timeout_ms=5000)
        self.assertEqual(verdict['decision'], 'admitted')

        # Negative control (b2): mismatched frame generation/sha256 without '-stale' suffix is rejected with STALE_FRAME.
        stale_without_suffix = gate.build_proposal(
            self.post, proposal_id='p-mismatch-clean-name', action=action, expectation=expectation, max_ms=5000,
        )
        with self.assertRaises(gate.tools.ToolRefusal) as caught:
            gate.tools.propose(stale_without_suffix, client=self.session, timeout_ms=5000)
        self.assertEqual(caught.exception.reason_code, 'STALE_FRAME')

        # Negative control (b3): explicit frame_id mismatch without '-stale' suffix is rejected with STALE_FRAME.
        self.session.current_frame = dict(self.frame, frame_id='frame-current-1')
        mismatched_frame_id = dict(
            gate.build_proposal(self.frame, proposal_id='p-frame-id-check', action=action, expectation=expectation, max_ms=5000),
            frame_id='frame-old-0',
        )
        reply = self.session.request(
            dict(request_id='r-1', op='propose', args=dict(proposal=mismatched_frame_id)),
            'mv_tool_result/v0.2', timeout_ms=5000,
        )
        self.assertEqual(reply['status'], 'refused')
        self.assertEqual(reply['reason_code'], 'STALE_FRAME')

    def test_mutant_harness_empty_cohort_errors_and_unattributed_kills_fail_closed(self):
        rmh_spec = importlib.util.spec_from_file_location(
            'run_mutant_harness', ROOT / 'agents/tests/run_mutant_harness.py',
        )
        rmh = importlib.util.module_from_spec(rmh_spec)
        rmh_spec.loader.exec_module(rmh)

        def green_baseline():
            return {'tests_run': 10, 'failures': [], 'errors': []}

        # 1. Empty cohort MUTANTS=[] fails closed with nonzero rc.
        with contextlib.redirect_stdout(io.StringIO()):
            rc_empty, _ = rmh.evaluate_mutants(mutants=[], suite_runner=green_baseline)
        self.assertEqual(rc_empty, 1)

        # 2. Baseline-red test suite aborts before mutation with nonzero rc.
        with contextlib.redirect_stdout(io.StringIO()):
            rc_red_base, _ = rmh.evaluate_mutants(
                mutants=rmh.MUTANTS,
                suite_runner=lambda: {'tests_run': 10, 'failures': ['test_x'], 'errors': []},
            )
        self.assertEqual(rc_red_base, 1)

        # 3. Mutant run producing unittest errors > 0 fails closed with nonzero rc.
        calls = {'n': 0}
        def error_on_mutant():
            calls['n'] += 1
            if calls['n'] == 1:
                return {'tests_run': 10, 'failures': [], 'errors': []}
            return {'tests_run': 10, 'failures': ['test_expected'], 'errors': ['test_crash']}

        cohort_err = [(f'M{i}', lambda: (lambda: None), ('test_expected',)) for i in range(1, 9)]
        with contextlib.redirect_stdout(io.StringIO()):
            rc_err, results_err = rmh.evaluate_mutants(mutants=cohort_err, suite_runner=error_on_mutant)
        self.assertEqual(rc_err, 1)
        self.assertTrue(any(r[3] == 'error' for r in results_err))

        # 4. Mutant killed only by unrelated test (missing expected killer) fails closed.
        calls['n'] = 0
        def unrelated_kill():
            calls['n'] += 1
            if calls['n'] == 1:
                return {'tests_run': 10, 'failures': [], 'errors': []}
            return {'tests_run': 10, 'failures': ['test_unrelated'], 'errors': []}

        with contextlib.redirect_stdout(io.StringIO()):
            rc_unattr, results_unattr = rmh.evaluate_mutants(mutants=cohort_err, suite_runner=unrelated_kill)
        self.assertEqual(rc_unattr, 1)
        self.assertTrue(all(r[3] == 'unattributed kill' for r in results_unattr))

        # 5. Positive control: all 8 mutants triggered by their declared expected killer with 0 errors pass.
        calls['n'] = 0
        def attributed_kill():
            calls['n'] += 1
            if calls['n'] == 1:
                return {'tests_run': 10, 'failures': [], 'errors': []}
            return {'tests_run': 10, 'failures': ['test_expected (sub=1)'], 'errors': []}

        with contextlib.redirect_stdout(io.StringIO()):
            rc_ok, results_ok = rmh.evaluate_mutants(mutants=cohort_err, suite_runner=attributed_kill)
        self.assertEqual(rc_ok, 0)
        self.assertTrue(all(r[3] == 'conforming' for r in results_ok))


if __name__ == '__main__':
    unittest.main()
