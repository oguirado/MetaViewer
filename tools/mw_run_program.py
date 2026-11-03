"""Bounded visual program actions through the existing core admission pipeline.

[TARGET, unit decision] A successful invocation proves verified moves only;
it never claims that the requested goal or game has been completed. Program
capsules use the frozen desktop_capsule wire kind and native program custody.
No browser URL, CDP or AX acquisition is required.
[TARGET, unit decision] Click effects use the whole surface, excluding clock
marks identified before dispatch. Text uses a verified field focus click or
explicit operator-asserted current focus; OCR absence is explicitly uncertified.
"""
import argparse
from contextlib import contextmanager
import copy
from difflib import SequenceMatcher
import json
import os
import re
import stat
import selectors
import signal
import subprocess
from pathlib import Path
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'agents'))
sys.path.insert(0, str(ROOT / 'tools'))
import mw_run_backend as host
from metaviewer_agents.mw_refusals import refusal_sentence
from metaviewer_agents.observe import build_observation
from metaviewer_agents.perception.vcore import VCorePerceptionAdapter, project_element_table
from metaviewer_agents.wender_bridge import WenderSubprocessAdapter


MODEL_CLICK_MIN_CONFIDENCE = 0.4  # [MEASURED, 40 live replies] wrong 0.35, lowest correct 0.45


class ProgramModelReplyRejected(RuntimeError):
    """A model reply was rejected before any proposal could exist."""

    def __init__(self, code, message):
        self.code = code
        super().__init__(code + ": " + message)


class ProgramObservationChanged(RuntimeError):
    """A valid newer observation rejected rebind before any proposal exists."""
    code = 'MW_PROGRAM_OBSERVATION_CHANGED'

    def __init__(self, sensed, fresh, mismatches):
        super().__init__(self.code)
        self.detail = dict(sensed_frame=copy.deepcopy(sensed), fresh_frame=copy.deepcopy(fresh),
                           mismatches=copy.deepcopy(mismatches))


@contextmanager
def marks_workspace():
    # Both frozen adapters admit marks only beneath this RAM namespace.
    root = Path('/dev/shm/vqa-cu')
    root.mkdir(mode=0o700, exist_ok=True)
    host.need(not root.is_symlink() and root.resolve() == root and root.is_dir() and
              root.stat().st_uid == os.getuid(), 'MW_PRIVATE_OUTPUT')
    with tempfile.TemporaryDirectory(prefix='mv-program-', dir=root) as directory:
        yield Path(directory) / 'marks.png'


def private_evidence_base():
    default = Path('/dev/shm/vqa-cu') / ('metaviewer-program-' + str(os.getuid()))
    base = Path(os.environ.get('XDG_STATE_HOME', str(default)))
    host.need(base.is_absolute() and base == base.resolve() and
              base.is_relative_to('/dev/shm'), 'MW_PROGRAM_RAM_REQUIRED')
    host.need(not any(p.is_symlink() for p in (base, *base.parents)), 'MW_PRIVATE_OUTPUT')
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    metadata = base.lstat()
    host.need(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == os.getuid() and
              stat.S_IMODE(metadata.st_mode) == 0o700, 'MW_PRIVATE_OUTPUT')
    return base


