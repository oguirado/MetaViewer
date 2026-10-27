// MVUI9 lane I: capsule action mount audit (rendered DOM level).
// SSR-mounts the wall tiles (default + window presentation + tile chrome),
// the recording panel and the multislot kit
// controls, and asserts the rendered controls carry stable ids, anchors and
// accessible names with snapshot-unique anchors. MultislotHost itself is
// source-audited: its xterm named import cannot load under node SSR.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { FIXTURES } from '../src/fixtures/states.js';
import { resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';

const SLASH_ANCHOR = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
const TILE_ANCHOR = /^tile-[a-z0-9]+(?:-[a-z0-9]+)*$/;

let server;
let cacheDir;

/**
 * @param {string} html Rendered markup.
 * @returns {Array<{ tag: string, open: string, inner: string }>} Interactive elements.
 */
function domControls(html) {
  const out = [];
  for (const match of html.matchAll(/<(button|select|textarea|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    out.push({ tag: match[1].toLowerCase(), open: match[0].slice(0, match[0].indexOf('>') + 1), inner: match[3] });
  }
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    out.push({ tag: 'input', open: match[0], inner: '' });
  }
  return out;
}

/**
 * @param {string} html Rendered markup.
 * @param {string} anchor Exact anchor value.
 * @returns {string|null} Full element source or null.
 */
function elementForAnchor(html, anchor) {
  for (const el of domControls(html)) {
    if (el.open.includes(`data-semantic-anchor="${anchor}"`)) return el.open + el.inner;
  }
  const status = html.match(
    new RegExp(`<([a-z][\\w-]*)\\b[^>]*data-semantic-anchor="${anchor}"[^>]*>([\\s\\S]*?)<\\/\\1>`),
  );
  return status ? status[0] : null;
}

/**
 * @param {string} html Rendered markup.
 * @returns {string[]} Every anchor in document order.
 */
function domAnchors(html) {
  return [...html.matchAll(/data-semantic-anchor="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * @param {string} html Rendered markup.
 * @returns {string[]} Every id in document order.
 */
function domIds(html) {
  return [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Rendered control contract: stable literal id, shaped anchor, name.
 * @param {{ tag: string, open: string, inner: string }} el Control element.
 * @param {string} label Assertion label.
 */
function assertDomContract(el, label) {
  const id = el.open.match(/\sid="([^"]+)"/)?.[1];
  assert.ok(id && id.length > 0, `${label}: rendered control without id: ${el.open.slice(0, 90)}`);
  assert.doesNotMatch(id, /\s/, `${label}: unstable id: ${id}`);
  assert.doesNotMatch(id, /^pv_id_/, `${label}: generated control id: ${id}`);
  const anchor = el.open.match(/data-semantic-anchor="([^"]+)"/)?.[1];
  assert.ok(anchor, `${label}: rendered control without anchor: ${el.open.slice(0, 90)}`);
  assert.ok(
    SLASH_ANCHOR.test(anchor) || TILE_ANCHOR.test(anchor),
    `${label}: anchor is kebab-case and deterministic: ${anchor}`,
  );
  const text = el.inner.replace(/<[^>]*>/g, ' ').trim();
  assert.ok(
    /aria-label=/.test(el.open) || /aria-labelledby=/.test(el.open) || text.length > 0,
    `${label}: rendered control without accessible name: ${el.open.slice(0, 90)}`,
  );
}

/**
 * @param {string[]} values Ids or anchors.
 * @param {string} label Assertion label.
 */
function assertSnapshotUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    assert.ok(!seen.has(value), `${label}: duplicate in snapshot: ${value}`);
    seen.add(value);
  }
}

/**
 * @param {unknown} component SSR-loaded component.
 * @param {Record<string, unknown>} props Component props.
 * @param {Record<string, unknown>} [provides] Injection values.
 * @returns {Promise<string>} Rendered HTML.
 */
async function renderWith(component, props, provides = {}) {
  const app = createSSRApp({ render: () => h(component, props) });
  for (const [key, value] of Object.entries(provides)) app.provide(key, value);
  return renderToString(app);
}

/**
 * Wall fixture for the audit: the `tile-chrome` fixture when the room has
 * landed it, otherwise a local four-tile record through the public
 * fixture runtime.
 * @returns {{ name: string, mount: import('../src/fixtures/fixtureRuntime.js').FixtureMount }}
 */
function wallFixture() {
  const chrome = resolveFixture('tile-chrome');
  if (chrome.ok) {
    const mount = createFixtureRuntime(chrome.fixture);
    assert.equal(mount.ok, true, 'tile-chrome fixture mounts through the fixture runtime');
    return { name: 'tile-chrome', mount: mount.mount };
  }
  assert.ok(
    Object.hasOwn(FIXTURES, 'four'),
    'local wall fixture falls back to the frozen four-tile record',
  );
  const record = {
    key: 'mvui9-local-chrome',
    screen: 'wall',
    scheme: 'mv-light',
    density: 'compact',
    epoch: 1,
    revision: 1,
    capsules: FIXTURES.four.capsules,
    ui: {},
    expectedAnchors: [],
  };
  const mount = createFixtureRuntime(record);
  assert.equal(mount.ok, true, 'local wall fixture mounts through the fixture runtime');
  return { name: 'mvui9-local-chrome', mount: mount.mount };
}

before(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'mvui9-icons-'));
  server = await createServer({
    cacheDir,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    appType: 'custom',
  });
});

