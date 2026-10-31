"""Read-only host witnesses for the admitted MemoryWeb owner.

[TARGET, unit decision] Private adapter start witnesses declare site mode;
missing witnesses never imply open. The owner's historical profile label mv-live-1
is a compatibility scope label only: identity/capsule/surface are independently
checked on every ownership call. No capsule is started, stopped or reconfigured.
The core verifies pixels; local binding controls reject a different surface or
generation using the same admitted proposal and core receipt.
[TARGET, unit decision] Without MV_CORE_CONFIG the entry attaches to the single
running packaged app: a same-UID resources/bin/mv-daemon-adapter whose parent is
that app's metaviewer binary. Only ATTACH_KEYS are kept from its environment;
caller values that disagree refuse MW_RUN_ATTACH. Orphan cores never match.
[TARGET, unit decision] A selected site root without standards/schemas is staged
privately with the tracked memoryweb-builtin schemas; Corpus still checks them
against the Wender pin. The site directory is copied whole, never merged.
[TARGET, unit decision] min_notice_s is honoured by announcing the run on stderr
and waiting before the owner starts; notices above 300 s refuse MW_NOTICE.
[TARGET, unit decision] Native AX withholds field values and reports value_len
code points; the owner's length seam reads len(value), so textbox/combobox rows
gain a U+2022 mask of that length. No field content is read or stored.
[TARGET, unit decision] Observations carry the native window url and, from
native AX only, an observed_wall marker for a CAPTCHA cue or a sign-in dialog.
The marker only stops the run for a human; nothing is clicked or solved.
[TARGET, unit decision] A MW_GATE_* refusal from the pinned gate is reworded with
mw_home_check.provenance_faults() lines naming the file and the remedy.
[TARGET, unit decision] Attach discovery runs inside connect(); the merged
environment rides on the client as host_env for HostBackend.
[TARGET, unit decision] After a verified run only, the visible text of the
container holding the oracle's present anchor is read once with the documented
read-only `ax --text-container` verb into the private evidence file answer.txt;
the report names it. Capture failure never changes the run verdict.
"""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
ATTACH_KEYS = ('MV_CORE_CONFIG', 'XDG_RUNTIME_DIR', 'MV_SRF_BIN_DIR', 'MV_SRF_STATE_DIR',
               'SRF_IDENTITY_STORE_ROOT')
SCHEMA_KINDS = ('site', 'workflow', 'step', 'run')
MAX_NOTICE_S = 300
MASK = '•'
CAPTCHA_CUES = {
    'checkbox': {"i'm not a robot", 'no soy un robot', 'verify you are human',
                 'verifica que eres un ser humano'},
    'iframe': {'cloudflare security challenge', 'widget containing a cloudflare security challenge'},
    'dialog': {'recaptcha'},
}
SIGN_IN_PHRASES = ('sign in', 'log in', 'login', 'sign up', 'create an account', 'iniciar sesión',
                   'inicia sesión', 'regístrate', 'crea una cuenta')


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


# Reuse the harness guard itself, including its executable/shell alias checks.
live = module('mv_entry_live', ROOT / 'tests/e2e/e2e1_slice/live.py')
home_check = module('mv_entry_home_check', ROOT / 'tools/mw_home_check.py')
from metaviewer_agents import tools
from metaviewer_agents.client import ClientError, ToolClient
from metaviewer_agents.mw_home import HomeError, canonical_home, check_home, resolve_home, site_root
from metaviewer_agents.mw_owner import Corpus, OwnerRefused, ReplayOwner, bounded_read, need
from metaviewer_agents.perception.deps_lock import DependencyLockError
from metaviewer_agents.verify import build_proposal


def command(argv, **kwargs):
    live.refuse_net_argv(argv)
    return subprocess.run([str(x) for x in argv], stdin=subprocess.DEVNULL,
                          capture_output=True, timeout=30, check=False, **kwargs)


def refuse(code, message):
    refusal = OwnerRefused(code)
    refusal.args = (code + ': ' + message,)
    return refusal


