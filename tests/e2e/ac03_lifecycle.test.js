'use strict';

/**
 * AC-03 capsule lifecycle journey (roadmap: New Capsule launcher lifecycle).
 *
 * Runs under node --test; locates the repo root from its own path. Two layers:
 *
 * 1. Lifecycle contract tests: pure closed validation of catalog entries,
 *    surface_event.error rows, and lifecycle traces (create/destroy/lost
 *    with tombstones), each paired with mutant fixtures that must FAIL
 *    the same assertions a broken lifecycle would trip. These run on
 *    every host with node alone.
 * 2. The live lifecycle journey: drives the real catalog authority
 *    (metaviewer_core::catalog) for every contract kind, boots the
 *    product wall fixture under xvfb, and kills an external child
 *    through the harness PID guard. It fails closed with a typed
 *    E2E_* error when a prerequisite is missing (live flag, xvfb,
 *    Electron binary, Rust toolchain); it never skips.
 *
 * [TARGET, unit decision] Roadmap AC-03 names identity browser, program,
 * Holdings app, desktop. The contract kind literals are browser,
 * program, game_capsule (Holdings app: its launch target resolves to
 * srf-holdings-capsule), desktop_capsule, plus vm; this file exercises
 * all five contract kinds so the four roadmap kinds are covered.
 * [TARGET, unit decision] The trace witness validator below is additive
 * in this file: harness.js is owned by another lane and only read here.
 * program is absent from surface_request/v0.2 transport kinds, so the
 * live driver exercises it through CreateRequest directly.
 *
 * CI entry (tests/e2e/run.py): exec `node --test tests/e2e/*.test.js`
 * under `xvfb-run -a -s "-screen 0 1280x900x24"` with the AC harness.
 *
 * @module ac03_lifecycle
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { createServer } = require('node:net');
const { join } = require('node:path');
const { crc32, deflateSync } = require('node:zlib');

const {
  E2EError,
  findRepoRoot,
  electronBinary,
  makeScratch,
  removeScratch,
  requireXvfb,
  runUnderXvfb,
  readProbeReport,
  terminate,
  assertPid,
  writeFakeManifest,
  writeProbeFile,
} = require('./ac-harness.cjs');
const { runRust } = require('./core-driver.js');

/** Env flag arming the live journey; anything else refuses the run. */

/** Closed catalog entry schema tag (contracts/v0.2). */
const CATALOG_SCHEMA = 'catalog_entry/v0.2';
/** Closed surface event schema tag (contracts/v0.2). */
const SURFACE_EVENT_SCHEMA = 'surface_event/v0.2';

/**
 * Catalog kinds from catalog_entry.schema.json. Duplicated as literals
 * so contract drift fails loudly at the fixture boundary.
 */
const CATALOG_KINDS = Object.freeze([
  'browser',
  'program',
  'desktop_capsule',
  'game_capsule',
  'vm',
]);

/** Roadmap AC-03 kind name to contract kind literal. */
const ROADMAP_KINDS = Object.freeze({
  identity_browser: 'browser',
  program: 'program',
  holdings_app: 'game_capsule',
  desktop: 'desktop_capsule',
});

/** Catalog id charset from the schema pattern. */
const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** Network enum from the schema. */
const NETWORKS = Object.freeze(['none', 'proxy']);
/** Trace operations. */
const TRACE_OPS = Object.freeze(['created', 'destroyed', 'lost', 'error']);

/**
 * Assert a thunk throws E2EError with one of the expected codes.
 * @param {() => unknown} thunk Failing thunk.
 * @param {ReadonlyArray<string>} codes Accepted codes.
 */
function rejectsWith(thunk, codes) {
  assert.throws(
    thunk,
    (error) => error instanceof E2EError && codes.includes(error.code),
    `expected E2EError with code in ${codes.join(',')}`,
  );
}

/**
 * Reject objects with keys outside the closed set.
 * @param {Record<string, unknown>} value Object under test.
 * @param {ReadonlyArray<string>} allowed Exact key set.
 * @param {string} label Field label for the error.
 * @param {string} code Refusal code.
 */
function needClosedKeys(value, allowed, label, code) {
  const keys = Object.keys(value).sort();
  const want = [...allowed].sort();
  if (keys.length !== want.length || keys.some((key, index) => key !== want[index])) {
    throw new E2EError(code, `${label} has unexpected keys: ${keys.join(',')}`);
  }
}

/**
 * @param {unknown} value Candidate.
 * @param {string} label Field label.
 * @param {number} min Minimum length.
 * @param {number} max Maximum length.
 * @returns {string} The validated string.
 */
function needBoundedText(value, label, min, max, code) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new E2EError(code, `${label} must be a ${min}..${max} string`);
  }
  return value;
}

/**
 * @param {unknown} value Candidate.
 * @param {string} label Field label.
 * @param {number} min Minimum value.
 * @param {number} max Maximum value.
 * @returns {number} The validated integer.
 */
function needBoundedInt(value, label, min, max, code) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new E2EError(code, `${label} must be an integer ${min}..${max}`);
  }
  return value;
}

/**
 * Closed validation of one catalog entry against the schema shape:
 * required fields, kind enum, id charsets, geometry ranges, and the
 * closed limits object.
 * @param {unknown} value Candidate entry.
 * @returns {Record<string, unknown>} The validated entry.
 */
