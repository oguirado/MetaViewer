"""Private service entrypoint. No renderer input chooses code or host paths."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys


def checked(path, digest):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError('source alias')
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError('regular source required')
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        st = os.fstat(source.fileno())
        if (not stat.S_ISREG(st.st_mode) or st.st_size > 2 * 1024 * 1024
                or (st.st_dev, st.st_ino) != (before.st_dev, before.st_ino)
                or st.st_uid not in (0, os.getuid()) or st.st_mode & 0o022 or st.st_nlink != 1):
            raise ValueError('source bounds')
        raw = source.read(2 * 1024 * 1024 + 1)
        after = os.fstat(source.fileno())
        current = path.lstat()
        if (len(raw) > 2 * 1024 * 1024 or path.resolve() != path
                or (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                or (st.st_dev, st.st_ino) != (current.st_dev, current.st_ino)):
            raise ValueError('source changed during read')
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError('source pin')
    return raw


def relative_source(value):
    relative = Path(value)
    if relative.is_absolute() or '..' in relative.parts or str(relative) != value or relative.suffix not in ('.py', '.json'):
        raise ValueError('source path')
    return relative


def verify_caps(cg):
    if (cg / 'memory.max').read_text().strip() != str(512 * 1024 * 1024) or (cg / 'memory.swap.max').read_text().strip() != '0' or (cg / 'pids.max').read_text().strip() != '64':
        raise ValueError('service resource caps')
    quota, period = (cg / 'cpu.max').read_text().split()
    if quota == 'max' or int(quota) <= 0 or int(period) <= 0 or int(quota) > int(period):
        raise ValueError('service cpu cap')


def run(attempt):
    root = Path(attempt)
    if root.resolve() != root or root.stat().st_uid != os.getuid() or stat.S_IMODE(root.stat().st_mode) != 0o700:
        raise ValueError('attempt custody')
    spec = json.loads((root / 'launch.json').read_bytes())
    if set(spec) != {'files', 'config', 'state_dir', 'runtime_root', 'unit'}:
        raise ValueError('launch fields')
    sources = {}
    for item in spec['files']:
        relative = relative_source(item['relative'])
        sources[str(relative)] = checked(root / 'bundle' / relative, item['sha256'])
    for path in (spec['state_dir'], spec['runtime_root']):
        p = Path(path)
        if p.resolve() != p or p.stat().st_uid != os.getuid() or stat.S_IMODE(p.stat().st_mode) != 0o700:
            raise ValueError('private lifecycle directory')
    groups = Path('/proc/self/cgroup').read_text().splitlines()
    group = [line[3:] for line in groups if line.startswith('0::')]
    if len(group) != 1 or not group[0].endswith('/' + spec['unit']):
        raise ValueError('dedicated service required')
    cg = Path('/sys/fs/cgroup' + group[0])
    verify_caps(cg)
    config = spec['config']
    config['external_cgroup'] = str(cg)
    config['runtime_root'] = spec['runtime_root']
    # Insert only already verified local modules; -I removes user/site PATH inputs.
    for name in ('arm_backend', 'contract_guard'):
        filename = root / 'bundle' / 'mc06-controller' / (name + '.py')
        module_spec = importlib.util.spec_from_file_location(name, filename)
        module = importlib.util.module_from_spec(module_spec)
        sys.modules[name] = module
        exec(compile(sources['mc06-controller/' + name + '.py'], str(filename), 'exec'), module.__dict__)
    filename = root / 'bundle' / 'mc06-controller' / 'controller.py'
    module_spec = importlib.util.spec_from_file_location('mc09_controller', filename)
    module = importlib.util.module_from_spec(module_spec)
    exec(compile(sources['mc06-controller/controller.py'], str(filename), 'exec'), module.__dict__)
    controller = module.Controller(config, spec['state_dir'])
    print(json.dumps({'mc09_ready': True, 'cgroup': str(cg)}), flush=True)
    try:
        while True:
            line = sys.stdin.buffer.readline(module.MAX_RECORD + 1)
            if not line:
                break
            if len(line) > module.MAX_RECORD or not line.endswith(b'\n'):
                raise ValueError('request bound')
            for event in controller.handle(json.loads(line), config['owner_id']):
                print(module.encoded(event).decode(), flush=True)
    finally:
        controller.close()


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('one private attempt required')
    run(sys.argv[1])