def discover_attach(proc=Path('/proc')):
    """Return ATTACH_KEYS of the one adapter owned by a running packaged app."""
    found = []
    for entry in Path(proc).iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if entry.stat().st_uid != os.getuid():
                continue
            exe = Path(os.readlink(entry / 'exe'))
            if exe.name != 'mv-daemon-adapter' or exe.parent.name != 'bin' or exe.parent.parent.name != 'resources':
                continue
            parent = (entry / 'stat').read_text().rpartition(')')[2].split()[1]
            if Path(os.readlink(Path(proc) / parent / 'exe')) != exe.parents[2] / 'metaviewer':
                continue
            raw = (entry / 'environ').read_bytes()[:1 << 20]
        except (OSError, IndexError, ValueError):
            continue
        values = {}
        for item in raw.split(b'\0'):
            key, sep, value = item.partition(b'=')
            if sep and key.decode('ascii', 'replace') in ATTACH_KEYS:
                values[key.decode()] = value.decode('utf-8', 'replace')
        found.append(values)
    if not found:
        raise refuse('MW_RUN_ATTACH', 'no running packaged MetaViewer app was found; start MetaViewer and '
                     'its capsule, or export MV_CORE_CONFIG and XDG_RUNTIME_DIR of the running core')
    if len(found) != 1:
        raise refuse('MW_RUN_ATTACH', f'{len(found)} running MetaViewer apps were found; close the others, '
                     'or export MV_CORE_CONFIG and XDG_RUNTIME_DIR of the one to use')
    return found[0]


def attach_env(env, discover=None):
    """Return (environment, basis); an explicit MV_CORE_CONFIG disables discovery."""
    if env.get('MV_CORE_CONFIG'):
        return dict(env), 'environment'
    values = (discover or discover_attach)()
    merged = dict(env)
    for key in ATTACH_KEYS:
        if key in ('MV_CORE_CONFIG', 'XDG_RUNTIME_DIR'):
            if not values.get(key):
                raise refuse('MW_RUN_ATTACH', f'the running app exposes no {key}; export MV_CORE_CONFIG '
                             'and XDG_RUNTIME_DIR of the running core')
            merged[key] = values[key]
        elif key in values:
            if env.get(key) not in (None, values[key]):
                raise refuse('MW_RUN_ATTACH', f'{key} differs from the running app ({values[key]}); '
                             'unset it or use the value of the running app')
            merged[key] = values[key]
    return merged, 'discovered'


def stage_corpus(home, site, evidence):
    """Return (root, basis): the site root, or a private staged copy with pinned schemas."""
    root = site_root(home, site)
    schemas = root / 'standards' / 'schemas'
    if all((schemas / (kind + '.v1.json')).is_file() for kind in SCHEMA_KINDS):
        return root, 'site_root'
    source = ROOT / 'memoryweb-builtin' / 'standards' / 'schemas'
    staged = Path(evidence) / 'corpus'
    copies = [(source / (kind + '.v1.json'), staged / 'standards/schemas' / (kind + '.v1.json'), source)
              for kind in SCHEMA_KINDS]
    site_dir = root / 'sites' / site
    for directory, names, files in os.walk(site_dir, followlinks=False):
        for name in names + files:
            need(not (Path(directory) / name).is_symlink(), 'MW_HOME_SYMLINK')
        for name in files:
            path = Path(directory) / name
            copies.append((path, staged / 'sites' / site / path.relative_to(site_dir), root))
    for path, target, base in copies:
        raw = bounded_read(path, base, 1024 * 1024)
        for parent in reversed(target.relative_to(evidence).parents):
            (Path(evidence) / parent).mkdir(mode=0o700, exist_ok=True)
        ReplayOwner.write(target, raw)
    return staged, 'staged_builtin_schemas'


