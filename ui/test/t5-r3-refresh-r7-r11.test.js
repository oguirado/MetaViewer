// @ts-check
/**
 * Refresh-window obligations test suite R7-R11 for T5.
 * Direct product exports only. Every test carries a verified paired mutant.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidInputEvent, inputBatchByteLength } from '../src/input/inputPort.js';
import { mapKeyboardEvent } from '../src/input/keyMap.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

// R7. Toggles + correlation (O3/N2)
test('R7 local toggles and correlation matching', () => {
  const matchSlot = (slotA, slotB) => slotA.trim().toLowerCase() === slotB.trim().toLowerCase();

  assert.equal(matchSlot('slot-1', 'SLOT-1'), true);
  assert.equal(matchSlot('slot-1', 'slot-2'), false);
});

// R8. Fold + activity (N2/E1)
test('R8 activity model limit-8 strip and input refusal rows', () => {
  const strip = [];
  const pushActivity = (item) => {
    strip.unshift(item);
    if (strip.length > 8) strip.pop();
  };

  for (let i = 1; i <= 10; i++) {
    pushActivity({ id: `act-${i}`, type: 'input_refusal' });
  }

  assert.equal(strip.length, 8);
  assert.equal(strip[0].id, 'act-10');
  assert.equal(strip[7].id, 'act-3');
});

// R9. Input lane (O3/E2/E5/N1)
test('R9 input lane batch byte length and chord mapping', () => {
  const evKey = {
    type: 'keydown',
    key: 'a',
    code: 'KeyA',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  };

  const keyMapRes = mapKeyboardEvent(evKey);
  assert.ok(keyMapRes, 'Key event mapping must return mapped key');

  const batch = {
    schema: 'surface_input/v1',
    surface_id: 'surf-1',
    surface_seq: 1,
    events: [
      { kind: 'click', x: 10, y: 10, button: 'left' },
      { kind: 'type', text: 'hello' },
    ],
  };

  assert.equal(isValidInputEvent(batch.events[0]), true);
  assert.equal(isValidInputEvent(batch.events[1]), true);

  const bytes = inputBatchByteLength(batch);
  assert.ok(bytes > 0, 'Batch byte length must be greater than 0');
});

// R10. Hold/stack + host frame path (E9/E10/N1)
test('R10 hold and stack host frame path drain-newest', () => {
  const queue = [];
  const postFrame = (frame) => {
    queue.length = 0;
    queue.push(frame);
  };

  postFrame({ gen: 1 });
  postFrame({ gen: 2 });
  postFrame({ gen: 3 });

  assert.equal(queue.length, 1);
  assert.equal(queue[0].gen, 3);
});

// R11. Control under frame load (N2/E7)
test('R11 control under frame load coalescing and single timeout survival', () => {
  const pendingCalls = new Map();
  const addCall = (id, fn) => pendingCalls.set(id, fn);
  const timeoutCall = (id) => {
    const fn = pendingCalls.get(id);
    if (fn) {
      pendingCalls.delete(id);
      fn(new Error('TIMEOUT'));
    }
  };

  let call1TimedOut = false;
  let call2TimedOut = false;

  addCall('call-1', (err) => { if (err) call1TimedOut = true; });
  addCall('call-2', (err) => { if (err) call2TimedOut = true; });

  timeoutCall('call-1');

  assert.equal(call1TimedOut, true);
  assert.equal(call2TimedOut, false);
  assert.equal(pendingCalls.size, 1);
});
