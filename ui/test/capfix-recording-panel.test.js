// CAP-FIX: recording panel and model. Pillar P4 frame-rate choice (1..60,
// "up to the source rate") and story-F3 (a capture refusal is rendered, not
// swallowed). Mutants (literal source edits) prove each guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as vue from 'vue';
import {
  CAPTURE_POLICY_REFUSAL_CODES,
  CAPTURE_REFUSAL_CODES,
} from '../src/capture/capturePort.js';
import {
  MV_RECORD_FPS_HINT,
  MV_RECORD_FPS_RANGE,
  mvCaptureRefusalText,
  mvRecordFpsAnchor,
  mvRecordFpsDomId,
  mvRecordingSealedText,
  parseMvRecordFps,
} from '../src/recording/recordingModel.js';
import { byId, flush, mount, panelComponent, textOf } from './capfix-helpers.mjs';

const CAPSULE = 'cap-01';
const TOGGLE = `mv-recordings-toggle-${CAPSULE}`;
const FPS = mvRecordFpsDomId(CAPSULE);
const STATUS = `mv-recordings-capture-status-${CAPSULE}`;

function fakeStore({ lastCode = '', phase = 'idle', result = { ok: true, recording_id: 'rec-1' } } = {}) {
  const store = {
    bySurface: vue.reactive({ [CAPSULE]: { phase, recordingId: phase === 'recording' ? 'rec-1' : null, frames: 0, elapsedMs: 0, lastShot: null, lastCode } }),
    rows: vue.reactive([]),
    calls: [],
    async toggleRecord(...args) { store.calls.push(args); return result; },
    async screenshot() { return { ok: false, code: 'CAPTURE_UNAVAILABLE' }; },
    async refresh() { return { ok: true }; },
    async exportCapture() { return { ok: false, code: 'CAPTURE_UNAVAILABLE' }; },
    dispose() {},
  };
  return store;
}
const type = (mounted, value) => byId(mounted, FPS).props.onInput({ target: { value } });
const click = async (mounted) => { byId(mounted, TOGGLE).props.onClick(); await flush(); };

test('parseMvRecordFps: empty is the host default, 1..60 integers are ok, everything else is invalid', () => {
  assert.deepEqual(parseMvRecordFps(''), { state: 'default' });
  assert.deepEqual(parseMvRecordFps('  '), { state: 'default' });
  assert.deepEqual(parseMvRecordFps(undefined), { state: 'default' });
  assert.deepEqual(parseMvRecordFps(null), { state: 'default' });
  assert.deepEqual(parseMvRecordFps('1'), { state: 'ok', fps: 1 });
  assert.deepEqual(parseMvRecordFps(' 60 '), { state: 'ok', fps: 60 });
  assert.deepEqual(parseMvRecordFps(15), { state: 'ok', fps: 15 });
  for (const bad of ['0', '61', '-1', '2.5', '1e1', 'abc', '5x', '999', '0x10', NaN, Infinity, 2.5, true, {}]) {
    assert.deepEqual(parseMvRecordFps(bad), { state: 'invalid' }, String(bad));
  }
  assert.deepEqual({ ...MV_RECORD_FPS_RANGE }, { min: 1, max: 60 });
});

test('refusal copy: every capture code has distinct fixed copy that never echoes the code', () => {
  const codes = [...CAPTURE_REFUSAL_CODES, ...CAPTURE_POLICY_REFUSAL_CODES];
  const seen = new Set();
  for (const code of codes) {
    const copy = mvCaptureRefusalText(code);
    assert.ok(copy.length > 10, code);
    assert.ok(!copy.includes(code) && !/[/\\]/.test(copy), `${code} copy leaks a code or path`);
    assert.ok(!seen.has(copy), `${code} copy is distinct`);
    seen.add(copy);
  }
  assert.notEqual(mvCaptureRefusalText('BUDGET_EXCEEDED'), mvCaptureRefusalText('CAPTURE_UNAVAILABLE'));
  assert.equal(mvCaptureRefusalText(''), '');
  assert.equal(mvCaptureRefusalText(undefined), '');
  assert.equal(mvCaptureRefusalText('SOMETHING_NEW'), 'Capture failed.');
});

