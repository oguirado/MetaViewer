'use strict';

/**
 * AC-04 human control journey (roadmap AC-04: take_control / release_control).
 *
 * Runs under node --test; locates the repo root from its own path. Two layers,
 * mirroring tests/e2e/e2e1_wall.test.js:
 *
 * 1. Arbitration contract tests: pure validation of the control-journey
 *    witness, the ratified take_control/release_control wire shapes, and the
 *    live probe report, each paired with mutant fixtures that must FAIL with
 *    the exact typed code a broken arbitration would trip. These run on every
 *    host with node alone.
 * 2. The live control journey, staged by the AC harness: the compiled core
 *    arbitration (pending cancelled on take, SURFACE_NOT_AGENT_CONTROLLED
 *    while human-held, STALE_FRAME before the post-release refresh, admit
 *    after it) plus the wall-tile take/release control probe under xvfb. It
 *    fails closed with a typed E2E_* error when a prerequisite is missing
 *    (live flag, cargo artifacts, xvfb, Electron binary, built wall, control
 *    host); it never skips.
 *
 * [TARGET, unit decision] Test-only witness vocabulary. The live probe and
 * the core-arbitration step record one closed report each; Layer 1 validates
 * both shapes and the arbitration invariants. Field names mirror
 * core/src/admission/mod.rs (cancelled, cancellation_reason, control_ready,
 * refresh fence) and the ratified contracts/v0.2 verdict codes. No wire
 * schema is introduced: take_control/release_control are already ratified in
 * contracts/v0.2/surface_request.schema.json and ui_intent.schema.json, and
 * the surface control enum lives in contracts/v0.2/surface.schema.json.
 *
 * Norm deviations recorded here for writers: the executor epoch moves only
 * on executor (re)connect (core/src/admission/mod.rs Connect arm), never on
 * take_control or release_control; the take/release fence is refresh_after
 * on core_seq, cleared only by a frame with a strictly greater core_seq.
 *
 * @module ac04_control
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const {
  E2EError,
  PROBE_WATCHDOG_MS,
  electronBinary,
  findRepoRoot,
  makeScratch,
  removeScratch,
  requireXvfb,
  runUnderXvfb,
  tileSelector,
  wallTileListSelector,
  whichBinary,
  writeFakeManifest,
} = require('./ac-harness.cjs');
const { runRust } = require('./core-driver.js');

/** Env flag arming the live journey; anything else refuses the run. */
/** Env dir with the built wall (set by tests/e2e/run.py). */
const BUILD_ENV = 'MV_E2E_BUILD';

/** Closed control report schema tag (test-only witness, see header). */
const CONTROL_REPORT_SCHEMA = 'e2e-control-report/v1';
/** Only probe phase this suite exercises. */
const CONTROL_PHASE = 'control';

/** Ratified control verbs (surface_request and ui_intent wire ops). */
const CONTROL_VERBS = Object.freeze(['take_control', 'release_control']);
/** Ratified surface control enum. */
const SURFACE_CONTROL = Object.freeze(['agent', 'human', 'shared']);
/** Exact takeover refusal: the AC-04 must-FAIL control. */
const REFUSAL_TAKEOVER = 'SURFACE_NOT_AGENT_CONTROLLED';
/** Exact pre-refresh refusal after release_control. */
const REFUSAL_STALE = 'STALE_FRAME';
/** request_id/surface_id charset for ui_intent control ops. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** Fixture refusal marker thrown by the wall fixture control builder. */
const FIXTURE_REFUSAL_MARK = 'Fixture cannot dispatch host actions';

/** Single-tile manifest for the control journey. */
const AC04_FAKES = Object.freeze([
  { capsuleId: 'ac04-ctrl-a', kind: 'browser', w: 640, h: 400 },
]);

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
 * @param {string} code Refusal code for the caller.
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
 * @param {string} label Field label for the error.
 * @param {string} code Refusal code for the caller.
 * @returns {number} The validated uint.
 */
function needUint(value, label, code) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0
    || value > Number.MAX_SAFE_INTEGER) {
    throw new E2EError(code, `${label} must be a uint`);
  }
  return /** @type {number} */ (value);
}

/**
 * @param {unknown} value Candidate.
 * @param {string} label Field label for the error.
 * @param {number} max Longest accepted length.
 * @param {string} code Refusal code for the caller.
 * @returns {string} The validated string.
 */
function needBoundedString(value, label, max, code) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new E2EError(code, `${label} must be a 1..${max} string`);
  }
  return /** @type {string} */ (value);
}

/**
 * Validate a ratified surface_request take_control/release_control op.
 * take_control params carry surface_id plus owner; release_control params
 * carry surface_id only; every object is closed.
 * @param {unknown} value Candidate op.
 * @returns {{ schema: string, op: string, params: Record<string, string> }} Normalized op.
 */
function checkSurfaceRequestControlOp(value) {
  const code = 'E2E_CONTRACT';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new E2EError(code, 'surface_request control op must be an object');
  }
  const op = /** @type {Record<string, unknown>} */ (value);
  needClosedKeys(op, ['schema', 'op', 'params'], 'surface_request control op', code);
  if (op.schema !== 'surface_request/v0.2') {
    throw new E2EError(code, 'surface_request control op schema mismatch');
  }
  if (typeof op.op !== 'string' || !CONTROL_VERBS.includes(op.op)) {
    throw new E2EError(code, 'surface_request control op must be take_control or release_control');
  }
  if (typeof op.params !== 'object' || op.params === null || Array.isArray(op.params)) {
    throw new E2EError(code, 'surface_request control params must be an object');
  }
  const params = /** @type {Record<string, unknown>} */ (op.params);
  if (op.op === 'take_control') {
    needClosedKeys(params, ['surface_id', 'owner'], 'take_control params', code);
    needBoundedString(params.surface_id, 'take_control surface_id', 128, code);
    if (typeof params.owner !== 'string' || !SURFACE_CONTROL.includes(params.owner)) {
      throw new E2EError(code, 'take_control owner must be agent, human or shared');
    }
    return {
      schema: 'surface_request/v0.2',
      op: 'take_control',
      params: {
        surface_id: /** @type {string} */ (params.surface_id),
        owner: /** @type {string} */ (params.owner),
      },
    };
  }
  needClosedKeys(params, ['surface_id'], 'release_control params', code);
  needBoundedString(params.surface_id, 'release_control surface_id', 128, code);
  return {
    schema: 'surface_request/v0.2',
    op: 'release_control',
    params: { surface_id: /** @type {string} */ (params.surface_id) },
  };
}

/**
 * Validate a ratified ui_intent take_control/release_control op.
 * @param {unknown} value Candidate op.
 * @returns {{ schema: string, request_id: string, op: string, params: { surface_id: string } }}
 * Normalized op.
 */
