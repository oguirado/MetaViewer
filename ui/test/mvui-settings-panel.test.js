// MetaViewer settings panel (AC-08): strict-CSP, agent_lane anchor,
// accessible-name, host-wiring audits, plus the WCAG AA contrast matrix
// for every U4 colour pair in mv-light and mv-dark (pre- and post-
// runtime-switch). Every checker ships with a planted violation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sfcUrl = new URL('../src/settings/MvSettingsPanel.vue', import.meta.url);
const cssUrl = new URL('../src/settings/settings.css', import.meta.url);
const themeUrl = new URL('../.kit/capsule-ui-kit/src/design/theme.css', import.meta.url);
const sfc = readFileSync(sfcUrl, 'utf8');
const css = readFileSync(cssUrl, 'utf8');
const theme = readFileSync(themeUrl, 'utf8');

/**
 * @param {string} source
 * @param {string} label
 */
function assertCspClean(source, label) {
  assert.doesNotMatch(source, /(?:^|[\s"'`:=])style\s*=/m, `${label}: inline style attribute`);
  assert.doesNotMatch(source, /v-bind:style/, `${label}: v-bind:style`);
  assert.doesNotMatch(source, /v-show/, `${label}: v-show writes el.style`);
  assert.doesNotMatch(source, /setAttribute\(\s*['"]style['"]/, `${label}: setAttribute style`);
  assert.doesNotMatch(source, /\.style\.[a-zA-Z]/, `${label}: element.style write`);
}

/**
 * @param {string} template
 * @param {string} label
 * @returns {number} Audited control count.
 */
function assertAnchoredControls(template, label) {
  const tags = template.match(/<(?:button|input|select)\b[\s\S]*?>/g) ?? [];
  for (const tag of tags) {
    assert.ok(/(?:^|\s):?id=/.test(tag), `${label}: control without id: ${tag.slice(0, 80)}`);
    assert.ok(
      /(?:^|\s):?data-semantic-anchor=/.test(tag),
      `${label}: control without data-semantic-anchor: ${tag.slice(0, 80)}`,
    );
  }
  return tags.length;
}

/**
 * @param {string} template
 * @param {string} label
 */
function assertNamedControls(template, label) {
  for (const tag of template.match(/<input\b[\s\S]*?>/g) ?? []) {
    assert.ok(
      /aria-label=/.test(tag) || /aria-labelledby=/.test(tag),
      `${label}: input without accessible name: ${tag.slice(0, 80)}`,
    );
  }
  for (const el of template.match(/<button\b[\s\S]*?<\/button>/g) ?? []) {
    const text = el
      .replace(/<[^>]*>/g, ' ')
      .replace(/\{\{[^}]*\}\}/g, 'x')
      .trim();
    assert.ok(
      /aria-label=/.test(el) || /aria-labelledby=/.test(el) || text.length > 0,
      `${label}: button without accessible name: ${el.slice(0, 80)}`,
    );
  }
}

/**
 * Parse a `:root...{...}` custom-property block into a name->value map.
 * @param {string} cssText
 * @param {string} selector Exact block selector.
 * @returns {Map<string, string>}
 */
function parseBlock(cssText, selector) {
  const start = cssText.indexOf(selector);
  assert.ok(start >= 0, `theme block missing: ${selector}`);
  const open = cssText.indexOf('{', start);
  const close = cssText.indexOf('}', open);
  const map = new Map();
  for (const [, name, value] of cssText.slice(open, close).matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    map.set(name, value.trim());
  }
  return map;
}

/**
 * Resolve a token through var() chains to an opaque sRGB hex colour.
 * @param {string} token Token name without leading `--`.
 * @param {Map<string, string>} scheme Scheme block map.
 * @param {Map<string, string>} primitives Primitive block map.
 * @returns {string} Lowercase `#rrggbb`.
 */
function resolveHex(token, scheme, primitives) {
  let value = scheme.get(token) ?? primitives.get(token);
  assert.ok(value !== undefined, `token unresolved: ${token}`);
  for (let depth = 0; depth < 10; depth += 1) {
    const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value);
    if (!ref) break;
    value = scheme.get(ref[1]) ?? primitives.get(ref[1]);
    assert.ok(value !== undefined, `token unresolved: ${ref[1]}`);
  }
  assert.match(value, /^#[0-9a-f]{6}$/i, `token is not an opaque hex: ${token}=${value}`);
  return value.toLowerCase();
}

/**
 * @param {string} hex `#rrggbb`.
 * @returns {number} WCAG relative luminance.
 */
function luminance(hex) {
  const channels = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/**
 * @param {string} foreground `#rrggbb`.
 * @param {string} background `#rrggbb`.
 * @returns {number} WCAG contrast ratio.
 */
function contrastRatio(foreground, background) {
  const high = Math.max(luminance(foreground), luminance(background));
  const low = Math.min(luminance(foreground), luminance(background));
  return (high + 0.05) / (low + 0.05);
}

test('settings SFC and CSS are strict-CSP clean; planted styles fail', () => {
  assertCspClean(sfc, 'MvSettingsPanel.vue');
  assertCspClean(css, 'settings.css');
  assert.throws(() => assertCspClean('<input style="accent-color:red" />', 'planted'), /inline style/);
  assert.throws(() => assertCspClean('<div v-show="ready" />', 'planted'), /v-show/);
});

test('scheme radios carry id, anchor and accessible name; planted gaps fail', async () => {
  const count = assertAnchoredControls(sfc, 'MvSettingsPanel.vue');
  assert.ok(count >= 1, `expected the scheme radio template, saw ${count}`);
  assert.ok(sfc.includes('v-for="option in options"'), 'one radio template per scheme option');
  const model = await import('../src/settings/settingsModel.js');
  assert.equal(model.MV_SCHEMES.length, 2);
  assertNamedControls(sfc, 'MvSettingsPanel.vue');
  assert.ok(sfc.includes('role="radiogroup"'), 'scheme group role');
  assert.ok(sfc.includes('MV_SETTINGS_ANCHORS.schemeGroup'), 'group anchor wired');
  assert.throws(
    () => assertAnchoredControls('<input type="radio" id="x" />', 'planted'),
    /without data-semantic-anchor/,
  );
  assert.throws(
    () => assertNamedControls('<input type="radio" id="x" data-semantic-anchor="a" />', 'planted'),
    /without accessible name/,
  );
});

test('settings panel persists through the injected host and live-switches', () => {
  assert.ok(sfc.includes("from 'capsule-ui-kit/theme'"), 'kit theme adapter imported');
  assert.ok(sfc.includes('setKitScheme'), 'live scheme switch wired');
  assert.ok(sfc.includes('createHostSettingsStore'), 'host store wired');
  assert.ok(sfc.includes('settingsHost: { type: Object, required: true }'), 'host injected as prop');
  assert.ok(sfc.includes('settingsRefusalFor'), 'typed refusal wired');
  assert.ok(sfc.includes("defineEmits(['scheme-change'])"), 'scheme-change emit declared');
  assert.ok(sfc.includes('src="./settings.css"'), 'lane CSS file used');
  assert.ok(!sfc.includes('localStorage'), 'never persists to local storage');
});

test('settings SFC and CSS carry no raw colour literals; planted hex fails', () => {
  /** @param {string} source @param {string} label */
  const assertNoHex = (source, label) => {
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, `${label}: raw colour literal`);
  };
  assertNoHex(sfc, 'MvSettingsPanel.vue');
  assertNoHex(css, 'settings.css');
  assert.throws(() => assertNoHex('.x { color: #0064e0; }', 'planted'), /raw colour/);
});

test('settings sources carry no placeholder, debug or raw error text', () => {
  /** @param {string} source @param {string} label */
  const assertNoDebug = (source, label) => {
    assert.doesNotMatch(source, /TODO|FIXME|XXX|HACK|console\.log|debugger|placeholder\s*=/, `${label}`);
  };
  assertNoDebug(sfc, 'MvSettingsPanel.vue');
  assertNoDebug(css, 'settings.css');
  assert.throws(() => assertNoDebug('placeholder="scheme"', 'planted'), /planted/);
});

test('U4 text pairs reach WCAG AA in mv-light and after a switch to mv-dark', () => {
  const primitives = parseBlock(theme, ':root');
  /** @type {Array<[string, string, string]>} [foreground, background, label] */
  const textPairs = [
    ['cuk-semantic-text-primary', 'cuk-semantic-surface-panel', 'body'],
    ['cuk-semantic-text-primary', 'cuk-semantic-surface-interactive', 'button'],
    ['cuk-semantic-text-accent', 'cuk-semantic-surface-panel', 'row select'],
    ['cuk-semantic-status-warning-text', 'cuk-semantic-status-warning-surface', 'recording refusal'],
    ['cuk-semantic-status-error-text', 'cuk-semantic-status-error-surface', 'settings refusal'],
    ['cuk-semantic-status-error-text', 'cuk-semantic-surface-panel', 'row error'],
    ['cuk-semantic-status-success-text', 'cuk-semantic-status-success-surface', 'sealed chip'],
  ];
  for (const schemeName of ['mv-light', 'mv-dark']) {
    const scheme = parseBlock(
      theme,
      `:root[data-theme-scheme="${schemeName}"][data-theme-contrast="normal"]`,
    );
    for (const [foreground, background, label] of textPairs) {
      const ratio = contrastRatio(resolveHex(foreground, scheme, primitives), resolveHex(background, scheme, primitives));
      assert.ok(ratio >= 4.5, `${schemeName} ${label} text ratio ${ratio.toFixed(2)} < 4.5`);
    }
  }
});

test('U4 non-text indicators reach 3:1 in mv-light and after a switch to mv-dark', () => {
  const primitives = parseBlock(theme, ':root');
  /** @type {Array<[string, string, string]>} [foreground, background, label] */
  const uiPairs = [
    ['cuk-semantic-accent-primary', 'cuk-semantic-surface-panel', 'radio accent'],
    ['cuk-semantic-focus-ring-color', 'cuk-semantic-surface-panel', 'focus ring'],
  ];
  for (const schemeName of ['mv-light', 'mv-dark']) {
    const scheme = parseBlock(
      theme,
      `:root[data-theme-scheme="${schemeName}"][data-theme-contrast="normal"]`,
    );
    for (const [foreground, background, label] of uiPairs) {
      const ratio = contrastRatio(resolveHex(foreground, scheme, primitives), resolveHex(background, scheme, primitives));
      assert.ok(ratio >= 3.0, `${schemeName} ${label} ratio ${ratio.toFixed(2)} < 3.0`);
    }
  }
});

test('contrast oracle is sensitive: a known-weak pair scores below AA', () => {
  const primitives = parseBlock(theme, ':root');
  const light = parseBlock(theme, ':root[data-theme-scheme="mv-light"][data-theme-contrast="normal"]');
  const weak = contrastRatio(
    resolveHex('cuk-semantic-text-disabled', light, primitives),
    resolveHex('cuk-semantic-surface-panel', light, primitives),
  );
  assert.ok(weak < 4.5, `oracle cannot fail: weak pair scored ${weak.toFixed(2)}`);
});
