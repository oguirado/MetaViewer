#!/usr/bin/env python3
"""Offline E1 rehearsal against an operator-supplied packaged app.

[TARGET, unit decision] Paths are explicit arguments, never host defaults.
The packaged UI auto-creates its first capsule. Native input is used only to
set up the local page; the workflow runs as an unmodified external CLI process.
Logs, copied site data and output are retained in a private temporary directory.
No identity-store or browser-profile files are opened by this driver.
"""
import argparse
import csv
import io
import shlex
import re
import functools
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'tests/e2e/fixtures/mw_perplexity'
ANSWER = 'Offline fixture answer: Paris is the capital of France.'


def safe_capsule(name):
    return (isinstance(name, str) and name.startswith('srf-id-')
            and name not in ('srf-id-cuentas-1', 'srf-id-perplexity-1'))


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(argv, *, check=True, **kwargs):
    result = subprocess.run([str(a) for a in argv], capture_output=True,
                            text=True, timeout=kwargs.pop('timeout', 30), **kwargs)
    print(json.dumps(dict(command=[str(a) for a in argv], rc=result.returncode)), flush=True)
    if check:
        require(result.returncode == 0, result.stderr or result.stdout)
    return result


def inventory():
    rows = command(['docker', 'ps', '--format', '{{.ID}} {{.Names}}']).stdout.splitlines()
    return dict(row.split(maxsplit=1)[::-1] for row in rows)


def wait_empty(seconds):
    deadline = time.monotonic() + seconds
    while True:
        active = [name for name in inventory() if name.startswith('srf-id-')]
        if not active:
            return
        require(time.monotonic() < deadline, 'capsule admission timed out: ' + ', '.join(active))
        time.sleep(5)


def wait_for(probe, seconds, message):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = probe()
        if value:
            return value
        time.sleep(.25)
    raise RuntimeError(message)


def descendant(pid, ancestor, proc=Path('/proc')):
    """Fail closed if the recorded launcher does not own this process."""
    seen = set()
    while pid > 1 and pid not in seen:
        if pid == ancestor:
            return True
        seen.add(pid)
        try:
            pid = int((proc / str(pid) / 'stat').read_text().rpartition(')')[2].split()[1])
        except (OSError, ValueError, IndexError):
            return False
    return False


def owns_attach(values, launcher):
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit() or not descendant(int(entry.name), launcher):
            continue
        try:
            if Path(os.readlink(entry / 'exe')).name != 'mv-daemon-adapter':
                continue
            expected = b'MV_CORE_CONFIG=' + values['MV_CORE_CONFIG'].encode()
            if expected in (entry / 'environ').read_bytes().split(b'\0'):
                return True
        except OSError:
            continue
    return False


def notice_visible(text):
    text = text.casefold()
    return all(word in text for word in ('login required', 'take control', 'acknowledge'))


def native_context(attached, registry):
    """Explicit native context; never open store or registry contents."""
    store = Path(attached['SRF_IDENTITY_STORE_ROOT'])
    require(store.is_absolute() and registry.is_absolute(), 'native context paths must be absolute')
    return ['--store-root', str(store), '--registry', str(registry)]


def screenshot_text(work, display, name):
    from PIL import ImageGrab
    image = work / (name + '.png')
    ImageGrab.grab(xdisplay=display).save(image)
    text = command(['tesseract', image, 'stdout'], timeout=30).stdout
    (work / (name + '.ocr.txt')).write_text(text)
    return text


def validate_run(result, expected):
    require(len(result.stdout.splitlines()) == 1, 'expected one JSON output line')
    value = json.loads(result.stdout)
    require(value['schema'] == 'metaviewer.mw_run/v1', 'result schema mismatch')
    require((result.returncode, value['rc'], value['verdict_code']) ==
            (expected[0], *expected), 'workflow result mismatch: ' + result.stdout)
    require('in 10 s; interrupt now to cancel' in result.stderr, 'countdown absent')
    require(all(isinstance(value[key], str) and Path(value[key]).is_absolute()
                for key in ('report', 'receipt')), 'absolute artifact paths absent')
    report = json.loads(Path(value['report']).read_text())
    receipt = json.loads(Path(value['receipt']).read_text())
    require(report['attach'] == 'discovered', 'attach path was bypassed')
    if expected[0] == 0:
        require(receipt['rc'] == 0 and receipt['verdict_code'] == 'VERIFIED', 'receipt refused')
        focus = report.get('focus_steps', [])
        skipped = [step for step in focus if step.get('core_action_verified') is False
                   and step.get('seq') == 1]
        require(len(focus) == len(skipped) and len(skipped) <= 1
                and receipt.get('steps_skipped_satisfied') == len(skipped),
                'focus skip lacks core_action_verified:false')
        require((receipt['steps_total'], receipt['steps_verified'], receipt['steps_failed']) ==
                (3, 3 - len(skipped), 0), 'workflow steps not verified')
        answer = Path(report['answer']['path'])
        require(report['answer']['captured'] is True and answer.name == 'answer.txt'
                and answer.read_text() == ANSWER, 'answer capture mismatch')
    else:
        require(receipt['reason'] == 'login_wall', 'wall not classified')
    return value


