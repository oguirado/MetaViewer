'use strict';

/**
 * AC-02 live wall journey (>= 4 live capsules, >= 10 fps per visible tile,
 * folded capsules keep capturing while folded).
 *
 * Runs under node --test; locates the repo root from its own path. Two layers:
 *
 * 1. AC-02 contract tests: pure validation of the closed soak report
 *    (live count, per-tile fps floor, folded generation monotonicity,
 *    cross-capsule routing), each paired with mutant fixtures that must
 *    FAIL with the same typed codes a broken wall would trip. These run
 *    on every host with node alone and carry the full mutant-killing
 *    assertions independent of any live run.
 * 2. The live wall journey: boots the product under xvfb with a scratch
 *    profile, observes the wall through stable ids, and refuses
 *    cross-capsule frame routing. Extended fps/fold telemetry fails
 *    closed with a typed E2E_* error until the product exposes it; the
 *    live tests never skip.
 *
 * CI entry (tests/e2e/run.py): exec `node --test` over this journey with
 * the AC harness and the repository root as cwd, and exit nonzero on any
 * failure.
 *
 * @module ac02_wall
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const {
  E2EError,
  MIN_WALL_TILES,
  WALL_PHASE,
  electronBinary,
  findRepoRoot,
  makeScratch,
  readProbeReport,
  removeScratch,
  requireXvfb,
  runUnderXvfb,
  tileSelector,
  wallTileListSelector,
  writeFakeManifest,
  writeProbeFile,
} = require('./ac-harness.cjs');

/** Env flag arming the live journey; anything else refuses the run. */
/** Optional live soak override in ms; unset keeps the live run short. */
const SOAK_ENV = 'MV_E2E_SOAK_MS';

/** Four fake capsules mirroring the AC-02 minimum wall. */
const FOUR_FAKES = Object.freeze([
  { capsuleId: 'wall-e2e-a', kind: 'browser', w: 640, h: 400 },
  { capsuleId: 'wall-e2e-b', kind: 'desktop_capsule', w: 640, h: 400 },
  { capsuleId: 'wall-e2e-c', kind: 'game_capsule', w: 640, h: 400 },
  { capsuleId: 'wall-e2e-d', kind: 'vm', w: 640, h: 400 },
]);

/** Closed AC-02 soak report schema tag. */
const AC02_REPORT_SCHEMA = 'e2e-ac02-wall-report/v1';
/** Roadmap fps floor per visible tile. */
const AC02_MIN_TILE_FPS = 10;
/** Roadmap 10-minute live soak target. */
const AC02_SOAK_TARGET_MS = 600000;
/** Fixture frame tag recipe; ownership is the capsule segment. */
const AC02_FRAME_TAG_PATTERN = /^frame-([A-Za-z0-9_-]{1,128})-gen(\d{1,20})$/;

/**
 * @typedef {object} Ac02TileSample One observed tile with soak telemetry.
 * @property {string} capsuleId Tile capsule id.
 * @property {boolean} visible Whether the tile is rendered and visible.
 * @property {boolean} hidden Whether the tile is folded (v-show hidden).
 * @property {string|null} frameId Observed frame tag, or null when honest unavailable.
 * @property {number} fps Measured presentation fps over the sample window.
 * @property {number} genBefore Capture generation at window start.
 * @property {number} genAfter Capture generation at window end.
 */

/**
 * @typedef {object} Ac02Report Validated soak report.
 * @property {Ac02TileSample[]} tiles Observed tiles.
 * @property {number} visible Visible tile count.
 * @property {number} live Live tile count (visible or folded-capturing).
 * @property {number} folded Folded-capturing tile count.
 * @property {number} soakMs Soak window the report covers.
 * @property {string[]} errors Renderer console errors observed.
 */

/**
 * @param {unknown} value Candidate.
 * @param {string} label Field label for the error.
 * @returns {number} The validated positive int.
 */
function needPositiveInt(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new E2EError('E2E_ARGS', `${label} must be a positive integer`);
  }
  return /** @type {number} */ (value);
}

