#!/usr/bin/env python3
"""Offline E1 rehearsal against an operator-supplied packaged app.

[TARGET, unit decision] Paths are explicit arguments, never host defaults.
The packaged UI auto-creates its first capsule. Native input is used only to
set up the local page; the workflow runs as an unmodified external CLI process.
Logs, copied site data and output are retained in a private temporary directory.
No identity-store or browser-profile files are opened by this driver.
"""
import argparse
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
        require((receipt['steps_total'], receipt['steps_verified'], receipt['steps_failed']) == (3, 3, 0),
                'workflow steps not verified')
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


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--launcher', type=Path, required=True)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--operator-repo', type=Path, required=True)
    parser.add_argument('--wender-root', type=Path, required=True)
    parser.add_argument('--proxy-registry', type=Path, required=True)
    parser.add_argument('--fixture-host', required=True, help='local host address reachable from the capsule')
    parser.add_argument('--display', default=':98')
    parser.add_argument('--admission-timeout', type=int, default=600)
    args = parser.parse_args(argv)
    work = Path(tempfile.mkdtemp(prefix='mv-e1-packaged-'))
    print('EVIDENCE ' + str(work), flush=True)
    xvfb = app = server = None
    owned = {}
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
        app = subprocess.Popen(['bash', str(args.launcher), str(args.run_dir)], env=env,
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

        caller = {k: v for k, v in env.items() if k not in backend.ATTACH_KEYS and k != 'MV_AGENT_INSTANCE'}
        caller.update(MV_MW_HOME=str(home))
        # Use the app's ordinary evidence location so its real handoff watcher sees the run.
        caller.pop('XDG_STATE_HOME', None)
        preflight = command([sys.executable, args.operator_repo / 'tools/mw_home_check.py', '--repo',
                             args.operator_repo, '--home', home, '--workflow', 'perplexity/ask'], env=caller)
        require(json.loads(preflight.stdout)['ok'], 'home preflight refused')
        for page, expected in (('home', (0, 'VERIFIED')), ('login', (4, 'HUMAN_HANDOFF'))):
            navigate(page)
            if page == 'login':
                require(not notice_visible(screenshot_text(work, args.display, 'before-login')),
                        'a pre-existing login notice would invalidate the display oracle')
            result = command([sys.executable, '-m', 'metaviewer_agents.mw_run', '--identity', 'mv-live-1',
                              '--site', 'perplexity', '--workflow', 'ask', '--slot',
                              'prompt=What is the capital of France? Ω'], cwd=args.operator_repo / 'agents',
                              env=caller, check=False, timeout=210)
            (work / (page + '.stdout')).write_text(result.stdout)
            (work / (page + '.stderr')).write_text(result.stderr)
            print(result.stderr, end='', flush=True)
            print(result.stdout, end='', flush=True)
            validate_run(result, expected)
            if page == 'login':
                # A screenshot of our Xvfb display proves a new notice, independently of the JSON.
                wait_for(lambda: notice_visible(screenshot_text(work, args.display, 'login-notice')),
                         20, 'login handoff notice absent from the packaged UI')
        print('PASS packaged E1 answer and human handoff', flush=True)
        return 0
    finally:
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
                summary = dict(rc=0, verdict_code='VERIFIED', steps_total=3, steps_verified=3, steps_failed=0)
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
