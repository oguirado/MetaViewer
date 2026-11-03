"""Goal-driven browser actions through native AX and the existing core path.

[TARGET, unit decision] Steps bound admitted actions, not goal completion.
Explicit text consumes focus then type, with exact native readback before an
optional Enter. AX marks for Muse are geometry annotations, not vision evidence.
No stored workflow, planner text, or score fallback authorizes input.
"""
import json
import os
from pathlib import Path
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'agents'))
sys.path.insert(0, str(ROOT / 'tools'))
import mw_run_backend as host
from mw_run_program import (atomic_journal, marks_workspace, private_evidence_base,
                            remaining_budget, require_click_target,
                            require_grounded_goal, validate_request, MuseProgramPlanner,
                            wait_for_publication)
from metaviewer_agents.observe import build_observation
from metaviewer_agents.mw_handoff import HandoffLatch
from metaviewer_agents.mw_refusals import refusal_sentence
from metaviewer_agents.wender_bridge import WenderSubprocessAdapter, detect_stopstate


class BrowserGoalBackend(host.HostBackend):
    compiled_wender_ok = True  # planning goes through WenderSubprocessAdapter and the model entry.
    eager_slot_text = False  # Only the chosen text target requires exact readback.
    agent_control_required = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # A compiled runtime directory holds its own extension modules: never import from it.
        from metaviewer_agents.perception.compiled import compiled_executable
        if compiled_executable('wender-agent', root=self.wender) is None:
            sys.path.insert(0, str(self.wender))
        self.handoff = HandoffLatch(self.evidence / 'browser-goal.handoff.json',
                                    detector=detect_stopstate)
        self.moves, self.attempts, self.program_observations = [], [], []

    def guard_wall(self, observed, sensed):
        # Same absorbing detector as the stored owner; before every input stage.
        observed = dict(observed)
        window = observed.get('ax_snapshot', {}).get('window', sensed.get('window', {}))
        if isinstance(window, dict) and isinstance(window.get('url'), str):
            observed.setdefault('url', window['url'])
        wall = host.wall_kind(dict(elements=sensed.get('ax', [])))
        if wall:
            observed['observed_wall'] = dict(observed=True, kind=wall)
        if self.handoff.inspect(dict(sensed, observed=observed), len(self.moves),
                                host.ReplayOwner.write):
            raise host.OwnerRefused('MW_HANDOFF_REQUIRED')

    def observe(self, timeout_ms):
        # [TARGET, unit decision] AX first, then the mandatory core pixels.
        # Native text-of can span a caret phase. Do not age the pixel baseline
        # during that read; rebind still compares native state and final pixels.
        tree = self.ax()
        observed = dict(host.tools.observe(self.surface_id, client=self.client, timeout_ms=timeout_ms),
                        ax_snapshot=tree)
        self.guard_wall(observed, dict(frame=observed['frame_ref'],
                                      ax=observed['ax_snapshot']['elements']))
        return observed

    def keepalive_observe(self, timeout_ms):
        # Session maintenance during the model wait: no AX read and no authority.
        # The full observe and rebind still gate every proposal.
        observed = host.tools.observe(self.surface_id, client=self.client, timeout_ms=timeout_ms)
        host.need(observed['frame_ref']['surface_id'] == self.surface_id, 'MW_BROWSER_GOAL_SURFACE')
        return observed

    def observe_for_rebind(self, timeout_ms):
        return self.observe(timeout_ms)

    def slot_text(self, row):
        # Readback can outlive its first observation. Fence every native text
        # sample against takeover without repeating any input.
        self.ownership()
        return super().slot_text(row)

    def perceive(self, observed):
        sensed = super().perceive(observed)
        self.guard_wall(observed, sensed)
        frame = sensed['frame']
        host.need(frame['surface_id'] == self.surface_id, 'MW_BROWSER_SURFACE')
        return sensed

    def rebind(self, sensed, plan, remaining):
        fresh = super().rebind(sensed, plan, remaining)
        self.guard_wall(dict(ax_snapshot=dict(elements=fresh['ax'])), fresh)
        return fresh

    def before_propose(self, proposal, sensed):
        self.active_attempt['dispatch_artifact'] = atomic_journal(
            self.evidence / ('dispatch-' + proposal['proposal_id'] + '.json'),
            dict(status='pending_dispatch', proposal=proposal, frame=sensed['frame'],
                 intent_artifact=self.active_attempt['intent_artifact']))
        self.active_attempt['status'] = 'dispatch_pending'


