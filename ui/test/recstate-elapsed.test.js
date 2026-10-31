// REC-STATE: the reactive elapsed composable keeps ticking between sparse host
// events, stops with the recording, and cleans up. Mutants prove each guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as vue from 'vue';
import * as real from '../src/recording/useRecordingElapsed.js';
import { fakeClock, mutantMustFail, mutantModule } from './recstate-helpers.mjs';

async function checkElapsed(mod) {
  // not recording: host value only, no timer
  {
    const clock = fakeClock();
    const sample = vue.reactive({ phase: 'idle', elapsedMs: 4200 });
    const scope = vue.effectScope();
    const ms = scope.run(() => mod.useRecordingElapsed(() => sample, () => clock));
    assert.equal(ms.value, 4200);
    assert.equal(clock.state.started, 0, 'no timer while idle');
    sample.elapsedMs = undefined;
    assert.equal(ms.value, null);
    scope.stop();
  }
  // recording: interpolates between events, re-anchors on events, stops cleanly
  {
    const clock = fakeClock(10_000);
    const sample = vue.reactive({ phase: 'recording', elapsedMs: 5000 });
    const scope = vue.effectScope();
    const ms = scope.run(() => mod.useRecordingElapsed(() => sample, () => clock));
    assert.equal(clock.active, 1, 'one timer while recording');
    assert.equal(ms.value, 5000);
    clock.advance(1000);
    assert.equal(ms.value, 6000, 'ticks with no host event');
    clock.advance(2000);
    assert.equal(ms.value, 8000);
    sample.elapsedMs = 9000; // host event ahead of the local estimate
    assert.equal(ms.value, 9000, 'host sample re-anchors forward');
    clock.advance(1000);
    assert.equal(ms.value, 10000);
    sample.elapsedMs = 10_400; // host 400 ms ahead of the estimate
    assert.equal(ms.value, 10_400);
    clock.advance(1000);
    assert.equal(ms.value, 11_400);
    sample.elapsedMs = 11_000; // host 400 ms behind: hold, never rewind
    assert.equal(ms.value, 11_400, 'jitter does not rewind the readout');
    sample.phase = 'stopping';
    assert.equal(clock.active, 0, 'timer cleared when the phase leaves recording');
    assert.equal(ms.value, 11_000, 'non-recording shows the host value');
    clock.advance(5000);
    assert.equal(ms.value, 11_000, 'frozen after stop');
    sample.phase = 'idle'; sample.elapsedMs = 0;
    assert.equal(ms.value, 0);
    sample.phase = 'recording'; sample.elapsedMs = 0; // new recording restarts from the host
    assert.equal(clock.active, 1);
    clock.advance(2000);
    assert.equal(ms.value, 2000);
    sample.elapsedMs = undefined; // unknown elapsed: never a fabricated zero
    assert.equal(ms.value, null);
    scope.stop();
    assert.equal(clock.active, 0, 'scope disposal clears the timer');
  }
  // two controllers do not share a timer
  {
    const clock = fakeClock();
    const a = vue.reactive({ phase: 'recording', elapsedMs: 0 });
    const b = vue.reactive({ phase: 'idle', elapsedMs: 0 });
    const scope = vue.effectScope();
    const [ma, mb] = scope.run(() => [
      mod.useRecordingElapsed(() => a, () => clock),
      mod.useRecordingElapsed(() => b, () => clock),
    ]);
    clock.advance(3000);
    assert.equal(ma.value, 3000);
    assert.equal(mb.value, 0);
    assert.equal(clock.active, 1);
    scope.stop();
  }
}

test('useRecordingElapsed: ticks between events, re-anchors, stops, cleans up', () => checkElapsed(real));

test('useRecordingElapsed: default platform timers start and stop cleanly', async () => {
  const sample = vue.reactive({ phase: 'recording', elapsedMs: 0 });
  const scope = vue.effectScope();
  const ms = scope.run(() => real.useRecordingElapsed(() => sample));
  assert.equal(ms.value, 0);
  scope.stop();
});

const MUTANTS = [
  ['never start the ticker', [['    startTimer();\n      } else {', '    } else {']]],
  ['ticker never advances the display', [['handle = clock.setInterval(() => { tick.value = clock.now(); }, clock.tickMs);', 'handle = clock.setInterval(() => {}, clock.tickMs);']]],
  ['ticker reads the wall clock', [['handle = clock.setInterval(() => { tick.value = clock.now(); }, clock.tickMs);', 'handle = clock.setInterval(() => { tick.value = Date.now(); }, clock.tickMs);']]],
  ['keep the timer after the recording ends', [['        anchor.value = null;\n        stopTimer();', '        anchor.value = null;']]],
  ['leak the timer on scope disposal', [['if (getCurrentScope()) onScopeDispose(stopTimer);', '']]],
  ['ignore the host sample (hard-coded zero)', [['anchor.value = anchorElapsed(anchor.value, sample.elapsedMs, nowMs);', 'anchor.value = anchorElapsed(anchor.value, 0, nowMs);']]],
  ['render store events only (freeze at the anchor)', [['anchor.value = anchorElapsed(anchor.value, sample.elapsedMs, nowMs);', 'anchor.value = anchorElapsed(null, sample.elapsedMs, 0);']]],
  ['do not stamp the event time', [['const nowMs = clock.now();\n      tick.value = nowMs;', 'const nowMs = 0;\n      tick.value = nowMs;']]],
];
for (const [label, edits] of MUTANTS) {
  test(`elapsed mutant must fail: ${label}`, async (t) => {
    const mutant = mutantModule('src/recording/useRecordingElapsed.js', edits);
    t.after(mutant.cleanup);
    const mod = await import(`${mutant.href}#${label}`);
    await mutantMustFail(() => checkElapsed(mod), label);
  });
}
