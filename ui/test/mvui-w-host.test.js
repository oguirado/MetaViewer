import test from 'node:test';
import { validates, intentSchema } from './mvui-x-schema.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as sideTerminal from '../src/terminal/sideTerminalFacade.js';
import * as adapters from '../src/core/hostAdapters.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { createHostSettingsStore, encodeMvSettings } from '../src/settings/settingsModel.js';
import { parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';
import { FIXTURE_KEYS } from '../src/fixtures/states.js';
import { createWallLayout, migrateWallLayout } from '../src/wall/layout.js';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { toKitMenuProviders } from '../src/multislot/multislotProviders.js';
import { SHELL_COMMAND, PROVIDER_COMMAND } from '../src/terminal/providers.js';
import { recordToDiskGate } from '../src/recording/recordingModel.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
let serial = 0;
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

// This fake has the final public API, including Promise outcomes and the
// deliberately synchronous subscription/unsubscribe pair. Every method checks
// its own receiver and exact positional arity, including zero-argument getters.
function fakeHost({ depth = 0, destination = '/recordings', refused = false } = {}) {
  const calls = [], listeners = new Set();
  let settings = null, layout = null, unsubscribes = 0, enabled = false;
  let verdict = { schema: 'action_verdict/v0.2', proposal_id: 'proposal-a', core_seq: 1, decision: 'admitted' };
  const host = { authority: {}, sideTerminal: {} };
  function method(owner, name, arity, validate, result) {
    owner[name] = function (...args) {
      assert.equal(this, owner, `${name}: bound receiver`);
      assert.equal(args.length, arity, `${name}: wrong arity`);
      validate(...args); calls.push({ name, args });
      return Promise.resolve().then(() => result(...args));
    };
  }
  const json = value => { assert.equal(typeof value, 'string'); assert.equal(typeof JSON.parse(value), 'object'); };
  const none = () => {};
  method(host, 'load', 0, none, () => layout);
  method(host, 'save', 1, json, value => { layout = value; return true; });
  method(host, 'loadSettings', 0, none, () => settings);
  method(host, 'saveSettings', 1, json, value => { settings = value; return true; });
  method(host, 'recordingDestination', 0, none, () => destination);
  method(host, 'nestedDepth', 0, none, () => depth);
  method(host, 'selfCapsuleId', 0, none, () => 'self-capsule');
  method(host.authority, 'propose', 1, json, () => verdict);
  method(host.authority, 'intent', 1, value => {
    json(value); assert.equal(validates(intentSchema, JSON.parse(value)), true);
  }, () => true);
  host.authority.subscribeFrames = function (...args) {
    assert.equal(this, host.authority); assert.equal(args.length, 1, 'subscribeFrames: wrong arity');
    assert.equal(typeof args[0], 'function'); calls.push({ name: 'subscribeFrames', args });
    const cb = args[0]; listeners.add(cb); let active = true;
    return function (...unsubscribeArgs) {
      assert.equal(unsubscribeArgs.length, 0);
      if (active) { active = false; unsubscribes++; listeners.delete(cb); }
    };
  };
  method(host.sideTerminal, 'setEnabled', 1, value => assert.equal(typeof value, 'boolean'), value => { enabled = value; return true; });
  method(host.sideTerminal, 'open', 1, spec => {
    assert.deepEqual(Object.keys(spec).sort(), ['args','cols','command','rows']);
    assert.equal(typeof spec.command, 'string'); assert.ok(Array.isArray(spec.args));
    assert.ok(spec.args.every(x => typeof x === 'string'));
    assert.ok(Number.isSafeInteger(spec.cols) && spec.cols >= 2 && spec.cols <= 500);
    assert.ok(Number.isSafeInteger(spec.rows) && spec.rows >= 2 && spec.rows <= 300);
  }, () => { if (refused || !enabled) throw new Error('ALLOW_LIST_PRIVATE /private/path'); return { session: 'terminal-a' }; });
  return { host, calls, emit: notice => { for (const cb of listeners) cb(notice); },
    get unsubscribes() { return unsubscribes; }, setVerdict: value => { verdict = value; } };
}

function notice(id = 'surface-a', changes = {}) {
  return { frame_ref: { schema: 'frame_ref/v0.2', surface_id: id, generation: 1,
    width: 10, height: 10, tick: 1, ts_ns: 1, capture_us: 1, format: 'rgb24', sha256: 'a'.repeat(64) },
  surface: { schema: 'surface/v0.2', surface_id: id, kind: 'desktop_capsule', display: 'Desktop',
    geometry: { w: 10, h: 10 }, state: 'active', visibility: 'unfolded', control: 'agent', profile_id: 'default', ...changes } };
}

async function boot(host, search = '') {
  let props, onUnmount;
  const events = new Map(), local = new Map();
  const mount = { textContent: '', dataset: {} };
  globalThis.window = { metaviewer: host, location: { search },
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  globalThis.document = { documentElement: { dataset: {} }, querySelector: () => mount, getElementById: () => null };
  globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) };
  globalThis.__wBoot = {
    vue: { createApp: (_App, input) => { props = input; return { onUnmount: fn => { onUnmount = fn; }, mount() {} }; } },
    './App.vue': {}, './core/hostAdapters.js': adapters, './settings/settingsHost.js': { createSettingsHost },
    './fixtures/resolveState.js': { parseStateQuery, resolveFixture }, './fixtures/fixtureRuntime.js': { createFixtureRuntime },
    './wall/layout.js': { createWallLayout, migrateWallLayout },
    'capsule-ui-kit/theme': { installKitTheme() {}, setKitScheme() {} },
  };
  const code = main.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
    (_all, binding, _q, spec) => `const ${binding} = globalThis.__wBoot[${JSON.stringify(spec)}];`)
    .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#w-${++serial}`);
  await tick();
  return { props, mount, local, events, close: () => onUnmount?.() };
}

