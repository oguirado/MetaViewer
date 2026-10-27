// @ts-check
/**
 * [TARGET, unit decision] Env-gated frame pipeline diagnostics for live QA and
 * production-path E2E verification. Active only when MV_FRAME_DIAG=1 in a
 * non-packaged, non-nested launch. Main tracks frame deliveries posted,
 * frame_ack/v0.2 outcomes received, and stream revocations by reason; preload
 * reports notices forwarded over an internal channel without adding any
 * window.metaviewer facade method. Snapshots are written atomically (0600) to
 * frame-diag.json in the verified private run directory.
 */
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MainError, observeSender, PRIVILEGED_ORIGIN } from './main.js';
import { validateQaRunDir } from './qaAnchors.js';

export const FRAME_DIAG_CHANNEL = 'metaviewer:frame.diag';
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
 *   inWallApp: boolean | null,
 *   origin: string,
 *   lastSurfaceId: string | null,
 *   lastSurfaceGeneration: number | null,
 *   domSurfaceState: string | null,
 *   domWaitingText: string | null,
 *   domStripText: string | null,
 * }>}
 */
export function validateFrameDiagPreload(payload) {
  const expectedKeys =
    'domStripText,domSurfaceState,domWaitingText,framesReceived,inWallApp,invalidNotices,lastSurfaceGeneration,lastSurfaceId,legacyNoticesForwarded,noticesForwarded,origin,portsClosed,portsReceived,schema';
  const legacyKeys =
    'framesReceived,inWallApp,invalidNotices,lastSurfaceGeneration,lastSurfaceId,legacyNoticesForwarded,noticesForwarded,origin,portsClosed,portsReceived,schema';
  if (!hasClosedDataKeys(payload, expectedKeys) && !hasClosedDataKeys(payload, legacyKeys)) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag must have closed keys');
  }
  if (payload.schema !== FRAME_DIAG_PRELOAD_SCHEMA) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag schema must be frame_diag_preload/v1');
  }
  if (
    !isNonNegativeSafeInt(payload.framesReceived) ||
    !isNonNegativeSafeInt(payload.invalidNotices) ||
    !isNonNegativeSafeInt(payload.portsReceived) ||
    !isNonNegativeSafeInt(payload.noticesForwarded) ||
    !isNonNegativeSafeInt(payload.legacyNoticesForwarded) ||
    !isNonNegativeSafeInt(payload.portsClosed)
  ) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag counters must be non-negative safe integers');
  }
  if (payload.inWallApp !== null && typeof payload.inWallApp !== 'boolean') {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag inWallApp must be boolean or null');
  }
  if (
    typeof payload.origin !== 'string' ||
    payload.origin.length > 256 ||
    payload.origin.includes('\0')
  ) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag origin must be a bounded string');
  }
  if (
    payload.lastSurfaceId !== null &&
    (typeof payload.lastSurfaceId !== 'string' || !SURFACE_ID_RE.test(payload.lastSurfaceId))
  ) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag lastSurfaceId is invalid');
  }
  if (
    payload.lastSurfaceGeneration !== null &&
    (typeof payload.lastSurfaceGeneration !== 'number' ||
      !Number.isSafeInteger(payload.lastSurfaceGeneration) ||
      payload.lastSurfaceGeneration < 1)
  ) {
    throw new MainError('FRAME_DIAG_PAYLOAD', 'preload diag lastSurfaceGeneration is invalid');
  }
  for (const domField of ['domSurfaceState', 'domWaitingText', 'domStripText']) {
    const val = payload[domField];
    if (val !== undefined && val !== null && (typeof val !== 'string' || val.length > 512 || val.includes('\0'))) {
      throw new MainError('FRAME_DIAG_PAYLOAD', `preload diag ${domField} is invalid`);
    }
  }
  return Object.freeze({
    schema: /** @type {'frame_diag_preload/v1'} */ (FRAME_DIAG_PRELOAD_SCHEMA),
    framesReceived: payload.framesReceived,
    invalidNotices: payload.invalidNotices,
    portsReceived: payload.portsReceived,
    noticesForwarded: payload.noticesForwarded,
    legacyNoticesForwarded: payload.legacyNoticesForwarded,
    portsClosed: payload.portsClosed,
    inWallApp: payload.inWallApp,
    origin: payload.origin,
    lastSurfaceId: payload.lastSurfaceId,
    lastSurfaceGeneration: payload.lastSurfaceGeneration,
    domSurfaceState: typeof payload.domSurfaceState === 'string' ? payload.domSurfaceState : null,
    domWaitingText: typeof payload.domWaitingText === 'string' ? payload.domWaitingText : null,
    domStripText: typeof payload.domStripText === 'string' ? payload.domStripText : null,
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
    await unlink(tempPath).catch((error) => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
        throw error;
      }
    });
  }
}