function checkCatalogEntry(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new E2EError('E2E_CATALOG', 'catalog entry must be an object');
  }
  const row = /** @type {Record<string, unknown>} */ (value);
  needClosedKeys(row, ['schema', 'entry_id', 'kind', 'profile_id', 'label', 'image',
    'window_width_px', 'window_height_px', 'display_width_px', 'display_height_px',
    'display_only', 'network', 'seccomp_identity', 'nested_depth', 'limits'],
  'catalog entry', 'E2E_CATALOG');
  if (row.schema !== CATALOG_SCHEMA) throw new E2EError('E2E_CATALOG', 'catalog schema mismatch');
  const entryId = needBoundedText(row.entry_id, 'entry_id', 1, 128, 'E2E_CATALOG');
  if (!ENTRY_ID_PATTERN.test(entryId)) throw new E2EError('E2E_CATALOG', 'entry_id charset mismatch');
  if (typeof row.kind !== 'string' || !CATALOG_KINDS.includes(row.kind)) {
    throw new E2EError('E2E_CATALOG', `kind must be one of ${CATALOG_KINDS.join(',')}`);
  }
  const profileId = needBoundedText(row.profile_id, 'profile_id', 1, 128, 'E2E_CATALOG');
  if (!ENTRY_ID_PATTERN.test(profileId)) {
    throw new E2EError('E2E_CATALOG', 'profile_id charset mismatch');
  }
  needBoundedText(row.label, 'label', 1, 256, 'E2E_CATALOG');
  needBoundedText(row.image, 'image', 1, 256, 'E2E_CATALOG');
  needBoundedInt(row.window_width_px, 'window_width_px', 1, 16384, 'E2E_CATALOG');
  needBoundedInt(row.window_height_px, 'window_height_px', 1, 16384, 'E2E_CATALOG');
  needBoundedInt(row.display_width_px, 'display_width_px', 1, 16384, 'E2E_CATALOG');
  needBoundedInt(row.display_height_px, 'display_height_px', 1, 16384, 'E2E_CATALOG');
  if (typeof row.display_only !== 'boolean') {
    throw new E2EError('E2E_CATALOG', 'display_only must be boolean');
  }
  if (typeof row.network !== 'string' || !NETWORKS.includes(row.network)) {
    throw new E2EError('E2E_CATALOG', 'network must be none or proxy');
  }
  if (typeof row.seccomp_identity !== 'boolean') {
    throw new E2EError('E2E_CATALOG', 'seccomp_identity must be boolean');
  }
  needBoundedInt(row.nested_depth, 'nested_depth', 0, 1, 'E2E_CATALOG');
  if (typeof row.limits !== 'object' || row.limits === null || Array.isArray(row.limits)) {
    throw new E2EError('E2E_CATALOG', 'limits must be an object');
  }
  const limits = /** @type {Record<string, unknown>} */ (row.limits);
  needClosedKeys(limits, ['memory_bytes', 'cpu_milli'], 'limits', 'E2E_CATALOG');
  needBoundedInt(limits.memory_bytes, 'memory_bytes', 1, 1073741824, 'E2E_CATALOG');
  needBoundedInt(limits.cpu_milli, 'cpu_milli', 1, 20000, 'E2E_CATALOG');
  return row;
}

/**
 * Closed validation of a surface_event.error row: unknown kinds and
 * unregistered profiles must surface exactly this shape.
 * @param {unknown} value Candidate event.
 * @returns {Record<string, unknown>} The validated event.
 */
function checkSurfaceEventError(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new E2EError('E2E_EVENT', 'surface event must be an object');
  }
  const row = /** @type {Record<string, unknown>} */ (value);
  needClosedKeys(row, ['schema', 'event', 'data'], 'surface event', 'E2E_EVENT');
  if (row.schema !== SURFACE_EVENT_SCHEMA) throw new E2EError('E2E_EVENT', 'event schema mismatch');
  if (row.event !== 'error') throw new E2EError('E2E_EVENT', 'event must be error');
  if (typeof row.data !== 'object' || row.data === null || Array.isArray(row.data)) {
    throw new E2EError('E2E_EVENT', 'event data must be an object');
  }
  const data = /** @type {Record<string, unknown>} */ (row.data);
  needClosedKeys(data, ['surface_id', 'code', 'detail'], 'event data', 'E2E_EVENT');
  needBoundedText(data.surface_id, 'surface_id', 1, 128, 'E2E_EVENT');
  needBoundedText(data.code, 'code', 1, 128, 'E2E_EVENT');
  needBoundedText(data.detail, 'detail', 1, 65536, 'E2E_EVENT');
  return row;
}

/**
 * Validate a lifecycle trace: created rows bring an id live exactly
 * once, destroyed/lost rows retire a live id, error rows never create
 * a surface, and no id is ever revived after a terminal row.
 * @param {unknown} value Candidate trace array.
 * @returns {{ created: number, destroyed: number, lost: number, errors: number,
 * live: string[] }} Normalized summary.
 */
function checkLifecycleTrace(value) {
  if (!Array.isArray(value)) throw new E2EError('E2E_TRACE', 'trace must be an array');
  /** @type {Map<string, string>} */
  const state = new Map();
  let created = 0;
  let destroyed = 0;
  let lost = 0;
  let errors = 0;
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new E2EError('E2E_TRACE', 'trace row must be an object');
    }
    const row = /** @type {Record<string, unknown>} */ (item);
    needClosedKeys(row, ['surface_id', 'op', 'code'], 'trace row', 'E2E_TRACE');
    const id = needBoundedText(row.surface_id, 'surface_id', 1, 128, 'E2E_TRACE');
    if (typeof row.op !== 'string' || !TRACE_OPS.includes(row.op)) {
      throw new E2EError('E2E_TRACE', 'trace op must be created, destroyed, lost, or error');
    }
    const op = row.op;
    if (op === 'error') {
      needBoundedText(row.code, 'code', 1, 128, 'E2E_TRACE');
      errors += 1;
      continue;
    }
    if (row.code !== null) throw new E2EError('E2E_TRACE', 'non-error rows carry a null code');
    if (op === 'created') {
      if (state.has(id)) throw new E2EError('E2E_REVIVE', `surface id revived: ${id}`);
      state.set(id, 'live');
      created += 1;
    } else if (state.get(id) !== 'live') {
      throw new E2EError('E2E_STATE', `surface ${id} is not live for ${op}`);
    } else if (op === 'destroyed') {
      state.set(id, 'destroyed');
      destroyed += 1;
    } else {
      state.set(id, 'lost');
      lost += 1;
    }
  }
  const live = [...state.entries()].filter(([, status]) => status === 'live').map(([id]) => id);
  return { created, destroyed, lost, errors, live };
}

/**
 * Build a valid catalog entry fixture for a contract kind.
 * @param {string} kind Contract kind literal.
 * @returns {Record<string, unknown>} The entry fixture.
 */
function validCatalogEntry(kind) {
  const game = kind === 'game_capsule';
  return {
    schema: CATALOG_SCHEMA,
    entry_id: `ac03-${kind.replace(/_/g, '-')}`,
    kind,
    profile_id: game ? 'holdings-app-1' : `ac03-${kind.replace(/_/g, '-')}-profile`,
    label: `AC03 ${kind}`,
    image: 'ac03-fixture-image',
    window_width_px: 1280,
    window_height_px: game ? 900 : 720,
    display_width_px: 1280,
    display_height_px: 900,
    display_only: false,
    network: 'none',
    seccomp_identity: true,
    nested_depth: 0,
    limits: { memory_bytes: 268435456, cpu_milli: 2000 },
  };
}

