// @ts-check
'use strict';

/**
 * DISPLAY-READER-R2: Electron side of the 20-30 fps DISPLAY tier (U-DEC-0153).
 *
 * Reads `<DISPLAY base>/metaviewer/display/<surface_id>.ring` using the
 * seqlock protocol in `DISPLAY_RING_SPEC.md`, enforcing the same path, mode,
 * owner, symlink and tmpfs guards as `hostBindings.js`. Caps reads at 30/s per
 * tile, pauses while the tile is hidden or folded, reopens on generation or
 * inode changes, emits stale after 2 s without `capture_mono_ns` advancing,
 * and falls back to VERIFIED-only rendering when the ring file is absent.
 * [TARGET, unit decision] Offer endpoints on guarded open before frame I/O; replacement demand
 * permits one validated repaint without advancing capture liveness.
 *
 * @module displayReader
 */

import { constants as fsConstants } from 'node:fs';
import { lstat, open, statfs as nodeStatfs } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { createDisplayPort, DISPLAY_PORT_NOTICE_SCHEMA } from './framePort.js';

/** Magic bytes `MVDISP1\0` at offset 0..7 of the display ring header. */
export const DISPLAY_RING_MAGIC = Buffer.from([0x4d, 0x56, 0x44, 0x49, 0x53, 0x50, 0x31, 0x00]);

/** Linux `TMPFS_MAGIC` (`0x01021994`). */
export const TMPFS_MAGIC = 0x01021994;

/** Header byte length fixed by `DISPLAY_RING_SPEC.md`. */
export const DISPLAY_HEADER_BYTES = 64;

/** Maximum reads per second per tile [TARGET]. */
export const DISPLAY_MAX_FPS = 30;

/** Milliseconds without `capture_mono_ns` advancement before marking stale [TARGET]. */
export const DISPLAY_STALE_MS = 2000;

/** Supported pixel format codes in the ring header. */
export const DISPLAY_FORMATS = Object.freeze({
  RGB24: 1,
  BGRX32: 2,
});

/** Closed refusal / outcome reasons for `displayReader`. */
export const DISPLAY_READER_REASONS = Object.freeze({
  RING_ABSENT: 'RING_ABSENT',
  HIDDEN: 'HIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  IN_FLIGHT: 'IN_FLIGHT',
  OPEN_PATH: 'OPEN_PATH',
  OPEN_SYMLINK: 'OPEN_SYMLINK',
  OPEN_IO: 'OPEN_IO',
  STAT_NOT_FILE: 'STAT_NOT_FILE',
  STAT_UID: 'STAT_UID',
  STAT_MODE: 'STAT_MODE',
  NOT_TMPFS: 'NOT_TMPFS',
  INVALID_HEADER: 'INVALID_HEADER',
  SIZE_MISMATCH: 'SIZE_MISMATCH',
  EMPTY_RING: 'EMPTY_RING',
  TORN_SEQ_ODD: 'TORN_SEQ_ODD',
  TORN_SEQ_CHANGED: 'TORN_SEQ_CHANGED',
  UNCHANGED: 'UNCHANGED',
  CLOSED: 'CLOSED',
});

const SURFACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const FILE_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0);
const DEFAULT_MAX_WIDTH = 4096;
const DEFAULT_MAX_HEIGHT = 4096;
const DEFAULT_MAX_FRAME_BYTES = DEFAULT_MAX_WIDTH * DEFAULT_MAX_HEIGHT * 4;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function validSurfaceId(value) {
  return (
    typeof value === 'string' &&
    SURFACE_ID_RE.test(value) &&
    !value.includes('..') &&
    !value.includes('/')
  );
}

/**
 * @param {unknown} root
 * @returns {root is string}
 */
function validRuntimeRoot(root) {
  return (
    typeof root === 'string' &&
    root.length >= 1 &&
    root.length <= 512 &&
    !root.includes('\0') &&
    isAbsolute(root) &&
    resolve(root) === root
  );
}

/**
 * Parse and validate the 64-byte ring header.
 * @param {Buffer} buf
 * @param {{ maxWidth: number, maxHeight: number, maxFrameBytes: number }} limits
 */
function parseRingHeader(buf, limits) {
  if (!Buffer.isBuffer(buf) || buf.byteLength < DISPLAY_HEADER_BYTES) {
    return null;
  }
  if (!buf.subarray(0, 8).equals(DISPLAY_RING_MAGIC)) {
    return null;
  }
  for (let i = 48; i < 64; i += 1) {
    if (buf[i] !== 0) return null;
  }
  const width = buf.readUInt32LE(8);
  const height = buf.readUInt32LE(12);
  const stride = buf.readUInt32LE(16);
  const format = buf.readUInt32LE(20);
  if (
    width < 1 ||
    width > limits.maxWidth ||
    height < 1 ||
    height > limits.maxHeight ||
    (format !== DISPLAY_FORMATS.RGB24 && format !== DISPLAY_FORMATS.BGRX32)
  ) {
    return null;
  }
  const bytesPerPixel = format === DISPLAY_FORMATS.RGB24 ? 3 : 4;
  const minStride = width * bytesPerPixel;
  if (stride < minStride || stride > limits.maxWidth * 4 + 4096) {
    return null;
  }
  const slotBytes = stride * height;
  if (!Number.isSafeInteger(slotBytes) || slotBytes < 1 || slotBytes > limits.maxFrameBytes) {
    return null;
  }
  const seq = buf.readBigUInt64LE(24);
  const captureMonoNs = buf.readBigUInt64LE(32);
  const generation = buf.readBigUInt64LE(40);
  return {
    width,
    height,
    stride,
    format,
    slotBytes,
    expectedFileSize: DISPLAY_HEADER_BYTES + 2 * slotBytes,
    seq,
    captureMonoNs,
    generation,
  };
}

/**
 * Convert a raw slot buffer (`RGB24` or `BGRX32`, with optional row padding)
 * into a tightly-packed `RGB24` `Uint8Array(width * height * 3)`.
 *
 * @param {Buffer} slotBuf
 * @param {{ width: number, height: number, stride: number, format: number }} spec
 * @returns {Uint8Array}
 */
