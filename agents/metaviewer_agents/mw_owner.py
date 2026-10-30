"""Custodied MemoryWeb execution; corpus bytes never select Python owners.

[TARGET, unit decision] The installed seam is the assembly backend's observe,
perceive, state, ax, ownership, propose and wait_verify operations. Its propose
operation owns the core/AdmittedExecutor boundary. This module has no native
input capability. Only T1 element anchors and registered AX predicates are
supported; pixel templates, visual masks and promotion refuse.
[TARGET, unit decision] slot_values is an invocation-only in-process mapping.
Private slots use fresh focused AX text for code-point lengths and the existing
core type proposal/receipt path. No clipboard owner or native paste exists.
[TARGET, unit decision] Site backends expose read-only network_context returning
{"mode": "open" | "allowlisted/proxied" | "legacy"}; no declaration is inferred.
Replay backends expose offline_proof with fixtures_offline exactly True.
The notice is an explicit private record of this invocation, not proof
of an external announcement. Policies requiring advance notice refuse until
that interval has actually elapsed. No workflow scripts are executed.
"""
from contextlib import contextmanager
from datetime import date
import copy
import hashlib
import hmac
import os
from pathlib import Path
import re
import stat
import sys
import time
import uuid

from .mw_handoff import HandoffLatch, HandoffResult
from .executor import AdmittedExecutor
from .tools import _check_action, _check_verdict_admitted