function checkUiIntentControlOp(value) {
  const code = 'E2E_CONTRACT';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new E2EError(code, 'ui_intent control op must be an object');
  }
  const op = /** @type {Record<string, unknown>} */ (value);
  needClosedKeys(op, ['schema', 'request_id', 'op', 'params'], 'ui_intent control op', code);
  if (op.schema !== 'ui_intent/v0.2') {
    throw new E2EError(code, 'ui_intent control op schema mismatch');
  }
  if (typeof op.request_id !== 'string' || op.request_id.length === 0
    || op.request_id.length > 128 || !REQUEST_ID_PATTERN.test(op.request_id)) {
    throw new E2EError(code, 'ui_intent control request_id malformed');
  }
  if (typeof op.op !== 'string' || !CONTROL_VERBS.includes(op.op)) {
    throw new E2EError(code, 'ui_intent control op must be take_control or release_control');
  }
  if (typeof op.params !== 'object' || op.params === null || Array.isArray(op.params)) {
    throw new E2EError(code, 'ui_intent control params must be an object');
  }
  const params = /** @type {Record<string, unknown>} */ (op.params);
  needClosedKeys(params, ['surface_id'], 'ui_intent control params', code);
  if (typeof params.surface_id !== 'string' || params.surface_id.length === 0
    || params.surface_id.length > 128 || !REQUEST_ID_PATTERN.test(params.surface_id)) {
    throw new E2EError(code, 'ui_intent control surface_id malformed');
  }
  return {
    schema: 'ui_intent/v0.2',
    request_id: /** @type {string} */ (op.request_id),
    op: /** @type {string} */ (op.op),
    params: { surface_id: /** @type {string} */ (params.surface_id) },
  };
}

/**
 * Validate a ratified surface control value.
 * @param {unknown} value Candidate control value.
 * @returns {string} The validated value.
 */
function checkSurfaceControl(value) {
  if (typeof value !== 'string' || !SURFACE_CONTROL.includes(value)) {
    throw new E2EError('E2E_CONTRACT', 'surface control must be agent, human or shared');
  }
  return value;
}

/**
 * @param {unknown} value Candidate id list.
 * @param {string} label Field label for the error.
 * @param {boolean} nonEmpty Whether at least one id is required.
 * @returns {string[]} The validated ids.
 */
function needIdList(value, label, nonEmpty) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new E2EError('E2E_REPORT', `${label} must be a${nonEmpty ? ' non-empty' : ''} id array`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 128) {
      throw new E2EError('E2E_REPORT', `${label} holds a malformed id`);
    }
  }
  const ids = /** @type {string[]} */ ([...value]);
  if (new Set(ids).size !== ids.length) {
    throw new E2EError('E2E_REPORT', `${label} holds duplicate ids`);
  }
  return ids;
}

/**
 * Strict closed validation of the control-journey witness: take_control
 * cancels every arranged pending proposal with the exact takeover refusal,
 * proposals during human control are refused with the takeover code, the
 * executor epoch is untouched by take and release, release arms a refresh
 * fence, admission before the fresh frame is stale, and only a frame with a
 * strictly greater core_seq clears the fence and admits again.
 * @param {unknown} value Parsed witness.
 * @returns {{ capsuleId: string, cancelled: string[], admitted: boolean, errors: string[] }}
 * Normalized summary.
 */
function validateControlJourneyWitness(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new E2EError('E2E_REPORT', 'control witness must be an object');
  }
  const witness = /** @type {Record<string, unknown>} */ (value);
  needClosedKeys(witness, ['schema', 'phase', 'capsuleId', 'epoch_before', 'epoch_after_take',
    'epoch_after_release', 'pending_before', 'draining_before_take', 'take',
    'during_control_verdict', 'release', 'pre_refresh_verdict', 'post_frame',
    'post_refresh_verdict', 'errors'], 'control witness', 'E2E_REPORT');
  if (witness.schema !== CONTROL_REPORT_SCHEMA) {
    throw new E2EError('E2E_REPORT', 'control witness schema mismatch');
  }
  if (witness.phase !== CONTROL_PHASE) {
    throw new E2EError('E2E_REPORT', 'control witness phase mismatch');
  }
  if (typeof witness.capsuleId !== 'string') {
    throw new E2EError('E2E_ARGS', 'control witness capsuleId must be a string');
  }
  tileSelector(witness.capsuleId);
  const epochBefore = needUint(witness.epoch_before, 'epoch_before', 'E2E_REPORT');
  const epochTake = needUint(witness.epoch_after_take, 'epoch_after_take', 'E2E_REPORT');
  const epochRelease = needUint(witness.epoch_after_release, 'epoch_after_release', 'E2E_REPORT');
  const pending = needIdList(witness.pending_before, 'pending_before', true);
  const draining = needIdList(witness.draining_before_take, 'draining_before_take', false);
  if (typeof witness.take !== 'object' || witness.take === null || Array.isArray(witness.take)) {
    throw new E2EError('E2E_REPORT', 'take outcome must be an object');
  }
  const take = /** @type {Record<string, unknown>} */ (witness.take);
  needClosedKeys(take, ['cancelled', 'cancellation_reason', 'control_ready', 'agent_controlled'],
    'take outcome', 'E2E_REPORT');
  const cancelled = needIdList(take.cancelled, 'take.cancelled', false);
  if (typeof take.cancellation_reason !== 'string') {
    throw new E2EError('E2E_REPORT', 'take.cancellation_reason must be a string');
  }
  if (typeof take.control_ready !== 'boolean' || typeof take.agent_controlled !== 'boolean') {
    throw new E2EError('E2E_REPORT', 'take control flags must be boolean');
  }
  if (typeof witness.release !== 'object' || witness.release === null
    || Array.isArray(witness.release)) {
    throw new E2EError('E2E_REPORT', 'release outcome must be an object');
  }
  const release = /** @type {Record<string, unknown>} */ (witness.release);
  needClosedKeys(release, ['agent_controlled', 'refresh_fence_seq'], 'release outcome',
    'E2E_REPORT');
  if (typeof release.agent_controlled !== 'boolean') {
    throw new E2EError('E2E_REPORT', 'release agent_controlled must be boolean');
  }
  const fence = needUint(release.refresh_fence_seq, 'release.refresh_fence_seq', 'E2E_REPORT');
  if (typeof witness.post_frame !== 'object' || witness.post_frame === null
    || Array.isArray(witness.post_frame)) {
    throw new E2EError('E2E_REPORT', 'post_frame must be an object');
  }
  const frame = /** @type {Record<string, unknown>} */ (witness.post_frame);
  needClosedKeys(frame, ['generation', 'core_seq'], 'post_frame', 'E2E_REPORT');
  const generation = needUint(frame.generation, 'post_frame.generation', 'E2E_REPORT');
  const frameSeq = needUint(frame.core_seq, 'post_frame.core_seq', 'E2E_REPORT');
  if (!Array.isArray(witness.errors)
    || !witness.errors.every((entry) => typeof entry === 'string')) {
    throw new E2EError('E2E_REPORT', 'control witness errors must be a string array');
  }
  // Arbitration invariants below; every breach is E2E_CONTROL, never a shape code.
  for (const id of pending) {
    if (!cancelled.includes(id)) {
      throw new E2EError('E2E_CONTROL', `take_control left pending proposal live: ${id}`);
    }
  }
  if (take.cancellation_reason !== REFUSAL_TAKEOVER) {
    throw new E2EError('E2E_CONTROL', 'take_control cancellation reason must be the takeover code');
  }
  if (take.agent_controlled !== false) {
    throw new E2EError('E2E_CONTROL', 'take_control must clear agent control');
  }
  const ready = /** @type {boolean} */ (take.control_ready);
  const expectReady = !draining.includes(/** @type {string} */ (witness.capsuleId));
  if (ready !== expectReady) {
    throw new E2EError('E2E_CONTROL', 'take_control control_ready disagrees with the drain set');
  }
  if (witness.during_control_verdict !== REFUSAL_TAKEOVER) {
    throw new E2EError('E2E_CONTROL', 'proposal during human control must refuse with takeover');
  }
  if (epochTake !== epochBefore || epochRelease !== epochBefore) {
    throw new E2EError('E2E_CONTROL', 'take_control and release_control must not move the epoch');
  }
  if (release.agent_controlled !== true) {
    throw new E2EError('E2E_CONTROL', 'release_control must restore agent control');
  }
  if (witness.pre_refresh_verdict !== REFUSAL_STALE) {
    throw new E2EError('E2E_CONTROL', 'proposal before the post-release frame must be stale');
  }
  if (generation < 1 || frameSeq <= fence) {
    throw new E2EError('E2E_CONTROL', 'post-release frame must clear the refresh fence');
  }
  if (witness.post_refresh_verdict !== null) {
    throw new E2EError('E2E_CONTROL', 'proposal after the fresh frame must admit');
  }
  return {
    capsuleId: /** @type {string} */ (witness.capsuleId),
    cancelled,
    admitted: true,
    errors: /** @type {string[]} */ ([...witness.errors]),
  };
}