after(async () => {
  await server?.close();
  await rm(cacheDir, { recursive: true, force: true });
});

test('recording mount: toggle, screenshot, manifest and refusal are contracted', async () => {
  const { default: Panel } = await server.ssrLoadModule('/src/recording/MvRecordingPanel.vue');
  const rows = [{ id: 'rec-01', phase: 'sealed' }];
  const html = await renderWith(Panel, {
    capsuleId: 'cap-01',
    recordings: rows,
    exportDestination: 'host-advertised',
  });
  for (const anchor of [
    'recording/cap-01/toggle',
    'recording/cap-01/screenshot',
    'recording/rec-01/select',
    'recording/rec-01/export',
  ]) {
    const found = domControls(html).find((el) => el.open.includes(`data-semantic-anchor="${anchor}"`));
    assert.ok(found, `recording control renders: ${anchor}`);
    assertDomContract(found, 'recording mount');
  }
  assertSnapshotUnique(domAnchors(html), 'recording mount anchors');
  assertSnapshotUnique(domIds(html), 'recording mount ids');
  const again = await renderWith(Panel, { capsuleId: 'cap-01', recordings: rows, exportDestination: 'host-advertised' });
  assert.deepEqual(domIds(again).sort(), domIds(html).sort(), 'recording ids are deterministic');
  const bare = await renderWith(Panel, { capsuleId: 'cap-01' });
  assert.ok(
    bare.includes('data-semantic-anchor="recording/cap-01/disk-refusal"'),
    'missing destination renders the refusal row, never a crash',
  );
});

test('recording mount: unavailable reason disables with the pinned accessible reason', async () => {
  const { default: Panel } = await server.ssrLoadModule('/src/recording/MvRecordingPanel.vue');
  const html = await renderWith(Panel, { capsuleId: 'cap-01', disabled: true, unavailableReason: 'no-facade' });
  for (const anchor of ['recording/cap-01/toggle', 'recording/cap-01/screenshot']) {
    const found = domControls(html).find((el) => el.open.includes(`data-semantic-anchor="${anchor}"`));
    assert.ok(found, `disabled control renders: ${anchor}`);
    assert.ok(/\sdisabled[\s>]/.test(found.open), `${anchor} renders disabled`);
    assert.ok(
      found.open.includes('data-unavailable-reason="Recording is unavailable"'),
      `${anchor} carries the pinned reason`,
    );
    assert.ok(
      (found.open.match(/title="([^"]*)"/)?.[1] ?? '').includes('Recording is unavailable'),
      `${anchor} exposes the reason accessibly`,
    );
  }
});

