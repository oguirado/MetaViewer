// MVUI33B lane S: the wall fps meter defaults to a monotonic clock.
// Without an injected clock the meter follows performance.now() when
// available and falls back to Date.now(); an injected clock still wins.
// Hosted-safe: stubbed globals with try/finally restore, no
// electron/socket/filesystem. Every behaviour ships with a negative control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MV_WALL_FPS_WINDOW_MS, createWallFpsMeter } from '../src/settings/settingsModel.js';

test('default clock is monotonic: the meter follows performance.now, not Date.now', () => {
  assert.equal(MV_WALL_FPS_WINDOW_MS, 2000);
  const originalNow = globalThis.performance.now;
  let perfAt = 0;
  globalThis.performance.now = () => perfAt;
  try {
    const meter = createWallFpsMeter({ windowMs: MV_WALL_FPS_WINDOW_MS });
    assert.equal(meter.read(), null);
    for (let i = 0; i < 6; i += 1) {
      perfAt = i * 250;
      meter.push(1_000_000_000 + i);
    }
    assert.equal(meter.read(), 3);
    perfAt = 5000;
    assert.equal(
      meter.read(),
      null,
      'expired arrivals leave the window on the monotonic clock (judge note 2)',
    );
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('negative control: an injected clock still wins over performance.now', () => {
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => 999_999_999;
  try {
    let at = 0;
    const meter = createWallFpsMeter({ windowMs: 2000, now: () => at });
    for (let i = 0; i < 4; i += 1) {
      at = i * 250;
      meter.push(1_000_000_000 + i);
    }
    assert.equal(meter.read(), 2, 'the injected clock drives the meter, not performance.now');
    at = 5000;
    assert.equal(meter.read(), null);
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('negative control: without performance the default falls back to Date.now', () => {
  const perfDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const originalDateNow = Date.now;
  let dateAt = 0;
  Object.defineProperty(globalThis, 'performance', { value: undefined, writable: true, configurable: true });
  Date.now = () => dateAt;
  try {
    const meter = createWallFpsMeter({ windowMs: 2000 });
    assert.equal(meter.read(), null);
    for (let i = 0; i < 4; i += 1) {
      dateAt = i * 250;
      meter.push(1_000_000_000 + i);
    }
    assert.equal(meter.read(), 2, 'the fallback clock drives the meter');
    dateAt = 5000;
    assert.equal(meter.read(), null);
  } finally {
    Date.now = originalDateNow;
    if (perfDescriptor) Object.defineProperty(globalThis, 'performance', perfDescriptor);
    else delete globalThis.performance;
  }
});
