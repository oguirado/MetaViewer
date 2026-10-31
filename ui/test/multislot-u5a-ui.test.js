// U5a-MULTISLOT-UI: + AI slot, state chip, slot heights, fold without killing
// the session, and Copy ID for the slot. Every guard ships with a unit test,
// a mounted MultislotHost SFC oracle, and an in-memory source mutant
// (negative control) that must fail the oracle when the guard is reverted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileSfc,
  mountHost,
  mutatedCompiler,
  flush,
  nodes,
  text,
  MVUI16_ID,
} from './mvui16-harness.mjs';
import {
  MULTISLOT_ACTIVITY_STATES,
  MULTISLOT_DEFAULT_HEIGHT,
  MULTISLOT_FOLDED_HEIGHT,
  MULTISLOT_HEIGHT_PRESETS,
  MULTISLOT_HEIGHT_REFUSAL,
  MULTISLOT_HEIGHT_STEP,
  MULTISLOT_MAX_HEIGHT,
  MULTISLOT_MIN_HEIGHT,
  MULTISLOT_STATE_CHIP_LABELS,
  MULTISLOT_STATE_CHIP_VALUES,
  clampMultislotHeight,
  effectiveMultislotHeight,
  normalizeMultislotActivityState,
  normalizeMultislotHeightPreset,
  resolveMultislotStateChip,
  stepMultislotHeight,
} from '../src/multislot/multislotInputGate.js';
import {
  LAUNCH_REFUSALS,
  MULTISLOT_MAX_SESSIONS,
  SESSION_LIMIT_MESSAGE,
  canLaunchSlotSession,
  normalizeLaunchError,
  resolveDefaultSlotLaunch,
  toKitMenuProviders,
} from '../src/multislot/multislotProviders.js';
import {
  copyAvailable,
  createCopyCapsuleId,
  resolveSlotCopyText,
} from '../src/multislot/multislotCopy.js';
import { createSideTerminalBrokerFacade } from '../src/terminal/sideTerminalFacade.js';
import {
  TERMINAL_LIVE_PROVIDERS,
  TERMINAL_LIVE_SESSION,
  createTerminalLiveHarness,
} from '../src/fixtures/terminalLive.js';

const id = MVUI16_ID;
const hostCompiler = (mutate) => mutatedCompiler('multislot/MultislotHost.vue', mutate);
const byId = (f, domId) => nodes(f.root).find((n) => n.props?.id === domId);

// ---------------------------------------------------------------------------
// 1. Pure unit tests: slot heights, state chip, + AI slot launch, Copy ID
// ---------------------------------------------------------------------------

test('U5a pure: canonical slot height constants and helpers enforce bounds', () => {
  assert.deepEqual(MULTISLOT_HEIGHT_PRESETS, [200, 360, 540]);
  assert.ok(Object.isFrozen(MULTISLOT_HEIGHT_PRESETS));
  assert.equal(MULTISLOT_DEFAULT_HEIGHT, 360);
  assert.equal(MULTISLOT_FOLDED_HEIGHT, 38);
  assert.equal(MULTISLOT_HEIGHT_STEP, 40);
  assert.equal(MULTISLOT_MIN_HEIGHT, 140);
  assert.equal(MULTISLOT_MAX_HEIGHT, 1600);

  for (const preset of [200, 360, 540, '200', '360', '540']) {
    assert.equal(normalizeMultislotHeightPreset(preset), Number(preset));
  }
  for (const invalid of [140, 300, 1600, -360, '360px', '', null, undefined, NaN, Infinity]) {
    assert.equal(normalizeMultislotHeightPreset(invalid), null);
  }

  assert.equal(clampMultislotHeight(360), 360);
  assert.equal(clampMultislotHeight(50), 140);
  assert.equal(clampMultislotHeight(2400), 1600);
  assert.equal(clampMultislotHeight(279.6), 280);
  assert.equal(clampMultislotHeight(NaN, 540), 540);
  assert.equal(clampMultislotHeight('bad'), 360);

  assert.equal(stepMultislotHeight(360, 1), 400);
  assert.equal(stepMultislotHeight(360, -1), 320);
  assert.equal(stepMultislotHeight(1580, 1), 1600);
  assert.equal(stepMultislotHeight(150, -1), 140);
  assert.equal(stepMultislotHeight(360, 1.5), 360);

  assert.equal(effectiveMultislotHeight(540, false), 540);
  assert.equal(effectiveMultislotHeight(540, true), 38);
});

