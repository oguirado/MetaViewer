#!/usr/bin/env python3
"""X11 window driver. Usage: ui.py --display DISPLAY --window XID --capture NEW.png
shot | fit | click X Y | type TEXT | key KEY
Requires xwininfo, xdotool and ffmpeg. Every action captures the window afterward.
Coordinates refer to the client window, never a scaled preview. No display default.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess


def run(env, *args):
    return subprocess.run(args, env=env, check=True, capture_output=True,
                          text=True, timeout=30).stdout


def geometry(text):
    fields = [r"Absolute upper-left X:\s*(-?\d+)",
              r"Absolute upper-left Y:\s*(-?\d+)", r"Width:\s*(\d+)",
              r"Height:\s*(\d+)"]
    matches = [re.search(pattern, text) for pattern in fields]
    if not all(matches):
        raise ValueError("xwininfo did not return complete geometry")
    return tuple(int(match[1]) for match in matches)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--display', required=True)
    p.add_argument('--window', required=True)
    p.add_argument('--capture', required=True, type=Path)
    p.add_argument('--width', type=int, default=1920)
    p.add_argument('--height', type=int, default=1080)
    sub = p.add_subparsers(dest='action', required=True)
    for name in ('shot', 'fit'):
        sub.add_parser(name)
    click = sub.add_parser('click')
    click.add_argument('x', type=int)
    click.add_argument('y', type=int)
    sub.add_parser('type').add_argument('text')
    sub.add_parser('key').add_argument('key')
    a = p.parse_args()
    if a.width <= 0 or a.height <= 0 or not re.fullmatch(r'(0x[0-9a-fA-F]+|[1-9][0-9]*)', a.window):
        p.error('positive dimensions and an explicit numeric XID are required')
    if a.capture.exists() or not a.capture.parent.is_dir():
        p.error('capture must be a new file in an existing directory')
    if a.action == 'click' and not (0 <= a.x < a.width and 0 <= a.y < a.height):
        p.error('click is outside the expected window')
    env = dict(os.environ, DISPLAY=a.display)
    if a.action == 'fit':
        run(env, 'xdotool', 'windowsize', '--sync', a.window, str(a.width), str(a.height))
    x, y, w, h = geometry(run(env, 'xwininfo', '-id', a.window))
    if (w, h) != (a.width, a.height) or x < 0 or y < 0:
        p.error(f'window geometry {x},{y} {w}x{h} does not match capture requirements')
    if a.action not in ('shot', 'fit'):
        run(env, 'xdotool', 'windowactivate', '--sync', a.window)
        if a.action == 'click':
            run(env, 'xdotool', 'mousemove', str(x + a.x), str(y + a.y), 'click', '1')
        elif a.action == 'type':
            run(env, 'xdotool', 'type', '--clearmodifiers', '--delay', '15', '--', a.text)
        else:
            run(env, 'xdotool', 'key', '--clearmodifiers', '--', a.key)
    run(env, 'ffmpeg', '-v', 'error', '-n', '-f', 'x11grab', '-video_size', f'{w}x{h}',
        '-i', f'{a.display}+{x},{y}', '-frames:v', '1', str(a.capture))
    print(a.capture)


if __name__ == '__main__':
    main()
