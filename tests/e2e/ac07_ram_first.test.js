'use strict';

/**
 * E2E AC-07 RAM-first journey (roadmap: record-for-AI and screenshots in RAM).
 *
 * Runs under node --test; locates the repo root from its own path. Two layers:
 *
 * 1. Contract tests: pure validation of record_request shapes, the
 *    closed storage-audit report, snapshot diffs and the bounded
 *    directory walker, each paired with mutant fixtures that must
 *    FAIL the same assertions a leaky recorder would trip. These run
 *    on every host with node alone.
 * 2. The live RAM-first journey: verifies the live prerequisites,
 *    executes the must-FAIL control (disk recording without a host
 *    destination refuses), and refuses with a typed E2E_* error while
 *    the recording surface is still a stub. It never skips.
 *
 * CI entry (tests/e2e/run.py): exec `node --test` over this suite with
 * the AC harness and the repository root as cwd, and exit nonzero on
 * any failure.
 *
 * @module ac07_ram_first
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { join, resolve, sep } = require('node:path');

const {
  E2EError,
  electronBinary,
  findRepoRoot,
  makeScratch,
  removeScratch,
  requireXvfb,
} = require('./ac-harness.cjs');

/** Env flag arming the live journey; anything else refuses the run. */
/** Env override for the live soak window; unset means the roadmap default. */
const SOAK_ENV = 'MV_E2E_SOAK_MS';
/** Closed record_request schema tag (contracts/v0.2/record_request.schema.json). */
const RECORD_SCHEMA = 'record_request/v0.2';
/** [TARGET, unit decision] Closed storage-audit report tag owned by this suite. */
const AUDIT_SCHEMA = 'e2e-ram-audit/v1';
/** Only audit phase this suite exercises. */
const AUDIT_PHASE = 'ram_first';
/** RAM root for frames, recordings and screenshots (Storage Law). */
const RAM_ROOT = '/dev/shm';
/** Roadmap 5-minute recording window; soak default, CI may override down. */
const RECORD_SOAK_MS = 300000;
/** Upper bound for the soak override so a typo cannot hang the gate. */
const MAX_SOAK_MS = 3600000;
/** Cap on audit report file bytes. */
const MAX_AUDIT_BYTES = 1024 * 1024;
/** Cap on snapshot entries per root. */
const MAX_SNAPSHOT_FILES = 4096;
/** Cap on snapshot walk depth. */
const MAX_SNAPSHOT_DEPTH = 12;
/** Cap on recorded byte counts (recording size cap). */
const MAX_RECORD_BYTES = 1073741824;
/** Record request ops from the contract oneOf branches. */
const RECORD_OPS = Object.freeze(['ram_start', 'ram_stop', 'disk_start', 'disk_stop', 'screenshot']);
/** Storage-audit artifact kinds. */
const ARTIFACT_KINDS = Object.freeze(['ram_recording', 'screenshot', 'disk_export']);
/** Identifier charset shared by requests, surfaces and recordings. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Absolute host path syntax (never authorization). */
const ABS_PATH_PATTERN = /^\/[^\u0000\r\n]*$/;
/** Marker left in unimplemented core modules until their unit lands. */
const STUB_MARKER = 'Reserved for';

/**
 * @param {string} code Stable refusal code.
 * @param {string} message Human detail.
 * @returns {never}
 */
function fail(code, message) {
  throw new E2EError(code, message);
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
    fail(code, `${label} has unexpected keys: ${keys.join(',')}`);
  }
}

/**
 * @param {unknown} value Candidate.
 * @param {string} label Field label for the error.
 * @param {string} code Domain refusal code for the caller.
 * @returns {string} The validated identifier.
 */
function checkRecordId(value, label, code) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !ID_PATTERN.test(value)) {
    fail(code, `${label} must match ^[A-Za-z0-9][A-Za-z0-9._:-]*$ (1..128)`);
  }
  return /** @type {string} */ (value);
}

/**
 * @param {unknown} value Candidate.
 * @param {string} label Field label for the error.
 * @param {number} min Inclusive lower bound.
 * @param {number} max Inclusive upper bound.
 * @param {string} code Domain refusal code for the caller.
 * @returns {number} The validated integer.
 */
function checkInt(value, label, min, max, code) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(code, `${label} must be an integer ${min}..${max}`);
  }
  return /** @type {number} */ (value);
}

/**
 * Absolute-path syntax check; callers decide authorization separately.
 * @param {unknown} value Candidate.
 * @param {string} label Field label for the error.
 * @param {string} code Domain refusal code for the caller.
 * @returns {string} The validated path.
 */
function checkAbsPath(value, label, code) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
      || !ABS_PATH_PATTERN.test(value)) {
    fail(code, `${label} must be an absolute path 1..4096`);
  }
  return /** @type {string} */ (value);
}

/**
 * Containment of a candidate path strictly inside a directory after
 * normalization, so `..` escapes and prefix siblings refuse.
 * @param {unknown} candidate Candidate file path.
 * @param {unknown} dir Containing directory.
 * @returns {boolean} True only when normalized inside.
 */
