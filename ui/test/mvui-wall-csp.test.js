// Lane U1 strict CSP: no inline styles, bindings or style writes in the lane.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LANE_FILES = [
  '../src/wall/EmptyWallView.vue',
  '../src/wall/SurfacePanel.vue',
  '../src/wall/tileStates.js',
  '../src/wall/layout.js',
  '../src/wall/wall.css',
];

/** Fail-closed source predicate: any inline-style vector throws. */
function assertNoInlineStyleVector(source, label) {
  assert.doesNotMatch(source, /style\s*=/, `${label}: no style attribute`);
  assert.doesNotMatch(source, /:style\b/, `${label}: no :style binding`);
  assert.doesNotMatch(source, /v-bind:style/, `${label}: no v-bind:style`);
  assert.doesNotMatch(source, /setAttribute\(\s*['"]style['"]/, `${label}: no setAttribute('style')`);
  assert.doesNotMatch(source, /\.style\b/, `${label}: no element.style write`);
  assert.doesNotMatch(source, /element\.style/, `${label}: no element.style reference`);
}

/** Fail-closed CSS predicate: kit tokens only, no literals or remote loads. */
function assertTokenOnlyCss(css, label) {
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, `${label}: no hex literal`);
  assert.doesNotMatch(css, /\brgba?\(/, `${label}: no rgb() literal`);
  assert.doesNotMatch(css, /\bhsla?\(/, `${label}: no hsl() literal`);
  assert.doesNotMatch(css, /@import/, `${label}: no @import`);
  assert.doesNotMatch(css, /\burl\(/, `${label}: no url() load`);
  assert.ok(css.includes('var(--cuk-'), `${label}: styles build on kit tokens`);
}

describe('lane CSP surface', () => {
  test('every lane file carries zero inline-style vectors', () => {
    for (const file of LANE_FILES) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      assertNoInlineStyleVector(source, file);
    }
  });

  test('lane CSS builds on kit tokens with zero literals', () => {
    const css = readFileSync(new URL('../src/wall/wall.css', import.meta.url), 'utf8');
    assertTokenOnlyCss(css, 'wall.css');
    for (const state of ['connecting', 'live', 'folded', 'human-control', 'agent-acting',
      'lost', 'error']) {
      assert.ok(css.includes(`[data-tile-state="${state}"]`), `treatment for ${state}`);
    }
    assert.ok(css.includes('.mv-wall-empty'), 'empty view keeps lane-owned classes');
  });

  test('negative control: each planted vector fails its own predicate', () => {
    const vectors = [
      '<div style="color: red">planted attribute</div>',
      '<div :style="{ color: c }">planted binding</div>',
      '<div v-bind:style="s">planted v-bind</div>',
      'el.setAttribute(\'style\', \'display:none\')',
      'element.style.display = \'none\'',
      'node.style.setProperty(\'color\', c)',
    ];
    for (const planted of vectors) {
      assert.throws(() => assertNoInlineStyleVector(planted, 'planted'), assert.AssertionError,
        planted);
    }
    for (const planted of ['.a{color:#fff}', '.a{color:rgb(1,2,3)}', '.a{color:hsl(1,2%,3%)}',
      '@import url("https://example.invalid/x.css")', '.a{background:url(x.png)}']) {
      assert.throws(() => assertTokenOnlyCss(planted, 'planted'), assert.AssertionError, planted);
    }
    assert.throws(() => assertTokenOnlyCss('.a{color:red}', 'planted'), assert.AssertionError,
      'token-free CSS fails the kit-token predicate');
  });
});
