// @ts-check
/**
 * [TARGET, unit decision] Opt-in read-only QA anchor snapshot bridge for live
 * vision runs. Active only when MV_E2E_LIVE=1 in a non-packaged, non-nested
 * launch. Preload fail-fast validates the closed qa_anchors/v1 payload; main
 * revalidates sender identity and payload shape and atomically writes 0600
 * qa-anchors.json inside the live stack's private run directory (never a
 * renderer-supplied path).
 */
import { constants as fsConstants, lstatSync, realpathSync } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MainError, observeSender, PRIVILEGED_ORIGIN } from './main.js';

export const QA_ANCHORS_CHANNEL = 'metaviewer:qa.anchors';
export const QA_ANCHORS_SCHEMA = 'qa_anchors/v1';
export const QA_ANCHORS_FILE = 'qa-anchors.json';
export const QA_USER_AGENT_TOKEN = '--qa-anchors=1';
export const QA_MAX_ROWS = 512;
export const QA_MAX_BYTES = 64 * 1024;
export const QA_MAX_NAME_CHARS = 128;
export const QA_MAX_ANCHOR_CHARS = 200;
export const QA_MAX_ANCHOR_SEGMENTS = 6;
export const QA_MAX_ANCHOR_SEGMENT_CHARS = 64;

export const QA_ANCHOR_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const ANCHOR = /^(?=.{1,200}$)[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._:-]{0,63}){0,5}$/;
export const QA_ANCHOR_RE = ANCHOR;
const QA_ROLE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SOURCE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Validate a QA semantic anchor against the hierarchical grammar:
 * one to six segments joined by "/", each segment ^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$,
 * total length <= 200, no empty segment, no "." or ".." segment, no leading or trailing "/".
 * @param {unknown} anchor Candidate anchor value.
 * @returns {anchor is string}
 */
export function isValidQaAnchor(anchor) {
  if (typeof anchor !== 'string' || anchor.length < 1 || anchor.length > QA_MAX_ANCHOR_CHARS) {
    return false;
  }
  if (!ANCHOR.test(anchor)) {
    return false;
  }
  const segments = anchor.split('/');
  if (segments.length < 1 || segments.length > QA_MAX_ANCHOR_SEGMENTS) {
    return false;
  }
  return segments.every(
    (segment) =>
      segment.length >= 1 &&
      segment.length <= QA_MAX_ANCHOR_SEGMENT_CHARS &&
      segment !== '.' &&
      segment !== '..' &&
      QA_ANCHOR_SEGMENT_RE.test(segment),
  );
}

export const isValidAnchor = isValidQaAnchor;

/**
 * Assert that a candidate value is a valid QA semantic anchor.
 * @param {unknown} anchor Candidate anchor value.
 * @returns {string}
 */
export function validateQaAnchor(anchor) {
  if (!isValidQaAnchor(anchor)) {
    throw new MainError('QA_PAYLOAD', 'row anchor is invalid');
  }
  return anchor;
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
 * Reject lone UTF-16 surrogates while permitting valid astral code points.
 * @param {string} text Candidate string.
 * @returns {boolean}
 */
function isWellFormedText(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
      } else {
        return false;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Validate and normalize a closed qa_anchors/v1 snapshot.
 * @param {unknown} snapshot Alleged snapshot payload.
 * @returns {{ readonly schema: 'qa_anchors/v1', readonly seq: number, readonly rows: ReadonlyArray<{ readonly anchor: string, readonly role: string, readonly name: string, readonly rect: { readonly x: number, readonly y: number, readonly w: number, readonly h: number } }> }}
 */
export function validateQaSnapshot(snapshot) {
  if (!hasClosedDataKeys(snapshot, 'rows,schema,seq')) {
    throw new MainError('QA_PAYLOAD', 'snapshot must have closed {schema,seq,rows} keys');
  }
  if (snapshot.schema !== QA_ANCHORS_SCHEMA) {
    throw new MainError('QA_PAYLOAD', 'snapshot schema must be qa_anchors/v1');
  }
  if (typeof snapshot.seq !== 'number' || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 1) {
    throw new MainError('QA_PAYLOAD', 'snapshot seq must be a positive safe integer');
  }
  const rowsInput = snapshot.rows;
  if (
    !Array.isArray(rowsInput) ||
    Object.getPrototypeOf(rowsInput) !== Array.prototype ||
    rowsInput.length > QA_MAX_ROWS ||
    Reflect.ownKeys(rowsInput).length !== rowsInput.length + 1
  ) {
    throw new MainError('QA_PAYLOAD', 'snapshot rows must be a dense array within row cap');
  }
  const normalizedRows = [];
  for (let i = 0; i < rowsInput.length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(rowsInput, i);
    if (desc === undefined || !('value' in desc)) {
      throw new MainError('QA_PAYLOAD', 'snapshot row entry must be a data property');
    }
    const row = desc.value;
    if (!hasClosedDataKeys(row, 'anchor,name,rect,role')) {
      throw new MainError('QA_PAYLOAD', 'row must have closed {anchor,role,name,rect} keys');
    }
    const anchor = validateQaAnchor(row.anchor);
    if (typeof row.role !== 'string' || !QA_ROLE_RE.test(row.role)) {
      throw new MainError('QA_PAYLOAD', 'row role is invalid');
    }
    if (
      typeof row.name !== 'string' ||
      row.name.length > QA_MAX_NAME_CHARS ||
      row.name.includes('\0') ||
      !isWellFormedText(row.name)
    ) {
      throw new MainError('QA_PAYLOAD', 'row name is invalid');
    }
    const rect = row.rect;
    if (!hasClosedDataKeys(rect, 'h,w,x,y')) {
      throw new MainError('QA_PAYLOAD', 'row rect must have closed {x,y,w,h} keys');
    }
    if (
      typeof rect.x !== 'number' || !Number.isSafeInteger(rect.x) ||
      typeof rect.y !== 'number' || !Number.isSafeInteger(rect.y) ||
      typeof rect.w !== 'number' || !Number.isSafeInteger(rect.w) || rect.w <= 0 ||
      typeof rect.h !== 'number' || !Number.isSafeInteger(rect.h) || rect.h <= 0
    ) {
      throw new MainError('QA_PAYLOAD', 'row rect coordinates must be integer CSS px with positive dimensions');
    }
    normalizedRows.push(
      Object.freeze({
        anchor,
        role: row.role,
        name: row.name,
        rect: Object.freeze({
          x: rect.x,
          y: rect.y,
          w: rect.w,
          h: rect.h,
        }),
      }),
    );
  }
  const normalized = Object.freeze({
    schema: /** @type {'qa_anchors/v1'} */ (QA_ANCHORS_SCHEMA),
    seq: snapshot.seq,
    rows: Object.freeze(normalizedRows),
  });
  const encoded = JSON.stringify(normalized);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > QA_MAX_BYTES) {
    throw new MainError('QA_PAYLOAD', 'snapshot exceeds 64 KiB serialized cap');
  }
  return normalized;
}

/**
 * Ensure candidate path lies strictly outside the repository source root.
 * @param {string} candidate Absolute path.
 * @returns {void}
 */
function assertOutsideSource(candidate) {
  const rel = relative(SOURCE_ROOT, resolve(candidate));
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new MainError('QA_RUN_DIR', 'qa run dir must be outside repository root');
  }
}

