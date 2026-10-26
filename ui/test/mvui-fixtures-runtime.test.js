// Fixture runtime: App-compatible wall runtime stubs from fixture data,
// intent recording instead of dispatch, terminal always null (host-owned).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_KEYS } from '../src/fixtures/states.js';
import { resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';

test('every key builds a mount with a closed runtime surface', () => {
  for (const key of FIXTURE_KEYS) {
    const created = createFixtureRuntime(key);
    assert.equal(created.ok, true, key);
    if (!created.ok) continue;
    const { fixture, runtime, calls, terminal } = created.mount;
    assert.equal(fixture.key, key);
    assert.deepEqual(Object.keys(runtime).sort(), [
      'controlRegistry',
      'intentBuilders',
      'projectionView',
      'scheduler',
      'tileScheduler',
    ]);
    assert.deepEqual(calls, []);
    assert.equal(terminal, null);
  }
});

test('projection rows mirror the fixture capsules exactly', () => {
  const created = createFixtureRuntime('four');
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { runtime, fixture } = created.mount;
  assert.equal(runtime.projectionView.getProjection().rows, fixture.capsules);
  assert.deepEqual(
    runtime.projectionView.getProjection().rows.map((row) => row.id),
    ['cap-01', 'cap-02', 'cap-03', 'cap-04'],
  );
  const snapshot = runtime.projectionView.getSnapshot();
  assert.equal(snapshot.status, 'live');
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.envelope?.schema, 'surface/v0.1');
  assert.equal(snapshot.envelope?.epoch, fixture.epoch);
  assert.equal(snapshot.envelope?.revision, fixture.revision);
  assert.equal(snapshot.error, null);
  assert.ok(Object.isFrozen(snapshot));
});

test('subscribe emits the current snapshot once and returns an unsub', () => {
  const created = createFixtureRuntime('one');
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const seen = [];
  const unsub = created.mount.runtime.projectionView.subscribe((snapshot) => seen.push(snapshot));
  assert.equal(typeof unsub, 'function');
  assert.equal(seen.length, 1);
  assert.equal(seen[0], created.mount.runtime.projectionView.getSnapshot());
  unsub();
  const again = created.mount.runtime.projectionView.subscribe(/** @type {any} */ (null));
  assert.equal(typeof again, 'function');
});

test('intent builders record frozen calls and return frozen receipts', () => {
  const created = createFixtureRuntime('tile-states');
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { runtime, calls } = created.mount;
  const first = runtime.intentBuilders.visibility({ capsuleId: 'cap-03', verb: 'fold' });
  const second = runtime.intentBuilders.control({ capsuleId: 'cap-05', verb: 'take_control' });
  const third = runtime.intentBuilders.presentation({ capsuleId: 'cap-06', verb: 'close' });
  assert.deepEqual(calls, [
    { builder: 'visibility', input: { capsuleId: 'cap-03', verb: 'fold' } },
    { builder: 'control', input: { capsuleId: 'cap-05', verb: 'take_control' } },
    { builder: 'presentation', input: { capsuleId: 'cap-06', verb: 'close' } },
  ]);
  assert.ok(Object.isFrozen(calls[0]));
  assert.deepEqual(first, { fixture: true, builder: 'visibility', input: { capsuleId: 'cap-03', verb: 'fold' } });
  assert.deepEqual(second.builder, 'control');
  assert.deepEqual(third.builder, 'presentation');
  assert.ok(Object.isFrozen(first));
});

test('tile scheduler stub covers the panel call surface without throwing', () => {
  const created = createFixtureRuntime('one');
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const scheduler = created.mount.runtime.tileScheduler;
  assert.doesNotThrow(() => {
    scheduler.attachCanvas();
    scheduler.foldSurface();
    scheduler.unfoldSurface();
    scheduler.updateSurfaceState();
    scheduler.detachCanvas();
    scheduler.destroy();
  });
});

test('empty and settings-dark mount with zero rows', () => {
  for (const key of ['empty', 'settings-dark']) {
    const created = createFixtureRuntime(key);
    assert.equal(created.ok, true, key);
    if (!created.ok) continue;
    assert.equal(created.mount.runtime.projectionView.getProjection().rows.length, 0, key);
  }
});

test('unknown keys and malformed records refuse with a typed error', () => {
  const refused = createFixtureRuntime('nope');
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, 'ERR_UNKNOWN_FIXTURE_STATE');
  else assert.fail('unknown key must refuse');
  const malformed = createFixtureRuntime(/** @type {any} */ ({ key: 'fake' }));
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, 'ERR_UNKNOWN_FIXTURE_STATE');
  else assert.fail('malformed record must refuse');
});

test('a resolved fixture record mounts directly', () => {
  const resolved = resolveFixture('nested');
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const created = createFixtureRuntime(resolved.fixture);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.mount.fixture.key, 'nested');
});

describe('no live core', () => {
  test('the factory never touches host globals', () => {
    assert.equal(typeof window, 'undefined');
    const created = createFixtureRuntime('nine');
    assert.equal(created.ok, true);
  });

  test('mounts stay deterministic across repeated builds', () => {
    const first = createFixtureRuntime('multislot');
    const second = createFixtureRuntime('multislot');
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.deepEqual(first.mount.runtime.projectionView.getSnapshot(), second.mount.runtime.projectionView.getSnapshot());
    assert.deepEqual(first.mount.calls, second.mount.calls);
  });
});
