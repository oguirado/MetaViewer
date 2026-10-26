import test from 'node:test';
import assert from 'node:assert/strict';
import { MULTISLOT_COPY_STATES, createCopyCapsuleId, normalizeCopyState } from '../src/multislot/multislotCopy.js';

test('copy states are the kit identity-plate vocabulary, failing closed to unavailable', () => {
  assert.deepEqual([...MULTISLOT_COPY_STATES], ['ready', 'copying', 'copied', 'unavailable']);
  assert.equal(normalizeCopyState('copied'), 'copied');
  assert.equal(normalizeCopyState('bogus'), 'unavailable');
  assert.equal(normalizeCopyState(undefined), 'unavailable');
});

test('valid capsule id reaches the injected clipboard exactly once', async () => {
  const written = [];
  const action = createCopyCapsuleId({ clipboard: { writeText: async (text) => { written.push(text); } } });
  const outcome = await action.copy('cap-01');
  assert.deepEqual(outcome, { state: 'copied', reason: '' });
  assert.deepEqual(written, ['cap-01']);
});

test('missing or unstable ids report unavailable without touching the clipboard (negative controls)', async () => {
  const written = [];
  const action = createCopyCapsuleId({ clipboard: { writeText: async (text) => { written.push(text); } } });
  for (const bad of [undefined, null, '', '   ', 'has space', '123', ':0', 'display=1', 42, {}]) {
    const outcome = await action.copy(bad);
    assert.equal(outcome.state, 'unavailable');
    assert.ok(outcome.reason.length > 0);
  }
  assert.equal(written.length, 0);
});

test('absent clipboard reports unavailable instead of throwing', async () => {
  const action = createCopyCapsuleId({ clipboard: null });
  const hadNavigator = 'navigator' in globalThis;
  const saved = hadNavigator ? globalThis.navigator : undefined;
  try {
    if (hadNavigator) {
      Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    }
    const outcome = await action.copy('cap-01');
    assert.deepEqual(outcome, { state: 'unavailable', reason: 'ERR_CLIPBOARD_UNAVAILABLE' });
  } finally {
    if (hadNavigator) Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true });
  }
});

test('refused clipboard write reports unavailable instead of throwing', async () => {
  const action = createCopyCapsuleId({
    clipboard: { writeText: async () => { throw new Error('denied'); } },
  });
  const outcome = await action.copy('cap-01');
  assert.deepEqual(outcome, { state: 'unavailable', reason: 'ERR_CLIPBOARD_WRITE_REFUSED' });
});
