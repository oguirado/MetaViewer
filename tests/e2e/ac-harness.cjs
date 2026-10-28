'use strict';
// [TARGET, unit decision] AC tests stage their renderer without the unrelated
// MV_E2E_LIVE flag. Missing real tools still fail; no dependency is downloaded.
// [TARGET, unit decision] W3-E2E-FRESH-BUILD: prepareWall verifies ui/dist
// against a length-framed SHA-256 content stamp and source mtime table covering
// ui/src, ui/electron, ui/index.html, ui/vite.config.*, ui/kit.lock.json,
// ui/package.json and ui/package-lock.json;
// stale or unstamped builds are rebuilt before any journey runs, and any
// rebuild failure removes stale outputs and throws E2EError('E2E_PREREQ', ...).
const harness = require('./harness.js');
const { after } = require('node:test');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} = require('node:fs');
const { join, resolve } = require('node:path');

/** Filename of the harness content/mtime stamp inside ui/dist. */
const UI_BUILD_STAMP_FILE = '.e2e-build-stamp.json';
/** Schema tag for the harness UI build stamp. */
const UI_BUILD_STAMP_SCHEMA = 'metaviewer.e2e-ui-build-stamp/v1';
/** Pattern matching Vite configuration files at the top of ui/. */
const VITE_CONFIG_PATTERN = /^vite\.config\.[^/\\]+$/;
/** Required subdirectories under ui/ whose recursive contents feed the build. */
const UI_SOURCE_DIRS = Object.freeze(['src', 'electron']);
/** Required top-level files under ui/ that feed the build. */
const UI_SOURCE_FILES = Object.freeze([
  'index.html',
  'kit.lock.json',
  'package.json',
  'package-lock.json',
]);
/** Required subdirectories under ui/dist whose recursive artifacts are stamped. */
const UI_DIST_DIRS = Object.freeze(['renderer', 'preload']);

let stage;
let stageSourceHash;
let previousBuild;

/**
 * Compute the lowercase hex SHA-256 digest of a regular file.
 * @param {string} filePath Absolute path to file.
 * @returns {string} 64-char hex digest.
 */
function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Return the minimum of a non-empty list of BigInt values.
 * @param {...bigint} values BigInt candidates.
 * @returns {bigint} Minimum value.
 */
function minBigInt(...values) {
  let current = values[0];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] < current) current = values[i];
  }
  return current;
}

/**
 * Format an exec/spawn error into a bounded single-line detail string.
 * @param {unknown} error Caught error value.
 * @returns {string} Bounded diagnostic string.
 */
function formatExecError(error) {
  if (error && typeof error === 'object') {
    const rec = /** @type {{ stderr?: unknown, stdout?: unknown, message?: unknown }} */ (error);
    const stderr = typeof rec.stderr === 'string' || Buffer.isBuffer(rec.stderr)
      ? String(rec.stderr).trim()
      : '';
    const stdout = typeof rec.stdout === 'string' || Buffer.isBuffer(rec.stdout)
      ? String(rec.stdout).trim()
      : '';
    const msg = typeof rec.message === 'string' ? rec.message.trim() : String(error);
    const detail = stderr || stdout || msg;
    return detail.slice(0, 512);
  }
  return String(error).slice(0, 512);
}

/**
 * Walk a directory under uiRoot and append relative POSIX file paths.
 * Refuses symlinks and non-regular entries with E2E_PREREQ.
 * @param {string} uiRoot Absolute UI root directory.
 * @param {string} relDir Relative POSIX directory path from uiRoot.
 * @param {string[]} out Output list of relative POSIX file paths.
 */