class Pages(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def end_headers(self):
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'")
        super().end_headers()


def stage_home(work, origin):
    home = work / 'memoryweb'
    site = home / 'sites/perplexity'
    shutil.copytree(FIXTURE / 'site', site)
    for path in (home, *home.rglob('*')):
        path.chmod(0o700 if path.is_dir() else 0o600)
    notes = (FIXTURE / 'repair/NOTES.md').read_bytes()
    (site / 'PROVENANCE.md').write_bytes(notes)
    (site / 'PROVENANCE.md').chmod(0o600)
    for name in ('site.json', 'workflows/ask.json'):
        path = site / name
        value = json.loads(path.read_bytes())
        value['provenance'].update(source='human', source_ref='PROVENANCE.md', receipt_sha256=None,
                                   quote_sha256=hashlib.sha256(notes).hexdigest())
        if name == 'site.json':
            value['domains'] = [origin.split('://')[1].split(':')[0]]
        path.write_text(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n')
    return home


def check_fixture_encoding(raw):
    from html.parser import HTMLParser
    class Encoding(HTMLParser):
        declared = False
        def handle_starttag(self, tag, attrs):
            if tag == 'meta' and dict(attrs).get('charset', '').lower() == 'utf-8':
                self.declared = True
    parser = Encoding()
    parser.feed(raw.decode('utf-8'))
    require(parser.declared, 'fixture must declare UTF-8 for native AX label identity')
    return True


def copy_fixture(capsule, destination, home_page="home"):
    require(home_page in ("home", "home_focus"), "unapproved home fixture")
    """Only tracked public fixture bytes enter the owned capsule's temporary RAM."""
    require(safe_capsule(capsule), 'protected capsule refused')
    require(destination.startswith('/tmp/mv-e1-probe-') and '..' not in destination,
            'fixture destination refused')
    for name in (home_page + '.html', 'answer.html', 'login.html'):
        check_fixture_encoding((FIXTURE / 'packaged' / name).read_bytes())
    command(['docker', 'exec', capsule, 'mkdir', '-p', destination])
    for name in (home_page + '.html', 'answer.html', 'login.html'):
        command(['docker', 'exec', '-i', capsule, 'sh', '-c', 'cat > "$1"',
                 'fixture-copy', destination + '/' + name],
                input=(FIXTURE / 'packaged' / name).read_text())
    return True


def measured_position(value):
    require(re.fullmatch(r'[0-9]+,[0-9]+', value) is not None, 'invalid control coordinates')
    x, y = map(int, value.split(','))
    require(0 <= x < 1600 and 0 <= y < 1000, 'control coordinates outside dedicated screen')
    return x, y


def control_position(tsv, word):
    rows = csv.DictReader(io.StringIO(tsv), delimiter='\t')
    matches = [r for r in rows if r['text'].strip() == word]
    require(len(matches) == 1, 'UI control ambiguous/absent: ' + word)
    row = matches[0]
    return (int(row['left']) + int(row['width']) // 2,
            int(row['top']) + int(row['height']) // 2)


def role_menu_position(tsv):
    """Locate the agent tile menu button (⋮) from its header badge or glyph."""
    rows = [r for r in csv.DictReader(io.StringIO(tsv), delimiter='\t') if r['text'].strip()]
    menus = [r for r in rows if r['text'].strip() in ('⋮', '...')]
    if len(menus) == 1:
        row = menus[0]
        return (int(row['left']) + int(row['width']) // 2,
                int(row['top']) + int(row['height']) // 2)
    badges = [r for r in rows if r['text'].strip().casefold() == 'agent']
    require(len(badges) == 1, 'UI role menu badge ambiguous/absent: agent')
    row = badges[0]
    height = int(row['height'])
    require(height > 0, 'invalid badge height')
    x = int(row['left']) + int(row['width']) + max(14, int(round(height * 1.4)))
    y = int(row['top']) + height // 2
    require(0 <= x < 1600 and 0 <= y < 1000, 'role menu coordinates outside dedicated screen')
    return x, y


def emergency_take_position(tsv):
    """Locate Take control (emergency) inside the open agent tile menu, never Switch mode."""
    rows = [r for r in csv.DictReader(io.StringIO(tsv), delimiter='\t') if r['text'].strip()]
    emergency = [r for r in rows if 'emergency' in r['text'].strip().casefold().strip('()')]
    require(len(emergency) == 1, 'UI emergency control ambiguous/absent: Take control (emergency)')
    target = emergency[0]
    top = int(target['top'])
    height = max(1, int(target['height']))
    line = [r for r in rows if abs(int(r['top']) - top) <= height]
    words = {r['text'].strip().casefold().strip('()') for r in line}
    require({'take', 'control'} <= words and 'switch' not in words,
            'UI emergency control line mismatch: ' + ' '.join(sorted(words)))
    left = min(int(r['left']) for r in line)
    right = max(int(r['left']) + int(r['width']) for r in line)
    return (left + right) // 2, top + height // 2


def run_control_cycle(work, display, attached, backend, surface_id, args, grab=None):
    """Switch to Agents view, open tile menu, take emergency control, and release to agent."""
    if grab is None:
        from PIL import ImageGrab
        grab = lambda path: ImageGrab.grab(xdisplay=display).save(path)

    def snapshot_tsv(name):
        image = work / (name + '.png')
        grab(image)
        tsv = command(['tesseract', image, 'stdout', 'tsv']).stdout
        (work / (name + '.tsv')).write_text(tsv)
        return tsv

    def click(x, y):
        command(['xdotool', 'mousemove', '--sync', str(x), str(y), 'click', '1'],
                env=dict(os.environ, DISPLAY=display))

    def owner(ownership):
        with backend.connect(attached) as client:
            rows = backend.tools.list_surfaces(cursor=None, limit=64,
                       timeout_ms=5000, client=client)['surfaces']
        return next((r for r in rows if r['surface_id'] == surface_id
                     and r['control'] == ownership), None)

    # Cold workspace boots on Humans view; switch to Agents view so the agent tile is visible.
    view_tsv = snapshot_tsv('control-view')
    vx, vy = (measured_position(args.agents_view_at) if getattr(args, 'agents_view_at', None)
              else control_position(view_tsv, 'Agents'))
    click(vx, vy)
    time.sleep(0.5)

    # Open the tile menu (tile-menu-<id>) unless an explicit take-control coordinate is supplied alone.
    if getattr(args, 'tile_menu_at', None) or not getattr(args, 'take_control_at', None):
        menu_tsv = snapshot_tsv('control-menu')
        mx, my = (measured_position(args.tile_menu_at) if getattr(args, 'tile_menu_at', None)
                  else role_menu_position(menu_tsv))
        click(mx, my)
        time.sleep(0.5)

    take_tsv = snapshot_tsv('control-human')
    tx, ty = (measured_position(args.take_control_at) if getattr(args, 'take_control_at', None)
              else emergency_take_position(take_tsv))
    click(tx, ty)
    wait_for(lambda: owner('human'), 10, 'control transition absent: human')
    time.sleep(1)

    release_tsv = snapshot_tsv('control-agent')
    rx, ry = (measured_position(args.release_control_at) if getattr(args, 'release_control_at', None)
              else control_position(release_tsv, 'Release'))
    click(rx, ry)
    wait_for(lambda: owner('agent'), 10, 'control transition absent: agent')
    time.sleep(1)
    return True


def bind_operator_repo(text, repo):
    """Override the single supplied launcher binding, without changing its source."""
    text, count = re.subn(r'MV_OPERATOR_REPO=\S+',
                          lambda _: 'MV_OPERATOR_REPO=' + shlex.quote(str(repo)), text)
    require(count == 1, 'launcher operator-repo binding is ambiguous')
    return text


class ProbeStages:
    """[TARGET, unit decision] Diagnostic failures persist and do not abort peers."""
    def __init__(self, work):
        self.path = work / 'stages.jsonl'
        self.failed = False

    def run(self, name, operation, *, forced=False):
        try:
            value = operation()
            row = dict(stage=name, status='PASS', forced=forced)
        except Exception as error:
            self.failed = True
            value = None
            row = dict(stage=name, status='FAIL', forced=forced,
                       error=type(error).__name__ + ': ' + str(error))
        with self.path.open('a') as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + '\n')
        print(json.dumps(row, ensure_ascii=False), flush=True)
        return value


def probe_entry(work, repo, redundant_ax_mutant=False):
    """Instrument a temporary CLI copy; preserve real return values and exceptions."""
    path = work / 'probe_entry.py'
    path.write_text("""
import importlib.util, json, sys, time, traceback
from pathlib import Path
repo, log = Path(sys.argv.pop(1)), Path(sys.argv.pop(1))
sys.path.insert(0, str(repo / 'agents'))
spec = importlib.util.spec_from_file_location('probe_backend', repo / 'tools/mw_run_backend.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
def emit(row):
    with log.open('a') as stream:
        stream.write(json.dumps(row, ensure_ascii=False, default=str) + '\\n')
def wrap(cls, name):
    original = getattr(cls, name)
    def call(self, *args, **kwargs):
        row = dict(method=name, mono_ns=time.monotonic_ns())
        if name == 'propose':
            row['action'] = kwargs.get('plan', {}).get('action')
            row['frame'] = kwargs.get('sensed', {}).get('frame')
        try:
            result = original(self, *args, **kwargs)
            row['status'] = 'PASS'
            if name in ('observe', 'perceive', 'state_for', 'ax', 'capture_answer', 'network_context', 'propose', 'wait_verify'):
                row['result'] = ({k: result[k] for k in ('frame', 'frame_ref', 'frame_witness') if k in result}
                                 if name in ('observe', 'perceive') else result)
            row['end_mono_ns'] = time.monotonic_ns()
            if name == 'propose':
                row['frame_attempts'] = getattr(self, 'frame_attempts', [])
            emit(row)
            return result
        except Exception as error:
            row.update(status='FAIL', error=str(error), traceback=traceback.format_exc())
            if name == 'propose':
                row['frame_attempts'] = getattr(self, 'frame_attempts', [])
            if hasattr(error, 'receipt'):
                row['receipt'] = error.receipt
            emit(row)
            raise
    setattr(cls, name, call)
for name in ('ownership', 'network_context', 'ax', 'observe', 'perceive', 'state_for',
             'propose', 'wait_verify', 'capture_answer'):
    wrap(host.HostBackend, name)
original_command = host.command
def command(*args, **kwargs):
    result = original_command(*args, **kwargs)
    if result.returncode:
        emit(dict(method='native_command', argv=args[0], rc=result.returncode,
                  stderr=result.stderr.decode('utf-8', 'replace'),
                  refusal=result.stdout.decode('utf-8', 'replace')[:500] if result.returncode else ''))
    return result
host.command = command
from metaviewer_agents.mw_owner import wender_api
mw = wender_api()[1]
original_grounded = mw._grounded
def diagnostic_grounded(value, target, state, owners, deadline):
    now = owners.clock()
    result = original_grounded(value, target, state, owners, deadline)
    emit(dict(method='grounding_gate', passed=result, now_ns=now,
              deadline_ns=deadline, expires_ns=value.expires_ns,
              remaining_ns=min(deadline, value.expires_ns)-now))
    return result
mw._grounded = diagnostic_grounded
original_need = mw._need
def diagnostic_need(value, *args, **kwargs):
    if not value:
        emit(dict(method='workflow_gate', mono_ns=time.monotonic_ns(), args=args, stack=traceback.format_stack()))
    return original_need(value, *args, **kwargs)
mw._need = diagnostic_need
from metaviewer_agents.mw_owner import ReplayOwner, PrivateSlots
for name in ('acquire', 'send', 'check', 'focus'):
    wrap(ReplayOwner, name)
wrap(PrivateSlots, 'read')
def owner_exceptions(frame, event, arg):
    if not frame.f_code.co_filename.endswith(('mw_workflow.py', 'mw_owner.py')):
        return None
    if event == 'exception':
        kind, error, _ = arg
        if kind not in (StopIteration, GeneratorExit):
            emit(dict(method='owner_exception', file=frame.f_code.co_filename,
                      line=frame.f_lineno, error_type=kind.__name__, error=str(error)))
    return owner_exceptions
sys.settrace(owner_exceptions)
from metaviewer_agents.mw_run import main
sys.exit(main(runner=host.run_entry))
""")
    if redundant_ax_mutant:
        source = path.read_text()
        source = source.replace("from metaviewer_agents.mw_run import main", """
# Negative control: restore the pre-fix repeated AX acquisitions.
original_observe = host.HostBackend.observe
def repeated_observe(self, *args, **kwargs):
    result = original_observe(self, *args, **kwargs)
    result.pop('ax_snapshot', None)
    return result
host.HostBackend.observe = repeated_observe
original_state = host.HostBackend.state_for
def repeated_state(self, sensed):
    self.ax()
    return original_state(self, sensed)
host.HostBackend.state_for = repeated_state
from metaviewer_agents.mw_owner import ReplayOwner
original_sense = ReplayOwner.sense
def repeated_sense(self, deadline):
    result = original_sense(self, deadline)
    tree = self.backend.call('ax')
    result['ax'] = tree.get('nodes', tree.get('elements'))
    return result
ReplayOwner.sense = repeated_sense
from metaviewer_agents.mw_run import main""")
        path.write_text(source)
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--launcher', type=Path, required=True)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--operator-repo', type=Path, required=True)
    parser.add_argument('--wender-root', type=Path, required=True)
    parser.add_argument('--proxy-registry', type=Path, required=True)
    parser.add_argument('--fixture-host', required=True, help='local host address reachable from the capsule')
    parser.add_argument('--forward-probe', action='store_true')
    parser.add_argument('--redundant-ax-mutant', action='store_true', help='negative control: restore repeated native AX reads')
    parser.add_argument('--focused-home', action='store_true')
    parser.add_argument('--home-only', action='store_true')
    parser.add_argument('--control-cycle', action='store_true')
    parser.add_argument('--agents-view-at', help='screenshot-measured Xvfb x,y for Agents view button')
    parser.add_argument('--tile-menu-at', help='screenshot-measured Xvfb x,y for tile menu button')
    parser.add_argument('--take-control-at', help='screenshot-measured Xvfb x,y')
    parser.add_argument('--release-control-at', help='screenshot-measured Xvfb x,y')
    parser.add_argument('--file-fixture', action='store_true', help='use owned local files directly')
    parser.add_argument('--display', default=':98')
    parser.add_argument('--admission-timeout', type=int, default=600)
    args = parser.parse_args(argv)
    work = Path(tempfile.mkdtemp(prefix='mv-e1-packaged-'))
    print('EVIDENCE ' + str(work), flush=True)
    xvfb = app = server = None
    owned = {}
    stages = ProbeStages(work)
    try:
        require(args.display == ':98', 'only the dedicated rehearsal display :98 is admitted')
        require(not Path('/tmp/.X98-lock').exists(), 'display :98 is occupied')
        require(args.launcher.is_file(), 'launcher absent')
        require((args.run_dir / 'MetaViewer-linux-arm64/metaviewer').is_file(), 'package absent')
        entry = args.run_dir / 'MetaViewer-linux-arm64/resources/operator/docs/AGENT_ENTRY.md'
        require('python3 -m metaviewer_agents.mw_run' in entry.read_text(), 'bundled entry command absent')
        for tool in ('Xvfb', 'xdpyinfo', 'docker', 'tesseract'):
            require(shutil.which(tool), 'tool absent: ' + tool)
        # Binding succeeds only for a local interface; no remote fixture origin is admitted.
        server = ThreadingHTTPServer((args.fixture_host, 0), functools.partial(
            Pages, directory=str(FIXTURE / 'packaged')))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f'http://{args.fixture_host}:{server.server_port}'
        home = stage_home(work, origin)
        env = dict(os.environ, DISPLAY=args.display, MV_MW_WENDER_ROOT=str(args.wender_root),
                   MV_WENDER_ROOT=str(args.wender_root))
        xvfb = subprocess.Popen([shutil.which('Xvfb'), args.display, '-screen', '0', '1600x1000x24'],
                                stdout=(work / 'xvfb.log').open('w'), stderr=subprocess.STDOUT)
        wait_for(lambda: subprocess.run(['xdpyinfo', '-display', args.display],
                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0,
                 10, 'Xvfb did not become ready')
        wait_empty(args.admission_timeout)
        start_wall_ns = time.time_ns()
        # Pin only the operator checkout in a private copy of the supplied launcher.
        launcher_text = bind_operator_repo(args.launcher.read_text(), args.operator_repo)
        launcher = work / 'launcher.sh'
        launcher.write_text(launcher_text)
        app = subprocess.Popen(['bash', str(launcher), str(args.run_dir)], env=env,
                               stdout=(work / 'app.log').open('w'), stderr=subprocess.STDOUT)
        (work / 'pids.json').write_text(json.dumps(dict(xvfb=xvfb.pid, launcher=app.pid)))
        sys.path.insert(0, str(ROOT / 'agents'))
        import importlib.util
        spec = importlib.util.spec_from_file_location('rehearsal_backend', ROOT / 'tools/mw_run_backend.py')
        backend = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(backend)

        def ready():
            require(app.poll() is None, 'launcher exited; see ' + str(work / 'app.log'))
            try:
                attached = backend.discover_attach()
                if not owns_attach(attached, app.pid):
                    return None
                with backend.connect(attached) as client:
                    reply = backend.tools.list_surfaces(cursor=None, limit=64, timeout_ms=1000, client=client)
                    rows = reply['surfaces']
                selected = [r for r in rows if r['profile_id'] == 'mv-live-1' and r['state'] == 'active']
                if len(selected) != 1:
                    return None
                witness_path = Path(attached['MV_SRF_STATE_DIR']) / 'egress/mv-live-1.started.json'
                witness = json.loads(witness_path.read_text())
                if witness['start_wall_ns'] < start_wall_ns:
                    return None
                current = inventory()
                capsules = set()
                for path in Path(attached['MV_SRF_STATE_DIR']).glob('*.json'):
                    if path.stat().st_mtime_ns < start_wall_ns:
                        continue
                    receipt = backend.private_json(path, Path(attached['MV_SRF_STATE_DIR']))
                    capsule = backend.live.capsule_from_receipt(receipt, 'mv-live-1')
                    if capsule:
                        capsules.add(capsule)
                if len(capsules) != 1 or not capsules <= current.keys():
                    return None
                capsule = next(iter(capsules))
                require(safe_capsule(capsule), 'protected or non-identity capsule refused')
                owned[capsule] = current[capsule]
                return attached, selected[0], capsule
            except (OSError, RuntimeError, ValueError):
                return None

        attached, surface, capsule = wait_for(ready, 90, 'packaged app/capsule not ready; see app.log')
        # Native control receipts bind ownership; egress witness agreement is tested by mw_run itself.
        witness = json.loads((Path(attached['MV_SRF_STATE_DIR']) / 'egress/mv-live-1.started.json').read_text())
        (work / 'binding.json').write_text(json.dumps(dict(surface=surface['surface_id'],
            capsule=capsule, witness=witness)))
        (work / 'containers.json').write_text(json.dumps(owned))
        native = Path(attached['MV_SRF_BIN_DIR']) / 'srf-identity-surface'

        def navigate(page):
            for flags in (['--key', 'ctrl+l'], ['--type', origin + '/' + page + '.html'], ['--key', 'Return']):
                command([native, 'input', '--container', capsule, '--window', 'w1',
                         '--state-dir', attached['MV_SRF_STATE_DIR'],
                         *native_context(attached, args.proxy_registry), *flags])
            time.sleep(2)

        def native_call(verb, *flags):
            result = command([native, verb, '--container', capsule, '--window', 'w1',
                              '--state-dir', attached['MV_SRF_STATE_DIR'],
                              *native_context(attached, args.proxy_registry), *flags])
            value = json.loads(result.stdout)
            with (work / 'native.jsonl').open('a') as stream:
                stream.write(json.dumps(dict(verb=verb, flags=flags, result=value), ensure_ascii=False) + '\n')
            return value

        def fixture_ax(page):
            value = native_call('ax')
            names = {row.get('name') for row in value.get('elements', [])}
            require('Pregunta lo que sea…' in names,
                    'fixture composer absent: ' + repr(sorted(str(n) for n in names)))
            if page == 'login':
                require('Inicia sesión o crea una cuenta' in names, 'login fixture dialog absent')
            return value

        def force_remaining():
            # Independent diagnostic inputs never turn the workflow failure green.
            tree = stages.run('forced.home.ax', lambda: native_call('ax'), forced=True)
            rows = tree.get('elements', []) if isinstance(tree, dict) else []
            composers = [row for row in rows if row.get('name') == 'Pregunta lo que sea…']
            def focus():
                require(len(composers) == 1, 'composer must be unique')
                x, y, width, height = composers[0]['box']
                return native_call('input', '--click', f'{x + width // 2},{y + height // 2}')
            stages.run('forced.composer.click', focus, forced=True)
            def type_prompt():
                value = native_call('ax')
                require(any(row.get('name') == 'Pregunta lo que sea…' and row.get('focused') is True
                            for row in value.get('elements', [])), 'composer is not focused')
                return native_call('input', '--type', 'What is the capital of France? Ω', '--paste')
            stages.run('forced.prompt.type', type_prompt, forced=True)
            def submit():
                value = native_call('ax')
                require(any(row.get('name') == 'Pregunta lo que sea…' and row.get('focused') is True
                            and row.get('value_len') == len('What is the capital of France? Ω')
                            for row in value.get('elements', [])), 'prompt not delivered to composer')
                return native_call('input', '--key', 'Return')
            stages.run('forced.submit', submit, forced=True)
            def answer_tree():
                value = native_call('ax')
                return value if any(r.get('name') == 'Copiar' for r in value.get('elements', [])) else None
            stages.run('forced.answer.wait', lambda: wait_for(answer_tree, 15, 'answer anchor absent'), forced=True)
            def capture():
                from unittest.mock import patch
                with patch.dict(os.environ, MV_WENDER_ROOT=str(args.wender_root)), backend.connect(attached) as client:
                    host = backend.HostBackend(client, 'mv-live-1', work, attached)
                    workflow = json.loads((home / 'sites/perplexity/workflows/ask.json').read_text())
                    result = host.capture_answer(workflow)
                    require(result.get('captured') is True, json.dumps(result))
                    require(Path(result['path']).read_text() == ANSWER, 'forced answer mismatch')
                    return result
            stages.run('forced.answer.extraction_and_file', capture, forced=True)

        caller = {k: v for k, v in env.items() if k not in backend.ATTACH_KEYS and k != 'MV_AGENT_INSTANCE'}
        caller.update(MV_MW_HOME=str(home), MV_OPERATOR_REPO=str(args.operator_repo))
        probe = probe_entry(work, args.operator_repo, args.redundant_ax_mutant) if args.forward_probe else None
        # Use the app's ordinary evidence location so its real handoff watcher sees the run.
        caller.pop('XDG_STATE_HOME', None)
        preflight = command([sys.executable, args.operator_repo / 'tools/mw_home_check.py', '--repo',
                             args.operator_repo, '--home', home, '--workflow', 'perplexity/ask'], env=caller)
        require(json.loads(preflight.stdout)['ok'], 'home preflight refused')
        forced_transport = False
        if args.file_fixture:
            destination = '/tmp/mv-e1-probe-' + work.name
            stages.run('fixture.copy', lambda: copy_fixture(capsule, destination, 'home_focus' if args.focused_home else 'home'))
            origin = 'file://' + destination
        pages = [('home', (0, 'VERIFIED'))]
        if not args.home_only:
            pages.append(('login', (4, 'HUMAN_HANDOFF')))
        for page, expected in pages:
            navigate('home_focus' if page == 'home' and args.focused_home else page)
            if args.forward_probe:
                tree = stages.run(page + '.native_ax', lambda: fixture_ax(page), forced=forced_transport)
                if page == 'home' and tree is None:
                    # No proxy policy changes: tracked fixtures only, inside our proven capsule.
                    destination = '/tmp/mv-e1-probe-' + work.name
                    stages.run('forced.fixture.copy', lambda: copy_fixture(capsule, destination, 'home_focus' if args.focused_home else 'home'), forced=True)
                    origin = 'file://' + destination
                    forced_transport = True
                    stages.run('forced.home.navigate', lambda: navigate(page), forced=True)
                    stages.run('forced.home.native_ax', lambda: fixture_ax(page), forced=True)
            if page == 'home' and args.forward_probe:
                def sample_frames():
                    samples = []
                    with backend.connect(attached) as client:
                        for _ in range(31):
                            frame = backend.tools.observe(surface['surface_id'], client=client, timeout_ms=5000)['frame_ref']
                            samples.append(dict(mono_ns=time.monotonic_ns(), frame=frame))
                            time.sleep(0.1)
                    (work / 'idle-frames.json').write_text(json.dumps(samples))
                    return samples
                if args.focused_home:
                    def check_focus():
                        value = native_call('ax')
                        require(any(r.get('name') == 'Pregunta lo que sea…' and r.get('focused') is True
                                    for r in value.get('elements', [])), 'autofocus composer not focused')
                        return True
                    stages.run('home.composer_focused', check_focus)
                if args.control_cycle:
                    cycled = stages.run('home.take_release_control',
                        lambda: run_control_cycle(work, args.display, attached, backend,
                                                  surface['surface_id'], args))
                    require(cycled is True, 'required take/release cycle did not complete')
                    if args.focused_home:
                        stages.run('home.composer_focused_after_release', check_focus)
                stages.run('home.idle_verified_frames', sample_frames)
            if page == 'login':
                def before_notice():
                    require(not notice_visible(screenshot_text(work, args.display, 'before-login')),
                            'a pre-existing login notice would invalidate the display oracle')
                    return True
                if args.forward_probe:
                    stages.run('login.display_baseline', before_notice)
                else:
                    before_notice()
            entry_argv = ([sys.executable, str(probe), str(args.operator_repo), str(work / (page + '.trace.jsonl'))]
                          if probe else [sys.executable, '-m', 'metaviewer_agents.mw_run'])
            result = command([*entry_argv, '--identity', 'mv-live-1',
                              '--site', 'perplexity', '--workflow', 'ask', '--slot',
                              'prompt=What is the capital of France? Ω'], cwd=args.operator_repo / 'agents',
                              env=caller, check=False, timeout=210)
            # Preserve only our packaged session's authority evidence before the
            # launcher removes its private runtime on exit. No identity data.
            config_path = Path(attached['MV_CORE_CONFIG'])
            config = json.loads(config_path.read_text())
            session = config_path.parent / 'state/metaviewer/sessions' / config['session_id']
            for name in ('journal.jsonl', 'checkpoint.json'):
                if (session / name).is_file():
                    shutil.copyfile(session / name, work / (page + '.core.' + name))
            transitions = []
            for event_path in (session / 'events').glob('*.json'):
                event = json.loads(event_path.read_text())
                if event['input'].get('event') not in ('Frame', 'Lifecycle', 'Propose', 'Dispatch', 'Receipt', 'TakeControl', 'ReleaseControl'):
                    continue
                row = {k: event[k] for k in ('input', 'outcome', 'record', 'state')}
                row['boundaries'] = []
                for witness in event['witnesses']:
                    artifact = session / 'artifacts' / witness['sha256']
                    if witness['byte_len'] > 12000 or not artifact.is_file():
                        continue
                    try:
                        row['boundaries'].append(json.loads(artifact.read_text()))
                    except (ValueError, UnicodeDecodeError):
                        pass
                transitions.append(row)
            (work / (page + '.core.transitions.json')).write_text(json.dumps(transitions))
            (work / (page + '.stdout')).write_text(result.stdout)
            (work / (page + '.stderr')).write_text(result.stderr)
            print(result.stderr, end='', flush=True)
            print(result.stdout, end='', flush=True)
            if args.forward_probe:
                outcome = stages.run(page + '.workflow', lambda: validate_run(result, expected), forced=forced_transport)
                if page == 'home' and outcome is None:
                    force_remaining()
            else:
                validate_run(result, expected)
            if page == 'login':
                # A screenshot of our Xvfb display proves a new notice, independently of the JSON.
                def notice():
                    return wait_for(lambda: notice_visible(screenshot_text(work, args.display, 'login-notice')),
                                    20, 'login handoff notice absent from the packaged UI')
                if args.forward_probe:
                    stages.run('login.display_notice', notice)
                else:
                    notice()
        if stages.failed:
            print('FAIL forward probe; see ' + str(stages.path), flush=True)
            return 1
        print('PASS packaged E1 answer and human handoff', flush=True)
        return 0
    finally:
        # Release the native identity lease while its state still exists.
        for name, container_id in owned.items():
            if inventory().get(name) == container_id and 'attached' in locals():
                command([str(Path(attached['MV_SRF_BIN_DIR']) / 'srf-identity-surface'),
                         'stop', '--container', name, '--state-dir', attached['MV_SRF_STATE_DIR'],
                         *native_context(attached, args.proxy_registry)], check=False)
        if app is not None and app.poll() is None:
            app.send_signal(signal.SIGTERM)
            try:
                app.wait(timeout=30)
            except subprocess.TimeoutExpired:
                print('launcher cleanup timed out; PID ' + str(app.pid), file=sys.stderr)
        for name, container_id in owned.items():
            if inventory().get(name) == container_id:
                command(['docker', 'stop', container_id], check=False)
                command(['docker', 'rm', container_id], check=False)
        if xvfb is not None:
            xvfb.terminate()
            xvfb.wait(timeout=10)
        if server is not None:
            server.shutdown()


def self_test():
    """Negative controls for the harness's ownership and display admission."""
    import unittest
    from unittest.mock import patch

    class Guards(unittest.TestCase):
        def test_failed_owner_keeps_verdict_without_forging_receipt(self):
            import importlib.util
            from types import SimpleNamespace
            spec = importlib.util.spec_from_file_location('probe_failure_backend', ROOT / 'tools/mw_run_backend.py')
            host = importlib.util.module_from_spec(spec)
            sys.path.insert(0, str(ROOT / 'agents'))
            spec.loader.exec_module(host)
            args = SimpleNamespace(site='perplexity', workflow='ask', identity='mv-live-1', slot=[])
            result = SimpleNamespace(rc=5, verdict_code='INPUT_UNCERTAIN', diagnostic='OWNER_FAILURE',
                                     handoff_path=None)
            backend = SimpleNamespace(call=lambda *a: {'mode': 'legacy'}, last_core_refusal='STALE_FRAME')
            owner = SimpleNamespace(run=lambda: result)
            with tempfile.TemporaryDirectory() as directory, \
                 patch.object(host, 'stage_corpus', return_value=(ROOT, 'site_root')), \
                 patch.object(host, 'wait_notice', return_value=time.monotonic_ns()):
                trace = {}
                outcome = host.execute(args, ROOT, Path(directory), backend,
                    corpus_factory=lambda *a: object(), owner_factory=lambda *a, **kw: owner, trace=trace)
                self.assertEqual(outcome, (5, 'INPUT_UNCERTAIN', None))
                self.assertEqual(trace['core_refusal'], 'STALE_FRAME')
                self.assertEqual(trace['diagnostic'], 'OWNER_FAILURE')
                self.assertFalse((Path(directory) / 'memoryweb-run.json').exists())
                real = object.__new__(host.HostBackend)
                real.client = object()
                with patch.object(real, 'ownership'), patch.object(real, 'network_context'), \
                     patch.object(real, 'rebind', return_value={'frame': {'generation': 1}}), \
                     patch.object(host, 'build_proposal', return_value={'based_on_frame': {}}), \
                     patch.object(host.tools, 'propose', side_effect=host.tools.ToolRefusal('STALE_FRAME', None)), \
                     patch.object(host.tools, 'wait_verify') as verify:
                    with self.assertRaisesRegex(host.OwnerRefused, 'MW_STALE_FRAME_EXHAUSTED'):
                        real.propose({'frame': {'generation': 1}, 'ax': []}, {'action': {}, 'expectation': {}}, 100)
                    self.assertEqual(real.last_core_refusal, 'STALE_FRAME')
                    verify.assert_not_called()

                result.rc, result.verdict_code = 0, 'VERIFIED'
                with self.assertRaisesRegex(host.OwnerRefused, 'receipt path absent'):
                    host.execute(args, ROOT, Path(directory), backend,
                        corpus_factory=lambda *a: object(), owner_factory=lambda *a, **kw: owner, trace={})

        def test_measured_position_bounds_and_invalid_mutants(self):
            self.assertEqual(measured_position('120,210'), (120, 210))
            for mutant in ('-1,0', '1600,0', '0,1000', '0,0,0', 'x,y'):
                with self.assertRaises(RuntimeError):
                    measured_position(mutant)

        def test_control_position_rejects_missing_and_ambiguous_labels(self):
            header = 'left\ttop\twidth\theight\ttext\n'
            row = '100\t200\t40\t20\tRelease\n'
            self.assertEqual(control_position(header + row, 'Release'), (120, 210))
            for mutant in (header, header + row + row, header + row.replace('Release', 'Other')):
                with self.assertRaisesRegex(RuntimeError, 'ambiguous/absent'):
                    control_position(mutant, 'Release')

        def test_role_menu_and_emergency_take_positions_reject_mutants(self):
            from types import SimpleNamespace
            header = 'left\ttop\twidth\theight\ttext\n'
            badge = '1200\t90\t36\t14\tagent\n'
            glyph = '1250\t86\t20\t22\t⋮\n'
            self.assertEqual(role_menu_position(header + badge + glyph), (1260, 97))
            self.assertEqual(role_menu_position(header + badge), (1256, 97))
            for mutant in (header, header + badge + badge, header + '1585\t90\t12\t14\tagent\n'):
                with self.assertRaises(RuntimeError):
                    role_menu_position(mutant)
            menu_tsv = (header +
                        '1100\t130\t150\t18\tSwitch\n1255\t130\t60\t18\thuman\n' +
                        '1100\t240\t32\t18\tTake\n1136\t240\t48\t18\tcontrol\n1188\t240\t82\t18\t(emergency)\n')
            self.assertEqual(emergency_take_position(menu_tsv), (1185, 249))
            for mutant in (
                header,
                menu_tsv + '1188\t260\t82\t18\t(emergency)\n',
                header + '1100\t240\t82\t18\t(emergency)\n',
                header + '1100\t240\t32\t18\tTake\n1136\t240\t48\t18\tcontrol\n1188\t240\t82\t18\t(emergency)\n1275\t240\t45\t18\tSwitch\n',
            ):
                with self.assertRaisesRegex(RuntimeError, 'emergency control'):
                    emergency_take_position(mutant)
            with tempfile.TemporaryDirectory() as directory:
                work = Path(directory)
                tsvs = iter([
                    header + '220\t24\t60\t24\tAgents\n',
                    header + badge,
                    menu_tsv,
                    header + '1300\t130\t50\t20\tRelease\n',
                ])
                controls = iter(['human', 'agent'])
                clicks = []
                def fake_command(argv, **kwargs):
                    if argv[0] == 'tesseract':
                        return SimpleNamespace(returncode=0, stdout=next(tsvs), stderr='')
                    if argv[0] == 'xdotool':
                        clicks.append((int(argv[3]), int(argv[4])))
                        return SimpleNamespace(returncode=0, stdout='', stderr='')
                    raise AssertionError(argv)
                class FakeBackend:
                    class tools:
                        @staticmethod
                        def list_surfaces(**_kw):
                            return {'surfaces': [{'surface_id': 'srf-1', 'control': next(controls)}]}
                    @staticmethod
                    def connect(_attached):
                        from contextlib import nullcontext
                        return nullcontext(object())
                args = SimpleNamespace(agents_view_at=None, tile_menu_at=None,
                                       take_control_at=None, release_control_at=None)
                with patch(__name__ + '.command', side_effect=fake_command), \
                     patch(__name__ + '.time.sleep'):
                    self.assertTrue(run_control_cycle(work, ':98', {}, FakeBackend, 'srf-1', args,
                                                      grab=lambda p: p.write_bytes(b'png')))
                self.assertEqual(clicks, [(250, 36), (1256, 97), (1185, 249), (1325, 140)])
                # Negative control: missing menu emergency item aborts before release.
                bad_tsvs = iter([
                    header + '220\t24\t60\t24\tAgents\n',
                    header + badge,
                    header + '1100\t130\t150\t18\tSwitch\n',
                ])
                with patch(__name__ + '.command', side_effect=lambda argv, **kw: (
                        SimpleNamespace(returncode=0, stdout=next(bad_tsvs), stderr='')
                        if argv[0] == 'tesseract' else SimpleNamespace(returncode=0, stdout='', stderr=''))), \
                     patch(__name__ + '.time.sleep'), \
                     self.assertRaisesRegex(RuntimeError, 'emergency control'):
                    run_control_cycle(work, ':98', {}, FakeBackend, 'srf-1', args,
                                      grab=lambda p: p.write_bytes(b'png'))

        def test_launcher_binding_exact_and_ambiguous_mutants(self):
            source = 'env MV_OPERATOR_REPO=/old/admin/path MV_MEMORYWEB_REPO=/keep app'
            self.assertEqual(bind_operator_repo(source, Path('/new/nonascii/ñ path')),
                "env MV_OPERATOR_REPO='/new/nonascii/ñ path' MV_MEMORYWEB_REPO=/keep app")
            for mutant in ('env app', source + ' MV_OPERATOR_REPO=/duplicate'):
                with self.assertRaisesRegex(RuntimeError, 'binding is ambiguous'):
                    bind_operator_repo(mutant, ROOT)

        def test_focus_fixture_changes_only_autofocus(self):
            original = (FIXTURE / 'packaged/home.html').read_bytes()
            focused = (FIXTURE / 'packaged/home_focus.html').read_bytes()
            self.assertEqual(focused.count(b'autofocus'), 1)
            self.assertEqual(focused.replace(b'<textarea autofocus ', b'<textarea '), original)
            self.assertNotEqual(focused, original)
            with patch(__name__ + '.command') as run:
                copy_fixture('srf-id-owned', '/tmp/mv-e1-probe-test', 'home_focus')
                self.assertIn('autofocus', run.call_args_list[1].kwargs['input'])
            with patch(__name__ + '.command') as run, self.assertRaises(RuntimeError):
                copy_fixture('srf-id-owned', '/tmp/mv-e1-probe-test', '../foreign')
            run.assert_not_called()

        def test_fixture_charset_and_removed_declaration_mutant(self):
            for path in (FIXTURE / 'packaged').glob('*.html'):
                raw = path.read_bytes()
                self.assertTrue(check_fixture_encoding(raw))
                mutant = raw.replace(b'<meta charset="utf-8">', b'')
                with self.assertRaisesRegex(RuntimeError, 'must declare UTF-8'):
                    check_fixture_encoding(mutant)

        def test_fixture_copy_only_public_files_and_protected_mutants(self):
            with patch(__name__ + '.command') as run:
                self.assertTrue(copy_fixture('srf-id-owned', '/tmp/mv-e1-probe-test'))
                self.assertEqual(run.call_count, 4)
                for call in run.call_args_list[1:]:
                    self.assertEqual(call.args[0][:4], ['docker', 'exec', '-i', 'srf-id-owned'])
                    self.assertIn('<meta charset="utf-8">', call.kwargs['input'])
            for capsule, destination in (('srf-id-cuentas-1', '/tmp/mv-e1-probe-test'),
                                         ('srf-id-owned', '/profile'),
                                         ('srf-id-owned', '/tmp/mv-e1-probe-../profile')):
                with patch(__name__ + '.command') as run, self.assertRaises(RuntimeError):
                    copy_fixture(capsule, destination)
                run.assert_not_called()

        def test_probe_continues_after_failure_without_erasing_it(self):
            with tempfile.TemporaryDirectory() as directory:
                stages = ProbeStages(Path(directory))
                def fail():
                    raise RuntimeError('negative control')
                self.assertIsNone(stages.run('broken', fail))
                self.assertEqual(stages.run('later', lambda: 42, forced=True), 42)
                rows = [json.loads(row) for row in stages.path.read_text().splitlines()]
                self.assertEqual([row['status'] for row in rows], ['FAIL', 'PASS'])
                self.assertTrue(rows[1]['forced'])
                self.assertTrue(stages.failed)

        def test_probe_wrapper_compiles_and_preserves_entry(self):
            with tempfile.TemporaryDirectory() as directory:
                path = probe_entry(Path(directory), ROOT)
                compile(path.read_text(), str(path), 'exec')
                self.assertIn('main(runner=host.run_entry)', path.read_text())
                self.assertIn('raise', path.read_text())

        def test_native_ax_uses_discovered_context_without_mutating_caller(self):
            import importlib.util
            from types import SimpleNamespace
            spec = importlib.util.spec_from_file_location('rehearsal_context_backend', ROOT / 'tools/mw_run_backend.py')
            host = importlib.util.module_from_spec(spec)
            sys.path.insert(0, str(ROOT / 'agents'))
            spec.loader.exec_module(host)
            values = dict(MV_CORE_CONFIG='/opaque/core.json', XDG_RUNTIME_DIR='/opaque/runtime',
                          MV_SRF_BIN_DIR='/opaque/bin', MV_SRF_STATE_DIR='/opaque/state',
                          SRF_IDENTITY_STORE_ROOT='/opaque/store', SRF_PROXY_REGISTRY='/opaque/registry')
            with patch.dict(os.environ, {}, clear=True), \
                 patch.object(host.HostBackend, 'ownership'), \
                 patch('metaviewer_agents.perception.deps_lock.resolve_locked_component', return_value=ROOT):
                merged, basis = host.attach_env({}, discover=lambda: values)
                backend = host.HostBackend(SimpleNamespace(host_env=merged), 'mv-live-1', ROOT, {})
                with patch.object(host, 'command', return_value=SimpleNamespace(returncode=0, stdout=b'{}')) as run:
                    backend.native(backend.binary, ['ax'])
                context = run.call_args.kwargs['env']
                self.assertEqual(basis, 'discovered')
                for key in ('SRF_IDENTITY_STORE_ROOT', 'SRF_PROXY_REGISTRY'):
                    self.assertEqual(context[key], values[key])
                    self.assertNotIn(key, os.environ)
                with self.assertRaisesRegex(host.OwnerRefused, 'differs from the running app'):
                    host.attach_env({'SRF_PROXY_REGISTRY': '/foreign/registry'}, discover=lambda: values)

        def test_native_context_is_explicit_and_rejects_relative_paths(self):
            self.assertEqual(native_context({'SRF_IDENTITY_STORE_ROOT': '/opaque/store'},
                                           Path('/opaque/registry.json')),
                             ['--store-root', '/opaque/store', '--registry', '/opaque/registry.json'])
            for store, registry in (('relative', '/opaque/registry'), ('/opaque/store', 'relative')):
                with self.assertRaisesRegex(RuntimeError, 'paths must be absolute'):
                    native_context({'SRF_IDENTITY_STORE_ROOT': store}, Path(registry))

        def test_process_ownership_and_foreign_mutant(self):
            with tempfile.TemporaryDirectory() as directory:
                proc = Path(directory)
                for pid, parent in ((40, 30), (30, 20), (20, 1), (50, 1)):
                    (proc / str(pid)).mkdir()
                    (proc / str(pid) / 'stat').write_text(f'{pid} (adapter) S {parent} 0\n')
                self.assertTrue(descendant(40, 20, proc))
                self.assertFalse(descendant(50, 20, proc))
                self.assertFalse(descendant(41, 20, proc))

        def test_protected_capsules_never_admitted(self):
            self.assertTrue(safe_capsule('srf-id-opaque-owned'))
            for name in ('srf-id-cuentas-1', 'srf-id-perplexity-1', 'srf-pg-any',
                         'srf-egress-proxy', 'n8n', 'distil-box'):
                self.assertFalse(safe_capsule(name))

        def test_capsule_admission_rejects_foreign_container(self):
            with patch(__name__ + '.inventory', return_value={'srf-id-foreign': 'foreign-id'}):
                with self.assertRaisesRegex(RuntimeError, 'capsule admission timed out'):
                    wait_empty(0)
            with patch(__name__ + '.inventory', return_value={'srf-egress-proxy': 'proxy-id'}):
                wait_empty(0)

        def test_display_oracle_rejects_receipt_only_and_missing_controls(self):
            self.assertTrue(notice_visible('Login required: sign in yourself Take control Acknowledge'))
            for mutant in ('HUMAN_HANDOFF', 'Login required Take control', 'Acknowledge Take control'):
                self.assertFalse(notice_visible(mutant))

        def test_fixture_copy_is_private_and_source_unchanged(self):
            source = (FIXTURE / 'site/site.json').read_bytes()
            with tempfile.TemporaryDirectory() as directory:
                home = stage_home(Path(directory), 'http://127.0.0.1:12345')
                self.assertEqual(home.stat().st_mode & 0o777, 0o700)
                site = json.loads((home / 'sites/perplexity/site.json').read_text())
                self.assertEqual(site['domains'], ['127.0.0.1'])
                self.assertEqual(site['execution_policy']['min_notice_s'], 10)
            self.assertEqual((FIXTURE / 'site/site.json').read_bytes(), source)

        def test_success_oracle_rejects_bad_receipt_answer_and_missing_notice(self):
            from types import SimpleNamespace
            with tempfile.TemporaryDirectory() as directory:
                work = Path(directory)
                answer = work / 'answer.txt'
                answer.write_text(ANSWER)
                report = work / 'report.json'
                report.write_text(json.dumps(dict(attach='discovered', answer=dict(captured=True, path=str(answer)))))
                receipt = work / 'memoryweb-run.json'
                summary = dict(rc=0, verdict_code='VERIFIED', steps_total=3, steps_verified=3,
                               steps_failed=0, steps_skipped_satisfied=0)
                receipt.write_text(json.dumps(summary))
                value = dict(schema='metaviewer.mw_run/v1', rc=0, verdict_code='VERIFIED',
                             receipt=str(receipt), report=str(report))
                result = SimpleNamespace(returncode=0, stdout=json.dumps(value),
                                         stderr='in 10 s; interrupt now to cancel')
                validate_run(result, (0, 'VERIFIED'))
                answer.write_text('mutated answer')
                with self.assertRaisesRegex(RuntimeError, 'answer capture mismatch'):
                    validate_run(result, (0, 'VERIFIED'))
                answer.write_text(ANSWER)
                receipt.write_text(json.dumps(dict(summary, steps_verified=2, steps_failed=1)))
                with self.assertRaisesRegex(RuntimeError, 'steps not verified'):
                    validate_run(result, (0, 'VERIFIED'))
                receipt.write_text(json.dumps(summary))
                result.stderr = ''
                with self.assertRaisesRegex(RuntimeError, 'countdown absent'):
                    validate_run(result, (0, 'VERIFIED'))

    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Guards))
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    try:
        sys.exit(self_test() if sys.argv[1:] == ['--self-test'] else main())
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print('BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
