'use strict';

/**
 * E2E harness for the MetaViewer wall journey (G-E2E).
 *
 * Owns the Electron-under-xvfb spawn, the scratch profile layout, the
 * fake-capsule manifest fixture, the serialized probe, and the strict
 * closed validation of the probe report. The CI e2e job (see
 * .github/workflows/ci.yml, job e2e) executes tests/e2e/run.py; that entry
 * is ABSENT and unowned, and must exec node --test over this directory.
 *
 * Patterns reused from the Holdings live shell suite (reference only):
 * serialized probe file run by the Electron binary under xvfb with a fixed
 * 1280x900 screen, stable-id queries, sendInputEvent for input, a bounded
 * watchdog, and fail-closed prerequisite errors instead of skips.
 *
 * Inert under plain node: no Electron import at the top level, no
 * top-level side effects. Process handling takes an int pid only, never a
 * name; a pid must exceed 1 and must not sit in the caller's group.
 *
 * @module harness
 */

const { spawnSync } = require('node:child_process');
const {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, join, resolve, sep } = require('node:path');

/**
 * Coded harness failure. Local codes (E2E_*) are distinct from core
 * refusal reasons and from preload ContractError codes.
 */
class E2EError extends Error {
  /**
   * @param {string} code Stable diagnostic code.
   * @param {string} message Human-readable detail.
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'E2EError';
    /** @type {string} @readonly */
    this.code = code;
  }
}

/** Fixed xvfb screen geometry shared with the CI e2e job. */
const XVFB_ARGV = Object.freeze(['-a', '-s', '-screen 0 1280x900x24']);

/** Renderer window size for the wall journey. */
const WINDOW_WIDTH = 1280;
/** Renderer window height for the wall journey. */
const WINDOW_HEIGHT = 900;

/**
 * Minimum visible wall tiles. Roadmap AC-02 targets at least four live
 * capsules; the wall test fails below this count.
 */
const MIN_WALL_TILES = 4;

/** Closed probe report schema tag. */
const REPORT_SCHEMA = 'e2e-wall-report/v1';
/** Closed fake-capsule manifest schema tag. */
const MANIFEST_SCHEMA = 'e2e-fake-manifest/v1';
/** Only probe phase e2e1 exercises. */
const WALL_PHASE = 'wall';

/** Milliseconds the live run may wait for boot and assertions. */
const XVFB_TIMEOUT_MS = 600000;
/** Milliseconds the serialized probe waits before exiting 2. */
const PROBE_WATCHDOG_MS = 120000;
/** Milliseconds terminate waits per signal stage. */
const KILL_WAIT_MS = 5000;
/** Cap on captured child output bytes. */
const MAX_CHILD_BYTES = 8 * 1024 * 1024;
/** Cap on probe report file bytes. */
const MAX_REPORT_BYTES = 1024 * 1024;
/** Cap on scratch ascent while locating the repo root. */
const MAX_ROOT_ASCENT = 8;

/**
 * Surface kinds the fake manifest may use. Mirrors the kind enum of
 * contracts/v0.2/surface.schema.json; the harness duplicates the
 * literals so drift fails loudly at the fixture boundary.
 */
const SURFACE_KINDS = Object.freeze([
  'desktop_capsule',
  'browser',
  'game_capsule',
  'vm',
]);

/** Capsule id charset; length mirrors surface_id 1..128. */
const CAPSULE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Scratch prefix charset. */
const PREFIX_PATTERN = /^[A-Za-z0-9-]{1,32}$/;

/**
 * @param {string} code Stable refusal code.
 * @param {string} message Human detail.
 * @returns {never}
 */
function fail(code, message) {
  throw new E2EError(code, message);
}

/**
 * @param {unknown} value Candidate.
 * @param {string} label Field label for the error.
 * @returns {string} The validated string.
 */
function needString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail('E2E_ARGS', `${label} must be a non-empty string`);
  return /** @type {string} */ (value);
}

/**
 * @param {unknown} value Candidate.
 * @param {string} label Field label for the error.
 * @returns {number} The validated positive int.
 */
function needPositiveInt(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail('E2E_ARGS', `${label} must be a positive integer`);
  }
  return /** @type {number} */ (value);
}

