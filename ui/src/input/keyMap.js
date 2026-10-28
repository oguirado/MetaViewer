/**
 * @fileoverview KeyboardEvent to surface_input/v1 key/type mapping (single table).
 *
 * Plain JavaScript with JSDoc; no dependencies, no DOM access. Two tables map DOM
 * `KeyboardEvent.key` names to the X keysym spelling the daemon adapter accepts.
 * Printable keys without ctrl/alt/super become `type`; named keys and chords
 * become `key`. Single-chars with ctrl/alt/super map ASCII punctuation/space
 * through PUNCT_KEYS (digits/letters stay, lowercased); any other character
 * with a modifier maps to null. Every emitted chord stays within the host
 * adapter grammar (at most 8 keys, joined with "+" at most 32 chars).
 * Escape always maps to null (it releases focus, never forwarded);
 * Dead/IME/unidentified keys map to null. The host owns key NAME spelling:
 * future renames land in NAMED_KEYS/PUNCT_KEYS only.
 */

/**
 * DOM `KeyboardEvent.key` to keysym spelling (X11 names: Return, BackSpace,
 * Page_Up, ...). Includes a few legacy DOM aliases (Del, Ins, arrows).
 *
 * @type {Record<string, string>}
 */
const NAMED_KEYS = {
  Enter: 'Return',
  Backspace: 'BackSpace',
  Tab: 'Tab',
  Delete: 'Delete',
  Del: 'Delete',
  Insert: 'Insert',
  Ins: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page_Up',
  PageDown: 'Page_Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Left: 'Left',
  Right: 'Right',
  Up: 'Up',
  Down: 'Down',
};
for (let f = 1; f <= 12; f += 1) {
  NAMED_KEYS[`F${f}`] = `F${f}`;
}

/**
 * Printable ASCII punctuation/space to X keysym spelling, used only inside
 * chords (with ctrl/alt/super). Digits and letters are not listed here: they
 * keep their own spelling, lowercased.
 *
 * @type {Record<string, string>}
 */
const PUNCT_KEYS = {
  ' ': 'space',
  '!': 'exclam',
  '"': 'quotedbl',
  '#': 'numbersign',
  $: 'dollar',
  '%': 'percent',
  '&': 'ampersand',
  "'": 'apostrophe',
  '(': 'parenleft',
  ')': 'parenright',
  '*': 'asterisk',
  '+': 'plus',
  ',': 'comma',
  '-': 'minus',
  '.': 'period',
  '/': 'slash',
  ':': 'colon',
  ';': 'semicolon',
  '<': 'less',
  '=': 'equal',
  '>': 'greater',
  '?': 'question',
  '@': 'at',
  '[': 'bracketleft',
  '\\': 'backslash',
  ']': 'bracketright',
  '^': 'asciicircum',
  _: 'underscore',
  '`': 'grave',
  '{': 'braceleft',
  '|': 'bar',
  '}': 'braceright',
  '~': 'asciitilde',
};

/**
 * Host adapter chord limits: at most 8 keys, joined with "+" at most 32 chars.
 *
 * @param {string[]} chord
 * @returns {boolean} True only when the chord fits both limits.
 */
function chordWithinLimits(chord) {
  if (chord.length < 1 || chord.length > 8) return false;
  return chord.join('+').length <= 32;
}

/**
 * Minimal structural view of a KeyboardEvent (real events and test fakes).
 *
 * @typedef {Object} MappedKeyInput
 * @property {unknown} key
 * @property {unknown} [ctrlKey]
 * @property {unknown} [altKey]
 * @property {unknown} [shiftKey]
 * @property {unknown} [metaKey]
 * @property {unknown} [isComposing]
 * @property {unknown} [keyCode]
 */

/**
 * @typedef {Object} KeyMapResult
 * @property {string} kind - type | key.
 * @property {string} [text] - type payload (one code point).
 * @property {string[]} [keys] - key chord.
 */

/**
 * Maps one keydown to a surface_input/v1 event, or null when never forwarded.
 *
 * @param {MappedKeyInput} ev
 * @returns {KeyMapResult | null}
 */
export function mapKeyboardEvent(ev) {
  if (ev === null || typeof ev !== 'object') return null;
  if (ev.isComposing === true || ev.keyCode === 229) return null;
  const key = ev.key;
  if (typeof key !== 'string' || key === '' || key === 'Unidentified' || key === 'Dead') return null;
  if (key === 'Escape' || key === 'Esc') return null;
  const ctrl = ev.ctrlKey === true;
  const alt = ev.altKey === true;
  const shift = ev.shiftKey === true;
  const meta = ev.metaKey === true;
  const normalized = key === 'Spacebar' ? ' ' : key;
  const chars = Array.from(normalized);
  if (chars.length === 1) {
    const ch = chars[0];
    const point = ch.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) return null;
    if (!ctrl && !alt && !meta) return { kind: 'type', text: ch };
    // Chord path: ASCII punctuation/space map to X keysym names, ASCII
    // digits/letters keep their spelling (lowercased); anything else with a
    // modifier (non-ASCII, emoji) is not forwarded.
    /** @type {string | undefined} */
    let name;
    if (Object.hasOwn(PUNCT_KEYS, ch)) {
      name = PUNCT_KEYS[ch];
    } else if (
      (point >= 0x30 && point <= 0x39)
      || (point >= 0x41 && point <= 0x5a)
      || (point >= 0x61 && point <= 0x7a)
    ) {
      name = ch.toLowerCase();
    } else {
      return null;
    }
    /** @type {string[]} */
    const chord = [];
    if (ctrl) chord.push('ctrl');
    if (alt) chord.push('alt');
    if (shift) chord.push('shift');
    if (meta) chord.push('super');
    chord.push(name);
    if (!chordWithinLimits(chord)) return null;
    return { kind: 'key', keys: chord };
  }
  /** @type {string | undefined} */
  const mapped = NAMED_KEYS[normalized];
  if (typeof mapped !== 'string') return null;
  if (!ctrl && !alt && !shift && !meta) return { kind: 'key', keys: [mapped] };
  /** @type {string[]} */
  const chord = [];
  if (ctrl) chord.push('ctrl');
  if (alt) chord.push('alt');
  if (shift) chord.push('shift');
  if (meta) chord.push('super');
  chord.push(mapped);
  if (!chordWithinLimits(chord)) return null;
  return { kind: 'key', keys: chord };
}