test('fps hint says "up to the source rate" and quotes no host rate', () => {
  assert.match(MV_RECORD_FPS_HINT, /up to the source rate/);
  assert.doesNotMatch(MV_RECORD_FPS_HINT, /\d/);
});

test('sealed text reports frames and dropped frames, never invents a drop count', () => {
  assert.equal(mvRecordingSealedText({ frames: 1 }), 'Sealed 1 frame.');
  assert.equal(mvRecordingSealedText({ frames: 4, dropped_frames: 0 }), 'Sealed 4 frames, 0 dropped.');
  assert.equal(mvRecordingSealedText({ frames: 4, dropped_frames: 2 }), 'Sealed 4 frames, 2 dropped.');
  assert.equal(mvRecordingSealedText({ frames: 4, dropped_frames: -1 }), 'Sealed 4 frames.');
  assert.equal(mvRecordingSealedText({ frames: -1 }), '');
  assert.equal(mvRecordingSealedText(null), '');
});

test('a refusal in the store is rendered with fixed copy and a code attribute; healthy renders nothing', async () => {
  const Panel = await panelComponent();
  for (const code of [...CAPTURE_REFUSAL_CODES, ...CAPTURE_POLICY_REFUSAL_CODES]) {
    const mounted = mount(Panel, { capsuleId: CAPSULE, captureState: fakeStore({ lastCode: code }), captureAvailable: true });
    try {
      const node = byId(mounted, STATUS);
      assert.ok(node, `${code} rendered`);
      assert.equal(textOf(node).trim(), mvCaptureRefusalText(code));
      assert.equal(node.props['data-error-code'], code);
      assert.equal(node.props.role, 'status');
    } finally { mounted.close(); }
  }
  const healthy = mount(Panel, { capsuleId: CAPSULE, captureState: fakeStore(), captureAvailable: true });
  try { assert.equal(byId(healthy, STATUS), undefined); } finally { healthy.close(); }
});

test('frame-rate field: named, anchored, hint wired; absent on the legacy unbound mount', async () => {
  const Panel = await panelComponent();
  const mounted = mount(Panel, { capsuleId: CAPSULE, captureState: fakeStore(), captureAvailable: true });
  try {
    const input = byId(mounted, FPS);
    assert.ok(input);
    assert.equal(input.props['data-semantic-anchor'], mvRecordFpsAnchor(CAPSULE));
    assert.match(input.props['aria-label'], /frames per second/);
    assert.equal(input.props['aria-describedby'], `${FPS}-hint`);
    assert.match(textOf(byId(mounted, `${FPS}-hint`)), /up to the source rate/);
  } finally { mounted.close(); }
  const legacy = mount(Panel, { capsuleId: CAPSULE });
  try { assert.equal(byId(legacy, FPS), undefined); } finally { legacy.close(); }
});

test('record: default is the exact one-argument call; a chosen rate rides the start only', async () => {
  const Panel = await panelComponent();
  const store = fakeStore();
  const mounted = mount(Panel, { capsuleId: CAPSULE, captureState: store, captureAvailable: true });
  try {
    await click(mounted);
    assert.deepEqual(store.calls, [[CAPSULE]]);
    type(mounted, '15'); await flush();
    await click(mounted);
    assert.deepEqual(store.calls[1], [CAPSULE, { maxFps: 15 }]);
    type(mounted, '  '); await flush();
    await click(mounted);
    assert.deepEqual(store.calls[2], [CAPSULE]);
  } finally { mounted.close(); }
  const recording = fakeStore({ phase: 'recording' });
  const stopMounted = mount(Panel, { capsuleId: CAPSULE, captureState: recording, captureAvailable: true });
  try {
    type(stopMounted, '30'); await flush();
    assert.equal(byId(stopMounted, FPS).props.disabled, true, 'field locks while recording');
    await click(stopMounted);
    assert.deepEqual(recording.calls, [[CAPSULE]], 'stop carries no rate');
  } finally { stopMounted.close(); }
});

