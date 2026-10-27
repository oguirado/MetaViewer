'use strict';
// Repeat rung determinism: drives real hosted slice from e2e1_slice/index.js x20.
// Mutation: append a varying counter to digest in e2e1_slice/index.js hosted()
// -> new Set(digests).size exceeds 1 and the repeat rung assertion fails.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hosted } = require('./e2e1_slice/index.js');

test('repeat rung runs real hosted slice x20 with identical state digests', () => {
  const digests = [];
  for (let i = 0; i < 20; i++) {
    const res = hosted();
    assert.equal(res.mode, 'hosted-core-only');
    assert.ok(res.digest, 'digest present');
    digests.push(res.digest);
  }

  assert.equal(new Set(digests).size, 1, 'all 20 runs must yield the exact same digest');
});
