// @ts-check
/**
 * [TARGET, unit decision] Env-gated frame pipeline diagnostics for live QA and
 * production-path E2E verification. Active only when MV_FRAME_DIAG=1 in a
 * non-packaged, non-nested launch. Main tracks frame deliveries posted,
 * frame_ack/v0.2 outcomes received, and stream revocations by reason; preload
 * reports notices forwarded over an internal channel without adding any
 * window.metaviewer facade method. Snapshots are written atomically (0600) to
 * frame-diag.json in the verified private run directory.
 * [TARGET, unit decision] frame_diag_preload/v1 admits optional non-negative
 * safe-integer counters rehashSkipped and rehashDone (absent = 0);
 * metaviewer:frames.reportDiag enforces monotonic per-session max and observeSender,
 * and snapshots expose requestedWallFps.
 */
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MainError, observeSender, PRIVILEGED_ORIGIN } from './main.js';
import { validateQaRunDir } from './qaAnchors.js';

export const FRAME_DIAG_CHANNEL = 'metaviewer:frame.diag';
export const FRAME_REPORT_DIAG_CHANNEL = 'metaviewer:frames.reportDiag';
export const FRAME_DIAG_SCHEMA = 'frame_diag/v1';
export const FRAME_DIAG_PRELOAD_SCHEMA = 'frame_diag_preload/v1';
export const FRAME_DIAG_FILE = 'frame-diag.json';
export const FRAME_DIAG_USER_AGENT_TOKEN = '--frame-diag=1';
export const FRAME_DIAG_MAX_BYTES = 64 * 1024;

const SOURCE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SURFACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const OUTCOME_KEYS = Object.freeze([
  'CONTEXT_LOST',
  'FOLD_DRAIN',
  'HIDDEN',
  'PRESENTED',
  'REFUSED',
  'SUPERSEDED',
  'SURFACE_DESTROYED',
]);

const REVOKE_KEYS = Object.freeze([
  'ENDPOINT_RESTART',
  'PORT_REVOKED',
  'SHUTDOWN',
  'TIMEOUT',
]);

export const FRAME_DIAG_ACQUIRE_CAUSES = Object.freeze([
  'FRAME_BINDING',
  'OPEN_EACCES',
  'OPEN_ENOENT',
  'OPEN_IO',
  'OPEN_PATH',
  'OPEN_SYMLINK',
  'SIZE',
  'STALE',
  'STAT_IO',
  'STAT_MODE',
  'STAT_NOT_FILE',
  'STAT_UID',
  'UNKNOWN',
]);

/**
 * Ensure candidate path lies strictly outside the repository source root.
 * @param {string} candidate Absolute path.
 * @returns {void}
 */
function assertOutsideSource(candidate) {
  const rel = relative(SOURCE_ROOT, resolve(candidate));
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new MainError('FRAME_DIAG_RUN_DIR', 'frame diag run dir must be outside repository root');
  }
}

/**
 * Check whether an object is a plain record with exact own data keys and no symbols.
 * @param {unknown} value Candidate object.
 * @param {string} sortedKeys Comma-joined sorted key list.
 * @returns {value is Record<string, unknown>}
 */
function hasClosedDataKeys(value, sortedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  const expectedCount = sortedKeys.length === 0 ? 0 : sortedKeys.split(',').length;
  if (Reflect.ownKeys(value).length !== expectedCount) {
    return false;
  }
  if (Object.keys(value).sort().join(',') !== sortedKeys) {
    return false;
  }
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((desc) => 'value' in desc);
}

/**
 * @param {unknown} value Candidate count.
 * @returns {value is number}
 */
function isNonNegativeSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate a renderer rehash diagnostic report ({rehashSkipped, rehashDone}).
 * @param {unknown} payload Alleged rehash diagnostic report.
 * @returns {Readonly<{ rehashSkipped: number, rehashDone: number }>}
 */
export function validateFrameRehashDiag(payload) {
  if (!hasClosedDataKeys(payload, 'rehashDone,rehashSkipped')) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'frames.reportDiag requires plain object {rehashSkipped, rehashDone}');
  }
  if (!isNonNegativeSafeInt(payload.rehashSkipped) || !isNonNegativeSafeInt(payload.rehashDone)) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'rehash diag counters must be non-negative safe integers');
  }
  return Object.freeze({
    rehashSkipped: payload.rehashSkipped,
    rehashDone: payload.rehashDone,
  });
}

/**
 * Validate and normalize a closed frame_diag_preload/v1 counter report.
 * @param {unknown} payload Alleged preload diagnostic report.
 * @returns {Readonly<{
 *   schema: 'frame_diag_preload/v1',
 *   framesReceived: number,
 *   invalidNotices: number,
 *   portsReceived: number,
 *   noticesForwarded: number,
 *   legacyNoticesForwarded: number,
 *   portsClosed: number,
 *   rehashSkipped: number,
 *   rehashDone: number,
 *   inWallApp: boolean | null,
 *   origin: string,
 *   lastSurfaceId: string | null,
 *   lastSurfaceGeneration: number | null,
 *   lastFrameGeneration: number | null,
 *   domSurfaceState: string | null,
 *   domWaitingText: string | null,
 *   domStripText: string | null,
 * }>}
 */