test('U5a pure: state chip resolves only from authenticated lifecycle states', () => {
  assert.ok(Object.isFrozen(MULTISLOT_ACTIVITY_STATES));
  assert.ok(Object.isFrozen(MULTISLOT_STATE_CHIP_VALUES));
  assert.ok(Object.isFrozen(MULTISLOT_STATE_CHIP_LABELS));

  for (const valid of MULTISLOT_ACTIVITY_STATES) {
    assert.equal(normalizeMultislotActivityState(valid), valid);
  }
  for (const bogus of ['\x1b]0;busy\x07', 'READY', 'running', null, undefined, 42, {}]) {
    assert.equal(normalizeMultislotActivityState(bogus), 'unknown');
  }

  assert.deepEqual(
    resolveMultislotStateChip({ surfaceState: 'lost', activityState: 'ready', attachmentState: 'live', sessionCount: 2 }),
    { state: 'capsule_gone', activityState: 'failed', label: 'Capsule gone', tone: 'error' },
  );
  assert.deepEqual(
    resolveMultislotStateChip({ surfaceState: 'live', activityState: 'unknown', attachmentState: 'live', sessionCount: 1 }),
    { state: 'ready', activityState: 'ready', label: 'Ready', tone: 'ready' },
  );
  assert.deepEqual(
    resolveMultislotStateChip({ surfaceState: 'live', activityState: 'busy', attachmentState: 'live', sessionCount: 1 }),
    { state: 'busy', activityState: 'busy', label: 'Busy', tone: 'active' },
  );
  assert.deepEqual(
    resolveMultislotStateChip({ surfaceState: 'live', activityState: 'waiting-input', attachmentState: 'live', sessionCount: 1 }),
    { state: 'waiting-input', activityState: 'waiting-input', label: 'Waiting input', tone: 'active' },
  );
  assert.deepEqual(
    resolveMultislotStateChip({ surfaceState: 'live', activityState: 'exited', attachmentState: 'disconnected', sessionCount: 0 }),
    { state: 'exited', activityState: 'exited', label: 'Exited', tone: 'muted' },
  );
  assert.deepEqual(
    resolveMultislotStateChip({ surfaceState: 'live', activityState: 'failed', attachmentState: 'disconnected', sessionCount: 0 }),
    { state: 'failed', activityState: 'failed', label: 'Failed', tone: 'error' },
  );
  assert.deepEqual(
    resolveMultislotStateChip({ surfaceState: 'live', activityState: 'unknown', attachmentState: 'detached', sessionCount: 0 }),
    { state: 'unknown', activityState: 'unknown', label: 'Idle', tone: 'muted' },
  );
});

test('U5a pure: + AI slot session gate and default provider launch resolution', () => {
  assert.equal(MULTISLOT_MAX_SESSIONS, 8);
  assert.match(SESSION_LIMIT_MESSAGE, /close a session/i);
  assert.deepEqual(canLaunchSlotSession({ sessionCount: 0 }), { ok: true });
  assert.deepEqual(canLaunchSlotSession({ sessionCount: 7 }), { ok: true });
  assert.deepEqual(canLaunchSlotSession({ sessionCount: 2, globalSessionCount: 7 }), { ok: true });
  const localCap = canLaunchSlotSession({ sessionCount: 8 });
  assert.equal(localCap.ok, false);
  if (!localCap.ok) {
    assert.equal(localCap.refusal.code, LAUNCH_REFUSALS.SESSION_LIMIT);
    assert.equal(localCap.refusal.message, SESSION_LIMIT_MESSAGE);
  }
  const globalCap = canLaunchSlotSession({ sessionCount: 1, globalSessionCount: 8 });
  assert.equal(globalCap.ok, false);
  if (!globalCap.ok) {
    assert.equal(globalCap.refusal.code, LAUNCH_REFUSALS.SESSION_LIMIT);
    assert.equal(globalCap.refusal.message, SESSION_LIMIT_MESSAGE);
  }
  assert.deepEqual(
    normalizeLaunchError(Object.assign(new Error('SESSION_LIMIT'), { code: 'SESSION_LIMIT' })),
    { code: LAUNCH_REFUSALS.SESSION_LIMIT, message: SESSION_LIMIT_MESSAGE },
  );
  assert.deepEqual(
    normalizeLaunchError(new Error('broker refused: SESSION_LIMIT')),
    { code: LAUNCH_REFUSALS.SESSION_LIMIT, message: SESSION_LIMIT_MESSAGE },
  );
  assert.deepEqual(
    normalizeLaunchError(new Error('other failure')),
    { code: LAUNCH_REFUSALS.COMMAND_UNAVAILABLE, message: 'Launch unavailable.' },
  );
  assert.equal(
    /** @type {{ refusal: { code: string } }} */ (canLaunchSlotSession({ sessionCount: 1, launching: true })).refusal.code,
    LAUNCH_REFUSALS.LAUNCH_BUSY,
  );
  assert.equal(
    /** @type {{ refusal: { code: string } }} */ (canLaunchSlotSession({ sessionCount: 1, hidden: true })).refusal.code,
    'LAYOUT_ILLEGAL_TRANSITION',
  );
  assert.equal(
    /** @type {{ refusal: { code: string } }} */ (canLaunchSlotSession({ sessionCount: 1, surfaceState: 'lost' })).refusal.code,
    LAUNCH_REFUSALS.SURFACE_LOST,
  );

  const providers = toKitMenuProviders(TERMINAL_LIVE_PROVIDERS);
  const preferred = resolveDefaultSlotLaunch({ providers, commands: ['shell', 'provider'] });
  assert.equal(preferred.ok, true);
  if (preferred.ok) {
    assert.equal(preferred.launch.entryId, 'alpha');
    assert.equal(preferred.launch.command, 'provider');
    assert.equal(preferred.launch.kind, 'provider');
  }

  const shellFallback = resolveDefaultSlotLaunch({ providers, commands: ['shell'] });
  assert.equal(shellFallback.ok, true);
  if (shellFallback.ok) {
    assert.equal(shellFallback.launch.entryId, 'shell');
    assert.equal(shellFallback.launch.command, 'shell');
  }

  const none = resolveDefaultSlotLaunch({ providers, commands: [] });
  assert.equal(none.ok, false);
  if (!none.ok) {
    assert.equal(none.refusal.code, LAUNCH_REFUSALS.COMMAND_UNAVAILABLE);
  }
});

