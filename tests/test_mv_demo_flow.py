"""DEMO-FLOW: operator Start -> gesture -> Stop -> Copy prompt -> Check site; no capsule or network.

The keysym names below are the raw libX11 XKeysymToString results that the
OpenSuperficies recorder writes (surface/record.go, level 0 keysym) [CITED]; they
are listed statically so hosted runs need no X libraries.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('mv_demo_flow_target', ROOT / 'tools/mv_demo.py')
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)

# (keysym, modifiers) pairs a real operator produces and the exporter must accept.
ACCEPTED_KEYS = [
    ('Prior', []), ('Next', []), ('Page_Up', []), ('Page_Down', []), ('Home', []), ('End', []),
    ('KP_Enter', []), ('Print', []), ('Menu', []), ('Pause', []), ('ISO_Left_Tab', ['shift']),
    ('F12', []), ('XF86AudioRaiseVolume', []), ('unknown', []),
    ('space', ['ctrl']), ('comma', ['ctrl']), ('minus', ['ctrl', 'shift']), ('equal', ['ctrl']),
    ('slash', ['super']), ('bracketleft', ['alt']), ('a', ['ctrl']), ('Return', ['ctrl']),
]
# Character-bearing or digit-ambiguous names: the recorder reads level 0, so the
# numeric keypad arrives as KP_End (1), KP_Down (2) ... and must never be exported.
REFUSED_KEYS = [
    ('KP_End', []), ('KP_Down', []), ('KP_Next', []), ('KP_Left', []), ('KP_Begin', []),
    ('KP_Right', []), ('KP_Home', []), ('KP_Up', []), ('KP_Prior', []), ('KP_Insert', []),
    ('KP_Delete', []), ('KP_Add', []), ('KP_Subtract', []), ('KP_Multiply', []), ('KP_Divide', []),
    ('space', []), ('comma', ['shift']), ('a', []), ('a', ['shift']), ('eacute', ['ctrl']),
    ('Cyrillic_a', ['ctrl']), ('XF86', []), ('XF86' + 'a' * 41, []), ('Prior ', []), ('NEVER-EXPORT', []),
]



def _signal_own_group(pid, sig):
    """Signal only the detached child's own process group, never ours (kill guard)."""
    if type(pid) is not int or pid <= 1 or os.getpgid(pid) == os.getpgid(0):
        raise AssertionError('refusing to signal pid %r' % (pid,))
    os.killpg(os.getpgid(pid), sig)

class deadline:
    """Fail instead of hang when code under test blocks (for example on a FIFO)."""
    def __init__(self, seconds):
        self.seconds = seconds

    def __enter__(self):
        signal.signal(signal.SIGALRM, self.expired)
        signal.alarm(self.seconds)

    def __exit__(self, *exc):
        signal.alarm(0)

    @staticmethod
    def expired(*_):
        raise AssertionError('blocked past the deadline')


def line(**row):
    return json.dumps(row, separators=(',', ':')).encode() + b'\n'


class FlowBase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'ram' / 'demo-1'
        self.source.mkdir(parents=True, mode=0o700)
        self.destination = self.root / 'saved'
        self.env = patch.dict(os.environ, {'XDG_STATE_HOME': str(self.root / 'state')})
        self.env.start()
        self.addCleanup(self.env.stop)

    def seal(self, rows, frames=('final.png',)):
        (self.source / 'events.jsonl').write_bytes(b''.join(line(**r) for r in rows))
        (self.source / 'README.md').write_text('secret-in-untrusted-readme')
        for name in frames:
            (self.source / name).write_bytes(b'frame ' + name.encode())

    def stop(self, seq):
        return dict(seq=seq, mono_ns=seq, window='', kind='stop', modifiers=[], reason='operator')

    def key(self, keysym, modifiers=(), seq=1, **extra):
        return dict(seq=seq, mono_ns=seq, window='w1', kind='key', keysym=keysym,
                    modifiers=list(modifiers), **extra)


