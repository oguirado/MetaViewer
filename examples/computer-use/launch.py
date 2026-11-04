#!/usr/bin/env python3
"""Usage: launch.py app EXECUTABLE [ARGS...]
       launch.py game-wrapper OUTPUT --game GAME.py --state STATE.json --seat red|yellow|both
App runs under a user systemd memory scope. A wrapper is an executable Host program
entry point; generated absolute paths come from arguments, not this repository.
"""
import argparse
from pathlib import Path
import shlex
import subprocess
import sys


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='action', required=True)
    app = sub.add_parser('app')
    app.add_argument('executable', type=Path)
    app.add_argument('args', nargs=argparse.REMAINDER)
    wrapper = sub.add_parser('game-wrapper')
    wrapper.add_argument('output', type=Path)
    wrapper.add_argument('--game', required=True, type=Path)
    wrapper.add_argument('--state', required=True, type=Path)
    wrapper.add_argument('--seat', choices=('red', 'yellow', 'both'), required=True)
    command_wrapper = sub.add_parser('command-wrapper')
    command_wrapper.add_argument('output', type=Path)
    command_wrapper.add_argument('--command', nargs=argparse.REMAINDER, required=True)
    a = p.parse_args()
    if a.action == 'app':
        if not a.executable.is_file():
            p.error('executable does not exist')
        return subprocess.call(['systemd-run', '--user', '--scope', '-p', 'MemoryHigh=6G',
                                '-p', 'MemoryMax=8G', '-p', 'MemorySwapMax=0', '--',
                                str(a.executable.resolve()), *a.args])
    if a.action == 'command-wrapper':
        if not a.command or not a.output.parent.is_dir():
            p.error('command and output parent are required')
        command = a.command
    else:
        if not a.game.is_file() or not a.state.parent.is_dir() or not a.output.parent.is_dir():
            p.error('game and parent directories must exist')
        command = [sys.executable, str(a.game.resolve()), 'view', '--state',
                   str(a.state.resolve()), '--seat', a.seat]
    with a.output.open('x') as out:
        out.write('#!/bin/sh\nexec ' + shlex.join(command) + '\n')
    a.output.chmod(0o700)
    print(a.output)
    return 0


if __name__ == '__main__':
    sys.exit(main())
