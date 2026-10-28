/**
 * MVUI28 lane R: async input results reach the port refusal emitter, deduped.
 *
 * Covers the `onResult` subscription (exactly once, method receiver kept, one
 * argument), async-only refusals, reply/event dedup per (surface_id, seq) in
 * both orders, silent ok events, unchanged behaviour without `onResult`, a
 * throwing `onResult`, malformed events, dispose semantics and the bounded
 * dedup memory in `ui/src/input/inputPort.js`. Each behaviour pairs with a
 * negative control. Runs under the repository `node --test` gate with
 * recording facades, the results double and manual rAF only; no DOM is loaded.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INPUT_RESULT_DEDUP_LIMIT, createInputPort } from '../src/input/inputPort.js';
import { createInputDouble } from '../src/input/inputDouble.js';
import { tick, until } from './frame-wait.mjs';

const click = () => ({ kind: 'click', x: 1, y: 2, button: 'left' });

/** @returns {{ raf: (cb: (t: number) => void) => unknown, cancelRaf: () => void, fire: () => void }} */
function makeRaf() {
  /** @type {((t: number) => void) | null} */
  let cb = null;
  return {
    raf: (fn) => { cb = fn; return 1; },
    cancelRaf: () => { cb = null; },
    fire: () => { const f = cb; cb = null; if (f) f(0); },
  };
}

/**
 * Method-style facade with a controllable result stream. `reply` selects the
 * send outcome: null accepts, a code refuses, 'defer' waits for manual
 * settlement through `state.resolvers`.
 */
function makeResultFacade() {
  const state = { sends: [], listeners: [], resolvers: [], subCalls: 0, unsubs: 0 };
  const facade = {
    reply: null,
    send(batch) {
      state.sends.push(batch);
      if (this.reply === 'defer') return new Promise((resolve) => state.resolvers.push(resolve));
      if (typeof this.reply === 'string') return Promise.resolve({ ok: false, code: this.reply });
      return Promise.resolve({ ok: true, accepted: batch.events.length });
    },
    onResult(cb) {
      state.subCalls += 1;
      state.listeners.push(cb);
      return () => { state.unsubs += 1; };
    },
    emit(event) { for (const cb of state.listeners.slice()) cb(event); },
  };
  return { state, facade };
}