def wait_notice(corpus, identity, network, clock=time.monotonic_ns, sleep=time.sleep):
    """Announce the run, then wait the declared advance notice; return its mono_ns."""
    waits = [policy['min_notice_s'] for policy in
             (corpus.site['execution_policy'], corpus.workflow['execution_policy'])]
    need(all(type(v) is int and 0 <= v <= MAX_NOTICE_S for v in waits), 'MW_NOTICE')
    notice = clock()
    wait = max(waits)
    if wait:
        print(f'mw_run: {corpus.workflow["site_id"]}/{corpus.workflow["id"]} acts on identity {identity} '
              f'(network {network}) in {wait} s; interrupt now to cancel', file=sys.stderr, flush=True)
    while clock() - notice < wait * 1_000_000_000:
        sleep(max(0.01, (notice + wait * 1_000_000_000 - clock()) / 1e9))
    return notice


def normalized(text):
    return re.sub(r'\s+', ' ', text if isinstance(text, str) else '').strip().casefold()


def wall_kind(tree):
    """Classify a CAPTCHA cue or a sign-in dialog in native AX rows; never act on it."""
    rows = [row for row in tree.get('elements', []) if isinstance(row, dict)]
    if any(normalized(row.get('name')) in CAPTCHA_CUES.get(row.get('role'), ()) for row in rows):
        return 'captcha_wall'
    if any(row.get('role') in ('dialog', 'alertdialog') and
           any(phrase in normalized(row.get('name')) for phrase in SIGN_IN_PHRASES) for row in rows):
        return 'login_wall'
    return None


def private_json(path, root, mode=0o600):
    path = Path(path)
    for parent in (root, *path.relative_to(root).parents):
        candidate = root if parent == root else root / parent
        metadata = candidate.lstat()
        need(not candidate.is_symlink() and metadata.st_uid == os.getuid()
             and stat.S_IMODE(metadata.st_mode) == 0o700, 'MW_PRIVATE_OUTPUT')
    metadata = path.lstat()
    need(metadata.st_uid == os.getuid() and stat.S_IMODE(metadata.st_mode) == mode,
         'MW_PRIVATE_OUTPUT')
    value = json.loads(bounded_read(path, root))
    need(isinstance(value, dict), 'MW_RUN_CONFIG')
    return value


def admit_home(repo, override):
    home = canonical_home(resolve_home(repo, override))

    def tracked(path):
        selectors = {'memoryweb'}
        if path.is_relative_to(repo):
            selectors.add(path.relative_to(repo).as_posix())
        for selector in selectors:
            rc = command(['git', '-C', repo, 'ls-files', '--error-unmatch', '--', selector]).returncode
            if rc == 0:
                return True
            if rc != 1:
                raise HomeError('MW_HOME_GIT')
        return False

    selectors = ['memoryweb/x']
    if home.is_relative_to(repo) and home != repo / 'memoryweb':
        selectors.append(str(home / 'x'))
    for selector in selectors:
        result = command(['git', '-C', repo, 'check-ignore', '-q', '--', selector])
        if result.returncode != 0:
            raise HomeError('MW_HOME_NOT_IGNORED' if result.returncode == 1 else 'MW_HOME_GIT')
    return check_home(home, tracked)


