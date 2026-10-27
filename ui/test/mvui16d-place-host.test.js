// MVUI16D lane P (L2-1, host side): purely local multislot toggles apply to
// local presentation and emit nothing host-bound, while fold/unfold still
// emit closed slot-intent bodies. Negative: a mutant re-emitting a local
// toggle fails the oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSfc, mountHost, mutatedCompiler, flush, MVUI16_ID } from './mvui16-harness.mjs';

const id = MVUI16_ID;

async function localToggleOracle(compile) {
  const modes = [];
  const h = await mountHost({
    clipboard: { writeText: async () => {} },
    'onUpdate:inputMode': (mode) => modes.push(mode),
  }, null, compile);
  try {
    h.children.slot.emit('submit-intent', { type: 'hide-surface' });
    await flush();
    assert.equal(h.children.slot.attrs['surface-hidden'], true);
    h.children.slot.emit('submit-intent', { type: 'show-surface' });
    await flush();
    assert.equal(h.children.slot.attrs['surface-hidden'], false);
    h.children.slot.emit('submit-intent', { type: 'hide-terminal' });
    await flush();
    assert.equal(h.children.slot.attrs['terminal-hidden'], true);
    h.children.slot.emit('submit-intent', { type: 'show-terminal' });
    await flush();
    assert.equal(h.children.slot.attrs['terminal-hidden'], false);
    h.children.slot.emit('submit-intent', { type: 'input-mode-read' });
    await flush();
    h.children.slot.emit('submit-intent', { type: 'input-mode-write' });
    await flush();
    assert.deepEqual(modes, ['read', 'write']);
    h.children.slot.emit('submit-intent', { type: 'copy-id' });
    await flush();
    h.children.slot.emit('submit-intent', { type: 'bogus-type' });
    await flush();
    assert.equal(h.emitted.length, 0, 'purely local toggles emit no submit-intent');
  } finally { h.app.unmount(); }
}

test('local view/mode toggles apply locally and emit nothing host-bound', async () => {
  await localToggleOracle(compileSfc);
});

test('negative control: mutant re-emitting a local toggle fails the oracle', async () => {
  const compile = mutatedCompiler('multislot/MultislotHost.vue', (source) => source.replace(
    `    if (!controlled('surfaceHidden', 'surface-hidden')) surfaceVisibleRef.value = type === 'show-surface';\n    return;`,
    `    if (!controlled('surfaceHidden', 'surface-hidden')) surfaceVisibleRef.value = type === 'show-surface';\n    emit('submit-intent', intent, props.capsuleId);\n    return;`));
  await assert.rejects(() => localToggleOracle(compile), { code: 'ERR_ASSERTION' });
});

test('fold and unfold still emit closed slot-intent bodies', async () => {
  const h = await mountHost({});
  try {
    for (const type of ['fold', 'unfold']) {
      h.children.slot.emit('submit-intent', { type });
      await flush();
    }
    assert.equal(h.emitted.length, 2);
    assert.equal(h.emitted[0][0].op, 'fold');
    assert.deepEqual(Object.keys(h.emitted[0][0]).sort(), ['op', 'params', 'request_id', 'schema']);
    assert.deepEqual(h.emitted[0][0].params, { slot_id: `cuk-ai-slot-${id}` });
    assert.equal(h.emitted[0][0].schema, 'ui_intent/v0.2');
    assert.equal(h.emitted[0][1], id);
    assert.equal(h.emitted[1][0].op, 'unfold');
    assert.equal(h.children.slot.attrs.folded, false, 'local folded presentation still tracks');
  } finally { h.app.unmount(); }
});

test('mvui16d memory ceiling', () => {
  const rss = process.memoryUsage().rss;
  if (process.env.MVUI16_MEASURE) console.log(`mvui16d-place-host rss MiB: ${Math.round(rss / 1048576)}`);
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
