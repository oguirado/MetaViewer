// MVUI27 lane S: a press on the multislot READ veil never scrolls the page.
// In READ mode the kit covers the surface with its veil
// (`data-input-shield="read"`), so the press lands on the veil, never on the
// canvas. The REAL MultislotHost SFC on the shared stub renderer: veiled
// pointerdown/mousedown prevent the default action without stopping
// propagation (journal events still bubble); presses anywhere else —
// terminal, buttons, inputs — pass through untouched, and anything without
// a working closest() is ignored without throwing. Negative control: an
// in-memory mutant without the guard re-exposes the veil (the oracle
// rejects on it). Bounded mounts (one host per test); no timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountHost, mutatedCompiler, hostButton, flush, MVUI16_ID } from './mvui16-harness.mjs';

const VEIL_SELECTOR = '[data-input-shield="read"]';

function fakePress(type, target) {
  const event = {
    type, target, defaultPrevented: false, stopCalls: 0,
    preventDefault() { event.defaultPrevented = true; },
    stopPropagation() { event.stopCalls += 1; },
  };
  return event;
}

function shieldTarget(seen) {
  return {
    closest: (selector) => {
      seen.push(selector);
      return selector === VEIL_SELECTOR ? { shield: true } : null;
    },
  };
}

const plainTarget = () => ({ closest: () => null });
const throwingTarget = () => ({ closest: () => { throw new Error('no closest here'); } });

const GUARD_KEYS = ['onPointerdown', 'onMousedown'];
const keyType = (key) => key.slice(2).toLowerCase();

// The new rule, shared by the veil test (real host: passes) and the mutant
// control (guard removed: rejects at the binding assertion).
function shieldOracle(f) {
  const hostRoot = f.root.children[0];
  assert.ok(String(hostRoot.props.class).includes('mv-multislot-host'), 'host root is mounted');
  for (const key of GUARD_KEYS) {
    assert.equal(typeof hostRoot.props[key], 'function', `${key} guard is bound`);
  }
  for (const key of GUARD_KEYS) {
    const handler = hostRoot.props[key];
    const seen = [];
    const veiled = fakePress(keyType(key), shieldTarget(seen));
    handler(veiled);
    assert.deepEqual(seen, [VEIL_SELECTOR], `${key} probes the veil selector`);
    assert.equal(veiled.defaultPrevented, true, `${key} on the READ veil never scrolls the page`);
    assert.equal(veiled.stopCalls, 0, `${key} on the veil still bubbles`);
    const plain = fakePress(keyType(key), plainTarget());
    handler(plain);
    assert.equal(plain.defaultPrevented, false, `${key} off the veil passes through`);
    assert.equal(plain.stopCalls, 0, `${key} off the veil still bubbles`);
    for (const [label, target] of [['no-closest', {}], ['null', null], ['missing', undefined], ['throwing', throwingTarget()]]) {
      const event = fakePress(keyType(key), target);
      handler(event);
      assert.equal(event.defaultPrevented, false, `${key} with ${label} target never prevents`);
    }
  }
}

test('mvui27 shield: veiled READ presses never scroll, the rest passes through', async () => {
  const f = await mountHost({}, null);
  try {
    shieldOracle(f);
  } finally {
    f.app.unmount();
  }
});

test('mvui27 shield negative control: mutant without the guard re-exposes the veil', async () => {
  const anchor = ' @pointerdown="onSlotPointerGuard" @mousedown="onSlotPointerGuard"';
  const compile = mutatedCompiler('multislot/MultislotHost.vue', (source) => {
    assert.equal(source.split(anchor).length, 2, 'guard binding anchor is unique');
    return source.split(anchor).join('');
  });
  await assert.rejects(async () => {
    const f = await mountHost({}, null, compile);
    try {
      shieldOracle(f);
    } finally {
      f.app.unmount();
    }
  }, { code: 'ERR_ASSERTION' });
  // The mutant is otherwise healthy: it mounts and the placement draft
  // round-trip still works, so the removal is surgical.
  const f = await mountHost({}, null, compile);
  try {
    assert.ok(String(f.root.children[0].props.class).includes('mv-multislot-host'), 'mutant host mounts');
    hostButton(f, MVUI16_ID, 'group').props.onInput({ target: { value: 'group-a' } });
    await flush();
    assert.equal(hostButton(f, MVUI16_ID, 'group').props.value, 'group-a', 'mutant draft round-trip works');
  } finally {
    f.app.unmount();
  }
});

test('mvui27 shield: slot controls keep working on the guarded host', async () => {
  const f = await mountHost({}, null);
  try {
    hostButton(f, MVUI16_ID, 'group').props.onInput({ target: { value: 'group-a' } });
    await flush();
    assert.equal(hostButton(f, MVUI16_ID, 'group').props.value, 'group-a', 'placement draft round-trip works');
    hostButton(f, MVUI16_ID, 'index').props.onInput({ target: { value: '3' } });
    await flush();
    assert.equal(hostButton(f, MVUI16_ID, 'index').props.value, '3', 'placement index round-trip works');
  } finally {
    f.app.unmount();
  }
});