test('U5a pure: Copy ID resolves capsuleId and slotId and refuses lost surfaces', async () => {
  assert.deepEqual(resolveSlotCopyText('cap-01', 'capsuleId'), { ok: true, text: 'cap-01' });
  assert.deepEqual(resolveSlotCopyText('cap-01', 'slotId'), { ok: true, text: 'cuk-ai-slot-cap-01' });
  assert.equal(resolveSlotCopyText('bad/id', 'slotId').ok, false);

  const written = [];
  const clipboard = { writeText: async (value) => { written.push(value); } };
  assert.equal(copyAvailable({ clipboard, surfaceState: 'live' }), true);
  assert.equal(copyAvailable({ clipboard, surfaceState: 'lost' }), false);

  const action = createCopyCapsuleId({ clipboard });
  assert.deepEqual(await action.copy('cap-01', { target: 'slotId' }), { state: 'copied', reason: '' });
  assert.deepEqual(written, ['cuk-ai-slot-cap-01']);

  assert.deepEqual(
    await action.copy('cap-01', { target: 'slotId', surfaceState: 'lost' }),
    { state: 'unavailable', reason: 'ERR_SURFACE_LOST' },
  );
  assert.deepEqual(written, ['cuk-ai-slot-cap-01']);
});

// ---------------------------------------------------------------------------
// 2. Mounted SFC oracles and negative-control source mutants
// ---------------------------------------------------------------------------

