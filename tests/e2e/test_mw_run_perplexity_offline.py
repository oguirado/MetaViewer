"""Offline end to end: `mw_run --site perplexity --workflow ask` through tools/mw_run_backend.py.

Real code under test: the mw_run CLI parser and run_entry, admit_home (git),
attach discovery over a fake /proc tree, connect() (core config and socket
checks), HostBackend (ownership, egress start witness, AX value masking, wall
marker, frame retention, pinned Wender shim, proposal binding controls),
Corpus and ReplayOwner from the pinned Wender checkout, receipt validation and
answer capture. Fakes: the core tool mailbox (admits proposals bound to the
current frame, applies them to the page model and verifies changed pixels),
the native srf-identity-admin/srf-identity-surface replies and the container
inventory, all served from the static HTML snapshots in
tests/e2e/fixtures/mw_perplexity. No network, no docker, no capsule.

Requires MV_MW_WENDER_ROOT or MV_WENDER_ROOT naming the deps.lock Wender checkout.
Run: python3 -m unittest tests/e2e/test_mw_run_perplexity_offline.py
"""
import contextlib
import functools
from html.parser import HTMLParser
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'tests/e2e/fixtures/mw_perplexity'
sys.path.insert(0, str(ROOT / 'agents'))
from metaviewer_agents.mw_run import build_parser  # noqa: E402

IDENTITY = 'mv-live-1'
CAPSULE = 'srf-id-mv-live-1'
SURFACE = 'surface-perplexity-1'
WIDTH, HEIGHT = 1280, 800
PROMPT = 'What is the capital of France? Ω'
ANSWER = 'Offline fixture answer: Paris is the capital of France.'
WALL_NAMES = {'Inicia sesión o crea una cuenta', 'Continuar con Google', 'Verify you are human',
              'Widget containing a Cloudflare security challenge'}
REAL_RUN = subprocess.run
RUN_WATCHDOG_S = 90  # [TARGET] a nominal offline run takes a few seconds; a missed wall would wait 150 s


class Watchdog(BaseException):
    """Escapes run_entry's handlers so a stalled run fails the test instead of hanging the suite."""


def alarm(signum, frame):
    raise Watchdog(f'mw_run exceeded {RUN_WATCHDOG_S} s (a wall was probably not handed off)')


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode()


def repair_provenance(site_dir):
    """Apply docs/MW_RUN_FIRST_RUN.md step 3: provenance names an EXPLANATION-format PROVENANCE.md."""
    notes = (FIXTURE / 'repair/NOTES.md').read_bytes()
    (site_dir / 'PROVENANCE.md').write_bytes(notes)
    for relative in ('site.json', 'workflows/ask.json'):
        path = site_dir / relative
        value = json.loads(path.read_bytes())
        value['provenance'].update(source='human', source_ref='PROVENANCE.md', receipt_sha256=None,
                                   quote_sha256=hashlib.sha256(notes).hexdigest())
        path.write_bytes(canonical(value))


def load_host():
    spec = importlib.util.spec_from_file_location('mv_mw_run_backend_offline', ROOT / 'tools/mw_run_backend.py')
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class Snapshot(HTMLParser):
    """Project one static page onto the native AX row vocabulary."""

    ROLES = {'button': 'button', 'textarea': 'textbox', 'iframe': 'iframe'}

    def __init__(self, raw):
        super().__init__()
        self.title, self.url, self.rows, self.texts = '', '', [], {}
        self._container, self._title, self._text = None, False, False
        self.feed(raw)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'title':
            self._title = True
        elif tag == 'meta' and attrs.get('name') == 'mv-url':
            self.url = attrs['content']
        elif tag == 'article':
            self._container = attrs['id']
            self.texts[self._container] = []
        elif tag == 'p' and self._container:
            self._text = True
        role = (self.ROLES.get(tag) or attrs.get('role') or
                ('checkbox' if tag == 'input' and attrs.get('type') == 'checkbox' else None))
        if role and 'data-box' in attrs:
            name = attrs.get('aria-label') or attrs.get('title') or ''
            box = [int(v) for v in attrs['data-box'].split(',')]
            container = None
            if self._container:
                ordinal = sum(1 for r in self.rows if (r['container'] or {}).get('id') == self._container)
                container = dict(id=self._container, ordinal=ordinal)
            self.rows.append(dict(role=role, name=name, box=box, container=container))

    def handle_endtag(self, tag):
        if tag == 'title':
            self._title = False
        elif tag == 'article':
            self._container = None
        elif tag == 'p':
            self._text = False

    def handle_data(self, data):
        if self._title:
            self.title += data
        elif self._text and self._container:
            self.texts[self._container].append(data.strip())


