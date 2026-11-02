import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { createAuthorityAdapter } from '../src/core/hostAdapters.js';
import { normalizeActivityEntry } from '../src/activity/activityModel.js';
import {createDesktopState, desktopRows} from '../electron/desktopLayout.js';

const require = createRequire(import.meta.url);
const VUE_URL = pathToFileURL(require.resolve('vue')).href;
let serial = 0;

async function loadRoleSurfaceModule() {
  const source = readFileSync(new URL('../src/surfaces/RoleSurface.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const compiled = compileScript(descriptor, { id: `role-surface-r3-${++serial}`, inlineTemplate: true }).content;
  const code = compiled.replace(/from ["']vue["']/g, `from ${JSON.stringify(VUE_URL)}`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#rs-${serial}`);
}

async function loadWallModule() {
  const source = readFileSync(new URL('../src/wall/WallWorkspace.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const code = descriptor.script.content.replace(/from ['"]vue['"]/g, `from ${JSON.stringify(VUE_URL)}`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#wall-${++serial}`);
}

async function loadApp(captured) {
  const stub = vue.defineComponent({
    setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap(slot => slot?.() ?? [])),
  });
  const strip = vue.defineComponent({
    props: ['entries'],
    setup: props => {
      captured.stripEntries = () => props.entries;
      return () => vue.h('section', { id: 'test-activity' });
    },
  });
  const outcome = vue.defineComponent({
    props: ['row'],
    setup: props => {
      captured.outcome = () => props.row;
      return () => vue.h('p', { id: 'test-outcome' });
    },
  });
  const uiButton = vue.defineComponent({
    props: ['id', 'label', 'disabled'],
    setup: (props, ctx) => () => vue.h('button', { id: props.id, label: props.label, disabled: props.disabled, ...ctx.attrs }),
  });
  const identities = vue.defineComponent({
    props: ['open'],
    setup: (props, ctx) => {
      captured.identities = { props, emit: ctx.emit };
      return () => vue.h('div', { id: 'test-identities' });
    },
  });
  const wall = vue.defineComponent({
    setup: (_, ctx) => {
      captured.wall = ctx;
      captured.follows = []; captured.views = [];
      ctx.expose({
        selectView: view => captured.views.push(view),
        followSurface: (id,mode) => captured.follows.push({id,mode}),
        applyLayoutEcho: () => undefined,
        revealSurface: (...args) => {
          captured.reveals.push(args);
          return captured.revealResult(...args);
        },
        applyPresentationIntent: intent => {
          captured.presentations.push(intent);
          return { ok: true, value: { panelId: `panel-${intent.capsuleId}`, type: intent.type } };
        },
        setPreset: () => ({ ok: true }),
      });
      return () => vue.h('div', { id: 'test-wall' }, ctx.slots.surface ? captured.rows().map(r => ctx.slots.surface({ surface: r, capsuleId: r.id })) : []);
    },
  });
  const roleSurface = vue.defineComponent({
    props: ['surfaceId', 'control'],
    setup: (props, ctx) => {
      captured.roleSurfaces.set(props.surfaceId, { props, emit: ctx.emit });
      return () => vue.h('div', { class: 'stub-role-surface', surfaceId: props.surfaceId }, ctx.slots.default?.());
    },
  });
  globalThis.__p18r3deps = {
    './demo/DemoDialog.vue': stub,
    './identities/IdentitiesDialog.vue': identities,
    './handoff/HandoffNotice.vue': stub,
    './creative/CreativeCapsule.vue': stub,
    './core/HostOutcome.vue': outcome,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': stub,
    './terminal/SideTerminalOverlay.vue': stub,
    './multislot/MultislotHost.vue': stub,
    './recording/MvRecordingPanel.vue': stub,
    './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub,
    './activity/ActivityStrip.vue': strip,
    './nested/nested.js': { resolveNestedMode, applyNestedWall },
    'capsule-ui-kit/ui': { UiButton: uiButton },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    './wall/WallWorkspace.vue': wall,
    './wall/DesktopWorkspace.vue': wall,
    '../electron/desktopLayout.js': {createDesktopState,desktopRows},
    './surfaces/SurfaceCanvas.vue': stub,
    './surfaces/tileScheduler.js': { createTileScheduler },
    RoleSurface: roleSurface,
  };
  const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const compiled = compileScript(descriptor, { id: `p18r3-app-${++serial}`, inlineTemplate: true });
  const code = compiled.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(VUE_URL));
    return `const ${binding.trim()} = globalThis.__p18r3deps[${JSON.stringify(specifier)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#app-${serial}`)).default;
}

function createTreeRenderer() {
  return vue.createRenderer({
    createElement: tag => ({ tag, props: {}, children: [], parent: null }),
    createText: text => ({ tag: '#text', text, children: [], props: {} }),
    createComment: text => ({ tag: '#comment', text, children: [], props: {} }),
    insert(child, parent, anchor) {
      if (child.parent) this.remove(child);
      child.parent = parent;
      const i = parent.children.indexOf(anchor);
      parent.children.splice(i < 0 ? parent.children.length : i, 0, child);
    },
    remove(child) {
      const items = child.parent?.children;
      if (items) items.splice(items.indexOf(child), 1);
      child.parent = null;
    },
    setText(node, text) { node.text = text; },
    setElementText(node, text) { node.text = text; node.children = []; },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp(node, key, _old, value) {
      if (value === undefined || value === null) delete node.props[key];
      else node.props[key] = value;
    },
    querySelector: () => null,
    setScopeId() {},
  });
}

const findAll = (node, pred) => [
  ...(pred(node) ? [node] : []),
  ...(node.children || []).flatMap(child => findAll(child, pred)),
];
const tick = async () => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await vue.nextTick();
};

