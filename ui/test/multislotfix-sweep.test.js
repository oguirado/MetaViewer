// MULTISLOT-FIX: sweep findings F1..F5 on the Open-in-multislot flow. Each
// oracle mounts the real MultislotHost / App SFC through the MVUI16 harness
// and has an in-memory source mutant (negative control) that must fail it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { compileSfc, mountHost, mountApp, mutatedCompiler, flush, nodes, text, MVUI16_ID } from './mvui16-harness.mjs';

const id = MVUI16_ID;
const button = (f, suffix) => nodes(f.root).find((n) => n.props?.id === `mv-multislot-${id}-${suffix}`);
const typed = (value) => ({ target: { value } });
const hostCompiler = (mutate) => mutatedCompiler('multislot/MultislotHost.vue', mutate);
const appCompiler = (mutate) => mutatedCompiler('App.vue', mutate);

// F1: the bar Close arms and confirms to nothing; the host must disable it.
async function closeOracle(compile) {
  const f = await mountHost({}, null, compile);
  try {
    assert.equal(f.children.bar.attrs['close-disabled'], true, 'Close is disabled, not armable');
    assert.match(String(f.children.bar.attrs['close-reason']), /\S/, 'Close carries a visible reason');
    f.children.bar.emit('submit-intent', { type: 'close', capsuleId: id });
    await flush();
    assert.equal(f.emitted.length, 0, 'a stray close intent never reaches the parent');
  } finally { f.app.unmount(); }
}
test('F1: slot Close is disabled with a reason and a stray close intent is dropped', async () => {
  await closeOracle(compileSfc);
});
test('F1 negative control: Close without the disabled binding fails the oracle', async () => {
  const compile = hostCompiler((s) => s.replace(':close-disabled="true" :close-reason="CLOSE_UNAVAILABLE_REASON"', ''));
  await assert.rejects(() => closeOracle(compile), { code: 'ERR_ASSERTION' });
});

// F2: losing the last capsule while multislot is open must leave a visible
// screen with Back (never a Back-less stranded flag).
async function strandOracle(compile) {
  const row = () => reactive({ id, surfaceId: id, title: 'Capsule', generation: 1, visibility: 'unfolded', control: 'human', backendLifecycle: 'active' });
  const state = reactive({ rows: [row()] });
  const feed = { getSnapshot: () => null, getProjection: () => ({ rows: state.rows }), subscribe: () => () => {} };
  const f = await mountApp({ runtime: { projectionView: feed } }, compile);
  const byId = (anchor) => nodes(f.root).find((n) => n.props?.id === anchor);
  try {
    assert.ok(byId('multislot-back'), 'Back is present with a capsule');
    state.rows = [];
    await flush();
    assert.ok(byId('multislot-back'), 'Back survives losing the last capsule');
    assert.ok(byId('multislot-empty'), 'an explicit empty notice replaces the silent wall');
    state.rows = [row()];
    await flush();
    assert.equal(byId('multislot-empty'), undefined, 'the notice leaves with the empty state');
    assert.ok(byId('multislot-back'));
  } finally { f.close(); }
}
test('F2: losing the last capsule keeps Back and an empty notice on the multislot screen', async () => {
  await strandOracle(compileSfc);
});
test('F2 negative control: the original v-if selectedSurface section fails the oracle', async () => {
  const compile = appCompiler((s) => s.replace('v-if="multislotOpen && !nestedMode.displayOnly" class="mv-multislot-screen"',
    'v-if="multislotOpen && selectedSurface && !nestedMode.displayOnly" class="mv-multislot-screen"'));
  await assert.rejects(() => strandOracle(compile), { code: 'ERR_ASSERTION' });
});