/**
 * Strict closed validation of the wall-tile control probe report (the UI
 * half of the journey: affordance found, take and release clicked, host
 * outcome observed, frame tags sampled).
 * @param {unknown} value Parsed probe report.
 * @returns {{ capsuleId: string, affordance_present: boolean, take_clicked: boolean,
 * release_clicked: boolean, host_refused: boolean, host_error: string,
 * frame_before: string|null, frame_after: string|null, errors: string[] }} Normalized report.
 */
function validateControlProbeReport(value) {
  const code = 'E2E_REPORT';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new E2EError(code, 'control probe report must be an object');
  }
  const report = /** @type {Record<string, unknown>} */ (value);
  needClosedKeys(report, ['schema', 'phase', 'capsuleId', 'affordance_present', 'take_clicked',
    'release_clicked', 'host_refused', 'host_error', 'tile_state_before', 'tile_state_after',
    'frame_before', 'frame_after', 'errors'], 'control probe report', code);
  if (report.schema !== CONTROL_REPORT_SCHEMA) {
    throw new E2EError(code, 'control probe report schema mismatch');
  }
  if (report.phase !== CONTROL_PHASE) {
    throw new E2EError(code, 'control probe report phase mismatch');
  }
  if (typeof report.capsuleId !== 'string') {
    throw new E2EError('E2E_ARGS', 'control probe capsuleId must be a string');
  }
  tileSelector(report.capsuleId);
  for (const flag of ['affordance_present', 'take_clicked', 'release_clicked', 'host_refused']) {
    if (typeof report[flag] !== 'boolean') {
      throw new E2EError(code, `control probe ${flag} must be boolean`);
    }
  }
  if (typeof report.host_error !== 'string' || report.host_error.length > 512) {
    throw new E2EError(code, 'control probe host_error must be a 0..512 string');
  }
  for (const field of ['tile_state_before', 'tile_state_after']) {
    const entry = report[field];
    if (entry !== null && (typeof entry !== 'string' || entry.length > 64)) {
      throw new E2EError(code, `control probe ${field} must be null or a 0..64 string`);
    }
  }
  for (const field of ['frame_before', 'frame_after']) {
    const entry = report[field];
    if (entry !== null
      && (typeof entry !== 'string' || entry.length === 0 || entry.length > 256)) {
      throw new E2EError(code, `control probe ${field} must be null or a 1..256 string`);
    }
  }
  if (!Array.isArray(report.errors) || !report.errors.every((entry) => typeof entry === 'string'
    && entry.length <= 1024)) {
    throw new E2EError(code, 'control probe errors must be a string array');
  }
  return {
    capsuleId: /** @type {string} */ (report.capsuleId),
    affordance_present: /** @type {boolean} */ (report.affordance_present),
    take_clicked: /** @type {boolean} */ (report.take_clicked),
    release_clicked: /** @type {boolean} */ (report.release_clicked),
    host_refused: /** @type {boolean} */ (report.host_refused),
    host_error: /** @type {string} */ (report.host_error),
    frame_before: /** @type {string|null} */ (report.frame_before),
    frame_after: /** @type {string|null} */ (report.frame_after),
    errors: /** @type {string[]} */ ([...report.errors]),
  };
}

/**
 * Selector for the tile control button. The kit CapsulePanel binds its
 * control action to data-semantic-anchor capsule/<id>/control; the capsule
 * id charset excludes quotes, so interpolation cannot escape the selector.
 * @param {unknown} capsuleId Tile capsule id.
 * @returns {string} Control-button selector.
 */
function controlAnchorSelector(capsuleId) {
  tileSelector(capsuleId);
  return `[data-semantic-anchor="capsule/${capsuleId}/control"]`;
}

/**
 * Serialized Electron probe for the control journey. Runs as the Electron
 * main entry inside the scratch app directory: it sets a scratch profile,
 * imports the product main, waits for the control tile, clicks its control
 * button twice (take, then release) through input events at the button
 * center, and writes the closed control report. A fixture host that refuses
 * control intents is recorded as data (host_refused), never hidden.
 *
 * Self-contained by construction: no closure over suite state, only
 * require calls and the injected config.
 * @param {{ profile: string, mainUrl: string, manifestPath: string,
 * reportPath: string, capsuleId: string, watchdogMs: number }} config Injected probe config.
 * @returns {Promise<void>} Resolves when the probe file is installed;
 * the process exits via app.exit once the journey completes.
 */
