/**
 * MVUI26 lane I: input-port regression tests for the RV10 input review.
 *
 * Covers input RV10-01 (facade receiver), RV10-02 (scroll safe-integer
 * guard), RV10-03 (surrogate-pair chunking), RV10-06 (send clone) and
 * MVVR10-NEW-01 (queue never throws) in `ui/src/input/inputPort.js`.
 * Each fix pairs the report's regression test with a negative control.
 * Runs under the repository `node --test` gate with recording facades,
 * the in-memory input double and manual rAF only; no DOM is loaded.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInputPort } from '../src/input/inputPort.js';
import { createInputDouble } from '../src/input/inputDouble.js';
import { tick } from './frame-wait.mjs';

const SAFE = Number.MAX_SAFE_INTEGER;

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

/**
 * Method-style facade: `send` reads receiver state, so an unbound
 * extraction fails with a TypeError mapped to CORE_UNAVAILABLE.
 * @returns {{ prefix: string, batches: any[], send: (batch: any) => Promise<any> }}
 */
function makeMethodFacade() {
  return {
    prefix: 'cap',
    batches: [],
    send(batch) {
      assert.equal(this.prefix, 'cap', 'facade receiver preserved');
      this.batches.push(batch);
      return Promise.resolve({ ok: true, accepted: batch.events.length });
    },
  };
}

