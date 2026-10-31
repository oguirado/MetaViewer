// Lane R: ?state=live-replay boot wiring. Executes the real entry like
// mvui-int-boot with the replay bindings added to the stub map: the replay
// mounts through the real authority runtime, invalid steps refuse with the
// fixed preview copy, and live boot plus every other fixture ignore ?step=.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hostAdapters from '../src/core/hostAdapters.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime, createLiveReplayMount, LIVE_REPLAY_FIXTURE } from '../src/fixtures/fixtureRuntime.js';
import { createWallLayout, migrateWallLayout } from '../src/wall/layout.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const FIXED_PREVIEW_COPY = 'MetaViewer cannot start: This preview is unavailable.';
let serial = 0;

/**
 * Boots the real entry with a stubbed module map and records the outcome.
 * @param {string} search
 * @param {{ host?: any }} [options]
 */
async function bootEntry(search, { host = null } = {}) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const mount = { textContent: '', dataset: {} };
  let mounted = null;
  const kitSchemes = [];
  const events = new Map();
  const fakeWindow = {
    location: { search },
    ...(host === null ? {} : { metaviewer: host }),
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: (name) => events.delete(name),
  };
  globalThis.window = fakeWindow;
  globalThis.document = { documentElement: { dataset: {} }, querySelector: () => mount };
  globalThis.__mvuiRBoot = {
    vue: { createApp: (_App, props) => ({ mount: (selector) => { mounted = { props, selector }; } }) },
    './App.vue': {},
    './core/hostAdapters.js': hostAdapters,
    './settings/settingsHost.js': { createSettingsHost },
    './fixtures/resolveState.js': { parseStateQuery, resolveFixture },
    './fixtures/fixtureRuntime.js': { createFixtureRuntime, createLiveReplayMount, LIVE_REPLAY_FIXTURE },
    './wall/layout.js': { createWallLayout, migrateWallLayout },
    'capsule-ui-kit/theme': { installKitTheme() {}, setKitScheme: (scheme) => kitSchemes.push(scheme) },
  };
  try {
    const code = main
      .replace(
        /^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
        (_all, binding, _quote, specifier) => `const ${binding.trim()} = globalThis.__mvuiRBoot[${JSON.stringify(specifier)}];`,
      )
      .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
    serial += 1;
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#r-replay-${serial}`);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    delete globalThis.__mvuiRBoot;
  }
  return { mount, mounted, kitSchemes, events, fakeWindow };
}

test('replay mounts the full script through the real runtime by default', async () => {
  const { mount, mounted, kitSchemes } = await bootEntry('?state=live-replay');
  assert.equal(mount.textContent, '');
  assert.ok(mounted, 'replay mounts');
  assert.equal(mounted.selector, '#metaviewer-app');
  assert.equal(mounted.props.fixture.key, 'live-replay');
  assert.equal(mounted.props.fixture, LIVE_REPLAY_FIXTURE, 'no copy without override');
  const rows = mounted.props.runtime.projectionView.getProjection()?.rows ?? [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'cap-01');
  assert.equal(rows[0].generation, 7);
  assert.equal(rows[0].backendLifecycle, 'active');
  assert.equal(mounted.props.terminal, null);
  assert.equal(mounted.props.terminalBroker, null);
  assert.equal(mounted.props.exportDestination, '');
  assert.equal(await mounted.props.storage.readRaw(), null);
  assert.equal(mounted.props.nestedHost.getNestedDepth(), 0);
  assert.deepEqual(kitSchemes, ['mv-light']);
});