function isPathUnder(candidate, dir) {
  if (typeof candidate !== 'string' || typeof dir !== 'string') return false;
  if (!candidate.startsWith('/') || !dir.startsWith('/')) return false;
  const full = resolve(candidate);
  const root = resolve(dir);
  return full.startsWith(`${root}${sep}`);
}

/**
 * @typedef {object} RecordRequest Normalized record request.
 * @property {string} schema Always record_request/v0.2.
 * @property {string} request_id Caller request id.
 * @property {string} op One of the RECORD_OPS literals.
 * @property {Record<string, unknown>} params Validated op params.
 */

/**
 * Strict closed validation of a record_request envelope. A disk_start
 * naming no host destination refuses with E2E_DESTINATION before any
 * shape check, so the must-FAIL control keeps its typed refusal.
 * @param {unknown} value Parsed record request.
 * @returns {RecordRequest} Normalized request.
 */
function validateRecordRequest(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('E2E_RECORD', 'record request must be an object');
  }
  const request = /** @type {Record<string, unknown>} */ (value);
  needClosedKeys(request, ['schema', 'request_id', 'op', 'params'], 'record request', 'E2E_RECORD');
  if (request.schema !== RECORD_SCHEMA) fail('E2E_RECORD', 'record request schema mismatch');
  const requestId = checkRecordId(request.request_id, 'request_id', 'E2E_RECORD');
  if (typeof request.op !== 'string' || !RECORD_OPS.includes(request.op)) {
    fail('E2E_RECORD', `op must be one of ${RECORD_OPS.join(',')}`);
  }
  const op = /** @type {string} */ (request.op);
  if (typeof request.params !== 'object' || request.params === null || Array.isArray(request.params)) {
    fail('E2E_RECORD', 'record params must be an object');
  }
  const params = /** @type {Record<string, unknown>} */ (request.params);
  if (op === 'disk_start') {
    checkRecordId(params.destination_capability_id, 'destination_capability_id', 'E2E_DESTINATION');
    checkAbsPath(params.destination_path, 'destination_path', 'E2E_DESTINATION');
  }
  /** @type {ReadonlyArray<string>} */
  let want;
  switch (op) {
    case 'ram_start':
      want = ['surface_id', 'recording_id', 'ring_bytes', 'max_fps'];
      break;
    case 'ram_stop':
    case 'disk_stop':
      want = ['surface_id', 'recording_id'];
      break;
    case 'disk_start':
      want = ['surface_id', 'recording_id', 'destination_capability_id', 'destination_path', 'max_fps'];
      break;
    case 'screenshot':
      want = ['surface_id', 'capture_id'];
      break;
    default:
      fail('E2E_RECORD', `op must be one of ${RECORD_OPS.join(',')}`);
      want = [];
      break;
  }
  needClosedKeys(params, want, `${op} params`, 'E2E_RECORD');
  checkRecordId(params.surface_id, 'surface_id', 'E2E_RECORD');
  if (params.recording_id !== undefined) {
    checkRecordId(params.recording_id, 'recording_id', 'E2E_RECORD');
  }
  if (params.capture_id !== undefined) {
    checkRecordId(params.capture_id, 'capture_id', 'E2E_RECORD');
  }
  if (params.ring_bytes !== undefined) {
    checkInt(params.ring_bytes, 'ring_bytes', 1, MAX_RECORD_BYTES, 'E2E_RECORD');
  }
  if (params.max_fps !== undefined) {
    checkInt(params.max_fps, 'max_fps', 1, 120, 'E2E_RECORD');
  }
  return { schema: RECORD_SCHEMA, request_id: requestId, op, params: { ...params } };
}

/**
 * @typedef {object} AuditArtifact Validated artifact row.
 * @property {string} artifact_id Stable artifact id.
 * @property {string} kind One of the ARTIFACT_KINDS literals.
 * @property {string} path Absolute artifact path.
 * @property {number} bytes Artifact byte size.
 */

/**
 * Validate one audit artifact row against its placement rule: RAM
 * kinds stay strictly under /dev/shm, disk exports stay strictly
 * under the declared destination.
 * @param {unknown} artifact Candidate row.
 * @param {unknown} destination Declared disk destination, or null.
 * @returns {AuditArtifact} The validated row.
 */
function checkAuditArtifact(artifact, destination) {
  if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) {
    fail('E2E_AUDIT', 'audit artifact must be an object');
  }
  const row = /** @type {Record<string, unknown>} */ (artifact);
  needClosedKeys(row, ['artifact_id', 'kind', 'path', 'bytes'], 'audit artifact', 'E2E_AUDIT');
  const artifactId = checkRecordId(row.artifact_id, 'artifact_id', 'E2E_AUDIT');
  if (typeof row.kind !== 'string' || !ARTIFACT_KINDS.includes(row.kind)) {
    fail('E2E_AUDIT', `artifact kind must be one of ${ARTIFACT_KINDS.join(',')}`);
  }
  const kind = /** @type {string} */ (row.kind);
  const path = checkAbsPath(row.path, 'artifact path', 'E2E_AUDIT');
  const bytes = checkInt(row.bytes, 'artifact bytes', 0, MAX_RECORD_BYTES, 'E2E_AUDIT');
  if (kind === 'disk_export') {
    if (destination === null) fail('E2E_STORAGE', 'disk export without a declared destination');
    if (!isPathUnder(path, destination)) {
      fail('E2E_STORAGE', `disk export outside destination: ${path}`);
    }
  } else if (!isPathUnder(path, RAM_ROOT)) {
    fail('E2E_STORAGE', `non-RAM ${kind} path: ${path}`);
  }
  return { artifact_id: artifactId, kind, path, bytes };
}