test('wall mount: default branch renders the full contracted tile family', async () => {
  const { default: SurfacePanel } = await server.ssrLoadModule('/src/wall/SurfacePanel.vue');
  const { mount } = wallFixture();
  const tiles = mount.fixture.capsules.map((row) => row.id);
  assert.ok(tiles.length >= 1, 'wall fixture carries tiles');
  const Wall = {
    render: () => tiles.map((capsuleId) => h(SurfacePanel, {
      capsuleId,
      title: `Tile ${capsuleId}`,
      projectionView: mount.runtime.projectionView,
      intentBuilders: mount.runtime.intentBuilders,
      controlRegistry: mount.runtime.controlRegistry,
      scheduler: mount.runtime.scheduler,
      tileScheduler: mount.runtime.tileScheduler,
      presentationInstance: `panel-${capsuleId}`,
    })),
  };
  const app = createSSRApp(Wall);
  app.provide('capsuleChromeStyle', 'openvue');
  const html = await renderToString(app);
  for (const capsuleId of tiles) {
    for (const action of ['panel', 'tab', 'fold', 'control', 'close', 'pin', 'popout', 'dock-back']) {
      const anchor = `capsule/${capsuleId}/${action}`;
      assert.ok(html.includes(`data-semantic-anchor="${anchor}"`), `tile renders ${anchor}`);
    }
  }
  for (const el of domControls(html)) assertDomContract(el, 'wall mount');
  assertSnapshotUnique(domAnchors(html), 'wall mount anchors');
  assertSnapshotUnique(domIds(html), 'wall mount ids');
  for (const capsuleId of tiles) {
    for (const action of ['close', 'dock-back']) {
      const element = elementForAnchor(html, `capsule/${capsuleId}/${action}`);
      assert.ok(element && element.includes('<svg'), `${action} renders its kit glyph icon on ${capsuleId}`);
    }
    const fold = elementForAnchor(html, `capsule/${capsuleId}/fold`);
    assert.ok(fold && /Fold|Unfold/.test(fold), `fold stays labeled on ${capsuleId}`);
  }
});

test('wall mount: window branch restores fold and control, hides pin and popout', async () => {
  const { default: SurfacePanel } = await server.ssrLoadModule('/src/wall/SurfacePanel.vue');
  const { mount } = wallFixture();
  const tiles = mount.fixture.capsules.map((row) => row.id);
  const Wall = {
    render: () => tiles.map((capsuleId) => h(SurfacePanel, {
      capsuleId,
      title: `Tile ${capsuleId}`,
      projectionView: mount.runtime.projectionView,
      intentBuilders: mount.runtime.intentBuilders,
      controlRegistry: mount.runtime.controlRegistry,
      scheduler: mount.runtime.scheduler,
      tileScheduler: mount.runtime.tileScheduler,
      presentationInstance: `panel-${capsuleId}`,
    })),
  };
  const app = createSSRApp(Wall);
  app.provide('capsuleChromeStyle', 'openvue');
  app.provide('capsuleWindowPresentation', { revision: { value: 0 }, get: () => undefined });
  const html = await renderToString(app);
  for (const capsuleId of tiles) {
    for (const action of ['fold', 'control', 'close', 'dock-back', 'hide', 'float', 'maximize']) {
      assert.ok(html.includes(`data-semantic-anchor="capsule/${capsuleId}/${action}"`),
        `window branch renders ${action} on ${capsuleId}`);
    }
    for (const action of ['pin', 'popout']) {
      assert.ok(!html.includes(`data-semantic-anchor="capsule/${capsuleId}/${action}"`),
        `window branch hides ${action} on ${capsuleId}`);
    }
    for (const action of ['hide', 'float', 'maximize', 'close']) {
      const element = elementForAnchor(html, `capsule/${capsuleId}/${action}`);
      assert.ok(element && element.includes('<svg'), `${action} renders its kit glyph icon on ${capsuleId}`);
    }
  }
  for (const el of domControls(html)) assertDomContract(el, 'window mount');
  assertSnapshotUnique(domAnchors(html), 'window mount anchors');
});

