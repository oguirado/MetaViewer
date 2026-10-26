// Lane V2 judge notes A1/A2: refusal-code accessor, panel-helper deprecation
// marker, and the catalog error-dedup design lock.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  deriveTileState,
  refusalCodeFor,
  TILE_ERROR_DISPLAY_STATUS,
} from '../src/wall/tileStates.js';
import {
  CATALOG_INVALID_ENTRY,
  normalizeCatalogEntries,
} from '../src/catalog/catalogModel.js';

function liveSnapshot(rows, overrides = {}) {
  return {
    status: 'live',
    stale: false,
    envelope: {
      schema: 'surface/v0.1', epoch: 3, revision: 7, query: 'wall', projection: { rows },
    },
    error: null,
    ...overrides,
  };
}

function tileRow(id, overrides = {}) {
  return {
    id, surfaceId: id, backendLifecycle: 'active', generation: 1,
    visibility: 'unfolded', control: 'shared', attachmentState: 'live', ...overrides,
  };
}

describe('judge A1: refusal code accessor', () => {
  test('refusalCodeFor returns the typed code from row or snapshot', () => {
    const row = tileRow('a', { refusal: { code: 'POLICY', message: 'denied' } });
    assert.equal(refusalCodeFor(liveSnapshot([row]), row), 'POLICY');
    const clean = tileRow('a');
    const snapshotError = liveSnapshot([clean], { error: { code: 'BUDGET_EXCEEDED', message: 'spent' } });
    assert.equal(refusalCodeFor(snapshotError, clean), 'BUDGET_EXCEEDED');
    // Negative control: the row refusal wins over the snapshot error.
    assert.equal(refusalCodeFor(snapshotError, row), 'POLICY');
  });

  test('negative controls: codeless refusals yield null, never a code', () => {
    for (const refusal of [null, undefined, {}, { code: '' }, { code: 7 }, 'POLICY']) {
      const row = tileRow('a', { refusal });
      assert.equal(refusalCodeFor(liveSnapshot([row]), row), null, JSON.stringify(refusal));
    }
    assert.equal(refusalCodeFor(null, null), null);
  });

  test('deriveTileState error branch matches the accessor exactly', () => {
    const row = tileRow('a', { refusal: { code: 'POLICY', message: 'denied' } });
    const decided = deriveTileState(liveSnapshot([row]), row);
    assert.equal(decided.tile, 'error');
    assert.equal(decided.status, `Refused: ${refusalCodeFor(liveSnapshot([row]), row)}`);
    // Negative control: without a code the tile never renders the error branch.
    const clean = tileRow('a');
    assert.equal(refusalCodeFor(liveSnapshot([clean]), clean), null);
    assert.equal(deriveTileState(liveSnapshot([clean]), clean).tile, 'live');
  });

  test('error status keeps the coded parity form; the display string is separate', () => {
    assert.equal(TILE_ERROR_DISPLAY_STATUS, 'Surface update unavailable');
    const row = tileRow('a', { refusal: { code: 'POLICY', message: 'denied' } });
    assert.equal(deriveTileState(liveSnapshot([row]), row).status, 'Refused: POLICY');
    const panelSource = readFileSync(new URL('../src/wall/SurfacePanel.vue', import.meta.url), 'utf8');
    assert.ok(
      panelSource.includes(`'${TILE_ERROR_DISPLAY_STATUS}'`),
      'the panel template masks with the same display string',
    );
    // Negative control: the raw code never equals the display string.
    assert.notEqual('Refused: POLICY', TILE_ERROR_DISPLAY_STATUS);
  });

  test('derivePanelStatus stays exported but is marked deprecated', () => {
    const source = readFileSync(new URL('../src/wall/SurfacePanel.vue', import.meta.url), 'utf8');
    assert.match(
      source,
      /@deprecated[\s\S]{0,400}export function derivePanelStatus/,
      'deprecation marker names the helper',
    );
    // Negative control: the marker predicate fails a marker-less fixture.
    const legacy = '/** Derive one display status. */\nexport function derivePanelStatus() {}';
    assert.throws(
      () => assert.match(legacy, /@deprecated[\s\S]{0,400}export function derivePanelStatus/),
      assert.AssertionError,
    );
  });
});

describe('judge A2: catalog error-dedup design lock', () => {
  test('distinct malformed entries collapse to one shared row by design', () => {
    const normalized = normalizeCatalogEntries([null, 42, {}, []]);
    assert.equal(normalized.errors.length, 1);
    assert.equal(normalized.errors[0].code, CATALOG_INVALID_ENTRY);
    assert.equal(normalized.errors[0].key, 'invalid-entry-unknown');
    assert.equal(normalized.errors[0].kind, null);
  });

  test('distinct unknown kinds sharing a slug receive indexed suffixes', () => {
    const normalized = normalizeCatalogEntries(['Foo Bar', 'foo-bar']);
    assert.deepEqual(normalized.errors.map((row) => row.key),
      ['unknown-kind-foo-bar', 'unknown-kind-foo-bar-2']);
    // Negative control: identical raw kinds still collapse (first wins).
    const dupes = normalizeCatalogEntries(['teleport', 'teleport']);
    assert.equal(dupes.errors.length, 1);
    assert.equal(dupes.errors[0].key, 'unknown-kind-teleport');
  });

  test('negative controls: unknown kinds never collapse across raw kinds', () => {
    const normalized = normalizeCatalogEntries(['teleport', 'wormhole']);
    assert.equal(normalized.errors.length, 2);
    assert.deepEqual(normalized.errors.map((row) => row.kind), ['teleport', 'wormhole']);
    const edge = normalizeCatalogEntries(['invalid-entry-unknown', null]);
    assert.deepEqual(edge.errors.map((row) => row.key),
      ['unknown-kind-invalid-entry-unknown', 'invalid-entry-unknown']);
  });

  test('the by-design collapse is documented on normalizeCatalogEntries', () => {
    const source = readFileSync(new URL('../src/catalog/catalogModel.js', import.meta.url), 'utf8');
    assert.match(
      source,
      /collapse to one shared[\s\S]{0,200}invalid-entry row by design/,
      'design note documents the collapse',
    );
  });
});
