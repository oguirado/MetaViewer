import * as p18cDesktopModel from '../electron/desktopLayout.js';
import { installRoleMenuInput, openRoleMenuInput } from './role-menu-input-harness.mjs';
/**
 * UI-CONTROL-ARM: taking Control arms keyboard input across all wall paths
 * (header Control, indicator Take control, handoff, and attaching to an
 * already-human surface), focuses the canvas on enable (unless typing in a
 * text field), transitions the indicator to "Click the tile to type" on
 * Escape and restores "Interactive" on canvas click, and surfaces/logs
 * input refusals once per burst with no typed text or secrets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createMainBindings } from '../electron/hostBindings.js';
import { installAuthorityWire } from '../electron/authorityWire.js';
import { createPreloadFacade } from '../electron/preload.js';
import { createAuthorityAdapter, createAuthorityRuntime } from '../src/core/hostAdapters.js';
import { createInputPort } from '../src/input/inputPort.js';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { controlVerbForRow } from '../src/wall/tileStates.js';
import { tick, until } from './frame-wait.mjs';

const APP_SOURCE = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
const CANVAS_SOURCE = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');
const PANEL_SOURCE = readFileSync(new URL('../src/wall/SurfacePanel.vue', import.meta.url), 'utf8');
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

async function compileCanvas(canvasSource = CANVAS_SOURCE) {
  const id = `ctlarm-canvas-${++serial}`;
  return importCode(rewriteImports(
    compileScript(parse(canvasSource).descriptor, { id, inlineTemplate: true }).content,
    (bindings, spec) => {
      assert.ok(Object.hasOwn(CANVAS_DEPS, spec), `unmapped canvas dependency ${spec}`);
      return `const ${bindings} = await import(${JSON.stringify(CANVAS_DEPS[spec])});`;
    }), id);
}

const DefaultSurfaceCanvas = await compileCanvas(CANVAS_SOURCE);

async function loadApp(source, captured, canvasComponent = DefaultSurfaceCanvas) {
  const stub = vue.defineComponent({
    setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap((s) => s?.() ?? [])),
  });
  const buttonStub = vue.defineComponent({
    inheritAttrs: false,
    props: ['label'],
    setup: (props, { attrs }) => () => vue.h('button', { ...attrs, label: props.label }),
  });
  const outcomeStub = vue.defineComponent({
    props: ['row'],
    setup: (props) => {
      captured.outcome = () => props.row;
      return () => null;
    },
  });
  const activityStub = vue.defineComponent({
    props: ['items'],
    setup: (props) => {
      captured.activity = () => props.items ?? [];
      return () => null;
    },
  });
  const handoffStub = vue.defineComponent({
    emits: ['take-control'],
    setup: (_, ctx) => {
      captured.handoff = { emit: ctx.emit };
      return () => null;
    },
  });
  const launcherStub = vue.defineComponent({
    emits: ['create'],
    setup: (_, ctx) => { captured.createCapsule = (body, settle) => ctx.emit('create', body, settle); return () => null; },
  });
  const wallStub = vue.defineComponent({
    props: ['projectionView', 'intentBuilders'],
    emits: ['submit-intent', 'ready', 'wall-settled', 'activate-surface', 'panel-closed'],
    setup: (props, ctx) => {
      const revision = vue.shallowRef(0);
      const stop = props.projectionView.subscribe(() => { revision.value += 1; });
      vue.onBeforeUnmount(() => { if (typeof stop === 'function') stop(); });
      const rowsOf = () => props.projectionView.getProjection()?.rows ?? [];
      captured.wall = {
        emit: ctx.emit,
        control(capsuleId, asked = 'take_control') {
          const row = rowsOf().find((candidate) => candidate.id === capsuleId) ?? null;
          ctx.emit('submit-intent', props.intentBuilders.control({ capsuleId, verb: controlVerbForRow(row, asked) }));
        },
      };
      ctx.expose({
        selectView: (mode) => { captured.selectedView = mode; },
        followSurface: (id, mode) => { captured.followed = [id, mode]; },
        revealSurface: (id, mode) => { captured.revealed.push([id, mode]); return { ok: true }; },
        applyLayoutEcho: () => ({ ok: true }),
      });
      return () => {
        void revision.value;
        return vue.h('div', { class: 'mv-tile-capture-host' }, rowsOf().flatMap((row) => ctx.slots.surface?.({ surface: row, capsuleId: row.id }) ?? []));
      };
    },
  });
  const deps = {
    './demo/DemoDialog.vue': stub,
    './identities/IdentitiesDialog.vue': stub,
    './handoff/HandoffNotice.vue': handoffStub,
    './creative/CreativeCapsule.vue': stub,
    './core/HostOutcome.vue': outcomeStub,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': launcherStub,
    './terminal/SideTerminalOverlay.vue': stub,
    './multislot/MultislotHost.vue': stub,
    './recording/MvRecordingPanel.vue': stub,
    './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub,
    './activity/ActivityStrip.vue': activityStub,
    './nested/nested.js': { resolveNestedMode, applyNestedWall },
    'capsule-ui-kit/ui': { UiButton: buttonStub },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    './wall/DesktopWorkspace.vue': wallStub,
    '../electron/desktopLayout.js': p18cDesktopModel,
    './wall/WallWorkspace.vue': wallStub,
    './surfaces/SurfaceCanvas.vue': canvasComponent,
    './surfaces/tileScheduler.js': { createTileScheduler },
  };
  const key = `__ctlarm${++serial}`;
  globalThis[key] = deps;
  const { descriptor } = parse(source);
  const compiled = compileScript(descriptor, { id: `ctlarm-app-${serial}`, inlineTemplate: true });
  const code = rewriteImports(compiled.content, (bindings, spec) => {
    assert.ok(Object.hasOwn(deps, spec), `unmapped App dependency ${spec}`);
    return `const ${bindings} = globalThis[${JSON.stringify(key)}][${JSON.stringify(spec)}];`;
  });
  return importCode(code, `ctlarm-app-${serial}`);
}

const RECT = Object.freeze({ x: 0, y: 0, left: 0, top: 0, width: 320, height: 200, right: 320, bottom: 200 });

function createDoubleRenderer(captured, doc) {
  const element = (tag) => {
    if (tag !== 'canvas') return { tag, props: {}, children: [], parent: null, style:{display:''}, getBoundingClientRect:()=>({x:0,y:0,width:320,height:200}),getClientRects:()=>[1] };
    const canvas = {
      tag, props: {}, children: [], parent: null, width: RECT.width, height: RECT.height,
      getBoundingClientRect: () => ({ ...RECT }),
      focus() {
        if (canvas.props.tabindex !== 0 && canvas.props.tabindex !== '0') return;
        doc.activeElement = canvas;
        canvas.props.onFocus?.({ type: 'focus', target: canvas });
      },
      blur() {
        if (doc.activeElement !== canvas) return;
        doc.activeElement = null;
        canvas.props.onBlur?.({ type: 'blur', target: canvas });
      },
    };
    captured.canvases.push(canvas);
    return canvas;
  };
  return vue.createRenderer({
    createElement: element,
    createText: (text) => ({ text, parent: null }),
    createComment: (text) => ({ comment: text, parent: null }),
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
    patchProp(node, key, _old, value) { node.props[key] = value; },
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

function pointer(type, x, y) {
  return { type, button: 0, buttons: 1, pointerId: 1, clientX: x, clientY: y, preventDefault() {} };
}

function makeSurface(surfaceId, control) {
  return {
    schema: 'surface/v0.2', surface_id: surfaceId, kind: 'browser', display: ':99',
    geometry: { w: 320, h: 200 }, state: 'active', visibility: 'unfolded', control, profile_id: 'default',
  };
}

function frameNotice(surface) {
  return {
    frame_ref: {
      schema: 'frame_ref/v0.2', surface_id: surface.surface_id, generation: 1, width: 320, height: 200,
      format: 'rgb24', sha256: 'a'.repeat(64), tick: 1, ts_ns: 1000, capture_us: 0,
    },
    surface,
  };
}

const registration = (component) => ({
  endpoint: { component, instance: `${component}-ctlarm` },
  hello: {
    schema: 'hello/v0.2', contract_version: 'v0.2', component, component_version: '0.1.2',
    component_commit: 'a'.repeat(40), dependencies: [],
  },
});

async function createStack(t, { initialControl = 'agent', grant = true, hold = false, refuseInputCode = null, wireClock = Date.now } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mv-ctlarm-'));
  const configDir = join(root, 'config');
  await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const socketPath = join(root, 'metaviewer', 'core.sock');
  const configPath = join(root, 'config.json');
  const config = { session_id: 'ctlarm-session', core: registration('core'), peers: [registration('ui')] };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const surfaces = new Map([['s1', makeSurface('s1', initialControl)]]);
  const received = [];
  const frameListeners = new Set();
  const sockets = new Set();
  let seq = 0;
  let held = null;
  let currentRefuseInputCode = refuseInputCode;
  const publish = (surface) => { for (const listener of [...frameListeners]) listener(frameNotice(surface)); };
  const send = (conn, body) => {
    if (conn.destroyed) return;
    seq += 1;
    conn.write(`${JSON.stringify({
      schema: 'envelope/v0.2', msg_id: `reply-${seq}`, ts_ns: seq * 1000, from: config.core.endpoint,
      to: config.peers[0].endpoint, session_id: config.session_id, seq, nonce: `nonce-${seq}`, body,
    })}\n`);
  };
  const server = createServer((conn) => {
    sockets.add(conn);
    conn.on('close', () => sockets.delete(conn));
    let buffer = '';
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
        const body = JSON.parse(buffer.slice(0, nl)).body;
        buffer = buffer.slice(nl + 1);
        received.push(body);
        if (body.schema === 'hello/v0.2') {
          send(conn, config.core.hello);
          for (const surface of surfaces.values()) send(conn, { schema: 'surface_event/v0.2', event: 'created', data: { surface } });
        } else if (body.schema === 'ui_intent/v0.2' && ['take_control', 'release_control'].includes(body.op)) {
          if (body.op === 'take_control' && !grant) {
            send(conn, { schema: 'action_verdict/v0.2', proposal_id: body.request_id, decision: 'refused',
              reason_code: 'LOCKED_BY_OTHER', core_seq: seq + 1 });
            continue;
          }
          const apply = () => {
            const next = { ...surfaces.get(body.params.surface_id), control: body.op === 'take_control' ? 'human' : 'agent' };
            surfaces.set(next.surface_id, next);
            send(conn, { schema: 'surface_event/v0.2', event: 'state_changed', data: { surface: next } });
            publish(next);
          };
          if (hold && body.op === 'take_control') held = apply;
          else apply();
        } else if (body.schema === 'surface_request/v0.2' && body.op === 'input') {
          if (currentRefuseInputCode !== null) {
            send(conn, { schema: 'action_verdict/v0.2', proposal_id: body.params.proposal_id, decision: 'refused',
              reason_code: currentRefuseInputCode, core_seq: seq + 1 });
          } else {
            send(conn, { schema: 'action_verdict/v0.2', proposal_id: body.params.proposal_id, decision: 'admitted', core_seq: seq + 1 });
          }
        }
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  await chmod(socketPath, 0o600);
  const env = { XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: configDir, MV_CORE_CONFIG: configPath };
  const createMessageChannel = () => {
    const port1 = new EventEmitter();
    Object.assign(port1, { postMessage() {}, start() {}, close() {} });
    return { port1, port2: { close() {} } };
  };
  const host = await createMainBindings({ env, createMessageChannel, inputDeadlineMs: 3000 });
  const handlers = new Map();
  const frame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false, postMessage() {} };
  const event = { sender: contents, senderFrame: frame };
  const wire = installAuthorityWire({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) },
    contents, core: host.core, frames: host.wire.frames, env, argv: [], now: wireClock,
  });
  const api = createPreloadFacade({
    transport: { nested: false, invoke: (channel, args) => handlers.get(channel)(event, ...args), subscribe: () => () => {} },
    bridge: { exposeInMainWorld() {} },
  });
  const sentBatches = [];
  const inputFacade = {
    send: (batch) => { sentBatches.push(batch); return api.input.send(batch); },
    onResult: (cb) => api.input.onResult(cb),
  };
  const framesPort = {
    subscribeFrames(listener) { frameListeners.add(listener); return () => frameListeners.delete(listener); },
  };
  t.after(async () => {
    await wire.dispose();
    await host.core.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    api, inputFacade, framesPort, sentBatches, surfaces, publish,
    setRefuseInputCode(code) { currentRefuseInputCode = code; },
    grantHeld() { const apply = held; held = null; apply?.(); },
    coreInputs: () => received.filter((body) => body.schema === 'surface_request/v0.2' && body.op === 'input'),
    controlIntents: () => received.filter((body) => body.schema === 'ui_intent/v0.2'),
  };
}

async function mountApp(t, stack, { source = APP_SOURCE, canvasComponent = DefaultSurfaceCanvas, portOptions = {}, activeElement = null } = {}) {
  const captured = { canvases: [], revealed: [] };
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const doc = { activeElement, documentElement: { dataset: {} }, getElementById: () => null };
  const fixtureWindow = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: undefined };
  globalThis.window = fixtureWindow;
  globalThis.document = doc;
  const runtime = createAuthorityRuntime(stack.framesPort);
  stack.publish(stack.surfaces.get('s1'));
  const inputPort = createInputPort(stack.inputFacade, portOptions);
  const App = await loadApp(source, captured, canvasComponent);
  const root = { children: [] };
  const app = createDoubleRenderer(captured, doc).createApp(App, {
    layout: {}, scope: {}, storage: { readRaw: async () => null, writeAtomic: async () => {} },
    nestedHost: { getNestedDepth: () => 0, getSelfCapsuleId: () => null },
    authorityHost: createAuthorityAdapter(stack.api.authority), runtime,
  });
  app.provide('inputPort', inputPort);
  installRoleMenuInput(t, app);
  app.mount(root);
  t.after(() => {
    // Several fixtures share a test; after-hooks run in registration order.
    // Unmount against this fixture's globals so child polling is always disposed.
    globalThis.window = fixtureWindow;
    globalThis.document = doc;
    app.unmount();
    inputPort.dispose();
    runtime.dispose();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  });
  await tick();
  await openRoleMenuInput(root);
  const canvas = (id = 's1') => captured.canvases.find((node) => node.parent !== null && (node.props.id === `capsule/${id}/input` || captured.canvases.filter((c) => c.parent !== null).length === 1)) ?? null;
  const chip = (id = 's1') => anchored(root, `capsule/${id}/input`);
  const chipStatusText = (id = 's1') => {
    const nodes = findAll(chip(id), (node) => node.props?.role === 'status');
    return nodes.map((n) => (n.children ?? []).map((c) => c.text ?? '').join('') || n.text || '').join(' ').trim();
  };
  return {
    root, doc, captured, canvas, chip, chipStatusText, inputPort,
    chipState: (id = 's1') => chip(id)?.props['data-input-state'] ?? '',
    focusable: (id = 's1') => canvas(id)?.props.tabindex === 0,
    focused: (id = 's1') => doc.activeElement === canvas(id),
    click(x, y, id = 's1') {
      const node = canvas(id);
      node.props.onPointerdown(pointer('pointerdown', x, y));
      node.props.onPointerup(pointer('pointerup', x, y));
    },
    key(key, id = 's1') { canvas(id).props.onKeydown({ type: 'keydown', key, preventDefault() {} }); },
  };
}

const settle = async () => { await tick(); await new Promise((resolve) => setTimeout(resolve, 45)); await tick(); };

test('V027: opening an Agent program reveals it without taking control; menu Take control still arms input', async (t) => {
  const stack = await createStack(t);
  stack.surfaces.set('s1', { ...makeSurface('s1', 'agent'), kind: 'desktop_capsule' });
  const view = await mountApp(t, stack);
  view.captured.wall.emit('wall-settled');
  const roles = globalThis.metaviewerRoles;
  globalThis.metaviewerRoles = {
    ...roles,
    createProgram: async (choice) => {
      assert.deepEqual(choice, { binary: 'gedit', role: 'agent' });
      return { ok: true, surfaceId: 's1', role: 'agent' };
    },
  };
  const reply = await new Promise(resolve => view.captured.createCapsule({ kind: 'program', binary: 'gedit', role: 'agent' }, resolve));
  assert.equal(reply.ok, true);
  await settle();
  assert.ok(view.captured.revealed.some(([id, mode]) => id === 's1' && mode === 'split'), 'opened program remains revealed');
  assert.equal(view.captured.selectedView, 'agent');
  assert.deepEqual(view.captured.followed, ['s1', 'agent'], 'opened program stays selected');
  assert.equal(stack.surfaces.get('s1').control, 'agent', 'opening preserves authoritative agent control');
  assert.deepEqual(stack.controlIntents(), [], 'opening sends no take_control');
  assert.equal(view.chipState(), 'view');
  assert.equal(view.focusable(), false);
  // The real RoleSurface menu remains the explicit entry to interactive input.
  const take = anchored(view.root, 'capsule/s1/control/emergency');
  assert.ok(take, 'Take control remains available in the real tile menu');
  assert.equal(take.props.disabled, false);
  take.props.onClick();
  await until(() => view.chipState() === 'interactive', 'manual menu Take control arms the program');
  assert.equal(stack.surfaces.get('s1').control, 'human');
  view.key('a');
  await until(() => stack.coreInputs().length === 1, 'manual Take control enables keyboard input');
});

test('UI-CONTROL-ARM 1: header Control path and attaching to an already-human surface arm input (with mutant: bypass arming)', async (t) => {
  // Verify SurfacePanel.vue routes header Control presses via controlVerbForRow and emits submit-intent.
  assert.ok(
    PANEL_SOURCE.includes("emit('submit-intent', props.intentBuilders.control({ capsuleId: props.capsuleId, verb }));"),
    'SurfacePanel emits submit-intent for header Control',
  );

  // 1a. Header Control button arms input when taking control from agent.
  const stack = await createStack(t, { initialControl: 'agent' });
  const view = await mountApp(t, stack);
  assert.equal(view.chipState(), 'view');
  assert.equal(view.focusable(), false);
  view.captured.wall.control('s1', 'surface_request.take_control');
  await until(() => view.chipState() === 'interactive', 'header Control arms input');
  assert.equal(view.focusable(), true);
  view.key('a');
  await until(() => stack.coreInputs().length >= 1, 'key reaches core after header Control');
  assert.deepEqual(stack.coreInputs()[0].params.action, { type: 'type', text: 'a' });

  // 1b. Attaching to an already-human surface arms input immediately on mount.
  const humanStack = await createStack(t, { initialControl: 'human' });
  const humanView = await mountApp(t, humanStack);
  await settle();
  assert.equal(humanView.chipState(), 'interactive', 'attaching to an already-human surface arms input');
  assert.equal(humanView.focusable(), true, 'already-human surface canvas is focusable');

  // Mutant: bypassing armWallInput(targetId) in applyWallControl leaves header Control and initial attach unarmed.
  const armTarget = '  armWallInput(targetId);';
  assert.equal(APP_SOURCE.split(armTarget).length, 2, 'unique armWallInput call in applyWallControl');
  const bypassMutant = APP_SOURCE.replace(armTarget, '  /* mutant: bypass arming */');
  const mutantStack = await createStack(t, { initialControl: 'agent' });
  const mutantView = await mountApp(t, mutantStack, { source: bypassMutant });
  mutantView.captured.wall.control('s1', 'surface_request.take_control');
  await until(() => mutantStack.surfaces.get('s1').control === 'human', 'core grants human control');
  await settle();
  assert.notEqual(mutantView.chipState(), 'interactive', 'mutant fails to arm input on header Control');
  assert.equal(mutantView.focusable(), false, 'mutant leaves canvas unfocusable');
});