async function addAiSlotOracle(compile) {
  const harness = createTerminalLiveHarness();
  const modeUpdates = [];
  const refused = [];
  const f = await mountHost(
    {
      capsuleId: id,
      terminalBinding: { session: TERMINAL_LIVE_SESSION, port: harness.sessionPort },
      terminalBroker: harness.brokerPort,
      terminalSessionPort: harness.transport,
      hostProviders: [...TERMINAL_LIVE_PROVIDERS],
      brokerCommands: ['shell', 'provider'],
      inputMode: 'write',
      'onUpdate:inputMode': (m) => modeUpdates.push(m),
      'onLaunch-refused': (r) => refused.push(r),
    },
    null,
    compile,
  );
  try {
    await flush();
    await createSideTerminalBrokerFacade(harness.brokerPort).setEnabled(true);
    await flush();
    const addBtn = byId(f, `mv-multislot-${id}-add-ai-slot`);
    assert.ok(addBtn, '+ AI slot button renders');
    assert.equal(addBtn.props.disabled, false, '+ AI slot is enabled when broker commands are advertised');
    await addBtn.props.onClick();
    await flush();
    await flush();
    assert.deepEqual(modeUpdates, ['read'], '+ AI slot resets input mode to READ by default');
    assert.equal(f.children.slot.attrs.sessions.length, 2, '+ AI slot opens and attaches a second session');
  } finally {
    f.app.unmount();
  }

  // Session cap guard: when 8 sessions are already attached, + AI slot is disabled
  // and a launch request refuses with ERR_LAUNCH_SESSION_LIMIT.
  const eightSessions = Array.from({ length: MULTISLOT_MAX_SESSIONS }, (_, idx) => ({
    session: `sess-${idx + 1}`,
    command: 'shell',
  }));
  let openCalls = 0;
  const capFacade = {
    capabilities: async () => ({ commands: ['shell'] }),
    attach: async () => ({ sessions: eightSessions }),
    open: async () => { openCalls++; return { session: 'sess-overflow' }; },
    onData: () => () => {},
    onExit: () => () => {},
    close() {},
    ack() {},
    write() {},
    dispose() {},
  };
  const cappedRefused = [];
  const cappedModes = [];
  const c = await mountHost(
    {
      capsuleId: id,
      terminalBinding: { session: 'sess-1', port: {} },
      brokerCommands: ['shell'],
      inputMode: 'write',
      'onUpdate:inputMode': (m) => cappedModes.push(m),
      'onLaunch-refused': (r) => cappedRefused.push(r),
    },
    capFacade,
    compile,
  );
  try {
    await flush();
    assert.equal(c.children.slot.attrs.sessions.length, MULTISLOT_MAX_SESSIONS);
    const addBtn = byId(c, `mv-multislot-${id}-add-ai-slot`);
    assert.equal(addBtn.props.disabled, true, '+ AI slot disables at MULTISLOT_MAX_SESSIONS');
    // Invoking + AI slot directly (or submit-intent add-ai-slot) at cap refuses
    // with ERR_LAUNCH_SESSION_LIMIT and close-a-session remedy without mutating inputMode or calling broker.open.
    await addBtn.props.onClick();
    await flush();
    assert.equal(openCalls, 0, 'onAddAiSlot gate prevents broker.open');
    assert.deepEqual(cappedModes, [], 'onAddAiSlot gate prevents inputMode mutation on refused launch');
    assert.equal(cappedRefused.at(-1)?.code, LAUNCH_REFUSALS.SESSION_LIMIT);
    assert.match(String(cappedRefused.at(-1)?.message), /close a session/i);
    assert.equal(byId(c, `mv-multislot-${id}-refusal`)?.props['data-error-code'], LAUNCH_REFUSALS.SESSION_LIMIT);
    assert.match(text(byId(c, `mv-multislot-${id}-refusal`)), /close a session/i);

    c.children.slot.emit('launch-request', { entryId: 'shell', command: 'shell', args: [] });
    await flush();
    assert.equal(openCalls, 0, 'session ceiling prevents broker.open');
    assert.equal(cappedRefused.at(-1)?.code, LAUNCH_REFUSALS.SESSION_LIMIT);
  } finally {
    c.app.unmount();
  }

  // Multi-capsule overflow: two capsules each below the per-capsule count (4 + 4 = 8 global).
  // Capsule A checks the global-count stub (`globalSessionCount = 8`) and blocks before broker.open;
  // Capsule B races into broker.open which rejects with `SESSION_LIMIT`, mapping to the typed
  // ERR_LAUNCH_SESSION_LIMIT refusal with the close-a-session remedy.
  let multiOpenCalls = 0;
  const multiFacade = {
    capabilities: async () => ({ commands: ['shell'] }),
    attach: async () => ({
      sessions: [
        { session: 'cap-sess-1', command: 'shell' },
        { session: 'cap-sess-2', command: 'shell' },
        { session: 'cap-sess-3', command: 'shell' },
        { session: 'cap-sess-4', command: 'shell' },
      ],
    }),
    open: async () => {
      multiOpenCalls++;
      throw Object.assign(new Error('SESSION_LIMIT'), { code: 'SESSION_LIMIT' });
    },
    onData: () => () => {},
    onExit: () => () => {},
    close() {},
    ack() {},
    write() {},
    dispose() {},
  };
  const multiRefusedA = [];
  const capA = await mountHost(
    {
      capsuleId: 'cap-a',
      terminalBinding: { session: 'cap-sess-1', port: {} },
      brokerCommands: ['shell'],
      globalSessionCount: MULTISLOT_MAX_SESSIONS,
      'onLaunch-refused': (r) => multiRefusedA.push(r),
    },
    multiFacade,
    compile,
  );
  try {
    await flush();
    assert.equal(capA.children.slot.attrs.sessions.length, 4, 'capsule A has only 4 local sessions');
    const addBtnA = byId(capA, 'mv-multislot-cap-a-add-ai-slot');
    assert.equal(addBtnA.props.disabled, true, '+ AI slot disables when globalSessionCount reaches 8');
    await addBtnA.props.onClick();
    await flush();
    assert.equal(multiOpenCalls, 0, 'global session count stub prevents broker.open');
    assert.equal(multiRefusedA.at(-1)?.code, LAUNCH_REFUSALS.SESSION_LIMIT);
    assert.match(String(multiRefusedA.at(-1)?.message), /close a session/i);
  } finally {
    capA.app.unmount();
  }

  const multiRefusedB = [];
  const capB = await mountHost(
    {
      capsuleId: 'cap-b',
      terminalBinding: { session: 'cap-sess-1', port: {} },
      brokerCommands: ['shell'],
      globalSessionCount: 7,
      'onLaunch-refused': (r) => multiRefusedB.push(r),
    },
    multiFacade,
    compile,
  );
  try {
    await flush();
    const addBtnB = byId(capB, 'mv-multislot-cap-b-add-ai-slot');
    assert.equal(addBtnB.props.disabled, false, 'capsule B is below the pre-launch count (7 < 8)');
    await addBtnB.props.onClick();
    await flush();
    await flush();
    assert.equal(multiOpenCalls, 1, 'broker.open is attempted when pre-launch count is 7');
    assert.equal(multiRefusedB.at(-1)?.code, LAUNCH_REFUSALS.SESSION_LIMIT, 'broker SESSION_LIMIT maps to ERR_LAUNCH_SESSION_LIMIT');
    assert.match(String(multiRefusedB.at(-1)?.message), /close a session/i);
    const refusalRowB = byId(capB, 'mv-multislot-cap-b-refusal');
    assert.ok(refusalRowB, 'refusal row renders on broker SESSION_LIMIT');
    assert.equal(refusalRowB.props['data-error-code'], LAUNCH_REFUSALS.SESSION_LIMIT);
    assert.match(text(refusalRowB), /close a session/i);
  } finally {
    capB.app.unmount();
  }
}

