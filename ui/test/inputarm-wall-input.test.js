// INPUT-ARM (FEEDBACK R-INPUT): the operator takes control of a capsule from
// the wall and immediately clicks and types in it, and always sees the state.
//
// The REAL App and the REAL SurfaceCanvas mount on a custom renderer over the
// packaged input and authority wiring: createInputPort(preload input facade)
// -> preload createPreloadFacade -> installAuthorityWire -> createMainBindings
// -> a fake core on a real unix socket. The projection is the REAL
// createAuthorityRuntime fed with frame notices mirroring the fake core's
// surface state (the frames wire itself is covered by its own suites). The
// wall stub mirrors SurfacePanel.onControlRequest exactly (controlVerbForRow ->
// intentBuilders.control -> submit-intent). Mutants run in-suite against a
// rewritten App source: input never armed from the wall, and arming without
// human control, must each fail the oracle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { installAuthorityWire } from '../electron/authorityWire.js';
import { createMainBindings } from '../electron/hostBindings.js';
import { createPreloadFacade } from '../electron/preload.js';
import { createAuthorityAdapter, createAuthorityRuntime } from '../src/core/hostAdapters.js';
import { createInputPort } from '../src/input/inputPort.js';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { controlVerbForRow } from '../src/wall/tileStates.js';
import { tick, until } from './frame-wait.mjs';

const APP_SOURCE = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
const CANVAS_SOURCE = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');
const VUE_URL = import.meta.resolve('vue');
let serial = 0;

/** Rewrites SFC imports through a closed map; an unmapped specifier fails. */
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
  compileScript(parse(CANVAS_SOURCE).descriptor, { id: 'inputarm-canvas', inlineTemplate: true }).content,
  (bindings, spec) => {
    assert.ok(Object.hasOwn(CANVAS_DEPS, spec), `unmapped canvas dependency ${spec}`);
    return `const ${bindings} = await import(${JSON.stringify(CANVAS_DEPS[spec])});`;
  }), 'inputarm-canvas');

/** Loads the real App (optionally mutated) with stub children and the real canvas. */
async function loadApp(source, captured) {
  const stub = vue.defineComponent({
    setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap((slot) => slot?.() ?? [])),
  });
  const buttonStub = vue.defineComponent({
    inheritAttrs: false,
    props: ['label'],
    setup: (props, { attrs }) => () => vue.h('button', { ...attrs, label: props.label }),
  });
  const outcomeStub = vue.defineComponent({
    props: ['row'],
    setup: (props) => { captured.outcome = () => props.row; return () => null; },
  });
  const handoffStub = vue.defineComponent({
    setup: (_, ctx) => { captured.handoff = ctx; return () => null; },
  });
  const wallStub = vue.defineComponent({
    props: ['projectionView', 'intentBuilders'],
    setup: (props, ctx) => {
      const revision = vue.shallowRef(0);
      const stop = props.projectionView.subscribe(() => { revision.value += 1; });
      vue.onBeforeUnmount(() => { if (typeof stop === 'function') stop(); });
      const rowsOf = () => props.projectionView.getProjection()?.rows ?? [];
      ctx.expose({
        revealSurface: (id, placement) => { captured.revealed.push([id, placement]); return { ok: true }; },
        applyLayoutEcho: () => ({ ok: true }),
      });
      captured.wall = {
        // Mirrors SurfacePanel.onControlRequest: the kit Control action asks
        // with a surface_request verb; the panel emits the built intent.
        control(capsuleId, asked) {
          const row = rowsOf().find((candidate) => candidate.id === capsuleId) ?? null;
          ctx.emit('submit-intent', props.intentBuilders.control({ capsuleId, verb: controlVerbForRow(row, asked) }));
        },
      };
      return () => {
        void revision.value;
        return vue.h('div', {}, rowsOf().flatMap((row) => ctx.slots.surface?.({ surface: row, capsuleId: row.id }) ?? []));
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
    './wall/WallWorkspace.vue': wallStub,
    './surfaces/SurfaceCanvas.vue': SurfaceCanvas,
    './surfaces/tileScheduler.js': { createTileScheduler },
  };
  const key = `__inputarm${++serial}`;
  globalThis[key] = deps;
  const { descriptor } = parse(source);
  const compiled = compileScript(descriptor, { id: `inputarm-app-${serial}`, inlineTemplate: true });
  const code = rewriteImports(compiled.content, (bindings, spec) => {
    assert.ok(Object.hasOwn(deps, spec), `unmapped App dependency ${spec}`);
    return `const ${bindings} = globalThis[${JSON.stringify(key)}][${JSON.stringify(spec)}];`;
  });
  return importCode(code, `inputarm-app-${serial}`);
}

const RECT = Object.freeze({ x: 0, y: 0, left: 0, top: 0, width: 320, height: 200, right: 320, bottom: 200 });

/** Custom renderer: canvases are focusable doubles with a 1:1 frame rect. */
function createDoubleRenderer(captured) {
  const doc = { activeElement: null };
  const element = (tag) => {
    if (tag !== 'canvas') return { tag, props: {}, children: [], parent: null };
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
  endpoint: { component, instance: `${component}-inputarm` },
  hello: {
    schema: 'hello/v0.2', contract_version: 'v0.2', component, component_version: '0.1.2',
    component_commit: 'a'.repeat(40), dependencies: [],
  },
});

/**
 * Fake core on a real unix socket behind the real host bindings, authority
 * wire and preload facade. `grant` false refuses take_control with a verdict.
 * Every surface change is mirrored to the renderer frame feed.
 */
async function createStack(t, { grant = true, hold = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mv-inputarm-'));
  const configDir = join(root, 'config');
  await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const socketPath = join(root, 'metaviewer', 'core.sock');
  const configPath = join(root, 'config.json');
  const config = { session_id: 'inputarm-session', core: registration('core'), peers: [registration('ui')] };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const surfaces = new Map([['s1', makeSurface('s1', 'agent')]]);
  const received = [];
  const frameListeners = new Set();
  const sockets = new Set();
  let seq = 0;
  /** @type {(() => void) | null} */
  let held = null;
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
          send(conn, { schema: 'action_verdict/v0.2', proposal_id: body.params.proposal_id, decision: 'admitted', core_seq: seq + 1 });
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
    contents, core: host.core, frames: host.wire.frames, env, argv: [],
  });
  const api = createPreloadFacade({
    transport: { nested: false, invoke: (channel, args) => handlers.get(channel)(event, ...args), subscribe: () => () => {} },
    bridge: { exposeInMainWorld() {} },
  });
  const sentBatches = [];
  // Renderer-side witness: every batch the port hands to the preload facade.
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
    grantHeld() { const apply = held; held = null; apply?.(); },
    coreInputs: () => received.filter((body) => body.schema === 'surface_request/v0.2' && body.op === 'input'),
    controlIntents: () => received.filter((body) => body.schema === 'ui_intent/v0.2'),
  };
}