/**
 * Validate a private run directory synchronously at installation time.
 * @param {unknown} rawDir Candidate directory path from trusted environment.
 * @returns {string} Verified run directory path.
 */
export function validateQaRunDir(rawDir) {
  if (
    typeof rawDir !== 'string' ||
    rawDir.length < 1 ||
    rawDir.length > 4096 ||
    /[\0\r\n]/.test(rawDir) ||
    !isAbsolute(rawDir)
  ) {
    throw new MainError('QA_RUN_DIR', 'qa run dir must be a bounded absolute path');
  }
  assertOutsideSource(rawDir);
  let info;
  try {
    info = lstatSync(rawDir);
  } catch {
    throw new MainError('QA_RUN_DIR', 'qa run dir does not exist');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (uid >= 0 && info.uid !== uid) ||
    (info.mode & 0o777) !== 0o700
  ) {
    throw new MainError('QA_RUN_DIR', 'qa run dir must be an owner-only 0700 directory');
  }
  let canonical;
  try {
    canonical = realpathSync(rawDir);
  } catch {
    throw new MainError('QA_RUN_DIR', 'qa run dir cannot be canonicalized');
  }
  assertOutsideSource(canonical);
  const canonicalStat = lstatSync(canonical);
  if (
    !canonicalStat.isDirectory() ||
    canonicalStat.isSymbolicLink() ||
    (uid >= 0 && canonicalStat.uid !== uid) ||
    (canonicalStat.mode & 0o777) !== 0o700
  ) {
    throw new MainError('QA_RUN_DIR', 'canonical qa run dir must be an owner-only 0700 directory');
  }
  return rawDir;
}

/**
 * Resolve QA anchor enablement and run directory from main launch context.
 * @param {{ env?: NodeJS.ProcessEnv, runtime?: { xdgRuntimeDir?: string, uid?: number }, runDir?: string, packaged?: boolean, nested?: boolean, argv?: ReadonlyArray<string> }} [options]
 * @returns {Readonly<{ enabled: boolean, runDir: string | null }>}
 */
export function resolveQaConfig(options = {}) {
  const env = options.env ?? {};
  const packaged = Boolean(options.packaged) ||
    fileURLToPath(import.meta.url).includes('.asar/') ||
    fileURLToPath(import.meta.url).includes('.asar\\');
  const liveRaw = env.MV_E2E_LIVE;
  if (packaged) {
    if (liveRaw !== undefined && liveRaw !== '') {
      throw new MainError('RETAIL_ENV', 'packaged launch refuses MV_E2E_LIVE');
    }
    return Object.freeze({ enabled: false, runDir: null });
  }
  const nested = Boolean(options.nested) ||
    (Array.isArray(options.argv) && options.argv.includes('--nested-depth=1'));
  if (nested) {
    return Object.freeze({ enabled: false, runDir: null });
  }
  if (liveRaw === undefined || liveRaw === '') {
    return Object.freeze({ enabled: false, runDir: null });
  }
  if (liveRaw !== '1') {
    throw new MainError('RETAIL_ENV', 'invalid MV_E2E_LIVE value');
  }
  const candidateDir = options.runDir ??
    env.MV_QA_RUN_DIR ??
    env.MV_E2E_RUN_DIR ??
    env.XDG_RUNTIME_DIR ??
    options.runtime?.xdgRuntimeDir;
  const verifiedDir = validateQaRunDir(candidateDir);
  return Object.freeze({ enabled: true, runDir: verifiedDir });
}

