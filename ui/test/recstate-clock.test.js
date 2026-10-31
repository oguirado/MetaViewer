// REC-STATE: pure clock model (interpolation between sparse host events,
// jitter hold, never a fabricated zero) with mutants. Source rate evidence:
// live tile ~2 fps [MEASURED, operator P8.1 log: capture_p50 318-567 ms].
import test from 'node:test';
import assert from 'node:assert/strict';
import * as clock from '../src/recording/recordingClock.js';
import { MV_RECORD_FPS_HINT } from '../src/recording/recordingModel.js';
import { importMutant, mutantMustFail } from './recstate-helpers.mjs';

function checkClock(m) {
  // interpolation from the last host sample
  assert.equal(m.liveElapsedMs(null, 5), null);
  assert.equal(m.liveElapsedMs(undefined, 5), null);
  assert.equal(m.liveElapsedMs({ baseMs: 5000, atMs: 100 }, 100), 5000);
  assert.equal(m.liveElapsedMs({ baseMs: 5000, atMs: 100 }, 3100), 8000);
  assert.equal(m.liveElapsedMs({ baseMs: 5000, atMs: 100 }, 50), 5000, 'local time never runs backwards');
  assert.equal(m.liveElapsedMs({ baseMs: -1, atMs: 0 }, 10), null);
  assert.equal(m.liveElapsedMs({ baseMs: 1, atMs: 0 }, NaN), null);
  // anchoring
  assert.equal(m.anchorElapsed(null, undefined, 10), null);
  assert.equal(m.anchorElapsed(null, -5, 10), null);
  assert.equal(m.anchorElapsed(null, NaN, 10), null);
  assert.equal(m.anchorElapsed(null, '5', 10), null);
  assert.deepEqual({ ...m.anchorElapsed(null, 0, 10) }, { baseMs: 0, atMs: 10 });
  const first = m.anchorElapsed(null, 5000, 0);
  // host a little behind the interpolated value (500 ms): hold, no rewind
  assert.deepEqual({ ...m.anchorElapsed(first, 5500, 1000) }, { baseMs: 6000, atMs: 1000 });
  // host far behind (a new recording): trust the host
  assert.deepEqual({ ...m.anchorElapsed(first, 100, 9000) }, { baseMs: 100, atMs: 9000 });
  // host ahead: trust the host
  assert.deepEqual({ ...m.anchorElapsed(first, 9000, 1000) }, { baseMs: 9000, atMs: 1000 });
  // display
  assert.equal(m.displayElapsedMs({ phase: 'recording', elapsedMs: 1 }, first, 2000), 7000);
  assert.equal(m.displayElapsedMs({ phase: 'recording', elapsedMs: 1 }, null, 2000), null);
  assert.equal(m.displayElapsedMs({ phase: 'idle', elapsedMs: 4200 }, first, 2000), 4200);
  assert.equal(m.displayElapsedMs({ phase: 'sealed', elapsedMs: undefined }, first, 2000), null);
  assert.equal(m.displayElapsedMs({ phase: 'idle', elapsedMs: -3 }, null, 2000), null);
  // formatting
  assert.equal(m.formatElapsedClock(0), '00:00');
  assert.equal(m.formatElapsedClock(999), '00:00');
  assert.equal(m.formatElapsedClock(59999), '00:59');
  assert.equal(m.formatElapsedClock(125000), '02:05');
  assert.equal(m.formatElapsedClock(3600000), '60:00');
  for (const bad of [null, undefined, -1, NaN, Infinity, '5', {}]) assert.equal(m.formatElapsedClock(bad), '--:--', String(bad));
}

test('clock model: interpolation, anchoring, jitter hold, unknown stays --:--', () => checkClock(clock));

test('clock constants: 1 s tick, 1 s jitter hold, honest measured-rate note', () => {
  assert.equal(clock.MV_ELAPSED_TICK_MS, 1000);
  assert.equal(clock.MV_ELAPSED_JITTER_MS, 1000);
  assert.equal(clock.MV_ELAPSED_UNKNOWN, '--:--');
  assert.match(clock.MV_RECORD_SOURCE_RATE_NOTE, /about 2 frames per second/);
  assert.match(clock.MV_RECORD_SOURCE_RATE_NOTE, /318 to 567 ms/);
  assert.match(MV_RECORD_FPS_HINT, /up to the source rate/, 'the CAP-FIX hint is kept');
  assert.doesNotMatch(MV_RECORD_FPS_HINT, /\d/, 'the CAP-FIX hint still quotes no number');
});

const MUTANTS = [
  ['freeze: ignore elapsed local time', [['return anchor.baseMs + Math.max(0, nowMs - anchor.atMs);', 'return anchor.baseMs;']]],
  ['wall clock instead of the local delta', [['Math.max(0, nowMs - anchor.atMs)', 'Math.max(0, Date.now() - anchor.atMs)']]],
  ['allow time to run backwards', [['Math.max(0, nowMs - anchor.atMs)', '(nowMs - anchor.atMs)']]],
  ['accept negative host elapsed', [['Number.isFinite(value) && value >= 0', 'Number.isFinite(value)']]],
  ['hard-code a zero readout when unknown', [['if (!isHostElapsedMs(ms)) return MV_ELAPSED_UNKNOWN;', 'if (!isHostElapsedMs(ms)) return "00:00";']]],
  ['drop the jitter hold', [['lag > 0 && lag <= MV_ELAPSED_JITTER_MS', 'false']]],
  ['hold forever (never trust a far-behind host)', [['lag > 0 && lag <= MV_ELAPSED_JITTER_MS', 'lag > 0']]],
  ['recording reads the stale host value', [["if (sample.phase === 'recording') return liveElapsedMs(anchor, nowMs);", "if (sample.phase === 'recording') return sample.elapsedMs;"]]],
  ['ceil instead of floor', [['Math.floor(/** @type {number} */ (ms) / 1000)', 'Math.ceil(/** @type {number} */ (ms) / 1000)']]],
];
for (const [label, edits] of MUTANTS) {
  test(`clock mutant must fail: ${label}`, async () => {
    const mutant = await importMutant('src/recording/recordingClock.js', edits);
    await mutantMustFail(() => checkClock(mutant), label);
  });
}