/** Mounts the real App over the stack, with the entry's live wiring. */
async function mountApp(t, stack, source = APP_SOURCE) {
  const captured = { canvases: [], revealed: [] };
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: undefined };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  const runtime = createAuthorityRuntime(stack.framesPort);
  stack.publish(stack.surfaces.get('s1'));
  const inputPort = createInputPort(stack.inputFacade);
  const App = await loadApp(source, captured);
  const root = { children: [] };
  const app = createDoubleRenderer(captured).createApp(App, {
    layout: {}, scope: {}, storage: { readRaw: async () => null, writeAtomic: async () => {} },
    nestedHost: { getNestedDepth: () => 0, getSelfCapsuleId: () => null },
    authorityHost: createAuthorityAdapter(stack.api.authority), runtime,
  });
  app.provide('inputPort', inputPort);
  app.mount(root);
  t.after(() => {
    try { app.unmount(); } catch { /* Teardown never fails the gate. */ }
    inputPort.dispose();
    runtime.dispose();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  });
  await tick();
  const canvas = () => captured.canvases.find((node) => node.parent !== null) ?? null;
  const chip = () => anchored(root, 'capsule/s1/input');
  return {
    root, captured, canvas, chip,
    chipState: () => chip()?.props['data-input-state'] ?? '',
    focusable: () => canvas()?.props.tabindex === 0,
    click(x, y) {
      const node = canvas();
      node.props.onPointerdown(pointer('pointerdown', x, y));
      node.props.onPointerup(pointer('pointerup', x, y));
    },
    key(key) { canvas().props.onKeydown({ type: 'keydown', key, preventDefault() {} }); },
  };
}

const settle = async () => { await tick(); await new Promise((resolve) => setTimeout(resolve, 40)); await tick(); };