/**
 * @typedef {object} StorageAuditSummary Normalized audit summary.
 * @property {AuditArtifact[]} artifacts Validated rows.
 * @property {number} ramBytes Bytes under /dev/shm.
 * @property {number} diskBytes Bytes under the declared destination.
 */

/**
 * Strict closed validation of the storage-audit report. Any dirty
 * byte outside the destination fails the audit: RAM-first means zero.
 * @param {unknown} value Parsed audit report.
 * @returns {StorageAuditSummary} Normalized summary.
 */
function validateStorageAudit(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('E2E_AUDIT', 'storage audit must be an object');
  }
  const audit = /** @type {Record<string, unknown>} */ (value);
  needClosedKeys(
    audit,
    ['schema', 'phase', 'destination', 'artifacts', 'home_dirty_bytes', 'repo_dirty_bytes'],
    'storage audit',
    'E2E_AUDIT',
  );
  if (audit.schema !== AUDIT_SCHEMA) fail('E2E_AUDIT', 'storage audit schema mismatch');
  if (audit.phase !== AUDIT_PHASE) fail('E2E_AUDIT', 'storage audit phase mismatch');
  if (audit.destination !== null) checkAbsPath(audit.destination, 'destination', 'E2E_AUDIT');
  if (!Array.isArray(audit.artifacts)) fail('E2E_AUDIT', 'audit artifacts must be an array');
  const entries = /** @type {ReadonlyArray<unknown>} */ (audit.artifacts);
  const artifacts = entries.map((entry) => checkAuditArtifact(entry, audit.destination));
  const homeDirty = checkInt(audit.home_dirty_bytes, 'home_dirty_bytes', 0, Number.MAX_SAFE_INTEGER, 'E2E_AUDIT');
  const repoDirty = checkInt(audit.repo_dirty_bytes, 'repo_dirty_bytes', 0, Number.MAX_SAFE_INTEGER, 'E2E_AUDIT');
  if (homeDirty !== 0 || repoDirty !== 0) {
    fail('E2E_STORAGE', `dirty bytes outside destination: home=${homeDirty} repo=${repoDirty}`);
  }
  let ramBytes = 0;
  let diskBytes = 0;
  for (const artifact of artifacts) {
    if (artifact.kind === 'disk_export') diskBytes += artifact.bytes;
    else ramBytes += artifact.bytes;
  }
  return { artifacts, ramBytes, diskBytes };
}

/**
 * Validate a path-to-bytes snapshot map.
 * @param {unknown} map Candidate map.
 * @param {string} label Field label for the error.
 * @returns {Array<[string, number]>} Clean entries.
 */
function checkSnapshotMap(map, label) {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    fail('E2E_AUDIT', `${label} must be a path map object`);
  }
  const record = /** @type {Record<string, unknown>} */ (map);
  const raw = Object.entries(record);
  if (raw.length > MAX_SNAPSHOT_FILES) fail('E2E_AUDIT', `${label} exceeds entry cap`);
  /** @type {Array<[string, number]>} */
  const clean = [];
  for (const [path, bytes] of raw) {
    if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
      fail('E2E_AUDIT', `${label} has a malformed path`);
    }
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0
        || bytes > Number.MAX_SAFE_INTEGER) {
      fail('E2E_AUDIT', `${label} has a malformed byte count`);
    }
    clean.push([path, bytes]);
  }
  return clean;
}

/**
 * Diff two snapshots. Every new or changed file counts its full new
 * size as dirty; deletions are not writes and stay out of the count.
 * @param {unknown} before Path-to-bytes map before recording.
 * @param {unknown} after Path-to-bytes map after recording.
 * @returns {{ dirty_bytes: number, changed_paths: string[] }} Sorted diff.
 */
function diffSnapshots(before, after) {
  const prior = new Map(checkSnapshotMap(before, 'before snapshot'));
  const next = checkSnapshotMap(after, 'after snapshot');
  let dirty = 0;
  /** @type {string[]} */
  const changed = [];
  for (const [path, bytes] of next) {
    if (!prior.has(path) || prior.get(path) !== bytes) {
      dirty += bytes;
      changed.push(path);
    }
  }
  changed.sort();
  return { dirty_bytes: dirty, changed_paths: changed };
}