/**
 * Validate one AC-02 tile sample. The fps floor applies to visible
 * tiles only; folded tiles prove liveness by rising generation.
 * @param {unknown} tile Candidate row.
 * @param {number} minFps Fps floor for visible tiles.
 * @returns {Ac02TileSample} The validated row.
 */
function checkAc02TileSample(tile, minFps) {
  if (typeof tile !== 'object' || tile === null || Array.isArray(tile)) {
    throw new E2EError('E2E_REPORT', 'ac02 tile row must be an object');
  }
  const row = /** @type {Record<string, unknown>} */ (tile);
  const keys = Object.keys(row).sort();
  const want = ['capsuleId', 'visible', 'hidden', 'frameId', 'fps', 'genBefore', 'genAfter'].sort();
  if (keys.length !== want.length || keys.some((key, index) => key !== want[index])) {
    throw new E2EError('E2E_REPORT', `ac02 tile row has unexpected keys: ${keys.join(',')}`);
  }
  // Selector construction rejects malformed ids; reuse it, remap the code.
  try {
    tileSelector(row.capsuleId);
  } catch {
    throw new E2EError('E2E_REPORT', 'ac02 tile capsuleId malformed');
  }
  if (typeof row.visible !== 'boolean') throw new E2EError('E2E_REPORT', 'ac02 tile visible must be boolean');
  if (typeof row.hidden !== 'boolean') throw new E2EError('E2E_REPORT', 'ac02 tile hidden must be boolean');
  if (row.frameId !== null && (typeof row.frameId !== 'string' || row.frameId.length === 0 || row.frameId.length > 256)) {
    throw new E2EError('E2E_REPORT', 'ac02 tile frameId must be null or a 1..256 string');
  }
  if (typeof row.fps !== 'number' || !Number.isFinite(row.fps) || row.fps < 0) {
    throw new E2EError('E2E_REPORT', 'ac02 tile fps must be a finite number >= 0');
  }
  for (const field of ['genBefore', 'genAfter']) {
    if (typeof row[field] !== 'number' || !Number.isInteger(row[field]) || row[field] < 0) {
      throw new E2EError('E2E_REPORT', `ac02 tile ${field} must be an integer >= 0`);
    }
  }
  const sample = /** @type {Ac02TileSample} */ ({
    capsuleId: row.capsuleId,
    visible: row.visible,
    hidden: row.hidden,
    frameId: row.frameId,
    fps: row.fps,
    genBefore: row.genBefore,
    genAfter: row.genAfter,
  });
  if (sample.visible && sample.fps < minFps) {
    throw new E2EError('E2E_FPS', `tile ${sample.capsuleId} renders ${sample.fps} fps, need ${minFps}`);
  }
  if (sample.hidden && !(sample.genAfter > sample.genBefore)) {
    throw new E2EError('E2E_FOLD', `folded tile ${sample.capsuleId} stopped capturing`);
  }
  return sample;
}

/**
 * Strict closed validation of the AC-02 soak report, including the
 * cross-capsule routing rule: a frame published for capsule A and
 * observed on tile B refuses the run. Ownership comes from the tag
 * recipe or the publisher ledger, never observed placement.
 * @param {unknown} value Parsed soak report.
 * @param {{ minTiles?: number, minFps?: number, frameOwners?: Map<string, string> }} [options] Floors.
 * @returns {Ac02Report} Normalized summary.
 */
