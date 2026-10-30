import {addOperatorStubs} from './operator-stubs.mjs';
// MVUI16 lane P shared harness: bounded mounts for the ARG-pmui-3..7
// regression tests. Every history array is capped; no watcher, no timers,
// no growing state across tests beyond the fixed caps below.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { compileSfc, mountComponent, nodes, text, flush, childStub, SidebarIcon, UiButton } from './mvui2-terminal-mount.mjs';
import * as gate from '../src/multislot/multislotInputGate.js';
import * as attach from '../src/multislot/multislotAttach.js';
import * as providers from '../src/multislot/multislotProviders.js';
import * as copy from '../src/multislot/multislotCopy.js';
import * as facade from '../src/terminal/sideTerminalFacade.js';
import * as adapters from '../src/core/hostAdapters.js';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';

export { compileSfc, mountComponent, nodes, text, flush, childStub, SidebarIcon, UiButton };
export * as gate from '../src/multislot/multislotInputGate.js';

export const MVUI16_ID = 'surface-a';
const HISTORY_LIMIT = 16;

/** Bounded history push shared by every double in this file. */
export function boundedPush(list, item, limit = HISTORY_LIMIT) {
  list.push(item);
  if (list.length > limit) list.splice(0, list.length - limit);
  return list.length;
}

export const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

export const hostButton = (f, id, suffix) => nodes(f.root).find((n) => n.props?.id === `mv-multislot-${id}-${suffix}`);