test('UI-CONTROL-ARM 2: the canvas is focused on enable unless typing in a text field (with mutant: skip focusCanvasOnEnable)', async (t) => {
  // Positive: enabling input automatically focuses the canvas so keys work without clicking the canvas first.
  const stack = await createStack(t, { initialControl: 'agent' });
  const view = await mountApp(t, stack);
  assert.equal(view.focused(), false, 'starts unfocused before control');
  const take = anchored(view.root, 'capsule/s1/control/emergency');
  take.props.onClick();
  await until(() => view.chipState() === 'interactive', 'chip Take control arms input');
  await settle();
  assert.equal(view.focused(), true, 'canvas is automatically focused when input becomes enabled');
  view.key('x');
  await until(() => stack.coreInputs().length === 1, 'typing works immediately without clicking the canvas');
  assert.deepEqual(stack.coreInputs()[0].params.action, { type: 'type', text: 'x' });

  // Guard: when the operator is typing in an <INPUT> field, enabling input does not steal focus.
  const inputField = { tagName: 'INPUT', isContentEditable: false };
  const guardStack = await createStack(t, { initialControl: 'agent' });
  const guardView = await mountApp(t, guardStack, { activeElement: inputField });
  guardView.captured.wall.control('s1', 'surface_request.take_control');
  await until(() => guardView.chipState() === 'interactive', 'armed while typing in input');
  await settle();
  assert.equal(guardView.doc.activeElement, inputField, 'focus is not stolen from an active INPUT element');

  // Mutant: removing focusCanvasOnEnable() in SurfaceCanvas.vue leaves the canvas unfocused on enable.
  const focusTarget = '  if (previous === false) {\n    focusCanvasOnEnable();\n    void Promise.resolve().then(focusCanvasOnEnable);\n  }';
  assert.equal(CANVAS_SOURCE.split(focusTarget).length, 2, 'unique focus-on-enable block in SurfaceCanvas.vue');
  const MutantCanvas = await compileCanvas(CANVAS_SOURCE.replace(focusTarget, '  if (previous === false) { /* mutant */ }'));
  const mutantStack = await createStack(t, { initialControl: 'agent' });
  const mutantView = await mountApp(t, mutantStack, { canvasComponent: MutantCanvas });
  mutantView.captured.wall.control('s1', 'surface_request.take_control');
  await until(() => mutantView.chipState() === 'interactive', 'mutant armed');
  await settle();
  assert.equal(mutantView.focused(), false, 'mutant fails to focus canvas on enable');
});