class Capsule:
    """Page model of the operator's capsule, driven only by admitted core input."""

    def __init__(self, start='home', after_submit='answer'):
        self.page, self.after_submit = start, after_submit
        self.focused, self.value, self.inputs, self.ax_reads = None, '', [], 0

    def snapshot(self):
        return Snapshot((FIXTURE / 'pages' / (self.page + '.html')).read_text(encoding='utf-8'))

    def tree(self, text_container=None):
        self.ax_reads += 1
        page = self.snapshot()
        elements = []
        for index, row in enumerate(page.rows):
            focused = row['name'] == self.focused
            elements.append(dict(
                id=hashlib.sha256(f'{self.page}/{index}/{row["name"]}'.encode()).hexdigest()[:16],
                role=row['role'], name=row['name'], box=row['box'], region=None,
                actionable=row['role'] in ('button', 'textbox', 'checkbox'), focused=focused,
                states=dict(enabled=True, focused=focused, expanded=None, checked=None, selected=None),
                container=row['container'],
                value_len=len(self.value) if row['role'] == 'textbox' else None))
        tree = dict(window=dict(id='w1', x=0, y=0, w=WIDTH, h=HEIGHT, title=page.title, url=page.url),
                    frame_seq=self.ax_reads, scroll=dict(x=0, y=0), elements=elements,
                    truncated=False, skipped_frames=0)
        if text_container is not None:
            text = ' '.join(page.texts[text_container])
            tree['text'] = dict(container_id=text_container, bytes=len(text.encode()), text=text)
        return tree

    def pixels(self):
        raw = bytearray(b'\xff' * (WIDTH * HEIGHT * 3))
        for row in self.snapshot().rows:
            x, y, w, h = row['box']
            key = (self.page, row['role'], row['name'], row['name'] == self.focused,
                   len(self.value) if row['role'] == 'textbox' else 0)
            colour = hashlib.sha256(repr(key).encode()).digest()[:3]
            for line in range(y, y + h):
                start = (line * WIDTH + x) * 3
                raw[start:start + w * 3] = colour * w
        return bytes(raw)

    def apply(self, action):
        self.inputs.append(dict(action))
        rows = self.snapshot().rows
        if action['type'] == 'click':
            hits = [r for r in rows if r['box'][0] <= action['x'] < r['box'][0] + r['box'][2]
                    and r['box'][1] <= action['y'] < r['box'][1] + r['box'][3]]
            if hits:
                self.focused = hits[-1]['name']
        elif action['type'] == 'type':
            if any(r['name'] == self.focused and r['role'] == 'textbox' for r in rows):
                self.value += action['text']
        elif action['type'] == 'key' and action['keys'] == ['Return']:
            if self.value and any(r['name'] == self.focused and r['role'] == 'textbox' for r in rows):
                self.page, self.value = self.after_submit, ''