/**
 * Build a valid trace: one surface per roadmap kind created and
 * destroyed, plus one externally-killed surface marked lost.
 * @returns {Array<Record<string, unknown>>} The trace fixture.
 */
function validLifecycleTrace() {
  const rows = Object.values(ROADMAP_KINDS).map((kind) => ([
    { surface_id: `ac03-surf-${kind}`, op: 'created', code: null },
    { surface_id: `ac03-surf-${kind}`, op: 'destroyed', code: null },
  ])).flat();
  rows.push(
    { surface_id: 'ac03-surf-lost', op: 'created', code: null },
    { surface_id: 'ac03-surf-lost', op: 'lost', code: null },
  );
  return rows;
}

describe('ac03 lifecycle contract (Layer 1)', () => {
  it('pins the five contract catalog kinds covering the four roadmap kinds', () => {
    assert.deepEqual([...CATALOG_KINDS],
      ['browser', 'program', 'desktop_capsule', 'game_capsule', 'vm']);
    assert.deepEqual({ ...ROADMAP_KINDS }, {
      identity_browser: 'browser',
      program: 'program',
      holdings_app: 'game_capsule',
      desktop: 'desktop_capsule',
    });
    for (const kind of Object.values(ROADMAP_KINDS)) {
      assert.ok(CATALOG_KINDS.includes(kind), `roadmap kind missing: ${kind}`);
    }
  });

  it('accepts a valid catalog entry for every contract kind', () => {
    for (const kind of CATALOG_KINDS) {
      const row = checkCatalogEntry(validCatalogEntry(kind));
      assert.equal(row.kind, kind);
    }
  });

  it('accepts a valid create/destroy/lost lifecycle trace with tombstones', () => {
    const summary = checkLifecycleTrace(validLifecycleTrace());
    assert.equal(summary.created, 5);
    assert.equal(summary.destroyed, 4);
    assert.equal(summary.lost, 1);
    assert.equal(summary.errors, 0);
    assert.deepEqual(summary.live, []);
  });

  it('accepts a valid surface_event.error row', () => {
    const row = checkSurfaceEventError({
      schema: SURFACE_EVENT_SCHEMA,
      event: 'error',
      data: { surface_id: 'ac03-surf-ghost', code: 'POLICY', detail: 'UnknownKind' },
    });
    assert.equal(row.event, 'error');
  });

  it('negative control: unknown kind is refused (AC-03 negative)', () => {
    const mutant = validCatalogEntry('browser');
    mutant.kind = 'spaceship';
    rejectsWith(() => checkCatalogEntry(mutant), ['E2E_CATALOG']);
  });

  it('negative control: unregistered profile yields error rows and zero surfaces (AC-03 negative)', () => {
    const trace = [
      { surface_id: 'ac03-surf-ghost', op: 'error', code: 'UnregisteredProfile' },
    ];
    const summary = checkLifecycleTrace(trace);
    assert.equal(summary.errors, 1);
    assert.equal(summary.created, 0);
    assert.deepEqual(summary.live, []);
  });

  it('negative control: destroyed or lost ids are never revived', () => {
    const destroyed = validLifecycleTrace();
    destroyed.push({ surface_id: 'ac03-surf-browser', op: 'created', code: null });
    rejectsWith(() => checkLifecycleTrace(destroyed), ['E2E_REVIVE']);
    const lost = validLifecycleTrace();
    lost.push({ surface_id: 'ac03-surf-lost', op: 'created', code: null });
    rejectsWith(() => checkLifecycleTrace(lost), ['E2E_REVIVE']);
    const doubled = [
      { surface_id: 'ac03-surf-x', op: 'created', code: null },
      { surface_id: 'ac03-surf-x', op: 'created', code: null },
    ];
    rejectsWith(() => checkLifecycleTrace(doubled), ['E2E_REVIVE']);
  });

  it('negative control: transitions on non-live surfaces are refused', () => {
    rejectsWith(() => checkLifecycleTrace(
      [{ surface_id: 'ac03-surf-ghost', op: 'destroyed', code: null }]), ['E2E_STATE']);
    rejectsWith(() => checkLifecycleTrace(
      [{ surface_id: 'ac03-surf-ghost', op: 'lost', code: null }]), ['E2E_STATE']);
    const afterLost = [
      { surface_id: 'ac03-surf-x', op: 'created', code: null },
      { surface_id: 'ac03-surf-x', op: 'lost', code: null },
      { surface_id: 'ac03-surf-x', op: 'destroyed', code: null },
    ];
    rejectsWith(() => checkLifecycleTrace(afterLost), ['E2E_STATE']);
    const afterDestroyed = [
      { surface_id: 'ac03-surf-x', op: 'created', code: null },
      { surface_id: 'ac03-surf-x', op: 'destroyed', code: null },
      { surface_id: 'ac03-surf-x', op: 'lost', code: null },
    ];
    rejectsWith(() => checkLifecycleTrace(afterDestroyed), ['E2E_STATE']);
    const duplicateLost = [
      { surface_id: 'ac03-surf-x', op: 'created', code: null },
      { surface_id: 'ac03-surf-x', op: 'lost', code: null },
      { surface_id: 'ac03-surf-x', op: 'lost', code: null },
    ];
    rejectsWith(() => checkLifecycleTrace(duplicateLost), ['E2E_STATE']);
  });

  it('negative control: malformed trace rows are refused', () => {
    rejectsWith(() => checkLifecycleTrace('not-an-array'), ['E2E_TRACE']);
    rejectsWith(() => checkLifecycleTrace(
      [{ surface_id: 'ac03-surf-x', op: 'created', code: null, debug: true }]), ['E2E_TRACE']);
    rejectsWith(() => checkLifecycleTrace(
      [{ surface_id: 'ac03-surf-x', op: 'teleport', code: null }]), ['E2E_TRACE']);
    rejectsWith(() => checkLifecycleTrace(
      [{ surface_id: 'ac03-surf-x', op: 'error', code: null }]), ['E2E_TRACE']);
    rejectsWith(() => checkLifecycleTrace(
      [{ surface_id: 'ac03-surf-x', op: 'created', code: 'POLICY' }]), ['E2E_TRACE']);
    rejectsWith(() => checkLifecycleTrace(
      [{ surface_id: '', op: 'created', code: null }]), ['E2E_TRACE']);
  });

  it('negative control: catalog entry with an extra key is refused (closed object)', () => {
    const mutant = { ...validCatalogEntry('browser'), debug: true };
    rejectsWith(() => checkCatalogEntry(mutant), ['E2E_CATALOG']);
  });

  it('negative control: wrong catalog schema tag is refused', () => {
    const mutant = validCatalogEntry('browser');
    mutant.schema = 'catalog_entry/v9';
    rejectsWith(() => checkCatalogEntry(mutant), ['E2E_CATALOG']);
  });

  it('negative control: malformed catalog fields are refused', () => {
    for (const field of ['entry_id', 'profile_id']) {
      for (const bad of ['', 'has space', '-leading', 'x'.repeat(129)]) {
        const mutant = validCatalogEntry('browser');
        mutant[field] = bad;
        rejectsWith(() => checkCatalogEntry(mutant), ['E2E_CATALOG']);
      }
    }
    for (const field of ['label', 'image']) {
      const mutant = validCatalogEntry('browser');
      mutant[field] = '';
      rejectsWith(() => checkCatalogEntry(mutant), ['E2E_CATALOG']);
    }
    for (const field of ['window_width_px', 'window_height_px', 'display_width_px', 'display_height_px']) {
      for (const bad of [0, 16385, 1.5, '1280']) {
        const mutant = validCatalogEntry('browser');
        mutant[field] = bad;
        rejectsWith(() => checkCatalogEntry(mutant), ['E2E_CATALOG']);
      }
    }
    const badNetwork = validCatalogEntry('browser');
    badNetwork.network = 'direct';
    rejectsWith(() => checkCatalogEntry(badNetwork), ['E2E_CATALOG']);
    const badDepth = validCatalogEntry('browser');
    badDepth.nested_depth = 2;
    rejectsWith(() => checkCatalogEntry(badDepth), ['E2E_CATALOG']);
    const badLimits = validCatalogEntry('browser');
    badLimits.limits = { memory_bytes: 0, cpu_milli: 2000 };
    rejectsWith(() => checkCatalogEntry(badLimits), ['E2E_CATALOG']);
    const openLimits = validCatalogEntry('browser');
    openLimits.limits = { memory_bytes: 1024, cpu_milli: 2000, gpu: 1 };
    rejectsWith(() => checkCatalogEntry(openLimits), ['E2E_CATALOG']);
  });

  it('negative control: malformed surface_event.error rows are refused', () => {
    const valid = {
      schema: SURFACE_EVENT_SCHEMA,
      event: 'error',
      data: { surface_id: 'ac03-surf-ghost', code: 'POLICY', detail: 'UnknownKind' },
    };
    rejectsWith(() => checkSurfaceEventError({ ...valid, debug: true }), ['E2E_EVENT']);
    rejectsWith(() => checkSurfaceEventError({ ...valid, event: 'created' }), ['E2E_EVENT']);
    rejectsWith(() => checkSurfaceEventError({ ...valid, schema: 'surface_event/v9' }), ['E2E_EVENT']);
    rejectsWith(() => checkSurfaceEventError(
      { ...valid, data: { ...valid.data, detail: '' } }), ['E2E_EVENT']);
    rejectsWith(() => checkSurfaceEventError(
      { ...valid, data: { surface_id: 'ac03-surf-ghost', code: 'POLICY' } }), ['E2E_EVENT']);
    rejectsWith(() => checkSurfaceEventError(null), ['E2E_EVENT']);
  });
});

