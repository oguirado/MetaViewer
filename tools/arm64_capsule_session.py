#!/usr/bin/env python3
"""Launch one owned normal ARM capsule session from the protected local registry."""
import argparse
from contextlib import contextmanager
import select
import socket
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import secrets
import re
import stat
import subprocess
import tempfile
import signal
import time

_spec = importlib.util.spec_from_file_location('arm64_capsules', Path(__file__).with_name('arm64_capsules.py'))
setup = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(setup)


def _rename_noreplace(directory_fd, source, target):
    """Linux atomic publication without replacing an existing custody marker."""
    import ctypes
    import errno
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    if rename is None:
        raise OSError(errno.ENOSYS, 'atomic no-replace publication unavailable')
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(directory_fd, os.fsencode(source), directory_fd, os.fsencode(target), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def publish_held_marker(directory, value):
    """Publish complete durable bytes; a failed preparation creates no final marker."""
    directory = setup.private_dir(directory)
    parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    temporary = '.held-session-' + secrets.token_hex(12)
    try:
        before = os.fstat(parent)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=parent)
        with os.fdopen(fd, 'wb') as stream:
            stream.write((json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode())
            stream.flush()
            os.fsync(stream.fileno())
        current = directory.lstat()
        setup.need((before.st_dev, before.st_ino) == (current.st_dev, current.st_ino),
                   'registry directory changed before publication')
        _rename_noreplace(parent, temporary, 'held-session.json')
        os.fsync(parent)
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass
        os.close(parent)


def record(root, event, **fields):
    # Each transition is a new durable file; interrupted actions cannot be replayed.
    index = len(list(root.glob('event-*.json')))
    setup.write_new(root / ('event-%04d.json' % index), {'event': event, **fields})


def process_identity(pid):
    """ENOENT is absence; every other observation failure remains unknown."""
    setup.need(type(pid) is int and pid > 0, 'positive process identity required')
    try:
        first = Path('/proc/%d/stat' % pid).read_text()
        tail = first.rsplit(')', 1)
        setup.need(len(tail) == 2 and first.startswith(str(pid) + ' ('), 'malformed process stat')
        fields = tail[1].split()
        setup.need(len(fields) >= 20 and fields[19].isdigit() and int(fields[19]) > 0,
                   'process start unknown')
        group = Path('/proc/%d/cgroup' % pid).read_text().strip()
        setup.need(group.startswith('0::/') and '\n' not in group and '..' not in group,
                   'process cgroup unknown')
        again_raw = Path('/proc/%d/stat' % pid).read_text()
        again = again_raw.rsplit(')', 1)
        setup.need(again_raw.startswith(str(pid) + ' (') and len(again) == 2 and len(again[1].split()) >= 20
                   and again[1].split()[19] == fields[19], 'process changed during observation')
        return {'pid': pid, 'start_ticks': int(fields[19]), 'cgroup': group[3:], 'state': fields[0]}
    except FileNotFoundError:
        return None
    except OSError as error:
        raise setup.Refused('process observation unknown') from error


def process_alive(expected):
    setup.closed(expected, ('pid', 'start_ticks', 'cgroup', 'state'))
    now = process_identity(expected['pid'])
    return now is not None and now['state'] not in ('Z', 'X') and all(
        now[k] == expected[k] for k in ('pid', 'start_ticks', 'cgroup'))


def bind_launcher(pid, start):
    setup.need(type(pid) is int and type(start) is int and pid == os.getppid() and start > 0,
               'current launcher parent required')
    observed = process_identity(pid)
    setup.need(observed is not None and observed['start_ticks'] == start
               and observed['state'] not in ('Z', 'X'), 'launcher identity mismatch')
    return observed


def stop_payload(plan):
    return {'schema': 'metaviewer-arm64-stop/v1', 'run_id': plan['run_id'],
            'launcher': plan['launcher'], 'outer': plan['outer']}


def request_stop(root, plan):
    path = root / 'STOP_REQUESTED'
    if path.exists() or path.is_symlink():
        setup.need(setup.decode(setup.read(path, private=True)) == stop_payload(plan), 'foreign stop record')
    else:
        setup.write_new(path, stop_payload(plan))


def custody_open(root, plan):
    stop = root / 'STOP_REQUESTED'
    if stop.exists() or stop.is_symlink():
        setup.need(setup.decode(setup.read(stop, private=True)) == stop_payload(plan), 'stop record unknown')
        return False
    return process_alive(plan['launcher']) and process_alive(plan['outer'])


def effect_guard(root, plan):
    setup.need(custody_open(root, plan), 'launcher/owner stopped before effect')


def inventory_module(value):
    setup.pin(value['reconciler'], 1 << 20)
    spec = importlib.util.spec_from_file_location('arm64_session_inventory', value['reconciler']['path'])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    setup.pin(value['reconciler'], 1 << 20)
    return module


def inventory_append(root, module, stage, **fields):
    return module.append_inventory(root / 'inventory-config.json', 'setup',
        {'stage': stage, 'producer': 'setup', **fields}, Path(__file__).resolve())


def initialize_inventory(value, root, plan, module):
    images = {'vm': value['vm_image']}
    images.update({kind: recipe['image_id'] for kind, recipe in value.get('normal_profiles', {}).items()})
    config = {'schema': 'arm64-resource-inventory-config/v1', 'journal': str(root / 'allocations.jsonl'),
              'root': str(root), 'run_id': plan['run_id'],
              'actor': 'actor-' + setup.digest(('agent:agent-arm64-' + plan['run_id']).encode()),
              'source_commit': plan['expected_commit'], 'asar_sha256': value['package']['asar']['sha256'],
              'session_helper_sha256': plan['script_sha256'], 'setup_helper_sha256': plan['setup_helper_sha256'],
              'producer_pins': value['producer_pins'], 'package_manifest': value['package_manifest'],
              'registry_sha256': plan['registry_sha256'], 'images': images}
    if 'identity_provisioner' in value:
        config['identity_provisioner'] = value['identity_provisioner']
    setup.write_new(root / 'inventory-config.json', config)
    setup.write_bytes_new(root / 'allocations.lock', b'')
    setup.write_bytes_new(root / 'allocations.jsonl', b'')
    st = root.stat()
    header = {k: config[k] for k in ('run_id', 'actor', 'source_commit', 'asar_sha256',
              'session_helper_sha256', 'setup_helper_sha256', 'producer_pins', 'package_manifest', 'registry_sha256')}
    inventory_append(root, module, 'session', unit=plan['unit'], root_device=st.st_dev, root_inode=st.st_ino, **header)


def guardian_witness(unit, group):
    raw = setup.run(['/usr/bin/systemctl', '--user', 'show', unit,
                     '--property=ActiveState,ControlGroup,InvocationID'], env=manager_environment(), timeout=5)
    props = dict(x.split('=', 1) for x in raw.decode().splitlines() if '=' in x)
    setup.need(props.get('ActiveState') == 'active' and props.get('ControlGroup') == group
               and re.fullmatch('[0-9a-f]{32}', props.get('InvocationID', '')), 'guardian invocation unknown')
    p = setup.canonical('/sys/fs/cgroup' + group)
    st = p.lstat()
    setup.need(stat.S_ISDIR(st.st_mode), 'guardian cgroup inode unknown')
    return {'unit': unit, 'invocation': props['InvocationID'], 'cgroup': group,
            'device': st.st_dev, 'inode': st.st_ino}


def stop_guardian(witness):
    # Fresh source-bound identity is required for this bounded fallback.
    setup.need(verify_scope(witness['unit']) == witness['cgroup']
               and guardian_witness(witness['unit'], witness['cgroup']) == witness, 'guardian identity changed')
    setup.run(['/usr/bin/systemctl', '--user', 'stop', witness['unit']],
              env=manager_environment(), timeout=5)


def wait_app(app, identity, root, plan, guardian, inventory):
    """Single monitor; never signal a foreign or reused process tuple."""
    while app.poll() is None:
        try:
            live = custody_open(root, plan)
        except setup.Refused:
            live = False
        if not live:
            record(root, 'app_stop_requested')
            setup.need(process_alive(identity), 'app identity unknown before terminate')
            app.terminate()
            try:
                return app.wait(timeout=5)
            except subprocess.TimeoutExpired:
                record(root, 'app_stop_unknown')
                inventory_append(root, inventory, 'unknown', id='app', reason='app_termination_timeout')
                stop_guardian(guardian)
                raise setup.Refused('app termination deadline expired')
        time.sleep(0.1)
    return app.returncode


def monitor_scope(start, root, plan):
    """Keep the outer custodian alive while forwarding stop as durable intent."""
    stop = [False]
    previous = {}
    def caught(signum, frame):
        stop[0] = True
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        previous[sig] = signal.signal(sig, caught)
    try:
        effect_guard(root, plan)
        if stop[0]:
            request_stop(root, plan)
            raise setup.Refused('stop before scope launch')
        child = start()
        while child.poll() is None:
            try:
                alive = custody_open(root, plan)
            except (ValueError, OSError):
                alive = False
            if stop[0] or not alive:
                request_stop(root, plan)
            time.sleep(0.1)
        return child.returncode
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def scope_args(unit, python, script, root):
    return ['/usr/bin/systemd-run', '--user', '--scope', '--quiet', '--collect',
            '--unit=' + unit, '--slice=newton-ia.slice', '-p', 'MemoryHigh=6G',
            '-p', 'MemoryMax=8G', '-p', 'MemorySwapMax=0', '-p', 'CPUQuota=200%',
            '-p', 'TasksMax=256', python, '-I', '-B', script, '--internal-root', str(root)]


def manager_environment():
    """User-manager authority is distinct from the admitted UI bus."""
    uid = os.getuid()
    return {'PATH': '/usr/bin:/bin', 'XDG_RUNTIME_DIR': '/run/user/' + str(uid),
            'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/' + str(uid) + '/bus'}


def xauthority_identity(value):
    path = value['xauthority']
    if value['mode'] == 'trusted-user-invocation' and path in (None, ''):
        return None
    p = setup.canonical(path)
    s = p.lstat()
    setup.need(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and s.st_nlink == 1
               and not s.st_mode & 0o022 and 0 < s.st_size <= 65536, 'UI Xauthority metadata')
    if value['mode'] == 'private-ui':
        setup.need(not s.st_mode & 0o077, 'private Xauthority required')
    # Credential bytes are never read or copied.
    return [s.st_dev, s.st_ino, s.st_uid, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns]


def ui_transport(value):
    setup.closed(value, ('schema', 'mode', 'display', 'xauthority', 'dbus_session_bus_address'))
    setup.need(value['schema'] == 'metaviewer-arm64-ui-transport/v1'
               and value['mode'] in ('private-ui', 'trusted-user-invocation')
               and type(value['display']) is str and re.fullmatch(r':[0-9]+(?:\.[0-9]+)?', value['display']),
               'explicit UI display required')
    # No address is silently inherited from the operator shell.
    xauthority_identity(value)
    address = value['dbus_session_bus_address']
    match = re.fullmatch(r'unix:path=([^,;%]+)(?:,guid=[0-9a-f]{32})?', address) if type(address) is str else None
    setup.need(match is not None, 'explicit private UI bus required')
    bus = setup.canonical(match[1])
    observed = bus.lstat()
    setup.private_dir(bus.parent)
    setup.need(stat.S_ISSOCK(observed.st_mode) and observed.st_uid == os.getuid()
               and (value['mode'] == 'trusted-user-invocation'
                    or str(bus) != '/run/user/' + str(os.getuid()) + '/bus'), 'admitted UI socket required')
    return value


def ui_bus_identity(value):
    address = re.fullmatch(r'unix:path=([^,;%]+)(?:,guid=[0-9a-f]{32})?', value['dbus_session_bus_address'])
    setup.need(address is not None, 'UI bus identity unavailable')
    s = setup.canonical(address[1]).lstat()
    return [s.st_dev, s.st_ino, s.st_uid, s.st_mode]


def verify_scope(unit):
    raw = setup.run(['/usr/bin/systemctl', '--user', 'show', unit,
                     '--property=ActiveState,ControlGroup,MemoryHigh,MemoryMax,MemorySwapMax,TasksMax,CPUQuotaPerSecUSec,Slice'],
                    env=manager_environment(), timeout=5)
    rows = dict(x.split('=', 1) for x in raw.decode().splitlines() if '=' in x)
    group = rows.get('ControlGroup', '')
    prefix = '/user.slice/user-%d.slice/user@%d.service/' % (os.getuid(), os.getuid())
    allowed = {prefix + 'newton-ia.slice/' + unit, prefix + 'newton.slice/newton-ia.slice/' + unit}
    setup.need(rows.get('ActiveState') == 'active' and group in allowed
               and rows.get('Slice') == 'newton-ia.slice'
               and Path('/proc/self/cgroup').read_text().strip() == '0::' + group,
               'owned guardian cgroup mismatch')
    setup.need(rows.get('MemoryHigh') == str(6 * 1024**3)
               and rows.get('MemoryMax') == str(8 * 1024**3)
               and rows.get('MemorySwapMax') == '0' and rows.get('TasksMax') == '256'
               and rows.get('CPUQuotaPerSecUSec') == '2s', 'guardian limits mismatch')
    # Check the actual shared slice identity separately from the leaf limits.
    slice_raw = setup.run(['/usr/bin/systemctl', '--user', 'show', 'newton-ia.slice',
                           '--property=ActiveState,ControlGroup,MemoryMax,TasksMax'], env=manager_environment(), timeout=5)
    parent = dict(x.split('=', 1) for x in slice_raw.decode().splitlines() if '=' in x)
    setup.need(parent.get('ActiveState') == 'active' and parent.get('ControlGroup') == group.rsplit('/', 1)[0]
               and parent.get('MemoryMax', '').isdigit() and 0 < int(parent['MemoryMax']) <= 100 * 1024**3
               and parent.get('TasksMax', '').isdigit() and 0 < int(parent['TasksMax']) <= 32768,
               'shared slice observation mismatch')
    return group


def helper_identity(obj, cid, name, image, payload, run_id):
    setup.need(type(obj) is dict and obj.get('Id') == cid and obj.get('Name') == '/' + name
               and obj.get('Image') == image, 'foreign helper identity')
    c, h = obj.get('Config', {}), obj.get('HostConfig', {})
    setup.need(c.get('Labels', {}).get('metaviewer.arm64-session') == run_id
               and c.get('Entrypoint') == ['/usr/bin/chown']
               and c.get('Cmd') == ['10001:10001', '/payload'] and c.get('User') == '0:0',
               'helper command mismatch')
    cap = lambda x: [v.removeprefix('CAP_') for v in x] if type(x) is list else None
    setup.need(h.get('NetworkMode') == 'none' and h.get('ReadonlyRootfs') is True
               and h.get('Memory') == 128 * 1024**2 and h.get('MemorySwap') == h.get('Memory')
               and h.get('PidsLimit') == 16 and h.get('NanoCpus') == 250000000
               and cap(h.get('CapAdd')) == ['CHOWN'] and cap(h.get('CapDrop')) == ['ALL']
               and h.get('Privileged') is False
               and h.get('SecurityOpt') in (['no-new-privileges'], ['no-new-privileges=true']),
               'helper confinement mismatch')
    mounts = obj.get('Mounts', [])
    requested = h.get('Mounts', [])
    setup.need(len(mounts) == len(requested) == 1
               and mounts[0].get('Source') == requested[0].get('Source') == str(payload)
               and mounts[0].get('Destination') == requested[0].get('Target') == '/payload'
               and mounts[0].get('Type') == requested[0].get('Type') == 'bind', 'helper mount mismatch')


def native_environment(root):
    return {'PATH': '/usr/bin:/bin', 'HOME': str(root / 'home'), 'LANG': 'C.UTF-8',
            'XDG_RUNTIME_DIR': str(root / 'host-runtime'),
            'SRF_IDENTITY_STORE_ROOT': str(root / 'store'),
            'MV_SRF_STATE_DIR': str(root / 'native-state'),
            'SRF_PROXY_REGISTRY': str(root / 'proxy-registry.json')}


def provision(value, root, run_id, command=setup.run, kind='vm', guard=None, inventory=None):
    """Exact fresh native identity and constrained CHOWN helper; no guest start."""
    env = native_environment(root)
    setup.need(callable(guard), 'effect custody guard required')
    def checked(argv, **kwargs):
        guard()
        return command(argv, **kwargs)
    guard()
    setup.need(kind in ('vm', 'browser', 'program'), 'closed native recipe')
    profile = ('mv-arm64-' if kind == 'vm' else 'arm64-' + kind + '-') + run_id
    recipe = value.get('normal_profiles', {}).get(kind) if kind != 'vm' else None
    setup.need(kind == 'vm' or recipe is not None, 'normal profile recipe missing')
    image = value['vm_image'] if kind == 'vm' else recipe['image_id']
    admin = value['native']['srf-identity-admin']['path']
    record(root, 'identity_create_pending', profile=profile)
    argv = [admin, 'create', '--store-root', env['SRF_IDENTITY_STORE_ROOT'], '--id', profile,
            '--label', 'ARM64 ' + kind]
    argv += ['--domains', ','.join(recipe['domains'])] if kind == 'browser' else ['--browser', 'program']
    checked(argv, env=env)
    identity = setup.decode(checked([admin, 'show', '--store-root', env['SRF_IDENTITY_STORE_ROOT'],
                                     '--id', profile], env=env))
    setup.need(identity.get('profile_id') == profile
               and identity.get('browser') == ('chromium' if kind == 'browser' else 'program'),
               'native identity mismatch')
    payload = setup.private_dir(root / 'store' / 'profiles' / profile)
    fd = os.open(payload, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        setup.need(not os.listdir(fd), 'fresh empty payload required')
        helper = 'mv-arm64-payload-' + kind + '-' + run_id
        record(root, 'helper_create_pending', name=helper, payload=str(payload),
               inode=[before.st_dev, before.st_ino])
        if inventory is not None:
            inventory_append(root, inventory, 'helper_pending', id=helper, name=helper,
                image_id=image, payload=str(payload), payload_device=before.st_dev, payload_inode=before.st_ino)
        argv = ['/usr/bin/docker', 'create', '--name', helper, '--label',
                'metaviewer.arm64-session=' + run_id, '--user', '0:0', '--network', 'none',
                '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt',
                'no-new-privileges', '--memory', '128m', '--memory-swap', '128m',
                '--pids-limit', '16', '--cpus', '0.25', '--mount',
                'type=bind,src=' + str(payload) + ',dst=/payload', '--entrypoint',
                '/usr/bin/chown', image, '10001:10001', '/payload']
        cid = checked(argv, env={'PATH': '/usr/bin:/bin'}).decode().strip()
        setup.need(re.fullmatch('[0-9a-f]{64}', cid), 'helper create outcome unknown')
        record(root, 'helper_bound', cid=cid)
        if inventory is not None:
            inventory_append(root, inventory, 'helper_bound', id=helper, cid=cid)

        def inspect():
            rows = setup.decode(checked(['/usr/bin/docker', 'container', 'inspect', cid]))
            setup.need(type(rows) is list and len(rows) == 1, 'helper inspect unknown')
            helper_identity(rows[0], cid, helper, image, payload, run_id)
            return rows[0]

        inspect()
        now = payload.lstat()
        setup.need((now.st_dev, now.st_ino) == (before.st_dev, before.st_ino)
                   and not os.listdir(fd), 'payload changed before helper')
        record(root, 'helper_start_pending', cid=cid)
        checked(['/usr/bin/docker', 'start', '--attach', cid])
        obj = inspect()
        after = os.fstat(fd)
        now = payload.lstat()
        setup.need(obj.get('State', {}).get('Status') == 'exited'
                   and type(obj['State'].get('ExitCode')) is int and obj['State']['ExitCode'] == 0
                   and (after.st_dev, after.st_ino) == (before.st_dev, before.st_ino)
                   and (now.st_dev, now.st_ino) == (before.st_dev, before.st_ino)
                   and after.st_uid == after.st_gid == 10001
                   and stat.S_IMODE(after.st_mode) == 0o700, 'payload ownership unknown')
        checked(['/usr/bin/docker', 'rm', cid])
        ids = checked(['/usr/bin/docker', 'container', 'ls', '--all', '--no-trunc',
                       '--format', '{{.ID}}']).decode().splitlines()
        setup.need(all(re.fullmatch('[0-9a-f]{64}', x) for x in ids) and cid not in ids,
                   'helper removal unknown')
        if inventory is not None:
            inventory_append(root, inventory, 'helper_removed', id=helper)
        record(root, 'identity_ready', profile=profile, helper_removed=True)
        return profile
    finally:
        os.close(fd)


def session_root_prefix(run_id, rewind=False):
    setup.need(type(rewind) is bool, 'explicit rewind mode required')
    setup.need(type(run_id) is str and re.fullmatch('[0-9a-f]{24}', run_id), 'session run identity')
    return 'metaviewer-arm64-' + run_id + '-'


def allocate_session_root(run_id, rewind=False, base='/dev/shm'):
    prefix = session_root_prefix(run_id, rewind)
    if not rewind:
        return Path(tempfile.mkdtemp(prefix=prefix, dir=base))
    # The run already has 96 bits of fresh randomness. Exclusive creation never
    # reuses a stale directory, and omitting another suffix preserves sun_path.
    root = Path(base) / prefix
    root.mkdir(mode=0o700)
    return root


def runtime_directory(root, rewind=False):
    return root / ('r' if rewind else 'runtime')


def rewind_sources(value):
    """Use only the exact rewind closure sealed by this package's manifest."""
    source = setup.canonical(value['source_root'])
    package = setup.canonical(str(Path(value['package']['app']['path']).parent))
    try:
        source.relative_to(package)
    except ValueError as error:
        raise setup.Refused('rewind source must belong to the admitted package') from error
    manifest = setup.pin(value['package_manifest'], 16 << 20).decode('utf-8', errors='strict')
    entries = {}
    for line in manifest.splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})(?: ([0-7]{4})  | ([ *]))(.+)', line)
        setup.need(match is not None, 'rewind package manifest syntax')
        sha, mode, mark, relative = match.groups()
        setup.need(not relative.startswith('/') and '\\' not in relative
                   and all(part not in ('', '.', '..') for part in relative.split('/'))
                   and relative not in entries, 'rewind package manifest identity')
        entries[relative] = (sha, int(mode, 8) if mode else (0o755 if mark == '*' else 0o644))
    normal = ['guest_command_runtime/' + n + '.py' for n in
              ('__init__', '_schemas', 'wire', 'schema', 'config', 'image', 'native_checks', 'protocol')]
    names = normal + ['rewind_runtime/' + n + '.py' for n in ('__init__', 'config', 'native', 'controller')]
    files = []
    for name in names + ['tools/rewind_runner.py']:
        path = setup.canonical(str(source / 'daemon-adapter' / name))
        relative = str(path.relative_to(package))
        setup.need(relative in entries, 'rewind source missing from package manifest')
        sha, mode = entries[relative]
        setup.need(stat.S_IMODE(path.lstat().st_mode) == mode, 'rewind source mode differs from manifest')
        pin = {'path': str(path), 'sha256': sha}
        setup.pin(pin, 2 << 20)
        if name == 'tools/rewind_runner.py':
            runner = pin
        else:
            files.append({'relative': name, **pin})
    return runner, files


