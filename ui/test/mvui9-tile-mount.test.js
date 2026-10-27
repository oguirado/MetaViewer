// MVUI9 lane T: tile capture chrome mounted contracts (SSR through vite).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createSSRApp, h, reactive } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** In-memory capture store double honouring the lane C preamble shape. */
function stubStore(entries = {}) {
  return reactive({
    bySurface: { ...entries },
    rows: [],
    toggleRecord: async () => ({ ok: true }),
    screenshot: async () => ({ ok: true }),
    refresh: async () => {},
    dispose: () => {},
  });
}

function recordingEntry(overrides = {}) {
  return {
    phase: 'recording', recordingId: 'rec-1', frames: 120, elapsedMs: 125000,
    lastShot: null, lastCode: '', ...overrides,
  };
}

/** Collect data-semantic-anchor values in document order. */
function collectAnchors(html) {
  return [...html.matchAll(/data-semantic-anchor="([^"]*)"/g)].map((m) => m[1]);
}

/** Collect id values in document order. */
function collectIds(html) {
  return [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
}

function assertTileTrio(html, surface) {
  for (const suffix of ['record-ai', 'screenshot', 'recording-badge']) {
    const anchor = `tile-${surface}-${suffix}`;
    assert.ok(collectAnchors(html).includes(anchor), `snapshot carries ${anchor}`);
    assert.ok(collectIds(html).includes(anchor), `snapshot carries id ${anchor}`);
  }
}

function assertUniqueAnchors(html) {
  const anchors = collectAnchors(html);
  assert.ok(anchors.length > 0, 'snapshot carries anchors');
  assert.equal(new Set(anchors).size, anchors.length,
    `anchors unique per snapshot: ${anchors.join(', ')}`);
}

function assertDisabledShot(html, surface) {
  const tags = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
  const shot = tags.find((tag) => tag.includes(`tile-${surface}-screenshot`));
  assert.ok(shot, `screenshot control renders for ${surface}`);
  assert.ok(shot.includes('disabled'), `screenshot control is disabled: ${shot}`);
  assert.ok(shot.includes('data-unavailable-reason="Recording is unavailable"'),
    `disabled reason travels with the control: ${shot}`);
  assert.match(shot, /aria-label="[^"]+"/, `disabled control keeps its name: ${shot}`);
}

describe('mounted tile chrome', () => {
  let server;
  let cacheDir;
  /** @type {any} */
  let Chrome = null;

  before(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'mvui9-tile-vite-'));
    server = await createServer({
      cacheDir,
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true },
      appType: 'custom',
    });
    ({ default: Chrome } = await server.ssrLoadModule('/src/wall/TileCaptureChrome.vue'));
  });

  after(async () => {
    await server?.close();
    await rm(cacheDir, { recursive: true, force: true });
  });

  test('every tile renders the record handle, screenshot control and badge', async () => {
    const store = stubStore({
      'cap-1': recordingEntry(),
      'cap-2': { phase: 'idle', recordingId: null, frames: 0, elapsedMs: 0,
        lastShot: { id: 'shot-9' }, lastCode: '' },
      'cap-3': { phase: 'idle', recordingId: null, frames: 0, elapsedMs: 0,
        lastShot: null, lastCode: '' },
    });
    const app = createSSRApp({
      render() {
        return h('div', ['cap-1', 'cap-2', 'cap-3'].map((surface) => h(Chrome, {
          key: surface, capsuleId: surface, capsuleLabel: `Capsule ${surface}`,
          captureState: store,
        })));
      },
    });
    const html = await renderToString(app);
    for (const surface of ['cap-1', 'cap-2', 'cap-3']) assertTileTrio(html, surface);
    assert.ok(html.includes('Recording 02:05'), 'recording badge shows elapsed time');
    assert.ok(html.includes('>Captured<'), 'fresh screenshot reads Captured');
    assert.ok(html.includes('>Screenshot<'), 'idle tile reads Screenshot');
    assert.ok(html.includes('cuk-saas-record-cap-1'), 'kit record toggle renders per tile');
    assert.ok(html.includes('capsule/cap-1/record'), 'kit record anchor survives');
    assert.ok(html.includes('cuk-sidebar-icon'), 'screenshot icon renders through the kit wrapper');
  });

  test('chrome follows store updates: recording badge is reactive', async () => {
    const store = stubStore({ 'cap-7': { phase: 'idle', lastShot: null } });
    const render = () => renderToString(createSSRApp(Chrome,
      { capsuleId: 'cap-7', captureState: store }));
    assert.ok((await render()).includes('>Idle<'), 'idle entry reads Idle');
    store.bySurface['cap-7'] = recordingEntry({ elapsedMs: 61000 });
    assert.ok((await render()).includes('Recording 01:01'), 'recording entry shows elapsed');
    store.bySurface['cap-7'] = { phase: 'error', lastShot: null };
    const errored = await render();
    assert.ok(errored.includes('>Idle<'), 'error phase renders no error text');
    assert.doesNotMatch(errored, /ERR_/, 'no refusal code leaks into the rail');
  });

  test('Map-backed stores resolve entries like plain objects', async () => {
    const store = stubStore();
    store.bySurface = new Map([['cap-8', recordingEntry({ elapsedMs: 5000 })]]);
    const html = await renderToString(createSSRApp(Chrome,
      { capsuleId: 'cap-8', captureState: store }));
    assertTileTrio(html, 'cap-8');
    assert.ok(html.includes('Recording 00:05'), 'Map entry drives the badge');
  });

  test('without a capture store the controls render disabled with the shared reason', async () => {
    const html = await renderToString(createSSRApp(Chrome,
      { capsuleId: 'cap-9', captureState: null }));
    assertTileTrio(html, 'cap-9');
    assertDisabledShot(html, 'cap-9');
    assert.ok(html.includes('data-unavailable-reason="Recording is unavailable"'),
      'kit toggle carries the same reason');
    assert.ok(html.includes('aria-label="Screenshot cap-9"'), 'disabled control keeps its name');
    assert.ok(html.includes('>Idle<'), 'badge keeps its idle readout');
    assert.doesNotMatch(html, /ERR_/, 'no refusal code leaks into the rail');
  });

  test('nested display-only mode hides the whole rail', async () => {
    const html = await renderToString(createSSRApp(Chrome,
      { capsuleId: 'cap-1', captureState: stubStore(), displayOnly: true }));
    assert.equal(html.includes('mv-tile-chrome'), false, 'no rail markup renders');
    assert.deepEqual(collectAnchors(html).filter((anchor) => anchor.startsWith('tile-')), [],
      'no tile anchors leak into the snapshot');
  });

  test('anchors stay unique across a nine-tile snapshot', async () => {
    const surfaces = Array.from({ length: 9 }, (unused, index) => `cap-${index + 1}`);
    const entries = Object.fromEntries(surfaces.map((surface, index) => [surface,
      index === 0 ? recordingEntry({ elapsedMs: 73000 }) : { phase: 'idle', lastShot: null }]));
    const app = createSSRApp({
      render() {
        return h('div', surfaces.map((surface) => h(Chrome, {
          key: surface, capsuleId: surface, captureState: stubStore(entries),
        })));
      },
    });
    const html = await renderToString(app);
    for (const surface of surfaces) assertTileTrio(html, surface);
    assertUniqueAnchors(html);
    assert.equal(collectAnchors(html).filter((anchor) => anchor.startsWith('tile-')).length, 27);
    assert.ok(html.includes('Recording 01:13'), 'recording tile shows elapsed in the wall');
  });

  test('negative control: trio, disabled and hidden assertions fail mutated snapshots', async () => {
    const full = stubStore({ 'cap-1': recordingEntry() });
    const html = await renderToString(createSSRApp(Chrome,
      { capsuleId: 'cap-1', captureState: full }));
    assertTileTrio(html, 'cap-1');
    assert.throws(() => assertTileTrio(
      html.replace('tile-cap-1-screenshot', 'tile-cap-1-removed'), 'cap-1'),
    assert.AssertionError, 'missing anchor fails the trio');
    assert.throws(() => assertUniqueAnchors(`${html}${html}`),
      assert.AssertionError, 'duplicated snapshot fails uniqueness');
    assert.throws(() => assertDisabledShot(html, 'cap-1'),
      assert.AssertionError, 'enabled control fails the disabled path');
    const disabled = await renderToString(createSSRApp(Chrome,
      { capsuleId: 'cap-1', captureState: null }));
    assertDisabledShot(disabled, 'cap-1');
    const hidden = await renderToString(createSSRApp(Chrome,
      { capsuleId: 'cap-1', captureState: full, displayOnly: true }));
    assert.throws(() => assertTileTrio(hidden, 'cap-1'),
      assert.AssertionError, 'hidden rail fails the trio');
    assert.throws(() => assertTileTrio(html, 'cap-2'),
      assert.AssertionError, 'foreign surface fails the trio');
  });
});