function walkUiSourceDir(uiRoot, relDir, out) {
  const absDir = join(uiRoot, ...relDir.split('/'));
  let stat;
  try {
    stat = lstatSync(absDir);
  } catch {
    throw new harness.E2EError('E2E_PREREQ', `required UI source directory missing: ${relDir}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new harness.E2EError('E2E_PREREQ', `UI source directory must be a real directory: ${relDir}`);
  }
  const entries = readdirSync(absDir, { withFileTypes: true }).slice().sort(
    (a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')),
  );
  for (const entry of entries) {
    const childRel = `${relDir}/${entry.name}`;
    const childAbs = join(absDir, entry.name);
    let childStat;
    try {
      childStat = lstatSync(childAbs);
    } catch {
      throw new harness.E2EError('E2E_PREREQ', `unreadable UI source entry: ${childRel}`);
    }
    if (childStat.isSymbolicLink()) {
      throw new harness.E2EError('E2E_PREREQ', `symlink refused in UI sources: ${childRel}`);
    }
    if (childStat.isDirectory()) {
      walkUiSourceDir(uiRoot, childRel, out);
    } else if (childStat.isFile()) {
      out.push(childRel);
    } else {
      throw new harness.E2EError('E2E_PREREQ', `unsupported UI source entry: ${childRel}`);
    }
  }
}

/**
 * Collect and hash all UI build source inputs (ui/src, ui/electron,
 * ui/index.html, ui/vite.config.*, ui/kit.lock.json).
 * @param {string} uiRoot Absolute path to the ui/ directory.
 * @returns {{
 *   uiRoot: string,
 *   sourceHash: string,
 *   maxMtimeMs: number,
 *   maxMtimeNs: string,
 *   files: string[],
 *   mtimes: Record<string, number>,
 *   mtimeNs: Record<string, string>,
 * }}
 */
function collectUiBuildSources(uiRoot) {
  if (typeof uiRoot !== 'string' || uiRoot.length === 0) {
    throw new harness.E2EError('E2E_ARGS', 'uiRoot must be a non-empty string');
  }
  const root = resolve(uiRoot);
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw new harness.E2EError('E2E_PREREQ', `UI directory missing: ${root}`);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new harness.E2EError('E2E_PREREQ', `UI root must be a real directory: ${root}`);
  }

  /** @type {string[]} */
  const collected = [];
  for (const dirName of UI_SOURCE_DIRS) {
    const beforeCount = collected.length;
    walkUiSourceDir(root, dirName, collected);
    if (collected.length === beforeCount) {
      throw new harness.E2EError('E2E_PREREQ', `required UI source directory is empty: ${dirName}`);
    }
  }

  const kitDir = join(root, '.kit');
  let kitStat = null;
  try {
    kitStat = lstatSync(kitDir);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
      throw new harness.E2EError('E2E_PREREQ', 'unreadable UI .kit entry');
    }
  }
  if (kitStat !== null) {
    walkUiSourceDir(root, '.kit', collected);
  }

  const defaultUiRoot = join(harness.findRepoRoot(__dirname), 'ui');
  for (const fileName of UI_SOURCE_FILES) {
    const absFile = join(root, fileName);
    let fStat;
    try {
      fStat = lstatSync(absFile);
    } catch (err) {
      if (
        fileName === 'package-lock.json' &&
        /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT' &&
        root !== defaultUiRoot
      ) {
        continue;
      }
      throw new harness.E2EError('E2E_PREREQ', `required UI source file missing: ${fileName}`);
    }
    if (fStat.isSymbolicLink() || !fStat.isFile()) {
      throw new harness.E2EError('E2E_PREREQ', `required UI source must be a regular file: ${fileName}`);
    }
    collected.push(fileName);
  }

  const topEntries = readdirSync(root, { withFileTypes: true }).slice().sort(
    (a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')),
  );
  const viteConfigs = [];
  for (const entry of topEntries) {
    if (!VITE_CONFIG_PATTERN.test(entry.name)) continue;
    const cfgAbs = join(root, entry.name);
    const cfgStat = lstatSync(cfgAbs);
    if (cfgStat.isSymbolicLink() || !cfgStat.isFile()) {
      throw new harness.E2EError('E2E_PREREQ', `vite config must be a regular file: ${entry.name}`);
    }
    viteConfigs.push(entry.name);
  }
  if (!viteConfigs.includes('vite.config.js')) {
    throw new harness.E2EError('E2E_PREREQ', 'required UI vite config missing: vite.config.js');
  }
  collected.push(...viteConfigs);

  const files = Array.from(new Set(collected)).sort(
    (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
  );

  const hash = createHash('sha256');
  /** @type {Record<string, number>} */
  const mtimes = {};
  /** @type {Record<string, string>} */
  const mtimeNs = {};
  let maxMtimeMs = 0;
  let maxMtimeNs = 0n;

  for (const relPath of files) {
    const fullPath = join(root, ...relPath.split('/'));
    let stat;
    let bytes;
    try {
      stat = lstatSync(fullPath, { bigint: true });
      bytes = readFileSync(fullPath);
    } catch {
      throw new harness.E2EError('E2E_PREREQ', `unreadable UI source file: ${relPath}`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new harness.E2EError('E2E_PREREQ', `UI source entry must be a regular file: ${relPath}`);
    }
    const key = Buffer.from(relPath, 'utf8');
    hash.update(`${key.length}:`).update(key).update(`${bytes.length}:`).update(bytes);
    const ns = stat.mtimeNs;
    const ms = Number(ns) / 1e6;
    mtimes[relPath] = ms;
    mtimeNs[relPath] = ns.toString();
    if (ms > maxMtimeMs) maxMtimeMs = ms;
    if (ns > maxMtimeNs) maxMtimeNs = ns;
  }

  return {
    uiRoot: root,
    sourceHash: hash.digest('hex'),
    maxMtimeMs,
    maxMtimeNs: maxMtimeNs.toString(),
    files,
    mtimes,
    mtimeNs,
  };
}

/**
 * Recursively collect and hash all regular artifact files under dist/renderer
 * and dist/preload. Returns null if required artifacts are missing or invalid.
 * @param {string} distRoot Absolute path to ui/dist.
 * @returns {{
 *   files: string[],
 *   treeSha256: string,
 *   rendererIndexSha256: string,
 *   preloadSha256: string,
 *   minMtimeNs: bigint,
 * } | null}
 */
function collectUiDistArtifacts(distRoot) {
  const rendererIndex = join(distRoot, 'renderer', 'index.html');
  const preloadCjs = join(distRoot, 'preload', 'preload.cjs');
  let rendererStat;
  let preloadStat;
  try {
    rendererStat = lstatSync(rendererIndex, { bigint: true });
    preloadStat = lstatSync(preloadCjs, { bigint: true });
  } catch {
    return null;
  }
  if (
    rendererStat.isSymbolicLink() ||
    !rendererStat.isFile() ||
    rendererStat.size <= 0n ||
    preloadStat.isSymbolicLink() ||
    !preloadStat.isFile() ||
    preloadStat.size <= 0n
  ) {
    return null;
  }

  /** @type {string[]} */
  const collected = [];
  /**
   * @param {string} relDir
   * @returns {boolean}
   */
  const walkDist = (relDir) => {
    const absDir = join(distRoot, ...relDir.split('/'));
    let dStat;
    try {
      dStat = lstatSync(absDir);
    } catch {
      return false;
    }
    if (dStat.isSymbolicLink() || !dStat.isDirectory()) return false;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true }).slice().sort(
        (a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')),
      );
    } catch {
      return false;
    }
    for (const entry of entries) {
      const childRel = `${relDir}/${entry.name}`;
      const childAbs = join(absDir, entry.name);
      let cStat;
      try {
        cStat = lstatSync(childAbs);
      } catch {
        return false;
      }
      if (cStat.isSymbolicLink()) return false;
      if (cStat.isDirectory()) {
        if (!walkDist(childRel)) return false;
      } else if (cStat.isFile()) {
        collected.push(childRel);
      } else {
        return false;
      }
    }
    return true;
  };

  for (const dirName of UI_DIST_DIRS) {
    if (!walkDist(dirName)) return null;
  }

  const files = Array.from(new Set(collected)).sort(
    (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
  );
  const treeHash = createHash('sha256');
  let minMtimeNs = rendererStat.mtimeNs;
  for (const relPath of files) {
    const absPath = join(distRoot, ...relPath.split('/'));
    let fStat;
    let bytes;
    try {
      fStat = lstatSync(absPath, { bigint: true });
      bytes = readFileSync(absPath);
    } catch {
      return null;
    }
    if (fStat.isSymbolicLink() || !fStat.isFile()) return null;
    if (fStat.mtimeNs < minMtimeNs) minMtimeNs = fStat.mtimeNs;
    const key = Buffer.from(relPath, 'utf8');
    treeHash.update(`${key.length}:`).update(key).update(`${bytes.length}:`).update(bytes);
  }

  let rendererIndexSha256;
  let preloadSha256;
  try {
    rendererIndexSha256 = sha256File(rendererIndex);
    preloadSha256 = sha256File(preloadCjs);
  } catch {
    return null;
  }

  return {
    files,
    treeSha256: treeHash.digest('hex'),
    rendererIndexSha256,
    preloadSha256,
    minMtimeNs,
  };
}

/**
 * Inspect whether ui/dist exists, carries a valid harness content stamp for the
 * current sources, and is newer than every watched source file.
 * @param {string} uiRoot Absolute path to the ui/ directory.
 * @param {ReturnType<typeof collectUiBuildSources>} [precomputedSources]
 * @returns {{
 *   fresh: boolean,
 *   reason: string,
 *   newerFile: string | null,
 *   stampPath: string,
 *   sources: ReturnType<typeof collectUiBuildSources>,
 *   stamp?: Record<string, unknown>,
 * }}
 */
function inspectUiDistFreshness(uiRoot, precomputedSources) {
  const sources = precomputedSources || collectUiBuildSources(uiRoot);
  const distRoot = join(sources.uiRoot, 'dist');
  const stampPath = join(distRoot, UI_BUILD_STAMP_FILE);

  const distArtifacts = collectUiDistArtifacts(distRoot);
  if (!distArtifacts) {
    return { fresh: false, reason: 'missing_build_artifacts', newerFile: null, stampPath, sources };
  }

  let stampStat;
  let stampRaw;
  try {
    stampStat = lstatSync(stampPath, { bigint: true });
    if (stampStat.isSymbolicLink() || !stampStat.isFile()) {
      return { fresh: false, reason: 'missing_stamp', newerFile: null, stampPath, sources };
    }
    stampRaw = readFileSync(stampPath, 'utf8');
  } catch {
    return { fresh: false, reason: 'missing_stamp', newerFile: null, stampPath, sources };
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(stampRaw);
  } catch {
    return { fresh: false, reason: 'invalid_stamp', newerFile: null, stampPath, sources };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { fresh: false, reason: 'invalid_stamp', newerFile: null, stampPath, sources };
  }
  const stamp = /** @type {Record<string, unknown>} */ (parsed);
  if (
    stamp.schema !== UI_BUILD_STAMP_SCHEMA ||
    typeof stamp.sourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(stamp.sourceHash) ||
    typeof stamp.rendererIndexSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(stamp.rendererIndexSha256) ||
    typeof stamp.preloadSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(stamp.preloadSha256) ||
    typeof stamp.distTreeSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(stamp.distTreeSha256) ||
    !Array.isArray(stamp.distFiles) ||
    typeof stamp.buildMtimeMs !== 'number' ||
    !Number.isFinite(stamp.buildMtimeMs) ||
    typeof stamp.buildMtimeNs !== 'string' ||
    !/^[0-9]+$/.test(stamp.buildMtimeNs) ||
    !stamp.mtimeNs ||
    typeof stamp.mtimeNs !== 'object' ||
    Array.isArray(stamp.mtimeNs)
  ) {
    return { fresh: false, reason: 'invalid_stamp', newerFile: null, stampPath, sources };
  }

  if (stamp.sourceHash !== sources.sourceHash) {
    return { fresh: false, reason: 'source_hash_mismatch', newerFile: null, stampPath, sources };
  }

  if (
    distArtifacts.rendererIndexSha256 !== stamp.rendererIndexSha256 ||
    distArtifacts.preloadSha256 !== stamp.preloadSha256 ||
    distArtifacts.treeSha256 !== stamp.distTreeSha256 ||
    distArtifacts.files.length !== stamp.distFiles.length ||
    distArtifacts.files.some((f, idx) => f !== stamp.distFiles[idx])
  ) {
    return { fresh: false, reason: 'artifact_hash_mismatch', newerFile: null, stampPath, sources };
  }

  const minBuildNs = minBigInt(distArtifacts.minMtimeNs, stampStat.mtimeNs);
  const minBuildMs = Number(minBuildNs) / 1e6;
  const recordedMtimeNs = /** @type {Record<string, unknown>} */ (stamp.mtimeNs);

  for (const relPath of sources.files) {
    const srcNs = BigInt(sources.mtimeNs[relPath]);
    const srcMs = sources.mtimes[relPath];
    const stampedNs = recordedMtimeNs[relPath];
    if (
      srcNs > minBuildNs ||
      srcMs > minBuildMs ||
      typeof stampedNs !== 'string' ||
      !/^[0-9]+$/.test(stampedNs) ||
      srcNs !== BigInt(stampedNs)
    ) {
      return {
        fresh: false,
        reason: 'source_newer_than_build',
        newerFile: relPath,
        stampPath,
        sources,
      };
    }
  }

  if (Object.keys(recordedMtimeNs).length !== sources.files.length) {
    return { fresh: false, reason: 'source_set_changed', newerFile: null, stampPath, sources };
  }

  return { fresh: true, reason: 'fresh', newerFile: null, stampPath, sources, stamp };
}

/**
 * Ensure ui/dist is fresh with respect to all watched UI sources, rebuilding via
 * Vite and writing the content hash + mtime stamp when stale or unstamped.
 * Throws E2EError('E2E_PREREQ', ...) and removes stale ui/dist if rebuild fails.
 * @param {{
 *   root?: string,
 *   uiRoot?: string,
 *   viteBin?: string,
 *   env?: NodeJS.ProcessEnv,
 *   skipKitCheck?: boolean,
 * }} [options]
 * @returns {{
 *   uiRoot: string,
 *   uiDist: string,
 *   stampPath: string,
 *   sourceHash: string,
 *   rebuilt: boolean,
 *   reason: string,
 *   newerFile: string | null,
 * }}
 */
function ensureFreshUiDist(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new harness.E2EError('E2E_ARGS', 'ensureFreshUiDist options must be an object');
  }
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const root = options.root
    ? resolve(harness.needString ? options.root : String(options.root))
    : (options.uiRoot ? resolve(String(options.uiRoot), '..') : harness.findRepoRoot(__dirname));
  const uiRoot = options.uiRoot ? resolve(String(options.uiRoot)) : join(root, 'ui');

  let check = inspectUiDistFreshness(uiRoot);
  const distRoot = join(uiRoot, 'dist');
  const syncKitScript = join(root, 'tools', 'sync_kit.mjs');
  if (check.fresh && !options.skipKitCheck && existsSync(syncKitScript)) {
    try {
      execFileSync(process.execPath, [syncKitScript, '--check'], {
        cwd: root,
        env,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 30000,
      });
    } catch {
      check = { ...check, fresh: false, reason: 'kit_drift' };
    }
  }
  if (check.fresh) {
    return {
      uiRoot,
      uiDist: distRoot,
      stampPath: check.stampPath,
      sourceHash: check.sources.sourceHash,
      rebuilt: false,
      reason: 'fresh',
      newerFile: null,
    };
  }

  // Never leave a valid stamp or reusable stale build if rebuilding fails.
  rmSync(check.stampPath, { force: true });

  if (!options.skipKitCheck && existsSync(syncKitScript)) {
    try {
      execFileSync(process.execPath, [syncKitScript, '--check'], {
        cwd: root,
        env,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 30000,
      });
    } catch (checkErr) {
      const kitRepo = (env.MV_KIT_CHECKOUT || env.CAPSULE_UI_KIT_REPO || '').trim();
      if (!kitRepo) {
        rmSync(distRoot, { recursive: true, force: true });
        throw new harness.E2EError(
          'E2E_PREREQ',
          `cannot rebuild stale ui/dist (${check.reason}): kit check failed and MV_KIT_CHECKOUT/CAPSULE_UI_KIT_REPO unset (${formatExecError(checkErr)})`,
        );
      }
      try {
        execFileSync(process.execPath, [syncKitScript, kitRepo], {
          cwd: root,
          env,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 60000,
        });
      } catch (syncErr) {
        rmSync(distRoot, { recursive: true, force: true });
        throw new harness.E2EError(
          'E2E_PREREQ',
          `cannot rebuild stale ui/dist (${check.reason}): kit sync failed (${formatExecError(syncErr)})`,
        );
      }
    }
  }

  const viteBin = options.viteBin
    ? resolve(String(options.viteBin))
    : join(uiRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  let viteStat;
  try {
    viteStat = lstatSync(viteBin);
  } catch {
    rmSync(distRoot, { recursive: true, force: true });
    throw new harness.E2EError(
      'E2E_PREREQ',
      `cannot rebuild stale ui/dist (${check.reason}): vite CLI missing at ${viteBin}`,
    );
  }
  if (!viteStat.isFile()) {
    rmSync(distRoot, { recursive: true, force: true });
    throw new harness.E2EError(
      'E2E_PREREQ',
      `cannot rebuild stale ui/dist (${check.reason}): vite CLI is not a regular file at ${viteBin}`,
    );
  }

  const preBuildSources = collectUiBuildSources(uiRoot);

  try {
    execFileSync(process.execPath, [viteBin, 'build'], {
      cwd: uiRoot,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (buildErr) {
    rmSync(distRoot, { recursive: true, force: true });
    throw new harness.E2EError(
      'E2E_PREREQ',
      `failed to rebuild stale ui/dist (${check.reason}): ${formatExecError(buildErr)}`,
    );
  }

  let distArtifacts = collectUiDistArtifacts(distRoot);
  if (!distArtifacts) {
    rmSync(distRoot, { recursive: true, force: true });
    throw new harness.E2EError(
      'E2E_PREREQ',
      'ui/dist rebuild did not produce valid dist/renderer and dist/preload artifacts',
    );
  }

  const postBuildSources = collectUiBuildSources(uiRoot);
  const sourcesChangedDuringBuild =
    preBuildSources.sourceHash !== postBuildSources.sourceHash ||
    preBuildSources.files.length !== postBuildSources.files.length ||
    preBuildSources.files.some(
      (relPath, idx) =>
        relPath !== postBuildSources.files[idx] ||
        preBuildSources.mtimeNs[relPath] !== postBuildSources.mtimeNs[relPath],
    );
  if (sourcesChangedDuringBuild) {
    rmSync(distRoot, { recursive: true, force: true });
    throw new harness.E2EError('E2E_PREREQ', 'UI sources changed during build');
  }

  const maxSourceNs = BigInt(preBuildSources.maxMtimeNs);
  if (distArtifacts.minMtimeNs < maxSourceNs) {
    const bumpedDate = new Date(Math.ceil(preBuildSources.maxMtimeMs) + 2);
    for (const relPath of distArtifacts.files) {
      const absPath = join(distRoot, ...relPath.split('/'));
      utimesSync(absPath, bumpedDate, bumpedDate);
    }
    distArtifacts = collectUiDistArtifacts(distRoot);
    if (!distArtifacts) {
      rmSync(distRoot, { recursive: true, force: true });
      throw new harness.E2EError(
        'E2E_PREREQ',
        'ui/dist artifacts became unreadable after mtime update',
      );
    }
  }

  const minArtifactNs = distArtifacts.minMtimeNs;
  const stampPayload = {
    schema: UI_BUILD_STAMP_SCHEMA,
    sourceHash: preBuildSources.sourceHash,
    rendererIndexSha256: distArtifacts.rendererIndexSha256,
    preloadSha256: distArtifacts.preloadSha256,
    distTreeSha256: distArtifacts.treeSha256,
    distFiles: distArtifacts.files,
    buildMtimeMs: Number(minArtifactNs) / 1e6,
    buildMtimeNs: minArtifactNs.toString(),
    mtimes: preBuildSources.mtimes,
    mtimeNs: preBuildSources.mtimeNs,
  };
  writeFileSync(check.stampPath, `${JSON.stringify(stampPayload, null, 2)}\n`, 'utf8');
  const stampStat = lstatSync(check.stampPath, { bigint: true });
  if (stampStat.mtimeNs < maxSourceNs) {
    const bumpedDate = new Date(Math.ceil(preBuildSources.maxMtimeMs) + 2);
    utimesSync(check.stampPath, bumpedDate, bumpedDate);
  }

  const verified = inspectUiDistFreshness(uiRoot);
  if (!verified.fresh) {
    rmSync(distRoot, { recursive: true, force: true });
    throw new harness.E2EError(
      'E2E_PREREQ',
      `rebuilt ui/dist failed post-build freshness verification (${verified.reason})`,
    );
  }

  return {
    uiRoot,
    uiDist: distRoot,
    stampPath: check.stampPath,
    sourceHash: preBuildSources.sourceHash,
    rebuilt: true,
    reason: check.reason,
    newerFile: check.newerFile,
  };
}

/**
 * Ensure ui/dist is fresh (rebuilding when any watched UI source is newer than
 * the build or when the build lacks a matching content stamp) and stage the AC
 * wall build in MV_E2E_BUILD.
 * @param {{
 *   root?: string,
 *   uiRoot?: string,
 *   viteBin?: string,
 *   env?: NodeJS.ProcessEnv,
 *   skipKitCheck?: boolean,
 *   stageWall?: boolean,
 * }} [options]
 */
function prepareWall(options = {}) {
  const distResult = ensureFreshUiDist(options);
  const env = options && options.env && typeof options.env === 'object' ? options.env : process.env;
  const defaultRoot = harness.findRepoRoot(__dirname);
  const shouldStageWall = options && options.stageWall !== undefined
    ? Boolean(options.stageWall)
    : distResult.uiRoot === join(defaultRoot, 'ui');

  if (!shouldStageWall) {
    return { ...distResult, wallBuild: null };
  }

  const needWallStage = !stage
    || distResult.rebuilt
    || stageSourceHash !== distResult.sourceHash
    || !existsSync(join(stage, 'build', 'index.html'));

  if (!needWallStage) {
    return { ...distResult, wallBuild: join(stage, 'build') };
  }

  const scratch = harness.makeScratch('mv-ac-wall');
  const build = join(scratch, 'build');
  try {
    execFileSync(process.execPath, [join(__dirname, 'ac-build.mjs')], {
      env: { ...env, MV_E2E_BUILD: build },
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    harness.removeScratch(scratch);
    throw new harness.E2EError(
      'E2E_PREREQ',
      `failed to stage AC wall build: ${formatExecError(error)}`,
    );
  }
  if (stage) {
    harness.removeScratch(stage);
  } else {
    previousBuild = process.env.MV_E2E_BUILD;
  }
  stage = scratch;
  stageSourceHash = distResult.sourceHash;
  process.env.MV_E2E_BUILD = build;
  return { ...distResult, wallBuild: build };
}

after(() => {
  if (!stage) return;
  if (previousBuild === undefined) delete process.env.MV_E2E_BUILD;
  else process.env.MV_E2E_BUILD = previousBuild;
  harness.removeScratch(stage);
  stage = undefined;
  stageSourceHash = undefined;
});
function electronBinary(root) {
  const dist = process.env.ELECTRON_OVERRIDE_DIST_PATH;
  if (!dist) return harness.electronBinary(root);
  const binary = join(dist, 'electron');
  accessSync(binary, constants.X_OK);
  return binary;
}
// [TARGET, unit decision] Count distinct delivered DOM frame identities, never
// timers or generation deltas. A static fixture therefore measures zero fps.
async function telemetryProbe(config) {
  const { app } = require('electron');
  app.setPath('userData', config.profile);
  process.env.MV_E2E_MANIFEST = config.manifestPath;
  process.env.MV_E2E_TELEMETRY = JSON.stringify({
    reportPath: config.reportPath, soakMs: config.soakMs,
  });
  setTimeout(() => app.exit(2), config.soakMs * 2 + 30000).unref();
  await import(config.mainUrl);
}
function writeProbeFile(dir, config) {
  if (config.soakMs === undefined) return harness.writeProbeFile(dir, config);
  if (!Number.isSafeInteger(config.soakMs) || config.soakMs <= 0) {
    throw new harness.E2EError('E2E_ARGS', 'soakMs must be a positive safe integer');
  }
  const path = join(dir, 'probe.cjs');
  writeFileSync(path, `(${telemetryProbe.toString()})(${JSON.stringify(config)});\n`);
  return path;
}
// [TARGET, unit decision] E2E-U29: documented native prerequisite set for E2E
// journeys (`cc` and `strace` for e2e12 replay purity, `xvfb-run` for wall journeys).
const E2E_NATIVE_PREREQS = Object.freeze({
  cc: Object.freeze({
    binary: 'cc',
    envVar: 'CC',
    purpose: 'C compiler for replay-deny LD_PRELOAD interposer and probe binary',
  }),
  strace: Object.freeze({
    binary: 'strace',
    envVar: 'STRACE',
    purpose: 'Linux syscall tracer and network fault injector for replay purity',
  }),
  'xvfb-run': Object.freeze({
    binary: 'xvfb-run',
    envVar: null,
    purpose: 'Virtual X11 display server for Electron wall journeys',
  }),
});

/**
 * Resolve a required native tool on PATH or via its documented environment
 * override, throwing a typed `E2EError('E2E_PREREQ', ...)` when absent or not
 * executable.
 * @param {string} name Canonical tool name (e.g. 'cc', 'strace', 'xvfb-run').
 * @param {{ env?: NodeJS.ProcessEnv, pathEnv?: string, envVar?: string | null }} [options]
 * @returns {string} Resolved absolute executable path.
 */
function requireNativeTool(name, options = {}) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new harness.E2EError('E2E_ARGS', 'native tool name must be a non-empty string');
  }
  const spec = Object.prototype.hasOwnProperty.call(E2E_NATIVE_PREREQS, name)
    ? E2E_NATIVE_PREREQS[name]
    : null;
  const env = options && typeof options.env === 'object' && options.env !== null
    ? options.env
    : process.env;
  const pathEnv = options && typeof options.pathEnv === 'string'
    ? options.pathEnv
    : (typeof env.PATH === 'string' ? env.PATH : '');
  const envVar = options && options.envVar !== undefined
    ? options.envVar
    : (spec ? spec.envVar : null);
  const rawOverride = envVar && typeof env[envVar] === 'string' ? env[envVar].trim() : '';
  const candidate = rawOverride.length > 0 ? rawOverride : (spec ? spec.binary : name);

  if (candidate.includes('/')) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      throw new harness.E2EError(
        'E2E_PREREQ',
        `required native tool '${name}' missing or not executable at ${candidate}`,
      );
    }
  }
  const resolved = harness.whichBinary(candidate, pathEnv);
  if (!resolved) {
    throw new harness.E2EError(
      'E2E_PREREQ',
      `required native tool '${name}' (${candidate}) not installed on PATH`,
    );
  }
  return resolved;
}

/**
 * Execute a native tool synchronously, converting missing-binary spawn failures
 * (`ENOENT` / `EACCES`) into a typed `E2EError('E2E_PREREQ', ...)` even if the
 * caller skipped the upfront probe.
 * @param {string} name Canonical tool name.
 * @param {ReadonlyArray<string>} args Argument vector.
 * @param {{ env?: NodeJS.ProcessEnv, pathEnv?: string, envVar?: string | null, skipProbe?: boolean, spawnOptions?: import('node:child_process').SpawnSyncOptions }} [options]
 */
function spawnNativeTool(name, args, options = {}) {
  const { spawnSync } = require('node:child_process');
  const env = options && typeof options.env === 'object' && options.env !== null
    ? options.env
    : process.env;
  const pathEnv = options && typeof options.pathEnv === 'string'
    ? options.pathEnv
    : (typeof env.PATH === 'string' ? env.PATH : '');
  const binary = options && options.skipProbe
    ? name
    : requireNativeTool(name, { env, pathEnv, envVar: options.envVar });
  const spawnOpts = {
    encoding: 'utf8',
    timeout: 10000,
    ...(options && options.spawnOptions ? options.spawnOptions : {}),
    env: { ...env, PATH: pathEnv },
  };
  const result = spawnSync(binary, Array.isArray(args) ? args : [], spawnOpts);
  if (result.error) {
    const code = /** @type {{ code?: unknown }} */ (result.error).code;
    if (code === 'ENOENT' || code === 'EACCES') {
      throw new harness.E2EError(
        'E2E_PREREQ',
        `native tool '${name}' failed to spawn (${String(code)}): ${result.error.message}`,
      );
    }
    throw result.error;
  }
  return result;
}

const CHILD_STATE = Symbol('mv.e2e.childState');

/**
 * Parse a single newline-delimited JSON envelope line from a fixture-core
 * socket, returning null on blank or malformed lines instead of throwing.
 * @param {unknown} line Raw line string without trailing LF.
 * @returns {Record<string, any> | null}
 */
function parseCoreLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Attach error and exit listeners to a spawned child process at creation time
 * so asynchronous ENOENT/spawn errors never become uncaught exceptions and
 * exit state is captured even before waitForChildExit is called.
 * @template {import('node:events').EventEmitter & { exitCode?: number | null, signalCode?: NodeJS.Signals | null }} T
 * @param {T} child Spawned ChildProcess.
 * @returns {T}
 */
function trackChildProcess(child) {
  if (!child || typeof child.on !== 'function') return child;
  if (child[CHILD_STATE]) return child;
  const state = {
    error: null,
    exited:
      (child.exitCode !== null && child.exitCode !== undefined) ||
      (child.signalCode !== null && child.signalCode !== undefined),
    exitCode: child.exitCode ?? null,
    signalCode: child.signalCode ?? null,
  };
  Object.defineProperty(child, CHILD_STATE, {
    value: state,
    enumerable: false,
    configurable: false,
  });
  child.on('error', (err) => {
    if (!state.error) state.error = err;
  });
  child.on('exit', (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.signalCode = signal;
  });
  return child;
}

/**
 * Stop (if requested) and wait for a spawned child process to exit, resolving
 * immediately when the child has already exited and rejecting promptly when
 * spawn failed with an error event.
 * @param {import('node:child_process').ChildProcess} child
 * @param {(() => void) | null} [stopFn]
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null }>}
 */
function waitForChildExit(child, stopFn = null) {
  if (!child || typeof child !== 'object') {
    return Promise.reject(new harness.E2EError('E2E_ARGS', 'child process is required'));
  }
  trackChildProcess(child);
  const state = child[CHILD_STATE];
  if (typeof stopFn === 'function') {
    stopFn();
  }
  if (state && state.error) {
    return Promise.reject(state.error);
  }
  if (
    (state && state.exited) ||
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  ) {
    return Promise.resolve({
      code: child.exitCode ?? (state ? state.exitCode : null),
      signal: child.signalCode ?? (state ? state.signalCode : null),
    });
  }
  return new Promise((resolveExit, rejectExit) => {
    const onExit = (code, signal) => {
      cleanup();
      resolveExit({ code, signal });
    };
    const onError = (err) => {
      cleanup();
      rejectExit(err);
    };
    const cleanup = () => {
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

module.exports = {
  ...harness,
  UI_BUILD_STAMP_FILE,
  UI_BUILD_STAMP_SCHEMA,
  UI_SOURCE_FILES,
  collectUiBuildSources,
  collectUiDistArtifacts,
  inspectUiDistFreshness,
  ensureFreshUiDist,
  prepareWall,
  electronBinary,
  writeProbeFile,
  E2E_NATIVE_PREREQS,
  requireNativeTool,
  spawnNativeTool,
  parseCoreLine,
  trackChildProcess,
  waitForChildExit,
};