/**
 * Reject objects with keys outside the closed set.
 * @param {Record<string, unknown>} value Object under test.
 * @param {ReadonlyArray<string>} allowed Exact key set.
 * @param {string} label Field label for the error.
 * @param {string} code Domain refusal code for the caller.
 */
function needClosedKeys(value, allowed, label, code) {
  const keys = Object.keys(value).sort();
  const want = [...allowed].sort();
  if (keys.length !== want.length || keys.some((key, index) => key !== want[index])) {
    fail(needString(code, 'code'), `${label} has unexpected keys: ${keys.join(',')}`);
  }
}

/**
 * Locate the repository root by ascending from a start directory until
 * the ui contract and the contracts tree are both present.
 * @param {string} start Absolute directory to ascend from.
 * @returns {string} Absolute repository root.
 */
function findRepoRoot(start) {
  let dir = resolve(needString(start, 'start'));
  for (let depth = 0; depth <= MAX_ROOT_ASCENT; depth += 1) {
    const uiPackage = join(dir, 'ui', 'package.json');
    const contracts = join(dir, 'contracts', 'v0.2');
    try {
      accessSync(uiPackage, constants.R_OK);
      accessSync(contracts, constants.R_OK);
      return dir;
    } catch {
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  }
  return fail('E2E_ROOT', 'repository root not found within ascent cap');
}

/**
 * Resolve the Electron binary shipped under ui/node_modules. The binary
 * is absent until the ui dependencies are staged; absence is a typed
 * prerequisite failure, never a fallback to another browser.
 * @param {string} root Absolute repository root.
 * @returns {string} Absolute Electron binary path.
 */
function electronBinary(root) {
  const binary = join(resolve(needString(root, 'root')), 'ui', 'node_modules', 'electron', 'dist', 'electron');
  try {
    accessSync(binary, constants.X_OK);
  } catch {
    fail('E2E_PREREQ', `electron binary missing or not executable: ${binary}`);
  }
  return binary;
}

/**
 * Pure PATH scan for an executable name. Kept pure so the contract
 * test can run it against a synthetic PATH fixture.
 * @param {string} name Binary name without separators.
 * @param {string} pathEnv PATH-style search list.
 * @returns {string|null} Absolute path, or null when not found.
 */
function whichBinary(name, pathEnv) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('/')) return null;
  if (typeof pathEnv !== 'string' || pathEnv.length === 0) return null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Require xvfb-run on PATH. The wall journey renders a real window, so
 * a missing virtual display refuses the run instead of rendering
 * headless with different geometry.
 * @returns {string} Absolute xvfb-run path.
 */
function requireXvfb() {
  const found = whichBinary('xvfb-run', process.env.PATH || '');
  if (!found) fail('E2E_PREREQ', 'xvfb-run not installed on PATH');
  return /** @type {string} */ (found);
}

/**
 * Validate a pid for signalling. Accepts an int above 1 that is
 * neither the caller nor its process group; existence is checked by
 * the kill site, not here.
 * @param {unknown} pid Candidate pid.
 * @returns {number} The validated pid.
 */
function assertPid(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) {
    fail('E2E_PID', 'pid must be an integer above 1');
  }
  const value = /** @type {number} */ (pid);
  if (value === process.pid) fail('E2E_PID', 'refusing to signal the caller');
  try {
    if (typeof process.getpgid === 'function' && process.getpgid(value) === process.getpgid(process.pid)) {
      fail('E2E_PID', 'refusing to signal the caller group');
    }
  } catch (error) {
    if (error instanceof E2EError) throw error;
    const code = /** @type {{ code?: unknown }} */ (error).code;
    if (code !== 'ESRCH') fail('E2E_PID', 'pid group check failed');
  }
  return value;
}

/**
 * @param {number} pid Validated pid.
 * @returns {boolean} True while the pid accepts signal 0.
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {number} ms Non-negative milliseconds.
 * @returns {Promise<void>} Resolves after the slice.
 */
function sleep(ms) {
  return new Promise((done) => setTimeout(done, Math.max(0, ms)));
}

/**
 * Terminate a pid with SIGTERM, escalating to SIGKILL after a bounded
 * wait. Takes a pid only; signalling by name is forbidden. Async so
 * the event loop can reap own children while waiting; a synchronous
 * wait would observe its own zombie forever.
 * @param {unknown} pid Candidate pid.
 * @param {{ waitMs?: number }} [options] Per-stage wait budget.
 * @returns {Promise<void>} Resolves once the pid is gone.
 */