test('P18-R3 item 1 unit: clipRoleBounds intersects tile rect, scroll ancestors and wall viewport', async () => {
  const { clipRoleBounds } = await loadRoleSurfaceModule();
  const windowViewport = { width: 1280, height: 720 };
  const wallViewport = { x: 48, y: 84, width: 1232, height: 476 };
  const scrollAncestor = { x: 48, y: 84, width: 1232, height: 476 };

  // Fully visible tile inside the wall viewport.
  const full = clipRoleBounds({ x: 60, y: 100, width: 580, height: 220 }, [scrollAncestor], wallViewport, windowViewport);
  assert.equal(full.visible, true);
  assert.deepEqual(full.bounds, { x: 60, y: 100, width: 580, height: 220 });

  // Human tile scrolled halfway below the wall viewport (over Activity strip and StatusBar at y >= 560).
  const halfScrolled = clipRoleBounds({ x: 60, y: 420, width: 580, height: 260 }, [scrollAncestor], wallViewport, windowViewport);
  assert.equal(halfScrolled.visible, true);
  assert.deepEqual(halfScrolled.bounds, { x: 60, y: 420, width: 580, height: 140 });
  assert.equal(halfScrolled.bounds.y + halfScrolled.bounds.height, 560, 'never paints below wall viewport (560)');

  // Tile scrolled completely below the wall viewport: empty intersection hides the view.
  const scrolledOut = clipRoleBounds({ x: 60, y: 580, width: 580, height: 240 }, [scrollAncestor], wallViewport, windowViewport);
  assert.equal(scrolledOut.visible, false);
  assert.equal(scrolledOut.bounds.height, 0);
});