const originalGlobals = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage };
test.afterEach(() => { Object.assign(globalThis, originalGlobals); delete globalThis.__wBoot; delete globalThis.__wComponents; });

test('strict window.metaviewer fake rejects wrong arity and wrong payload shapes', async () => {
  const { host } = fakeHost();
  for (const method of ['load','loadSettings','recordingDestination','nestedDepth','selfCapsuleId']) assert.throws(() => host[method]('extra'), /wrong arity/);
  for (const [owner, name] of [[host,'save'],[host,'saveSettings'],[host.authority,'propose'],[host.authority,'intent'],[host.sideTerminal,'open'],[host.sideTerminal,'setEnabled']]) {
    assert.throws(() => owner[name](), /wrong arity/);
    assert.throws(() => owner[name]({}, {}), /wrong arity/);
  }
  assert.throws(() => host.authority.subscribeFrames(), /wrong arity/);
  assert.throws(() => host.authority.subscribeFrames(() => {}, () => {}), /wrong arity/);
  const stop = host.authority.subscribeFrames(() => {});
  assert.throws(() => stop('extra')); stop();
  assert.ok(host.load() instanceof Promise);
  assert.throws(() => host.authority.intent({ op: 'fold' }));
  assert.throws(() => host.sideTerminal.open({ command: 'shell', args: [] }));
  assert.equal(await host.save('{}'), true);
  assert.equal(await host.sideTerminal.setEnabled(true), true);
});

test('real bootstrap binds each live service, settings round trip, destination and nested identity', async () => {
  const fake = fakeHost({ depth: 1 });
  const mounted = await boot(fake.host);
  try {
    assert.ok(mounted.props, mounted.mount.textContent);
    assert.equal(mounted.props.exportDestination, '/recordings');
    assert.equal(recordToDiskGate({ destination: mounted.props.exportDestination, phase: 'sealed' }).allowed, true);
    const nested = resolveNestedMode(mounted.props.nestedHost);
    assert.equal(nested.displayOnly, true); assert.equal(nested.selfCapsuleId, 'self-capsule');
    const store = createHostSettingsStore(mounted.props.settingsHost);
    await store.load(); await store.save({ scheme: 'mv-dark', density: 'compact' });
    assert.equal((await store.load()).scheme, 'mv-dark');
    assert.equal(mounted.local.size, 0, 'live settings never touch local storage');
    assert.equal(await mounted.props.storage.readRaw(), null);
    await mounted.props.storage.writeAtomic('{}');
    assert.equal(fake.calls.filter(x => x.name === 'subscribeFrames').length, 1);
  } finally { mounted.close(); }
  assert.equal(fake.unsubscribes, 1);
});

