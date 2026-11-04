#!/usr/bin/env python3
"""Run offline with: python3 -B examples/computer-use/test_examples.py.
No live display, model account or MetaViewer instance is used.
"""
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

import connect_four as game
import drawing
import model_keys
import ui

HERE = Path(__file__).resolve().parent


class Examples(unittest.TestCase):
    def test_horizontal_vertical_diagonal_and_full_column(self):
        for cells in ([(5, c) for c in range(3)], [(r, 0) for r in (5, 4, 3)],
                      [(5, 0), (4, 1), (3, 2)]):
            state = game.new_game()
            for r, c in cells:
                state['board'][r][c] = 'red'
            if cells[-1] == (3, 2):
                for r in (5, 4, 3):
                    state['board'][r][3] = 'yellow'
                column = 3
            else:
                column = 3 if cells[0] == (5, 0) and cells[-1] == (5, 2) else 0
            self.assertTrue(game.drop(state, column, 'red'))
            self.assertEqual(state['winner'], 'red')
        state = game.new_game()
        self.assertFalse(game.drop(state, 0, 'yellow'))
        self.assertFalse(game.drop(state, -1, 'red'))
        for row in state['board']:
            row[0] = 'yellow'
        self.assertFalse(game.drop(state, 0, 'red'))

    def test_shared_state_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / 'match.json'
            state.write_text(json.dumps(game.new_game()))
            self.assertTrue(game.play(state, 2, 'red'))
            self.assertFalse(game.play(state, 2, 'red'))
            self.assertEqual(json.loads(state.read_text())['board'][5][2], 'red')
            run = subprocess.run([sys.executable, str(HERE/'connect_four.py'), 'init', '--state', str(state)],
                                 capture_output=True)
            self.assertNotEqual(run.returncode, 0)

    def test_decision_contract_and_muse_failure(self):
        value = dict(key='Enter', observation='menu', reason='confirm', expected='board')
        self.assertEqual(model_keys.decision(json.dumps(value), 'json'), value)
        events = json.dumps({'payload_type': 'run.output.delta', 'payload': {'text': json.dumps(value)}})
        completed = json.dumps({'payload_type': 'run.terminal.completed', 'payload': {'terminal': 'completed'}})
        self.assertEqual(model_keys.decision(events+'\n'+completed, 'muse'), value)
        with self.assertRaises(ValueError):
            model_keys.decision(events, 'muse')
        for invalid in ({**value, 'key': 'a'}, {**value, 'extra': 'field'}, {**value, 'reason': 1}, []):
            with self.assertRaises(ValueError):
                model_keys.decision(json.dumps(invalid), 'json')
        with self.assertRaises(ValueError):
            model_keys.decision(events+'\n'+json.dumps({'payload_type': 'run.terminal.failed'}), 'muse')

    def test_png_pixel_integrity(self):
        encoded = model_keys.png(1, 1, b'\xff\x00\x80')
        self.assertTrue(encoded.startswith(b'\x89PNG\r\n\x1a\n'))
        offset, compressed = 8, b''
        while offset < len(encoded):
            size = struct.unpack('>I', encoded[offset:offset+4])[0]
            kind = encoded[offset+4:offset+8]
            data = encoded[offset+8:offset+8+size]
            crc = struct.unpack('>I', encoded[offset+8+size:offset+12+size])[0]
            self.assertEqual(crc, zlib.crc32(kind+data))
            if kind == b'IDAT':
                compressed += data
            offset += 12+size
        self.assertEqual(zlib.decompress(compressed), b'\x00\xff\x00\x80')
        with self.assertRaises(ValueError):
            model_keys.png(1, 1, b'')

    def test_geometry_and_drawing_rejection(self):
        self.assertEqual(ui.geometry('Absolute upper-left X: -4\nAbsolute upper-left Y: 9\nWidth: 1920\nHeight: 1080'),
                         (-4, 9, 1920, 1080))
        with self.assertRaises(ValueError):
            ui.geometry('Width: 1920')
        self.assertEqual(drawing.validate({'shapes': []}), [])
        for value in ({'shapes': [{'kind': 'script', 'xy': [0, 0, 1, 1], 'color': '#ffffff'}]},
                      {'shapes': [{'kind': 'oval', 'xy': [0, 0, float('nan'), 1], 'color': '#ffffff'}]},
                      {'shapes': [], 'script': 'bad'}):
            with self.assertRaises(ValueError):
                drawing.validate(value)

    def test_help_and_negative_arguments_without_display(self):
        env = dict(os.environ)
        env.pop('DISPLAY', None)
        for script in ('ui', 'frames', 'model_keys', 'launch', 'connect_four', 'drawing'):
            result = subprocess.run([sys.executable, str(HERE / (script+'.py')), '--help'],
                                    capture_output=True, env=env)
            self.assertEqual(result.returncode, 0, script)
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run([sys.executable, str(HERE/'ui.py'), '--display', 'invalid',
                '--window', '1', '--capture', str(Path(tmp)/'out.png'), 'click', '-1', '0'],
                capture_output=True, env=env)
            self.assertEqual(result.returncode, 2)
            self.assertIn(b'outside', result.stderr)
            result = subprocess.run([sys.executable, str(HERE/'model_keys.py'), '--operator-root', tmp,
                '--identity', 'sample', '--evidence', tmp, '--goal', 'test', '--steps', '0',
                '--player', 'unavailable'], capture_output=True, env=env)
            self.assertEqual(result.returncode, 2)

    def test_wrapper_quotes_arguments(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'wrapper with spaces'
            text = 'literal $(exit 9) ; text with spaces'
            result = subprocess.run([sys.executable, str(HERE/'launch.py'), 'command-wrapper', str(path),
                                     '--command', sys.executable, '-c', 'import sys; print(sys.argv[1])', text],
                                    capture_output=True)
            self.assertEqual(result.returncode, 0)
            result = subprocess.run([str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout.strip(), text)

    def test_real_frame_crop_and_sheet(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            frame = root / 'frame.png'
            frame.write_bytes(model_keys.png(32, 32, b'\xff\x40\x00' * 32 * 32))
            crop = root / 'crop.png'
            sheet = root / 'sheet.png'
            for args in (['crop', str(frame), str(crop), '--rect', '8', '8', '16', '16'],
                         ['sheet', str(sheet), str(frame), str(crop), '--columns', '2']):
                result = subprocess.run([sys.executable, str(HERE/'frames.py'), *args], capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(struct.unpack('>II', crop.read_bytes()[16:24]), (16, 16))
            self.assertEqual(struct.unpack('>II', sheet.read_bytes()[16:24]), (960, 270))
            self.assertEqual(json.loads(sheet.with_suffix('.json').read_text())['inputs'],
                             [str(frame), str(crop)])
            invalid = root / 'invalid.png'
            result = subprocess.run([sys.executable, str(HERE/'frames.py'), 'crop',
                str(frame), str(invalid), '--rect', '30', '0', '16', '16'], capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertFalse(invalid.exists())


if __name__ == '__main__':
    unittest.main()