test('replay answers intents and proposals through the mounted adapter', async () => {
  const { mounted } = await bootEntry('?state=live-replay&step=5');
  assert.ok(mounted);
  const adapter = mounted.props.authorityHost;
  assert.ok(adapter, 'replay binds the intent adapter to the fake port');
  const request = mounted.props.runtime.intentBuilders.control({ capsuleId: 'cap-01', verb: 'take_control' });
  assert.equal(await adapter.intent(request), true);
  assert.equal((await adapter.propose({ schema:'action_proposal/v0.2',proposal_id:'p',surface_id:'cap-01',based_on_frame:{generation:1,sha256:'a'.repeat(64)},budget:{max_ms:100,max_retries:0},action:{type:'click',x:1,y:1,button:'left'},expectation:{type:'state_sha256_change'} })).code, 'ACTION_ADMITTED');
  const refused = await adapter.propose({ schema:'action_proposal/v0.2',proposal_id:'p',surface_id:'cap-01',based_on_frame:{generation:1,sha256:'a'.repeat(64)},budget:{max_ms:100,max_retries:0},action:{type:'click',x:1,y:1,button:'left'},expectation:{type:'state_sha256_change'}, refuse: true });
  assert.equal(refused.code, 'POLICY');
  assert.doesNotMatch(refused.message, /POLICY|ERR_/);
});

test('?step= captures each replay phase for the bench', async () => {
  const matrix = [
    ['?state=live-replay&step=0', 0, null],
    ['?state=live-replay&step=1', 1, 1],
    ['?state=live-replay&step=3', 1, 3],
    ['?state=live-replay&step=4', 1, 4],
    ['?state=live-replay&step=6', 1, 5],
    ['?state=live-replay&step=7', 1, 6],
    ['?state=live-replay&step=8', 1, 7],
  ];
  for (const [search, rowCount, generation] of matrix) {
    const { mount, mounted } = await bootEntry(search);
    assert.equal(mount.textContent, '', search);
    assert.ok(mounted, search);
    const rows = mounted.props.runtime.projectionView.getProjection()?.rows ?? [];
    assert.equal(rows.length, rowCount, search);
    assert.equal(rows[0]?.generation ?? null, generation, search);
  }
  const stale = await bootEntry('?state=live-replay&step=6');
  assert.equal(stale.mounted.props.runtime.projectionView.getSnapshot().stale, false);
  assert.equal(stale.mounted.props.runtime.projectionView.getSnapshot().error, null);
  const lost = await bootEntry('?state=live-replay&step=7');
  const lostRows = lost.mounted.props.runtime.projectionView.getProjection()?.rows ?? [];
  assert.equal(lostRows[0].backendLifecycle, 'lost');
});

test('?scheme= overrides the replay scheme without mutating the shared record', async () => {
  const { mount, mounted, kitSchemes } = await bootEntry('?state=live-replay&scheme=mv-dark&step=2');
  assert.equal(mount.textContent, '');
  assert.ok(mounted);
  assert.equal(mounted.props.fixture.key, 'live-replay');
  assert.equal(mounted.props.fixture.scheme, 'mv-dark');
  assert.deepEqual(kitSchemes, ['mv-dark']);
  assert.ok(Object.isFrozen(mounted.props.fixture));
  assert.equal(LIVE_REPLAY_FIXTURE.scheme, 'mv-light', 'shared record never mutated');
  const rows = mounted.props.runtime.projectionView.getProjection()?.rows ?? [];
  assert.equal(rows[0]?.generation, 2, 'step and scheme compose');
  const refused = await bootEntry('?state=live-replay&scheme=bogus');
  assert.equal(refused.mounted, null);
  assert.equal(refused.mount.textContent, FIXED_PREVIEW_COPY);
  assert.equal(refused.mount.dataset.errorCode, 'ERR_UNKNOWN_SCHEME');
});

test('invalid steps refuse boot with the fixed preview copy', async () => {
  const cases = [
    ['?state=live-replay&step=', 'ERR_INVALID_STEP_QUERY'],
    ['?state=live-replay&step=bogus', 'ERR_INVALID_STEP_QUERY'],
    ['?state=live-replay&step=-1', 'ERR_INVALID_STEP_QUERY'],
    ['?state=live-replay&step=02', 'ERR_INVALID_STEP_QUERY'],
    ['?state=live-replay&step=2&step=3', 'ERR_INVALID_STEP_QUERY'],
    ['?state=live-replay&step=9', 'ERR_UNKNOWN_STEP'],
    ['?state=live-replay&step=99', 'ERR_UNKNOWN_STEP'],
  ];
  for (const [search, code] of cases) {
    let liveReads = 0;
    const host = {};
    Object.defineProperty(host, 'load', { get() { liveReads += 1; throw new Error('private host detail'); } });
    const { mount, mounted } = await bootEntry(search, { host });
    assert.equal(mounted, null, `${search} must not mount`);
    assert.equal(mount.textContent, FIXED_PREVIEW_COPY, search);
    assert.equal(mount.dataset.errorCode, code, search);
    assert.doesNotMatch(mount.textContent, /ERR_|private host detail/, search);
    assert.equal(liveReads, 0, `${search} never reaches the host`);
  }
});

