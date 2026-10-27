// MVUI16 lane P (ARG-pmui-5, P2): fold/unfold on a hidden surface is a typed
// refusal (LAYOUT_ILLEGAL_TRANSITION), never a silent drop. The oracle drives
// the direct/programmatic path (dispatchMultislot via the App mount), which
// the MultislotHost UI guard does not cover. Negative: bare-return mutant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSfc, gate, mountApp, commitPlacement, mutatedCompiler, flush, nodes, MVUI16_ID } from './mvui16-harness.mjs';

const id = MVUI16_ID;
const outcomeCode = (f) => nodes(f.root).find((n) => n.props?.id === 'mv-host-outcome').props['data-outcome-code'];

async function hiddenFoldOracle(AppCompile) {
  const f = await mountApp({}, AppCompile);
  try {
    await commitPlacement(f, gate.buildMultislotHideIntent(id));
    assert.equal(f.captured.slot.attrs.hidden, true);
    for (const op of ['fold', 'unfold']) {
      const sent = f.sent.length;
      f.captured.slot.emit('submit-intent', gate.buildMultislotFoldIntent(op, id), id);
      await flush();
      assert.equal(f.sent.length, sent, `${op} on a hidden surface never reaches the host`);
      assert.equal(outcomeCode(f), 'LAYOUT_ILLEGAL_TRANSITION', `${op} refusal is typed`);
    }
  } finally { f.close(); }
}

test('fold and unfold on a hidden surface refuse with the typed code', async () => {
  await hiddenFoldOracle(compileSfc);
});

test('negative control: bare-return mutant leaves the outcome unset', async () => {
  const compile = mutatedCompiler('App.vue', (source) => source.replace(
    'if (placements.value[capsuleId]?.hidden) { hostOutcome.value = { code:\'LAYOUT_ILLEGAL_TRANSITION\', message:\'\', tone:\'refusal\' }; return; }',
    'if (placements.value[capsuleId]?.hidden) return;'));
  await assert.rejects(() => hiddenFoldOracle(compile), { code: 'ERR_ASSERTION' });
});

test('mvui16 memory ceiling', () => {
  const rss = process.memoryUsage().rss;
  if (process.env.MVUI16_MEASURE) console.log(`mvui16-hidden-fold rss MiB: ${Math.round(rss / 1048576)}`);
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
