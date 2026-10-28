/**
 * Tests for the client-to-frame map (`ui/src/input/frameMap.js`).
 *
 * Runs under the repository `node --test` gate with synthetic rects only; no DOM
 * is loaded. Each behaviour pairs a positive witness with a negative control that
 * must fail: points inside the letterbox bars map to null (an implementation that
 * skipped the contain-fit removal would return coordinates and fail), as do
 * outside points and malformed inputs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapClientToFrame } from '../src/input/frameMap.js';

const rect = (left, top, width, height) => ({ left, top, width, height });
const at = (clientX, clientY, r, frameWidth, frameHeight) => mapClientToFrame({
  clientX, clientY, rect: r, frameWidth, frameHeight,
});

describe('mvui25 frame map', () => {
  it('maps exact-fit canvases 1:1', () => {
    const r = rect(0, 0, 200, 100);
    assert.deepEqual(at(0, 0, r, 200, 100), { x: 0, y: 0 });
    assert.deepEqual(at(199, 99, r, 200, 100), { x: 199, y: 99 });
    assert.deepEqual(at(100, 50, r, 200, 100), { x: 100, y: 50 });
  });

  it('removes horizontal letterbox bars', () => {
    const r = rect(0, 0, 200, 100);
    assert.deepEqual(at(50, 0, r, 100, 100), { x: 0, y: 0 });
    assert.deepEqual(at(149, 99, r, 100, 100), { x: 99, y: 99 });
    assert.deepEqual(at(100, 50, r, 100, 100), { x: 50, y: 50 });
    assert.equal(at(49, 50, r, 100, 100), null);
    assert.equal(at(150, 50, r, 100, 100), null);
    assert.equal(at(0, 0, r, 100, 100), null);
  });

  it('removes vertical letterbox bars', () => {
    const r = rect(0, 0, 100, 200);
    assert.deepEqual(at(0, 50, r, 100, 100), { x: 0, y: 0 });
    assert.deepEqual(at(99, 149, r, 100, 100), { x: 99, y: 99 });
    assert.equal(at(50, 49, r, 100, 100), null);
    assert.equal(at(50, 150, r, 100, 100), null);
  });

  it('scales down and up with uniform contain fit', () => {
    assert.deepEqual(at(50, 25, rect(0, 0, 100, 50), 200, 100), { x: 100, y: 50 });
    assert.deepEqual(at(99, 49, rect(0, 0, 100, 50), 200, 100), { x: 198, y: 98 });
    assert.deepEqual(at(0, 0, rect(0, 0, 400, 200), 200, 100), { x: 0, y: 0 });
    assert.deepEqual(at(399, 199, rect(0, 0, 400, 200), 200, 100), { x: 199, y: 99 });
    assert.deepEqual(at(99, 99, rect(0, 0, 100, 100), 3, 3), { x: 2, y: 2 });
  });

  it('honours canvas offsets and rejects outside points', () => {
    const r = rect(10, 20, 100, 100);
    assert.deepEqual(at(10, 20, r, 100, 100), { x: 0, y: 0 });
    assert.deepEqual(at(109, 119, r, 100, 100), { x: 99, y: 99 });
    assert.equal(at(9, 20, r, 100, 100), null);
    assert.equal(at(10, 19, r, 100, 100), null);
    assert.equal(at(110, 50, r, 100, 100), null);
    assert.equal(at(50, 120, r, 100, 100), null);
    assert.equal(at(-5, -5, r, 100, 100), null);
  });

  it('rejects malformed inputs as null', () => {
    const r = rect(0, 0, 100, 100);
    assert.equal(mapClientToFrame(null), null);
    assert.equal(mapClientToFrame(undefined), null);
    assert.equal(mapClientToFrame({}), null);
    assert.equal(at(NaN, 0, r, 100, 100), null);
    assert.equal(at(0, Infinity, r, 100, 100), null);
    assert.equal(at(0, 0, null, 100, 100), null);
    assert.equal(at(0, 0, rect(0, 0, 0, 100), 100, 100), null);
    assert.equal(at(0, 0, rect(0, 0, 100, -2), 100, 100), null);
    assert.equal(at(0, 0, r, 0, 100), null);
    assert.equal(at(0, 0, r, 100, 1.5), null);
    assert.equal(at(0, 0, r, -4, 100), null);
  });

  it('rss stays below 512 MiB', () => {
    const rss = process.memoryUsage().rss;
    assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
  });
});
