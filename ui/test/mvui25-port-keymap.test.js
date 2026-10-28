/**
 * Tests for the keyboard map (`ui/src/input/keyMap.js`).
 *
 * Runs under the repository `node --test` gate with synthetic key events only; no
 * DOM is loaded. Each behaviour pairs a positive witness with a negative control
 * that must fail: modified printables never become `type`, Escape (even modified)
 * never maps, and IME/dead/unidentified keys map to null.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapKeyboardEvent } from '../src/input/keyMap.js';

const ev = (key, over = {}) => ({ key, ...over });

describe('mvui25 key map', () => {
  it('maps printables without ctrl/alt/super to type', () => {
    for (const [key, text] of [['a', 'a'], ['A', 'A'], ['7', '7'], [' ', ' '], ['?', '?'], ['€', '€']]) {
      assert.deepEqual(mapKeyboardEvent(ev(key)), { kind: 'type', text });
    }
    assert.deepEqual(mapKeyboardEvent(ev('A', { shiftKey: true })), { kind: 'type', text: 'A' });
    const out = mapKeyboardEvent(ev('q'));
    assert.equal('keys' in out, false);
  });

  it('maps the named table to X keysym spelling', () => {
    const table = {
      Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Delete: 'Delete', Insert: 'Insert',
      Home: 'Home', End: 'End', PageUp: 'Page_Up', PageDown: 'Page_Down',
      ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
    };
    for (const [dom, sym] of Object.entries(table)) {
      assert.deepEqual(mapKeyboardEvent(ev(dom)), { kind: 'key', keys: [sym] });
    }
    for (let f = 1; f <= 12; f += 1) {
      assert.deepEqual(mapKeyboardEvent(ev(`F${f}`)), { kind: 'key', keys: [`F${f}`] });
    }
    const out = mapKeyboardEvent(ev('Enter'));
    assert.equal('text' in out, false);
  });

  it('builds chords with lowercase letters and ordered modifiers', () => {
    assert.deepEqual(mapKeyboardEvent(ev('l', { ctrlKey: true })), { kind: 'key', keys: ['ctrl', 'l'] });
    assert.deepEqual(mapKeyboardEvent(ev('L', { ctrlKey: true, shiftKey: true })),
      { kind: 'key', keys: ['ctrl', 'shift', 'l'] });
    assert.deepEqual(mapKeyboardEvent(ev('c', { metaKey: true })), { kind: 'key', keys: ['super', 'c'] });
    assert.deepEqual(mapKeyboardEvent(ev('Enter', { altKey: true })), { kind: 'key', keys: ['alt', 'Return'] });
    assert.deepEqual(mapKeyboardEvent(ev('Delete', { ctrlKey: true, altKey: true })),
      { kind: 'key', keys: ['ctrl', 'alt', 'Delete'] });
    assert.deepEqual(mapKeyboardEvent(ev('Tab', { shiftKey: true })), { kind: 'key', keys: ['shift', 'Tab'] });
    assert.deepEqual(mapKeyboardEvent(ev('1', { ctrlKey: true })), { kind: 'key', keys: ['ctrl', '1'] });
    assert.deepEqual(mapKeyboardEvent(ev(' ', { ctrlKey: true })), { kind: 'key', keys: ['ctrl', 'space'] });
    const chord = mapKeyboardEvent(ev('x', { ctrlKey: true }));
    assert.equal(chord.kind, 'key');
  });

  it('never forwards Escape, even modified', () => {
    assert.equal(mapKeyboardEvent(ev('Escape')), null);
    assert.equal(mapKeyboardEvent(ev('Escape', { ctrlKey: true })), null);
    assert.equal(mapKeyboardEvent(ev('Escape', { shiftKey: true })), null);
    assert.equal(mapKeyboardEvent(ev('Esc')), null);
  });

  it('maps Dead, IME, and unidentified keys to null', () => {
    assert.equal(mapKeyboardEvent(ev('Dead')), null);
    assert.equal(mapKeyboardEvent(ev('Unidentified')), null);
    assert.equal(mapKeyboardEvent(ev('a', { isComposing: true })), null);
    assert.equal(mapKeyboardEvent(ev('a', { keyCode: 229 })), null);
    assert.equal(mapKeyboardEvent(ev('Process')), null);
  });

  it('maps modifier-only, lock, unknown, and malformed input to null', () => {
    for (const key of ['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'NumLock', 'AudioVolumeUp',
      'ContextMenu', 'PrintScreen', 'F13', 'Clear', 'Fn']) {
      assert.equal(mapKeyboardEvent(ev(key)), null, key);
    }
    assert.equal(mapKeyboardEvent(null), null);
    assert.equal(mapKeyboardEvent(undefined), null);
    assert.equal(mapKeyboardEvent({}), null);
    assert.equal(mapKeyboardEvent(ev('')), null);
    assert.equal(mapKeyboardEvent(ev(42)), null);
    assert.equal(mapKeyboardEvent(ev('\u0001', { ctrlKey: true })), null);
  });

  it('rss stays below 512 MiB', () => {
    const rss = process.memoryUsage().rss;
    assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
  });
});
