// MVUI11 lane E: bound row export calls the capture store (never the kit
// intent channel), with per-row idle/exporting/exported/refused states,
// receipt witnesses and fixed typed copy per code. Negative control: the
// unbound panel keeps emitting the legacy kit export intent.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createCapturePort, createCaptureState } from '../src/capture/capturePort.js';
import { createCaptureDouble } from '../src/capture/captureDouble.js';
import {
  MV_EXPORT_REFUSAL_CODES,
  MV_EXPORT_STATES,
  mvExportRefusalText,
  mvExportShaPrefix,
  mvExportStatusAnchor,
  mvExportStatusDomId,
  mvExportedText,
  mvRowExportBusy,
  mvRowExportLabel,
  normalizeMvExportCode,
  normalizeMvExportState,
} from '../src/recording/recordingModel.js';

const TOKEN = 'recording:configured';
const DIGEST = 'c'.repeat(64);

let serial = 0;
async function component(file) {
  const url = new URL(`../src/${file}`, import.meta.url);
  const { descriptor } = parse(readFileSync(url, 'utf8'));
  const compiled = compileScript(descriptor, { id: 'mvui11-export', inlineTemplate: true });
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
const chromeText = mounted => nodes(mounted.root)
  .map(node => `${text(node)} ${node.props?.title ?? ''} ${node.props?.['aria-label'] ?? ''}`).join(' ');

/** Bound store fake with a scripted exportCapture. */
function fakeStore(over = {}) {
  const store = {
    bySurface: vue.reactive({ ...(over.bySurface ?? {}) }),
    rows: vue.reactive([...(over.rows ?? [])]),
    calls: [],
    async toggleRecord(surfaceId) { store.calls.push(['toggleRecord', surfaceId]); return { ok: true }; },
    async screenshot(surfaceId) { store.calls.push(['screenshot', surfaceId]); return { ok: true }; },
    async refresh() { store.calls.push(['refresh']); return { ok: true }; },
    async exportCapture(captureId) {
      store.calls.push(['exportCapture', captureId]);
      if (typeof over.exportCapture === 'function') return over.exportCapture(captureId);
      return { ok: true, export: { id: captureId, bytes: 2048, sha256: DIGEST } };
    },
    dispose() { store.calls.push(['dispose']); },
  };
  return store;
}

function sealedRow(id = 'rec-1', surface = 'cap-01') {
  return { id, kind: 'recording', surface_id: surface, phase: 'sealed', frames: 12, duration_ms: 61000, sealed: true, created_ms: 1 };
}

describe('bound row export reaches the store, never the intent channel', () => {
  test('success shows Exported plus the sha prefix; ids and anchors are byte-identical', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    const events = [];
    const store = fakeStore({ rows: [sealedRow()] });
    const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store,
      captureAvailable: true, exportDestination: TOKEN, onSubmitIntent: event => events.push(event) });
    try {
      const button = byId(mounted, 'mv-recordings-export-rec-1');
      assert.equal(button.props['data-semantic-anchor'], 'recording/rec-1/export');
      assert.equal(button.props['aria-label'], 'Export rec-1 to host destination');
      assert.equal(text(button).trim(), 'Export');
      const result = await button.props.onClick();
      await flush();
      assert.deepEqual(store.calls, [['exportCapture', 'rec-1']]);
      assert.deepEqual(events, [], 'bound export never emits a kit intent');
      assert.equal(result.ok, true);
      const status = byId(mounted, 'mv-recordings-export-status-rec-1');
      assert.ok(status, 'status readout renders');
      assert.equal(status.props['data-semantic-anchor'], 'recording/rec-1/export-status');
      assert.equal(status.props['data-export-state'], 'exported');
      assert.equal(status.props['data-export-code'], undefined);
      assert.equal(status.props.role, 'status');
      assert.match(text(status).trim(), /^Exported [0-9a-f]{8}$/);
      assert.equal(text(status).trim(), 'Exported cccccccc');
      assert.ok(byId(mounted, 'mv-recordings-export-rec-1').props.disabled, 'exported row cannot re-export');
    } finally { mounted.close(); }
  });

  test('pending export shows the busy state, then the receipt', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    let resolve;
    const pending = new Promise((done) => { resolve = done; });
    const store = fakeStore({ rows: [sealedRow()], exportCapture: () => pending });
    const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store,
      captureAvailable: true, exportDestination: TOKEN });
    try {
      const clicked = byId(mounted, 'mv-recordings-export-rec-1').props.onClick();
      await flush();
      const busy = byId(mounted, 'mv-recordings-export-rec-1');
      assert.equal(busy.props.disabled, true);
      assert.equal(busy.props['aria-busy'], 'true');
      assert.equal(text(busy).trim(), 'Exporting');
      assert.equal(byId(mounted, 'mv-recordings-export-status-rec-1'), undefined, 'no status before settle');
      resolve({ ok: true, export: { id: 'rec-1', bytes: 2048, sha256: DIGEST } });
      await clicked;
      await flush();
      assert.equal(text(byId(mounted, 'mv-recordings-export-status-rec-1')).trim(), 'Exported cccccccc');
      assert.equal(byId(mounted, 'mv-recordings-export-rec-1').props['aria-busy'], undefined);
    } finally { mounted.close(); }
  });

  test('no path is ever rendered from the receipt', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    const store = fakeStore({ rows: [sealedRow()] });
    const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store,
      captureAvailable: true, exportDestination: TOKEN });
    try {
      await byId(mounted, 'mv-recordings-export-rec-1').props.onClick();
      await flush();
      const status = text(byId(mounted, 'mv-recordings-export-status-rec-1')).trim();
      assert.match(status, /^Exported [0-9a-f]{8}$/);
      assert.doesNotMatch(status, /\//);
      assert.doesNotMatch(chromeText(mounted), /recording:configured/);
    } finally { mounted.close(); }
  });

  test('bound but held: export disabled with the fixed reason, store untouched', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    const events = [];
    const store = fakeStore({ rows: [sealedRow()] });
    const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store,
      captureAvailable: false, exportDestination: TOKEN, onSubmitIntent: event => events.push(event) });
    try {
      const button = byId(mounted, 'mv-recordings-export-rec-1');
      assert.equal(button.props.disabled, true);
      assert.equal(button.props['data-unavailable-reason'], 'Recording is unavailable');
      button.props.onClick();
      await flush();
      assert.deepEqual(store.calls, [], 'held export never reaches the store');
      assert.deepEqual(events, [], 'held export never emits');
    } finally { mounted.close(); }
  });
});

