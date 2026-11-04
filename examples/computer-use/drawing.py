#!/usr/bin/env python3
"""Display a model's JSON drawing without executing generated code.
Usage: drawing.py --input DRAWING.json [--title NAME]
Object: {"shapes": [{"kind":"oval", "xy":[20,20,200,160], "color":"#44aaff"}]}.
Kinds: oval, rectangle, line. Coordinates lie inside a square canvas. Requires tkinter.
"""
import argparse
import json
from pathlib import Path
import re


def validate(value):
    if not isinstance(value, dict) or set(value) != {'shapes'} or not isinstance(value['shapes'], list):
        raise ValueError('expected a shapes object')
    if len(value['shapes']) > 100:
        raise ValueError('too many shapes')
    for shape in value['shapes']:
        if (not isinstance(shape, dict) or set(shape) != {'kind', 'xy', 'color'}
                or shape['kind'] not in ('oval', 'rectangle', 'line')
                or not isinstance(shape['color'], str)
                or not re.fullmatch(r'#[0-9a-fA-F]{6}', shape['color'])
                or not isinstance(shape['xy'], list) or len(shape['xy']) != 4
                or any(type(n) not in (int, float) or not 0 <= n <= 600 for n in shape['xy'])):
            raise ValueError('invalid shape')
    return value['shapes']


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', required=True, type=Path)
    p.add_argument('--title', default='Drawing')
    a = p.parse_args()
    with a.input.open('rb') as source:
        raw = source.read(65537)
    if len(raw) > 65536:
        p.error('drawing is too large')
    shapes = validate(json.loads(raw))
    import tkinter as tk
    root = tk.Tk()
    root.title(a.title)
    canvas = tk.Canvas(root, width=600, height=600, bg='white')
    canvas.pack(fill='both', expand=True)
    def redraw(_event=None):
        canvas.delete('all')
        sx, sy = canvas.winfo_width()/600, canvas.winfo_height()/600
        for shape in shapes:
            xy = [v * (sx if i % 2 == 0 else sy) for i, v in enumerate(shape['xy'])]
            draw = getattr(canvas, 'create_' + shape['kind'])
            draw(*xy, fill=shape['color'])
    canvas.bind('<Configure>', redraw)
    root.mainloop()


if __name__ == '__main__':
    main()