def build_profile(value, root, agent, unit, group, rewind=False):
    setup.need(type(rewind) is bool, 'explicit rewind mode required')
    if rewind:
        # Go's service root and Python's native root both add bounded suffixes.
        worst = str(runtime_directory(root, True) / 'headless-4294967295/rewind-12345678/vsock.sock_52')
        setup.need(len(os.fsencode(worst)) <= 107, 'rewind Unix socket path budget')
    runner, files = rewind_sources(value) if rewind else (value['runner'], value['files'])
    owner = 'actor-' + setup.digest(('agent:' + agent).encode())
    assets = {}
    for name, asset in value['artifacts'].items():
        raw = setup.pin(asset)
        target = root / 'assets' / name
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o500 if name != 'kernel' else 0o400)
        with os.fdopen(fd, 'wb') as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        assets[name] = {'path': str(target), 'sha256': asset['sha256']}
    config = {'schema': 'guest-command-host-config/v1', 'owner_id': owner, 'generation': 1,
              'runtime_admitted': True, 'artifacts': assets, 'runtime_root': str(runtime_directory(root, rewind)),
              'external_cgroup': '/sys/fs/cgroup' + group, 'startup_seconds': 20, 'stop_seconds': 5}
    if rewind:
        config.update(schema='rewind-host-config/v1', startup_seconds=10)
        del config['generation']
    return {'schema': 'mv-rewind-host/v1' if rewind else 'mv-guest-command-host/v1', 'owner_id': owner, 'guardian_unit': unit,
            'python': value['python'], 'python_prefix': value['python_prefix'],
            'runner': runner, 'controller_relative': 'rewind_runtime/controller.py' if rewind else 'guest_command_runtime/controller.py',
            'files': files, 'config_template': config,
            'state_root': str(root / 'state'), 'runtime_root': str(runtime_directory(root, rewind))}