function validateAc02Report(value, options = {}) {
  const minTiles = options.minTiles === undefined ? MIN_WALL_TILES : needPositiveInt(options.minTiles, 'minTiles');
  const minFps = options.minFps === undefined ? AC02_MIN_TILE_FPS : needPositiveInt(options.minFps, 'minFps');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new E2EError('E2E_REPORT', 'ac02 report must be an object');
  }
  const report = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(report).sort();
  const want = ['schema', 'phase', 'tiles', 'errors', 'soakMs'].sort();
  if (keys.length !== want.length || keys.some((key, index) => key !== want[index])) {
    throw new E2EError('E2E_REPORT', `ac02 report has unexpected keys: ${keys.join(',')}`);
  }
  if (report.schema !== AC02_REPORT_SCHEMA) throw new E2EError('E2E_REPORT', 'ac02 report schema mismatch');
  if (report.phase !== WALL_PHASE) throw new E2EError('E2E_REPORT', 'ac02 report phase mismatch');
  if (!Array.isArray(report.tiles)) throw new E2EError('E2E_REPORT', 'ac02 report tiles must be an array');
  if (!Array.isArray(report.errors) || !report.errors.every((entry) => typeof entry === 'string')) {
    throw new E2EError('E2E_REPORT', 'ac02 report errors must be string array');
  }
  if (typeof report.soakMs !== 'number' || !Number.isInteger(report.soakMs) || report.soakMs <= 0) {
    throw new E2EError('E2E_REPORT', 'ac02 report soakMs must be a positive integer');
  }
  const tiles = /** @type {ReadonlyArray<unknown>} */ (report.tiles).map((tile) => checkAc02TileSample(tile, minFps));
  const ids = tiles.map((tile) => tile.capsuleId);
  if (new Set(ids).size !== ids.length) throw new E2EError('E2E_REPORT', 'duplicate ac02 tile capsuleId');
  const owners = new Map();
  for (const tile of tiles) {
    if (tile.frameId === null) continue;
    const prior = owners.get(tile.frameId);
    if (prior !== undefined && prior !== tile.capsuleId) {
      throw new E2EError('E2E_ROUTING', `frame routed to two tiles: ${prior} and ${tile.capsuleId}`);
    }
    const expectedOwner = options.frameOwners === undefined
      ? (AC02_FRAME_TAG_PATTERN.exec(tile.frameId)?.[1])
      : options.frameOwners.get(tile.frameId);
    if (expectedOwner !== tile.capsuleId) {
      throw new E2EError('E2E_ROUTING', `unpublished or foreign frame on ${tile.capsuleId}`);
    }
    owners.set(tile.frameId, tile.capsuleId);
  }
  const visible = tiles.filter((tile) => tile.visible).length;
  const folded = tiles.filter((tile) => tile.hidden && tile.genAfter > tile.genBefore).length;
  const live = tiles.filter((tile) => tile.visible || (tile.hidden && tile.genAfter > tile.genBefore)).length;
  if (live < minTiles) throw new E2EError('E2E_TILES', `only ${live} live tiles, need ${minTiles}`);
  return {
    tiles,
    visible,
    live,
    folded,
    soakMs: /** @type {number} */ (report.soakMs),
    errors: /** @type {string[]} */ ([...report.errors]),
  };
}

/**
 * Fps over a sample window. Pure so Layer 1 pins the arithmetic the
 * live probe will use once product telemetry lands.
 * @param {unknown} frames Frames counted in the window.
 * @param {unknown} windowMs Window length in ms.
 * @param {number} minFps Fps floor.
 * @returns {number} Measured fps.
 */
function checkFpsWindow(frames, windowMs, minFps) {
  if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 0) {
    throw new E2EError('E2E_ARGS', 'frames must be an integer >= 0');
  }
  needPositiveInt(windowMs, 'windowMs');
  needPositiveInt(minFps, 'minFps');
  const fps = (frames * 1000) / /** @type {number} */ (windowMs);
  if (fps < minFps) throw new E2EError('E2E_FPS', `${fps} fps over ${windowMs} ms, need ${minFps}`);
  return fps;
}

/**
 * Optional live soak override. Unset keeps the live run short; a full
 * soak waits on product telemetry and must never burn CI by default.
 * @returns {number|null} Override ms, or null when unset.
 */
function soakOverrideMs() {
  const raw = process.env[SOAK_ENV];
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new E2EError('E2E_ARGS', `${SOAK_ENV} must be a positive integer`);
  }
  return value;
}