/** Takes control from the wall, then clicks and types; returns observations. */
async function takeFromWallAndType(t, { source = APP_SOURCE, grant = true } = {}) {
  const stack = await createStack(t, { grant });
  const view = await mountApp(t, stack, source);
  const before = { chip: view.chipState(), focusable: view.focusable() };
  view.click(120, 44);
  await settle();
  const sentBeforeTake = stack.sentBatches.length;
  view.captured.wall.control('s1', 'surface_request.take_control');
  await until(() => stack.controlIntents().some((body) => body.op === 'take_control'), 'take_control at the core');
  await settle();
  const pendingOrArmed = view.chipState();
  if (grant) await until(() => view.chipState() === 'interactive' || stack.surfaces.get('s1').control === 'human', 'host grant');
  await settle();
  const after = { chip: view.chipState(), focusable: view.focusable(), outcome: view.captured.outcome?.()?.code ?? null };
  view.click(120, 44);
  view.key('Enter');
  view.key('a');
  await settle();
  if (after.focusable) await until(() => stack.sentBatches.length >= 1, 'renderer input batch');
  if (after.focusable && grant) await until(() => stack.coreInputs().length >= 3, 'input batch at the core');
  await settle();
  return { stack, view, before, sentBeforeTake, pendingOrArmed, after };
}

test('INPUT-ARM: wall Control arms the capsule; a click and keys reach the core through the packaged input path', async (t) => {
  const { stack, view, before, sentBeforeTake, after } = await takeFromWallAndType(t);
  assert.deepEqual(before, { chip: 'view', focusable: false }, 'agent-controlled tile starts view-only');
  const take = anchored(view.root, 'capsule/s1/input/take');
  assert.equal(take, null, 'the view-only chip is replaced once interactive');
  assert.equal(sentBeforeTake, 0, 'a view-only click sends nothing');
  assert.equal(after.chip, 'interactive');
  assert.equal(after.focusable, true, 'the canvas becomes focusable at once (no multislot WRITE toggle)');
  const batches = stack.sentBatches;
  assert.ok(batches.length >= 1, 'the renderer port sent the input batch');
  for (const batch of batches) {
    assert.equal(batch.schema, 'surface_input/v1');
    assert.equal(batch.surface_id, 's1');
    assert.equal(batch.stream_id, 1);
  }
  const actions = stack.coreInputs().map((body) => body.params.action);
  assert.deepEqual(actions, [
    { type: 'click', x: 120, y: 44, button: 'left' },
    { type: 'key', keys: ['Return'] },
    { type: 'type', text: 'a' },
  ]);
  for (const body of stack.coreInputs()) {
    assert.equal(body.params.surface_id, 's1');
    assert.equal(body.params.origin, 'human');
  }
});

test('INPUT-ARM: the interactive chip offers Release; release returns the tile to view-only and input stops', async (t) => {
  const { stack, view } = await takeFromWallAndType(t);
  const release = anchored(view.root, 'capsule/s1/input/release');
  assert.ok(release, 'Release is offered while interactive');
  assert.equal(release.props['aria-label'], 'Release control of default');
  const inputs = stack.coreInputs().length;
  release.props.onClick();
  await until(() => stack.controlIntents().some((body) => body.op === 'release_control'), 'release_control at the core');
  await until(() => view.chipState() === 'view', 'view-only after release');
  await settle();
  assert.equal(view.focusable(), false, 'the canvas is no longer focusable');
  view.click(120, 44);
  await settle();
  assert.equal(stack.coreInputs().length, inputs, 'nothing is sent after release');
});

test('INPUT-ARM: a refused take never arms; the tile stays view-only and the renderer sends nothing', async (t) => {
  const { stack, after, pendingOrArmed } = await takeFromWallAndType(t, { grant: false });
  assert.equal(pendingOrArmed, 'view', 'the refused pending arm is dropped');
  assert.equal(after.chip, 'view');
  assert.equal(after.focusable, false);
  assert.equal(after.outcome, 'HOST_REQUEST_REFUSED', 'the refusal is visible');
  assert.equal(stack.sentBatches.length, 0, 'no batch leaves the renderer without human control');
  assert.equal(stack.coreInputs().length, 0);
});

test('INPUT-ARM: the view-only chip is a keyboard-reachable take-control button with an accessible name', async (t) => {
  const stack = await createStack(t);
  const view = await mountApp(t, stack);
  const take = anchored(view.root, 'capsule/s1/input/take');
  assert.ok(take, 'view-only chip action is rendered');
  assert.equal(take.tag, 'button', 'kit button (native focusable control)');
  assert.equal(take.props.label, 'View only — press Control to interact');
  assert.equal(take.props['aria-label'], 'View only. Take control of default to interact');
  assert.equal(take.props.id, 'mv-input-take-s1');
  take.props.onClick();
  await until(() => view.chipState() === 'interactive', 'chip take arms after the host grant');
  assert.equal(view.focusable(), true);
});