/**
 * Install the opt-in MV_FRAME_DIAG collector and preload IPC receiver when enabled.
 * Registers nothing in retail or nested launches.
 * @param {{ ipcMain?: { handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => Promise<unknown>) => unknown, removeHandler?: (channel: string) => unknown }, contents?: unknown, env?: NodeJS.ProcessEnv, runtime?: { xdgRuntimeDir?: string, uid?: number }, runDir?: string, packaged?: boolean, nested?: boolean, argv?: ReadonlyArray<string> }} [options]
 * @returns {Readonly<{
 *   enabled: boolean,
 *   runDir: string | null,
 *   recordDelivery: (info: { surfaceId: string, surfaceGeneration: number, frameGeneration: number, epoch: number, announced?: boolean }) => void,
 *   recordReaderRefusal: (info?: { surfaceId?: string, frameGeneration?: number, reason?: string, detail?: string }) => void,
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
  if (!config.enabled || config.runDir === null) {
    const emptySnapshot = Object.freeze({ enabled: false });
    return Object.freeze({
      enabled: false,
      runDir: null,
      recordDelivery: () => {},
      recordReaderRefusal: () => {},
      recordPortRefusal: () => {},
      recordStateOnly: () => {},
      recordAck: () => {},
      recordRevocation: () => {},
      getSnapshot: () => emptySnapshot,
      flush: async () => {},
      dispose: async () => {},
    });
  }
  const { ipcMain, contents } = options;
  if (ipcMain === null || ipcMain === undefined || typeof ipcMain !== 'object' || typeof ipcMain.handle !== 'function') {
    throw new MainError('IPC', 'ipcMain must provide handle');
  }
  const targetDir = config.runDir;
  let disposed = false;
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
  /** @type {Readonly<{ surfaceId: string, surfaceGeneration: number, frameGeneration: number, epoch: number }> | null} */
  let lastDelivery = null;
  /** @type {Readonly<{ surfaceId: string | null, frameGeneration: number | null, reason: string | null, detail: string | null }> | null} */
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
   *   inWallApp: boolean | null,
   *   origin: string,
   *   lastSurfaceId: string | null,
   *   lastSurfaceGeneration: number | null,
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
    inWallApp: null,
    origin: '',
    lastSurfaceId: null,
    lastSurfaceGeneration: null,
    domSurfaceState: null,
    domWaitingText: null,
    domStripText: null,
  });

  /** @type {Promise<unknown>} */
  let writeChain = Promise.resolve();

  function buildSnapshot() {
    return Object.freeze({
      schema: FRAME_DIAG_SCHEMA,
      seq,
      main: Object.freeze({
        deliveriesPosted,
        deliveriesRefusedByReader,
        deliveriesRefusedByPort,
        portAnnouncements,
        stateOnlyPosted,
        acksReceived,
        acksByOutcome: Object.freeze({ ...acksByOutcome }),
        revocationsTotal,
        revocationsByReason: Object.freeze({ ...revocationsByReason }),
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
   * @returns {Promise<true>}
   */
  function scheduleWrite() {
    if (disposed) {
      return Promise.resolve(/** @type {true} */ (true));
    }
    seq += 1;
    const snap = buildSnapshot();
    const next = writeChain.then(
      () => writeFrameDiagSnapshot(targetDir, snap),
      () => writeFrameDiagSnapshot(targetDir, snap),
    );
    writeChain = next.catch(() => {});
    return next;
  }

  // Write initial baseline snapshot immediately upon installation.
  void scheduleWrite();

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
      preloadState = validateFrameDiagPreload(args[0]);
      await scheduleWrite();
      return true;
    },
  );

  return Object.freeze({
    enabled: true,
    runDir: targetDir,
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
        lastReaderRefusal = Object.freeze({
          surfaceId: typeof info.surfaceId === 'string' ? info.surfaceId : null,
          frameGeneration: Number.isSafeInteger(info.frameGeneration) ? /** @type {number} */ (info.frameGeneration) : null,
          reason: typeof info.reason === 'string' ? info.reason : null,
          detail: typeof info.detail === 'string' ? info.detail : null,
        });
        pushEvent({ kind: 'reader_refusal', frameGeneration: lastReaderRefusal.frameGeneration, reason: lastReaderRefusal.reason, detail: lastReaderRefusal.detail });
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
      await writeChain;
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        if (typeof ipcMain.removeHandler === 'function') {
          ipcMain.removeHandler(FRAME_DIAG_CHANNEL);
        }
      } catch {
        /* teardown best-effort */
      }
      await writeChain;
    },
  });
}