describe('every refusal code maps to fixed typed copy', () => {
  const cases = [
    ['DESTINATION_UNSET', 'No export destination advertised by the host'],
    ['CAPTURE_UNKNOWN', 'Recording is unavailable'],
    ['NOT_SEALED', 'Only sealed recordings can be exported'],
    ['DESTINATION_UNAVAILABLE', 'Export destination is unavailable'],
    ['DESTINATION_EXISTS', 'Recording already exported'],
    ['LIMIT', 'Export limit reached'],
    ['NESTED_DISPLAY_ONLY', 'Recording is unavailable'],
    ['CAPTURE_UNAVAILABLE', 'Recording is unavailable'],
  ];
  for (const [code, copy] of cases) {
    test(`${code} renders fixed copy with the code in a data attribute only`, async () => {
      const Panel = await component('recording/MvRecordingPanel.vue');
      const events = [];
      const store = fakeStore({ rows: [sealedRow()], exportCapture: () => ({ ok: false, code }) });
      const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store,
        captureAvailable: true, exportDestination: TOKEN, onSubmitIntent: event => events.push(event) });
      try {
        await byId(mounted, 'mv-recordings-export-rec-1').props.onClick();
        await flush();
        const status = byId(mounted, 'mv-recordings-export-status-rec-1');
        assert.equal(text(status).trim(), copy);
        assert.equal(status.props['data-export-state'], 'refused');
        assert.equal(status.props['data-export-code'], code);
        assert.ok(!chromeText(mounted).includes(code), 'raw code never visible');
        assert.deepEqual(events, [], 'refused export never emits');
        assert.ok(!byId(mounted, 'mv-recordings-export-rec-1').props.disabled, 'refused row can retry');
      } finally { mounted.close(); }
    });
  }

  test('unknown store codes fail closed to the unavailable copy', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    const store = fakeStore({ rows: [sealedRow()], exportCapture: () => ({ ok: false, code: 'BOGUS' }) });
    const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store,
      captureAvailable: true, exportDestination: TOKEN });
    try {
      await byId(mounted, 'mv-recordings-export-rec-1').props.onClick();
      await flush();
      const status = byId(mounted, 'mv-recordings-export-status-rec-1');
      assert.equal(text(status).trim(), 'Recording is unavailable');
      assert.equal(status.props['data-export-code'], 'CAPTURE_UNAVAILABLE');
    } finally { mounted.close(); }
  });

  test('malformed store results refuse without throwing or leaking', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    for (const result of [null, undefined, 7, { ok: true }, { ok: true, export: { sha256: 'short' } },
      { ok: true, export: { id: 'rec-1', bytes: 8, sha256: 'Z'.repeat(64) } }]) {
      const store = fakeStore({ rows: [sealedRow()], exportCapture: () => result });
      const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store,
        captureAvailable: true, exportDestination: TOKEN });
      try {
        await byId(mounted, 'mv-recordings-export-rec-1').props.onClick();
        await flush();
        assert.equal(text(byId(mounted, 'mv-recordings-export-status-rec-1')).trim(),
          'Recording is unavailable', JSON.stringify(result));
      } finally { mounted.close(); }
    }
  });

  test('hostile store throw or reject settles to the typed refusal', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    for (const synchronous of [false, true]) {
      const hostile = () => {
        if (synchronous) throw new Error('hostile secret');
        return Promise.reject(new Error('hostile secret'));
      };
      const store = { ...fakeStore({ rows: [sealedRow()] }), exportCapture: hostile };
      const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: TOKEN });
      try {
        const result = await byId(mounted, 'mv-recordings-export-rec-1').props.onClick();
        await flush();
        assert.deepEqual(result, { ok: false, code: 'CAPTURE_UNAVAILABLE' });
        assert.equal(text(byId(mounted, 'mv-recordings-export-status-rec-1')).trim(), 'Recording is unavailable');
        assert.ok(!chromeText(mounted).includes('hostile secret'));
      } finally { mounted.close(); }
    }
  });
});

