import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectQaAnchors } from '../src/qa/anchorCollector.js';

// MVUI17 lane Q: hierarchical QA anchor grammar v2 (L2-3).
// 1..6 segments joined by '/', each ^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$,
// total length <= 200, no empty/'.'/'..' segment, no leading/trailing '/'.

const SEG_64 = 's'.repeat(64);
const TOTAL_200 = `${'a'.repeat(64)}/${'b'.repeat(64)}/${'c'.repeat(64)}/ddddd`;
assert.equal(TOTAL_200.length, 200);

const VALID = [
  'capsule/abc/fold',
  'tile-x-record-ai',
  'a/b/c/d/e/f',
  'A0:b.c_d-e/f',
  'x',
  SEG_64,
  TOTAL_200,
  'capsule/cap-01/panel',
  'dialog/new-capsule/mode-create',
];

const INVALID = [
  'a/b/c/d/e/f/g', // 7 segments
  'a//b', // empty segment
  'a/b/', // trailing slash
  '/a/b', // leading slash
  'a/./b', // dot segment
  'a/../b', // dotdot segment
  '.',
  '..',
  'x'.repeat(65), // segment > 64
  `${TOTAL_200}e`, // total > 200
  'has space',
  '',
  'capsule/abc/fold/',
  '-bad/ok', // segment must start alnum
  '_bad/ok',
  'Café/x', // non-ascii
  'a/b/c/d/e/f/', // 6 segments but trailing slash
];

function dom() {
  const root = {
    nodeType: 9,
    children: [],
    ownerDocument: null,
    querySelectorAll() { return this.children.filter(el => el.hasAttribute('data-semantic-anchor')); },
    getElementById() { return null; },
  };
  root.ownerDocument = root;
  const window = {
    innerWidth: 1000,
    innerHeight: 800,
    getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1' }; },
  };
  function element(tag, attrs, text = '') {
    const node = {
      nodeType: 1,
      localName: tag,
      parentElement: null,
      ownerDocument: root,
      childNodes: text ? [{ nodeType: 3, nodeValue: text }] : [],
      box: { x: 10, y: 20, width: 80, height: 30 },
      getAttribute(name) { return attrs[name] ?? null; },
      hasAttribute(name) { return Object.hasOwn(attrs, name); },
      matches() { return false; },
      closest() { return null; },
      querySelectorAll() { return []; },
      getBoundingClientRect() {
        const b = this.box;
        return { ...b, left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
      },
    };
    root.children.push(node);
    return node;
  }
  return { root, window, element };
}

test('hierarchical grammar v2: positive matrix collected verbatim', () => {
  const d = dom();
  for (const anchor of VALID) d.element('button', { 'data-semantic-anchor': anchor }, `label ${anchor}`);
  const rows = collectQaAnchors(d.root, d.window).rows;
  assert.deepEqual(rows.map(row => row.anchor).sort(), [...VALID].sort());
  for (const row of rows) assert.equal(row.role, 'button');
});

test('hierarchical grammar v2: negative matrix excluded, valid sibling survives', () => {
  const d = dom();
  for (const anchor of INVALID) d.element('button', { 'data-semantic-anchor': anchor }, 'invalid');
  d.element('button', { 'data-semantic-anchor': 'capsule/abc/fold' }, 'Fold');
  const rows = collectQaAnchors(d.root, d.window).rows;
  // Negative control: the invalid anchors are absent AND the witness is present,
  // so the test cannot pass by collecting nothing.
  assert.deepEqual(rows.map(row => row.anchor), ['capsule/abc/fold']);
  for (const anchor of INVALID) assert.ok(!rows.some(row => row.anchor === anchor), anchor);
});

test('hierarchical grammar v2: segment and total boundaries', () => {
  const d = dom();
  d.element('button', { 'data-semantic-anchor': 'k'.repeat(64) }, 'edge64');
  d.element('button', { 'data-semantic-anchor': TOTAL_200 }, 'edge200');
  const rows = collectQaAnchors(d.root, d.window).rows;
  assert.deepEqual(rows.map(row => row.anchor).sort(), [TOTAL_200, 'k'.repeat(64)].sort());
});

// Mounted kit tile: SSR-render the real kit CapsulePanel, feed its published
// DOM through the real collector, and snapshot the capsule/<id>/... rows.
function nodesFromHtml(html) {
  const nodes = [];
  const tagRe = /<([a-z][\w-]*)\b([^>]*)>([^<]*)/gi;
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    const [, tag, attributes, text] = match;
    if (!attributes.includes('data-semantic-anchor')) continue;
    const attrs = Object.fromEntries(
      [...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
    );
    nodes.push({ tag: tag.toLowerCase(), attrs, text: text.trim() });
  }
  return nodes;
}

test('mounted kit tile snapshot includes capsule/<id>/... rows', async () => {
  const uiRoot = process.env.MVUI_UI_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
  const require = createRequire(join(uiRoot, 'package.json'));
  const { createServer } = require('vite');
  const { createSSRApp } = require('vue');
  const { renderToString } = require('@vue/server-renderer');
  const vuePlugin = require('@vitejs/plugin-vue').default;
  const cacheDir = await mkdtemp(join(tmpdir(), 'mvui17-qa-vite-'));
  let server;
  try {
    server = await createServer({
      root: uiRoot,
      configFile: false,
      cacheDir,
      plugins: [vuePlugin()],
      resolve: {
        alias: [{
          find: /^capsule-ui-kit\/CapsulePanel$/,
          replacement: join(uiRoot, '.kit/capsule-ui-kit/src/capsules/CapsulePanel.vue'),
        }],
        dedupe: ['vue'],
      },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true },
      appType: 'custom',
    });
    const { default: CapsulePanel } = await server.ssrLoadModule('capsule-ui-kit/CapsulePanel');
    const html = await renderToString(createSSRApp(CapsulePanel, { capsuleId: 'cap-01' }));
    const d = dom();
    for (const node of nodesFromHtml(html)) d.element(node.tag, node.attrs, node.text);
    const rows = collectQaAnchors(d.root, d.window).rows;
    const anchors = rows.map(row => row.anchor);
    assert.ok(anchors.length > 0, 'mounted tile must publish at least one anchor');
    for (const expected of [
      'capsule/cap-01/fold',
      'capsule/cap-01/control',
      'capsule/cap-01/close',
      'capsule/cap-01/dock-back',
    ]) {
      assert.ok(anchors.includes(expected), `missing ${expected} in ${JSON.stringify(anchors)}`);
    }
    assert.equal(rows.find(row => row.anchor === 'capsule/cap-01/fold').role, 'button');
    // Negative control: a counterfactual anchor must be absent.
    assert.ok(!anchors.includes('capsule/cap-01/missing'));
  } finally {
    await server?.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('mvui17 qa grammar memory ceiling', () => {
  assert.ok(process.memoryUsage().rss < 512 * 1024 * 1024, `rss ${process.memoryUsage().rss}`);
});