/**
 * Verify directory and write the latest QA anchor snapshot atomically (0600,
 * temp + fsync + rename, O_NOFOLLOW) to qa-anchors.json inside runDir.
 * @param {string} runDir Verified private run directory.
 * @param {unknown} snapshot Snapshot payload to validate and persist.
 * @returns {Promise<true>}
 */
export async function writeQaSnapshot(runDir, snapshot) {
  const validated = validateQaSnapshot(snapshot);
  const encoded = JSON.stringify(validated);
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  assertOutsideSource(runDir);
  let dirStat;
  try {
    dirStat = await lstat(runDir);
  } catch {
    throw new MainError('QA_RUN_DIR', 'qa run dir is unavailable');
  }
  if (
    !dirStat.isDirectory() ||
    dirStat.isSymbolicLink() ||
    (uid >= 0 && dirStat.uid !== uid) ||
    (dirStat.mode & 0o777) !== 0o700
  ) {
    throw new MainError('QA_RUN_DIR', 'qa run dir failed pre-write check');
  }
  const canonicalDir = await realpath(runDir);
  assertOutsideSource(canonicalDir);

  const targetPath = join(runDir, QA_ANCHORS_FILE);
  try {
    const existing = await lstat(targetPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new MainError('QA_SYMLINK', 'qa-anchors.json must not be a symlink or non-regular file');
    }
  } catch (error) {
    if (error instanceof MainError) {
      throw error;
    }
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
      throw new MainError('QA_WRITE', 'unable to inspect qa-anchors.json target');
    }
  }

  const tempPath = join(runDir, `.qa-anchors-${process.pid}-${randomUUID()}.tmp`);
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
      throw new MainError('QA_WRITE', 'qa-anchors.json post-write verification failed');
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
 * Install the opt-in metaviewer:qa.anchors handler onto ipcMain when enabled.
 * Registers nothing in retail or nested launches.
 * @param {{ ipcMain: { handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => Promise<unknown>) => unknown, removeHandler?: (channel: string) => unknown }, contents: unknown, env?: NodeJS.ProcessEnv, runtime?: { xdgRuntimeDir?: string, uid?: number }, runDir?: string, packaged?: boolean, nested?: boolean, argv?: ReadonlyArray<string> }} options
 * @returns {Readonly<{ enabled: boolean, runDir: string | null, dispose: () => Promise<void> }>}
 */
export function installQaAnchors(options) {
  if (options === null || typeof options !== 'object') {
    throw new MainError('QA_OPTIONS', 'options must be an object');
  }
  const config = resolveQaConfig(options);
  if (!config.enabled || config.runDir === null) {
    return Object.freeze({
      enabled: false,
      runDir: null,
      dispose: async () => {},
    });
  }
  const { ipcMain, contents } = options;
  if (ipcMain === null || typeof ipcMain !== 'object' || typeof ipcMain.handle !== 'function') {
    throw new MainError('IPC', 'ipcMain must provide handle');
  }
  const targetDir = config.runDir;
  let disposed = false;
  /** @type {Promise<unknown>} */
  let writeChain = Promise.resolve();

  ipcMain.handle(
    QA_ANCHORS_CHANNEL,
    /**
     * @param {unknown} event Invoke event.
     * @param {...unknown} args Positional payload vector.
     * @returns {Promise<true>}
     */
    async (event, ...args) => {
      if (disposed) {
        throw new MainError('QA_DISPOSED', 'qa anchors bridge is disposed');
      }
      const verdict = observeSender(event, contents, PRIVILEGED_ORIGIN);
      if (verdict.verdict !== 'admit') {
        throw new MainError(verdict.code, 'sender refused');
      }
      if (args.length !== 1) {
        throw new MainError('QA_ARGS', 'qa.anchors requires exactly one snapshot argument');
      }
      const validated = validateQaSnapshot(args[0]);
      const next = writeChain.then(
        () => writeQaSnapshot(targetDir, validated),
        () => writeQaSnapshot(targetDir, validated),
      );
      writeChain = next.catch(() => {});
      return next;
    },
  );

  return Object.freeze({
    enabled: true,
    runDir: targetDir,
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        if (typeof ipcMain.removeHandler === 'function') {
          ipcMain.removeHandler(QA_ANCHORS_CHANNEL);
        }
      } catch {
        /* teardown best-effort */
      }
      await writeChain;
    },
  });
}