// In-memory source mutants (negative controls); production sources untouched.
let mutantSerial = 0;
export function mutatedCompiler(target, mutate) {
  return async (file, deps) => {
    if (file !== target) return compileSfc(file, deps);
    const original = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const changed = mutate(original);
    assert.notEqual(changed, original, 'negative control must change the source');
    const { descriptor } = parse(changed);
    let code = compileScript(descriptor, { id: 'mvui16negative', inlineTemplate: true }).content;
    deps['capsule-ui-kit/ui'] ??= { UiButton };
    code = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
    code = code.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
      if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(import.meta.resolve('vue')));
      addOperatorStubs(deps);
      assert.ok(spec in deps, `Unmapped mutant dependency: ${spec}`);
      return `const ${bindings.trim()} = globalThis.__mvui16NegativeDeps[${JSON.stringify(spec)}];`;
    });
    globalThis.__mvui16NegativeDeps = deps;
    try {
      return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${mutantSerial++}`)).default;
    } finally { delete globalThis.__mvui16NegativeDeps; }
  };
}

export async function mountHost(initial = {}, terminalFacade = null, compile = compileSfc) {
  const children = {};
  const emitted = [];
  const stub = vue.defineComponent({ setup: () => () => vue.h('div') });
  const Host = await compile('multislot/MultislotHost.vue', {
    '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue': SidebarIcon,
    '@xterm/xterm': { Terminal: class {} },
    '@xterm/addon-fit': { FitAddon: class {} },
    '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js': { createTerminalDocument: () => ({}) },
    '/.kit/capsule-ui-kit/src/multislot/AiMultiSlot.vue': childStub('slot', children),
    '/.kit/capsule-ui-kit/src/multislot/AiSlotControlBar.vue': childStub('bar', children),
    'capsule-ui-kit/TerminalView': { createStreamRegistry: () => ({ createSession() {}, beginAttach() {}, applyRestoreSnapshot() {}, setControlLease() {}, writeOutputChunk() {}, disposeSession() {}, forgetSession() {} }) },
    '../terminal/BrokerLaunchControls.vue': stub,
    '../terminal/sideTerminalFacade.js': terminalFacade ? { ...facade, createSideTerminalFacade: () => terminalFacade } : facade,
    './multislotInputGate.js': gate,
    './multislotAttach.js': attach,
    './multislotProviders.js': providers,
    './multislotCopy.js': copy,
  });
  const f = mountComponent(Host, {
    capsuleId: MVUI16_ID,
    inputMode: 'write',
    measureSlotBox: () => ({ x: 10, y: 20, width: 300, height: 200 }),
    onSubmitIntent: (...args) => boundedPush(emitted, args),
    ...initial,
  });
  await flush();
  return { ...f, children, emitted };
}

export async function mountApp(initial = {}, compile = compileSfc, options = {}) {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  const captured = {};
  const sent = [];
  const echoes = [];
  const local = [];
  const stub = vue.defineComponent({ setup: () => () => vue.h('div') });
  const hostOutcome = await compileSfc('core/HostOutcome.vue', { './hostAdapters.js': adapters });
  const slot = vue.defineComponent({ setup: (_, ctx) => { captured.slot = ctx; return () => vue.h('section'); } });
  const wall = vue.defineComponent({
    setup: (_, ctx) => {
      captured.wall = ctx;
      ctx.expose({
        applyLayoutEcho: (...args) => {
          boundedPush(echoes, args);
          return options.echoResult === undefined ? echoes.length : options.echoResult;
        },
      });
      return () => vue.h('div');
    },
  });
  const App = await compile('App.vue', {
    './creative/CreativeCapsule.vue': stub,
    './core/HostOutcome.vue': hostOutcome,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': stub,
    './terminal/SideTerminalOverlay.vue': stub,
    './multislot/MultislotHost.vue': slot,
    './recording/MvRecordingPanel.vue': stub,
    './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub,
    './activity/ActivityStrip.vue': stub,
    './nested/nested.js': { resolveNestedMode, applyNestedWall },
    'capsule-ui-kit/ui': { UiButton: stub },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    './wall/WallWorkspace.vue': wall,
    './surfaces/SurfaceCanvas.vue': stub,
    './surfaces/tileScheduler.js': { createTileScheduler },
  });
  const row = vue.reactive({ id: MVUI16_ID, surfaceId: MVUI16_ID, title: 'Capsule', generation: 1, visibility: 'unfolded', control: 'human', backendLifecycle: 'active' });
  const feed = { getSnapshot: () => null, getProjection: () => ({ rows: [row] }), subscribe: () => () => {} };
  const f = mountComponent(App, {
    layout: {},
    scope: {},
    storage: { readRaw: async () => null, writeAtomic: async () => {} },
    fixture: { key: 'multislot', ui: {}, capsules: [{ id: MVUI16_ID }] },
    runtime: { projectionView: feed },
    authorityHost: { intent: (body) => { const wait = deferred(); boundedPush(sent, { body, ...wait }); return wait.promise; } },
    onSubmitIntent: (i) => boundedPush(local, i),
    ...initial,
  });
  await flush();
  captured.slot.emit('update:inputMode', 'write');
  await flush();
  return {
    ...f,
    captured,
    sent,
    echoes,
    local,
    setRow: (patch) => { Object.assign(row, patch); },
    close() { f.app.unmount(); globalThis.window = oldWindow; globalThis.document = oldDocument; },
  };
}

/** Commit one placement body through the App mount; resolves the ack with true. */
export async function commitPlacement(f, body) {
  f.captured.slot.emit('submit-intent', body, MVUI16_ID);
  await flush();
  f.sent.at(-1).resolve(true);
  await flush();
}

// Recording panel helpers (bounded fake store).
const PANEL_TOKEN = 'recording:configured';
export const panelToken = () => PANEL_TOKEN;
export const PANEL_DIGEST = 'c'.repeat(64);

let panelSerial = 0;
async function compilePanelSource(source, tag) {
  const url = new URL('../src/recording/MvRecordingPanel.vue', import.meta.url);
  const { descriptor } = parse(source);
  const compiled = compileScript(descriptor, { id: 'mvui16-export', inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue') {
      const helper = new URL('./mvui2-terminal-mount.mjs', import.meta.url).href;
      return `import { SidebarIcon as ${binding.trim()} } from ${JSON.stringify(helper)};`;
    }
    const resolved = specifier === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(specifier, url).href;
    return `import ${binding} from ${JSON.stringify(resolved)};`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}${panelSerial++}`)).default;
}

export async function panelComponent() {
  return compilePanelSource(readFileSync(new URL('../src/recording/MvRecordingPanel.vue', import.meta.url), 'utf8'), 'panel');
}

