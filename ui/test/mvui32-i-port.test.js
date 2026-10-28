// MVUI32 lane I (R3-INPUT-1): input-port gate epoch unit tests — the REAL
// createInputPort with a recording facade, a fake clock and a saved-RAF
// double. closeGate must drop input buffered before the closure (never sent,
// never replayed, no refusal emitted) while fresh input dispatches normally.
// Plain node:test; no sleeps, no sockets, no Electron.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInputPort } from '../src/input/inputPort.js';
import { tick } from './frame-wait.mjs';

/** @returns {{ raf: (cb: (t: number) => void) => unknown, cancelRaf: () => void, fire: () => void, scheduled: boolean }} */
function makeSavedRaf() {
  /** @type {((t: number) => void) | null} */
  let cb = null;
  return {
    raf: (fn) => { cb = fn; return 1; },
    cancelRaf: () => { cb = null; },
    fire: () => { const f = cb; cb = null; if (f) f(0); },
    get scheduled() { return cb !== null; },
  };
}

/** @returns {{ calls: any[], send: (batch: any) => Promise<any> }} */
function makeFacade() {
  const calls = [];
  return {
    calls,
    send: (batch) => { calls.push(batch); return Promise.resolve({ ok: true, accepted: batch.events.length }); },
  };
}

const key = (keys = ['Return']) => ({ kind: 'key', keys });
const type = (text = 'a') => ({ kind: 'type', text });
const click = (x = 10, y = 20, button = 'left') => ({ kind: 'click', x, y, button });

describe('mvui32i input gate', () => {
  it('drops queued input closed before the RAF flush', () => {
    const facade = makeFacade();
    const frames = makeSavedRaf();
    const port = createInputPort(facade, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    try {
      port.queue('s', 1, key());
      port.queue('s', 1, type('x'));
      assert.equal(frames.scheduled, true);
      port.closeGate('s');
      frames.fire();
      assert.equal(facade.calls.length, 0, 'purged input is never sent');
    } finally {
      port.dispose();
    }
  });

  it('never replays purged input but dispatches fresh input normally', async () => {
    const facade = makeFacade();
    const frames = makeSavedRaf();
    const port = createInputPort(facade, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    try {
      port.queue('s', 1, type('stale'));
      port.closeGate('s');
      frames.fire();
      assert.equal(facade.calls.length, 0);
      frames.fire();
      await tick();
      assert.equal(facade.calls.length, 0, 'no replay on later frames');
      port.queue('s', 1, key(['Return']));
      frames.fire();
      await tick();
      assert.equal(facade.calls.length, 1, 'fresh input dispatches');
      assert.deepEqual(facade.calls[0].events, [key(['Return'])]);
      assert.equal(facade.calls[0].stream_id, 1);
    } finally {
      port.dispose();
    }
  });

  it('is per-surface: a sibling surface still dispatches', async () => {
    const facade = makeFacade();
    const frames = makeSavedRaf();
    const port = createInputPort(facade, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    try {
      port.queue('a', 1, type('doomed'));
      port.queue('b', 2, type('live'));
      port.closeGate('a');
      frames.fire();
      await tick();
      assert.equal(facade.calls.length, 1);
      assert.equal(facade.calls[0].surface_id, 'b');
      assert.deepEqual(facade.calls[0].events, [type('live')]);
    } finally {
      port.dispose();
    }
  });

  it('emits no refusal for purged input', async () => {
    const facade = makeFacade();
    const frames = makeSavedRaf();
    const port = createInputPort(facade, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    try {
      port.queue('s', 1, key());
      port.closeGate('s');
      frames.fire();
      await tick();
      assert.equal(facade.calls.length, 0);
      assert.equal(refusals.length, 0, 'gate-cancelled input is silent');
    } finally {
      port.dispose();
    }
  });

  it('drops later batches on a re-entrant gate closure mid-run', async () => {
    const calls = [];
    const frames = makeSavedRaf();
    const port = createInputPort({
      send: (batch) => {
        calls.push(batch);
        // Pathological facade: closes the gate while the first batch sends.
        port.closeGate('s');
        return Promise.resolve({ ok: true, accepted: batch.events.length });
      },
    }, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    try {
      for (let i = 0; i < 33; i += 1) port.queue('s', 1, click(i, 0));
      frames.fire();
      await tick();
      assert.equal(calls.length, 1, 'only the in-flight batch sends');
      assert.equal(calls[0].events.length, 32);
      frames.fire();
      await tick();
      assert.equal(calls.length, 1, 'the remainder never replays');
    } finally {
      port.dispose();
    }
  });

  it('leaves direct send unaffected', async () => {
    const facade = makeFacade();
    const port = createInputPort(facade);
    try {
      port.closeGate('s');
      const result = await port.send('s', 1, [click()]);
      assert.deepEqual(result, { ok: true, accepted: 1 });
      assert.equal(facade.calls.length, 1);
    } finally {
      port.dispose();
    }
  });

  it('negative: unknown, invalid and post-dispose closes are silent no-ops', async () => {
    const facade = makeFacade();
    const frames = makeSavedRaf();
    const port = createInputPort(facade, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    try {
      for (const bad of ['ghost', '', null, undefined, 42, {}, [], 'x'.repeat(257)]) {
        port.closeGate(bad);
      }
      port.queue('s', 1, key());
      frames.fire();
      await tick();
      assert.equal(facade.calls.length, 1, 'unrelated closes drop nothing');
      assert.equal(refusals.length, 0);
    } finally {
      port.dispose();
    }
    port.closeGate('s');
    assert.equal(facade.calls.length, 1, 'post-dispose close is a no-op');
  });

  it('negative: queued input without closeGate still dispatches', async () => {
    const facade = makeFacade();
    const frames = makeSavedRaf();
    const port = createInputPort(facade, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    try {
      port.queue('s', 1, type('a'));
      frames.fire();
      await tick();
      assert.equal(facade.calls.length, 1);
      assert.deepEqual(facade.calls[0].events, [type('a')]);
    } finally {
      port.dispose();
    }
  });

  it('keeps the frozen API with the pinned members', () => {
    const port = createInputPort(makeFacade());
    try {
      assert.equal(Object.isFrozen(port), true);
      assert.equal(port.available, true);
      assert.equal(typeof port.send, 'function');
      assert.equal(typeof port.queue, 'function');
      assert.equal(typeof port.closeGate, 'function');
      assert.equal(typeof port.onRefusal, 'function');
      assert.equal(typeof port.dispose, 'function');
    } finally {
      port.dispose();
    }
  });
});
