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
[TARGET, unit decision] Slot evidence reads the focused editor's own native
text-of ID when AX value text is absent. Length masks are not content
proof. Missing, truncated or differently bound native text refuses before input.
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
[TARGET, unit decision] A failed owner without a selected receipt preserves its
verdict and diagnostic; a successful owner still requires a validated receipt.
[TARGET, unit decision] Before submission, re-perceive and validate the same
AX target/focus, then bind a latest verified frame with identical pixels. Only
STALE_FRAME (an explicit non-execution) permits another attempt, at most three
within the original delivery budget. Transport/settlement failures never retry.
Answer capture removes standalone captions of AX buttons/links in its container;
ambiguous caption placement refuses capture rather than deleting answer prose.
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
from types import FunctionType
import uuid

ROOT = Path(__file__).resolve().parents[1]
ATTACH_KEYS = ('MV_CORE_CONFIG', 'XDG_RUNTIME_DIR', 'MV_SRF_BIN_DIR', 'MV_SRF_STATE_DIR',
               'SRF_IDENTITY_STORE_ROOT', 'SRF_PROXY_REGISTRY', 'MV_WENDER_EXECUTABLE',
               'MV_VISION_EXECUTABLE', 'MV_WENDER_ROOT', 'VQA_VE_ROOT', 'MV_OPERATOR_REPO')
SCHEMA_KINDS = ('site', 'workflow', 'step', 'run')
MAX_NOTICE_S = 300
CAPTCHA_CUES = {
    'checkbox': {"i'm not a robot", 'no soy un robot', 'verify you are human',
                 'verifica que eres un ser humano'},
    'iframe': {'cloudflare security challenge', 'widget containing a cloudflare security challenge',
               'recaptcha', 'recaptcha challenge', 'hcaptcha', 'hcaptcha challenge'},
    'dialog': {'recaptcha'},
}
SIGN_IN_PHRASES = ('sign in', 'log in', 'login', 'sign up', 'create an account', 'iniciar sesión',
                   'inicia sesión', 'regístrate', 'crea una cuenta')
HUMAN_CHECK_PHRASES = ('verify you are human', 'verify that you are human',
                       'verifica que eres un ser humano')
PASSWORD_NAMES = {'password', 'contraseña'}


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
from metaviewer_agents.mw_owner import Corpus, OwnerRefused, ReplayOwner, bounded_read, need, focus_only_steps
from metaviewer_agents.perception.deps_lock import DependencyLockError
from metaviewer_agents.verify import build_proposal
from metaviewer_agents.mw_owner import RebindHandoff


def readback_runner(mw, owner):
    """Invocation-local Wender namespace; never mutate the pinned dependency.

    Its _observe precheck otherwise rejects the expired paste slot deadline
    before the agent acquisition seam can run. Only post-receipt slot-length
    acquisition receives the independent verification window. All other time
    checks, including delivery and step verification, retain their deadlines.
    """
    namespace = dict(vars(mw))
    for name, value in vars(mw).items():
        if isinstance(value, FunctionType) and value.__globals__ is vars(mw):
            namespace[name] = FunctionType(value.__code__, namespace, value.__name__,
                                           value.__defaults__, value.__closure__)
            namespace[name].__kwdefaults__ = value.__kwdefaults__
    observe = namespace['_observe']

    def bounded_observe(predicate, state, owners, deadline):
        window = getattr(owner, 'slot_readback_deadline_ns', None)
        if (owners.observations is owner and window is not None and
                predicate.get('capability_id') == 'mv.ax.length.v1'):
            try:
                need(time.monotonic_ns() < window, 'MW_SLOT_READBACK_DEADLINE')
                result = observe(predicate, state, owners, window)
                need(time.monotonic_ns() < window, 'MW_SLOT_READBACK_DEADLINE')
                return result
            except BaseException as error:
                if time.monotonic_ns() >= window:
                    owner.slot_readback_error = 'MW_SLOT_READBACK_DEADLINE'
                    raise OwnerRefused(owner.slot_readback_error) from error
                raise
            finally:
                owner.slot_readback_deadline_ns = None
        return observe(predicate, state, owners, deadline)

    namespace['_observe'] = bounded_observe
    return namespace['run_workflow']


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



