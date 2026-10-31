// REC-STATE: tile recording badge (live mm:ss + typed reason), the exact wall
// hook for TileCaptureChrome.vue, and the capture store's typed failure
// reason. Mutants prove each guard. Wall files are read only here.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as vue from 'vue';
import { recordingBadgeCopy } from '../src/recording/recordingBadge.js';
import { tileBadgeAnchor, tileBadgeDomId, tileBadgeText } from '../src/wall/tileCapture.js';
import {
  RECORD_BUTTON_STUB, byId, fakeClock, flush, importMutant, mount, mutantMustFail,
  sfc, storeWith, textOf, UI_ROOT,
} from './recstate-helpers.mjs';

const CAP = 'cap-1';
const BADGE = tileBadgeDomId(CAP);
const spec = (rel) => new URL(rel, UI_ROOT).href;

test('badge copy: phase word, live clock, typed reason, no leaked code', () => {
  assert.deepEqual(recordingBadgeCopy({ phase: 'idle', elapsedMs: 0, code: '' }), { text: 'Idle', title: 'Phase idle', reason: '' });
  assert.equal(recordingBadgeCopy({ phase: 'recording', elapsedMs: 125_000 }).text, 'Recording 02:05');
  assert.equal(recordingBadgeCopy({ phase: 'recording', elapsedMs: null }).text, 'Recording --:--');
  assert.equal(recordingBadgeCopy({ phase: 'recording', elapsedMs: -1 }).text, 'Recording --:--');
  assert.equal(recordingBadgeCopy({ phase: 'starting' }).text, 'Starting');
  assert.equal(recordingBadgeCopy({ phase: 'stopping' }).text, 'Stopping');
  assert.equal(recordingBadgeCopy({ phase: 'sealed' }).text, 'Sealed');
  const failed = recordingBadgeCopy({ phase: 'error', code: 'RECORDING_FAILED' });
  assert.match(failed.text, /^Idle — The recording failed/);
  assert.equal(failed.title, failed.reason);
  assert.ok(!failed.text.includes('RECORDING_FAILED'));
  assert.match(recordingBadgeCopy({ phase: 'idle', code: 'BUDGET_EXCEEDED' }).text, /^Idle — The host refused/);
  assert.match(recordingBadgeCopy({ phase: 'recording', elapsedMs: 5000, code: 'POLICY' }).text, /^Recording 00:05 — /);
  // the wall helper stays untouched: its static copy equals ours when healthy
  for (const [phase, elapsedMs] of [['idle', 0], ['recording', 61_000], ['starting', 0], ['stopping', 0], ['sealed', 0], ['error', 0]]) {
    assert.equal(recordingBadgeCopy({ phase, elapsedMs }).text, tileBadgeText({ phase, elapsedMs }), phase);
  }
});