/**
 * @typedef {object} DirSnapshot Bounded directory snapshot.
 * @property {string} root Resolved snapshot root.
 * @property {Record<string, number>} files Absolute path to byte size.
 * @property {boolean} truncated True when caps or unreadable entries
 * stop the walk from proving the tree clean.
 * @property {number} skipped Unreadable entries skipped.
 */

/**
 * Bounded iterative snapshot of file sizes under a root. Depth, file
 * count and symlink guards keep the audit itself off the gate clock;
 * anything unreadable marks the snapshot truncated instead of
 * claiming a clean tree it did not fully see.
 * @param {string} root Absolute directory to snapshot.
 * @param {{ maxFiles?: number, maxDepth?: number,
 * excludeDirs?: ReadonlyArray<string> }} [options] Walk budgets.
 * @returns {DirSnapshot} The snapshot.
 */
function snapshotDir(root, options = {}) {
  const start = resolve(String(root || ''));
  let stat;
  try {
    stat = statSync(start);
  } catch {
    fail('E2E_SNAPSHOT', `snapshot root unreadable: ${start}`);
  }
  if (!stat.isDirectory()) fail('E2E_SNAPSHOT', 'snapshot root must be a directory');
  const maxFiles = options.maxFiles === undefined ? MAX_SNAPSHOT_FILES : options.maxFiles;
  const maxDepth = options.maxDepth === undefined ? MAX_SNAPSHOT_DEPTH : options.maxDepth;
  if (!Number.isInteger(maxFiles) || maxFiles <= 0) {
    fail('E2E_ARGS', 'maxFiles must be a positive integer');
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    fail('E2E_ARGS', 'maxDepth must be a non-negative integer');
  }
  const exclude = new Set(Array.isArray(options.excludeDirs) ? options.excludeDirs : []);
  /** @type {Record<string, number>} */
  const files = {};
  let count = 0;
  let skipped = 0;
  let truncated = false;
  /** @type {Array<{ dir: string, depth: number }>} */
  const stack = [{ dir: start, depth: 0 }];
  while (stack.length > 0) {
    const frame = /** @type {{ dir: string, depth: number }} */ (stack.pop());
    let entries;
    try {
      entries = readdirSync(frame.dir, { withFileTypes: true });
    } catch {
      skipped += 1;
      truncated = true;
      continue;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : 1));
    for (const entry of entries) {
      if (count >= maxFiles) {
        truncated = true;
        break;
      }
      const full = join(frame.dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (exclude.has(entry.name)) continue;
        if (frame.depth < maxDepth) stack.push({ dir: full, depth: frame.depth + 1 });
        else truncated = true;
      } else if (entry.isFile()) {
        let size;
        try {
          size = statSync(full).size;
        } catch {
          skipped += 1;
          truncated = true;
          continue;
        }
        files[full] = size;
        count += 1;
      }
    }
    if (truncated && count >= maxFiles) break;
  }
  return { root: start, files, truncated, skipped };
}

/**
 * Read an audit report file and validate it. Oversized or malformed
 * files refuse with a typed error.
 * @param {string} path Absolute report path.
 * @returns {StorageAuditSummary} Normalized summary.
 */
function readAuditReport(path) {
  const file = resolve(String(path || ''));
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    fail('E2E_AUDIT', 'audit report unreadable');
  }
  const body = /** @type {string} */ (text);
  if (body.length > MAX_AUDIT_BYTES) fail('E2E_AUDIT', 'audit report exceeds byte cap');
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    fail('E2E_AUDIT', 'audit report is not JSON');
  }
  return validateStorageAudit(value);
}

/**
 * @param {unknown} text Module text.
 * @returns {boolean} True while the stub marker stands.
 */
function isRecordStub(text) {
  return typeof text === 'string' && text.includes(STUB_MARKER);
}

/**
 * Refuse the live journey while the recording module is still the
 * reserved stub its owning unit has not replaced yet.
 * @param {string} recordModPath Absolute core record module path.
 * @returns {string} The validated path once implemented.
 */
function requireRecordSurface(recordModPath) {
  const file = resolve(String(recordModPath || ''));
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    fail('E2E_PREREQ', `record surface unreadable: ${file}`);
  }
  if (isRecordStub(text)) {
    fail('E2E_PREREQ', `record surface unready: ${file} is a reserved stub`);
  }
  return file;
}

/**
 * Live soak window: the roadmap default unless the env override names
 * a bounded smaller or larger full-soak run.
 * @param {{ [key: string]: unknown }} [env] Environment override for tests.
 * @returns {number} Soak window in ms.
 */
function soakMs(env = process.env) {
  const table = /** @type {{ [key: string]: unknown }} */ (env);
  const raw = table[SOAK_ENV];
  if (raw === undefined || raw === '') return RECORD_SOAK_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_SOAK_MS) {
    fail('E2E_ARGS', `${SOAK_ENV} must be an integer 1..${MAX_SOAK_MS}`);
  }
  return parsed;
}

/**
 * Build a valid ram_start request.
 * @returns {{ schema: string, request_id: string, op: string,
 * params: Record<string, unknown> }} Fresh fixture.
 */
