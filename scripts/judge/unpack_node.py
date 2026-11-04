#!/usr/bin/env python3
"""Preserve regular Node/npm files without archive links."""
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile


def unpack(archive, destination):
    destination = Path(destination)
    with tarfile.open(archive) as tf:
        members = tf.getmembers()
        roots = set()
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts:
                raise ValueError('unsafe Node member')
            roots.add(path.parts[0])
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError('unsupported Node member')
        if len(roots) != 1:
            raise ValueError('Node archive must have one root')
        for member in members:
            parts = PurePosixPath(member.name).parts[1:]
            if not parts or not member.isfile():
                continue
            target = destination.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with tf.extractfile(member) as source, target.open('wb') as out:
                shutil.copyfileobj(source, out)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
    for name in ('npm', 'npx'):
        if (destination / 'lib/node_modules/npm/bin' / f'{name}-cli.js').is_file():
            wrapper = destination / 'bin' / name
            wrapper.write_text('#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 2\n'
                               f'exec "$base/bin/node" "$base/lib/node_modules/npm/bin/{name}-cli.js" "$@"\n')
            wrapper.chmod(0o755)


if __name__ == '__main__':
    try:
        unpack(*sys.argv[1:])
    except (OSError, ValueError, tarfile.TarError) as exc:
        print(f'JUDGE_ASSET: {exc} -- fix: obtain a valid Node archive', file=sys.stderr)
        sys.exit(2)
