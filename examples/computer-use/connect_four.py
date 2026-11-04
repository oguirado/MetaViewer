#!/usr/bin/env python3
"""A small original shared-board game; Python stdlib, tkinter for the live view.
Usage: connect_four.py init --state NEW.json
       connect_four.py view --state FILE.json --seat red|yellow|both
Left/Right selects a column; Enter drops a piece on your turn. Both plays either side. Two views share
one state file. init never overwrites a match. No network or model is required.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import tempfile

ROWS, COLS = 6, 7


def new_game():
    return {'board': [[''] * COLS for _ in range(ROWS)], 'turn': 'red', 'winner': '', 'moves': 0}


def drop(state, column, seat):
    if state['winner'] or seat != state['turn'] or not 0 <= column < COLS:
        return False
    row = next((r for r in range(ROWS - 1, -1, -1) if not state['board'][r][column]), None)
    if row is None:
        return False
    state['board'][row][column] = seat
    state['moves'] += 1
    for dr, dc in ((1, 0), (0, 1), (1, 1), (1, -1)):
        count = 1
        for sign in (-1, 1):
            r, c = row + dr * sign, column + dc * sign
            while 0 <= r < ROWS and 0 <= c < COLS and state['board'][r][c] == seat:
                count += 1
                r, c = r + dr * sign, c + dc * sign
        if count >= 4:
            state['winner'] = seat
    if not state['winner'] and state['moves'] == ROWS * COLS:
        state['winner'] = 'draw'
    state['turn'] = 'yellow' if seat == 'red' else 'red'
    return True


def play(path, column, seat):
    with path.with_suffix(path.suffix + '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads(path.read_text())
        if not drop(state, column, seat):
            return False
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.board-')
        try:
            with os.fdopen(fd, 'w') as out:
                json.dump(state, out)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    return True


def view(path, seat):
    import tkinter as tk
    root = tk.Tk()
    root.title('Connect Four — ' + seat)
    canvas = tk.Canvas(root, width=840, height=640, bg='#122034', highlightthickness=0)
    canvas.pack(fill='both', expand=True)
    selected = [3]

    def move(delta):
        selected[0] = (selected[0] + delta) % COLS

    root.bind('<Left>', lambda _: move(-1))
    root.bind('<Right>', lambda _: move(1))
    def enter(_event):
        current = json.loads(path.read_text())['turn'] if seat == 'both' else seat
        play(path, selected[0], current)
    root.bind('<Return>', enter)

    def draw():
        state = json.loads(path.read_text())
        canvas.delete('all')
        width, height = canvas.winfo_width(), canvas.winfo_height()
        cell = max(12, min((width - 40) / COLS, (height - 140) / ROWS))
        left = (width - cell * COLS) / 2
        status = 'Result: ' + state['winner'] if state['winner'] else 'Turn: ' + state['turn']
        canvas.create_text(width/2, 25, text=f'You: {seat}   {status}', fill='white', font=('sans', 18))
        canvas.create_text(width/2, 58, text='Left / Right: select   Enter: drop', fill='white')
        for c in range(COLS):
            canvas.create_text(left + (c+.5)*cell, 86, text=str(c+1),
                               fill='#ffffff' if c == selected[0] else '#7290ad', font=('sans', 16, 'bold'))
        for r in range(ROWS):
            for c in range(COLS):
                x, y = left+c*cell+5, 105+r*cell+5
                color = {'red': '#f15a63', 'yellow': '#f5cb55', '': '#354c68'}[state['board'][r][c]]
                canvas.create_oval(x, y, x+cell-10, y+cell-10, fill=color, outline='')
        root.after(150, draw)
    draw()
    root.mainloop()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='action', required=True)
    init = sub.add_parser('init')
    init.add_argument('--state', required=True, type=Path)
    viewer = sub.add_parser('view')
    viewer.add_argument('--state', required=True, type=Path)
    viewer.add_argument('--seat', required=True, choices=('red', 'yellow', 'both'))
    a = p.parse_args()
    if not a.state.parent.is_dir():
        p.error('state parent directory must exist')
    if a.action == 'init':
        with a.state.open('x') as out:
            json.dump(new_game(), out)
        a.state.chmod(0o600)
    else:
        if not a.state.is_file():
            p.error('initialize the state before opening a view')
        view(a.state, a.seat)


if __name__ == '__main__':
    main()