test('wall mount: tile chrome entries are contracted with capture modules', async () => {
  const capture = await import('../src/capture/capturePort.js');
  assert.equal(typeof capture.createCapturePort, 'function', 'createCapturePort keeps its preamble name');
  assert.equal(typeof capture.createCaptureState, 'function', 'createCaptureState keeps its preamble name');
  const doubling = await import('../src/capture/captureDouble.js');
  assert.equal(typeof doubling.createCaptureDouble, 'function', 'createCaptureDouble keeps its preamble name');
  const { default: SurfacePanel } = await server.ssrLoadModule('/src/wall/SurfacePanel.vue');
  const { mount } = wallFixture();
  const tiles = mount.fixture.capsules.map((row) => row.id);
  const facade = doubling.createCaptureDouble();
  const port = capture.createCapturePort(facade);
  const state = capture.createCaptureState(port);
  try {
    await state.toggleRecord(tiles[0]);
    await state.screenshot(tiles[1] ?? tiles[0]);
    const Wall = {
      render: () => tiles.map((capsuleId) => h(SurfacePanel, {
        capsuleId,
        title: `Tile ${capsuleId}`,
        projectionView: mount.runtime.projectionView,
        intentBuilders: mount.runtime.intentBuilders,
        controlRegistry: mount.runtime.controlRegistry,
        scheduler: mount.runtime.scheduler,
        tileScheduler: mount.runtime.tileScheduler,
        presentationInstance: `panel-${capsuleId}`,
        captureState: state,
        displayOnly: false,
      })),
    };
    const app = createSSRApp(Wall);
    app.provide('capsuleChromeStyle', 'openvue');
    const html = await renderToString(app);
    const tileAnchors = domAnchors(html).filter((anchor) => anchor.startsWith('tile-'));
    assert.ok(tileAnchors.length > 0, 'tile chrome renders');
    for (const capsuleId of tiles) {
      const record = elementForAnchor(html, `tile-${capsuleId}-record-ai`);
      assert.ok(record, `tile chrome renders tile-${capsuleId}-record-ai`);
      assert.match(record, /\sid="[^"]+"/, 'record chrome keeps a stable id');
      assert.ok(record.includes('saas-record'), 'record chrome renders through the kit record wrapper');
      const shot = domControls(html).find((el) => el.open.includes(`data-semantic-anchor="tile-${capsuleId}-screenshot"`));
      assert.ok(shot, `tile chrome renders tile-${capsuleId}-screenshot`);
      assertDomContract(shot, 'tile chrome');
      const badge = elementForAnchor(html, `tile-${capsuleId}-recording-badge`);
      assert.ok(badge, `tile chrome renders tile-${capsuleId}-recording-badge`);
      assert.match(badge, /\sid="[^"]+"/, 'badge keeps a stable id');
      const text = badge.replace(/<[^>]*>/g, ' ').trim();
      assert.ok(text.length > 0, 'badge keeps readout text');
    }
    assertSnapshotUnique(tileAnchors, 'tile chrome anchors');
    const elapsed = elementForAnchor(html, `tile-${tiles[0]}-recording-badge`);
    assert.ok(elapsed && /\d/.test(elapsed.replace(/<[^>]*>/g, ' ')), 'recording tile badge shows elapsed time');
  } finally { state.dispose(); }
});

