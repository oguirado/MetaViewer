/** Lane V3: MV-3/MV-4 ownership plus a MetaViewer contrast guard.
 * MV-3 ("Find a capsule...") and MV-4 ("No terminal sessions.") render through
 * kit components and kit (`--cuk-*`) tokens. This suite pins that ownership,
 * guards MetaViewer-owned text pairs at WCAG AA in both resolved modes, and
 * proves the contrast helper rejects planted low-contrast mutants.
 * @module mvui2-contrast-tokens.test
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const MV_TOKENS_URL = new URL('../src/design/metaviewer.tokens.json', import.meta.url);
const MV_CSS_URL = new URL('../src/design/metaviewer.css', import.meta.url);
const MV_SRC_URL = new URL('../src/', import.meta.url);
const TOPBAR_URL = new URL('../.kit/capsule-ui-kit/src/shell/TopBar.vue', import.meta.url);
const TABS_URL = new URL('../.kit/capsule-ui-kit/src/terminal/TerminalSessionTabs.vue', import.meta.url);

/** @type {Record<string, any>} */
const tokens = JSON.parse(readFileSync(MV_TOKENS_URL, 'utf8'));
const cssText = readFileSync(MV_CSS_URL, 'utf8');

const MIN_RATIO = 4.5;
const MODES = ['light.normal', 'dark.normal'];
const TEXTS = ['semantic.text.primary', 'semantic.text.muted', 'semantic.text.disabled', 'semantic.text.accent'];
const BACKGROUNDS = ['semantic.surface.canvas', 'semantic.surface.panel', 'semantic.surface.chrome', 'semantic.surface.sunken'];
const KIT_SELECTORS = ['s1-topbar-search', 'cui-terminal-tabs__empty', 'ai-terminal-pane__empty'];

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

/** @param {any} node @param {string} path @param {string[]} hits */
function findWired350(node, path, hits) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.$type === 'string') {
    for (const v of [node.$value, ...Object.values(node.modes ?? {})]) {
      if (typeof v === 'string' && v.includes('neutral.350')) hits.push(path);
    }
    return;
  }
  for (const [key, value] of Object.entries(node)) findWired350(value, path ? path + '.' + key : key, hits);
}

describe('mvui2 MetaViewer-owned text contrast', () => {
  test('body and secondary text reach 4.5:1 on every base surface in both modes', () => {
    for (const mode of MODES) {
      for (const fg of TEXTS) {
        for (const bg of BACKGROUNDS) {
          const fore = resolveColor(tokens, fg, mode);
          const back = resolveColor(tokens, bg, mode);
          const ratio = contrast(fore, back);
          assert.ok(ratio >= MIN_RATIO, `${mode}/${fg}/${bg} ${fore}/${back} ratio=${ratio.toFixed(3)}`);
        }
      }
    }
  });

  test('mv schemes carry no MetaViewer mode block: :root defaults equal light.normal', () => {
    assert.ok(!cssText.includes('mv-light'), 'no mv-light block in metaviewer.css');
    assert.ok(!cssText.includes('mv-dark'), 'no mv-dark block in metaviewer.css');
    assert.deepEqual(tokens.axes.scheme.resolvedModes, ['light', 'dark']);
    const root = cssText.slice(0, cssText.indexOf('}'));
    assert.ok(root.includes('--mv-semantic-text-disabled: var(--mv-primitive-color-neutral-600);'));
    assert.ok(root.includes('--mv-semantic-text-muted: var(--mv-primitive-color-neutral-700);'));
    assert.ok(root.includes('--mv-semantic-text-primary: var(--mv-primitive-color-neutral-900);'));
  });

  test('neutral-350 stays unwired from every semantic and component token', () => {
    const hits = [];
    findWired350(tokens.semantic, 'semantic', hits);
    findWired350(tokens.component, 'component', hits);
    assert.deepEqual(hits, []);
  });
});

describe('mvui2 MV-3/MV-4 kit ownership', () => {
  test('MV-3 search trigger renders through kit tokens only', () => {
    const topbar = readFileSync(TOPBAR_URL, 'utf8');
    assert.ok(topbar.includes('data-semantic-anchor="shell/navigation/command-open"'));
    assert.ok(topbar.includes('{{ searchPlaceholder }}'));
    assert.ok(topbar.includes('color: var(--cuk-semantic-text-disabled)'));
    assert.ok(topbar.includes('background: var(--cuk-semantic-surface-canvas)'));
    assert.ok(!topbar.includes('--mv-'), 'kit TopBar references no MetaViewer token');
  });

  test('MV-4 empty row renders through kit tokens only', () => {
    const tabs = readFileSync(TABS_URL, 'utf8');
    assert.ok(tabs.includes('No terminal sessions.'));
    assert.ok(tabs.includes('cui-terminal-tabs__empty'));
    assert.ok(tabs.includes('color: var(--cuk-semantic-text-disabled)'));
    assert.ok(tabs.includes('background-color: var(--cuk-semantic-surface-sunken)'));
    assert.ok(!tabs.includes('--mv-'), 'kit tabs reference no MetaViewer token');
  });

  test('no MetaViewer source overrides those kit selectors', () => {
    const offenders = [];
    for (const rel of collectSource(MV_SRC_URL, '')) {
      const text = readFileSync(new URL(rel, MV_SRC_URL), 'utf8');
      for (const selector of KIT_SELECTORS) {
        if (text.includes(selector)) offenders.push(rel + '#' + selector);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe('mvui2 planted-failure controls', () => {
  test('contrast helper rejects the planted vision-failure pairs', () => {
    const light = contrast('#bcc0c4', '#ffffff');
    assert.ok(light < MIN_RATIO, `planted light pair must fail: ${light.toFixed(3)}`);
    assert.ok(Math.abs(light - 1.83) < 0.01, `planted light math: ${light.toFixed(3)}`);
    const sunken = contrast('#bcc0c4', '#edf1f5');
    assert.ok(sunken < MIN_RATIO, `planted sunken pair must fail: ${sunken.toFixed(3)}`);
    assert.ok(Math.abs(sunken - 1.61) < 0.01, `planted sunken math: ${sunken.toFixed(3)}`);
    assert.ok(contrast('#5d6c7b', '#0a1317') < MIN_RATIO, 'planted dark pair must fail');
  });

  test('wiring neutral-350 as disabled text fails the pair check', () => {
    const mutant = structuredClone(tokens);
    mutant.semantic.text.disabled.modes['light.normal'] = '{primitive.color.neutral.350}';
    const fore = resolveColor(mutant, 'semantic.text.disabled', 'light.normal');
    const back = resolveColor(mutant, 'semantic.surface.canvas', 'light.normal');
    assert.equal(fore, '#bcc0c4');
    assert.ok(contrast(fore, back) < MIN_RATIO, 'mutant disabled-on-canvas must fail');
  });

  test('malformed color input is rejected first', () => {
    for (const bad of ['red', '#fff', '#ffffff00', '#gggggg', '']) {
      assert.throws(() => luminance(bad), /hex/i);
    }
  });
});