// F3: Move/Tab on the pristine form must submit the current group and index.
async function placementOracle(compile) {
  const f = await mountHost({ groupId: 'dock-a', placementIndex: 3 }, null, compile);
  try {
    assert.match(text(button(f, 'placement-current')), /group dock-a, position 3/, 'current placement is shown');
    for (const op of ['move', 'tab']) {
      const before = f.emitted.length;
      button(f, op).props.onClick();
      await flush();
      assert.equal(f.emitted.length, before + 1, `${op} is admitted, not refused`);
      const [body] = f.emitted.at(-1);
      assert.equal(body.op, op, `${op} submits on the first click`);
      assert.deepEqual([body.params.group_id, body.params.index], ['dock-a', 3]);
    }
    button(f, 'group').props.onInput(typed('dock-b'));
    button(f, 'index').props.onInput(typed('5'));
    await flush();
    button(f, 'move').props.onClick();
    await flush();
    const [body] = f.emitted.at(-1);
    assert.deepEqual([body.params.group_id, body.params.index], ['dock-b', 5], 'a typed draft wins');
  } finally { f.app.unmount(); }
}
test('F3: pristine Move/Tab submit the current placement and a typed draft wins', async () => {
  await placementOracle(compileSfc);
});
test('F3: a never-placed slot falls back to the dock default', async () => {
  const f = await mountHost({});
  try {
    button(f, 'move').props.onClick();
    await flush();
    assert.deepEqual([f.emitted.at(-1)[0].params.group_id, f.emitted.at(-1)[0].params.index], ['multislot-dock', 0]);
    assert.equal(button(f, 'refusal'), undefined, 'no refusal row');
  } finally { f.app.unmount(); }
});
test('F3 negative control: raw blank fields fail the oracle', async () => {
  const compile = hostCompiler((s) => s.replace("placementGroup.value.trim() === '' ? currentGroup.value : placementGroup.value", 'placementGroup.value'));
  await assert.rejects(() => placementOracle(compile), { code: 'ERR_ASSERTION' });
});
test('F3: an invalid draft index still refuses with the typed row', async () => {
  const f = await mountHost({ groupId: 'dock-a', placementIndex: 3 });
  try {
    button(f, 'index').props.onInput(typed('x9'));
    await flush();
    button(f, 'move').props.onClick();
    await flush();
    assert.equal(f.emitted.length, 0);
    assert.equal(button(f, 'placement-refusal').props['data-error-code'], 'ERR_INVALID_PLACEMENT_INPUT');
  } finally { f.app.unmount(); }
});

// F4: WRITE under agent control is disabled with a reason and never emitted.
async function agentWriteOracle(compile) {
  const updates = [];
  const f = await mountHost({ agentControlled: true, inputMode: 'read', 'onUpdate:inputMode': (m) => updates.push(m) }, null, compile);
  try {
    assert.equal(f.children.bar.attrs['input-mode-disabled'], true);
    assert.match(String(f.children.bar.attrs['input-mode-reason']), /\S/);
    f.children.bar.emit('submit-intent', { type: 'input-mode-write', capsuleId: id });
    await flush();
    assert.deepEqual(updates, [], 'no WRITE flash under agent control');
  } finally { f.app.unmount(); }
}
test('F4: agent-controlled slots disable the WRITE chip and never emit WRITE', async () => {
  await agentWriteOracle(compileSfc);
});
test('F4 negative control: the unguarded host fails the oracle', async () => {
  const compile = hostCompiler((s) => s.replace("if (type === 'input-mode-write' && props.agentControlled === true) return;", ''));
  await assert.rejects(() => agentWriteOracle(compile), { code: 'ERR_ASSERTION' });
  const bare = hostCompiler((s) => s.replace(':input-mode-disabled="agentControlled" :input-mode-reason="agentControlled ? AGENT_WRITE_REASON : \'\'"', ''));
  await assert.rejects(() => agentWriteOracle(bare), { code: 'ERR_ASSERTION' });
});
test('F4: human-controlled slots still toggle WRITE', async () => {
  const updates = [];
  const f = await mountHost({ inputMode: 'read', 'onUpdate:inputMode': (m) => updates.push(m) });
  try {
    assert.equal(f.children.bar.attrs['input-mode-disabled'], false);
    f.children.bar.emit('submit-intent', { type: 'input-mode-write', capsuleId: id });
    await flush();
    assert.deepEqual(updates, ['write']);
  } finally { f.app.unmount(); }
});

// F5: the folded rail needs the real surface state from the App.
async function surfaceStateOracle(compile) {
  const f = await mountApp({ fixture: { key: 'multislot', ui: { liveReplay: true }, capsules: [{ id }] } }, compile);
  try {
    assert.equal(f.captured.slot.attrs['surface-state'], 'connecting', 'unbound surface is connecting');
    f.setRow({ attachmentState: 'live' });
    await flush();
    assert.equal(f.captured.slot.attrs['surface-state'], 'live');
    f.setRow({ backendLifecycle: 'lost' });
    await flush();
    assert.equal(f.captured.slot.attrs['surface-state'], 'lost', 'a lost surface reaches the rail');
  } finally { f.close(); }
}
test('F5: App binds the selected surface state onto the multislot host', async () => {
  await surfaceStateOracle(compileSfc);
});
test('F5 negative control: dropping the binding fails the oracle', async () => {
  const compile = appCompiler((s) => s.replace(':surface-state="canvasStateFor(selectedSurface)" ', ''));
  await assert.rejects(() => surfaceStateOracle(compile), { code: 'ERR_ASSERTION' });
});

test('multislotfix memory ceiling', () => {
  assert.ok(process.memoryUsage().rss < 512 * 1024 * 1024);
});
