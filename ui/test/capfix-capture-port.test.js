// CAP-FIX: renderer capture port and store. Typed core refusals reach the
// operator (no collapse to CAPTURE_UNAVAILABLE), the optional frame-rate
// ceiling (pillar P4) rides only a start, and the sealed recording keeps the
// core dropped_frames count. Mutants prove each guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTURE_POLICY_REFUSAL_CODES,
  CAPTURE_REFUSAL_CODES,
  CAPTURE_FPS_RANGE,
  createCapturePort,
  createCaptureState,
  isCaptureFps,
} from '../src/capture/capturePort.js';
import { createCaptureDouble } from '../src/capture/captureDouble.js';
import { importMutant } from './capfix-helpers.mjs';

const DIGEST = 'c'.repeat(64);

/** Scripted facade that records every request and answers from a queue. */
function scripted(replies) {
  const calls = { recordStart: [], recordStop: [], screenshot: [], export: [], list: [] };
  const answer = (name) => async (request) => { calls[name].push(request); return replies[name]; };
  return {
    calls,
    screenshot: answer('screenshot'),
    recordStart: answer('recordStart'),
    recordStop: answer('recordStop'),
    export: answer('export'),
    list: answer('list'),
    subscribe: () => () => {},
  };
}
const stopReply = (extra = {}) => ({ ok: true, recording: { id: 'rec-1', surface_id: 's1', frames: 4, duration_ms: 1500, sealed: true, sha256: DIGEST, ...extra } });

test('policy refusal set is frozen, disjoint from the pinned record set and range is 1..60', () => {
  assert.deepEqual([...CAPTURE_POLICY_REFUSAL_CODES], ['BUDGET_EXCEEDED', 'POLICY']);
  assert.ok(Object.isFrozen(CAPTURE_POLICY_REFUSAL_CODES));
  for (const code of CAPTURE_POLICY_REFUSAL_CODES) assert.ok(!CAPTURE_REFUSAL_CODES.includes(code));
  assert.deepEqual({ ...CAPTURE_FPS_RANGE }, { min: 1, max: 60 });
  for (const ok of [1, 3, 60]) assert.equal(isCaptureFps(ok), true);
  for (const bad of [0, 61, -1, 2.5, '3', NaN, Infinity, null, undefined, true]) assert.equal(isCaptureFps(bad), false, String(bad));
});

test('BUDGET_EXCEEDED and POLICY survive every capture method', async () => {
  for (const code of CAPTURE_POLICY_REFUSAL_CODES) {
    const refusal = { ok: false, code, request_id: 'x' };
    const port = createCapturePort(scripted({ recordStart: refusal, recordStop: refusal, screenshot: refusal, export: refusal, list: refusal }));
    assert.deepEqual(await port.recordStart('s1'), { ok: false, code });
    assert.deepEqual(await port.recordStop('rec-1'), { ok: false, code });
    assert.deepEqual(await port.screenshot('s1'), { ok: false, code });
    assert.deepEqual(await port.exportCapture('rec-1'), { ok: false, code });
    assert.deepEqual(await port.list(), { ok: false, code });
  }
  assert.deepEqual(await createCapturePort(scripted({ screenshot: { ok: false, code: 'NOPE', request_id: 'x' } })).screenshot('s1'),
    { ok: false, code: 'CAPTURE_UNAVAILABLE' }, 'unknown codes still fail closed');
});

test('store keeps the typed refusal in lastCode for the panel to render', async () => {
  const facade = createCaptureDouble({ refuseStart: 'BUDGET_EXCEEDED' });
  const store = createCaptureState(createCapturePort(facade));
  const result = await store.toggleRecord('s1');
  assert.deepEqual(result, { ok: false, code: 'BUDGET_EXCEEDED' });
  assert.equal(store.bySurface.s1.lastCode, 'BUDGET_EXCEEDED');
  assert.equal(store.bySurface.s1.phase, 'idle');
  store.dispose();
});

test('recordStart request: legacy shape without a choice, max_fps with one, nothing reaches the host when invalid', async () => {
  const facade = scripted({ recordStart: { ok: true, recording_id: 'rec-1' } });
  const port = createCapturePort(facade);
  await port.recordStart('s1');
  await port.recordStart('s1', {});
  await port.recordStart('s1', { maxFps: 15 });
  assert.deepEqual(facade.calls.recordStart.map((r) => Object.keys(r).sort().join(',')),
    ['mode,request_id,schema,surface_id', 'mode,request_id,schema,surface_id', 'max_fps,mode,request_id,schema,surface_id']);
  assert.equal(facade.calls.recordStart[2].max_fps, 15);
  const before = facade.calls.recordStart.length;
  for (const bad of [0, 61, 2.5, '5', NaN, null, Infinity]) {
    assert.deepEqual(await port.recordStart('s1', { maxFps: bad }), { ok: false, code: 'CAPTURE_UNAVAILABLE' }, String(bad));
  }
  assert.equal(facade.calls.recordStart.length, before, 'invalid choice never calls the facade');
});

