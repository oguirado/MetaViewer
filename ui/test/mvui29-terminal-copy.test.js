// MVUI29c lane T: Copy-capsule-ID port order (clipboard, host copyText,
// ambient), the host grammar pre-check, and the disabled-with-reason
// control. Host doubles only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountHost, flush } from './mvui16-harness.mjs';
import { copyAvailable, createCopyCapsuleId, isCopyTextAllowed } from '../src/multislot/multislotCopy.js';
import { createTerminalLiveHarness } from '../src/fixtures/terminalLive.js';

test('host copyText carries the capsule id when no clipboard is injected', async () => {
  const seen = [];
  const action = createCopyCapsuleId({ copyText: async (text) => { seen.push(text); } });
  const outcome = await action.copy('cap-01');
  assert.deepEqual(outcome, { state: 'copied', reason: '' });
  assert.deepEqual(seen, ['cap-01']);
});

test('injected clipboard wins over the host path', async () => {
  const written = [];
  const hosted = [];
  const action = createCopyCapsuleId({
    clipboard: { writeText: async (text) => { written.push(text); } },
    copyText: async (text) => { hosted.push(text); },
  });
  assert.deepEqual(await action.copy('cap-01'), { state: 'copied', reason: '' });
  assert.deepEqual(written, ['cap-01']);
  assert.deepEqual(hosted, []);
});

test('invalid ids never reach the host path (negative control)', async () => {
  const hosted = [];
  const action = createCopyCapsuleId({ copyText: async (text) => { hosted.push(text); } });
  const outcome = await action.copy('has space');
  assert.equal(outcome.state, 'unavailable');
  assert.ok(outcome.reason.length > 0);
  assert.deepEqual(hosted, []);
});

test('refused host write reports unavailable instead of throwing', async () => {
  const action = createCopyCapsuleId({
    copyText: async () => { throw new Error('denied'); },
  });
  assert.deepEqual(await action.copy('cap-01'), { state: 'unavailable', reason: 'ERR_CLIPBOARD_WRITE_REFUSED' });
});

test('host-typed refusal keeps the host code in the reason', async () => {
  const action = createCopyCapsuleId({
    copyText: async () => { throw new Error('terminal-live/transport-copyText: ERR_CLIPBOARD_INVALID'); },
  });
  assert.deepEqual(await action.copy('cap-01'), { state: 'unavailable', reason: 'ERR_CLIPBOARD_INVALID' });
});

test('off-grammar ids refuse before calling with the host code (negative control)', async () => {
  const written = [];
  const hosted = [];
  const action = createCopyCapsuleId({
    clipboard: { writeText: async (text) => { written.push(text); } },
    copyText: async (text) => { hosted.push(text); },
  });
  for (const bad of ['cap/01', '-lead', 'x'.repeat(129)]) {
    assert.equal(isCopyTextAllowed(bad), false, bad);
    assert.deepEqual(await action.copy(bad), { state: 'unavailable', reason: 'ERR_CLIPBOARD_INVALID' });
  }
  assert.deepEqual(written, []);
  assert.deepEqual(hosted, []);
  assert.equal(isCopyTextAllowed('cap-01'), true);
  assert.equal(isCopyTextAllowed('a'.repeat(128)), true);
});

test('copy availability mirrors the reachable paths', () => {
  assert.equal(copyAvailable({ clipboard: { writeText: async () => {} } }), true);
  assert.equal(copyAvailable({ clipboard: {} }), false);
  assert.equal(copyAvailable({ copyText: async () => true }), true);
  assert.equal(copyAvailable({ copyText: null, clipboard: null }), false);
});

test('control enables with a clipboard and copies on intent', async () => {
  const harness = createTerminalLiveHarness();
  const f = await mountHost({ capsuleId: 'cap-01', clipboard: harness.clipboard, inputMode: 'write' });
  try {
    await flush();
    assert.equal(f.children.bar.attrs['copy-disabled'], false);
    assert.equal(f.children.bar.attrs['copy-reason'], '');
    f.children.bar.emit('submit-intent', { type: 'copy-id' });
    await flush();
    await flush();
    assert.equal(f.children.bar.attrs['copy-state'], 'copied');
    assert.ok(harness.calls.some((call) => call.method === 'clipboard-write'));
  } finally {
    f.app.unmount();
  }
});

test('control disables with an accessible reason when no path exists', async () => {
  const f = await mountHost({ capsuleId: 'cap-01', inputMode: 'write' });
  try {
    await flush();
    assert.equal(f.children.bar.attrs['copy-disabled'], true);
    assert.equal(f.children.bar.attrs['copy-reason'], 'Copy unavailable: no clipboard path.');
    f.children.bar.emit('submit-intent', { type: 'copy-id' });
    await flush();
    await flush();
    assert.equal(f.children.bar.attrs['copy-state'], 'unavailable');
  } finally {
    f.app.unmount();
  }
});

test('session-transport clipboard enables the control without injection', async () => {
  const harness = createTerminalLiveHarness();
  const f = await mountHost({ capsuleId: 'cap-01', terminalSessionPort: harness.transport, inputMode: 'write' });
  try {
    await flush();
    assert.equal(f.children.bar.attrs['copy-disabled'], false);
    f.children.bar.emit('submit-intent', { type: 'copy-id' });
    await flush();
    await flush();
    assert.equal(f.children.bar.attrs['copy-state'], 'copied');
    assert.ok(harness.calls.some((call) => call.method === 'copyText'));
  } finally {
    f.app.unmount();
  }
});

test('control disables with an accessible reason when the capsule id is off-grammar', async () => {
  const harness = createTerminalLiveHarness();
  const f = await mountHost({ capsuleId: 'cap/01', clipboard: harness.clipboard, inputMode: 'write' });
  try {
    await flush();
    assert.equal(f.children.bar.attrs['copy-disabled'], true);
    assert.equal(f.children.bar.attrs['copy-reason'], 'Copy unavailable: this capsule id cannot be copied.');
    f.children.bar.emit('submit-intent', { type: 'copy-id' });
    await flush();
    await flush();
    assert.equal(f.children.bar.attrs['copy-state'], 'unavailable');
    assert.ok(!harness.calls.some((call) => call.method === 'clipboard-write'));
  } finally {
    f.app.unmount();
  }
});
