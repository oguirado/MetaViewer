#!/usr/bin/env python3
"""Explicit scripted SDK demonstration. No model inference or second SDK owner."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import time

HELPERS = {
    'run_control.py': 'ef116438bc52b9f8ab94c19ab2319a792745e6be30ab632521b705fd949083ae',
    'demo.py': 'b87900e3541126727b3eb09ac74ae63a691c2da3dc7346044212a4a122c4fca2',
    'observer_control.py': '342225a0c9c07a2d61b8737a8ad0cd0b538c79efe68d0489dabf84633d32a12e',
    'sdk_observer.py': 'a72052f961acb0992a46763b78bba1d8ff066b8d21f4f8e5dd970bfd309a8d6a',
    'vis_common.py': '1e4f34e23f066fe95011c94f888ff5fd0fceffd862f5113d17d98ae97a9ae9b4',
    'DEMO_PINS.json': '6dbb1e3082656ebe09df4239d612aec698c15346b418dabed3f0f8537ea6ce6c',
}
SDK_SHA = 'bb12357c454d0ca1089883fc36fcda55a4df9d611d470401579d7d17f1d7c69b'
FILES = ('notes.txt', 'photo.txt', 'plan.txt')


class Refused(ValueError):
    pass


def need(value, reason):
    if not value:
        raise Refused(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def decode(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            need(key not in value, 'duplicate JSON key')
            value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(Refused('nonfinite JSON')))


def private_dir(path):
    path = Path(path)
    need(path.is_absolute() and path.resolve(strict=True) == path, 'directory alias')
    s = path.lstat()
    need(stat.S_ISDIR(s.st_mode) and s.st_uid == os.getuid()
         and stat.S_IMODE(s.st_mode) == 0o700, 'private directory required')
    return path


def read(path, limit=131072, private=True):
    path = Path(path)
    need(path.is_absolute() and path.resolve(strict=True) == path, 'file alias')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
             and before.st_nlink == 1 and not before.st_mode & (0o077 if private else 0o022)
             and 0 < before.st_size <= limit, 'protected bounded file required')
        raw = os.read(fd, limit + 1)
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode', 'st_uid', 'st_nlink')
        need(len(raw) == before.st_size and all(getattr(before, k) == getattr(os.fstat(fd), k)
             == getattr(path.lstat(), k) for k in fields), 'file changed during read')
        return raw
    finally:
        os.close(fd)


def check_helpers(episode):
    for name, expected in HELPERS.items():
        need(sha(read(episode / name, private=False)) == expected, 'helper pin mismatch: ' + name)


def exclusive(path, value):
    raw = (json.dumps(value, sort_keys=True, allow_nan=False) + '\n').encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


class Context:
    def __init__(self, episode, pin_sha):
        self.episode = private_dir(episode)
        need(re.fullmatch('[0-9a-f]{64}', pin_sha), 'explicit package digest required')
        self.pin_sha = pin_sha
        self.active_raw = read(self.episode / 'ACTIVE.json')
        self.active = decode(self.active_raw)
        need(set(self.active) == {'root', 'run_id'} and re.fullmatch('[0-9a-f]{24}', self.active['run_id']), 'active episode shape')
        self.run_id = self.active['run_id']
        self.root = private_dir(self.active['root'])
        need(self.root.parts[:3] == ('/', 'dev', 'shm'), 'private RAM episode required')
        self.plan_raw = read(self.root / 'PLAN.json')
        self.plan = decode(self.plan_raw)
        self.identity = [self.root.stat().st_dev, self.root.stat().st_ino]
        need(self.plan['root'] == str(self.root) and self.plan['root_identity'] == self.identity
             and self.plan['run_id'] == self.run_id and self.plan['actor'] == 'rw68-' + self.run_id
             and self.plan['unit'] == 'rw68-' + self.run_id + '.service'
             and self.plan['effect_pins'] == {name: HELPERS[name] for name in ('demo.py', 'observer_control.py')},
             'episode binding mismatch')
        self.owner = 'actor-' + sha(('agent:' + self.plan['actor']).encode())
        self.scene = self.root / 'scripted-scene'
        self.journal = self.root / 'observer' / 'events.jsonl'
        private_dir(self.journal.parent)
        self.journal_identity = [self.journal.stat().st_dev, self.journal.stat().st_ino]
        self.revalidate()

    def revalidate(self):
        check_helpers(self.episode)
        need(read(self.episode / 'ACTIVE.json') == self.active_raw and read(self.root / 'PLAN.json') == self.plan_raw,
             'episode metadata changed')
        need([private_dir(self.root).stat().st_dev, self.root.stat().st_ino] == self.identity,
             'episode root replaced')
        need(not (self.root / 'CLOSED.json').exists() and not (self.episode / 'CLOSED.json').exists(), 'episode closed')
        raw = read(self.episode / 'PACKAGE_PIN.json', private=False)
        need(sha(raw) == self.pin_sha, 'package pin changed')
        pins = decode(raw)
        need(self.plan['pins'] == pins and self.plan['pin_file'] == str(self.episode / 'PACKAGE_PIN.json')
             and self.plan['pin_sha256'] == self.pin_sha and pins['sdk_pins']['guest_command.py'] == SDK_SHA,
             'active package or SDK differs')
        sdk = Path(pins['package']) / 'resources/operator/agents/metaviewer_agents/guest_command.py'
        need(sha(read(sdk, private=False)) == SDK_SHA, 'installed SDK differs')
        need(pins['python']['path'] == '/usr/bin/python3.12', 'fixed interpreter required')
        self.python = pins['python']['path']
        need(pins['python'] == decode(read(self.episode / 'DEMO_PINS.json', private=False))['python'],
             'interpreter policy changed')
        st = os.stat(self.python, follow_symlinks=False)
        need(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022
             and st.st_mode & 0o111 and os.access(self.python, os.X_OK, effective_ids=True), 'interpreter custody')
        identity = (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        if not hasattr(self, 'python_identity'):
            with open(self.python, 'rb') as stream:
                need(hashlib.file_digest(stream, 'sha256').hexdigest() == pins['python']['sha256'], 'interpreter digest')
            self.python_identity = identity
        need(identity == self.python_identity, 'interpreter changed')
        need([self.journal.stat().st_dev, self.journal.stat().st_ino] == self.journal_identity, 'observer journal replaced')

    def events(self):
        self.revalidate()
        raw = read(self.journal, 4 << 20)
        need(raw.endswith(b'\n'), 'observer tail incomplete')
        lines = raw.splitlines(keepends=True)
        need(len(lines) <= 2048, 'observer bound')
        rows, seen = [], set()
        for line in lines:
            e = decode(line)
            need(set(e) == {'schema', 'event_id', 'request_id', 'owner_id', 'event', 'data', 'session'}
                 and e['schema'] in ('guest_command_event/v0.2', 'rewind_event/v0.2')
                 and e['owner_id'] == self.owner and e['event_id'] not in seen,
                 'observer authority or replay')
            seen.add(e['event_id'])
            rows.append(e)
        return rows, lines


def current(rows):
    need(rows, 'no authenticated workload')
    e = rows[-1]
    value = e['session']
    need(e['event'] not in ('outcome_unknown', 'refused', 'recovery_ready') and value is not None
         and value['phase'] == 'ready' and value['ownership'] == 'held'
         and type(value['generation']) is int and value['generation'] > 0, 'workload not ready')
    return {'owner_id': e['owner_id'], 'workload_id': value['workload_id'], 'generation': value['generation']}


def matching(rows, cursor, target, op, generation, point=None):
    accepted = set()
    found = []
    for e in rows[cursor:]:
        value = e.get('session')
        if e.get('schema') != 'rewind_event/v0.2' or e.get('owner_id') != target['owner_id'] or not value:
            continue
        if value.get('workload_id') != target['workload_id'] or value.get('generation') != generation or e['data'].get('op') != op:
            continue
        if e['event'] == 'accepted':
            accepted.add(e['request_id'])
        elif e['event'] == 'completed' and e['request_id'] in accepted and value.get('phase') == 'ready' and value.get('ownership') == 'held':
            selected = e['data'].get('point_id')
            points = [p for p in value.get('points', []) if p.get('point_id') == selected and p.get('status') == 'usable']
            if len(points) == 1 and (point is None or selected == point):
                if op != 'mark' or points[0].get('source_generation') == target['generation']:
                    if op == 'restore' and value.get('last_good_usable') != point:
                        continue
                    found.append({'point_id': selected, 'target': target | {'generation': generation}, 'event_id': e['event_id']})
    need(len(found) <= 1, 'ambiguous completed rewind')
    return found[0] if found else None


def find_mark(rows, cursor, target):
    return matching(rows, cursor, target, 'mark', target['generation'] + 1)


def find_restore(rows, cursor, target, point):
    return matching(rows, cursor, target, 'restore', target['generation'] + 1, point)


def commands(folder):
    need(re.fullmatch('demo-files-[0-9a-f]{16}', folder), 'guest folder identity')
    root = './' + folder
    listing = f"ls -1 {root} && printf 'Files: ' && ls -1 {root} | wc -l"
    writes = ' && '.join(f"printf '{text}\\n' > {root}/{name}" for name, text in zip(FILES, ('Notes before rewind', 'Photo placeholder', 'Plan before rewind')))
    return {'seed': f'set -eu; mkdir {root} && {writes} && {listing}',
            'delete': f"set -eu; rm {' '.join(root + '/' + name for name in FILES)} && {listing} && test -z \"$(ls -A {root})\" && printf 'EMPTY\\n'",
            'list': f"set -eu; {listing} && cat {' '.join(root + '/' + name for name in FILES)} && printf 'CONTINUE\\n'"}


def run_helper(ctx, request, target, command):
    argv = [ctx.python, '-I', '-B', str(ctx.episode / 'run_control.py'), '--request-id', request,
            '--owner-id', target['owner_id'], '--workload-id', target['workload_id'],
            '--generation', str(target['generation']), '--command', command, '--cwd', '', '--timeout-ms', '10000',
            '--pin-file', str(ctx.episode / 'PACKAGE_PIN.json'), '--pin-sha256', ctx.pin_sha]
    result = subprocess.run(argv, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, capture_output=True, timeout=80, check=False)
    need(result.returncode == 0 and len(result.stdout) <= 262144, 'SDK command outcome unknown')
    return decode(result.stdout)


def dispatch_once(ctx, stage, target, command, invoke=run_helper):
    ctx.revalidate()
    request = secrets.token_hex(16)
    intent = {'run_id': ctx.run_id, 'request_id': request, 'target': target, 'command_sha256': sha(command.encode())}
    exclusive(ctx.scene / (stage + '.intent.json'), intent)
    try:
        ctx.revalidate()
        value = invoke(ctx, request, target, command)
        need(value['status'] == 'completed' and value['run_id'] == ctx.run_id and value['request_id'] == request
             and all(value[k] == target[k] for k in target) and value['exit_code'] == 0
             and value['signal'] is None and value['cause'] == 'exit' and value['output_complete'] is True,
             'SDK result not confirmed')
        for stream in ('stdout', 'stderr'):
            raw = base64.b64decode(value[stream + '_b64'], validate=True)
            need(len(raw) == value[stream + '_bytes'] <= 65536 and sha(raw) == value[stream + '_sha256'], 'output mismatch')
        exclusive(ctx.scene / (stage + '.result.json'), value)
        print(base64.b64decode(value['stdout_b64']).decode('utf-8', 'strict'), end='', flush=True)
        return value
    except Exception:
        exclusive(ctx.scene / (stage + '.unknown.json'), {'request_id': request, 'status': 'HOLD_NO_RETRY'})
        raise


def terminal_cursor(ctx, result):
    end = time.monotonic() + 5
    while time.monotonic() < end:
        try:
            rows, lines = ctx.events()
        except Refused as error:
            if str(error) not in ('file changed during read', 'observer tail incomplete'):
                raise
            time.sleep(0.05)
            continue
        matches = [i for i, e in enumerate(rows) if e['schema'] == 'guest_command_event/v0.2'
                   and e['event'] == 'job_finished' and e['session'] is not None
                   and e['session'].get('job', {}).get('job_id') == result['job_id']]
        if matches:
            need(len(matches) == 1, 'ambiguous SDK terminal')
            cursor = matches[0] + 1
            return {'cursor': cursor, 'prefix_sha256': sha(b''.join(lines[:cursor]))}
        time.sleep(0.05)
    raise Refused('terminal observation missing; no retry')


def prefix(rows, lines, saved):
    need(type(saved['cursor']) is int and 0 <= saved['cursor'] <= len(rows)
         and sha(b''.join(lines[:saved['cursor']])) == saved['prefix_sha256'], 'observer prefix changed')


def execute(args):
    ctx = Context(args.episode, args.package_pin_sha256)
    if args.action == 'seed':
        ctx.scene.mkdir(mode=0o700)
    private_dir(ctx.scene)
    lock = os.open(ctx.scene / 'scene.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        lock_stat = os.fstat(lock)
        need(stat.S_ISREG(lock_stat.st_mode) and lock_stat.st_uid == os.getuid()
             and lock_stat.st_nlink == 1 and stat.S_IMODE(lock_stat.st_mode) == 0o600, 'scene lock custody')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        rows, lines = ctx.events()
        if args.action == 'seed':
            target = current(rows)
            folder = 'demo-files-' + secrets.token_hex(8)
            exclusive(ctx.scene / 'scene.json', {'run_id': ctx.run_id, 'root_identity': ctx.identity, 'journal_identity': ctx.journal_identity,
                                                'folder': folder, 'target': target})
            result = dispatch_once(ctx, 'seed', target, commands(folder)['seed'])
            text = base64.b64decode(result['stdout_b64']).decode()
            need(re.search(r'^Files:\s*3\s*$', text, re.M) and all(name in text.splitlines() for name in FILES),
                 'seed listing mismatch')
            exclusive(ctx.scene / 'seed.cursor.json', terminal_cursor(ctx, result))
            print('Human: Mark this ready workload before delete-and-watch.', flush=True)
            return
        scene = decode(read(ctx.scene / 'scene.json'))
        need(scene['run_id'] == ctx.run_id and scene['root_identity'] == ctx.identity and scene['journal_identity'] == ctx.journal_identity, 'scene belongs to another episode')
        cmd = commands(scene['folder'])
        saved = decode(read(ctx.scene / 'seed.cursor.json'))
        prefix(rows, lines, saved)
        if args.action == 'list':
            target = current(rows)
            need(target['owner_id'] == scene['target']['owner_id'] and target['workload_id'] == scene['target']['workload_id'], 'foreign workload')
            dispatch_once(ctx, 'list', target, cmd['list'])
            return
        mark = find_mark(rows, saved['cursor'], scene['target'])
        need(mark is not None and current(rows) == mark['target'], 'completed post-seed Mark required')
        exclusive(ctx.scene / 'selected-mark.json', mark)
        result = dispatch_once(ctx, 'delete', mark['target'], cmd['delete'])
        output = base64.b64decode(result['stdout_b64']).decode()
        need(re.search(r'^Files:\s*0\s*$', output, re.M) and 'EMPTY' in output, 'empty listing not confirmed')
        deleted = terminal_cursor(ctx, result)
        exclusive(ctx.scene / 'delete.cursor.json', deleted)
        print('Human: classic Back to the marked point. Watching; no retries.', flush=True)
        deadline = time.monotonic() + args.watch_seconds
        while time.monotonic() < deadline:
            try:
                rows, lines = ctx.events()
            except Refused as error:
                if str(error) not in ('file changed during read', 'observer tail incomplete'):
                    raise
                time.sleep(0.2)
                continue
            prefix(rows, lines, deleted)
            restored = find_restore(rows, deleted['cursor'], mark['target'], mark['point_id'])
            if restored is not None:
                need(current(rows) == restored['target'], 'restore no longer ready')
                value = dispatch_once(ctx, 'restored-list', restored['target'], cmd['list'])
                text = base64.b64decode(value['stdout_b64']).decode()
                need(re.search(r'^Files:\s*3\s*$', text, re.M) and all(name in text.splitlines() for name in FILES)
                     and 'CONTINUE' in text.splitlines(), 'restored files not confirmed')
                print('Scripted demonstration complete; no model inference.', flush=True)
                return
            time.sleep(0.2)
        raise Refused('restore watch timed out; no retry or replay')
    finally:
        os.close(lock)


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--episode', required=True)
    parser.add_argument('--package-pin-sha256', required=True)
    parser.add_argument('--watch-seconds', type=int, default=600)
    parser.add_argument('action', choices=('seed', 'delete-and-watch', 'list'))
    args = parser.parse_args(argv)
    need(1 <= args.watch_seconds <= 600, 'watch bound')
    return args


def main(argv=None):
    print('Scripted SDK demonstration / no model inference', flush=True)
    try:
        execute(arguments(argv))
        return 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print('HOLD: ' + type(error).__name__ + '; no automatic retry', flush=True)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
