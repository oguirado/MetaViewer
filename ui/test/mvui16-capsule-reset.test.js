// MVUI16 lane P (ARG-pmui-6, P2): placement refusal + drafts reset when the
// capsule switches (the host stays mounted, no :key on the parent mount).
// Negative control: a mutant without the capsuleId watch keeps the stale row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSfc, mountHost, hostButton, mutatedCompiler, flush, nodes, text, MVUI16_ID } from './mvui16-harness.mjs';

const id = MVUI16_ID;

async function capsuleResetOracle(compile) {
  const f = await mountHost({}, null, compile);
  try {
    hostButton(f, id, 'group').props.onInput({ target: { value: 'group-a' } });
    hostButton(f, id, 'index').props.onInput({ target: { value: '256' } });
    await flush();
    hostButton(f, id, 'move').props.onClick();
    await flush();
    assert.equal(f.emitted.length, 0, 'invalid draft sends nothing');
    assert.match(text(f.root), /Choose a valid group/);
    f.props.capsuleId = 'cap-2';
    await flush();
    assert.doesNotMatch(text(f.root), /Choose a valid group/, 'refusal clears on capsule switch');
    assert.equal(nodes(f.root).find((n) => n.props?.id === 'mv-multislot-cap-2-placement-refusal'), undefined);
    assert.equal(hostButton(f, 'cap-2', 'group').props.value, '');
    assert.equal(hostButton(f, 'cap-2', 'index').props.value, '');
  } finally { f.app.unmount(); }
}

test('switching capsules clears the placement refusal and drafts', async () => {
  await capsuleResetOracle(compileSfc);
});

test('negative control: mutant without the watch keeps the stale refusal', async () => {
  const compile = mutatedCompiler('multislot/MultislotHost.vue', (source) => source.replace(
    'watch(() => props.capsuleId, () => { placementRefusal.value = null; placementGroup.value = \'\'; placementIndexInput.value = \'\'; });',
    ''));
  await assert.rejects(() => capsuleResetOracle(compile), { code: 'ERR_ASSERTION' });
});

test('mvui16 memory ceiling', () => {
  const rss = process.memoryUsage().rss;
  if (process.env.MVUI16_MEASURE) console.log(`mvui16-capsule-reset rss MiB: ${Math.round(rss / 1048576)}`);
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
