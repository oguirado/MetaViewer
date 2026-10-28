// MVUI29 lane T: provider menu, broker launch, live output, input lease,
// close/end semantics on the real MultislotHost. Host doubles only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountHost, flush, nodes, text } from './mvui16-harness.mjs';
import { createSideTerminalBrokerFacade } from '../src/terminal/sideTerminalFacade.js';
import {
  TERMINAL_LIVE_ENDED,
  TERMINAL_LIVE_PROVIDERS,
  TERMINAL_LIVE_SESSION,
  createTerminalLiveHarness,
} from '../src/fixtures/terminalLive.js';

async function mountLive(over = {}) {
  const harness = createTerminalLiveHarness();
  const closed = [];
  const f = await mountHost({
    capsuleId: 'cap-01',
    terminalBinding: { session: TERMINAL_LIVE_SESSION, port: harness.sessionPort },
    terminalBroker: harness.brokerPort,
    terminalSessionPort: harness.transport,
    hostProviders: [...TERMINAL_LIVE_PROVIDERS],
    brokerCommands: ['shell', 'provider'],
    clipboard: harness.clipboard,
    inputMode: 'write',
    'onClose-session': (payload) => closed.push(payload),
    ...over,
  });
  return { f, harness, closed };
}

test('provider menu lists shell plus host providers with launch commands', async () => {
  const { f } = await mountLive();
  try {
    await flush();
    assert.deepEqual(
      f.children.slot.attrs.providers.map((entry) => entry.id),
      ['shell', 'alpha', 'beta.tool'],
    );
    assert.ok(f.children.slot.attrs.commands.includes('shell'));
    assert.ok(f.children.slot.attrs.commands.includes('provider'));
  } finally {
    f.app.unmount();
  }
});

test('provider menu falls back to shell-only without host data or listing (negative control)', async () => {
  const harness = createTerminalLiveHarness();
  const f = await mountHost({ capsuleId: 'cap-01', inputMode: 'write' });
  try {
    await flush();
    assert.deepEqual(f.children.slot.attrs.providers.map((entry) => entry.id), ['shell']);
    assert.equal(harness.calls.length, 0);
  } finally {
    f.app.unmount();
  }
});

test('providers list through the session transport when no direct host data', async () => {
  const harness = createTerminalLiveHarness();
  const f = await mountHost({
    capsuleId: 'cap-01',
    terminalSessionPort: harness.transport,
    inputMode: 'write',
  });
  try {
    await flush();
    await flush();
    assert.deepEqual(
      f.children.slot.attrs.providers.map((entry) => entry.id),
      ['shell', 'alpha', 'beta.tool'],
    );
    assert.ok(harness.calls.some((call) => call.method === 'listProviders'));
  } finally {
    f.app.unmount();
  }
});

test('live binding session attaches; broker open attaches a second session', async () => {
  const { f, harness } = await mountLive();
  try {
    await flush();
    assert.deepEqual(
      f.children.slot.attrs.sessions.map((s) => s.sessionId),
      [TERMINAL_LIVE_SESSION],
    );
    assert.equal(f.children.slot.attrs['attachment-state'], 'live');
    await createSideTerminalBrokerFacade(harness.brokerPort).setEnabled(true);
    f.children.slot.emit('launch-request', { entryId: 'shell', command: 'shell', args: [], title: '', kind: '' });
    await flush();
    await flush();
    assert.deepEqual(
      f.children.slot.attrs.sessions.map((s) => s.sessionId),
      [TERMINAL_LIVE_SESSION, TERMINAL_LIVE_ENDED],
    );
    assert.ok(harness.calls.some((call) => call.method === 'open'));
  } finally {
    f.app.unmount();
  }
});