test('each optional method is independently feature detected, including non-callable legacy fields', async () => {
  for (const [group, name] of [[null,'loadSettings'],[null,'saveSettings'],[null,'recordingDestination'],[null,'nestedDepth'],[null,'selfCapsuleId'],['authority','propose'],['authority','intent'],['authority','subscribeFrames'],['sideTerminal','open'],['sideTerminal','setEnabled']]) {
    for (const absent of [undefined, true]) {
      const fake = fakeHost(); (group ? fake.host[group] : fake.host)[name] = absent;
      const mounted = await boot(fake.host);
      try {
        assert.ok(mounted.props, `${name}: ${mounted.mount.textContent}`);
        const p = mounted.props;
        if (name === 'loadSettings') assert.equal(JSON.parse(await p.settingsHost.loadSettings()).scheme, 'mv-light');
        if (name === 'saveSettings') { await p.settingsHost.saveSettings(encodeMvSettings({ scheme: 'mv-dark', density: 'compact' })); assert.equal(mounted.local.size, 1); }
        if (name === 'recordingDestination') assert.equal(p.exportDestination, '');
        if (name === 'nestedDepth') assert.equal(p.nestedHost.getNestedDepth(), null);
        if (name === 'selfCapsuleId') assert.equal(p.nestedHost.getSelfCapsuleId(), null);
        if (name === 'propose' || name === 'intent') assert.equal(p.authorityHost[name], null);
        if (name === 'subscribeFrames') assert.equal(p.runtime, null);
        if (name === 'open' || name === 'setEnabled') assert.equal(p.terminalBroker[name], null);
        assert.equal(fake.calls.some(call => call.name === name), false);
      } finally { mounted.close(); }
    }
  }
});

test('older layout-only host mounts; missing required layout methods keeps visible boot refusal', async () => {
  const full = fakeHost().host;
  const legacy = { load: full.load.bind(full), save: full.save.bind(full) };
  const mounted = await boot(legacy);
  assert.ok(mounted.props); assert.equal(mounted.props.runtime, null); assert.equal(mounted.props.terminalBroker, null);
  mounted.close();
  for (const name of ['load','save']) {
    const fake = fakeHost(); delete fake.host[name];
    const failed = await boot(fake.host);
    assert.equal(failed.props, undefined); assert.match(failed.mount.textContent, /cannot start/);
    assert.equal(fake.calls.length, 0);
  }
});

test('every fixture bypasses all live methods, including settings, authority and terminal', async () => {
  for (const key of FIXTURE_KEYS) {
    const fake = fakeHost();
    const mounted = await boot(fake.host, `?state=${key}`);
    assert.ok(mounted.props, key);
    const p = mounted.props;
    await p.settingsHost.loadSettings(); await p.settingsHost.saveSettings('{}');
    await p.storage.readRaw(); await p.storage.writeAtomic('{}');
    assert.equal(p.authorityHost, null); assert.equal(p.terminalBroker, null); assert.equal(p.exportDestination, '');
    assert.equal(fake.calls.length, 0); mounted.close();
  }
});

test('null destination denies disk export and authority stream updates existing projection with teardown', async () => {
  const fake = fakeHost({ destination: null }); const mounted = await boot(fake.host);
  try {
    assert.equal(recordToDiskGate({ destination: mounted.props.exportDestination, phase: 'sealed' }).allowed, false);
    const feed = mounted.props.runtime.projectionView, changes = [];
    const off = feed.subscribe(snapshot => changes.push(snapshot));
    fake.emit(notice());
    assert.equal(feed.getSnapshot().status, 'live');
    assert.equal(feed.getProjection().rows[0].id, 'surface-a');
    fake.emit(notice('surface-b', { visibility: 'folded', control: 'human' }));
    assert.equal(feed.getProjection().rows.length, 2);
    assert.equal(feed.getProjection().rows[1].visibility, 'folded');
    assert.doesNotMatch(JSON.stringify(feed.getSnapshot()), /frame_ref|sha256|bytes|path/);
    fake.emit({ ...notice(), surface: { ...notice().surface, control: 'invented' } });
    assert.equal(feed.getSnapshot().stale, true); assert.equal(feed.getProjection().rows.length, 2);
    fake.emit(notice('surface-a', { state: 'destroyed' }));
    assert.equal(feed.getProjection().rows[0].backendLifecycle, 'destroyed');
    off(); const late = fake.calls.find(x => x.name === 'subscribeFrames').args[0];
    mounted.events.get('pagehide')(); mounted.close();
    const before = changes.length; late(notice('late'));
    assert.equal(changes.length, before); assert.equal(fake.unsubscribes, 1); assert.equal(mounted.events.size, 0);
  } finally { mounted.close(); }
});