class RecorderVocabulary(FlowBase):
    def test_real_keys_export_and_character_bearing_names_refuse(self):
        for keysym, modifiers in ACCEPTED_KEYS:
            with self.subTest(accept=keysym, modifiers=modifiers):
                demo.validate_events(line(**self.key(keysym, modifiers)) + line(**self.stop(2)))
        for keysym, modifiers in REFUSED_KEYS:
            with self.subTest(refuse=keysym, modifiers=modifiers):
                with self.assertRaises(demo.Refused):
                    demo.validate_events(line(**self.key(keysym, modifiers)) + line(**self.stop(2)))

    def test_page_down_recording_exports_end_to_end(self):
        self.seal([self.key('Prior'), self.key('Next', seq=2), self.stop(3)])
        receipt = demo.export_demo(self.source, self.destination)
        exported = (self.destination / 'events.jsonl').read_bytes()
        self.assertIn(b'"keysym":"Prior"', exported)
        self.assertEqual(hashlib.sha256(exported).hexdigest(), receipt['sha256']['events.jsonl'])

    def test_keypad_digit_stream_never_exports(self):
        self.seal([self.key('KP_End'), self.key('KP_Down', seq=2), self.stop(3)])
        with self.assertRaises(demo.Refused):
            demo.export_demo(self.source, self.destination)
        self.assertFalse(self.destination.exists())


class FinalAndFrames(FlowBase):
    def test_multi_window_final_frames_export_and_prompt_digests(self):
        self.seal([self.key('Return'), self.stop(2)], frames=('final_w1.png', 'final_w2.png'))
        receipt = demo.export_demo(self.source, self.destination)
        self.assertEqual(sorted(receipt['sha256']),
                         ['README.md', 'events.jsonl', 'final_w1.png', 'final_w2.png'])
        self.assertTrue(demo.known_name('final_w12.png'))

    def test_final_frame_names_are_closed(self):
        for name in ('final_wx.png', 'final_w1.png.bak', 'final-w1.png', 'finalw1.png', 'Final.png', '001_final.png'):
            with self.subTest(name=name):
                self.assertFalse(demo.known_name(name))
        self.seal([self.key('Return'), self.stop(2)], frames=('final.png', 'final_wx.png'))
        with self.assertRaises(demo.Refused):
            demo.export_demo(self.source, self.destination)

    def test_recording_without_any_final_frame_is_unsealed(self):
        self.seal([self.key('Return'), self.stop(2)], frames=())
        with self.assertRaises(demo.Refused):
            demo.export_demo(self.source, self.destination)
        self.assertFalse(self.destination.exists())

    def test_failed_after_capture_drops_only_the_dangling_reference(self):
        first = self.key('Return', before='001_before.png', after='001_after.png')
        second = self.key('Tab', seq=2, before='002_before.png', after='002_after.png')
        self.seal([first, second, self.stop(3)],
                  frames=('final.png', '001_before.png', '002_before.png', '002_after.png'))
        raw = (self.source / 'events.jsonl').read_bytes()
        receipt = demo.export_demo(self.source, self.destination)
        exported = (self.destination / 'events.jsonl').read_bytes().splitlines(keepends=True)
        original = raw.splitlines(keepends=True)
        rows = [json.loads(x) for x in exported]
        self.assertEqual(rows[0]['before'], '001_before.png')
        self.assertNotIn('after', rows[0])
        self.assertEqual(exported[1:], original[1:], 'untouched rows keep their exact bytes')
        self.assertEqual(sorted(receipt['sha256']), sorted(p.name for p in self.destination.iterdir() if p.name != 'digests.json'))
        self.assertNotIn('001_after.png', receipt['sha256'])

    def test_complete_recording_events_are_byte_identical(self):
        row = self.key('Return', before='001_before.png', after='001_after.png')
        self.seal([row, self.stop(2)], frames=('final.png', '001_before.png', '001_after.png'))
        raw = (self.source / 'events.jsonl').read_bytes()
        demo.export_demo(self.source, self.destination)
        self.assertEqual((self.destination / 'events.jsonl').read_bytes(), raw)

    def test_malformed_frame_reference_still_refuses(self):
        for bad in ('../001_after.png', '001_after.png.bak', 'final.png', '/etc/passwd'):
            with self.subTest(bad=bad):
                self.seal([self.key('Return', after=bad), self.stop(2)])
                with self.assertRaises(demo.Refused):
                    demo.export_demo(self.source, self.destination)
                self.assertFalse(self.destination.exists())