test('launch without broker or transport refuses NO_BROKER (negative control)', async () => {
  const f = await mountHost({ capsuleId: 'cap-01', brokerCommands: ['shell'], inputMode: 'write' });
  try {
    await flush();
    f.children.slot.emit('launch-request', { entryId: 'shell', command: 'shell', args: [] });
    await flush();
    const alert = nodes(f.root).find((n) => n.props?.role === 'alert');
    assert.equal(alert.props['data-error-code'], 'ERR_LAUNCH_NO_BROKER');
    assert.match(text(f.root), /Launch unavailable/);
  } finally {
    f.app.unmount();
  }
});

test('transport exit raises the typed notice while the live session stays', async () => {
  const { f, harness } = await mountLive();
  try {
    await flush();
    await createSideTerminalBrokerFacade(harness.brokerPort).setEnabled(true);
    f.children.slot.emit('launch-request', { entryId: 'shell', command: 'shell', args: [], title: '', kind: '' });
    await flush();
    await flush();
    harness.emitExit({ session: TERMINAL_LIVE_ENDED, reason: 'exited' });
    await flush();
    assert.deepEqual(
      f.children.slot.attrs.sessions.map((s) => s.sessionId),
      [TERMINAL_LIVE_SESSION],
    );
    const notice = nodes(f.root).find((n) => n.props?.id === 'mv-multislot-cap-01-session-notice');
    assert.ok(notice);
    assert.equal(notice.props['data-outcome-code'], 'TERMINAL_SESSION_EXITED');
    assert.equal(notice.props.role, 'status');
    assert.ok(text(f.root).includes('Session ended.'));
    assert.ok(!text(f.root).includes('TERMINAL_'));
  } finally {
    f.app.unmount();
  }
});

test('closing a session updates the slot and emits close-session', async () => {
  const { f, closed } = await mountLive();
  try {
    await flush();
    f.children.slot.emit('close-session', { sessionId: TERMINAL_LIVE_SESSION });
    await flush();
    assert.deepEqual(f.children.slot.attrs.sessions, []);
    assert.equal(f.children.slot.attrs['attachment-state'], 'disconnected');
    assert.deepEqual(closed, [{ sessionId: TERMINAL_LIVE_SESSION }]);
  } finally {
    f.app.unmount();
  }
});

test('closing an unknown session leaves the slot unchanged (negative control)', async () => {
  const { f, closed } = await mountLive();
  try {
    await flush();
    f.children.slot.emit('close-session', { sessionId: 'ghost' });
    await flush();
    assert.deepEqual(
      f.children.slot.attrs.sessions.map((s) => s.sessionId),
      [TERMINAL_LIVE_SESSION],
    );
    assert.equal(f.children.slot.attrs['attachment-state'], 'live');
    assert.deepEqual(closed, [{ sessionId: 'ghost' }]);
  } finally {
    f.app.unmount();
  }
});

test('control lease follows the live input mode', async () => {
  const { f } = await mountLive({ inputMode: 'write' });
  try {
    await flush();
    assert.equal(f.children.slot.attrs['has-control-lease'], true);
    f.props.inputMode = 'read';
    await flush();
    assert.equal(f.children.slot.attrs['has-control-lease'], false);
  } finally {
    f.app.unmount();
  }
});

test('malformed transport injection fails closed to NO_BROKER (negative control)', async () => {
  const harness = createTerminalLiveHarness();
  const f = await mountHost({
    capsuleId: 'cap-01',
    terminalBroker: harness.brokerPort,
    terminalSessionPort: { attach: 42 },
    brokerCommands: ['shell'],
    inputMode: 'write',
  });
  try {
    await flush();
    await createSideTerminalBrokerFacade(harness.brokerPort).setEnabled(true);
    f.children.slot.emit('launch-request', { entryId: 'shell', command: 'shell', args: [] });
    await flush();
    const alert = nodes(f.root).find((n) => n.props?.role === 'alert');
    assert.equal(alert.props['data-error-code'], 'ERR_LAUNCH_NO_BROKER');
  } finally {
    f.app.unmount();
  }
});
