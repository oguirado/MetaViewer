#!/usr/bin/env python3
"""[TARGET, unit decision] Offline volume entry; conductor must wire workflow.

Use an already staged pinned kit or fail. Missing npm packages may only be
installed from cache. Electron may only be staged from a locally supplied,
checksum-verified archive. No dependency fetch or checkout is performed here.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def prerequisites(root, env):
    # A Python entry need not have executable mode: the caller runs python3.
    if not (root / 'tests/e2e/run.py').is_file():
        raise RuntimeError('BLOCKED: tests/e2e/run.py absent')
    kit = env.get('CAPSULE_UI_KIT_REPO') or env.get('MV_KIT_CHECKOUT')
    if not kit or not Path(kit).is_dir():
        raise RuntimeError('E2E_PREREQ: pinned kit checkout absent')
    return kit


def prepare(root, env, run=subprocess.run):
    kit = prerequisites(root, env)
    run(['node', 'tools/sync_kit.mjs', kit], cwd=root, env=env, check=True)
    version = run(['node', '--version'], cwd=root, env=env, check=True,
                  capture_output=True, text=True).stdout.strip()
    match = re.fullmatch(r'v(\d+)\.\d+\.\d+', version)
    if match is None or int(match.group(1)) < 24:
        raise RuntimeError('E2E_PREREQ: Node >=24 required')
    ui = root / 'ui' 
    if not (ui / 'node_modules/vite/package.json').is_file():
        run(['npm', 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
            cwd=ui, env=env, check=True)
    package = ui / 'node_modules/electron'
    if json.loads((package / 'package.json').read_text())['version'] != '44.9.2':
        raise RuntimeError('E2E_PREREQ: Electron pin mismatch')
    binary = package / 'dist/electron'
    if not os.access(binary, os.X_OK):
        archives = env.get('MV_ELECTRON_ZIP_DIR')
        arch = {'aarch64': 'arm64', 'x86_64': 'x64'}.get(platform.machine())
        if not archives or arch is None:
            raise RuntimeError('E2E_PREREQ: local Electron archive required')
        name = f'electron-v44.9.2-linux-{arch}.zip'
        archive = Path(archives) / name
        expected = json.loads((package / 'checksums.json').read_text()).get(name)
        if expected is None or hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
            raise RuntimeError('E2E_PREREQ: Electron archive checksum mismatch')
        with tempfile.TemporaryDirectory(dir=package, prefix='e2e-electron-') as scratch:
            stage = Path(scratch) / 'dist'
            stage.mkdir()
            with zipfile.ZipFile(archive) as stream:
                for member in stream.infolist():
                    path = PurePosixPath(member.filename)
                    if path.is_absolute() or '..' in path.parts:
                        raise RuntimeError('E2E_PREREQ: unsafe Electron archive path')
                    stream.extract(member, stage)
                    if not member.is_dir():
                        (stage / member.filename).chmod((member.external_attr >> 16) & 0o777 or 0o644)
            (stage / 'electron').chmod(0o755)
            if (package / 'dist').exists():
                raise RuntimeError('E2E_PREREQ: incomplete Electron dist; repair explicitly')
            shutil.move(stage, package / 'dist')
        (package / 'path.txt').write_text('electron')
    result = run(['xvfb-run', '-a', str(binary), '--version'], cwd=root, env=env,
                 check=True, capture_output=True, text=True)
    if result.stdout.strip() != 'v44.9.2':
        raise RuntimeError('E2E_PREREQ: Electron binary version mismatch')


def _active_workflow_lines(job):
    active = []
    for raw in job.splitlines():
        uncommented = re.sub(r'(?:^|\s+)#.*$', '', raw).rstrip()
        if not uncommented or re.match(r'^\s*(?:-\s*)?name\s*:', uncommented):
            continue
        active.append(uncommented)
    return '\n'.join(active)


def check_workflow(text):
    """Guard only the volume-e2e job; reject the confirmed workflow mutants."""
    match = re.search(r'^  volume-e2e:\n(.*?)(?=^  [a-zA-Z0-9_-]+:|\Z)', text, re.M | re.S)
    job = _active_workflow_lines(match.group(1)) if match else ''
    required = ('[ ! -f "$HARNESS" ]', 'setup-node@', 'kit-checkout',
                'npm ci', 'install_electron.cjs')
    missing = [item for item in required if item not in job]
    if missing:
        raise RuntimeError('E2E_PREREQ: volume workflow missing ' + ', '.join(missing))


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--iterations', type=int, choices=(20, 300), default=20)
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--check-workflow', action='store_true')
    args = parser.parse_args(argv)
    env = dict(os.environ)
    try:
        if args.check_workflow:
            check_workflow((ROOT / ".github/workflows/volume.yml").read_text())
            return 0
        prepare(ROOT, env)
        if args.prepare_only:
            return 0
        for index in range(args.iterations):
            subprocess.run([sys.executable, 'tests/e2e/run.py'], cwd=ROOT, env=env, check=True)
            print(f'volume-e2e {index + 1}/{args.iterations} PASS', flush=True)
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 2 if str(error).startswith('BLOCKED:') else 1


if __name__ == '__main__':
    sys.exit(main())