test('U5a mounted: + AI slot launches in READ mode and enforces the global 8-session ceiling across capsules', async () => {
  await addAiSlotOracle(compileSfc);
});

test('U5a mutant: removing the session-ceiling check in onAddAiSlot fails the oracle', async () => {
  const compile = hostCompiler((s) =>
    s.replace('if (gate.ok === false) {', 'if (false) {'));
  await assert.rejects(() => addAiSlotOracle(compile), { code: 'ERR_ASSERTION' });
});

test('U5a mutant: ignoring globalSessionCount in slotSessionGate fails the multi-capsule oracle', async () => {
  const compile = hostCompiler((s) =>
    s.replace('globalSessionCount: resolvedGlobalSessionCount.value,', 'globalSessionCount: null,'));
  await assert.rejects(() => addAiSlotOracle(compile), { code: 'ERR_ASSERTION' });
});

test('U5a mutant: mapping broker SESSION_LIMIT to generic COMMAND_UNAVAILABLE fails the multi-capsule oracle', async () => {
  const compile = hostCompiler((s) =>
    s.replace(
      'const outcome = typeof normalizeLaunchError === \'function\'\n      ? normalizeLaunchError(error)\n      : { code: LAUNCH_REFUSALS.COMMAND_UNAVAILABLE, message: \'Launch unavailable.\' };',
      'const outcome = { code: LAUNCH_REFUSALS.COMMAND_UNAVAILABLE, message: \'Launch unavailable.\' };',
    ));
  await assert.rejects(() => addAiSlotOracle(compile), { code: 'ERR_ASSERTION' });
});

test('U5a mutant: removing the session-ceiling check in onLaunchRequest fails the oracle', async () => {
  const compile = hostCompiler((s) =>
    s.replace('if (slotGate.ok === false) {', 'if (false) {'));
  await assert.rejects(() => addAiSlotOracle(compile), { code: 'ERR_ASSERTION' });
});

test('U5a mutant: removing READ-by-default on + AI slot fails the oracle', async () => {
  const compile = hostCompiler((s) =>
    s.replace("if (mode.value !== 'read') {\n    emit('update:inputMode', 'read');\n  }", ''));
  await assert.rejects(() => addAiSlotOracle(compile), { code: 'ERR_ASSERTION' });
});

test('U5a mutant: leaving + AI slot enabled at session cap fails the oracle', async () => {
  const compile = hostCompiler((s) =>
    s.replace(':disabled="!canAddAiSlot"', ':disabled="false"'));
  await assert.rejects(() => addAiSlotOracle(compile), { code: 'ERR_ASSERTION' });
});

async function stateChipOracle(compile) {
  const listeners = { exit: new Set() };
  const liveFacade = {
    capabilities: async () => ({ commands: ['shell'] }),
    attach: async () => ({ sessions: [{ session: 's-1', command: 'shell' }] }),
    onData: () => () => {},
    onExit: (fn) => { listeners.exit.add(fn); return () => listeners.exit.delete(fn); },
    close() {},
    ack() {},
    write() {},
    dispose() {},
  };
  const f = await mountHost({ capsuleId: id }, liveFacade, compile);
  try {
    const chip = () => byId(f, `mv-multislot-${id}-state-chip`);
    assert.ok(chip(), 'state chip renders in slot header');
    assert.equal(chip().props['data-state-chip'], 'unknown');
    assert.equal(text(chip()).trim(), 'Idle');

    f.props.terminalBinding = { session: 's-1', port: {} };
    await flush();
    assert.equal(chip().props['data-state-chip'], 'ready', 'authenticated attach transitions state chip to ready');
    assert.equal(text(chip()).trim(), 'Ready');
    assert.equal(f.children.slot.attrs['activity-state'], 'ready');

    f.props.sessionActivityState = 'busy';
    await flush();
    assert.equal(chip().props['data-state-chip'], 'busy');
    assert.equal(text(chip()).trim(), 'Busy');

    f.props.sessionActivityState = 'waiting-input';
    await flush();
    assert.equal(chip().props['data-state-chip'], 'waiting-input');
    assert.equal(text(chip()).trim(), 'Waiting input');

    f.props.sessionActivityState = '';
    for (const fn of listeners.exit) fn({ session: 's-1' });
    await flush();
    assert.equal(chip().props['data-state-chip'], 'exited');
    assert.equal(text(chip()).trim(), 'Exited');

    f.props.surfaceState = 'lost';
    await flush();
    assert.equal(chip().props['data-state-chip'], 'capsule_gone');
    assert.equal(text(chip()).trim(), 'Capsule gone');
    assert.equal(f.children.slot.attrs['activity-state'], 'failed');
  } finally {
    f.app.unmount();
  }
}

