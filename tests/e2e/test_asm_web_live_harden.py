"""Hosted-only security contracts; mutations are applied in memory, never live.

[TARGET, unit decision] Stub only native/session/process boundaries. All refusal,
cleanup and publication logic under test is the actual runner implementation.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RUNNER = HERE / 'e2e1_slice/asm_web_live.py'
sys.path.insert(0, str(ROOT / 'agents'))

# Each named regression must fail its security contract if the gate is removed.
MUTATIONS = {
    'MUT-MISSING-EVIDENCE-KEYERROR': ('test_failed_action_receipts',
        "evidence = receipt_evidence(receipt)", "evidence = receipt['native_evidence']"),
    'planner-out-of-box-click': ('test_planner_custody',
        "require(action.get('type') == 'click'", "require(True or action.get('type') == 'click'"),
    'midrun-gate-flap': ('test_admission_gate_flap',
        "require(self.op_offline_proof().get('fixtures_offline') is True, 'offline fixture proof failed')",
        "require(True, 'offline fixture proof failed')"),
    'unpinned-verifier-exec': ('test_binary_pins',
        "require(hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256']",
        "require(True or hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256']"),
    'fixture-sendbeacon-img': ('test_fixture_allowlist',
        "require(hashlib.sha256(raw).hexdigest() == FIXTURE_PINS[page]",
        "require(True or hashlib.sha256(raw).hexdigest() == FIXTURE_PINS[page]"),
    'replay-stop-partial-fail': ('test_partial_freeze',
        "        try:\n            for proc in self.session.processes:\n                proc.send_signal(signal.SIGSTOP)\n                stopped.append(proc)\n",
        "        for proc in self.session.processes:\n            proc.send_signal(signal.SIGSTOP)\n            stopped.append(proc)\n        try:\n"),
    'cleanup-foreign-capsule-silent': ('test_cleanup_inventory_failure',
        'for name in sorted(owned):', 'for name in sorted(owned & (inventory or set())):'),
    'unset-optin-token-leak': ('test_backend_optin',
        "require(os.environ.get('MV_LIVE_WEB') == '1' and",
        "require(True or os.environ.get('MV_LIVE_WEB') == '1' and"),
}


def load_runner():
    spec = importlib.util.spec_from_file_location('asm_web_live_harden_subject', RUNNER)
    module = importlib.util.module_from_spec(spec)
    source = RUNNER.read_text()
    mutation = os.environ.get('MV_WEB_TEST_MUTATION')
    if mutation:
        _, before, after = MUTATIONS[mutation]
        assert source.count(before) == 1, mutation
        source = source.replace(before, after)
    exec(compile(source, str(RUNNER), 'exec'), module.__dict__)
    return module


web = load_runner()


class HardenTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mv-web-harden-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.backend = object.__new__(web.LiveBackend)

    def executable(self, name='tool'):
        path = self.root / name
        path.write_bytes(b'hosted fixture, never executed')
        path.chmod(0o700)
        return path

    def test_planner_custody(self):
        from metaviewer_agents.wender_bridge import WenderSubprocessAdapter
        b = self.backend
        tool = self.executable()
        b.roots = {'wender-agent': self.root}
        b.observations = {'frame': {}}
        target = dict(id='node-1', name='Submit Greeting', box=[10, 20, 30, 40])
        state = dict(nodes=[target], actionable=['node-1'])
        sensed = dict(frame=dict(sha256='frame', width=100, height=100), state=state, table={})
        fake = Mock()
        def planned(action=None, node=None, changed=None):
            fake.plan_step.return_value = (action or dict(type='click', x=11, y=21, button='left'),
                                           {'untrusted': True}, changed or state, node or target)
        with patch.dict(os.environ, MV_WENDER_PLANNER_CMD=json.dumps([str(tool)])), \
                patch.object(WenderSubprocessAdapter, '__new__', return_value=fake):
            planned()
            self.assertEqual(b.op_plan(sensed, 'click:Submit Greeting')['action']['x'], 11)
            for x, y in [(9, 21), (40, 21), (11, 60), (True, 21)]:
                planned(dict(type='click', x=x, y=y, button='left'))
                with self.assertRaises(web.Failure) as caught:
                    b.op_plan(sensed, 'click:Submit Greeting')
                self.assertEqual(caught.exception.code, 'E2E_WITNESS')
            planned(node=dict(target, box=[0, 0, 1, 1]))
            with self.assertRaises(web.Failure):
                b.op_plan(sensed, 'click:Submit Greeting')
            for bad in [dict(target, name='Stop generation'), dict(target, box=[90, 20, 30, 40])]:
                altered = dict(nodes=[bad], actionable=['node-1'])
                planned(node=bad, changed=altered)
                with self.assertRaises(web.Failure):
                    b.op_plan(dict(sensed, state=altered), 'click:' + bad['name'])
            planned()
            with patch.dict(os.environ, MV_WENDER_PLANNER_CMD=json.dumps([sys.executable])):
                with self.assertRaises(web.Failure) as caught:
                    b.op_plan(sensed, 'click:Submit Greeting')
                self.assertEqual(caught.exception.code, 'E2E_PREREQ')
        with self.assertRaises(web.Failure):
            web.planner_command(json.dumps([str(tool), '-c', 'unsafe']), self.root)

    def test_admission_gate_flap(self):
        b = self.backend
        b.session = Mock()
        b.session.receive.return_value = {'native_evidence': {}}
        b.pending = {}
        b.tools = SimpleNamespace(propose=Mock(), ToolRefusal=RuntimeError)
        b.op_ownership = Mock(return_value={})
        b.op_offline_proof = Mock(return_value={'fixtures_offline': False})
        b.stack = SimpleNamespace(checked=Mock(side_effect=AssertionError('native call during proof')))
        with patch('metaviewer_agents.verify.build_proposal', return_value={'proposal_id': 'p'}):
            with self.assertRaises(web.Failure):
                b.op_propose({'frame': {}}, {'action': {}, 'expectation': {}}, 100)
        b.stack.checked.assert_not_called()
        b.tools.propose.assert_not_called()
        b.session.receive.assert_not_called()
        b.session.state = {'capsules': ['owned']}
        b.live = SimpleNamespace(profile_containers=lambda _: {'owned', 'foreign'})
        b.stack = SimpleNamespace(inventory=lambda: {'owned', 'foreign'})
        with self.assertRaises(web.Failure):
            web.LiveBackend.op_ownership(b)

    def test_failed_action_receipts(self):
        b = self.backend
        b.session = Mock()
        b.pending = {}
        b.tools = SimpleNamespace(propose=Mock(return_value={'admitted': True}),
                                  ToolRefusal=RuntimeError)
        b.op_ownership = Mock(return_value={})
        b.op_offline_proof = Mock(return_value={'fixtures_offline': True})
        for receipt in [
                dict(error='input failed: usage: CLI failed with exit status 2',
                     verified=False, verification={'detail': 'input failed'}),
                dict(verified=True, verification={'detail': 'missing witness'}),
                dict(native_evidence={}, verified=True),
                dict(native_evidence={'input_mono_ns': 1}, error='native error')]:
            with self.subTest(receipt=receipt):
                b.session.receive.return_value = receipt
                with patch('metaviewer_agents.verify.build_proposal',
                           return_value={'proposal_id': 'p'}):
                    try:
                        b.op_propose({'frame': {}}, {'action': {}, 'expectation': {}}, 100)
                    except Exception as error:
                        self.assertIsInstance(error, web.Failure)
                        self.assertEqual(error.code, 'VERIFICATION_FAILED')
                        self.assertIn(json.dumps(receipt.get('error')), str(error))
                        self.assertIn(json.dumps(receipt.get('verification')), str(error))
                    else:
                        self.fail('failed receipt accepted')
                self.assertEqual(b.pending, {})
        good = dict(native_evidence={'input_mono_ns': 1}, verified=False, error='')
        b.session.receive.return_value = good
        with patch('metaviewer_agents.verify.build_proposal', return_value={'proposal_id': 'p'}):
            self.assertEqual(b.op_propose({'frame': {}}, {'action': {}, 'expectation': {}}, 100)
                             ['native_evidence'], good['native_evidence'])
        self.assertEqual(b.pending['p'][2], good)

    def test_navigation_unicode_chunks(self):
        b = self.backend
        url = 'data:text/plain,' + '😀é' * 2300
        frame = dict(width=1280, height=900, sha256='before')
        b.op_offline_proof = Mock(return_value={'fixtures_offline': True})
        b.op_observe = Mock(return_value={'frame_ref': frame})
        b.op_ax = Mock(return_value={'elements': [{'name': 'EMPTY'}]})
        b.op_propose = Mock(return_value=dict(proposal_id='p', verdict={'admitted': True}))
        def verify(*args):
            b.op_observe.return_value = {'frame_ref': dict(frame, sha256='after')}
            return dict(receipt={'verified': True})
        b.op_wait_verify = Mock(side_effect=verify)
        with patch.object(web, 'page_url', return_value=url):
            setup = b.op_navigate('form', url)
        chunks = [c.args[1]['action']['text'] for c in b.op_propose.call_args_list
                  if c.args[1]['action']['type'] == 'type']
        self.assertEqual(''.join(chunks), url)
        self.assertEqual([len(c) for c in chunks], [2000, 2000, len(url) - 4000])
        self.assertTrue(all(c.encode('utf-8').decode('utf-8') == c for c in chunks))
        self.assertEqual(len(setup), 3 + len(chunks))
        self.assertEqual(b.op_wait_verify.call_count, len(setup))
        self.assertTrue(all(s['kind'] == 'navigation' for s in setup[1:]))

    def test_binary_pins(self):
        path = self.executable()
        pins = {'verifier': {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}}
        self.assertEqual(web.pinned_executable('verifier', str(path), pins), str(path))
        for supplied in ['relative', str(self.root / 'outside')]:
            with self.assertRaises(web.Failure):
                web.pinned_executable('verifier', supplied, pins)
        path.write_bytes(b'mutated binary')
        with self.assertRaises(web.Failure):
            web.pinned_executable('verifier', str(path), pins)
        with patch.dict(os.environ, {'NODE_OPTIONS': '--evil', 'LD_PRELOAD': 'evil',
                                     'WEB_TEST_TOKEN': 'planted', 'LANG': 'C'}):
            env = web.minimal_env()
        self.assertLessEqual(set(env), {'PATH', 'LANG', 'CARGO_TARGET_DIR'})
        self.assertEqual(env['LANG'], 'C')

    def test_fixture_allowlist(self):
        original = web.fixture('form')
        for payload in ['<script>navigator.sendBeacon("/leak")</script>',
                        '<img src="//outside/pixel">', '<script>import("/payload")</script>',
                        '<iframe src="/outside"></iframe>', '<form action="/leak">',
                        '<style>body{background:url(/leak)}</style>']:
            (self.root / 'form.html').write_text(original + payload)
            with patch.dict(web.FIXTURE_ROOTS, {'form': self.root}):
                with self.assertRaises(web.Failure):
                    web.fixture('form')
        for page in web.FIXTURE_PINS:
            self.assertIn("default-src 'none'", web.fixture(page))

    def test_partial_freeze(self):
        b = self.backend
        procs = [Mock(), Mock(), Mock()]
        procs[1].send_signal.side_effect = OSError('STOP failed')
        b.session = SimpleNamespace(processes=procs)
        b.op_observe = Mock()
        with self.assertRaises(OSError):
            b.op_replay()
        self.assertEqual(procs[0].send_signal.call_args_list[-1].args, (signal.SIGCONT,))
        procs[2].send_signal.assert_not_called()

    def test_replay_probe_and_resume_errors(self):
        b = self.backend
        procs = [Mock(), Mock(), Mock()]
        b.session = SimpleNamespace(processes=procs, report={}, archive=self.root, work=self.root)
        b.op_observe = Mock()
        b.live = SimpleNamespace(replay_probe=Mock(side_effect=RuntimeError('probe failed')))
        with patch.dict(os.environ, MV_E2E_REPLAY_BIN='unused'), self.assertRaises(RuntimeError):
            b.op_replay()
        for proc in procs:
            self.assertEqual(proc.send_signal.call_args_list[-1].args, (signal.SIGCONT,))
        procs[0].send_signal.side_effect = lambda sig: (_ for _ in ()).throw(OSError()) if sig == signal.SIGCONT else None
        with patch.dict(os.environ, MV_E2E_REPLAY_BIN='unused'), self.assertRaises(web.Failure):
            b.op_replay()
        self.assertEqual(procs[-1].send_signal.call_args_list[-1].args, (signal.SIGCONT,))

    def cleanup_backend(self):
        b = self.backend
        b.adapter = None
        b.evidence = self.root / 'evidence'
        b.evidence.mkdir(mode=0o700)
        temp = tempfile.TemporaryDirectory(dir=self.root)
        work = Path(temp.name) / 'work'
        work.mkdir()
        (work / 'forensic.txt').write_text('preserve me')
        b.session = SimpleNamespace(state={'capsules': ['owned'], 'pids': [], 'published': []},
            peers=[], processes=[], report={'wire_evidence': [{'token': 'planted'}]},
            temp=temp, root=Path(temp.name), work=work)
        b.stack = SimpleNamespace(remember_tree=Mock(), inventory=Mock(side_effect=[OSError('inventory'), {'foreign'}]),
            checked=Mock(side_effect=[OSError('transient stop'), 'stopped']), alive=lambda _: False)
        b.live = SimpleNamespace(CAPSULE_ID_RE=re.compile('owned|foreign'),
            profile_containers=lambda _: {'foreign'},
            cleanup_capsule_ram=Mock(return_value={'status': 'PASS', 'ram_absent': True}))
        return b

    def test_cleanup_inventory_failure(self):
        b = self.cleanup_backend()
        with patch.dict(os.environ, MV_SRF_BIN_DIR=str(self.root), MV_SRF_STATE_DIR=str(self.root),
                        MV_SRF_LIVE_RAM_ROOT=str(self.root)):
            result = b.op_cleanup()
        self.assertEqual(b.stack.checked.call_count, 2)
        for call in b.stack.checked.call_args_list:
            argv = call.args[0]
            self.assertEqual(argv[argv.index('--container') + 1], 'owned')
        self.assertEqual(result['foreign_capsules'], ['foreign'])
        self.assertEqual(result['container_cleanup'], 'FAIL')
        self.assertTrue(result['process_cleanup']['temporary_tree_absent'])
        self.assertEqual((b.evidence / 'runtime-forensics/work/forensic.txt').read_text(), 'preserve me')
        self.assertNotIn('planted', (b.evidence / 'wire.json').read_text())
        for path in b.evidence.rglob('*'):
            self.assertEqual(path.stat().st_mode & 0o777, 0o700 if path.is_dir() else 0o600)

    def test_backend_optin(self):
        modules = {name: ModuleType(name) for name in ('gate_g_ai', 'g_ai_stack', 'live', 'stack')}
        modules['g_ai_stack'].Session = type('FakeSession', (), {})
        env = {key: 'hosted-only' for key in web.REQUIRED_ENV}
        env.update(MV_LIVE_WEB='', MV_E2E_LIVE='1', MV_SRF_LIVE_PROFILE='mv-live-1')
        with patch.dict(sys.modules, modules), patch.dict(os.environ, env), \
                patch.object(web.tempfile, 'mkdtemp', side_effect=AssertionError('allocation before opt-in')) as allocate:
            with self.assertRaises(web.Failure) as caught:
                web.LiveBackend()
            self.assertEqual(caught.exception.code, 'E2E_PREREQ')
            allocate.assert_not_called()

    def test_start_failure_releases_resources(self):
        b = self.cleanup_backend()
        b.adapter = Mock()
        b.adapter._vserve_proc = SimpleNamespace(poll=lambda: 0)
        b._start = Mock(side_effect=web.Failure('initialization failed'))
        with patch.dict(os.environ, MV_SRF_BIN_DIR=str(self.root), MV_SRF_STATE_DIR=str(self.root),
                        MV_SRF_LIVE_RAM_ROOT=str(self.root)):
            with self.assertRaises(web.Failure):
                b.op_start()
        b.adapter.close.assert_called_once()
        self.assertFalse(b.evidence.exists())
        self.assertFalse(b.session.root.exists())

    def test_report_redaction(self):
        token = 'planted-web-token-abcdef'
        report = dict(error={'detail': token + ' identity=' + str(self.root)},
                      wire_evidence=[{'argv': ['tool', token], 'stderr': token, 'value': token}])
        with patch.dict(os.environ, WEB_TEST_API_KEY=token), patch.object(web, 'HostedRPC'), \
                patch.object(web, 'run', side_effect=lambda backend, target: (target.update(report) or 1)), \
                patch.object(sys, 'argv', ['runner', '--hosted-rpc']), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(web.main(), 1)
        self.assertNotIn(token, output.getvalue())
        self.assertNotIn(str(self.root), output.getvalue())
        path = self.root / 'report.json'
        with patch.dict(os.environ, WEB_TEST_API_KEY=token):
            web.private_write(path, json.dumps(web.redact(report)))
        self.assertNotIn(token, path.read_text())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_prelude_geometry(self):
        for width, height in [(1280, 900), (1920, 1080), (800, 600)]:
            frame = dict(width=width, height=height)
            point = web.LiveBackend.prelude_point(frame)
            self.assertEqual((point['x'], point['y']), (width // 4, 3 * height // 4))
            web.LiveBackend.check_prelude(frame, point)
            for x, y in [(7 * width // 8, height // 8), (width // 4, 20),
                         (-1, height * 3 // 4), (width, height), (True, height * 3 // 4)]:
                with self.assertRaises(web.Failure):
                    web.LiveBackend.check_prelude(frame, dict(point, x=x, y=y))
        for width, height in [(None, 900), (1280, 0), (True, 900)]:
            with self.assertRaises(web.Failure):
                web.LiveBackend.prelude_point(dict(width=width, height=height))

    def test_navigation_prelude_receipt_and_stale_admission(self):
        b = self.backend
        frame = dict(width=1280, height=900, sha256='before', surface_id='owned')
        b.op_offline_proof = Mock(return_value={'fixtures_offline': True})
        url = web.page_url('form')
        chunks = [url[i:i + 2000] for i in range(0, len(url), 2000)]
        count = 3 + len(chunks)
        b.op_observe = Mock(side_effect=[{'frame_ref': frame}] * (count + 2) +
                           [{'frame_ref': dict(frame, sha256='after')}])
        b.op_ax = Mock(return_value={'elements': [{'name': 'EMPTY'}]})
        b.op_propose = Mock(side_effect=[web.Failure('stale', 'STALE_FRAME')] +
                          [dict(proposal_id=str(i), verdict={'admitted': True}) for i in range(count)])
        verified = dict(status='verified', receipt={'verified': True})
        b.op_wait_verify = Mock(return_value=verified)
        setup = b.op_navigate('form', web.page_url('form'))
        self.assertEqual(len(setup), count)
        self.assertEqual(setup[0]['kind'], 'focus_prelude')
        self.assertEqual(b.op_wait_verify.call_count, count)
        calls = b.op_propose.call_args_list
        self.assertEqual(calls[0].args[1], calls[1].args[1])
        actions = [call.args[1]['action'] for call in calls[1:]]
        self.assertEqual(actions, [web.LiveBackend.prelude_point(frame),
            dict(type='key', keys=['ctrl', 'l']), *[dict(type='type', text=c) for c in chunks],
            dict(type='key', keys=['Return'])])
        for call in calls:
            self.assertEqual(call.args[0]['frame'], frame)
            self.assertEqual(call.args[1]['expectation'], dict(type='changed_region',
                bbox=dict(x=0, y=0, w=1280, h=900)))
        b.op_wait_verify.side_effect = web.Failure('VERIFICATION_FAILED', 'VERIFICATION_FAILED')
        b.op_propose.side_effect = None
        b.op_propose.return_value = dict(proposal_id='failed', verdict={'admitted': True})
        b.op_observe.side_effect = None
        b.op_observe.return_value = {'frame_ref': frame}
        with self.assertRaises(web.Failure) as caught:
            b.op_navigate('form', web.page_url('form'))
        self.assertEqual(caught.exception.code, 'VERIFICATION_FAILED')
        self.assertEqual(b.op_wait_verify.call_count, count + 1)  # Never retry dispatched input.

    def test_named_mutations(self):
        for name, (test_name, _, _) in MUTATIONS.items():
            with self.subTest(mutation=name):
                env = dict(os.environ, MV_WEB_TEST_MUTATION=name, PYTHONDONTWRITEBYTECODE='1')
                result = subprocess.run([sys.executable, str(Path(__file__).resolve()),
                    'HardenTests.' + test_name], env=env, capture_output=True, text=True, timeout=15)
                self.assertNotEqual(result.returncode, 0, 'surviving mutation: ' + name)
                self.assertIn('FAIL:', result.stderr, result.stderr)
                self.assertNotIn('ERROR:', result.stderr, result.stderr)
                print('KILLED ' + name)


if __name__ == '__main__':
    unittest.main(verbosity=2)