test('recordStop keeps dropped_frames when the core sent it and never invents it', async () => {
  const withDropped = await createCapturePort(scripted({ recordStop: stopReply({ dropped_frames: 3 }) })).recordStop('rec-1');
  assert.equal(withDropped.ok, true);
  assert.equal(withDropped.recording.dropped_frames, 3);
  const legacy = await createCapturePort(scripted({ recordStop: stopReply() })).recordStop('rec-1');
  assert.equal(Object.hasOwn(legacy.recording, 'dropped_frames'), false);
  for (const bad of [-1, 1.5, '2', null]) {
    assert.deepEqual(await createCapturePort(scripted({ recordStop: stopReply({ dropped_frames: bad }) })).recordStop('rec-1'),
      { ok: false, code: 'CAPTURE_UNAVAILABLE' }, String(bad));
  }
});

test('toggleRecord passes the choice to a start only; stop and the default keep the one-argument call', async () => {
  const seen = [];
  const port = {
    available: true,
    screenshot: async () => ({ ok: false, code: 'CAPTURE_UNAVAILABLE' }),
    recordStart: async (...args) => { seen.push(['start', ...args]); return { ok: true, recording_id: 'rec-1' }; },
    recordStop: async (...args) => { seen.push(['stop', ...args]); return { ok: true, recording: { id: 'rec-1', surface_id: 's1', frames: 1, duration_ms: 1, sealed: true, sha256: DIGEST } }; },
    list: async () => ({ ok: true, rows: [] }),
    subscribe: () => () => {},
  };
  const store = createCaptureState(port);
  await store.toggleRecord('s1');
  await store.toggleRecord('s1', { maxFps: 30 });
  await store.toggleRecord('s1', { maxFps: 30 });
  await store.toggleRecord('s1', { maxFps: 12 });
  assert.deepEqual(seen, [['start', 's1'], ['stop', 'rec-1'], ['start', 's1', { maxFps: 30 }], ['stop', 'rec-1']]);
  store.dispose();
});

const MUTANTS = [
  ['policy codes no longer accepted',
    ['(CAPTURE_REFUSAL_CODES.includes(code) || CAPTURE_POLICY_REFUSAL_CODES.includes(code))', 'CAPTURE_REFUSAL_CODES.includes(code)'],
    async () => { const m = await mutated(); return (await m.createCapturePort(scripted({ recordStart: { ok: false, code: 'POLICY', request_id: 'x' } })).recordStart('s1')).code !== 'POLICY'; }],
  ['fps range guard removed',
    ['if (maxFps !== undefined && !isCaptureFps(maxFps)) return unavailable();', ''],
    async () => { const f = scripted({ recordStart: { ok: true, recording_id: 'r' } }); await (await mutated()).createCapturePort(f).recordStart('s1', { maxFps: 61 }); return f.calls.recordStart.length === 1; }],
  ['max_fps not forwarded',
    ['...(maxFps === undefined ? {} : { max_fps: maxFps }),', ''],
    async () => { const f = scripted({ recordStart: { ok: true, recording_id: 'r' } }); await (await mutated()).createCapturePort(f).recordStart('s1', { maxFps: 15 }); return !Object.hasOwn(f.calls.recordStart[0], 'max_fps'); }],
  ['dropped_frames dropped from the stop result',
    ['...(hasDropped ? { dropped_frames: recording.dropped_frames } : {}),', ''],
    async () => { const r = await (await mutated()).createCapturePort(scripted({ recordStop: stopReply({ dropped_frames: 3 }) })).recordStop('rec-1'); return !Object.hasOwn(r.recording, 'dropped_frames'); }],
];
let cache = null;
async function mutated() { return cache; }
for (const [name, edit, detect] of MUTANTS) {
  test(`mutant caught (capturePort): ${name}`, async () => {
    cache = await importMutant('src/capture/capturePort.js', [edit]);
    assert.equal(await detect(), true, 'the mutant must show the regression');
    cache = await importMutant('src/capture/capturePort.js', []);
    assert.equal(await detect(), false, 'the faithful copy must not');
  });
}
