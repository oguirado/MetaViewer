// MVUI29 lane T: ?state=terminal-live alias record, mount extras, and the
// live/ended/menu drive through the real renderer modules. Doubles at the
// host boundary only; every behaviour has a negative control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_KEYS, FIXTURES } from '../src/fixtures/states.js';
import {
  isAliasFixtureKey,
  isFixtureKey,
  listFixtureKeys,
  parseStateQuery,
  resolveFixture,
} from '../src/fixtures/resolveState.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';
import {
  TERMINAL_LIVE_CAPABILITIES,
  TERMINAL_LIVE_ENDED,
  TERMINAL_LIVE_FIXTURE,
  TERMINAL_LIVE_KEY,
  TERMINAL_LIVE_PROVIDERS,
  TERMINAL_LIVE_SCRIPT,
  TERMINAL_LIVE_SESSION,
  createTerminalLiveHarness,
} from '../src/fixtures/terminalLive.js';
import {
  createPortSessionFacade,
  createSessionTransport,
  createSideTerminalFacade,
  normalizeTerminalOutcome,
} from '../src/terminal/sideTerminalFacade.js';
import { createMultislotPump } from '../src/multislot/multislotAttach.js';
import { toKitMenuProviders, validateLaunchRequest } from '../src/multislot/multislotProviders.js';
import { createGatedTerminalWriter } from '../src/multislot/multislotInputGate.js';

/** @param {unknown} value */
function assertDeepFrozen(value) {
  assert.ok(Object.isFrozen(value));
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      if (entry && typeof entry === 'object') assertDeepFrozen(entry);
    }
  }
}

function recordingRegistry() {
  const calls = { chunks: [], leases: [], created: [], disposed: [] };
  return {
    calls,
    registry: {
      createSession: (config) => { calls.created.push(config); },
      beginAttach: () => {},
      applyRestoreSnapshot: () => {},
      writeOutputChunk: (params) => { calls.chunks.push(params); },
      setControlLease: (params) => { calls.leases.push(params); },
      disposeSession: (id) => { calls.disposed.push(id); },
      forgetSession: () => {},
    },
  };
}

test('terminal-live resolves as an alias; the canonical set is untouched', () => {
  assert.deepEqual(parseStateQuery('?state=terminal-live'), { ok: true, key: TERMINAL_LIVE_KEY });
  assert.deepEqual(parseStateQuery('state=terminal-live'), { ok: true, key: TERMINAL_LIVE_KEY });
  const resolved = resolveFixture(TERMINAL_LIVE_KEY);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.fixture, TERMINAL_LIVE_FIXTURE);
  assert.equal(isAliasFixtureKey(TERMINAL_LIVE_KEY), true);
  assert.equal(isFixtureKey(TERMINAL_LIVE_KEY), false);
  assert.equal(FIXTURE_KEYS.length, 11);
  assert.deepEqual(listFixtureKeys(), FIXTURE_KEYS);
  assert.equal(Object.hasOwn(FIXTURES, TERMINAL_LIVE_KEY), false);
});

test('unknown, missing and near-miss queries still refuse (negative controls)', () => {
  assert.deepEqual(parseStateQuery('?state=terminal-livex').ok, false);
  assert.deepEqual(parseStateQuery('?state=Terminal-Live').ok, false);
  assert.deepEqual(parseStateQuery('?state=terminal-live&state=one').ok, true);
  const refused = resolveFixture('terminal-livex');
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, 'ERR_UNKNOWN_FIXTURE_STATE');
  assert.equal(isAliasFixtureKey('nope'), false);
  assert.equal(isAliasFixtureKey(null), false);
});