async function controlProbeMain(config) {
  const assert = require('node:assert/strict');
  const { readFileSync, writeFileSync } = require('node:fs');
  const { app } = require('electron');
  assert.equal(typeof config, 'object');
  assert.equal(typeof config.profile, 'string');
  assert.ok(config.mainUrl.startsWith('file://'));
  assert.equal(typeof config.manifestPath, 'string');
  assert.equal(typeof config.reportPath, 'string');
  assert.equal(typeof config.capsuleId, 'string');
  assert.ok(/^[A-Za-z0-9_-]{1,128}$/.test(config.capsuleId));
  assert.ok(Number.isInteger(config.watchdogMs) && config.watchdogMs > 0);
  app.setPath('userData', config.profile);
  const manifest = JSON.parse(readFileSync(config.manifestPath, 'utf8'));
  assert.equal(manifest.schema, 'e2e-fake-manifest/v1');
  assert.ok(Array.isArray(manifest.capsules) && manifest.capsules.length > 0);
  const capsuleId = config.capsuleId;
  assert.ok(manifest.capsules.some((row) => row.capsuleId === capsuleId));
  const tileSel = `[data-capsule-id="${capsuleId}"]`;
  const controlSel = `[data-semantic-anchor="capsule/${capsuleId}/control"]`;
  /** Pause between input steps so layout settles. */
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  const failReport = (message) => {
    try {
      writeFileSync(config.reportPath, `${JSON.stringify({
        schema: 'e2e-control-report/v1',
        phase: 'control',
        capsuleId,
        affordance_present: false,
        take_clicked: false,
        release_clicked: false,
        host_refused: false,
        host_error: '',
        tile_state_before: null,
        tile_state_after: null,
        frame_before: null,
        frame_after: null,
        errors: [String(message).slice(0, 512)],
      })}\n`, 'utf8');
    } catch {
      // Report write failure still exits nonzero below.
    }
  };
  setTimeout(() => {
    failReport('control probe watchdog expired');
    app.exit(2);
  }, config.watchdogMs).unref();
  app.on('browser-window-created', (_, win) => {
    const errors = [];
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 3) {
        errors.push(String(event.message).slice(0, 512));
      }
    });
    win.webContents.once('did-finish-load', async () => {
      try {
        const wc = win.webContents;
        const mount = await wc.executeJavaScript('!!document.querySelector("#metaviewer-app")');
        assert.equal(mount, true, 'wall mount #metaviewer-app must exist');
        const sampleCode = `(function(tileSel, controlSel){`
          + `const tile = document.querySelector(tileSel);`
          + `if (!tile) return null;`
          + `const host = tile.closest('[data-tile-state]');`
          + `const frame = tile.querySelector('[data-frame-tag]');`
          + `const button = document.querySelector(controlSel);`
          + `let rect = null;`
          + `if (button) {`
          + `const box = button.getBoundingClientRect();`
          + `rect = { x: box.x + box.width / 2, y: box.y + box.height / 2 };`
          + `}`
          + `return { visible: tile.checkVisibility(),`
          + `tileState: host ? host.getAttribute('data-tile-state') : null,`
          + `frameTag: frame ? frame.getAttribute('data-frame-tag') : null,`
          + `controlPresent: !!button, controlRect: rect };`
          + `})(${JSON.stringify(tileSel)}, ${JSON.stringify(controlSel)})`;
        const sample = () => wc.executeJavaScript(sampleCode);
        const deadline = Date.now() + Math.floor(config.watchdogMs / 2);
        let observed = null;
        do {
          observed = await sample();
          if (observed && observed.visible && observed.frameTag !== null) break;
          await pause(50);
        } while (Date.now() < deadline);
        assert.ok(observed, 'control tile missing');
        assert.ok(observed.visible && observed.frameTag !== null,
          'control tile never became visible with a frame');
        const tileStateBefore = observed.tileState;
        const frameBefore = observed.frameTag;
        const affordancePresent = observed.controlPresent === true;
        let takeClicked = false;
        let releaseClicked = false;
        if (affordancePresent) {
          const click = async () => {
            const current = await sample();
            assert.ok(current && current.controlRect, 'control affordance lost before click');
            const x = Math.round(current.controlRect.x);
            const y = Math.round(current.controlRect.y);
            wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
            wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
          };
          await click();
          takeClicked = true;
          await pause(300);
          assert.equal((await sample()).tileState, 'human-control', 'take must change the authoritative tile state');
          await click();
          releaseClicked = true;
          await pause(300);
          assert.equal((await sample()).tileState, tileStateBefore, 'release must restore the authoritative tile state');
        }
        const after = await sample();
        const hostError = errors.find((entry) => entry.includes(
          'Fixture cannot dispatch host actions')) || '';
        const report = {
          schema: 'e2e-control-report/v1',
          phase: 'control',
          capsuleId,
          affordance_present: affordancePresent,
          take_clicked: takeClicked,
          release_clicked: releaseClicked,
          host_refused: hostError !== '',
          host_error: hostError.slice(0, 512),
          tile_state_before: tileStateBefore,
          tile_state_after: after ? after.tileState : null,
          frame_before: frameBefore,
          frame_after: after ? after.frameTag : null,
          errors: errors.slice(0, 16),
        };
        writeFileSync(config.reportPath, `${JSON.stringify(report)}\n`, 'utf8');
        app.exit(0);
      } catch (error) {
        failReport((error && error.stack) || error);
        app.exit(1);
      }
    });
  });
  process.env.MV_E2E_MANIFEST = config.manifestPath;
  await import(config.mainUrl);
}

/**
 * Render the control probe file text embedding a validated config. The
 * config travels as JSON, so no caller string can inject code.
 * @param {{ profile: string, mainUrl: string, manifestPath: string,
 * reportPath: string, capsuleId: string, watchdogMs?: number }} config Probe config.
 * @returns {string} Probe file text.
 */