test('UI-CONTROL-ARM 3: Escape gives a distinct "Click the tile to type" state and a click re-arms (with mutant: ignore canvas-escape)', async (t) => {
  const stack = await createStack(t, { initialControl: 'agent' });
  const view = await mountApp(t, stack);
  view.captured.wall.control('s1', 'surface_request.take_control');
  await until(() => view.chipState() === 'interactive', 'armed');
  await settle();
  assert.equal(view.focused(), true);
  assert.equal(view.chipStatusText(), 'Interactive');

  // Pressing Escape blurs the canvas and switches the chip to 'paused' ("Click the tile to type").
  view.key('Escape');
  await tick();
  assert.equal(view.focused(), false, 'Escape blurs the canvas');
  assert.equal(view.chipState(), 'paused', 'Escape transitions chip state to paused');
  assert.equal(view.chipStatusText(), 'Click the tile to type', 'Escape shows distinct "Click the tile to type" copy');
  assert.equal(view.focusable(), true, 'canvas remains focusable so a click can restore typing');

  // Clicking the canvas restores focus and returns the chip to 'interactive' ("Interactive").
  view.click(100, 80);
  await settle();
  assert.equal(view.focused(), true, 'clicking the canvas restores focus');
  assert.equal(view.chipState(), 'interactive', 'clicking the canvas restores interactive state');
  assert.equal(view.chipStatusText(), 'Interactive', 'clicking the canvas restores Interactive status text');

  // Mutant: ignoring canvas-escape in App.vue leaves the chip claiming "Interactive" after Escape.
  const escapeTarget = '  wallInputEscaped.value = { ...wallInputEscaped.value, [id]: true };';
  assert.equal(APP_SOURCE.split(escapeTarget).length, 2, 'unique wallInputEscaped assignment');
  const escapeMutant = APP_SOURCE.replace(escapeTarget, '  /* mutant: ignore escape */');
  const mutantStack = await createStack(t, { initialControl: 'agent' });
  const mutantView = await mountApp(t, mutantStack, { source: escapeMutant });
  mutantView.captured.wall.control('s1', 'surface_request.take_control');
  await until(() => mutantView.chipState() === 'interactive', 'mutant armed');
  await settle();
  mutantView.key('Escape');
  await tick();
  assert.equal(mutantView.chipState(), 'interactive', 'mutant falsely stays interactive after Escape');
  assert.notEqual(mutantView.chipStatusText(), 'Click the tile to type', 'mutant fails to show Click the tile to type');
});