function convertSlotToRgb24(slotBuf, spec) {
  const { width, height, stride, format } = spec;
  const rowRgbBytes = width * 3;
  const out = new Uint8Array(rowRgbBytes * height);
  if (format === DISPLAY_FORMATS.RGB24) {
    if (stride === rowRgbBytes) {
      out.set(slotBuf.subarray(0, rowRgbBytes * height));
      return out;
    }
    for (let y = 0; y < height; y += 1) {
      const srcRow = y * stride;
      out.set(slotBuf.subarray(srcRow, srcRow + rowRgbBytes), y * rowRgbBytes);
    }
    return out;
  }
  // format === DISPLAY_FORMATS.BGRX32: [B, G, R, X] -> [R, G, B]
  let dstIdx = 0;
  for (let y = 0; y < height; y += 1) {
    let srcIdx = y * stride;
    for (let x = 0; x < width; x += 1) {
      out[dstIdx] = slotBuf[srcIdx + 2];
      out[dstIdx + 1] = slotBuf[srcIdx + 1];
      out[dstIdx + 2] = slotBuf[srcIdx];
      dstIdx += 3;
      srcIdx += 4;
    }
  }
  return out;
}

/**
 * Open and validate the ring file under `$XDG_RUNTIME_DIR/metaviewer/display/<surface_id>.ring`,
 * walking the parent directories without following symlinks and verifying owner
 * uid, mode (0700 on directories, 0600 on ring file) and `TMPFS_MAGIC`.
 *
 * @param {{
 *   runtimeDir: string,
 *   surfaceId: string,
 *   uid: number,
 *   statfsFn: typeof nodeStatfs,
 *   onOpened?: () => void,
 * }} params
 * @returns {Promise<
 *   | { ok: true, handle: import('node:fs/promises').FileHandle, stat: import('node:fs').Stats, path: string }
 *   | { ok: false, reason: string }
 * >}
 */
export async function openGuardedRingFile({ runtimeDir, surfaceId, uid, statfsFn, onOpened }) {
  const effectiveUid =
    typeof uid === 'number' ? uid : typeof process.getuid === 'function' ? process.getuid() : -1;
  const effectiveStatfs = statfsFn ?? nodeStatfs;
  if (!validRuntimeRoot(runtimeDir) || !validSurfaceId(surfaceId)) {
    return { ok: false, reason: DISPLAY_READER_REASONS.OPEN_PATH };
  }
  const normalizedRoot = runtimeDir.endsWith('/metaviewer')
    ? runtimeDir.slice(0, -'/metaviewer'.length)
    : runtimeDir;
  const mvDir = join(normalizedRoot, 'metaviewer');
  const displayDir = join(mvDir, 'display');
  const ringFileName = `${surfaceId}.ring`;
  const ringPath = join(displayDir, ringFileName);

  /** @type {import('node:fs/promises').FileHandle | null} */
  let pinnedDir = null;
  try {
    const dirSteps = [
      { fullPath: normalizedRoot, relName: normalizedRoot },
      { fullPath: mvDir, relName: 'metaviewer' },
      { fullPath: displayDir, relName: 'display' },
    ];
    for (const step of dirSteps) {
      let lst;
      try {
        lst = await lstat(step.fullPath);
      } catch (err) {
        const code = /** @type {any} */ (err)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return { ok: false, reason: DISPLAY_READER_REASONS.RING_ABSENT };
        }
        return { ok: false, reason: DISPLAY_READER_REASONS.OPEN_IO };
      }
      if (lst.isSymbolicLink()) {
        return { ok: false, reason: DISPLAY_READER_REASONS.OPEN_SYMLINK };
      }
      if (!lst.isDirectory()) {
        return { ok: false, reason: DISPLAY_READER_REASONS.OPEN_PATH };
      }
      if (lst.uid !== effectiveUid) {
        return { ok: false, reason: DISPLAY_READER_REASONS.STAT_UID };
      }
      if ((lst.mode & 0o077) !== 0) {
        return { ok: false, reason: DISPLAY_READER_REASONS.STAT_MODE };
      }
      const openTarget =
        pinnedDir === null ? step.fullPath : `/proc/self/fd/${pinnedDir.fd}/${step.relName}`;
      let nextDir;
      try {
        nextDir = await open(openTarget, DIR_FLAGS);
      } catch (err) {
        const code = /** @type {any} */ (err)?.code;
        if (code === 'ELOOP' || code === 'EMLINK' || code === 'ENOTDIR') {
          return { ok: false, reason: DISPLAY_READER_REASONS.OPEN_SYMLINK };
        }
        if (code === 'ENOENT') {
          return { ok: false, reason: DISPLAY_READER_REASONS.RING_ABSENT };
        }
        return { ok: false, reason: DISPLAY_READER_REASONS.OPEN_IO };
      }
      if (pinnedDir !== null) {
        await pinnedDir.close().catch(() => {});
      }
      pinnedDir = nextDir;
      const dst = await pinnedDir.stat();
      if (
        !dst.isDirectory() ||
        dst.ino !== lst.ino ||
        dst.dev !== lst.dev ||
        dst.uid !== effectiveUid ||
        (dst.mode & 0o077) !== 0
      ) {
        return { ok: false, reason: DISPLAY_READER_REASONS.OPEN_SYMLINK };
      }
    }

    let fileLst;
    try {
      fileLst = await lstat(ringPath);
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (code === 'ENOENT') {
        return { ok: false, reason: DISPLAY_READER_REASONS.RING_ABSENT };
      }
      return { ok: false, reason: DISPLAY_READER_REASONS.OPEN_IO };
    }
    if (fileLst.isSymbolicLink()) {
      return { ok: false, reason: DISPLAY_READER_REASONS.OPEN_SYMLINK };
    }
    if (!fileLst.isFile()) {
      return { ok: false, reason: DISPLAY_READER_REASONS.STAT_NOT_FILE };
    }
    if (fileLst.uid !== effectiveUid) {
      return { ok: false, reason: DISPLAY_READER_REASONS.STAT_UID };
    }
    if ((fileLst.mode & 0o777) !== 0o600) {
      return { ok: false, reason: DISPLAY_READER_REASONS.STAT_MODE };
    }

    const fileTarget =
      pinnedDir !== null ? `/proc/self/fd/${pinnedDir.fd}/${ringFileName}` : ringPath;
    /** @type {import('node:fs/promises').FileHandle} */
    let fh;
    try {
      fh = await open(fileTarget, FILE_FLAGS);
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (code === 'ELOOP' || code === 'EMLINK') {
        return { ok: false, reason: DISPLAY_READER_REASONS.OPEN_SYMLINK };
      }
      if (code === 'ENOENT') {
        return { ok: false, reason: DISPLAY_READER_REASONS.RING_ABSENT };
      }
      return { ok: false, reason: DISPLAY_READER_REASONS.OPEN_IO };
    }
    try {
      const fst = await fh.stat();
      if (!fst.isFile() || fst.isSymbolicLink()) {
        await fh.close().catch(() => {});
        return { ok: false, reason: DISPLAY_READER_REASONS.STAT_NOT_FILE };
      }
      if (fst.ino !== fileLst.ino || fst.dev !== fileLst.dev) {
        await fh.close().catch(() => {});
        return { ok: false, reason: DISPLAY_READER_REASONS.OPEN_SYMLINK };
      }
      if (fst.uid !== effectiveUid) {
        await fh.close().catch(() => {});
        return { ok: false, reason: DISPLAY_READER_REASONS.STAT_UID };
      }
      if ((fst.mode & 0o777) !== 0o600) {
        await fh.close().catch(() => {});
        return { ok: false, reason: DISPLAY_READER_REASONS.STAT_MODE };
      }
      let sfs;
      try {
        onOpened?.();
        sfs = await effectiveStatfs(ringPath);
      } catch {
        await fh.close().catch(() => {});
        return { ok: false, reason: DISPLAY_READER_REASONS.NOT_TMPFS };
      }
      if (Number(sfs?.type) !== TMPFS_MAGIC) {
        await fh.close().catch(() => {});
        return { ok: false, reason: DISPLAY_READER_REASONS.NOT_TMPFS };
      }
      return { ok: true, handle: fh, stat: fst, path: ringPath };
    } catch {
      await fh.close().catch(() => {});
      return { ok: false, reason: DISPLAY_READER_REASONS.OPEN_IO };
    }
  } finally {
    if (pinnedDir !== null) {
      await pinnedDir.close().catch(() => {});
    }
  }
}