def connect(env, trace=None):
    env, basis = attach_env(env)
    if trace is not None:
        trace['attach'] = basis
    for key in ('MV_CORE_CONFIG', 'XDG_RUNTIME_DIR'):
        if not env.get(key) or not Path(env[key]).is_absolute():
            raise refuse('MW_RUN_ATTACH', f'{key} must be an absolute path of the running core')
    endpoint = Path(env['XDG_RUNTIME_DIR']) / 'metaviewer/core.sock'
    try:
        config = json.loads(Path(env['MV_CORE_CONFIG']).read_text())
    except (OSError, ValueError) as error:
        raise refuse('MW_RUN_ATTACH', f'core configuration {env["MV_CORE_CONFIG"]} is unreadable '
                     f'({type(error).__name__}); is MetaViewer still running?') from error
    if not endpoint.is_socket():
        raise refuse('MW_RUN_ATTACH', f'core socket {endpoint} is absent; is MetaViewer still running?')
    instance = env.get('MV_AGENT_INSTANCE')
    peers = [p for p in config['peers'] if p['endpoint']['component'] == 'agent'
             and (instance is None or p['endpoint']['instance'] == instance)]
    need(len(peers) == 1, 'MW_RUN_REGISTRATION')
    local, core = peers[0], config['core']
    scope = json.dumps([config['session_id'], local['endpoint'], core['endpoint']], sort_keys=True).encode()
    client = ToolClient(str(endpoint), session_id=config['session_id'], local=local, core=core,
                        dependency_pins=local['hello']['dependencies'],
                        sequence_path=endpoint.parent / ('.mvctl-' + hashlib.sha256(scope).hexdigest() + '.seq'),
                        timeout_s=30, max_line_bytes=1 << 20, max_reply_bytes=1 << 20)
    client.host_env = env
    return client