export async function mutantPanelComponent(mutate) {
  const original = readFileSync(new URL('../src/recording/MvRecordingPanel.vue', import.meta.url), 'utf8');
  const changed = mutate(original);
  assert.notEqual(changed, original, 'negative control must change the source');
  return compilePanelSource(changed, 'mutant');
}

export function mountPanel(Component, input) {
  const props = vue.reactive(input);
  const renderer = vue.createRenderer({
    createElement: (tag) => ({ tag, props: {}, children: [] }),
    createText: (textValue) => ({ text: textValue }),
    createComment: () => ({ text: '' }),
    insert(child, parent, anchor) {
      if (child.parent) this.remove(child);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
    },
    remove(child) { const list = child.parent?.children; if (list) list.splice(list.indexOf(child), 1); },
    setText(node, value) { node.text = value; },
    setElementText(node, value) { node.text = value; node.children = []; },
    patchProp(node, key, _old, value) { node.props[key] = value; },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    setScopeId() {},
  });
  const root = { children: [] };
  const app = renderer.createApp({ render: () => vue.h(Component, props) });
  app.mount(root);
  return { props, root, close: () => app.unmount() };
}

export const panelFlush = async () => { await new Promise((resolve) => setImmediate(resolve)); await vue.nextTick(); };
export const panelById = (mounted, id) => nodes(mounted.root).find((node) => node.props?.id === id);

export function fakeStore(over = {}) {
  const store = {
    bySurface: vue.reactive({ ...(over.bySurface ?? {}) }),
    rows: vue.reactive([...(over.rows ?? [])]),
    calls: [],
    async toggleRecord(surfaceId) { boundedPush(store.calls, ['toggleRecord', surfaceId]); return { ok: true }; },
    async screenshot(surfaceId) { boundedPush(store.calls, ['screenshot', surfaceId]); return { ok: true }; },
    async refresh() { boundedPush(store.calls, ['refresh']); return { ok: true }; },
    async exportCapture(captureId) {
      boundedPush(store.calls, ['exportCapture', captureId]);
      if (typeof over.exportCapture === 'function') return over.exportCapture(captureId);
      return { ok: true, export: { id: captureId, bytes: 2048, sha256: PANEL_DIGEST } };
    },
    dispose() { boundedPush(store.calls, ['dispose']); },
  };
  return store;
}

export function sealedRow(id = 'rec-1', surface = 'cap-01') {
  return { id, kind: 'recording', surface_id: surface, phase: 'sealed', frames: 12, duration_ms: 61000, sealed: true, created_ms: 1 };
}

// Wall controller module loader (optional in-memory mutant).
let wallSerial = 0;
export async function wallModule(mutate = null) {
  const raw = readFileSync(new URL('../src/wall/WallWorkspace.vue', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const source = mutate ? mutate(raw) : raw;
  if (mutate) assert.notEqual(source, raw, 'negative control must change the source');
  const code = source.replace("from 'vue'", `from ${JSON.stringify(import.meta.resolve('vue'))}`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui16wall${wallSerial++}`);
}

/** Ready wall controller with fakes; float calls capture (panelId, bounds). */
export function readyWallWithPanel(wall, capsuleId, rows = null) {
  const floatCalls = [];
  const dockCalls = [];
  const panel = { id: `panel-${capsuleId}`, api: { moveTo() {}, setActive() {}, close() {} } };
  const api = { getPanel: (id) => (id === panel.id ? panel : undefined), addPanel: () => panel };
  const windows = {
    state: () => ({ hidden: false }),
    show() {},
    hide() {},
    float(panelId, bounds) { boundedPush(floatCalls, [panelId, bounds], 8); },
    dock(panelId) { boundedPush(dockCalls, panelId, 8); },
  };
  const projectionRows = rows ?? [{ id: capsuleId, surfaceId: capsuleId, backendLifecycle: 'active' }];
  const controller = wall.createWallWorkspaceController({ projectionView: { getProjection: () => ({ rows: projectionRows }) } });
  assert.equal(controller.handleReady({ api, windows }).ok, true);
  return { controller, api, windows, floatCalls, dockCalls };
}
