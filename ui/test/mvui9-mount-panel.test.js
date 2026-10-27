// MVUI9 lane A: recording panel capture routing. A bound captureState
// store receives record-for-AI and screenshot actions (zero submit-intent
// emissions for them) and exportCapture; only select emits a kit intent. The store
// fakes below implement only the preamble names and deliberately omit
// `.available`, proving the panel never reads it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { captureEntryFor, captureRowsFor } from '../src/recording/recordingModel.js';

let serial = 0;
async function component(file) {
  const url = new URL(`../src/${file}`, import.meta.url);
  const { descriptor } = parse(readFileSync(url, 'utf8'));
  const compiled = compileScript(descriptor, { id: 'mvui9-mount', inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue') {
      const helper = new URL('./mvui2-terminal-mount.mjs', import.meta.url).href;
      return `import { SidebarIcon as ${binding.trim()} } from ${JSON.stringify(helper)};`;
    }
    const resolved = specifier === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(specifier, url).href;
    return `import ${binding} from ${JSON.stringify(resolved)};`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${serial++}`)).default;
}
function mount(Component, input) {
  const props = vue.reactive(input);
  const renderer = vue.createRenderer({
    createElement: tag => ({ tag, props: {}, children: [] }), createText: text => ({ text }), createComment: () => ({ text: '' }),
    insert(child, parent, anchor) {
      if (child.parent) this.remove(child);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
    },
    remove(child) { const list = child.parent?.children; if (list) list.splice(list.indexOf(child), 1); },
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; node.children = []; },
    patchProp(node, key, _old, value) { node.props[key] = value; },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    setScopeId() {},
  });
  const root = { children: [] };
  const app = renderer.createApp({ render: () => vue.h(Component, props) });
  app.mount(root);
  return { props, root, close: () => app.unmount() };
}
const nodes = node => [node, ...(node.children ?? []).flatMap(nodes)];
const text = node => [node.text ?? '', ...(node.children ?? []).map(text)].join(' ');
const byId = (mounted, id) => nodes(mounted.root).find(node => node.props?.id === id);
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick(); };
const click = (mounted, id) => {
  const node = byId(mounted, id);
  assert.ok(node, `control rendered: ${id}`);
  assert.equal(typeof node.props.onClick, 'function', `control is clickable: ${id}`);
  node.props.onClick();
};

/**
 * Contract-shaped store fake (preamble names only, no `.available`).
 * @param {{ map?: boolean, bySurface?: Record<string, object>, rows?: object[] }} [over]
 */
function fakeStore(over = {}) {
  const useMap = over.map === true;
  const bySurface = useMap
    ? vue.reactive(new Map(Object.entries(over.bySurface ?? {})))
    : vue.reactive({ ...(over.bySurface ?? {}) });
  const store = {
    bySurface,
    rows: vue.reactive([...(over.rows ?? [])]),
    calls: [],
    read(surfaceId) { return useMap ? bySurface.get(surfaceId) : bySurface[surfaceId]; },
    write(surfaceId, entry) {
      if (useMap) bySurface.set(surfaceId, entry);
      else bySurface[surfaceId] = entry;
    },
    async toggleRecord(surfaceId) {
      store.calls.push(['toggleRecord', surfaceId]);
      const current = store.read(surfaceId);
      if (current?.phase === 'recording') {
        store.write(surfaceId, { ...current, phase: 'sealed', recordingId: null });
        store.rows.push({ id: current.recordingId ?? `${surfaceId}-rec`, kind: 'recording',
          surface_id: surfaceId, phase: 'sealed', frames: current.frames ?? 0,
          duration_ms: current.elapsedMs ?? 0, sealed: true, created_ms: 1 });
      } else {
        store.write(surfaceId, { phase: 'recording', recordingId: `${surfaceId}-rec-1`,
          frames: 0, elapsedMs: 0, lastShot: current?.lastShot ?? null, lastCode: '' });
      }
      return { ok: true };
    },
    async screenshot(surfaceId) {
      store.calls.push(['screenshot', surfaceId]);
      const shot = { id: `${surfaceId}-shot-1`, surface_id: surfaceId,
        width: 64, height: 64, sha256: 'ab'.repeat(32), created_ms: 1 };
      const current = store.read(surfaceId);
      store.write(surfaceId, { ...(current ?? { phase: 'idle', recordingId: null, frames: 0, elapsedMs: 0, lastCode: '' }), lastShot: shot });
      store.rows.push({ id: shot.id, kind: 'shot', surface_id: surfaceId,
        phase: 'sealed', frames: 1, duration_ms: 0, sealed: true, created_ms: 1 });
      return { ok: true, shot };
    },
    async refresh() { store.calls.push(['refresh']); return { ok: true }; },
    async exportCapture(captureId) {
      store.calls.push(['exportCapture', captureId]);
      return { ok: true, export: { id: captureId, bytes: 2048, sha256: 'ab'.repeat(32) } };
    },
    dispose() { store.calls.push(['dispose']); },
  };
  return store;
}

describe('bound panel routes record-for-AI and screenshot to the store', () => {
  test('record toggle calls toggleRecord, emits nothing, phase follows the store', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    const events = [];
    const store = fakeStore();
    const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store,
      captureAvailable: true, onSubmitIntent: event => events.push(event) });
    try {
      assert.equal(text(byId(mounted, 'mv-recordings-phase-cap-01')).trim(), 'idle');
      assert.equal(text(byId(mounted, 'mv-recordings-toggle-cap-01')).trim(), 'Record for AI');
      click(mounted, 'mv-recordings-toggle-cap-01');
      await flush();
      assert.deepEqual(store.calls, [['toggleRecord', 'cap-01']]);
      assert.deepEqual(events, [], 'bound record action never emits');
      assert.equal(text(byId(mounted, 'mv-recordings-phase-cap-01')).trim(), 'recording');
      assert.equal(text(byId(mounted, 'mv-recordings-toggle-cap-01')).trim(), 'Stop');
      click(mounted, 'mv-recordings-toggle-cap-01');
      await flush();
      assert.equal(text(byId(mounted, 'mv-recordings-phase-cap-01')).trim(), 'sealed');
      assert.equal(text(byId(mounted, 'mv-recordings-toggle-cap-01')).trim(), 'Record again');
      assert.deepEqual(events, [], 'bound stop action never emits');
    } finally { mounted.close(); }
  });

  test('screenshot calls the store, emits nothing, control shows captured', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    const events = [];
    const store = fakeStore();
    const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store,
      captureAvailable: true, onSubmitIntent: event => events.push(event) });
    try {
      assert.equal(text(byId(mounted, 'mv-recordings-screenshot-cap-01')).trim(), 'Screenshot');
      click(mounted, 'mv-recordings-screenshot-cap-01');
      await flush();
      assert.deepEqual(store.calls, [['screenshot', 'cap-01']]);
      assert.deepEqual(events, [], 'bound screenshot never emits');
      assert.equal(text(byId(mounted, 'mv-recordings-screenshot-cap-01')).trim(), 'Captured');
    } finally { mounted.close(); }
  });

  test('negative control: the same clicks emit kit intents without a store (legacy path)', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    const events = [];
    const mounted = mount(Panel, { capsuleId: 'cap-01', onSubmitIntent: event => events.push(event) });
    try {
      click(mounted, 'mv-recordings-toggle-cap-01');
      click(mounted, 'mv-recordings-screenshot-cap-01');
      await flush();
      assert.deepEqual(events, [
        { type: 'record-ai', capsuleId: 'cap-01', phase: 'idle' },
        { type: 'screenshot', capsuleId: 'cap-01', target: 'ram' },
      ]);
    } finally { mounted.close(); }
  });

  test('bound but unavailable: controls disabled with the fixed reason, actions inert', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    const events = [];
    const store = fakeStore();
    const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store,
      captureAvailable: false, onSubmitIntent: event => events.push(event) });
    try {
      for (const id of ['mv-recordings-toggle-cap-01', 'mv-recordings-screenshot-cap-01']) {
        const node = byId(mounted, id);
        assert.equal(node.props.disabled, true, `${id} disabled`);
        assert.equal(node.props['data-unavailable-reason'], 'Recording is unavailable', `${id} reason`);
        node.props.onClick();
      }
      await flush();
      assert.deepEqual(store.calls, [], 'held controls never reach the store');
      assert.deepEqual(events, [], 'held controls never emit');
    } finally { mounted.close(); }
  });

  test('bound select emits and export calls the store once without emitting; shots stay out of the manifest', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    const events = [];
    const store = fakeStore({ rows: [
      { id: 'rec-1', kind: 'recording', surface_id: 'cap-01', phase: 'sealed',
        frames: 12, duration_ms: 61000, sealed: true, created_ms: 1 },
      { id: 'shot-1', kind: 'shot', surface_id: 'cap-01', phase: 'sealed',
        frames: 1, duration_ms: 0, sealed: true, created_ms: 1 },
      { id: 'rec-9', kind: 'recording', surface_id: 'cap-09', phase: 'sealed',
        frames: 3, duration_ms: 1000, sealed: true, created_ms: 1 },
    ] });
    const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store,
      captureAvailable: true, exportDestination: 'recording:configured', onSubmitIntent: event => events.push(event) });
    try {
      const selects = nodes(mounted.root).filter(n => n.props?.class === 'mv4-select');
      assert.equal(selects.length, 1, 'manifest lists only this surface recordings');
      assert.equal(selects[0].props['aria-label'], 'Select rec-1');
      selects[0].props.onClick();
      await flush();
      assert.deepEqual(events, [
        { type: 'recording-select', capsuleId: 'cap-01', recordingId: 'rec-1' },
      ]);
      assert.deepEqual(store.calls, [], 'select never touches the store');
      const result = await byId(mounted, 'mv-recordings-export-rec-1').props.onClick();
      await flush();
      assert.equal(result.ok, true, 'bound export completes through the store');
      assert.deepEqual(store.calls, [['exportCapture', 'rec-1']], 'one export call with the capture id');
      assert.deepEqual(events, [
        { type: 'recording-select', capsuleId: 'cap-01', recordingId: 'rec-1' },
      ], 'export emits no additional intent');
    } finally { mounted.close(); }
  });

  test('Map-backed bySurface works; elapsed renders from the entry', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    const events = [];
    const store = fakeStore({ map: true, bySurface: { 'cap-01': { phase: 'recording',
      recordingId: 'rec-1', frames: 30, elapsedMs: 65000, lastShot: null, lastCode: '' } } });
    const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store,
      captureAvailable: true, onSubmitIntent: event => events.push(event) });
    try {
      assert.equal(text(byId(mounted, 'mv-recordings-phase-cap-01')).trim(), 'recording');
      const elapsed = nodes(mounted.root).find(n => n.props?.class === 'mv4-elapsed');
      assert.equal(text(elapsed).trim(), '01:05');
      click(mounted, 'mv-recordings-toggle-cap-01');
      await flush();
      assert.deepEqual(store.calls, [['toggleRecord', 'cap-01']]);
      assert.deepEqual(events, []);
    } finally { mounted.close(); }
  });

  test('malformed store shapes fail closed without throwing', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    const events = [];
    const mounted = mount(Panel, { capsuleId: 'cap-01',
      captureState: { bySurface: 42, rows: 'nope' }, captureAvailable: true,
      onSubmitIntent: event => events.push(event) });
    try {
      assert.equal(text(byId(mounted, 'mv-recordings-phase-cap-01')).trim(), 'idle');
      assert.match(text(mounted.root), /No recordings yet\./);
      click(mounted, 'mv-recordings-toggle-cap-01');
      click(mounted, 'mv-recordings-screenshot-cap-01');
      await flush();
      assert.deepEqual(events, [], 'bound malformed store never falls back to emit');
    } finally { mounted.close(); }
  });
});

describe('captureEntryFor and captureRowsFor', () => {
  test('entry lookup spans object and Map stores and rejects hostile shapes', () => {
    const entry = { phase: 'recording' };
    assert.equal(captureEntryFor({ bySurface: { 'cap-01': entry } }, 'cap-01'), entry);
    assert.equal(captureEntryFor({ bySurface: new Map([['cap-01', entry]]) }, 'cap-01'), entry);
    assert.equal(captureEntryFor({ bySurface: { 'cap-01': entry } }, 'cap-02'), null);
    for (const hostile of [null, undefined, 42, 'x', [], { bySurface: null },
        { bySurface: 42 }, { bySurface: { 'cap-01': 42 } }, { bySurface: new Map() }]) {
      assert.equal(captureEntryFor(hostile, 'cap-01'), null, JSON.stringify(hostile));
    }
    for (const badId of [null, '', 42, '__proto__', 'constructor', 'prototype']) {
      assert.equal(captureEntryFor({ bySurface: {} }, badId), null, String(badId));
    }
    // Negative control: the lookup is not a tautology — a present entry resolves.
    assert.notEqual(captureEntryFor({ bySurface: { 'cap-01': entry } }, 'cap-01'), null);
  });

  test('row mapping keeps this-surface recordings with panel fields', () => {
    const rows = captureRowsFor({ rows: [
      { id: 'rec-1', kind: 'recording', surface_id: 'cap-01', phase: 'sealed', frames: 12, duration_ms: 61000 },
      { id: 'bogus', kind: 'recording', surface_id: 'cap-01', phase: 'nope', duration_ms: -5 },
      { id: 'shot-1', kind: 'shot', surface_id: 'cap-01', phase: 'sealed' },
      { id: 'rec-9', kind: 'recording', surface_id: 'cap-09', phase: 'sealed' },
      null, 42, { id: '', kind: 'recording', surface_id: 'cap-01' },
    ] }, 'cap-01');
    assert.deepEqual(rows, [
      { id: 'rec-1', capsuleId: 'cap-01', phase: 'sealed', store: 'ram', elapsedSeconds: 61, frames: 12 },
      { id: 'bogus', capsuleId: 'cap-01', phase: 'idle', store: 'ram', elapsedSeconds: null, frames: undefined },
    ]);
    assert.ok(Object.isFrozen(rows));
    for (const hostile of [null, undefined, {}, { rows: null }, { rows: {} }]) {
      assert.deepEqual(captureRowsFor(hostile, 'cap-01'), []);
    }
    assert.deepEqual(captureRowsFor({ rows: [] }, ''), []);
  });
});

test('hostile bound capture actions settle to typed refusal without error text', async () => {
  const Panel = await component('recording/MvRecordingPanel.vue');
  for (const synchronous of [false, true]) {
    const hostile = () => {
      if (synchronous) throw new Error('hostile secret');
      return Promise.reject(new Error('hostile secret'));
    };
    const store = { ...fakeStore(), toggleRecord: hostile, screenshot: hostile };
    const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store, captureAvailable: true });
    try {
      for (const id of ['mv-recordings-toggle-cap-01', 'mv-recordings-screenshot-cap-01']) {
        const result = byId(mounted, id).props.onClick();
        assert.deepEqual(await result, { ok: false, code: 'CAPTURE_UNAVAILABLE' });
        await flush();
        assert.ok(!text(mounted.root).includes('hostile secret'));
      }
    } finally { mounted.close(); }
  }
});