class HostBackend:
    def __init__(self, client, identity, evidence, env):
        from metaviewer_agents.perception.deps_lock import resolve_locked_component
        self.client, self.identity, self.evidence = client, identity, Path(evidence)
        env = client.host_env if isinstance(getattr(client, 'host_env', None), dict) else env
        need(isinstance(identity, str) and live.PROFILE_ID_RE.fullmatch(identity), 'MW_IDENTITY')
        for key in ('MV_SRF_STATE_DIR', 'MV_SRF_BIN_DIR', 'SRF_IDENTITY_STORE_ROOT'):
            if not env.get(key):
                raise refuse('MW_RUN_CONFIG', f'{key} is not set; use the value of the running app')
        self.state = Path(env['MV_SRF_STATE_DIR'])
        self.binary = Path(env['MV_SRF_BIN_DIR']) / 'srf-identity-surface'
        self.store = Path(env['SRF_IDENTITY_STORE_ROOT'])
        self.admin = self.binary.with_name('srf-identity-admin')
        need(all(p.is_absolute() for p in (self.state, self.binary, self.store)), 'MW_RUN_CONFIG')
        self.wender = resolve_locked_component('wender-agent')
        self.pending = {}
        self.network_evidence = None
        self.surface_id = None
        self.capsule = None
        self.ownership()

    def native(self, binary, args):
        # Closed read-only surface, in addition to the shared network guard.
        argv = [binary, *args]
        live.refuse_net_argv(argv)
        need((Path(binary) == self.binary and args[0] == 'ax') or
             (Path(binary) == self.admin and args[0] == 'show'), 'MW_RUN_NATIVE_INPUT')
        reply = command(argv)
        need(reply.returncode == 0 and len(reply.stdout) <= 1024 * 1024, 'MW_RUN_NATIVE')
        value = json.loads(reply.stdout)
        need(isinstance(value, dict), 'MW_RUN_NATIVE')
        return value

    def surfaces(self):
        cursor, seen, found = None, set(), []
        for _ in range(256):
            page = tools.list_surfaces(cursor=cursor, limit=256, client=self.client, timeout_ms=5000)
            found.extend(s for s in page['surfaces'] if s['profile_id'] == self.identity
                         and s['state'] == 'active' and s['kind'] == 'browser')
            cursor = page['next_cursor']
            if cursor is None:
                return found
            need(cursor not in seen, 'MW_RUN_AMBIGUOUS')
            seen.add(cursor)
        raise OwnerRefused('MW_RUN_AMBIGUOUS')

    def ownership(self):
        metadata = self.native(self.admin, ['show', '--store-root', str(self.store), '--id', self.identity])
        need(metadata.get('profile_id') == self.identity, 'MW_IDENTITY')
        surfaces = self.surfaces()
        need(bool(surfaces), 'MW_RUN_NO_SURFACE')
        need(len(surfaces) == 1, 'MW_RUN_AMBIGUOUS')
        leases = set()
        for path in self.state.glob('*.json'):
            receipt = private_json(path, self.state)
            capsule = live.capsule_from_receipt(receipt, self.identity)
            if capsule:
                leases.add(capsule)
        inventory = command(['docker', 'ps', '--format', '{{.Names}}'])
        need(inventory.returncode == 0, 'MW_RUN_OWNERSHIP')
        active = set(inventory.stdout.decode().splitlines())
        need(bool(leases & active), 'MW_RUN_NO_SURFACE')
        need(len(leases) == 1 and leases <= active, 'MW_RUN_AMBIGUOUS')
        capsule = next(iter(leases))
        surface = surfaces[0]['surface_id']
        need(self.surface_id in (None, surface) and self.capsule in (None, capsule), 'MW_RUN_OWNERSHIP')
        self.surface_id, self.capsule = surface, capsule
        return dict(profile='mv-live-1', identity=self.identity, surface_id=surface, capsules=[capsule])

    def network_context(self):
        self.ownership()
        try:
            directory = self.state / 'egress'
            witness = private_json(directory / (self.identity + '.started.json'), self.state, 0o400)
            need(set(witness) == {'schema', 'capsule_id', 'effective_mode', 'record_sha256',
                                  'start_mono_ns', 'start_wall_ns'} and
                 witness['schema'] == 'metaviewer.capsule_egress_started/v1' and
                 witness['capsule_id'] == self.capsule and
                 witness['effective_mode'] in ('open', 'proxied', 'legacy') and
                 all(type(witness[key]) is int and witness[key] > 0
                     for key in ('start_mono_ns', 'start_wall_ns')), 'MW_NETWORK')
            record_path = directory / (self.identity + '.json')
            try:
                private_json(record_path, self.state)
                current = hashlib.sha256(bounded_read(record_path, self.state)).hexdigest()
            except FileNotFoundError:
                current = 'absent'
            need(witness['record_sha256'] == current, 'MW_NETWORK')
        except (OSError, ValueError, OwnerRefused, TypeError, KeyError) as error:
            refusal = OwnerRefused('MW_NETWORK')
            refusal.args = ('MW_NETWORK: network setting changed after start or start witness unavailable; '
                            'restart the capsule after changing its network setting',)
            raise refusal from error
        # The adapter witness records the effective argv, including legacy when
        # startup capability knowledge lacks open. A new probe could disagree
        # with the running adapter snapshot and cannot prove its start mode.
        self.network_evidence = dict(witness)
        return dict(mode='allowlisted/proxied' if witness['effective_mode'] == 'proxied'
                    else witness['effective_mode'], basis=dict(witness))

    def ax(self):
        self.ownership()
        tree = self.native(self.binary, ['ax', '--container', self.capsule, '--window', 'w1',
                                         '--state-dir', str(self.state)])
        for row in tree.get('elements', []) if isinstance(tree.get('elements'), list) else []:
            if (isinstance(row, dict) and row.get('role') in ('textbox', 'combobox') and 'value' not in row
                    and type(row.get('value_len')) is int and 0 <= row['value_len'] <= 65536):
                row['value'] = MASK * row['value_len']
        return tree

    def observe(self, timeout_ms):
        observed = dict(tools.observe(self.surface_id, client=self.client, timeout_ms=timeout_ms))
        tree = self.ax()
        window = tree.get('window')
        if isinstance(window, dict) and isinstance(window.get('url'), str):
            observed['url'] = window['url']
        wall = wall_kind(tree)
        if wall:
            observed['observed_wall'] = dict(observed=True, kind=wall)
        return observed

    def capture_answer(self, workflow):
        """Read the oracle anchor's container text once into answer.txt; never raise."""
        names = {b['value'] for p in workflow['oracle']['postconditions']
                 if p.get('capability_id') == 'mv.ax.present.v1'
                 for b in p.get('bindings', []) if b.get('name') == 'name' and isinstance(b.get('value'), str)}
        try:
            rows = [r for r in self.ax().get('elements', []) if isinstance(r, dict) and r.get('name') in names]
            containers = {r['container']['id'] for r in rows if isinstance(r.get('container'), dict)
                          and isinstance(r['container'].get('id'), str) and r['container']['id']}
            if len(containers) != 1:
                return dict(captured=False, reason='MW_ANSWER_CONTAINER',
                            detail=f'{len(containers)} containers hold the answer anchor')
            container = next(iter(containers))
            reply = self.native(self.binary, ['ax', '--container', self.capsule, '--window', 'w1',
                                              '--state-dir', str(self.state), '--text-container', container])
            text = reply.get('text')
            need(isinstance(text, dict) and text.get('container_id') == container and
                 isinstance(text.get('text'), str), 'MW_ANSWER_TEXT')
            raw = text['text'].encode('utf-8')
            need(0 < len(raw) <= 65536, 'MW_ANSWER_TEXT')
            path = self.evidence / 'answer.txt'
            ReplayOwner.write(path, raw)
            return dict(captured=True, path=str(path), bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest(),
                        container_id=container)
        except (OSError, ValueError, KeyError, TypeError, OwnerRefused, subprocess.SubprocessError) as error:
            return dict(captured=False, reason=getattr(error, 'code', 'MW_ANSWER_TEXT'),
                        detail=type(error).__name__)

    def retain(self, frame):
        from metaviewer_agents.perception.vcore import _ramws_frame
        tools._check_frame(frame)
        pixels = _ramws_frame(frame, frame['width'], frame['height']).data
        need(hashlib.sha256(pixels).hexdigest() == frame['sha256'], 'MW_FRAME_BINDING')
        path = self.evidence / (frame['sha256'] + '.rgb')
        if not path.exists():
            ReplayOwner.write(path, pixels)
        need(path.read_bytes() == pixels, 'MW_FRAME_BINDING')
        return dict(surface_id=frame['surface_id'], sha256=frame['sha256'],
                    generation=frame['generation'], bytes=len(pixels), artifact=str(path))

    def perceive(self, observed):
        frame = observed['frame_ref']
        witness = self.retain(frame)
        tree = self.ax()
        need(isinstance(tree.get('elements'), list) and
             all(isinstance(row, dict) for row in tree['elements']), 'MW_AX')
        # AX supplies native geometry; no synthetic visual detections. The
        # Wender shim intersects these rectangles with its own pruned AX rows.
        elements = []
        for row in tree.get('elements', []):
            box = row.get('box')
            if isinstance(box, list) and len(box) == 4 and all(type(v) is int for v in box):
                x, y, w, h = box
                if 0 <= x < x + w <= frame['width'] and 0 <= y < y + h <= frame['height']:
                    elements.append(dict(bbox=dict(x=x, y=y, w=w, h=h)))
        table = dict(schema='vqa.element-table/v1', frame_sha256=frame['sha256'],
                     width=frame['width'], height=frame['height'], elements=elements)
        return dict(frame=frame, table=table, frame_witness=witness)

    def state_for(self, sensed):
        # The pinned shim computes Wender IDs, AX hashes and actionable state.
        if not hasattr(self, '_glue'):
            self._glue = module('mv_entry_glue', ROOT / 'tools/gate_g_ai.py')
        glue = self._glue
        argv = [sys.executable, '-c', glue.WENDER_SHIM]
        live.refuse_net_argv(argv)
        payload = json.dumps(dict(element_table=sensed['table'], tree=self.ax()))
        result = subprocess.run(argv, input=payload, text=True, capture_output=True, timeout=30,
                                cwd=self.wender, env={'PATH': os.defpath, 'PYTHONPATH': str(self.wender),
                                                     'PYTHONDONTWRITEBYTECODE': '1'})
        need(result.returncode == 0, 'MW_RUN_STATE')
        from metaviewer_agents.wender_bridge import validate_state
        state = json.loads(result.stdout)
        validate_state(state)
        return state

    def propose(self, sensed, plan, max_ms):
        self.ownership()
        self.network_context()
        proposal = build_proposal(sensed['frame'], proposal_id='mw-' + uuid.uuid4().hex,
                                  action=plan['action'], expectation=plan['expectation'], max_ms=max_ms)
        verdict = tools.propose(proposal, client=self.client, timeout_ms=max_ms)
        # The owner's propose seam needs settlement evidence: wait once here,
        # then expose that same verification in its wait_verify stage.
        verified = tools.wait_verify(proposal['proposal_id'], proposal['expectation'], max_ms,
                                     client=self.client, surface_id=self.surface_id)
        native = dict(verified)
        need(isinstance(native, dict) and isinstance(native.get('native_evidence'), dict), 'MW_RECEIPT_MISMATCH')
        self.pending[proposal['proposal_id']] = (proposal, copy.deepcopy(sensed['frame']), verified)
        return dict(proposal_id=proposal['proposal_id'], verdict=verdict, native_evidence=native['native_evidence'])

    @staticmethod
    def binding(proposal, before, receipt):
        try:
            tools._check_receipt_verified(receipt, surface_id=proposal['surface_id'])
            return (proposal['surface_id'] == before['surface_id'] == receipt['native_evidence']['surface_id']
                    and proposal['based_on_frame'] == {k: before[k] for k in ('sha256', 'generation')}
                    and receipt['proposal_id'] == proposal['proposal_id']
                    and receipt['after_frame']['generation'] > before['generation'])
        except (ValueError, KeyError, TypeError):
            return False

    def wait_verify(self, admitted, timeout_ms):
        proposal, before, receipt = self.pending.pop(admitted['proposal_id'])
        need(self.binding(proposal, before, receipt), 'MW_RECEIPT_MISMATCH')
        wrong, stale = copy.deepcopy(proposal), copy.deepcopy(proposal)
        wrong['surface_id'] += '-different'
        stale['based_on_frame']['generation'] += 1
        need(not self.binding(wrong, before, receipt) and not self.binding(stale, before, receipt),
             'MW_RECEIPT_MISMATCH')
        self.retain(receipt['after_frame'])
        return dict(status='verified', receipt=dict(receipt), focus_verified=receipt.get('focus_verified'),
                    input_mono_ns=receipt.get('input_mono_ns'), frame_sha256=receipt.get('frame_sha256'),
                    receipt_binding_negative_control='PASS')

    def call(self, stage, **args):
        operations = {'ownership': self.ownership, 'network_context': self.network_context, 'ax': self.ax,
                      'observe': self.observe,
                      'perceive': self.perceive, 'state': self.state_for,
                      'propose': self.propose, 'wait_verify': self.wait_verify}
        need(stage in operations, 'MW_RUN_OPERATION')
        return operations[stage](**args)


