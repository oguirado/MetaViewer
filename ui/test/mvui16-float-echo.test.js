// MVUI16 lane P (ARG-pmui-4, P1): committed float geometry reaches the wall
// panel, and a failed layout echo surfaces a typed outcome without skipping
// the committed placements update (plus one retry on wall @ready).
// Negatives: mutants dropping the geometry arg / the echo check fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSfc, gate, mountApp, commitPlacement, mutatedCompiler, flush, nodes, text, wallModule, readyWallWithPanel, MVUI16_ID } from './mvui16-harness.mjs';

const id = MVUI16_ID;
const outcomeCode = (f) => nodes(f.root).find((n) => n.props?.id === 'mv-host-outcome').props['data-outcome-code'];

// --- Wall controller: geometry forwarding ---

function assertFloatBounds(wall, bounds = { x: 10, y: 20, width: 300, height: 200 }) {
  const { controller, floatCalls } = readyWallWithPanel(wall, id);
  try {
    const body = gate.buildMultislotFloatIntent(id, bounds);
    const result = controller.applyLayoutEcho(id, body);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { panelId: `panel-${id}` });
    assert.equal(floatCalls.length, 1);
    assert.deepEqual(floatCalls[0], [`panel-${id}`, bounds]);
  } finally { controller.dispose(); }
}

test('float echo positions the panel at the committed geometry', async () => {
  assertFloatBounds(await wallModule());
});

test('float echo refuses invalid params, unknown panels and cold walls untouched', async () => {
  const wall = await wallModule();
  const { controller, floatCalls } = readyWallWithPanel(wall, id);
  try {
    for (const params of [
      { slot_id: `cuk-ai-slot-${id}`, x_px: 16384, y_px: 0, width_px: 1, height_px: 1 },
      { slot_id: `cuk-ai-slot-${id}`, x_px: 0, y_px: 0, width_px: 0, height_px: 1 },
      { slot_id: `cuk-ai-slot-${id}`, x_px: 0.5, y_px: 0, width_px: 1, height_px: 1 },
      { slot_id: 'other', x_px: 0, y_px: 0, width_px: 1, height_px: 1 },
    ]) {
      assert.equal(controller.applyLayoutEcho(id, { op: 'float', params }).ok, false);
    }
    assert.equal(controller.applyLayoutEcho('cap-missing', gate.buildMultislotFloatIntent('cap-missing', { x: 0, y: 0, width: 1, height: 1 })).ok, false);
    assert.equal(floatCalls.length, 0, 'refused floats never touch the dock API');
  } finally { controller.dispose(); }
  const cold = wall.createWallWorkspaceController({ projectionView: { getProjection: () => ({ rows: [{ id, surfaceId: id, backendLifecycle: 'active' }] }) } });
  try {
    const result = cold.applyLayoutEcho(id, gate.buildMultislotFloatIntent(id, { x: 0, y: 0, width: 1, height: 1 }));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ERR_NOT_READY');
  } finally { cold.dispose(); }
});

test('negative control: mutant dropping the geometry arg fails the position oracle', async () => {
  const mutant = await wallModule((source) => source.replace(
    'windows.float(panelId, { x: p.x_px, y: p.y_px, width: p.width_px, height: p.height_px });',
    'windows.float(panelId);'));
  assert.throws(() => assertFloatBounds(mutant), { code: 'ERR_ASSERTION' });
});

// --- App: failed echo keeps the commit, types the outcome, retries on ready ---

const ECHO_FAILURE = Object.freeze({ ok: false, error: Object.freeze({ code: 'ERR_NOT_READY', message: 'wall is not ready' }) });

async function echoFailureOracle(AppCompile) {
  const f = await mountApp({}, AppCompile, { echoResult: ECHO_FAILURE });
  try {
    await commitPlacement(f, gate.buildMultislotFloatIntent(id, { x: 10, y: 20, width: 300, height: 200 }));
    const attrs = f.captured.slot.attrs;
    assert.equal(attrs.floating, true, 'placements commit despite the failed echo');
    assert.equal(attrs['float-width'], 300);
    assert.equal(f.echoes.length, 1);
    assert.equal(outcomeCode(f), 'ERR_NOT_READY');
    assert.doesNotMatch(text(f.root), /wall is not ready/);
    f.captured.wall.emit('ready');
    await flush();
    assert.equal(f.echoes.length, 2, 'one retry on wall @ready');
    f.captured.wall.emit('ready');
    await flush();
    assert.equal(f.echoes.length, 2, 'retry is single-shot');
  } finally { f.close(); }
}

test('not-ready echo surfaces a typed outcome while placements still commit', async () => {
  await echoFailureOracle(compileSfc);
});

test('negative control: mutant ignoring the echo result keeps the stale success', async () => {
  const compile = mutatedCompiler('App.vue', (source) => source.replace(
    'if (echo && typeof echo === \'object\' && echo.ok === false) {', 'if (false) {'));
  await assert.rejects(() => echoFailureOracle(compile), { code: 'ERR_ASSERTION' });
});

test('mvui16 memory ceiling', () => {
  const rss = process.memoryUsage().rss;
  if (process.env.MVUI16_MEASURE) console.log(`mvui16-float-echo rss MiB: ${Math.round(rss / 1048576)}`);
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
