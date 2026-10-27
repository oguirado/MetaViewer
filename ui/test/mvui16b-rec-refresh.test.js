// MVUI16B lane R (L2-2): sealed recordings reach the manifest. The store
// relists on sealed events, stop success and screenshot success; the panel
// relists on mount and capsule switch. Rows dedupe by id, merge per
// surface and cap at 64; concurrent refresh calls coalesce to one in
// flight plus one queued. Bounded fake facade plus negatives.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import {
  CAPTURE_ROWS_CAP,
  createCapturePort,
  createCaptureState,
} from '../src/capture/capturePort.js';
import { captureRowsFor } from '../src/recording/recordingModel.js';

const T0 = Date.now();
const LIST_HISTORY_LIMIT = 8;
const SETTLE_TRIES = 40;

/** Deterministic manifest row factory (host-validated shape). */
function recRow(id, surface, phase = 'sealed', kind = 'recording') {
  return {
    id, kind, surface_id: surface, phase, frames: 3, duration_ms: 30,
    sealed: phase === 'sealed', created_ms: 9,
  };
}

/** Bounded scripted facade: list calls counted, history capped. */
function scripted(handlers = {}) {
  const calls = {
    screenshot: [], recordStart: [], recordStop: [], list: 0, subscribe: 0,
  };
  const listHistory = [];
  const listeners = new Set();
  const facade = {
    calls, listHistory, listeners,
    async screenshot(request) {
      if (calls.screenshot.length < LIST_HISTORY_LIMIT) calls.screenshot.push(request);
      return handlers.screenshot ? handlers.screenshot(request) : { ok: false, code: 'CAPTURE_UNAVAILABLE' };
    },
    async recordStart(request) {
      if (calls.recordStart.length < LIST_HISTORY_LIMIT) calls.recordStart.push(request);
      if (request.mode !== 'ai' && !handlers.recordStart) return { ok: false, code: 'CAPTURE_UNAVAILABLE' };
      return handlers.recordStart ? handlers.recordStart(request) : { ok: false, code: 'CAPTURE_UNAVAILABLE' };
    },
    async recordStop(request) {
      if (calls.recordStop.length < LIST_HISTORY_LIMIT) calls.recordStop.push(request);
      return handlers.recordStop ? handlers.recordStop(request) : { ok: false, code: 'CAPTURE_UNAVAILABLE' };
    },
    async list() {
      calls.list += 1;
      listHistory.push(calls.list);
      if (listHistory.length > LIST_HISTORY_LIMIT) listHistory.splice(0, listHistory.length - LIST_HISTORY_LIMIT);
      return handlers.list ? handlers.list() : { ok: false, code: 'CAPTURE_UNAVAILABLE' };
    },
    subscribe(cb) {
      calls.subscribe += 1;
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    emit(event) {
      for (const cb of [...listeners]) cb(event);
    },
  };
  return facade;
}

function sealedEvent(recordingId, surfaceId) {
  return {
    type: 'capture.state', recording_id: recordingId, surface_id: surfaceId,
    phase: 'sealed', frames: 3, elapsed_ms: 30,
  };
}

/** Bounded settle: poll a condition across setImmediate ticks. */
async function settleUntil(cond, tries = SETTLE_TRIES) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (cond()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return cond();
}

// Panel compile + mount helpers (self-contained; no lane-T surface).
let panelSerial = 0;
async function compilePanelSource(source, tag) {
  const url = new URL('../src/recording/MvRecordingPanel.vue', import.meta.url);
  const { descriptor } = parse(source);
  const compiled = compileScript(descriptor, { id: 'mvui16b-rec', inlineTemplate: true });
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

let panelComponentCached = null;
async function panelComponent() {
  if (panelComponentCached === null) {
    panelComponentCached = await compilePanelSource(
      readFileSync(new URL('../src/recording/MvRecordingPanel.vue', import.meta.url), 'utf8'), 'panel');
  }
  return panelComponentCached;
}

async function mutantPanelComponent(mutate) {
  const original = readFileSync(new URL('../src/recording/MvRecordingPanel.vue', import.meta.url), 'utf8');
  const changed = mutate(original);
  assert.notEqual(changed, original, 'negative control must change the source');
  return compilePanelSource(changed, 'mutant');
}

function mountPanel(Component, input) {
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

const panelFlush = async () => { await new Promise((resolve) => setImmediate(resolve)); await vue.nextTick(); };
const panelNodes = (node) => [node, ...(node.children ?? []).flatMap(panelNodes)];
const panelText = (node) => [node.text ?? '', ...(node.children ?? []).map(panelText)].join(' ');
const panelById = (mounted, id) => panelNodes(mounted.root).find((node) => node.props?.id === id);

let mutantPortSerial = 0;
async function mutantCapturePort(mutate) {
  const url = new URL('../src/capture/capturePort.js', import.meta.url);
  const original = readFileSync(url, 'utf8');
  const changed = mutate(original);
  assert.notEqual(changed, original, 'negative control must change the source');
  const require = createRequire(import.meta.url);
  const code = changed
    .replace(`from 'vue'`, `from ${JSON.stringify(pathToFileURL(require.resolve('vue')).href)}`)
    .replace(`from '../recording/recordingModel.js'`,
      `from ${JSON.stringify(new URL('../src/recording/recordingModel.js', import.meta.url).href)}`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui16bport${mutantPortSerial++}`);
}

describe('store relists after sealed rows land (L2-2)', () => {
  test('sealed event relists and fills rows for that surface', async () => {
    const facade = scripted({ list: () => ({ ok: true, rows: [recRow('rec-1', 'wall-1')] }) });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal(state.rows.length, 0, 'rows start empty: the L2-2 shape');
      facade.emit(sealedEvent('rec-9', 'wall-1'));
      assert.equal(await settleUntil(() => facade.calls.list >= 1), true, 'sealed event triggers list');
      assert.equal(await settleUntil(() => state.rows.length === 1), true, 'rows fill');
      assert.equal(state.rows[0].id, 'rec-1');
      assert.equal(captureRowsFor(state, 'wall-1').length, 1);
      assert.equal(facade.calls.list, 1, 'one event triggers one list call');
    } finally { state.dispose(); }
  });

  test('stop success relists even with no host event', async () => {
    const facade = scripted({
      recordStart: () => ({ ok: true, recording_id: 'rec-1' }),
      recordStop: (request) => ({
        ok: true,
        recording: {
          id: request.recording_id, surface_id: 'wall-1', frames: 3,
          duration_ms: 30, sealed: true, sha256: 'b'.repeat(64),
        },
      }),
      list: () => ({ ok: true, rows: [recRow('rec-1', 'wall-1')] }),
    });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal((await state.toggleRecord('wall-1')).ok, true);
      assert.equal(facade.calls.list, 0, 'start emits no sealed row, so no list');
      assert.equal((await state.toggleRecord('wall-1')).ok, true);
      assert.equal(await settleUntil(() => facade.calls.list >= 1), true, 'stop triggers list');
      assert.equal(await settleUntil(() => state.rows.length === 1), true, 'rows fill');
      assert.equal(state.rows[0].id, 'rec-1');
    } finally { state.dispose(); }
  });

  test('screenshot success relists; refusal never does', async () => {
    let shotOk = true;
    const facade = scripted({
      screenshot: (request) => (shotOk
        ? {
          ok: true,
          shot: {
            id: 'shot-1', surface_id: request.surface_id, width: 64, height: 48,
            sha256: 'a'.repeat(64), created_ms: 11,
          },
        }
        : { ok: false, code: 'LIMIT' }),
      list: () => ({ ok: true, rows: [recRow('shot-1', 'wall-1', 'sealed', 'shot')] }),
    });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal((await state.screenshot('wall-1')).ok, true);
      assert.equal(await settleUntil(() => facade.calls.list >= 1), true, 'shot success triggers list');
      assert.equal(await settleUntil(() => state.rows.length === 1), true, 'rows fill');
      shotOk = false;
      assert.equal((await state.screenshot('wall-1')).ok, false);
      await panelFlush();
      assert.equal(facade.calls.list, 1, 'refused shot triggers no list');
    } finally { state.dispose(); }
  });

  test('negative control: non-sealed events never relist', async () => {
    const facade = scripted({ list: () => ({ ok: true, rows: [recRow('rec-1', 'wall-1')] }) });
    const state = createCaptureState(createCapturePort(facade));
    try {
      for (const phase of ['starting', 'recording', 'stopping', 'idle', 'error']) {
        facade.emit({ ...sealedEvent('rec-9', 'wall-1'), phase });
      }
      await panelFlush();
      assert.equal(facade.calls.list, 0, 'only sealed relists');
      assert.equal(state.rows.length, 0);
    } finally { state.dispose(); }
  });

  test('negative control: store without the sealed trigger never lists on events', async () => {
    const mutant = await mutantCapturePort((source) => source.replace(
      `\n    if (event.phase === 'sealed') queueAutoRefresh(event.surface_id);`, ''));
    const facade = scripted({ list: () => ({ ok: true, rows: [recRow('rec-1', 'wall-1')] }) });
    const state = mutant.createCaptureState(mutant.createCapturePort(facade));
    try {
      facade.emit(sealedEvent('rec-9', 'wall-1'));
      await panelFlush();
      assert.equal(facade.calls.list, 0, 'mutant reproduces the L2-2 silence');
      assert.equal(state.rows.length, 0);
    } finally { state.dispose(); }
  });
});

describe('refresh stores deduped, per-surface, bounded rows', () => {
  test('rows dedupe by id, first wins', async () => {
    const facade = scripted({
      list: () => ({
        ok: true,
        rows: [recRow('rec-1', 'wall-1'), recRow('rec-1', 'wall-1'), recRow('rec-2', 'wall-1')],
      }),
    });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal((await state.refresh()).ok, true);
      assert.deepEqual(state.rows.map((row) => row.id), ['rec-1', 'rec-2']);
    } finally { state.dispose(); }
  });

  test('rows cap at 64 like the host', async () => {
    assert.equal(CAPTURE_ROWS_CAP, 64);
    const rows = [];
    for (let index = 0; index < 70; index += 1) rows.push(recRow(`rec-${index}`, 'wall-1'));
    const facade = scripted({ list: () => ({ ok: true, rows }) });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal((await state.refresh()).ok, true);
      assert.equal(state.rows.length, 64);
      assert.equal(state.rows[0].id, 'rec-0');
      assert.equal(state.rows[63].id, 'rec-63');
    } finally { state.dispose(); }
  });

  test('filtered refresh merges one surface and keeps the others', async () => {
    let rows = [recRow('a1', 'A'), recRow('a2', 'A'), recRow('b1', 'B')];
    const facade = scripted({ list: () => ({ ok: true, rows }) });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal((await state.refresh()).ok, true);
      assert.deepEqual(state.rows.map((row) => row.id), ['a1', 'a2', 'b1']);
      rows = [recRow('a3', 'A'), recRow('b2', 'B')];
      assert.equal((await state.refresh('A')).ok, true);
      assert.deepEqual(state.rows.map((row) => row.id), ['a3', 'b1'],
        'fresh A rows first, untouched B rows kept');
      assert.equal(captureRowsFor(state, 'B').length, 1);
      assert.equal(captureRowsFor(state, 'B')[0].id, 'b1');
    } finally { state.dispose(); }
  });

  test('hostile filter falls back to the full replace', async () => {
    const facade = scripted({ list: () => ({ ok: true, rows: [recRow('a1', 'A')] }) });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal((await state.refresh('__proto__')).ok, true);
      assert.deepEqual(state.rows.map((row) => row.id), ['a1']);
    } finally { state.dispose(); }
  });

  test('refusal keeps the previous rows', async () => {
    let flip = true;
    const facade = scripted({
      list: () => (flip
        ? { ok: true, rows: [recRow('rec-1', 'wall-1')] }
        : { ok: false, code: 'LIMIT' }),
    });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal((await state.refresh()).ok, true);
      flip = false;
      assert.deepEqual(await state.refresh(), { ok: false, code: 'LIMIT' });
      assert.deepEqual(state.rows.map((row) => row.id), ['rec-1']);
    } finally { state.dispose(); }
  });
});

describe('refresh coalesces storms and respects dispose', () => {
  test('five concurrent refreshes issue one in flight plus one queued', async () => {
    let release;
    const pending = new Promise((done) => { release = done; });
    let calls = 0;
    const facade = scripted({
      list: () => {
        calls += 1;
        if (calls === 1) return pending;
        return { ok: true, rows: [recRow('rec-2', 'wall-1')] };
      },
    });
    const state = createCaptureState(createCapturePort(facade));
    try {
      const work = [state.refresh(), state.refresh(), state.refresh(), state.refresh(), state.refresh()];
      await panelFlush();
      assert.equal(facade.calls.list, 1, 'one in flight while the first pends');
      release({ ok: true, rows: [recRow('rec-1', 'wall-1')] });
      const results = await Promise.all(work);
      assert.equal(facade.calls.list, 2, 'exactly one queued follow-up');
      assert.equal(results[0].rows[0].id, 'rec-1', 'first caller keeps the first run');
      for (const result of results.slice(1)) {
        assert.equal(result.rows[0].id, 'rec-2', 'coalesced callers share the queued run');
      }
      assert.deepEqual(state.rows.map((row) => row.id), ['rec-2'], 'last run wins the rows');
      assert.ok(facade.listHistory.length <= LIST_HISTORY_LIMIT, 'bounded list history');
    } finally { state.dispose(); }
  });

  test('disposed store never touches the facade', async () => {
    const facade = scripted({ list: () => ({ ok: true, rows: [recRow('rec-1', 'wall-1')] }) });
    const state = createCaptureState(createCapturePort(facade));
    state.dispose();
    assert.deepEqual(await state.refresh(), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
    facade.emit(sealedEvent('rec-9', 'wall-1'));
    await panelFlush();
    assert.equal(facade.calls.list, 0, 'post-dispose event never lists');
    assert.equal(state.rows.length, 0);
  });

  test('queued refresh resolves promptly on dispose', async () => {
    let release;
    const pending = new Promise((done) => { release = done; });
    const facade = scripted({ list: () => pending });
    const state = createCaptureState(createCapturePort(facade));
    try {
      const first = state.refresh();
      const queued = state.refresh();
      state.dispose();
      assert.deepEqual(await queued, { ok: false, code: 'CAPTURE_UNAVAILABLE' });
      release({ ok: true, rows: [recRow('rec-1', 'wall-1')] });
      assert.deepEqual(await first, { ok: false, code: 'CAPTURE_UNAVAILABLE' });
      assert.equal(facade.calls.list, 1, 'only the in-flight call ran');
      assert.equal(state.rows.length, 0, 'disposed run mutates nothing');
    } finally { state.dispose(); }
  });
});

describe('panel relists on mount and capsule switch', () => {
  test('mount lists once and sealed rows replace the empty text', async () => {
    const Panel = await panelComponent();
    const facade = scripted({ list: () => ({ ok: true, rows: [recRow('rec-1', 'cap-01')] }) });
    const state = createCaptureState(createCapturePort(facade));
    const mounted = mountPanel(Panel, {
      capsuleId: 'cap-01', captureState: state, captureAvailable: true, exportDestination: '',
    });
    try {
      assert.equal(await settleUntil(() => facade.calls.list >= 1), true, 'mount triggers list');
      assert.equal(await settleUntil(() => state.rows.length === 1), true, 'rows fill');
      await panelFlush();
      assert.equal(facade.calls.list, 1, 'mount lists exactly once');
      assert.doesNotMatch(panelText(mounted.root), /No recordings yet\./);
      assert.ok(panelById(mounted, 'mv-recordings-select-rec-1'), 'sealed row renders');
    } finally { mounted.close(); state.dispose(); }
  });

  test('mount skips the list when rows are already populated', async () => {
    const Panel = await panelComponent();
    const facade = scripted({ list: () => ({ ok: true, rows: [recRow('rec-1', 'cap-01')] }) });
    const state = createCaptureState(createCapturePort(facade));
    assert.equal((await state.refresh()).ok, true);
    const before = facade.calls.list;
    const mounted = mountPanel(Panel, {
      capsuleId: 'cap-01', captureState: state, captureAvailable: true, exportDestination: '',
    });
    try {
      await panelFlush();
      assert.equal(facade.calls.list, before, 'populated mount never relists');
      assert.ok(panelById(mounted, 'mv-recordings-select-rec-1'));
    } finally { mounted.close(); state.dispose(); }
  });

  test('mount never touches a static fake without a port', async () => {
    const Panel = await panelComponent();
    const store = {
      bySurface: vue.reactive({}),
      rows: vue.reactive([]),
      calls: [],
      async refresh() { store.calls.push(['refresh']); return { ok: true }; },
    };
    const mounted = mountPanel(Panel, {
      capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: '',
    });
    try {
      await panelFlush();
      assert.deepEqual(store.calls, [], 'pinned exact-call mounts stay silent');
      assert.match(panelText(mounted.root), /No recordings yet\./);
    } finally { mounted.close(); }
  });

  test('capsule switch relists and shows the new surface rows', async () => {
    const Panel = await panelComponent();
    const facade = scripted({
      list: () => ({ ok: true, rows: [recRow('rec-1', 'cap-01'), recRow('rec-2', 'cap-02')] }),
    });
    const state = createCaptureState(createCapturePort(facade));
    const mounted = mountPanel(Panel, {
      capsuleId: 'cap-01', captureState: state, captureAvailable: true, exportDestination: '',
    });
    try {
      assert.equal(await settleUntil(() => state.rows.length === 1), true, 'mount fills cap-01');
      await panelFlush();
      assert.ok(panelById(mounted, 'mv-recordings-select-rec-1'));
      const before = facade.calls.list;
      mounted.props.capsuleId = 'cap-02';
      assert.equal(await settleUntil(() => facade.calls.list > before), true, 'switch triggers list');
      assert.equal(await settleUntil(() => state.rows.length === 2), true, 'merge keeps both surfaces');
      await panelFlush();
      assert.ok(panelById(mounted, 'mv-recordings-select-rec-2'), 'cap-02 row renders');
      assert.equal(panelById(mounted, 'mv-recordings-select-rec-1'), undefined, 'cap-01 row filters out');
      const same = facade.calls.list;
      mounted.props.capsuleId = 'cap-02';
      await panelFlush();
      assert.equal(facade.calls.list, same, 'same-id assignment never relists');
    } finally { mounted.close(); state.dispose(); }
  });

  test('negative control: panel without the mount hook never lists on mount', async () => {
    const Panel = await mutantPanelComponent((source) => source.replace(
      `onMounted(() => {
  // Mount load only: a store without a listable port is a static fake
  // (the pinned exact-call tests), and rows for the active capsule are
  // already fresh through the store event path, so neither case relists
  // here. Rows for other capsules never suppress this mount's list.
  const store = props.captureState;
  if (typeof store?.refresh !== 'function') return;
  if (typeof store?.port?.list !== 'function') return;
  if (!Array.isArray(store.rows)) return;
  if (hasActiveCapsuleRows(store)) return;
  requestListRefresh();
});`, ''));
    const facade = scripted({ list: () => ({ ok: true, rows: [recRow('rec-1', 'cap-01')] }) });
    const state = createCaptureState(createCapturePort(facade));
    const mounted = mountPanel(Panel, {
      capsuleId: 'cap-01', captureState: state, captureAvailable: true, exportDestination: '',
    });
    try {
      await panelFlush();
      assert.equal(facade.calls.list, 0, 'mutant reproduces the L2-2 silence');
      assert.match(panelText(mounted.root), /No recordings yet\./);
    } finally { mounted.close(); state.dispose(); }
  });

  test('negative control: panel without the switch watcher never lists on switch', async () => {
    const Panel = await mutantPanelComponent((source) => source.replace(
      `watch(() => props.capsuleId, (next, prev) => {
  if (next !== prev) requestListRefresh();
});`, ''));
    const facade = scripted({
      list: () => ({ ok: true, rows: [recRow('rec-1', 'cap-01'), recRow('rec-2', 'cap-02')] }),
    });
    const state = createCaptureState(createCapturePort(facade));
    const mounted = mountPanel(Panel, {
      capsuleId: 'cap-01', captureState: state, captureAvailable: true, exportDestination: '',
    });
    try {
      assert.equal(await settleUntil(() => state.rows.length >= 1), true, 'mount still lists');
      await panelFlush();
      const before = facade.calls.list;
      mounted.props.capsuleId = 'cap-02';
      await panelFlush();
      assert.equal(facade.calls.list, before, 'mutant never relists on switch');
    } finally { mounted.close(); state.dispose(); }
  });
});

test('mvui16b memory ceiling and file budget', () => {
  const rss = process.memoryUsage().rss;
  if (process.env.MVUI16_MEASURE) console.log(`mvui16b-rec-refresh rss MiB: ${Math.round(rss / 1048576)}`);
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
  assert.ok(Date.now() - T0 < 10000, 'test file finishes in < 10 s');
});