async function terminate(pid, options = {}) {
  const target = assertPid(pid);
  const waitMs = options.waitMs === undefined ? KILL_WAIT_MS : needPositiveInt(options.waitMs, 'waitMs');
  if (!pidAlive(target)) return;
  try {
    process.kill(target, 'SIGTERM');
  } catch (error) {
    if (!pidAlive(target)) return;
    const code = /** @type {{ code?: unknown }} */ (error).code;
    fail('E2E_KILL', `SIGTERM refused: ${String(code)}`);
  }
  const deadline = Date.now() + waitMs;
  while (pidAlive(target) && Date.now() < deadline) await sleep(25);
  if (!pidAlive(target)) return;
  try {
    process.kill(target, 'SIGKILL');
  } catch (error) {
    if (!pidAlive(target)) return;
    const code = /** @type {{ code?: unknown }} */ (error).code;
    fail('E2E_KILL', `SIGKILL refused: ${String(code)}`);
  }
  const killDeadline = Date.now() + waitMs;
  while (pidAlive(target) && Date.now() < killDeadline) await sleep(25);
  if (pidAlive(target)) fail('E2E_KILL', 'pid survived SIGKILL within budget');
}

/**
 * Selector matching every wall tile. Tiles carry data-capsule-id per
 * the kit CapsulePanel contract; the wall test never selects by list
 * index, length, or display text.
 * @returns {string} Tile list selector.
 */
function wallTileListSelector() {
  return '[data-capsule-id]';
}

/**
 * Selector for one tile by capsule id. The id charset excludes quote
 * and bracket characters, so interpolation cannot escape the selector.
 * @param {unknown} capsuleId Tile capsule id.
 * @returns {string} Single-tile selector.
 */
function tileSelector(capsuleId) {
  if (typeof capsuleId !== 'string' || !CAPSULE_ID_PATTERN.test(capsuleId)) {
    fail('E2E_ARGS', 'capsuleId must match [A-Za-z0-9_-]{1,128}');
  }
  return `[data-capsule-id="${capsuleId}"]`;
}

/**
 * @typedef {object} FakeCapsuleSpec UI-level fake capsule fixture row.
 * @property {string} capsuleId Stable tile id.
 * @property {string} kind One of the SURFACE_KINDS literals.
 * @property {number} w Tile width in px, at least 1.
 * @property {number} h Tile height in px, at least 1.
 */

/**
 * Validate one fake capsule row against the closed fixture shape.
 * @param {unknown} spec Candidate row.
 * @returns {FakeCapsuleSpec} The validated row.
 */
function checkFakeCapsuleSpec(spec) {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    fail('E2E_SHAPE', 'fake capsule spec must be an object');
  }
  const row = /** @type {Record<string, unknown>} */ (spec);
  needClosedKeys(row, ['capsuleId', 'kind', 'w', 'h'], 'fake capsule spec', 'E2E_SHAPE');
  if (typeof row.capsuleId !== 'string' || !CAPSULE_ID_PATTERN.test(row.capsuleId)) {
    fail('E2E_SHAPE', 'fake capsuleId must match [A-Za-z0-9_-]{1,128}');
  }
  if (typeof row.kind !== 'string' || !SURFACE_KINDS.includes(row.kind)) {
    fail('E2E_SHAPE', `fake kind must be one of ${SURFACE_KINDS.join(',')}`);
  }
  needPositiveInt(row.w, 'fake w');
  needPositiveInt(row.h, 'fake h');
  return /** @type {FakeCapsuleSpec} */ ({
    capsuleId: row.capsuleId,
    kind: row.kind,
    w: row.w,
    h: row.h,
  });
}

/**
 * Write the closed fake-capsule manifest the probe reads. This is a
 * UI-level tile fixture; adapter-level fakes belong to the integration
 * lane and are never imported here.
 * @param {string} dir Absolute scratch directory.
 * @param {ReadonlyArray<unknown>} capsules Fake capsule rows.
 * @returns {string} Absolute manifest path.
 */