function validRamStart() {
  return {
    schema: RECORD_SCHEMA,
    request_id: 'rec-1',
    op: 'ram_start',
    params: { surface_id: 'surface-1', recording_id: 'ring-1', ring_bytes: 67108864, max_fps: 30 },
  };
}

/**
 * Build a valid disk_start request with a host destination.
 * @returns {{ schema: string, request_id: string, op: string,
 * params: Record<string, unknown> }} Fresh fixture.
 */
function validDiskStart() {
  return {
    schema: RECORD_SCHEMA,
    request_id: 'rec-2',
    op: 'disk_start',
    params: {
      surface_id: 'surface-1',
      recording_id: 'disk-1',
      destination_capability_id: 'host-dest-1',
      destination_path: '/tmp/mv0-disk-dest',
      max_fps: 30,
    },
  };
}

/**
 * Build a valid RAM-only audit with zero dirty bytes.
 * @returns {{ schema: string, phase: string, destination: null,
 * artifacts: Array<Record<string, unknown>>,
 * home_dirty_bytes: number, repo_dirty_bytes: number }} Fresh fixture.
 */
function validAudit() {
  return {
    schema: AUDIT_SCHEMA,
    phase: AUDIT_PHASE,
    destination: null,
    artifacts: [
      { artifact_id: 'ring-1', kind: 'ram_recording', path: '/dev/shm/mv0/ring-1', bytes: 1024 },
      { artifact_id: 'shot-1', kind: 'screenshot', path: '/dev/shm/mv0/shot-1.png', bytes: 2048 },
    ],
    home_dirty_bytes: 0,
    repo_dirty_bytes: 0,
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

describe('ac07 ram-first contract', () => {
  it('pins the record_request tag, op set and audit tag', () => {
    assert.equal(RECORD_SCHEMA, 'record_request/v0.2');
    assert.deepStrictEqual([...RECORD_OPS], ['ram_start', 'ram_stop', 'disk_start', 'disk_stop', 'screenshot']);
    assert.equal(AUDIT_SCHEMA, 'e2e-ram-audit/v1');
    assert.equal(AUDIT_PHASE, 'ram_first');
    assert.equal(RAM_ROOT, '/dev/shm');
  });

  it('accepts ram_start, ram_stop and screenshot requests', () => {
    const started = validateRecordRequest(validRamStart());
    assert.equal(started.op, 'ram_start');
    assert.equal(started.params.ring_bytes, 67108864);
    const stopped = validateRecordRequest({
      schema: RECORD_SCHEMA,
      request_id: 'rec-3',
      op: 'ram_stop',
      params: { surface_id: 'surface-1', recording_id: 'ring-1' },
    });
    assert.equal(stopped.op, 'ram_stop');
    const shot = validateRecordRequest({
      schema: RECORD_SCHEMA,
      request_id: 'rec-4',
      op: 'screenshot',
      params: { surface_id: 'surface-1', capture_id: 'shot-1' },
    });
    assert.equal(shot.op, 'screenshot');
  });

  it('accepts disk_start with a host destination and disk_stop', () => {
    const started = validateRecordRequest(validDiskStart());
    assert.equal(started.op, 'disk_start');
    assert.equal(started.params.destination_path, '/tmp/mv0-disk-dest');
    const stopped = validateRecordRequest({
      schema: RECORD_SCHEMA,
      request_id: 'rec-5',
      op: 'disk_stop',
      params: { surface_id: 'surface-1', recording_id: 'disk-1' },
    });
    assert.equal(stopped.op, 'disk_stop');
  });

  it('negative control: disk_start without destination capability is refused (AC-07 negative)', () => {
    const missing = validDiskStart();
    delete missing.params.destination_capability_id;
    rejectsWith(() => validateRecordRequest(missing), ['E2E_DESTINATION']);
    for (const bad of ['', 'has space', 'x'.repeat(129), null]) {
      const mutant = validDiskStart();
      mutant.params.destination_capability_id = bad;
      rejectsWith(() => validateRecordRequest(mutant), ['E2E_DESTINATION']);
    }
  });

  it('negative control: disk_start without destination path is refused', () => {
    const missing = validDiskStart();
    delete missing.params.destination_path;
    rejectsWith(() => validateRecordRequest(missing), ['E2E_DESTINATION']);
    for (const bad of ['', 'relative/path', 'C:\\win\\path', null]) {
      const mutant = validDiskStart();
      mutant.params.destination_path = bad;
      rejectsWith(() => validateRecordRequest(mutant), ['E2E_DESTINATION']);
    }
  });

  it('negative control: malformed requests are refused', () => {
    for (const bad of [null, [], 'text', 42, { schema: RECORD_SCHEMA }]) {
      rejectsWith(() => validateRecordRequest(bad), ['E2E_RECORD']);
    }
    const wrongTag = validRamStart();
    wrongTag.schema = 'record_request/v9';
    rejectsWith(() => validateRecordRequest(wrongTag), ['E2E_RECORD']);
    const extraKey = { ...validRamStart(), debug: true };
    rejectsWith(() => validateRecordRequest(extraKey), ['E2E_RECORD']);
    const unknownOp = validRamStart();
    unknownOp.op = 'tape_start';
    rejectsWith(() => validateRecordRequest(unknownOp), ['E2E_RECORD']);
    for (const bad of ['', 'bad id', 'x'.repeat(129), 7, null]) {
      const mutant = validRamStart();
      mutant.request_id = bad;
      rejectsWith(() => validateRecordRequest(mutant), ['E2E_RECORD']);
    }
    const extraParam = validRamStart();
    extraParam.params.destination_path = '/tmp/nowhere';
    rejectsWith(() => validateRecordRequest(extraParam), ['E2E_RECORD']);
  });

  it('negative control: out-of-range record params are refused', () => {
    const noRing = validRamStart();
    delete noRing.params.ring_bytes;
    rejectsWith(() => validateRecordRequest(noRing), ['E2E_RECORD']);
    for (const bad of [0, -1, MAX_RECORD_BYTES + 1, 1.5, 'big']) {
      const mutant = validRamStart();
      mutant.params.ring_bytes = bad;
      rejectsWith(() => validateRecordRequest(mutant), ['E2E_RECORD']);
    }
    for (const bad of [0, 121, 1.5]) {
      const mutant = validRamStart();
      mutant.params.max_fps = bad;
      rejectsWith(() => validateRecordRequest(mutant), ['E2E_RECORD']);
    }
    const shotWithDest = {
      schema: RECORD_SCHEMA,
      request_id: 'rec-6',
      op: 'screenshot',
      params: { surface_id: 'surface-1', capture_id: 'shot-1', destination_path: '/tmp/x' },
    };
    rejectsWith(() => validateRecordRequest(shotWithDest), ['E2E_RECORD']);
  });

  it('accepts a RAM-only storage audit with zero dirty bytes', () => {
    const summary = validateStorageAudit(validAudit());
    assert.equal(summary.artifacts.length, 2);
    assert.equal(summary.ramBytes, 3072);
    assert.equal(summary.diskBytes, 0);
  });

  it('accepts disk exports strictly under the declared destination', () => {
    const audit = validAudit();
    audit.destination = '/tmp/mv0-disk-dest';
    audit.artifacts.push({
      artifact_id: 'disk-1',
      kind: 'disk_export',
      path: '/tmp/mv0-disk-dest/ring-1.mkv',
      bytes: 4096,
    });
    const summary = validateStorageAudit(audit);
    assert.equal(summary.diskBytes, 4096);
    assert.equal(summary.ramBytes, 3072);
  });

  it('negative control: recordings and screenshots outside /dev/shm are refused', () => {
    const tmpShot = validAudit();
    tmpShot.artifacts[1].path = '/tmp/shot-1.png';
    rejectsWith(() => validateStorageAudit(tmpShot), ['E2E_STORAGE']);
    const outsideRing = validAudit();
    outsideRing.artifacts[0].path = '/srv/outside/ring-1';
    rejectsWith(() => validateStorageAudit(outsideRing), ['E2E_STORAGE']);
  });

  it('negative control: traversal and prefix-sibling RAM paths are refused', () => {
    for (const bad of ['/dev/shm/../tmp/x', '/dev/shm-evil/x', '/dev/shm']) {
      const mutant = validAudit();
      mutant.artifacts[0].path = bad;
      rejectsWith(() => validateStorageAudit(mutant), ['E2E_STORAGE']);
    }
  });

  it('negative control: disk export without or outside destination is refused', () => {
    const orphan = validAudit();
    orphan.artifacts.push({
      artifact_id: 'disk-1',
      kind: 'disk_export',
      path: '/tmp/mv0-disk-dest/ring-1.mkv',
      bytes: 10,
    });
    rejectsWith(() => validateStorageAudit(orphan), ['E2E_STORAGE']);
    const escaped = validAudit();
    escaped.destination = '/tmp/mv0-disk-a';
    escaped.artifacts.push({
      artifact_id: 'disk-1',
      kind: 'disk_export',
      path: '/tmp/mv0-disk-b/ring-1.mkv',
      bytes: 10,
    });
    rejectsWith(() => validateStorageAudit(escaped), ['E2E_STORAGE']);
  });

  it('negative control: dirty bytes outside the destination fail the audit', () => {
    const homeDirty = validAudit();
    homeDirty.home_dirty_bytes = 1;
    rejectsWith(() => validateStorageAudit(homeDirty), ['E2E_STORAGE']);
    const repoDirty = validAudit();
    repoDirty.repo_dirty_bytes = 5;
    rejectsWith(() => validateStorageAudit(repoDirty), ['E2E_STORAGE']);
  });

  it('negative control: malformed audits are refused', () => {
    for (const bad of [null, [], 'text', 42, { schema: AUDIT_SCHEMA }]) {
      rejectsWith(() => validateStorageAudit(bad), ['E2E_AUDIT']);
    }
    const wrongTag = { ...validAudit(), schema: 'ram-audit/v9' };
    rejectsWith(() => validateStorageAudit(wrongTag), ['E2E_AUDIT']);
    const extraKey = { ...validAudit(), debug: true };
    rejectsWith(() => validateStorageAudit(extraKey), ['E2E_AUDIT']);
    const badKind = validAudit();
    badKind.artifacts[0].kind = 'tape';
    rejectsWith(() => validateStorageAudit(badKind), ['E2E_AUDIT']);
    const badDest = validAudit();
    badDest.destination = 'relative/dir';
    rejectsWith(() => validateStorageAudit(badDest), ['E2E_AUDIT']);
  });

  it('contains paths strictly after normalization', () => {
    assert.equal(isPathUnder('/dev/shm/a/b', '/dev/shm'), true);
    assert.equal(isPathUnder('/tmp/dest/f', '/tmp/dest/'), true);
    assert.equal(isPathUnder('/dev/shm/../tmp/x', '/dev/shm'), false);
    assert.equal(isPathUnder('/dev/shm-evil/x', '/dev/shm'), false);
    assert.equal(isPathUnder('/dev/shm', '/dev/shm'), false);
    assert.equal(isPathUnder('/tmp/a', '/tmp/b'), false);
    assert.equal(isPathUnder('relative/x', '/tmp/b'), false);
    assert.equal(isPathUnder('/tmp/x', 'relative'), false);
    assert.equal(isPathUnder(null, '/tmp/b'), false);
    assert.equal(isPathUnder('/tmp/x', null), false);
  });

  it('diffs snapshots deterministically', () => {
    assert.deepStrictEqual(diffSnapshots({}, {}), { dirty_bytes: 0, changed_paths: [] });
    const before = { '/w/a': 10, '/w/b': 20 };
    const after = { '/w/a': 10, '/w/b': 25, '/w/c': 5 };
    assert.deepStrictEqual(diffSnapshots(before, after), { dirty_bytes: 30, changed_paths: ['/w/b', '/w/c'] });
    const deleted = diffSnapshots({ '/w/a': 10, '/w/z': 7 }, { '/w/a': 10 });
    assert.deepStrictEqual(deleted, { dirty_bytes: 0, changed_paths: [] });
  });

  it('negative control: malformed snapshot maps are refused', () => {
    for (const bad of [null, [], 'text', 42]) {
      rejectsWith(() => diffSnapshots(bad, {}), ['E2E_AUDIT']);
      rejectsWith(() => diffSnapshots({}, bad), ['E2E_AUDIT']);
    }
    rejectsWith(() => diffSnapshots({ '/w/a': -1 }, {}), ['E2E_AUDIT']);
    rejectsWith(() => diffSnapshots({ '/w/a': 1.5 }, {}), ['E2E_AUDIT']);
    /** @type {Record<string, number>} */
    const big = {};
    for (let i = 0; i <= MAX_SNAPSHOT_FILES; i += 1) big[`/w/${i}`] = 1;
    rejectsWith(() => diffSnapshots({}, big), ['E2E_AUDIT']);
  });

  it('snapshots a scratch tree and diffs real writes', () => {
    const scratch = makeScratch('mv0-ac07');
    try {
      const first = join(scratch, 'f1.bin');
      const sub = join(scratch, 'sub');
      mkdirSync(sub);
      const second = join(sub, 'f2.bin');
      writeFileSync(first, '0123456789', 'utf8');
      writeFileSync(second, 'zz', 'utf8');
      const before = snapshotDir(scratch);
      assert.equal(before.truncated, false);
      assert.equal(before.skipped, 0);
      assert.equal(before.files[first], 10);
      assert.equal(before.files[second], 2);
      writeFileSync(first, '0123456789abc', 'utf8');
      const third = join(scratch, 'f3.bin');
      writeFileSync(third, 'zz', 'utf8');
      const after = snapshotDir(scratch);
      assert.equal(after.truncated, false);
      const diff = diffSnapshots(before.files, after.files);
      assert.equal(diff.dirty_bytes, 15);
      assert.deepStrictEqual(diff.changed_paths, [first, third].sort());
      const repeat = snapshotDir(scratch);
      assert.deepStrictEqual(diffSnapshots(after.files, repeat.files), { dirty_bytes: 0, changed_paths: [] });
    } finally {
      removeScratch(scratch);
    }
  });

  it('snapshot walker truncates within caps and refuses bad roots', () => {
    const scratch = makeScratch('mv0-ac07');
    try {
      writeFileSync(join(scratch, 'a.bin'), 'a', 'utf8');
      writeFileSync(join(scratch, 'b.bin'), 'b', 'utf8');
      mkdirSync(join(scratch, 'skip'));
      writeFileSync(join(scratch, 'skip', 's.bin'), 's', 'utf8');
      const capped = snapshotDir(scratch, { maxFiles: 1 });
      assert.equal(capped.truncated, true);
      assert.ok(Object.keys(capped.files).length <= 1);
      const shallow = snapshotDir(scratch, { maxDepth: 0 });
      assert.equal(shallow.truncated, true);
      assert.equal(join(scratch, 'skip', 's.bin') in shallow.files, false);
      const excluded = snapshotDir(scratch, { excludeDirs: ['skip'] });
      assert.equal(excluded.truncated, false);
      assert.equal(join(scratch, 'skip', 's.bin') in excluded.files, false);
      rejectsWith(() => snapshotDir(join(scratch, 'missing')), ['E2E_SNAPSHOT']);
      rejectsWith(() => snapshotDir(join(scratch, 'a.bin')), ['E2E_SNAPSHOT']);
      rejectsWith(() => snapshotDir(scratch, { maxFiles: 0 }), ['E2E_ARGS']);
    } finally {
      removeScratch(scratch);
    }
  });

  it('round-trips the audit report file', () => {
    const scratch = makeScratch('mv0-ac07');
    try {
      const path = join(scratch, 'ram-audit.json');
      writeFileSync(path, `${JSON.stringify(validAudit())}\n`, 'utf8');
      const summary = readAuditReport(path);
      assert.equal(summary.ramBytes, 3072);
      const badPath = join(scratch, 'bad.json');
      writeFileSync(badPath, '{not json', 'utf8');
      rejectsWith(() => readAuditReport(badPath), ['E2E_AUDIT']);
      rejectsWith(() => readAuditReport(join(scratch, 'missing.json')), ['E2E_AUDIT']);
      const hugePath = join(scratch, 'huge.json');
      writeFileSync(hugePath, 'x'.repeat(MAX_AUDIT_BYTES + 1), 'utf8');
      rejectsWith(() => readAuditReport(hugePath), ['E2E_AUDIT']);
    } finally {
      removeScratch(scratch);
    }
  });

  it('detects the reserved record stub', () => {
    assert.equal(isRecordStub('//! Reserved for recording coordination.'), true);
    assert.equal(isRecordStub('pub fn start_ram_ring() {}'), false);
    assert.equal(isRecordStub(null), false);
    const scratch = makeScratch('mv0-ac07');
    try {
      const stub = join(scratch, 'stub.rs');
      const real = join(scratch, 'real.rs');
      writeFileSync(stub, '//! Reserved for recording coordination implemented by W2-REC.\n', 'utf8');
      writeFileSync(real, '//! Recording coordinator.\n', 'utf8');
      rejectsWith(() => requireRecordSurface(stub), ['E2E_PREREQ']);
      assert.equal(requireRecordSurface(real), resolve(real));
      rejectsWith(() => requireRecordSurface(join(scratch, 'missing.rs')), ['E2E_PREREQ']);
    } finally {
      removeScratch(scratch);
    }
  });

  it('defaults the soak window with a bounded override', () => {
    assert.equal(soakMs({}), RECORD_SOAK_MS);
    assert.equal(RECORD_SOAK_MS, 300000);
    assert.equal(soakMs({ [SOAK_ENV]: '60000' }), 60000);
    assert.equal(soakMs({ [SOAK_ENV]: '' }), RECORD_SOAK_MS);
    for (const bad of ['0', '-5', 'abc', '1.5', String(MAX_SOAK_MS + 1)]) {
      rejectsWith(() => soakMs({ [SOAK_ENV]: bad }), ['E2E_ARGS']);
    }
  });

  it('pins the audit byte, snapshot and soak caps', () => {
    assert.equal(MAX_AUDIT_BYTES, 1048576);
    assert.equal(MAX_SNAPSHOT_FILES, 4096);
    assert.equal(MAX_SNAPSHOT_DEPTH, 12);
    assert.equal(MAX_RECORD_BYTES, 1073741824);
    assert.equal(MAX_SOAK_MS, 3600000);
  });
});

describe('ac07 live ram-first journey', () => {
  it('record-for-AI stays in RAM; disk without destination refused (AC-07)', {
    todo: 'GAP-AC07-RECORD: core/src/record/mod.rs:1 is reserved; daemon-adapter/internal/capsule/manager.go:212-213 refuses record_start/record_stop',
  }, () => {
    requireRecordSurface(join(findRepoRoot(__dirname), 'core/src/record/mod.rs'));
    requireXvfb();
    const root = findRepoRoot(__dirname);
    const electron = electronBinary(root);
    assert.ok(electron.length > 0, 'electron binary must resolve');
    // The must-FAIL control executes live too: a disk request without
    // a host destination refuses before any capture starts.
    rejectsWith(() => validateRecordRequest({
      schema: RECORD_SCHEMA,
      request_id: 'live-rec-1',
      op: 'disk_start',
      params: { surface_id: 'live-surface-1', recording_id: 'live-disk-1', max_fps: 30 },
    }), ['E2E_DESTINATION']);
    // Fail closed until the recording unit lands. Past this gate the
    // soak snapshots the home and repo trees, drives ram_start,
    // screenshot, refused disk_start and permitted disk_start through
    // the product, and validates the audit with validateStorageAudit
    // plus diffSnapshots asserting zero dirty bytes.
    requireRecordSurface(join(root, 'core', 'src', 'record', 'mod.rs'));
    // A landed surface without a live driver in this suite must not
    // go green; wiring the driver removes this second gate.
    throw new E2EError('E2E_PREREQ', 'live record driver unwired in this suite');
  });
});