async function checkBadge(Badge) {
  const clock = fakeClock();
  const store = storeWith(CAP, { phase: 'recording', recordingId: 'rec-1', elapsedMs: 4000 });
  const mounted = mount(Badge, { capsuleId: CAP, captureState: store, clock });
  try {
    const node = byId(mounted, BADGE);
    assert.ok(node, 'wall badge id kept');
    assert.equal(node.props['data-semantic-anchor'], tileBadgeAnchor(CAP));
    assert.equal(node.props.role, 'status');
    assert.equal(node.props.class, 'mv-tile-chrome__badge');
    assert.equal(node.props['data-variant'], 'recording');
    assert.equal(textOf(node).trim(), 'Recording 00:04');
    clock.advance(2000); await flush();
    assert.equal(textOf(byId(mounted, BADGE)).trim(), 'Recording 00:06', 'ticks between host events');
    store.bySurface[CAP].elapsedMs = 20_000; await flush();
    assert.equal(textOf(byId(mounted, BADGE)).trim(), 'Recording 00:20');
    // stop with a typed refusal: idle, reason visible, timer gone
    Object.assign(store.bySurface[CAP], { phase: 'idle', recordingId: null, elapsedMs: 0, lastCode: 'BUDGET_EXCEEDED' }); await flush();
    const idle = byId(mounted, BADGE);
    assert.equal(idle.props['data-variant'], 'idle');
    assert.equal(idle.props['data-error-code'], 'BUDGET_EXCEEDED');
    assert.match(textOf(idle), /^Idle — The host refused/);
    assert.equal(clock.active, 0);
    // failure event
    Object.assign(store.bySurface[CAP], { phase: 'error', lastCode: 'RECORDING_FAILED' }); await flush();
    assert.match(textOf(byId(mounted, BADGE)), /recording failed/i);
    // healthy idle again
    Object.assign(store.bySurface[CAP], { phase: 'idle', lastCode: '' }); await flush();
    assert.equal(textOf(byId(mounted, BADGE)).trim(), 'Idle');
    assert.equal(byId(mounted, BADGE).props['data-error-code'], undefined);
  } finally { mounted.close(); }
  assert.equal(clock.active, 0);
  // a missing store or surface is a plain idle badge, never a throw
  for (const captureState of [null, { bySurface: {} }, { bySurface: new Map() }]) {
    const bare = mount(Badge, { capsuleId: CAP, captureState, clock: fakeClock() });
    try { assert.equal(textOf(byId(bare, BADGE)).trim(), 'Idle'); } finally { bare.close(); }
  }
  // late-arriving entry on a reactive store
  const late = { bySurface: vue.reactive({}) };
  const lateClock = fakeClock();
  const lateMount = mount(Badge, { capsuleId: CAP, captureState: late, clock: lateClock });
  try {
    late.bySurface[CAP] = { phase: 'recording', elapsedMs: 9000 }; await flush();
    assert.equal(textOf(byId(lateMount, BADGE)).trim(), 'Recording 00:09');
    lateClock.advance(1000); await flush();
    assert.equal(textOf(byId(lateMount, BADGE)).trim(), 'Recording 00:10');
  } finally { lateMount.close(); }
}

const badgeMaps = { specifiers: { './useRecordingElapsed.js': spec('src/recording/useRecordingElapsed.js'), './recordingBadge.js': spec('src/recording/recordingBadge.js'), '../wall/tileCapture.js': spec('src/wall/tileCapture.js') } };

test('RecordingBadge: wall ids/anchors kept, red recording variant, live mm:ss, typed reason', async () => checkBadge(await sfc('src/recording/RecordingBadge.vue', [], badgeMaps)));

const BADGE_MUTANTS = [
  ['drop the recording variant', [[':data-variant="variant"', ':data-variant="\'idle\'"']]],
  ['drop the status role', [['role="status"', '']]],
  ['drop the wall anchor', [[':data-semantic-anchor="tileBadgeAnchor(props.capsuleId)"', '']]],
  ['hide the typed reason', [['{{ copy.text }}', '{{ copy.text.split(" \\u2014 ")[0] }}']]],
  ['render store events only, no local tick', [['elapsedMs: elapsed.value, code', 'elapsedMs: entry.value?.elapsedMs, code']]],
  ['hard-code a zero readout', [['elapsedMs: elapsed.value, code', 'elapsedMs: 0, code']]],
  ['drop the error-code attribute', [[':data-error-code="copy.reason ? code : undefined"', '']]],
];
for (const [label, edits] of BADGE_MUTANTS) {
  test(`badge mutant must fail: ${label}`, async () => {
    const Badge = await sfc('src/recording/RecordingBadge.vue', edits, badgeMaps);
    await mutantMustFail(() => checkBadge(Badge), label);
  });
}

// The exact hook for the wall owner: swap the static badge span for the
// component. Applied here to a copy, never to the wall file.
export const WALL_HOOK = [
  ["import SidebarIcon from '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue';\n",
    "import SidebarIcon from '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue';\nimport RecordingBadge from '../recording/RecordingBadge.vue';\n"],
  [`    <span
      :id="badgeId"
      class="mv-tile-chrome__badge"
      :data-variant="badgeVariant"
      role="status"
      :data-semantic-anchor="badgeAnchor"
      :title="badgeTitle"
    >{{ badgeText }}</span>`,
  '    <RecordingBadge :capsule-id="props.capsuleId" :capture-state="props.captureState" />'],
];