describe('existing gates keep their rows and copy', () => {
  test('null destination keeps the existing refusal row and disabled export', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    const store = fakeStore({ rows: [sealedRow()] });
    const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store,
      captureAvailable: true, exportDestination: '' });
    try {
      const refusal = byId(mounted, 'mv-recording-disk-refusal-cap-01');
      assert.equal(text(refusal).trim(), 'No export destination advertised by the host');
      const button = byId(mounted, 'mv-recordings-export-rec-1');
      assert.equal(button.props.disabled, true);
      assert.equal(text(byId(mounted, 'mv-recordings-gate-rec-1')).trim(), 'Destination required');
      button.props.onClick();
      await flush();
      assert.deepEqual(store.calls, [], 'gated export never reaches the store');
    } finally { mounted.close(); }
  });

  test('unsealed rows keep the sealed-required gate', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    const store = fakeStore({ rows: [{ ...sealedRow(), phase: 'recording', sealed: false }] });
    const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store,
      captureAvailable: true, exportDestination: TOKEN });
    try {
      assert.equal(text(byId(mounted, 'mv-recordings-gate-rec-1')).trim(), 'Sealed required');
      const button = byId(mounted, 'mv-recordings-export-rec-1');
      assert.equal(button.props.disabled, true);
      assert.equal(button.props['data-unavailable-reason'], 'Only sealed recordings can be exported');
    } finally { mounted.close(); }
  });

  test('negative control: the unbound panel keeps emitting the kit export intent', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    const events = [];
    const mounted = mount(Panel, { capsuleId: 'cap-01', recordings: [{ id: 'rec-1', phase: 'sealed' }],
      exportDestination: TOKEN, onSubmitIntent: event => events.push(event) });
    try {
      byId(mounted, 'mv-recordings-export-rec-1').props.onClick();
      await flush();
      assert.deepEqual(events, [{
        type: 'recording-export', capsuleId: 'cap-01', recordingId: 'rec-1', phase: 'sealed', destination: TOKEN,
      }]);
    } finally { mounted.close(); }
  });

  test('bound store without exportCapture stays inert and never emits', async () => {
    const Panel = await component('recording/MvRecordingPanel.vue');
    const events = [];
    const legacy = fakeStore({ rows: [sealedRow()] });
    // @ts-expect-error legacy store predates export
    delete legacy.exportCapture;
    const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: legacy,
      captureAvailable: true, exportDestination: TOKEN, onSubmitIntent: event => events.push(event) });
    try {
      byId(mounted, 'mv-recordings-export-rec-1').props.onClick();
      await flush();
      assert.deepEqual(events, [], 'bound export never falls back to emit');
      assert.equal(byId(mounted, 'mv-recordings-export-status-rec-1'), undefined);
    } finally { mounted.close(); }
  });
});