test('alias record is frozen pure data with the closed fixture shape', () => {
  assertDeepFrozen(TERMINAL_LIVE_FIXTURE);
  assert.deepEqual(Object.keys(TERMINAL_LIVE_FIXTURE).sort(), [
    'capsules', 'density', 'epoch', 'expectedAnchors', 'key', 'revision', 'scheme', 'screen', 'ui',
  ]);
  assert.equal(TERMINAL_LIVE_FIXTURE.screen, 'multislot');
  assert.equal(TERMINAL_LIVE_FIXTURE.capsules.length, 1);
  assert.deepEqual(TERMINAL_LIVE_FIXTURE.ui.terminalLive, {
    liveSession: TERMINAL_LIVE_SESSION,
    endedSession: TERMINAL_LIVE_ENDED,
    menuOpen: true,
  });
  const anchors = TERMINAL_LIVE_FIXTURE.expectedAnchors.map((row) => row.anchor);
  assert.equal(new Set(anchors).size, anchors.length);
  for (const anchor of ['capsule/cap-01/slot', 'capsule/cap-01/copy-id', 'capsule/cap-01/terminal', 'terminal/side/new']) {
    assert.ok(anchors.includes(anchor), anchor);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(TERMINAL_LIVE_FIXTURE)).key, TERMINAL_LIVE_KEY);
});

test('alias mount carries the live binding plus terminal extras; canonical mounts stay null', () => {
  const created = createFixtureRuntime(TERMINAL_LIVE_KEY);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.mount.terminal.session, TERMINAL_LIVE_SESSION);
  assert.equal(typeof created.mount.terminal.port.postMessage, 'function');
  assert.ok(created.mount.terminalLive);
  assert.deepEqual(Object.keys(created.mount.runtime).sort(), [
    'controlRegistry', 'intentBuilders', 'projectionView', 'scheduler', 'tileScheduler',
  ]);
  const direct = createFixtureRuntime(TERMINAL_LIVE_FIXTURE);
  assert.equal(direct.ok && direct.mount.terminal.session, TERMINAL_LIVE_SESSION);
  const canonical = createFixtureRuntime('one');
  assert.equal(canonical.ok && canonical.mount.terminal, null);
  assert.equal(canonical.ok && canonical.mount.terminalLive, undefined);
});

test('live session output renders through the real facade and pump', async () => {
  const harness = createTerminalLiveHarness();
  const facade = createSideTerminalFacade({ session: TERMINAL_LIVE_SESSION, port: harness.sessionPort });
  const { calls, registry } = recordingRegistry();
  const events = [];
  const pump = createMultislotPump({
    facade, registry, capsuleId: 'cap-01', getInputMode: () => 'write', onEvent: (event) => events.push(event),
  });
  try {
    const attached = await facade.attach();
    assert.equal(attached.sessions[0].session, TERMINAL_LIVE_SESSION);
    pump.attachSession({ session: TERMINAL_LIVE_SESSION, command: 'shell' });
    harness.emitScript();
    assert.equal(calls.chunks.length, TERMINAL_LIVE_SCRIPT.length);
    assert.deepEqual(
      calls.chunks.map((chunk) => [...chunk.data]),
      TERMINAL_LIVE_SCRIPT.map((frame) => [...frame.bytes]),
    );
    assert.deepEqual(events, []);
  } finally {
    pump.dispose();
    facade.dispose();
  }
});

test('malformed live frames fail the session instead of rendering (negative control)', async () => {
  const harness = createTerminalLiveHarness();
  const facade = createSideTerminalFacade({ session: TERMINAL_LIVE_SESSION, port: harness.sessionPort });
  const { calls, registry } = recordingRegistry();
  const events = [];
  const pump = createMultislotPump({
    facade, registry, capsuleId: 'cap-01', getInputMode: () => 'write', onEvent: (event) => events.push(event),
  });
  try {
    await facade.attach();
    pump.attachSession({ session: TERMINAL_LIVE_SESSION, command: 'shell' });
    harness.emitScript([{ seq: 9, bytes: [65] }]);
    assert.deepEqual(calls.chunks, []);
    assert.equal(events.length, 1);
  } finally {
    pump.dispose();
    facade.dispose();
  }
});

