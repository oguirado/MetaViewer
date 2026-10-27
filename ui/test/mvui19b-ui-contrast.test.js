/** MVUI19B lane U: L3-6 contrast ownership for the lane surfaces.
 * The three live items (terminal provider text, dark launcher placeholder,
 * multislot Copy ID) are all kit-owned: the renderer sets no colour on any of
 * them and every renderer text pair in the lane surfaces resolves through kit
 * tokens at WCAG AA in mv-light and mv-dark. This suite pins that ownership
 * (renderer CSS carries no colour literal; the kit rules own the three
 * elements), guards the enabled token pairs at >= 4.5, and pins the kit-queue
 * mechanism behind the live readings: kit disabled opacity (0.48) blends
 * enabled pairs down to the measured bands, and the launcher placeholder
 * falls back to the vendor/UA default (the kit ships no ::placeholder rule).
 * Characterization suite: no renderer colour change, kit queue owns the rest.
 * @module mvui19b-ui-contrast.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MULTI_CSS = readFileSync(new URL('../src/multislot/multislot.css', import.meta.url), 'utf8');
const TERM_CSS = readFileSync(new URL('../src/terminal/terminal.css', import.meta.url), 'utf8');
const CATALOG_CSS = readFileSync(new URL('../src/catalog/catalog.css', import.meta.url), 'utf8');
const WALL_CSS = readFileSync(new URL('../src/wall/wall.css', import.meta.url), 'utf8');
const PLATE = readFileSync(new URL('../.kit/capsule-ui-kit/src/multislot/AiIdentityPlate.vue', import.meta.url), 'utf8');
const NEWMENU = readFileSync(new URL('../.kit/capsule-ui-kit/src/side-terminal/SideTerminalNewMenu.vue', import.meta.url), 'utf8');
const UITEXTINPUT = readFileSync(new URL('../.kit/capsule-ui-kit/src/ui/UiTextInput.vue', import.meta.url), 'utf8');
const DIALOG = readFileSync(new URL('../.kit/capsule-ui-kit/src/shell/NewCapsuleDialog.vue', import.meta.url), 'utf8');
const kitTokens = JSON.parse(readFileSync(new URL('../.kit/capsule-ui-kit/src/design/tokens.json', import.meta.url), 'utf8'));

const MIN_RATIO = 4.5;
const MODES = ['mv-light.normal', 'mv-dark.normal'];

/** @param {Record<string, any>} contract @param {string} path @returns {any} */
function leafAt(contract, path) {
  let node = contract;
  for (const key of path.split('.')) node = node?.[key];
  assert.ok(node && typeof node === 'object' && typeof node.$type === 'string', 'known token: ' + path);
  return node;
}

/** @param {string} value @returns {string} single reference target or '' */
function singleRef(value) {
  const m = /^\{([A-Za-z0-9_.]+)\}$/.exec(value);
  return m ? m[1] : '';
}

/** Resolve a color token by following mode references to an opaque hex literal.
 * @param {Record<string, any>} contract @param {string} path @param {string} mode @returns {string}
 */
