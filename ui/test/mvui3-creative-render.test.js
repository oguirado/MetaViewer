import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { FIXTURES } from '../src/fixtures/states.js';
import { collectAgentControls, assertAnchoredControls } from '../src/agent/agentLane.js';

function controls(html) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].map(([, attributes, content]) => {
    const attrs = Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
    return { id: attrs.id ?? '', tagName: 'BUTTON', textContent: content.replace(/<[^>]*>/g, '').trim(),
      getAttribute: key => attrs[key] ?? null, hasAttribute: key => Object.hasOwn(attrs, key),
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }) };
  });
}
function assertCsp(html) { assert.doesNotMatch(html, /\sstyle\s*=/i); }

test('real kit render: CSP, stable accessible controls and blank non-admitted states', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'mvui3-creative-'));
  let server;
  try {
    server = await createServer({ cacheDir, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom' });
    const { default: Capsule } = await server.ssrLoadModule('/src/creative/CreativeCapsule.vue');
    const frames = FIXTURES.creative.ui.creativeFrames;
    const html = await renderToString(createSSRApp(Capsule, { capsuleId: 'cap-01', frames }));
    assertCsp(html);
    const buttons = controls(html);
    assert.equal(buttons.length, 3);
    assertAnchoredControls(buttons);
    const collected = collectAgentControls({ querySelectorAll: () => buttons });
    assert.equal(collected.skipped.length, 0);
    assert.ok(collected.controls.every(c => c.name.length > 0));
    assert.equal(new Set(collected.controls.map(c => c.anchor)).size, 3);
    for (const expected of FIXTURES.creative.expectedAnchors.filter(r => r.anchor.startsWith('capsule/'))) {
      assert.ok(collected.controls.some(c => c.anchor === expected.anchor && c.role === expected.role), expected.anchor);
    }
    assert.match(html, /<img\b/);
    for (const props of [
      { capsuleId: 'cap-01', frames: [] },
      { capsuleId: 'cap-01', frames: [{ ...frames[0], data_url: 'https://blocked/image.png' }] },
      { capsuleId: '', frames },
      { capsuleId: 'cap-01', frames, folded: true },
    ]) {
      const blank = await renderToString(createSSRApp(Capsule, props));
      assertCsp(blank);
      assert.doesNotMatch(blank, /<img\b|ERR_|unavailable|refused|waiting|placeholder|no storyboard/i);
      assertAnchoredControls(controls(blank));
    }
    const another = await renderToString(createSSRApp(Capsule, { capsuleId: 'cap-02', frames }));
    const combined = [...buttons, ...controls(another)];
    assert.equal(new Set(combined.map(c => c.id)).size, combined.length);
    assert.equal(new Set(combined.map(c => c.getAttribute('data-semantic-anchor'))).size, combined.length);
    assert.throws(() => assertCsp('<button style="color:red">Mutant</button>'));
    assert.throws(() => assertAnchoredControls([{ id: '', tagName: 'BUTTON', getAttribute: () => null }]));
  } finally { await server?.close(); await rm(cacheDir, { recursive: true, force: true }); }
});

const tokens = JSON.parse(readFileSync(new URL('../src/design/metaviewer.tokens.json', import.meta.url), 'utf8'));
function resolve(path, mode) {
  for (let step = 0; step < 16; step++) {
    const leaf = path.split('.').reduce((value, key) => value?.[key], tokens);
    assert.ok(leaf, path);
    const value = leaf.modes?.[mode] ?? leaf.$value;
    const reference = /^\{([\w.]+)\}$/.exec(value);
    if (!reference) { assert.match(value, /^#[\da-f]{6}$/i); return value; }
    path = reference[1];
  }
  throw new Error('Token cycle');
}
function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function assertContrast(fg, bg) {
  const [high, low] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  assert.ok((high + 0.05) / (low + 0.05) >= 4.5, `${fg} on ${bg}`);
}
test('creative text uses AA theme pairs and no raw colors, fonts or runtime styles', () => {
  const source = readFileSync(new URL('../src/creative/CreativeCapsule.vue', import.meta.url), 'utf8');
  const css = source.split('<style scoped>')[1];
  assert.match(css, /color: var\(--cuk-semantic-text-primary\)/);
  assert.match(css, /background: var\(--cuk-semantic-surface-canvas\)/);
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(|hsla?\(|font-family\s*:/i);
  assert.doesNotMatch(source, /\bstyle\s*=|:style|v-show|\.style\b|setAttribute\s*\(\s*['"]style/);
  for (const mode of ['light.normal', 'dark.normal']) {
    assertContrast(resolve('semantic.text.primary', mode), resolve('semantic.surface.canvas', mode));
  }
  assert.throws(() => assertContrast('#ffffff', '#ffffff'));
});
