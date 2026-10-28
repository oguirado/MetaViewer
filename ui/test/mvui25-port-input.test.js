/**
 * Tests for the surface_input/v1 renderer port (`ui/src/input/inputPort.js`).
 *
 * Runs under the repository `node --test` gate with the in-memory input double,
 * recording facades, fake clocks and manual rAF only; no DOM or Electron runtime
 * is loaded. Each behaviour pairs a positive witness with a negative control that
 * must fail: refused sends never reach the facade (zero recorded batches), a
 * seq-reusing mutant is caught by the double, and contract-violating facades
 * (malformed replies, permissive accepts) still surface as typed refusals.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  INPUT_LIMITS,
  INPUT_REFUSALS,
  INPUT_SCHEMA,
  createInputPort,
} from '../src/input/inputPort.js';
import { createInputDouble } from '../src/input/inputDouble.js';
import { tick, until } from './frame-wait.mjs';

/** @returns {{ now: () => number, advance: (ms: number) => void }} */
function makeNow(start = 1000000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
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

const click = (x = 10, y = 20, button = 'left') => ({ kind: 'click', x, y, button });
const key = (keys = ['Return']) => ({ kind: 'key', keys });
const type = (text = 'a') => ({ kind: 'type', text });
const scroll = (dx = 1, dy = 2, x = 5, y = 6) => ({ kind: 'scroll', dx, dy, x, y });

/**
 * @param {...unknown} args
 * @returns {{ calls: any[], send: (batch: any) => Promise<any> }}
 */
function makeFacade(...args) {
  const reply = args.length === 0 ? { ok: true, accepted: 1 } : args[0];
  const calls = [];
  return {
    calls,
    send: (batch) => { calls.push(batch); return Promise.resolve(reply); },
  };
}

describe('mvui25 input port', () => {
  it('exposes the frozen API with the closed refusal set', () => {
    const port = createInputPort(makeFacade());
    assert.equal(Object.isFrozen(port), true);
    assert.equal(port.available, true);
    assert.deepEqual([...INPUT_REFUSALS], [
      'NOT_IN_CONTROL',
      'INPUT_MODE_READ',
      'SURFACE_UNKNOWN',
      'STALE_STREAM',
      'LIMIT',
      'NESTED_DISPLAY_ONLY',
      'SCHEMA',
      'CORE_UNAVAILABLE',
    ]);
    assert.equal(INPUT_SCHEMA, 'surface_input/v1');
    assert.equal(INPUT_LIMITS.MAX_EVENTS_PER_BATCH, 32);
    assert.equal(INPUT_LIMITS.MAX_PAYLOAD_BYTES, 16384);
    assert.equal(INPUT_LIMITS.MAX_BATCHES_PER_SECOND, 60);
    port.dispose();
  });

  it('reports unavailable without a facade and never rejects', async () => {
    for (const facade of [undefined, null, {}, { send: 42 }]) {
      const port = createInputPort(facade);
      assert.equal(port.available, false);
      const result = await port.send('s', 1, [click()]);
      assert.deepEqual(result, { ok: false, code: 'CORE_UNAVAILABLE' });
      port.dispose();
    }
  });

  it('sends one well-formed batch through the double', async () => {
    const dbl = createInputDouble();
    const port = createInputPort(dbl);
    const result = await port.send('capsule-A', 3, [click(4, 5), key(['ctrl', 'l'])]);
    assert.deepEqual(result, { ok: true, accepted: 2 });
    assert.equal(dbl.batches.length, 1);
    assert.deepEqual(dbl.batches[0], {
      schema: 'surface_input/v1',
      surface_id: 'capsule-A',
      stream_id: 3,
      seq: 1,
      events: [click(4, 5), key(['ctrl', 'l'])],
    });
    port.dispose();
  });

  it('passes every closed host refusal through send', async () => {
    for (const code of INPUT_REFUSALS) {
      const port = createInputPort(makeFacade({ ok: false, code }));
      const result = await port.send('s', 1, [click()]);
      assert.deepEqual(result, { ok: false, code });
      port.dispose();
    }
  });

  it('maps malformed or unknown host replies to CORE_UNAVAILABLE', async () => {
    const bad = [null, undefined, 42, 'ok', true, [], { ok: true }, { ok: true, accepted: '1' },
      { ok: true, accepted: -1 }, { ok: true, accepted: 1.5 }, { ok: false }, { ok: false, code: 'BOGUS' },
      { ok: 'yes' }, { nope: 1 }];
    for (const reply of bad) {
      const port = createInputPort(makeFacade(reply));
      const result = await port.send('s', 1, [click()]);
      assert.deepEqual(result, { ok: false, code: 'CORE_UNAVAILABLE' }, `reply ${JSON.stringify(reply)}`);
      port.dispose();
    }
  });

  it('maps throwing, rejecting, and non-promise facades to CORE_UNAVAILABLE', async () => {
    const throwing = createInputPort({ send: () => { throw new Error('boom'); } });
    assert.deepEqual(await throwing.send('s', 1, [click()]), { ok: false, code: 'CORE_UNAVAILABLE' });
    const rejecting = createInputPort({ send: () => Promise.reject(new Error('boom')) });
    assert.deepEqual(await rejecting.send('s', 1, [click()]), { ok: false, code: 'CORE_UNAVAILABLE' });
    const sync = createInputPort({ send: () => undefined });
    assert.deepEqual(await sync.send('s', 1, [click()]), { ok: false, code: 'CORE_UNAVAILABLE' });
    throwing.dispose();
    rejecting.dispose();
    sync.dispose();
  });

  it('refuses malformed sends as SCHEMA without touching the facade', async () => {
    const facade = makeFacade();
    const port = createInputPort(facade);
    const badIds = ['', 42, null, undefined, {}, 'x'.repeat(257)];
    for (const surfaceId of badIds) {
      assert.deepEqual(await port.send(surfaceId, 1, [click()]), { ok: false, code: 'SCHEMA' });
    }
    for (const streamId of [-1, 1.5, '3', NaN, null, undefined]) {
      assert.deepEqual(await port.send('s', streamId, [click()]), { ok: false, code: 'SCHEMA' });
    }
    const many = Array.from({ length: 33 }, (_, i) => click(i, 0));
    for (const events of [[], many, [{ kind: 'nope' }], [{ kind: 'click', x: 1 }], 'x', null, undefined]) {
      assert.deepEqual(await port.send('s', 1, events), { ok: false, code: 'SCHEMA' });
    }
    assert.equal(facade.calls.length, 0);
    assert.equal(port.available, true);
    port.dispose();
  });

  it('refuses oversized payloads as LIMIT and accepts the boundary', async () => {
    const word = 'x'.repeat(1024);
    const sizeFor = (n) => Buffer.byteLength(JSON.stringify({
      schema: 'surface_input/v1', surface_id: 's', stream_id: 1, seq: 1,
      events: Array.from({ length: n }, () => ({ kind: 'type', text: word })),
    }), 'utf8');
    let okCount = 1;
    while (sizeFor(okCount + 1) <= 16384) okCount += 1;
    assert.ok(sizeFor(okCount) <= 16384 && sizeFor(okCount + 1) > 16384);
    const fits = Array.from({ length: okCount }, () => type(word));
    const portOk = createInputPort(createInputDouble());
    assert.deepEqual((await portOk.send('s', 1, fits)).ok, true);
    portOk.dispose();
    const tooBig = Array.from({ length: okCount + 1 }, () => type(word));
    const facade = makeFacade();
    const portBig = createInputPort(facade);
    assert.deepEqual(await portBig.send('s', 1, tooBig), { ok: false, code: 'LIMIT' });
    assert.equal(facade.calls.length, 0);
    portBig.dispose();
  });

  it('owns seq per surface from 1 across send and queue', async () => {
    const dbl = createInputDouble();
    const clock = makeNow();
    const frames = makeRaf();
    const port = createInputPort(dbl, { now: clock.now, raf: frames.raf, cancelRaf: frames.cancelRaf });
    await port.send('a', 1, [click()]);
    await port.send('b', 1, [click()]);
    await port.send('a', 1, [click()]);
    port.queue('a', 1, type('z'));
    frames.fire();
    await tick();
    assert.deepEqual(dbl.batches.map((b) => [b.surface_id, b.seq]), [['a', 1], ['b', 1], ['a', 2], ['a', 3]]);
    port.dispose();
  });

  it('never consumes seq on local refusals', async () => {
    const dbl = createInputDouble();
    const clock = makeNow();
    const port = createInputPort(dbl, { now: clock.now });
    assert.deepEqual(await port.send('s', 1, []), { ok: false, code: 'SCHEMA' });
    assert.deepEqual((await port.send('s', 1, [click()])).ok, true);
    assert.equal(dbl.batches[0].seq, 1);
    for (let i = 0; i < 59; i += 1) await port.send('s', 1, [click()]);
    assert.deepEqual(await port.send('s', 1, [click()]), { ok: false, code: 'LIMIT' });
    assert.equal(dbl.batches.length, 60);
    clock.advance(1000);
    assert.deepEqual((await port.send('s', 1, [click()])).ok, true);
    assert.equal(dbl.batches[60].seq, 61);
    port.dispose();
  });

  it('rate-limits at 60 batches/s per surface, independently', async () => {
    const dbl = createInputDouble();
    const clock = makeNow();
    const port = createInputPort(dbl, { now: clock.now });
    for (let i = 0; i < 60; i += 1) {
      assert.deepEqual((await port.send('hot', 1, [click()])).ok, true);
    }
    assert.deepEqual(await port.send('hot', 1, [click()]), { ok: false, code: 'LIMIT' });
    assert.deepEqual((await port.send('cold', 1, [click()])).ok, true);
    assert.equal(dbl.batches.filter((b) => b.surface_id === 'hot').length, 60);
    clock.advance(1000);
    assert.deepEqual((await port.send('hot', 1, [click()])).ok, true);
    port.dispose();
  });

  it('coalesces consecutive type text and scroll deltas per frame', async () => {
    const dbl = createInputDouble();
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    port.queue('s', 1, type('a'));
    port.queue('s', 1, type('b'));
    port.queue('s', 1, type('c'));
    assert.equal(dbl.batches.length, 0);
    frames.fire();
    await tick();
    assert.equal(dbl.batches.length, 1);
    assert.deepEqual(dbl.batches[0].events, [type('abc')]);
    port.queue('s', 1, scroll(3, -2, 10, 20));
    port.queue('s', 1, scroll(4, 5, 11, 21));
    frames.fire();
    await tick();
    assert.deepEqual(dbl.batches[1].events, [scroll(7, 3, 11, 21)]);
    port.dispose();
  });

  it('keeps order across non-coalescible events', async () => {
    const dbl = createInputDouble();
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    port.queue('s', 1, type('a'));
    port.queue('s', 1, click(1, 2));
    port.queue('s', 1, type('b'));
    port.queue('s', 1, key(['Return']));
    frames.fire();
    await tick();
    assert.equal(dbl.batches.length, 1);
    assert.deepEqual(dbl.batches[0].events, [type('a'), click(1, 2), type('b'), key(['Return'])]);
    port.dispose();
  });

  it('splits queued events at 32 per batch with order and seq kept', async () => {
    const dbl = createInputDouble();
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    for (let i = 0; i < 33; i += 1) port.queue('s', 1, click(i, 0));
    frames.fire();
    await tick();
    assert.equal(dbl.batches.length, 2);
    assert.equal(dbl.batches[0].events.length, 32);
    assert.equal(dbl.batches[1].events.length, 1);
    assert.deepEqual(dbl.batches[0].seq, 1);
    assert.deepEqual(dbl.batches[1].seq, 2);
    assert.deepEqual(dbl.batches.flatMap((b) => b.events).map((e) => e.x),
      Array.from({ length: 33 }, (_, i) => i));
    port.dispose();
  });

  it('splits queued payloads at 16 KiB without losing text', async () => {
    const dbl = createInputDouble();
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const letters = Array.from({ length: 20 }, (_, i) => String.fromCharCode(97 + (i % 26)));
    for (const ch of letters) port.queue('s', 1, type(ch.repeat(1024)));
    frames.fire();
    await tick();
    assert.ok(dbl.batches.length >= 2, `expected a split, got ${dbl.batches.length} batches`);
    const events = dbl.batches.flatMap((b) => b.events);
    assert.ok(events.every((e) => e.kind === 'type' && e.text.length <= 1024));
    assert.equal(events.map((e) => e.text).join(''), letters.map((ch) => ch.repeat(1024)).join(''));
    for (const b of dbl.batches) {
      assert.ok(Buffer.byteLength(JSON.stringify(b), 'utf8') <= 16384);
    }
    port.dispose();
  });

  it('splits queued batches by stream run, preserving order', async () => {
    const dbl = createInputDouble();
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    port.queue('s', 7, click(1, 1));
    port.queue('s', 8, click(2, 2));
    port.queue('s', 8, click(3, 3));
    frames.fire();
    await tick();
    assert.equal(dbl.batches.length, 2);
    assert.equal(dbl.batches[0].stream_id, 7);
    assert.deepEqual(dbl.batches[0].events, [click(1, 1)]);
    assert.equal(dbl.batches[1].stream_id, 8);
    assert.deepEqual(dbl.batches[1].events, [click(2, 2), click(3, 3)]);
    port.dispose();
  });

  it('reports queued host refusals through onRefusal', async () => {
    const dbl = createInputDouble({ refuse: 'NOT_IN_CONTROL' });
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.queue('s', 1, click());
    frames.fire();
    await until(() => refusals.length >= 1, 'queued refusal');
    assert.deepEqual(refusals, [{ surfaceId: 's', code: 'NOT_IN_CONTROL' }]);
    assert.equal(dbl.batches.length, 1);
    port.dispose();
  });

  it('reports queued rate excess as local LIMIT and drops it', async () => {
    const dbl = createInputDouble();
    const clock = makeNow();
    const frames = makeRaf();
    const port = createInputPort(dbl, { now: clock.now, raf: frames.raf, cancelRaf: frames.cancelRaf });
    for (let i = 0; i < 59; i += 1) await port.send('s', 1, [click()]);
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    for (let i = 0; i < 64; i += 1) port.queue('s', 1, click(i, 0));
    frames.fire();
    await until(() => refusals.length >= 1, 'queued LIMIT');
    assert.deepEqual(refusals, [{ surfaceId: 's', code: 'LIMIT' }]);
    assert.equal(dbl.batches.length, 60);
    port.dispose();
  });

  it('refuses invalid queued events as SCHEMA without scheduling', () => {
    const dbl = createInputDouble();
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.queue('s', 1, { kind: 'nope' });
    port.queue('', 1, click());
    port.queue('s', -1, click());
    assert.deepEqual(refusals.map((r) => r.code), ['SCHEMA', 'SCHEMA', 'SCHEMA']);
    assert.equal(frames.scheduled, false);
    assert.equal(dbl.batches.length, 0);
    port.dispose();
  });

  it('refuses queued events as CORE_UNAVAILABLE without a facade', () => {
    const port = createInputPort(undefined, { raf: makeRaf().raf });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.queue('s', 1, click());
    assert.deepEqual(refusals, [{ surfaceId: 's', code: 'CORE_UNAVAILABLE' }]);
    port.dispose();
  });

  it('supports unsubscribe and isolates throwing listeners', async () => {
    const dbl = createInputDouble({ refuse: 'STALE_STREAM' });
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const seen = [];
    port.onRefusal(() => { throw new Error('listener boom'); });
    port.onRefusal((r) => seen.push(r));
    port.queue('s', 1, click());
    frames.fire();
    await until(() => seen.length >= 1, 'surviving listener');
    assert.deepEqual(seen, [{ surfaceId: 's', code: 'STALE_STREAM' }]);
    const extra = [];
    const stop = port.onRefusal((r) => extra.push(r));
    stop();
    port.queue('s', 1, click());
    frames.fire();
    await until(() => seen.length >= 2, 'second refusal');
    assert.deepEqual(extra, []);
    assert.deepEqual(typeof port.onRefusal('nope'), 'function');
    port.dispose();
  });

  it('dispose cancels the flush and silences the port', async () => {
    const dbl = createInputDouble();
    const frames = makeRaf();
    const port = createInputPort(dbl, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    port.queue('s', 1, click());
    assert.equal(frames.scheduled, true);
    port.dispose();
    assert.equal(frames.scheduled, false);
    frames.fire();
    await tick();
    assert.equal(dbl.batches.length, 0);
    assert.deepEqual(await port.send('s', 1, [click()]), { ok: false, code: 'CORE_UNAVAILABLE' });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));
    port.queue('s', 1, click());
    await tick();
    assert.deepEqual(refusals, []);
    assert.equal(dbl.batches.length, 0);
  });

  it('a seq-reusing mutant is caught while the real port passes', async () => {
    const dbl = createInputDouble();
    const port = createInputPort(dbl);
    assert.deepEqual((await port.send('s', 1, [click()])).ok, true);
    assert.deepEqual((await port.send('s', 1, [click()])).ok, true);
    const mutantBatch = {
      schema: 'surface_input/v1', surface_id: 's', stream_id: 1, seq: 1, events: [click()],
    };
    assert.deepEqual(await dbl.send(mutantBatch), { ok: false, code: 'SCHEMA' });
    assert.equal(dbl.batches.filter((b) => b.seq === 2).length, 1);
    port.dispose();
  });

  it('contract-violating facades never break the port contract', async () => {
    const permissive = { calls: [], send(batch) { this.calls.push(batch); return Promise.resolve({ ok: true, accepted: 99 }); } };
    const port = createInputPort(permissive);
    assert.deepEqual(await port.send('s', 1, []), { ok: false, code: 'SCHEMA' });
    assert.deepEqual(await port.send('s', 1, [{ kind: 'bogus' }]), { ok: false, code: 'SCHEMA' });
    assert.equal(permissive.calls.length, 0);
    port.dispose();
    const garbage = createInputPort({ send: () => Promise.resolve('fine') });
    assert.deepEqual(await garbage.send('s', 1, [click()]), { ok: false, code: 'CORE_UNAVAILABLE' });
    garbage.dispose();
  });

  it('rss stays below 512 MiB', () => {
    const rss = process.memoryUsage().rss;
    assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
  });
});