def child_environment(value, root, agent, profile, transport, normal=None, hosted=False, *, rewind=False, guardian=None):
    # The only display/auth authority is the explicit protected UI descriptor.
    env = native_environment(root)
    env.update(DISPLAY=transport['display'],
               DBUS_SESSION_BUS_ADDRESS=transport['dbus_session_bus_address'],
               XDG_CONFIG_HOME=str(root / 'config'), XDG_DATA_HOME=str(root / 'data'),
               XDG_STATE_HOME=str(root / 'app-state'), XDG_CACHE_HOME=str(root / 'cache'),
               TMPDIR=str(root / 'tmp'))
    if transport['xauthority']:
        env['XAUTHORITY'] = transport['xauthority']
    if hosted:
        env['MV_HOSTED'] = '1'
    profiles = {profile: {'Kind': 'vm', 'NativeKind': 'vm',
                   'Program': 'notepad-vm', 'RAMRoot': str(root / 'frames'), 'Display': ':100',
                   'Width': 1280, 'Height': 900, 'NestedDepth': 0, 'default_mode': 'agent', 'text_input': 'type'}}
    if normal and 'browser' in normal:
        profiles[normal['browser']] = {'Kind': 'browser', 'NativeKind': 'browser',
            'RAMRoot': str(root / 'frames'), 'Display': ':101', 'Width': 1280,
            'Height': 900, 'default_mode': 'agent', 'text_input': 'paste'}
    env.update(MV_ARM64_CAPSULES='1', MV_GUEST_COMMAND_PROFILE=str(root / 'guest-profile.json'),
               MV_GUEST_COMMAND_AGENT_INSTANCE=agent,
               MV_SRF_BIN_DIR=str(Path(value['native']['srf-identity-admin']['path']).parent),
               MV_SRF_PROFILES=json.dumps(profiles, separators=(',', ':')))
    # The sole production caller runs only after real host admission and all
    # configured fresh profile provisioning. This is host metadata, not IPC.
    env['MV_ARM64_CAPSULE_STATUS'] = json.dumps({
        'vm': {'available': True, 'reason': ''},
        'microvm': {'available': True, 'reason': ''}}, separators=(',', ':'))
    env['MV_ARM64_INVENTORY_CONFIG'] = str(root / 'inventory-config.json')
    if rewind:
        setup.need(type(rewind) is bool and type(guardian) is str and guardian, 'rewind guardian required')
        env.update(MV_REWIND_ENABLED='1', MV_REWIND_PROFILE=str(root / 'guest-profile.json'),
                   MV_REWIND_AGENT_INSTANCE=agent, MV_REWIND_GUARDIAN_UNIT=guardian)
    # Normal browser/program profiles supplied by a future registry version must
    # be admitted explicitly, never merged from untrusted stale environment.
    return env


