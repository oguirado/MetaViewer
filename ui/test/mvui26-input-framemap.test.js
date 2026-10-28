/**
 * MVUI26 lane I: frame-map regression test for input RV10-07.
 *
 * `mapClientToFrame` must require safe-integer frame dimensions, matching
 * the downstream input-event contract. Pairs the report's regression test
 * (unsafe dimensions map to null) with the MAX_SAFE_INTEGER boundary
 * control and a small-dimension mapping control. No DOM is loaded.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapClientToFrame } from '../src/input/frameMap.js';

const rect = (left, top, width, height) => ({ left, top, width, height });
const at = (clientX, clientY, r, frameWidth, frameHeight) => mapClientToFrame({
  clientX, clientY, rect: r, frameWidth, frameHeight,
});

describe('mvui26 frame map safe dimensions', () => {
  it('returns null for unsafe-integer frame dimensions', () => {
    const r = rect(0, 0, 100, 100);
    assert.equal(at(50, 50, r, 1e20, 100), null);
    assert.equal(at(50, 50, r, 100, 1e20), null);
    assert.equal(at(50, 50, r, 2 ** 53, 2 ** 53), null);
    assert.equal(at(50, 50, r, -1e20, 100), null);
  });

  it('control: MAX_SAFE_INTEGER dimensions still map', () => {
    const r = rect(0, 0, 100, 100);
    const point = at(50, 50, r, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    assert.notEqual(point, null);
    assert.equal(Number.isSafeInteger(point.x), true);
    assert.equal(Number.isSafeInteger(point.y), true);
  });

  it('control: small dimensions map exactly as before', () => {
    const r = rect(0, 0, 200, 100);
    assert.deepEqual(at(0, 0, r, 200, 100), { x: 0, y: 0 });
    assert.deepEqual(at(199, 99, r, 200, 100), { x: 199, y: 99 });
    assert.equal(at(0, 0, r, 0, 100), null);
    assert.equal(at(0, 0, r, 100, 1.5), null);
  });
});
