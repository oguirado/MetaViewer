// CAP-FIX: capture seam between the Rust core, hostBindings, the main-side
// captureBridge and the renderer preload facade.
// Incident class: the core replied with a 7-key recording (dropped_frames) and
// with BUDGET_EXCEEDED/POLICY refusals; the closed asserts threw, and the host
// connection shut down instead of returning a typed reply.
// Every guard has a mutant (importMutant) that the probes must catch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPreloadFacade, ContractError } from '../electron/preload.js';
import * as bridge from '../electron/captureBridge.js';
import { coreRefusalCodes, coreStopRecordingKeys, importMutant } from './capfix-helpers.mjs';

const DIGEST = 'b'.repeat(64);
const REQ = { schema: 'capture_request/v1', request_id: 'req-1', surface_id: 'surface-demo', mode: 'ai' };

/** Reply the core builds on ram_stop, from the keys scraped out of the Rust source. */
function coreStopReply(overrides = {}) {
  const values = { id: 'rec-1', surface_id: 'surface-demo', frames: 5, dropped_frames: 2, duration_ms: 1800, sealed: true, sha256: DIGEST };
  const recording = {};
  for (const key of coreStopRecordingKeys()) recording[key] = values[key];
  return { ok: true, recording: { ...recording, ...overrides } };
}

/** Preload-side facade over a canned transport reply. */
function preloadCapture(reply) {
  return createPreloadFacade({
    transport: { invoke: async () => reply, subscribe: () => () => {}, nested: false },
    bridge: { exposeInMainWorld() {} },
  }).capture;
}

/**
 * Probe one assert implementation. Returns the names of violated properties,
 * so the faithful module yields [] and each mutant must yield its own name.
 * @param {{assertCaptureReply:Function,assertCaptureCall:Function}} m
 */
function probe(m) {
  const failed = [];
  const accepts = (fn) => { try { fn(); return true; } catch (e) { if (e instanceof ContractError) return false; throw e; } };
  const check = (name, ok) => { if (!ok) failed.push(name); };
  check('stop-accepts-core-7-key', accepts(() => m.assertCaptureReply('recordStop', coreStopReply())));
  const six = coreStopReply(); delete six.recording.dropped_frames;
  check('stop-accepts-legacy-6-key', accepts(() => m.assertCaptureReply('recordStop', six)));
  for (const bad of [-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 2]) {
    check(`stop-rejects-dropped-${String(bad)}`, !accepts(() => m.assertCaptureReply('recordStop', coreStopReply({ dropped_frames: bad }))));
  }
  check('stop-rejects-extra-key', !accepts(() => m.assertCaptureReply('recordStop', coreStopReply({ path: '/secret' }))));
  for (const code of coreRefusalCodes()) {
    check(`refusal-${code}`, accepts(() => m.assertCaptureReply('recordStart', { ok: false, code, request_id: 'req-1' }, 'req-1')));
  }
  check('refusal-unknown-rejected', !accepts(() => m.assertCaptureReply('recordStart', { ok: false, code: 'OTHER', request_id: 'req-1' }, 'req-1')));
  for (const fps of [1, 3, 30, 60]) check(`start-fps-${fps}`, accepts(() => m.assertCaptureCall('recordStart', [{ ...REQ, max_fps: fps }])));
  for (const fps of [0, 61, -1, 2.5, '3', NaN, null, true, Infinity]) {
    check(`start-fps-rejects-${String(fps)}`, !accepts(() => m.assertCaptureCall('recordStart', [{ ...REQ, max_fps: fps }])));
  }
  check('start-legacy-shape', accepts(() => m.assertCaptureCall('recordStart', [REQ])));
  check('start-rejects-unknown-key', !accepts(() => m.assertCaptureCall('recordStart', [{ ...REQ, max_fps: 3, extra: 1 }])));
  check('stop-call-rejects-fps', !accepts(() => m.assertCaptureCall('recordStop', [{ schema: REQ.schema, request_id: 'r', recording_id: 'rec-1', max_fps: 3 }])));
  check('screenshot-rejects-fps', !accepts(() => m.assertCaptureCall('screenshot', [{ schema: REQ.schema, request_id: 'r', surface_id: 's1', max_fps: 3 }])));
  return failed;
}

test('probe is clean on the real captureBridge', () => {
  assert.deepEqual(probe(bridge), []);
});

test('core drift guard: scraped Rust shapes are what the probe assumes', () => {
  assert.deepEqual(coreStopRecordingKeys(),
    ['dropped_frames', 'duration_ms', 'frames', 'id', 'sealed', 'sha256', 'surface_id']);
  const codes = coreRefusalCodes();
  for (const required of ['BUDGET_EXCEEDED', 'POLICY', 'LIMIT', 'CAPTURE_UNAVAILABLE', 'DESTINATION_UNSET', 'DESTINATION_UNAVAILABLE', 'NOT_SEALED']) {
    assert.ok(codes.includes(required), `core emits ${required}`);
  }
});

test('hostBindings validates the wire reply with the captureBridge assert (one seam)', () => {
  const host = readFileSync(fileURLToPath(new URL('../electron/hostBindings.js', import.meta.url)), 'utf8');
  assert.match(host, /import\s*\{[^}]*\bassertCaptureReply\b[^}]*\}\s*from\s*'\.\/captureBridge\.js'/);
  assert.match(host, /assertCaptureReply\(value\.method,value\.reply,value\.request_id\)/);
});

test('preload facade resolves the core 7-key stop reply and every core refusal (never a thrown OUTCOME)', async () => {
  const stop = coreStopReply();
  assert.deepEqual(await preloadCapture(stop).recordStop({ schema: REQ.schema, request_id: 'req-1', recording_id: 'rec-1' }), stop);
  for (const code of coreRefusalCodes()) {
    const refusal = { ok: false, code, request_id: 'req-1' };
    assert.deepEqual(await preloadCapture(refusal).recordStart(REQ), refusal, code);
  }
});

