import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INPUT_GATE_REFUSAL,
  MULTISLOT_INPUT_MODES,
  createGatedTerminalWriter,
  leaseForInputMode,
  normalizeMultislotInputMode,
} from '../src/multislot/multislotInputGate.js';

test('input modes are exactly read and write', () => {
  assert.deepEqual([...MULTISLOT_INPUT_MODES], ['read', 'write']);
});

test('mode normalizer keeps read/write and fails every other value closed to read', () => {
  assert.equal(normalizeMultislotInputMode('read'), 'read');
  assert.equal(normalizeMultislotInputMode('write'), 'write');
  for (const unknown of [undefined, null, '', 'WRITE', 'Read', 'admin', 0, 1, {}, []]) {
    assert.equal(normalizeMultislotInputMode(unknown), 'read');
  }
});

test('control lease is granted in WRITE mode only', () => {
  assert.equal(leaseForInputMode('write'), true);
  assert.equal(leaseForInputMode('read'), false);
  assert.equal(leaseForInputMode('WRITE'), false);
  assert.equal(leaseForInputMode(undefined), false);
});

test('READ mode drops operator keystrokes: facade.write is never called', () => {
  let calls = 0;
  const writer = createGatedTerminalWriter({
    facade: { write: () => { calls += 1; } },
    getInputMode: () => 'read',
  });
  const outcome = writer.write({ session: 's', bytes: [65] });
  assert.deepEqual(outcome, { delivered: false, reason: INPUT_GATE_REFUSAL });
  assert.equal(calls, 0);
  assert.equal(INPUT_GATE_REFUSAL, 'ERR_INPUT_MODE_READ');
});

test('WRITE mode delivers operator keystrokes unchanged', () => {
  const seen = [];
  const writer = createGatedTerminalWriter({
    facade: { write: (input) => seen.push(input) },
    getInputMode: () => 'write',
  });
  const outcome = writer.write({ session: 's', bytes: [65, 66] });
  assert.deepEqual(outcome, { delivered: true, reason: '' });
  assert.deepEqual(seen, [{ session: 's', bytes: [65, 66] }]);
});

test('gate reads the live mode: a switch to READ drops the next keystroke', () => {
  let mode = 'write';
  let calls = 0;
  const writer = createGatedTerminalWriter({
    facade: { write: () => { calls += 1; } },
    getInputMode: () => mode,
  });
  assert.equal(writer.write({ session: 's', bytes: [65] }).delivered, true);
  mode = 'read';
  assert.equal(writer.write({ session: 's', bytes: [65] }).delivered, false);
  assert.equal(calls, 1);
});

test('unknown modes drop writes (negative control: uppercase WRITE is not WRITE)', () => {
  let calls = 0;
  const writer = createGatedTerminalWriter({
    facade: { write: () => { calls += 1; } },
    getInputMode: () => 'WRITE',
  });
  const outcome = writer.write({ session: 's', bytes: [65] });
  assert.equal(outcome.delivered, false);
  assert.equal(calls, 0);
});

test('gated writer construction rejects a facade without write() and a missing mode source', () => {
  assert.throws(() => createGatedTerminalWriter({ facade: {}, getInputMode: () => 'read' }), TypeError);
  assert.throws(() => createGatedTerminalWriter({ facade: { write: () => {} } }), TypeError);
  assert.doesNotThrow(() => createGatedTerminalWriter({ facade: { write: () => {} }, getInputMode: () => 'read' }));
});
