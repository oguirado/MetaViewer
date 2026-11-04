import * as agentPromptGate from '../src/terminal/agentPromptGate.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalDeckController, deserializeDeckState, TERMINAL_DECK_SCHEMA, MAX_DECK_SCREENS, MAX_SLOTS_PER_SCREEN } from '../src/terminal/terminalDeckModel.js';

function storage(raw) {
  return { raw, getItem() { return this.raw; }, setItem(_key, value) { this.raw = value; } };
}
function savedDeck(count = 0) {
  return { schema: TERMINAL_DECK_SCHEMA, screens: [{ id: 'screen-1', slots: Array.from({ length: count }, (_, i) => ({ id: `slot-${i + 1}`, kind: 'shell', profileId: 'shell' })) }] };
}

test('LP01 unsupported saved bytes survive deck edits; valid decks remain writable', () => {
  const original = JSON.stringify({ schema: 'metaviewer.terminalDeck/future', precious: 'keep' });
  const store = storage(original);
  const deck = createTerminalDeckController({ storage: store });
  deck.addScreen(); deck.persist(); deck.dispose();
  assert.equal(store.raw, original);
  const valid = storage(JSON.stringify(savedDeck()));
  const writable = createTerminalDeckController({ storage: valid });
  writable.addScreen(); writable.dispose();
  assert.equal(JSON.parse(valid.raw).screens.length, 2);
});

test('LP04 overflow saved screen refuses restore and preserves every saved slot', () => {
  const raw = JSON.stringify(savedDeck(MAX_SLOTS_PER_SCREEN + 1));
  assert.equal(deserializeDeckState(raw), null);
  const store = storage(raw), deck = createTerminalDeckController({ storage: store });
  deck.addScreen(); deck.dispose();
  assert.equal(store.raw, raw);
  assert.equal(deserializeDeckState(JSON.stringify(savedDeck(MAX_SLOTS_PER_SCREEN))).screens[0].slots.length, MAX_SLOTS_PER_SCREEN);
});

function brokerHarness(options = {}) {
  let exit, data, sequence = 0;
  const closed = [], writes = [];
  const broker = { open: async () => ({ session: `session-${++sequence}` }), close: async ({ session }) => { closed.push(session); } };
  const sessionFacade = { attach: async () => {}, write: req => writes.push(req), close() {}, onExit(fn) { exit = fn; }, onData(fn) { data = fn; } };
  const deck = createTerminalDeckController({ broker, sessionFacade, closeGraceMs: 0, ...options });
  return { deck, broker, closed, writes, exit: event => exit(event), data: frame => data(frame) };
}