function writeFakeManifest(dir, capsules) {
  const root = resolve(needString(dir, 'dir'));
  if (!Array.isArray(capsules) || capsules.length === 0) fail('E2E_ARGS', 'capsules must be a non-empty array');
  const rows = /** @type {ReadonlyArray<unknown>} */ (capsules).map(checkFakeCapsuleSpec);
  const ids = rows.map((row) => row.capsuleId);
  if (new Set(ids).size !== ids.length) fail('E2E_SHAPE', 'fake capsule ids must be unique');
  const manifest = { schema: MANIFEST_SCHEMA, capsules: rows };
  const path = join(root, 'fake-manifest.json');
  writeFileSync(path, `${JSON.stringify(manifest)}\n`, 'utf8');
  return path;
}

/**
 * Read and validate the fake-capsule manifest back. The probe file
 * embeds its own copy of these checks (it cannot require this
 * module), and this reader guards the test side symmetrically.
 * @param {string} path Absolute manifest path.
 * @returns {{ schema: string, capsules: FakeCapsuleSpec[] }} The manifest.
 */
function readFakeManifest(path) {
  const file = resolve(needString(path, 'path'));
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    fail('E2E_MANIFEST', 'fake manifest unreadable');
  }
  if (/** @type {string} */ (text).length > MAX_REPORT_BYTES) fail('E2E_MANIFEST', 'fake manifest exceeds byte cap');
  let value;
  try {
    value = JSON.parse(/** @type {string} */ (text));
  } catch {
    fail('E2E_MANIFEST', 'fake manifest is not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('E2E_MANIFEST', 'fake manifest must be an object');
  }
  const manifest = /** @type {Record<string, unknown>} */ (value);
  needClosedKeys(manifest, ['schema', 'capsules'], 'fake manifest', 'E2E_MANIFEST');
  if (manifest.schema !== MANIFEST_SCHEMA) fail('E2E_MANIFEST', 'fake manifest schema mismatch');
  if (!Array.isArray(manifest.capsules)) fail('E2E_MANIFEST', 'fake manifest capsules must be an array');
  const capsules = /** @type {ReadonlyArray<unknown>} */ (manifest.capsules).map(checkFakeCapsuleSpec);
  return { schema: MANIFEST_SCHEMA, capsules };
}

/**
 * @typedef {object} WallTileReport One observed tile.
 * @property {string} capsuleId Tile capsule id.
 * @property {boolean} visible Whether the tile is rendered and visible.
 * @property {string|null} frameId Observed frame tag, or null when the
 * tile shows honest unavailable content with no frame.
 */

/**
 * @typedef {object} WallReport Validated probe report.
 * @property {WallTileReport[]} tiles Observed tiles.
 * @property {string} phase Probe phase, always wall for e2e1.
 * @property {string[]} errors Renderer console errors observed.
 */

/**
 * Validate one observed tile row.
 * @param {unknown} tile Candidate row.
 * @returns {WallTileReport} The validated row.
 */
function checkTileReport(tile) {
  if (typeof tile !== 'object' || tile === null || Array.isArray(tile)) {
    fail('E2E_REPORT', 'tile row must be an object');
  }
  const row = /** @type {Record<string, unknown>} */ (tile);
  needClosedKeys(row, ['capsuleId', 'visible', 'frameId'], 'tile row', 'E2E_REPORT');
  if (typeof row.capsuleId !== 'string' || !CAPSULE_ID_PATTERN.test(row.capsuleId)) {
    fail('E2E_REPORT', 'tile capsuleId malformed');
  }
  if (typeof row.visible !== 'boolean') fail('E2E_REPORT', 'tile visible must be boolean');
  if (row.frameId !== null && (typeof row.frameId !== 'string' || row.frameId.length === 0 || row.frameId.length > 256)) {
    fail('E2E_REPORT', 'tile frameId must be null or a 1..256 string');
  }
  return /** @type {WallTileReport} */ ({ capsuleId: row.capsuleId, visible: row.visible, frameId: row.frameId });
}

/**
 * Strict closed validation of the probe report, including the
 * cross-capsule routing rule: a frame published for capsule A and
 * observed on tile B refuses the run. Frame tags are opaque probe
 * strings; only their tile placement is judged here.
 * @param {unknown} value Parsed probe report.
 * @param {{ minTiles?: number }} [options] Minimum visible tiles.
 * @returns {{ tiles: WallTileReport[], visible: number, errors: string[] }} Normalized summary.
 */
