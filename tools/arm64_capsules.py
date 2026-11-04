#!/usr/bin/env python3
"""Admit operator-provided ARM capsule assets; never download or install them."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

SCHEMA = 'metaviewer-arm64-setup/v1'
MODULES = tuple('guest_command_runtime/' + n + '.py' for n in (
    '__init__', '_schemas', 'wire', 'schema', 'config', 'image', 'native_checks',
    'native', 'protocol', 'storage', 'controller'))
NATIVE = ('srf-identity-admin', 'srf-identity-surface')
MAX_JSON = 131072


class Refused(ValueError):
    pass


def need(ok, reason):
    if not ok:
        raise Refused(reason)


def closed(value, keys):
    need(type(value) is dict and set(value) == set(keys), 'closed object required')


def pairs(items):
    out = {}
    for k, v in items:
        need(k not in out, 'duplicate JSON key')
        out[k] = v
    return out


def decode(raw):
    need(len(raw) <= MAX_JSON, 'JSON exceeds bound')
    return json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(Refused('nonfinite JSON')))


def canonical(value):
    need(type(value) is str and value.startswith('/') and not value.startswith('//')
         and '\0' not in value and str(Path(value)) == value
         and '..' not in Path(value).parts, 'canonical absolute path required')
    p = Path(value)
    need(str(p.resolve(strict=True)) == value, 'symlink path refused')
    return p


def read(path, limit=MAX_JSON, private=False):
    p = canonical(str(path))
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
             and before.st_uid in (0, os.getuid()) and not before.st_mode & 0o022
             and 0 < before.st_size <= limit, 'regular bounded protected file required')
        if private:
            need(before.st_uid == os.getuid() and not before.st_mode & 0o077,
                 'owner-private file required')
        raw = bytearray()
        while len(raw) <= limit:
            b = os.read(fd, min(1048576, limit + 1 - len(raw)))
            if not b:
                break
            raw.extend(b)
        after = os.fstat(fd)
        now = p.lstat()
        fields = ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_nlink',
                  'st_size', 'st_mtime_ns', 'st_ctime_ns')
        need(len(raw) == before.st_size and all(getattr(before, k) == getattr(after, k)
             == getattr(now, k) for k in fields), 'file changed during read')
        return bytes(raw)
    finally:
        os.close(fd)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def pin(value, limit=1 << 30):
    closed(value, ('path', 'sha256'))
    need(type(value['sha256']) is str and re.fullmatch('[0-9a-f]{64}', value['sha256']),
         'SHA256 required')
    raw = read(value['path'], limit)
    need(digest(raw) == value['sha256'], 'artifact hash mismatch')
    return raw


def executable(value):
    raw = pin(value)
    s = canonical(value['path']).stat()
    need(s.st_mode & 0o111 and not s.st_mode & 0o6000, 'non-setid executable required')
    need(os.access(value['path'], os.X_OK, effective_ids=True), 'effective execute access required')
    need(len(raw) >= 20 and raw[:6] == b'\x7fELF\x02\x01'
         and int.from_bytes(raw[18:20], 'little') == 183, 'ARM64 executable required')
    return raw


def private_dir(path, create=False):
    p = Path(path)
    if create:
        # Walk from the nearest existing ancestor; never follow a symlink.
        missing = []
        q = p
        while not q.exists() and not q.is_symlink():
            missing.append(q)
            q = q.parent
        canonical(str(q))
        for q in reversed(missing):
            q.mkdir(mode=0o700)
    p = canonical(str(p))
    s = p.lstat()
    need(stat.S_ISDIR(s.st_mode) and s.st_uid == os.getuid()
         and stat.S_IMODE(s.st_mode) == 0o700, 'owner-private directory required')
    return p


def registry_path(env=None):
    env = os.environ if env is None else env
    base = env.get('XDG_DATA_HOME') or str(Path.home() / '.local/share')
    need(Path(base).is_absolute(), 'absolute XDG_DATA_HOME required')
    return Path(base) / 'metaviewer/capsules/arm64/setup.json'


def validate(value):
    keys = ('schema', 'source_commit', 'source_root', 'package', 'python',
            'python_prefix', 'artifacts', 'native', 'runner', 'files', 'vm_image', 'legal',
            'producer_pins', 'package_manifest', 'reconciler')
    extras = tuple(k for k in ('normal_profiles', 'identity_provisioner') if type(value) is dict and k in value)
    closed(value, keys + extras)
    need(value['schema'] == SCHEMA and type(value['source_commit']) is str
         and re.fullmatch('[0-9a-f]{40}', value['source_commit']), 'setup identity')
    source = canonical(value['source_root'])
    need(source.is_dir(), 'source directory required')
    closed(value['package'], ('app', 'asar'))
    app = executable(value['package']['app'])
    need(app[:4] == b'\x7fELF' and len(app) >= 20 and app[4:6] == b'\x02\x01'
         and int.from_bytes(app[18:20], 'little') == 183, 'ARM64 application ELF required')
    pin(value['package']['asar'], 1 << 30)
    need(value['package']['asar']['path'] == str(Path(value['package']['app']['path']).parent / 'resources/app.asar'),
         'application/ASAR directory binding')
    pin(value['package_manifest'], 16 << 20)
    closed(value['producer_pins'], ('setup', 'graphical', 'guestcommand'))
    for producer in value['producer_pins'].values():
        pin(producer, 256 << 20)
    need(value['producer_pins']['graphical'] == value['producer_pins']['guestcommand'],
         'shared adapter producer pin required')
    adapter = str(Path(value['package']['app']['path']).parent / 'resources/bin/mv-daemon-adapter')
    need(value['producer_pins']['graphical']['path'] == adapter
         and value['producer_pins']['setup']['path'] == str(source / 'tools/arm64_capsule_session.py'),
         'packaged producer path binding')
    pin(value['reconciler'], 1 << 20)
    need(value['reconciler']['path'] == str(source / 'tools/arm64_capsule_reconcile.py'),
         'packaged reconciler binding')
    executable(value['python'])
    need(canonical(value['python_prefix']).is_dir(), 'Python prefix directory')
    closed(value['artifacts'], ('engine', 'kernel', 'broker', 'busybox'))
    for name, asset in value['artifacts'].items():
        raw = pin(asset)
        if name != 'kernel':
            need(len(raw) >= 20 and raw[:6] == b'\x7fELF\x02\x01'
                 and int.from_bytes(raw[18:20], 'little') == 183, 'ARM64 artifact ELF required')
        else:
            need(len(raw) >= 64 and raw[56:60] == b'ARM\x64', 'ARM64 raw kernel required')
    closed(value['native'], NATIVE)
    for native in value['native'].values():
        executable(native)
    parents = {str(Path(x['path']).parent) for x in value['native'].values()}
    need(len(parents) == 1 and all(Path(value['native'][n]['path']).name == n for n in NATIVE),
         'native binary directory closure')
    pin(value['runner'], 1 << 20)
    need(value['runner']['path'] == str(source / 'daemon-adapter/tools/guest_command_runner.py'),
         'runner source binding')
    need(type(value['files']) is list and len(value['files']) == len(MODULES), 'module closure')
    seen = set()
    for entry in value['files']:
        closed(entry, ('relative', 'path', 'sha256'))
        rel = entry['relative']
        need(type(rel) is str and rel in MODULES and rel not in seen, 'module identity')
        seen.add(rel)
        need(entry['path'] == str(source / 'daemon-adapter' / rel), 'module source binding')
        pin({'path': entry['path'], 'sha256': entry['sha256']}, 2 << 20)
    need(type(value['vm_image']) is str and re.fullmatch('sha256:[0-9a-f]{64}', value['vm_image']),
         'exact local image ID required')
    legal = value['legal']
    closed(legal, ('scope', 'operator_local_use_confirmed', 'redistribute', 'assets'))
    need(legal['scope'] == 'operator-provided-local-only' and legal['operator_local_use_confirmed'] is True
         and legal['redistribute'] is False, 'explicit local-use scope required')
    closed(legal['assets'], ('engine', 'kernel', 'broker', 'busybox', 'vm_image', 'native'))
    for facts in legal['assets'].values():
        closed(facts, ('license', 'source', 'evidence'))
        need(all(type(x) is str and 0 < len(x.encode()) <= 4096 for x in facts.values()),
             'per-asset legal/source facts required')
    normal = value.get('normal_profiles', {})
    need(type(normal) is dict and set(normal) <= {'browser', 'program'}
         and ('program' not in normal or 'browser' in normal), 'normal profile recipe set')
    if 'browser' in normal:
        need('identity_provisioner' in value, 'identity provisioning source pin required')
    if 'identity_provisioner' in value:
        pin(value['identity_provisioner'], 1 << 20)
        need(value['identity_provisioner']['path'] == str(source / 'tools/mv_identity.py'),
             'identity provisioning source binding')
    for name, recipe in normal.items():
        closed(recipe, ('image_id', 'legal', 'domains') if name == 'browser' else ('image_id', 'legal'))
        need(type(recipe['image_id']) is str and re.fullmatch('sha256:[0-9a-f]{64}', recipe['image_id']),
             'normal profile exact local image')
        closed(recipe['legal'], ('license', 'source', 'evidence'))
        need(all(type(x) is str and 0 < len(x.encode()) <= 4096 for x in recipe['legal'].values()),
             'normal image legal/source facts required')
        if name == 'browser':
            sites = recipe['domains']
            need(type(sites) is list and 1 <= len(sites) <= 16
                 and all(type(x) is str and re.fullmatch('[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', x) for x in sites)
                 and sites == sorted(set(sites)), 'closed browser domain policy')
    return value


def run(argv, env=None, timeout=15):
    result = subprocess.run(argv, env=env, capture_output=True, timeout=timeout, check=False)
    need(result.returncode == 0 and len(result.stdout) <= 1 << 20, 'bounded command failed')
    return result.stdout


# Constant program, isolated interpreter, no user imports/config or writes.
PYTHON_PROBE = ('import sys,json,hashlib,socket,ctypes,threading;'
                'print(json.dumps({"executable":sys.executable,"prefix":sys.base_prefix,'
                '"isolated":sys.flags.isolated,"no_bytecode":sys.dont_write_bytecode,'
                '"version":list(sys.version_info[:2])}))')


def interpreter_check(value, command=run):
    executable(value['python'])
    result = decode(command([value['python']['path'], '-I', '-B', '-c', PYTHON_PROBE],
                            env={'PATH': '/usr/bin:/bin'}, timeout=5))
    closed(result, ('executable', 'prefix', 'isolated', 'no_bytecode', 'version'))
    need(result['executable'] == value['python']['path']
         and result['prefix'] == value['python_prefix'] and type(result['isolated']) is int and result['isolated'] == 1
         and result['no_bytecode'] is True and type(result['version']) is list
         and len(result['version']) == 2 and all(type(n) is int for n in result['version'])
         and result['version'][0] == 3 and result['version'][1] >= 11,
         'isolated interpreter prefix/import validation failed')
    executable(value['python'])


def host_check(value):
    need(os.uname().machine == 'aarch64', 'ARM64 host required')
    fd = os.open('/dev/kvm', os.O_RDWR | os.O_CLOEXEC)
    try:
        need(fcntl.ioctl(fd, 0xAE00, 0) == 12, 'KVM API unavailable')
    finally:
        os.close(fd)
    images = [value['vm_image']] + [r['image_id'] for r in value.get('normal_profiles', {}).values()]
    for image in images:
        rows = decode(run(['/usr/bin/docker', 'image', 'inspect', image], env={'PATH': '/usr/bin:/bin'}))
        need(type(rows) is list and len(rows) == 1 and rows[0].get('Id') == image
             and rows[0].get('Architecture') == 'arm64' and rows[0].get('Os') == 'linux',
             'local capsule image mismatch')
    return {'architecture': 'aarch64', 'kvm_api': 12, 'vm_image': value['vm_image']}


def write_new(path, value):
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()
    write_bytes_new(path, raw)


def write_bytes_new(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        d = os.open(Path(path).parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(d)
        finally:
            os.close(d)
    except BaseException:
        # Keep partial evidence; no automatic retry or replacement.
        raise


def load_registry(env=None):
    p = registry_path(env)
    private_dir(p.parent)
    return validate(decode(read(p, private=True)))


def configure(value, env=None):
    validate(value)
    interpreter_check(value)
    host_check(value)
    p = registry_path(env)
    private_dir(p.parent, create=True)
    # Link a fully fsynced private temporary inode atomically, refusing replacement.
    fd, name = tempfile.mkstemp(prefix='.setup-', dir=p.parent)
    os.close(fd)
    os.unlink(name)
    try:
        write_new(name, value)
        os.link(name, p, follow_symlinks=False)
        os.unlink(name)
        d = os.open(p.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(d)
        finally:
            os.close(d)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return p


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('doctor', 'configure-local', 'status'))
    parser.add_argument('--descriptor')
    args = parser.parse_args()
    try:
        need((args.operation != 'status') == bool(args.descriptor), 'descriptor required only for doctor/configure-local')
        value = validate(decode(read(args.descriptor, private=True))) if args.descriptor else load_registry()
        if args.operation != 'configure-local':
            interpreter_check(value)
        observation = host_check(value) if args.operation != 'configure-local' else None
        if args.operation == 'configure-local':
            configure(value)
        print(json.dumps({'schema': 'metaviewer-arm64-setup-result/v1', 'operation': args.operation,
                          'configured': True, 'capabilities': ['vm', 'microvm'], 'host': observation}))
    except (Refused, OSError, ValueError, subprocess.SubprocessError):
        print(json.dumps({'schema': 'metaviewer-arm64-setup-result/v1', 'operation': args.operation,
                          'configured': False, 'error': 'ARM64_SETUP_REFUSED'}))
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
