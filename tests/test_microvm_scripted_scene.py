"""Pure scripted-scene controls; no SDK, socket, guest or graphical actions."""
import hashlib
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('scene', Path(__file__).resolve().parents[1] / 'tools/microvm_scripted_scene.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)

OWNER = 'actor-' + 'a' * 64
TARGET = {'owner_id': OWNER, 'workload_id': 'workload-demo', 'generation': 1}


def event(op, kind, generation, request='request-one', point='point-one', source=1):
    return {'schema': 'rewind_event/v0.2', 'event_id': 'event-' + kind + '-' + request,
            'request_id': request, 'owner_id': OWNER, 'event': kind,
            'data': {'op': op, 'point_id': point},
            'session': {'workload_id': TARGET['workload_id'], 'generation': generation,
                        'phase': 'ready', 'ownership': 'held', 'authority_epoch': generation,
                        'last_good_usable': point,
                        'points': [{'point_id': point, 'source_generation': source, 'status': 'usable'}]}}


class SceneTests(unittest.TestCase):
    def test_mark_requires_postseed_accepted_and_completed_point(self):
        rows = [event('mark', 'accepted', 2), event('mark', 'completed', 2)]
        found = s.find_mark(rows, 0, TARGET)
        self.assertEqual(found['point_id'], 'point-one')
        self.assertIsNone(s.find_mark(rows, 2, TARGET))
        self.assertIsNone(s.find_mark(rows[1:], 0, TARGET))
        for field, value in [('owner_id', 'actor-foreign'), ('workload_id', 'workload-foreign'), ('source_generation', 2)]:
            changed = json.loads(json.dumps(rows))
            for row in changed:
                if field == 'owner_id': row[field] = value
                elif field == 'workload_id': row['session'][field] = value
                else: row['session']['points'][0][field] = value
            self.assertIsNone(s.find_mark(changed, 0, TARGET))

    def test_restore_requires_postdelete_exact_point_and_next_generation(self):
        rows = [event('restore', 'accepted', 3), event('restore', 'completed', 3)]
        self.assertIsNotNone(s.find_restore(rows, 0, TARGET | {'generation': 2}, 'point-one'))
        self.assertIsNone(s.find_restore(rows, 2, TARGET | {'generation': 2}, 'point-one'))
        self.assertIsNone(s.find_restore(rows, 0, TARGET | {'generation': 1}, 'point-one'))
        self.assertIsNone(s.find_restore(rows, 0, TARGET | {'generation': 2}, 'point-foreign'))
        rows[-1]['event'] = 'outcome_unknown'
        self.assertIsNone(s.find_restore(rows, 0, TARGET | {'generation': 2}, 'point-one'))

    def test_commands_only_delete_three_literal_guest_paths(self):
        commands = s.commands('demo-files-' + 'a' * 16)
        self.assertIn('mkdir ./demo-files-', commands['seed'])
        self.assertNotIn('mkdir -p', commands['seed'])
        self.assertNotIn('rm -', commands['delete'])
        for name in ('notes.txt', 'photo.txt', 'plan.txt'):
            self.assertIn('./demo-files-' + 'a' * 16 + '/' + name, commands['delete'])
        self.assertNotIn('*', commands['delete'])
        self.assertNotIn('rm ', commands['list'])
        for path in ('/tmp/demo', '../demo', 'demo-files-;rm', 'demo-files-' + 'a' * 16 + '/x'):
            with self.assertRaises(s.Refused): s.commands(path)

    def test_wrong_helper_pin_refuses_without_import_or_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'run_control.py').write_bytes(b'changed')
            (root / 'run_control.py').chmod(0o600)
            with patch.object(s, 'HELPERS', {'run_control.py': hashlib.sha256(b'expected').hexdigest()}):
                with self.assertRaises(s.Refused): s.check_helpers(root)

    def test_uncertain_attempt_is_durable_and_never_replayed(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = types.SimpleNamespace(scene=Path(tmp), revalidate=lambda: None, run_id='a' * 24)
            calls = []
            def fail(*args): calls.append(args); raise TimeoutError('unknown send')
            with self.assertRaises(TimeoutError): s.dispatch_once(ctx, 'seed', TARGET, 'fixed', invoke=fail)
            self.assertTrue((ctx.scene / 'seed.intent.json').exists())
            with self.assertRaises(FileExistsError): s.dispatch_once(ctx, 'seed', TARGET, 'fixed', invoke=fail)
            self.assertEqual(len(calls), 1)

    def test_intent_precedes_dispatch_and_target_drift_refuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = types.SimpleNamespace(scene=Path(tmp), run_id='a' * 24)
            count = []
            def check():
                count.append(1)
                if len(count) == 2: raise s.Refused('changed custody')
            ctx.revalidate = check
            def forbidden(*args): self.fail('dispatch after changed custody')
            with self.assertRaises(s.Refused): s.dispatch_once(ctx, 'seed', TARGET, 'fixed', invoke=forbidden)
            self.assertTrue((ctx.scene / 'seed.intent.json').exists())

    def test_successful_dispatch_is_once_and_uses_exact_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = types.SimpleNamespace(scene=Path(tmp), revalidate=lambda: None, run_id='a' * 24)
            calls = []
            def complete(context, rid, target, command):
                self.assertTrue((context.scene / 'seed.intent.json').is_file())
                calls.append((target, command))
                value = {'status': 'completed', 'run_id': context.run_id, 'request_id': rid,
                         **target, 'exit_code': 0, 'signal': None, 'cause': 'exit', 'output_complete': True}
                for stream in ('stdout', 'stderr'):
                    raw = b'ok\n' if stream == 'stdout' else b''
                    value.update({stream + '_bytes': len(raw), stream + '_sha256': hashlib.sha256(raw).hexdigest(),
                                  stream + '_b64': base64.b64encode(raw).decode()})
                return value
            s.dispatch_once(ctx, 'seed', TARGET, 'fixed', invoke=complete)
            with self.assertRaises(FileExistsError): s.dispatch_once(ctx, 'seed', TARGET, 'fixed', invoke=complete)
            self.assertEqual(calls, [(TARGET, 'fixed')])

    def test_helper_invocation_has_no_shell_and_keeps_explicit_pin(self):
        ctx = types.SimpleNamespace(python='/usr/bin/python3.12', episode=Path('/synthetic'), pin_sha='b' * 64)
        done = types.SimpleNamespace(returncode=0, stdout=b'{}')
        with patch.object(s.subprocess, 'run', return_value=done) as run:
            self.assertEqual(s.run_helper(ctx, 'c' * 32, TARGET, 'literal guest command'), {})
        argv = run.call_args.args[0]
        self.assertNotIn('shell', run.call_args.kwargs)
        self.assertEqual(argv[argv.index('--pin-sha256') + 1], ctx.pin_sha)
        self.assertEqual(argv[argv.index('--generation') + 1], '1')
        self.assertEqual(argv[argv.index('--command') + 1], 'literal guest command')

    def test_three_command_scene_uses_mark_then_postdelete_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = types.SimpleNamespace(scene=Path(tmp) / 'scene', run_id='a' * 24,
                                        identity=[1, 2], journal_identity=[1, 3], revalidate=lambda: None,
                                        python='/usr/bin/python3.12', episode=Path('/synthetic'), pin_sha='b' * 64)
            ready = {'schema': 'guest_command_event/v0.2', 'event_id': 'event-ready',
                     'owner_id': OWNER, 'event': 'ready', 'session': dict(TARGET, phase='ready', ownership='held')}
            rows = [ready]
            calls = []
            pending = []
            def events():
                snapshot = list(rows)
                lines = [(json.dumps(row) + '\n').encode() for row in snapshot]
                if pending:
                    rows.extend(pending.pop())
                return snapshot, lines
            ctx.events = events
            def run(argv, **kwargs):
                calls.append(argv)
                get = lambda flag: argv[argv.index(flag) + 1]
                rid, gen = get('--request-id'), int(get('--generation'))
                text = 'notes.txt\nphoto.txt\nplan.txt\nFiles: 3\n'
                if len(calls) == 2:
                    text = 'Files: 0\nEMPTY\n'
                    pending.append([event('restore', 'accepted', 3, request='request-back'),
                                    event('restore', 'completed', 3, request='request-back')])
                elif len(calls) == 3:
                    text += 'Notes before rewind\nPhoto placeholder\nPlan before rewind\nCONTINUE\n'
                value = {'status': 'completed', 'run_id': ctx.run_id, 'request_id': rid,
                         **(TARGET | {'generation': gen}), 'job_id': 'job-' + rid,
                         'exit_code': 0, 'signal': None, 'cause': 'exit', 'output_complete': True}
                for stream, raw in [('stdout', text.encode()), ('stderr', b'')]:
                    value.update({stream + '_bytes': len(raw), stream + '_sha256': hashlib.sha256(raw).hexdigest(),
                                  stream + '_b64': base64.b64encode(raw).decode()})
                rows.append(dict(ready, event_id='event-' + rid, event='job_finished',
                                 session=dict(ready['session'], generation=gen, job={'job_id': value['job_id']})))
                return types.SimpleNamespace(returncode=0, stdout=json.dumps(value).encode())
            args = types.SimpleNamespace(episode='/synthetic', package_pin_sha256='b' * 64, action='seed', watch_seconds=1)
            with patch.object(s, 'Context', return_value=ctx), patch.object(s.subprocess, 'run', side_effect=run):
                s.execute(args)
                rows.extend([event('mark', 'accepted', 2), event('mark', 'completed', 2)])
                args.action = 'delete-and-watch'
                s.execute(args)
            self.assertEqual(len(calls), 3)
            self.assertEqual([a[a.index('--generation') + 1] for a in calls], ['1', '2', '3'])
            self.assertIn('rm ./demo-files-', calls[1][calls[1].index('--command') + 1])
            self.assertNotIn('rm ', calls[2][calls[2].index('--command') + 1])

    def test_cli_never_defaults_package_pin_or_adds_force(self):
        with self.assertRaises(SystemExit): s.arguments(['--episode', '/fixture', 'seed'])
        with self.assertRaises(SystemExit): s.arguments(['--episode', '/fixture', '--package-pin-sha256', 'a' * 64, '--force', 'seed'])


if __name__ == '__main__':
    unittest.main()