function validateWallReport(value, options = {}) {
  const minTiles = options.minTiles === undefined ? MIN_WALL_TILES : needPositiveInt(options.minTiles, 'minTiles');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('E2E_REPORT', 'probe report must be an object');
  }
  const report = /** @type {Record<string, unknown>} */ (value);
  needClosedKeys(report, ['schema', 'phase', 'tiles', 'errors'], 'probe report', 'E2E_REPORT');
  if (report.schema !== REPORT_SCHEMA) fail('E2E_REPORT', 'probe report schema mismatch');
  if (report.phase !== WALL_PHASE) fail('E2E_REPORT', 'probe report phase mismatch');
  if (!Array.isArray(report.tiles)) fail('E2E_REPORT', 'probe report tiles must be an array');
  if (!Array.isArray(report.errors) || !report.errors.every((entry) => typeof entry === 'string')) {
    fail('E2E_REPORT', 'probe report errors must be string array');
  }
  const tiles = /** @type {ReadonlyArray<unknown>} */ (report.tiles).map(checkTileReport);
  const ids = tiles.map((tile) => tile.capsuleId);
  if (new Set(ids).size !== ids.length) fail('E2E_REPORT', 'duplicate tile capsuleId');
  const owners = new Map();
  for (const tile of tiles) {
    if (tile.frameId === null) continue;
    const prior = owners.get(tile.frameId);
    if (prior !== undefined && prior !== tile.capsuleId) {
      fail('E2E_ROUTING', `frame routed to two tiles: ${prior} and ${tile.capsuleId}`);
    }
    owners.set(tile.frameId, tile.capsuleId);
  }
  const visible = tiles.filter((tile) => tile.visible).length;
  if (visible < minTiles) fail('E2E_TILES', `only ${visible} visible tiles, need ${minTiles}`);
  return { tiles, visible, errors: /** @type {string[]} */ ([...report.errors]) };
}

/**
 * Read a probe report file and validate it. Oversized or malformed
 * files refuse with a typed error.
 * @param {string} path Absolute report path.
 * @param {{ minTiles?: number }} [options] Minimum visible tiles.
 * @returns {{ tiles: WallTileReport[], visible: number, errors: string[] }} Normalized summary.
 */
function readProbeReport(path, options = {}) {
  const file = resolve(needString(path, 'path'));
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    fail('E2E_REPORT', 'probe report unreadable');
  }
  if (/** @type {string} */ (text).length > MAX_REPORT_BYTES) fail('E2E_REPORT', 'probe report exceeds byte cap');
  let value;
  try {
    value = JSON.parse(/** @type {string} */ (text));
  } catch {
    fail('E2E_REPORT', 'probe report is not JSON');
  }
  return validateWallReport(value, options);
}

/**
 * Serialized Electron probe. Runs as the Electron main entry inside
 * the scratch app directory: it sets a scratch profile, imports the
 * product main, waits for the first window load, then observes the
 * wall through stable-id queries and writes the closed report file.
 *
 * Self-contained by construction: no closure over harness state, only
 * require calls and the injected config. Every helper it needs is
 * defined inside.
 * @param {{ profile: string, mainUrl: string, manifestPath: string,
 * reportPath: string, watchdogMs: number }} config Injected probe config.
 * @returns {Promise<void>} Resolves when the probe file is installed;
 * the process exits via app.exit once the journey completes.
 */