test('WRITE keystrokes reach the live session; READ drops them', async () => {
  const harness = createTerminalLiveHarness();
  const posted = [];
  const port = {
    ...harness.sessionPort,
    postMessage: (message) => posted.push(message),
  };
  const facade = createSideTerminalFacade({ session: TERMINAL_LIVE_SESSION, port });
  await facade.attach();
  let mode = 'write';
  const writer = createGatedTerminalWriter({ facade, getInputMode: () => mode });
  try {
    assert.deepEqual(writer.write({ session: TERMINAL_LIVE_SESSION, bytes: [65] }), { delivered: true, reason: '' });
    assert.equal(posted.length, 1);
    mode = 'read';
    assert.equal(writer.write({ session: TERMINAL_LIVE_SESSION, bytes: [66] }).delivered, false);
    assert.equal(posted.length, 1);
  } finally {
    facade.dispose();
  }
});

test('broker open plus transport exit produce the typed ended row', async () => {
  const harness = createTerminalLiveHarness();
  await harness.brokerPort.setEnabled(true);
  const opened = await harness.brokerPort.open({ command: 'shell', args: [], cols: 80, rows: 24 });
  assert.equal(opened.session, TERMINAL_LIVE_ENDED);
  const transport = createSessionTransport(harness.transport);
  const facade = createPortSessionFacade({ transport });
  const { registry } = recordingRegistry();
  const events = [];
  const pump = createMultislotPump({
    facade, registry, capsuleId: 'cap-01', getInputMode: () => 'write', onEvent: (event) => events.push(event),
  });
  try {
    // Fixed host API: the port binds through attach (as the slot does on
    // launch) before the pump registers the session.
    await facade.attach({ session: TERMINAL_LIVE_ENDED });
    pump.attachSession({ session: TERMINAL_LIVE_ENDED, command: 'shell' });
    harness.emitExit({ session: TERMINAL_LIVE_ENDED, reason: 'exited' });
    assert.deepEqual(events, [{ type: 'exited', sessionId: TERMINAL_LIVE_ENDED }]);
    assert.deepEqual(normalizeTerminalOutcome({ type: 'exited', sessionId: TERMINAL_LIVE_ENDED }), {
      type: 'exited',
      sessionId: TERMINAL_LIVE_ENDED,
      code: 'TERMINAL_SESSION_EXITED',
      message: 'Session ended.',
      tone: 'info',
    });
    assert.equal(pump.closeSession(TERMINAL_LIVE_ENDED), false);
  } finally {
    pump.dispose();
    facade.dispose();
  }
});

test('disabled broker refuses opens (negative control)', async () => {
  const harness = createTerminalLiveHarness();
  await assert.rejects(
    async () => harness.brokerPort.open({ command: 'shell', args: [], cols: 80, rows: 24 }),
    /TERMINAL_DISABLED/,
  );
  assert.throws(() => harness.brokerPort.open({ command: 'shell' }), /invalid spec/);
});

test('fixture providers build the populated menu and a valid launch commit', () => {
  const menu = toKitMenuProviders(TERMINAL_LIVE_PROVIDERS);
  assert.deepEqual(menu.map((entry) => entry.id), ['shell', 'alpha', 'beta.tool']);
  const validated = validateLaunchRequest(
    { entryId: 'alpha', command: 'provider', args: ['alpha', '--serve'], title: 'Alpha', kind: 'alpha' },
    { commands: ['shell', 'provider'], menuIds: [...menu.map((entry) => entry.id), 'custom'] },
  );
  assert.equal(validated.ok, true);
  const refused = validateLaunchRequest(
    { entryId: 'ghost', command: 'provider', args: [] },
    { commands: ['shell', 'provider'], menuIds: [...menu.map((entry) => entry.id), 'custom'] },
  );
  assert.equal(refused.ok, false);
  assert.equal(TERMINAL_LIVE_CAPABILITIES.length, 3);
});
