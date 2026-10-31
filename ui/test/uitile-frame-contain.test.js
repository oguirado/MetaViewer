// UI-TILE: the browser frame is painted with object-fit:contain (largest
// uniform scale, centred, bands on the free axis) and pointer input maps
// through the same transform. Numbers mirror the operator evidence: a
// 1280x900 browser frame inside a 1238x283 tile canvas box.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { containFit, mapClientToFrame } from '../src/input/frameMap.js';

const FRAME = { width: 1280, height: 900 };

function map(rect, clientX, clientY, frame = FRAME) {
  return mapClientToFrame({ clientX, clientY, rect,
    frameWidth: frame.width, frameHeight: frame.height });
}

describe('containFit', () => {
  test('wide box: height-bound, side bands', () => {
    const fit = containFit(1238, 283, 1280, 900);
    assert.ok(fit);
    assert.equal(fit.height, 283);
    assert.ok(Math.abs(fit.width - 1280 * 283 / 900) < 1e-9);
    assert.ok(Math.abs(fit.offsetX - (1238 - fit.width) / 2) < 1e-9);
    assert.equal(fit.offsetY, 0);
  });

  test('tall box: width-bound, top and bottom bands', () => {
    const fit = containFit(640, 900, 1280, 900);
    assert.ok(fit);
    assert.equal(fit.width, 640);
    assert.equal(fit.height, 450);
    assert.equal(fit.offsetX, 0);
    assert.equal(fit.offsetY, 225);
  });

  test('largest fit: the displayed frame touches the box on one axis and never overflows', () => {
    for (const [w, h] of [[1238, 283], [1238, 327], [400, 1000], [1280, 900], [2560, 1800], [17, 3]]) {
      const fit = containFit(w, h, 1280, 900);
      assert.ok(fit, `${w}x${h}`);
      assert.ok(fit.width <= w + 1e-9 && fit.height <= h + 1e-9, `${w}x${h} overflows`);
      assert.ok(Math.abs(fit.width - w) < 1e-9 || Math.abs(fit.height - h) < 1e-9, `${w}x${h} not maximal`);
      assert.ok(Math.abs(fit.width / fit.height - 1280 / 900) < 1e-9, `${w}x${h} aspect`);
    }
  });

  test('negative control: non-positive or non-finite sizes refuse', () => {
    for (const args of [[0, 1, 1, 1], [1, -1, 1, 1], [1, 1, 0, 1], [1, 1, 1, NaN],
      [Infinity, 1, 1, 1], ['1', 1, 1, 1]]) {
      assert.equal(containFit(...args), null, JSON.stringify(args));
    }
  });
});

describe('pointer mapping through the contain transform', () => {
  test('side bands: displayed points map to the right frame pixel', () => {
    const rect = { left: 201, top: 348, width: 1238, height: 283 };
    const fit = containFit(rect.width, rect.height, FRAME.width, FRAME.height);
    const scale = fit.scale;
    const display = (x, y) => [rect.left + fit.offsetX + (x + 0.5) * scale,
      rect.top + fit.offsetY + (y + 0.5) * scale];
    for (const [x, y] of [[0, 0], [640, 450], [1279, 899], [100, 800], [1000, 17]]) {
      assert.deepEqual(map(rect, ...display(x, y)), { x, y }, `${x},${y}`);
    }
    // Inside the left and right bands: never sent.
    assert.equal(map(rect, rect.left + 1, rect.top + 100), null);
    assert.equal(map(rect, rect.left + fit.offsetX - 0.5, rect.top + 100), null);
    assert.equal(map(rect, rect.left + fit.offsetX + fit.width + 0.5, rect.top + 100), null);
    assert.equal(map(rect, rect.left + rect.width - 1, rect.top + 100), null);
  });

  test('top and bottom bands: displayed points map to the right frame pixel', () => {
    const rect = { left: 10, top: 20, width: 640, height: 900 };
    // scale 0.5, frame drawn 640x450 at y = 20 + 225.
    assert.deepEqual(map(rect, 10 + 0.25, 245 + 0.25), { x: 0, y: 0 });
    assert.deepEqual(map(rect, 10 + 320.25, 245 + 225.25), { x: 640, y: 450 });
    assert.deepEqual(map(rect, 10 + 639.75, 245 + 449.75), { x: 1279, y: 899 });
    assert.equal(map(rect, 330, 244.9), null, 'top band');
    assert.equal(map(rect, 330, 245 + 450), null, 'bottom band');
    assert.equal(map(rect, 330, 21), null, 'top band edge');
  });

  test('exact fit has no bands and maps 1:1', () => {
    const rect = { left: 0, top: 0, width: 1280, height: 900 };
    assert.deepEqual(map(rect, 0, 0), { x: 0, y: 0 });
    assert.deepEqual(map(rect, 1279.9, 899.9), { x: 1279, y: 899 });
    assert.equal(map(rect, 1280, 10), null);
  });

  test('negative control: a stretched (non-contain) transform would map elsewhere', () => {
    const rect = { left: 0, top: 0, width: 1238, height: 283 };
    // Under a stretch the box centre-right point would be frame x ~= 1100;
    // under contain it falls in the right band.
    assert.equal(map(rect, 1064, 141), null);
  });
});

describe('canvas paints with contain and keeps the state row out of the canvas height', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url)), 'utf8');
  const style = source.slice(source.indexOf('<style'));
  const rule = (selector) => {
    const start = style.indexOf(`${selector} {`);
    assert.ok(start >= 0, selector);
    return style.slice(start, style.indexOf('}', start));
  };

  test('canvas keeps object-fit:contain and fills the tile body', () => {
    const canvas = rule('.mv-surface__canvas');
    assert.match(canvas, /object-fit:\s*contain/);
    assert.match(canvas, /flex:\s*1/);
    assert.match(canvas, /min-height:\s*0/);
  });

  test('state word overlays the strip line instead of taking a row', () => {
    assert.match(rule('.mv-surface'), /position:\s*relative/);
    const state = rule('.mv-surface__state');
    assert.match(state, /position:\s*absolute/);
    assert.match(state, /bottom:\s*0/);
    assert.match(rule('.mv-surface__strip'), /padding:\s*0 8px 0 48px/);
  });
});
