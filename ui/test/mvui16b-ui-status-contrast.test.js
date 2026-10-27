// MVUI16B lane T (L2-7): the status bar 'Main wall' crumb measured 4.35:1
// rendered (AA needs 4.5). Ownership: the kit owns the tone->token colour
// rules (StatusBar.vue, never edited); the renderer owns the crumb tone prop
// (App.vue). The kit default for the last crumb is accent, whose token math
// is marginal in mv-light (4.745); antialiased rendering measured 4.35. The
// renderer now selects tone 'strong' (text-primary on sunken, 14.7/18.3),
// via existing kit API and tokens, ids/anchors unchanged. Negative controls:
// the tone assertion rejects the untoned default, and the helper math pins
// the marginal old pair plus a planted failing pair.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const APP_URL = new URL('../src/App.vue', import.meta.url);
const STATUSBAR_URL = new URL('../.kit/capsule-ui-kit/src/shell/StatusBar.vue', import.meta.url);
const MV_SRC_URL = new URL('../src/', import.meta.url);
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
  const x = luminance(foreground);
  const y = luminance(background);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Pin the specific kit selector, rather than accepting another rule's color. */
function assertKitTextRule(source, selector, token, background) {
  const rule = source.split(selector + '{')[1]?.split('}')[0]
    ?? source.split(selector + ' {')[1]?.split('}')[0];
  assert.ok(rule, selector);
  assert.ok(rule.includes('color: var(--cuk-semantic-text-' + token + ')'), selector);
  assert.ok(!rule.includes('--cuk-semantic-text-disabled'), 'legacy disabled text rejected');
  for (const mode of MODES) {
    const foreground = resolveColor(kitTokens, 'semantic.text.' + token, mode);
    const surface = resolveColor(kitTokens, 'semantic.surface.' + background, mode);
    assert.ok(contrast(foreground, surface) >= MIN_RATIO, selector + '/' + mode);
  }
}

/** The renderer-owned lever: wall crumb id/label byte-identical, tone strong. */
function assertWallCrumbTone(appSource) {
  assert.ok(
    appSource.includes(`:crumbs="[{ id: 'wall', label: 'Main wall', tone: 'strong' }]"`),
    'wall crumb keeps id/label and selects the strong tone',
  );
}

/** @param {URL} dir @param {string} prefix @returns {string[]} repo-relative source paths */
function collectSource(dir, prefix) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) out.push(...collectSource(new URL(entry.name + '/', dir), prefix + entry.name + '/'));
    else if (/\.(vue|js|css)$/.test(entry.name)) out.push(prefix + entry.name);
  }
  return out;
}

describe('mvui16b L2-7 wall-crumb contrast', () => {
  test('renderer selects the strong tone on the byte-identical wall crumb', () => {
    const app = readFileSync(APP_URL, 'utf8');
    assertWallCrumbTone(app);
    assert.throws(() => assertWallCrumbTone(app.replace(`, tone: 'strong'`, '')),
      'untoned default (kit accent) is rejected');
  });

  test('strong crumb reaches AA on the sunken bar in mv-light and mv-dark', () => {
    const bar = readFileSync(STATUSBAR_URL, 'utf8');
    assert.ok(bar.includes('background: var(--cuk-semantic-surface-sunken)'), 'sunken bar');
    assertKitTextRule(bar, '.s1-statusbar-crumb-strong', 'primary', 'sunken');
    assert.throws(() => assertKitTextRule(
      bar.replace('color: var(--cuk-semantic-text-primary);font-weight',
        'color: var(--cuk-semantic-text-disabled);font-weight'),
      '.s1-statusbar-crumb-strong', 'primary', 'sunken'),
    'disabled-text mutant fails');
  });

  test('no MetaViewer source overrides the kit crumb selectors', () => {
    const offenders = [];
    for (const rel of collectSource(MV_SRC_URL, '')) {
      const source = readFileSync(new URL(rel, MV_SRC_URL), 'utf8');
      for (const selector of ['s1-statusbar-crumb-', 's1-statusbar-crumbs']) {
        if (source.includes(selector)) offenders.push(rel + '#' + selector);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe('mvui16b L2-7 planted-failure controls', () => {
  test('helper math pins the marginal old pair and a failing pair', () => {
    const old = contrast('#0064e0', '#edf1f5');
    assert.ok(Math.abs(old - 4.745) < 0.01, `old accent-on-sunken token math: ${old.toFixed(3)}`);
    const failing = contrast('#bcc0c4', '#edf1f5');
    assert.ok(failing < MIN_RATIO, `planted pair must fail: ${failing.toFixed(3)}`);
    assert.ok(Math.abs(failing - 1.612) < 0.01, `planted pair math: ${failing.toFixed(3)}`);
  });

  test('malformed color input is rejected first', () => {
    for (const bad of ['red', '#fff', '#ffffff00', '#gggggg', '']) {
      assert.throws(() => luminance(bad), /hex/i);
    }
  });
});

test('mvui16b-ui memory ceiling', () => {
  const rss = process.memoryUsage().rss;
  if (process.env.MVUI16_MEASURE) console.log(`mvui16b-ui-status-contrast rss MiB: ${Math.round(rss / 1048576)}`);
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