/** Four tile fakes across the harness surface kinds for the live wall boot. */
const AC03_FAKES = Object.freeze([
  { capsuleId: 'ac03-wall-a', kind: 'browser', w: 640, h: 400 },
  { capsuleId: 'ac03-wall-b', kind: 'desktop_capsule', w: 640, h: 400 },
  { capsuleId: 'ac03-wall-c', kind: 'game_capsule', w: 640, h: 400 },
  { capsuleId: 'ac03-wall-d', kind: 'vm', w: 640, h: 400 },
]);

/**
 * Rust driver exercising the real catalog authority: register one
 * entry per contract kind, create and destroy a surface of each,
 * prove tombstones, mark one surface lost, and emit the lifecycle
 * trace plus the typed error event for node-side validation.
 */
const LIFECYCLE_DRIVER = `
use metaviewer_core::catalog::*;

fn entry(kind: Kind, entry_id: &str, profile_id: &str, wh: u32) -> CatalogEntry {
    CatalogEntry::try_from(CatalogEntryWire {
        schema: "catalog_entry/v0.2".into(),
        entry_id: entry_id.into(),
        kind,
        profile_id: profile_id.into(),
        label: "AC03 lifecycle fixture".into(),
        image: "ac03-fixture-image".into(),
        window_width_px: 1280,
        window_height_px: wh,
        display_width_px: 1280,
        display_height_px: 900,
        display_only: false,
        network: Network::None,
        seccomp_identity: true,
        nested_depth: 0,
        limits: Limits { memory_bytes: 268435456, cpu_milli: 2000 },
    }).expect("fixture entry valid")
}

fn main() {
    let regs = vec![
        Registration::new(entry(Kind::Browser, "ac03-browser", "ac03-browser-profile", 720),
            LaunchTarget::Browser).expect("browser registration"),
        Registration::new(entry(Kind::Program, "ac03-program", "ac03-program-profile", 720),
            LaunchTarget::Program { program: "notepad".into() }).expect("program registration"),
        Registration::new(entry(Kind::Vm, "ac03-vm", "ac03-vm-profile", 720),
            LaunchTarget::Vm { program: "notepad-vm".into() }).expect("vm registration"),
        Registration::new(entry(Kind::GameCapsule, "ac03-holdings", "holdings-app-1", 900),
            LaunchTarget::Game { app_dir: "/app/holdings".into(), slots: 2 })
            .expect("game registration"),
        Registration::new(entry(Kind::DesktopCapsule, "ac03-desktop", "desktop-class-1", 720),
            LaunchTarget::Desktop { class: "ac03-class".into(), slot: 1 })
            .expect("desktop registration"),
    ];
    let mut registry = CatalogRegistry::new(regs).expect("registry");
    println!("REGISTRY:5");
    let cases = [
        ("browser", "ac03-browser-profile", 720u32),
        ("program", "ac03-program-profile", 720u32),
        ("vm", "ac03-vm-profile", 720u32),
        ("game_capsule", "holdings-app-1", 900u32),
        ("desktop_capsule", "desktop-class-1", 720u32),
    ];
    let mut trace: Vec<serde_json::Value> = Vec::new();
    for (kind, profile, height) in cases {
        let id = format!("ac03-surf-{kind}");
        let spec = registry.create(CreateRequest { surface_id: &id, kind,
            profile_id: profile, width_px: 1280, height_px: height, nested_depth: 0 })
            .expect("create");
        println!("BINARY:{kind}:{}", spec.binary);
        println!("STATE:{id}:{:?}", registry.state(&id).expect("live"));
        trace.push(serde_json::json!({"surface_id": id, "op": "created", "code": null}));
    }
    for (kind, _, _) in cases {
        let id = format!("ac03-surf-{kind}");
        registry.destroy(&id).expect("destroy");
        println!("DESTROY:{id}:{:?}", registry.state(&id).expect("terminal"));
        trace.push(serde_json::json!({"surface_id": id, "op": "destroyed", "code": null}));
    }
    for (kind, profile, height) in cases {
        let id = format!("ac03-surf-{kind}");
        let err = registry.create(CreateRequest { surface_id: &id, kind,
            profile_id: profile, width_px: 1280, height_px: height, nested_depth: 0 })
            .expect_err("revive must fail");
        println!("REVIVE:{id}:err:{err:?}");
    }
    let lost_id = "ac03-surf-lost";
    registry.create(CreateRequest { surface_id: lost_id, kind: "browser",
        profile_id: "ac03-browser-profile", width_px: 1280, height_px: 720, nested_depth: 0 })
        .expect("lost-path create");
    trace.push(serde_json::json!({"surface_id": lost_id, "op": "created", "code": null}));
    registry.mark_lost(lost_id).expect("mark lost");
    println!("STATE:{lost_id}:{:?}", registry.state(lost_id).expect("terminal"));
    trace.push(serde_json::json!({"surface_id": lost_id, "op": "lost", "code": null}));
    let err = registry.create(CreateRequest { surface_id: lost_id, kind: "browser",
        profile_id: "ac03-browser-profile", width_px: 1280, height_px: 720, nested_depth: 0 })
        .expect_err("lost revive must fail");
    println!("REVIVE:{lost_id}:err:{err:?}");
    let err = registry.validate_create(CreateRequest { surface_id: "ac03-surf-ghost",
        kind: "spaceship", profile_id: "ac03-browser-profile",
        width_px: 1280, height_px: 720, nested_depth: 0 }).expect_err("unknown kind");
    println!("UNKNOWN_KIND:err:{err:?}");
    trace.push(serde_json::json!({"surface_id": "ac03-surf-ghost",
        "op": "error", "code": format!("{err:?}")}));
    let err = registry.validate_create(CreateRequest { surface_id: "ac03-surf-ghost-2",
        kind: "browser", profile_id: "ghost-profile-9",
        width_px: 1280, height_px: 720, nested_depth: 0 }).expect_err("unknown profile");
    println!("UNREGISTERED_PROFILE:err:{err:?}");
    trace.push(serde_json::json!({"surface_id": "ac03-surf-ghost-2",
        "op": "error", "code": format!("{err:?}")}));
    let err = registry.validate_create(CreateRequest { surface_id: "ac03-surf-geo",
        kind: "browser", profile_id: "ac03-browser-profile",
        width_px: 640, height_px: 400, nested_depth: 0 }).expect_err("geometry");
    println!("GEOMETRY_MISMATCH:err:{err:?}");
    let err = registry.validate_create(CreateRequest { surface_id: "ac03-surf-depth",
        kind: "browser", profile_id: "ac03-browser-profile",
        width_px: 1280, height_px: 720, nested_depth: 1 }).expect_err("depth");
    println!("DEPTH_MISMATCH:err:{err:?}");
    let err = registry.destroy("ac03-surf-never-live").expect_err("destroy unknown");
    println!("DESTROY_UNKNOWN:err:{err:?}");
    let event = CatalogError::UnknownKind.surface_event("ac03-surf-ghost");
    println!("EVENT_JSON:{}", serde_json::to_string(&event).expect("event json"));
    println!("TRACE:{}", serde_json::to_string(&trace).expect("trace json"));
}
`;