class RecordFlow(FlowBase):
    def record_env(self):
        store = self.root / 'store'
        (store / 'locks').mkdir(parents=True)
        store.chmod(0o700)
        lease = store / 'locks/example.json'
        lease.write_text(json.dumps({'active': True, 'holder': 'srf-id-example'}))
        lease.chmod(0o600)
        state = self.root / 'native-state'
        state.mkdir(mode=0o700)
        bins = self.root / 'bin'
        bins.mkdir()
        return {'SRF_IDENTITY_STORE_ROOT': str(store), 'MV_SRF_BIN_DIR': str(bins),
                'MV_SRF_STATE_DIR': str(state)}

    def run_record(self, rows, frames=('final.png',)):
        self.seal(rows, frames)
        ram = self.root / 'record-ram'
        ram.mkdir()
        child = unittest.mock.MagicMock()
        child.stdout.readline.return_value = b'{"url":"http://127.0.0.1:1234/"}\n'
        child.wait.return_value = 0
        child.poll.return_value = 0

        def spawn(argv, **kwargs):
            import shutil
            shutil.copytree(self.source, ram / 'demo-1')
            return child
        with patch.dict(os.environ, self.record_env()), \
                patch.object(demo.identity.Identities, 'show'), \
                patch.object(demo, 'RAM', ram), \
                patch.object(demo.subprocess, 'Popen', side_effect=spawn), \
                contextlib.redirect_stdout(io.StringIO()):
            try:
                return demo.record('example', 'demo-1'), ram
            except demo.Refused:
                return None, ram

    def test_sealed_export_removes_the_ram_copy(self):
        result, ram = self.run_record([self.key('Prior'), self.stop(2)])
        self.assertTrue(Path(result['evidence']).is_dir())
        self.assertFalse((ram / 'demo-1').exists(), 'private frames do not linger in RAM')
        self.assertTrue(self.source.is_dir(), 'only the sealed RAM copy is removed')

    def test_refused_export_keeps_the_ram_copy(self):
        result, ram = self.run_record([self.key('KP_End'), self.stop(2)])
        self.assertIsNone(result)
        self.assertTrue((ram / 'demo-1' / 'events.jsonl').is_file())
        self.assertFalse((self.root / 'state/metaviewer/demos/demo-1').exists())

    def test_discard_ram_never_follows_a_link(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('keep')
        link = self.root / 'ram' / 'link'
        link.symlink_to(outside, target_is_directory=True)
        demo.discard_ram(link)
        self.assertEqual((outside / 'keep').read_text(), 'keep')
        self.assertTrue(link.is_symlink())

    def test_stop_signal_to_the_tool_group_seals_and_exports(self):
        env_extra = self.record_env()
        bins = Path(env_extra['MV_SRF_BIN_DIR'])
        ram = self.root / 'native-ram'
        ram.mkdir(mode=0o700)
        native = bins / 'srf-identity-surface'
        native.write_text(textwrap.dedent('''\
            #!/bin/bash
            d="$FAKE_RAM/demo-1"
            mkdir -m 700 "$d" || exit 4
            printf '%s\\n' '{"url":"http://127.0.0.1:1/","native":"n","socket":"s"}'
            seal() {
              printf '%s\\n' '{"seq":1,"mono_ns":1,"window":"w1","kind":"key","keysym":"Prior","modifiers":[],"before":"001_before.png","after":"001_after.png"}' \\
                '{"seq":2,"mono_ns":2,"window":"","kind":"stop","reason":"operator","modifiers":[]}' > "$d/events.jsonl"
              echo secret-readme > "$d/README.md"; echo png > "$d/final.png"; echo png > "$d/001_before.png"
            }
            trap 'sleep 0.3; seal; exit 0' INT
            while :; do sleep 0.05; done
            '''))
        native.chmod(0o700)
        harness = self.root / 'harness.py'
        harness.write_text(textwrap.dedent('''\
            import importlib.util, sys
            from pathlib import Path
            from unittest.mock import patch
            spec = importlib.util.spec_from_file_location('mv_demo', Path(sys.argv[1]) / 'tools/mv_demo.py')
            demo = importlib.util.module_from_spec(spec); spec.loader.exec_module(demo)
            demo.RAM = Path(sys.argv[2])
            with patch.object(demo.identity.Identities, 'show'):
                sys.exit(demo.main(['record', '--identity', 'example', '--demo', 'demo-1']))
            '''))
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(self.root),
               'XDG_STATE_HOME': str(self.root / 'state'), 'FAKE_RAM': str(ram), **env_extra}
        # The host spawns the tool detached (own process group) and signals that group on Stop.
        child = subprocess.Popen([sys.executable, str(harness), str(ROOT), str(ram)], env=env,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True)
        self.addCleanup(lambda: child.poll() is None and child.kill())
        announce = json.loads(child.stdout.readline())
        self.assertEqual(announce, {'url': 'http://127.0.0.1:1/'})
        _signal_own_group(child.pid, signal.SIGINT)
        out, err = child.communicate(timeout=60)
        self.assertEqual(child.returncode, 0, err.decode()[-2000:])
        reply = json.loads(out.decode().strip().splitlines()[-1])
        self.assertTrue(reply['ok'])
        evidence = Path(reply['result']['evidence'])
        self.assertEqual(evidence, self.root / 'state/metaviewer/demos/demo-1')
        self.assertEqual(evidence.stat().st_mode & 0o777, 0o700)
        rows = [json.loads(x) for x in (evidence / 'events.jsonl').read_text().splitlines()]
        self.assertEqual(rows[0]['keysym'], 'Prior')
        self.assertNotIn('after', rows[0], 'the frame the recorder never wrote is not referenced')
        self.assertNotIn('secret', (evidence / 'README.md').read_text())
        for name, digest in reply['result']['sha256'].items():
            self.assertEqual(hashlib.sha256((evidence / name).read_bytes()).hexdigest(), digest)
            self.assertEqual((evidence / name).stat().st_mode & 0o777, 0o600)
        self.assertFalse((ram / 'demo-1').exists())


