// Lane V strip source: anchors, strict CSP, typed rows, keyboard, docked bar.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const STRIP_URL = new URL('../src/activity/ActivityStrip.vue', import.meta.url);
const MODEL_URL = new URL('../src/activity/activityModel.js', import.meta.url);
const CSS_URL = new URL('../src/activity/activity.css', import.meta.url);

const strip = readFileSync(STRIP_URL, 'utf8');
const template = strip.slice(strip.indexOf('<template>'));

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

describe('activity CSP surface', () => {
  test('every lane file carries zero inline-style vectors', () => {
    for (const [file, source] of [['ActivityStrip.vue', strip],
      ['activityModel.js', readFileSync(MODEL_URL, 'utf8')],
      ['activity.css', readFileSync(CSS_URL, 'utf8')]]) {
      assertNoInlineStyleVector(source, file);
    }
  });

  test('lane CSS builds on kit tokens and both tone treatments', () => {
    const css = readFileSync(CSS_URL, 'utf8');
    assertTokenOnlyCss(css, 'activity.css');
    assert.ok(css.includes('.mv-activity__list'), 'outcomes list keeps lane-owned classes');
    assert.ok(css.includes('.mv-activity__row'), 'typed rows keep lane-owned classes');
    assert.ok(css.includes("[data-activity-tone='refusal']"), 'refusal tone treatment');
    assert.ok(css.includes('--cuk-semantic-status-success-border'), 'success tone treatment');
  });

  test('negative control: each planted vector fails its own predicate', () => {
    for (const planted of [
      '<div style="color: red">planted attribute</div>',
      '<div :style="{ color: c }">planted binding</div>',
      'el.setAttribute(\'style\', \'display:none\')',
      'element.style.display = \'none\'',
    ]) {
      assert.throws(() => assertNoInlineStyleVector(planted, 'planted'), assert.AssertionError, planted);
    }
    for (const planted of ['.a{color:#fff}', '.a{color:rgb(1,2,3)}', '@import url("x.css")']) {
      assert.throws(() => assertTokenOnlyCss(planted, 'planted'), assert.AssertionError, planted);
    }
  });
});

describe('activity anchors and keyboard', () => {
  test('toggle and list are anchored, stable and named', () => {
    assert.match(template, /<UiButton\b[^>]*:id="toggleId"[^>]*:data-semantic-anchor="toggleAnchor"[^>]*label="Activity"[^>]*:aria-expanded="expanded"/s,
      'toggle carries bound id, anchor, name and disclosure state');
    assert.match(template, /<ol\b[^>]*:id="listId"[^>]*:data-semantic-anchor="listAnchor"[^>]*role="log"[^>]*tabindex="0"[^>]*:aria-label="listName"/s,
      'outcomes list is a labelled log reachable by keyboard');
    assert.match(template, /<section\b[^>]*:id="stripId"[^>]*:data-semantic-anchor="stripAnchor"[^>]*:aria-label="stripName"/s,
      'strip section is anchored and named');
  });

  test('rows carry deterministic per-sequence anchors and typed data attributes', () => {
    assert.match(template, /<li\b[^>]*v-for="entry in rows"[^>]*:key="entry\.seq"[^>]*:id="mvActivityRowDomId\(entry\.seq\)"[^>]*:data-semantic-anchor="mvActivityRowAnchor\(entry\.seq\)"[^>]*:data-activity-type="entry\.type"[^>]*:data-activity-tone="entry\.tone"/s,
      'rows key and anchor on the feed sequence with typed attributes');
  });

  test('no fake controls: real buttons, no div buttons, no focus overrides', () => {
    assert.doesNotMatch(template, /<div\b[^>]*role="button"/, 'no div button');
    assert.doesNotMatch(template, /tabindex="-1"|tabindex="[2-9]/, 'no focus order overrides');
    assert.doesNotMatch(template, /@keydown|@keyup|@keypress/, 'no custom key handling');
  });

  test('negative control: unanchored or unnamed controls fail', () => {
    const anchored = (tag) => {
      assert.match(tag, /(:id|id)="[^"]+"/, `control keeps a stable id: ${tag}`);
      const anchor = tag.match(/(:data-semantic-anchor|data-semantic-anchor)="([^"]+)"/);
      assert.ok(anchor, `control keeps a data-semantic-anchor: ${tag}`);
      if (!tag.startsWith('<UiButton :')) {
        assert.match(anchor[2], /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/, anchor[2]);
      }
      assert.ok(tag.includes('label=') || tag.includes('aria-label=') || tag.includes(':aria-label='),
        `control keeps an accessible name: ${tag}`);
    };
    anchored('<UiButton :id="toggleId" :data-semantic-anchor="toggleAnchor" label="Activity" />');
    for (const bad of [
      '<UiButton label="Activity" />',
      '<UiButton :id="toggleId" label="Activity" />',
      '<UiButton :id="toggleId" :data-semantic-anchor="toggleAnchor" />',
      '<ol tabindex="0"><li>x</li></ol>',
    ]) {
      assert.throws(() => anchored(bad), assert.AssertionError, bad);
    }
  });
});

describe('activity row copy and placement', () => {
  test('template renders closed copy only, never raw codes', () => {
    assert.doesNotMatch(template, /STALE_FRAME|SURFACE_NOT_AGENT_CONTROLLED|LOCKED_BY_OTHER|BUDGET_EXCEEDED|OUT_OF_BOUNDS|ACTION_ADMITTED|INTENT_ACKNOWLEDGED|HOST_REQUEST_REFUSED/,
      'no raw outcome code in the template');
    assert.doesNotMatch(template, /ERR_[A-Z_]+/, 'no error literal in the template');
    assert.match(template, /\{\{\s*entry\.text\s*\}\}/, 'rows render the normalized closed copy');
    assert.match(template, /\{\{\s*emptyText\s*\}\}/, 'empty state renders the neutral copy');
  });

  test('strip is docked in flow, never an overlay covering tiles', () => {
    const css = readFileSync(CSS_URL, 'utf8');
    assert.doesNotMatch(css, /position\s*:\s*(absolute|fixed)/, 'docked bar takes no overlay position');
    assert.doesNotMatch(css, /z-index/, 'docked bar stacks in flow');
    assert.ok(css.includes('.mv-activity {'), 'strip root owns the docked bar class');
  });

  test('negative control: planted code text and overlay positioning fail', () => {
    assert.throws(() => assert.doesNotMatch('<li>STALE_FRAME refused</li>', /STALE_FRAME/), assert.AssertionError);
    assert.throws(() => assert.doesNotMatch('.mv-activity{position:absolute}', /position\s*:\s*(absolute|fixed)/),
      assert.AssertionError);
  });
});