class FakeCore:
    """Python stand-in for the core tool mailbox of the running packaged app."""

    def __init__(self, capsule, shm, **registration):
        self.capsule, self.shm, self.registration = capsule, shm, registration
        self.generation, self.frame, self.raw, self.seq = 0, None, None, 0
        self.proposals, self.pending, self.ops = [], {}, []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def publish(self):
        raw = self.capsule.pixels()
        if raw != self.raw:
            self.generation += 1
            path = self.shm / f'g{self.generation:04d}.rgb'
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw)
            self.raw = raw
            self.frame = dict(schema='frame_ref/v0.2', surface_id=SURFACE, generation=self.generation,
                              tick=self.generation, ts_ns=time.monotonic_ns(), width=WIDTH, height=HEIGHT,
                              format='rgb24', ramws_path=str(path), sha256=hashlib.sha256(raw).hexdigest(),
                              capture_us=1)
        return dict(self.frame)

    def changed(self, before, after, box):
        for line in range(box['y'], box['y'] + box['h']):
            start = (line * WIDTH + box['x']) * 3
            if before[start:start + box['w'] * 3] != after[start:start + box['w'] * 3]:
                return True
        return False

    def request(self, call, expect, *, timeout_ms):
        op, args = call['op'], call['args']
        self.ops.append(op)
        head = dict(schema=expect, request_id=call['request_id'], op=op)
        if op == 'list':
            surface = dict(schema='surface/v0.2', surface_id=SURFACE, kind='browser', display=':99',
                           geometry=dict(w=WIDTH, h=HEIGHT), state='active', visibility='unfolded',
                           control='agent', profile_id=IDENTITY)
            return dict(head, status='ok', surfaces=[surface], next_cursor=None)
        if op == 'observe':
            assert args['surface_id'] == SURFACE
            return dict(head, status='ok', observation=dict(schema='observation/v0.2', frame_ref=self.publish()))
        if op == 'propose':
            proposal = args['proposal']
            self.proposals.append(proposal)
            if (proposal['surface_id'] != SURFACE or proposal['based_on_frame'] !=
                    {k: self.frame[k] for k in ('sha256', 'generation')}):
                return dict(head, status='refused', reason_code='STALE_FRAME', detail='')
            before = self.raw
            input_ns = time.monotonic_ns()
            self.capsule.apply(proposal['action'])
            after = self.publish()
            self.seq += 1
            verified = self.changed(before, self.raw, proposal['expectation']['bbox'])
            self.pending[proposal['proposal_id']] = (verified, after, input_ns, proposal['action']['type'])
            return dict(head, status='admitted', verdict=dict(schema='action_verdict/v0.2',
                        proposal_id=proposal['proposal_id'], decision='admitted', core_seq=self.seq))
        if op == 'wait_verify':
            verified, after, input_ns, kind = self.pending.pop(args['proposal_id'])
            if not verified:
                return dict(head, status='timeout', proposal_id=args['proposal_id'], verified=False)
            kind = 'text' if kind == 'type' else kind
            receipt = dict(schema='action_receipt/v0.2', proposal_id=args['proposal_id'],
                           executed_at_ns=input_ns, after_frame=after, verified=True,
                           verification=dict(method='pixel', detail='changed_region over the full frame'),
                           error='', native_evidence=dict(surface_id=SURFACE, input_mono_ns=input_ns,
                                                          input_ts_ns=input_ns, kind=kind,
                                                          focus_verified=True, result='ok'))
            return dict(head, status='verified', receipt=receipt, focus_verified=True,
                        input_mono_ns=input_ns, frame_sha256=after['sha256'])
        raise AssertionError('unexpected core op ' + op)