class CheckSite(FlowBase):
    def checkout(self):
        checkout = self.root / 'checkout'
        (checkout / 'tools').mkdir(parents=True)
        (checkout / 'sites').mkdir()
        (checkout / 'sites/README.md').write_text('Hosted folder contract')
        (checkout / 'templates/site').mkdir(parents=True)
        (checkout / 'standards/schemas').mkdir(parents=True)
        (checkout / 'standards/schemas/mw.v1.schema.json').write_text('{}')
        (checkout / 'tools/build_index.py').write_text(
            "import pathlib, sys\nroot = pathlib.Path(sys.argv[sys.argv.index('--root')+1])\n"
            "site = root / 'sites/example'\n"
            "if not (site / 'site.json').is_file(): sys.exit(1)\n"
            "index = root / 'index'\n"
            "if '--check' in sys.argv: sys.exit(0 if index.read_text() == 'built' else 1)\n"
            "index.write_text('built')\n")
        home = self.root / 'home'
        (home / 'sites/example').mkdir(parents=True)
        (home / 'sites/example/site.json').write_text('valid')
        return checkout, home

    def run_check(self, checkout, home):
        with patch.dict(os.environ, {'MV_MEMORYWEB_REPO': str(checkout)}), \
                patch.object(demo, 'admitted_home', return_value=home), \
                patch.object(demo.subprocess, 'run', wraps=demo.subprocess.run) as run, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            code = demo.main(['check', '--site', 'example'])
        return code, json.loads(output.getvalue()), run

    def test_authored_site_validates_and_names_its_source(self):
        checkout, home = self.checkout()
        (home / 'sites/example/nodes').mkdir()
        (home / 'sites/example/nodes/a.json').write_text('{}')
        code, reply, _ = self.run_check(checkout, home)
        self.assertEqual(code, 0)
        self.assertEqual(reply['result'], {'site': 'example', 'validated': True, 'source': 'home'})

    def test_builtin_fallback_is_labelled_not_passed_off_as_authored(self):
        checkout, home = self.checkout()
        (checkout / 'tools/build_index.py').write_text('')
        home = self.root / 'empty-home'
        home.mkdir()
        with patch.dict(os.environ, {'MV_MEMORYWEB_REPO': str(checkout)}), \
                patch.object(demo, 'admitted_home', return_value=home):
            self.assertEqual(demo.check('meta-ai')['source'], 'builtin')

    def test_symlinks_in_an_authored_site_refuse_before_any_copy_or_build(self):
        checkout, home = self.checkout()
        secret = self.root / 'secret.txt'
        secret.write_text('operator-private')
        site = home / 'sites/example'
        for make in (lambda: (site / 'leak.json').symlink_to(secret),
                     lambda: (site / 'dir-link').symlink_to(self.root, target_is_directory=True),
                     lambda: (site / 'dangling').symlink_to(self.root / 'absent')):
            with self.subTest(make=make):
                make()
                code, reply, run = self.run_check(checkout, home)
                self.assertEqual(code, 6)
                self.assertEqual(reply['error'], 'DEMO_REFUSED')
                run.assert_not_called()
                for link in [p for p in site.iterdir() if p.is_symlink()]:
                    link.unlink()
        code, reply, _ = self.run_check(checkout, home)
        self.assertEqual(code, 0, 'a clean site passes once the links are gone')

    def test_nested_symlink_refuses(self):
        checkout, home = self.checkout()
        nested = home / 'sites/example/nodes/deep'
        nested.mkdir(parents=True)
        (nested / 'x.json').symlink_to(home / 'sites/example/site.json')
        code, reply, run = self.run_check(checkout, home)
        self.assertEqual(code, 6)
        run.assert_not_called()

    def test_special_files_refuse_without_blocking(self):
        checkout, home = self.checkout()
        os.mkfifo(home / 'sites/example/pipe')
        with deadline(10):
            code, reply, run = self.run_check(checkout, home)
        self.assertEqual(code, 6)
        run.assert_not_called()

    def test_site_tree_is_bounded(self):
        checkout, home = self.checkout()
        site = home / 'sites/example'
        for index in range(5):
            (site / f'n{index}.json').write_text('x' * 10)
        for name, value in (('SITE_FILES', 3), ('SITE_BYTES', 20)):
            with self.subTest(limit=name), patch.object(demo, name, value):
                code, reply, run = self.run_check(checkout, home)
                self.assertEqual(code, 6)
                run.assert_not_called()
        deep = site
        for index in range(demo.SITE_DEPTH + 2):
            deep = deep / f'd{index}'
        deep.mkdir(parents=True)
        code, reply, run = self.run_check(checkout, home)
        self.assertEqual(code, 6)
        run.assert_not_called()

    def test_copy_keeps_authored_bytes_for_the_builder(self):
        checkout, home = self.checkout()
        (home / 'sites/example/site.json').write_bytes(b'valid\n\x00bytes')
        (checkout / 'tools/build_index.py').write_text(
            "import pathlib, sys\nroot = pathlib.Path(sys.argv[sys.argv.index('--root')+1])\n"
            "sys.exit(0 if (root / 'sites/example/site.json').read_bytes() == b'valid\\n\\x00bytes' else 1)\n")
        code, _, _ = self.run_check(checkout, home)
        self.assertEqual(code, 0)


