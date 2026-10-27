'use strict';
// [TARGET, unit decision] AC tests stage their renderer without the unrelated
// MV_E2E_LIVE flag. Missing real tools still fail; no dependency is downloaded.
const harness = require('./harness.js');
const { after } = require('node:test');
const { execFileSync } = require('node:child_process');
const { accessSync, constants, writeFileSync } = require('node:fs');
const { join } = require('node:path');
let stage;
let previousBuild;
function prepareWall() {
  if (stage) return;
  const scratch = harness.makeScratch('mv-ac-wall');
  const build = join(scratch, 'build');
  try {
    execFileSync(process.execPath, [join(__dirname, 'ac-build.mjs')], {
      env: { ...process.env, MV_E2E_BUILD: build }, encoding: 'utf8',
      timeout: 120000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    harness.removeScratch(scratch);
    throw error;
  }
  stage = scratch;
  previousBuild = process.env.MV_E2E_BUILD;
  process.env.MV_E2E_BUILD = build;
}
after(() => {
  if (!stage) return;
  if (previousBuild === undefined) delete process.env.MV_E2E_BUILD;
  else process.env.MV_E2E_BUILD = previousBuild;
  harness.removeScratch(stage);
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

module.exports = {
  ...harness,
  prepareWall,
  electronBinary,
  writeProbeFile,
  E2E_NATIVE_PREREQS,
  requireNativeTool,
  spawnNativeTool,
};
