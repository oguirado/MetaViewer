"""Opt-in assembly web acceptance; stdout JSON, retained evidence outside the repo.

[TARGET, unit decision] Reuse the G-AI session and pinned Wender state shim.
The optional MV_WENDER_PLANNER_CMD plans custody-bound clicks; deterministic
typing and the read-only table report use the same pinned state. A single
VCore client survives every tick. Runtime blob links bind the local flow pages
without a server. Hosted RPC substitutes only the backend, never task checks.
[TARGET, unit decision] MV_WEB_EXEC_PINS is an operator-supplied JSON object:
{"node": {"path": "/absolute/executable", "sha256": "..."}, "verifier": {...}}.
Explicit NODE/MV_E2E_VERIFY_BIN must match those pins. A locally built verifier
is pinned in the private evidence directory. Configured planner argv permits
only one executable under the lock-verified Wender root (no interpreter flags).
Fixture bytes are allowlisted; deliberate fixture changes need reviewed pins.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import quote

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
# OpenSuperficies src/browserid/inject/inject.go rejects type input above 2000 runes.
TYPE_TEXT_CAP = 2000
REQUIRED_ENV = ('MV_E2E_CORE_BIN', 'MV_E2E_ADAPTER_BIN', 'MV_E2E_REPLAY_BIN',
                'MV_SRF_BIN_DIR', 'MV_SRF_LIVE_PROFILE', 'MV_SRF_LIVE_RAM_ROOT',
                'MV_SRF_STATE_DIR', 'SRF_IDENTITY_STORE_ROOT', 'SRF_PROXY_REGISTRY')


class Failure(RuntimeError):
    def __init__(self, message, code='E2E_WITNESS'):
        self.code = code
        super().__init__(message)


def require(condition, message, code='E2E_WITNESS'):
    if not condition:
        raise Failure(message, code)


def receipt_evidence(receipt):
    # Reuse VERIFICATION_FAILED for failed input and absent native witnesses.
    # Propose receipts remain unverified until the separate wait_verify call.
    require(not receipt.get('error') and
            isinstance(receipt.get('native_evidence'), dict) and receipt['native_evidence'],
            'action receipt: ' + json.dumps(dict(error=receipt.get('error'),
                verification=receipt.get('verification'),
                native_evidence_present=bool(receipt.get('native_evidence'))), ensure_ascii=False),
            'VERIFICATION_FAILED')
    return receipt['native_evidence']


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                    ensure_ascii=False).encode()).hexdigest()


# The import path is explicit because hosted hardening also execs this file.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from automation_pack import BUILTINS, load_packs

# Compatibility fixture helper for existing security mutation tests. Pins come
# from the same built-in documents; execution uses each admitted pack snapshot.
FIXTURE_PINS = {page: pin for path in sorted(BUILTINS.glob('*/automation.json'))
                for page, pin in json.loads(path.read_text())['fixtures'].items()}
FIXTURE_ROOTS = {page: path.parent / 'pages' for path in sorted(BUILTINS.glob('*/automation.json'))
                 for page in json.loads(path.read_text())['fixtures']}


def fixture(page, pack=None):
    if pack is not None:
        require(page in pack.pages, 'fixture not pinned', 'E2E_PACK_PIN')
        return pack.pages[page]
    require(page in FIXTURE_PINS, 'fixture not allowlisted')
    raw = (FIXTURE_ROOTS[page] / (page + '.html')).read_bytes()
    require(hashlib.sha256(raw).hexdigest() == FIXTURE_PINS[page], 'fixture bytes not allowlisted')
    html = raw.decode('utf-8')
    require("default-src 'none'" in html, 'fixture CSP missing')
    return html


def private_write(path, data):
    # Never follow an existing symlink when persisting evidence.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(data if isinstance(data, bytes) else data.encode())


def redact(value):
    if isinstance(value, dict):
        return {k: ('[REDACTED]' if re.search(
            r'token|secret|password|credential|authorization|cookie|^argv$|^stderr$|^stdout$', k, re.I)
                    else redact(v)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    if not isinstance(value, str):
        return value
    sensitive = [v for k, v in os.environ.items() if v and (
        re.search(r'token|secret|password|credential|cookie|api.?key', k, re.I) or
        (k.startswith(('MV_', 'SRF_')) and ('/' in v or k.endswith('CMD'))) or k == 'HOME')]
    for secret in sorted(sensitive, key=len, reverse=True):
        value = value.replace(secret, '[REDACTED]')
    value = re.sub(r'(?i)(bearer\s+|(?:token|secret|password|api_key)[=:]\s*)[^\s,;]+',
                   r'\1[REDACTED]', value)
    return re.sub(r'/(?:home|Users|tmp|run|dev/shm)/[^\s\"\'<>]*', '[PRIVATE_PATH]', value)


def minimal_env():
    return {k: os.environ[k] for k in ('PATH', 'LANG', 'CARGO_TARGET_DIR') if k in os.environ}


def pinned_executable(role, supplied, pins):
    entry = pins.get(role, {})
    require(isinstance(entry, dict) and isinstance(supplied, str) and
            Path(supplied).is_absolute() and entry.get('path') == supplied and
            re.fullmatch(r'[0-9a-f]{64}', str(entry.get('sha256', ''))),
            'executable path/pin not admitted: ' + role, 'E2E_PREREQ')
    path = Path(supplied)
    require(path.resolve(strict=True) == path and path.is_file() and os.access(path, os.X_OK),
            'executable must be canonical and executable: ' + role, 'E2E_PREREQ')
    require(hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256'],
            'executable hash mismatch: ' + role, 'E2E_PREREQ')
    return str(path)


def planner_command(raw, root):
    try:
        argv = json.loads(raw)
        require(isinstance(argv, list) and len(argv) == 1 and isinstance(argv[0], str) and
                '\x00' not in argv[0] and Path(argv[0]).is_absolute(),
                'planner argv not allowlisted', 'E2E_PREREQ')
        path = Path(argv[0]).resolve(strict=True)
        require(path.is_relative_to(Path(root).resolve(strict=True)) and path.is_file() and
                os.access(path, os.X_OK), 'planner outside locked root', 'E2E_PREREQ')
        return [str(path)]
    except (ValueError, OSError, TypeError) as error:
        raise Failure('planner argv not allowlisted', 'E2E_PREREQ') from error


def page_html(page, pack=None):
    html = fixture(page, pack)
    if page == 'flow_a':
        # Finite local A -> B -> A chain; the final A is the original fixture.
        back = '<script>document.getElementById("back-btn").href=URL.createObjectURL('
        back += 'new Blob([' + json.dumps(html).replace('</script', '<\\/script')
        back += '],{type:"text/html"}));</script>'
        second = fixture('flow_b', pack) + back
        html += '<script>document.getElementById("next-btn").href=URL.createObjectURL('
        html += 'new Blob([' + json.dumps(second).replace('</script', '<\\/script')
        html += '],{type:"text/html"}));</script>'
    return html


def page_url(page, pack=None):
    html = page_html(page, pack)
    encoded = 'data:text/html;charset=utf-8,' + quote(html, safe='')
    compact = 'data:text/html;charset=utf-8;base64,' + base64.b64encode(html.encode()).decode('ascii')
    return min((encoded, compact), key=len)


def start_live_session(session):
    # Scope the adapter configuration to this launch, restoring caller state.
    prior = os.environ.get('MV_SRF_LIVE_TEXT_INPUT')
    os.environ['MV_SRF_LIVE_TEXT_INPUT'] = 'paste'
    try:
        return session.start()
    finally:
        if prior is None:
            os.environ.pop('MV_SRF_LIVE_TEXT_INPUT', None)
        else:
            os.environ['MV_SRF_LIVE_TEXT_INPUT'] = prior


def texts(tree):
    return [str(n.get('text') or n.get('name') or '')
            for n in tree.get('elements', tree.get('nodes', []))]


def prove_ax(task, sensed, tree, expected):
    rows = texts(tree)
    require(all(token in rows for token in expected), 'AX readback differs from expected page')
    names = [n.get('name', '') for n in sensed['state']['nodes']]
    require(all(token in names for token in expected), 'AX differs from perceived Wender state')
    task['ax_proofs'].append(dict(expected=expected, texts=rows,
                                  frame_ref=sensed['frame'], tree_sha256=digest(tree)))


def seal_task(task, pack):
    # Independent completion gate: deleting the final prove_ax call cannot pass.
    required = pack.document['expect']
    proven = [x for proof in task['ax_proofs'] for x in proof['expected']
              if x in proof['texts']]
    require(proven == required, 'mandatory final AX proof absent')
    require(task['steps'] <= pack.document['budget'], 'task action budget exceeded')
    task['verdict'] = 'PASS'


class HostedRPC:
    """Test-only pipe protocol. It never loads native/live modules."""
    def call(self, stage, **args):
        if stage == 'start':
            class Launch:
                def start(_):
                    return self.request('start', text_input=os.environ.get('MV_SRF_LIVE_TEXT_INPUT'))
            return start_live_session(Launch())
        if stage == 'navigate':
            # Exercise the real navigation implementation with hosted boundaries.
            self.call('navigate_begin', **args)
            native = object.__new__(LiveBackend)
            native.packs = self.packs
            for name in ('offline_proof', 'observe', 'propose', 'wait_verify', 'ax'):
                def boundary(*values, _name=name):
                    keys = dict(offline_proof=(), observe=('timeout_ms',),
                                propose=('sensed', 'plan', 'max_ms'),
                                wait_verify=('admitted', 'timeout_ms'), ax=())[_name]
                    result = self.call('navigation_' + _name, **dict(zip(keys, values)))
                    if _name == 'propose':
                        receipt_evidence(result)
                    return result
                setattr(native, 'op_' + name, boundary)
            setup = native.op_navigate(**args)
            self.request('navigate', **args)
            return setup
        return self.request(stage, **args)

    def request(self, stage, **args):
        print(json.dumps(dict(rpc=stage, args=args)), flush=True)
        reply = json.loads(sys.stdin.readline())
        if 'error' in reply:
            raise Failure(reply['error'], reply.get('code', 'E2E_WITNESS'))
        return reply['result']


def run(backend, report):
    packs = backend.packs
    typing_target = None

    def stage(task, name, **args):
        started = time.monotonic_ns()
        try:
            return backend.call(name, **args)
        finally:
            task['latency_ms'].setdefault(name, []).append(
                dict(value=(time.monotonic_ns() - started) / 1e6, provenance='MEASURED'))

    def sense(task):
        observed = stage(task, 'observe', timeout_ms=5000)
        result = stage(task, 'perceive', observed=observed)
        require(result['table']['frame_sha256'] == result['frame']['sha256'], 'C2 frame mismatch')
        witness = result['frame_witness']
        require(witness.get('sha256') == result['frame']['sha256'] and
                witness.get('generation') == result['frame']['generation'] and
                witness.get('surface_id') == result['frame']['surface_id'] and
                type(witness.get('bytes')) is int and witness['bytes'] > 0 and witness.get('artifact'),
                'frame byte witness absent or uncorrelated')
        result['state'] = stage(task, 'state', sensed=result)
        task['observations'].append(dict(frame_ref=result['frame'],
                                        element_table_sha256=digest(result['table']),
                                        wender_state_sha256=digest(result['state']),
                                        perception_transport=result.get('transport', 'hosted'),
                                        frame_witness=witness))
        return result

    def step(task, goal):
        nonlocal typing_target
        require(task['steps'] < pack.document['budget'], 'action budget exhausted')
        # Retry admission refusals only; dispatched actions are never replayed.
        for attempt in range(3):
            sensed = sense(task)
            if goal.startswith('type:'):
                require(typing_target is not None, 'typing requires a prior verified named click')
                sensed['typing_target'] = typing_target
            planned = stage(task, 'plan', sensed=sensed, goal=goal)
            require(stage(task, 'offline_proof').get('fixtures_offline') is True, 'offline fixture proof failed')
            stage(task, 'ownership')
            try:
                admitted = stage(task, 'propose', sensed=sensed, plan=planned, max_ms=30000)
            except Failure as error:
                if error.code == 'STALE_FRAME' and attempt < 2:
                    continue
                raise
            task['steps'] += 1
            verified = stage(task, 'wait_verify', admitted=admitted, timeout_ms=30000)
            receipt = verified['receipt']
            require(verified['status'] == 'verified' and receipt.get('verified') is True,
                    'receipt is not verified')
            require(verified['focus_verified'] is True and verified['input_mono_ns'] > 0,
                    'native focus/input proof missing')
            require(verified.get('receipt_binding_negative_control') == 'PASS',
                    'receipt binding negative control missing')
            require(receipt['proposal_id'] == admitted['proposal_id'] and
                    receipt['after_frame']['surface_id'] == sensed['frame']['surface_id'] and
                    verified['frame_sha256'] == receipt['after_frame']['sha256'] and
                    verified['input_mono_ns'] == admitted['native_evidence']['input_mono_ns'],
                    'receipt binding mismatch')
            task['action_receipts'].append(verified)
            typing_target = goal[6:] if goal.startswith('click:') else None
            return
        raise Failure('stale admission exhausted')

    def prove_cell(task, tree, expected):
        cells = [x for x in texts(tree) if x in expected]
        require(cells == expected, 'read document order mismatch')
        require(task['read_plan'].get('values') == cells, 'read plan differs from AX values')
        task['reported_values'] = cells
        cell = pack.document.get('report_cell')
        if cell:
            row, col, index = cell['row'], cell['col'], cell['index']
            require(index < len(cells), 'reported table cell absent')
            task['reported_cell'] = dict(row=row, col=col, value=cells[index])
            require(task['read_plan'].get('row') == row and task['read_plan'].get('col') == col and
                    task['read_plan'].get('value') == cells[index], 'read plan differs from AX cell')

    def plan_read(task, sensed, goal):
        expected = pack.read_expected[goal[5:]]
        sensed['read_expected'] = expected
        if 'report_cell' in pack.document:
            sensed['report_cell'] = pack.document['report_cell']
        task['read_plan'] = stage(task, 'plan', sensed=sensed, goal=goal)
        return expected

    def prove_read(task, sensed, goal, pack):
        region = goal[5:]
        expected = plan_read(task, sensed, goal)
        tree = stage(task, 'ax')
        prove_ax(task, sensed, tree, expected)
        prove_cell(task, tree, expected)

    try:
        report['ownership'] = backend.call('start')
        require(report['ownership']['profile'] == 'mv-live-1' and
                len(report['ownership']['capsules']) == 1, 'one owned capsule required')
        report['net'] = backend.call('offline_proof')
        require(report['net'].get('fixtures_offline') is True, 'offline fixture proof failed')
        for pack in packs:
            spec = pack.document
            typing_target = None
            task_id, page = spec['name'], spec['start']
            task = dict(task=task_id, verdict='FAIL', steps=0, latency_ms={},
                        observations=[], action_receipts=[], ax_proofs=[])
            report['tasks'].append(task)
            stage(task, 'ownership')
            url = page_url(page, pack)
            task['page'] = dict(file=str(pack.root / 'pages' / (page + '.html')), data_url_length=len(url),
                                source_sha256=hashlib.sha256(fixture(page, pack).encode()).hexdigest())
            require(stage(task, 'offline_proof').get('fixtures_offline') is True,
                    'offline proof before navigation')
            task['fixture_setup'] = stage(task, 'navigate', page=page, url=url, marker=pack.marker)
            # Reads are independent AX checkpoints and never consume proposals.
            # Hold the final proof separately so the independent seal still
            # rejects deleting that proof (the existing AX-skip mutation).
            for goal in spec['steps'][:-1]:
                if goal.startswith('read:'):
                    checkpoint = sense(task)
                    prove_read(task, checkpoint, goal, pack)
                else:
                    step(task, goal)
            final = sense(task)
            region = spec['steps'][-1][5:]
            expected = plan_read(task, final, spec['steps'][-1])
            final_tree = stage(task, 'ax')
            prove_ax(task, final, final_tree, expected)
            prove_cell(task, final_tree, expected)
            seal_task(task, pack)
        report['replay_probe'] = backend.call('replay')
        replay = report['replay_probe']
        require(replay.get('status') == 'PASS' and type(replay.get('corrupt_rc')) is int and
                replay['corrupt_rc'] != 0 and type(replay.get('committed_records')) is int and
                replay['committed_records'] > 0 and
                re.fullmatch(r'[0-9a-f]{64}', replay.get('digest', '')),
                'replay negative control absent')
    except Exception as error:
        report['error'] = dict(code=getattr(error, 'code', 'E2E_WITNESS'), detail=str(error))
    finally:
        try:
            report.update(backend.call('cleanup'))
        except Exception as error:
            report['cleanup_error'] = str(error)
    complete = (not report.get('error') and not report.get('cleanup_error') and
                len(report['tasks']) == len(packs) and all(t['verdict'] == 'PASS' for t in report['tasks']) and
                report.get('container_cleanup') == 'PASS' and
                report.get('process_cleanup', {}).get('temporary_tree_absent') is True and
                report.get('process_cleanup', {}).get('socket_absent') is True and
                report.get('process_cleanup', {}).get('status') == 'PASS' and
                report.get('ram_cleanup', {}).get('ram_absent') is True and
                report.get('ram_cleanup', {}).get('status') == 'PASS' and
                bool(report.get('wire_evidence')))
    report['status'] = 'DONE' if complete else 'BLOCKED'
    report.update(redact(report))
    return 0 if complete else 1


class LiveBackend:
    def __init__(self):
        require(os.environ.get('MV_LIVE_WEB') == '1' and
                os.environ.get('MV_E2E_LIVE') == '1' and
                os.environ.get('MV_SRF_LIVE_PROFILE') == 'mv-live-1',
                'explicit backend live opt-in required', 'E2E_PREREQ')
        for key in REQUIRED_ENV:
            require(bool(os.environ.get(key)), 'missing ' + key, 'E2E_PREREQ')
        sys.path.insert(0, str(ROOT / 'agents'))
        sys.path.insert(0, str(ROOT / 'tools'))
        import gate_g_ai as glue
        import g_ai_stack
        import live
        import stack
        from metaviewer_agents import tools
        self.glue, self.live, self.stack, self.tools = glue, live, stack, tools

        class TimedSession(g_ai_stack.Session):
            def request(session, body, expect, *, timeout_ms):
                # The shared wrapper ignores timeout_ms. Bound the entire wire
                # request here, including unrelated inbound events.
                deadline = time.monotonic() + timeout_ms / 1000
                recv = session.agent.recv
                prior = session.agent._timeout_s

                def bounded_recv():
                    left = deadline - time.monotonic()
                    if left <= 0:
                        raise TimeoutError('live web request deadline exceeded')
                    session.agent._timeout_s = left
                    return recv()

                session.agent.recv = bounded_recv
                session.agent._timeout_s = timeout_ms / 1000
                try:
                    return super().request(body, expect, timeout_ms=timeout_ms)
                finally:
                    session.agent.recv = recv
                    session.agent._timeout_s = prior

        self.session = TimedSession()
        self.adapter = None
        self.pending = {}
        self.observations = {}
        require(not Path(tempfile.gettempdir()).resolve().is_relative_to(ROOT),
                'temporary evidence root must be outside repo', 'E2E_PREREQ')
        self.evidence = Path(tempfile.mkdtemp(prefix='mv-web-evidence-'))
        try:
            self.evidence.chmod(0o700)
        except BaseException:
            shutil.rmtree(self.evidence, ignore_errors=True)
            raise

    def call(self, stage, **args):
        return getattr(self, 'op_' + stage)(**args)

    def op_start(self):
        try:
            return self._start()
        except BaseException:
            try:
                self.op_cleanup()
            finally:
                shutil.rmtree(self.evidence, ignore_errors=True)
            raise

    def _start(self):
        from metaviewer_agents.perception.deps_lock import resolve_locked_component
        from metaviewer_agents.perception.vcore import VCorePerceptionAdapter
        self.roots = {name: resolve_locked_component(name) for name in ('wender-agent', 'vision-engine')}
        require(not self.live.profile_containers('mv-live-1'), 'profile already allocated', 'E2E_PREREQ')
        state = Path(os.environ['MV_SRF_STATE_DIR']).stat()
        require(state.st_uid == os.getuid() and stat.S_IMODE(state.st_mode) == 0o700,
                'state directory must be current-uid mode 0700', 'E2E_PREREQ')
        self.adapter = VCorePerceptionAdapter(self.roots['vision-engine'], timeout=30,
                                             verify_lock=True, pin_python=True,
                                             fallback_oneshot=False)
        # Reuse the public-core verifier and its same-receipt negative controls.
        # No verifier implementation or alternate component ABI is invented.
        configured_verifier = os.environ.get('MV_E2E_VERIFY_BIN')
        try:
            pins = json.loads(os.environ.get('MV_WEB_EXEC_PINS', '{}'))
            require(isinstance(pins, dict), 'executable pins must be an object', 'E2E_PREREQ')
        except ValueError as error:
            raise Failure('invalid executable pins', 'E2E_PREREQ') from error
        self.exec_pins = pins
        if configured_verifier:
            self.verifier = pinned_executable('verifier', configured_verifier, pins)
        else:
            node = pinned_executable('node', os.environ.get('NODE') or shutil.which('node'), pins)
            code = ("const fs=require('node:fs'); const {compileRust}=require(process.argv[1]);"
                    "process.stdout.write(compileRust(process.argv[2],fs.readFileSync(process.argv[3],'utf8')));")
            env = minimal_env()
            require(Path(env.get('CARGO_TARGET_DIR', '')).is_absolute(),
                    'absolute per-worktree CARGO_TARGET_DIR required', 'E2E_PREREQ')
            build = subprocess.run([node, '-e', code,
                                    str(ROOT / 'tests/e2e/core-driver.js'), str(self.evidence),
                                    str(Path(__file__).with_name('verify-receipt.rs'))],
                                   env=env, capture_output=True, text=True, timeout=180)
            require(build.returncode == 0, 'offline receipt verifier build failed: ' + redact(build.stderr[-2000:]),
                    'E2E_PREREQ')
            built = self.evidence / 'driver'
            require(build.stdout.strip() == str(built) and built.is_file() and not built.is_symlink(),
                    'verifier build output escaped custody', 'E2E_PREREQ')
            self.exec_pins = dict(pins, verifier=dict(path=str(built),
                sha256=hashlib.sha256(built.read_bytes()).hexdigest()))
            self.verifier = pinned_executable('verifier', str(built), self.exec_pins)
        start_live_session(self.session)
        return dict(profile='mv-live-1', capsules=self.session.state['capsules'],
                    surface_id=self.session.surface_id)

    def op_offline_proof(self):
        # [TARGET, unit decision] Fixture-only fallback: the pinned CLI has no
        # capsule network-state query (OpenSuperficies a9ac1ac8,
        # cmd/srf-identity-surface/main.go:137-149, 174-185). Operator policy
        # is not exported by that CLI. Never infer native isolation from CSP.
        packs = getattr(self, 'packs', None)
        if packs is None:
            for page in FIXTURE_PINS:
                fixture(page)
        else:
            for pack in packs:
                for page in pack.pages:
                    fixture(page, pack)
        return dict(fixtures_offline=True, scope='pinned fixtures and local data/blob URLs',
                    network='not altered (read-only check unavailable at pin)')

    def op_ownership(self):
        owned = set((self.session.state or {}).get('capsules', []))
        current = self.live.profile_containers('mv-live-1')
        active = self.stack.inventory()
        require(len(owned) == 1 and current == owned and owned <= active,
                'single owned profile capsule no longer proven')
        return dict(profile='mv-live-1', capsules=sorted(owned))

    def retain(self, frame):
        pixels = self.glue.checked_frame(frame).data
        require((self.session.archive / 'artifacts' / frame['sha256']).read_bytes() == pixels,
                'retained core frame differs from live pixels')
        target = self.evidence / (frame['sha256'] + '.rgb')
        private_write(target, pixels)
        return dict(sha256=frame['sha256'], generation=frame['generation'], bytes=len(pixels),
                    surface_id=frame['surface_id'], artifact=str(target))

    def op_observe(self, timeout_ms):
        s = self.session
        s.frame = self.stack.settle_latest_frame(s.ui, s.surface_id, s.frame, s.report)
        obs = self.tools.observe(s.surface_id, client=s, timeout_ms=timeout_ms)
        self.observations[obs['frame_ref']['sha256']] = obs
        return obs

    def op_perceive(self, observed):
        from metaviewer_agents.perception.vcore import project_element_table
        frame = observed['frame_ref']
        vision = self.adapter.perceive(frame)
        observed['vision'] = vision
        self.observations[frame['sha256']] = observed
        return dict(frame=frame, table=project_element_table(frame, vision),
                    frame_witness=self.retain(frame), transport=self.adapter.last_transport)

    def op_state(self, sensed):
        return self.glue.wender_state(self.roots['wender-agent'], sensed['table'], self.op_ax())

    def op_plan(self, sensed, goal):
        from metaviewer_agents.executor import AdmittedExecutor
        from metaviewer_agents.wender_bridge import WenderSubprocessAdapter
        frame, state = sensed['frame'], sensed['state']
        expectation = dict(type='changed_region', bbox=dict(x=0, y=0, w=frame['width'], h=frame['height']))
        kind, value = goal.split(':', 1)
        if kind == 'read':
            expected = sensed.get('read_expected', [])
            require(bool(expected), 'read expectations absent')
            cells = [n.get('name') for n in state['nodes'] if n.get('name') in expected]
            require(cells == expected, 'Wender read plan order mismatch')
            planned = dict(values=cells, state_sha256=digest(state))
            cell = sensed.get('report_cell')
            if cell:
                require(cell['index'] < len(cells), 'reported table cell absent')
                planned.update(row=cell['row'], col=cell['col'], value=cells[cell['index']])
            return planned
        if kind == 'type':
            # The immediately prior verified click focused this custody-bound field.
            require(bool(sensed.get('typing_target')) and
                    any(n.get('name') == sensed['typing_target'] and n['id'] in state['actionable']
                        for n in state['nodes']), 'typing target absent')
            return dict(action=dict(type='type', text=value), expectation=expectation)
        if kind == 'key':
            from automation_pack import PAGE_KEYS
            require(value in PAGE_KEYS, 'key chord is not page-safe', 'E2E_PACK_STEPS')
            return dict(action=dict(type='key', keys=value.split('+')), expectation=expectation)
        if kind == 'scroll':
            return dict(action=dict(type='scroll', dx={'left': -120, 'right': 120}.get(value, 0),
                                    dy={'up': -120, 'down': 120}.get(value, 0)), expectation=expectation)
        require(kind == 'click', 'unsupported pack action', 'E2E_PACK_STEPS')
        configured = os.environ.get('MV_WENDER_PLANNER_CMD')
        if configured:
            planner = WenderSubprocessAdapter(command=planner_command(configured, self.roots['wender-agent']),
                                              wender_root=self.roots['wender-agent'],
                                              timeout=30, verify_lock=True)
            action, expectation, planned, target = planner.plan_step(
                self.observations[frame['sha256']], sensed['table'], 'Click ' + value)
            require(digest(planned) == digest(state), 'planner changed observed state')
            require(target.get('name') == value, 'planner chose wrong task target')
        else:
            targets = [n for n in state['nodes'] if n.get('name') == value and n['id'] in state['actionable']]
            require(len(targets) == 1, 'unique Wender target absent: ' + value)
            target = targets[0]
            x, y, w, h = target['box']
            action = dict(type='click', x=x + w // 2, y=y + h // 2, button='left')
        targets = [n for n in state['nodes'] if n.get('name') == value and n['id'] in state['actionable']]
        require(len(targets) == 1 and target == targets[0], 'unique actionable custody target absent')
        try:
            AdmittedExecutor.check_target(target, latest=state['nodes'], frame=frame)
        except ValueError as error:
            raise Failure('target custody refused') from error
        x, y, w, h = target['box']
        require(action.get('type') == 'click' and action.get('button') == 'left' and
                set(action) == {'type', 'button', 'x', 'y'} and
                type(action.get('x')) is int and type(action.get('y')) is int and
                x <= action['x'] < x + w and y <= action['y'] < y + h,
                'planner click outside custody box')
        # Planner expectations cannot replace the independently bounded witness.
        expectation = dict(type='changed_region', bbox=dict(x=0, y=0, w=frame['width'], h=frame['height']))
        return dict(action=action, expectation=expectation)

    def op_propose(self, sensed, plan, max_ms):
        from metaviewer_agents.verify import build_proposal
        proposal = build_proposal(sensed['frame'], proposal_id='asm-web-' + uuid.uuid4().hex,
                                  action=plan['action'], expectation=plan['expectation'], max_ms=max_ms)
        self.op_ownership()
        require(self.op_offline_proof().get('fixtures_offline') is True, 'offline fixture proof failed')
        try:
            verdict = self.tools.propose(proposal, client=self.session, timeout_ms=max_ms)
        except self.tools.ToolRefusal as error:
            raise Failure(str(error), error.reason_code) from error
        receipt = self.session.receive(self.session.agent, lambda b:
                                       b.get('schema') == 'action_receipt/v0.2' and
                                       b.get('proposal_id') == proposal['proposal_id'])
        evidence = receipt_evidence(receipt)
        self.pending[proposal['proposal_id']] = (proposal, sensed['frame'], receipt)
        return dict(proposal_id=proposal['proposal_id'], verdict=verdict,
                    native_evidence=evidence)

    def op_wait_verify(self, admitted, timeout_ms):
        proposal, before, native = self.pending.pop(admitted['proposal_id'])
        receipt = self.tools.wait_verify(proposal['proposal_id'], proposal['expectation'], timeout_ms,
                                         client=self.session, surface_id=self.session.surface_id)
        require(receipt.get('input_mono_ns') == native['native_evidence']['input_mono_ns'],
                'native input clock differs')
        self.retain(receipt['after_frame'])
        context = self.evidence / (proposal['proposal_id'] + '.json')
        private_write(context, json.dumps(dict(proposal=proposal, before=before, receipt=native)))
        verifier = pinned_executable('verifier', self.verifier, self.exec_pins)
        check = subprocess.run([verifier, str(context), str(self.session.archive / 'artifacts')],
                               env=minimal_env(), capture_output=True, text=True, timeout=30)
        require(check.returncode == 0, 'same-receipt binding negative control failed: ' + redact(check.stderr[-2000:]))
        negative = json.loads(check.stdout)
        require(negative.get('status') == 'PASS' and negative['baseline']['verified'] is True and
                negative['different_surface']['verified'] is False and
                negative['stale_generation']['verified'] is False,
                'receipt binding negative control accepted')
        return dict(status='verified', receipt=dict(receipt), focus_verified=receipt.get('focus_verified'),
                    input_mono_ns=receipt.get('input_mono_ns'), frame_sha256=receipt.get('frame_sha256'),
                    receipt_binding_negative_control=negative['status'], verify_negative_control=negative)

    @staticmethod
    def prelude_point(frame):
        # [TARGET, unit decision] Restrict setup to the lower-left content
        # quadrant. This excludes the toolbar and the upper-right restore bubble
        # observed in the operator's frame; never dismiss that bubble here.
        width, height = frame['width'], frame['height']
        require(type(width) is int and type(height) is int and width >= 4 and height >= 4,
                'prelude frame geometry invalid')
        return dict(type='click', x=width // 4, y=3 * height // 4, button='left')

    @staticmethod
    def check_prelude(frame, action):
        width, height = frame['width'], frame['height']
        require('click' == action.get('type') and action.get('button') == 'left' and
                type(action.get('x')) is int and type(action.get('y')) is int and
                0 < action['x'] < width // 2 and height // 2 < action['y'] < height,
                'prelude outside safe content geometry')

    def op_navigate(self, page, url, marker=None):
        setup = []
        # Match both URL and marker to an admitted pack snapshot.
        packs = getattr(self, 'packs', None)
        if packs is None:  # Direct built-in unit probes use the same fixture pins.
            require(url == page_url(page), 'navigation outside pinned local fixture')
            marker = marker or {'form': 'EMPTY', 'flow_a': 'FLOW_STAGE_A_READY',
                                'table': 'auth-gateway'}[page]
        else:
            require(any(page in pack.pages and url == page_url(page, pack) and
                        marker == pack.marker for pack in packs),
                    'navigation outside pinned local fixture')
        require(self.op_offline_proof().get('fixtures_offline') is True, 'offline proof before navigation')
        before = self.op_observe(5000)['frame_ref']
        # Removing omnibox selection changes browser chrome even when page
        # pixels are blank. Keep changed_region fail-closed for this input too;
        # native AX is not used as an unproven alternate focus-state ABI.
        for index, action in enumerate([self.prelude_point(before),
                       dict(type='key', keys=['ctrl', 'l']),
                       # Python str slices preserve Unicode code points (srf runes).
                       *[dict(type='type', text=url[offset:offset + TYPE_TEXT_CAP])
                         for offset in range(0, len(url), TYPE_TEXT_CAP)],
                       dict(type='key', keys=['Return'])]):
            for attempt in range(3):
                obs = self.op_observe(5000)
                frame = obs['frame_ref']
                if index == 0 and action.get('type') == 'click':
                    self.check_prelude(frame, action)
                plan = dict(action=action, expectation=dict(type='changed_region', bbox=dict(
                    x=0, y=0, w=frame['width'], h=frame['height'])))
                try:
                    admitted = self.op_propose(dict(frame=frame), plan, 30000)
                except Failure as error:
                    if error.code == 'STALE_FRAME' and attempt < 2:
                        continue
                    raise
                verified = self.op_wait_verify(admitted, 30000)
                setup.append(dict(kind='focus_prelude' if index == 0 else 'navigation',
                                  verdict=admitted['verdict'], verify_verdict=verified))
                break
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            after = self.op_observe(5000)['frame_ref']
            if after['sha256'] != before['sha256'] and marker in texts(self.op_ax()):
                return setup
            time.sleep(0.05)
        raise Failure('fixture navigation did not produce pixels and AX marker')

    def op_ax(self):
        return self.session.native_tree()

    def op_replay(self):
        self.op_observe(5000)  # Completed observe barrier, then freeze owned writers.
        stopped = []
        try:
            for proc in self.session.processes:
                proc.send_signal(signal.SIGSTOP)
                stopped.append(proc)
            self.live.replay_probe(self.session.report, self.session.archive,
                                   os.environ['MV_E2E_REPLAY_BIN'], self.session.work)
            # Preserve journal and retained artifacts before removing runtime state.
            shutil.copytree(self.session.archive, self.evidence / 'archive')
        finally:
            resume_errors = []
            for proc in stopped:
                try:
                    proc.send_signal(signal.SIGCONT)
                except Exception as error:
                    resume_errors.append(redact(str(error)))
            require(not resume_errors, 'writer resume failed: ' + repr(resume_errors))
        return self.session.report['replay_probe']

    def op_cleanup(self):
        # Deliberately do not call Session.__exit__/stack.cleanup: those union
        # profile-wide containers into ownership. Only this create's names qualify.
        if hasattr(self, '_cleanup_result'):
            return self._cleanup_result
        errors = []

        def attempt(label, action):
            try:
                return action()
            except Exception as error:
                errors.append(label + ': ' + str(error))
                return None

        perception_process = getattr(self.adapter, '_vserve_proc', None)
        if self.adapter is not None:
            attempt('perception', self.adapter.close)
        s = self.session
        owned = set((s.state or {}).get('capsules', []))
        for peer in s.peers:
            attempt('peer', peer.close)
        if s.state:
            attempt('process inventory', lambda: self.stack.remember_tree(s.state, s.root))
        inventory = attempt('container inventory', self.stack.inventory)
        for name in sorted(owned):
            if not self.live.CAPSULE_ID_RE.fullmatch(name):
                errors.append('unsafe capsule cleanup name')
                continue
            for retry in range(2):
                try:
                    self.stack.checked([
                        Path(os.environ['MV_SRF_BIN_DIR']) / 'srf-identity-surface',
                        'stop', '--container', name, '--state-dir', os.environ['MV_SRF_STATE_DIR']])
                    break
                except Exception as error:
                    if retry == 1:
                        errors.append('capsule stop: ' + str(error))
        if s.state:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                for row in reversed(s.state['pids']):
                    attempt('process stop', lambda: self.stack.signal_record(row, sig))
                deadline = time.monotonic() + 5
                while any(self.stack.alive(r) for r in s.state['pids']) and time.monotonic() < deadline:
                    time.sleep(0.05)
            for proc in s.processes:
                attempt('process wait', lambda: proc.wait(timeout=10))
        processes_absent = (not s.state or not any(self.stack.alive(r) for r in s.state['pids']))
        processes_absent = processes_absent and (perception_process is None or perception_process.poll() is not None)
        active = attempt('final container inventory', self.stack.inventory)
        foreign = attempt('foreign profile inventory', lambda: self.live.profile_containers('mv-live-1') - owned)
        if foreign:
            errors.append('foreign profile capsules remain: ' + repr(sorted(foreign)))
        container_absent = active is not None and not owned & active and foreign == set()
        ram = None
        if active is not None:
            ram = attempt('RAM', lambda: self.live.cleanup_capsule_ram(
                Path(os.environ['MV_SRF_LIVE_RAM_ROOT']), owned,
                (s.state or {}).get('published', []), active))
        if s.temp is not None:
            socket = s.work / 'runtime/metaviewer/core.sock'
            if s.root.exists():
                attempt('forensics', lambda: shutil.copytree(s.root, self.evidence / 'runtime-forensics',
                    ignore=lambda directory, names: [n for n in names
                        if not (Path(directory) / n).is_file() and not (Path(directory) / n).is_dir()
                        or (Path(directory) / n).is_symlink()]))
            attempt('temporary tree', s.temp.cleanup)
            absent, socket_absent = not s.root.exists(), not socket.exists()
        else:
            absent = socket_absent = True
        wire = redact(s.report.get('wire_evidence', []))
        private_write(self.evidence / 'wire.json', json.dumps(wire))
        # Copied archives/logs inherit no public permissions from source trees.
        for directory, dirs, files in os.walk(self.evidence):
            Path(directory).chmod(0o700)
            for name in files:
                (Path(directory) / name).chmod(0o600)
        self._cleanup_result = redact(dict(container_cleanup='PASS' if container_absent else 'FAIL',
                    cleanup_errors=errors, foreign_capsules=sorted(foreign) if foreign is not None else None,
                    process_cleanup=dict(status='PASS' if absent and socket_absent and processes_absent and not errors else 'FAIL',
                    temporary_tree_absent=absent, socket_absent=socket_absent),
                    ram_cleanup=ram or dict(status='FAIL', ram_absent=False),
                    wire_evidence=wire, evidence_directory=str(self.evidence)))
        # Keep the private destination internally; publication scrubs its path.
        self._cleanup_result['evidence_directory'] = str(self.evidence)
        return self._cleanup_result


def run_memoryweb(backend, report, corpus):
    from metaviewer_agents.mw_owner import ReplayOwner
    evidence = getattr(backend, 'evidence', None)
    if evidence is None:
        evidence = Path(tempfile.mkdtemp(prefix='mv-mw-evidence-'))
        os.chmod(evidence, 0o700)
        backend.evidence = evidence
    notice = dict(mode='replay', network='offline fixtures', acknowledged=True,
                  mono_ns=time.monotonic_ns())
    owner = ReplayOwner(backend, corpus, evidence / 'memoryweb-run.json', notice=notice)
    owner.validate_corpus()
    pages = corpus.workflow['evaluation_profile']['fixture_ids']
    require(len(pages) == 1 and pages[0] in FIXTURE_PINS,
            'MemoryWeb replay requires one pinned built-in fixture', 'MW_FIXTURE')
    page = pages[0]
    starts = [pack for pack in backend.packs if pack.document['start'] == page]
    require(len(starts) == 1, 'MemoryWeb fixture has no unique pinned start', 'MW_FIXTURE')
    private_write(evidence / 'memoryweb-notice.json', json.dumps(notice, sort_keys=True))
    try:
        report['net'] = owner.check_network()
        report['ownership'] = backend.call('start')
        require(report['ownership'].get('profile') == 'mv-live-1' and
                len(report['ownership'].get('capsules', [])) == 1, 'one owned capsule required')
        owner.check_network()
        report['fixture_setup'] = backend.call('navigate', page=page, url=page_url(page, starts[0]),
                                               marker=starts[0].marker)
        result = owner.run()
        summary_schema_validated = False
        if result.summary is not None:
            emitted = corpus.gate.strict_load(owner.output.read_bytes())
            summary_schema_validated = (emitted == result.summary and corpus.gate.conforms(
                emitted, corpus.schemas['run'], corpus.bundle['$defs']))
            require(summary_schema_validated, 'MemoryWeb run summary schema failed', 'MW_RUN_SCHEMA')
        report['memoryweb'] = dict(rc=result.rc, verdict_code=result.verdict_code,
                                   summary_schema_validated=summary_schema_validated,
                                   summary=result.summary, receipts=owner.receipts,
                                   summary_file=str(owner.output))
        require(result.rc == 0 and result.summary is not None and owner.output.is_file(),
                'MemoryWeb replay refused: ' + result.verdict_code, 'MW_RUN')
        report['replay_probe'] = backend.call('replay')
        replay = report['replay_probe']
        require(replay.get('status') == 'PASS' and type(replay.get('corrupt_rc')) is int and
                replay['corrupt_rc'] != 0 and type(replay.get('committed_records')) is int and
                replay['committed_records'] > 0 and
                re.fullmatch(r'[0-9a-f]{64}', replay.get('digest', '')), 'replay proof absent')
    except Exception as error:
        report['error'] = dict(code=getattr(error, 'code', 'MW_RUN'), detail=str(error))
    finally:
        try:
            report.update(backend.call('cleanup'))
        except Exception as error:
            report['cleanup_error'] = str(error)
        owner.dispatch.close()
    complete = (not report.get('error') and not report.get('cleanup_error') and
                report.get('container_cleanup') == 'PASS' and
                report.get('process_cleanup', {}).get('status') == 'PASS' and
                report.get('process_cleanup', {}).get('temporary_tree_absent') is True and
                report.get('process_cleanup', {}).get('socket_absent') is True and
                report.get('ram_cleanup', {}).get('status') == 'PASS' and
                report.get('ram_cleanup', {}).get('ram_absent') is True and bool(report.get('wire_evidence')))
    report['status'] = 'DONE' if complete else 'BLOCKED'
    return 0 if complete else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hosted-rpc', action='store_true')
    parser.add_argument('--pack', action='append', default=[])
    parser.add_argument('--mw-root', type=Path)
    parser.add_argument('--mw-workflow')
    options = parser.parse_args()
    hosted = options.hosted_rpc
    if not hosted and os.environ.get('MV_LIVE_WEB') != '1':
        print(json.dumps(dict(status='SKIPPED', reason='MV_LIVE_WEB=1 required')))
        return 0
    report = dict(schema='metaviewer.asm-web-live/v1', mode='hosted' if hosted else 'live', tasks=[])
    backend = None
    try:
        if not hosted:
            require(os.environ.get('MV_E2E_LIVE') == '1' and
                    os.environ.get('MV_SRF_LIVE_PROFILE') == 'mv-live-1',
                    'explicit live gate and mv-live-1 identity required', 'E2E_PREREQ')
            for key in REQUIRED_ENV:
                require(bool(os.environ.get(key)), 'missing ' + key, 'E2E_PREREQ')
        require(bool(options.mw_root) == bool(options.mw_workflow),
                '--mw-root and --mw-workflow are required together', 'MW_SELECTOR')
        corpus = None
        if options.mw_root:
            sys.path.insert(0, str(ROOT / 'agents'))
            from metaviewer_agents.mw_owner import Corpus
            corpus = Corpus(options.mw_root, options.mw_workflow)
        packs = load_packs(options.pack, os.environ.get('MV_AUTOMATIONS_DIR'))
        backend = HostedRPC() if hosted else LiveBackend()
        backend.packs = packs
        rc = run_memoryweb(backend, report, corpus) if corpus else run(backend, report)
    except Exception as error:
        report.update(status='BLOCKED', error=dict(code=getattr(error, 'code', 'E2E_PREREQ'), detail=str(error)))
        rc = 1
    evidence = getattr(backend, 'evidence', None)
    if not hosted and evidence is not None and evidence.is_dir():
        target = evidence / 'report.json'
        report['report_file'] = str(target)
        try:
            private_write(target, json.dumps(redact(report), sort_keys=True))
        except Exception as error:
            report.update(status='BLOCKED', persistence_error=redact(str(error)))
            rc = 1
    report = redact(report)
    print(json.dumps(dict(report=report) if hosted else report, sort_keys=True), flush=True)
    return rc


if __name__ == '__main__':
    sys.exit(main())