def focus_corpus(corpus, evidence):
    """[TARGET, unit decision] Explicit invocation projection; source stays sealed."""
    steps = focus_only_steps(corpus.workflow)
    if not steps:
        return corpus, None
    projected = copy.deepcopy(corpus.workflow)
    for step in projected['steps']:
        if any(s['seq'] == step['seq'] for s in steps):
            step['already_satisfied'] = copy.deepcopy(step['verify']['predicate'])
    root = Path(evidence) / 'focus-corpus'
    for directory, names, files in os.walk(corpus.root, followlinks=False):
        if Path(directory) == corpus.root:
            names[:] = [name for name in names if name in ('sites', 'standards')]
        for name in names + files:
            need(not (Path(directory) / name).is_symlink(), 'MW_HOME_SYMLINK')
        for name in files:
            path = Path(directory) / name
            # Corpus roots may contain invocation evidence: copy only site/schema data.
            relative = path.relative_to(corpus.root)
            if relative.parts[0] not in ('sites', 'standards'):
                continue
            target = root / relative
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            raw = ((corpus.gate.canon(projected) + '\n').encode() if path == corpus.path
                   else bounded_read(path, corpus.root, 1024 * 1024))
            ReplayOwner.write(target, raw)
    derived = Corpus(root, corpus.workflow['site_id'] + '/' + corpus.workflow['id'], corpus.api)
    return derived, dict(rule='focus-only composer click before paste',
        source_sha256=corpus.pins[corpus.path], projected_sha256=derived.pins[derived.path])

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
    """Classify exposed native AX wall cues; never act on or answer a wall.

    [TARGET, unit decision] Page headings or password-plus-sign-in wording
    supply the page-level login seam. Native AX rows are exposed unless marked
    hidden/ignored/invisible or given an empty box; no DOM/extra read is needed.
    Frame names and human-check text are stop-only cues, not vendor proof.
    """
    rows = []
    for row in tree.get('elements', []):
        if not isinstance(row, dict):
            continue
        states = row.get('states') or {}
        if any(source.get('hidden') is True or source.get('ignored') is True or
               source.get('visible') is False for source in (row, states)):
            continue
        box = row.get('box')
        if isinstance(box, (list, tuple)) and len(box) == 4 and (box[2] <= 0 or box[3] <= 0):
            continue
        rows.append(row)
    if any(normalized(row.get('name')) in CAPTCHA_CUES.get(row.get('role'), ()) for row in rows):
        return 'captcha_wall'
    if any(row.get('role') in ('text', 'statictext', 'paragraph', 'heading', 'dialog', 'alertdialog') and
           any(phrase in normalized(row.get('name')) for phrase in HUMAN_CHECK_PHRASES) for row in rows):
        return 'captcha_wall'
    if any(row.get('role') in ('dialog', 'alertdialog') and
           any(phrase in normalized(row.get('name')) for phrase in SIGN_IN_PHRASES) for row in rows):
        return 'login_wall'
    if any(row.get('role') == 'heading' and
           any(normalized(row.get('name')) == phrase or
               normalized(row.get('name')).startswith(tuple(phrase + suffix for suffix in (' to ', ' with ', ' a ', ' en ')))
               for phrase in SIGN_IN_PHRASES) for row in rows):
        return 'login_wall'
    password = any(row.get('role') == 'textbox' and
                   (normalized(row.get('name')) in PASSWORD_NAMES or
                    re.fullmatch(r'enter (?:your )?password[: ]*', normalized(row.get('name'))))
                   for row in rows)
    if password and any(row.get('role') in ('button', 'link', 'text', 'statictext') and
                        normalized(row.get('name')) in SIGN_IN_PHRASES for row in rows):
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
    if home_check.packaged_runtime(Path(repo), home):
        return check_home(home, lambda path: path.is_relative_to(repo))

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


CARET_OFF_MIN_LEVEL = 0x80  # [MEASURED] x64 off phase beside a glyph: bbbbbb, bcbcbc, e1e1e1, efefef, ffffff