test('UI-CONTROL-ARM 4: a refusal is shown and logged once per burst with no secrets or typed text (with mutant)', async (t) => {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  t.after(() => { console.log = origLog; });

  let nowMs = 50000;
  const notices = [];
  const stack = await createStack(t, {
    initialControl: 'agent',
    refuseInputCode: 'STALE_FRAME',
    wireClock: () => nowMs,
  });
  const view = await mountApp(t, stack, {
    portOptions: {
      now: () => nowMs,
      refusalBurstMs: 1000,
      onRefusalNotice: (notice) => notices.push(notice),
    },
  });
  view.captured.wall.control('s1', 'surface_request.take_control');
  await until(() => view.chipState() === 'interactive', 'armed');
  await settle();

  // Send a burst of 3 refused inputs within the same 1000 ms window, including sensitive typed text.
  view.click(40, 40);
  await settle();
  nowMs += 50;
  view.key('Enter');
  await settle();
  nowMs += 50;
  view.inputPort.queue('s1', 1, { kind: 'type', text: 'super-secret-password' });
  await settle();

  await until(() => view.chipStatusText().includes('Input refused: STALE_STREAM'), 'refusal shown in chip');
  assert.equal(view.chipStatusText(), 'Input refused: STALE_STREAM');
  assert.equal(view.chipStatusText().includes('super-secret-password'), false, 'no typed text in chip');

  const refusedLogs = logs.filter((line) => line.startsWith('METAVIEWER_INPUT_REFUSED'));
  assert.equal(refusedLogs.length, 1, 'terminal log emitted exactly once for the 3-batch refusal burst');
  assert.equal(refusedLogs[0], 'METAVIEWER_INPUT_REFUSED surface=s1 code=STALE_STREAM count=1');
  assert.equal(logs.some((line) => line.includes('super-secret-password')), false, 'no typed text in terminal log');
  assert.equal(notices.length, 1, 'inputPort onRefusalNotice hook fired once for the burst');
  assert.deepEqual(notices[0], { surfaceId: 's1', code: 'STALE_STREAM', count: 1 });

  // Advance clock past the 1000 ms burst window: the next refusal logs the accumulated burst count.
  nowMs += 1500;
  view.click(50, 50);
  await settle();
  const afterWindowLogs = logs.filter((line) => line.startsWith('METAVIEWER_INPUT_REFUSED'));
  assert.equal(afterWindowLogs.length, 2, 'second burst window logs once more');
  assert.equal(afterWindowLogs[1], 'METAVIEWER_INPUT_REFUSED surface=s1 code=STALE_STREAM count=4');

  // Mutant: removing wallInputRefusal assignment in App.vue hides the refusal from the chip.
  const refusalTarget = '      wallInputRefusal.value = { ...wallInputRefusal.value, [surfaceId]: `Input refused: ${code}` };';
  assert.equal(APP_SOURCE.split(refusalTarget).length, 2, 'unique wallInputRefusal assignment');
  const refusalMutant = APP_SOURCE.replace(refusalTarget, '      /* mutant: silent refusal */');
  const mutantStack = await createStack(t, { initialControl: 'agent', refuseInputCode: 'STALE_FRAME' });
  const mutantView = await mountApp(t, mutantStack, { source: refusalMutant });
  mutantView.captured.wall.control('s1', 'surface_request.take_control');
  await until(() => mutantView.chipState() === 'interactive', 'mutant armed');
  await settle();
  mutantView.click(40, 40);
  await settle();
  assert.equal(mutantView.chipStatusText().includes('Input refused:'), false, 'mutant fails to show refusal in chip');
});