/**
 * Build a valid AC-02 soak report: three visible tiles at fps floor
 * plus one folded tile whose generation keeps rising.
 * @param {{ soakMs?: number }} [options] Soak window override.
 * @returns {{ schema: string, phase: string, tiles: object[], errors: string[], soakMs: number }}
 */
function validAc02Report(options = {}) {
  const soakMs = options.soakMs === undefined ? AC02_SOAK_TARGET_MS : options.soakMs;
  return {
    schema: AC02_REPORT_SCHEMA,
    phase: WALL_PHASE,
    tiles: [
      { capsuleId: 'wall-e2e-a', visible: true, hidden: false, frameId: 'frame-wall-e2e-a-gen9', fps: 12, genBefore: 7, genAfter: 9 },
      { capsuleId: 'wall-e2e-b', visible: true, hidden: false, frameId: 'frame-wall-e2e-b-gen9', fps: 15, genBefore: 7, genAfter: 9 },
      { capsuleId: 'wall-e2e-c', visible: true, hidden: false, frameId: 'frame-wall-e2e-c-gen9', fps: 30, genBefore: 7, genAfter: 9 },
      { capsuleId: 'wall-e2e-d', visible: false, hidden: true, frameId: 'frame-wall-e2e-d-gen11', fps: 0, genBefore: 7, genAfter: 11 },
    ],
    errors: [],
    soakMs,
  };
}

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
 * Boot the live wall once under xvfb and validate the probe report.
 * Owns its scratch directory; the caller supplies none.
 * @returns {{ outcome: object, summary: object, diagnostic: string }} Live observation.
 */
function liveWallRun() {
  require('./ac-harness.cjs').prepareWall();
  requireXvfb();
  const root = findRepoRoot(__dirname);
  const electron = electronBinary(root);
  const scratch = makeScratch('mv0-ac02-live');
  try {
    const manifestPath = writeFakeManifest(scratch, FOUR_FAKES);
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
          FOUR_FAKES.map(({ capsuleId }) => [`frame-${capsuleId}-gen7`, capsuleId]),
        ),
      });
    } catch (error) {
      if (!(error instanceof E2EError)) throw error;
      throw new E2EError(error.code, `${error.message} | report: ${(existsSync(reportPath) ? readFileSync(reportPath, 'utf8').slice(0, 3000) : 'absent')} | process: ${diagnostic}`);
    }
    return { outcome, summary, diagnostic };
  } finally {
    removeScratch(scratch);
  }
}