test('U5a mounted: state chip tracks authenticated session and surface lifecycle states', async () => {
  await stateChipOracle(compileSfc);
});

test('U5a mutant: ignoring ready transition on session attach fails the state-chip oracle', async () => {
  const compile = hostCompiler((s) =>
    s.replace(
      "attachmentState.value = sessions.value.length ? 'live' : 'disconnected';\n      activityState.value = sessions.value.length ? 'ready' : 'unknown';",
      "attachmentState.value = sessions.value.length ? 'live' : 'disconnected';\n      activityState.value = 'exited';",
    ));
  await assert.rejects(() => stateChipOracle(compile), { code: 'ERR_ASSERTION' });
});

async function slotHeightOracle(compile) {
  const heights = [];
  const f = await mountHost(
    {
      capsuleId: id,
      'onUpdate:slotHeight': (h) => heights.push(h),
    },
    null,
    compile,
  );
  try {
    const root = () => nodes(f.root).find((n) => n.props?.class === 'mv-multislot-host');
    assert.equal(root().props['data-slot-height'], 360);
    assert.equal(f.children.slot.attrs['pane-size'], 360);
    assert.equal(byId(f, `mv-multislot-${id}-height-360`).props['aria-pressed'], true);

    byId(f, `mv-multislot-${id}-height-200`).props.onClick();
    await flush();
    assert.equal(root().props['data-slot-height'], 200);
    assert.equal(f.children.slot.attrs['pane-size'], 200);
    assert.equal(byId(f, `mv-multislot-${id}-height-200`).props['aria-pressed'], true);

    byId(f, `mv-multislot-${id}-height-540`).props.onClick();
    await flush();
    assert.equal(root().props['data-slot-height'], 540);
    assert.equal(f.children.slot.attrs['pane-size'], 540);
    assert.deepEqual(heights, [200, 540]);

    // Invalid height preset via submit-intent refuses with ERR_INVALID_SLOT_HEIGHT
    f.children.slot.emit('submit-intent', { type: 'slot-height', height: 999 });
    await flush();
    assert.equal(root().props['data-slot-height'], 540, 'unsupported preset leaves height unchanged');
    assert.equal(byId(f, `mv-multislot-${id}-placement-refusal`).props['data-error-code'], MULTISLOT_HEIGHT_REFUSAL);

    // Splitter resize clamps within 140..1600
    f.children.slot.emit('resize', { size: 90 });
    await flush();
    assert.equal(root().props['data-slot-height'], 140);
    f.children.slot.emit('resize', { size: 2200 });
    await flush();
    assert.equal(root().props['data-slot-height'], 1600);

    // slot-height-step intent steps by 40px increments and clamps
    byId(f, `mv-multislot-${id}-height-360`).props.onClick();
    await flush();
    assert.equal(root().props['data-slot-height'], 360);
    f.children.slot.emit('submit-intent', { type: 'slot-height-step', delta: 1 });
    await flush();
    assert.equal(root().props['data-slot-height'], 400, 'slot-height-step +1 adds 40px');
    f.children.slot.emit('submit-intent', { type: 'slot-height-step', delta: -2 });
    await flush();
    assert.equal(root().props['data-slot-height'], 320, 'slot-height-step -2 subtracts 80px');

    // Hidden slot refuses height preset, splitter resize, and slot-height-step with LAYOUT_ILLEGAL_TRANSITION
    f.props.hidden = true;
    await flush();
    byId(f, `mv-multislot-${id}-height-200`).props.onClick();
    await flush();
    assert.equal(root().props['data-slot-height'], 320, 'hidden slot refuses height preset change');
    assert.equal(byId(f, `mv-multislot-${id}-placement-refusal`).props['data-error-code'], 'LAYOUT_ILLEGAL_TRANSITION');

    f.children.slot.emit('resize', { size: 500 });
    await flush();
    assert.equal(root().props['data-slot-height'], 320, 'hidden slot refuses splitter resize');
    assert.equal(byId(f, `mv-multislot-${id}-placement-refusal`).props['data-error-code'], 'LAYOUT_ILLEGAL_TRANSITION');

    f.children.slot.emit('submit-intent', { type: 'slot-height-step', delta: 1 });
    await flush();
    assert.equal(root().props['data-slot-height'], 320, 'hidden slot refuses slot-height-step');
    assert.equal(byId(f, `mv-multislot-${id}-placement-refusal`).props['data-error-code'], 'LAYOUT_ILLEGAL_TRANSITION');

    // Lost surface also refuses splitter resize and slot-height-step with LAYOUT_ILLEGAL_TRANSITION
    f.props.hidden = false;
    f.props.surfaceState = 'lost';
    await flush();
    f.children.slot.emit('resize', { size: 480 });
    await flush();
    assert.equal(root().props['data-slot-height'], 320, 'lost surface refuses splitter resize');
    assert.equal(byId(f, `mv-multislot-${id}-placement-refusal`).props['data-error-code'], 'LAYOUT_ILLEGAL_TRANSITION');

    f.children.slot.emit('submit-intent', { type: 'slot-height-step', delta: 1 });
    await flush();
    assert.equal(root().props['data-slot-height'], 320, 'lost surface refuses slot-height-step');
    assert.equal(byId(f, `mv-multislot-${id}-placement-refusal`).props['data-error-code'], 'LAYOUT_ILLEGAL_TRANSITION');
  } finally {
    f.app.unmount();
  }
}