test('UI-CONTROL-ARM 5: Release disarms input and blurs canvas (with mutant: skip disarmWallInput)', async (t) => {
  const stack = await createStack(t, { initialControl: 'agent' });
  const view = await mountApp(t, stack);
  view.captured.wall.control('s1', 'surface_request.take_control');
  await until(() => view.chipState() === 'interactive', 'armed');
  await settle();
  assert.equal(view.focusable(), true);
  assert.equal(view.focused(), true);

  const release = anchored(view.root, 'capsule/s1/input/release');
  assert.ok(release, 'Release button is rendered');
  const sentBeforeRelease = stack.coreInputs().length;
  release.props.onClick();
  await until(() => view.chipState() === 'view', 'Release returns chip to view');
  await settle();
  assert.equal(view.focusable(), false, 'Release removes canvas tabindex');
  assert.equal(view.focused(), false, 'Release blurs the canvas');
  view.click(80, 60);
  view.key('a');
  await settle();
  assert.equal(stack.coreInputs().length, sentBeforeRelease, 'no input sent after Release');

  // Mutant: bypassing releaseWallControl / disarmWallInput on Release leaves the tile armed.
  const releaseTarget = "function releaseWallControl(surface) {\n  if (nestedMode.displayOnly || !surface) return;\n  applyWallControl(surface.id, 'release_control');\n}";
  assert.equal(APP_SOURCE.split(releaseTarget).length, 2, 'unique releaseWallControl function');
  const releaseMutant = APP_SOURCE.replace(releaseTarget, 'function releaseWallControl(_surface) { /* mutant: skip release disarm */ }');
  const mutantStack = await createStack(t, { initialControl: 'agent' });
  const mutantView = await mountApp(t, mutantStack, { source: releaseMutant });
  mutantView.captured.wall.control('s1', 'surface_request.take_control');
  await until(() => mutantView.chipState() === 'interactive', 'mutant armed');
  await settle();
  const mutantRelease = anchored(mutantView.root, 'capsule/s1/input/release');
  mutantRelease.props.onClick();
  await settle();
  assert.equal(mutantView.chipState(), 'interactive', 'mutant fails to disarm on Release');
  assert.equal(mutantView.focusable(), true, 'mutant leaves canvas focusable after Release');
});

