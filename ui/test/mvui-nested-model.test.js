// MetaViewer nested display-only mode (AC-17): depth parsing, injected
// host resolution, self-capsule filtering and clean-wall application.
// Every behaviour ships with a negative control proving it can fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NESTED_DISPLAY_DEPTH,
  NESTED_TOP_DEPTH,
  applyNestedWall,
  createMemoryNestedHost,
  filterNestedRows,
  isNestedDisplayOnly,
  parseNestedDepth,
  resolveNestedMode,
} from '../src/nested/nested.js';

test('depth constants pin top-level 0 and display-only 1', () => {
  assert.equal(NESTED_TOP_DEPTH, 0);
  assert.equal(NESTED_DISPLAY_DEPTH, 1);
});

test('depth parsing accepts absent, 0 and 1 as numbers or bare digits', () => {
  for (const absent of [null, undefined, '']) {
    assert.deepEqual(parseNestedDepth(absent), { ok: true, depth: 0 });
  }
  assert.deepEqual(parseNestedDepth(0), { ok: true, depth: 0 });
  assert.deepEqual(parseNestedDepth(1), { ok: true, depth: 1 });
  assert.deepEqual(parseNestedDepth('0'), { ok: true, depth: 0 });
  assert.deepEqual(parseNestedDepth('1'), { ok: true, depth: 1 });
});

test('depth parsing refuses depth 2 and above, never clamping', () => {
  for (const deep of [2, 3, 99, '2', '3', '10', -1, '-1']) {
    const parsed = parseNestedDepth(deep);
    assert.equal(parsed.ok, false, `expected refusal for ${String(deep)}`);
    assert.equal(parsed.ok === false && parsed.error.code, 'NESTED_DEPTH');
  }
});

test('depth parsing refuses malformed values with a typed code', () => {
  for (const malformed of ['01', '1 ', ' 1', 'one', '1.0', 1.5, NaN, true, {}, [], ['1']]) {
    const parsed = parseNestedDepth(malformed);
    assert.equal(parsed.ok, false, `expected refusal for ${String(malformed)}`);
    assert.equal(parsed.ok === false && parsed.error.code, 'NESTED_DEPTH_MALFORMED');
  }
});

test('display-only is true only at numeric depth 1', () => {
  assert.equal(isNestedDisplayOnly(1), true);
  for (const other of [0, 2, -1, '1', '0', null, undefined, true, NaN]) {
    assert.equal(isNestedDisplayOnly(other), false);
  }
});

test('mode resolution reads depth and self id through the injected host', () => {
  const nested = resolveNestedMode(createMemoryNestedHost({ depth: 1, selfCapsuleId: 'cap-self' }));
  assert.deepEqual({ ...nested }, { depth: 1, displayOnly: true, known: true, selfCapsuleId: 'cap-self' });
  assert.equal(Object.isFrozen(nested), true);
  const top = resolveNestedMode(createMemoryNestedHost({ depth: 0 }));
  assert.deepEqual({ ...top }, { depth: 0, displayOnly: false, known: true, selfCapsuleId: null });
  const bare = resolveNestedMode(createMemoryNestedHost());
  assert.deepEqual({ ...bare }, { depth: 0, displayOnly: false, known: false, selfCapsuleId: null });
});

test('mode resolution never throws and never surfaces host failure as text', () => {
  const throwing = {
    getNestedDepth: () => {
      throw new Error('HOST-BOOM');
    },
    getSelfCapsuleId: () => {
      throw new Error('HOST-BOOM');
    },
  };
  for (const host of [null, undefined, {}, throwing]) {
    const mode = resolveNestedMode(/** @type {any} */ (host));
    assert.deepEqual({ ...mode }, { depth: 0, displayOnly: false, known: false, selfCapsuleId: null });
  }
  const deep = resolveNestedMode(createMemoryNestedHost({ depth: 2, selfCapsuleId: 'cap-self' }));
  assert.deepEqual({ ...deep }, { depth: 0, displayOnly: false, known: false, selfCapsuleId: null });
});

test('row filtering removes the self capsule by id or surface id', () => {
  const rows = [
    { id: 'cap-a', surfaceId: 'cap-a' },
    { id: 'cap-self', surfaceId: 'cap-self' },
    { id: 'cap-b', surfaceId: 'cap-b' },
    { id: 'cap-alias', surfaceId: 'cap-self' },
  ];
  assert.deepEqual(filterNestedRows(rows, 'cap-self'), [
    { id: 'cap-a', surfaceId: 'cap-a' },
    { id: 'cap-b', surfaceId: 'cap-b' },
  ]);
  assert.equal(rows.length, 4);
  assert.deepEqual(filterNestedRows(rows, 'cap-absent'), rows);
  assert.deepEqual(filterNestedRows(rows, null), rows);
  assert.notEqual(filterNestedRows(rows, null), rows);
  assert.deepEqual(filterNestedRows([null, { id: 'cap-self' }], 'cap-self'), [null]);
  assert.deepEqual(filterNestedRows(null, 'cap-self'), []);
  assert.deepEqual(filterNestedRows('rows', 'cap-self'), []);
});

test('wall application filters only in display-only mode, else copies', () => {
  const rows = [{ id: 'cap-self' }, { id: 'cap-a' }];
  const nested = applyNestedWall(rows, { displayOnly: true, selfCapsuleId: 'cap-self' });
  assert.deepEqual(nested.rows, [{ id: 'cap-a' }]);
  assert.equal(nested.displayOnly, true);
  for (const mode of [null, undefined, {}, { displayOnly: false }, { displayOnly: 'yes' }]) {
    const top = applyNestedWall(rows, /** @type {any} */ (mode));
    assert.deepEqual(top.rows, rows);
    assert.equal(top.displayOnly, false);
    assert.notEqual(top.rows, rows);
  }
  const empty = applyNestedWall(null, { displayOnly: true, selfCapsuleId: 'cap-self' });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.displayOnly, true);
});

test('nested resolution is deterministic across repeated reads', () => {
  const host = createMemoryNestedHost({ depth: '1', selfCapsuleId: 'cap-self' });
  assert.deepEqual(resolveNestedMode(host), resolveNestedMode(host));
  assert.deepEqual(
    applyNestedWall([{ id: 'cap-a' }], resolveNestedMode(host)),
    applyNestedWall([{ id: 'cap-a' }], resolveNestedMode(host)),
  );
});