test('P18-R3 item 1 DOM: scroll events on the wall container clip, hide without closing, and restore on the same connection', async () => {
  const { default: RoleSurface } = await loadRoleSurfaceModule();
  const oldApi = globalThis.metaviewerRoles;
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const oldWidth = globalThis.innerWidth;
  const oldHeight = globalThis.innerHeight;
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 720;

  let tileBox = { x: 48, y: 400, width: 1200, height: 260 };
  const wallBox = { x: 48, y: 84, width: 1232, height: 476 };
  const scrollListeners = new Set();
  const bodyAttrs = new Map();
  const wallEl = {
    id: 'shell-wall',
    tag: 'main',
    props: { id: 'shell-wall' },
    children: [],
    parent: null,
    getBoundingClientRect: () => wallBox,
    addEventListener(type, fn) { if (type === 'scroll') scrollListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'scroll') scrollListeners.delete(fn); },
  };
  globalThis.window = {
    addEventListener(type, fn) { if (type === 'scroll') scrollListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'scroll') scrollListeners.delete(fn); },
  };
  globalThis.document = {
    body: {
      dataset: {},
      hasAttribute: name => bodyAttrs.has(name),
      getAttribute: name => bodyAttrs.get(name) ?? null,
      setAttribute: (name, val) => bodyAttrs.set(name, String(val)),
      removeAttribute: name => bodyAttrs.delete(name),
    },
    documentElement: { dataset: {} },
    getElementById: id => (id === 'shell-wall' ? wallEl : null),
    addEventListener(type, fn) { if (type === 'scroll') scrollListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'scroll') scrollListeners.delete(fn); },
  };

  const mounts = [], resizes = [], visibilities = [];
  let closes = 0;
  globalThis.metaviewerRoles = {
    status: async () => ({ role: 'human', view: { state: 'ready' } }),
    mount: async (id, bounds) => { mounts.push({ id, bounds }); return { ok: true }; },
    resize: async (id, bounds) => { resizes.push({ id, bounds }); return { ok: true }; },
    visibility: async (id, visible) => { visibilities.push({ id, visible }); return { ok: true }; },
    close: async () => { closes++; return { ok: true }; },
  };

  const makeNode = tag => ({
    tag,
    children: [],
    style: { display: '' },
    props: {},
    parent: null,
    getBoundingClientRect: () => tileBox,
    getClientRects: () => [1],
  });
  const renderer = vue.createRenderer({
    createElement: makeNode,
    createText: text => ({ ...makeNode('#text'), text }),
    createComment: text => ({ ...makeNode('#comment'), text }),
    setText(n, text) { n.text = text; },
    setComment(n, text) { n.text = text; },
    setElementText(n, text) { n.text = text; n.children = []; },
    patchProp(n, key, _prev, value) { n.props[key] = value; },
    insert(n, parent, anchor) {
      n.parent = parent;
      const at = parent.children.indexOf(anchor);
      if (at < 0) parent.children.push(n);
      else parent.children.splice(at, 0, n);
    },
    remove(n) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); },
    parentNode: n => n.parent,
    nextSibling: () => null,
  });

  const app = renderer.createApp({ render: () => vue.h(RoleSurface, { surfaceId: 'surface-human-2', control: 'human' }) });
  try {
    app.mount(wallEl);
    await new Promise(r => setTimeout(r, 25));
    await vue.nextTick();

    // Initial mount is clipped to wallViewport bottom (84 + 476 = 560), so height is 160 instead of 260.
    assert.equal(mounts.length, 1);
    assert.deepEqual(mounts[0], { id: 'surface-human-2', bounds: { x: 48, y: 400, width: 1200, height: 160 } });
    assert.ok(scrollListeners.size > 0, 'scroll listener is registered');

    // Scroll further down so only 60px of the tile remains inside the wall viewport.
    tileBox = { x: 48, y: 500, width: 1200, height: 260 };
    for (const onScroll of scrollListeners) onScroll();
    await new Promise(r => setTimeout(r, 15));
    assert.equal(resizes.length, 1, 'scroll event updates bounds immediately without waiting for poll timer');
    assert.deepEqual(resizes[0], { id: 'surface-human-2', bounds: { x: 48, y: 500, width: 1200, height: 60 } });

    // Scroll completely out of the wall viewport (y = 570 >= 560).
    tileBox = { x: 48, y: 570, width: 1200, height: 260 };
    for (const onScroll of scrollListeners) onScroll();
    await new Promise(r => setTimeout(r, 15));
    assert.deepEqual(visibilities, [{ id: 'surface-human-2', visible: false }]);
    assert.equal(closes, 0, 'hiding when scrolled out of view never closes the session or bridge');
    assert.equal(mounts.length, 1);

    // Scroll back into the wall viewport: restores visibility on the same mount/bridge connection.
    tileBox = { x: 48, y: 200, width: 1200, height: 260 };
    for (const onScroll of scrollListeners) onScroll();
    await new Promise(r => setTimeout(r, 15));
    assert.deepEqual(visibilities, [
      { id: 'surface-human-2', visible: false },
      { id: 'surface-human-2', visible: true },
    ]);
    assert.equal(mounts.length, 1, 'restored on the same bridge mount');
    assert.equal(closes, 0);
    assert.deepEqual(resizes.at(-1), { id: 'surface-human-2', bounds: { x: 48, y: 200, width: 1200, height: 260 } });
  } finally {
    app.unmount();
    globalThis.metaviewerRoles = oldApi;
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
    globalThis.innerWidth = oldWidth;
    globalThis.innerHeight = oldHeight;
  }
});

