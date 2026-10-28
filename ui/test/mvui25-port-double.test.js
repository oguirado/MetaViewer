/**
 * Tests for the input double (`ui/src/input/inputDouble.js`).
 *
 * Runs under the repository `node --test` gate with crafted batches only; no DOM
 * or Electron runtime is loaded. Each behaviour pairs a positive witness with a
 * negative control that must fail: schema violations refuse with SCHEMA, reused
 * or non-increasing seq refuses (a contract-violating mutant double that accepts
 * the same batch proves the check is load-bearing), and unknown option codes
 * throw at creation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INPUT_REFUSALS } from '../src/input/inputPort.js';
import { createInputDouble } from '../src/input/inputDouble.js';

const batch = (over = {}) => ({
  schema: 'surface_input/v1',
  surface_id: 's',
  stream_id: 1,
  seq: 1,
  events: [{ kind: 'click', x: 1, y: 2, button: 'left' }],
  ...over,
});

describe('mvui25 input double', () => {
  it('accepts valid batches and records deep copies', async () => {
    const dbl = createInputDouble();
    const sent = batch({ events: [{ kind: 'type', text: 'hi' }, { kind: 'key', keys: ['ctrl', 'l'] }] });
    assert.deepEqual(await dbl.send(sent), { ok: true, accepted: 2 });
    sent.surface_id = 'mutated';
    sent.events.push({ kind: 'click', x: 0, y: 0, button: 'left' });
    assert.equal(dbl.batches.length, 1);
    assert.equal(dbl.batches[0].surface_id, 's');
    assert.equal(dbl.batches[0].events.length, 2);
  });

  it('refuses schema violations with SCHEMA', async () => {
    const dbl = createInputDouble();
    const bad = [
      batch({ schema: 'surface_input/v9' }),
      batch({ surface_id: '' }),
      batch({ surface_id: 7 }),
      batch({ stream_id: -1 }),
      batch({ stream_id: 1.5 }),
      batch({ seq: 0 }),
      batch({ seq: 1.5 }),
      batch({ seq: '1' }),
      batch({ events: [] }),
      batch({ events: Array.from({ length: 33 }, () => ({ kind: 'type', text: 'x' })) }),
      batch({ events: [{ kind: 'hover' }] }),
      batch({ events: [{ kind: 'click', x: 1, y: 2 }] }),
      batch({ events: [{ kind: 'type', text: '' }] }),
      batch({ events: [{ kind: 'type', text: 'x'.repeat(1025) }] }),
      batch({ events: [{ kind: 'key', keys: [] }] }),
      batch({ events: [{ kind: 'scroll', dx: 1, dy: 2, x: 0 }] }),
      batch({ events: 'x' }),
      null,
      undefined,
      42,
      'batch',
    ];
    for (const b of bad) {
      assert.deepEqual(await dbl.send(b), { ok: false, code: 'SCHEMA' }, JSON.stringify(b)?.slice(0, 80));
    }
  });

  it('enforces strictly increasing seq per surface', async () => {
    const dbl = createInputDouble();
    assert.deepEqual((await dbl.send(batch({ seq: 1 }))).ok, true);
    assert.deepEqual(await dbl.send(batch({ seq: 1 })), { ok: false, code: 'SCHEMA' });
    assert.deepEqual((await dbl.send(batch({ seq: 2 }))).ok, true);
    assert.deepEqual(await dbl.send(batch({ seq: 2 })), { ok: false, code: 'SCHEMA' });
    assert.deepEqual((await dbl.send(batch({ surface_id: 'other', seq: 1 }))).ok, true);
    dbl.reset();
    assert.deepEqual((await dbl.send(batch({ seq: 1 }))).ok, true);
    assert.equal(dbl.batches.length, 1);
  });

  it('a mutant double that skips the seq check proves the check is load-bearing', async () => {
    const mutant = { async send() { return { ok: true, accepted: 1 }; } };
    const dbl = createInputDouble();
    const first = batch({ seq: 5 });
    const replay = batch({ seq: 5 });
    assert.deepEqual(await mutant.send(first), { ok: true, accepted: 1 });
    assert.deepEqual(await mutant.send(replay), { ok: true, accepted: 1 });
    assert.deepEqual((await dbl.send(first)).ok, true);
    assert.deepEqual(await dbl.send(replay), { ok: false, code: 'SCHEMA' });
  });

  it('refuses unknown surfaces and stale streams', async () => {
    const dbl = createInputDouble({ surfaces: ['a', 'b'], streams: { a: 3 } });
    assert.deepEqual(await dbl.send(batch({ surface_id: 'zz', seq: 1 })), { ok: false, code: 'SURFACE_UNKNOWN' });
    assert.deepEqual(await dbl.send(batch({ surface_id: 'a', stream_id: 2, seq: 1 })),
      { ok: false, code: 'STALE_STREAM' });
    assert.deepEqual((await dbl.send(batch({ surface_id: 'a', stream_id: 3, seq: 1 }))).ok, true);
    assert.deepEqual((await dbl.send(batch({ surface_id: 'b', stream_id: 9, seq: 1 }))).ok, true);
  });

  it('honours refuse as a code, map, or function', async () => {
    const fixed = createInputDouble({ refuse: 'NOT_IN_CONTROL' });
    assert.deepEqual(await fixed.send(batch()), { ok: false, code: 'NOT_IN_CONTROL' });
    const mapped = createInputDouble({ refuse: { s: 'NESTED_DISPLAY_ONLY' } });
    assert.deepEqual(await mapped.send(batch()), { ok: false, code: 'NESTED_DISPLAY_ONLY' });
    assert.deepEqual((await mapped.send(batch({ surface_id: 't' }))).ok, true);
    const dynamic = createInputDouble({ refuse: (b) => (b.stream_id === 1 ? 'LIMIT' : null) });
    assert.deepEqual(await dynamic.send(batch()), { ok: false, code: 'LIMIT' });
    assert.deepEqual((await dynamic.send(batch({ stream_id: 2, seq: 2 }))).ok, true);
    const throwing = createInputDouble({ refuse: () => { throw new Error('boom'); } });
    assert.deepEqual(await throwing.send(batch()), { ok: false, code: 'CORE_UNAVAILABLE' });
    const unknown = createInputDouble({ refuse: () => 'BOGUS' });
    assert.deepEqual(await unknown.send(batch()), { ok: false, code: 'SCHEMA' });
  });

  it('returns every closed code when configured', async () => {
    for (const code of INPUT_REFUSALS) {
      const dbl = createInputDouble({ refuse: code });
      assert.deepEqual(await dbl.send(batch()), { ok: false, code });
    }
  });

  it('rejects unknown configured codes at creation', () => {
    assert.throws(() => createInputDouble({ refuse: 'BOGUS' }), /unknown refusal code/);
    assert.throws(() => createInputDouble({ refuse: { s: 'BOGUS' } }), /unknown refusal code/);
    assert.throws(() => createInputDouble({ refuse: 42 }), /must be a code/);
  });

  it('refuses oversized payloads as LIMIT', async () => {
    const dbl = createInputDouble();
    const big = batch({ events: Array.from({ length: 20 }, () => ({ kind: 'type', text: 'y'.repeat(1024) })) });
    assert.ok(Buffer.byteLength(JSON.stringify(big), 'utf8') > 16384);
    assert.deepEqual(await dbl.send(big), { ok: false, code: 'LIMIT' });
    const fits = batch({ events: Array.from({ length: 5 }, () => ({ kind: 'type', text: 'y'.repeat(1024) })) });
    assert.deepEqual((await dbl.send(fits)).ok, true);
  });

  it('rss stays below 512 MiB', () => {
    const rss = process.memoryUsage().rss;
    assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
  });
});