/**
 * Create a per-tile display ring reader.
 *
 * @param {{
 *   runtimeDir: string,
 *   surfaceId: string,
 *   uid?: number,
 *   maxFps?: number,
 *   staleTimeoutMs?: number,
 *   maxWidth?: number,
 *   maxHeight?: number,
 *   maxFrameBytes?: number,
 *   visible?: boolean,
 *   statfs?: typeof nodeStatfs,
 *   clock?: () => number,
 *   setTimer?: (cb: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 *   onFrame?: (frame: {
 *     surfaceId: string,
 *     generation: string,
 *     seq: string,
 *     captureMonoNs: string,
 *     width: number,
 *     height: number,
 *     format: 'rgb24',
 *     bytes: Uint8Array,
 *   }) => void,
 *   onState?: (state: 'active' | 'stale' | 'absent', generation: string) => void,
 *   onRefusal?: (reason: string) => void,
 *   onRingOpened?: () => void,
 *   onBeforeHeaderReRead?: (info: { seq: bigint, slotIndex: number }) => Promise<void> | void,
 * }} options
 */
export function createDisplayReader(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('DISPLAY_READER_OPTIONS');
  }
  const runtimeDir = options.runtimeDir;
  const surfaceId = options.surfaceId;
  const uid =
    typeof options.uid === 'number'
      ? options.uid
      : typeof process.getuid === 'function'
        ? process.getuid()
        : -1;
  const maxFps =
    typeof options.maxFps === 'number' && options.maxFps >= 1 && options.maxFps <= 30
      ? options.maxFps
      : DISPLAY_MAX_FPS;
  const staleTimeoutMs =
    typeof options.staleTimeoutMs === 'number' && options.staleTimeoutMs > 0
      ? options.staleTimeoutMs
      : DISPLAY_STALE_MS;
  const limits = {
    maxWidth: options.maxWidth ?? DEFAULT_MAX_WIDTH,
    maxHeight: options.maxHeight ?? DEFAULT_MAX_HEIGHT,
    maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
  };
  const statfsFn = options.statfs ?? nodeStatfs;
  const clock = options.clock ?? (() => Date.now());
  const setTimer =
    options.setTimer ??
    ((cb, ms) => {
      const t = setTimeout(cb, ms);
      if (t !== null && typeof t === 'object' && typeof t.unref === 'function') t.unref();
      return t;
    });
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  const onFrame = typeof options.onFrame === 'function' ? options.onFrame : null;
  const onState = typeof options.onState === 'function' ? options.onState : null;
  const onRefusal = typeof options.onRefusal === 'function' ? options.onRefusal : null;
  function onOpened() {
    if (!closed && visible) options.onRingOpened?.();
  }
  const onBeforeHeaderReRead =
    typeof options.onBeforeHeaderReRead === 'function' ? options.onBeforeHeaderReRead : null;

  /** @type {import('node:fs/promises').FileHandle | null} */
  let openHandle = null;
  /** @type {number | bigint | null} */
  let openIno = null;
  /** @type {number | bigint | null} */
  let openDev = null;
  /** @type {bigint | null} */
  let lastGeneration = null;
  /** @type {bigint} */
  let lastSeq = 0n;
  /** @type {bigint | null} */
  let lastCaptureMonoNs = null;
  /** @type {number | null} */
  let lastAdvanceAtMs = null;
  // [TARGET, unit decision] A replacement endpoint needs one validated read,
  // even for a static capture. Delivery demand never resets capture liveness.
  let repaintRequested = false;
  /** @type {'absent' | 'active' | 'stale'} */
  let currentState = 'absent';

  let visible = options.visible !== false;
  let running = false;
  let closed = false;
  let inFlight = false;
  /** @type {any} */
  let pollTimer = null;
  let nextTargetMs = 0;

  // Instrumentation counters
  let readsAttempted = 0;
  let framesRead = 0;
  // A visibility/stop transition must not close the descriptor underneath an
  // awaited seqlock read. close() drains that read before releasing resources.
  let closeAfterRead = false;
  /** @type {Promise<void>} */ let readDrain = Promise.resolve();
  let tornReads = 0;
  let refusals = 0;
  let reopens = 0;
  /** @type {string | null} */
  let lastRefusalReason = null;
  /** @type {number[]} */
  const readStamps = [];

  const headerBuf1 = Buffer.alloc(DISPLAY_HEADER_BYTES);
  const headerBuf2 = Buffer.alloc(DISPLAY_HEADER_BYTES);
  /** @type {Buffer | null} */
  let scratchSlotBuf = null;

  async function closeHandle() {
    const h = openHandle;
    openHandle = null;
    openIno = null;
    openDev = null;
    if (h !== null) {
      await h.close().catch(() => {});
    }
  }

  /** @param {'absent' | 'active' | 'stale'} nextState */
  function transitionState(nextState) {
    if (currentState === nextState) return;
    currentState = nextState;
    if (onState !== null) {
      try {
        onState(nextState, String(lastGeneration ?? 0n));
      } catch {
        /* ignore consumer error */
      }
    }
  }

  /** @param {string} reason */
  function recordRefusal(reason) {
    refusals += 1;
    lastRefusalReason = reason;
    if (onRefusal !== null) {
      try {
        onRefusal(reason);
      } catch {
        /* ignore consumer error */
      }
    }
  }

  /** @param {number} nowMs */
  function checkStaleness(nowMs) {
    if (lastAdvanceAtMs !== null && nowMs - lastAdvanceAtMs >= staleTimeoutMs) {
      transitionState('stale');
      return true;
    }
    return false;
  }

  /**
   * Perform at most one non-blocking seqlock read.
   * @param {{ ignoreRateLimit?: boolean }} [readOpts]
   */
  async function readOnce(readOpts) {
    if (closed) {
      return { ok: false, reason: DISPLAY_READER_REASONS.CLOSED };
    }
    if (!visible) {
      return { ok: false, reason: DISPLAY_READER_REASONS.HIDDEN };
    }
    if (inFlight) {
      return { ok: false, reason: DISPLAY_READER_REASONS.IN_FLIGHT };
    }
    const nowMs = clock();
    while (readStamps.length > 0 && nowMs - readStamps[0] >= 1000) {
      readStamps.shift();
    }
    if (!readOpts?.ignoreRateLimit && readStamps.length >= maxFps) {
      checkStaleness(nowMs);
      return { ok: false, reason: DISPLAY_READER_REASONS.RATE_LIMITED };
    }

    inFlight = true;
    /** @type {()=>void} */ let finishRead = () => {};
    readDrain = new Promise(resolve => { finishRead = resolve; });
    readStamps.push(nowMs);
    readsAttempted += 1;
    try {
      const ringPath =
        validRuntimeRoot(runtimeDir) && validSurfaceId(surfaceId)
          ? join(runtimeDir, 'metaviewer', 'display', `${surfaceId}.ring`)
          : '';
      if (openHandle !== null && ringPath.length > 0) {
        try {
          const curLst = await lstat(ringPath);
          if (
            curLst.isSymbolicLink() ||
            !curLst.isFile() ||
            curLst.uid !== uid ||
            (curLst.mode & 0o777) !== 0o600
          ) {
            await closeHandle();
          } else if (curLst.ino !== openIno || curLst.dev !== openDev) {
            await closeHandle();
            reopens += 1;
          }
        } catch {
          await closeHandle();
        }
      }

      if (openHandle === null) {
        const opened = await openGuardedRingFile({ runtimeDir, surfaceId, uid, statfsFn, onOpened });
        if (!opened.ok) {
          if (opened.reason === DISPLAY_READER_REASONS.RING_ABSENT) {
            lastGeneration = null;
            lastSeq = 0n;
            lastCaptureMonoNs = null;
            lastAdvanceAtMs = null;
            transitionState('absent');
            return { ok: false, reason: DISPLAY_READER_REASONS.RING_ABSENT };
          }
          transitionState('absent');
          recordRefusal(opened.reason);
          return { ok: false, reason: opened.reason };
        }
        openHandle = opened.handle;
        openIno = opened.stat.ino;
        openDev = opened.stat.dev;
      }

      if (closed || !visible || openHandle === null) {
        await closeHandle();
        return { ok: false, reason: DISPLAY_READER_REASONS.HIDDEN };
      }

      const h1Read = await openHandle.read(headerBuf1, 0, DISPLAY_HEADER_BYTES, 0);
      if (h1Read.bytesRead !== DISPLAY_HEADER_BYTES) {
        await closeHandle();
        recordRefusal(DISPLAY_READER_REASONS.INVALID_HEADER);
        return { ok: false, reason: DISPLAY_READER_REASONS.INVALID_HEADER };
      }
      let h1 = parseRingHeader(headerBuf1, limits);
      if (h1 === null) {
        await closeHandle();
        recordRefusal(DISPLAY_READER_REASONS.INVALID_HEADER);
        return { ok: false, reason: DISPLAY_READER_REASONS.INVALID_HEADER };
      }

      // Reopen on generation change per spec.
      if (lastGeneration !== null && h1.generation !== lastGeneration) {
        await closeHandle();
        reopens += 1;
        const reopened = await openGuardedRingFile({ runtimeDir, surfaceId, uid, statfsFn, onOpened });
        if (!reopened.ok) {
          if (reopened.reason !== DISPLAY_READER_REASONS.RING_ABSENT) {
            recordRefusal(reopened.reason);
          }
          transitionState('absent');
          return { ok: false, reason: reopened.reason };
        }
        openHandle = reopened.handle;
        openIno = reopened.stat.ino;
        openDev = reopened.stat.dev;
        lastGeneration = h1.generation;
        lastSeq = 0n;
        lastCaptureMonoNs = null;
        const h1ReRead = await openHandle.read(headerBuf1, 0, DISPLAY_HEADER_BYTES, 0);
        if (h1ReRead.bytesRead !== DISPLAY_HEADER_BYTES) {
          await closeHandle();
          recordRefusal(DISPLAY_READER_REASONS.INVALID_HEADER);
          return { ok: false, reason: DISPLAY_READER_REASONS.INVALID_HEADER };
        }
        h1 = parseRingHeader(headerBuf1, limits);
        if (h1 === null) {
          await closeHandle();
          recordRefusal(DISPLAY_READER_REASONS.INVALID_HEADER);
          return { ok: false, reason: DISPLAY_READER_REASONS.INVALID_HEADER };
        }
      }

      const fst = await openHandle.stat();
      if (fst.size !== h1.expectedFileSize) {
        await closeHandle();
        recordRefusal(DISPLAY_READER_REASONS.SIZE_MISMATCH);
        return { ok: false, reason: DISPLAY_READER_REASONS.SIZE_MISMATCH };
      }

      if (h1.seq === 0n) {
        checkStaleness(clock());
        return { ok: false, reason: DISPLAY_READER_REASONS.EMPTY_RING };
      }
      if ((h1.seq & 1n) === 1n) {
        tornReads += 1;
        checkStaleness(clock());
        return { ok: false, reason: DISPLAY_READER_REASONS.TORN_SEQ_ODD };
      }

      if (
        !repaintRequested &&
        lastGeneration === h1.generation &&
        lastSeq === h1.seq &&
        lastCaptureMonoNs === h1.captureMonoNs
      ) {
        checkStaleness(clock());
        return { ok: false, reason: DISPLAY_READER_REASONS.UNCHANGED };
      }

      const slotIndex = Number((h1.seq / 2n) % 2n);
      const slotOffset = DISPLAY_HEADER_BYTES + slotIndex * h1.slotBytes;
      if (scratchSlotBuf === null || scratchSlotBuf.byteLength < h1.slotBytes) {
        scratchSlotBuf = Buffer.allocUnsafe(h1.slotBytes);
      }
      const slotRead = await openHandle.read(scratchSlotBuf, 0, h1.slotBytes, slotOffset);
      if (slotRead.bytesRead !== h1.slotBytes) {
        tornReads += 1;
        return { ok: false, reason: DISPLAY_READER_REASONS.TORN_SEQ_CHANGED };
      }

      if (onBeforeHeaderReRead !== null) {
        await onBeforeHeaderReRead({ seq: h1.seq, slotIndex });
      }

      const h2Read = await openHandle.read(headerBuf2, 0, DISPLAY_HEADER_BYTES, 0);
      if (h2Read.bytesRead !== DISPLAY_HEADER_BYTES) {
        tornReads += 1;
        return { ok: false, reason: DISPLAY_READER_REASONS.TORN_SEQ_CHANGED };
      }
      const h2 = parseRingHeader(headerBuf2, limits);
      if (
        h2 === null ||
        h2.seq !== h1.seq ||
        (h2.seq & 1n) !== 0n ||
        h2.generation !== h1.generation ||
        h2.captureMonoNs !== h1.captureMonoNs ||
        h2.width !== h1.width ||
        h2.height !== h1.height ||
        h2.stride !== h1.stride ||
        h2.format !== h1.format
      ) {
        tornReads += 1;
        checkStaleness(clock());
        return { ok: false, reason: DISPLAY_READER_REASONS.TORN_SEQ_CHANGED };
      }

      if (closed || !visible) return {ok:false,reason:closed ? DISPLAY_READER_REASONS.CLOSED : DISPLAY_READER_REASONS.HIDDEN};
      const nowAfterRead = clock();
      const monoAdvanced = lastCaptureMonoNs === null || h1.captureMonoNs !== lastCaptureMonoNs;
      lastGeneration = h1.generation;
      lastSeq = h1.seq;
      lastCaptureMonoNs = h1.captureMonoNs;

      if (!monoAdvanced && !repaintRequested) {
        checkStaleness(nowAfterRead);
        return { ok: false, reason: DISPLAY_READER_REASONS.UNCHANGED };
      }

      repaintRequested = false;
      if (monoAdvanced) lastAdvanceAtMs = nowAfterRead;
      const rgbBytes = convertSlotToRgb24(scratchSlotBuf, h1);
      framesRead += 1;
      if (monoAdvanced) transitionState('active');
      // Preserve the ring u64 identity across structured clone. UnixNano
      // generations exceed Number.MAX_SAFE_INTEGER in real tap sessions.
      const frame = Object.freeze({
        surfaceId,
        generation: String(h1.generation),
        seq: String(h1.seq),
        captureMonoNs: String(h1.captureMonoNs),
        width: h1.width,
        height: h1.height,
        format: /** @type {'rgb24'} */ ('rgb24'),
        bytes: rgbBytes,
      });
      if (onFrame !== null) {
        try {
          onFrame(frame);
        } catch {
          /* ignore consumer fault */
        }
      }
      // Send stale after the replay so the renderer cannot treat delivery as
      // proof of a new capture, including when this reader was already stale.
      if (!monoAdvanced) {
        const wasStale = currentState === 'stale';
        if (checkStaleness(nowAfterRead) && wasStale && onState !== null) {
          try { onState('stale', String(lastGeneration)); } catch { /* consumer fault */ }
        }
      }
      return { ok: true, frame };
    } finally {
      try {
        if (closeAfterRead || closed || !visible) {
          closeAfterRead = false;
          await closeHandle();
        }
      } finally { inFlight = false; finishRead(); }
    }
  }

  function scheduleNextTick() {
    if (!running || !visible || closed || pollTimer !== null) return;
    const stepMs = 1000 / maxFps;
    const now = clock();
    if (nextTargetMs <= now) {
      nextTargetMs = now + stepMs;
    } else {
      nextTargetMs += stepMs;
    }
    const delayMs = Math.max(1, Math.floor(nextTargetMs - now));
    pollTimer = setTimer(() => {
      pollTimer = null;
      if (!running || !visible || closed) return;
      void readOnce().finally(() => {
        scheduleNextTick();
      });
    }, delayMs);
  }

  function stopPolling() {
    if (pollTimer !== null) {
      const h = pollTimer;
      pollTimer = null;
      clearTimer(h);
    }
  }

  function start() {
    if (closed || running) return;
    running = true;
    nextTargetMs = clock();
    if (visible) {
      void readOnce().finally(() => {
        scheduleNextTick();
      });
    }
  }

  function stop() {
    running = false;
    stopPolling();
    closeAfterRead = inFlight;
    if (!inFlight) void closeHandle();
  }

  /** @param {boolean} nextVisible */
  function setVisible(nextVisible) {
    const boolVisible = Boolean(nextVisible);
    if (visible === boolVisible) return;
    visible = boolVisible;
    if (!visible) {
      stopPolling();
      closeAfterRead = inFlight;
      if (!inFlight) void closeHandle();
    } else if (running && !closed) {
      nextTargetMs = clock();
      void readOnce().finally(() => {
        scheduleNextTick();
      });
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    running = false;
    stopPolling();
    await readDrain;
    await closeHandle();
  }

  function getInstrumentation() {
    const nowMs = clock();
    while (readStamps.length > 0 && nowMs - readStamps[0] >= 1000) {
      readStamps.shift();
    }
    return Object.freeze({
      surfaceId,
      visible,
      running,
      closed,
      state: currentState,
      readsAttempted,
      readsPerSecond: readStamps.length,
      framesRead,
      tornReads,
      refusals,
      reopens,
      lastRefusalReason,
      lastGeneration: lastGeneration === null ? null : String(lastGeneration),
      lastSeq: String(lastSeq),
      lastCaptureMonoNs: lastCaptureMonoNs === null ? null : String(lastCaptureMonoNs),
    });
  }

  return Object.freeze({
    start,
    stop,
    setVisible,
    readOnce,
    requestRepaint() { repaintRequested = true; },
    close,
    getInstrumentation,
  });
}

