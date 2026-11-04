#!/usr/bin/env python3
"""Run one app with fresh, exclusive Muse-writable session data, then remove it."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import tempfile


def private_directory(path):
    value = Path(path)
    info = value.lstat()
    if (not value.is_absolute() or value.resolve() != value
            or not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700
            or info.st_uid != os.getuid()):
        raise ValueError('MUSE_SESSION_PRIVATE_DIRECTORY_REQUIRED')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True)
    args = parser.parse_args()
    parent = private_directory(os.environ.get('XDG_RUNTIME_DIR', ''))
    app = Path(args.app)
    if not app.is_absolute() or not app.is_file() or not os.access(app, os.X_OK):
        raise ValueError('MUSE_SESSION_APP_REQUIRED')
    # Never let the packaged default put identity payloads in the writable root.
    identities = Path(os.environ.get('SRF_IDENTITY_STORE_ROOT', ''))
    if not identities.is_absolute() or not identities.is_dir() or identities.resolve() != identities:
        raise ValueError('MUSE_SESSION_EXTERNAL_IDENTITY_STORE_REQUIRED')
    root = Path(tempfile.mkdtemp(prefix='metaviewer-muse-', dir=parent))
    identity = root.stat()
    child = None
    handlers = {}
    try:
        os.chmod(root, 0o700)
        with (root / '.owner.json').open('x') as stream:
            os.chmod(stream.name, 0o600)
            proc_stat = Path('/proc/self/stat').read_text()
            start = proc_stat.rsplit(')', 1)[1].split()[19]
            json.dump({'schema': 'metaviewer.muse-session/v1', 'launcher_pid': os.getpid(), 'launcher_start': start}, stream)
        (root / 'memoryweb').mkdir(mode=0o700)
        env = dict(os.environ, MV_MUSE_WORKSPACE=str(root), XDG_RUNTIME_DIR=str(root),
                   MV_MW_HOME=str(root / 'memoryweb'))
        # Existing account/configuration directories stay outside; none are copied.
        env['XDG_CONFIG_HOME'] = os.environ.get('XDG_CONFIG_HOME') or str(Path.home() / '.config')
        child = subprocess.Popen([str(app)], env=env)
        def forward(signum, _frame):
            if child.poll() is None:
                child.send_signal(signum)
        for signum in (signal.SIGINT, signal.SIGTERM):
            handlers[signum] = signal.signal(signum, forward)
        code = child.wait()
        return 128 - code if code < 0 else code
    finally:
        for signum, handler in handlers.items():
            signal.signal(signum, handler)
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                raise RuntimeError('MUSE_SESSION_RETAINED_LIVE_CHILD')
        if root.exists():
            current = private_directory(root).stat()
            if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
                raise ValueError('MUSE_SESSION_ROOT_CHANGED')
            shutil.rmtree(root)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=__import__('sys').stderr)
        raise SystemExit(2)
