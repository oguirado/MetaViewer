// Lane V CSP surface: App.vue plus the activity lane carry zero style vectors.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LANE_FILES = [
  '../src/App.vue',
  '../src/activity/ActivityStrip.vue',
  '../src/activity/activityModel.js',
  '../src/activity/activity.css',
];

/** Fail-closed source predicate: any inline-style vector throws. */
function assertNoInlineStyleVector(source, label) {
  assert.doesNotMatch(source, /style\s*=/, `${label}: no style attribute`);
  assert.doesNotMatch(source, /:style\b/, `${label}: no :style binding`);
  assert.doesNotMatch(source, /v-bind:style/, `${label}: no v-bind:style`);
  assert.doesNotMatch(source, /setAttribute\(\s*['"]style['"]/, `${label}: no setAttribute('style')`);
  assert.doesNotMatch(source, /\.style\b/, `${label}: no element.style write`);
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

/** @param {string} source */
function styleBlocks(source) {
  return [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
}

describe('lane V CSP surface', () => {
  test('every lane file carries zero inline-style vectors', () => {
    for (const file of LANE_FILES) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      assertNoInlineStyleVector(source, file);
    }
  });

  test('bench hook block adds no style vector', () => {
    const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
    const block = source.slice(source.indexOf('const benchHook'), source.indexOf('});', source.indexOf('delete benchWindow.__metaviewerBench')) + 3);
    assert.ok(block.includes('__metaviewerBench'), 'hook block located');
    assertNoInlineStyleVector(block, 'bench hook');
  });

  test('lane styles build on kit tokens with zero literals', () => {
    for (const file of ['../src/App.vue', '../src/activity/activity.css']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const css = file.endsWith('.css') ? source : styleBlocks(source);
      assert.ok(css.length > 0, `${file}: style block present`);
      assertTokenOnlyCss(css, file);
    }
  });

  test('negative control: each planted vector fails its own predicate', () => {
    const vectors = [
      '<div style="color: red">planted attribute</div>',
      '<div :style="{ color: c }">planted binding</div>',
      '<div v-bind:style="s">planted v-bind</div>',
      'el.setAttribute(\'style\', \'display:none\')',
      'element.style.display = \'none\'',
    ];
    for (const planted of vectors) {
      assert.throws(() => assertNoInlineStyleVector(planted, 'planted'), assert.AssertionError, planted);
    }
    for (const planted of ['.a{color:#fff}', '.a{color:rgb(1,2,3)}', '.a{color:hsl(1,2%,3%)}',
      '@import url("https://example.invalid/x.css")', '.a{background:url(x.png)}']) {
      assert.throws(() => assertTokenOnlyCss(planted, 'planted'), assert.AssertionError, planted);
    }
    assert.throws(() => assertTokenOnlyCss('.a{color:red}', 'planted'), assert.AssertionError,
      'token-free CSS fails the kit-token predicate');
  });
});