test('preload and captureBridge admit the same recordStart/export fps requests', () => {
  const inputs = [1, 3, 60, 0, 61, 2.5, '3', NaN, null, true, undefined];
  for (const fps of inputs) {
    for (const method of ['recordStart', 'export']) {
      const request = method === 'export'
        ? { schema: REQ.schema, request_id: 'r', capture_id: 'rec-1', destination: 'recording:configured', max_fps: fps }
        : { ...REQ, max_fps: fps };
      let bridgeOk = true;
      try { bridge.assertCaptureCall(method, [request]); } catch (e) { assert.ok(e instanceof ContractError); bridgeOk = false; }
      let preloadOk = true;
      try { preloadCapture({ ok: true })[method](request).catch(() => {}); } catch (e) { assert.ok(e instanceof ContractError); preloadOk = false; }
      assert.equal(bridgeOk, preloadOk, `${method} max_fps=${String(fps)}`);
    }
  }
});

test('main-side handler forwards max_fps to the core request and returns the 7-key stop and typed refusals', async () => {
  const handlers = new Map();
  const frame = { url: 'app://metaviewer/index.html', origin: 'app://metaviewer' };
  const contents = { id: 1, mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false };
  const seen = [];
  const replies = [coreStopReply(), { ok: false, code: 'BUDGET_EXCEEDED', request_id: 'req-1' }, { ok: false, code: 'POLICY', request_id: 'req-1' }];
  const core = { request: async (message) => { seen.push(message); return replies.shift(); } };
  const installed = bridge.installCaptureBridge({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) },
    contents, core, nested: false,
  });
  const event = { sender: contents, senderFrame: frame };
  const call = (suffix, request) => handlers.get(`metaviewer:${suffix}`)(event, request);
  const stop = await call('capture.record.stop', { schema: REQ.schema, request_id: 'req-1', recording_id: 'rec-1' });
  assert.equal(stop.ok, true);
  assert.equal(stop.recording.dropped_frames, 2);
  const budget = await call('capture.record.start', { ...REQ, max_fps: 15 });
  assert.deepEqual(budget, { ok: false, code: 'BUDGET_EXCEEDED', request_id: 'req-1' });
  assert.equal(seen[1].request.max_fps, 15, 'max_fps reaches the host binding');
  const policy = await call('capture.record.start', REQ);
  assert.deepEqual(policy, { ok: false, code: 'POLICY', request_id: 'req-1' });
  assert.equal(Object.hasOwn(seen[2].request, 'max_fps'), false, 'absent choice stays absent');
  await assert.rejects(() => call('capture.record.start', { ...REQ, max_fps: 61 }), ContractError);
  await installed.dispose();
});

// Negative controls: each guard removed in a faithful copy must be caught.
const MUTANTS = [
  ['refusal codes BUDGET_EXCEEDED/POLICY removed', "'BUDGET_EXCEEDED','POLICY']);", "]);", 'refusal-BUDGET_EXCEEDED'],
  ['7-key stop reply no longer admitted', "|| captureKeys(v.recording,`dropped_frames,${stopKeys}`)", '', 'stop-accepts-core-7-key'],
  ['dropped_frames value unchecked', "&& (!Object.hasOwn(r,'dropped_frames') || captureNumber(r.dropped_frames))", '', 'stop-rejects-dropped--1'],
  ['max_fps key shape removed', "const hasFps=keysWithFps!==null && captureKeys(v,keysWithFps);", 'const hasFps=false;', 'start-fps-30'],
  ['max_fps upper bound removed', "v.max_fps<1 || v.max_fps>60", 'v.max_fps<1', 'start-fps-rejects-61'],
  ['max_fps lower bound removed', "v.max_fps<1 || v.max_fps>60", 'v.max_fps>60', 'start-fps-rejects-0'],
  ['max_fps integer check removed', "!Number.isSafeInteger(v.max_fps) || ", '', 'start-fps-rejects-2.5'],
];
for (const [name, from, to, expected] of MUTANTS) {
  test(`mutant caught (captureBridge): ${name}`, async () => {
    const mutant = await importMutant('electron/captureBridge.js', [[from, to]]);
    const failed = probe(mutant);
    assert.ok(failed.includes(expected), `${expected} not reported; got ${JSON.stringify(failed)}`);
  });
}

// The preload copy of the same asserts is mutated through the facade.
const PRELOAD_MUTANTS = [
  ['refusal codes BUDGET_EXCEEDED/POLICY removed', "'BUDGET_EXCEEDED','POLICY']);", "]);"],
  ['7-key stop reply no longer admitted', "|| captureKeys(v.recording,`dropped_frames,${stopKeys}`)", ''],
];
for (const [name, from, to] of PRELOAD_MUTANTS) {
  test(`mutant caught (preload): ${name}`, async () => {
    const mutant = await importMutant('electron/preload.js', [[from, to]]);
    const capture = mutant.createPreloadFacade({
      transport: { invoke: async () => (name.startsWith('refusal') ? { ok: false, code: 'BUDGET_EXCEEDED', request_id: 'req-1' } : coreStopReply()), subscribe: () => () => {}, nested: false },
      bridge: { exposeInMainWorld() {} },
    }).capture;
    const call = name.startsWith('refusal')
      ? capture.recordStart(REQ)
      : capture.recordStop({ schema: REQ.schema, request_id: 'req-1', recording_id: 'rec-1' });
    await assert.rejects(() => call, (e) => e.name === 'ContractError' || e.code === 'OUTCOME');
  });
}
