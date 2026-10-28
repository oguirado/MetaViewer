/**
 * MVUI25D lane P: safe-integer checks for surface_input/v1 coordinates.
 *
 * `isValidInputEvent` must enforce `Number.isSafeInteger` on click x/y and on
 * scroll dx/dy/x/y, like `isValidStreamId` already does for stream_id, so
 * unsafe integers (>= 2^53) are refused as SCHEMA before reaching the facade.
 * Each behaviour pairs the rejection with a boundary control at
 * `Number.MAX_SAFE_INTEGER` that must still be accepted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInputPort,
  isValidInputEvent,
} from '../src/input/inputPort.js';
import { createInputDouble } from '../src/input/inputDouble.js';
import { tick } from './frame-wait.mjs';

const UNSAFE = 2 ** 53;
const SAFE = Number.MAX_SAFE_INTEGER;

/** @returns {{ calls: any[], send: (batch: any) => Promise<any> }} */
function makeFacade() {
  const calls = [];
  return {
    calls,
    send: (batch) => { calls.push(batch); return Promise.resolve({ ok: true, accepted: 1 }); },
  };
}

/** @returns {{ raf: (cb: (t: number) => void) => unknown, cancelRaf: () => void, fire: () => void, scheduled: boolean }} */
function makeRaf() {
  /** @type {((t: number) => void) | null} */
  let cb = null;
  return {
    raf: (fn) => { cb = fn; return 1; },
    cancelRaf: () => { cb = null; },
    fire: () => { const f = cb; cb = null; if (f) f(0); },
    get scheduled() { return cb !== null; },
  };
}

describe('mvui25d port safe integers', () => {
  it('rejects 2^53 click/scroll coordinates as SCHEMA without touching the facade', async () => {
    const unsafeEvents = [
      { kind: 'click', x: UNSAFE, y: 1, button: 'left' },
      { kind: 'click', x: 1, y: UNSAFE, button: 'left' },
      { kind: 'scroll', dx: UNSAFE, dy: 0, x: 1, y: 1 },
      { kind: 'scroll', dx: 0, dy: UNSAFE, x: 1, y: 1 },
      { kind: 'scroll', dx: -UNSAFE, dy: 0, x: 1, y: 1 },
      { kind: 'scroll', dx: 0, dy: -UNSAFE, x: 1, y: 1 },
      { kind: 'scroll', dx: 0, dy: 0, x: UNSAFE, y: 1 },
      { kind: 'scroll', dx: 0, dy: 0, x: 1, y: UNSAFE },
    ];
    for (const ev of unsafeEvents) {
      assert.equal(isValidInputEvent(ev), false, JSON.stringify(ev));
    }
    const facade = makeFacade();
    const port = createInputPort(facade);
    for (const ev of unsafeEvents) {
      assert.deepEqual(await port.send('s', 1, [ev]), { ok: false, code: 'SCHEMA' }, JSON.stringify(ev));
    }
    // Parity control: stream_id already enforces safe integers.
    assert.deepEqual(
      await port.send('s', UNSAFE, [{ kind: 'click', x: 1, y: 1, button: 'left' }]),
      { ok: false, code: 'SCHEMA' },
    );
    assert.equal(facade.calls.length, 0);
    assert.equal(port.available, true);
    port.dispose();
  });

  it('accepts the MAX_SAFE_INTEGER boundary through the double', async () => {
    const dbl = createInputDouble();
    const port = createInputPort(dbl);
    const clickSafe = { kind: 'click', x: SAFE, y: SAFE, button: 'left' };
    const scrollSafe = { kind: 'scroll', dx: SAFE, dy: -SAFE, x: SAFE, y: SAFE };
    assert.equal(isValidInputEvent(clickSafe), true);
    assert.equal(isValidInputEvent(scrollSafe), true);
    assert.deepEqual(await port.send('s', 1, [clickSafe]), { ok: true, accepted: 1 });
    assert.deepEqual(await port.send('s', 1, [scrollSafe]), { ok: true, accepted: 1 });
    assert.deepEqual(await port.send('s', SAFE, [{ kind: 'click', x: 1, y: 1, button: 'left' }]),
      { ok: true, accepted: 1 });
    assert.equal(dbl.batches.length, 3);
    assert.deepEqual(dbl.batches[0].events, [clickSafe]);
    assert.deepEqual(dbl.batches[1].events, [scrollSafe]);
    assert.equal(dbl.batches[2].stream_id, SAFE);
    port.dispose();
  });

  it('refuses queued 2^53 events as SCHEMA while valid ones still flush', async () => {
    const dbl = createInputDouble();
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.queue('s', 1, { kind: 'click', x: UNSAFE, y: 1, button: 'left' });
    port.queue('s', 1, { kind: 'scroll', dx: UNSAFE, dy: 0, x: 1, y: 1 });
    assert.deepEqual(refusals.map((r) => r.code), ['SCHEMA', 'SCHEMA']);
    assert.equal(frames.scheduled, false);
    assert.equal(dbl.batches.length, 0);
    // Negative control: a safe event queued on the same port flushes normally.
    port.queue('s', 1, { kind: 'click', x: 1, y: 2, button: 'left' });
    assert.equal(frames.scheduled, true);
    frames.fire();
    await tick();
    assert.equal(dbl.batches.length, 1);
    assert.deepEqual(dbl.batches[0].events, [{ kind: 'click', x: 1, y: 2, button: 'left' }]);
    port.dispose();
  });
});