def slots(values):
    result = {}
    for value in values:
        key, sep, payload = value.partition('=')
        need(bool(sep) and bool(key) and key not in result, 'MW_SLOT')
        result[key] = payload
    return result


def execute(args, home, evidence, backend, *, corpus_factory=Corpus, owner_factory=ReplayOwner, trace=None):
    root, basis = stage_corpus(home, args.site, evidence)
    corpus = corpus_factory(root, args.site + '/' + args.workflow)
    network = backend.call('network_context')['mode']
    output = evidence / 'memoryweb-run.json'
    notice = wait_notice(corpus, args.identity, network)
    if trace is not None:
        trace.update(corpus=basis, notice_s=(time.monotonic_ns() - notice) // 1_000_000_000)
    owner = owner_factory(backend, corpus, output, mode='site',
                         notice=dict(mode='site', network=network, acknowledged=True, mono_ns=notice),
                         slot_values=slots(args.slot))
    try:
        result = owner.run()
    except OwnerRefused as error:
        faults = home_check.provenance_faults(root / 'sites' / args.site, args.workflow)
        if str(getattr(error, 'code', '')).startswith('MW_GATE_') and faults:
            raise refuse(error.code, 'the pinned MemoryWeb gate refused the stored definition: ' +
                         '; '.join(faults)[:2000] + '; fix the site data, then rerun tools/mw_home_check.py '
                         f'--repo <MetaViewer checkout> --workflow {args.site}/{args.workflow}') from error
        raise
    if result.handoff_path:
        handoff = Path(result.handoff_path)
        need(handoff == output.with_suffix('.handoff.json') and handoff.is_file(), 'MW_HANDOFF_REQUIRED')
        return 4, 'HUMAN_HANDOFF', str(handoff)
    need(output.is_file(), 'receipt path absent')
    raw = bounded_read(output, evidence)
    summary = corpus.gate.strict_load(raw)
    need(summary == result.summary and summary.get('rc') == result.rc and
         corpus.gate.conforms(summary, corpus.schemas['run'], corpus.bundle['$defs']), 'MW_RUN_RECEIPT')
    validation = corpus.gate.validate_file(output, corpus.bundle, context=owner.context())
    need(validation.rc == 0, 'MW_RUN_RECEIPT')
    capture = getattr(backend, 'capture_answer', None)
    if result.rc == 0 and trace is not None and callable(capture):
        trace['answer'] = capture(corpus.workflow)
    return result.rc, result.verdict_code, str(output)


def run_entry(args):
    receipt, report = None, None
    rc, code = 6, 'MW_RUN_CONFIG'
    backend, message, trace = None, None, {}
    try:
        values = slots(args.slot)
        del values  # Validate syntax before any core connection; values stay invocation-private.
        home = admit_home(ROOT, os.environ.get('MV_MW_HOME'))
        base = Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state')))
        need(base.is_absolute(), 'MW_PRIVATE_OUTPUT')
        evidence = base / 'metaviewer/runs' / uuid.uuid4().hex
        need(not evidence.is_relative_to(ROOT) and not evidence.is_relative_to(home), 'MW_PRIVATE_OUTPUT')
        evidence.mkdir(mode=0o700, parents=True)
        need(not any(p.is_symlink() for p in (evidence, *evidence.parents)), 'MW_PRIVATE_OUTPUT')
        report = str(evidence / 'report.json')
        with connect(os.environ, trace) as client:
            backend = HostBackend(client, args.identity, evidence, os.environ)
            rc, code, receipt = execute(args, home, evidence, backend, trace=trace)
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, AttributeError,
            ClientError, tools.ToolRefusal, tools.VerificationFailed) as error:
        code = getattr(error, 'code', getattr(error, 'reason_code', 'MW_RUN_CONFIG'))
        message = str(error)
        if isinstance(error, ClientError):
            code, message = 'MW_RUN_CORE', (f'core connection failed ({error.code}: {error}); '
                                            'is this the running MetaViewer core?')
        elif isinstance(error, HomeError):
            message = (f'{error.code}: MemoryWeb home {os.environ.get("MV_MW_HOME") or ROOT / "memoryweb"} '
                       f'refused; check it with: python3 {ROOT / "tools/mw_home_check.py"} --repo {ROOT}')
        elif isinstance(error, DependencyLockError):
            code, message = 'MW_DEPENDENCY', (f'{error.code}: {error.message}; set MV_WENDER_ROOT to the '
                                              'wender-agent checkout at its deps.lock commit')
        print('mw_run: ' + (message if message and message.startswith(code) else
                            code + (': ' + message if message else '')), file=sys.stderr, flush=True)
    result = dict(schema='metaviewer.mw_run/v1', rc=rc, verdict_code=code, receipt=receipt, report=report)
    if report is not None:
        try:
            ReplayOwner.write(Path(report), (json.dumps(dict(result, message=message,
                network=getattr(backend, 'network_evidence', None), **trace), separators=(',', ':')) + '\n').encode())
        except OSError:
            result.update(rc=6, verdict_code='MW_PRIVATE_OUTPUT')
    print(json.dumps(result, separators=(',', ':')))
    return result['rc']
