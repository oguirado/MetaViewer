"""Private service entrypoint. No renderer input chooses code or host paths."""
import hashlib
import importlib.util
import signal
import threading
import types
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
    if set(spec) != {'files', 'config', 'state_dir', 'runtime_root', 'unit', 'session_id'}:
        raise ValueError('launch fields')
    names = ('__init__', '_schemas', 'wire', 'schema', 'config', 'image', 'native_checks', 'native', 'protocol', 'storage', 'controller')
    sources = {}
    for item in spec['files']:
        relative = relative_source(item['relative'])
        if str(relative) in sources:
            raise ValueError('duplicate source')
        sources[str(relative)] = checked(root / 'bundle' / relative, item['sha256'])
    if set(sources) != {'guest_command_runtime/' + name + '.py' for name in names}:
        raise ValueError('closed package required')
    for path in (spec['state_dir'], spec['runtime_root']):
        p = Path(path)
        if p.resolve() != p or p.stat().st_uid != os.getuid() or stat.S_IMODE(p.stat().st_mode) != 0o700:
            raise ValueError('private lifecycle directory')
    groups = Path('/proc/self/cgroup').read_text().splitlines()
    group = [line[3:] for line in groups if line.startswith('0::')]
    if len(group) != 1 or not group[0].endswith('/' + spec['unit']):
        raise ValueError('dedicated service required')
    cg = Path('/sys/fs/cgroup' + group[0]); verify_caps(cg)
    config = spec['config']; config['external_cgroup'] = str(cg); config['runtime_root'] = spec['runtime_root']
    package = types.ModuleType('guest_command_runtime'); package.__path__ = []
    package.__file__ = str(root / 'bundle/guest_command_runtime/__init__.py')
    sys.modules['guest_command_runtime'] = package
    exec(compile(sources['guest_command_runtime/__init__.py'],package.__file__,'exec'),package.__dict__)
    for name in names[1:]:
        full = 'guest_command_runtime.' + name
        module = types.ModuleType(full); module.__package__ = 'guest_command_runtime'
        module.__file__ = str(root / ('bundle/guest_command_runtime/' + name + '.py'))
        sys.modules[full] = module; setattr(package,name,module)
        exec(compile(sources['guest_command_runtime/' + name + '.py'],module.__file__,'exec'),module.__dict__)
    controller = sys.modules['guest_command_runtime.controller'].Controller(
        config, spec['session_id'], spec['state_dir'],
        lambda event: print(json.dumps(event,ensure_ascii=False,separators=(',',':')),flush=True))
    input_failure = []
    def read_input():
        try:
            while True:
                line = sys.stdin.buffer.readline(262145)
                if not line: break
                if len(line)>262144 or not line.endswith(b'\n'): raise ValueError('request bound')
                request = sys.modules['guest_command_runtime.wire'].strict_object(line)
                controller.submit(request)
        except BaseException as error:
            input_failure.append(error)
        finally: controller.finish()
    thread=threading.Thread(target=read_input,daemon=True,name='guest-command-input')
    signal.signal(signal.SIGTERM,lambda *_: controller.finish())
    print(json.dumps({'guest_command_ready':True,'cgroup':str(cg)}),flush=True)
    thread.start(); controller.run()
    if input_failure: raise input_failure[0]

if __name__ == '__main__':
    if len(sys.argv) != 2: raise SystemExit('one private attempt required')
    run(sys.argv[1])
