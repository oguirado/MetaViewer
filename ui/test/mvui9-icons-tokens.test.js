// MVUI9 lane I: capsule chrome token and hygiene audit.
// Renderer chrome in the audit scope (wall, multislot host, recording
// panel, broker menu, shell actions) styles through kit/design tokens only:
// no raw colour literals, no debug or placeholder text, and no inline-style
// writes in the wall scope. Each checker ships a planted violation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * @returns {string[]} Repo-relative audit scope paths.
 */
function scopeFiles() {
  const scope = [
    'src/App.vue',
    'src/multislot/MultislotHost.vue',
    'src/multislot/multislot.css',
    'src/recording/MvRecordingPanel.vue',
    'src/recording/recording.css',
    'src/recording/recordingModel.js',
    'src/terminal/BrokerLaunchControls.vue',
    'src/wall/wall.css',
  ];
  const wallDir = new URL('../src/wall/', import.meta.url);
  for (const name of readdirSync(wallDir).filter((entry) => entry.endsWith('.vue')).sort()) {
    scope.push(`src/wall/${name}`);
  }
  return scope;
}

/**
 * @param {string} rel Repo-relative path under ui/.
 * @returns {string} File text.
 */
function readScope(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

/**
 * @param {string} source File text.
 * @param {string} label Assertion label.
 */
function assertNoRawColour(source, label) {
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, `${label}: raw colour literal`);
  assert.doesNotMatch(source, /\brgba?\(/, `${label}: raw rgb() literal`);
  assert.doesNotMatch(source, /\bhsla?\(/, `${label}: raw hsl() literal`);
}

/**
 * @param {string} source File text.
 * @param {string} label Assertion label.
 */
function assertNoDebugText(source, label) {
  assert.doesNotMatch(
    source,
    /TODO|FIXME|XXX|HACK|console\.log|debugger|(?<![A-Za-z0-9_-])placeholder\s*=/,
    `${label}: debug or placeholder text`,
  );
}

/**
 * Wall-scope strict CSP surface: classes only, never style writes.
 * @param {string} source File text.
 * @param {string} label Assertion label.
 */
function assertWallCspClean(source, label) {
  assert.doesNotMatch(source, /(?:^|[\s"'`:=])style\s*=/m, `${label}: inline style attribute`);
  assert.doesNotMatch(source, /v-bind:style/, `${label}: v-bind:style`);
  assert.doesNotMatch(source, /:style=/, `${label}: :style binding`);
  assert.doesNotMatch(source, /v-show/, `${label}: v-show writes el.style`);
  assert.doesNotMatch(source, /setAttribute\(\s*['"]style['"]/, `${label}: setAttribute style`);
  assert.doesNotMatch(source, /\.style\.[a-zA-Z]/, `${label}: element.style write`);
}

test('audit scope carries no raw colour literals: tokens only', () => {
  const scope = scopeFiles();
  assert.ok(scope.length >= 10, `scope covers wall, multislot, panel, menu and shell, saw ${scope.length}`);
  for (const rel of scope) assertNoRawColour(readScope(rel), rel);
  assert.throws(() => assertNoRawColour('.x { color: #fff; }', 'planted'), /raw colour/);
  assert.throws(() => assertNoRawColour('.x { color: #12345678; }', 'planted'), /raw colour/);
  assert.throws(() => assertNoRawColour('.x { color: rgb(1, 2, 3); }', 'planted'), /raw rgb/);
  assert.throws(() => assertNoRawColour('.x { color: hsl(0, 0%, 0%); }', 'planted'), /raw hsl/);
});

test('audit scope carries no debug or placeholder text', () => {
  for (const rel of scopeFiles()) assertNoDebugText(readScope(rel), rel);
  assert.throws(() => assertNoDebugText('<!-- TODO: wire -->', 'planted'), /planted/);
  assert.throws(() => assertNoDebugText('console.log(x)', 'planted'), /planted/);
  assert.throws(() => assertNoDebugText('<input placeholder="x" />', 'planted'), /planted/);
});

test('wall scope is strict-CSP clean; planted style writes fail', () => {
  const wall = scopeFiles().filter((rel) => rel.startsWith('src/wall/'));
  assert.ok(wall.length >= 4, `wall scope covers components and css, saw ${wall.length}`);
  for (const rel of wall) assertWallCspClean(readScope(rel), rel);
  assert.throws(() => assertWallCspClean('<button style="color:red">x</button>', 'planted'), /inline style/);
  assert.throws(() => assertWallCspClean('<div :style="s" />', 'planted'), /inline style/);
  assert.throws(() => assertWallCspClean('<div v-show="open" />', 'planted'), /v-show/);
  assert.throws(
    () => assertWallCspClean(`el.setAttribute('style', 'display:none')`, 'planted'),
    /setAttribute style/,
  );
  assert.throws(() => assertWallCspClean('el.style.display = "none"', 'planted'), /element\.style/);
});

test('lane CSS grounds chrome in kit tokens (scheme-following, AA-owned)', () => {
  for (const rel of ['src/wall/wall.css', 'src/multislot/multislot.css', 'src/recording/recording.css']) {
    const css = readScope(rel);
    assert.ok(css.includes('var(--cuk-'), `${rel} styles through kit tokens`);
    assert.doesNotMatch(css, /font-family\s*:\s*(?![^;]*var\()[^;]+;/, `${rel}: no new font stacks`);
  }
  assert.throws(
    () => assert.ok('.x { color: red; }'.includes('var(--cuk-'), 'planted'),
    /planted/,
    'token grounding fails without a kit token reference',
  );
});