class HostBackend:
    surface_kind = 'browser'
    eager_slot_text = True
    agent_control_required = False
    # The stored workflow owner imports Wender state APIs in process; the compiled
    # runtime exports plan and model only. A lane on those entries may opt in.
    compiled_wender_ok = False

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
        from metaviewer_agents.perception.compiled import compiled_executable
        if not self.compiled_wender_ok and compiled_executable('wender-agent', root=self.wender) is not None:
            raise refuse('MW_COMPILED_BROWSER_UNAVAILABLE',
                'compiled Wender exports plan/model only; browser workflow/state APIs require '
                'a verified checkout. Program automation supports the compiled runtime.')
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
        # Discovery returns a mapping without changing the caller environment.
        # Forward only native context, just as explicit-context callers do.
        context = getattr(self.client, 'host_env', None)
        native_env = dict(os.environ)
        if isinstance(context, dict):
            for key in ('SRF_IDENTITY_STORE_ROOT', 'SRF_PROXY_REGISTRY'):
                if context.get(key):
                    native_env[key] = context[key]
        reply = command(argv, env=native_env)
        need(reply.returncode == 0 and len(reply.stdout) <= 1024 * 1024, 'MW_RUN_NATIVE')
        value = json.loads(reply.stdout)
        need(isinstance(value, dict), 'MW_RUN_NATIVE')
        return value

    def surfaces(self):
        cursor, seen, found = None, set(), []
        for _ in range(256):
            page = tools.list_surfaces(cursor=cursor, limit=256, client=self.client, timeout_ms=5000)
            found.extend(s for s in page['surfaces'] if s['profile_id'] == self.identity
                         and s['state'] == 'active' and s['kind'] == self.surface_kind)
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
            extract = (live.program_capsule_from_receipt if self.surface_kind == 'desktop_capsule'
                       else live.capsule_from_receipt)
            capsule = extract(receipt, self.identity)
            if capsule:
                leases.add(capsule)
        inventory = command(['docker', 'ps', '--format', '{{.Names}}'])
        if inventory.returncode != 0:
            raise refuse('MW_RUN_OWNERSHIP',
                'Docker inventory failed; restore access to the Docker daemon in this shell, '
                'then run bash scripts/judge/metaviewer-judge.sh doctor --capsules before retrying')
        active = set(inventory.stdout.decode().splitlines())
        leases &= active
        need(bool(leases), 'MW_RUN_NO_SURFACE')
        need(len(leases) == 1, 'MW_RUN_AMBIGUOUS')
        capsule = next(iter(leases))
        surface = surfaces[0]['surface_id']
        need(self.surface_id in (None, surface) and self.capsule in (None, capsule), 'MW_RUN_OWNERSHIP')
        self.surface_id, self.capsule = surface, capsule
        if self.surface_kind == 'desktop_capsule' or self.agent_control_required:
            need(surfaces[0].get('control') == 'agent', 'MW_PROGRAM_CONTROL')
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
            if (self.eager_slot_text and isinstance(row, dict) and row.get('role') in ('textbox', 'combobox')
                    and row.get('focused') is True and not isinstance(row.get('value'), str)):
                row['value'] = self.slot_text(row)
        return tree

    def slot_text(self, row):
        """Bind exact editable text and length from one native AX response.

        [TARGET, unit decision] Refresh the caller's length only after all
        bindings pass; an earlier AX observation may predate the paste.
        """
        selector = row.get('id')
        need(isinstance(selector, str) and bool(selector), 'MW_SLOT_LENGTH_MISSING_EDITOR_ID')
        try:
            reply = self.native(self.binary, ['ax', '--container', self.capsule, '--window', 'w1',
                '--state-dir', str(self.state), '--text-of', selector])
        except (OwnerRefused, OSError, ValueError, subprocess.SubprocessError) as error:
            raise refuse('MW_SLOT_LENGTH_TEXT_OF_UNAVAILABLE',
                         'Exact editable read-back failed; update srf-identity-surface '
                         'to a build supporting ax --text-of and retry.') from error
        text = reply.get('editable_text')
        rows = reply.get('elements', [])
        need(isinstance(rows, list), 'MW_SLOT_LENGTH_EDITOR_BINDING')
        matches = [r for r in rows if isinstance(r, dict) and r.get('id') == selector]
        binding_keys = ('id', 'role', 'name', 'box', 'focused')
        need(len(matches) == 1 and all(k in row and k in matches[0] and
             matches[0][k] == row[k] for k in binding_keys) and
             matches[0].get('focused') is True and reply.get('truncated') is False,
             'MW_SLOT_LENGTH_EDITOR_BINDING')
        need(isinstance(text, dict) and text.get('id') == selector and
             isinstance(text.get('text'), str), 'MW_SLOT_LENGTH_MISSING_READABLE_TEXT')
        value = text['text']
        need(text.get('truncated') is False and type(text.get('bytes')) is int and
             text['bytes'] == len(value.encode('utf-8')) and text['bytes'] <= 65536,
             'MW_SLOT_LENGTH_TRUNCATED_TEXT')
        native_length = matches[0].get('value_len')
        need(text.get('length_unit') == 'unicode_code_points' and
             type(text.get('value_len')) is int and text['value_len'] == len(value) and
             type(native_length) is int and native_length == text['value_len'],
             'MW_SLOT_LENGTH_TEXT_MISMATCH')
        row['value_len'] = native_length
        return value

    def observe(self, timeout_ms):
        observed = dict(tools.observe(self.surface_id, client=self.client, timeout_ms=timeout_ms))
        tree = self.ax()
        observed['ax_snapshot'] = tree
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
            tree = self.ax()
            rows = [r for r in tree.get('elements', []) if isinstance(r, dict) and r.get('name') in names]
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
            raw = self.answer_only(text['text'], tree.get('elements', []), container).encode('utf-8')
            need(0 < len(raw) <= 65536, 'MW_ANSWER_TEXT')
            path = self.evidence / 'answer.txt'
            ReplayOwner.write(path, raw)
            return dict(captured=True, path=str(path), bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest(),
                        container_id=container)
        except (OSError, ValueError, KeyError, TypeError, OwnerRefused, subprocess.SubprocessError) as error:
            return dict(captured=False, reason=getattr(error, 'code', 'MW_ANSWER_TEXT'),
                        detail=type(error).__name__)

    @staticmethod
    def answer_only(text, rows, container):
        # Native container text is line-separated DOM text. Remove one standalone
        # caption per AX control, never global substring replacement (answer prose
        # can legitimately contain the same words). Ambiguity fails closed.
        lines = text.splitlines()
        for row in rows:
            if (row.get('role') not in ('button', 'link') or
                    not isinstance(row.get('container'), dict) or
                    row['container'].get('id') != container):
                continue
            caption = row.get('name', '').strip()
            if not caption:
                continue
            matches = [i for i, line in enumerate(lines) if line.strip() == caption]
            need(len(matches) <= 1, 'MW_ANSWER_CAPTION_AMBIGUOUS')
            if matches:
                lines.pop(matches[0])
            else:
                need(caption not in text, 'MW_ANSWER_CAPTION_AMBIGUOUS')
        return '\n'.join(lines).strip()

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
        tree = observed.get('ax_snapshot') or self.ax()
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
        return dict(frame=frame, table=table, frame_witness=witness, ax=tree['elements'], window=tree.get('window', {}))

    def state_for(self, sensed):
        # The pinned shim computes Wender IDs, AX hashes and actionable state.
        from metaviewer_agents.perception.compiled import compiled_browser_entry
        tree = dict(elements=sensed['ax'], window=sensed['window'])
        request = dict(element_table=sensed['table'], tree=tree)
        state = compiled_browser_entry('state', request, root=self.wender)
        if state is not None:
            from metaviewer_agents.wender_bridge import validate_state
            validate_state(state)
            return state
        if not hasattr(self, '_glue'):
            self._glue = module('mv_entry_glue', ROOT / 'tools/gate_g_ai.py')
        glue = self._glue
        argv = [sys.executable, '-c', glue.WENDER_SHIM]
        live.refuse_net_argv(argv)
        # [TARGET, unit decision] State and AX predicates share this acquisition's
        # snapshot. Re-reading AX here multiplied native latency and expired the
        # unchanged T1 target before Wender's fixed locate deadline.
        payload = json.dumps(request)
        result = subprocess.run(argv, input=payload, text=True, capture_output=True, timeout=30,
                                cwd=self.wender, env={'PATH': os.defpath, 'PYTHONPATH': str(self.wender),
                                                     'PYTHONDONTWRITEBYTECODE': '1'})
        need(result.returncode == 0, 'MW_RUN_STATE')
        from metaviewer_agents.wender_bridge import validate_state
        state = json.loads(result.stdout)
        validate_state(state)
        return state

    @staticmethod
    def revalidate_action(before, fresh, action):
        need(before['frame']['surface_id'] == fresh['frame']['surface_id'] and
             all(before['frame'][k] == fresh['frame'][k] for k in ('width', 'height')),
             'MW_REBIND_SURFACE')
        def signature(row):
            return {k: row.get(k) for k in ('id', 'role', 'name', 'box', 'actionable', 'focused', 'states', 'value', 'value_len')}
        old, new = before['ax'], fresh['ax']
        if action['type'] == 'click':
            def candidates(rows):
                return [r for r in rows if r.get('actionable') is True and
                        isinstance(r.get('box'), list) and len(r['box']) == 4 and
                        r['box'][0] <= action['x'] < r['box'][0] + r['box'][2] and
                        r['box'][1] <= action['y'] < r['box'][1] + r['box'][3]]
            a, b = candidates(old), candidates(new)
        elif action['type'] in ('type', 'key'):
            def focused(rows):
                return [r for r in rows if r.get('focused') is True or
                        r.get('states', {}).get('focused') in (True, 'true')]
            a, b = focused(old), focused(new)
        else:
            need([signature(r) for r in old] == [signature(r) for r in new], 'MW_REBIND_TARGET')
            return
        need(len(a) == len(b) == 1 and bool(a[0].get('id')) and
             signature(a[0]) == signature(b[0]), 'MW_REBIND_TARGET')

    @staticmethod
    def caret_only_change(before, after, rows, old_pixels, new_pixels):
        """[TARGET, unit decision] Admit only a solid black one-pixel caret.

        Measured blink: one column, fifteen pixels, black versus near white
        background or antialiased edge. Bound height at thirty-two pixels;
        text/value/geometry/focus must independently survive AX revalidation.
        """
        if (before['surface_id'] != after['surface_id'] or
                any(before[k] != after[k] for k in ('width', 'height'))):
            return False
        w, h = before['width'], before['height']
        if len(old_pixels) != len(new_pixels) or len(old_pixels) != w * h * 3:
            return False
        focused = [r for r in rows if r.get('role') in ('textbox', 'combobox') and
                   (r.get('focused') is True or r.get('states', {}).get('focused') in (True, 'true'))]
        if len(focused) != 1:
            return False
        changed = sorted({i // 3 for i, (a, b) in enumerate(zip(old_pixels, new_pixels)) if a != b})
        if not changed or len(changed) > 32:
            return False
        x, y = changed[0] % w, changed[0] // w
        box = focused[0].get('box')
        if (not isinstance(box, list) or len(box) != 4 or
                not (box[0] < x < box[0] + box[2] - 1 and
                     box[1] <= y < y + len(changed) <= box[1] + box[3])):
            return False
        if changed != [((y + dy) * w + x) for dy in range(len(changed))]:
            return False
        first = old_pixels[changed[0]*3:changed[0]*3+3]
        if first == b'\0\0\0':
            caret, off = old_pixels, new_pixels
        elif new_pixels[changed[0]*3:changed[0]*3+3] == b'\0\0\0':
            caret, off = new_pixels, old_pixels
        else:
            return False
        # Measured on x64: beside the last typed glyph the caret's other phase is the glyph's
        # antialiased edge (efefef, not ffffff), so it is near white rather than one flat colour.
        return all(caret[i*3:i*3+3] == b'\0\0\0' and min(off[i*3:i*3+3]) >= CARET_OFF_MIN_LEVEL
                   for i in changed)

    def observe_for_rebind(self, timeout_ms):
        return tools.observe(self.surface_id, client=self.client, timeout_ms=timeout_ms)

    def rebind(self, sensed, plan, remaining):
        deadline = time.monotonic_ns() + remaining * 1_000_000
        observed = self.observe_for_rebind(remaining)
        fresh = self.perceive(observed)
        wall = wall_kind(dict(elements=fresh['ax']))
        if wall:
            raise RebindHandoff(dict(fresh, observed=dict(observed,
                observed_wall=dict(observed=True, kind=wall))))
        self.revalidate_action(sensed, fresh, plan['action'])
        # AX/geometry and pixels were re-perceived. A new generation requires
        # identical pixels or the strictly classified caret blink below.
        latest = tools.observe(self.surface_id, client=self.client, timeout_ms=remaining)['frame_ref']
        same = all(latest[k] == fresh['frame'][k] for k in
                   ('surface_id', 'sha256', 'width', 'height'))
        if not same and hasattr(self, 'evidence'):
            # Hash-check immutable raw frames before classifying a blink.
            witness = self.retain(latest)
            old_pixels = Path(fresh['frame_witness']['artifact']).read_bytes()
            new_pixels = Path(witness['artifact']).read_bytes()
            need(hashlib.sha256(old_pixels).hexdigest() == fresh['frame']['sha256'] and
                 hashlib.sha256(new_pixels).hexdigest() == latest['sha256'], 'MW_FRAME_BINDING')
            same = self.caret_only_change(fresh['frame'], latest, fresh['ax'], old_pixels, new_pixels)
            # fresh AX was acquired between these frame publications and was
            # already compared with the target's original AX snapshot above.
        need(same and latest['generation'] >= fresh['frame']['generation'], 'MW_REBIND_PIXELS')
        witness = self.retain(latest)
        # Disk/hash and native AX work must precede the final publication read.
        # Reuse only the already retained identical pixel content; never spend
        # another native capture/file read between this binding and proposal.
        final = tools.observe(self.surface_id, client=self.client, timeout_ms=remaining)['frame_ref']
        # [TARGET, unit decision] Only the browser goal's verified focused key or text
        # may bind either retained caret phase. Classify an unseen final phase
        # before one more publication read; no pixel reads follow that read.
        # Click/type and other owners keep the identical-final-pixels gate.
        keys = ('surface_id', 'sha256', 'width', 'height')
        if (getattr(self, 'rebind_caret_keys', False) and plan['action']['type'] in ('key', 'type') and
                not all(final[k] == latest[k] for k in keys)):
            alternate = self.retain(final)
            old_pixels = Path(witness['artifact']).read_bytes()
            new_pixels = Path(alternate['artifact']).read_bytes()
            need(hashlib.sha256(old_pixels).hexdigest() == latest['sha256'] and
                 hashlib.sha256(new_pixels).hexdigest() == final['sha256'], 'MW_FRAME_BINDING')
            need(final['generation'] >= latest['generation'] and
                 self.caret_only_change(latest, final, fresh['ax'], old_pixels, new_pixels),
                 'MW_REBIND_PIXELS')
            phases = [(latest, witness), (final, alternate)]
            latest = final
            budget = (deadline - time.monotonic_ns()) // 1_000_000
            need(budget > 0, 'MW_STALE_FRAME_EXHAUSTED')
            final = tools.observe(self.surface_id, client=self.client, timeout_ms=budget)['frame_ref']
            matches = [(frame, proof) for frame, proof in phases
                       if all(final[k] == frame[k] for k in keys)]
            need(bool(matches), 'MW_REBIND_PIXELS')
            witness = matches[0][1]
        else:
            need(all(final[k] == latest[k] for k in keys), 'MW_REBIND_PIXELS')
        need(final['generation'] >= latest['generation'], 'MW_REBIND_PIXELS')
        fresh['frame_witness'] = dict(witness, generation=final['generation'])
        fresh['frame'] = final
        return fresh

    def propose(self, sensed, plan, max_ms):
        self.ownership()
        if self.surface_kind == 'browser':
            self.network_context()
        deadline = time.monotonic_ns() + max_ms * 1_000_000
        self.frame_attempts = getattr(self, 'frame_attempts', [])
        for attempt in range(3 if 'ax' in sensed else 1):
            remaining = (deadline - time.monotonic_ns()) // 1_000_000
            need(remaining > 0, 'MW_STALE_FRAME_EXHAUSTED')
            proposal_id = 'mw-' + uuid.uuid4().hex
            prepare_propose = getattr(self, 'prepare_propose', None)
            if callable(prepare_propose):
                # Durable intent work must precede the final publication read.
                # Its candidate binding is replaced only after normal rebind.
                candidate = build_proposal(sensed['frame'], proposal_id=proposal_id,
                    action=plan['action'], expectation=plan['expectation'], max_ms=remaining)
                prepare_propose(candidate, sensed)
                remaining = (deadline - time.monotonic_ns()) // 1_000_000
                need(remaining > 0, 'MW_STALE_FRAME_EXHAUSTED')
            # Older assembly callers supply only a frame: retain their single-shot
            # core path; fresh-target retry requires the owner's AX evidence.
            try:
                fresh = (self.rebind(sensed, plan, remaining)
                         if 'ax' in sensed or self.surface_kind == 'desktop_capsule' else sensed)
            except OwnerRefused as error:
                # No proposal was sent. Reacquire after a caret/pixel race;
                # changed targets and human handoff still refuse immediately.
                if error.code != 'MW_REBIND_PIXELS':
                    raise
                self.frame_attempts.append(dict(attempt=attempt + 1, status=error.code,
                                                submitted=False))
                continue
            remaining = (deadline - time.monotonic_ns()) // 1_000_000
            need(remaining > 0, 'MW_STALE_FRAME_EXHAUSTED')
            proposal = build_proposal(fresh['frame'], proposal_id=proposal_id,
                                      action=plan['action'], expectation=plan['expectation'], max_ms=remaining)
            binding = proposal.get('based_on_frame')
            if binding is None:
                binding = {k: fresh['frame'][k] for k in ('sha256', 'generation') if k in fresh['frame']}
            row = dict(attempt=attempt + 1, proposal_id=proposal['proposal_id'], based_on_frame=binding,
                       observed_generation=sensed['frame']['generation'], submit_mono_ns=time.monotonic_ns(),
                       status='intent_pending')
            self.frame_attempts.append(row)
            before_propose = getattr(self, 'before_propose', None)
            if callable(before_propose):
                before_propose(copy.deepcopy(proposal), fresh)
            row['status'] = 'dispatch_pending'
            try:
                verdict = tools.propose(proposal, client=self.client, timeout_ms=remaining)
                row['status'] = 'admitted'
                break
            except tools.ToolRefusal as error:
                self.last_core_refusal = error.reason_code
                row['status'] = error.reason_code
                on_refusal = getattr(self, 'proposal_refused', None)
                if callable(on_refusal):
                    on_refusal(row, error)
                if error.reason_code != 'STALE_FRAME' or 'ax' not in sensed:
                    raise
        else:
            raise OwnerRefused('MW_STALE_FRAME_EXHAUSTED')
        sensed = fresh
        max_ms = max(1, (deadline - time.monotonic_ns()) // 1_000_000)
        # The owner's propose seam needs settlement evidence: wait once here,
        # then expose that same verification in its wait_verify stage.
        verified = tools.wait_verify(proposal['proposal_id'], proposal['expectation'], max_ms,
                                     client=self.client, surface_id=self.surface_id)
        native = self.native_witness(verified)
        self.pending[proposal['proposal_id']] = (proposal, copy.deepcopy(sensed['frame']), verified)
        return dict(proposal_id=proposal['proposal_id'], verdict=verdict, native_evidence=copy.deepcopy(native))

    def native_witness(self, verified):
        # [TARGET, unit decision] The frozen core wait projection strips native
        # evidence and exposes validated witnesses on _VerifiedReceipt instead.
        # Preserve the wire receipt; never synthesize input_ts_ns or native IDs.
        native = verified.get('native_evidence')
        if native is None:
            need(isinstance(verified, tools._VerifiedReceipt), 'MW_RECEIPT_MISMATCH')
            tools._check_receipt_verified(verified, surface_id=self.surface_id)
            need(verified.get('focus_verified') is True and
                 type(verified.get('input_mono_ns')) is int and verified.get('input_mono_ns') > 0 and
                 verified.get('frame_sha256') == verified['after_frame']['sha256'], 'MW_RECEIPT_MISMATCH')
            native = dict(surface_id=self.surface_id, input_mono_ns=verified.get('input_mono_ns'))
        need(isinstance(native, dict), 'MW_RECEIPT_MISMATCH')
        return native

    @staticmethod
    def binding(proposal, before, receipt):
        try:
            tools._check_receipt_verified(receipt, surface_id=proposal['surface_id'])
            return (proposal['surface_id'] == before['surface_id'] == receipt['after_frame']['surface_id']
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
    if isinstance(corpus, Corpus):
        corpus, projection = focus_corpus(corpus, evidence)
        if trace is not None and projection is not None:
            trace['focus_projection'] = projection
    network = backend.call('network_context')['mode']
    output = evidence / 'memoryweb-run.json'
    notice = wait_notice(corpus, args.identity, network)
    if trace is not None:
        trace.update(corpus=basis, notice_s=(time.monotonic_ns() - notice) // 1_000_000_000)
    owner = owner_factory(backend, corpus, output, mode='site',
                         notice=dict(mode='site', network=network, acknowledged=True, mono_ns=notice),
                         slot_values=slots(args.slot), readback_ci=bool(os.environ.get('CI')),
                         readback_runner=readback_runner)
    try:
        result = owner.run()
    except OwnerRefused as error:
        faults = home_check.provenance_faults(root / 'sites' / args.site, args.workflow)
        if str(getattr(error, 'code', '')).startswith('MW_GATE_') and faults:
            raise refuse(error.code, 'the pinned MemoryWeb gate refused the stored definition: ' +
                         '; '.join(faults)[:2000] + '; fix the site data, then rerun tools/mw_home_check.py '
                         f'--repo <MetaViewer checkout> --workflow {args.site}/{args.workflow}') from error
        raise
    if trace is not None:
        trace['focus_steps'] = getattr(owner, 'focus_evidence', [])
        trace['diagnostic'] = result.diagnostic
        if hasattr(backend, 'frame_attempts'):
            trace['frame_attempts'] = backend.frame_attempts
        refusal = getattr(backend, 'last_core_refusal', None)
        if refusal is not None:
            trace['core_refusal'] = refusal
    if result.handoff_path:
        handoff = Path(result.handoff_path)
        need(handoff == output.with_suffix('.handoff.json') and handoff.is_file(), 'MW_HANDOFF_REQUIRED')
        return 4, 'HUMAN_HANDOFF', str(handoff)
    if not output.is_file() and result.rc != 0:
        return result.rc, result.verdict_code, None
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
    if getattr(args, 'surface_kind', 'browser') == 'program':
        program = module('mv_mw_run_program', ROOT / 'tools/mw_run_program.py')
        return program.run_entry(args)
    if getattr(args, 'goal', None) is not None:
        browser = module('mv_mw_run_browser_goal', ROOT / 'tools/mw_run_browser_goal.py')
        return browser.run_entry(args)
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
        need(not any(p.is_symlink() for p in (evidence, *evidence.parents)), 'MW_PRIVATE_OUTPUT')
        base.mkdir(mode=0o700, parents=True, exist_ok=True)
        for path in (evidence.parent.parent, evidence.parent, evidence):
            path.mkdir(mode=0o700, exist_ok=True)
            metadata = path.lstat()
            need(not path.is_symlink() and stat.S_ISDIR(metadata.st_mode) and
                 metadata.st_uid == os.getuid() and stat.S_IMODE(metadata.st_mode) == 0o700,
                 'MW_PRIVATE_OUTPUT')
        report = str(evidence / 'report.json')
        with connect(os.environ, trace) as client:
            backend = HostBackend(client, args.identity, evidence, os.environ)
            rc, code, receipt = execute(args, home, evidence, backend, trace=trace)
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, AttributeError,
            ClientError, tools.ToolRefusal, tools.VerificationFailed, subprocess.SubprocessError) as error:
        if callable(getattr(args, 'finish_wall_deadline', None)):
            args.finish_wall_deadline()
        code = getattr(error, 'code', getattr(error, 'reason_code', 'MW_RUN_CONFIG'))
        message = str(error)
        if isinstance(error, subprocess.TimeoutExpired):
            code, message = 'MW_RUN_NATIVE', 'native discovery command timed out'
        elif isinstance(error, ClientError):
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
    if callable(getattr(args, 'finish_wall_deadline', None)):
        args.finish_wall_deadline()
    result = dict(schema='metaviewer.mw_run/v1', rc=rc, verdict_code=code, receipt=receipt, report=report)
    if report is not None:
        try:
            ReplayOwner.write(Path(report), (json.dumps(dict(result, message=message,
                network=getattr(backend, 'network_evidence', None), **trace), separators=(',', ':')) + '\n').encode())
        except OSError:
            result['report'] = None
            if result['rc'] not in (4, 5):
                result.update(rc=6, verdict_code='MW_PRIVATE_OUTPUT')
    print(json.dumps(result, separators=(',', ':')))
    return result['rc']