def ui_bus_policy():
    # Keep desktop integration, but never expose the user manager to Chromium.
    # Portal registration otherwise moves Electron out of its guardian scope.
    return ['--filter', '--talk=org.freedesktop.portal.Desktop',
            '--talk=org.freedesktop.portal.Documents', '--talk=org.freedesktop.Notifications',
            '--talk=org.a11y.Bus', '--talk=ca.desrt.dconf', '--talk=org.gtk.vfs.*']


def ui_bus_address(root):
    return 'unix:path=' + str(root / 'host-runtime' / 'ui-bus')


def ui_bus_executable():
    binary = Path('/usr/bin/xdg-dbus-proxy').resolve(strict=True)
    info = binary.stat()
    setup.need(stat.S_ISREG(info.st_mode) and info.st_uid == 0
               and not info.st_mode & 0o022 and info.st_mode & 0o111,
               'protected desktop bus proxy required')
    return str(binary)


@contextmanager
def guarded_ui_bus(root, transport, group):
    # The original UI bus remains bound by PLAN and its socket identity. Only
    # Electron receives this filtered endpoint; manager operations use their
    # separate explicit bus. The proxy inherits the original guardian cgroup.
    endpoint = root / 'host-runtime' / 'ui-bus'
    setup.need(not endpoint.exists() and not endpoint.is_symlink(), 'UI bus endpoint already exists')
    parent, child = socket.socketpair()
    proxy = None
    try:
        proxy = subprocess.Popen([ui_bus_executable(), '--fd=' + str(child.fileno()),
                                  transport['dbus_session_bus_address'], str(endpoint), *ui_bus_policy()],
                                 env=manager_environment(), pass_fds=(child.fileno(),))
        child.close()
        ready, _, _ = select.select([parent], [], [], 5)
        setup.need(bool(ready) and len(parent.recv(1)) == 1 and proxy.poll() is None,
                   'UI bus proxy readiness unknown')
        identity = process_identity(proxy.pid)
        setup.need(identity is not None and identity['cgroup'] == group,
                   'UI bus proxy outside guardian')
        info = endpoint.lstat()
        setup.need(stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid(), 'UI bus proxy socket custody')
        setup.write_new(root / 'ui-bus-proxy.json', {'process': identity,
                        'upstream': transport['dbus_session_bus_address'], 'endpoint': str(endpoint),
                        'policy': ui_bus_policy()})
        yield ui_bus_address(root)
    finally:
        child.close()
        parent.close()  # --fd shutdown; never signal an unbound PID.
        if proxy is not None:
            setup.need(proxy.wait(timeout=5) == 0, 'UI bus proxy closure unknown')