def planning_view(backend, sensed):
    # Planning alone needs Wender state. Keep native rebind on its original
    # AX/pixel path, without another planner subprocess inside the input gate.
    state = backend.state_for(sensed)
    elements = []
    for node in state['nodes']:
        if node['id'] not in state['actionable'] or node.get('actionable') is not True:
            continue
        box = node.get('box')
        host.need(isinstance(box, list) and len(box) == 4, 'MW_BROWSER_AX_BOX')
        elements.append(dict(bbox=dict(zip(('x', 'y', 'w', 'h'), box)),
                             name=node['name'], role=node['role'], score_ppm=1000000))
    host.need(bool(elements), 'MW_BROWSER_NO_TARGETS')
    frame = sensed['frame']
    return dict(sensed, state=state, table=dict(sensed['table'], elements=elements),
                observation=build_observation(frame, surface_id=backend.surface_id,
                                              generation=frame['generation']))


def focused_target(sensed, target):
    rows = [r for r in sensed['ax'] if r.get('focused') is True or
            r.get('states', {}).get('focused') in (True, 'true')]
    host.need(len(rows) == 1, 'MW_BROWSER_FOCUS')
    row = rows[0]
    host.need(row.get('role') in ('textbox', 'combobox') and bool(row.get('id')) and
              row.get('id') == target.get('native_editor_id') and
              all(row.get(k) == target.get(k) for k in ('name', 'role', 'box')),
              'MW_BROWSER_FOCUS')
    return row