function renderControlProbeFile(config) {
  if (typeof config !== 'object' || config === null) {
    throw new E2EError('E2E_ARGS', 'control probe config must be an object');
  }
  if (typeof config.profile !== 'string' || config.profile.length === 0) {
    throw new E2EError('E2E_ARGS', 'control probe profile must be a non-empty string');
  }
  const profile = resolve(config.profile);
  if (typeof config.mainUrl !== 'string' || !config.mainUrl.startsWith('file://')) {
    throw new E2EError('E2E_ARGS', 'control probe mainUrl must be a file URL');
  }
  if (typeof config.manifestPath !== 'string' || config.manifestPath.length === 0
    || typeof config.reportPath !== 'string' || config.reportPath.length === 0) {
    throw new E2EError('E2E_ARGS', 'control probe manifest and report paths are required');
  }
  tileSelector(config.capsuleId);
  const watchdogMs = config.watchdogMs === undefined
    ? PROBE_WATCHDOG_MS
    : config.watchdogMs;
  if (typeof watchdogMs !== 'number' || !Number.isInteger(watchdogMs) || watchdogMs <= 0) {
    throw new E2EError('E2E_ARGS', 'control probe watchdogMs must be a positive integer');
  }
  const frozen = {
    profile,
    mainUrl: config.mainUrl,
    manifestPath: resolve(config.manifestPath),
    reportPath: resolve(config.reportPath),
    capsuleId: config.capsuleId,
    watchdogMs,
  };
  return `(${controlProbeMain.toString()})(${JSON.stringify(frozen)});`;
}

/**
 * Build a valid control-journey witness object.
 * @returns {Record<string, unknown>} Fresh valid witness.
 */
function validWitness() {
  return {
    schema: CONTROL_REPORT_SCHEMA,
    phase: CONTROL_PHASE,
    capsuleId: 'ac04-ctrl-a',
    epoch_before: 1,
    epoch_after_take: 1,
    epoch_after_release: 1,
    pending_before: ['proposal-ac04-pending'],
    draining_before_take: [],
    take: {
      cancelled: ['proposal-ac04-pending'],
      cancellation_reason: 'SURFACE_NOT_AGENT_CONTROLLED',
      control_ready: true,
      agent_controlled: false,
    },
    during_control_verdict: 'SURFACE_NOT_AGENT_CONTROLLED',
    release: { agent_controlled: true, refresh_fence_seq: 41 },
    pre_refresh_verdict: 'STALE_FRAME',
    post_frame: { generation: 3, core_seq: 44 },
    post_refresh_verdict: null,
    errors: [],
  };
}

/**
 * Build a valid control probe report object (UI half, host ready).
 * @returns {Record<string, unknown>} Fresh valid probe report.
 */
function validProbeReport() {
  return {
    schema: CONTROL_REPORT_SCHEMA,
    phase: CONTROL_PHASE,
    capsuleId: 'ac04-ctrl-a',
    affordance_present: true,
    take_clicked: true,
    release_clicked: true,
    host_refused: false,
    host_error: '',
    tile_state_before: 'live',
    tile_state_after: 'live',
    frame_before: 'frame-ac04-ctrl-a-gen7',
    frame_after: 'frame-ac04-ctrl-a-gen8',
    errors: [],
  };
}