test('INPUT-ARM: handoff take-control selects and reveals the tile, leaves covering screens, and arms input', async (t) => {
  const stack = await createStack(t);
  const view = await mountApp(t, stack);
  const settings = anchored(view.root, 'settings/open');
  settings.props.onClick();
  await tick();
  const screen = findAll(view.root, (node) => node.props?.class === 'mv-settings-screen')[0];
  assert.equal(screen.props.hidden, false, 'settings covers the wall');
  view.captured.handoff.emit('take-control', 's1');
  await tick();
  assert.equal(screen.props.hidden, true, 'the wall is shown again');
  assert.deepEqual(view.captured.revealed.at(-1), ['s1', 'tab'], 'the capsule tile is revealed');
  await until(() => view.chipState() === 'interactive', 'handoff take arms after the host grant');
  view.canvas().focus();
  view.key('Enter');
  await until(() => stack.coreInputs().length === 1, 'key at the core');
  assert.deepEqual(stack.coreInputs()[0].params.action, { type: 'key', keys: ['Return'] });
});

test('INPUT-ARM: a later human update without a wall take never arms (agent rules unchanged)', async (t) => {
  const stack = await createStack(t);
  const view = await mountApp(t, stack);
  const human = { ...stack.surfaces.get('s1'), control: 'human' };
  stack.publish(human);
  await settle();
  assert.equal(view.chipState(), 'view', 'human control alone keeps the tile view-only');
  assert.equal(view.focusable(), false);
  stack.publish({ ...human, control: 'agent' });
  await settle();
  view.captured.wall.control('s1', 'surface_request.take_control');
  await until(() => view.chipState() === 'interactive', 'armed');
  stack.publish({ ...human, control: 'agent' });
  await until(() => view.chipState() === 'view', 'agent control disarms');
  assert.equal(view.focusable(), false, 'never interactive while an agent controls');
  stack.publish(human);
  await settle();
  assert.equal(view.chipState(), 'view', 'the disarm is one-way');
});

test('INPUT-ARM: a take still awaiting the host grant is never interactive (no arm without human control)', async (t) => {
  const stack = await createStack(t, { hold: true });
  const view = await mountApp(t, stack);
  view.captured.wall.control('s1', 'surface_request.take_control');
  await until(() => stack.controlIntents().some((body) => body.op === 'take_control'), 'take_control at the core');
  await settle();
  assert.equal(view.chipState(), 'pending', 'the chip says the take is in flight');
  assert.equal(view.focusable(), false, 'not focusable before the host grants human control');
  view.canvas().focus();
  view.click(120, 44);
  view.key('Enter');
  await settle();
  assert.equal(stack.sentBatches.length, 0, 'nothing leaves the renderer while control is still agent');
  stack.grantHeld();
  await until(() => view.chipState() === 'interactive', 'armed on the grant');
  view.click(120, 44);
  await until(() => stack.coreInputs().length === 1, 'click at the core after the grant');
});

const WALL_BINDING = ':input-enabled="inputEnabledFor(surface) || wallArmedFor(surface)"';
const HUMAN_GATE = "return surface.control === 'human' && wallInputArmed.value[surface.id] === true;";

test('INPUT-ARM mutant: wall input never armed (the R-INPUT bug) fails the oracle', async (t) => {
  assert.equal(APP_SOURCE.split(WALL_BINDING).length, 2, 'mutation anchor is unique');
  const mutant = APP_SOURCE.replace(WALL_BINDING, ':input-enabled="inputEnabledFor(surface)"');
  const { stack, after } = await takeFromWallAndType(t, { source: mutant });
  assert.equal(after.focusable, false, 'mutant keeps the canvas inert');
  assert.equal(stack.coreInputs().length, 0, 'mutant: no input reaches the core, so the positive oracle fails');
});

test('INPUT-ARM mutant: arming without human control fails the refusal oracle', async (t) => {
  assert.equal(APP_SOURCE.split(HUMAN_GATE).length, 2, 'mutation anchor is unique');
  const mutant = APP_SOURCE.replace(HUMAN_GATE,
    'return wallInputArmed.value[surface.id] === true || wallInputPending.value[surface.id] === true;')
    .replace('      if (hostActive && refused && Object.hasOwn(wallInputPending.value, request.id)) {',
      '      if (false) {');
  const { stack } = await takeFromWallAndType(t, { source: mutant, grant: false });
  assert.ok(stack.sentBatches.length > 0, 'mutant sends a batch without human control (refusal oracle fails)');
  assert.equal(stack.coreInputs().length, 0, 'the host re-check still refuses it before the core');
});