/**
 * Host coordinator managing per-surface `displayReader` and `createDisplayPort`
 * instances in `hostBindings.js`. Offers a channel on guarded ring open;
 * only validated reads can publish DISPLAY pixels on that channel.
 *
 * @param {{
 *   root: string,
 *   env?: NodeJS.ProcessEnv,
 *   uid?: number,
 *   createDisplayChannel?: () => { port1: any, port2: any },
 *   statfs?: typeof nodeStatfs,
 *   clock?: () => number,
 *   setTimer?: (cb: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 * }} options
 */
export function createDisplayHost(options) {
  // DISPLAY ring base (spec v1.1): MV_DISPLAY_DIR, else /dev/shm/metaviewer-display-<uid> (tmpfs).
  // The packaged app's private XDG_RUNTIME_DIR lives under /tmp, which is not tmpfs on every host.
  const runtimeDir = options?.root ?? displayBaseDir(options?.env ?? process.env);
  const enabled = (options?.env ?? process.env).MV_DISPLAY_TAP !== 'off';
  const channelFactory = options?.createDisplayChannel ?? (() => new MessageChannel());
  /**
   * @type {Map<string, {
   *   reader: ReturnType<typeof createDisplayReader>,
   *   displayPort: ReturnType<typeof createDisplayPort> | null,
   *   rendererPort: any | null,
   *   announced: boolean,
   *   lastRequest: number,
   *   hostVisible: boolean,
   *   rendererVisible: boolean,
   * }>}
   */
  const entries = new Map();
  /** @type {Set<(notice: { surfaceId: string, port: any }) => void>} */
  const portListeners = new Set();
  let rendererSubscribed = false;
  let disposed = false;
  // [TARGET, unit decision] Retail diagnostics: posted + first valid renderer
  // ACK (or timeout), at most two lines per live surface. Off creates no timer.
  /** @type {Map<string, {done:boolean,timer:ReturnType<typeof setTimeout>|null}>} */
  const portDiagnostics = new Map();
  // [TARGET, unit decision] Always-on retail stages, one line per stage per
  // known surface, at most 256 surfaces. No frame bytes or untrusted text.
  /** @type {Map<string, Set<string>>} */
  const stageDiagnostics = new Map();
  /** @param {any} value */
  function noteStage(value) {
    if (!enabled || disposed || !value || !entries.has(value.surface_id)
        || Object.keys(value).sort().join(',') !== 'detail,schema,stage,surface_id'
        || value.schema !== 'display_diagnostic/v1'
        || !['PRELOAD_GOT_PORT','PRELOAD_FORWARDED','ROUTER_ATTACHED','FIRST_FRAME','FIRST_PAINT','REFUSED','VISIBILITY'].includes(value.stage)
        || !['OK','VISIBLE','HIDDEN','INVALID_PORTS','TRANSFER_FAILED','UNSAFE_GENERATION','INVALID_DELIVERY','SURFACE_MISMATCH','NO_BINDING','PAINT_FAILED'].includes(value.detail)) return;
    let stages = stageDiagnostics.get(value.surface_id);
    if (!stages) {
      if (stageDiagnostics.size >= 256) return;
      stages = new Set(); stageDiagnostics.set(value.surface_id, stages);
    }
    if (stages.has(value.stage)) return;
    stages.add(value.stage);
    console.error(`METAVIEWER_DISPLAY_STAGE surface=${value.surface_id} stage=${value.stage} detail=${value.detail}`);
  }
  /** @param {string} surfaceId @param {boolean} [posted] */
  function notePortPosted(surfaceId, posted = true) {
    if (!enabled || disposed || portDiagnostics.has(surfaceId)) return;
    const diagnostic = { done: !posted, timer: /** @type {ReturnType<typeof setTimeout>|null} */ (null) };
    portDiagnostics.set(surfaceId, diagnostic);
    console.error(`METAVIEWER_DISPLAY_PORT surface=${surfaceId} posted=${posted}`);
    if (posted) {
      diagnostic.timer = setTimeout(() => {
        diagnostic.timer = null;
        if (diagnostic.done) return;
        diagnostic.done = true;
        console.error(`METAVIEWER_DISPLAY_ACK surface=${surfaceId} outcome=TIMEOUT`);
      }, 3000);
      diagnostic.timer.unref?.();
    }
  }
  /** @param {string} surfaceId */
  function clearPortDiagnostic(surfaceId) {
    const diagnostic = portDiagnostics.get(surfaceId);
    if (diagnostic?.timer) clearTimeout(diagnostic.timer);
    portDiagnostics.delete(surfaceId);
  }

  /** @param {string} surfaceId */
  function ensurePortChannel(surfaceId) {
    const entry = entries.get(surfaceId);
    if (!entry || disposed) return null;
    if (entry.displayPort !== null) {
      if (rendererSubscribed && !entry.announced && entry.rendererPort !== null) {
        entry.announced = true;
        const portToSend = entry.rendererPort;
        entry.rendererPort = null;
        for (const listener of [...portListeners]) {
          try {
            listener({ surfaceId, port: portToSend });
          } catch {
            /* ignore */
          }
        }
      }
      return entry.displayPort;
    }
    const channel = channelFactory();
    entry.rendererPort = channel.port2;
    channel.port1.on?.('message', (/** @type {any} */ event) => {
      const raw = event?.data ?? event;
      const diagnostic = portDiagnostics.get(surfaceId);
      if (!diagnostic || diagnostic.done || raw?.schema !== 'display_ack/v1'
          || raw.kind !== 'display_ack' || raw.surfaceId !== surfaceId
          || !['PRESENTED', 'HIDDEN', 'REFUSED'].includes(raw.outcome)
          || !/^[0-9]{1,20}$/.test(String(raw.seq)) || BigInt(raw.seq) < 2n || (BigInt(raw.seq) & 1n)) return;
      diagnostic.done = true;
      if (diagnostic.timer) clearTimeout(diagnostic.timer);
      diagnostic.timer = null;
      console.error(`METAVIEWER_DISPLAY_ACK surface=${surfaceId} outcome=${raw.outcome}`);
    });
    entry.displayPort = createDisplayPort({
      port: channel.port1,
      surfaceId,
      onVisibilityChange: (vis) => {
        entry.rendererVisible = vis;
        entry.reader.setVisible(entry.hostVisible && entry.rendererVisible);
      },
      onRevoke: () => {
        entry.displayPort = null;
        entry.rendererPort = null;
        entry.announced = false;
      },
    });
    if (rendererSubscribed && entry.rendererPort !== null) {
      entry.announced = true;
      const portToSend = entry.rendererPort;
      entry.rendererPort = null;
      for (const listener of [...portListeners]) {
        try {
          listener({ surfaceId, port: portToSend });
        } catch {
          /* ignore */
        }
      }
    }
    return entry.displayPort;
  }

  // [TARGET, unit decision] Pull replaces the transferred endpoint atomically.
  // Unknown surfaces allocate nothing; at most four replacements/second/surface.
  /** @param {string} surfaceId */
  function requestPort(surfaceId) {
    const entry = entries.get(surfaceId);
    if (!enabled || disposed || !entry || !rendererSubscribed) return false;
    const now = options.clock?.() ?? Date.now();
    if (now - entry.lastRequest < 250) return false;
    entry.lastRequest = now;
    entry.displayPort?.close();
    try { entry.rendererPort?.close?.(); } catch {}
    entry.displayPort = null;
    entry.rendererPort = null;
    entry.announced = false; // advisory for unsolicited offers only
    entry.rendererVisible = true;
    entry.reader.setVisible(entry.hostVisible);
    entry.reader.requestRepaint();
    ensurePortChannel(surfaceId);
    return true;
  }

  /** @param {any} state */
  function updateSurface(state) {
    if (!enabled || disposed || !state || !validSurfaceId(state.surface_id)) return;
    const surfaceId = state.surface_id;
    const hostVisible =
      state.state === 'active' &&
      state.visibility !== 'folded' &&
      state.visibility !== 'hidden';
    let entry = entries.get(surfaceId);
    if (!entry) {
      const reader = createDisplayReader({
        runtimeDir,
        surfaceId,
        uid: options?.uid,
        visible: hostVisible,
        statfs: options?.statfs,
        clock: options?.clock,
        setTimer: options?.setTimer,
        clearTimer: options?.clearTimer,
        onRingOpened: () => { ensurePortChannel(surfaceId); },
        onFrame: (frame) => {
          const dp = ensurePortChannel(surfaceId);
          dp?.postDisplayFrame(frame);
        },
        onState: (nextState, generation) => {
          if (nextState === 'absent' && entry?.displayPort === null) return;
          const dp = ensurePortChannel(surfaceId);
          dp?.postDisplayState(nextState, generation);
        },
      });
      entry = {
        reader,
        displayPort: null,
        rendererPort: null,
        announced: false,
        lastRequest: -Infinity,
        hostVisible,
        rendererVisible: true,
      };
      entries.set(surfaceId, entry);
      if (rendererSubscribed) {
        reader.start();
      }
    } else {
      entry.hostVisible = hostVisible;
      entry.reader.setVisible(entry.hostVisible && entry.rendererVisible);
      if (rendererSubscribed) {
        entry.reader.start();
      }
    }
  }

  /** @param {string} surfaceId */
  function removeSurface(surfaceId) {
    const entry = entries.get(surfaceId);
    if (!entry) return;
    entries.delete(surfaceId);
    stageDiagnostics.delete(surfaceId);
    clearPortDiagnostic(surfaceId);
    void entry.reader.close();
    entry.displayPort?.close();
    try {
      entry.rendererPort?.close?.();
    } catch {
      /* ignore */
    }
  }

  /** @param {boolean} subscribed */
  function setSubscribed(subscribed) {
    rendererSubscribed = Boolean(subscribed);
    if (disposed) return;
    for (const [surfaceId, entry] of entries) {
      if (rendererSubscribed) {
        entry.reader.start();
        if (entry.displayPort !== null && !entry.announced && entry.rendererPort !== null) {
          entry.announced = true;
          const portToSend = entry.rendererPort;
          entry.rendererPort = null;
          for (const listener of [...portListeners]) {
            try {
              listener({ surfaceId, port: portToSend });
            } catch {
              /* ignore */
            }
          }
        }
      } else {
        entry.reader.stop();
      }
    }
  }

  /** @param {(notice: { surfaceId: string, port: any }) => void} listener */
  function subscribePorts(listener) {
    if (typeof listener !== 'function') return () => {};
    portListeners.add(listener);
    if (rendererSubscribed) {
      for (const [surfaceId, entry] of entries) {
        if (entry.displayPort !== null && !entry.announced && entry.rendererPort !== null) {
          entry.announced = true;
          const portToSend = entry.rendererPort;
          entry.rendererPort = null;
          try {
            listener({ surfaceId, port: portToSend });
          } catch {
            /* ignore */
          }
        }
      }
    }
    return () => {
      portListeners.delete(listener);
    };
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    portListeners.clear();
    stageDiagnostics.clear();
    for (const surfaceId of portDiagnostics.keys()) clearPortDiagnostic(surfaceId);
    const closing = [];
    for (const entry of entries.values()) {
      closing.push(entry.reader.close());
      entry.displayPort?.close();
      try {
        entry.rendererPort?.close?.();
      } catch {
        /* ignore */
      }
    }
    entries.clear();
    await Promise.allSettled(closing);
  }

  /** @param {string} surfaceId */
  function getReaderInstrumentation(surfaceId) {
    return entries.get(surfaceId)?.reader.getInstrumentation() ?? null;
  }

  return Object.freeze({
    updateSurface,
    removeSurface,
    setSubscribed,
    notePortPosted,
    noteStage,
    requestPort,
    subscribe: subscribePorts,
    subscribePorts,
    getReaderInstrumentation,
    dispose,
  });
}