export function validateFrameDiagPreload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag must have closed keys');
  }
  const proto = Object.getPrototypeOf(payload);
  if (proto !== Object.prototype && proto !== null) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag must have closed keys');
  }
  const ownKeys = Object.keys(payload);
  if (
    Reflect.ownKeys(payload).length !== ownKeys.length ||
    !Object.values(Object.getOwnPropertyDescriptors(payload)).every((desc) => 'value' in desc)
  ) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag must have closed keys');
  }
  const baseKeys = ownKeys
    .filter((key) => key !== 'rehashSkipped' && key !== 'rehashDone')
    .sort()
    .join(',');
  const expectedKeys =
    'domStripText,domSurfaceState,domWaitingText,framesReceived,inWallApp,invalidNotices,lastFrameGeneration,lastSurfaceGeneration,lastSurfaceId,legacyNoticesForwarded,noticesForwarded,origin,portsClosed,portsReceived,schema';
  const prevKeys =
    'domStripText,domSurfaceState,domWaitingText,framesReceived,inWallApp,invalidNotices,lastSurfaceGeneration,lastSurfaceId,legacyNoticesForwarded,noticesForwarded,origin,portsClosed,portsReceived,schema';
  const legacyKeys =
    'framesReceived,inWallApp,invalidNotices,lastSurfaceGeneration,lastSurfaceId,legacyNoticesForwarded,noticesForwarded,origin,portsClosed,portsReceived,schema';
  if (baseKeys !== expectedKeys && baseKeys !== prevKeys && baseKeys !== legacyKeys) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag must have closed keys');
  }
  const rec = /** @type {Record<string, unknown>} */ (payload);
  if (rec.schema !== FRAME_DIAG_PRELOAD_SCHEMA) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag schema must be frame_diag_preload/v1');
  }
  const rehashSkipped = rec.rehashSkipped === undefined ? 0 : rec.rehashSkipped;
  const rehashDone = rec.rehashDone === undefined ? 0 : rec.rehashDone;
  if (
    !isNonNegativeSafeInt(rec.framesReceived) ||
    !isNonNegativeSafeInt(rec.invalidNotices) ||
    !isNonNegativeSafeInt(rec.portsReceived) ||
    !isNonNegativeSafeInt(rec.noticesForwarded) ||
    !isNonNegativeSafeInt(rec.legacyNoticesForwarded) ||
    !isNonNegativeSafeInt(rec.portsClosed) ||
    !isNonNegativeSafeInt(rehashSkipped) ||
    !isNonNegativeSafeInt(rehashDone)
  ) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag counters must be non-negative safe integers');
  }
  if (rec.inWallApp !== null && typeof rec.inWallApp !== 'boolean') {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag inWallApp must be boolean or null');
  }
  if (
    typeof rec.origin !== 'string' ||
    rec.origin.length > 256 ||
    rec.origin.includes('\0')
  ) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag origin must be a bounded string');
  }
  if (
    rec.lastSurfaceId !== null &&
    (typeof rec.lastSurfaceId !== 'string' || !SURFACE_ID_RE.test(rec.lastSurfaceId))
  ) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag lastSurfaceId is invalid');
  }
  if (
    rec.lastSurfaceGeneration !== null &&
    (typeof rec.lastSurfaceGeneration !== 'number' ||
      !Number.isSafeInteger(rec.lastSurfaceGeneration) ||
      rec.lastSurfaceGeneration < 1)
  ) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag lastSurfaceGeneration is invalid');
  }
  if (
    rec.lastFrameGeneration !== undefined &&
    rec.lastFrameGeneration !== null &&
    (typeof rec.lastFrameGeneration !== 'number' ||
      !Number.isSafeInteger(rec.lastFrameGeneration) ||
      rec.lastFrameGeneration < 1)
  ) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag lastFrameGeneration is invalid');
  }
  for (const domField of ['domSurfaceState', 'domWaitingText', 'domStripText']) {
    const val = rec[domField];
    if (val !== undefined && val !== null && (typeof val !== 'string' || val.length > 512 || val.includes('\0'))) {
      throw new MainError('FRAME_DIAG_PAYLOAD', `preload diag ${domField} is invalid`);
    }
  }
  return Object.freeze({
    schema: /** @type {'frame_diag_preload/v1'} */ (FRAME_DIAG_PRELOAD_SCHEMA),
    framesReceived: rec.framesReceived,
    invalidNotices: rec.invalidNotices,
    portsReceived: rec.portsReceived,
    noticesForwarded: rec.noticesForwarded,
    legacyNoticesForwarded: rec.legacyNoticesForwarded,
    portsClosed: rec.portsClosed,
    rehashSkipped,
    rehashDone,
    inWallApp: rec.inWallApp,
    origin: rec.origin,
    lastSurfaceId: rec.lastSurfaceId,
    lastSurfaceGeneration: rec.lastSurfaceGeneration,
    lastFrameGeneration: typeof rec.lastFrameGeneration === 'number' ? rec.lastFrameGeneration : null,
    domSurfaceState: typeof rec.domSurfaceState === 'string' ? rec.domSurfaceState : null,
    domWaitingText: typeof rec.domWaitingText === 'string' ? rec.domWaitingText : null,
    domStripText: typeof rec.domStripText === 'string' ? rec.domStripText : null,
  });
}

/**
 * Resolve MV_FRAME_DIAG enablement and run directory from main launch context.
 * @param {{ env?: NodeJS.ProcessEnv, runtime?: { xdgRuntimeDir?: string, uid?: number }, runDir?: string, packaged?: boolean, nested?: boolean, argv?: ReadonlyArray<string> }} [options]
 * @returns {Readonly<{ enabled: boolean, runDir: string | null }>}
 */