test('UI-CONTROL-ARM 6: an agent-held surface never arms (with mutant: arm without human control check)', async (t) => {
  const stack = await createStack(t, { initialControl: 'agent', hold: true });
  const view = await mountApp(t, stack);
  assert.equal(view.chipState(), 'view', 'agent surface starts in view state');
  assert.equal(view.focusable(), false, 'agent surface is never focusable');
  assert.equal(view.focused(), false, 'agent surface is never focused');

  // Even after requesting control, while the core still holds agent control, input never arms.
  view.captured.wall.control('s1', 'surface_request.take_control');
  await settle();
  assert.equal(view.chipState(), 'pending', 'pending while agent still holds control');
  assert.equal(view.focusable(), false, 'still unfocusable while agent holds control');
  view.click(100, 100);
  view.key('a');
  await settle();
  assert.equal(stack.sentBatches.length, 0, 'zero batches sent while surface is agent-controlled');

  // Mutant: removing surface.control === 'human' check in wallArmedFor arms an agent-held surface.
  const humanGate = "  return surface.control === 'human' && wallInputArmed.value[surface.id] === true;";
  assert.equal(APP_SOURCE.split(humanGate).length, 2, 'unique human gate in wallArmedFor');
  const agentMutant = APP_SOURCE.replace(
    humanGate,
    '  return wallInputArmed.value[surface.id] === true || wallInputPending.value[surface.id] === true;',
  );
  const mutantStack = await createStack(t, { initialControl: 'agent', hold: true });
  const mutantView = await mountApp(t, mutantStack, { source: agentMutant });
  mutantView.captured.wall.control('s1', 'surface_request.take_control');
  await settle();
  assert.equal(mutantView.chipState(), 'interactive', 'mutant falsely arms while surface is still agent-controlled');
  assert.equal(mutantView.focusable(), true, 'mutant makes agent-held surface focusable');
});