class PackagedEnvironment(FlowBase):
    def scrubbed(self):
        return {'PATH': '/usr/bin:/bin', 'HOME': str(self.root), 'LANG': 'C.UTF-8'}

    def test_check_from_a_scrubbed_environment_answers_json_without_a_traceback(self):
        result = subprocess.run([sys.executable, str(ROOT / 'tools/mv_demo.py'), 'check', '--site', 'no-such-site'],
                                env=self.scrubbed(), cwd=self.root, stdin=subprocess.DEVNULL,
                                capture_output=True, timeout=60, check=False)
        self.assertEqual(result.returncode, 6, result.stderr.decode()[-2000:])
        self.assertEqual(json.loads(result.stdout), {'schema': 'metaviewer.demo/v1', 'ok': False, 'error': 'DEMO_REFUSED'})
        self.assertEqual(result.stderr, b'')

    def test_agents_package_resolves_without_pythonpath(self):
        code = ("import importlib.util\n"
                f"spec = importlib.util.spec_from_file_location('m', {str(ROOT / 'tools/mv_demo.py')!r})\n"
                "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n"
                "from metaviewer_agents.mw_home import site_root\n")
        result = subprocess.run([sys.executable, '-c', code], env=self.scrubbed(), cwd=self.root,
                                capture_output=True, timeout=60, check=False)
        self.assertEqual(result.returncode, 0, result.stderr.decode()[-2000:])


if __name__ == '__main__':
    unittest.main()