export function resolveFrameDiagConfig(options = {}) {
  const env = options.env ?? {};
  const packaged =
    Boolean(options.packaged) ||
    fileURLToPath(import.meta.url).includes('.asar/') ||
    fileURLToPath(import.meta.url).includes('.asar\\');
  const diagRaw = env.MV_FRAME_DIAG;
  if (packaged) {
    if (diagRaw !== undefined && diagRaw !== '') {
      throw new MainError('RETAIL_ENV', 'packaged launch refuses MV_FRAME_DIAG');
    }
    return Object.freeze({ enabled: false, runDir: null });
  }
  const nested =
    Boolean(options.nested) ||
    (Array.isArray(options.argv) && options.argv.includes('--nested-depth=1'));
  if (nested) {
    return Object.freeze({ enabled: false, runDir: null });
  }
  if (diagRaw === undefined || diagRaw === '' || diagRaw === '0') {
    return Object.freeze({ enabled: false, runDir: null });
  }
  if (diagRaw !== '1') {
    throw new MainError('RETAIL_ENV', 'invalid MV_FRAME_DIAG value');
  }
  const candidateDir =
    options.runDir ??
    env.MV_FRAME_DIAG_DIR ??
    env.MV_QA_RUN_DIR ??
    env.MV_E2E_RUN_DIR ??
    env.XDG_RUNTIME_DIR ??
    options.runtime?.xdgRuntimeDir;
  const verifiedDir = validateQaRunDir(candidateDir);
  return Object.freeze({ enabled: true, runDir: verifiedDir });
}

/**
 * Verify directory and write the frame diagnostic snapshot atomically (0600,
 * temp + fsync + rename, O_NOFOLLOW) to frame-diag.json inside runDir.
 * @param {string} runDir Verified private run directory.
 * @param {unknown} snapshot Diagnostic snapshot payload.
 * @returns {Promise<true>}
 */
