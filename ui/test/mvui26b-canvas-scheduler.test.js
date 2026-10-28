// MVUI26B lane S: synchronous tileScheduler evaluation — the lane-P mapper
// re-exports are static imports (no top-level await), so pages and e2e
// harnesses can call in right after load. The await scan strips comments
// and string literals, so prose may name the construct; a planted await in
// code must still trip it (negative control). Plain node:test; no waits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mapClientToFrame as frameViaScheduler,
  mapKeyboardEvent as keyViaScheduler,
} from '../src/surfaces/tileScheduler.js';
import { mapKeyboardEvent } from '../src/input/keyMap.js';
import { mapClientToFrame } from '../src/input/frameMap.js';

const schedulerSource = readFileSync(
  new URL('../src/surfaces/tileScheduler.js', import.meta.url), 'utf8');

// Comments first (JSDoc prose carries apostrophes), then string literals;
// what remains is code plus regex literals, where an await never hides.
function stripNonCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const CODE_AWAIT = /\bawait\b/;

test('mvui26b scheduler: no top-level await delays module evaluation', () => {
  assert.equal(CODE_AWAIT.test(stripNonCode(schedulerSource)), false,
    'no await outside comments and string literals');
  assert.match(schedulerSource,
    /import\s*\{\s*mapKeyboardEvent\s*\}\s*from\s*['"]\.\.\/input\/keyMap\.js['"]/,
    'static keyMap import');
  assert.match(schedulerSource,
    /import\s*\{\s*mapClientToFrame\s*\}\s*from\s*['"]\.\.\/input\/frameMap\.js['"]/,
    'static frameMap import');
  assert.match(schedulerSource, /export\s*\{\s*mapClientToFrame,\s*mapKeyboardEvent\s*\}/,
    'same-name re-export');
});

test('mvui26b scheduler negative: the scan flags a planted top-level await', () => {
  const planted = `${schedulerSource}\nconst late = await import('./late.js');\n`;
  assert.equal(CODE_AWAIT.test(stripNonCode(planted)), true, 'planted code await is detected');
  const commentOnly = `${schedulerSource}\n// a planted await in a line comment\n/* await in a block comment */\n`;
  assert.equal(CODE_AWAIT.test(stripNonCode(commentOnly)), false, 'comment awaits stay silent');
  const stringOnly = `${schedulerSource}\nconst label = 'no top-level await here';\n`;
  assert.equal(CODE_AWAIT.test(stripNonCode(stringOnly)), false, 'string awaits stay silent');
});

test('mvui26b scheduler: re-exported mappers work synchronously after import', () => {
  assert.equal(keyViaScheduler, mapKeyboardEvent, 'mapKeyboardEvent identity');
  assert.equal(frameViaScheduler, mapClientToFrame, 'mapClientToFrame identity');
  assert.deepEqual(keyViaScheduler({ key: 'Enter' }), { kind: 'key', keys: ['Return'] });
  assert.equal(frameViaScheduler(null), null);
});