def internal(root):
    root = setup.private_dir(root)
    plan = setup.decode(setup.read(root / 'PLAN.json', private=True))
    setup.closed(plan, ('schema', 'run_id', 'unit', 'app', 'source_root', 'expected_commit', 'registry_sha256', 'script_sha256', 'setup_helper_sha256', 'ui_transport', 'ui_xauthority_identity', 'ui_bus_identity', 'hosted', 'launcher', 'outer') + (('rewind',) if 'rewind' in plan else ()))
    rewind = plan.get('rewind', False)
    setup.need(type(rewind) is bool, 'explicit rewind mode required')
    setup.need(plan['schema'] == 'metaviewer-arm64-session/v1'
               and root.name.startswith(session_root_prefix(plan['run_id'], rewind))
               and plan['unit'] == 'metaviewer-arm64-' + plan['run_id'] + '.scope', 'session identity')
    setup.need(setup.digest(setup.read(__file__, 1 << 20)) == plan['script_sha256'], 'session helper changed')
    setup.need(setup.digest(setup.read(setup.__file__, 1 << 20)) == plan['setup_helper_sha256'], 'setup helper changed')
    setup.need(not list(root.glob('event-*.json')), 'session already attempted')
    registry = setup.read(setup.registry_path(), private=True)
    setup.need(setup.digest(registry) == plan['registry_sha256'], 'registry changed')
    value = setup.validate(setup.decode(registry))
    if rewind:
        rewind_sources(value)
    setup.need(value['source_commit'] == plan['expected_commit'], 'sealed package/source mismatch')
    setup.interpreter_check(value)
    transport = ui_transport(plan['ui_transport'])
    setup.need(xauthority_identity(transport) == plan['ui_xauthority_identity'] and type(plan['hosted']) is bool,
               'UI authority changed since admission')
    setup.need(ui_bus_identity(transport) == plan['ui_bus_identity'], 'UI bus changed since admission')
    setup.need(plan['app'] == value['package']['app']['path']
               and plan['source_root'] == value['source_root'], 'launcher/package mismatch')
    group = verify_scope(plan['unit'])
    effect_guard(root, plan)
    inventory = inventory_module(value)
    initialize_inventory(value, root, plan, inventory)
    guardian = guardian_witness(plan['unit'], group)
    setup.write_new(root / 'guardian.json', guardian)
    inventory_append(root, inventory, 'guardian_bound', id='guardian', **guardian)
    setup.write_new(root / 'inner-process.json', process_identity(os.getpid()))
    record(root, 'session_admitted', guardian=plan['unit'], cgroup=group)
    setup.host_check(value)
    memory = int(next(x.split()[1] for x in Path('/proc/meminfo').read_text().splitlines()
                      if x.startswith('MemAvailable:'))) * 1024
    setup.need(memory >= 32 * 1024**3, 'combined ARM session memory floor')
    guard = lambda: effect_guard(root, plan)
    profile = provision(value, root, plan['run_id'], guard=guard, inventory=inventory)
    normal = {kind: provision(value, root, plan['run_id'], kind=kind, guard=guard, inventory=inventory)
              for kind in ('browser', 'program') if kind in value.get('normal_profiles', {})}
    agent = 'agent-arm64-' + plan['run_id']
    protected = build_profile(value, root, agent, plan['unit'], group, rewind=rewind)
    setup.write_new(root / 'guest-profile.json', protected)
    env = child_environment(value, root, agent, profile, transport, normal, plan['hosted'], rewind=rewind, guardian=plan['unit'])
    # Rehash immediately before the sole application side effect.
    setup.pin(value['package']['app'])
    setup.pin(value['package']['asar'])
    guard()
    inventory_append(root, inventory, 'app_pending', id='app')
    record(root, 'app_spawn_pending', agent_instance=agent, actor=protected['owner_id'])
    guard()
    with guarded_ui_bus(root, transport, group) as ui_bus:
        env['DBUS_SESSION_BUS_ADDRESS'] = ui_bus
        app = subprocess.Popen([plan['app']], env=env, cwd=str(root / 'home'))
        identity = process_identity(app.pid)
        setup.need(identity is not None and identity['cgroup'] == group, 'app start binding unknown')
        inventory_append(root, inventory, 'app_bound', id='app', pid=app.pid,
                         start_ticks=identity['start_ticks'], cgroup=identity['cgroup'])
        record(root, 'app_spawned', pid=app.pid)
        rc = wait_app(app, identity, root, plan, guardian, inventory)
    record(root, 'app_exited_closure_unproven', returncode=rc)
    inventory.seal_inventory(root / 'inventory-config.json', 'setup', Path(__file__).resolve())
    return rc