class PerplexityOfflineTests(unittest.TestCase):
    def setUp(self):
        wender = os.environ.get('MV_MW_WENDER_ROOT') or os.environ.get('MV_WENDER_ROOT')
        self.assertTrue(wender, 'MV_MW_WENDER_ROOT or MV_WENDER_ROOT must name the deps.lock Wender checkout')
        self.wender = wender
        self.host = load_host()
        temporary = tempfile.TemporaryDirectory(prefix='mv-mwrun-Música-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.root.chmod(0o700)
        shm = tempfile.TemporaryDirectory(prefix='mv-mwrun-offline-', dir='/dev/shm')
        self.addCleanup(shm.cleanup)
        self.shm = Path(shm.name)
        # MemoryWeb home exactly as the operator keeps it: no standards/, one site.
        self.home = self.root / 'memoryweb'
        shutil.copytree(FIXTURE / 'site', self.home / 'sites/perplexity')
        for directory in (self.home, self.home / 'sites'):
            directory.chmod(0o700)
        for relative in ('site.json', 'workflows/ask.json'):
            raw = (FIXTURE / 'site' / relative).read_bytes()
            self.assertEqual(canonical(json.loads(raw)), raw, 'fixture copy must stay canonical')
        if self._testMethodName != 'test_operator_import_bytes_refused_with_provenance_fix':
            repair_provenance(self.home / 'sites/perplexity')
        # Packaged app runtime directory (mv-pkg-*), with its core config and socket.
        self.runtime = self.root / 'mv-pkg-run'
        (self.runtime / 'metaviewer').mkdir(parents=True, mode=0o700)
        registration = lambda component: dict(endpoint=dict(component=component, instance=component + '-1'),
                                               hello=dict(schema='hello/v0.2', component=component,
                                                          dependencies=[]))
        config = dict(session_id='pkg-offline', core=registration('core'),
                      peers=[registration(c) for c in ('daemon', 'agent', 'ui')])
        (self.runtime / 'config.json').write_text(json.dumps(config))
        self.listener = socket.socket(socket.AF_UNIX)
        self.addCleanup(self.listener.close)
        self.listener.bind(str(self.runtime / 'metaviewer/core.sock'))
        # Native state directory with the capsule control receipt and egress start witness.
        self.state = self.root / 'srf-state'
        (self.state / 'egress').mkdir(parents=True, mode=0o700)
        self.state.chmod(0o700)
        receipt = self.state / 'capsule.json'
        receipt.write_text(json.dumps(dict(Lease=dict(ProfileID=IDENTITY), Capsule=dict(container=CAPSULE))))
        receipt.chmod(0o600)
        witness = self.state / 'egress' / (IDENTITY + '.started.json')
        witness.write_text(json.dumps(dict(schema='metaviewer.capsule_egress_started/v1', capsule_id=CAPSULE,
                                           effective_mode='legacy', record_sha256='absent',
                                           start_mono_ns=123, start_wall_ns=456)))
        witness.chmod(0o400)
        self.app_env = dict(MV_CORE_CONFIG=str(self.runtime / 'config.json'), XDG_RUNTIME_DIR=str(self.runtime),
                            MV_SRF_BIN_DIR=str(self.root / 'srf-bin'), MV_SRF_STATE_DIR=str(self.state),
                            SRF_IDENTITY_STORE_ROOT=str(self.root / 'srf-identities'),
                            MV_SRF_LIVE_PROFILE=IDENTITY, OPERATOR_SECRET_SHAPE='never-copied')
        self.proc = self.root / 'proc'
        self.add_process('4242', self.root / 'app/resources/bin/mv-daemon-adapter', '4200', self.app_env)
        self.add_process('4200', self.root / 'app/metaviewer', '1', {})
        self.add_process('1', Path('/usr/lib/systemd/systemd'), '0', {})
        # An orphan adapter of a quit app (parent reaped to init) must never match.
        self.add_process('5151', self.root / 'old/resources/bin/mv-daemon-adapter', '1',
                         dict(self.app_env, MV_CORE_CONFIG='/stale/config.json'))
        self.natives = []

    def add_process(self, pid, exe, ppid, env):
        entry = self.proc / pid
        entry.mkdir(parents=True)
        (entry / 'exe').symlink_to(exe)
        (entry / 'stat').write_text(f'{pid} (x) S {ppid} 0 0\n')
        (entry / 'environ').write_bytes(b''.join(f'{k}={v}'.encode() + b'\0' for k, v in env.items()))

    def native(self, capsule, argv, **kwargs):
        argv = [str(a) for a in argv]
        name = Path(argv[0]).name
        if name not in ('srf-identity-admin', 'srf-identity-surface', 'docker'):
            return REAL_RUN(argv, **kwargs)
        self.natives.append(argv)
        if name == 'docker':
            self.assertEqual(argv[1:], ['ps', '--format', '{{.Names}}'])
            reply = CAPSULE + '\n'
        elif name == 'srf-identity-admin':
            self.assertEqual(argv[1:], ['show', '--store-root', self.app_env['SRF_IDENTITY_STORE_ROOT'],
                                        '--id', IDENTITY])
            reply = json.dumps(dict(profile_id=IDENTITY))
        else:
            self.assertEqual(argv[1:8], ['ax', '--container', CAPSULE, '--window', 'w1',
                                         '--state-dir', str(self.state)])
            extra = argv[8:]
            self.assertIn(extra, ([], ['--text-container', extra[-1] if extra else '']))
            reply = json.dumps(capsule.tree(extra[1] if extra else None))
        return SimpleNamespace(returncode=0, stdout=reply.encode(), stderr=b'')

    def notice(self, waits):
        real = self.host.wait_notice

        def wait(corpus, identity, network):
            # Virtual clock: the declared notice elapses without a real 10 s sleep.
            virtual = [time.monotonic_ns() - corpus.site['execution_policy']['min_notice_s'] * 1_000_000_000]
            slept = []

            def sleep(seconds):
                slept.append(seconds)
                virtual[0] += int(seconds * 1e9) + 1

            mono = real(corpus, identity, network, clock=lambda: virtual[0], sleep=sleep)
            waits.append(sum(slept))
            return mono
        return wait

    def run_mw(self, capsule, extra_env=None, slot=('prompt=' + PROMPT,)):
        argv = ['--identity', IDENTITY, '--site', 'perplexity', '--workflow', 'ask']
        for value in slot:
            argv += ['--slot', value]
        args = build_parser().parse_args(argv)
        # The external AI's shell: none of the app's variables are exported.
        env = dict(HOME=str(self.root), PATH=os.environ.get('PATH', os.defpath), LANG='C.UTF-8',
                   XDG_STATE_HOME=str(self.root / 'state'), MV_MW_HOME=str(self.home),
                   MV_WENDER_ROOT=self.wender, **(extra_env or {}))
        cores, waits = [], []

        def client(*a, **kw):
            core = FakeCore(capsule, self.shm, endpoint=a[0], **kw)
            cores.append(core)
            return core
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, env, clear=True), \
             patch.object(self.host, 'discover_attach', functools.partial(self.host.discover_attach, proc=self.proc)), \
             patch.object(self.host, 'ToolClient', side_effect=client), \
             patch.object(self.host, 'wait_notice', self.notice(waits)), \
             patch.object(subprocess, 'run', side_effect=functools.partial(self.native, capsule)), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            previous = signal.signal(signal.SIGALRM, alarm)
            signal.alarm(RUN_WATCHDOG_S)
            try:
                rc = self.host.run_entry(args)
            finally:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, previous)
        lines = stdout.getvalue().splitlines()
        self.assertEqual(len(lines), 1, stdout.getvalue())
        result = json.loads(lines[0])
        self.assertEqual(result['rc'], rc)
        report = json.loads(Path(result['report']).read_text()) if result['report'] else None
        return SimpleNamespace(rc=rc, result=result, report=report, core=cores[0] if cores else None,
                               waits=waits, stderr=stderr.getvalue())

    def assert_read_only_natives(self):
        for argv in self.natives:
            self.assertIn(Path(argv[0]).name, ('srf-identity-admin', 'srf-identity-surface', 'docker'))
            self.assertNotIn('input', argv)
            self.assertNotIn('net', argv)
            self.assertNotIn(PROMPT, ' '.join(argv))

    def test_ask_verified_answer_captured_and_receipt_validated(self):
        capsule = Capsule()
        run = self.run_mw(capsule)
        self.assertEqual((run.rc, run.result['verdict_code']), (0, 'VERIFIED'), (run.report, run.stderr))
        # Attach came from the running app's adapter, not from the caller's shell.
        self.assertEqual(run.report['attach'], 'discovered')
        self.assertEqual(run.core.registration['endpoint'], str(self.runtime / 'metaviewer/core.sock'))
        self.assertEqual(run.core.registration['local']['endpoint']['component'], 'agent')
        self.assertEqual(run.report['corpus'], 'staged_builtin_schemas')
        self.assertEqual(run.report['network']['effective_mode'], 'legacy')
        # Declared advance notice (site min_notice_s) was announced and waited.
        self.assertGreaterEqual(run.waits[0], 10)
        self.assertIn('perplexity/ask acts on identity mv-live-1 (network legacy) in 10 s', run.stderr)
        # Exactly the stored steps, through core propose/wait_verify only.
        self.assertEqual([p['action']['type'] for p in run.core.proposals], ['click', 'type', 'key'])
        self.assertEqual(capsule.inputs[1], dict(type='type', text=PROMPT))
        self.assertEqual(run.core.ops.count('propose'), run.core.ops.count('wait_verify'), 3)
        self.assertEqual(capsule.page, 'answer')
        self.assert_read_only_natives()
        # Verified summary: schema-checked receipt bound to frames the core published.
        receipt = Path(run.result['receipt'])
        self.assertEqual(receipt.name, 'memoryweb-run.json')
        summary = json.loads(receipt.read_text())
        # run.v1 mode is Wender's replay lane (it also runs site workflows); network mode is in the report.
        self.assertEqual((summary['site_id'], summary['workflow_id'], summary['mode']), ('perplexity', 'ask', 'replay'))
        self.assertEqual((summary['rc'], summary['verdict_code']), (0, 'VERIFIED'))
        self.assertEqual((summary['steps_total'], summary['steps_verified'], summary['steps_failed']), (3, 3, 0))
        workflow = (self.home / 'sites/perplexity/workflows/ask.json').read_bytes()
        self.assertEqual(summary['workflow_sha256'], hashlib.sha256(workflow).hexdigest())
        retained = sorted(p.name for p in receipt.parent.glob('*.rgb'))
        published = {p['based_on_frame']['sha256'] + '.rgb' for p in run.core.proposals}
        self.assertTrue(published <= set(retained), (published, retained))
        for name in retained:
            self.assertEqual(hashlib.sha256((receipt.parent / name).read_bytes()).hexdigest() + '.rgb', name)
        # The slot value never reaches the receipt, report or retained evidence names.
        for path in receipt.parent.rglob('*.json'):
            self.assertNotIn(PROMPT, path.read_text(encoding='utf-8', errors='replace'))
        # Answer text: captured once from the anchor's container, private and hash bound.
        answer = run.report['answer']
        self.assertTrue(answer['captured'], answer)
        self.assertEqual(answer['container_id'], 'answer-1')
        path = Path(answer['path'])
        self.assertEqual(path.read_text(encoding='utf-8'), ANSWER)
        self.assertEqual(answer['sha256'], hashlib.sha256(ANSWER.encode()).hexdigest())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent, receipt.parent)

    def test_operator_import_bytes_refused_with_provenance_fix(self):
        # The operator's imported definition, byte for byte: its provenance names no file,
        # so the pinned gate refuses before any input; the message names file and remedy.
        capsule = Capsule()
        run = self.run_mw(capsule)
        self.assertEqual((run.rc, run.result['verdict_code']), (6, 'MW_GATE_IO'), (run.report, run.stderr))
        self.assertEqual(capsule.inputs, [])
        self.assertEqual(run.core.proposals, [])
        message = run.report['message']
        for relative in ('site.json', 'workflows/ask.json'):
            self.assertIn(relative + ": provenance.source_ref 'operator operating memory "
                          "PERPLEXITY_OPERATING_MEMORY.md verified 2026-10-19' must name a file inside "
                          'sites/perplexity/', message)
        self.assertIn('--workflow perplexity/ask', message)
        self.assertIn(message, run.stderr)
        # The operator's pre-flight CLI reports the same faults, and passes once repaired.
        def check():
            reply = REAL_RUN([sys.executable, str(ROOT / 'tools/mw_home_check.py'), '--repo', str(ROOT),
                              '--home', str(self.home), '--workflow', 'perplexity/ask'],
                             capture_output=True, text=True, timeout=60, env=dict(os.environ, HOME=str(self.root)))
            return reply.returncode, json.loads(reply.stdout)
        rc, reply = check()
        self.assertEqual((rc, reply['ok'], reply['code'], len(reply['faults'])), (6, False, 'MW_PROVENANCE', 2))
        self.assertTrue(all(f in message for f in reply['faults']))
        repair_provenance(self.home / 'sites/perplexity')
        rc, reply = check()
        self.assertEqual((rc, reply['ok'], reply['code'], reply['faults']), (0, True, None, []))

    def test_mut_home_refusal_names_the_check(self):
        self.home.chmod(0o755)
        run = self.run_mw(Capsule())
        self.assertEqual((run.rc, run.result['verdict_code']), (6, 'MW_HOME_MODE'))
        # Refused before evidence admission: no report path, the reason is on stderr.
        self.assertIsNone(run.result['report'])
        self.assertIn('mw_run: MW_HOME_MODE: MemoryWeb home ' + str(self.home) + ' refused; check it with: python3 ',
                      run.stderr)
        self.assertIn('tools/mw_home_check.py --repo', run.stderr)
        self.assertIsNone(run.core)

    def test_login_wall_hands_off_before_any_input(self):
        capsule = Capsule(start='login')
        run = self.run_mw(capsule)
        self.assertEqual((run.rc, run.result['verdict_code']), (4, 'HUMAN_HANDOFF'), (run.report, run.stderr))
        self.assertEqual(run.core.proposals, [])
        self.assertEqual(capsule.inputs, [])
        handoff = json.loads(Path(run.result['receipt']).read_text())
        self.assertEqual(handoff['schema'], 'metaviewer.handoff/v1')
        self.assertEqual(handoff['reason'], 'login_wall')
        self.assertEqual(handoff['surface_id'], SURFACE)
        self.assertNotIn('answer', run.report)
        self.assert_read_only_natives()

    def test_captcha_after_submit_hands_off_and_is_never_touched(self):
        capsule = Capsule(after_submit='captcha')
        run = self.run_mw(capsule)
        self.assertEqual((run.rc, run.result['verdict_code']), (4, 'HUMAN_HANDOFF'), (run.report, run.stderr))
        self.assertEqual(capsule.page, 'captcha')
        handoff = json.loads(Path(run.result['receipt']).read_text())
        self.assertIn(handoff['reason'], ('captcha_wall', 'captcha'))
        # Three admitted inputs reached the page before the wall; none after it.
        self.assertEqual([p['action']['type'] for p in run.core.proposals], ['click', 'type', 'key'])
        self.assertFalse(any(i.get('type') == 'click' and 440 <= i['x'] < 840 and 300 <= i['y'] < 380
                             for i in capsule.inputs))
        self.assertNotIn('answer', run.report)

    def test_mut_attach_refusals_are_actionable(self):
        # No running app: only the orphan adapter remains.
        shutil.rmtree(self.proc / '4242')
        run = self.run_mw(Capsule())
        self.assertEqual((run.rc, run.result['verdict_code']), (6, 'MW_RUN_ATTACH'))
        self.assertIn('no running packaged MetaViewer app was found', run.report['message'])
        self.assertIsNone(run.core)
        self.assertIn('mw_run: MW_RUN_ATTACH: no running', run.stderr)
        self.assertNotIn('MW_RUN_ATTACH: MW_RUN_ATTACH', run.stderr)
        # Two running apps are ambiguous.
        self.add_process('4242', self.root / 'app/resources/bin/mv-daemon-adapter', '4200', self.app_env)
        self.add_process('4343', self.root / 'app2/resources/bin/mv-daemon-adapter', '4300', self.app_env)
        self.add_process('4300', self.root / 'app2/metaviewer', '1', {})
        run = self.run_mw(Capsule())
        self.assertEqual(run.result['verdict_code'], 'MW_RUN_ATTACH')
        self.assertIn('2 running MetaViewer apps', run.report['message'])
        shutil.rmtree(self.proc / '4343')
        # A caller value that disagrees with the running app refuses.
        run = self.run_mw(Capsule(), dict(MV_SRF_STATE_DIR='/elsewhere'))
        self.assertEqual(run.result['verdict_code'], 'MW_RUN_ATTACH')
        self.assertIn('MV_SRF_STATE_DIR differs from the running app', run.report['message'])
        # The app quit after discovery: socket gone.
        (self.runtime / 'metaviewer/core.sock').unlink()
        run = self.run_mw(Capsule())
        self.assertEqual(run.result['verdict_code'], 'MW_RUN_ATTACH')
        self.assertIn('core socket', run.report['message'])
        self.assertNotIn('never-copied', json.dumps(run.report))

    def test_mut_missing_wender_names_the_variable(self):
        capsule = Capsule()
        with patch.dict(os.environ, {}, clear=False):
            self.wender, saved = '', self.wender
            try:
                run = self.run_mw(capsule)
            finally:
                self.wender = saved
        self.assertEqual((run.rc, run.result['verdict_code']), (6, 'MW_DEPENDENCY'))
        self.assertIn('MV_WENDER_ROOT', run.report['message'])
        self.assertEqual(capsule.inputs, [])

    def test_mut_unmasked_value_len_fails_the_typed_length_check(self):
        # Without the U+2022 mask the owner cannot bind the typed length and must not succeed.
        capsule = Capsule()
        with patch.object(self.host, 'MASK', ''):
            run = self.run_mw(capsule)
        self.assertNotEqual(run.rc, 0)
        self.assertNotIn('answer', run.report)

    def test_mut_answer_without_unique_container_is_not_captured(self):
        capsule = Capsule()
        original = Capsule.tree

        def no_container(self_, text_container=None):
            tree = original(self_, text_container)
            for row in tree['elements']:
                row['container'] = None
            return tree
        with patch.object(Capsule, 'tree', no_container):
            run = self.run_mw(capsule)
        self.assertEqual(run.rc, 0)
        self.assertEqual(run.report['answer'], dict(captured=False, reason='MW_ANSWER_CONTAINER',
                                                    detail='0 containers hold the answer anchor'))
        self.assertFalse(any(arg == '--text-container' for argv in self.natives for arg in argv))


if __name__ == '__main__':
    unittest.main()