async function probeMain(config) {
  const assert = require('node:assert/strict');
  const { readFileSync, writeFileSync } = require('node:fs');
  const { app } = require('electron');
  assert.equal(typeof config, 'object');
  assert.equal(typeof config.profile, 'string');
  assert.ok(config.mainUrl.startsWith('file://'));
  assert.equal(typeof config.manifestPath, 'string');
  assert.equal(typeof config.reportPath, 'string');
  assert.ok(Number.isInteger(config.watchdogMs) && config.watchdogMs > 0);
  app.setPath('userData', config.profile);
  const manifest = JSON.parse(readFileSync(config.manifestPath, 'utf8'));
  assert.equal(manifest.schema, 'e2e-fake-manifest/v1');
  assert.ok(Array.isArray(manifest.capsules) && manifest.capsules.length > 0);
  const wanted = manifest.capsules.map((row) => row.capsuleId);
  /** Pause between input steps so layout settles. */
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  /** Serialize one observed tile row. */
  const observeTiles = (tiles) => {
    assert.ok(Array.isArray(tiles));
    return tiles.map((tile) => ({
      capsuleId: tile.capsuleId,
      visible: tile.visible === true,
      frameId: tile.frameId === null ? null : String(tile.frameId),
    }));
  };
  setTimeout(() => app.exit(2), config.watchdogMs).unref();
  app.on('browser-window-created', (_, win) => {
    const errors = [];
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 3) {
        errors.push(String(event.message).slice(0, 512));
        console.error(String(event.message).slice(0, 512));
      }
    });
    win.webContents.once('did-finish-load', async () => {
      try {
        const wc = win.webContents;
        const mount = await wc.executeJavaScript('!!document.querySelector("#metaviewer-app")');
        assert.equal(mount, true, 'wall mount #metaviewer-app must exist');
        const sampleTiles = () => wc.executeJavaScript(
          `(${() => {
            const nodes = Array.from(document.querySelectorAll('[data-capsule-id]'));
            return nodes.map((node) => ({
              capsuleId: node.getAttribute('data-capsule-id'),
              visible: node.checkVisibility(),
              frameId: node.querySelector('[data-frame-tag]')?.getAttribute('data-frame-tag') ?? null,
            }));
          }})()`,
        );
        const deadline = Date.now() + Math.floor(config.watchdogMs / 2);
        let tiles = [];
        do {
          tiles = await sampleTiles();
          if (wanted.every((id) => tiles.some((tile) => tile.capsuleId === id
              && tile.visible && tile.frameId !== null))) break;
          if (errors.length) throw new Error(errors.join(' | '));
          await pause(50);
        } while (Date.now() < deadline);
        const rows = observeTiles(tiles);
        const seen = new Set(rows.map((row) => row.capsuleId));
        for (const id of wanted) assert.ok(seen.has(id), `manifest tile missing: ${id}`);
        for (const row of rows) assert.ok(wanted.includes(row.capsuleId), `unregistered tile: ${row.capsuleId}`);
        const report = { schema: 'e2e-wall-report/v1', phase: 'wall', tiles: rows, errors };
        writeFileSync(config.reportPath, `${JSON.stringify(report)}\n`, 'utf8');
        app.exit(errors.length === 0 ? 0 : 1);
      } catch (error) {
        try {
          const report = {
            schema: 'e2e-wall-report/v1',
            phase: 'wall',
            tiles: [],
            errors: [String((error && error.stack) || error).slice(0, 512)],
          };
          writeFileSync(config.reportPath, `${JSON.stringify(report)}\n`, 'utf8');
        } catch {
          // Report write failure still exits nonzero below.
        }
        app.exit(1);
      }
    });
  });
  process.env.MV_E2E_MANIFEST = config.manifestPath;
  await import(config.mainUrl);
}

/**
 * Render the probe file text embedding a validated config. The config
 * travels as JSON, so no caller string can inject code.
 * @param {{ profile: string, mainUrl: string, manifestPath: string,
 * reportPath: string, watchdogMs?: number }} config Probe config.
 * @returns {string} Probe file text.
 */
function renderProbeFile(config) {
  if (typeof config !== 'object' || config === null) fail('E2E_ARGS', 'probe config must be an object');
  const profile = resolve(needString(config.profile, 'profile'));
  const mainUrl = needString(config.mainUrl, 'mainUrl');
  if (!mainUrl.startsWith('file://')) fail('E2E_ARGS', 'mainUrl must be a file URL');
  const manifestPath = resolve(needString(config.manifestPath, 'manifestPath'));
  const reportPath = resolve(needString(config.reportPath, 'reportPath'));
  const watchdogMs = config.watchdogMs === undefined ? PROBE_WATCHDOG_MS : needPositiveInt(config.watchdogMs, 'watchdogMs');
  const frozen = { profile, mainUrl, manifestPath, reportPath, watchdogMs };
  return `(${probeMain.toString()})(${JSON.stringify(frozen)});`;
}

/**
 * Write the probe file into the scratch app directory.
 * @param {string} dir Absolute scratch directory.
 * @param {{ profile: string, mainUrl: string, manifestPath: string,
 * reportPath: string, watchdogMs?: number }} config Probe config.
 * @returns {string} Absolute probe path.
 */
