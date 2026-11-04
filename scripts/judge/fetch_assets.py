#!/usr/bin/env python3
"""Fetch a selected tier from an explicit release or local directory.

Remote manifests require their SHA256 supplied independently by the operator.
Checksums detect corruption; they do not authenticate the release publisher.
"""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import re
import shutil
import sys
import tempfile
import urllib.parse
import urllib.request


def fetch(source, destination, arch, capsules=False, sums_sha256=None):
    remote = urllib.parse.urlsplit(source).scheme == 'https'
    if '://' in source and not remote:
        raise ValueError('source must be a local directory or HTTPS release asset base URL')
    if remote and not re.fullmatch('[0-9a-fA-F]{64}', sums_sha256 or ''):
        raise ValueError('HTTPS requires --sums-sha256 from the release publisher')
    names = [f'metaviewer-linux-{arch}.tar.gz', f'node-linux-{arch}.tar.xz']
    if capsules:
        names += [f'opensuperficies-linux-{arch}.tar.gz', f'images-linux-{arch}.tar',
                  'vision-engine.tar.gz', 'wender-agent.tar.gz']
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.judge-fetch-', dir=destination) as work:
        work = Path(work)

        def copy(name):
            out = work / name
            if remote:
                url = source.rstrip('/') + '/' + name
                with urllib.request.urlopen(url, timeout=60) as response:
                    if urllib.parse.urlsplit(response.geturl()).scheme != 'https':
                        raise ValueError('release redirected outside HTTPS')
                    with out.open('wb') as stream:
                        shutil.copyfileobj(response, stream)
            else:
                shutil.copyfile(Path(source) / name, out)
            return out

        sums = copy('SHA256SUMS')
        if sums_sha256 and hashlib.sha256(sums.read_bytes()).hexdigest() != sums_sha256.lower():
            raise ValueError('SHA256SUMS digest mismatch')
        entries = {}
        for line in sums.read_text().splitlines():
            match = re.fullmatch(r'([0-9a-fA-F]{64}) [ *]([^/\\]+)', line)
            if not match or match[2] in entries:
                raise ValueError('invalid or duplicate SHA256SUMS entry')
            entries[match[2]] = match[1].lower()
        for name in names:
            if name not in entries:
                raise ValueError(f'SHA256SUMS has no entry for {name}')
            asset = copy(name)
            with asset.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            if digest != entries[name]:
                raise ValueError(f'{name} digest mismatch')
        for name in names + ['SHA256SUMS']:
            os.replace(work / name, destination / name)
    print(f'JUDGE_FETCH_OK arch={arch} tier={"T2" if capsules else "T1"}')


class JudgeParser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, f'JUDGE_USAGE: {message} -- fix: python3 scripts/judge/fetch_assets.py --help\n')


def main():
    parser = JudgeParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--dest', type=Path, default=Path(__file__).resolve().parents[2] / 'assets')
    parser.add_argument('--arch', choices=('x64', 'arm64'),
                        default={'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine()))
    parser.add_argument('--capsules', action='store_true')
    parser.add_argument('--sums-sha256')
    args = parser.parse_args()
    try:
        if not args.arch:
            raise ValueError('unsupported machine; specify --arch x64 or --arch arm64')
        fetch(args.source, args.dest, args.arch, args.capsules, args.sums_sha256)
    except (OSError, ValueError) as exc:
        print(f'JUDGE_ASSET: {exc} -- fix: python3 scripts/judge/fetch_assets.py '
              '--source <complete-release-or-local-directory> [--capsules] '
              '--sums-sha256 <publisher-manifest-digest>', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