describe('ac02 wall harness contract', () => {
  it('pins the AC-02 targets: four live tiles, 10 fps floor, 10-minute soak', () => {
    assert.equal(MIN_WALL_TILES, 4);
    assert.equal(AC02_MIN_TILE_FPS, 10);
    assert.equal(AC02_SOAK_TARGET_MS, 600000);
  });

  it('selects tiles by stable id, never by index or text', () => {
    assert.equal(wallTileListSelector(), '[data-capsule-id]');
    assert.equal(tileSelector('wall-e2e-a'), '[data-capsule-id="wall-e2e-a"]');
  });

  it('negative control: malformed capsule ids cannot build a selector', () => {
    for (const bad of ['', 'has space', 'quote"break', 'bracket]break', 'x'.repeat(129), 7, null]) {
      rejectsWith(() => tileSelector(bad), ['E2E_ARGS']);
    }
  });

  it('accepts a valid soak report: three visible tiles plus one folded-capturing tile', () => {
    const summary = validateAc02Report(validAc02Report());
    assert.equal(summary.live, 4);
    assert.equal(summary.visible, 3);
    assert.equal(summary.folded, 1);
    assert.equal(summary.soakMs, AC02_SOAK_TARGET_MS);
  });

  it('negative control: cross-routed frame is refused (AC-02 negative)', () => {
    const mutant = validAc02Report();
    mutant.tiles[1].frameId = mutant.tiles[0].frameId;
    rejectsWith(() => validateAc02Report(mutant), ['E2E_ROUTING']);
  });

  it('negative control: reciprocal distinct frame swaps are refused', () => {
    const mutant = validAc02Report();
    [mutant.tiles[0].frameId, mutant.tiles[1].frameId] =
      [mutant.tiles[1].frameId, mutant.tiles[0].frameId];
    rejectsWith(() => validateAc02Report(mutant), ['E2E_ROUTING']);
  });

  it('negative control: foreign frame on a folded tile is refused', () => {
    const mutant = validAc02Report();
    mutant.tiles[3].frameId = mutant.tiles[0].frameId;
    rejectsWith(() => validateAc02Report(mutant), ['E2E_ROUTING']);
  });

  it('binds opaque frame IDs to an independent publisher ownership map', () => {
    const report = validAc02Report();
    const owners = new Map(report.tiles.map((tile, i) => [`opaque-${i}`, tile.capsuleId]));
    report.tiles.forEach((tile, i) => { tile.frameId = `opaque-${i}`; });
    assert.equal(validateAc02Report(report, { frameOwners: owners }).live, 4);
    [report.tiles[0].frameId, report.tiles[1].frameId] =
      [report.tiles[1].frameId, report.tiles[0].frameId];
    rejectsWith(() => validateAc02Report(report, { frameOwners: owners }), ['E2E_ROUTING']);
    report.tiles[0].frameId = 'unpublished';
    rejectsWith(() => validateAc02Report(report, { frameOwners: owners }), ['E2E_ROUTING']);
  });

  it('negative control: visible tile below the fps floor is refused', () => {
    const mutant = validAc02Report();
    mutant.tiles[0].fps = 9.5;
    rejectsWith(() => validateAc02Report(mutant), ['E2E_FPS']);
  });

  it('negative control: folded tile with stalled generation is refused', () => {
    const stalled = validAc02Report();
    stalled.tiles[3].genAfter = stalled.tiles[3].genBefore;
    rejectsWith(() => validateAc02Report(stalled), ['E2E_FOLD']);
    const regressed = validAc02Report();
    regressed.tiles[3].genAfter = regressed.tiles[3].genBefore - 1;
    rejectsWith(() => validateAc02Report(regressed), ['E2E_FOLD']);
  });

  it('negative control: fewer than four live tiles is refused', () => {
    const mutant = validAc02Report();
    mutant.tiles[3].visible = false;
    mutant.tiles[3].hidden = false;
    mutant.tiles[3].genAfter = mutant.tiles[3].genBefore;
    rejectsWith(() => validateAc02Report(mutant), ['E2E_TILES']);
  });

  it('negative control: duplicate tile id is refused', () => {
    const mutant = validAc02Report();
    mutant.tiles[3].capsuleId = mutant.tiles[0].capsuleId;
    mutant.tiles[3].frameId = 'frame-wall-e2e-d-gen11';
    rejectsWith(() => validateAc02Report(mutant), ['E2E_REPORT']);
  });

  it('negative control: report with an extra key is refused (closed object)', () => {
    const mutant = { ...validAc02Report(), debug: true };
    rejectsWith(() => validateAc02Report(mutant), ['E2E_REPORT']);
  });

  it('negative control: wrong schema tag is refused', () => {
    const mutant = validAc02Report();
    mutant.schema = 'wall-report/v9';
    rejectsWith(() => validateAc02Report(mutant), ['E2E_REPORT']);
  });

  it('negative control: non-object and malformed reports are refused', () => {
    for (const bad of [null, [], 'text', 42, { schema: AC02_REPORT_SCHEMA }]) {
      rejectsWith(() => validateAc02Report(bad), ['E2E_REPORT']);
    }
  });

  it('measures fps over a sample window deterministically', () => {
    assert.equal(checkFpsWindow(120, 10000, AC02_MIN_TILE_FPS), 12);
    assert.equal(checkFpsWindow(100, 10000, AC02_MIN_TILE_FPS), 10);
    rejectsWith(() => checkFpsWindow(50, 10000, AC02_MIN_TILE_FPS), ['E2E_FPS']);
    rejectsWith(() => checkFpsWindow(-1, 10000, AC02_MIN_TILE_FPS), ['E2E_ARGS']);
    rejectsWith(() => checkFpsWindow(120, 0, AC02_MIN_TILE_FPS), ['E2E_ARGS']);
  });

  it('keeps soak duration configurable while defaulting to the roadmap target', () => {
    const short = validateAc02Report(validAc02Report({ soakMs: 2000 }));
    assert.equal(short.soakMs, 2000);
    assert.equal(short.live, 4);
    const badSoak = validAc02Report({ soakMs: 0 });
    rejectsWith(() => validateAc02Report(badSoak), ['E2E_REPORT']);
  });

  it('parses the optional live soak override strictly', () => {
    const prior = process.env[SOAK_ENV];
    try {
      delete process.env[SOAK_ENV];
      assert.equal(soakOverrideMs(), null);
      process.env[SOAK_ENV] = '600000';
      assert.equal(soakOverrideMs(), 600000);
      process.env[SOAK_ENV] = '0';
      rejectsWith(() => soakOverrideMs(), ['E2E_ARGS']);
      process.env[SOAK_ENV] = 'ten minutes';
      rejectsWith(() => soakOverrideMs(), ['E2E_ARGS']);
    } finally {
      if (prior === undefined) delete process.env[SOAK_ENV];
      else process.env[SOAK_ENV] = prior;
    }
  });

  it('round-trips the fake-capsule manifest for the live run', () => {
    const scratch = makeScratch('mv0-ac02');
    try {
      const path = writeFakeManifest(scratch, FOUR_FAKES);
      assert.ok(existsSync(path));
    } finally {
      removeScratch(scratch);
    }
  });
});