function writeProbeFile(dir, config) {
  const root = resolve(needString(dir, 'dir'));
  const path = join(root, 'probe.cjs');
  writeFileSync(path, `${renderProbeFile(config)}\n`, 'utf8');
  return path;
}

/**
 * Create a scratch directory under the platform temp root.
 * @param {string} prefix Name prefix, charset [A-Za-z0-9-].
 * @returns {string} Absolute scratch path.
 */
function makeScratch(prefix) {
  if (typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix)) {
    fail('E2E_ARGS', 'scratch prefix must match [A-Za-z0-9-]{1,32}');
  }
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/**
 * Remove a scratch directory created by makeScratch. Refuses paths
 * outside the platform temp root.
 * @param {string} dir Absolute scratch path.
 */
function removeScratch(dir) {
  const root = resolve(needString(dir, 'dir'));
  const base = resolve(tmpdir());
  if (!root.startsWith(`${base}${sep}`)) fail('E2E_ARGS', 'scratch path outside temp root');
  rmSync(root, { recursive: true, force: true });
}

/**
 * Run the Electron probe under xvfb with a bounded wait. Argv entries
 * are validated as NUL-free strings; the spawn itself is bounded by
 * timeout so nothing outlives the caller.
 * @param {{ electron: string, appDir: string, extraArgs?: ReadonlyArray<string>,
 * timeoutMs?: number }} options Spawn options.
 * @returns {{ status: number|null, stdout: string, stderr: string, timedOut: boolean }}
 * Spawn outcome.
 */
function runUnderXvfb(options) {
  if (typeof options !== 'object' || options === null) fail('E2E_ARGS', 'spawn options must be an object');
  const electron = resolve(needString(options.electron, 'electron'));
  const appDir = resolve(needString(options.appDir, 'appDir'));
  const timeoutMs = options.timeoutMs === undefined ? XVFB_TIMEOUT_MS : needPositiveInt(options.timeoutMs, 'timeoutMs');
  const extra = options.extraArgs === undefined ? [] : options.extraArgs;
  if (!Array.isArray(extra) || !extra.every((entry) => typeof entry === 'string' && !entry.includes('\0'))) {
    fail('E2E_ARGS', 'extraArgs must be NUL-free strings');
  }
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  let result;
  try {
    result = spawnSync('xvfb-run', [...XVFB_ARGV, electron, appDir, ...extra], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_CHILD_BYTES,
      env: childEnv,
    });
  } catch (error) {
    const code = /** @type {{ code?: unknown }} */ (error).code;
    fail('E2E_SPAWN', `xvfb-run spawn refused: ${String(code)}`);
  }
  const outcome = /** @type {{ status: number|null, stdout: unknown, stderr: unknown,
    error?: { code?: unknown } }} */ (result);
  if (outcome.error) {
    const code = String(outcome.error.code || 'unknown');
    if (code === 'ENOENT') fail('E2E_PREREQ', 'xvfb-run not installed on PATH');
    fail('E2E_SPAWN', `xvfb-run failed: ${code}`);
  }
  return {
    status: outcome.status,
    stdout: typeof outcome.stdout === 'string' ? outcome.stdout : '',
    stderr: typeof outcome.stderr === 'string' ? outcome.stderr : '',
    timedOut: outcome.status === null,
  };
}

module.exports = {
  E2EError,
  XVFB_ARGV,
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  MIN_WALL_TILES,
  REPORT_SCHEMA,
  MANIFEST_SCHEMA,
  WALL_PHASE,
  XVFB_TIMEOUT_MS,
  PROBE_WATCHDOG_MS,
  KILL_WAIT_MS,
  MAX_CHILD_BYTES,
  MAX_REPORT_BYTES,
  SURFACE_KINDS,
  findRepoRoot,
  electronBinary,
  whichBinary,
  requireXvfb,
  assertPid,
  terminate,
  wallTileListSelector,
  tileSelector,
  checkFakeCapsuleSpec,
  writeFakeManifest,
  readFakeManifest,
  checkTileReport,
  validateWallReport,
  readProbeReport,
  probeMain,
  renderProbeFile,
  writeProbeFile,
  makeScratch,
  removeScratch,
  runUnderXvfb,
};
