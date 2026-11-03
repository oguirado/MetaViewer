import * as p18cDesktopModel from '../electron/desktopLayout.js';
import { installRoleMenuInput, openRoleMenuInput } from './role-menu-input-harness.mjs';
// UX-CHIP: verify the wall tile no longer renders the covering "View only —
// press Control to interact" overlay chip, while keeping take/release control
// and pending/unavailable/interactive states reachable in the non-overlapping
// .mv-input-indicator header bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createAuthorityRuntime } from '../src/core/hostAdapters.js';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { tick } from './frame-wait.mjs';

const APP_SOURCE = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
const CANVAS_SOURCE = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');
const VUE_URL = import.meta.resolve('vue');
let serial = 0;

function rewriteImports(code, resolve) {
  return code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
      if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(VUE_URL));
      return resolve(bindings.trim(), spec);
    });
}

async function importCode(code, tag) {
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}`)).default;
}

const CANVAS_DEPS = {
  './tileScheduler.js': import.meta.resolve('../src/surfaces/tileScheduler.js'),
  '../input/keyMap.js': import.meta.resolve('../src/input/keyMap.js'),
  '../input/frameMap.js': import.meta.resolve('../src/input/frameMap.js'),
};
const SurfaceCanvas = await importCode(rewriteImports(
  compileScript(parse(CANVAS_SOURCE).descriptor, { id: 'uxchip-canvas', inlineTemplate: true }).content,
  (bindings, spec) => {
    assert.ok(Object.hasOwn(CANVAS_DEPS, spec), `unmapped canvas dependency ${spec}`);
    return `const ${bindings} = await import(${JSON.stringify(CANVAS_DEPS[spec])});`;
  }), 'uxchip-canvas');

async function loadApp(source) {
  const stub = vue.defineComponent({
    setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap((slot) => slot?.() ?? [])),
  });
  const buttonStub = vue.defineComponent({
    inheritAttrs: false,
    props: ['label'],
    setup: (props, { attrs }) => () => vue.h('button', { ...attrs, label: props.label }),
  });
  const wallStub = vue.defineComponent({
    props: ['projectionView'],
    setup: (props, ctx) => {
      const revision = vue.shallowRef(0);
      const stop = props.projectionView.subscribe(() => { revision.value += 1; });
      vue.onBeforeUnmount(() => { if (typeof stop === 'function') stop(); });
      const rowsOf = () => props.projectionView.getProjection()?.rows ?? [];
      ctx.expose({ revealSurface: () => ({ ok: true }), applyLayoutEcho: () => ({ ok: true }) });
      return () => {
        void revision.value;
        return vue.h('div', { class: 'mv-tile-capture-host' }, rowsOf().flatMap((row) => ctx.slots.surface?.({ surface: row, capsuleId: row.id }) ?? []));
      };
    },
  });
  const deps = {
    './demo/DemoDialog.vue': stub,
    './identities/IdentitiesDialog.vue': stub,
    './handoff/HandoffNotice.vue': stub,
    './creative/CreativeCapsule.vue': stub,
    './core/HostOutcome.vue': stub,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': stub,
    './terminal/SideTerminalOverlay.vue': stub,
    './multislot/MultislotHost.vue': stub,
    './recording/MvRecordingPanel.vue': stub,
    './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub,
    './activity/ActivityStrip.vue': stub,
    './nested/nested.js': { resolveNestedMode, applyNestedWall },
    'capsule-ui-kit/ui': { UiButton: buttonStub },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    './wall/DesktopWorkspace.vue': wallStub,
    '../electron/desktopLayout.js': p18cDesktopModel,
    './wall/WallWorkspace.vue': wallStub,
    './surfaces/SurfaceCanvas.vue': SurfaceCanvas,
    './surfaces/tileScheduler.js': { createTileScheduler },
  };
  const key = `__uxchip${++serial}`;
  globalThis[key] = deps;
  const { descriptor } = parse(source);
  const compiled = compileScript(descriptor, { id: `uxchip-app-${serial}`, inlineTemplate: true });
  const code = rewriteImports(compiled.content, (bindings, spec) => {
    assert.ok(Object.hasOwn(deps, spec), `unmapped App dependency ${spec}`);
    return `const ${bindings} = globalThis[${JSON.stringify(key)}][${JSON.stringify(spec)}];`;
  });
  return importCode(code, `uxchip-app-${serial}`);
}

function createRenderer(activity = { calls: 0 }) {
  return vue.createRenderer({
    createElement: (tag) => ({ tag, props: {}, children: [], parent: null, style:{display:''}, getBoundingClientRect:()=>({x:0,y:0,width:320,height:200}),getClientRects:()=>[1] }),
    createText: (text) => ({ text, parent: null }),
    createComment: (comment) => ({ comment, parent: null }),
    insert(child, parent, anchor = null) {
      child.parent = parent;
      const at = anchor ? parent.children.indexOf(anchor) : -1;
      if (at >= 0) parent.children.splice(at, 0, child);
      else parent.children.push(child);
    },
    remove(child) {
      const items = child.parent?.children;
      if (items) { const at = items.indexOf(child); if (at >= 0) items.splice(at, 1); }
      child.parent = null;
    },
    setText(node, text) { node.text = text; },
    setElementText(node, text) { node.children = []; node.text = text; },
    parentNode: (node) => node.parent ?? null,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp(node, key, _old, value) { activity.calls++; node.props[key] = value; },
    querySelector: () => null,
    setScopeId() {},
  });
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, out);
  return out;
}

const anchored = (root, value) => findAll(root, (node) => node.props?.['data-semantic-anchor'] === value)[0] ?? null;

function checkIndicatorContract(source) {
  if (source.includes('View only — press Control to interact')) {
    return { ok: false, reason: 'legacy overlay label present' };
  }
  if (source.includes('class="mv-input-chip"')) {
    return { ok: false, reason: 'legacy mv-input-chip overlay class present' };
  }
  const styles = parse(source).descriptor.styles.map((s) => s.content).join('\n');
  const indicatorRule = styles.match(/\.mv-input-indicator\s*\{([^}]*)\}/);
  if (!indicatorRule) {
    return { ok: false, reason: 'missing .mv-input-indicator style rule' };
  }
  if (/position\s*:\s*(absolute|fixed)/i.test(indicatorRule[1])) {
    return { ok: false, reason: '.mv-input-indicator uses overlay positioning' };
  }
  return { ok: true, reason: '' };
}

function makeSurface(surfaceId, control) {
  return {
    schema: 'surface/v0.2',
    surface_id: surfaceId,
    kind: 'browser',
    display: ':99',
    geometry: { w: 320, h: 200 },
    state: 'active',
    visibility: 'unfolded',
    control,
    profile_id: 'Alpha Browser',
  };
}

function frameNotice(surface) {
  return {
    frame_ref: {
      schema: 'frame_ref/v0.2',
      surface_id: surface.surface_id,
      generation: 1,
      width: 320,
      height: 200,
      format: 'rgb24',
      sha256: 'a'.repeat(64),
      tick: 1,
      ts_ns: 1000,
      capture_us: 0,
    },
    surface,
  };
}

async function mountFixture(t, { source = APP_SOURCE, inputAvailable = true, holdGrant = false } = {}) {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: undefined };
  const listeners = new Map();
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
  };
  const frameListeners = new Set();
  const framesPort = {
    subscribeFrames(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
  };
  const publish = (surface) => {
    for (const listener of [...frameListeners]) listener(frameNotice(surface));
  };
  let surface = makeSurface('cap-alpha', 'agent');
  const runtime = createAuthorityRuntime(framesPort);
  publish(surface);

  const submitted = [];
  let heldGrant = null;
  const authorityHost = {
    async intent(intent) {
      submitted.push(intent);
      const apply = () => {
        if (intent.op === 'take_control') surface = makeSurface('cap-alpha', 'human');
        if (intent.op === 'release_control') surface = makeSurface('cap-alpha', 'agent');
        publish(surface);
      };
      if (holdGrant && intent.op === 'take_control') {
        heldGrant = apply;
      } else {
        apply();
      }
      return { code: 'INTENT_ACKNOWLEDGED', message: 'Request sent.', tone: 'success' };
    },
  };
  const App = await loadApp(source);
  const root = { children: [] };
  const activity = { calls: 0 };
  const app = createRenderer(activity).createApp(App, {
    layout: {}, scope: {}, storage: { readRaw: async () => null, writeAtomic: async () => {} },
    nestedHost: { getNestedDepth: () => 0, getSelfCapsuleId: () => null },
    authorityHost, runtime,
  });
  app.provide('inputPort', {
    available: inputAvailable,
    send: () => ({ accepted: true }),
    onResult: () => () => {},
    resetSurface: () => {},
    dispose: () => {},
  });
  installRoleMenuInput(t, app);
  app.mount(root);
  t.after(() => {
    try { app.unmount(); } catch { /* ignore unmount errors */ }
    runtime.dispose();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  });
  await tick();
  await openRoleMenuInput(root);
  return {
    root,
    submitted,
    activity,
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    grantHeld() { const fn = heldGrant; heldGrant = null; fn?.(); },
  };
}

test('UX-CHIP: static contract removes the view-only overlay and styles .mv-input-indicator in flow', () => {
  assert.deepEqual(checkIndicatorContract(APP_SOURCE), { ok: true, reason: '' });
});

test('UX-CHIP: view, pending, interactive, and release states render in .mv-input-indicator before SurfaceCanvas', async (t) => {
  const { root, submitted, grantHeld } = await mountFixture(t, { holdGrant: true });
  const indicator = anchored(root, 'capsule/cap-alpha/input');
  assert.ok(indicator, 'indicator is present');
  assert.equal(indicator.props.class, 'mv-input-indicator');
  assert.equal(indicator.props['data-input-state'], 'view');
  const host = indicator.parent;
  const surfaceEl = findAll(host, (node) => node.props?.class === 'mv-surface')[0];
  assert.ok(surfaceEl, 'SurfaceCanvas root is rendered');
  assert.ok(host.children.indexOf(indicator) < host.children.indexOf(surfaceEl), 'indicator precedes SurfaceCanvas in flow');

  const take = anchored(root, 'capsule/cap-alpha/control/emergency');
  assert.ok(take, 'take control button is reachable');
  assert.equal(take.props.disabled, false, 'available emergency action is enabled');
  assert.equal(take.text, 'Take control (emergency)');
  assert.equal(take.props['aria-label'], 'Take control of Alpha Browser (emergency)');

  take.props.onClick();
  await tick();
  assert.equal(indicator.props['data-input-state'], 'pending');
  const pendingStatus = findAll(indicator, (node) => node.props?.role === 'status');
  assert.equal(pendingStatus.length, 1);
  assert.equal(pendingStatus[0].text, 'Taking control…');

  grantHeld();
  await tick();
  assert.equal(indicator.props['data-input-state'], 'interactive');
  const interactiveStatus = findAll(indicator, (node) => node.props?.role === 'status');
  assert.equal(interactiveStatus.length, 1);
  assert.equal(interactiveStatus[0].text, 'Interactive');
  const release = anchored(root, 'capsule/cap-alpha/input/release');
  assert.ok(release, 'release control button is reachable');
  assert.equal(release.props.label, 'Release');
  assert.equal(release.props['aria-label'], 'Release control of Alpha Browser');

  release.props.onClick();
  await tick();
  assert.equal(indicator.props['data-input-state'], 'view');
  assert.deepEqual(submitted.map((item) => item.op), [
    'take_control',
    'release_control',
  ]);
});

test('UX-CHIP: unavailable state renders compact role=status feedback without an overlay', async (t) => {
  const { root } = await mountFixture(t, { inputAvailable: false });
  const indicator = anchored(root, 'capsule/cap-alpha/input');
  assert.ok(indicator);
  assert.equal(indicator.props.class, 'mv-input-indicator');
  assert.equal(indicator.props['data-input-state'], 'unavailable');
  assert.equal(anchored(root, 'capsule/cap-alpha/control/emergency')?.props.disabled, true, 'unavailable emergency action cannot be invoked');
  const status = findAll(indicator, (node) => node.props?.role === 'status');
  assert.equal(status.length, 1);
  assert.equal(status[0].text, 'Input unavailable in this window');
});

test('UX-CHIP mutant: removing the take-control action fails the reachability oracle; re-adding the overlay fails the contract', async (t) => {
  const takeLine = ':can-take-control="wallInputState(surface) === \'view\'"';
  assert.equal(APP_SOURCE.split(takeLine).length, 2, 'unique take-control button line');
  const noTakeMutant = APP_SOURCE.replace(takeLine, ':can-take-control="false"');
  const { root } = await mountFixture(t, { source: noTakeMutant });
  assert.equal(anchored(root, 'capsule/cap-alpha/control/emergency').props.disabled, true, 'mutant has no available emergency action');

  const overlayMutant = APP_SOURCE.replace('class="mv-input-indicator"', 'class="mv-input-chip"');
  assert.equal(checkIndicatorContract(overlayMutant).ok, false, 'overlay class mutant is rejected');
});

// Do not pass renderer nodes to assertion diffs: their parent/VNode links are
// cyclic and Node's diagnostic expansion can consume gigabytes on a mismatch.
test('P18B mounted App stays quiescent across menu toggles and idle ticks', async t => {
  const { root, activity, listenerCount } = await mountFixture(t);
  const initialListeners = listenerCount();
  t.after(() => assert.equal(listenerCount(), 0, 'document listeners are released on unmount'));
  const more = findAll(root, n => n.props?.id === 'shell-terminal')[0];
  assert.ok(!!more, 'Terminal dock is reachable');
  for (let i = 0; i < 20; i++) { await more.props.onClick(); await tick(); }
  await new Promise(resolve => setTimeout(resolve, 250));
  const settledCalls = activity.calls;
  const settledNodes = findAll(root, () => true).length;
  for (let i = 0; i < 100; i++) await tick();
  assert.equal(listenerCount(), initialListeners, 'menu transitions never accumulate document listeners');
  assert.equal(activity.calls, settledCalls, 'no self-sustaining render/prop feedback at idle');
  assert.equal(findAll(root, () => true).length, settledNodes, 'no idle listener-driven tree growth');
  assert.ok(settledCalls < 2000, 'menu transitions have bounded render work');
});
