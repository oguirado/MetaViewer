// MetaViewer catalog launcher contract (AC-03): kit dialog composition,
// typed error rows with stable ids/anchors, focus return, strict CSP and
// token-only lane CSS. Source-assertion suite: the SFC is read as text and
// every checker below also runs against a planted violation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SFC_URL = new URL('../src/catalog/CatalogLauncher.vue', import.meta.url);
const CSS_URL = new URL('../src/catalog/catalog.css', import.meta.url);
const sfc = readFileSync(SFC_URL, 'utf8');
const css = readFileSync(CSS_URL, 'utf8');

const script = (sfc.match(/<script setup>([\s\S]*?)<\/script>/) ?? [])[1] ?? '';
const template = (sfc.match(/<template>([\s\S]*?)<\/template>/) ?? [])[1] ?? '';
assert.ok(script.length > 0 && template.length > 0);

/** Fail when text carries any inline-style vector (CSP: style-src + nonce). */
function assertNoInlineStyles(text) {
  assert.doesNotMatch(text, /style\s*=/);
  assert.doesNotMatch(text, /:style\b/);
  assert.doesNotMatch(text, /v-bind:style/);
  assert.doesNotMatch(text, /setAttribute\(\s*['"]style['"]/);
  assert.doesNotMatch(text, /\.\s*style\b/);
  assert.doesNotMatch(text, /v-show\b/);
}

/**
 * Fail when an element id lacks a data-semantic-anchor on the same tag, or
 * when an anchor leaves the launcher error family or uses randomness.
 */
function assertAnchors(text) {
  assert.doesNotMatch(text, /Math\.random|Date\.now|randomUUID/);
  const tags = [...text.matchAll(/<[a-zA-Z][^>]*>/g)].map((match) => match[0]);
  for (const tag of tags) {
    if (/(\s|^|\():id=|\sid=/.test(tag)) {
      assert.ok(tag.includes('data-semantic-anchor'),
        `id without data-semantic-anchor: ${tag}`);
    }
  }
  const anchors = [...text.matchAll(/data-semantic-anchor="([^"`]+)"/g)].map((m) => m[1]);
  const bound = [...text.matchAll(/:data-semantic-anchor="`([^`]+)`"/g)].map((m) => m[1]);
  for (const anchor of [...anchors, ...bound]) {
    assert.match(anchor, /^[a-z0-9]+(\/[a-z0-9-]+)+(\$\{[^}]+\})?$/);
    assert.ok(anchor.startsWith('dialog/new-capsule/'), anchor);
  }
}

/** Fail when text carries a raw colour literal. */
function assertNoColorLiterals(text) {
  assert.doesNotMatch(text, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(text, /\brgba?\s*\(/);
  assert.doesNotMatch(text, /\bhsla?\s*\(/);
}

test('launcher composes the kit dialog with catalog bindings and events', () => {
  assert.match(script, /from '\.\.\/\.\.\/\.kit\/capsule-ui-kit\/src\/index-shell\.js'/);
  assert.match(script, /NewCapsuleDialog/);
  for (const marker of ['<NewCapsuleDialog', ':visible="visible"', ':types="dialogTypes"',
    ':title="title"', ':subtitle="subtitle"', ':empty-text="emptyText"',
    '@update:visible="forwardVisible"', '@create="onCreate"', '@close="onClose"']) {
    assert.ok(template.includes(marker), marker);
  }
  // Negative control: wiring without the create forward fails the check.
  const unwired = template.replace('@create="onCreate"', '@create="onKitCreate"');
  assert.throws(() => assert.ok(unwired.includes('@create="onCreate"')), assert.AssertionError);
});

test('unknown kinds render as conditional typed error rows in the empty slot', () => {
  assert.ok(template.includes('#empty'));
  assert.ok(template.includes('v-if="catalogErrors.length"'));
  assert.ok(template.includes('v-for="row in catalogErrors"'));
  assert.ok(template.includes(':key="row.key"'));
  assert.ok(template.includes('catalog-launcher/error-'));
  assert.ok(template.includes('dialog/new-capsule/error-'));
  assert.ok(template.includes(':data-error-code="row.code"'));
  assert.ok(template.includes('This capsule kind is unavailable.'));
  assert.ok(!template.includes('{{ row.message }}'));
  assert.ok(template.includes('aria-label="Unavailable capsule kinds"'));
  // Negative control: an unconditional slot (kit fallback lost) fails.
  const unconditional = template.replace('v-if="catalogErrors.length" ', '');
  assert.throws(() => assert.ok(unconditional.includes('v-if="catalogErrors.length"')),
    assert.AssertionError);
});

test('error rows carry stable ids and kebab-case semantic anchors', () => {
  assertAnchors(template);
  assert.ok(template.includes(':id="`catalog-launcher/error-${row.key}`"'));
  assert.ok(template.includes(':data-semantic-anchor="`dialog/new-capsule/error-${row.key}`"'));
  // Negative controls: a missing anchor and a non-family anchor fail.
  assert.throws(() => assertAnchors('<li id="catalog-launcher/error-x">row</li>'),
    assert.AssertionError);
  assert.throws(() => assertAnchors('<li id="a" data-semantic-anchor="Something Random">row</li>'),
    assert.AssertionError);
});

test('close paths restore invoker focus; open captures it', () => {
  assert.ok(script.includes('createInvokerFocus'));
  assert.ok(script.includes('invokerFocus.capture(document.activeElement)'));
  assert.ok(script.includes('watch(() => props.visible'));
  const closes = script.match(/invokerFocus\.restore\(\)/g) ?? [];
  assert.equal(closes.length, 1, 'only the visible-close watcher restores');
  assert.match(script, /if \(!open && previous\) invokerFocus.restore\(\)/);
  assert.match(script, /flush: 'post'/);
  assert.ok(script.includes("emit('close')"));
  // Negative control: wiring without restore fails the check.
  const noRestore = script.replace(/invokerFocus\.restore\(\)/g, 'invokerFocus.capture(null)');
  assert.throws(() => assert.ok(noRestore.includes('invokerFocus.restore()')),
    assert.AssertionError);
});

test('create emits a built intent payload, never the raw kit choice', () => {
  assert.ok(script.includes('buildCreateIntent'));
  assert.ok(script.includes("emit('create', result.intent)"));
  // Negative control: a raw forward without the intent builder fails.
  const raw = script.replace(/buildCreateIntent/g, 'passThrough');
  assert.throws(() => assert.ok(raw.includes('buildCreateIntent')), assert.AssertionError);
});

test('keyboard flow stays kit-native: no key interception in the wrapper', () => {
  assert.doesNotMatch(template, /keydown/);
  assert.doesNotMatch(script, /keydown|onKey|handleKey/);
  // Negative control: a planted key handler fails the check.
  assert.throws(() => assert.doesNotMatch('<div @keydown="onKey"></div>', /keydown/),
    assert.AssertionError);
});

test('launcher source carries no inline-style vector (strict CSP)', () => {
  assertNoInlineStyles(template);
  assertNoInlineStyles(script);
  // Negative controls: every planted vector fails the checker.
  for (const planted of ['<div style="color:red">', '<div :style="s">', '<div v-bind:style="s">',
    'el.setAttribute(\'style\', s)', 'el.style.display = "none"', '<div v-show="open">']) {
    assert.throws(() => assertNoInlineStyles(planted), assert.AssertionError, planted);
  }
});

test('lane CSS defines every wrapper class with kit tokens only', () => {
  for (const name of ['mv-catalog-errors', 'mv-catalog-errors__row',
    'mv-catalog-errors__code', 'mv-catalog-errors__text']) {
    assert.ok(template.includes(name), name);
    assert.ok(css.includes(`.${name}`), name);
  }
  const refs = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(refs.length > 5);
  for (const ref of refs) assert.ok(ref.startsWith('--cuk-'), ref);
  // Negative control: a non-kit token reference fails the allowlist.
  const planted = `${css}\n.x{color:var(--made-up-token);}\n`;
  const bad = [...planted.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]);
  assert.throws(() => {
    for (const ref of bad) assert.ok(ref.startsWith('--cuk-'), ref);
  }, assert.AssertionError);
});

test('lane CSS carries no colour literal and pairs error text with surface', () => {
  assertNoColorLiterals(css);
  for (const token of ['--cuk-semantic-status-error-text', '--cuk-semantic-status-error-surface',
    '--cuk-semantic-status-error-border']) {
    assert.ok(css.includes(token), token);
  }
  // Negative controls: planted literals fail the checker.
  for (const planted of ['.x{color:#fff;}', '.x{color:rgb(0,0,0);}', '.x{color:hsl(0,0%,0%);}']) {
    assert.throws(() => assertNoColorLiterals(planted), assert.AssertionError, planted);
  }
});

test('lane CSS is scheme-neutral: no per-scheme overrides or new fonts', () => {
  const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(uncommented, /data-theme-scheme|mv-light|mv-dark/);
  assert.doesNotMatch(css, /@font-face|@import/);
  const families = [...css.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1]);
  assert.ok(families.length > 0);
  for (const family of families) assert.ok(family.includes('var(--cuk-'), family);
  // Negative controls: a scheme override and a literal font fail.
  assert.throws(() => assert.doesNotMatch('[data-theme-scheme="mv-dark"]{}',
    /data-theme-scheme/), assert.AssertionError);
  assert.throws(() => assert.doesNotMatch('p{font-family:Inter;}', /font-family:\s*(?!var\()/),
    assert.AssertionError);
});

test('lane sources carry no e-mail strings or host paths', () => {
  for (const [label, text] of [['sfc', sfc], ['css', css]]) {
    assert.doesNotMatch(text, /\S+@\S+\.\S+/, label);
    assert.doesNotMatch(text, /\/home\/|C:\\|\\\\Users/, label);
  }
  // Negative controls: planted address and path fail.
  assert.throws(() => assert.doesNotMatch('mail a@b.cc here', /\S+@\S+\.\S+/),
    assert.AssertionError);
  assert.throws(() => assert.doesNotMatch('at /home/x file', /\/home\//), assert.AssertionError);
});