class OwnerRefused(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def need(value, code='OUT_OF_SUPPORT'):
    if not value:
        raise OwnerRefused(code)


def wender_api():
    from .perception.deps_lock import resolve_locked_component
    root = resolve_locked_component('wender-agent')
    sys.path.insert(0, str(root))
    from tools import memoryweb_gate as gate
    from wender.learn import mw_workflow as mw
    from wender.learn.script_live import LegacyDispatchOwner
    from wender.scripts.types import AdmissionCheck, Truth, Reason
    need(Path(gate.__file__).resolve().is_relative_to(root), 'DEPENDENCY_BINDING')
    return gate, mw, LegacyDispatchOwner, AdmissionCheck, Truth, Reason


def bounded_read(path, root, limit=65536):
    path, root = Path(path).absolute(), Path(root).resolve(strict=True)
    need(path.is_relative_to(root), 'MW_CONTAINMENT')
    need(not any(p.is_symlink() for p in (path, *path.parents)), 'MW_CONTAINMENT')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        metadata = os.fstat(stream.fileno())
        need(stat.S_ISREG(metadata.st_mode) and metadata.st_size <= limit, 'MW_CAPACITY')
        raw = stream.read(limit + 1)
    need(len(raw) <= limit, 'MW_CAPACITY')
    return raw


class Corpus:
    """Read-only canonical documents validated against both pinned schema sets."""
    def __init__(self, root, selector, api=None):
        self.api = api or wender_api()
        self.gate, self.mw = self.api[:2]
        gate = self.gate
        self.root = Path(root).resolve(strict=True)
        need(re.fullmatch(r'[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+', selector), 'MW_SELECTOR')
        site, workflow = selector.split('/')
        self.path = self.root / 'sites' / site / 'workflows' / (workflow + '.json')
        bundle_raw = gate.DOCS.joinpath('mw.v1.schema.json').read_bytes()
        need(hashlib.sha256(bundle_raw).hexdigest() == gate.SCHEMA_PIN, 'MW_SCHEMA_PIN')
        self.bundle = gate.strict_load(bundle_raw)
        self.schemas = {}
        for kind in ('site', 'workflow', 'step', 'run'):
            schema = gate.strict_load(bounded_read(
                self.root / 'standards' / 'schemas' / (kind + '.v1.json'), self.root, 1024 * 1024))
            # MemoryWeb projections must be byte-semantically identical to the
            # definitions pinned by Wender, including their closed root shape.
            projection = {k: v for k, v in schema.items() if k not in ('$defs', '$schema', '$id')}
            need(schema.get('$defs') == self.bundle['$defs'] and
                 projection == self.bundle['$defs'][kind], 'MW_SCHEMA_PIN')
            self.schemas[kind] = schema
        self.site = self.document(self.root / 'sites' / site / 'site.json', 'site')
        self.workflow = self.document(self.path, 'workflow')
        need(self.site['id'] == site and self.workflow['site_id'] == site and
             self.workflow['id'] == workflow, 'MW_IDENTITY')
        self.pins = {p: hashlib.sha256(bounded_read(p, self.root)).hexdigest() for p in
                     (self.path, self.root / 'sites' / site / 'site.json')}

    def document(self, path, kind):
        raw = bounded_read(path, self.root)
        value = self.gate.strict_load(raw)
        need(raw == (self.gate.canon(value) + '\n').encode(), 'MW_CANONICAL')
        need(self.gate.conforms(value, self.schemas[kind], self.bundle['$defs']), 'MW_SCHEMA')
        return value

    def intact(self):
        return all(hashlib.sha256(bounded_read(p, self.root)).hexdigest() == pin
                   for p, pin in self.pins.items())


class PrivateSlots:
    """Invocation-owned values; never resolve values or paths from corpus bytes."""
    def __init__(self, owner, values):
        need(values is None or type(values) is dict, 'MW_SLOT_SOURCE')
        self.owner = owner
        self.values = dict(values or {})
        self.pending = None
        self.normalized = {}

    def normalize(self, slot):
        # [TARGET, unit decision] Normalize one terminal line ending only.
        slot_id = slot['slot_id']
        value = self.values[slot_id]
        if type(value) is str and value.endswith('\n'):
            value = value[:-2] if value.endswith('\r\n') else value[:-1]
        if type(value) is str:
            # Match printable Unicode plus space separators (native IsPrint).
            need(all(c.isprintable() or (c.isspace() and ord(c) >= 160 and
                     c not in '\u2028\u2029') for c in value),
                 'MW_TEXT_UNPRINTABLE: ' + slot_id)
        try:
            self.owner.check_text(value, slot['max_length'])
        except OwnerRefused as error:
            if error.code == 'MW_TEXT_ENCODING':
                raise OwnerRefused('MW_TEXT_UNPRINTABLE: ' + slot_id) from None
            raise
        if value != self.values[slot_id]:
            self.values[slot_id] = value
            self.normalized[slot_id] = 'trailing_newline_removed'
        return value

    def admit(self, slot, state):
        o = self.owner
        need(slot in o.corpus.workflow['text_slots'] and slot['slot_id'] in self.values and
             not slot['chip_clear_steps'], 'MW_SLOT_SOURCE')
        return o.answer(True)

    def read(self, slot, state, max_bytes):
        o = self.owner
        self.admit(slot, state)
        value = self.normalize(slot)
        o.check_text(value, min(slot['max_length'], max_bytes))
        binding = o.length_binding(slot['slot_id'])
        initial = o.acquire(binding.predicate, state.deadline_ns).value
        need(not slot['clear_first'] or initial == 0 and initial in slot['empty_len_allowed'], 'MW_SLOT_INITIAL')
        self.pending = (slot['slot_id'], value, initial)
        return o.mw.PrivateSlot(value, initial, o.scope, o.authority, 'private_pipe', o.answer(True))

    def verify(self, slot, state, length, initial):
        o = self.owner
        return o.answer(self.pending is not None and self.pending[0] == slot['slot_id'] and
                        len(self.pending[1]) == length and self.pending[2] == initial and
                        bool(o.receipts) and o.last_send == state.input_ns)


class ReplayOwner:
    def __init__(self, backend, corpus, output, *, mode='replay', notice=None, slot_values=None):
        need(mode in ('replay', 'site'), 'MW_NETWORK')
        self.mode = mode
        self.network = 'offline fixtures' if mode == 'replay' else None
        self.backend, self.corpus = backend, corpus
        self.gate, self.mw, dispatch, self.Check, self.Truth, self.Reason = corpus.api
        self.output = Path(output).absolute()
        need(self.output.parent.is_dir() and self.output.parent.stat().st_uid == os.geteuid() and
             self.output.parent.stat().st_mode & 0o777 == 0o700,
             'MW_PRIVATE_OUTPUT')
        need(not any(p.is_symlink() for p in (self.output, *self.output.parents)), 'MW_PRIVATE_OUTPUT')
        self.scope, self.authority = object(), object()
        self.slots = PrivateSlots(self, slot_values)
        self.notice = copy.deepcopy(notice)
        self.latest = None
        self.handoff = HandoffLatch(self.output.with_suffix('.handoff.json'))
        self.send_ready = False
        self.publications, self.targets = {}, {}
        self.receipts = []
        self.events, self.staged = [], {}
        self.secret = os.urandom(32)
        self.used = 0
        self.cancelled = False
        self.final_pass = False
        self.last_send = None
        self.last_publication_frame = None
        self.limits = self.mw.WorkflowLimits(65536, 128, 128, 2048, 16 * 1024 * 1024,
            4 * 1024 * 1024, 4096, 2048, 8 * 1024 * 1024, 4096, 65536,
            1_000_000_000, 1_000_000_000, 30_000_000_000, time.monotonic_ns() + 120_000_000_000)
        self.context_value = self.gate.ValidationContext(corpus.root, as_of=date.today(),
            capability_check=self.capability_check, evidence_check=self.evidence_check)
        self.surface = object()
        self.dispatch = dispatch(self.surface)

    def answer(self, value):
        return self.Check(self.Truth.TRUE, None) if value else self.Check(self.Truth.FALSE, self.Reason.MISSING)

    def capability_check(self, obj, predicate):
        if predicate is not None:
            ok = self.predicate_supported(predicate)
        else:
            ok = (obj.get('engine') == 'wender-agent' and
                  set(obj.get('required_capabilities', [])) <= {'mv.ax.present.v1', 'mv.ax.focus.v1'})
        return self.gate.GateResult(0, 'PASS') if ok else self.gate.GateResult(5, 'CAPABILITY_MISSING')

    def evidence_check(self, kind, value, related):
        # Provenance file/quote/hash checks belong to the real gate. Replay
        # claims no statistics, script effects, promotion, ordering or RAM proof.
        ok = kind == 'provenance' and self.corpus.intact()
        if kind == 'focus':
            ok = any(p.get('capability_id') == 'mv.ax.focus.v1' for p in value['preconditions'])
        return self.gate.GateResult(0, 'PASS') if ok else self.gate.GateResult(5, 'EVIDENCE_DENIED')

    @contextmanager
    def pin(self, path):
        need(path == self.corpus.path and self.corpus.intact(), 'SEAL_MISMATCH')
        yield self.mw.PinnedArtifact(path, self.corpus.pins[path], self.answer(True))

    def check(self, *args):
        if len(args) == 1:  # artifact.check
            pin = args[0]
            return self.answer(pin.path == self.corpus.path and pin.sha256 == self.corpus.pins[pin.path]
                               and self.corpus.intact())
        phase, workflow, scope, authority = args
        need(scope is self.scope and authority is self.authority and workflow == self.corpus.workflow)
        if phase == 'commit' and self.handoff.latched:
            return self.answer(True)  # Persist only; never poll a latched capsule.
        if phase != 'commit':
            self.handoff_guard()
        if phase == 'send':
            self.send_ready = False
        self.check_network()
        self.check_notice()
        owned = self.backend.call('ownership')
        need(owned.get('profile') == 'mv-live-1' and len(owned.get('capsules', [])) == 1, 'MW_LEASE')
        if phase == 'send':
            # Pace and detect STOP before Wender records intent/INPUT_UNCERTAIN.
            pace = self.pace()
            now = time.monotonic_ns()
            wake = max(now, self.last_send + pace * 1_000_000) if self.last_send is not None else now
            need(wake < self.limits.deadline_ns, 'MW_DEADLINE')
            if wake > now:
                time.sleep((wake - now) / 1e9)
            self.stop_check(self.sense(self.limits.deadline_ns))
            self.send_ready = True
        return self.answer(True)  # Core rechecks the dispatch lease at propose.

    def check_network(self):
        try:
            reply = self.backend.call('offline_proof' if self.mode == 'replay' else 'network_context')
        except Exception as error:
            raise OwnerRefused('MW_NETWORK') from error
        need(isinstance(reply, dict), 'MW_NETWORK')
        if self.mode == 'replay':
            need(reply.get('fixtures_offline') is True, 'MW_NETWORK')
        else:
            declared = reply.get('mode')
            need(declared in ('open', 'allowlisted/proxied', 'legacy'), 'MW_NETWORK')
            need(self.network is None or self.network == declared, 'MW_NETWORK')
            self.network = declared
        return reply

    def check_notice(self):
        need(isinstance(self.notice, dict) and self.notice.get('mode') == self.mode and
             self.notice.get('network') == self.network and self.notice.get('acknowledged') is True and
             type(self.notice.get('mono_ns')) is int and self.notice['mono_ns'] <= time.monotonic_ns(),
             'MW_NOTICE')
        for policy in (self.corpus.site['execution_policy'], self.corpus.workflow['execution_policy']):
            need(not policy['allow_capsule_restart'], 'MW_RESTART')
            need(time.monotonic_ns() - self.notice['mono_ns'] >= policy['min_notice_s'] * 1_000_000_000,
                 'MW_NOTICE')
            need(not policy['requires_operator_go_ahead_on_write'], 'MW_WRITE_APPROVAL')

    def inventory(self, workflow):
        return {'task': tuple(s['seq'] for s in workflow['steps'])}

    @staticmethod
    def predicate_supported(predicate):
        if not isinstance(predicate, dict):
            return False
        bindings = predicate.get('bindings')
        return (predicate.get('kind') == 'state_signal' and predicate.get('comparison') == 'truth' and
                predicate.get('snapshot_ref') is None and predicate.get('evidence_refs') == [] and
                predicate.get('capability_id') in ('mv.ax.present.v1', 'mv.ax.focus.v1') and
                isinstance(bindings, list) and len(bindings) == 1 and
                bindings[0].get('name') == 'name' and bindings[0].get('type') == 'string' and
                isinstance(bindings[0].get('value'), str) and bool(bindings[0]['value']))

    def handoff_guard(self):
        need(not self.handoff.latched, 'MW_HANDOFF_REQUIRED')

    def stop_check(self, sensed):
        self.handoff_guard()
        finished = {self.gate.strict_load(raw)['step_seq'] for raw in self.events
                    if self.gate.strict_load(raw)['kind'] in
                    ('verified', 'failed', 'satisfied_skip', 'condition_skip')}
        seq = next((s['seq'] for s in self.corpus.workflow['steps'] if s['seq'] not in finished),
                   self.corpus.workflow['steps'][-1]['seq'])
        if self.handoff.inspect(sensed, seq, self.write):
            # Pinned docs/spec/MEMORYWEB_PROTOCOL.md:555; mw_workflow._Stop:397.
            raise self.mw._Stop('HUMAN_HANDOFF', 4, 'MW_HANDOFF_REQUIRED')

    def sense(self, deadline):
        self.handoff_guard()
        need(time.monotonic_ns() < deadline, 'MW_DEADLINE')
        start = time.monotonic_ns()
        observed = self.backend.call('observe', timeout_ms=5000)
        sensed = self.backend.call('perceive', observed=observed)
        frame, witness = sensed['frame'], sensed['frame_witness']
        need(frame == observed['frame_ref'] and sensed['table']['frame_sha256'] == frame['sha256'] and
             witness.get('sha256') == frame['sha256'] and witness.get('generation') == frame['generation'] and
             witness.get('surface_id') == frame['surface_id'] and type(witness.get('bytes')) is int and
             witness['bytes'] > 0 and witness.get('artifact'), 'MW_FRAME_BINDING')
        for previous in (self.last_publication_frame,
                         self.receipts[-1]['receipt']['after_frame'] if self.receipts else None):
            if previous is not None:
                need(frame['surface_id'] == previous['surface_id'] and
                     frame['generation'] >= previous['generation'] and
                     (frame['generation'] != previous['generation'] or frame['sha256'] == previous['sha256']),
                     'MW_STALE_PUBLICATION')
        sensed['state'] = self.backend.call('state', sensed=sensed)
        from .wender_bridge import validate_state
        validate_state(sensed['state'])
        sensed['observed'] = observed
        self.stop_check(sensed)
        tree = self.backend.call('ax')
        need(isinstance(tree, dict) and isinstance(tree.get('nodes', tree.get('elements')), list), 'MW_AX')
        sensed['ax'] = tree.get('nodes', tree.get('elements'))
        sensed['capture_start'] = start
        need(len(self.gate.canon(sensed).encode()) <= self.limits.peak_bytes, 'MW_CAPACITY')
        self.last_publication_frame = copy.deepcopy(frame)
        self.latest = sensed
        return sensed

    def publication(self, predicate, sensed, value):
        frame = sensed['frame']
        publication = f"{frame['surface_id']}:{frame['generation']}:{frame['sha256']}"
        result = self.mw.ObservationValue(self.scope, self.authority, publication,
            sensed['capture_start'], time.monotonic_ns(), predicate['capability_id'], '1',
            'integer' if type(value) is int else 'boolean',
            'unicode_code_points' if type(value) is int else 'truth', value, True, None)
        self.publications[id(result)] = result
        need(len(self.publications) <= self.limits.acquisitions, 'MW_CAPACITY')
        return result

    def length_binding(self, slot_id):
        steps = [s for s in self.corpus.workflow['steps']
                 if s['action']['kind'] == 'paste' and s['action']['text_slot'] == slot_id]
        names = {p['bindings'][0]['value'] for s in steps for p in s['preconditions']
                 if p['capability_id'] == 'mv.ax.focus.v1' and self.predicate_supported(p)}
        need(len(names) == 1, 'MW_SLOT_FOCUS')
        predicate = dict(kind='state_signal', capability_id='mv.ax.length.v1',
            bindings=[dict(name='name', type='string', value=next(iter(names)))],
            evidence_refs=[], comparison='truth', snapshot_ref=None)
        return self.mw._SlotLengthBinding(slot_id, predicate, '1', 'unicode_code_points')

    def acquire(self, predicate, deadline):
        length = any(predicate == self.length_binding(s['slot_id']).predicate
                     for s in self.corpus.workflow['text_slots'])
        need(length or self.predicate_supported(predicate))
        sensed = self.sense(deadline)
        name = predicate['bindings'][0]['value']
        rows = [r for r in sensed['ax'] if (r.get('name') == name or r.get('text') == name)]
        if length:
            need(len(rows) == 1 and (rows[0].get('focused') is True or
                 rows[0].get('states', {}).get('focused') in (True, 'true')), 'MW_SLOT_FOCUS')
            text = rows[0].get('value', rows[0].get('text'))
            need(type(text) is str, 'MW_SLOT_LENGTH')
            return self.publication(predicate, sensed, len(text))
        value = bool(rows)
        if predicate['capability_id'] == 'mv.ax.focus.v1':
            value = len(rows) == 1 and (rows[0].get('focused') is True or
                                       rows[0].get('states', {}).get('focused') in (True, 'true'))
        else:
            value = value and any(n['name'] == name for n in sensed['state']['nodes'])
        return self.publication(predicate, sensed, value)

    def validate(self, *args):
        if len(args) == 1:
            value = args[0]
            return self.answer(self.publications.get(id(value)) is value and
                               value.scope is self.scope and value.authority is self.authority)
        path, inventory = args
        saved = self.staged.get(Path(path))
        return self.answer(saved is not None and saved[1] == inventory and
            bounded_read(path, self.output.parent) == saved[0] and saved[3] == self.read(self.limits.journal_bytes))

    def pace(self):
        # [TARGET, unit decision] Refuse policy pacing above 5000 ms; never clamp.
        values = [p['min_action_pace_ms'] for p in
                  (self.corpus.site['execution_policy'], self.corpus.workflow['execution_policy'])]
        need(all(type(v) is int and 0 <= v <= 5000 for v in values), 'MW_PACE_POLICY')
        return max(values)

    def static_action(self, action):
        kind = action.get('kind')
        need(kind in ('click', 'right_click', 'paste', 'key', 'type', 'scroll', 'wait_signal'),
             'MW_UNSUPPORTED_ACTION')
        self.pace()
        timeout = action.get('delivery_budget_ms', 30000)
        need(type(timeout) is int and 0 < timeout <= 60000, 'MW_DEADLINE')
        if kind in ('click', 'right_click'):
            need(type(action.get('button')) is int and action['button'] in (1, 2, 3) and
                 (kind != 'right_click' or action['button'] == 3), 'MW_UNSUPPORTED_ACTION')
        if kind == 'key':
            key = action.get('key_name')
            need(isinstance(key, str), 'MW_KEY_POLICY')
            parts = key.split('+')
            # Mirror daemon-adapter/internal/capsule/manager.go:874-878 (ASCII
            # chord grammar/arity) and core/src/admission/mod.rs:307-311 (nonempty
            # parts and joined length). Validate before normalization/admission.
            need(1 <= len(parts) <= 8 and len(key) <= 32 and
                 all(re.fullmatch(r'[A-Za-z0-9_]{1,32}', part) for part in parts),
                 'MW_KEY_POLICY')
            normalized = [part.casefold() for part in parts]
            need(all(part not in ('escape', 'esc') for part in normalized), 'MW_KEY_POLICY')
            for policy in (self.corpus.site['execution_policy'], self.corpus.workflow['execution_policy']):
                forbidden = {part.casefold() for part in policy['forbidden_keys']}
                need(all(part not in forbidden for part in normalized), 'MW_KEY_POLICY')
        if kind == 'scroll':
            need('point' not in action, 'MW_SCROLL_POINT')
            _check_action(dict(type='scroll', dx=action.get('dx_px'), dy=action.get('dy_px')))

    def supports(self, workflow):
        self.text_refusal = None
        try:
            self.pace()
            need(workflow['status'] == 'draft')
            for slot in workflow['text_slots']:
                need(slot['slot_id'] in self.slots.values and not slot['chip_clear_steps'])
                self.slots.normalize(slot)
                self.length_binding(slot['slot_id'])
            need(bool(workflow['oracle']['postconditions']))
            predicates = list(workflow['preconditions']) + list(workflow['oracle']['postconditions'])
            for step in workflow['steps']:
                action, target = step['action'], step['target']
                # [TARGET, unit decision] Refuse all wait_signal steps here:
                # translate() has no executable mapping for that action.
                need(action['kind'] not in ('type', 'wait_signal') and action['path'] == 'coordinates')
                self.static_action(action)
                need(target is None or self.target_supported(target))
                need(not step['fallback_targets'] and step['when'] is None and step['repeat'] is None)
                if action['kind'] in ('click', 'right_click'):
                    need(target is not None)
                if action['kind'] == 'scroll':
                    need(target is None)
                if action['kind'] == 'paste':
                    need(target is None and any(s['slot_id'] == action['text_slot'] for s in workflow['text_slots']))
                if action['kind'] in ('key', 'paste'):
                    need(any(p['capability_id'] == 'mv.ax.focus.v1' for p in step['preconditions']))
                predicates.extend(step['preconditions'])
                if step['already_satisfied'] is not None:
                    predicates.append(step['already_satisfied'])
                if target is not None:
                    predicates.append(target['frame_predicate'])
                need(self.verifier(step['verify']).result is self.Truth.TRUE)
            need(all(self.predicate_supported(p) for p in predicates))
            return self.answer(True)
        except (OwnerRefused, ValueError) as error:
            if isinstance(error, OwnerRefused) and error.code.startswith('MW_TEXT_UNPRINTABLE:'):
                self.text_refusal = error.code
            return self.answer(False)

    @staticmethod
    def target_supported(target):
        return (target.get('rung') == 'T1' and target.get('frame_kind') == 'element' and
                target.get('required_anchor_refs') == [target.get('anchor_ref')] and
                target.get('consistency_tolerance_px') == 0 and target.get('relative_xy_bps') is None and
                isinstance(target.get('anchor_ref'), str) and target['anchor_ref'].startswith('ax:'))

    def target(self, spec, state, deadline):
        if spec is None:  # Scroll's required grounding is a publication, never a pointer input.
            sensed = self.sense(deadline)
            observation = self.publication(dict(capability_id='mv.frame.publication.v1'), sensed, True)
            point = (0, 0)
        else:
            observation = self.acquire(spec['frame_predicate'], deadline)
            need(observation.value is True, 'MW_TARGET_FRAME')
            need(self.target_supported(spec))
            name = spec['anchor_ref'][3:]
            rows = [n for n in self.latest['state']['nodes'] if n['name'] == name and n['actionable']]
            need(len(rows) == 1, 'MW_TARGET')
            row = rows[0]
            AdmittedExecutor.check_target(row, latest=self.latest['state']['nodes'], frame=self.latest['frame'])
            x, y, w, h = row['box']
            point = (x + w // 2 + spec['offset_dx_px'], y + h // 2 + spec['offset_dy_px'])
            need(x <= point[0] < x + w and y <= point[1] < y + h, 'MW_TARGET')
        target = self.mw.GroundedTarget(point, None, observation, self.scope, self.authority,
            self.answer(True), self, deadline, (0, 0))
        self.targets[id(target)] = (target, copy.deepcopy(spec), copy.deepcopy(self.latest))
        self.used += len(self.gate.canon(self.latest).encode())
        need(self.used <= self.limits.retained_bytes and len(self.targets) <= self.limits.steps, 'MW_CAPACITY')
        return target

    def validate_target(self, spec, value, state):
        saved = self.targets.get(id(value))
        return self.answer(saved is not None and saved[0] is value and saved[1] == spec and
            value.support_owner is self and time.monotonic_ns() < value.expires_ns and
            self.validate(value.observation).result is self.Truth.TRUE)

    def verifier(self, spec):
        return self.answer(spec['mode'] == 'state_signal' and self.predicate_supported(spec['predicate']) and
                           spec['busy_predicate'] is None and not spec['fallback_verifiers'])

    def observe_verifier(self, spec, state, deadline):
        need(self.verifier(spec).result is self.Truth.TRUE)
        return self.acquire(spec['predicate'], deadline)

    def equivalent(self, a, b):
        return self.answer(a == b)

    def satisfaction(self, step, state):
        predicate = step['already_satisfied']
        return self.answer(self.predicate_supported(predicate) and
                           self.acquire(predicate, state.deadline_ns).value is True)

    def changed(self, predicate, baseline, current):
        return self.answer(False)  # No registered RAM comparison in this slice.

    def focus(self, step, state):
        predicates = [p for p in step['preconditions'] if p['capability_id'] == 'mv.ax.focus.v1']
        return self.answer(bool(predicates) and all(self.acquire(p, state.deadline_ns).value is True for p in predicates))

    def plan(self, action, target):
        return self.translate(action, target)

    def translate(self, action, target):
        self.static_action(action)
        kind = action.get('kind')
        need(kind in ('click', 'right_click', 'key', 'type', 'scroll'), 'MW_UNSUPPORTED_ACTION')
        if kind in ('click', 'right_click'):
            saved = self.targets.get(id(target))
            need(saved is not None and saved[0] is target and time.monotonic_ns() < target.expires_ns,
                 'MW_TARGET')
            need(type(action.get('button')) is int and action['button'] in (1, 2, 3) and
                 (kind != 'right_click' or action['button'] == 3), 'MW_UNSUPPORTED_ACTION')
            result = dict(type='click', x=target.point[0], y=target.point[1],
                        button='right' if kind == 'right_click' else {1: 'left', 2: 'middle', 3: 'right'}[action['button']])
            _check_action(result)
            return result
        if kind == 'key':
            key = action['key_name']
            result = dict(type='key', keys=key.split('+'))
        elif kind == 'type':
            self.check_text(action.get('text'))
            result = dict(type='type', text=action.get('text'))
        else:
            # Wender needs an internal GroundedTarget even for point-free scroll;
            # a declared target or point always refuses, before proposal.
            saved = self.targets.get(id(target)) if target is not None else None
            need(target is None or saved is not None and saved[1] is None,
                 'MW_SCROLL_POINT')
            result = dict(type='scroll', dx=action.get('dx_px'), dy=action.get('dy_px'))
        _check_action(result)
        return result

    def action(self, action, target):
        self.handoff_guard()
        try:
            if action.get('kind') == 'paste':
                self.static_action(action)
                need(any(s['slot_id'] == action.get('text_slot') for s in self.corpus.workflow['text_slots']),
                     'MW_UNSUPPORTED_ACTION')
            else:
                self.translate(action, target)
        except OwnerRefused as error:
            if error.code == 'MW_DEADLINE':
                # [TARGET, unit decision] Pinned Wender's pre-intent stop emits
                # its schema-valid usage failure receipt, without uncertain input.
                raise self.mw._Stop('USAGE_SCHEMA', 2) from error
            raise
        return self.answer(True)

    def check_text(self, value, max_length=65536):
        need(type(value) is str and 0 < len(value) <= min(max_length, 65536, self.limits.slot_bytes),
             'MW_TEXT_BOUNDS')
        need(all(ord(c) >= 32 and not 127 <= ord(c) <= 159 and
                 not 0xD800 <= ord(c) <= 0xDFFF and not 0x202A <= ord(c) <= 0x202E and
                 not 0x2066 <= ord(c) <= 0x2069 and ord(c) not in (0x061C, 0x200E, 0x200F)
                 for c in value), 'MW_TEXT_ENCODING')
        need(len(value.encode('utf-8')) <= min(16384, self.limits.slot_bytes), 'MW_TEXT_BOUNDS')

    def send_private(self, action, target, payload):
        self.handoff_guard()
        pending = self.slots.pending
        need(action.get('kind') == 'paste' and pending is not None and
             action.get('text_slot') == pending[0] and type(payload) is bytes and
             payload == pending[1].encode('utf-8'), 'MW_SLOT_SOURCE')
        slot = next(s for s in self.corpus.workflow['text_slots'] if s['slot_id'] == pending[0])
        self.check_text(pending[1], slot['max_length'])
        return self.send(dict(action, kind='type', text=pending[1]), target)

    def send(self, action, target):
        self.handoff_guard()
        translated = self.translate(action, target)
        ready, self.send_ready = self.send_ready, False
        need(ready and self.latest is not None, 'MW_OBSERVATION_REQUIRED')
        current = self.latest
        if translated['type'] in ('type', 'key'):
            focused = current
            need(sum(r.get('focused') is True or r.get('states', {}).get('focused') in (True, 'true')
                     for r in focused['ax']) == 1, 'MW_FOCUS')
        self.check('dispatch', self.corpus.workflow, self.scope, self.authority)
        sensed = current
        frame = sensed['frame']
        expectation = dict(type='changed_region', bbox=dict(x=0, y=0, w=frame['width'], h=frame['height']))
        timeout = action.get('delivery_budget_ms', 30000)
        boundary = time.monotonic_ns()
        admitted = self.backend.call('propose', sensed=sensed,
            plan=dict(action=translated, expectation=expectation), max_ms=timeout)
        verdict = _check_verdict_admitted(admitted.get('verdict'))
        need(verdict['proposal_id'] == admitted.get('proposal_id'), 'MW_ADMISSION_BINDING')
        verified = self.backend.call('wait_verify', admitted=admitted, timeout_ms=timeout)
        receipt = verified['receipt']
        input_ns = verified.get('input_mono_ns')
        need(verified.get('status') == 'verified' and receipt.get('verified') is True and
             receipt.get('proposal_id') == admitted.get('proposal_id') and bool(admitted.get('proposal_id')) and
             receipt.get('native_evidence', {}).get('input_mono_ns') == input_ns and
             receipt.get('native_evidence', {}).get('surface_id') == frame['surface_id'] and
             admitted.get('native_evidence', {}).get('input_mono_ns') == input_ns and
             verified.get('focus_verified') is True and type(input_ns) is int and input_ns > 0 and
             boundary <= input_ns <= time.monotonic_ns() and
             receipt.get('after_frame', {}).get('surface_id') == frame['surface_id'] and
             verified.get('frame_sha256') == receipt.get('after_frame', {}).get('sha256') and
             verified.get('receipt_binding_negative_control') == 'PASS', 'MW_RECEIPT_MISMATCH')
        # Retain only the verified binding, never opaque backend evidence or text.
        self.receipts.append(dict(mode=self.mode, network=self.network, status='verified', focus_verified=True, input_mono_ns=input_ns,
            frame_sha256=verified['frame_sha256'], receipt_binding_negative_control='PASS',
            receipt=dict(verified=True, proposal_id=receipt['proposal_id'],
                after_frame={k: receipt['after_frame'][k] for k in
                             ('surface_id', 'sha256', 'generation') if k in receipt['after_frame']},
                native_evidence=dict(surface_id=frame['surface_id'], input_mono_ns=input_ns))))
        if action.get('kind') == 'type' and self.slots.pending:
            normalization = self.slots.normalized.get(self.slots.pending[0])
            if normalization:
                self.receipts[-1]['normalized'] = normalization
        self.last_send = input_ns
        return input_ns

    def final(self, workflow):
        self.final_pass = all(self.acquire(p, self.limits.deadline_ns).value is True
                              for p in workflow['oracle']['postconditions'])
        return self.answer(self.final_pass and bool(workflow['oracle']['postconditions']))

    def reserve(self, *args):
        amount = args[1] if isinstance(args[0], str) else args[0]
        need(type(amount) is int and amount > 0 and not self.cancelled, 'MW_CAPACITY')
        # Synchronous reads retain metadata only; released peak reservations do
        # not accumulate. Journal storage has its independent absolute cap.
        need(amount <= self.limits.journal_bytes, 'MW_CAPACITY')
        return self.answer(True)

    def cancel(self, timeout):
        self.cancelled = True
        return self.answer(type(timeout) is int and timeout > 0)

    def drain(self, timeout):
        return self.answer(self.cancelled and type(timeout) is int and timeout > 0)

    def t0(self, *args):
        raise OwnerRefused('MW_RAM_UNSUPPORTED')

    change = t0

    def read(self, budget):
        raw = b''.join(self.events)
        need(len(raw) <= budget, 'MW_CAPACITY')
        return raw

    def digest(self, raw, prev):
        return hmac.new(self.secret, (prev or '').encode() + b'\0' + raw, 'sha256').hexdigest()

    def authenticate(self, event):
        payload = {k: v for k, v in event.items() if k != 'digest'}
        return self.answer(hmac.compare_digest(event['digest'], self.digest(self.gate.canon(payload).encode(), event['prev'])))

    def recover(self, *args):
        return self.answer(False)  # Fresh replay only; never retry uncertain input.

    def append(self, raw):
        event = self.gate.strict_load(raw)
        need(self.authenticate(event).result is self.Truth.TRUE, 'MW_JOURNAL')
        need(len(self.events) < self.limits.event_count and
             len(self.read(self.limits.journal_bytes)) + len(raw) <= self.limits.journal_bytes, 'MW_CAPACITY')
        # Durable metadata is private and contains no frame or typed text.
        path = self.output.with_suffix('.events.jsonl')
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW
        if not self.events:
            flags |= os.O_EXCL
        fd = os.open(path, flags, 0o600)
        with os.fdopen(fd, 'ab') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        self.events.append(raw)
        return self.answer(True)

    def stage(self, summary, inventory, output):
        need(Path(output) == self.output, 'MW_JOURNAL')
        dispositions = {s['seq']: 'not_reached' for s in self.corpus.workflow['steps']}
        outstanding = set()
        for raw in self.events:
            event = self.gate.strict_load(raw)
            seq, kind = event['step_seq'], event['kind']
            if kind == 'intent':
                need(seq not in outstanding, 'MW_JOURNAL')
                outstanding.add(seq)
            elif kind == 'complete':
                need(seq in outstanding, 'MW_JOURNAL')
                outstanding.remove(seq)
            elif kind in ('verified', 'failed', 'satisfied_skip', 'condition_skip'):
                dispositions[seq] = kind
        # An uncertain send may still produce an honest failure summary. It
        # never permits a successful selection or reuse of this dispatch owner.
        need(not outstanding or summary['rc'] != 0, 'MW_JOURNAL')
        expected = dict(workflow_sha256=self.corpus.pins[self.corpus.path],
            steps=[dict(seq=s['seq'], disposition=dispositions[s['seq']],
                predicate_pass=dispositions[s['seq']] in ('verified', 'satisfied_skip'),
                optional=not s['protected'], guard_false=dispositions[s['seq']] == 'condition_skip')
                for s in self.corpus.workflow['steps']],
            required_segments={k: list(v) for k, v in self.inventory(self.corpus.workflow).items()},
            final_task_pass=summary['rc'] == 0)
        need(inventory == expected and (summary['rc'] != 0 or self.final_pass), 'MW_JOURNAL')
        if self.handoff.latched:
            summary['evidence_refs'].append(self.handoff.path.name)
        if self.slots.normalized:
            # Run report evidence contains slot identifiers and reasons only.
            report = self.output.with_suffix('.normalization.json')
            if not report.exists():
                self.write(report, (self.gate.canon({'slots': [
                    {'slot': slot, 'normalized': reason}
                    for slot, reason in sorted(self.slots.normalized.items())]}) + '\n').encode())
            summary['evidence_refs'].append(report.name)
        raw = (self.gate.canon(summary) + '\n').encode()
        path = self.output.parent / ('.mw-inactive-' + uuid.uuid4().hex + '.json')
        self.write(path, raw)
        self.staged[path] = (raw, copy.deepcopy(inventory), copy.deepcopy(summary), self.read(self.limits.journal_bytes))
        return path

    @staticmethod
    def write(path, raw):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())

    def context(self):
        def load(kind, value, related):
            for saved in self.staged.values():
                if kind == 'run_inventory' and value == saved[2]:
                    return copy.deepcopy(saved[1])
            raise OwnerRefused('MW_JOURNAL')

        def check(kind, value, related):
            ok = any(kind == 'run_inventory' and value == s[2] and related and related[0] == s[1]
                     and self.read(self.limits.journal_bytes) == s[3] for s in self.staged.values())
            return self.gate.GateResult(0, 'PASS') if ok else self.gate.GateResult(5, 'FORGED')
        return self.gate.ValidationContext(self.output.parent, evidence_load=load, evidence_check=check)

    def select(self, staged):
        need(self.validate(staged, self.staged[Path(staged)][1]).result is self.Truth.TRUE, 'MW_JOURNAL')
        need(not self.output.exists(), 'MW_JOURNAL_EXISTS')
        os.link(staged, self.output, follow_symlinks=False)
        Path(staged).unlink()
        fd = os.open(self.output.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return self.answer(True)

    def owners(self):
        return self.mw.RunOwners(artifact=self, validation_context=self.context_value,
            authorization=self, capabilities=self, observations=self, ram=self, transport=self,
            slots=self.slots, slot_length_bindings=tuple(self.length_binding(s['slot_id'])
                for s in self.corpus.workflow['text_slots']), resources=self, journal=self, dispatch=self.dispatch, surface=self.surface,
            replay_policy=None, clock=time.monotonic_ns, sleep=time.sleep, limits=self.limits,
            scope=self.scope, authority=self.authority, run_id='mv-mw-' + uuid.uuid4().hex,
            # Pinned Wender's replay execution lane also runs site workflows;
            # capsule network policy belongs solely to this owner's context.
            mode='replay', output=self.output)

    def validate_corpus(self):
        supported = self.supports(self.corpus.workflow).result is self.Truth.TRUE
        need(supported, self.text_refusal or 'MW_UNSUPPORTED_WORKFLOW')
        for path in (self.corpus.root / 'sites' / self.corpus.site['id'] / 'site.json', self.corpus.path):
            result = self.gate.validate_file(path, self.corpus.bundle, context=self.context_value)
            need(result.rc == 0, 'MW_GATE_' + result.category)
        if self.mode == 'site':
            self.check_network()
        self.check_notice()

    def run(self):
        self.handoff_guard()
        self.validate_corpus()
        self.check_network()
        owners = self.owners()
        result = self.mw.run_workflow(self.corpus.path, bundle=self.corpus.bundle, owners=owners, limits=self.limits)
        return HandoffResult(result.rc, result.verdict_code, result.summary, result.diagnostic,
                             str(self.handoff.path) if self.handoff.latched else None)