describe('ac04 control arbitration contract', () => {
  it('selects the control tile and its control button by stable ids', () => {
    assert.equal(wallTileListSelector(), '[data-capsule-id]');
    assert.equal(tileSelector('ac04-ctrl-a'), '[data-capsule-id="ac04-ctrl-a"]');
    assert.equal(controlAnchorSelector('ac04-ctrl-a'),
      '[data-semantic-anchor="capsule/ac04-ctrl-a/control"]');
  });

  it('negative control: malformed capsule ids cannot build control selectors', () => {
    for (const bad of ['', 'has space', 'quote"break', 'slash/break', 'x'.repeat(129), 7, null]) {
      rejectsWith(() => controlAnchorSelector(bad), ['E2E_ARGS']);
    }
  });

  it('accepts a valid control-journey witness', () => {
    const summary = validateControlJourneyWitness(validWitness());
    assert.equal(summary.capsuleId, 'ac04-ctrl-a');
    assert.deepEqual(summary.cancelled, ['proposal-ac04-pending']);
    assert.equal(summary.admitted, true);
    assert.deepEqual(summary.errors, []);
  });

  it('negative control: proposal admitted during human control is refused (AC-04 negative)', () => {
    const mutant = validWitness();
    mutant.during_control_verdict = null;
    rejectsWith(() => validateControlJourneyWitness(mutant), ['E2E_CONTROL']);
  });

  it('negative control: wrong refusal during human control is refused', () => {
    for (const wrong of ['STALE_FRAME', 'LOCKED_BY_OTHER', 'BUDGET_EXCEEDED', 'OUT_OF_BOUNDS',
      'POLICY', 'surface_not_agent_controlled', '']) {
      const mutant = validWitness();
      mutant.during_control_verdict = wrong;
      rejectsWith(() => validateControlJourneyWitness(mutant), ['E2E_CONTROL']);
    }
  });

  it('negative control: take_control leaving a pending proposal live is refused', () => {
    const mutant = validWitness();
    mutant.pending_before = ['proposal-ac04-pending', 'proposal-ac04-second'];
    mutant.take = {
      cancelled: ['proposal-ac04-pending'],
      cancellation_reason: 'SURFACE_NOT_AGENT_CONTROLLED',
      control_ready: true,
      agent_controlled: false,
    };
    rejectsWith(() => validateControlJourneyWitness(mutant), ['E2E_CONTROL']);
  });

  it('negative control: take_control cancelling nothing while pending exists is refused', () => {
    const mutant = validWitness();
    mutant.take = {
      cancelled: [],
      cancellation_reason: 'SURFACE_NOT_AGENT_CONTROLLED',
      control_ready: true,
      agent_controlled: false,
    };
    rejectsWith(() => validateControlJourneyWitness(mutant), ['E2E_CONTROL']);
  });

  it('negative control: take_control with a wrong cancellation reason is refused', () => {
    const mutant = validWitness();
    mutant.take = {
      cancelled: ['proposal-ac04-pending'],
      cancellation_reason: 'POLICY',
      control_ready: true,
      agent_controlled: false,
    };
    rejectsWith(() => validateControlJourneyWitness(mutant), ['E2E_CONTROL']);
  });

  it('negative control: take_control keeping agent control is refused', () => {
    const mutant = validWitness();
    mutant.take = {
      cancelled: ['proposal-ac04-pending'],
      cancellation_reason: 'SURFACE_NOT_AGENT_CONTROLLED',
      control_ready: true,
      agent_controlled: true,
    };
    rejectsWith(() => validateControlJourneyWitness(mutant), ['E2E_CONTROL']);
  });

  it('negative control: control_ready disagreeing with the drain set is refused', () => {
    const mutant = validWitness();
    mutant.draining_before_take = ['ac04-ctrl-a'];
    setTakeReady(mutant, true);
    rejectsWith(() => validateControlJourneyWitness(mutant), ['E2E_CONTROL']);
    const mutant2 = validWitness();
    setTakeReady(mutant2, false);
    rejectsWith(() => validateControlJourneyWitness(mutant2), ['E2E_CONTROL']);
  });

  it('negative control: epoch moved by take_control or release_control is refused', () => {
    const takeMutant = validWitness();
    takeMutant.epoch_after_take = 2;
    rejectsWith(() => validateControlJourneyWitness(takeMutant), ['E2E_CONTROL']);
    const releaseMutant = validWitness();
    releaseMutant.epoch_after_release = 2;
    rejectsWith(() => validateControlJourneyWitness(releaseMutant), ['E2E_CONTROL']);
  });

  it('negative control: release_control keeping the surface human-held is refused', () => {
    const mutant = validWitness();
    mutant.release = { agent_controlled: false, refresh_fence_seq: 41 };
    rejectsWith(() => validateControlJourneyWitness(mutant), ['E2E_CONTROL']);
  });

  it('negative control: proposal admitted before the post-release frame is refused', () => {
    const mutant = validWitness();
    mutant.pre_refresh_verdict = null;
    rejectsWith(() => validateControlJourneyWitness(mutant), ['E2E_CONTROL']);
  });

  it('negative control: post-release frame at or below the fence is refused', () => {
    const atFence = validWitness();
    atFence.post_frame = { generation: 3, core_seq: 41 };
    rejectsWith(() => validateControlJourneyWitness(atFence), ['E2E_CONTROL']);
    const belowFence = validWitness();
    belowFence.post_frame = { generation: 3, core_seq: 40 };
    rejectsWith(() => validateControlJourneyWitness(belowFence), ['E2E_CONTROL']);
  });

  it('negative control: refused proposal after the fresh frame is refused', () => {
    const mutant = validWitness();
    mutant.post_refresh_verdict = 'STALE_FRAME';
    rejectsWith(() => validateControlJourneyWitness(mutant), ['E2E_CONTROL']);
  });

  it('negative control: witness with an extra key is refused (closed object)', () => {
    const mutant = { ...validWitness(), debug: true };
    rejectsWith(() => validateControlJourneyWitness(mutant), ['E2E_REPORT']);
    const nested = validWitness();
    nested.take = {
      cancelled: ['proposal-ac04-pending'],
      cancellation_reason: 'SURFACE_NOT_AGENT_CONTROLLED',
      control_ready: true,
      agent_controlled: false,
      debug: true,
    };
    rejectsWith(() => validateControlJourneyWitness(nested), ['E2E_REPORT']);
  });

  it('negative control: witness with a wrong schema tag is refused', () => {
    const mutant = validWitness();
    mutant.schema = 'e2e-wall-report/v1';
    rejectsWith(() => validateControlJourneyWitness(mutant), ['E2E_REPORT']);
  });

  it('negative control: non-object and malformed witnesses are refused', () => {
    for (const bad of [null, [], 'text', 42, { schema: CONTROL_REPORT_SCHEMA }]) {
      rejectsWith(() => validateControlJourneyWitness(bad), ['E2E_REPORT']);
    }
    const badId = validWitness();
    badId.capsuleId = 'bad id';
    rejectsWith(() => validateControlJourneyWitness(badId), ['E2E_ARGS']);
  });

  it('accepts valid surface_request take_control and release_control ops', () => {
    const take = checkSurfaceRequestControlOp({
      schema: 'surface_request/v0.2',
      op: 'take_control',
      params: { surface_id: 'surface-ac04-1', owner: 'human' },
    });
    assert.equal(take.op, 'take_control');
    assert.equal(take.params.owner, 'human');
    const release = checkSurfaceRequestControlOp({
      schema: 'surface_request/v0.2',
      op: 'release_control',
      params: { surface_id: 'surface-ac04-1' },
    });
    assert.equal(release.op, 'release_control');
  });

  it('negative control: malformed surface_request control ops are refused', () => {
    rejectsWith(() => checkSurfaceRequestControlOp({
      schema: 'surface_request/v0.2',
      op: 'take_control',
      params: { surface_id: 'surface-ac04-1' },
    }), ['E2E_CONTRACT']);
    rejectsWith(() => checkSurfaceRequestControlOp({
      schema: 'surface_request/v0.2',
      op: 'take_control',
      params: { surface_id: 'surface-ac04-1', owner: 'robot' },
    }), ['E2E_CONTRACT']);
    rejectsWith(() => checkSurfaceRequestControlOp({
      schema: 'surface_request/v0.2',
      op: 'release_control',
      params: { surface_id: 'surface-ac04-1', owner: 'human' },
    }), ['E2E_CONTRACT']);
    rejectsWith(() => checkSurfaceRequestControlOp({
      schema: 'surface_request/v0.2',
      op: 'seize_control',
      params: { surface_id: 'surface-ac04-1' },
    }), ['E2E_CONTRACT']);
  });

  it('accepts valid ui_intent take_control and release_control ops', () => {
    const take = checkUiIntentControlOp({
      schema: 'ui_intent/v0.2',
      request_id: 'ac04-take-1',
      op: 'take_control',
      params: { surface_id: 'surface-ac04-1' },
    });
    assert.equal(take.request_id, 'ac04-take-1');
    const release = checkUiIntentControlOp({
      schema: 'ui_intent/v0.2',
      request_id: 'ac04-release-1',
      op: 'release_control',
      params: { surface_id: 'surface-ac04-1' },
    });
    assert.equal(release.op, 'release_control');
  });

  it('negative control: malformed ui_intent control ops are refused', () => {
    rejectsWith(() => checkUiIntentControlOp({
      schema: 'ui_intent/v0.2',
      request_id: 'bad id!',
      op: 'take_control',
      params: { surface_id: 'surface-ac04-1' },
    }), ['E2E_CONTRACT']);
    rejectsWith(() => checkUiIntentControlOp({
      schema: 'ui_intent/v0.2',
      request_id: 'ac04-take-1',
      op: 'take_control',
      params: {},
    }), ['E2E_CONTRACT']);
    rejectsWith(() => checkUiIntentControlOp({
      schema: 'ui_intent/v0.1',
      request_id: 'ac04-take-1',
      op: 'take_control',
      params: { surface_id: 'surface-ac04-1' },
    }), ['E2E_CONTRACT']);
  });

  it('accepts the ratified surface control values and refuses the rest', () => {
    assert.equal(checkSurfaceControl('agent'), 'agent');
    assert.equal(checkSurfaceControl('human'), 'human');
    assert.equal(checkSurfaceControl('shared'), 'shared');
    for (const bad of ['robot', 'HUMAN', '', null, 7]) {
      rejectsWith(() => checkSurfaceControl(bad), ['E2E_CONTRACT']);
    }
  });

  it('accepts a valid control probe report and refuses malformed ones', () => {
    const summary = validateControlProbeReport(validProbeReport());
    assert.equal(summary.capsuleId, 'ac04-ctrl-a');
    assert.equal(summary.take_clicked, true);
    assert.equal(summary.host_refused, false);
    const mutant = { ...validProbeReport(), debug: true };
    rejectsWith(() => validateControlProbeReport(mutant), ['E2E_REPORT']);
    const badFlag = validProbeReport();
    badFlag.take_clicked = 'yes';
    rejectsWith(() => validateControlProbeReport(badFlag), ['E2E_REPORT']);
    for (const bad of [null, [], 'text', 42]) {
      rejectsWith(() => validateControlProbeReport(bad), ['E2E_REPORT']);
    }
  });

  it('renders the control probe file with the config as inert JSON', () => {
    const text = renderControlProbeFile({
      profile: '/tmp/mv0-ac04-profile',
      mainUrl: 'file:///repo/tests/e2e/live-main.cjs',
      manifestPath: '/tmp/mv0-ac04-manifest.json',
      reportPath: '/tmp/mv0-ac04-report.json',
      capsuleId: 'ac04-ctrl-a',
    });
    assert.ok(text.includes('e2e-control-report/v1'));
    assert.ok(text.includes('/tmp/mv0-ac04-report.json'));
    assert.ok(text.includes('ac04-ctrl-a'));
    rejectsWith(() => renderControlProbeFile({
      profile: '/tmp/p',
      mainUrl: 'https://example.invalid/main.js',
      manifestPath: '/tmp/m.json',
      reportPath: '/tmp/r.json',
      capsuleId: 'ac04-ctrl-a',
    }), ['E2E_ARGS']);
    rejectsWith(() => renderControlProbeFile({
      profile: '/tmp/p',
      mainUrl: 'file:///repo/tests/e2e/live-main.cjs',
      manifestPath: '/tmp/m.json',
      reportPath: '/tmp/r.json',
      capsuleId: 'bad id',
    }), ['E2E_ARGS']);
  });
});

