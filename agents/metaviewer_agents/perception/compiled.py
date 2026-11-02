"""[TARGET, unit decision] Source-free sidecars use a public distribution lock.

An explicit executable overrides checkout mode. Every regular file (including
shared libraries and schemas) is pinned; missing, extra, source or linked files
refuse before spawning. No caller-supplied hash can replace this lock.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import stat

from .deps_lock import DependencyLockError, _locked_commit

VARIABLES = {'wender-agent': 'MV_WENDER_EXECUTABLE',
             'vision-engine': 'MV_VISION_EXECUTABLE'}
LOCK = Path(__file__).with_name('compiled.lock.json')


def compiled_executable(name, *, root=None, lock_path=None):
    """Return a verified executable, or None when checkout mode was selected."""
    variable = VARIABLES[name]
    raw = os.environ.get(VARIABLES[name])
    executable_name = {'wender-agent': 'wender-runtime',
                       'vision-engine': 'vision-runtime'}[name]
    if raw is None and root is not None:
        # Invalid checkout arguments retain their adapter's typed validation.
        if not isinstance(root, (str, Path)):
            return None
        try:
            candidate = Path(root) / executable_name
            if candidate.exists() or candidate.is_symlink():
                raw = str(candidate)
        except (OSError, ValueError, RuntimeError):
            return None
    if raw is None:
        return None
    try:
        path = Path(raw)
        if (not path.is_absolute() or path != path.resolve(strict=True) or
                any(p.is_symlink() for p in (path, *path.parents)) or
                not path.is_file() or not os.access(path, os.X_OK)):
            raise ValueError('compiled executable must be a canonical executable file')
        if root is not None and Path(root).resolve(strict=True) != path.parent:
            raise DependencyLockError('commit_mismatch',
                                      f'{name}: compiled executable differs from component root')
        if platform.system() != 'Linux' or platform.machine().lower() not in ('x86_64', 'amd64'):
            raise ValueError('compiled runtime is available only for linux-x64')
        pins = json.loads(LOCK.read_text())['components'][name]
        deps = Path(lock_path) if lock_path is not None else Path(__file__).resolve().parents[3] / 'deps.lock'
        if _locked_commit(name, deps) != pins['commit']:
            raise DependencyLockError('commit_mismatch', f'{name}: compiled lock differs from deps.lock')
        if path.name != pins['executable']:
            raise ValueError('compiled executable name differs from lock')
        found = set()
        for entry in path.parent.rglob('*'):
            mode = entry.lstat().st_mode
            if stat.S_ISDIR(mode):
                continue
            relative = entry.relative_to(path.parent).as_posix()
            if not stat.S_ISREG(mode) or relative not in pins['files']:
                raise DependencyLockError('dirty_tree', f'{name}: unpinned compiled file {relative}')
            found.add(relative)
            with entry.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            if digest != pins['files'][relative]:
                raise DependencyLockError('hash_mismatch', f'{name}: compiled hash mismatch: {relative}')
        missing = set(pins['files']) - found
        if missing:
            raise ValueError('compiled runtime missing pinned files: ' + ', '.join(sorted(missing)))
        return path
    except DependencyLockError:
        raise
    except (OSError, ValueError, TypeError, KeyError, StopIteration, RuntimeError) as error:
        raise DependencyLockError('unavailable', f'{variable}: {error}') from error
