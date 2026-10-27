// MVUI16E lane E (post-rebase reconciliation of MVUI16D lane P): the kit
// windows.float ignores its bounds argument, and the wall architecture
// contract (wall.test.js) forbids any presentation layout round trip in
// the renderer, so applyFloatEcho forwards the committed echo geometry
// through the kit windows.float(panelId, bounds) call and nothing else.
// The bounds ride the call for the kit to honor once kit queue item 15
// lands; until then no resulting-geometry assertion is possible here.
// Negative: a mutant dropping the kit call fails the oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wallModule, gate, boundedPush, readyWallWithPanel, MVUI16_ID } from './mvui16-harness.mjs';

const id = MVUI16_ID;
const panelId = `panel-${id}`;

// Ready controller whose dock api exposes layout serialization: the
// renderer must never round-trip it (wall architecture contract), so the
// layout entries throw if touched.
function readyWallWithLayoutApi(wall) {
  const floatCalls = [];
  const panel = { id: panelId, api: { moveTo() {}, setActive() {}, close() {} } };
  const api = {
    getPanel: (pid) => (pid === panelId ? panel : undefined),
    addPanel: () => panel,
    toJSON: () => { throw new Error('renderer must not serialize layout'); },
    fromJSON: () => { throw new Error('renderer must not restore layout'); },
  };
  const windows = { state: () => ({ hidden: false }), show() {}, hide() {},
    float: (pid, box) => boundedPush(floatCalls, [pid, box], 8), dock() {} };
  const controller = wall.createWallWorkspaceController({
    projectionView: { getProjection: () => ({ rows: [{ id, surfaceId: id, backendLifecycle: 'active' }] }) },
  });
  assert.equal(controller.handleReady({ api, windows }).ok, true);
  return { controller, floatCalls };
}

async function floatCallOracle(wall, bounds = { x: 10, y: 20, width: 300, height: 200 }) {
  const { controller, floatCalls } = readyWallWithPanel(wall, id);
  try {
    const result = controller.applyLayoutEcho(id, gate.buildMultislotFloatIntent(id, bounds));
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { panelId });
    assert.equal(floatCalls.length, 1, 'one kit float call per committed echo');
    assert.deepEqual(floatCalls[0], [panelId, bounds], 'echo geometry rides the kit call');
  } finally { controller.dispose(); }
}

test('float echo forwards the committed geometry through the kit float call', async () => {
  await floatCallOracle(await wallModule());
});

test('float echo never round-trips layout even when the api exposes it', async () => {
  const wall = await wallModule();
  const bounds = { x: 10, y: 20, width: 300, height: 200 };
  const w = readyWallWithLayoutApi(wall);
  try {
    const result = w.controller.applyLayoutEcho(id, gate.buildMultislotFloatIntent(id, bounds));
    assert.equal(result.ok, true);
    assert.deepEqual(w.floatCalls, [[panelId, bounds]]);
  } finally { w.controller.dispose(); }
});

test('float echo refuses invalid params, unknown rows and cold walls untouched', async () => {
  const wall = await wallModule();
  const { controller, floatCalls } = readyWallWithPanel(wall, id);
  try {
    for (const params of [
      { slot_id: `cuk-ai-slot-${id}`, x_px: -1, y_px: 0, width_px: 1, height_px: 1 },
      { slot_id: `cuk-ai-slot-${id}`, x_px: 0, y_px: 16384, width_px: 1, height_px: 1 },
      { slot_id: `cuk-ai-slot-${id}`, x_px: 0, y_px: 0, width_px: 16385, height_px: 1 },
      { slot_id: 'other', x_px: 0, y_px: 0, width_px: 1, height_px: 1 },
    ]) {
      assert.equal(controller.applyLayoutEcho(id, { op: 'float', params }).ok, false);
    }
    assert.equal(controller.applyLayoutEcho('cap-missing', gate.buildMultislotFloatIntent('cap-missing', { x: 0, y: 0, width: 1, height: 1 })).ok, false);
    assert.equal(floatCalls.length, 0, 'refused floats never reach the kit');
  } finally { controller.dispose(); }
  const cold = wall.createWallWorkspaceController({ projectionView: { getProjection: () => ({ rows: [{ id, surfaceId: id, backendLifecycle: 'active' }] }) } });
  try {
    const result = cold.applyLayoutEcho(id, gate.buildMultislotFloatIntent(id, { x: 0, y: 0, width: 1, height: 1 }));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ERR_NOT_READY');
  } finally { cold.dispose(); }
});

test('negative control: mutant dropping the kit float call fails the oracle', async () => {
  const mutant = await wallModule((source) => source.replace(
    'windows.float(panelId, { x: p.x_px, y: p.y_px, width: p.width_px, height: p.height_px });',
    'windows.dock(panelId);'));
  await assert.rejects(() => floatCallOracle(mutant), { code: 'ERR_ASSERTION' });
});

test('mvui16d memory ceiling', () => {
  const rss = process.memoryUsage().rss;
  if (process.env.MVUI16_MEASURE) console.log(`mvui16d-place-float rss MiB: ${Math.round(rss / 1048576)}`);
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