def exact_readback(backend, sensed, target, text):
    # [TARGET, unit decision] Poll only stale content within the remaining run
    # budget. Every sample reacquires wall/focus/identity; never repeat input.
    deadline = time.monotonic_ns() + remaining_budget(backend, 1000) * 1_000_000
    while True:
        row = focused_target(sensed, target)
        value = backend.slot_text(row)  # Always ax --text-of, even if AX has value.
        if value == text and row.get('value_len') == len(text):
            return dict(status='exact_native_readback', editor_id=row['id'],
                        code_points=len(value), bytes=len(value.encode('utf-8')))
        host.need(time.monotonic_ns() < deadline, 'MW_BROWSER_TEXT_MISMATCH')
        time.sleep(min(0.05, max(0, (deadline - time.monotonic_ns()) / 1e9)))
        sensed = backend.perceive(backend.observe(remaining_budget(backend,
            max(1, (deadline - time.monotonic_ns()) // 1_000_000))))


def annotate_ax(backend, sensed, marks_path):
    """Render AX rectangles and decimal IDs on retained pixels in private RAM."""
    from metaviewer_agents.perception.base import Frame
    from metaviewer_agents.perception.vcore import _png_bytes
    frame = sensed['frame']
    pixels = bytearray(Path(sensed['frame_witness']['artifact']).read_bytes())
    host.need(host.hashlib.sha256(pixels).hexdigest() == frame['sha256'], 'MW_FRAME_BINDING')
    width, height = frame['width'], frame['height']
    def dot(x, y):
        if 0 <= x < width and 0 <= y < height:
            offset = (y * width + x) * 3
            pixels[offset:offset+3] = b'\xff\x00\x00'
    glyphs = ('111101101101111', '010110010010111', '111001111100111',
              '111001111001111', '101101111001001', '111100111001111',
              '111100111101111', '111001001001001', '111101111101111',
              '111101111001111')
    marks = []
    host.need(len(sensed['table']['elements']) <= 24, 'MW_BROWSER_MODEL_MARK_LIMIT')
    for index, row in enumerate(sensed['table']['elements'], 1):
        box = row['bbox']
        x, y, w, h = (box[k] for k in ('x', 'y', 'w', 'h'))
        for dx in range(w):
            dot(x+dx, y)
            dot(x+dx, y+h-1)
        for dy in range(h):
            dot(x, y+dy)
            dot(x+w-1, y+dy)
        for place, digit in enumerate(str(index)):
            for bit, on in enumerate(glyphs[int(digit)]):
                if on == '1':
                    dot(x+2+place*4+bit%3, y+2+bit//3)
        marks.append(dict(id=index, kind=row['role'], ocr_text=row['name'], **box))
    marks_path.write_bytes(_png_bytes(Frame(width, height, bytes(pixels))))
    marks_path.chmod(0o600)
    c2 = dict(schema='ve.cu_describe/v1', frame_sha256=frame['sha256'],
              width=width, height=height, marks=marks, marks_png=str(marks_path))
    backend.program_observations.append(dict(frame=frame, c2=c2,
        frame_witness=sensed['frame_witness'], source='native_ax_annotations'))


def terminal_failure(backend, attempt, action, error, journal_id):
    # [TARGET, unit decision] The core's explicit terminal failure settles the
    # attempt for every action kind and both reply paths. Timeouts do not.
    body = error.receipt
    if isinstance(body, dict) and body.get('code') == 'VERIFICATION_FAILED':
        settled = dict(attempt, status=('key_effect_unverified' if action['type'] == 'key'
                                       else 'effect_unverified'),
                       delivery_verified=None, effect_verified=False, settlement=body)
        artifact = atomic_journal(backend.evidence / ('receipt-' + journal_id + '.json'), settled)
        attempt.update(settled, receipt_artifact=artifact)
        raise host.OwnerRefused('MW_PROGRAM_NO_VISIBLE_EFFECT') from error
    raise error


def run_moves(backend, planner, args, marks_path=None):
    validate_request(args.goal, args.steps, args.timeout_ms)
    text, key = getattr(args, 'text', None), getattr(args, 'key', None)
    host.need(text is None or (isinstance(text, str) and bool(text) and
              len(text.encode('utf-8')) <= 65536), 'MW_BROWSER_TEXT')
    host.need(key in (None, 'Enter') and (key is None or text is not None), 'MW_BROWSER_KEY')
    host.need(text is None or args.steps >= (3 if key else 2), 'MW_BROWSER_STEPS')
    target = None
    for index in range(args.steps if text is None else (3 if key else 2)):
        if backend.moves:
            baseline = backend.observe(remaining_budget(backend, args.timeout_ms))['frame_ref']
            backend.client.subscribe_frames(backend.surface_id,
                timeout_ms=remaining_budget(backend, args.timeout_ms))
            observed = wait_for_publication(backend, baseline['generation'],
                                            remaining_budget(backend, args.timeout_ms))
        else:
            observed = backend.observe(remaining_budget(backend, args.timeout_ms))
        sensed = backend.perceive(observed)
        if index == 0 or text is None:
            sensed = planning_view(backend, sensed)
            if isinstance(planner, MuseProgramPlanner):
                annotate_ax(backend, sensed, marks_path)
            action, expectation, state, target = planner.plan_step(
                sensed['observation'], sensed['table'], args.goal)
            selected = planner.grounded_goal if isinstance(planner, MuseProgramPlanner) else args.goal
            require_grounded_goal(sensed['table'], selected, target)
            require_click_target(action, target)
            if text is not None:
                host.need(target.get('role') in ('textbox', 'combobox'), 'MW_BROWSER_FOCUS')
                native = [r for r in sensed['ax'] if all(r.get(k) == target.get(k)
                          for k in ('name', 'role', 'box'))]
                host.need(len(native) == 1 and bool(native[0].get('id')), 'MW_BROWSER_FOCUS')
                target = dict(target, native_editor_id=native[0]['id'])
        else:
            focused_target(sensed, target)
            action = dict(type='type', text=text) if index == 1 else dict(type='key', keys=['Return'])
            if index == 2:
                exact_readback(backend, sensed, target, text)
            frame = sensed['frame']
            expectation = dict(type='changed_region', bbox=dict(x=0, y=0,
                                w=frame['width'], h=frame['height']))
        journal_id = uuid.uuid4().hex
        attempt = dict(status='intent_recording', action_kind=action['type'], target=target)
        backend.attempts.append(attempt)
        attempt['intent_artifact'] = atomic_journal(backend.evidence / ('intent-' + journal_id + '.json'),
            dict(goal=args.goal, action=action, expectation=expectation,
                 target=target, frame=sensed['frame'], source='invocation' if text else 'grounded_goal'))
        backend.active_attempt = attempt
        attempt['status'] = 'binding_pending'
        start = len(getattr(backend, 'frame_attempts', []))
        try:
            admitted = backend.propose(sensed, dict(action=action, expectation=expectation),
                                        remaining_budget(backend, args.timeout_ms))
        except host.tools.VerificationFailed as error:
            terminal_failure(backend, attempt, action, error, journal_id)
        except host.tools.ToolRefusal as error:
            rows = getattr(backend, 'frame_attempts', [])
            if rows and rows[-1].get('status') == error.reason_code:
                attempt['status'] = 'refused_before_execution'
                attempt['reason_code'] = error.reason_code
            raise
        except host.OwnerRefused:
            rows = getattr(backend, 'frame_attempts', [])[start:]
            if rows and all(row.get('status') == 'STALE_FRAME' or
                            (row.get('submitted') is False and
                             row.get('status') == 'MW_REBIND_PIXELS') for row in rows):
                attempt['status'] = 'refused_before_execution'
            raise
        attempt['status'] = 'settlement_pending'
        try:
            verified = backend.wait_verify(admitted, remaining_budget(backend, args.timeout_ms))
        except host.tools.VerificationFailed as error:
            terminal_failure(backend, attempt, action, error, journal_id)
        move = dict(action=action, target=target, verification=verified)
        # Persist native settlement BEFORE readback; failure cannot erase input.
        attempt['receipt_artifact'] = atomic_journal(
            backend.evidence / ('receipt-' + journal_id + '.json'), move)
        attempt['status'] = 'verified_move'
        backend.moves.append(move)
        if action['type'] == 'type':
            after = backend.perceive(backend.observe(remaining_budget(backend, args.timeout_ms)))
            move['text_gate'] = exact_readback(backend, after, target, text)
            attempt['readback_artifact'] = atomic_journal(
                backend.evidence / ('readback-' + journal_id + '.json'), move['text_gate'])
    return backend.moves


def run_entry(args):
    result = dict(schema='metaviewer.mw_run/v1', rc=6, verdict_code='MW_BROWSER_GOAL_CONFIG',
                  receipt=None, report=None)
    evidence, backend, message = None, None, None
    try:
        validate_request(args.goal, args.steps, args.timeout_ms)
        host.need(args.planner in ('rules', 'muse') and
                  type(args.model_timeout_ms) is int and 1 <= args.model_timeout_ms <= 240000,
                  'MW_BROWSER_PLANNER')
        evidence = private_evidence_base() / 'metaviewer/runs' / uuid.uuid4().hex
        for path in (evidence.parent.parent, evidence.parent, evidence):
            path.mkdir(mode=0o700, exist_ok=True)
            host.need(not any(p.is_symlink() for p in (path, *path.parents)) and
                      path.stat().st_uid == os.getuid() and
                      host.stat.S_IMODE(path.stat().st_mode) == 0o700, 'MW_PRIVATE_OUTPUT')
        result['report'] = str(evidence / 'report.json')
        with host.connect(os.environ) as client:
            backend = BrowserGoalBackend(client, args.identity, evidence, os.environ)
            from metaviewer_agents.mw_run import resolve_wall_deadline_s
            backend.run_deadline_ns = min(getattr(args, 'wall_deadline_mono_ns',
                time.monotonic_ns() + int(resolve_wall_deadline_s(args)*1e9)),
                time.monotonic_ns() + int(resolve_wall_deadline_s(args)*1e9)) - 5_000_000_000
            backend.observe(remaining_budget(backend, args.timeout_ms))
            client.subscribe_frames(backend.surface_id,
                timeout_ms=remaining_budget(backend, args.timeout_ms))
            planner = WenderSubprocessAdapter(wender_root=backend.wender,
                timeout=args.timeout_ms/1000, verify_lock=True)
            with marks_workspace() as marks:
                if args.planner == 'muse':
                    planner = MuseProgramPlanner(backend, planner, args.model_timeout_ms)
                moves = run_moves(backend, planner, args, marks)
        result.update(rc=0, verdict_code='BROWSER_BOUNDED_ACTIONS_VERIFIED',
                      receipt=atomic_journal(evidence / 'moves.json', moves))
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, AttributeError,
            host.ClientError, host.tools.ToolRefusal, host.tools.VerificationFailed,
            host.subprocess.SubprocessError) as error:
        code = getattr(error, 'code', getattr(error, 'reason_code', 'MW_BROWSER_GOAL_CONFIG'))
        message = str(error)
        if code in ('SURFACE_NOT_AGENT_CONTROLLED', 'MW_PROGRAM_CONTROL'):
            code, message = 'MW_PROGRAM_CONTROL', refusal_sentence('MW_PROGRAM_CONTROL')
        elif isinstance(error, host.subprocess.TimeoutExpired):
            code, message = 'MW_RUN_NATIVE', 'native discovery command timed out'
        elif isinstance(error, host.ClientError) and error.code == 'busy':
            code, message = error.code, str(error)
        elif isinstance(error, host.ClientError):
            code, message = 'MW_RUN_CORE', (f'core connection failed ({error.code}: {error}); '
                'is this the running MetaViewer core?')
        elif isinstance(error, host.DependencyLockError):
            code, message = 'MW_DEPENDENCY', (f'{error.code}: {error.message}; set MV_WENDER_ROOT '
                'to the wender-agent checkout at its deps.lock commit')
        elif code == 'MW_PROGRAM_MODEL_TIMEOUT':
            message = 'model planning budget expired before dispatch; retry or use the rules planner'
        result.update(verdict_code=code)
        if code == 'MW_HANDOFF_REQUIRED':
            result.update(rc=4, verdict_code='HUMAN_HANDOFF',
                          receipt=str(backend.handoff.path) if backend.handoff.latched and
                          backend.handoff.persisted is not False else None)
        elif any(a['status'] in ('dispatch_pending', 'settlement_pending')
                 for a in getattr(backend, 'attempts', [])):
            result.update(rc=5, verdict_code='INPUT_UNCERTAIN')
            if code == 'MW_PROGRAM_MODEL_TIMEOUT':
                message = ('model planning budget expired with input pending; do not retry; '
                           'inspect the capsule and settle the pending input first')
        message = message[:4096]
        print('mw_run_browser_goal: ' + message, file=sys.stderr)
    if evidence is not None and evidence.is_dir():
        try:
            atomic_journal(evidence / 'report.json', dict(result, goal_completed=None,
                moves=getattr(backend, 'moves', []), attempts=getattr(backend, 'attempts', []),
                frame_attempts=getattr(backend, 'frame_attempts', []), message=message,
                handoff_persistence=('failed' if getattr(getattr(backend, 'handoff', None),
                    'persisted', None) is False else 'persisted' if
                    getattr(getattr(backend, 'handoff', None), 'persisted', None) is True else None),
                vision_crosscheck='not_performed', model_reading='commentary_only'))
        except OSError:
            if result['verdict_code'] == 'HUMAN_HANDOFF':
                result['report'] = None
            else:
                result.update(rc=5 if getattr(backend, 'moves', []) else 6,
                              verdict_code='MW_PRIVATE_OUTPUT', receipt=None)
    print(json.dumps(result))
    return result['rc']