test('intents preserve literal op names, proposals are JSON text and acknowledgements are strict', async () => {
  const fake = fakeHost(), mounted = await boot(fake.host);
  try {
    const p = mounted.props, builders = p.runtime.intentBuilders;
    for (const verb of ['take_control','release_control']) {
      const request = verb === 'fold' ? builders.visibility({ capsuleId: 'surface-a', verb }) : builders.control({ capsuleId: 'surface-a', verb });
      assert.equal(await p.authorityHost.intent(request), true);
      const body = JSON.parse(fake.calls.at(-1).args[0]);
      assert.equal(body.schema, 'ui_intent/v0.2');
      assert.equal(body.op, verb);
      assert.deepEqual(body.params, { surface_id: 'surface-a' });
      assert.ok(body.request_id);
    }
    assert.equal((await p.authorityHost.propose({ action: 'example' })).tone, 'success');
    fake.setVerdict({ schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 2, decision: 'refused', reason_code: 'POLICY' });
    const refused = await p.authorityHost.propose({ action: 'example' });
    assert.equal(refused.code, 'POLICY'); assert.doesNotMatch(refused.message, /POLICY|ERR_/);
    await assert.rejects(adapters.createAuthorityAdapter({ intent: async () => 1 }).intent({ op: 'take_control', surfaceId: 'surface-a' }));
    await assert.rejects(p.authorityHost.intent(builders.visibility({ capsuleId: 'surface-a', verb: 'fold' })));
    await assert.rejects(adapters.createTerminalBroker({ setEnabled: async () => 'true' }).setEnabled(true));
  } finally { mounted.close(); }
});