test('an invalid rate blocks a start with a reason and never reaches the store; a stop is never blocked', async () => {
  const Panel = await panelComponent();
  const store = fakeStore();
  const mounted = mount(Panel, { capsuleId: CAPSULE, captureState: store, captureAvailable: true });
  try {
    for (const bad of ['0', '61', '2.5', 'abc']) {
      type(mounted, bad); await flush();
      const toggle = byId(mounted, TOGGLE);
      assert.equal(toggle.props.disabled, true, bad);
      assert.match(toggle.props.title, /whole number from 1 to 60/, bad);
      assert.equal(byId(mounted, FPS).props['aria-invalid'], 'true', bad);
      toggle.props.onClick?.();
      await flush();
    }
    assert.deepEqual(store.calls, []);
  } finally { mounted.close(); }
  const recording = fakeStore({ phase: 'recording' });
  const stopMounted = mount(Panel, { capsuleId: CAPSULE, captureState: recording, captureAvailable: true });
  try {
    assert.equal(byId(stopMounted, TOGGLE).props.disabled, false);
  } finally { stopMounted.close(); }
});

test('after a stop the sealed receipt shows frames and dropped', async () => {
  const Panel = await panelComponent();
  const store = fakeStore({ phase: 'recording', result: { ok: true, recording: { id: 'rec-1', surface_id: CAPSULE, frames: 6, dropped_frames: 1, duration_ms: 10, sealed: true, sha256: 'd'.repeat(64) } } });
  const mounted = mount(Panel, { capsuleId: CAPSULE, captureState: store, captureAvailable: true });
  try {
    await click(mounted);
    const sealed = [...(function walk(n) { return [n, ...(n.children ?? []).flatMap(walk)]; })(mounted.root)]
      .find((n) => n.props?.class === 'mv4-capture-sealed');
    assert.ok(sealed);
    assert.equal(textOf(sealed).trim(), 'Sealed 6 frames, 1 dropped.');
  } finally { mounted.close(); }
});

// Negative controls on the SFC: the guard text is removed and the probe must regress.
const MUTANTS = [
  ['refusal line not rendered', [['v-if="refusalText"', 'v-if="false"']],
    async (Panel) => { const m = mount(Panel, { capsuleId: CAPSULE, captureState: fakeStore({ lastCode: 'POLICY' }), captureAvailable: true }); try { return byId(m, STATUS) === undefined; } finally { m.close(); } }],
  ['invalid rate no longer blocks a start', [['|| fpsBlocksStart.value);', ');']],
    async (Panel) => { const s = fakeStore(); const m = mount(Panel, { capsuleId: CAPSULE, captureState: s, captureAvailable: true }); try { type(m, '99'); await flush(); return byId(m, TOGGLE).props.disabled === false; } finally { m.close(); } }],
  ['chosen rate not forwarded', [['{ maxFps: fps.fps }', '{}']],
    async (Panel) => { const s = fakeStore(); const m = mount(Panel, { capsuleId: CAPSULE, captureState: s, captureAvailable: true }); try { type(m, '15'); await flush(); await click(m); return JSON.stringify(s.calls[0][1]) !== JSON.stringify({ maxFps: 15 }); } finally { m.close(); } }],
  ['rate also sent on a stop', [['const starting = !recordingNow.value;', 'const starting = true;']],
    async (Panel) => { const s = fakeStore({ phase: 'recording' }); const m = mount(Panel, { capsuleId: CAPSULE, captureState: s, captureAvailable: true }); try { await flush(); byId(m, FPS).props.onInput({ target: { value: '30' } }); await flush(); await click(m); return s.calls[0].length === 2; } finally { m.close(); } }],
];
for (const [name, edits, detect] of MUTANTS) {
  test(`mutant caught (panel): ${name}`, async () => {
    assert.equal(await detect(await panelComponent(edits)), true, 'the mutant must show the regression');
    assert.equal(await detect(await panelComponent()), false, 'the faithful panel must not');
  });
}
