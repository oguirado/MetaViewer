// MVUI32 lane A (R3-APP-1): the post-await layout echo in App dispatchMultislot
// is fenced on surface lifetime identity (admitted id presence plus a
// departure epoch), not the mutable content frame generation. Same-lifetime
// g10 -> g11 advances keep the committed echo; a destroyed or replaced
// surface lifetime rejects it. The feed swaps row objects per frame like the
// real projection (frozen row per admitted frame); the shared harness row is
// patched in place and cannot show the bug. Hosted-safe: deferred ack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { compileSfc, gate, mountApp, mutatedCompiler, flush, MVUI16_ID } from './mvui16-harness.mjs';

const id = MVUI16_ID;
const floatBody = () => gate.buildMultislotFloatIntent(id, { x: 10, y: 20, width: 300, height: 200 });
const baseRow = (over = {}) => reactive({ id, surfaceId: id, title: 'Capsule',
  generation: 10, visibility: 'unfolded', control: 'human', backendLifecycle: 'active', ...over });

/** Swappable projection feed: frame advances replace the row object. */
function liveFeed() {
  const state = reactive({ rows: [baseRow()] });
  const feed = { getSnapshot: () => null, getProjection: () => ({ rows: state.rows }), subscribe: () => () => {} };
  return { feed, state };
}

async function startIntent(AppCompile, live) {
  const f = await mountApp({ runtime: { projectionView: live.feed } }, AppCompile);
  f.captured.slot.emit('submit-intent', floatBody(), id);
  await flush();
  assert.equal(f.sent.length, 1);
  return f;
}

async function advanceOracle(AppCompile) {
  const live = liveFeed();
  const f = await startIntent(AppCompile, live);
  try {
    assert.equal(f.captured.slot.attrs['layout-pending'], true, 'pending arms while awaiting authority');
    live.state.rows = [baseRow({ generation: 11 })];
    await flush();
    f.sent.at(-1).resolve(true);
    await flush();
    assert.equal(f.echoes.length, 1, 'same-lifetime g10->g11 keeps the committed echo');
    assert.equal(f.captured.slot.attrs.floating, true, 'placement commits exactly once');
    assert.equal(f.captured.slot.attrs['layout-pending'], false, 'pending state clears after commit');
  } finally { f.close(); }
}

async function destroyOracle(AppCompile) {
  const live = liveFeed();
  const f = await startIntent(AppCompile, live);
  try {
    live.state.rows = [baseRow({ generation: 11, backendLifecycle: 'destroyed' })];
    await flush();
    f.sent.at(-1).resolve(true);
    await flush();
    assert.equal(f.echoes.length, 0, 'destroyed surface rejects the stale echo');
    live.state.rows = [baseRow({ generation: 12 })];
    await flush();
    assert.equal(f.captured.slot.attrs['layout-pending'], false, 'pending clears on the rejected path');
  } finally { f.close(); }
}

test('same-lifetime frame advance keeps the committed layout echo', async () => {
  await advanceOracle(compileSfc);
});

test('destroyed surface rejects the stale layout echo', async () => {
  await destroyOracle(compileSfc);
});

test('replaced surface lifetime rejects the stale layout echo', async () => {
  const live = liveFeed();
  const f = await startIntent(compileSfc, live);
  try {
    live.state.rows = [baseRow({ id: 'surface-b', surfaceId: 'surface-b', title: 'Other', generation: 1 })];
    await flush();
    f.sent.at(-1).resolve(true);
    await flush();
    assert.equal(f.echoes.length, 0, 'replaced lifetime never receives the echo');
  } finally { f.close(); }
});

test('destroy-then-revive under the same id still rejects the stale echo', async () => {
  const live = liveFeed();
  const f = await startIntent(compileSfc, live);
  try {
    live.state.rows = [baseRow({ generation: 11, backendLifecycle: 'destroyed' })];
    await flush();
    // Revive at the SAME generation: only the departure epoch can reject this.
    live.state.rows = [baseRow({ generation: 10 })];
    await flush();
    f.sent.at(-1).resolve(true);
    await flush();
    assert.equal(f.echoes.length, 0, 'the ended lifetime epoch rejects the echo');
    assert.equal(f.captured.slot.attrs['layout-pending'], false);
    f.captured.slot.emit('submit-intent', floatBody(), id);
    await flush();
    f.sent.at(-1).resolve(true);
    await flush();
    assert.equal(f.echoes.length, 1, 'a fresh intent on the live surface still commits');
  } finally { f.close(); }
});

test('negative control: mutant restoring the generation fence drops the echo', async () => {
  const compile = mutatedCompiler('App.vue', (source) => source.replace(
    '|| !rows.value.some(row => row.id === capsuleId)) return;',
    '|| !rows.value.some(row => row.id === capsuleId && row.generation === surface.generation)) return;'));
  await assert.rejects(() => advanceOracle(compile), (error) => {
    assert.equal(error.code, 'ERR_ASSERTION');
    assert.match(error.message, /keeps the committed echo/);
    return true;
  });
});

test('negative control: mutant removing the fence echoes onto the destroyed surface', async () => {
  const compile = mutatedCompiler('App.vue', (source) => source.replace(
    'if (result !== true || !hostActive || surfaceLifetimeEpochOf(capsuleId) !== lifetimeEpoch\n        || !rows.value.some(row => row.id === capsuleId)) return;',
    'if (result !== true || !hostActive) return;'));
  await assert.rejects(() => destroyOracle(compile), (error) => {
    assert.equal(error.code, 'ERR_ASSERTION');
    assert.match(error.message, /rejects the stale echo/);
    return true;
  });
});