test('state errors win over step errors', async () => {
  const { mount, mounted } = await bootEntry('?state=nope&step=bogus');
  assert.equal(mounted, null);
  assert.equal(mount.textContent, FIXED_PREVIEW_COPY);
  assert.equal(mount.dataset.errorCode, 'ERR_UNKNOWN_FIXTURE_STATE');
});

test('replay never touches the live host', async () => {
  let liveReads = 0;
  const host = {};
  for (const key of ['load', 'save']) {
    Object.defineProperty(host, key, { get() { liveReads += 1; throw new Error('private host detail'); } });
  }
  const { mount, mounted } = await bootEntry('?state=live-replay&step=5', { host });
  assert.equal(mount.textContent, '');
  assert.ok(mounted);
  assert.equal(liveReads, 0);
});

test('live boot ignores ?step= entirely, including garbage', async () => {
  const host = { load: async () => null, save: async () => true };
  for (const search of ['', '?step=3', '?step=bogus', '?step=1&step=2', '?step=']) {
    const { mount, mounted, kitSchemes } = await bootEntry(search, { host });
    assert.equal(mount.textContent, '', `live ${search} mounts`);
    assert.ok(mounted, `live ${search} mounts`);
    assert.equal(mounted.props.fixture, null, `live ${search} has no fixture`);
    assert.deepEqual(kitSchemes, ['mv-light'], `live ${search} keeps the default seed`);
  }
});

test('other fixtures ignore ?step= entirely, including garbage', async () => {
  for (const search of ['?state=four&step=3', '?state=four&step=bogus', '?state=four&step=1&step=2', '?state=one&step=']) {
    const { mount, mounted } = await bootEntry(search);
    assert.equal(mount.textContent, '', `${search} mounts`);
    assert.ok(mounted, search);
    assert.equal(mounted.props.authorityHost, null, `${search} binds no adapter`);
    const rows = mounted.props.runtime.projectionView.getProjection().rows;
    assert.equal(rows.length, search.includes('state=four') ? 4 : 1, search);
  }
});

test('pagehide disposes the replay runtime and releases the listener', async () => {
  const { mounted, events, fakeWindow } = await bootEntry('?state=live-replay&step=5');
  assert.ok(mounted);
  const view = mounted.props.runtime.projectionView;
  const off = view.subscribe(() => {});
  assert.equal(typeof off, 'function');
  off();
  assert.equal(events.has('pagehide'), true, 'replay registers teardown');
  const previousWindow = globalThis.window;
  globalThis.window = fakeWindow;
  try {
    events.get('pagehide')();
  } finally {
    globalThis.window = previousWindow;
  }
  assert.equal(events.has('pagehide'), false, 'teardown releases the listener');
  assert.throws(() => view.subscribe(() => {}), /disposed/);
});

test('boot keeps the closed stub-map import surface for the replay hook', () => {
  assert.ok(main.includes("import { parseStateQuery, resolveFixture } from './fixtures/resolveState.js';"));
  assert.ok(main.includes('createLiveReplayMount'));
  assert.ok(main.includes('ERR_INVALID_STEP_QUERY'));
  assert.ok(main.includes('ERR_UNKNOWN_STEP'));
  assert.doesNotMatch(main, /from\s+['"]\.\/fixtures\/liveReplay\.js['"]/,
    'direct replay imports would break the closed boot stub maps');
});