test('export roundtrips through the real port and double with zero intents', async () => {
  const Panel = await component('recording/MvRecordingPanel.vue');
  const events = [];
  const store = createCaptureState(createCapturePort(createCaptureDouble()));
  try {
    assert.equal((await store.toggleRecord('cap-01')).ok, true);
    assert.equal((await store.toggleRecord('cap-01')).ok, true);
    assert.equal((await store.refresh()).ok, true);
    const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store,
      captureAvailable: true, exportDestination: TOKEN, onSubmitIntent: event => events.push(event) });
    try {
      await byId(mounted, 'mv-recordings-export-rec-1').props.onClick();
      await flush();
      assert.equal(text(byId(mounted, 'mv-recordings-export-status-rec-1')).trim(), 'Exported ffffffff');
      assert.deepEqual(events, []);
    } finally { mounted.close(); }
  } finally { store.dispose(); }
});

describe('export model helpers', () => {
  test('refusal copy is fixed per code with a closed fallback', () => {
    assert.equal(mvExportRefusalText('DESTINATION_UNSET'), 'No export destination advertised by the host');
    assert.equal(mvExportRefusalText('NOT_SEALED'), 'Only sealed recordings can be exported');
    assert.equal(mvExportRefusalText('DESTINATION_UNAVAILABLE'), 'Export destination is unavailable');
    assert.equal(mvExportRefusalText('DESTINATION_EXISTS'), 'Recording already exported');
    assert.equal(mvExportRefusalText('LIMIT'), 'Export limit reached');
    for (const code of ['CAPTURE_UNKNOWN', 'CAPTURE_UNAVAILABLE', 'NESTED_DISPLAY_ONLY']) {
      assert.equal(mvExportRefusalText(code), 'Recording is unavailable', code);
    }
    for (const code of ['BOGUS', '', null, undefined, 7, 'SURFACE_UNKNOWN']) {
      assert.equal(mvExportRefusalText(code), 'Recording is unavailable', String(code));
    }
  });

  test('code and state normalization fail closed', () => {
    for (const code of MV_EXPORT_REFUSAL_CODES) assert.equal(normalizeMvExportCode(code), code);
    for (const code of ['BOGUS', '', null, undefined]) {
      assert.equal(normalizeMvExportCode(code), 'CAPTURE_UNAVAILABLE', String(code));
    }
    for (const state of MV_EXPORT_STATES) assert.equal(normalizeMvExportState(state), state);
    for (const state of ['nope', '', null, undefined, 7]) {
      assert.equal(normalizeMvExportState(state), 'idle', String(state));
    }
    assert.ok(Object.isFrozen(MV_EXPORT_REFUSAL_CODES) && Object.isFrozen(MV_EXPORT_STATES));
  });

  test('receipt witness is a short hex prefix or empty', () => {
    assert.equal(mvExportShaPrefix(DIGEST), 'cccccccc');
    for (const bad of ['', 'short', 'C'.repeat(64), DIGEST.slice(1), null, undefined, 7]) {
      assert.equal(mvExportShaPrefix(bad), '', String(bad));
    }
    assert.equal(mvExportedText(DIGEST), 'Exported cccccccc');
    assert.equal(mvExportedText('short'), 'Exported');
    assert.equal(mvRowExportLabel('exporting'), 'Exporting');
    assert.equal(mvRowExportLabel('idle'), 'Export');
    assert.equal(mvRowExportBusy('exporting'), true);
    assert.equal(mvRowExportBusy('exported'), false);
  });

  test('status id and anchor are stable, safe and collision-free', () => {
    assert.equal(mvExportStatusDomId('rec-1'), 'mv-recordings-export-status-rec-1');
    assert.equal(mvExportStatusAnchor('rec-1'), 'recording/rec-1/export-status');
    const ids = ['', ' ', '/', 'a b', 'a/b', 'A', 'a', 'encoded-0020-end', 'cap-7', 'rec-1'];
    for (const name of ['mvExportStatusDomId', 'mvExportStatusAnchor']) {
      const helper = name === 'mvExportStatusDomId' ? mvExportStatusDomId : mvExportStatusAnchor;
      const values = ids.map(id => helper(id));
      assert.equal(new Set(values).size, ids.length, `${name} collisions`);
      values.forEach((value, index) => {
        assert.equal(value, helper(ids[index]));
        assert.match(value, name.endsWith('Anchor') ? /^[a-z0-9]+(?:\/[a-z0-9-]+)+$/ : /^[a-z0-9-]+$/);
      });
    }
  });
});