describe('mvui28 input results (lane R port)', () => {
  it('subscribes to onResult exactly once, as a method with one argument', () => {
    const seen = { calls: 0, argCounts: [] };
    const facade = {
      marker: 'mvui28',
      send: (batch) => Promise.resolve({ ok: true, accepted: batch.events.length }),
      onResult(cb) {
        assert.equal(this.marker, 'mvui28', 'facade receiver preserved');
        seen.calls += 1;
        seen.argCounts.push(arguments.length);
        assert.equal(typeof cb, 'function');
        return () => {};
      },
    };
    const port = createInputPort(facade);
    assert.equal(port.available, true);
    assert.equal(seen.calls, 1, 'exactly one subscription');
    assert.deepEqual(seen.argCounts, [1], 'exactly one function argument');
    port.dispose();
  });

  it('an async-only refusal reaches onRefusal after an ok send reply', async () => {
    const { facade } = makeResultFacade();
    const port = createInputPort(facade);
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    assert.deepEqual(await port.send('s', 1, [click()]), { ok: true, accepted: 1 });
    assert.deepEqual(refusals, [], 'the ok reply is silent');
    facade.emit(Object.freeze({ surface_id: 's', seq: 1, ok: false, code: 'LIMIT' }));
    assert.deepEqual(refusals, [{ surfaceId: 's', code: 'LIMIT' }]);
    port.dispose();
  });

  it('reply then event for the same seq emits exactly once', async () => {
    const { facade } = makeResultFacade();
    facade.reply = 'NOT_IN_CONTROL';
    const frames = makeRaf();
    const port = createInputPort(facade, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.queue('s', 1, click());
    frames.fire();
    await until(() => refusals.length >= 1, 'queued refusal');
    assert.deepEqual(refusals, [{ surfaceId: 's', code: 'NOT_IN_CONTROL' }]);
    facade.emit({ surface_id: 's', seq: 1, ok: false, code: 'NOT_IN_CONTROL' });
    await tick();
    assert.deepEqual(refusals, [{ surfaceId: 's', code: 'NOT_IN_CONTROL' }], 'the event copy is deduped');
    port.dispose();
  });

  it('event then reply for the same seq emits exactly once', async () => {
    const { state, facade } = makeResultFacade();
    facade.reply = 'defer';
    const frames = makeRaf();
    const port = createInputPort(facade, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.queue('s', 1, click());
    frames.fire();
    assert.equal(state.sends.length, 1, 'the batch left before the event');
    assert.equal(state.resolvers.length, 1);
    facade.emit({ surface_id: 's', seq: 1, ok: false, code: 'STALE_STREAM' });
    assert.deepEqual(refusals, [{ surfaceId: 's', code: 'STALE_STREAM' }], 'the event emits first');
    state.resolvers[0]({ ok: false, code: 'STALE_STREAM' });
    await tick();
    assert.deepEqual(refusals, [{ surfaceId: 's', code: 'STALE_STREAM' }], 'the reply copy is deduped');
    port.dispose();
  });

  it('control: distinct keys each emit; unknown keys emit too', async () => {
    const { facade } = makeResultFacade();
    facade.reply = 'LIMIT';
    const frames = makeRaf();
    const port = createInputPort(facade, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.queue('a', 1, click());
    port.queue('b', 1, click());
    frames.fire();
    await until(() => refusals.length >= 2, 'both queued refusals');
    assert.deepEqual(refusals, [
      { surfaceId: 'a', code: 'LIMIT' },
      { surfaceId: 'b', code: 'LIMIT' },
    ], 'same seq on another surface is not a duplicate');
    facade.emit({ surface_id: 'a', seq: 1, ok: false, code: 'LIMIT' });
    await tick();
    assert.equal(refusals.length, 2, 'the duplicate stays deduped');
    facade.emit({ surface_id: 'c', seq: 1, ok: false, code: 'LIMIT' });
    assert.equal(refusals.length, 3, 'an event for an unknown key still emits');
    port.dispose();
  });

  it('ok events are silent', async () => {
    const { facade } = makeResultFacade();
    const port = createInputPort(facade);
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    facade.emit({ surface_id: 's', seq: 1, ok: true, code: null });
    facade.emit({ surface_id: 'never-sent', seq: 7, ok: true, code: null });
    facade.emit({ surface_id: 's', seq: 2, ok: true, code: 'LIMIT' });
    await tick();
    assert.deepEqual(refusals, []);
    port.dispose();
  });

  it('control: an ok reply never suppresses a later async refusal', async () => {
    const { facade } = makeResultFacade();
    const frames = makeRaf();
    const port = createInputPort(facade, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.queue('s', 1, click());
    frames.fire();
    await tick();
    assert.deepEqual(refusals, [], 'the ok reply is silent');
    facade.emit({ surface_id: 's', seq: 1, ok: false, code: 'SURFACE_UNKNOWN' });
    assert.deepEqual(refusals, [{ surfaceId: 's', code: 'SURFACE_UNKNOWN' }]);
    port.dispose();
  });

  it('facades without onResult behave exactly as before', async () => {
    const dbl = createInputDouble({ refuse: 'NOT_IN_CONTROL' });
    assert.equal(typeof dbl.onResult, 'undefined', 'the default double carries no results');
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    assert.equal(port.available, true);
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.queue('s', 1, click());
    frames.fire();
    await until(() => refusals.length >= 1, 'queued refusal');
    assert.deepEqual(refusals, [{ surfaceId: 's', code: 'NOT_IN_CONTROL' }]);
    assert.deepEqual(await port.send('s', 1, [click()]), { ok: false, code: 'NOT_IN_CONTROL' });
    port.dispose();
    const bare = createInputPort({ send: (b) => Promise.resolve({ ok: true, accepted: b.events.length }) });
    assert.deepEqual(await bare.send('s', 1, [click()]), { ok: true, accepted: 1 });
    bare.dispose();
  });

  it('a throwing onResult leaves the port available', async () => {
    const facade = {
      send: (batch) => Promise.resolve({ ok: true, accepted: batch.events.length }),
      onResult() { throw new Error('host down'); },
    };
    let port = null;
    assert.doesNotThrow(() => { port = createInputPort(facade); }, 'subscribe throws mean "no results"');
    assert.equal(port.available, true);
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    assert.deepEqual(await port.send('s', 1, [click()]), { ok: true, accepted: 1 });
    assert.deepEqual(refusals, []);
    assert.doesNotThrow(() => port.dispose());
  });

  it('control: a non-function unsubscribe never breaks dispose', () => {
    const facade = {
      send: (batch) => Promise.resolve({ ok: true, accepted: batch.events.length }),
      onResult() { return 42; },
    };
    const port = createInputPort(facade);
    assert.doesNotThrow(() => { port.dispose(); port.dispose(); });
  });

  it('malformed events are ignored and never throw', async () => {
    const { facade } = makeResultFacade();
    const port = createInputPort(facade);
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    const evil = {};
    Object.defineProperty(evil, 'surface_id', {
      enumerable: true,
      get() { throw new Error('boom'); },
    });
    const bad = [
      null, undefined, 7, 'x', [], {},
      { surface_id: 's' },
      { surface_id: '', seq: 1, ok: false, code: 'LIMIT' },
      { surface_id: 's', seq: 0, ok: false, code: 'LIMIT' },
      { surface_id: 's', seq: 1.5, ok: false, code: 'LIMIT' },
      { surface_id: 's', seq: '1', ok: false, code: 'LIMIT' },
      { surface_id: 's', seq: 1 },
      { surface_id: 's', seq: 1, ok: 'false', code: 'LIMIT' },
      { surface_id: 's', seq: 1, ok: false },
      { surface_id: 's', seq: 1, ok: false, code: null },
      { surface_id: 's', seq: 1, ok: false, code: 'BOGUS' },
      { surface_id: 's', seq: 1, ok: false, code: 'INPUT_MODE_READ' },
      evil,
    ];
    for (const event of bad) {
      assert.doesNotThrow(() => facade.emit(event), `ignored without throwing: ${String(event)}`);
    }
    await tick();
    assert.deepEqual(refusals, [], 'no malformed event emits');
    facade.emit({ surface_id: 's', seq: 1, ok: false, code: 'LIMIT' });
    assert.deepEqual(refusals, [{ surfaceId: 's', code: 'LIMIT' }], 'the port still emits after the storm');
    port.dispose();
  });

  it('dispose unsubscribes once; late events stay silent', () => {
    const { state, facade } = makeResultFacade();
    const port = createInputPort(facade);
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.dispose();
    port.dispose();
    assert.equal(state.unsubs, 1, 'exactly one unsubscribe across a double dispose');
    const [listener] = state.listeners;
    assert.equal(typeof listener, 'function');
    assert.doesNotThrow(() => listener({ surface_id: 's', seq: 1, ok: false, code: 'LIMIT' }));
    assert.deepEqual(refusals, [], 'a late event after teardown stays silent');
  });

  it('control: a throwing unsubscribe never breaks dispose', () => {
    const facade = {
      send: (batch) => Promise.resolve({ ok: true, accepted: batch.events.length }),
      onResult() { return () => { throw new Error('unsub down'); }; },
    };
    const port = createInputPort(facade);
    assert.doesNotThrow(() => port.dispose());
  });

  it('the dedup memory keeps only the last 256 keys', () => {
    assert.equal(INPUT_RESULT_DEDUP_LIMIT, 256, 'the bound stays pinned');
    const { facade } = makeResultFacade();
    const port = createInputPort(facade);
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    const total = INPUT_RESULT_DEDUP_LIMIT + 44;
    for (let seq = 1; seq <= total; seq += 1) {
      facade.emit({ surface_id: 's', seq, ok: false, code: 'LIMIT' });
    }
    assert.equal(refusals.length, total, 'every fresh key emits');
    facade.emit({ surface_id: 's', seq: 45, ok: false, code: 'LIMIT' });
    assert.equal(refusals.length, total, 'the oldest kept key stays deduped');
    facade.emit({ surface_id: 's', seq: total, ok: false, code: 'LIMIT' });
    assert.equal(refusals.length, total, 'the newest key stays deduped');
    facade.emit({ surface_id: 's', seq: 44, ok: false, code: 'LIMIT' });
    assert.equal(refusals.length, total + 1, 'the evicted key emits again');
    port.dispose();
  });

  it('the port over the results double dedups the synchronous event and reply', async () => {
    const dbl = createInputDouble({ results: true, refuse: 'STALE_STREAM' });
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.queue('s', 1, click());
    frames.fire();
    await until(() => refusals.length >= 1, 'deduped refusal');
    await tick();
    assert.deepEqual(refusals, [{ surfaceId: 's', code: 'STALE_STREAM' }], 'event plus reply collapse to one');
    port.dispose();
  });

  it('control: the results double stays silent on the accept path', async () => {
    const dbl = createInputDouble({ results: true });
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.queue('s', 1, click());
    frames.fire();
    await tick();
    assert.equal(dbl.batches.length, 1, 'the batch settled');
    assert.deepEqual(refusals, [], 'ok reply plus ok event emit nothing');
    port.dispose();
  });
});