def launch(app, source_root, transport_path, expected_commit, launcher_pid, launcher_start, rewind=False):
    setup.need(type(rewind) is bool, 'explicit rewind mode required')
    setup.need(os.environ.get('MV_ARM64_CAPSULES') != '1', 'already internal session')
    launcher = bind_launcher(launcher_pid, launcher_start)
    outer = process_identity(os.getpid())
    setup.need(outer is not None and outer['state'] not in ('Z', 'X'), 'outer identity unknown')
    value = setup.load_registry()
    setup.need(type(expected_commit) is str and re.fullmatch('[0-9a-f]{40}', expected_commit)
               and expected_commit == value['source_commit'], 'sealed package/source mismatch')
    setup.interpreter_check(value)
    ui_bus_executable()  # Refuse an unavailable/unsafe proxy before holding a session.
    if rewind:
        rewind_sources(value)  # Refuse missing or changed closure before custody/effects.
    # Both helper files must be installed protected before even a held marker.
    script = str(Path(__file__).resolve())
    helper_hash = setup.digest(setup.read(script, 1 << 20))
    setup_hash = setup.digest(setup.read(setup.__file__, 1 << 20))
    transport = ui_transport(setup.decode(setup.read(transport_path, private=True)))
    setup.need(app == value['package']['app']['path'] and source_root == value['source_root'],
               'explicit launcher binding mismatch')
    setup.host_check(value)
    directory = setup.private_dir(setup.registry_path().parent)
    lock = os.open(directory / 'session.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        s = os.fstat(lock)
        setup.need(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid()
                   and s.st_nlink == 1 and stat.S_IMODE(s.st_mode) == 0o600, 'session lock custody')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        setup.need(not (directory / 'held-session.json').exists(), 'previous session requires reconciliation')
        run_id = secrets.token_hex(12)
        root = allocate_session_root(run_id, rewind)
        for name in ('home', 'native-state', 'store', 'frames', 'assets', 'state', 'r' if rewind else 'runtime',
                     'host-runtime', 'config', 'data', 'app-state', 'cache', 'tmp'):
            (root / name).mkdir(mode=0o700)
        unit = 'metaviewer-arm64-' + run_id + '.scope'
        plan = {'schema': 'metaviewer-arm64-session/v1', 'run_id': run_id, 'unit': unit,
                'app': app, 'source_root': source_root, 'expected_commit': expected_commit,
                'registry_sha256': setup.digest(setup.read(setup.registry_path(), private=True)),
                'script_sha256': helper_hash, 'setup_helper_sha256': setup_hash,
                'ui_transport': transport,
                'ui_xauthority_identity': xauthority_identity(transport),
                'ui_bus_identity': ui_bus_identity(transport),
                'hosted': os.environ.get('MV_HOSTED') == '1', 'launcher': launcher, 'outer': outer, 'rewind': rewind}
        setup.write_bytes_new(root / 'setup.json', setup.read(setup.registry_path(), private=True))
        setup.write_new(root / 'PLAN.json', plan)
        effect_guard(root, plan)
        publish_held_marker(directory, {'root': str(root), 'unit': unit, 'status': 'closure-unproven'})
        manager_env = manager_environment()
        manager_env['XDG_DATA_HOME'] = str(setup.registry_path().parents[3])
        result = monitor_scope(lambda: subprocess.Popen(
            scope_args(unit, value['python']['path'], script, root), env=manager_env), root, plan)
        # The held marker remains the admission fence while the trusted
        # reconciler acquires session.lock independently after the scope ends.
        fcntl.flock(lock, fcntl.LOCK_UN)
        inventory = inventory_module(value)
        try:
            inventory.seal_coordinator(root / 'inventory-config.json', Path(__file__).resolve())
            inventory.reconcile_held(directory / 'held-session.json', release=True)
        except (ValueError, OSError, subprocess.SubprocessError):
            return 2  # no reset, retry, guessed resource cleanup or false close
        return result
    finally:
        os.close(lock)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--app')
    p.add_argument('--source-root')
    p.add_argument('--internal-root')
    p.add_argument('--ui-transport')
    p.add_argument('--expected-commit')
    p.add_argument('--launcher-pid', type=int)
    p.add_argument('--launcher-start', type=int)
    p.add_argument('--rewind', action='store_true', help='Enable the sealed ARM64 rewind backend in the normal capsule session')
    args = p.parse_args()
    try:
        if args.internal_root:
            setup.need(not args.app and not args.source_root and not args.ui_transport and not args.expected_commit
                       and args.launcher_pid is None and args.launcher_start is None and not args.rewind, 'internal arity')
            return internal(args.internal_root)
        setup.need(bool(args.app and args.source_root and args.ui_transport and args.expected_commit), 'explicit app/source/UI binding required')
        return launch(args.app, args.source_root, args.ui_transport, args.expected_commit,
                      args.launcher_pid, args.launcher_start, rewind=args.rewind)
    except (ValueError, OSError, subprocess.SubprocessError):
        if args.internal_root:
            # Failure after an uncertain Popen still has a captured own scope.
            # Never guess a PID; stop only its freshly matching invocation/inode.
            try:
                root = setup.private_dir(args.internal_root)
                guardian = setup.decode(setup.read(root / 'guardian.json', private=True))
                setup.closed(guardian, ('unit', 'invocation', 'cgroup', 'device', 'inode'))
                try:
                    plan = setup.decode(setup.read(root / 'PLAN.json', private=True))
                    raw = setup.read(root / 'setup.json', private=True)
                    setup.need(type(plan) is dict and setup.digest(raw) == plan.get('registry_sha256'), 'registry changed')
                    value = setup.decode(raw)
                    inventory_append(root, inventory_module(value), 'unknown', id='setup', reason='setup_or_app_failure')
                except (ValueError, OSError, subprocess.SubprocessError):
                    pass  # failed/partial inventory remains unsealed and held
                stop_guardian(guardian)
            except (ValueError, OSError, subprocess.SubprocessError):
                pass  # custody remains held; never infer clean close
        print('ARM64_SESSION_REFUSED: retained state requires inspection')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