describe('mvui26 input port fixes', () => {
  it('keeps facade receiver when sending', async () => {
    const facade = makeMethodFacade();
    const port = createInputPort(facade);
    assert.equal(port.available, true);
    const result = await port.send('s', 1, [{ kind: 'type', text: 'a' }]);
    assert.deepEqual(result, { ok: true, accepted: 1 });
    assert.equal(facade.batches.length, 1);
    assert.equal(facade.batches[0].surface_id, 's');
    port.dispose();
  });

  it('keeps facade receiver on the queued flush path', async () => {
    const facade = makeMethodFacade();
    const frames = makeRaf();
    const port = createInputPort(facade, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.queue('s', 1, { kind: 'click', x: 1, y: 2, button: 'left' });
    frames.fire();
    await tick();
    assert.deepEqual(refusals, []);
    assert.equal(facade.batches.length, 1);
    assert.deepEqual(facade.batches[0].events, [{ kind: 'click', x: 1, y: 2, button: 'left' }]);
    port.dispose();
  });

  it('control: closure facades and missing-send facades behave as before', async () => {
    const calls = [];
    const arrow = { send: (batch) => { calls.push(batch); return Promise.resolve({ ok: true, accepted: 1 }); } };
    const port = createInputPort(arrow);
    assert.deepEqual(await port.send('s', 1, [{ kind: 'type', text: 'a' }]), { ok: true, accepted: 1 });
    assert.equal(calls.length, 1);
    port.dispose();
    const closed = createInputPort({});
    assert.equal(closed.available, false);
    assert.deepEqual(await closed.send('s', 1, [{ kind: 'type', text: 'a' }]), {
      ok: false, code: 'CORE_UNAVAILABLE',
    });
    closed.dispose();
  });

  it('keeps coalesced scroll deltas within safe integers', async () => {
    const dbl = createInputDouble();
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.queue('s', 1, { kind: 'scroll', dx: SAFE, dy: 0, x: 5, y: 6 });
    port.queue('s', 1, { kind: 'scroll', dx: 1, dy: 0, x: 5, y: 6 });
    frames.fire();
    await tick();
    assert.deepEqual(refusals, [], 'no SCHEMA refusal for the unsafe sum');
    assert.equal(dbl.batches.length, 1);
    assert.equal(dbl.batches[0].events.length, 2);
    assert.equal(dbl.batches[0].events[0].dx, SAFE);
    assert.equal(dbl.batches[0].events[1].dx, 1);
    port.dispose();
  });

  it('keeps coalesced scroll dy within safe integers', async () => {
    const dbl = createInputDouble();
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.queue('s', 1, { kind: 'scroll', dx: 0, dy: SAFE, x: 5, y: 6 });
    port.queue('s', 1, { kind: 'scroll', dx: 0, dy: 1, x: 5, y: 6 });
    frames.fire();
    await tick();
    assert.deepEqual(refusals, []);
    assert.equal(dbl.batches.length, 1);
    assert.deepEqual(
      dbl.batches[0].events.map((e) => e.dy),
      [SAFE, 1],
    );
    port.dispose();
  });

  it('control: small scrolls still coalesce to the latest position', async () => {
    const dbl = createInputDouble();
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    port.queue('s', 1, { kind: 'scroll', dx: 3, dy: -2, x: 10, y: 20 });
    port.queue('s', 1, { kind: 'scroll', dx: 4, dy: 5, x: 11, y: 21 });
    frames.fire();
    await tick();
    assert.equal(dbl.batches.length, 1);
    assert.deepEqual(dbl.batches[0].events, [{ kind: 'scroll', dx: 7, dy: 3, x: 11, y: 21 }]);
    port.dispose();
  });

  it('never splits surrogate pairs when chunking type text', async () => {
    const dbl = createInputDouble();
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    port.queue('s', 1, { kind: 'type', text: 'a'.repeat(1023) });
    port.queue('s', 1, { kind: 'type', text: '😀' });
    frames.fire();
    await tick();
    assert.equal(dbl.batches.length, 1);
    const events = dbl.batches[0].events;
    assert.equal(events.length, 2);
    assert.equal(events[0].text, 'a'.repeat(1023));
    assert.equal(events[1].text, '😀');
    const unpaired = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    for (const ev of events) {
      assert.doesNotMatch(ev.text, unpaired, 'no chunk carries a lone surrogate');
    }
    port.dispose();
  });

  it('control: BMP-only text still splits at 1024 with a full round-trip', async () => {
    const dbl = createInputDouble();
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const word = `${'a'.repeat(1024)}${'b'.repeat(1024)}cc`;
    port.queue('s', 1, { kind: 'type', text: 'a'.repeat(1024) });
    port.queue('s', 1, { kind: 'type', text: 'b'.repeat(1024) });
    port.queue('s', 1, { kind: 'type', text: 'cc' });
    frames.fire();
    await tick();
    assert.equal(dbl.batches.length, 1);
    const events = dbl.batches[0].events;
    assert.deepEqual(events.map((e) => e.text.length), [1024, 1024, 2]);
    assert.equal(events.map((e) => e.text).join(''), word);
    port.dispose();
  });

  it('detaches send() events from caller mutation', async () => {
    const facade = {
      seenKeys: null,
      async send(batch) {
        await Promise.resolve();
        await Promise.resolve();
        this.seenKeys = batch.events[0].keys.slice();
        return { ok: true, accepted: 1 };
      },
    };
    const port = createInputPort(facade);
    const ev = { kind: 'key', keys: ['ctrl', 'c'] };
    const pending = port.send('s', 1, [ev]);
    ev.keys.push('INJECTED');
    const result = await pending;
    assert.deepEqual(result, { ok: true, accepted: 1 });
    assert.deepEqual(facade.seenKeys, ['ctrl', 'c']);
    port.dispose();
  });

  it('control: send() still delivers the original chord content', async () => {
    const dbl = createInputDouble();
    const port = createInputPort(dbl);
    const result = await port.send('s', 1, [{ kind: 'key', keys: ['ctrl', 'c'] }]);
    assert.deepEqual(result, { ok: true, accepted: 1 });
    assert.deepEqual(dbl.batches[0].events, [{ kind: 'key', keys: ['ctrl', 'c'] }]);
    port.dispose();
  });

  it('queue() never throws on hostile input', () => {
    const frames = makeRaf();
    const dbl = createInputDouble();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    const evil = {};
    Object.defineProperty(evil, 'kind', {
      enumerable: true,
      get() { throw new Error('boom'); },
    });
    assert.doesNotThrow(() => port.queue('s', 1, evil));
    assert.deepEqual(refusals, [{ surfaceId: 's', code: 'SCHEMA' }]);
    assert.equal(frames.scheduled, false);
    port.dispose();
  });

  it('control: the port still queues valid events after a hostile one', async () => {
    const frames = makeRaf();
    const dbl = createInputDouble();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    const evil = {};
    Object.defineProperty(evil, 'kind', {
      enumerable: true,
      get() { throw new Error('boom'); },
    });
    port.queue('s', 1, evil);
    port.queue('s', 1, { kind: 'click', x: 1, y: 2, button: 'left' });
    frames.fire();
    await tick();
    assert.deepEqual(refusals, [{ surfaceId: 's', code: 'SCHEMA' }]);
    assert.equal(dbl.batches.length, 1);
    assert.deepEqual(dbl.batches[0].events, [{ kind: 'click', x: 1, y: 2, button: 'left' }]);
    port.dispose();
  });
});