test('U5a mounted: slot height presets (200/360/540), step, clamping and hidden/lost-slot refusal', async () => {
  await slotHeightOracle(compileSfc);
});

test('U5a mutant: skipping preset validation in onSelectSlotHeight fails the height oracle', async () => {
  const compile = hostCompiler((s) =>
    s.replace('if (normalized === null) {', 'if (false) {'));
  await assert.rejects(() => slotHeightOracle(compile), { code: 'ERR_ASSERTION' });
});

test('U5a mutant: skipping hidden guard in onSelectSlotHeight fails the height oracle', async () => {
  const compile = hostCompiler((s) =>
    s.replace('function onSelectSlotHeight(preset) {\n  if (hiddenRef.value || isSurfaceLost.value) {', 'function onSelectSlotHeight(preset) {\n  if (false) {'));
  await assert.rejects(() => slotHeightOracle(compile), { code: 'ERR_ASSERTION' });
});

test('U5a mutant: skipping hidden/lost guard in onSlotResize fails the height oracle', async () => {
  const compile = hostCompiler((s) =>
    s.replace('function onSlotResize(payload) {\n  if (hiddenRef.value || isSurfaceLost.value) {', 'function onSlotResize(payload) {\n  if (false) {'));
  await assert.rejects(() => slotHeightOracle(compile), { code: 'ERR_ASSERTION' });
});

test('U5a mutant: skipping hidden/lost guard in slot-height-step fails the height oracle', async () => {
  const compile = hostCompiler((s) =>
    s.replace("if (type === 'slot-height-step') {\n    if (hiddenRef.value || isSurfaceLost.value) {", "if (type === 'slot-height-step') {\n    if (false) {"));
  await assert.rejects(() => slotHeightOracle(compile), { code: 'ERR_ASSERTION' });
});

test('U5a mutant: dropping slot-height-step handler fails the height oracle', async () => {
  const compile = hostCompiler((s) =>
    s.replace("if (type === 'slot-height-step') {", "if (false && type === 'slot-height-step') {"));
  await assert.rejects(() => slotHeightOracle(compile), { code: 'ERR_ASSERTION' });
});

