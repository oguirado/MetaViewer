'use strict';
// E2E Item 12: Routing ownership (E6, E7, E4)
// Cites SW-0269 (E6, E7), SW-0224 §2.3 (E4).
// Uses validateWallReport from harness.js directly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateWallReport, E2EError } = require('./harness.js');

test('Item 12: validateWallReport accepts matching publisher map and valid tiles (E6, E7, E4)', () => {
  const frameOwners = new Map([
    ['f-1', 'cap-1'],
    ['f-2', 'cap-2'],
    ['f-3', 'cap-3'],
    ['f-4', 'cap-4'],
  ]);

  const report = {
    schema: 'e2e-wall-report/v1',
    phase: 'wall',
    tiles: [
      { capsuleId: 'cap-1', visible: true, frameId: 'f-1' },
      { capsuleId: 'cap-2', visible: true, frameId: 'f-2' },
      { capsuleId: 'cap-3', visible: true, frameId: 'f-3' },
      { capsuleId: 'cap-4', visible: true, frameId: 'f-4' },
    ],
    errors: [],
  };

  const res = validateWallReport(report, { frameOwners, minTiles: 4 });
  assert.equal(res.visible, 4);
  assert.equal(res.errors.length, 0);
});

test('Item 12: Negative controls - validateWallReport refuses swapped, foreign, or unpublished frames with E2E_ROUTING', () => {
  const frameOwners = new Map([
    ['f-1', 'cap-1'],
    ['f-2', 'cap-2'],
    ['f-3', 'cap-3'],
    ['f-4', 'cap-4'],
  ]);

  // 1. Swapped frame
  const swappedReport = {
    schema: 'e2e-wall-report/v1',
    phase: 'wall',
    tiles: [
      { capsuleId: 'cap-1', visible: true, frameId: 'f-2' },
      { capsuleId: 'cap-2', visible: true, frameId: 'f-1' },
      { capsuleId: 'cap-3', visible: true, frameId: 'f-3' },
      { capsuleId: 'cap-4', visible: true, frameId: 'f-4' },
    ],
    errors: [],
  };

  assert.throws(() => {
    validateWallReport(swappedReport, { frameOwners, minTiles: 4 });
  }, (err) => err instanceof E2EError && err.code === 'E2E_ROUTING');

  // 2. Unpublished frame ID
  const unpublishedReport = {
    schema: 'e2e-wall-report/v1',
    phase: 'wall',
    tiles: [
      { capsuleId: 'cap-1', visible: true, frameId: 'f-unknown' },
      { capsuleId: 'cap-2', visible: true, frameId: 'f-2' },
      { capsuleId: 'cap-3', visible: true, frameId: 'f-3' },
      { capsuleId: 'cap-4', visible: true, frameId: 'f-4' },
    ],
    errors: [],
  };

  assert.throws(() => {
    validateWallReport(unpublishedReport, { frameOwners, minTiles: 4 });
  }, (err) => err instanceof E2EError && err.code === 'E2E_ROUTING');

  // 3. Opaque report without frameOwners map refuses live frame IDs
  assert.throws(() => {
    validateWallReport(reportWithOpaqueIds(), { minTiles: 4 });
  }, (err) => err instanceof E2EError && err.code === 'E2E_ROUTING');
});

function reportWithOpaqueIds() {
  return {
    schema: 'e2e-wall-report/v1',
    phase: 'wall',
    tiles: [
      { capsuleId: 'cap-1', visible: true, frameId: 'opaque-1' },
      { capsuleId: 'cap-2', visible: true, frameId: 'opaque-2' },
      { capsuleId: 'cap-3', visible: true, frameId: 'opaque-3' },
      { capsuleId: 'cap-4', visible: true, frameId: 'opaque-4' },
    ],
    errors: [],
  };
}