test('wall mount: missing facade disables tile chrome; display-only hides it', async () => {
  const capture = await import('../src/capture/capturePort.js');
  const { default: SurfacePanel } = await server.ssrLoadModule('/src/wall/SurfacePanel.vue');
  const { mount } = wallFixture();
  const tiles = mount.fixture.capsules.map((row) => row.id);
  const port = capture.createCapturePort(undefined);
  const state = capture.createCaptureState(port);
  try {
    const Wall = {
      render: () => tiles.map((capsuleId) => h(SurfacePanel, {
        capsuleId,
        title: `Tile ${capsuleId}`,
        projectionView: mount.runtime.projectionView,
        intentBuilders: mount.runtime.intentBuilders,
        controlRegistry: mount.runtime.controlRegistry,
        scheduler: mount.runtime.scheduler,
        tileScheduler: mount.runtime.tileScheduler,
        presentationInstance: `panel-${capsuleId}`,
        captureState: state,
        displayOnly: false,
      })),
    };
    const app = createSSRApp(Wall);
    app.provide('capsuleChromeStyle', 'openvue');
    const html = await renderToString(app);
    const tileAnchors = domAnchors(html).filter((anchor) => anchor.startsWith('tile-'));
    assert.ok(tileAnchors.length > 0, 'tile chrome renders disabled (lane T/A pending when absent)');
    for (const capsuleId of tiles) {
      const record = elementForAnchor(html, `tile-${capsuleId}-record-ai`);
      assert.ok(record, `disabled chrome renders tile-${capsuleId}-record-ai`);
      assert.ok(record.includes('disabled'), `tile-${capsuleId}-record-ai renders disabled`);
      const shot = domControls(html).find(
        (el) => el.open.includes(`data-semantic-anchor="tile-${capsuleId}-screenshot"`),
      );
      assert.ok(shot, `disabled chrome renders tile-${capsuleId}-screenshot`);
      assert.ok(/\sdisabled[\s>]/.test(shot.open), `tile-${capsuleId}-screenshot renders disabled`);
      const exposed = `${shot.open.match(/title="([^"]*)"/)?.[1] ?? ''} ${shot.open.match(/aria-label="([^"]*)"/)?.[1] ?? ''}`;
      assert.ok(exposed.includes('Recording is unavailable'), `tile-${capsuleId}-screenshot exposes the pinned reason`);
    }
    const Nested = {
      render: () => tiles.map((capsuleId) => h(SurfacePanel, {
        capsuleId,
        title: `Tile ${capsuleId}`,
        projectionView: mount.runtime.projectionView,
        intentBuilders: mount.runtime.intentBuilders,
        controlRegistry: mount.runtime.controlRegistry,
        scheduler: mount.runtime.scheduler,
        tileScheduler: mount.runtime.tileScheduler,
        presentationInstance: `panel-${capsuleId}`,
        captureState: state,
        displayOnly: true,
      })),
    };
    const nestedApp = createSSRApp(Nested);
    nestedApp.provide('capsuleChromeStyle', 'openvue');
    const nested = await renderToString(nestedApp);
    assert.deepEqual(
      domAnchors(nested).filter((anchor) => anchor.startsWith('tile-')),
      [],
      'display-only mode hides the tile chrome',
    );
  } finally { state.dispose(); }
});

test('multislot kit mounts: bar and slot controls are contracted', async () => {
  const { default: Bar } = await server.ssrLoadModule('/.kit/capsule-ui-kit/src/multislot/AiSlotControlBar.vue');
  const bar = await renderWith(Bar, { capsuleId: 'cap-01', capsuleLabel: 'Assisted editor' });
  for (const anchor of [
    'capsule/cap-01/input-mode',
    'capsule/cap-01/multislot/fold',
    'capsule/cap-01/copy-id',
    'capsule/cap-01/multislot/close',
  ]) {
    const found = domControls(bar).find((el) => el.open.includes(`data-semantic-anchor="${anchor}"`));
    assert.ok(found, `slot bar renders ${anchor}`);
    assertDomContract(found, 'slot bar');
  }
  assertSnapshotUnique(domAnchors(bar), 'slot bar anchors');
  const { default: Slot } = await server.ssrLoadModule('/.kit/capsule-ui-kit/src/multislot/AiMultiSlot.vue');
  const slot = await renderWith(Slot, { capsuleId: 'cap-01', capsuleLabel: 'Assisted editor' });
  for (const anchor of ['capsule/cap-01/ai-slot/float', 'capsule/cap-01/ai-slot/fold']) {
    const found = domControls(slot).find((el) => el.open.includes(`data-semantic-anchor="${anchor}"`));
    assert.ok(found, `slot shell renders ${anchor}`);
    assertDomContract(found, 'slot shell');
  }
  assertSnapshotUnique(domAnchors(slot), 'slot shell anchors');
});