test('P18-R3 item 2: stopped capsule tile leaves the wall and reopen of the same identity reuses its old slot', async () => {
  const wall = await loadWallModule();
  const rows = [
    { id: 'surface-1', surfaceId: 'surface-1', profile_id: 'mv-live-1', title: 'mv-live-1', backendLifecycle: 'active', control: 'agent', visibility: 'unfolded' },
    { id: 'surface-2', surfaceId: 'surface-2', profile_id: 'mv-live-2', title: 'mv-live-2', backendLifecycle: 'active', control: 'human', visibility: 'unfolded' },
  ];
  const panels = new Map();
  const addCalls = [];
  const closedPanels = [];
  const api = {
    width: 1200,
    height: 500,
    groups: [],
    getPanel: id => panels.get(id),
    addPanel(options) {
      addCalls.push(options);
      const group = { id: `group-${options.id}`, size: 1, panels: [], api: { setSize() {} } };
      const panel = {
        id: options.id,
        params: options.params,
        group,
        api: {
          close() {
            closedPanels.push(options.id);
            panels.delete(options.id);
            group.size = 0;
          },
          setActive() {},
          moveTo() {},
        },
      };
      group.panels.push(panel);
      this.groups.push(group);
      panels.set(options.id, panel);
      return panel;
    },
    removeGroup(group) {
      const idx = this.groups.indexOf(group);
      if (idx >= 0) this.groups.splice(idx, 1);
    },
  };
  const windows = {
    state: () => ({ hidden: false, floating: false, maximized: false }),
    show() {},
    hide() {},
    float() {},
    dock() {},
  };
  const controller = wall.createWallWorkspaceController({ projectionView: { getProjection: () => ({ rows }) } });
  controller.handleReady({ api, windows });

  // Open mv-live-1 (left) and mv-live-2 (right).
  assert.equal(controller.revealSurface('surface-1', 'split').ok, true);
  assert.equal(controller.revealSurface('surface-2', 'split').ok, true);
  assert.deepEqual([...panels.keys()], ['panel-surface-1', 'panel-surface-2']);

  // Stop mv-live-1: its lifecycle becomes destroyed and its tile leaves the wall.
  rows[0].backendLifecycle = 'destroyed';
  assert.equal(controller.applyPresentationIntent({ type: 'close', capsuleId: 'surface-1' }).ok, true);
  assert.deepEqual(closedPanels, ['panel-surface-1']);
  assert.deepEqual([...panels.keys()], ['panel-surface-2'], 'stopped tile is gone from the wall');

  // Reopen mv-live-1 under a new surfaceId (surface-3): it takes its old left slot relative to surface-2.
  rows.push({ id: 'surface-3', surfaceId: 'surface-3', profile_id: 'mv-live-1', title: 'mv-live-1', backendLifecycle: 'active', control: 'agent', visibility: 'unfolded' });
  assert.equal(controller.revealSurface('surface-3', 'split').ok, true);
  assert.deepEqual([...panels.keys()], ['panel-surface-2', 'panel-surface-3'], 'only two live tiles exist, no lingering Destroyed tile');
  const reopenedOptions = addCalls.at(-1);
  assert.equal(reopenedOptions.id, 'panel-surface-3');
  assert.deepEqual(reopenedOptions.position, { referencePanel: 'panel-surface-2', direction: 'left' }, 'reopened identity takes its old left slot');
});

