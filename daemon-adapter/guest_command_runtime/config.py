"""Protected host configuration. Public commands never supply these fields."""
import copy
import json
import os
from pathlib import PurePosixPath
import re
import stat

from .wire import strict_object


class ConfigError(ValueError):
    pass


def closed(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        raise ConfigError('unknown or missing configuration field')


def host_path(value):
    if (type(value) is not str or not value.startswith('/') or '\0' in value or
            len(value.encode('utf-8')) > 4096 or str(PurePosixPath(value)) != value or
            value.startswith('//') or '..' in PurePosixPath(value).parts):
        raise ConfigError('canonical absolute host path required')


def validate(value):
    closed(value, ('schema', 'owner_id', 'generation', 'runtime_admitted', 'artifacts',
                   'runtime_root', 'external_cgroup', 'startup_seconds', 'stop_seconds'))
    if value['schema'] != 'guest-command-host-config/v1':
        raise ConfigError('unknown host profile')
    if type(value['runtime_admitted']) is not bool:
        raise ConfigError('explicit runtime admission required')
    if type(value['owner_id']) is not str or re.fullmatch(r'actor-[a-z0-9][a-z0-9._-]{0,63}', value['owner_id']) is None:
        raise ConfigError('owner identity')
    if type(value['generation']) is not int or not 1 <= value['generation'] <= 2**53-1:
        raise ConfigError('generation')
    for name in ('startup_seconds', 'stop_seconds'):
        if type(value[name]) is not int or not 1 <= value[name] <= 30:
            raise ConfigError('deadline exceeds existing bounds')
    for name in ('runtime_root', 'external_cgroup'):
        host_path(value[name])
    closed(value['artifacts'], ('engine', 'kernel', 'broker', 'busybox'))
    for asset in value['artifacts'].values():
        closed(asset, ('path', 'sha256'))
        host_path(asset['path'])
        if type(asset['sha256']) is not str or re.fullmatch('[0-9a-f]{64}', asset['sha256']) is None:
            raise ConfigError('explicit artifact SHA256 required')
    return copy.deepcopy(value)


def load(path):
    host_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as source:
        observed = os.fstat(source.fileno())
        if (not stat.S_ISREG(observed.st_mode) or observed.st_uid != os.getuid() or
                stat.S_IMODE(observed.st_mode) not in (0o600, 0o400) or
                observed.st_nlink != 1 or not 1 <= observed.st_size <= 65536):
            raise ConfigError('single-link protected owned host configuration required')
        raw = source.read(65537)
        if len(raw) > 65536:
            raise ConfigError('configuration grew beyond limit')
        return validate(strict_object(raw))