/**
 * Rewrite the take control_ready flag of a witness fixture.
 * @param {Record<string, unknown>} witness Fixture to adjust.
 * @param {boolean} ready Replacement flag.
 */
function setTakeReady(witness, ready) {
  const take = /** @type {Record<string, unknown>} */ (witness.take);
  witness.take = { ...take, control_ready: ready };
}

/**
 * Rust arbitration script for the live core half of the journey. Admit one
 * proposal before take_control (so cancellation is non-vacuous), take
 * control, propose during human control, release, propose before the fresh
 * frame, publish the fresh frame, and propose again. Prints one marker line
 * per step; the test asserts every line exactly.
 */
const CORE_ARBITRATION_SCRIPT = `
use metaviewer_core::admission::*;
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;

fn proposal(id: &str, seq: u64, nonce: &str, sha: &str, generation: u64) -> serde_json::Value {
    serde_json::json!({
        "schema": "envelope/v0.2",
        "msg_id": format!("msg-{id}"),
        "ts_ns": 0,
        "from": {"component": "agent", "instance": "agent-1"},
        "to": {"component": "core", "instance": "authority"},
        "session_id": "ac04-1",
        "seq": seq,
        "nonce": nonce,
        "body": {
            "schema": "action_proposal/v0.2",
            "proposal_id": id,
            "surface_id": "surface-ac04-1",
            "based_on_frame": {"sha256": sha, "generation": generation},
            "action": {"type": "click", "x": 10, "y": 10, "button": "left"},
            "expectation": {"type": "text_present", "text": "ok"},
            "budget": {"max_ms": 100, "max_retries": 0}
        }
    })
}

fn agent() -> metaviewer_core::Endpoint {
    metaviewer_core::Endpoint { component: metaviewer_core::Component::Agent, instance: "agent-1".into() }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let root = PathBuf::from(&args[1]);
    fs::DirBuilder::new().mode(0o700).recursive(true).create(&root).unwrap();
    let initial = CoreState::session("ac04-1").unwrap();
    let mut authority = Authority::create(&root, initial).unwrap();
    authority.apply(Input::Connect).unwrap();

    let w1 = authority.retain_witness(b"ac04-frame-gen-1").unwrap();
    let w2 = authority.retain_witness(b"ac04-frame-gen-2").unwrap();
    let w3 = authority.retain_witness(b"ac04-frame-gen-3").unwrap();

    let surface = Surface {
        display: "display-1".into(),
        owner: agent(),
        agent_controlled: true,
        live: true,
        frame: Some(Frame { sha256: w1.sha256.clone(), generation: 1, width: 100, height: 100 }),
        refresh_after: None,
        allowed_verbs: vec![],
    };
    authority.apply_with_witnesses(Input::Surface { id: "surface-ac04-1".into(), surface }, vec![w1.clone()]).unwrap();

    let pending = AdmissionRequest::decode(
        &proposal("proposal-ac04-pending", 1, "nonce-ac04-pending", &w1.sha256, 1).to_string(),
        &agent(), "ac04-1", 1, 0).unwrap();
    let pending_out = authority.apply_with_witnesses(Input::Propose(pending), vec![w1.clone()]).unwrap();
    println!("PENDING_ADMITTED:{:?}", pending_out.reason);

    let take_out = authority.apply(Input::TakeControl { surface_id: "surface-ac04-1".into() }).unwrap();
    println!("TAKE_CANCELLED:{}", take_out.cancelled.join(","));
    println!("TAKE_REASON:{:?}", take_out.cancellation_reason);
    println!("TAKE_READY:{}", take_out.control_ready);
    println!("EPOCH_TAKE:{}", authority.state().epoch);

    authority.apply_with_witnesses(Input::Frame {
        surface_id: "surface-ac04-1".into(),
        frame: Frame { sha256: w2.sha256.clone(), generation: 2, width: 100, height: 100 },
    }, vec![w2.clone()]).unwrap();

    let during = AdmissionRequest::decode(
        &proposal("proposal-ac04-during", 2, "nonce-ac04-during", &w2.sha256, 2).to_string(),
        &agent(), "ac04-1", 1, 0).unwrap();
    let during_out = authority.apply_with_witnesses(Input::Propose(during), vec![w2.clone()]).unwrap();
    println!("DURING:{:?}", during_out.reason);

    let release_out = authority.apply(Input::ReleaseControl { surface_id: "surface-ac04-1".into() }).unwrap();
    println!("EPOCH_RELEASE:{}", authority.state().epoch);
    println!("RELEASE_SEQ:{}", release_out.core_seq);

    let prerefresh = AdmissionRequest::decode(
        &proposal("proposal-ac04-prerefresh", 3, "nonce-ac04-prerefresh", &w2.sha256, 2).to_string(),
        &agent(), "ac04-1", 1, 0).unwrap();
    let prerefresh_out = authority.apply_with_witnesses(Input::Propose(prerefresh), vec![w2]).unwrap();
    println!("PREREFRESH:{:?}", prerefresh_out.reason);

    let frame_out = authority.apply_with_witnesses(Input::Frame {
        surface_id: "surface-ac04-1".into(),
        frame: Frame { sha256: w3.sha256.clone(), generation: 3, width: 100, height: 100 },
    }, vec![w3.clone()]).unwrap();
    println!("FRAME_SEQ:{}", frame_out.core_seq);

    let post = AdmissionRequest::decode(
        &proposal("proposal-ac04-post", 4, "nonce-ac04-post", &w3.sha256, 3).to_string(),
        &agent(), "ac04-1", 1, 0).unwrap();
    let post_out = authority.apply_with_witnesses(Input::Propose(post), vec![w3]).unwrap();
    println!("POST:{:?}", post_out.reason);
}
`;

