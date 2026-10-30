"""Hosted demonstration custody tests; no capsule or network."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('mv_demo', ROOT / 'tools/mv_demo.py')
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


class DemoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'ram' / 'demo'
        self.source.mkdir(parents=True, mode=0o700)
        self.rows = [dict(seq=1, mono_ns=1, window='w1', kind='text',
                          text_len=7, modifiers=[]),
                     dict(seq=2, mono_ns=2, window='', kind='stop',
                          reason='operator', modifiers=[])]
        self.write_recording()
        self.destination = self.root / 'saved'
        self.env = patch.dict(os.environ, {'XDG_STATE_HOME': str(self.root / 'state')})
        self.env.start()
        self.addCleanup(self.env.stop)

    def write_recording(self):
        (self.source / 'events.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in self.rows))
        (self.source / 'README.md').write_text('secret-in-untrusted-readme')
        (self.source / 'final.png').write_bytes(b'hosted fake frame')

    def test_export_private_digests_and_length_only(self):
        receipt = demo.export_demo(self.source, self.destination)
        self.assertEqual(self.destination.stat().st_mode & 0o777, 0o700)
        for name, digest in receipt['sha256'].items():
            path = self.destination / name
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)
        self.assertNotIn('secret', (self.destination / 'README.md').read_text())
        self.assertEqual(json.loads((self.destination / 'events.jsonl').read_text().splitlines()[0])['text_len'], 7)

    def test_mut_text_leak(self):
        for key in ('text', 'char', 'characters', 'value'):
            with self.subTest(key=key):
                self.rows[0][key] = 'NEVER-EXPORT'
                self.write_recording()
                with self.assertRaises(demo.Refused):
                    demo.export_demo(self.source, self.destination)
                self.assertFalse(self.destination.exists())
                del self.rows[0][key]
        self.rows[0].update(kind='key', keysym='a')
        del self.rows[0]['text_len']
        self.write_recording()
        with self.assertRaises(demo.Refused):
            demo.export_demo(self.source, self.destination)

    def test_duplicate_key_cannot_hide_recorded_characters(self):
        raw = (b'{"seq":1,"mono_ns":1,"window":"w1","kind":"key",'
               b'"keysym":"NEVER-EXPORT","keysym":"Return","modifiers":[]}\n'
               + json.dumps(self.rows[-1]).encode() + b'\n')
        (self.source / 'events.jsonl').write_bytes(raw)
        with self.assertRaises(demo.Refused):
            demo.export_demo(self.source, self.destination)
        self.assertFalse(self.destination.exists())

    def test_unsealed_and_profile_and_symlink_refuse(self):
        for name in ('Cookies', 'Login Data-journal'):
            bad = self.source / name
            bad.write_text('secret')
            with self.assertRaises(demo.Refused):
                demo.export_demo(self.source, self.destination)
            bad.unlink()
        (self.source / 'final.png').unlink()
        (self.source / 'final.png').symlink_to(self.source / 'README.md')
        with self.assertRaises(OSError):
            demo.export_demo(self.source, self.destination)
        (self.source / 'final.png').unlink()
        self.rows.pop()
        self.write_recording()
        with self.assertRaises(demo.Refused):
            demo.export_demo(self.source, self.destination)

    def test_mut_argv_before_spawn(self):
        with self.record_context(), patch.object(demo.identity.Identities, 'show') as show, \
                patch.object(demo, 'RAM', self.root / 'unused'), \
                patch.object(demo, 'refuse_net_argv') as guard, \
                patch.object(demo.subprocess, 'run') as run, \
                patch.object(demo.subprocess, 'Popen') as spawn, \
                contextlib.redirect_stdout(io.StringIO()):
            for value in ('ok;touch bad', 'ok extra', '../ok', 'ok\nnet', '$(id)', '-oops'):
                self.assertEqual(demo.main(['record', '--identity', value, '--demo', 'demo']), 6)
                self.assertEqual(demo.main(['record', '--identity', 'example', '--demo', value]), 6)
                show.assert_not_called()
                guard.assert_not_called()
                spawn.assert_not_called()
                run.assert_not_called()
            self.assertEqual(demo.main(['record', '--identity', 'example', '--demo', 'demo', 'extra']), 6)
            self.assertEqual(demo.main(['record', '--identity', 'example', '--demo=-oops']), 6)
            self.assertEqual(demo.main(['net']), 6)
            show.assert_not_called()
            guard.assert_not_called()
            spawn.assert_not_called()
            run.assert_not_called()

    def test_mut_prompt_and_check_ids(self):
        with patch.object(demo, 'admitted_home') as home, \
                patch.object(demo.subprocess, 'run') as run, \
                patch.object(demo.subprocess, 'Popen') as spawn, \
                contextlib.redirect_stdout(io.StringIO()):
            for value in ('ok;touch bad', 'ok extra', '../ok', 'ok\nnet', '$(id)', '-oops'):
                for argv in (['prompt', '--demo=' + value, '--site', 'example'],
                             ['prompt', '--demo', 'demo', '--site=' + value],
                             ['check', '--site=' + value]):
                    with self.subTest(argv=argv):
                        self.assertEqual(demo.main(argv), 6)
                        home.assert_not_called()
                        run.assert_not_called()
                        spawn.assert_not_called()

    def record_context(self):
        store = self.root / 'store'
        (store / 'locks').mkdir(parents=True)
        store.chmod(0o700)
        lease = store / 'locks/example.json'
        lease.write_text(json.dumps({'active': True, 'holder': 'srf-id-example'}))
        lease.chmod(0o600)
        state = self.root / 'native-state'
        state.mkdir(mode=0o700)
        return patch.dict(os.environ, {'SRF_IDENTITY_STORE_ROOT': str(store),
                          'MV_SRF_BIN_DIR': str(self.root / 'bin'),
                          'MV_SRF_STATE_DIR': str(state)})

    def test_mut_net_verb_guard_covers_view(self):
        with self.record_context(), patch.object(demo.identity.Identities, 'show'), \
                patch.object(demo, 'RAM', self.root / 'unused'), \
                patch.object(demo, 'refuse_net_argv', side_effect=demo.ForbiddenVerb('blocked')) as guard, \
                patch.object(demo.subprocess, 'Popen') as spawn:
            with self.assertRaises(demo.ForbiddenVerb):
                demo.record('example', 'demo')
            argv = guard.call_args.args[0]
            self.assertEqual(argv[1:7], ['view', '--container', 'srf-id-example', '--login', '--record', 'demo'])
            spawn.assert_not_called()
        with self.assertRaises(demo.ForbiddenVerb):
            subcommand = 'down'
            demo.refuse_net_argv(['srf-identity-surface', 'net', subcommand])

    def test_record_waits_and_exports(self):
        child = MagicMock()
        child.stdout.readline.return_value = b'{"url":"http://127.0.0.1:1234/"}\n'
        child.wait.return_value = 0
        child.poll.return_value = 0
        ram = self.root / 'record-ram'
        ram.mkdir()
        def spawn(argv, **kwargs):
            import shutil
            shutil.copytree(self.source, ram / 'demo')
            return child
        with self.record_context(), patch.object(demo.identity.Identities, 'show') as show, \
                patch.object(demo, 'refuse_net_argv', wraps=demo.refuse_net_argv) as guard, \
                patch.object(demo.subprocess, 'run') as run, \
                patch.object(demo, 'RAM', ram), \
                patch.object(demo.subprocess, 'Popen', side_effect=spawn) as popen, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            result = demo.record('example', 'demo')
        argv = [str(self.root / 'bin/srf-identity-surface'), 'view', '--container',
                'srf-id-example', '--login', '--record', 'demo', '--state-dir',
                str(self.root / 'native-state'), '--store-root', str(self.root / 'store')]
        show.assert_called_once_with('example')
        guard.assert_called_once_with(argv)
        popen.assert_called_once_with(argv, stdin=demo.subprocess.DEVNULL,
                                     stdout=demo.subprocess.PIPE, stderr=demo.subprocess.DEVNULL,
                                     start_new_session=True)
        run.assert_not_called()
        self.assertEqual(json.loads(output.getvalue()), {'url': 'http://127.0.0.1:1234/'})
        child.wait.assert_called_once()
        self.assertTrue(Path(result['evidence']).is_dir())

    def test_mut_prompt_stale_and_tamper(self):
        evidence = demo.evidence_root() / 'demo'
        demo.export_demo(self.source, evidence)
        checkout, home = self.fixture_checkout()
        with patch.object(demo, 'admitted_home', return_value=home), patch.dict(os.environ, {'MV_MEMORYWEB_REPO': str(checkout)}):
            text = demo.prompt('demo', 'example')
            self.assertTrue(text.startswith('```text\n') and text.endswith('```'))
            self.assertIn(str(evidence), text)
            self.assertIn(str(home / 'sites/example'), text)
            command = next(line for line in text.splitlines() if line.startswith('python3 '))
            self.assertEqual(shlex.split(command), ['python3', str(ROOT / 'tools/mv_demo.py'), 'check', '--site', 'example'])
            self.assertNotIn('@DEMO@', text)
            self.assertIn('text_len', text)
            self.assertNotIn('secret', text)
            self.assertTrue((ROOT / 'tools/mv_demo.py').is_file())
            (checkout / 'standards/schemas/mw.v1.schema.json').unlink()
            with self.assertRaises(demo.Refused):
                demo.prompt('demo', 'example')
            (checkout / 'standards/schemas/mw.v1.schema.json').write_text('{}')
            (evidence / 'events.jsonl').write_text('tampered')
            with self.assertRaises(demo.Refused):
                demo.prompt('demo', 'example')
        docs = (ROOT / 'docs/AUTOMATE_FROM_DEMO.md').read_text()
        for verb in ('record', 'prompt', 'check'):
            self.assertIn('tools/mv_demo.py ' + verb, docs)

    def fixture_checkout(self):
        checkout = self.root / 'checkout'
        (checkout / 'tools').mkdir(parents=True)
        (checkout / 'sites').mkdir()
        (checkout / 'sites/README.md').write_text('Hosted folder contract')
        (checkout / 'templates/site').mkdir(parents=True)
        (checkout / 'standards/schemas').mkdir(parents=True)
        (checkout / 'standards/schemas/mw.v1.schema.json').write_text('{}')
        (checkout / 'tools/build_index.py').write_text(
            "import pathlib, sys\nroot = pathlib.Path(sys.argv[sys.argv.index('--root')+1])\n"
            "site = root / 'sites/example/site.json'\n"
            "if not site.is_file() or site.read_text() != 'valid': sys.exit(1)\n"
            "index = root / 'index'\n"
            "if '--check' in sys.argv: sys.exit(0 if index.read_text() == 'built' else 1)\n"
            "index.write_text('built')\n")
        home = self.root / 'home'
        (home / 'sites/example').mkdir(parents=True)
        return checkout, home

    def test_mut_check_false_ok(self):
        checkout, home = self.fixture_checkout()
        site = home / 'sites/example/site.json'
        site.write_text('invalid')
        with patch.dict(os.environ, {'MV_MEMORYWEB_REPO': str(checkout)}), \
                patch.object(demo, 'admitted_home', return_value=home), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(demo.main(['check', '--site', 'example']), 6)
            self.assertFalse(json.loads(output.getvalue())['ok'])
            site.write_text('valid')
            self.assertTrue(demo.check('example')['validated'])
        self.assertFalse((checkout / 'index').exists())
        self.assertFalse((checkout / 'sites/example').exists())

    def test_home_gate_before_builder(self):
        with patch.object(demo.home_check, 'main', return_value=6) as gate, \
                patch.object(demo.subprocess, 'run') as spawn:
            with self.assertRaises(demo.Refused):
                demo.check('example')
            gate.assert_called_once()
            spawn.assert_not_called()

    def test_check_interpreter_and_interrupt_json(self):
        checkout, home = self.fixture_checkout()
        with patch.dict(os.environ, {'MV_MEMORYWEB_REPO': str(checkout)}), \
                patch.object(demo, 'admitted_home', return_value=home), \
                patch.object(demo.subprocess, 'run', side_effect=KeyboardInterrupt) as run, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(demo.main(['check', '--site', 'example']), 6)
        self.assertEqual(json.loads(output.getvalue()),
                         {'schema': 'metaviewer.demo/v1', 'ok': False, 'error': 'DEMO_REFUSED'})
        argv = run.call_args.args[0]
        self.assertEqual(argv[:2], [sys.executable, '-I'])
        copy = Path(argv[4])
        self.assertEqual(argv[2:], [str(copy / 'tools/build_index.py'), '--root', str(copy)])
        self.assertFalse(copy.exists())


if __name__ == '__main__':
    unittest.main()