test('P18-R3 items 3 and 4: handled refusals create no error rows, unexpected failures name their real code, and mode-switch offer is a modal hiding native views', async () => {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const oldRoles = globalThis.metaviewerRoles;

  const bodyAttrs = new Map();
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = {
    documentElement: { dataset: {} },
    body: {
      dataset: {},
      hasAttribute: name => bodyAttrs.has(name),
      getAttribute: name => bodyAttrs.get(name) ?? null,
      setAttribute(name, val) { bodyAttrs.set(name, String(val)); this.dataset.mvModal = String(val); },
      removeAttribute(name) { bodyAttrs.delete(name); delete this.dataset.mvModal; },
    },
    getElementById: () => null,
  };

  const rows = vue.reactive([
    { id: 'surface-1', surfaceId: 'surface-1', title: 'mv-live-1', profile_id: 'mv-live-1', generation: 1, visibility: 'unfolded', control: 'agent', backendLifecycle: 'active' },
  ]);
  const captured = {
    reveals: [],
    presentations: [],
    roleSurfaces: new Map(),
    rows: () => rows,
    revealResult: () => ({ ok: true }),
    stripEntries: () => [],
    outcome: () => null,
  };

  let nextOpenReply = {
    ok: false,
    code: 'PROFILE_ALREADY_BOUND',
    surfaceId: 'surface-1',
    currentMode: 'agent',
    requestedMode: 'human',
  };
  let nextSwitchReply = { ok: true, surfaceId: 'surface-2', role: 'human' };
  globalThis.metaviewerRoles = {
    open: async () => nextOpenReply,
    switchMode: async () => nextSwitchReply,
    surfaces: async () => [],
    status: async () => ({ role: 'agent', control: 'agent' }),
  };

  const App = await loadApp(captured);
  const appRoot = { tag: 'root', props: {}, children: [] };
  const app = createTreeRenderer().createApp(App, {
    authorityHost: createAuthorityAdapter({
      createSurface: async () => ({ ok: true }),
      intent: async () => true,
      propose: async () => ({ schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 1, decision: 'admitted' }),
    }),
    runtime: {
      projectionView: {
        getSnapshot: () => ({ envelope: null }),
        getProjection: () => ({ rows }),
        subscribe: () => () => {},
      },
    },
    layout: {},
    scope: {},
    storage: { readRaw: async () => null, writeAtomic: async () => {} },
  });
  app. component('RoleSurface', globalThis.__p18r3deps.RoleSurface);

  try {
    app.mount(appRoot);
    await tick();

    // The desktop host stays mounted while the admitted wall becomes empty.
    // Its readiness witness must remain valid when the next capsule arrives.
    captured.wall.emit('ready');
    const initialRows = rows.splice(0);
    await tick();
    rows.push(...initialRows);
    await tick();
    assert.equal(findAll(appRoot,n=>n.props?.['data-wall-settled']==='true').length,1,
      'an empty-to-populated wall keeps its mounted desktop readiness');

    // 1. Open as human on mv-live-1 already open in agent mode -> shows modal confirmation offer, zero error rows.
    captured.identities.emit('open-identity', { profileId: 'mv-live-1', role: 'human' });
    await tick();
    await tick();

    assert.equal(captured.views.at(-1),'human','identity opening selects the requested global view');
    assert.deepEqual(captured.stripEntries(), [], 'mode-switch confirmation offer must not create an Activity error row');
    assert.equal(captured.outcome(), null, 'mode-switch confirmation offer must not show a refusal toast');

    // Item 4: modal dialog is rendered with app dialog classes and sets body[data-mv-modal].
    const dialog = findAll(appRoot, n => n.props?.role === 'dialog' && n.props?.['aria-label'] === 'Switch capsule mode')[0];
    assert.ok(dialog, 'mode-switch confirmation modal dialog is rendered');
    assert.match(dialog.props.class, /\bmv-mode-confirm\b/);
    assert.match(dialog.props.class, /\bs1-confirm-backdrop\b/);
    assert.equal(globalThis.document.body.hasAttribute('data-mv-modal'), true, 'body[data-mv-modal] is set while modal offer is open');

    // Verify RoleSurface hides native view while body[data-mv-modal] is active and restores on Cancel.
    const { isModalActive } = await loadRoleSurfaceModule();
    assert.equal(isModalActive(globalThis.document), true);

    const cancelBtn = findAll(dialog, n => n.props?.id === 'mode-switch-cancel')[0];
    assert.ok(cancelBtn, 'Cancel button exists in modal');
    cancelBtn.props.onClick();
    await tick();
    assert.equal(globalThis.document.body.hasAttribute('data-mv-modal'), false, 'body[data-mv-modal] is cleared on Cancel');
    assert.equal(isModalActive(globalThis.document), false);

    // Re-trigger offer and click Confirm: switchMode succeeds and reveals surface-2 with zero error rows.
    captured.identities.emit('open-identity', { profileId: 'mv-live-1', role: 'human' });
    await tick();
    await tick();
    const confirmBtn = findAll(appRoot, n => n.props?.id === 'mode-switch-confirm')[0];
    assert.ok(confirmBtn, 'Confirm button exists in modal');
    rows.push({ id: 'surface-2', surfaceId: 'surface-2', title: 'mv-live-1', profile_id: 'mv-live-1', generation: 1, visibility: 'unfolded', control: 'human', backendLifecycle: 'active' });
    confirmBtn.props.onClick();
    await tick();
    await tick();
    assert.deepEqual(captured.stripEntries(), [], 'successful mode switch must not create an error row');
    assert.equal(captured.outcome(), null);

    // 2. Same-mode open returning reused surface or PROFILE_ALREADY_BOUND with same mode reveals without error row.
    assert.deepEqual(captured.follows.at(-1),{id:'surface-2',mode:'human'},'mode switch follows the replacement into its matching view');
    nextOpenReply = { ok: true, reused: true, surfaceId: 'surface-2', role: 'human' };
    captured.identities.emit('open-identity', { profileId: 'mv-live-1', role: 'human' });
    await tick();
    await tick();
    assert.deepEqual(captured.stripEntries(), [], 'same-mode open reveal must not create an error row');

    nextOpenReply = { ok: false, code: 'PROFILE_ALREADY_BOUND', surfaceId: 'surface-2', currentMode: 'human', requestedMode: 'human' };
    captured.identities.emit('open-identity', { profileId: 'mv-live-1', role: 'human' });
    await tick();
    await tick();
    assert.deepEqual(captured.stripEntries(), [], 'PROFILE_ALREADY_BOUND with reveal must not create an error row');

    // 3. Busy flag is ignored without creating an error row.
    nextOpenReply = { ok: false, code: 'SURFACE_CREATE_BUSY' };
    captured.identities.emit('open-identity', { profileId: 'mv-live-1', role: 'human', busy: true });
    await tick();
    await tick();
    assert.deepEqual(captured.stripEntries(), [], 'busy flag must not create an error row');

    // 4. Unexpected failure DOES create an error row and names the real code.
    nextOpenReply = { ok: false, code: 'CAPSULE_STOP_UNPROVEN' };
    captured.identities.emit('open-identity', { profileId: 'mv-live-1', role: 'agent' });
    await tick();
    await tick();
    assert.equal(captured.stripEntries().length, 1, 'unexpected failure records one error row');
    assert.equal(captured.stripEntries()[0].code, 'CAPSULE_STOP_UNPROVEN');
    const normalized = normalizeActivityEntry(captured.stripEntries()[0]);
    assert.match(normalized.text, /^CAPSULE_STOP_UNPROVEN:/, 'error row names the real refusal code');
    assert.equal(captured.outcome()?.code, 'CAPSULE_STOP_UNPROVEN');
    // P18F: slot exhaustion has direct, actionable copy; unrelated codes remain visible.
    nextOpenReply = {ok:false,code:'CAPSULE_SLOT_UNAVAILABLE'};
    captured.identities.emit('open-identity',{profileId:'mv-live-1',role:'agent'});
    await tick();await tick();
    assert.equal(captured.outcome()?.message,'No free capsule slot. Stop another capsule first (up to 16 run at once).');
    assert.equal(normalizeActivityEntry(captured.stripEntries().at(-1)).text,'No free capsule slot. Stop another capsule first (up to 16 run at once).');
    nextOpenReply = {ok:false,code:'ADAPTER_PROFILE'};
    captured.identities.emit('open-identity',{profileId:'mv-live-1',role:'agent'});
    await tick();await tick();
    assert.match(captured.outcome()?.message,/^ADAPTER_PROFILE:/);

  } finally {
    app.unmount();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
    globalThis.metaviewerRoles = oldRoles;
    delete globalThis.__p18r3deps;
  }
});