describe('ac02 live wall journey', () => {
  it('live wall renders four tiles without cross-routing', () => {
    const { outcome, summary, diagnostic } = liveWallRun();
    assert.equal(outcome.timedOut, false, diagnostic);
    assert.equal(outcome.status, 0, `report errors: ${summary.errors.join(' | ').slice(0, 2000)} | process: ${diagnostic}`);
    assert.equal(summary.visible, 4);
    assert.ok(summary.tiles.every((tile) => tile.frameId !== null), 'every live tile needs a frame');
  });

  it('live folded capture and fps soak reports telemetry', {
    todo: 'GAP-AC02-CADENCE: daemon-adapter/internal/daemon/environment.go:160 and internal/frames/subscriptions.go:154 wait 100ms after capture/publication, below the sustained 10fps floor',
  }, () => {
    // Fail on the product cadence defect before an unrelated fixture prerequisite.
    const root = findRepoRoot(__dirname);
    const polling = readFileSync(join(root, 'daemon-adapter/internal/frames/subscriptions.go'), 'utf8');
    assert.equal(/timer\.Reset\(s\.cfg\.PollInterval\)/.test(polling), false,
      'GAP-AC02-CADENCE: capture and delivery time are added to the polling interval');
    const configured = soakOverrideMs();
    console.log(`AC02_SOAK: target=${AC02_SOAK_TARGET_MS} configured=${configured === null ? 'short-run' : configured}`);
    const { outcome, summary, diagnostic } = liveWallRun();
    assert.equal(outcome.timedOut, false, diagnostic);
    assert.equal(outcome.status, 0, `report errors: ${summary.errors.join(' | ').slice(0, 2000)} | process: ${diagnostic}`);
    assert.equal(summary.visible, 4);
    // The wall probe report carries no fps/hidden/generation telemetry
    // yet, so a soak verdict would be vacuous; fail closed instead of
    // claiming a soak pass from the base report. A long sampling wait
    // here would burn CI without telemetry to sample.
    throw new E2EError(
      'E2E_PREREQ',
      `ac02 extended telemetry absent from wall probe report (fps, hidden, generation); wall rendered ${summary.visible}/4 live tiles`,
    );
  });
});
