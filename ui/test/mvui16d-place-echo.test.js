// MVUI16D lane P: App-level placement-echo and L2-1 regressions.
// (1) JUDGE_p1 note 1: a newer successful layout echo clears an older failed
// echo for the capsule, so @ready never replays stale geometry over a newer
// commit (newest-wins on repeated failure). (2) L2-1: purely local view/mode
// toggles never reach the host; fold/unfold forward unchanged (the kit slot
// id is the pinned wire contract and the host resolves it, so no renderer
// mapping belongs on that path). Negatives: mutants dropping the delete,
// remapping the slot, or restoring the fall-through fail the oracles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSfc, gate, mountApp, mutatedCompiler, flush, text, deferred, boundedPush, MVUI16_ID } from './mvui16-harness.mjs';

const id = MVUI16_ID;
const ECHO_FAILURE = Object.freeze({ ok: false, error: Object.freeze({ code: 'ERR_NOT_READY', message: 'wall is not ready' }) });
const ECHO_OK = Object.freeze({ ok: true, value: Object.freeze({ panelId: `panel-${id}` }) });

// App mount with a recording propose port (the shared harness omits propose).
async function mountEchoApp(AppCompile, options) {
  const intentCalls = [];
  const proposeCalls = [];
  const f = await mountApp({
    authorityHost: {
      intent: (body) => { const wait = deferred(); boundedPush(intentCalls, { body, ...wait }); return wait.promise; },
      propose: async (body) => { boundedPush(proposeCalls, body); return { code: 'POLICY', message: 'refused', tone: 'refusal' }; },
    },
  }, AppCompile, options);
  return { ...f, intentCalls, proposeCalls };
}

async function commitIntent(f, body) {
  f.captured.slot.emit('submit-intent', body, id);
  await flush();
  f.intentCalls.at(-1).resolve(true);
  await flush();
}

async function staleEchoOracle(AppCompile) {
  const options = { echoResult: ECHO_FAILURE };
  const f = await mountEchoApp(AppCompile, options);
  try {
    await commitIntent(f, gate.buildMultislotFloatIntent(id, { x: 10, y: 20, width: 300, height: 200 }));
    assert.equal(f.captured.slot.attrs.floating, true);
    assert.equal(f.echoes.length, 1);
    options.echoResult = ECHO_OK;
    await commitIntent(f, gate.buildMultislotHideIntent(id));
    assert.equal(f.captured.slot.attrs.hidden, true);
    assert.equal(f.echoes.length, 2);
    f.captured.wall.emit('ready');
    await flush();
    assert.equal(f.echoes.length, 2, 'stale failed echo never replays after a newer success');
  } finally { f.close(); }
}

test('a newer successful echo clears an older failed echo for the capsule', async () => {
  await staleEchoOracle(compileSfc);
});

test('negative control: mutant keeping the stale retry replays on @ready', async () => {
  const compile = mutatedCompiler('App.vue', (source) => source.replace(
    '      pendingEchoRetry.delete(capsuleId);', ''));
  await assert.rejects(() => staleEchoOracle(compile), { code: 'ERR_ASSERTION' });
});

test('newest failure wins: repeated failures retry only the latest body', async () => {
  const f = await mountEchoApp(compileSfc, { echoResult: ECHO_FAILURE });
  try {
    await commitIntent(f, gate.buildMultislotFloatIntent(id, { x: 10, y: 20, width: 300, height: 200 }));
    await commitIntent(f, gate.buildMultislotMoveIntent(id, 'group-a', 0));
    assert.equal(f.echoes.length, 2);
    f.captured.wall.emit('ready');
    await flush();
    assert.equal(f.echoes.length, 3, 'one single-shot retry');
    assert.equal(f.echoes[2][1].op, 'move', 'retry carries the newest failed body');
    assert.equal(f.echoes[2][1].params.group_id, 'group-a');
  } finally { f.close(); }
});

async function foldPassthroughOracle(AppCompile) {
  const f = await mountEchoApp(AppCompile, {});
  try {
    for (const op of ['fold', 'unfold']) {
      const body = gate.buildMultislotFoldIntent(op, id);
      f.captured.slot.emit('submit-intent', body, id);
      await flush();
      assert.equal(f.intentCalls.length, 1);
      assert.deepEqual(f.intentCalls.at(-1).body, body, `${op} forwards unchanged`);
      f.intentCalls.at(-1).resolve(true);
      await flush();
      assert.equal(f.captured.slot.attrs.folded, op === 'fold');
      f.intentCalls.length = 0;
    }
    assert.equal(f.proposeCalls.length, 0, 'fold never touches the proposal path');
  } finally { f.close(); }
}

test('fold and unfold forward unchanged (kit slot is the pinned wire contract)', async () => {
  await foldPassthroughOracle(compileSfc);
});

test('negative control: mutant remapping the slot breaks the pinned passthrough', async () => {
  const compile = mutatedCompiler('App.vue', (source) => source.replace(
    'const result = await submitIntent?.(intent);',
    'const result = await submitIntent?.({ ...intent, params: { slot_id: capsuleId } });'));
  await assert.rejects(() => foldPassthroughOracle(compile), { code: 'ERR_ASSERTION' });
});

async function localToggleOracle(AppCompile) {
  const f = await mountEchoApp(AppCompile, {});
  try {
    for (const type of ['hide-surface', 'show-surface', 'hide-terminal', 'show-terminal',
        'input-mode-read', 'input-mode-write', 'copy-id', 'bogus-type']) {
      f.captured.slot.emit('submit-intent', { type }, id);
      await flush();
    }
    assert.equal(f.intentCalls.length, 0, 'local toggles never reach intent');
    assert.equal(f.proposeCalls.length, 0, 'local toggles never reach propose');
    assert.equal(f.local.length, 0, 'local toggles are not even re-emitted');
    assert.doesNotMatch(text(f.root), /Please try again/, 'no red unavailable toast');
  } finally { f.close(); }
}

test('purely local toggles never reach the host', async () => {
  await localToggleOracle(compileSfc);
});

test('negative control: mutant restoring the fall-through leaks toggles to propose', async () => {
  const compile = mutatedCompiler('App.vue', (source) => source.replace(
    `  if (op || record?.type?.startsWith('creative/')) {`,
    '  if (true) {'));
  await assert.rejects(() => localToggleOracle(compile), { code: 'ERR_ASSERTION' });
});

test('host-bound control intents still forward through dispatchMultislot', async () => {
  const f = await mountEchoApp(compileSfc, {});
  try {
    const body = { schema: 'ui_intent/v0.2', request_id: 'mvui16d-tc-1', op: 'take_control', params: { surface_id: id } };
    f.captured.slot.emit('submit-intent', body, id);
    await flush();
    assert.equal(f.intentCalls.length, 1, 'selective gate, not a blanket drop');
    assert.deepEqual(f.intentCalls[0].body, body);
    assert.equal(f.proposeCalls.length, 0);
    f.intentCalls.at(-1).resolve(true);
    await flush();
  } finally { f.close(); }
});

test('mvui16d memory ceiling', () => {
  const rss = process.memoryUsage().rss;
  if (process.env.MVUI16_MEASURE) console.log(`mvui16d-place-echo rss MiB: ${Math.round(rss / 1048576)}`);
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