async function component(path, deps) {
  globalThis.__wComponents = deps;
  const { descriptor } = parse(readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'));
  const compiled = compileScript(descriptor, { id: `w-${++serial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, spec) => {
    if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    return `const ${binding.trim()} = globalThis.__wComponents[${JSON.stringify(spec)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#w-component-${serial}`)).default;
}
function mountComponent(Component, props) {
  const root = { children: [] };
  const renderer = vue.createRenderer({
    createElement: tag => ({ tag, props: {}, children: [] }), createText: text => ({ text }), createComment: text => ({ text: '' }),
    insert(child, parent) { child.parent = parent; parent.children.push(child); },
    remove(child) { const items = child.parent?.children; if (items) items.splice(items.indexOf(child), 1); },
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; },
    parentNode: node => node.parent, nextSibling: () => null, patchProp(node, name, _old, value) { node.props[name] = value; },
    querySelector: () => null, setScopeId() {},
  });
  const app = renderer.createApp(Component, props); app.mount(root);
  return { root, close: () => app.unmount() };
}
const allNodes = node => [node, ...(node.children ?? []).flatMap(allNodes)];
const renderedText = node => [node.text ?? '', ...(node.children ?? []).map(renderedText)].join(' ');

test('mounted App routes wall controls and catalog proposals, renders typed verdicts and respects nested display-only mode', async () => {
  const fake = fakeHost(), booted = await boot(fake.host), captured = {};
  const HostOutcome = await component('core/HostOutcome.vue', { './hostAdapters.js': adapters });
  const stub = vue.defineComponent({ setup: (_p, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap(slot => slot?.() ?? [])) });
  const wall = vue.defineComponent({ setup: (_p, ctx) => { captured.wall = ctx; return () => vue.h('div'); } });
  const catalog = vue.defineComponent({ setup: (_p, ctx) => { captured.catalog = ctx; return () => vue.h('div'); } });
  const deps = {
    './core/HostOutcome.vue': HostOutcome, 'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    'capsule-ui-kit/ui': { UiButton: stub }, 'capsule-ui-kit/theme': { setKitScheme() {} },
    './wall/WallWorkspace.vue': wall, './wall/EmptyWallView.vue': stub, './catalog/CatalogLauncher.vue': catalog,
    './terminal/SideTerminalOverlay.vue': stub, './multislot/MultislotHost.vue': vue.defineComponent({ setup: (_p, ctx) => { captured.multislot = ctx; return () => vue.h('div'); } }),
    './recording/MvRecordingPanel.vue': stub, './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub, './surfaces/SurfaceCanvas.vue': stub,
    './nested/nested.js': { resolveNestedMode, applyNestedWall }, './surfaces/tileScheduler.js': { createTileScheduler },
  };
  const App = await component('App.vue', deps);
  const mounted = mountComponent(App, booted.props);
  try {
    const runtime = booted.props.runtime;
    for (const verb of ['take_control','release_control']) {
      const intent = verb === 'fold' ? runtime.intentBuilders.visibility({ capsuleId: 'surface-a', verb }) : runtime.intentBuilders.control({ capsuleId: 'surface-a', verb });
      captured.wall.emit('submit-intent', intent); await tick();
      assert.equal(JSON.parse(fake.calls.at(-1).args[0]).op, verb);
      assert.match(renderedText(mounted.root), /Request sent/);
    }
    fake.setVerdict({ schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 2, decision: 'refused', reason_code: 'LOCKED_BY_OTHER' });
    captured.catalog.emit('create', { kind: 'browser' }); await tick();
    assert.equal(fake.calls.at(-1).name, 'propose');
    assert.equal(typeof fake.calls.at(-1).args[0], 'string');
    assert.match(renderedText(mounted.root), /Another operator/);
    assert.doesNotMatch(renderedText(mounted.root), /LOCKED_BY_OTHER|ERR_|PRIVATE/);
    const row = allNodes(mounted.root).find(n => n.props?.id === 'mv-host-outcome');
    assert.equal(row.props['data-outcome-code'], 'LOCKED_BY_OTHER');
    assert.equal(row.props['data-semantic-anchor'], 'host/outcome');
    assert.equal(row.props.role, 'alert');
  } finally { mounted.close(); booted.close(); }
  const fallbackEvents = [];
  const fallback = mountComponent(App, { ...booted.props, runtime: null,
    authorityHost: { intent: null, propose: booted.props.authorityHost.propose },
    onSubmitIntent: intent => fallbackEvents.push(intent) });
  try {
    const before = fake.calls.length;
    captured.wall.emit('submit-intent', { op: 'take_control', surfaceId: 'surface-a' }); await tick();
    assert.equal(fake.calls.length, before); assert.equal(fallbackEvents.length, 1);
  } finally { fallback.close(); }
  const multislotFixture = resolveFixture('multislot').fixture;
  const slotBoot = await boot(fake.host); fake.emit(notice());
  const localEvents = [];
  const slot = mountComponent(App, { ...slotBoot.props, fixture: multislotFixture, onSubmitIntent: value => localEvents.push(value) });
  try {
    const before = fake.calls.length;
    captured.multislot.emit('submit-intent', { type: 'fold', capsuleId: 'surface-a' }); await tick();
    assert.equal(fake.calls.length, before);
    assert.deepEqual(localEvents, [{ type: 'fold', capsuleId: 'surface-a' }]);
  } finally { slot.close(); slotBoot.close(); }
  const nested = await boot(fake.host);
  nested.props.nestedHost = { getNestedDepth: () => 1, getSelfCapsuleId: () => 'self-capsule' };
  const nestedMount = mountComponent(App, nested.props);
  try {
    assert.equal(allNodes(nestedMount.root).some(n => n.tag === 'button'), false);
    assert.equal(allNodes(nestedMount.root).some(n => n.props?.id === 'shell-settings'), false);
  } finally { nestedMount.close(); nested.close(); }
});

test('mounted provider menu enables through literal ack, launches one exact spec and renders allow-list refusal as typed row', async () => {
  const Menu = await component('terminal/BrokerLaunchControls.vue', {
    './sideTerminalFacade.js': sideTerminal,
    '../multislot/multislotProviders.js': { toKitMenuProviders }, './providers.js': { SHELL_COMMAND, PROVIDER_COMMAND },
  });
  for (const refused of [false, true]) {
    const fake = fakeHost({ refused }), booted = await boot(fake.host);
    const mounted = mountComponent(Menu, { broker: booted.props.terminalBroker });
    try {
      const checkbox = allNodes(mounted.root).find(n => n.tag === 'input');
      const button = allNodes(mounted.root).find(n => n.tag === 'button');
      assert.equal(button.props.disabled, true);
      await checkbox.props.onChange({ target: { checked: true } }); await vue.nextTick();
      assert.deepEqual(fake.calls.at(-1), { name: 'setEnabled', args: [true] });
      assert.equal(button.props.disabled, false);
      await button.props.onClick(); await vue.nextTick();
      assert.deepEqual(fake.calls.at(-1), { name: 'open', args: [{ command: 'shell', args: [], cols: 80, rows: 24 }] });
      const row = allNodes(mounted.root).find(n => n.props?.['data-outcome-code']);
      assert.equal(row.props['data-outcome-code'], refused ? 'TERMINAL_LAUNCH_REFUSED' : 'TERMINAL_OPENED');
      assert.doesNotMatch(renderedText(mounted.root), /ALLOW_LIST_PRIVATE|private\/path|TERMINAL_LAUNCH_REFUSED/);
      assert.ok(button.props.id); assert.ok(button.props['data-semantic-anchor']);
      await checkbox.props.onChange({ target: { checked: false } }); await vue.nextTick();
      assert.deepEqual(fake.calls.at(-1), { name: 'setEnabled', args: [false] });
    } finally { mounted.close(); booted.close(); }
  }
});