test('multislot host mount attempt documents the xterm SSR boundary', async (t) => {
  try {
    const { default: Host } = await server.ssrLoadModule('/src/multislot/MultislotHost.vue');
    const html = await renderWith(Host, { capsuleId: 'cap-01', capsuleLabel: 'Assisted editor' });
    for (const el of domControls(html)) assertDomContract(el, 'multislot host');
    assertSnapshotUnique(domAnchors(html), 'multislot host anchors');
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (message.includes('@xterm/xterm') || message.includes('Terminal')) {
      t.skip('MultislotHost SSR blocked by its xterm named import (source-audited instead)');
      return;
    }
    throw error;
  }
});

test('empty wall mount keeps the stable wall/add-capsule contract', async () => {
  const { default: Empty } = await server.ssrLoadModule('/src/wall/EmptyWallView.vue');
  const html = await renderWith(Empty, {});
  const found = domControls(html).find((el) => el.open.includes('data-semantic-anchor="wall/add-capsule"'));
  assert.ok(found, 'empty wall renders wall/add-capsule');
  assertDomContract(found, 'empty wall');
  assert.ok(found.open.includes('id="empty-wall-add"'), 'empty wall keeps its stable id');
});

test('tile-chrome alias (when present) targets a known fixture key', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  if (!main.includes('tile-chrome')) return;
  const keys = [...main.matchAll(/['"]tile-chrome['"]\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const key of keys) {
    assert.ok(Object.hasOwn(FIXTURES, key), `tile-chrome alias targets a known fixture: ${key}`);
  }
});

test('negative controls: DOM contract and uniqueness checkers fail', () => {
  assertDomContract(
    { tag: 'button', open: '<button id="a" data-semantic-anchor="capsule/cap-01/close" aria-label="Close">', inner: 'x' },
    'planted-good',
  );
  for (const [el, pattern] of [
    [{ tag: 'button', open: '<button data-semantic-anchor="capsule/cap-01/close" aria-label="Close">', inner: 'x' }, /without id/],
    [{ tag: 'button', open: '<button id="pv_id_1" data-semantic-anchor="capsule/cap-01/close" aria-label="Close">', inner: 'x' }, /generated control id/],
    [{ tag: 'button', open: '<button id="a" aria-label="Close">', inner: 'x' }, /without anchor/],
    [{ tag: 'button', open: '<button id="a" data-semantic-anchor="Capsule/cap-01/close" aria-label="Close">', inner: 'x' }, /kebab-case/],
    [{ tag: 'button', open: '<button id="a" data-semantic-anchor="capsule/cap-01/close">', inner: '' }, /without accessible name/],
  ]) {
    assert.throws(() => assertDomContract(el, 'planted'), pattern, el.open);
  }
  assert.throws(
    () => assertSnapshotUnique(['capsule/cap-01/close', 'capsule/cap-01/close'], 'planted'),
    /duplicate in snapshot/,
    'a duplicated snapshot anchor fails',
  );
});


test('wall mount audit releases capture subscription when an assertion fails', async () => {
  const source = readFileSync(new URL('./mvui9-icons-mount.test.js', import.meta.url), 'utf8');
  const marker = "test('wall mount: missing facade disables tile chrome; display-only hides it', async () => {";
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf("\n});", start);
  const body = source.slice(start, end).replace(
    "const capture = await import('../src/capture/capturePort.js');", '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = async (text) => {
    let subscribed = true;
    const capture = {
      createCapturePort: () => ({}),
      createCaptureState: () => ({ dispose() { subscribed = false; } }),
    };
    const audit = new AsyncFunction('capture', 'server', 'wallFixture', 'createSSRApp',
      'renderToString', 'domAnchors', 'assert', text);
    await assert.rejects(audit(capture,
      { ssrLoadModule: async () => ({ default: {} }) },
      () => ({ mount: { fixture: { capsules: [] } } }),
      () => ({ provide() {} }), async () => '', () => [], assert),
    assert.AssertionError);
    assert.equal(subscribed, false, 'subscription released after failed assertion');
  };
  await run(body);
  await assert.rejects(run(body.replace('} finally { state.dispose(); }', '} finally {}')),
    assert.AssertionError, 'negative control detects missing cleanup');
});
