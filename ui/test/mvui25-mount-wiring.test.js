// MVUI25 lane A: entry input-port wiring plus App gating. main.js keeps
// its closed stub-map import surface (input names travel through the
// fixtureRuntime re-export), builds the port from the double on fixtures
// and host.input live, and provides it as 'inputPort'; App computes
// per-surface inputEnabled/streamId and passes them to every SurfaceCanvas.
// Every behaviour test has a negative control; async waits via frame-wait.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hostAdapters from '../src/core/hostAdapters.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { TILE_CHROME_FIXTURE, TILE_CHROME_KEY, fixtureCaptureSeed } from '../src/fixtures/tileChrome.js';
import { INPUT_WRITE_FIXTURE, INPUT_WRITE_KEY } from '../src/fixtures/inputWrite.js';
import { createWallLayout, migrateWallLayout } from '../src/wall/layout.js';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { tick } from './frame-wait.mjs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');

/** @param {string} source */
function staticImportSpecifiers(source) {
  return [...source.matchAll(/^import\s+[^\n]+?\s+from\s+(['"])(.*?)\1;?$/gm)].map((match) => match[2]);
}

describe('entry source shape', () => {
  test('main.js keeps its closed stub-map import surface', () => {
    assert.deepEqual(staticImportSpecifiers(main), [
      'vue',
      './App.vue',
      './core/hostAdapters.js',
      './settings/settingsHost.js',
      './fixtures/resolveState.js',
      './fixtures/fixtureRuntime.js',
      './wall/layout.js',
      'capsule-ui-kit/theme',
    ]);
    for (const name of ['INPUT_WRITE_FIXTURE', 'INPUT_WRITE_KEY', 'createInputPort', 'createInputDouble']) {
      assert.ok(main.includes(name), `re-exported name wired: ${name}`);
    }
  });

  test('negative control: the surface check fails on a planted direct import', () => {
    assert.deepEqual(staticImportSpecifiers(main).length, 8);
    assert.throws(() => assert.deepEqual(
      staticImportSpecifiers(`${main}\nimport { x } from './input/inputPort.js';`).length, 8),
      assert.AssertionError);
  });

  test('live input wraps host.input without fresh window reads', () => {
    assert.ok(main.includes('host?.input'), 'facade reached through the pinned host read');
    assert.ok(main.includes('fixture ? inputDouble : host?.input'), 'double backs fixtures, host backs live');
    const liveReads = main.replaceAll('__metaviewerBench', '').match(/\.metaviewer\b/g) ?? [];
    assert.equal(liveReads.length, 1, 'the single host read (layout uses bracket access)');
  });

  test('negative control: the read pin fails on a planted window read', () => {
    const count = (source) => (source.replaceAll('__metaviewerBench', '').match(/\.metaviewer\b/g) ?? []).length;
    assert.equal(count(main), 1);
    assert.throws(() => assert.equal(count(`${main}\nconst c = window.metaviewer.input;`), 1),
      assert.AssertionError);
  });

  test('entry builds, provides and disposes the input port', () => {
    for (const snippet of [
      "typeof createInputDouble === 'function' ? createInputDouble() : null",
      'fixture ? inputDouble !== null : true',
      'createInputPort(',
      "application.provide?.('inputPort', inputPort)",
      'inputPort?.dispose?.()',
      'isInputWrite',
    ]) {
      assert.ok(main.includes(snippet), `entry ships: ${snippet}`);
    }
  });
});

describe('App gating forwarding', () => {
  test('App inlines gating (no new import) and initialises the shared input mode', () => {
    assert.ok(!appSource.includes('inputGating.js'), 'no new import: the App surface stays pinned');
    assert.ok(appSource.includes("String(props.fixture?.ui?.inputMode ?? '').toLowerCase() === 'write' ? 'write' : 'read'"),
      'fixture-driven initial mode');
    assert.ok(appSource.includes('v-model:input-mode="inputMode"'), 'multislot keeps the shared ref');
    assert.ok(appSource.includes('function inputEnabledFor(surface)'), 'per-surface gate');
    assert.ok(appSource.includes('function surfaceStreamId(surface)'), 'per-surface stream id');
    assert.ok(appSource.includes("control === 'human' && inputMode.value === 'write'"), 'wall reads the same ref');
  });

  test('App passes inputEnabled and streamId to every SurfaceCanvas', () => {
    const bindings = appSource.match(/<SurfaceCanvas[^>]*>/g) ?? [];
    assert.equal(bindings.length, 3, 'nested, wall and multislot tiles');
    for (const tag of bindings) {
      assert.ok(tag.includes(':input-enabled="inputEnabledFor('), `gated: ${tag.slice(0, 80)}`);
      assert.ok(tag.includes(':stream-id="surfaceStreamId('), `stream: ${tag.slice(0, 80)}`);
    }
    assert.ok(appSource.includes(':input-enabled="inputEnabledFor(surface)"'), 'wall/nested row');
    assert.ok(appSource.includes(':input-enabled="inputEnabledFor(selectedSurface)"'), 'multislot row');
  });

  test('negative control: the forwarding check fails when bindings are stripped', () => {
    const forwarded = (source) => (source.match(/<SurfaceCanvas[^>]*:input-enabled=/g) ?? []).length === 3
      && (source.match(/<SurfaceCanvas[^>]*:stream-id=/g) ?? []).length === 3;
    assert.equal(forwarded(appSource), true);
    assert.equal(forwarded(appSource.replaceAll(':input-enabled=', ':data-input-enabled=')), false);
    assert.equal(forwarded(appSource.replaceAll(':stream-id=', ':data-stream-id=')), false);
  });
});

const APP_URL = new URL('../src/App.vue', import.meta.url);
let appSerial = 500;

/**
 * Load the real App with stub children. The WallWorkspace stub renders the
 * surface slot per test row; the SurfaceCanvas stub records its input props.
 * @param {{ canvases?: Array<Record<string, unknown>>, rows?: unknown[] }} captured
 */
async function loadGatingApp(captured) {
  const stub = vue.defineComponent({
    setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap((slot) => slot?.() ?? [])),
  });
  const canvasStub = vue.defineComponent({
    props: ['surfaceId', 'inputEnabled', 'streamId'],
    setup: (props) => {
      (captured.canvases ??= []).push({ ...props });
      return () => vue.h('div');
    },
  });
  const wallStub = vue.defineComponent({
    setup: (_, ctx) => () => vue.h('div', {}, (captured.rows ?? []).map((row) =>
      ctx.slots.surface?.({ surface: row, capsuleId: /** @type {{ id: string }} */ (row).id }) ?? [])),
  });
  globalThis.__vdeps = {
    './core/HostOutcome.vue': stub,
    './activity/ActivityStrip.vue': stub,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    './wall/WallWorkspace.vue': wallStub,
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': stub,
    './terminal/SideTerminalOverlay.vue': stub,
    './multislot/MultislotHost.vue': stub,
    './recording/MvRecordingPanel.vue': stub,
    './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub,
    './surfaces/SurfaceCanvas.vue': canvasStub,
    './creative/CreativeCapsule.vue': stub,
    'capsule-ui-kit/ui': { UiButton: stub },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    './nested/nested.js': { resolveNestedMode, applyNestedWall },
    './surfaces/tileScheduler.js': { createTileScheduler },
  };
  const { descriptor } = parse(readFileSync(APP_URL, 'utf8'));
  const compiled = compileScript(descriptor, { id: `v-gating-${++appSerial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    return `const ${binding.trim()} = globalThis.__vdeps[${JSON.stringify(specifier)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#v-gating-${appSerial}`)).default;
}

function gatingRenderer() {
  return vue.createRenderer({
    createElement: (tag) => ({ tag, props: {}, children: [] }),
    createText: (text) => ({ text }),
    createComment: (text) => ({ text }),
    insert(child, parent, anchor) {
      if (child.parent) this.remove(child);
      child.parent = parent;
      const i = parent.children.indexOf(anchor);
      parent.children.splice(i < 0 ? parent.children.length : i, 0, child);
    },
    remove(child) { const items = child.parent?.children; if (items) items.splice(items.indexOf(child), 1); },
    setText(node, text) { node.text = text; },
    setElementText(node, text) { node.text = text; },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp(node, key, _old, value) { node.props[key] = value; },
    querySelector: () => null,
    setScopeId() {},
  });
}

/**
 * @param {unknown[]} rows
 */
function gatingRuntime(rows) {
  return {
    projectionView: {
      getSnapshot: () => ({ envelope: { epoch: 1 } }),
      getProjection: () => ({ rows }),
      subscribe: () => () => {},
    },
  };
}

const GATING_STORAGE = { readRaw: async () => null, writeAtomic: async () => {} };
const GATING_NESTED_LIVE = { getNestedDepth: () => 0, getSelfCapsuleId: () => null };
const GATING_NESTED_ONLY = { getNestedDepth: () => 1, getSelfCapsuleId: () => null };

/**
 * @param {string} id
 * @param {string} control
 * @param {number} [generation]
 */
function gatingRow(id, control, generation = 1) {
  return {
    id, surfaceId: id, title: id, kind: 'program', backendLifecycle: 'active',
    generation, visibility: 'unfolded', control, controlOwner: control === 'shared' ? 'none' : control,
    folded: false, refusal: null, readinessError: null, attachmentState: 'live',
    aiSessionActivity: 'ready', dispatchOutcome: 'none',
  };
}

/**
 * Mount the real App and collect SurfaceCanvas input props.
 * @param {{ fixture?: unknown, rows?: unknown[], nestedHost?: unknown, router?: unknown }} over
 */
async function mountGating(over = {}) {
  const captured = { canvases: [], rows: over.rows ?? [] };
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: undefined };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  let handle = null;
  try {
    const App = await loadGatingApp(captured);
    const root = { children: [] };
    handle = gatingRenderer().createApp(App, {
      layout: {}, scope: {}, storage: GATING_STORAGE,
      fixture: over.fixture ?? null,
      nestedHost: over.nestedHost ?? GATING_NESTED_LIVE,
      runtime: gatingRuntime(captured.rows),
    });
    if (over.router) handle.provide('framePortRouter', over.router);
    handle.mount(root);
    await tick();
    await vue.nextTick();
    return { canvases: captured.canvases };
  } finally {
    try { handle?.unmount(); } catch { /* Teardown never fails the gate. */ }
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
    delete globalThis.__vdeps;
  }
}

describe('gating matrix (mounted App)', () => {
  test('human+write enables the wall tile; read and agent stay disabled', async () => {
    const rows = [gatingRow('cap-01', 'human'), gatingRow('cap-02', 'agent'), gatingRow('cap-03', 'shared')];
    const gated = await mountGating({ fixture: INPUT_WRITE_FIXTURE, rows });
    const byId = new Map(gated.canvases.map((row) => [row.surfaceId, row]));
    assert.equal(byId.get('cap-01')?.inputEnabled, true);
    assert.equal(byId.get('cap-02')?.inputEnabled, false);
    assert.equal(byId.get('cap-03')?.inputEnabled, false);

    const read = await mountGating({ fixture: null, rows: [gatingRow('cap-01', 'human')] });
    assert.equal(read.canvases.length, 1);
    assert.equal(read.canvases[0].inputEnabled, false);
  });

  test('negative control: agent control and READ mode send nothing', async () => {
    const agentWrite = await mountGating({ fixture: INPUT_WRITE_FIXTURE, rows: [gatingRow('cap-01', 'agent')] });
    assert.equal(agentWrite.canvases[0].inputEnabled, false);
    const humanRead = await mountGating({ fixture: null, rows: [gatingRow('cap-01', 'human')] });
    assert.equal(humanRead.canvases[0].inputEnabled, false);
    assert.throws(() => assert.equal(agentWrite.canvases[0].inputEnabled, true), assert.AssertionError);
    assert.throws(() => assert.equal(humanRead.canvases[0].inputEnabled, true), assert.AssertionError);
  });

  test('nested display-only never enables, even for human+write', async () => {
    const nested = await mountGating({
      fixture: INPUT_WRITE_FIXTURE,
      rows: [gatingRow('cap-01', 'human')],
      nestedHost: GATING_NESTED_ONLY,
    });
    assert.ok(nested.canvases.length >= 1);
    for (const row of nested.canvases) assert.equal(row.inputEnabled, false);
  });

  test('negative control: the nested wall renders but stays non-focusable', async () => {
    const nested = await mountGating({
      fixture: INPUT_WRITE_FIXTURE,
      rows: [gatingRow('cap-01', 'human')],
      nestedHost: GATING_NESTED_ONLY,
    });
    assert.ok(nested.canvases.length >= 1, 'nested tiles render');
    assert.throws(() => assert.equal(nested.canvases[0].inputEnabled, true), assert.AssertionError);
  });

  test('streamId: router wins, else projection generation', async () => {
    const router = { getSurfaceStatus: (id) => (id === 'cap-01' ? { surfaceGeneration: 7 } : null) };
    const live = await mountGating({
      fixture: INPUT_WRITE_FIXTURE,
      rows: [gatingRow('cap-01', 'human', 2), gatingRow('cap-02', 'human', 3)],
      router,
    });
    const byId = new Map(live.canvases.map((row) => [row.surfaceId, row]));
    assert.equal(byId.get('cap-01')?.streamId, 7);
    assert.equal(byId.get('cap-02')?.streamId, 3);

    const legacy = await mountGating({ fixture: null, rows: [gatingRow('cap-01', 'human', 5)] });
    assert.equal(legacy.canvases[0].streamId, 5);
  });

  test('negative control: router throw degrades to the projection id', async () => {
    const throwing = { getSurfaceStatus: () => { throw new Error('router down'); } };
    const mounted = await mountGating({
      fixture: INPUT_WRITE_FIXTURE,
      rows: [gatingRow('cap-01', 'human', 4)],
      router: throwing,
    });
    assert.equal(mounted.canvases[0].streamId, 4);
    assert.throws(() => assert.equal(mounted.canvases[0].streamId, 0), assert.AssertionError);
  });
});

/**
 * @param {{ available?: boolean }} [over]
 */
function fakeInput(over = {}) {
  const calls = [];
  const double = Object.freeze({ kind: 'input-double' });
  const port = { available: over.available !== false, calls, dispose() { calls.push(['dispose']); } };
  const factories = {
    createInputDouble: () => { calls.push(['createDouble']); return double; },
    createInputPort: (facade) => { calls.push(['createPort', facade === double]); return port; },
  };
  return { calls, double, port, factories };
}

/**
 * Boot the real entry with a fake module map (int-boot pattern).
 * @param {string} search
 * @param {{ fixtureRuntimeExtra?: object, windowExtra?: object }} [over]
 */
async function bootEntry(search, over = {}) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousBoot = globalThis.__mvuiBoot;
  const mount = { textContent: '', dataset: {} };
  let mounted = null;
  try {
    const forbidden = () => { throw new Error('fixture called live preload'); };
    globalThis.window = {
      location: { search },
      addEventListener() {},
      removeEventListener() {},
      metaviewer: {
        load: forbidden, save: forbidden, nestedDepth: forbidden,
        selfCapsuleId: forbidden, recordingDestination: forbidden,
      },
      ...over.windowExtra,
    };
    globalThis.document = { documentElement: { dataset: {} }, querySelector: () => mount };
    globalThis.__mvuiBoot = {
      vue: {
        createApp: (_App, props) => {
          const provides = {};
          return {
            mount: (selector) => { mounted = { props, selector, provides }; },
            provide: (key, value) => { provides[key] = value; },
            onUnmount: () => {},
          };
        },
      },
      './App.vue': {},
      './core/hostAdapters.js': hostAdapters,
      './settings/settingsHost.js': { createSettingsHost },
      './fixtures/resolveState.js': { parseStateQuery, resolveFixture },
      './fixtures/fixtureRuntime.js': {
        createFixtureRuntime: (fixture) => ({
          ok: true,
          mount: {
            fixture,
            runtime: {
              projectionView: {
                getProjection: () => ({ rows: fixture.capsules }),
                getSnapshot: () => ({ envelope: { epoch: 1 } }),
                subscribe: () => () => {},
              },
            },
            calls: [],
            terminal: null,
          },
        }),
        TILE_CHROME_KEY,
        TILE_CHROME_FIXTURE,
        fixtureCaptureSeed,
        INPUT_WRITE_KEY,
        INPUT_WRITE_FIXTURE,
        ...over.fixtureRuntimeExtra,
      },
      './wall/layout.js': { createWallLayout, migrateWallLayout },
      'capsule-ui-kit/theme': { installKitTheme() {}, setKitScheme() {} },
    };
    const code = main.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
      (_all, binding, _quote, specifier) => `const ${binding.trim()} = globalThis.__mvuiBoot[${JSON.stringify(specifier)}];`)
      .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
    bootSerial += 1;
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui25-${bootSerial}`);
    await tick();
    return { mounted, mount };
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    if (previousBoot === undefined) delete globalThis.__mvuiBoot;
    else globalThis.__mvuiBoot = previousBoot;
  }
}
let bootSerial = 0;

describe('entry boot behavior', () => {
  test('?state=input-write mounts one human tile with a double-backed port', async () => {
    const input = fakeInput();
    const { mounted, mount } = await bootEntry('?state=input-write', { fixtureRuntimeExtra: input.factories });
    assert.equal(mount.textContent, '');
    assert.ok(mounted, 'alias boots');
    assert.equal(mounted.selector, '#metaviewer-app');
    assert.equal(mounted.props.fixture.key, 'input-write');
    assert.equal(mounted.props.fixture.capsules.length, 1);
    assert.equal(mounted.props.fixture.capsules[0].control, 'human');
    assert.equal(mounted.provides.inputPort, input.port);
    assert.deepEqual(input.calls, [['createDouble'], ['createPort', true]]);
  });

  test('fixture boots use the double; live boots use host.input', async () => {
    const fixtureInput = fakeInput();
    const fixtureBoot = await bootEntry('?state=one', { fixtureRuntimeExtra: fixtureInput.factories });
    assert.ok(fixtureBoot.mounted, 'fixture boots');
    assert.equal(fixtureBoot.mounted.provides.inputPort, fixtureInput.port);
    assert.deepEqual(fixtureInput.calls, [['createDouble'], ['createPort', true]]);

    const liveInput = fakeInput();
    const hostInput = Object.freeze({ kind: 'host-input' });
    const liveBoot = await bootEntry('', {
      fixtureRuntimeExtra: liveInput.factories,
      windowExtra: {
        metaviewer: {
          load: async () => null, save: async () => ({ ok: true }),
          nestedDepth: async () => 0, selfCapsuleId: async () => null,
          recordingDestination: async () => '', input: hostInput,
        },
      },
    });
    assert.ok(liveBoot.mounted, 'live boots');
    assert.equal(liveBoot.mounted.props.fixture, null);
    assert.equal(liveBoot.mounted.provides.inputPort, liveInput.port);
    assert.deepEqual(liveInput.calls, [['createPort', false]]);
  });

  test('negative control: live boot without host.input still provides a port (facade undefined)', async () => {
    const input = fakeInput();
    let seen = 'unset';
    const factories = {
      ...input.factories,
      createInputPort: (facade) => { seen = facade; return input.port; },
    };
    const { mounted } = await bootEntry('', {
      fixtureRuntimeExtra: factories,
      windowExtra: { metaviewer: { load: async () => null, save: async () => ({ ok: true }) } },
    });
    assert.ok(mounted, 'live boots without an input facade');
    assert.equal(seen, undefined);
    assert.equal(mounted.provides.inputPort, input.port);
  });

  test('negative control: missing factories degrade to null without refusing boot', async () => {
    const { mounted, mount } = await bootEntry('?state=one', { fixtureRuntimeExtra: {} });
    assert.equal(mount.textContent, '');
    assert.ok(mounted, 'boots without input names (stub-harness shape)');
    assert.equal(mounted.provides.inputPort, null);
  });

  test('unknown and repeated states still refuse; the alias widens nothing', async () => {
    for (const search of ['?state=nope', '?state=', '?state=one&state=four', '?state=input-write&state=one']) {
      const { mounted, mount } = await bootEntry(search, { fixtureRuntimeExtra: fakeInput().factories });
      assert.equal(mounted, null, `no mount for ${search}`);
      assert.equal(mount.textContent, 'MetaViewer cannot start: This preview is unavailable.', search);
      assert.match(mount.dataset.errorCode, /^ERR_/, search);
    }
  });
});

test('input port registers pagehide disposal', async () => {
  const input = fakeInput();
  let pagehide;
  const removals = [];
  await bootEntry('?state=one', {
    fixtureRuntimeExtra: input.factories,
    windowExtra: { addEventListener(name, callback) { if (name === 'pagehide') pagehide = callback; } },
  });
  assert.equal(typeof pagehide, 'function');
  const previous = globalThis.window;
  globalThis.window = { removeEventListener: (...args) => removals.push(args) };
  try { pagehide(); } finally { globalThis.window = previous; }
  assert.deepEqual(input.calls.at(-1), ['dispose']);
  assert.equal(removals[0][0], 'pagehide');
});

test('rss stays under 512 MiB', () => {
  const rss = process.memoryUsage().rss;
  if (process.env.MVUI16_MEASURE) console.log(`mvui25-mount-wiring rss MiB: ${Math.round(rss / 1048576)}`);
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
