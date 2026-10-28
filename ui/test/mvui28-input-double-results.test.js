/**
 * MVUI28 lane R: the input double emits settled-send results behind an option.
 *
 * Covers the default facade shape (no `onResult`), the `results:true`
 * subscription (frozen per-send results mirroring the reply, ARGS throw,
 * idempotent unsubscribe, reset keeping listeners, throwing listeners) in
 * `ui/src/input/inputDouble.js`. Each behaviour pairs with a negative
 * control. Runs under the repository `node --test` gate; no DOM is loaded.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INPUT_RESULT_CODES } from '../src/input/inputPort.js';
import { ContractError, createInputDouble } from '../src/input/inputDouble.js';

/** @param {unknown} surfaceId @param {unknown} seq */
const batch = (surfaceId, seq) => ({
  schema: 'surface_input/v1',
  surface_id: surfaceId,
  stream_id: 1,
  seq,
  events: [{ kind: 'type', text: 'a' }],
});

describe('mvui28 input double results (lane R double)', () => {
  it('the default facade carries no onResult', () => {
    for (const dbl of [createInputDouble(), createInputDouble({}), createInputDouble({ refuse: 'LIMIT' })]) {
      assert.deepEqual(Object.keys(dbl).sort(), ['batches', 'reset', 'send']);
      assert.equal(typeof dbl.onResult, 'undefined');
      assert.ok(Object.isFrozen(dbl));
    }
  });

  it('results:true emits one frozen result per settled send', async () => {
    const dbl = createInputDouble({ results: true, refuse: (b) => (b.seq === 2 ? 'LIMIT' : null) });
    assert.equal(typeof dbl.onResult, 'function');
    assert.ok(Object.isFrozen(dbl));
    const results = [];
    const stop = dbl.onResult((r) => results.push(r));
    assert.equal(typeof stop, 'function');
    assert.deepEqual(await dbl.send(batch('s', 1)), { ok: true, accepted: 1 });
    assert.deepEqual(await dbl.send(batch('s', 2)), { ok: false, code: 'LIMIT' });
    assert.equal(results.length, 2, 'one result per settled send');
    assert.deepEqual(results[0], { surface_id: 's', seq: 1, ok: true, code: null });
    assert.deepEqual(results[1], { surface_id: 's', seq: 2, ok: false, code: 'LIMIT' });
    for (const result of results) assert.ok(Object.isFrozen(result), 'results stay frozen');
    assert.equal(dbl.batches.length, 2, 'recording is unchanged');
    stop();
  });

  it('host refusals emit; identity-less sends stay silent', async () => {
    const dbl = createInputDouble({ results: true, surfaces: ['a'] });
    const results = [];
    dbl.onResult((r) => results.push(r));
    assert.deepEqual(await dbl.send(batch('b', 1)), { ok: false, code: 'SURFACE_UNKNOWN' });
    assert.equal(results.length, 1, 'the host refusal emits its result');
    assert.deepEqual(results[0], { surface_id: 'b', seq: 1, ok: false, code: 'SURFACE_UNKNOWN' });
    assert.deepEqual(await dbl.send(batch('a', 1)), { ok: true, accepted: 1 });
    assert.deepEqual(await dbl.send(batch('a', 1)), { ok: false, code: 'SCHEMA' }, 'duplicate seq refuses');
    assert.equal(results.length, 3, 'the well-formed duplicate still emits');
    for (const bad of [null, 7, 'x', [], { schema: 'surface_input/v1' }, batch('', 1), batch('a', 0), batch('a', 'x')]) {
      assert.deepEqual((await dbl.send(bad)).ok, false, `identity-less send refuses: ${String(bad)}`);
    }
    assert.equal(results.length, 3, 'sends without a usable identity stay silent');
  });

  it('onResult takes exactly one function, else ContractError ARGS', () => {
    const dbl = createInputDouble({ results: true });
    const probe = () => {};
    assert.equal(typeof dbl.onResult(probe), 'function', 'one function subscribes');
    const bad = [[], [probe, probe], ['x'], [undefined], [null], [{}], [42]];
    for (const args of bad) {
      assert.throws(
        () => dbl.onResult(...args),
        (err) => {
          assert.ok(err instanceof ContractError, 'a ContractError');
          assert.equal(err.name, 'ContractError');
          assert.equal(err.code, 'ARGS');
          assert.match(err.message, /^ARGS: /);
          return true;
        },
        `ARGS throw for ${args.length} argument(s)`,
      );
    }
  });

  it('unsubscribe is idempotent; reset keeps listeners', async () => {
    const dbl = createInputDouble({ results: true });
    const first = [];
    const second = [];
    const stopFirst = dbl.onResult((r) => first.push(r));
    dbl.onResult((r) => second.push(r));
    assert.doesNotThrow(() => { stopFirst(); stopFirst(); });
    await dbl.send(batch('s', 1));
    assert.equal(first.length, 0, 'the unsubscribed listener hears nothing');
    assert.equal(second.length, 1, 'its sibling still hears');
    dbl.reset();
    assert.deepEqual(dbl.batches, [], 'reset clears batches');
    await dbl.send(batch('s', 1));
    assert.equal(second.length, 2, 'reset keeps the subscription');
  });

  it('control: a throwing listener never breaks send or its siblings', async () => {
    const dbl = createInputDouble({ results: true });
    dbl.onResult(() => { throw new Error('listener boom'); });
    const results = [];
    dbl.onResult((r) => results.push(r));
    assert.deepEqual(await dbl.send(batch('s', 1)), { ok: true, accepted: 1 });
    assert.equal(results.length, 1, 'the sibling still hears');
  });

  it('results mirror the reply outcome for every event code', async () => {
    assert.equal(INPUT_RESULT_CODES.length, 7, 'the contract event set, exactly');
    for (const code of INPUT_RESULT_CODES) {
      const dbl = createInputDouble({ results: true, refuse: code });
      const results = [];
      dbl.onResult((r) => results.push(r));
      assert.deepEqual(await dbl.send(batch('s', 1)), { ok: false, code }, code);
      assert.deepEqual(results, [{ surface_id: 's', seq: 1, ok: false, code }], code);
      assert.ok(Object.isFrozen(results[0]), 'results stay frozen');
    }
  });

  it('control: nullish dynamic refusals accept with a null-code event', async () => {
    const dbl = createInputDouble({ results: true, refuse: () => null });
    const results = [];
    dbl.onResult((r) => results.push(r));
    assert.deepEqual(await dbl.send(batch('s', 1)), { ok: true, accepted: 1 });
    assert.deepEqual(results, [{ surface_id: 's', seq: 1, ok: true, code: null }]);
  });
});
