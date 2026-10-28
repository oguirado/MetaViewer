// MVUI25D lane C: mapper-import failure fails closed — the tileScheduler stubs
// return null (never throw), and the SurfaceCanvas handlers guard every mapper
// call, so nothing is queued and no error escapes a DOM listener. The stub
// half evaluates a copy of the scheduler with its static mapper imports
// rewritten to null stubs (relative specifiers cannot resolve from a data:
// URL, exactly like the mutant harnesses); the file-URL half pins the real
// mappers still work (positive control). Plain
// node:test; no async waits needed beyond the module import itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mapClientToFrame as frameViaScheduler,
  mapKeyboardEvent as keyViaScheduler,
} from '../src/surfaces/tileScheduler.js';

const schedulerSource = readFileSync(
  new URL('../src/surfaces/tileScheduler.js', import.meta.url), 'utf8');
const tileSource = readFileSync(
  new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');

// Separate module instance evaluated from a data: URL: the static mapper
// imports are rewritten to null stubs (relative specifiers cannot resolve
// from a data: URL), pinning the fail-closed contract.
const stubSource = schedulerSource
  .replace(`import { mapKeyboardEvent } from '../input/keyMap.js';`,
    'const mapKeyboardEvent = () => null;')
  .replace(`import { mapClientToFrame } from '../input/frameMap.js';`,
    'const mapClientToFrame = () => null;');
assert.ok(!stubSource.includes('../input/keyMap.js'), 'keyMap import must be stubbed out');
assert.ok(!stubSource.includes('../input/frameMap.js'), 'frameMap import must be stubbed out');
const stubbed = await import(
  `data:text/javascript;base64,${Buffer.from(stubSource).toString('base64')}#mvui25d-stubs`);

test('mvui25d failclosed: scheduler stubs return null instead of throwing', () => {
  assert.equal(typeof stubbed.mapKeyboardEvent, 'function');
  assert.equal(typeof stubbed.mapClientToFrame, 'function');
  assert.doesNotThrow(() => stubbed.mapKeyboardEvent({ key: 'a' }));
  assert.doesNotThrow(() => stubbed.mapClientToFrame(null));
  assert.equal(stubbed.mapKeyboardEvent({ key: 'a' }), null);
  assert.equal(stubbed.mapClientToFrame(null), null);
  assert.doesNotMatch(schedulerSource, /lane-P input mappers unavailable/,
    'the throwing stub text is gone');
});

test('mvui25d failclosed positive: file-URL mappers still map through the scheduler', () => {
  assert.deepEqual(keyViaScheduler({ key: 'Enter' }), { kind: 'key', keys: ['Return'] });
  assert.deepEqual(keyViaScheduler({ key: 'a' }), { kind: 'type', text: 'a' });
  assert.equal(frameViaScheduler(null), null);
});

test('mvui25d failclosed: handlers guard every mapper call with try/catch', () => {
  assert.match(tileSource, /try\s*\{\s*mapped = mapKeyboardEvent\(event\);\s*\}\s*catch\s*\{\s*return;\s*\}/,
    'keydown mapper call is guarded');
  assert.match(tileSource, /try\s*\{\s*return mapClientToFrame\(\{/,
    'client-to-frame mapper call is guarded');
  assert.match(tileSource, /inputPort\?\.queue\(props\.surfaceId, props\.streamId, mapped\)/,
    'guarded key path still queues after preventDefault');
});