async function foldWithoutKillOracle(compile) {
  const dataListeners = new Set();
  const acks = [];
  let closes = 0;
  let disposes = 0;
  const liveFacade = {
    capabilities: async () => ({ commands: ['shell'] }),
    attach: async () => ({ sessions: [{ session: 'alive-1', command: 'shell' }] }),
    onData: (fn) => { dataListeners.add(fn); return () => dataListeners.delete(fn); },
    onExit: () => () => {},
    close() { closes++; },
    ack(credit) { acks.push(credit); },
    write() {},
    dispose() { disposes++; },
  };
  const f = await mountHost(
    {
      capsuleId: id,
      terminalBinding: { session: 'alive-1', port: {} },
    },
    liveFacade,
    compile,
  );
  try {
    await flush();
    const root = () => nodes(f.root).find((n) => n.props?.class === 'mv-multislot-host');
    byId(f, `mv-multislot-${id}-height-540`).props.onClick();
    await flush();
    assert.equal(root().props['data-slot-height'], 540);
    assert.equal(root().props['data-slot-folded'], 'false');

    // Fold the slot: height becomes 38px (MULTISLOT_FOLDED_HEIGHT), expanded height stays 540px,
    // and the attached PTY session stays alive and continues processing frames.
    f.children.slot.emit('submit-intent', { type: 'fold' });
    await flush();
    assert.equal(f.children.slot.attrs.folded, true);
    assert.equal(root().props['data-slot-folded'], 'true');
    assert.equal(root().props['data-slot-height'], MULTISLOT_FOLDED_HEIGHT);
    assert.equal(root().props['data-slot-expanded-height'], 540);
    assert.equal(closes, 0, 'folding never closes the PTY session');
    assert.equal(disposes, 0, 'folding never disposes the terminal facade');
    assert.deepEqual(f.children.slot.attrs.sessions.map((s) => s.sessionId), ['alive-1']);

    for (const fn of dataListeners) {
      fn({ session: 'alive-1', seq: 1, bytes: [79, 75], byteLength: 2 });
    }
    await flush();
    assert.deepEqual(acks, [{ session: 'alive-1', seq: 1, bytes: 2 }], 'folded slot continues pumping PTY output');

    // Unfold restores the expanded height (540px) with the same live session.
    f.children.slot.emit('submit-intent', { type: 'unfold' });
    await flush();
    assert.equal(f.children.slot.attrs.folded, false);
    assert.equal(root().props['data-slot-folded'], 'false');
    assert.equal(root().props['data-slot-height'], 540);
    assert.deepEqual(f.children.slot.attrs.sessions.map((s) => s.sessionId), ['alive-1']);
    assert.equal(f.children.slot.attrs['attachment-state'], 'live');
  } finally {
    f.app.unmount();
  }
}

test('U5a mounted: fold collapses to 38px without killing the live PTY session and unfold restores expanded height', async () => {
  await foldWithoutKillOracle(compileSfc);
});

test('U5a mutant: unbinding sessions on fold fails the fold-without-kill oracle', async () => {
  const compile = hostCompiler((s) =>
    s.replace(
      "if (!controlled('folded')) foldedRef.value = type === 'fold';",
      "if (!controlled('folded')) { foldedRef.value = type === 'fold'; unbind(); }",
    ));
  await assert.rejects(() => foldWithoutKillOracle(compile), { code: 'ERR_ASSERTION' });
});

async function copySlotIdOracle(compile) {
  const written = [];
  const clipboard = { writeText: async (value) => { written.push(value); } };
  const f = await mountHost(
    {
      capsuleId: id,
      clipboard,
      surfaceState: 'live',
    },
    null,
    compile,
  );
  try {
    await flush();
    assert.equal(f.children.bar.attrs['copy-disabled'], false);
    f.children.bar.emit('submit-intent', { type: 'copy-id' });
    await flush();
    await flush();
    assert.equal(f.children.bar.attrs['copy-state'], 'copied');
    assert.deepEqual(written, [id]);

    f.children.bar.emit('submit-intent', { type: 'copy-slot-id' });
    await flush();
    await flush();
    assert.deepEqual(written, [id, `cuk-ai-slot-${id}`]);

    // Losing the capsule surface disables Copy ID and blocks clipboard writes
    f.props.surfaceState = 'lost';
    await flush();
    assert.equal(f.children.bar.attrs['copy-disabled'], true);
    assert.match(String(f.children.bar.attrs['copy-reason']), /surface is lost/);
    f.children.bar.emit('submit-intent', { type: 'copy-id' });
    await flush();
    await flush();
    assert.equal(f.children.bar.attrs['copy-state'], 'unavailable');
    assert.equal(written.length, 2, 'lost surface never writes to clipboard');
  } finally {
    f.app.unmount();
  }
}

test('U5a mounted: Copy ID copies capsuleId and slotId on live surfaces and refuses on lost surfaces', async () => {
  await copySlotIdOracle(compileSfc);
});

test('U5a mutant: allowing Copy ID when surfaceState is lost fails the copy oracle', async () => {
  const compile = hostCompiler((s) =>
    s.replace(
      "const isSurfaceLost = computed(() => props.surfaceState === 'lost' || props.surfaceState === 'capsule_gone');",
      'const isSurfaceLost = computed(() => false);',
    ));
  await assert.rejects(() => copySlotIdOracle(compile), { code: 'ERR_ASSERTION' });
});

test('U5a mutant: dropping lost-surface precedence in stateChip fails the state-chip oracle', async () => {
  const compile = hostCompiler((s) =>
    s.replace(
      'return resolveMultislotStateChip({\n      surfaceState: props.surfaceState,',
      "return resolveMultislotStateChip({\n      surfaceState: 'live',",
    ));
  await assert.rejects(() => stateChipOracle(compile), { code: 'ERR_ASSERTION' });
});

test('U5a memory ceiling stays under 512 MiB', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});