export async function writeFrameDiagSnapshot(runDir, snapshot) {
  const encoded = JSON.stringify(snapshot);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > FRAME_DIAG_MAX_BYTES) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'frame-diag.json exceeds 64 KiB serialized cap');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  assertOutsideSource(runDir);
  let dirStat;
  try {
    dirStat = await lstat(runDir);
  } catch {
    throw new MainError('FRAME_DIAG_RUN_DIR', 'frame diag run dir is unavailable');
  }
  if (
    !dirStat.isDirectory() ||
    dirStat.isSymbolicLink() ||
    (uid >= 0 && dirStat.uid !== uid) ||
    (dirStat.mode & 0o777) !== 0o700
  ) {
    throw new MainError('FRAME_DIAG_RUN_DIR', 'frame diag run dir failed pre-write check');
  }
  const canonicalDir = await realpath(runDir);
  assertOutsideSource(canonicalDir);

  const targetPath = join(runDir, FRAME_DIAG_FILE);
  try {
    const existing = await lstat(targetPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new MainError('FRAME_DIAG_SYMLINK', 'frame-diag.json must not be a symlink or non-regular file');
    }
  } catch (error) {
    if (error instanceof MainError) {
      throw error;
    }
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
      throw new MainError('FRAME_DIAG_WRITE', 'unable to inspect frame-diag.json target');
    }
  }

  const tempPath = join(runDir, `.frame-diag-${process.pid}-${randomUUID()}.tmp`);
  try {
    const file = await open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.chmod(0o600);
      await file.writeFile(encoded, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tempPath, targetPath);
    const verifyStat = await lstat(targetPath);
    if (verifyStat.isSymbolicLink() || !verifyStat.isFile() || (verifyStat.mode & 0o777) !== 0o600) {
      throw new MainError('FRAME_DIAG_WRITE', 'frame-diag.json post-write verification failed');
    }
    const dirHandle = await open(
      runDir,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
    return true;
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

/**
 * Install the opt-in MV_FRAME_DIAG collector and preload IPC receiver when enabled.
 * Registers nothing in retail or nested launches.
 * @param {{ ipcMain?: { handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => Promise<unknown>) => unknown, removeHandler?: (channel: string) => unknown }, contents?: unknown, env?: NodeJS.ProcessEnv, runtime?: { xdgRuntimeDir?: string, uid?: number }, runDir?: string, packaged?: boolean, nested?: boolean, argv?: ReadonlyArray<string>, now?: () => number }} [options]
 * @returns {Readonly<{
 *   enabled: boolean,
 *   runDir: string | null,
 *   requestedWallFps: number,
 *   recordCadence: (cadence: { wallFps: number }) => void,
 *   recordRehashDiag: (payload: unknown, sessionKey?: unknown) => Readonly<{ rehashSkipped: number, rehashDone: number }>,
 *   handleReportDiag: (event: unknown, ...args: unknown[]) => Promise<true>,
 *   recordDelivery: (info: { surfaceId: string, surfaceGeneration: number, frameGeneration: number, epoch: number, announced?: boolean }) => void,
 *   recordReaderRefusal: (info?: { surfaceId?: string, frameGeneration?: number, reason?: string, detail?: string, cause?: string }) => void,
 *   recordPortRefusal: (info?: { surfaceId?: string, frameGeneration?: number, reason?: string }) => void,
 *   recordStateOnly: (info?: { surfaceId?: string }) => void,
 *   recordAck: (ack: { surfaceId: string, surfaceGeneration: number, frameGeneration: number, outcome: string }) => void,
 *   recordRevocation: (notice: { binding?: { surfaceId?: string, surfaceGeneration?: number }, reason: string }) => void,
 *   getSnapshot: () => Record<string, unknown>,
 *   flush: () => Promise<void>,
 *   dispose: () => Promise<void>,
 * }>}
 */
export function installFrameDiag(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new MainError('FRAME_DIAG_OPTIONS', 'options must be an object');
  }
  const config = resolveFrameDiagConfig(options);
  const { ipcMain, contents } = options;
  const packaged =
    Boolean(options.packaged) ||
    fileURLToPath(import.meta.url).includes('.asar/') ||
    fileURLToPath(import.meta.url).includes('.asar\\');
  const nested =
    Boolean(options.nested) ||
    (Array.isArray(options.argv) && options.argv.includes('--nested-depth=1'));

  let disposed = false;
  let requestedWallFps = 30;
  const hasCustomClock = typeof options.now === 'function';
  const clock = hasCustomClock ? /** @type {() => number} */ (options.now) : Date.now;
  const ZERO_REHASH_MAX = Object.freeze({ rehashSkipped: 0, rehashDone: 0 });
  /** @type {WeakMap<object, Readonly<{ rehashSkipped: number, rehashDone: number }>>} */
  const sessionRehashMax = new WeakMap();
  /** @type {Map<unknown, Readonly<{ rehashSkipped: number, rehashDone: number }>>} */
  const scalarSessionRehashMax = new Map();
  /** @type {Readonly<{ rehashSkipped: number, rehashDone: number }>} */
  let latestRehashMax = ZERO_REHASH_MAX;

  /**
   * @param {unknown} sessionKey
   * @returns {Readonly<{ rehashSkipped: number, rehashDone: number }>}
   */
  function getSessionMax(sessionKey) {
    if (sessionKey !== null && (typeof sessionKey === 'object' || typeof sessionKey === 'function')) {
      return sessionRehashMax.get(sessionKey) ?? ZERO_REHASH_MAX;
    }
    return scalarSessionRehashMax.get(sessionKey) ?? ZERO_REHASH_MAX;
  }

  /**
   * @param {unknown} sessionKey
   * @param {Readonly<{ rehashSkipped: number, rehashDone: number }>} next
   */
  function setSessionMax(sessionKey, next) {
    if (sessionKey !== null && (typeof sessionKey === 'object' || typeof sessionKey === 'function')) {
      sessionRehashMax.set(sessionKey, next);
    } else {
      scalarSessionRehashMax.set(sessionKey, next);
    }
    latestRehashMax = Object.freeze({
      rehashSkipped: Math.max(latestRehashMax.rehashSkipped, next.rehashSkipped),
      rehashDone: Math.max(latestRehashMax.rehashDone, next.rehashDone),
    });
  }

  /**
   * @param {unknown} payload
   * @param {unknown} [sessionKey]
   * @returns {{ next: Readonly<{ rehashSkipped: number, rehashDone: number }>, changed: boolean }}
   */
  function applyRehashDiag(payload, sessionKey = contents) {
    const validated = validateFrameRehashDiag(payload);
    const prev = getSessionMax(sessionKey);
    if (validated.rehashSkipped < prev.rehashSkipped || validated.rehashDone < prev.rehashDone) {
      throw new MainError('FRAME_DIAG_DECREASE', 'rehash diag counters must not decrease');
    }
    const next = Object.freeze({
      rehashSkipped: Math.max(prev.rehashSkipped, validated.rehashSkipped),
      rehashDone: Math.max(prev.rehashDone, validated.rehashDone),
    });
    const changed = next.rehashSkipped !== prev.rehashSkipped || next.rehashDone !== prev.rehashDone;
    setSessionMax(sessionKey, next);
    return { next, changed };
  }

  if (!config.enabled || config.runDir === null) {
    let reportRegistered = false;
    /**
     * @param {unknown} event
     * @param {...unknown} args
     * @returns {Promise<true>}
     */
    const handleReportDiagDisabled = async (event, ...args) => {
      if (disposed) {
        throw new MainError('FRAME_DIAG_DISPOSED', 'frame diag bridge is disposed');
      }
      const verdict = observeSender(event, contents, PRIVILEGED_ORIGIN);
      if (verdict.verdict !== 'admit') {
        throw new MainError(verdict.code, 'sender refused');
      }
      if (args.length !== 1) {
        throw new MainError('FRAME_DIAG_ARGS', 'frames.reportDiag requires exactly one argument');
      }
      const senderKey =
        event !== null && typeof event === 'object' && 'sender' in event && event.sender
          ? event.sender
          : contents;
      applyRehashDiag(args[0], senderKey);
      return true;
    };
    if (!packaged && !nested && ipcMain && typeof ipcMain === 'object' && typeof ipcMain.handle === 'function') {
      ipcMain.handle(FRAME_REPORT_DIAG_CHANNEL, handleReportDiagDisabled);
      reportRegistered = true;
    }
    return Object.freeze({
      enabled: false,
      runDir: null,
      get requestedWallFps() {
        return requestedWallFps;
      },
      recordCadence(cadence) {
        if (disposed || !cadence || typeof cadence !== 'object') return;
        if (typeof cadence.wallFps === 'number' && Number.isSafeInteger(cadence.wallFps) && [3, 30, 60].includes(cadence.wallFps)) {
          requestedWallFps = cadence.wallFps;
        }
      },
      recordRehashDiag(payload, sessionKey = contents) {
        return applyRehashDiag(payload, sessionKey).next;
      },
      handleReportDiag: handleReportDiagDisabled,
      recordDelivery: () => {},
      recordReaderRefusal: () => {},
      recordPortRefusal: () => {},
      recordStateOnly: () => {},
      recordAck: () => {},
      recordRevocation: () => {},
      getSnapshot: () =>
        Object.freeze({
          enabled: false,
          requestedWallFps,
          main: Object.freeze({ requestedWallFps }),
          preload: Object.freeze({
            schema: FRAME_DIAG_PRELOAD_SCHEMA,
            rehashSkipped: latestRehashMax.rehashSkipped,
            rehashDone: latestRehashMax.rehashDone,
          }),
        }),
      flush: async () => {},
      async dispose() {
        if (disposed) return;
        disposed = true;
        if (reportRegistered && ipcMain && typeof ipcMain.removeHandler === 'function') {
          try {
            ipcMain.removeHandler(FRAME_REPORT_DIAG_CHANNEL);
          } catch {}
        }
      },
    });
  }
  if (ipcMain === null || ipcMain === undefined || typeof ipcMain !== 'object' || typeof ipcMain.handle !== 'function') {
    throw new MainError('IPC', 'ipcMain must provide handle');
  }
  const targetDir = config.runDir;
  let seq = 0;
  let deliveriesPosted = 0;
  let deliveriesRefusedByReader = 0;
  let deliveriesRefusedByPort = 0;
  let portAnnouncements = 0;
  let stateOnlyPosted = 0;
  let acksReceived = 0;
  /** @type {Record<string, number>} */
  const acksByOutcome = Object.fromEntries(OUTCOME_KEYS.map((key) => [key, 0]));
  let revocationsTotal = 0;
  /** @type {Record<string, number>} */
  const revocationsByReason = Object.fromEntries(REVOKE_KEYS.map((key) => [key, 0]));
  /** @type {Record<string, number>} */
  const readerRefusalsByCause = Object.fromEntries(FRAME_DIAG_ACQUIRE_CAUSES.map((key) => [key, 0]));
  /** @type {Readonly<{ surfaceId: string, surfaceGeneration: number, frameGeneration: number, epoch: number }> | null} */
  let lastDelivery = null;
  /** @type {Readonly<{ surfaceId: string | null, frameGeneration: number | null, reason: string | null, detail: string | null, cause: string | null }> | null} */
  let lastReaderRefusal = null;
  /** @type {Readonly<{ surfaceId: string | null, frameGeneration: number | null, reason: string | null }> | null} */
  let lastPortRefusal = null;
  /** @type {Readonly<{ surfaceId: string, surfaceGeneration: number, frameGeneration: number, outcome: string }> | null} */
  let lastAck = null;
  /** @type {Readonly<{ surfaceId: string | null, surfaceGeneration: number | null, reason: string }> | null} */
  let lastRevocation = null;
  /** @type {Array<Record<string, unknown>>} */
  const recentEvents = [];
  /** @param {Record<string, unknown>} ev */
  function pushEvent(ev) {
    if (recentEvents.length >= 16) recentEvents.shift();
    recentEvents.push(Object.freeze({ ...ev }));
  }
  /** @type {Readonly<{
   *   schema: 'frame_diag_preload/v1',
   *   framesReceived: number,
   *   invalidNotices: number,
   *   portsReceived: number,
   *   noticesForwarded: number,
   *   legacyNoticesForwarded: number,
   *   portsClosed: number,
   *   rehashSkipped: number,
   *   rehashDone: number,
   *   inWallApp: boolean | null,
   *   origin: string,
   *   lastSurfaceId: string | null,
   *   lastSurfaceGeneration: number | null,
   *   lastFrameGeneration: number | null,
   *   domSurfaceState: string | null,
   *   domWaitingText: string | null,
   *   domStripText: string | null,
   * }>} */
  let preloadState = Object.freeze({
    schema: /** @type {'frame_diag_preload/v1'} */ (FRAME_DIAG_PRELOAD_SCHEMA),
    framesReceived: 0,
    invalidNotices: 0,
    portsReceived: 0,
    noticesForwarded: 0,
    legacyNoticesForwarded: 0,
    portsClosed: 0,
    rehashSkipped: 0,
    rehashDone: 0,
    inWallApp: null,
    origin: '',
    lastSurfaceId: null,
    lastSurfaceGeneration: null,
    lastFrameGeneration: null,
    domSurfaceState: null,
    domWaitingText: null,
    domStripText: null,
  });

  /** @type {Promise<unknown>} */
  let writeChain = Promise.resolve();
  /** @type {{ snapshot: Record<string, unknown>, batch: Promise<true>, fromReportDiag: boolean } | null} */
  let pendingBatch = null;
  /** @type {WeakMap<object, number>} */
  const sessionLastReportWriteAt = new WeakMap();
  /** @type {Map<unknown, number>} */
  const scalarSessionLastReportWriteAt = new Map();
  let reportDiagDirty = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reportDiagTimer = null;

  /**
   * @param {unknown} sessionKey
   * @returns {number}
   */
  function getSessionLastWriteAt(sessionKey) {
    if (sessionKey !== null && (typeof sessionKey === 'object' || typeof sessionKey === 'function')) {
      return sessionLastReportWriteAt.get(sessionKey) ?? -Infinity;
    }
    return scalarSessionLastReportWriteAt.get(sessionKey) ?? -Infinity;
  }

  /**
   * @param {unknown} sessionKey
   * @param {number} ts
   */
  function setSessionLastWriteAt(sessionKey, ts) {
    if (sessionKey !== null && (typeof sessionKey === 'object' || typeof sessionKey === 'function')) {
      sessionLastReportWriteAt.set(sessionKey, ts);
    } else {
      scalarSessionLastReportWriteAt.set(sessionKey, ts);
    }
  }

  function buildSnapshot() {
    return Object.freeze({
      schema: FRAME_DIAG_SCHEMA,
      seq,
      requestedWallFps,
      main: Object.freeze({
        requestedWallFps,
        deliveriesPosted,
        deliveriesRefusedByReader,
        deliveriesRefusedByPort,
        portAnnouncements,
        stateOnlyPosted,
        acksReceived,
        acksByOutcome: Object.freeze({ ...acksByOutcome }),
        revocationsTotal,
        revocationsByReason: Object.freeze({ ...revocationsByReason }),
        readerRefusalsByCause: Object.freeze({ ...readerRefusalsByCause }),
        lastDelivery,
        lastReaderRefusal,
        lastPortRefusal,
        lastAck,
        lastRevocation,
        recentEvents: Object.freeze([...recentEvents]),
      }),
      preload: preloadState,
    });
  }

  /**
   * @param {{ fromReportDiag?: boolean }} [opts]
   * @returns {Promise<true>}
   */
  function scheduleWrite(opts = {}) {
    if (disposed) {
      return Promise.resolve(/** @type {true} */ (true));
    }
    const fromReportDiag = opts.fromReportDiag === true;
    if (reportDiagTimer !== null) {
      clearTimeout(reportDiagTimer);
      reportDiagTimer = null;
    }
    reportDiagDirty = false;
    seq += 1;
    const snap = buildSnapshot();
    if (pendingBatch !== null) {
      pendingBatch.snapshot = snap;
      if (fromReportDiag) {
        pendingBatch.fromReportDiag = true;
      }
      return pendingBatch.batch;
    }
    /** @type {{ snapshot: Record<string, unknown>, batch: Promise<true>, fromReportDiag: boolean }} */
    const entry = {
      snapshot: snap,
      batch: /** @type {any} */ (null),
      fromReportDiag,
    };
    pendingBatch = entry;
    const runQueued = async () => {
      if (pendingBatch === entry) {
        pendingBatch = null;
      }
      if (disposed && !entry.fromReportDiag) {
        throw new MainError('FRAME_DIAG_DISPOSED', 'frame diag bridge is disposed');
      }
      return writeFrameDiagSnapshot(targetDir, entry.snapshot);
    };
    const next = writeChain.then(runQueued, runQueued);
    entry.batch = next;
    writeChain = next.catch(() => {});
    return next;
  }

  /**
   * @param {Record<string, unknown>} a
   * @param {Record<string, unknown>} b
   * @returns {boolean}
   */
  function preloadStatesEqual(a, b) {
    if (a === b) return true;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const k of keys) {
      if (!Object.is(a[k], b[k])) return false;
    }
    return true;
  }

  /**
   * Coalesce preload/reportDiag snapshot writes: write only when preload state
   * changes, and at most once per second per session.
   * @param {unknown} sessionKey
   * @param {typeof preloadState} nextPreload
   * @returns {Promise<true>}
   */
  function schedulePreloadDiagWrite(sessionKey, nextPreload) {
    if (!preloadStatesEqual(preloadState, nextPreload)) {
      preloadState = nextPreload;
      reportDiagDirty = true;
    }
    return scheduleDiagWrite(sessionKey);
  }

  /**
   * Share the write budget across renderer diagnostics and cadence changes.
   * @param {unknown} sessionKey
   * @returns {Promise<true>}
   */
  function scheduleDiagWrite(sessionKey) {
    if (!reportDiagDirty) {
      return Promise.resolve(/** @type {true} */ (true));
    }
    const nowMs = clock();
    const lastWriteMs = getSessionLastWriteAt(sessionKey);
    const elapsed = nowMs - lastWriteMs;
    if (elapsed >= 1000) {
      setSessionLastWriteAt(sessionKey, nowMs);
      return scheduleWrite({ fromReportDiag: true });
    }
    if (reportDiagTimer === null) {
      const delayMs = Math.max(1, 1000 - elapsed);
      reportDiagTimer = setTimeout(() => {
        reportDiagTimer = null;
        if (
          !disposed &&
          reportDiagDirty &&
          (!hasCustomClock || clock() - getSessionLastWriteAt(sessionKey) >= 1000)
        ) {
          setSessionLastWriteAt(sessionKey, clock());
          void scheduleWrite({ fromReportDiag: true });
        }
      }, delayMs);
      reportDiagTimer.unref?.();
    }
    return Promise.resolve(/** @type {true} */ (true));
  }

  /**
   * Coalesce reportDiag snapshot writes: merge per-session max monotonically
   * into global preloadState, write only on change, and at most once per second
   * per session.
   * @param {unknown} sessionKey
   * @param {Readonly<{ rehashSkipped: number, rehashDone: number }>} next
   * @returns {Promise<true>}
   */
  function scheduleReportDiagWrite(sessionKey, next) {
    const nextPreload = Object.freeze({
      ...preloadState,
      rehashSkipped: Math.max(preloadState.rehashSkipped, next.rehashSkipped),
      rehashDone: Math.max(preloadState.rehashDone, next.rehashDone),
    });
    return schedulePreloadDiagWrite(sessionKey, nextPreload);
  }

  // Write initial baseline snapshot immediately upon installation.
  void scheduleWrite();

  /**
   * @param {unknown} event Invoke event.
   * @param {...unknown} args Positional payload vector.
   * @returns {Promise<true>}
   */
  async function handleReportDiag(event, ...args) {
    if (disposed) {
      throw new MainError('FRAME_DIAG_DISPOSED', 'frame diag bridge is disposed');
    }
    const verdict = observeSender(event, contents, PRIVILEGED_ORIGIN);
    if (verdict.verdict !== 'admit') {
      throw new MainError(verdict.code, 'sender refused');
    }
    if (args.length !== 1) {
      throw new MainError('FRAME_DIAG_ARGS', 'frames.reportDiag requires exactly one argument');
    }
    const senderKey =
      event !== null && typeof event === 'object' && 'sender' in event && event.sender
        ? event.sender
        : contents;
    const { next } = applyRehashDiag(args[0], senderKey);
    await scheduleReportDiagWrite(senderKey, next);
    return true;
  }

  ipcMain.handle(FRAME_REPORT_DIAG_CHANNEL, handleReportDiag);

  ipcMain.handle(
    FRAME_DIAG_CHANNEL,
    /**
     * @param {unknown} event Invoke event.
     * @param {...unknown} args Positional payload vector.
     * @returns {Promise<true>}
     */
    async (event, ...args) => {
      if (disposed) {
        throw new MainError('FRAME_DIAG_DISPOSED', 'frame diag bridge is disposed');
      }
      const verdict = observeSender(event, contents, PRIVILEGED_ORIGIN);
      if (verdict.verdict !== 'admit') {
        throw new MainError(verdict.code, 'sender refused');
      }
      if (args.length !== 1) {
        throw new MainError('FRAME_DIAG_ARGS', 'frame.diag requires exactly one snapshot argument');
      }
      const candidate = args[0];
      if (hasClosedDataKeys(candidate, 'rehashDone,rehashSkipped')) {
        return handleReportDiag(event, candidate);
      }
      const validated = validateFrameDiagPreload(candidate);
      const senderKey =
        event !== null && typeof event === 'object' && 'sender' in event && event.sender
          ? event.sender
          : contents;
      const prev = getSessionMax(senderKey);
      const rawRec = /** @type {Record<string, unknown>} */ (candidate);
      if (
        (rawRec.rehashSkipped !== undefined && validated.rehashSkipped < prev.rehashSkipped) ||
        (rawRec.rehashDone !== undefined && validated.rehashDone < prev.rehashDone)
      ) {
        throw new MainError('FRAME_DIAG_DECREASE', 'rehash diag counters must not decrease');
      }
      const sessionNext = Object.freeze({
        rehashSkipped: Math.max(prev.rehashSkipped, validated.rehashSkipped),
        rehashDone: Math.max(prev.rehashDone, validated.rehashDone),
      });
      setSessionMax(senderKey, sessionNext);
      const nextPreload = Object.freeze({
        ...validated,
        rehashSkipped: Math.max(preloadState.rehashSkipped, sessionNext.rehashSkipped),
        rehashDone: Math.max(preloadState.rehashDone, sessionNext.rehashDone),
      });
      await schedulePreloadDiagWrite(senderKey, nextPreload);
      return true;
    },
  );

  return Object.freeze({
    enabled: true,
    runDir: targetDir,
    get requestedWallFps() {
      return requestedWallFps;
    },
    recordCadence(cadence) {
      if (disposed || !cadence || typeof cadence !== 'object') {
        return;
      }
      if (typeof cadence.wallFps === 'number' && Number.isSafeInteger(cadence.wallFps) && [3, 30, 60].includes(cadence.wallFps)) {
        if (requestedWallFps !== cadence.wallFps) {
          requestedWallFps = cadence.wallFps;
          reportDiagDirty = true;
          void scheduleDiagWrite(contents);
        }
      }
    },
    recordRehashDiag(payload, sessionKey = contents) {
      if (disposed) {
        throw new MainError('FRAME_DIAG_DISPOSED', 'frame diag bridge is disposed');
      }
      const { next } = applyRehashDiag(payload, sessionKey);
      void scheduleReportDiagWrite(sessionKey, next);
      return next;
    },
    handleReportDiag,
    recordDelivery(info) {
      if (disposed || !info || typeof info !== 'object') {
        return;
      }
      deliveriesPosted += 1;
      if (info.announced === true) {
        portAnnouncements += 1;
      }
      if (
        typeof info.surfaceId === 'string' &&
        Number.isSafeInteger(info.surfaceGeneration) &&
        Number.isSafeInteger(info.frameGeneration) &&
        Number.isSafeInteger(info.epoch)
      ) {
        lastDelivery = Object.freeze({
          surfaceId: info.surfaceId,
          surfaceGeneration: info.surfaceGeneration,
          frameGeneration: info.frameGeneration,
          epoch: info.epoch,
        });
        pushEvent({ kind: 'delivered', frameGeneration: info.frameGeneration, surfaceGeneration: info.surfaceGeneration, announced: Boolean(info.announced) });
      }
      void scheduleWrite();
    },
    recordReaderRefusal(info) {
      if (disposed) {
        return;
      }
      deliveriesRefusedByReader += 1;
      if (info && typeof info === 'object') {
        const detail = typeof info.detail === 'string' ? info.detail : null;
        const cause =
          typeof info.cause === 'string' && Object.hasOwn(readerRefusalsByCause, info.cause)
            ? info.cause
            : detail === 'acquire-failed'
              ? 'UNKNOWN'
              : null;
        if (cause !== null) {
          readerRefusalsByCause[cause] += 1;
        }
        lastReaderRefusal = Object.freeze({
          surfaceId: typeof info.surfaceId === 'string' && SURFACE_ID_RE.test(info.surfaceId) ? info.surfaceId : null,
          frameGeneration: Number.isSafeInteger(info.frameGeneration) ? /** @type {number} */ (info.frameGeneration) : null,
          reason: typeof info.reason === 'string' ? info.reason : null,
          detail,
          cause,
        });
        pushEvent({
          kind: 'reader_refusal',
          frameGeneration: lastReaderRefusal.frameGeneration,
          reason: lastReaderRefusal.reason,
          detail: lastReaderRefusal.detail,
          cause: lastReaderRefusal.cause,
        });
      }
      void scheduleWrite();
    },
    recordPortRefusal(info) {
      if (disposed) {
        return;
      }
      deliveriesRefusedByPort += 1;
      if (info && typeof info === 'object') {
        lastPortRefusal = Object.freeze({
          surfaceId: typeof info.surfaceId === 'string' ? info.surfaceId : null,
          frameGeneration: Number.isSafeInteger(info.frameGeneration) ? /** @type {number} */ (info.frameGeneration) : null,
          reason: typeof info.reason === 'string' ? info.reason : null,
        });
        pushEvent({ kind: 'port_refusal', frameGeneration: lastPortRefusal.frameGeneration, reason: lastPortRefusal.reason });
      }
      void scheduleWrite();
    },
    recordStateOnly() {
      if (disposed) {
        return;
      }
      stateOnlyPosted += 1;
      void scheduleWrite();
    },
    recordAck(ack) {
      if (disposed || !ack || typeof ack !== 'object') {
        return;
      }
      acksReceived += 1;
      if (typeof ack.outcome === 'string' && Object.hasOwn(acksByOutcome, ack.outcome)) {
        acksByOutcome[ack.outcome] += 1;
      }
      if (
        typeof ack.surfaceId === 'string' &&
        Number.isSafeInteger(ack.surfaceGeneration) &&
        Number.isSafeInteger(ack.frameGeneration) &&
        typeof ack.outcome === 'string'
      ) {
        lastAck = Object.freeze({
          surfaceId: ack.surfaceId,
          surfaceGeneration: ack.surfaceGeneration,
          frameGeneration: ack.frameGeneration,
          outcome: ack.outcome,
        });
        pushEvent({ kind: 'ack', frameGeneration: ack.frameGeneration, surfaceGeneration: ack.surfaceGeneration, outcome: ack.outcome });
      }
      void scheduleWrite();
    },
    recordRevocation(notice) {
      if (disposed || !notice || typeof notice !== 'object') {
        return;
      }
      revocationsTotal += 1;
      if (typeof notice.reason === 'string' && Object.hasOwn(revocationsByReason, notice.reason)) {
        revocationsByReason[notice.reason] += 1;
      }
      if (typeof notice.reason === 'string') {
        const sid =
          typeof notice.binding?.surfaceId === 'string' ? notice.binding.surfaceId : null;
        const sgen =
          typeof notice.binding?.surfaceGeneration === 'number' &&
          Number.isSafeInteger(notice.binding.surfaceGeneration)
            ? notice.binding.surfaceGeneration
            : null;
        lastRevocation = Object.freeze({
          surfaceId: sid,
          surfaceGeneration: sgen,
          reason: notice.reason,
        });
      }
      void scheduleWrite();
    },
    getSnapshot() {
      return buildSnapshot();
    },
    async flush() {
      if (reportDiagTimer !== null) {
        clearTimeout(reportDiagTimer);
        reportDiagTimer = null;
      }
      if (reportDiagDirty && !disposed) {
        await scheduleWrite({ fromReportDiag: true });
      }
      await writeChain;
    },
    async dispose() {
      if (disposed) {
        return;
      }
      if (reportDiagTimer !== null) {
        clearTimeout(reportDiagTimer);
        reportDiagTimer = null;
      }
      const flushDirty = reportDiagDirty;
      reportDiagDirty = false;
      disposed = true;
      try {
        if (typeof ipcMain.removeHandler === 'function') {
          ipcMain.removeHandler(FRAME_DIAG_CHANNEL);
          ipcMain.removeHandler(FRAME_REPORT_DIAG_CHANNEL);
        }
      } catch {
        /* teardown best-effort */
      }
      if (flushDirty) {
        seq += 1;
        const snap = buildSnapshot();
        if (pendingBatch !== null && pendingBatch.fromReportDiag) {
          pendingBatch.snapshot = snap;
        } else {
          const writeFinal = () => writeFrameDiagSnapshot(targetDir, snap);
          writeChain = writeChain.then(writeFinal, writeFinal).catch(() => {});
        }
      }
      await writeChain;
    },
  });
}