describe('ac03 live lifecycle journey (Layer 2)', () => {
  it('authority creates and destroys every catalog kind with tombstones (AC-03)', () => {
    const scratch = makeScratch('mv0-ac03-live');
    try {
      const lines = runRust(scratch, LIFECYCLE_DRIVER).trim().split('\n');
      assert.equal(lines[0], 'REGISTRY:5');
      const binaries = {
        browser: 'srf-identity-surface',
        program: 'srf-identity-surface',
        vm: 'srf-identity-surface',
        game_capsule: 'srf-holdings-capsule',
        desktop_capsule: 'srf-capsula-desktop',
      };
      let index = 1;
      for (const [kind, binary] of Object.entries(binaries)) {
        assert.equal(lines[index], `BINARY:${kind}:${binary}`);
        assert.equal(lines[index + 1], `STATE:ac03-surf-${kind}:Live`);
        index += 2;
      }
      for (const kind of Object.keys(binaries)) {
        assert.equal(lines[index], `DESTROY:ac03-surf-${kind}:Destroyed`);
        index += 1;
      }
      for (const kind of Object.keys(binaries)) {
        assert.equal(lines[index], `REVIVE:ac03-surf-${kind}:err:SurfaceIdUsed`);
        index += 1;
      }
      assert.equal(lines[index], 'STATE:ac03-surf-lost:Lost');
      assert.equal(lines[index + 1], 'REVIVE:ac03-surf-lost:err:SurfaceIdUsed');
      assert.equal(lines[index + 2], 'UNKNOWN_KIND:err:UnknownKind');
      assert.equal(lines[index + 3], 'UNREGISTERED_PROFILE:err:UnregisteredProfile');
      assert.equal(lines[index + 4], 'GEOMETRY_MISMATCH:err:Geometry');
      assert.equal(lines[index + 5], 'DEPTH_MISMATCH:err:NestedDepth');
      assert.equal(lines[index + 6], 'DESTROY_UNKNOWN:err:SurfaceNotLive');
      const eventLine = lines[index + 7];
      assert.ok(eventLine.startsWith('EVENT_JSON:'), 'driver must emit the error event');
      const event = JSON.parse(eventLine.slice('EVENT_JSON:'.length));
      const checked = checkSurfaceEventError(event);
      assert.equal(checked.event, 'error');
      assert.equal(
        /** @type {Record<string, unknown>} */ (checked.data).surface_id, 'ac03-surf-ghost');
      const traceLine = lines[index + 8];
      assert.ok(traceLine.startsWith('TRACE:'), 'driver must emit the lifecycle trace');
      const summary = checkLifecycleTrace(JSON.parse(traceLine.slice('TRACE:'.length)));
      assert.equal(summary.created, 6);
      assert.equal(summary.destroyed, 5);
      assert.equal(summary.lost, 1);
      assert.equal(summary.errors, 2);
      assert.deepEqual(summary.live, []);
    } finally {
      removeScratch(scratch);
    }
  });

  it('wall fixture renders kind-covered tiles under xvfb (AC-03)', () => {
    require('./ac-harness.cjs').prepareWall();
    requireXvfb();
    const root = findRepoRoot(__dirname);
    const electron = electronBinary(root);
    const scratch = makeScratch('mv0-ac03-wall');
    try {
      const manifestPath = writeFakeManifest(scratch, AC03_FAKES);
      const reportPath = join(scratch, 'report.json');
      const mainEntry = join(root, 'tests', 'e2e', 'live-main.cjs');
      const mainUrl = require('node:url').pathToFileURL(mainEntry).href;
      writeProbeFile(scratch, {
        profile: join(scratch, 'profile'),
        mainUrl,
        manifestPath,
        reportPath,
      });
      const outcome = runUnderXvfb({
        electron,
        appDir: join(scratch, 'probe.cjs'),
        diagnosticsPath: join(scratch, 'electron-process.json'),
      });
      const diagnostic = JSON.stringify({
        ...outcome,
        stdout: outcome.stdout.slice(-2000),
        stderr: outcome.stderr.slice(-4000),
      });
      console.log(`E2E_PROCESS: ${diagnostic}`);
      let summary;
      try {
        summary = readProbeReport(reportPath, {
          frameOwners: new Map(
            AC03_FAKES.map(({ capsuleId }) => [`frame-${capsuleId}-gen7`, capsuleId]),
          ),
        });
      } catch (error) {
        if (!(error instanceof E2EError)) throw error;
        throw new E2EError(error.code,
          `${error.message} | report: ${(existsSync(reportPath)
            ? readFileSync(reportPath, 'utf8').slice(0, 3000) : 'absent')} | process: ${diagnostic}`);
      }
      assert.equal(outcome.timedOut, false, diagnostic);
      assert.equal(outcome.status, 0,
        `report errors: ${summary.errors.join(' | ').slice(0, 2000)} | process: ${diagnostic}`);
      assert.equal(summary.visible, 4);
      assert.ok(summary.tiles.every((tile) => tile.frameId !== null), 'every live tile needs a frame');
    } finally {
      removeScratch(scratch);
    }
  });

  it('external death is delivered through the PID guard (AC-03)', async () => {
    const root = findRepoRoot(__dirname);
    const scratch = makeScratch('mv0-ac03-pid-guard');
    const shmBase = process.env.MV_SHM_DIR || '/dev/shm';
    const ramRoot = mkdtempSync(join(shmBase, 'mv-ac03-'));
    chmodSync(ramRoot, 0o700);
    let server = null;
    let conn = null;
    let adapter = null;
    const spawnedPids = [];
    try {
      const adapterBin = process.env.MV_E2E_ADAPTER_BIN || join(scratch, 'mv-daemon-adapter');
      if (!process.env.MV_E2E_ADAPTER_BIN) {
        try {
          execFileSync(
            process.env.GO || 'go',
            ['build', '-o', adapterBin, './cmd/mv-daemon-adapter'],
            {
              cwd: join(root, 'daemon-adapter'),
              env: { ...process.env, GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' },
              stdio: 'pipe',
              timeout: 60000,
            },
          );
        } catch (error) {
          throw new E2EError('E2E_PREREQ', `failed to build mv-daemon-adapter: ${error.message}`);
        }
      }

      const rgb24 = Buffer.from([255, 0, 0, 0, 255, 0]);
      const digestHex = createHash('sha256').update(rgb24).digest('hex');
      const pngChunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length, 0);
        const typeBuf = Buffer.from(type, 'ascii');
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
        return Buffer.concat([len, typeBuf, data, crc]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(2, 0);
      ihdr.writeUInt32BE(1, 4);
      ihdr[8] = 8;
      ihdr[9] = 2;
      const idat = deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0]));
      const pngBytes = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', idat),
        pngChunk('IEND', Buffer.alloc(0)),
      ]);
      for (const profile of ['kill-target', 'destroyed-target']) {
        const frameDir = join(ramRoot, `run-${profile}`, 'frames', 'w1');
        mkdirSync(frameDir, { recursive: true, mode: 0o700 });
        chmodSync(join(ramRoot, `run-${profile}`), 0o700);
        chmodSync(join(ramRoot, `run-${profile}`, 'frames'), 0o700);
        chmodSync(frameDir, 0o700);
        const frameFile = join(frameDir, 'f.png');
        writeFileSync(frameFile, pngBytes, { mode: 0o600 });
        chmodSync(frameFile, 0o600);
      }

      const binDir = join(scratch, 'bin');
      const stateDir = join(scratch, 'state');
      const runtimeDir = join(scratch, 'runtime');
      const socketDir = join(runtimeDir, 'metaviewer');
      mkdirSync(binDir, { recursive: true, mode: 0o700 });
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      mkdirSync(socketDir, { recursive: true, mode: 0o700 });
      chmodSync(binDir, 0o700);
      chmodSync(stateDir, 0o700);
      chmodSync(runtimeDir, 0o700);
      chmodSync(socketDir, 0o700);

      const spawnCapsuleProcess = () => {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
          stdio: 'ignore',
          detached: true,
        });
        assert.ok(typeof child.pid === 'number');
        const pid = assertPid(child.pid);
        spawnedPids.push(pid);
        return { child, pid };
      };
      const killProc = spawnCapsuleProcess();
      const destroyedProc = spawnCapsuleProcess();
      writeFileSync(
        join(stateDir, 'pids.json'),
        JSON.stringify({
          'kill-target': killProc.pid,
          'destroyed-target': destroyedProc.pid,
        }),
        { mode: 0o600 },
      );

      const cliScript = `#!/usr/bin/env python3
import json, os, sys, time

op = sys.argv[1]
args = sys.argv[2:]
def flag(name):
    idx = args.index(name)
    return args[idx + 1]

state_dir = flag("--state-dir")

def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False

if op == "start":
    identity = flag("--identity")
    container = f"srf-id-{identity}"
    run_id = f"run-{identity}"
    with open(os.path.join(state_dir, "pids.json"), "r", encoding="utf-8") as fh:
        pids = json.load(fh)
    pid = int(pids[identity])
    if not pid_alive(pid):
        sys.exit(3)
    with open(os.path.join(state_dir, f"{container}.json"), "w", encoding="utf-8") as fh:
        json.dump({"pid": pid, "identity": identity, "run_id": run_id}, fh)
    print(json.dumps({
        "container": container,
        "run_id": run_id,
        "windows": [{"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1, "title": "fake", "url": ""}],
    }))
elif op == "frame":
    container = flag("--container")
    meta_path = os.path.join(state_dir, f"{container}.json")
    if not os.path.exists(meta_path):
        sys.exit(4)
    with open(meta_path, "r", encoding="utf-8") as fh:
        meta = json.load(fh)
    if not pid_alive(int(meta["pid"])):
        sys.exit(4)
    now = time.monotonic_ns()
    print(json.dumps({
        "path": os.path.join(${JSON.stringify(ramRoot)}, meta["run_id"], "frames", "w1", "f.png"),
        "seq": now,
        "sha256_rgb24": ${JSON.stringify(digestHex)},
        "width": 2,
        "height": 1,
        "capture_mono_ns": now,
        "generation": container,
        "window": {"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1, "title": "fake", "url": ""},
    }))
elif op == "input":
    container = flag("--container")
    with open(os.path.join(state_dir, "input.log"), "a", encoding="utf-8") as fh:
        fh.write(container + "\\n")
    print(json.dumps({
        "surface_id": "w1",
        "kind": "key",
        "input_mono_ns": time.monotonic_ns(),
        "focus_verified": True,
        "result": "ok",
    }))
elif op == "stop":
    container = flag("--container")
    print(json.dumps({"stopped": container, "removed_verified": True}))
else:
    sys.exit(2)
`;
      const cliPath = join(binDir, 'srf-identity-surface');
      writeFileSync(cliPath, cliScript, { mode: 0o700 });
      chmodSync(cliPath, 0o700);

      const socketPath = join(socketDir, 'core.sock');
      const inbox = [];
      let waiter = null;
      let rxBuf = '';
      const pushEnvelope = (env) => {
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve(env);
        } else {
          inbox.push(env);
        }
      };
      const nextEnvelope = (label = 'envelope', timeoutMs = 5000) => {
        if (inbox.length > 0) return Promise.resolve(inbox.shift());
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            waiter = null;
            reject(new E2EError('E2E_TIMEOUT', `timed out waiting for ${label} (seq=${daemonSeq}, stderr=${adapterStderr})`));
          }, timeoutMs);
          waiter = (env) => {
            clearTimeout(timer);
            resolve(env);
          };
        });
      };

      let adapterStderr = '';
      const connected = new Promise((resolve, reject) => {
        server = createServer((socket) => {
          conn = socket;
          socket.setEncoding('utf8');
          socket.on('error', () => {});
          socket.on('data', (chunk) => {
            rxBuf += chunk;
            let idx = rxBuf.indexOf('\n');
            while (idx !== -1) {
              const line = rxBuf.slice(0, idx);
              rxBuf = rxBuf.slice(idx + 1);
              if (line.length > 0) pushEnvelope(JSON.parse(line));
              idx = rxBuf.indexOf('\n');
            }
          });
          resolve(socket);
        });
        server.on('error', reject);
      });
      await new Promise((resolve) => server.listen(socketPath, resolve));
      chmodSync(socketPath, 0o600);

      const profiles = JSON.stringify({
        'kill-target': {
          Kind: 'browser',
          NativeKind: 'browser',
          RAMRoot: ramRoot,
          Display: ':100',
          Width: 2,
          Height: 1,
        },
        'destroyed-target': {
          Kind: 'browser',
          NativeKind: 'browser',
          RAMRoot: ramRoot,
          Display: ':100',
          Width: 2,
          Height: 1,
        },
      });
      const commit = 'f8f9294fc70a423164d63f2cf6e5de65ec6f6516';
      adapter = spawn(adapterBin, [], {
        cwd: root,
        env: {
          ...process.env,
          MV_SESSION_ID: 'ac03-pid-session',
          MV_CORE_INSTANCE: 'core-ac03',
          MV_DAEMON_INSTANCE: 'daemon-ac03',
          MV_SRF_BIN_DIR: binDir,
          MV_SRF_STATE_DIR: stateDir,
          MV_SRF_PROFILES: profiles,
          MV_SRF_LIVE_RAM_ROOT: ramRoot,
          MV_SRF_LIVE_PROFILE: 'kill-target',
          SRF_IDENTITY_STORE_ROOT: ramRoot,
          SRF_PROXY_REGISTRY: join(ramRoot, 'proxies.json'),
          XDG_RUNTIME_DIR: runtimeDir,
          MV_CONTRACT_DIR: join(root, 'contracts', 'v0.2'),
          MV_COMPONENT_COMMIT: commit,
          MV_LIVENESS_INTERVAL: '25ms',
          MV_LIVENESS_MISSES: '2',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      adapter.stderr.setEncoding('utf8');
      adapter.stderr.on('data', (chunk) => {
        adapterStderr += chunk;
      });
      adapter.stdout.setEncoding('utf8');
      adapter.stdout.on('data', (chunk) => {
        adapterStderr += chunk;
      });

      await connected;
      let coreSeq = 0;
      let daemonSeq = 0;
      const sendCore = (body) => {
        coreSeq += 1;
        const env = {
          schema: 'envelope/v0.2',
          msg_id: `core-${coreSeq}`,
          ts_ns: 0,
          from: { component: 'core', instance: 'core-ac03' },
          to: { component: 'daemon', instance: 'daemon-ac03' },
          session_id: 'ac03-pid-session',
          seq: coreSeq,
          nonce: `core-${coreSeq}`,
          body,
        };
        conn.write(`${JSON.stringify(env)}\n`);
      };
      const readDaemon = async (label = 'envelope', timeoutMs = 5000) => {
        const env = await nextEnvelope(label, timeoutMs);
        daemonSeq += 1;
        assert.equal(env.schema, 'envelope/v0.2');
        assert.equal(env.seq, daemonSeq);
        assert.equal(env.from.component, 'daemon');
        assert.equal(env.to.component, 'core');
        return env.body;
      };
      const sendRequest = (op, params) => {
        sendCore({ schema: 'surface_request/v0.2', op, params });
      };

      const daemonHello = await readDaemon();
      assert.equal(daemonHello.schema, 'hello/v0.2');
      assert.equal(daemonHello.component, 'daemon');
      sendCore({
        schema: 'hello/v0.2',
        contract_version: 'v0.2',
        component: 'core',
        component_version: '0.1.1',
        component_commit: commit,
        dependencies: [],
      });

      const trace = [];
      sendRequest('create', { kind: 'browser', profile_id: 'kill-target', geometry: { w: 2, h: 1 } });
      const createdKill = await readDaemon();
      assert.equal(createdKill.event, 'created');
      const idKill = createdKill.data.surface.surface_id;
      trace.push({ surface_id: idKill, op: 'created', code: null });
      const initialFrameKill = await readDaemon();
      assert.equal(initialFrameKill.event, 'frame_ready');

      sendRequest('create', { kind: 'browser', profile_id: 'destroyed-target', geometry: { w: 2, h: 1 } });
      const createdDestroyed = await readDaemon();
      assert.equal(createdDestroyed.event, 'created');
      const idDestroyed = createdDestroyed.data.surface.surface_id;
      trace.push({ surface_id: idDestroyed, op: 'created', code: null });
      const initialFrameDestroyed = await readDaemon();
      assert.equal(initialFrameDestroyed.event, 'frame_ready');

      const killMeta = JSON.parse(readFileSync(join(stateDir, 'srf-id-kill-target.json'), 'utf8'));
      const destroyedMeta = JSON.parse(readFileSync(join(stateDir, 'srf-id-destroyed-target.json'), 'utf8'));
      const pidKill = assertPid(killMeta.pid);
      const pidDestroyed = assertPid(destroyedMeta.pid);
      spawnedPids.push(pidKill, pidDestroyed);

      sendRequest('destroy', { surface_id: idDestroyed });
      const destroyedEvent = await readDaemon();
      assert.equal(destroyedEvent.event, 'state_changed');
      assert.equal(destroyedEvent.data.surface.surface_id, idDestroyed);
      assert.equal(destroyedEvent.data.surface.state, 'destroyed');
      trace.push({ surface_id: idDestroyed, op: 'destroyed', code: null });

      // Negative control: kill the already-destroyed surface's external process first,
      // then kill the active surface's external process through the harness PID guard.
      const killExited = new Promise((done) => killProc.child.on('exit', () => done(true)));
      const destroyedExited = new Promise((done) => destroyedProc.child.on('exit', () => done(true)));
      await terminate(pidDestroyed, { waitMs: 2000 });
      await terminate(pidKill, { waitMs: 2000 });
      assert.equal(await destroyedExited, true);
      assert.equal(await killExited, true);

      const lostEvents = [];
      const destroyedLostEvents = [];
      const firstAfterKill = await readDaemon('lost-event', 5000);
      assert.equal(firstAfterKill.schema, SURFACE_EVENT_SCHEMA);
      assert.equal(firstAfterKill.event, 'state_changed');
      assert.equal(firstAfterKill.data.surface.surface_id, idKill);
      assert.equal(firstAfterKill.data.surface.state, 'lost');
      lostEvents.push(firstAfterKill.data.surface.surface_id);
      trace.push({ surface_id: idKill, op: 'lost', code: null });

      // Wait 6 liveness intervals (150ms) so any duplicate lost on idKill or
      // spurious lost on the already-destroyed idDestroyed would be emitted.
      await new Promise((wake) => setTimeout(wake, 150));

      sendRequest('input', {
        surface_id: idKill,
        proposal_id: 'ac03-lost-input',
        action: { type: 'key', keys: ['Escape'] },
      });
      sendRequest('frame_subscribe', { surface_id: idKill });
      sendRequest('frame_subscribe', { surface_id: idDestroyed });

      let postLossInputRefused = false;
      let postLossCaptureRefused = false;
      let destroyedCaptureRefused = false;
      for (let i = 0; i < 3; i += 1) {
        const msg = await readDaemon('post-loss-reply', 5000);
        if (msg.schema === SURFACE_EVENT_SCHEMA && msg.event === 'state_changed' && msg.data.surface.state === 'lost') {
          if (msg.data.surface.surface_id === idDestroyed) {
            destroyedLostEvents.push(msg.data.surface.surface_id);
          } else {
            lostEvents.push(msg.data.surface.surface_id);
          }
          trace.push({ surface_id: msg.data.surface.surface_id, op: 'lost', code: null });
        } else if (msg.schema === 'action_receipt/v0.2') {
          assert.equal(msg.proposal_id, 'ac03-lost-input');
          assert.equal(msg.verified, false);
          assert.ok(typeof msg.error === 'string' && msg.error.startsWith('input failed:'));
          postLossInputRefused = true;
        } else if (msg.schema === SURFACE_EVENT_SCHEMA && msg.event === 'error') {
          const checked = checkSurfaceEventError(msg);
          trace.push({ surface_id: checked.data.surface_id, op: 'error', code: checked.data.code });
          if (checked.data.surface_id === idKill) postLossCaptureRefused = true;
          if (checked.data.surface_id === idDestroyed) destroyedCaptureRefused = true;
        } else {
          assert.fail(`unexpected daemon message after loss: ${JSON.stringify(msg)}`);
        }
      }
      for (const queued of inbox) {
        const body = queued.body;
        if (body && body.schema === SURFACE_EVENT_SCHEMA && body.event === 'state_changed' && body.data.surface.state === 'lost') {
          if (body.data.surface.surface_id === idDestroyed) {
            destroyedLostEvents.push(body.data.surface.surface_id);
          } else {
            lostEvents.push(body.data.surface.surface_id);
          }
        }
      }

      assert.equal(existsSync(join(stateDir, 'input.log')), false, 'lost surface input must not reach native CLI');
      assert.equal(lostEvents.length, 1, 'adapter must emit exactly one lost event for externally killed active capsule');
      assert.equal(destroyedLostEvents.length, 0, 'already-destroyed capsule must not emit lost');
      assert.equal(postLossInputRefused, true, 'input on lost surface must be refused');
      assert.equal(postLossCaptureRefused, true, 'capture on lost surface must be refused');
      assert.equal(destroyedCaptureRefused, true, 'capture on destroyed surface must be refused');
      const summary = checkLifecycleTrace(trace);
      assert.equal(summary.created, 2);
      assert.equal(summary.destroyed, 1);
      assert.equal(summary.lost, 1);
      assert.equal(summary.errors, 2);
      assert.deepEqual(summary.live, []);
    } finally {
      if (conn) conn.destroy();
      if (server) server.close();
      if (adapter && adapter.exitCode === null) {
        adapter.kill('SIGKILL');
        await new Promise((wake) => adapter.once('exit', wake));
      }
      for (const pid of spawnedPids) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
      }
      rmSync(ramRoot, { recursive: true, force: true });
      removeScratch(scratch);
    }
  });
});