/**
 * Install the main-process display port forwarder onto `webContents`.
 *
 * @param {{
 *   contents: any,
 *   ipcMain: any,
 *   display: ReturnType<typeof createDisplayHost> | null | undefined,
 * }} options
 */
export function installDisplayBridge(options) {
  const contents = options?.contents;
  const display = options?.display;
  if (!display || typeof display.subscribePorts !== 'function') {
    return Object.freeze({
      dispose: async () => {},
    });
  }
  // [TARGET, unit decision] The host subscribes before the document loads.
  // Retain native ports until the isolated preload has installed its receiver;
  // Electron drops IPC transfers posted before that listener exists.
  const channel = 'metaviewer:display-receiver-ready';
  const ipcMain = options.ipcMain;
  // Injected invoke-only hosts have no native receiver hooks: keep DISPLAY
  // queued until disposal instead of breaking their other IPC services.
  let receiverReady = false;
  let disposed = false;
  /** @type {Map<string, any>} */
  const pending = new Map();
  /** @param {string} surfaceId @param {any} port */
  function post(surfaceId, port) {
    if (disposed || !contents || typeof contents.postMessage !== 'function' || contents.isDestroyed?.()) {
      try { port?.close?.(); } catch {}
      return;
    }
    try {
      contents.postMessage('metaviewer:authority.frames',
        { schema: DISPLAY_PORT_NOTICE_SCHEMA, surface_id: surfaceId }, [port]);
      display?.notePortPosted(surfaceId);
    } catch {
      display?.notePortPosted(surfaceId, false);
      try { port?.close?.(); } catch {}
    }
  }
  /** @param {any} event */
  function ready(event) {
    if (disposed || event?.sender !== contents || event.senderFrame !== contents.mainFrame
        || !/^app:\/\/metaviewer\//.test(event.senderFrame?.url ?? '')) return;
    receiverReady = true;
    for (const [surfaceId, port] of pending) post(surfaceId, port);
    pending.clear();
  }
  /** @param {any} event @param {any} value */
  function request(event, value) {
    if (disposed || event?.sender !== contents || event.senderFrame !== contents.mainFrame
        || !/^app:\/\/metaviewer\//.test(event.senderFrame?.url ?? '')
        || !value || Object.keys(value).sort().join(',') !== 'schema,surface_id'
        || value.schema !== 'display_request/v1' || !validSurfaceId(value.surface_id)) return;
    ready(event); // a pull supersedes a missed native-ready announcement
    display?.requestPort?.(value.surface_id);
  }
  ipcMain?.on?.('metaviewer:display-request', request);
  /** @param {any} event @param {any} value */
  function diagnostic(event, value) {
    if (disposed || event?.sender !== contents || event.senderFrame !== contents.mainFrame
        || !/^app:\/\/metaviewer\//.test(event.senderFrame?.url ?? '')) return;
    display?.noteStage(value);
  }
  ipcMain?.on?.('metaviewer:display-diagnostic', diagnostic);
  ipcMain?.on?.(channel, ready);
  const unsubscribe = display.subscribePorts(({ surfaceId, port }) => {
    if (receiverReady) { post(surfaceId, port); return; }
    try { pending.get(surfaceId)?.close?.(); } catch {}
    pending.delete(surfaceId);
    if (pending.size >= 256) {
      const first = pending.keys().next().value;
      if (first !== undefined) { try { pending.get(first)?.close?.(); } catch {} pending.delete(first); }
    }
    pending.set(surfaceId, port);
  });
  return Object.freeze({
    async dispose() {
      disposed = true;
      ipcMain?.removeListener?.(channel, ready);
      ipcMain?.removeListener?.('metaviewer:display-request', request);
      ipcMain?.removeListener?.('metaviewer:display-diagnostic', diagnostic);
      for (const port of pending.values()) { try { port?.close?.(); } catch {} }
      pending.clear();
      unsubscribe();
      await display.dispose();
    },
  });
}

/** @param {Record<string, string | undefined>} env @returns {string} */
export function displayBaseDir(env) {
  if (typeof env.MV_DISPLAY_DIR === 'string' && env.MV_DISPLAY_DIR !== '') return env.MV_DISPLAY_DIR;
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  return uid >= 0 ? `/dev/shm/metaviewer-display-${uid}` : '';
}
