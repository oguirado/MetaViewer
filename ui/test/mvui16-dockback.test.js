// MVUI16 lane P (ARG-pmui-3, P2): dock-back after float returns to the prior
// dock target. Regression: move->float->dock-back emits the prior group/index
// (the float keeps clearing groupId/index, pinned by mvui11). Negative
// control: a mutant dropping the lastDock save emits the conventional default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSfc, gate, mountApp, mountHost, commitPlacement, mutatedCompiler, flush, MVUI16_ID } from './mvui16-harness.mjs';

const id = MVUI16_ID;
const slotId = `cuk-ai-slot-${id}`;

// Commits move(group-a,2) then float through the App mount, feeds the
// resulting placement props into a floating MultislotHost, triggers dock-back,
// and returns the emitted move body.
async function dockbackBody(AppCompile) {
  const f = await mountApp({}, AppCompile);
  try {
    await commitPlacement(f, gate.buildMultislotMoveIntent(id, 'group-a', 2));
    await commitPlacement(f, gate.buildMultislotFloatIntent(id, { x: 10, y: 20, width: 300, height: 200 }));
    const attrs = f.captured.slot.attrs;
    assert.equal(attrs.floating, true);
    assert.equal(attrs['group-id'], undefined, 'float clears dock metadata');
    assert.equal(attrs['placement-index'], undefined, 'float clears dock metadata');
    assert.equal(attrs['last-dock-group-id'], 'group-a');
    assert.equal(attrs['last-dock-index'], 2);
    const h = await mountHost({
      floating: true,
      lastDockGroupId: attrs['last-dock-group-id'],
      lastDockIndex: attrs['last-dock-index'],
    });
    try {
      h.children.slot.emit('submit-intent', { type: 'dock-back' });
      await flush();
      assert.equal(h.emitted.length, 1);
      return h.emitted[0][0];
    } finally { h.app.unmount(); }
  } finally { f.close(); }
}

test('dock-back after float emits the prior dock group and index', async () => {
  const body = await dockbackBody(compileSfc);
  assert.equal(body.op, 'move');
  assert.deepEqual(body.params, { slot_id: slotId, group_id: 'group-a', index: 2 });
});

const dropLastDockSave = (source) => source.replace(
    `        // MVUI16 lane P (ARG-pmui-3): remember the displaced dock target for
        // dock-back; the groupId/index deletions below stay untouched.
        if (previous.groupId !== undefined) next.lastDockGroupId = previous.groupId;
        else delete next.lastDockGroupId;
        if (previous.index !== undefined) next.lastDockIndex = previous.index;
        else delete next.lastDockIndex;
`,
    '');

test('negative control: mutant dropping the lastDock save emits the dock default', async () => {
  const compile = mutatedCompiler('App.vue', dropLastDockSave);
  const f = await mountApp({}, compile);
  try {
    await commitPlacement(f, gate.buildMultislotMoveIntent(id, 'group-a', 2));
    await commitPlacement(f, gate.buildMultislotFloatIntent(id, { x: 10, y: 20, width: 300, height: 200 }));
    const attrs = f.captured.slot.attrs;
    assert.equal(attrs['last-dock-group-id'], undefined, 'mutant reproduces the lost memory');
    const h = await mountHost({ floating: true });
    try {
      h.children.slot.emit('submit-intent', { type: 'dock-back' });
      await flush();
      assert.deepEqual(h.emitted[0][0].params, { slot_id: slotId, group_id: 'multislot-dock', index: 0 });
    } finally { h.app.unmount(); }
  } finally { f.close(); }
  await assert.rejects(() => dockbackBody(compile), { code: 'ERR_ASSERTION' });
});

test('mvui16 memory ceiling', () => {
  const rss = process.memoryUsage().rss;
  if (process.env.MVUI16_MEASURE) console.log(`mvui16-dockback rss MiB: ${Math.round(rss / 1048576)}`);
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