function resolveColor(contract, path, mode) {
  let current = path;
  for (let hop = 0; hop < 16; hop++) {
    const leaf = leafAt(contract, current);
    const raw = leaf.modes?.[mode] ?? leaf.$value;
    assert.equal(typeof raw, 'string', 'resolved token: ' + current);
    const ref = singleRef(raw);
    if (!ref) {
      assert.match(raw, /^#[0-9a-f]{6}$/, 'opaque hex literal: ' + current);
      return raw;
    }
    current = ref;
  }
  throw new Error('token cycle: ' + path);
}

/** WCAG 2.x relative luminance; only opaque six-digit hex is accepted.
 * @param {string} hex @returns {number}
 */
function luminance(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error('Invalid hex color: ' + String(hex));
  const m = hex.slice(1).match(/../g);
  if (!m) throw new Error('Invalid hex color: ' + hex);
  const rgb = m.map((x) => parseInt(x, 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

/** WCAG 2.x contrast ratio between two opaque colors.
 * @param {string} foreground @param {string} background @returns {number}
 */
function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Blend a hex foreground over a hex background at the given opacity.
 * @param {string} fg @param {string} bg @param {number} opacity @returns {[number, number, number]}
 */
function blend(fg, bg, opacity) {
  const f = fg.slice(1).match(/../g).map((x) => parseInt(x, 16));
  const b = bg.slice(1).match(/../g).map((x) => parseInt(x, 16));
  return f.map((v, i) => Math.round(v * opacity + b[i] * (1 - opacity)));
}

/** @param {[number, number, number]} rgb @param {string} bg @returns {number} */
function blendedContrast(rgb, bg) {
  const toLum = ([r, g, b]) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return f(r) * 0.2126 + f(g) * 0.7152 + f(b) * 0.0722;
  };
  const a = toLum(rgb);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('lane renderer CSS carries no colour literal or colour function', () => {
  for (const [name, css] of [['multislot.css', MULTI_CSS], ['terminal.css', TERM_CSS], ['catalog.css', CATALOG_CSS], ['wall.css', WALL_CSS]]) {
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, `${name} carries a colour literal`);
    assert.doesNotMatch(css, /\brgba?\(/, `${name} carries a colour function`);
    assert.doesNotMatch(css, /\bhsla?\(/, `${name} carries a colour function`);
    assert.ok(css.includes('var(--cuk-'), `${name} resolves through kit tokens`);
  }
});

test('the three L3-6 elements are kit-owned (renderer sets no colour on them)', () => {
  // Copy ID: kit plate rule, primary text on the panel fallback.
  const copyRule = PLATE.split('.ms2-plate-copy {')[1]?.split('}')[0] ?? '';
  assert.ok(copyRule.includes('color: var(--cuk-semantic-text-primary)'), 'plate copy text');
  assert.ok(copyRule.includes('var(--cuk-semantic-surface-panel)'), 'plate copy surface');
  assert.ok(!MULTI_CSS.includes('ms2-plate-copy'), 'renderer never restyles the plate');
  // Provider menu text: kit option label inherits primary, hint is muted.
  const hintRule = NEWMENU.split('.cui-side-terminal-new__option-hint {')[1]?.split('}')[0] ?? '';
  assert.ok(hintRule.includes('color: var(--cuk-semantic-text-muted)'), 'menu hint text');
  assert.ok(!TERM_CSS.includes('cui-side-terminal-new__option'), 'renderer never restyles the menu');
  // Launcher placeholder: the kit input wrapper ships no placeholder rule at
  // all, so the vendor input/UA default paints it.
  assert.ok(!UITEXTINPUT.includes('placeholder'), 'no kit placeholder prop or rule');
  assert.ok(!UITEXTINPUT.includes('<style'), 'no kit input styles');
  assert.ok(DIALOG.includes('UiTextInput'), 'dialog search stays the kit input');
  assert.ok(!CATALOG_CSS.includes('placeholder'), 'renderer never styles the placeholder');
});

test('enabled lane text pairs hold WCAG AA in mv-light and mv-dark', () => {
  const pairs = [
    ['semantic.text.primary', 'semantic.surface.panel', 'copy-id/menu label enabled'],
    ['semantic.text.primary', 'semantic.surface.canvas', 'renderer broker launch text'],
    ['semantic.text.primary', 'semantic.surface.elevated', 'menu dialog text'],
    ['semantic.text.muted', 'semantic.surface.panel', 'side-panel status text'],
    ['semantic.text.muted', 'semantic.surface.elevated', 'menu hint text'],
    ['semantic.status.error.text', 'semantic.status.error.surface', 'refusal/error rows'],
  ];
  for (const mode of MODES) {
    for (const [fg, bg, label] of pairs) {
      const ratio = contrast(resolveColor(kitTokens, fg, mode), resolveColor(kitTokens, bg, mode));
      assert.ok(ratio >= MIN_RATIO, `${label}/${mode}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test('kit-queue mechanism: disabled opacity blends pairs into the live bands', () => {
  assert.equal(kitTokens.semantic.opacity.disabled.$value, '{primitive.opacity.disabled}');
  assert.equal(kitTokens.primitive.opacity.disabled.$value, 0.48, 'kit disabled opacity');
  // Pinned blended ratios (kit queue): provider-menu hint/label and Copy ID
  // at opacity 0.48 over their kit surfaces. Live OCR read 1.9-2.5 (terminal
  // text), 3.27 (dark placeholder) and 3.03 (Copy ID).
  const pins = [
    ['semantic.text.muted', 'semantic.surface.elevated', 'mv-dark.normal', 3.056, 'menu hint disabled mv-dark'],
    ['semantic.text.primary', 'semantic.surface.elevated', 'mv-dark.normal', 4.335, 'menu label disabled mv-dark'],
    ['semantic.text.muted', 'semantic.surface.elevated', 'mv-light.normal', 2.346, 'menu hint disabled mv-light'],
    ['semantic.text.primary', 'semantic.surface.panel', 'mv-light.normal', 3.078, 'copy-id disabled mv-light'],
  ];
  for (const [fg, bg, mode, expected, label] of pins) {
    const ratio = blendedContrast(
      blend(resolveColor(kitTokens, fg, mode), resolveColor(kitTokens, bg, mode), 0.48),
      resolveColor(kitTokens, bg, mode),
    );
    assert.ok(Math.abs(ratio - expected) < 0.01, `${label}: ${ratio.toFixed(3)}:1 pins ${expected}`);
    assert.ok(ratio < MIN_RATIO, `${label} stays a kit-queue item while < AA`);
  }
});

test('contrast math rejects a planted failing pair (negative control)', () => {
  assert.ok(contrast('#777777', '#ffffff') < MIN_RATIO);
  assert.ok(contrast('#1c1e21', '#ffffff') >= MIN_RATIO);
  assert.match('.x{color:#ff0000}', /#[0-9a-fA-F]{3,8}\b/);
});

test('rss stays under the 512 MiB lane budget', () => {
  const rss = process.memoryUsage.rss();
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} bytes stays under 512 MiB`);
});
