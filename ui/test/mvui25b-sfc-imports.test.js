// MVUI25B lane C: SFC closed-dependency regression — SurfaceCanvas.vue must
// import only vue and ./tileScheduler.js (defect 1: pre-existing harnesses
// compile the SFC with a closed map and fail on ../input/*). Also pins that
// tileScheduler re-exports both lane-P mappers by identity with a behaviour
// spot-check through the re-export. Plain node:test; no async waits needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mapClientToFrame as frameViaScheduler,
  mapKeyboardEvent as keyViaScheduler,
} from '../src/surfaces/tileScheduler.js';
import { mapKeyboardEvent } from '../src/input/keyMap.js';
import { mapClientToFrame } from '../src/input/frameMap.js';

const sfcSource = readFileSync(
  new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');
const FORBIDDEN_INPUT_IMPORT = /from\s+['"]\.\.\/input\//;

test('mvui25b sfc imports: SurfaceCanvas imports nothing from ../input', () => {
  assert.doesNotMatch(sfcSource, FORBIDDEN_INPUT_IMPORT, 'no ../input import in the SFC');
  assert.match(sfcSource, /from\s+['"]\.\/tileScheduler\.js['"]/,
    'the SFC still imports the scheduler (allowed path)');
  assert.match(sfcSource, /from\s+['"]vue['"]/, 'the SFC still imports vue');
});

test('mvui25b sfc imports negative: the forbidden pattern is detectable', () => {
  assert.match("import { mapKeyboardEvent } from '../input/keyMap.js';",
    FORBIDDEN_INPUT_IMPORT, 'fixture with ../input import matches');
  assert.match('import { x } from "../input/frameMap.js";',
    FORBIDDEN_INPUT_IMPORT, 'double-quoted ../input import matches');
  assert.doesNotMatch("import { x } from './tileScheduler.js';",
    FORBIDDEN_INPUT_IMPORT, 'scheduler import does not match');
});

test('mvui25b re-export: scheduler re-exports both lane-P mappers', () => {
  assert.equal(keyViaScheduler, mapKeyboardEvent, 'mapKeyboardEvent identity');
  assert.equal(frameViaScheduler, mapClientToFrame, 'mapClientToFrame identity');
  assert.deepEqual(keyViaScheduler({ key: 'Enter' }), { kind: 'key', keys: ['Return'] });
  assert.equal(frameViaScheduler(null), null);
});

test('mvui25b re-export negative: identity check distinguishes functions', () => {
  assert.notEqual(keyViaScheduler, frameViaScheduler, 'the two mappers differ');
  assert.equal(typeof keyViaScheduler, 'function');
  assert.equal(typeof frameViaScheduler, 'function');
});