class ProgramBackend(host.HostBackend):
    surface_kind = 'desktop_capsule'

    def __init__(self, client, identity, evidence, env):
        from metaviewer_agents.perception.deps_lock import resolve_locked_component
        self.client, self.identity, self.evidence = client, identity, Path(evidence)
        context = getattr(client, 'host_env', None)
        env = context if isinstance(context, dict) else env
        host.need(isinstance(identity, str) and host.live.PROFILE_ID_RE.fullmatch(identity), 'MW_IDENTITY')
        host.need(bool(env.get('MV_SRF_STATE_DIR')), 'MW_RUN_CONFIG')
        self.state = Path(env['MV_SRF_STATE_DIR'])
        self.binary = (Path(env['MV_SRF_BIN_DIR']) / 'srf-identity-surface'
                       if env.get('MV_SRF_BIN_DIR') else None)
        self.admin = self.binary.with_name('srf-identity-admin') if self.binary is not None else None
        self.store = Path(env['SRF_IDENTITY_STORE_ROOT']) if env.get('SRF_IDENTITY_STORE_ROOT') else None
        host.need(all(p.is_absolute() for p in (self.state, self.binary, self.store) if p is not None),
                  'MW_RUN_CONFIG')
        self.wender = resolve_locked_component('wender-agent')
        self.pending, self.network_evidence = {}, None
        self.surface_id, self.capsule, self.program_binding = None, None, None
        self.ownership()

    def ownership(self):
        surfaces = self.surfaces()
        host.need(bool(surfaces), 'MW_RUN_NO_SURFACE')
        host.need(len(surfaces) == 1, 'MW_RUN_AMBIGUOUS')
        surface = surfaces[0]
        if surface.get('control') != 'agent':
            raise host.refuse('MW_PROGRAM_CONTROL',
                refusal_sentence('MW_PROGRAM_CONTROL'))
        surface_id = surface['surface_id']
        host.need(isinstance(surface_id, str) and
                  re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', surface_id),
                  'MW_PROGRAM_BINDING')
        host.need(self.surface_id in (None, surface_id), 'MW_RUN_OWNERSHIP')
        path = self.state / 'human-bindings' / (surface_id + '.json')
        prior = getattr(self, 'program_binding', None)
        # Even a valid old native lease cannot identify the native transport of
        # another public desktop surface. Require the adapter-selected witness
        # before either lane; no profile/display prefix grants custody.
        if not os.path.lexists(path):
            raise host.refuse('MW_PROGRAM_BINDING',
                'program requires an exported adapter custody witness; unexported host-window '
                'and builtin program transports are unsupported')
        binding = host.private_json(path, self.state)
        fields = {'schema', 'surface_id', 'container', 'run_id', 'control_ready',
                  'input_epoch', 'width', 'height', 'role', 'profile_id'}
        host_xpra = 'host_xpra' in binding
        host.need(set(binding) == fields | ({'host_xpra'} if host_xpra else set()) and
                  (not host_xpra or binding['host_xpra'] is True), 'MW_PROGRAM_BINDING')
        container = ('srf-pg-hx-' if host_xpra else 'srf-pg-') + self.identity
        host.need(binding['schema'] == 'metaviewer.human_binding/v0.3' and
                  binding['surface_id'] == surface_id and binding['profile_id'] == self.identity and
                  binding['container'] == container and binding['role'] == 'agent' and
                  binding['control_ready'] is True and type(binding['input_epoch']) is int and
                  0 <= binding['input_epoch'] < 2**64 and isinstance(binding['run_id'], str) and
                  re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', binding['run_id']) and
                  all(type(binding[k]) is int and 1 <= binding[k] <= 16384
                      for k in ('width', 'height')), 'MW_PROGRAM_BINDING')
        if host_xpra:
            host.need(binding['run_id'] == 'run-hw-' + surface_id.removeprefix('surface-')[:16],
                      'MW_PROGRAM_BINDING')
        immutable = ('schema', 'surface_id', 'profile_id', 'container', 'run_id', 'role', 'host_xpra')
        host.need(prior is None or all(prior.get(k) == binding.get(k) for k in immutable),
                  'MW_RUN_OWNERSHIP')
        host.need(self.capsule in (None, container), 'MW_RUN_OWNERSHIP')
        if host_xpra:
            # This setup deliberately omits stored-identity provisioning.
            self.surface_id, self.capsule = surface_id, container
            witness = dict(profile='host-xpra', identity=self.identity, surface_id=surface_id, capsules=[])
        else:
            host.need(all(getattr(self, key, None) is not None for key in ('binary', 'admin', 'store')),
                      'MW_RUN_CONFIG')
            # The native control receipt and the manager-selected witness must
            # name the same admitted run, not merely reuse a container name.
            for receipt_path in self.state.glob('*.json'):
                receipt=host.private_json(receipt_path,self.state)
                if host.live.program_capsule_from_receipt(receipt,self.identity)==container:
                    native=receipt.get('Capsule',receipt)
                    host.need(native.get('run_id')==binding['run_id'],'MW_PROGRAM_BINDING')
            witness = super().ownership()
            host.need(self.capsule == binding['container'], 'MW_PROGRAM_BINDING')
        self.program_binding = dict(binding)
        return dict(witness, native_binding=dict(binding))

    def check_program_frame(self, frame):
        binding = getattr(self, 'program_binding', None)
        host.need(isinstance(binding, dict), 'MW_PROGRAM_BINDING')
        host.tools._check_frame(frame)
        path = Path(frame['ramws_path'])
        host.need(frame['surface_id'] == binding['surface_id'] and path.is_absolute() and
                  path.is_relative_to('/dev/shm') and
                  path.parent.name.startswith('frames-') and len(path.parent.name) > len('frames-') and
                  re.fullmatch(r'[0-9a-f]{32}\.rgb', path.name) and
                  path == path.resolve(strict=True) and
                  not any(p.is_symlink() for p in (path, *path.parents)), 'MW_PROGRAM_FRAME_CUSTODY')
        # Publisher.publish checks native run/window/container before producing
        # this authenticated surface-bound Ref. Public raw allocations deliberately
        # have random names; their paths do not disclose the native run/window.
        for candidate,kind,mode in ((path,stat.S_ISREG,0o600),(path.parent,stat.S_ISDIR,0o700)):
            metadata=candidate.lstat()
            host.need(kind(metadata.st_mode) and metadata.st_uid==os.getuid() and
                      stat.S_IMODE(metadata.st_mode)==mode,'MW_PROGRAM_FRAME_CUSTODY')

    def retain(self, frame):
        self.check_program_frame(frame)
        return super().retain(frame)

    def native_witness(self, verified):
        if (getattr(self, 'program_binding', None) or {}).get('host_xpra') is True:
            # Core validates the private-display XID and witness before exposing
            # the frozen verified-result projection. It strips the native ID;
            # do not manufacture an XID or accept an ordinary lookalike dict.
            host.need(isinstance(verified, host.tools._VerifiedReceipt), 'MW_RECEIPT_MISMATCH')
        return super().native_witness(verified)

    def before_propose(self, proposal, sensed):
        self.active_attempt['proposal_id'] = proposal['proposal_id']
        # Retain the dispatch baseline even if the publisher releases its RAM
        # allocation while settlement is pending.
        self.program_dispatch_witnesses = getattr(self, 'program_dispatch_witnesses', {})
        self.program_dispatch_witnesses[proposal['proposal_id']] = sensed.get('frame_witness', {})
        path = self.evidence / ('dispatch-' + proposal['proposal_id'] + '.json')
        artifact = atomic_journal(path, dict(status='pending_dispatch', proposal=proposal,
            record_kind='immutable_pre_dispatch',
            settlement_artifact=str(self.evidence / ('receipt-' +
                Path(self.active_attempt['intent_artifact']).stem.removeprefix('intent-') + '.json')),
            frame=sensed['frame'], intent_artifact=self.active_attempt['intent_artifact'],
            program_binding=getattr(self, 'program_binding', None)))
        self.active_attempt['dispatch_artifact'] = artifact

    def proposal_refused(self, row, error):
        path = self.evidence / ('dispatch-' + row['proposal_id'] + '.json')
        record = json.loads(path.read_text())
        host.need(record['proposal']['proposal_id'] == row['proposal_id'], 'MW_RECEIPT_MISMATCH')
        record.update(status='refused_before_execution', reason_code=error.reason_code, submitted=True)
        atomic_journal(path, record, replace=True)

    def observe(self, timeout_ms):
        self.ownership()
        observed = host.tools.observe(self.surface_id, client=self.client, timeout_ms=timeout_ms)
        host.need(observed['frame_ref']['surface_id'] == self.surface_id, 'MW_PROGRAM_SURFACE')
        self.check_program_frame(observed['frame_ref'])
        return observed

    def keepalive_observe(self, timeout_ms):
        # Session maintenance only: do not run discovery/native commands here.
        # Full ownership and rebind remain mandatory before any proposal.
        observed = host.tools.observe(self.surface_id, client=self.client, timeout_ms=timeout_ms)
        host.need(observed['frame_ref']['surface_id'] == self.surface_id, 'MW_PROGRAM_SURFACE')
        self.check_program_frame(observed['frame_ref'])
        return observed

    def perceive(self, observed, *, allow_empty=False):
        frame = observed['frame_ref']
        host.need(frame['surface_id'] == self.surface_id, 'MW_PROGRAM_SURFACE')
        self.check_program_frame(frame)
        witness = self.retain(frame)
        record = dict(frame=dict(frame), frame_witness=witness, status='retained')
        if not hasattr(self, 'program_observations'):
            self.program_observations = []
        self.program_observations.append(record)
        try:
            vision = self.vision.perceive(frame)
            record['vision'] = vision
            c2 = self.vision.last_c2_payload
            if isinstance(c2, dict):
                record['c2'] = c2
            table = project_element_table(frame, vision)
            record['table'] = table
            record['status'] = 'localized' if table['elements'] else 'unknown'
            host.need(allow_empty or bool(table['elements']), 'MW_PROGRAM_UNKNOWN_OBSERVATION')
        except (OSError, ValueError, RuntimeError) as error:
            record['error'] = dict(code=getattr(error, 'code', 'MW_PROGRAM_PERCEPTION'),
                                   message=str(error)[:4096])
            raise
        finally:
            diagnostics = getattr(self.vision, 'diagnostics', None)
            if isinstance(diagnostics, dict):
                record['diagnostics'] = dict(diagnostics)
            for name in ('last_vserve_error', 'last_fallback_error'):
                error = getattr(self.vision, name, None)
                if isinstance(error, Exception):
                    record[name] = dict(code=getattr(error, 'code', 'MW_PROGRAM_PERCEPTION'),
                                        message=str(error)[:4096])
        return dict(frame=frame, table=table, frame_witness=witness,
                    c2=record.get('c2'),
                    perception_transport=self.vision.last_transport,
                    observation=build_observation(frame, surface_id=self.surface_id,
                        generation=frame['generation'], vision=vision))

    def propose(self, sensed, plan, max_ms):
        # [TARGET, unit decision] Explicit stale nonexecution retries only the
        # RGB rebind, under the original attempt cap and absolute deadline.
        deadline = time.monotonic_ns() + max_ms * 1_000_000
        attempts = min(3, plan.get('frame_attempt_limit', 3))
        for retry in range(attempts):
            remaining = (deadline - time.monotonic_ns()) // 1_000_000
            host.need(remaining > 0, 'MW_STALE_FRAME_EXHAUSTED')
            start = len(getattr(self, 'frame_attempts', []))
            try:
                admitted = super().propose(sensed, plan, remaining)
                if plan.get('program_effect'):
                    proposal, before, verified = self.pending[admitted['proposal_id']]
                    after = verified['after_frame']
                    self.active_attempt['core_verification'] = copy.deepcopy(verified)
                    effect = visible_effect(self, before, after, sensed['table'],
                        before_witness=self.program_dispatch_witnesses.pop(admitted['proposal_id'], None),
                        return_box=plan.get('focused_text') is True)
                    if plan.get('focused_text'):
                        self.active_attempt['changed_box'] = effect
                return admitted
            except host.tools.ToolRefusal as error:
                rows = getattr(self, 'frame_attempts', [])[start:]
                if (error.reason_code != 'STALE_FRAME' or not rows or
                        rows[-1]['status'] != 'STALE_FRAME' or retry == attempts - 1):
                    raise

    def rebind(self, sensed, plan, remaining):
        started = time.monotonic_ns()
        # Wender binds its target to sensed pixels. A moving or replaced target
        # requires a new planning tick, never a coordinate replay or input retry.
        focused = plan.get('focused_text') is True and plan['action']['type'] == 'type' and plan.get('target') is None
        if isinstance(self.client, host.ToolClient) and not focused:
            baseline = self.observe(remaining)['frame_ref']
            # Repeat subscribe requests a real same-pixel publication from the
            # existing shared poller. Merely being subscribed does not refresh.
            self.client.subscribe_frames(self.surface_id, timeout_ms=remaining)
            self.subscription['status'] = 'subscribed'
            fresh = wait_for_publication(self, baseline['generation'], remaining)['frame_ref']
        else:
            fresh = self.observe(remaining)['frame_ref']
        if isinstance(self.client, host.ToolClient):
            # Drain through an empty readiness check; one event is not enough.
            deadline = started + remaining * 1_000_000
            while True:
                budget = (deadline - time.monotonic_ns()) // 1_000_000
                host.need(budget > 0, 'MW_STALE_FRAME_EXHAUSTED')
                if not self.client.drain_frames(timeout_ms=budget):
                    break
            cached = self.client._frames.get(self.surface_id)
            if cached is not None and cached['generation'] > fresh['generation']:
                fresh = copy.deepcopy(cached)
            self.check_program_frame(fresh)
        mismatches = {k: dict(sensed=sensed['frame'][k], fresh=fresh[k])
                      for k in ('surface_id', 'sha256', 'width', 'height')
                      if fresh[k] != sensed['frame'][k]}
        host.need(fresh['surface_id'] == sensed['frame']['surface_id'] == self.surface_id and
                  fresh['generation'] >= sensed['frame']['generation'], 'MW_REBIND_PIXELS')
        cheap_started = time.monotonic_ns()
        if focused:
            # Operator-asserted focus has no pixel target. Preserve surface,
            # geometry, generation and custody checks; only pixels may drift.
            host.need(not (set(mismatches) - {'sha256'}), 'MW_REBIND_PIXELS')
            host.need(not mismatches or fresh['generation'] > sensed['frame']['generation'], 'MW_REBIND_PIXELS')
            rebound = dict(sensed, frame=fresh, frame_witness=self.retain(fresh))
            self.record_rebind_time(started, cheap_started, fresh)
            return rebound
        if mismatches:
            host.need(fresh['generation'] > sensed['frame']['generation'], 'MW_REBIND_PIXELS')
            if set(mismatches) == {'sha256'}:
                rebound = self.unchanged_target(sensed, fresh, plan)
                if rebound is not None:
                    self.record_rebind_time(started, cheap_started, fresh)
                    return rebound
            raise ProgramObservationChanged(sensed['frame'], fresh, mismatches)
        rebound = dict(sensed, frame=fresh, frame_witness=self.retain(fresh))
        self.record_rebind_time(started, cheap_started, fresh)
        return rebound

    def record_rebind_time(self, started, cheap_started, fresh):
        record = dict(generation=fresh['generation'],
                      elapsed_us=(time.monotonic_ns() - started) // 1000,
                      rgb_check_us=(time.monotonic_ns() - cheap_started) // 1000)
        if hasattr(self, 'active_attempt'):
            self.active_attempt.setdefault('frame_rebinds', []).append(record)

    def unchanged_target(self, sensed, fresh, plan):
        # [TARGET, unit decision] Exact RGB equality over the complete chosen
        # box grounded in the original table admits only off-target drift.
        target = plan.get('target')
        artifact = sensed.get('frame_witness', {}).get('artifact')
        if not isinstance(target, dict) or not artifact:
            return None
        box = target.get('box')
        if (not isinstance(box, list) or len(box) != 4 or
                any(type(v) is not int for v in box)):
            return None
        x, y, w, h = box
        width, height = fresh['width'], fresh['height']
        if not (0 <= x < x + w <= width and 0 <= y < y + h <= height):
            return None
        if plan['action'].get('type') != 'type':
            require_click_target(plan['action'], target)
        else:
            require_text_field(target)
        require_grounded_goal(sensed['table'], target['name'], target)
        witness = self.retain(fresh)
        old = Path(artifact).read_bytes()
        new = Path(witness['artifact']).read_bytes()
        host.need(len(old) == len(new) == width * height * 3 and
                  host.hashlib.sha256(old).hexdigest() == sensed['frame']['sha256'] and
                  host.hashlib.sha256(new).hexdigest() == fresh['sha256'], 'MW_FRAME_BINDING')
        for row in range(y, y + h):
            start = (row * width + x) * 3
            if old[start:start + w * 3] != new[start:start + w * 3]:
                return None
        return dict(sensed, frame=fresh, frame_witness=witness)

    def network_context(self):
        raise host.OwnerRefused('MW_PROGRAM_OPERATION')

    def ax(self):
        raise host.OwnerRefused('MW_PROGRAM_OPERATION')


def validate_request(goal, steps, timeout_ms):
    host.need(isinstance(goal, str) and bool(goal.strip()) and len(goal) <= 4096,
              'MW_PROGRAM_GOAL')
    host.need(type(steps) is int and 1 <= steps <= 16, 'MW_PROGRAM_STEPS')
    host.need(type(timeout_ms) is int and 1 <= timeout_ms <= 30000, 'MW_PROGRAM_BUDGET')


def require_grounded_goal(table, goal, target):
    """Do not turn Wender's score fallback into authority for an arbitrary click."""
    needle = host.normalized(goal)
    matches = [row for row in table['elements'] if host.normalized(row.get('name')) == needle]
    host.need(len(matches) == 1, 'MW_PROGRAM_GOAL_UNGROUNDED')
    row = matches[0]
    box = row['bbox']
    host.need(target.get('name') == row['name'] and target.get('role') == row['role'] and
              target.get('box') == [box[k] for k in ('x', 'y', 'w', 'h')],
              'MW_PROGRAM_GOAL_UNGROUNDED')


def require_click_target(action,target):
    box=target.get('box')
    host.need(action.get('type')=='click' and type(action.get('x')) is int and
              type(action.get('y')) is int and isinstance(box,list) and len(box)==4 and
              box[0]<=action['x']<box[0]+box[2] and box[1]<=action['y']<box[1]+box[3],
              'MW_PROGRAM_CLICK_TARGET')


def effect_expectation(frame):
    return dict(type='changed_region', bbox=dict(x=0, y=0, w=frame['width'], h=frame['height']))


def visible_effect(backend, before, after, table, *, before_witness=None, return_box=False):
    """Independent RGB check prevents a known clock from proving an action."""
    host.need(all(before[k] == after[k] for k in ('surface_id', 'width', 'height')) and
              after['generation'] > before['generation'], 'MW_FRAME_BINDING')
    pixels = []
    for frame, witness in ((before, before_witness), (after, None)):
        witness = witness if witness and witness.get('artifact') else backend.retain(frame)
        raw = Path(witness['artifact']).read_bytes()
        host.need(len(raw) == frame['width'] * frame['height'] * 3 and
                  host.hashlib.sha256(raw).hexdigest() == frame['sha256'], 'MW_FRAME_BINDING')
        pixels.append(raw)
    clocks = [r['bbox'] for r in table['elements'] if
              r['role'].casefold() in ('clock', 'timer') or
              re.fullmatch(r'(?:clock|time|\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)',
                           r['name'].strip(), re.I)]
    width = before['width']
    left, top, right, bottom = width, before['height'], -1, -1
    for offset in range(0, len(pixels[0]), 3):
        if pixels[0][offset:offset+3] == pixels[1][offset:offset+3]:
            continue
        x, y = (offset // 3) % width, (offset // 3) // width
        if not any(b['x'] <= x < b['x'] + b['w'] and b['y'] <= y < b['y'] + b['h'] for b in clocks):
            if not return_box:
                return
            left, top, right, bottom = min(left, x), min(top, y), max(right, x), max(bottom, y)
    host.need(right >= left, 'MW_PROGRAM_NO_VISIBLE_EFFECT')
    return [left, top, right - left + 1, bottom - top + 1]


def refuse_known_password(target):
    states = target.get('states', {})
    label = (target.get('role', '') + ' ' + target.get('name', '')).casefold()
    host.need(not any(word in label for word in ('password', 'passwd', 'passphrase', 'contraseña')) and
              not any(states.get(key) for key in ('password', 'protected', 'secret')) and
              states.get('type') != 'password', 'MW_PROGRAM_PASSWORD')


def require_text_field(target):
    refuse_known_password(target)
    host.need(target.get('role') in ('field', 'textbox', 'entry', 'text_field'), 'MW_PROGRAM_TEXT_FIELD')


def readback_text(c2, target):
    """Bound user-window OCR diagnostics; never substitute the requested text."""
    return observed_text(c2, target)[:4096]


def observed_text(c2, target):
    """Use actual OCR only, never mark-N, model prose or the requested text."""
    x, y, w, h = target['box']
    marks = [m for m in (c2 or {}).get('marks', []) if
             x <= m['x'] + m['w'] / 2 < x + w and
             y <= m['y'] + m['h'] / 2 < y + h and m.get('ocr_text')]
    marks.sort(key=lambda m: (m['y'], m['x']))
    return ' '.join(m['ocr_text'] for m in marks)


def classify_text_readback(c2, target, text, *, caret=False, focused_area=False):
    observed = observed_text(c2, target)
    if not observed:
        return 'not_readable'
    if observed == text:
        return 'exact'
    if focused_area:
        # The changed area also holds unrelated updates, such as a status bar. Evidence
        # is the requested words, contiguous and literal, in what OCR read inside it.
        # Preserve every requested space: tokenization cannot prove literal text.
        # Only an adjacent terminal caret and word boundaries may be ignored.
        suffix = r'(?:\|)?' if caret and not text.endswith('|') else ''
        if text and re.search(r'(?<!\S)' + re.escape(text) + suffix + r'(?!\S)', observed):
            return 'exact'
    # A terminal vertical caret may be merged with the last word or emitted
    # as its own OCR mark. Never normalize case, words or requested pipes.
    if caret and not text.endswith('|') and observed in (text + '|', text + ' |'):
        return 'exact'
    # [TARGET, unit decision] Similarity is uncertainty, never certification.
    # Compare literal, equal-word-count spans in the focused window. Short
    # strings and changed punctuation/case alone retain strict disagreement.
    wanted = text.split()
    words = observed.split()
    candidates = ([' '.join(words[i:i + len(wanted)])
                   for i in range(len(words) - len(wanted) + 1)]
                  if focused_area and wanted else [observed])
    for candidate in candidates:
        if (len(text) >= 8 and candidate.casefold() != text.casefold()
                and any(word in candidate.split() for word in wanted)
                and re.findall(r'[!?.;:]', candidate) == re.findall(r'[!?.;:]', text)
                and SequenceMatcher(None, text, candidate, autojunk=False).ratio() >= 0.85):
            return 'not_readable'
    return 'mismatch'


def ocr_env(vision):
    # The perception child environment is scrubbed; OCR data location is not a secret.
    env = dict(vision._child_env())
    if os.environ.get('TESSDATA_PREFIX'):
        env['TESSDATA_PREFIX'] = os.environ['TESSDATA_PREFIX']
    return env


def read_text_pixels(backend, frame, target, timeout_ms):
    """[TARGET, unit decision] Read clean pixels independently of C2 mark caps.

    Use the existing engine TSV reader, retaining its process/row bounds. Margin
    supplies OCR context; only words intersecting the original area are evidence.
    No expected text is sent to OCR. Unavailable OCR preserves the C2 fallback.
    """
    from metaviewer_agents.perception.vcore import _run_bounded
    vision = backend.vision
    if not isinstance(getattr(vision, 've_root', None), Path):
        return None
    witness = backend.retain(frame)
    raw = Path(witness['artifact']).read_bytes()
    host.need(len(raw) == frame['width'] * frame['height'] * 3 and
              host.hashlib.sha256(raw).hexdigest() == frame['sha256'], 'MW_FRAME_BINDING')
    script = '''
import hashlib, json, sys
import numpy as np
from vadapt.cu_ocr import run_full_frame_tsv
path, digest, width, height, box, timeout = json.loads(sys.argv[1])
raw = open(path, 'rb').read()
assert hashlib.sha256(raw).hexdigest() == digest
rgb = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3)
x, y, w, h = box
margin = 12
left, top = max(0, x-margin), max(0, y-margin)
right, bottom = min(width, x+w+margin), min(height, y+h+margin)
result = run_full_frame_tsv(rgb[top:bottom, left:right].copy(), timeout_s=timeout)
words = []
for word in result['words']:
    wx, wy, ww, wh = word['bbox_px']
    wx, wy = wx+left, wy+top
    if wx < x+w and wx+ww > x and wy < y+h and wy+wh > y:
        words.append(word['raw_text'])
print(json.dumps(dict(ok=result['ocr_ok'], reason=result['missing_reason'], text=' '.join(words))))
'''
    timeout = min(vision.timeout, timeout_ms / 1000)
    if timeout <= 0:
        return None
    try:
        result = _run_bounded([vision.python, '-c', script, json.dumps([
            witness['artifact'], frame['sha256'], frame['width'], frame['height'],
            target['box'], timeout])], cwd=str(vision.ve_root), env=ocr_env(vision),
            stdin=subprocess.DEVNULL, timeout=timeout)
        if result.returncode != 0:
            return None
        payload = json.loads(result.stdout)
        attempt = getattr(backend, 'active_attempt', None)
        if isinstance(attempt, dict):
            attempt['readback_ocr_reason'] = payload.get('reason')
        if payload.get('ok') is not True or not isinstance(payload.get('text'), str):
            return None
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        return None
    x, y, w, h = target['box']
    return dict(marks=[dict(x=x, y=y, w=w, h=h, ocr_text=payload['text'])])


def type_after_focus(backend, move, text, timeout_ms):
    target = move['target']
    require_text_field(target)
    host.need(move['verification'].get('focus_verified') is True, 'MW_PROGRAM_FOCUS_UNVERIFIED')
    after = move['verification']['receipt']['after_frame']
    sensed = backend.perceive(dict(frame_ref=after))
    # Bind the same field in the post-click observation; names may have changed.
    rows = [r for r in sensed['table']['elements'] if
            [r['bbox'][k] for k in ('x', 'y', 'w', 'h')] == target['box'] and r['role'] == target['role']]
    host.need(len(rows) == 1, 'MW_PROGRAM_TEXT_FIELD')
    target = dict(target, name=rows[0]['name'], states=rows[0].get('states', {}))
    require_text_field(target)
    dispatch_text(backend, sensed, target, text, timeout_ms)


def type_focused(backend, text, timeout_ms):
    # [TARGET, unit decision] The operator asserts current focus. No visual
    # target/focus witness is fabricated; OCR uses the post-input changed area.
    sensed = backend.perceive(backend.observe(remaining_budget(backend, timeout_ms)), allow_empty=True)
    rows = sensed['table']['elements']
    for row in rows:
        refuse_known_password(row)
    focused = [r for r in rows if r.get('focused') is True or
               r.get('states', {}).get('focused') in (True, 'true')]
    host.need(len(focused) <= 1, 'MW_PROGRAM_FOCUS_AMBIGUOUS')
    if focused:
        row = focused[0]
        require_text_field(row)
        box = [row['bbox'][k] for k in ('x', 'y', 'w', 'h')]
    else:
        box = [0, 0, sensed['frame']['width'], sensed['frame']['height']]
    target = dict(box=box, source='operator_asserted_focus')
    dispatch_text(backend, sensed, target, text, timeout_ms, focused=True)


def dispatch_text(backend, sensed, target, text, timeout_ms, *, focused=False):
    action = dict(type='type', text=text)
    expectation = effect_expectation(sensed['frame'])
    attempt = dict(status='dispatch_or_settlement_pending', action=action, expectation=expectation, target=target)
    backend.program_attempts.append(attempt)
    backend.active_attempt = attempt
    journal_id = uuid.uuid4().hex
    start = len(getattr(backend, 'frame_attempts', []))
    admitted = None
    try:
        attempt['intent_artifact'] = atomic_journal(backend.evidence / ('intent-' + journal_id + '.json'),
            dict(status='pending_dispatch', frame=sensed['frame'], action=action, expectation=expectation, target=target))
        admitted = backend.propose(sensed, dict(action=action, expectation=expectation,
            target=None if focused else target, program_effect=True, focused_text=focused), remaining_budget(backend, timeout_ms))
        verified = backend.wait_verify(admitted, remaining_budget(backend, timeout_ms))
        attempt['verification'] = verified
        frame = verified['receipt']['after_frame']
        backend.vision.perceive(frame)
        readback_target = target
        if focused:
            x, y, w, h = target['box']
            cx, cy, cw, ch = attempt['changed_box']
            left, top = max(x, cx), max(y, cy)
            right, bottom = min(x + w, cx + cw), min(y + h, cy + ch)
            readback_target = dict(target, box=[left, top, max(0, right-left), max(0, bottom-top)])
            attempt['readback_box'] = readback_target['box']
        pixels = read_text_pixels(backend, frame, readback_target, remaining_budget(backend, timeout_ms))
        attempt['readback_source'] = 'pixels_tsv' if pixels is not None else 'c2_marks'
        payload = pixels if pixels is not None else backend.vision.last_c2_payload
        attempt['readback_text'] = readback_text(payload, readback_target)
        readback = classify_text_readback(payload,
                                         readback_target, text, caret=focused, focused_area=focused)
        attempt['text_readback'] = backend.text_readback = readback
        host.need(readback != 'mismatch', 'MW_PROGRAM_TEXT_MISMATCH')
        status = 'verified_text' if readback == 'exact' else 'uncertified_text'
        record = dict(status=status, action=action, target=target, verification=verified, text_readback=readback)
        attempt.update(status=status, receipt_artifact=atomic_journal(
            backend.evidence / ('receipt-' + journal_id + '.json'), record))
        backend.program_moves.append(record)
    except Exception as error:
        rows = getattr(backend, 'frame_attempts', [])[start:]
        nonexecution = all(r.get('status') in ('STALE_FRAME', 'MW_REBIND_PIXELS', 'intent_pending') or
                           isinstance(error, host.tools.ToolRefusal) and r.get('status') == error.reason_code
                           for r in rows)
        # A returned admission or a pending/uncorrelated dispatch remains uncertain.
        if admitted is None and nonexecution:
            attempt.update(status='refused_before_execution' if rows else 'refused_before_dispatch',
                           reason_code=getattr(error, 'reason_code', getattr(error, 'code', 'MW_PROGRAM_TEXT_REFUSED')))
            backend.program_clean_refusal = True
        else:
            attempt['status'] = 'input_uncertain'
        if isinstance(error, host.tools.VerificationFailed):
            attempt['status'] = 'input_uncertain'
            journal_verification_failure(backend, attempt, error, journal_id)
        raise


class MuseProgramPlanner:
    """Opt-in model selects a real mark; Wender's custody CLI plans its click."""
    def __init__(self, backend, custody, timeout_ms):
        self.backend, self.custody, self.timeout_ms = backend, custody, timeout_ms
        self.grounded_goal = None
        self.battery_state_sha256 = None
        self.last_decision = None

    @staticmethod
    def selected_name(c3, c2, table):
        action = c3.get('action', {})
        # A live "Press the C button" clicked the 7 at confidence 0.35 with this flag set; correct
        # clicks measured 0.45 and above. A model that says it is guessing does not get to click.
        confidence = c3.get('confidence')
        host.need(c3.get('need_reasoning', False) is False and
                  (confidence is None or
                   (type(confidence) in (int, float) and confidence >= MODEL_CLICK_MIN_CONFIDENCE)),
                  'MW_PROGRAM_MODEL_TARGET')
        host.need(c3.get('schema') == 'cu.action/v1' and action.get('kind') == 'click' and
                  type(action.get('mark_id')) is int, 'MW_PROGRAM_MODEL_TARGET')
        marks = [m for m in c2['marks'] if m.get('id') == action['mark_id']]
        host.need(len(marks) == 1, 'MW_PROGRAM_MODEL_TARGET')
        mark = marks[0]
        box = {k: mark[k] for k in ('x', 'y', 'w', 'h')}
        rows = [r for r in table['elements'] if r['bbox'] == box and r['role'] == mark['kind'] and
                r['name'] == (mark.get('ocr_text') or 'mark-' + str(mark['id']))]
        host.need(len(rows) == 1, 'MW_PROGRAM_MODEL_TARGET')
        host.need(action.get('x') == box['x'] + box['w'] // 2 and
                  action.get('y') == box['y'] + box['h'] // 2, 'MW_PROGRAM_MODEL_TARGET')
        return rows[0]['name']

    def plan_step(self, observation, table, goal):
        from metaviewer_agents.perception.base import Frame
        from metaviewer_agents.perception.vcore import _png_bytes
        self.grounded_goal = self.battery_state_sha256 = self.last_decision = None
        record = self.backend.program_observations[-1]
        c2, frame = record.get('c2'), observation['frame_ref']
        host.need(isinstance(c2, dict) and c2.get('frame_sha256') == frame['sha256'] ==
                  record['frame']['sha256'] == table['frame_sha256'], 'MW_PROGRAM_MODEL_FRAME')
        from mw_program_muse import private_ram_path
        marks=private_ram_path(c2['marks_png'])
        private_ram_path(marks.parent,directory=True)
        raw = Path(record['frame_witness']['artifact']).read_bytes()
        host.need(host.hashlib.sha256(raw).hexdigest() == frame['sha256'], 'MW_PROGRAM_MODEL_FRAME')
        png = marks.parent / 'frame.png'
        png.write_bytes(_png_bytes(Frame(frame['width'], frame['height'], raw)))
        png.chmod(0o600)
        workspace = marks.parent / 'workspace'
        workspace.mkdir(mode=0o700, exist_ok=True)
        budget = remaining_budget(self.backend, self.timeout_ms)
        request = dict(goal=goal, c2=c2, frame_png=str(png), workspace=str(workspace), timeout_s=budget / 1000)
        env = {k: os.environ[k] for k in ('PATH','HOME','LANG','XDG_CONFIG_HOME','XDG_DATA_HOME',
            'XDG_RUNTIME_DIR') if k in os.environ}
        env.update(PYTHONPATH=str(self.backend.wender), PYTHONDONTWRITEBYTECODE='1',
                   MV_HOSTED='1', TMPDIR=str(marks.parent))
        def keepalive(timeout_ms):
            try:
                observed = self.backend.keepalive_observe(timeout_ms)
                record['keepalive_frame'] = copy.deepcopy(observed['frame_ref'])
                return observed
            except (OSError, ValueError, RuntimeError, host.ClientError,
                    host.tools.ToolRefusal) as error:
                record['keepalive_error'] = dict(type=type(error).__name__,
                    code=getattr(error, 'code', 'MW_PROGRAM_KEEPALIVE'), message=str(error)[:4096])
                raise
        try:
            result = run_model_with_frames(self.backend.client,
                [sys.executable, str(ROOT / 'tools/mw_program_muse.py')],
                cwd=self.backend.wender, env=env, request=json.dumps(request).encode(), timeout=budget / 1000,
                keepalive=keepalive)
        except host.subprocess.TimeoutExpired as error:
            raise host.refuse('MW_PROGRAM_MODEL_TIMEOUT', 'model planning budget expired before dispatch') from error
        try:
            decision = json.loads(result.stdout)
        except (ValueError, UnicodeError) as error:
            raise ProgramModelReplyRejected('MW_PROGRAM_MODEL_FAILED', 'invalid model JSON') from error
        self.last_decision = decision
        if not isinstance(decision, dict):
            raise ProgramModelReplyRejected('MW_PROGRAM_MODEL_TARGET', 'model reply must be an object')
        if result.returncode != 0:
            record['model_error'] = decision.get('error')
            error = decision.get('error')
            if isinstance(error, dict) and error.get('type') == 'ActionValidationError':
                raise ProgramModelReplyRejected('MW_PROGRAM_MODEL_FAILED', str(error))
            raise host.refuse('MW_PROGRAM_MODEL_FAILED', str(error or 'model helper refused'))
        try:
            host.need(set(decision) == {'c3','model_metadata'}, 'MW_PROGRAM_MODEL_TARGET')
            name = self.selected_name(decision['c3'], c2, table)
        except (host.OwnerRefused, KeyError, TypeError, AttributeError) as error:
            raise ProgramModelReplyRejected('MW_PROGRAM_MODEL_TARGET', str(error)) from error
        planned = self.custody.plan_step(observation, table, name)
        require_grounded_goal(table, name, planned[3])
        self.grounded_goal, self.battery_state_sha256 = name, self.custody.battery_state_sha256
        return planned


def stop_model_group(recorded_pid):
    """Signal only the recorded separate session created for this provider."""
    host.need(type(recorded_pid) is int and recorded_pid > 1,
              'MW_PROGRAM_MODEL_PROCESS_TARGET')
    host.need(recorded_pid not in (os.getpid(), os.getpgid(0)),
              'MW_PROGRAM_MODEL_PROCESS_TARGET')
    try:
        os.killpg(recorded_pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


MODEL_KEEPALIVE_INTERVAL_S = 10.0
MODEL_KEEPALIVE_RPC_MS = 1000


def run_model_with_frames(client, command, *, cwd, env, request, timeout, keepalive=None):
    """One actor drains authenticated frames and bounded provider pipes together."""
    host.need(len(request) <= 1024 * 1024 and timeout > 0, 'MW_PROGRAM_MODEL_BUDGET')
    host.need(keepalive is None or callable(keepalive), 'MW_PROGRAM_KEEPALIVE')
    deadline = time.monotonic() + timeout
    next_keepalive = time.monotonic()
    def service_keepalive():
        nonlocal next_keepalive
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise host.subprocess.TimeoutExpired(command, timeout)
        if keepalive is not None and time.monotonic() >= next_keepalive:
            keepalive(max(1, min(MODEL_KEEPALIVE_RPC_MS, int(remaining * 1000))))
            if time.monotonic() >= deadline:
                raise host.subprocess.TimeoutExpired(command, timeout)
            next_keepalive = time.monotonic() + MODEL_KEEPALIVE_INTERVAL_S
    process = host.subprocess.Popen(command, cwd=cwd, env=env, stdin=host.subprocess.PIPE,
        stdout=host.subprocess.PIPE, stderr=host.subprocess.PIPE, start_new_session=True, close_fds=True)
    recorded_pid = process.pid
    outputs = {process.stdout: bytearray(), process.stderr: bytearray()}
    limits = {process.stdout: 1024 * 1024, process.stderr: 65536}
    pending = memoryview(request)
    try:
        with selectors.DefaultSelector() as selector:
            for stream in (process.stdin, process.stdout, process.stderr):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_WRITE if stream is process.stdin else selectors.EVENT_READ)
            while selector.get_map():
                service_keepalive()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise host.subprocess.TimeoutExpired(command, timeout)
                for _ in range(16):
                    service_keepalive()
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise host.subprocess.TimeoutExpired(command, timeout)
                    if not client.drain_frames(timeout_ms=max(1, min(1000, int(remaining * 1000)))):
                        break
                service_keepalive()
                remaining = deadline - time.monotonic()
                pause = min(0.05, remaining)
                if keepalive is not None:
                    pause = min(pause, max(0, next_keepalive - time.monotonic()))
                for key, _ in selector.select(pause):
                    stream = key.fileobj
                    if stream is process.stdin:
                        try:
                            written = os.write(stream.fileno(), pending[:4096])
                            pending = pending[written:]
                        except BlockingIOError:
                            continue
                        except BrokenPipeError:
                            pending = pending[:0]
                        if not pending:
                            selector.unregister(stream)
                            stream.close()
                    else:
                        buffer = outputs[stream]
                        try:
                            chunk = os.read(stream.fileno(), min(65536, limits[stream] - len(buffer) + 1))
                        except BlockingIOError:
                            continue
                        if not chunk:
                            selector.unregister(stream)
                        else:
                            buffer.extend(chunk)
                            host.need(len(buffer) <= limits[stream], 'MW_PROGRAM_MODEL_OUTPUT_LIMIT')
        # Keep the exited leader unreaped so its recorded id cannot be reused
        # before the separate provider group has been cleaned up.
        while True:
            service_keepalive()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise host.subprocess.TimeoutExpired(command, timeout)
            exited = os.waitid(os.P_PID, recorded_pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if exited is not None:
                host.need(exited.si_pid == recorded_pid, 'MW_PROGRAM_MODEL_PROCESS_TARGET')
                break
            client.drain_frames(timeout_ms=max(1, min(50, int(remaining * 1000))))
            time.sleep(min(0.01, remaining))
    finally:
        # Only this recorded new process group belongs to the provider attempt.
        stop_model_group(recorded_pid)
        process.wait()
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()
    return host.subprocess.CompletedProcess(command, process.returncode,
        bytes(outputs[process.stdout]), bytes(outputs[process.stderr]))


def remaining_budget(backend, maximum):
    deadline = getattr(backend, 'run_deadline_ns', None)
    remaining = maximum if deadline is None else min(maximum, (deadline - time.monotonic_ns()) // 1000000)
    host.need(remaining > 0, 'MW_PROGRAM_DEADLINE')
    return remaining


def wait_for_publication(backend, after_generation, timeout_ms):
    """Poll real core observations only after an explicit non-execution refusal."""
    deadline = time.monotonic_ns() + timeout_ms * 1000000
    for _ in range(512):
        left = min(remaining_budget(backend, timeout_ms), (deadline - time.monotonic_ns()) // 1000000)
        host.need(left > 0, 'MW_PROGRAM_NO_NEW_PUBLICATION')
        observed = backend.observe(left)
        if observed['frame_ref']['generation'] > after_generation:
            return observed
        time.sleep(min(0.05, left / 1000))
    raise host.OwnerRefused('MW_PROGRAM_NO_NEW_PUBLICATION')


def atomic_journal(path, value, *, replace=False):
    """Publish a new private record only after its complete contents are synced."""
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    try:
        host.ReplayOwner.write(temporary, (json.dumps(value) + '\n').encode())
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path, follow_symlinks=False)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)
    return str(path)


def journal_verification_failure(backend, attempt, error, journal_id):
    """Retain the actual wait payload; it need not be an action receipt.

    The tool boundary correlates its reply to the wait request. The separately
    recorded dispatch ID binds that call to this attempt without inventing a
    proposal_id inside an error body that does not carry one.
    """
    failure = dict(error_type=type(error).__name__, correlation='unknown')
    proposal_id = attempt.get('proposal_id')
    if isinstance(proposal_id, str) and proposal_id:
        failure['proposal_id'] = proposal_id
    else:
        proposal_id = None
    payload = getattr(error, 'receipt', None)
    if isinstance(payload, dict):
        failure['payload'] = copy.deepcopy(payload)
        if proposal_id:
            if 'proposal_id' not in payload:
                failure['correlation'] = 'dispatch_wait_call'
            else:
                failure['correlation'] = ('proposal_id_match' if payload['proposal_id'] == proposal_id
                                          else 'proposal_id_mismatch')
    else:
        failure['payload_status'] = 'unavailable'
    attempt['verification_failure'] = failure
    try:
        attempt['verification_failure_artifact'] = atomic_journal(
            backend.evidence / ('verification-failure-' + journal_id + '.json'),
            dict(status='input_uncertain', intent_artifact=attempt['intent_artifact'], **failure))
    except (OSError, ValueError, TypeError, RuntimeError) as journal_error:
        # This is best-effort diagnostic retention after an uncertain action.
        # Preserve both the original exception and the rc5 attempt disposition.
        attempt['verification_failure_journal_error'] = dict(
            type=type(journal_error).__name__, message=str(journal_error)[:4096])


def run_moves(backend, planner, goal, steps, timeout_ms, text=None):
    """Return receipts only after both native input and core settlement verify."""
    validate_request(goal, steps, timeout_ms)
    if text is not None:
        host.tools._check_action(dict(type='type', text=text))
        host.need(steps == 1, 'MW_PROGRAM_TEXT_STEPS')
    moves = []
    # Preserve partial evidence on refusal; a delivered action is not undone.
    backend.program_moves = moves
    backend.program_attempts = []
    backend.program_clean_refusal = False
    if goal == 'focused':
        host.need(text is not None, 'MW_PROGRAM_FOCUSED_TEXT_REQUIRED')
        type_focused(backend, text, timeout_ms)
        return moves
    settled_frame = None
    for _ in range(steps):
        next_observation = None
        if settled_frame is not None:
            # A receipt settles the previous action; it is not the next planning
            # acquisition. Ask the shared publisher for a real post-settlement
            # capture, even if those pixels have not changed again.
            baseline = backend.observe(remaining_budget(backend, timeout_ms))['frame_ref']
            host.need(baseline['surface_id'] == settled_frame['surface_id'] == backend.surface_id,
                      'MW_PROGRAM_SURFACE')
            floor = max(baseline['generation'], settled_frame['generation'])
            backend.client.subscribe_frames(backend.surface_id,
                timeout_ms=remaining_budget(backend, timeout_ms))
            next_observation = wait_for_publication(backend, floor, remaining_budget(backend, timeout_ms))
        for retry in range(3):
            backend.program_clean_refusal = False
            observed = (next_observation if next_observation is not None else
                        backend.observe(remaining_budget(backend, timeout_ms)))
            next_observation = None
            sensed = backend.perceive(observed)
            if settled_frame is not None:
                host.need(sensed['frame'] == observed['frame_ref'] and
                          sensed['frame']['surface_id'] == settled_frame['surface_id'] and
                          sensed['frame']['generation'] > settled_frame['generation'],
                          'MW_PROGRAM_FRESH_FRAME')
            try:
                action, expectation, state, target = planner.plan_step(
                    sensed['observation'], sensed['table'], goal)
            except ProgramModelReplyRejected as error:
                backend.program_attempts.append(dict(status='refused_before_dispatch',
                    reason_code=error.code, message=str(error), submitted=False,
                    observation=sensed['observation'], table=sensed['table'],
                    model_decision=copy.deepcopy(planner.last_decision)))
                if retry < 2:
                    continue
                backend.program_clean_refusal = True
                raise
            attempt = dict(status='planned', observation=sensed['observation'], table=sensed['table'],
                           perception_transport=sensed.get('perception_transport'),
                           action=action, expectation=expectation, target=target,
                           battery_state_sha256=planner.battery_state_sha256)
            if isinstance(planner, MuseProgramPlanner):
                attempt['model_decision'] = planner.last_decision
            backend.program_attempts.append(attempt)
            attempt['status'] = 'goal_not_grounded'
            selected_goal = planner.grounded_goal if isinstance(planner, MuseProgramPlanner) else goal
            require_grounded_goal(sensed['table'], selected_goal, target)
            require_click_target(action,target)
            if text is not None:
                require_text_field(target)
            # Wender's validated target remains authoritative. Its on-target
            # effect predicate does not describe program display updates.
            expectation = effect_expectation(sensed['frame'])
            attempt['expectation'] = expectation
            budget = remaining_budget(backend, timeout_ms)
            journal_id = uuid.uuid4().hex
            attempt['status'] = 'intent_recording'
            attempt['intent_artifact'] = atomic_journal(backend.evidence / ('intent-' + journal_id + '.json'),
                dict(status='pending_dispatch', journal_id=journal_id, goal=goal,
                     frame=sensed['frame'], action=action, expectation=expectation,
                     target=target, battery_state_sha256=planner.battery_state_sha256))
            budget = remaining_budget(backend, timeout_ms)
            attempt['status'] = 'dispatch_or_settlement_pending'
            start = len(getattr(backend, 'frame_attempts', []))
            backend.active_attempt = attempt
            try:
                admitted = backend.propose(sensed, dict(action=action, expectation=expectation, target=target,
                    frame_attempt_limit=3 - retry, program_effect=True), budget)
                attempt['status'] = 'settlement_pending'
                verified = backend.wait_verify(admitted, remaining_budget(backend, timeout_ms))
                attempt['status'] = 'verified_move'
                attempt['receipt_artifact'] = atomic_journal(
                    backend.evidence / ('receipt-' + journal_id + '.json'),
                    dict(status='verified_move', journal_id=journal_id,
                         intent_artifact=attempt['intent_artifact'], verification=verified,
                         frame_attempts=getattr(backend, 'frame_attempts', [])[start:]))
                moves.append(dict(status='verified_move', before=sensed['frame_witness'],
                                  after=backend.retain(verified['receipt']['after_frame']),
                                  action=action, expectation=expectation, target=target,
                                  battery_state_sha256=planner.battery_state_sha256,
                                  verification=verified))
                settled_frame = dict(verified['receipt']['after_frame'])
                if text is not None:
                    type_after_focus(backend, moves[-1], text, timeout_ms)
                break
            except (OSError, ValueError, RuntimeError, KeyError, TypeError, AttributeError, host.ClientError,
                    host.tools.ToolRefusal, host.tools.VerificationFailed) as error:
                if attempt['status'] == 'verified_move' and settled_frame is not None:
                    # A following type owns its own attempt. Its acquisition or
                    # settlement failure cannot rewrite this settled click.
                    raise
                rows = getattr(backend, 'frame_attempts', [])[start:]
                if isinstance(error, ProgramObservationChanged):
                    # The current rebind has not submitted a proposal. Earlier
                    # explicit stale refusals prove nonexecution; other dispatch
                    # evidence forbids recovery.
                    stale_only = bool(rows) and all(r.get('status') == 'STALE_FRAME' for r in rows)
                    if not stale_only and (rows or attempt.get('proposal_id') or attempt.get('dispatch_artifact')):
                        attempt['status'] = 'input_uncertain'
                        raise
                    attempt.update(status='refused_before_dispatch', reason_code=error.code,
                                   rebind=copy.deepcopy(error.detail))
                    atomic_journal(backend.evidence / ('rebind-refused-' + journal_id + '.json'),
                        dict(status='refused_before_dispatch', intent_artifact=attempt['intent_artifact'],
                             reason_code=error.code, rebind=error.detail, submitted=False))
                    if retry < 2 and not stale_only:
                        baseline = backend.observe(remaining_budget(backend, timeout_ms))['frame_ref']
                        host.need(baseline['surface_id'] == backend.surface_id, 'MW_PROGRAM_SURFACE')
                        backend.client.subscribe_frames(backend.surface_id,
                            timeout_ms=remaining_budget(backend, timeout_ms))
                        next_observation = wait_for_publication(backend,
                            max(baseline['generation'], error.detail['fresh_frame']['generation']),
                            remaining_budget(backend, timeout_ms))
                        continue
                    backend.program_clean_refusal = True
                    raise
                nonexecution = (isinstance(error, host.tools.ToolRefusal) and rows and
                                rows[-1].get('status') == error.reason_code)
                if isinstance(error, host.tools.VerificationFailed):
                    attempt['status'] = 'input_uncertain'
                    journal_verification_failure(backend, attempt, error, journal_id)
                elif nonexecution:
                    attempt['status'] = 'refused_before_execution'
                    attempt['reason_code'] = error.reason_code
                elif ((rows and rows[-1].get('status') != 'intent_pending') or
                      attempt['status'] in ('settlement_pending', 'verified_move')):
                    attempt['status'] = 'input_uncertain'
                else:
                    attempt['status'] = 'refused_before_dispatch'
                raise
    return moves


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--identity', required=True)
    parser.add_argument('--goal', required=True)
    parser.add_argument('--text', help='Type at current focus with --goal focused, otherwise click a field; OCR readback follows')
    parser.add_argument('--steps', type=int, default=1)
    parser.add_argument('--timeout-ms', type=int, default=10000)
    parser.add_argument('--planner', choices=('rules', 'muse'), default='rules')
    parser.add_argument('--model-timeout-ms', type=int, default=120000)
    args = parser.parse_args(argv)
    return run_entry(args)


def run_entry(args):
    result = dict(schema='metaviewer.mw_run/v1', rc=6, verdict_code='MW_PROGRAM_CONFIG',
                  receipt=None, report=None)
    backend, evidence, message = None, None, None
    text = getattr(args, 'text', None)
    try:
        validate_request(args.goal, args.steps, args.timeout_ms)
        text = getattr(args, 'text', None)
        if text is not None:
            host.tools._check_action(dict(type='type', text=text))
            host.need(args.steps == 1, 'MW_PROGRAM_TEXT_STEPS')
        host.need(args.goal != 'focused' or text is not None, 'MW_PROGRAM_FOCUSED_TEXT_REQUIRED')
        host.need(getattr(args, 'planner', 'rules') in ('rules', 'muse') and
                  1 <= getattr(args, 'model_timeout_ms', 120000) <= 240000, 'MW_PROGRAM_PLANNER')
        base = private_evidence_base()
        evidence = base / 'metaviewer/runs' / uuid.uuid4().hex
        host.need(not evidence.is_relative_to(ROOT) and
                  not any(p.is_symlink() for p in (evidence, *evidence.parents)), 'MW_PRIVATE_OUTPUT')
        for path in (evidence.parent.parent, evidence.parent, evidence):
            path.mkdir(mode=0o700, exist_ok=True)
            metadata = path.lstat()
            host.need(not path.is_symlink() and stat.S_ISDIR(metadata.st_mode) and
                      metadata.st_uid == os.getuid() and stat.S_IMODE(metadata.st_mode) == 0o700,
                      'MW_PRIVATE_OUTPUT')
        result['report'] = str(evidence / 'report.json')
        with host.connect(os.environ) as client:
            backend = ProgramBackend(client, args.identity, evidence, os.environ)
            from metaviewer_agents.mw_run import resolve_wall_deadline_s
            budget_s = resolve_wall_deadline_s(args)
            host.need(budget_s > 5, 'MW_PROGRAM_DEADLINE')
            backend.run_deadline_ns = min(getattr(args, 'wall_deadline_mono_ns',
                time.monotonic_ns() + int(budget_s * 1e9)),
                time.monotonic_ns() + int(budget_s * 1e9)) - 5_000_000_000
            initial = backend.observe(remaining_budget(backend, args.timeout_ms))['frame_ref']
            client.subscribe_frames(backend.surface_id, timeout_ms=remaining_budget(backend, args.timeout_ms))
            backend.subscription = dict(status='subscribed', initial_generation=initial['generation'])
            try:
                backend.subscription['observation'] = backend.observe(
                    remaining_budget(backend, args.timeout_ms))['frame_ref']
                backend.subscription['freshness_authority'] = 'core_proposal_admission'
            # C2 localizes static first frames only when marks are requested.
            # Its output must stay in private RAM, never in the source tree.
                with marks_workspace() as marks:
                    backend.vision = VCorePerceptionAdapter(timeout=args.timeout_ms / 1000,
                        verify_lock=True, marks_out=marks, ocr_marks=True,
                        tessdata_prefix=os.environ.get('TESSDATA_PREFIX'))
                    try:
                        planner = None
                        if args.goal != 'focused':
                            planner = WenderSubprocessAdapter(wender_root=backend.wender,
                                timeout=args.timeout_ms / 1000, verify_lock=True)
                            if getattr(args, 'planner', 'rules') == 'muse':
                                planner = MuseProgramPlanner(backend, planner, args.model_timeout_ms)
                        moves = run_moves(backend, planner, args.goal, args.steps, args.timeout_ms,
                                          **({'text': text} if text is not None else {}))
                    finally:
                        backend.vision.close()
            finally:
                # The adapter's poller belongs to the surface, not this peer.
                # Its unsubscribe is global and must not stop parallel readers.
                backend.subscription['status'] = 'retained_for_surface_lifecycle'
        result.update(rc=0, verdict_code='PROGRAM_BOUNDED_ACTIONS_VERIFIED',
                      receipt=str(evidence / 'moves.json'))
        if getattr(backend, 'text_readback', None) == 'not_readable':
            result['verdict_code'] = 'PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE'
        host.ReplayOwner.write(Path(result['receipt']), (json.dumps(moves) + '\n').encode())
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, AttributeError,
            host.ClientError, host.tools.ToolRefusal, host.tools.VerificationFailed,
            host.subprocess.SubprocessError) as error:
        result.update(rc=6, receipt=None,
                      verdict_code=getattr(error, 'code', getattr(error, 'reason_code', 'MW_PROGRAM_CONFIG')))
        attempts = getattr(backend, 'program_attempts', [])
        last = attempts[-1] if attempts else {}
        # A retry can exhaust its deadline during acquisition or planning too.
        # The last recorded model rejection still proves no new dispatch began.
        clean_model_stop = (last.get('status') == 'refused_before_dispatch' and
                            last.get('submitted') is False and
                            last.get('reason_code') in
                            ('MW_PROGRAM_MODEL_FAILED', 'MW_PROGRAM_MODEL_TARGET'))
        clean_refusal = (clean_model_stop or
                         isinstance(error, ProgramObservationChanged) and
                         getattr(backend, 'program_clean_refusal', False))
        if ((getattr(backend, 'program_moves', []) and not clean_refusal) or any(a.get('status') in
                ('input_uncertain','dispatch_or_settlement_pending','settlement_pending')
                for a in attempts)):
            result.update(rc=5, verdict_code='INPUT_UNCERTAIN')
        message = str(error)[:4096]
        print('mw_run_program: ' + str(error), file=sys.stderr)
    if evidence is not None and evidence.is_dir():
        # [TARGET, unit decision] C2 marks belong to the removed RAM workspace.
        # Keep semantic observations without publishing a dangling file reference.
        observations = copy.deepcopy(getattr(backend, 'program_observations', []))
        for observation in observations:
            c2 = observation.get('c2')
            if isinstance(c2, dict) and 'marks_png' in c2:
                c2.pop('marks_png')
                c2['marks_png_lifetime'] = 'ephemeral_workspace_removed'
        report = dict(result, status=('bounded_actions' if result['rc'] == 0 else
                                    'input_uncertain' if result['rc'] == 5 else 'refused'),
                      goal_completed=None, moves=getattr(backend, 'program_moves', []),
                      attempts=getattr(backend, 'program_attempts', []),
                      observations=observations, message=message,
                      subscription=getattr(backend, 'subscription', None),
                      program_binding=getattr(backend, 'program_binding', None),
                      frame_attempts=getattr(backend, 'frame_attempts', []))
        if text is not None:
            report['text_readback'] = getattr(backend, 'text_readback', None)
            report['readback_text'] = next((a['readback_text'] for a in reversed(
                getattr(backend, 'program_attempts', [])) if 'readback_text' in a), None)
        try:
            host.ReplayOwner.write(evidence / 'report.json', (json.dumps(report) + '\n').encode())
        except OSError:
            uncertain = bool(getattr(backend, 'program_moves', [])) or result['rc'] == 5
            result.update(rc=5 if uncertain else 6,
                          verdict_code='INPUT_UNCERTAIN' if uncertain else 'MW_PRIVATE_OUTPUT', receipt=None)
    print(json.dumps(result))
    return result['rc']


if __name__ == '__main__':
    sys.exit(main())