for (const custom of [false, true]) {
  test(`TD01 concurrent ${custom ? 'custom' : 'profile'} opens compete for the final deck slot`, async () => {
    const saved = savedDeck();
    saved.screens = Array.from({ length: MAX_DECK_SCREENS }, (_, i) => ({ id: `screen-${i + 1}`, slots: Array.from({ length: MAX_SLOTS_PER_SCREEN - (i === MAX_DECK_SCREENS - 1 ? 1 : 0) }, (_, j) => ({ id: `slot-${i * MAX_SLOTS_PER_SCREEN + j + 1}`, kind: 'shell', profileId: 'shell' })) }));
    const h = brokerHarness({ storage: storage(JSON.stringify(saved)) });
    const opens = [], attaches = [];
    const sessionFacade = { attach: () => new Promise(resolve => attaches.push(resolve)), write: req => h.writes.push(req), close() {} };
    h.deck.dispose();
    h.deck = createTerminalDeckController({ broker: h.broker, sessionFacade, storage: storage(JSON.stringify(saved)) });
    h.broker.open = () => new Promise(resolve => opens.push(resolve));
    const launch = () => custom ? h.deck.launchCustomCli('echo synthetic') : h.deck.launchProfile('shell');
    const first = launch();
    await new Promise(resolve => setImmediate(resolve));
    opens[0]({ session: 'session-first' });
    await new Promise(resolve => setImmediate(resolve));
    const outcomes = Promise.allSettled([first, launch()]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(opens.length, 2);
    opens[1]({ session: 'session-overflow' });
    await new Promise(resolve => setImmediate(resolve));
    attaches.forEach(resolve => resolve());
    const results = await outcomes;
    try {
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.ok(h.deck.state.screens.every(s => s.slots.length <= MAX_SLOTS_PER_SCREEN));
      assert.ok(h.closed.includes('session-overflow'));
      assert.equal(h.writes.some(r => r.session === 'session-overflow'), false);
    } finally { h.deck.dispose(); }
  });
}

test('TD07 legacy broker without writable session refuses custom CLI and closes shell', async () => {
  const closed = [];
  const deck = createTerminalDeckController({ broker: { open: async () => ({ session: 'session-legacy' }), close: async req => closed.push(req.session) } });
  try {
    await assert.rejects(deck.launchCustomCli('echo synthetic'), /TERMINAL_SESSION_UNAVAILABLE/);
    assert.deepEqual(closed, ['session-legacy']);
    assert.equal(deck.state.screens[0].slots.length, 0);
  } finally { deck.dispose(); }
});

test('TD03 natural exit clears its busy close confirmation', async () => {
  const h = brokerHarness();
  try {
    const slot = await h.deck.launchProfile('shell');
    await h.deck.requestCloseSlot(slot.id);
    assert.equal(h.deck.state.pendingCloseSlotId, slot.id);
    h.exit({ session: slot.sessionId, reason: { code: 0 } });
    assert.equal(h.deck.state.pendingCloseSlotId, null);
    assert.equal(h.deck.findSlot(slot.id).slot.status, 'exited');
  } finally { h.deck.dispose(); }
});

test('Naturally exited injected-facade slots close locally without another broker close', async () => {
  const h = brokerHarness();
  try {
    const slot = await h.deck.launchProfile('shell');
    h.exit({ session: slot.sessionId, reason: { code: 0 } });
    assert.deepEqual(h.closed, []);
    await h.deck.requestCloseSlot(slot.id);
    await h.deck.requestCloseSlot(slot.id);
    assert.deepEqual(h.closed, []);
    assert.equal(h.deck.state.screens[0].slots.length, 0);
  } finally { h.deck.dispose(); }
});

import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';
import * as deckModel from '../src/terminal/terminalDeckModel.js';
import {createPairedTerminals,pairedTargetId} from '../src/terminal/pairedTerminals.js';
import vm from 'node:vm';

let viewSerial = 0;
function loadView(mutate = source => source, model = deckModel) {
  const source = mutate(readFileSync(new URL('../src/terminal/TerminalDeckView.vue', import.meta.url), 'utf8'))
    .replace('defineExpose({', 'defineExpose({ pendingSessionOutput,');
  const { descriptor } = parse(source);
  let code = compileScript(descriptor, { id: `u5-${++viewSerial}`, inlineTemplate: true }).content;
  class MissingTerminal { constructor() { throw Error('headless terminal unavailable'); } }
  const key = `__u5deps${viewSerial}`;
  globalThis[key] = { vue, '@xterm/xterm': { Terminal: MissingTerminal }, '@xterm/addon-fit': { FitAddon: class {} }, './terminalDeckModel.js': model, './pairedTerminals.js': {createPairedTerminals,pairedTargetId}, './agentPromptGate.js': agentPromptGate,
    '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js': { createTerminalDocument: () => ({}) } };
  code = code.replace(/^import\s+(['"])(.*?)\1;?\s*$/gm, '')
    .replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (_all, binding, _q, spec) => `const ${binding.replace(/\bas\b/g, ':')} = globalThis[${JSON.stringify(key)}][${JSON.stringify(spec)}];`)
    .replace(/^export\s+default\s+/m, 'globalThis.__u5view = ');
  vm.runInThisContext(`{\n${code}\n}`);
  const component = globalThis.__u5view;
  delete globalThis.__u5view; delete globalThis[key];
  return component;
}
function mountView(component, props) {
  const make = tag => ({ tag, children: [], props: {}, parent: null });
  const renderer = vue.createRenderer({ createElement: make, createComment: make, createText: text => ({ ...make('#text'), text }),
    insert(child, parent, anchor) { if (child.parent) this.remove(child); child.parent = parent; const i = parent.children.indexOf(anchor); parent.children.splice(i < 0 ? parent.children.length : i, 0, child); },
    remove(child) { const list = child.parent?.children; if (list) list.splice(list.indexOf(child), 1); child.parent = null; },
    setText(n, text) { n.text = text; }, setElementText(n, text) { n.text = text; n.children = []; }, patchProp(n, key, _old, value) { n.props[key] = value; },
    parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null, setScopeId() {} });
  const root = make('root'), app = renderer.createApp(component, props), exposed = app.mount(root);
  const find = (id, node = root) => node.props.id === id ? node : node.children.map(n => find(id, n)).find(Boolean);
  return { app, exposed, find };
}
const tick = async () => { await vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await vue.nextTick(); };

test('TD02 bootstrap identity paste reaches every workflow clipboard action', async () => {
  let copied = '';
  const view = mountView(loadView(), { clipboard: { writeText: async text => { copied = text; } }, storage: storage(null) });
  try {
    const identity = 'Capsule: synthetic-profile (surface synthetic-surface)';
    await view.exposed.onBootstrapPaste({ clipboardData: { getData: () => identity } });
    for (const kind of ['automate', 'use-automation', 'no-automation']) {
      await view.find(`terminal-deck-${kind}`).props.onClick();
      assert.ok(copied.includes(identity));
      assert.equal(copied.includes('<operator-pasted capsule identity line>'), false);
    }
  } finally { view.app.unmount(); }
});

test('TD05 term-null output buffering is bounded and removed when its slot closes', async () => {
  let output, exit;
  const facade = { attach: async () => {}, write() {}, close() {}, onData(fn) { output = fn; }, onExit(fn) { exit = fn; } };
  const view = mountView(loadView(), { terminalBroker: { open: async () => ({ session: 'session-buffer' }), close: async () => {} }, terminalBinding: facade, storage: storage(null) });
  try {
    const slot = await view.exposed.controller.launchProfile('shell');
    await tick();
    // No xterm can consume these frames, so the real fallback queues them.
    for (let i = 0; i < 128; i++) output({ session: slot.sessionId, seq: i + 1, bytes: Array(4096).fill(65), byteLength: 4096 });
    const retained = view.exposed.pendingSessionOutput.get(slot.sessionId);
    assert.ok(retained.join('').length <= 65536, 'fallback keeps a bounded tail');
    assert.ok(retained.join('').length > 0);
    exit({ session: slot.sessionId, reason: { code: 0 } });
    await view.exposed.controller.requestCloseSlot(slot.id);
    await tick();
    assert.equal(view.exposed.pendingSessionOutput.has(slot.sessionId), false);
  } finally { view.app.unmount(); }
});

test('TD06 paired workflow buttons paste into both a freshly launched agent CLI and an already-idle running agent CLI without respawning', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0; t.mock.method(performance, 'now', () => now);
  let output, seq = 0;
  const writes = [], opened = [];
  const facade = {
    attach: async () => {},
    write: req => writes.push(req),
    ack() {},
    close() {},
    onData(fn) { output = fn; return () => {}; },
    onExit() { return () => {}; },
  };
  const view = mountView(loadView(), {
    open: true,
    pairedTarget: { surfaceId: 'surface-a', profileId: 'identity-a', title: 'Alpha' },
    hostProviders: [{ id: 'agent-codex', label: 'Codex' }],
    terminalBroker: { open: async spec => { opened.push(spec); return { session: `session-${++seq}` }; }, close: async () => {} },
    terminalBinding: facade,
    storage: storage(null),
  });
  try {
    await tick(); await tick();
    assert.equal(opened.length, 1);
    assert.equal(opened[0].command, 'shell');
    await view.find('terminal-deck-use-automation').props.onClick();
    await tick();
    assert.ok(view.find('terminal-deck-launch-agent-codex'));
    const launching = view.find('terminal-deck-launch-agent-codex').props.onClick();
    await tick(); await tick();
    assert.equal(opened.length, 2);
    assert.equal(opened[1].command, 'agent-codex');
    const text = '\x1b]10;?\x1b\\\x1b[1mOpenAI Codex\x1b[0m\n› Ask Codex to do anything\x1b]0;~/workspace\x07';
    output({ session: 'session-2', seq: 1, bytes: [...new TextEncoder().encode(text)], byteLength: Buffer.byteLength(text) });
    now = 350; t.mock.timers.tick(350);
    await tick();
    assert.equal(writes.length, 1);
    await launching;
    // Leave the running agent CLI idle for 1 minute with no fresh output, then click all three workflow buttons.
    now = 60350;
    for (const kind of ['use-automation', 'automate', 'no-automation']) {
      await view.find(`terminal-deck-${kind}`).props.onClick();
      await tick();
      assert.equal(view.find('terminal-deck-agent-choice'), undefined, kind);
    }
    assert.equal(opened.length, 2, 'idle agent CLI is reused without respawning');
    assert.equal(writes.length, 4);
  } finally { view.app.unmount(); }
});