async function chromeWith(edits, clock) {
  const Badge = await sfc('src/recording/RecordingBadge.vue', [], badgeMaps);
  const Chrome = await sfc('src/wall/TileCaptureChrome.vue', edits, {
    components: {
      '../../.kit/capsule-ui-kit/src/saas/SaasRecordButton.vue': RECORD_BUTTON_STUB,
      '../recording/RecordingBadge.vue': vue.defineComponent({ props: ['captureState', 'capsuleId'], render() { return vue.h(Badge, { capsuleId: this.capsuleId, captureState: this.captureState, clock }); } }),
    },
    specifiers: { './tileCapture.js': spec('src/wall/tileCapture.js') },
  });
  return Chrome;
}

test('wall hook: TileCaptureChrome with the hook ticks between host events; the unhooked chrome is static', async () => {
  const clock = fakeClock();
  const hooked = await chromeWith(WALL_HOOK, clock);
  const store = storeWith(CAP, { phase: 'recording', recordingId: 'rec-1', elapsedMs: 7000 });
  const mounted = mount(hooked, { capsuleId: CAP, capsuleLabel: 'Cap', captureState: store });
  try {
    assert.equal(textOf(byId(mounted, BADGE)).trim(), 'Recording 00:07');
    clock.advance(3000); await flush();
    assert.equal(textOf(byId(mounted, BADGE)).trim(), 'Recording 00:10');
    assert.equal(byId(mounted, BADGE).props['data-variant'], 'recording');
  } finally { mounted.close(); }
  // negative control: without the hook the badge only repaints on events
  const plain = await chromeWith([], clock);
  const frozenStore = storeWith(CAP, { phase: 'recording', recordingId: 'rec-1', elapsedMs: 7000 });
  const frozen = mount(plain, { capsuleId: CAP, capsuleLabel: 'Cap', captureState: frozenStore });
  try {
    clock.advance(3000); await flush();
    assert.equal(textOf(byId(frozen, BADGE)).trim(), 'Recording 00:07', 'unhooked badge is frozen between events');
  } finally { frozen.close(); }
});

test('wall hook: the edit targets exist verbatim (a wall refactor fails here, not silently)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const source = readFileSync(fileURLToPath(new URL('src/wall/TileCaptureChrome.vue', UI_ROOT)), 'utf8');
  for (const [from] of WALL_HOOK) assert.ok(source.includes(from), from.slice(0, 60));
});

// Capture store: a host `error` event leaves a typed reason, cleared on recovery.
function checkStoreReason(mod) {
  let deliver = () => {};
  const port = {
    async screenshot() { return { ok: false, code: 'CAPTURE_UNAVAILABLE' }; },
    async recordStart() { return { ok: true, recording_id: 'rec-1' }; },
    async recordStop() { return { ok: true }; },
    async list() { return { ok: true, rows: [] }; },
    subscribe(callback) { deliver = callback; return () => {}; },
  };
  const state = mod.createCaptureState(port);
  const send = (phase, extra = {}) => deliver({ type: 'capture.state', recording_id: 'rec-1', surface_id: CAP, phase, frames: 0, elapsed_ms: 0, ...extra });
  send('recording', { elapsed_ms: 1000 });
  assert.equal(state.bySurface[CAP].lastCode, '');
  send('error', { elapsed_ms: 2000 });
  assert.equal(state.bySurface[CAP].phase, 'error');
  assert.equal(state.bySurface[CAP].lastCode, 'RECORDING_FAILED');
  assert.equal(state.bySurface[CAP].recordingId, null);
  send('recording', { elapsed_ms: 0, recording_id: 'rec-2' });
  assert.equal(state.bySurface[CAP].lastCode, '', 'a healthy recording clears the failure reason');
  state.dispose();
}
test('capture store: a host error event leaves the typed RECORDING_FAILED reason; recovery clears it', async () => {
  checkStoreReason(await import('../src/capture/capturePort.js'));
});

for (const [label, edits] of [
  ['silent fall on a host error', [["if (event.phase === 'error') entry.lastCode", "if (false) entry.lastCode"]]],
  ['sticky failure reason', [["else if (event.phase === 'recording' && entry.lastCode", "else if (false && entry.lastCode"]]],
]) {
  test(`capture store mutant must fail: ${label}`, async () => {
    const mod = await importMutant('src/capture/capturePort.js', edits);
    await mutantMustFail(() => checkStoreReason(mod), label);
  });
}
