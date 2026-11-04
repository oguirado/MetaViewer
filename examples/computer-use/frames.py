#!/usr/bin/env python3
"""Inspect saved frames with ffmpeg, without a display.
Usage: frames.py crop INPUT OUTPUT --rect X Y WIDTH HEIGHT
       frames.py sheet OUTPUT INPUT... [--columns N]
Sheet cells follow input order; the adjacent JSON file records that order.
"""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='action', required=True)
    crop = sub.add_parser('crop')
    crop.add_argument('input', type=Path)
    crop.add_argument('output', type=Path)
    crop.add_argument('--rect', nargs=4, type=int, required=True)
    sheet = sub.add_parser('sheet')
    sheet.add_argument('output', type=Path)
    sheet.add_argument('inputs', nargs='+', type=Path)
    sheet.add_argument('--columns', type=int, default=3)
    a = p.parse_args()
    if a.output.exists() or not a.output.parent.is_dir():
        p.error('output must be new, with an existing parent')
    cmd = ['ffmpeg', '-v', 'error', '-n']
    if a.action == 'crop':
        x, y, w, h = a.rect
        if min(x, y) < 0 or min(w, h) <= 0 or not a.input.is_file():
            p.error('input and crop rectangle are invalid')
        probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height', '-of', 'json', str(a.input)],
            check=True, capture_output=True, text=True, timeout=30)
        streams = json.loads(probe.stdout).get('streams', [])
        if len(streams) != 1 or x+w > streams[0]['width'] or y+h > streams[0]['height']:
            p.error('crop rectangle extends outside the source frame')
        cmd += ['-i', str(a.input), '-vf', f'crop={w}:{h}:{x}:{y}:exact=1']
    else:
        if a.columns <= 0 or len(a.inputs) > 32 or not all(f.is_file() for f in a.inputs):
            p.error('require positive columns and at most 32 existing input files')
        manifest = a.output.with_suffix('.json')
        if manifest.exists():
            p.error('sheet manifest already exists')
        for f in a.inputs:
            cmd += ['-i', str(f)]
        filters = [f'[{i}:v]scale=480:270:force_original_aspect_ratio=decrease,'
                   f'pad=480:270:(ow-iw)/2:(oh-ih)/2[v{i}]' for i in range(len(a.inputs))]
        labels = ''.join(f'[v{i}]' for i in range(len(a.inputs)))
        layout = '|'.join(f'{(i % a.columns)*480}_{(i // a.columns)*270}'
                          for i in range(len(a.inputs)))
        if len(a.inputs) == 1:
            filters.append('[v0]null[out]')
        else:
            filters.append(f'{labels}xstack=inputs={len(a.inputs)}:layout={layout}:fill=black[out]')
        cmd += ['-filter_complex_threads', '1', '-filter_complex', ';'.join(filters), '-map', '[out]']
    subprocess.run(cmd + ['-frames:v', '1', str(a.output)], check=True, timeout=60)
    if a.action == 'sheet':
        with manifest.open('x') as output:
            json.dump({'columns': a.columns, 'inputs': [str(f) for f in a.inputs]}, output, indent=2)
    print(a.output)


if __name__ == '__main__':
    main()