/**
 * Run the core arbitration script and return its marker lines.
 * @param {string} scratch Absolute scratch directory.
 * @returns {string[]} Marker lines.
 */
function runArbitrationScript(scratch) {
  try {
    return runRust(scratch, CORE_ARBITRATION_SCRIPT).trim().split('\n');
  } catch (error) {
    const detail = String((error && error.message) || error).slice(0, 300);
    throw new E2EError('E2E_PREREQ', `core arbitration harness refused: ${detail}`);
  }
}

describe('ac04 live control journey', () => {
  it('core arbitration: take cancels pending, control refuses, release plus refresh resumes (AC-04)', () => {
    const pathEnv = process.env.PATH || '';
    if (!process.env.CARGO && !whichBinary('cargo', pathEnv)) {
      throw new E2EError('E2E_PREREQ', 'cargo not installed on PATH');
    }
    if (!process.env.RUSTC && !whichBinary('rustc', pathEnv)) {
      throw new E2EError('E2E_PREREQ', 'rustc not installed on PATH');
    }
    const scratch = makeScratch('mv0-ac04-core');
    try {
      const lines = runArbitrationScript(scratch);
      assert.equal(lines.length, 11);
      assert.equal(lines[0], 'PENDING_ADMITTED:None');
      assert.equal(lines[1], 'TAKE_CANCELLED:proposal-ac04-pending');
      assert.equal(lines[2], 'TAKE_REASON:Some(SurfaceNotAgentControlled)');
      assert.equal(lines[3], 'TAKE_READY:true');
      assert.equal(lines[4], 'EPOCH_TAKE:1');
      assert.equal(lines[5], 'DURING:Some(SurfaceNotAgentControlled)');
      assert.equal(lines[6], 'EPOCH_RELEASE:1');
      assert.equal(lines[8], 'PREREFRESH:Some(StaleFrame)');
      assert.equal(lines[10], 'POST:None');
      const fence = Number(String(lines[7]).replace('RELEASE_SEQ:', ''));
      const frameSeq = Number(String(lines[9]).replace('FRAME_SEQ:', ''));
      assert.ok(Number.isInteger(fence) && Number.isInteger(frameSeq));
      const witness = {
        ...validWitness(),
        pending_before: ['proposal-ac04-pending'],
        release: { agent_controlled: true, refresh_fence_seq: fence },
        post_frame: { generation: 3, core_seq: frameSeq },
      };
      const summary = validateControlJourneyWitness(witness);
      assert.equal(summary.admitted, true);
      assert.deepEqual(summary.cancelled, ['proposal-ac04-pending']);
    } finally {
      removeScratch(scratch);
    }
  });

  it('wall tile take and release control through the control button (AC-04)', {
    todo: 'GAP-AC04-CONTROL-OWNER: ui/src/core/hostAdapters.js:100-102 emits control, SurfacePanel.vue:325 forwards it unchanged; kit CapsulePanel.vue:382,1653 reads controlOwner, so the second click takes control again',
  }, () => {
    require('./ac-harness.cjs').prepareWall();
    requireXvfb();
    const root = findRepoRoot(__dirname);
    const electron = electronBinary(root);
    const buildDir = process.env[BUILD_ENV] || '';
    if (buildDir === '' || !existsSync(join(buildDir, 'index.html'))) {
      throw new E2EError('E2E_PREREQ', 'built wall absent: run.py stages MV_E2E_BUILD first');
    }
    const scratch = makeScratch('mv0-ac04-live');
    try {
      const manifestPath = writeFakeManifest(scratch, AC04_FAKES);
      const reportPath = join(scratch, 'control-report.json');
      const mainEntry = join(root, 'tests', 'e2e', 'live-main.cjs');
      writeFileSync(join(scratch, 'probe.cjs'), `${renderControlProbeFile({
        profile: join(scratch, 'profile'),
        mainUrl: require('node:url').pathToFileURL(mainEntry).href,
        manifestPath,
        reportPath,
        capsuleId: AC04_FAKES[0].capsuleId,
      })}\n`, 'utf8');
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
        let text;
        try {
          text = readFileSync(reportPath, 'utf8');
        } catch {
          throw new E2EError('E2E_REPORT', 'control probe report unreadable');
        }
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new E2EError('E2E_REPORT', 'control probe report is not JSON');
        }
        summary = validateControlProbeReport(parsed);
      } catch (error) {
        if (!(error instanceof E2EError)) throw error;
        const seen = existsSync(reportPath) ? readFileSync(reportPath, 'utf8').slice(0, 3000) : 'absent';
        throw new E2EError(error.code, `${error.message} | report: ${seen} | process: ${diagnostic}`);
      }
      assert.equal(outcome.timedOut, false, diagnostic);
      assert.equal(outcome.status, 0,
        `probe errors: ${summary.errors.join(' | ').slice(0, 2000)} | process: ${diagnostic}`);
      if (!summary.affordance_present) {
        throw new E2EError('E2E_PREREQ', 'control affordance absent on the tile');
      }
      if (summary.host_refused) {
        assert.ok(summary.host_error.includes(FIXTURE_REFUSAL_MARK), diagnostic);
        throw new E2EError('E2E_PREREQ',
          `control host unready: ${summary.host_error.slice(0, 200)}`);
      }
      assert.equal(summary.take_clicked, true, diagnostic);
      assert.equal(summary.release_clicked, true, diagnostic);
      assert.ok(summary.frame_before !== null && summary.frame_after !== null, diagnostic);
      assert.ok(summary.frame_before !== summary.frame_after,
        `release must refresh the frame | process: ${diagnostic}`);
      assert.deepEqual(summary.errors, [], diagnostic);
    } finally {
      removeScratch(scratch);
    }
  });
});

