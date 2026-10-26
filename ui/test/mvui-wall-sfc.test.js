// Lane U1 SFC contracts: EmptyWallView one-file seam plus the edited panel.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const EMPTY_URL = new URL('../src/wall/EmptyWallView.vue', import.meta.url);
const PANEL_URL = new URL('../src/wall/SurfacePanel.vue', import.meta.url);

/** Run the shared static predicates; fixtures missing a block must throw. */
function assertSfcContract(source, name) {
  assert.ok(source.includes('<script'), `${name} carries a script block`);
  assert.ok(source.includes('<template>'), `${name} carries a template block`);
  assert.doesNotMatch(source, /lang\s*=\s*["']ts["']/, `${name} stays JavaScript-only`);
}

describe('EmptyWallView static contract (pinned compiler)', async () => {
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc');
  const source = readFileSync(EMPTY_URL, 'utf8');

  test('SFC parses with setup script and template; no authored TS', () => {
    const { descriptor, errors } = parse(source, { filename: 'EmptyWallView.vue' });
    assert.equal(errors.length, 0);
    assert.ok(descriptor.scriptSetup, 'setup script declares props and emits');
    assert.ok(!descriptor.script, 'no separate module script: one-file seam');
    assert.ok(descriptor.template, 'template renders the empty wall');
    for (const block of [descriptor.scriptSetup, descriptor.template]) {
      assert.ok(!block.lang || block.lang === 'js', 'JavaScript only, no authored TypeScript');
    }
  });

  test('template and setup compile with zero errors under the pinned compiler', () => {
    const { descriptor } = parse(source, { filename: 'EmptyWallView.vue' });
    const template = compileTemplate({
      source: descriptor.template.content,
      filename: 'EmptyWallView.vue',
      id: 'empty-wall-test',
    });
    assert.equal(template.errors.length, 0);
    const script = compileScript(descriptor, { id: 'empty-wall-test', inlineTemplate: true });
    assert.ok(script.content.length > 0);
  });

  test('imports stay inside vue macros, the kit button and the lane CSS', () => {
    const specifiers = [...source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)]
      .map((m) => m[1]);
    assert.deepEqual([...new Set(specifiers)].sort(), ['./wall.css', 'capsule-ui-kit/ui']);
  });

  test('props carry product copy defaults; emits declare add-capsule only', () => {
    assert.match(source, /title:\s*\{[^}]*default:\s*'A clear view of your work\.'/);
    assert.match(source, /hint:\s*\{[^}]*default:\s*'Add a capsule to bring/);
    const emits = source.match(/\bdefineEmits\(\[([\s\S]*?)\]\)/)[1]
      .split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''));
    assert.deepEqual(emits, ['add-capsule']);
  });

  test('primary action keeps the stable wall/add-capsule contract', () => {
    assert.match(source, /<UiButton/);
    assert.ok(source.includes('id="empty-wall-add"'), 'stable control id');
    assert.ok(source.includes('data-semantic-anchor="wall/add-capsule"'), 'stable anchor');
    assert.ok(source.includes('label="Add capsule"'), 'accessible name');
    assert.ok(source.includes('intent="primary"'), 'primary intent');
    assert.match(source, /@click="\$emit\('add-capsule'\)"/, 'click emits the create intent');
  });

  test('empty view is static: no conditionals, no loops, no host calls', () => {
    const template = source.slice(source.indexOf('<template>'));
    assert.doesNotMatch(template, /v-if/);
    assert.doesNotMatch(template, /v-show/);
    assert.doesNotMatch(template, /v-for/);
    const codeOnly = source.replace(/\/\*\*?[\s\S]*?\*\//g, '');
    for (const token of ['window.', 'localStorage', 'node:', 'TODO', 'FIXME']) {
      assert.ok(!codeOnly.includes(token), `empty view must not contain ${token}`);
    }
  });

  test('negative control: the shared predicates fail a fixture without a template', () => {
    assertSfcContract(source, 'EmptyWallView.vue');
    assert.throws(() => assertSfcContract('<script setup>const a = 1;</script>', 'fixture'),
      /template block/);
    assert.throws(
      () => assertSfcContract('<script lang="ts"></script><template></template>', 'fixture'),
      /JavaScript-only/);
  });
});

describe('edited SurfacePanel still compiles', async () => {
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc');
  const source = readFileSync(PANEL_URL, 'utf8');

  test('SFC parses and compiles with zero errors after the tile edit', () => {
    const { descriptor, errors } = parse(source, { filename: 'SurfacePanel.vue' });
    assert.equal(errors.length, 0);
    assert.ok(descriptor.script, 'pure module block survives');
    assert.ok(descriptor.scriptSetup, 'setup script survives');
    const template = compileTemplate({
      source: descriptor.template.content,
      filename: 'SurfacePanel.vue',
      id: 'surface-panel-test',
    });
    assert.equal(template.errors.length, 0);
    const script = compileScript(descriptor, { id: 'surface-panel-test', inlineTemplate: true });
    assert.ok(script.content.length > 0);
  });

  test('tile wrapper and shared decision reach the kit panel', () => {
    const template = source.slice(source.indexOf('<template>'));
    assert.match(template, /<div class="mv-tile" :data-tile-state="tile\.tile" :data-error-code="row\?\.refusal\?\.code \?\? snapshot\?\.error\?\.code">/);
    assert.ok(template.includes(":presentation-status=\"tile.tile === 'error' ? 'Surface update unavailable' : tile.status\""));
    assert.match(template, /<\/CapsulePanel>\s*<\/div>\s*<\/template>/s);
  });

  test('negative control: the wrapper predicate fails the pre-edit shape', () => {
    const legacy = '<template><CapsulePanel :presentation-status="status" /></template>';
    assert.throws(() => assert.match(legacy, /<div class="mv-tile"/), assert.AssertionError);
  });
});
