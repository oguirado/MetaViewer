// @ts-check
// [TARGET, unit decision] Deterministic Linux bundle with an owned real-core session.
// Local archives are mandatory; packager never reaches its download branch.
import { createHash } from 'node:crypto';
import { createReadStream, closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, basename, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildFuseConfig, ELECTRON_PIN, FUSE_TABLE } from '../electron/main.js';
import { extractFile, listPackage, statFile, uncache } from '@electron/asar';
import { syncKit } from '../../tools/sync_kit.mjs';

export { ELECTRON_PIN };
export const PKG_BOOT_BUDGET_MS = 10000;
export const SMOKE_DIAGNOSTIC_TAIL_CHARS = 3000;

/**
 * Synchronously write a line to a file descriptor (1 for stdout, 2 for stderr)
 * so piped output reaches the parent before an immediate app.exit / process.exit.
 * @param {number} fd
 * @param {unknown} value
 */
export function writeFdSync(fd, value) {
  const text = String(value ?? '');
  const bytes = Buffer.from(text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    try {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) break;
      offset += written;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
      if (code === 'EINTR' || code === 'EAGAIN') continue;
      try {
        (fd === 1 ? process.stdout : process.stderr).write(bytes.subarray(offset));
      } catch {}
      break;
    }
  }
}

const execute = promisify(execFile);
const ui = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(ui, '..');
const DEFAULT_UMASK_FILE_MODE = (() => {
  const probe = join(tmpdir(), `.mv-mode-probe-${process.pid}-${Date.now()}`);
  try {
    const fd = openSync(probe, 'wx', 0o666);
    try {
      return statSync(probe).mode & 0o777;
    } finally {
      closeSync(fd);
      unlinkSync(probe);
    }
  } catch {
    return 0o644;
  }
})();
/** @param {string} value */
export function packageArchitecture(value = process.arch) {
  if (value !== 'arm64' && value !== 'x64') throw new Error('PKG_ARCH_UNSUPPORTED');
  return { arch: value, machine: value === 'arm64' ? 183 : 62,
    name: `MetaViewer-linux-${value}`, archive: `electron-v${ELECTRON_PIN}-linux-${value}.zip` };
}
const architecture = packageArchitecture();
const { archive } = architecture;

/** @param {string | undefined} value @param {string} repository */
export function validateOutput(value, repository) {
  if (!value || !isAbsolute(value)) throw new Error('MV_PKG_OUT must be an absolute external directory');
  const output = resolve(value);
  const root = resolve(repository);
  if (output === root || output.startsWith(root + sep) || root.startsWith(output + sep)) {
    throw new Error('MV_PKG_OUT must not overlap the repository');
  }
  return output;
}

/** @param {{ name: string }} a @param {{ name: string }} b */
function compareEntryNames(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** @param {string} root */
async function normalizePackageModes(root) {
  /** @param {string} part */
  async function walk(part) {
    const dirPath = part ? join(root, part) : root;
    await fs.chmod(dirPath, 0o755);
    const items = (await fs.readdir(dirPath, { withFileTypes: true })).slice().sort(compareEntryNames);
    for (const item of items) {
      const name = part ? `${part}/${item.name}` : item.name;
      const fullPath = join(root, name);
      if (item.isSymbolicLink()) throw new Error(`Symlink refused: ${name}`);
      if (item.isDirectory()) {
        await walk(name);
      } else if (item.isFile()) {
        const st = await fs.lstat(fullPath);
        await fs.chmod(fullPath, (st.mode & 0o111) !== 0 ? 0o755 : 0o644);
      } else {
        throw new Error(`Unsupported package entry: ${name}`);
      }
    }
  }
  await walk('');
}

/** @param {string} root @param {string} destination */
export async function writeManifest(root, destination) {
  /** @type {{ name: string, mode: number }[]} */
  const files = [];
  /** @param {string} part */
  async function walk(part) {
    const items = (await fs.readdir(join(root, part), { withFileTypes: true })).slice().sort(compareEntryNames);
    for (const item of items) {
      const name = part ? `${part}/${item.name}` : item.name;
      if (/[\r\n\\]/.test(name)) throw new Error('Unsupported manifest filename');
      if (item.isSymbolicLink()) throw new Error(`Symlink refused: ${name}`);
      if (item.isDirectory()) await walk(name);
      else if (item.isFile()) {
        const st = await fs.lstat(join(root, name));
        files.push({ name, mode: st.mode & 0o777 });
      } else throw new Error(`Unsupported package entry: ${name}`);
    }
  }
  await walk('');
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const includeExplicitModes = files.some(file => file.mode !== DEFAULT_UMASK_FILE_MODE);
  const lines = [];
  for (const file of files) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(join(root, file.name))) hash.update(bytes);
    const modeField = includeExplicitModes ? ` ${file.mode.toString(8).padStart(4, '0')}` : '';
    lines.push(`${hash.digest('hex')}${modeField}  ${file.name}\n`);
  }
  await fs.writeFile(destination, lines.join(''), { flag: 'wx' });
}

// [TARGET, unit decision] Pinned Linux fuse-wire writer: the sentinel, version,
// count and byte states are checked against the local Electron artifact. Unknown
// wire layouts fail closed. No runtime dependency or downloaded fuse helper.
const ASSET_SEAL_PREFIX = 'const PACKAGED_ASSET_DIGESTS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze(';
const EXEC_SEAL_PREFIX = 'const PACKAGED_EXEC_DIGESTS = Object.freeze(';
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');

/** @param {string} source */
function stripMainSeal(source) {
  const parts = source.split(ASSET_SEAL_PREFIX);
  if (parts.length !== 2) throw new Error('ASAR seal marker mismatch');
  const end = parts[1].indexOf('));');
  if (end < 0) throw new Error('ASAR seal marker mismatch');
  return `${parts[0]}${ASSET_SEAL_PREFIX}{}${parts[1].slice(end)}`;
}

/** @param {string} source */
function stripEntrySeal(source) {
  const parts = source.split(EXEC_SEAL_PREFIX);
  if (parts.length !== 2) return source;
  const end = parts[1].indexOf(');');
  if (end < 0) throw new Error('ASAR entry seal marker mismatch');
  return `${parts[0]}${EXEC_SEAL_PREFIX}{}${parts[1].slice(end)}`;
}

/**
 * @param {string} relativePath
 * @param {Buffer} rawBytes
 */
function normalizeSealedBytes(relativePath, rawBytes) {
  if (relativePath === 'electron/main.js') {
    return Buffer.from(stripMainSeal(rawBytes.toString('utf8')), 'utf8');
  }
  if (relativePath === 'electron/nesting.js') {
    return Buffer.from(stripEntrySeal(rawBytes.toString('utf8')), 'utf8');
  }
  return rawBytes;
}

/** @param {boolean} asar @param {Readonly<Record<string, boolean | string>>} config */
export function assertPackagingPolicy(asar, config) {
  if (asar !== true) throw new Error('ASAR is required by OnlyLoadAppFromAsar');
  const expected = buildFuseConfig();
  if (Object.keys(config).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => config[key] !== value)) {
    throw new Error('Fuse configuration drift');
  }
}

/** @param {Buffer} bytes */
function fuseOffset(bytes) {
  const index = bytes.indexOf(FUSE_SENTINEL);
  if (index < 0 || bytes.indexOf(FUSE_SENTINEL, index + 1) !== -1) throw new Error('Fuse sentinel missing or ambiguous');
  const header = index + FUSE_SENTINEL.length;
  if (bytes[header] !== 1 || bytes[header + 1] !== FUSE_TABLE.length ||
      bytes.length < header + 2 + FUSE_TABLE.length) throw new Error('Fuse wire version/length mismatch');
  const offset = header + 2;
  for (const row of FUSE_TABLE) {
    if (![48, 49].includes(bytes[offset + row.index])) throw new Error(`Fuse ${row.name} unavailable`);
  }
  return offset;
}

/** @param {string} binary @param {Readonly<Record<string, boolean | string>>} config */
export async function applyFuses(binary, config) {
  assertPackagingPolicy(true, config);
  const bytes = await fs.readFile(binary);
  const offset = fuseOffset(bytes);
  const patch = Buffer.from(FUSE_TABLE.map(row => config[String(row.index)] ? 49 : 48));
  const file = await fs.open(binary, 'r+');
  try {
    const result = await file.write(patch, 0, patch.length, offset);
    if (result.bytesWritten !== patch.length) throw new Error('Incomplete fuse write');
    await file.sync();
  } finally { await file.close(); }
  await verifyFuses(binary);
}

/** @param {string} binary */
async function verifyFuses(binary) {
  const bytes = await fs.readFile(binary);
  const offset = fuseOffset(bytes);
  for (const row of FUSE_TABLE) {
    if (bytes[offset + row.index] !== (row.expect ? 49 : 48)) throw new Error(`Fuse mismatch: ${row.name}`);
  }
}

/** @param {string} root */
export async function verifyPackagedSecurity(root) {
  await verifyFuses(join(root, 'metaviewer'));
  const resources = join(root, 'resources');
  const entries = await fs.readdir(resources);
  if (!entries.includes('app.asar') || entries.includes('app') || entries.includes('app.asar.unpacked')) {
    throw new Error('ASAR-only application layout required');
  }
  const archivePath = join(resources, 'app.asar');
  const st = await fs.lstat(archivePath);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('ASAR must be a regular file');
  uncache(archivePath);
  const source = extractFile(archivePath, 'electron/main.js').toString();
  const sealed = source.split(ASSET_SEAL_PREFIX);
  if (sealed.length !== 2) throw new Error('ASAR asset seal missing');
  const end = sealed[1].indexOf('));');
  const hashes = JSON.parse(sealed[1].slice(0, end));
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) throw new Error('Invalid ASAR asset seal');
  const nestingSource = extractFile(archivePath, 'electron/nesting.js').toString();
  const nestingParts = nestingSource.split(EXEC_SEAL_PREFIX);
  if (nestingParts.length === 2) {
    const nestingEnd = nestingParts[1].indexOf(');');
    if (nestingEnd < 0) throw new Error('Invalid ASAR entry seal');
    const execHashes = JSON.parse(nestingParts[1].slice(0, nestingEnd));
    if (JSON.stringify(execHashes) !== JSON.stringify(hashes)) {
      throw new Error('ASAR entry seal mismatch');
    }
  }
  let assets = 0;
  // The immutable ASAR namespace must not contain aliases or unpacked files.
  for (const name of listPackage(archivePath, {})) {
    const entry = statFile(archivePath, name.replace(/^\//, ''), false);
    if ('link' in entry || ('unpacked' in entry && entry.unpacked)) throw new Error('ASAR alias/unpacked entry refused');
    if (!('size' in entry)) continue;
    const relPath = name.replace(/^\//, '');
    /** @type {string | null} */
    let sealKey = null;
    if (relPath.startsWith('dist/renderer/')) {
      sealKey = relPath.slice('dist/renderer/'.length);
    } else if (relPath.startsWith('dist/preload/') || relPath.startsWith('electron/')) {
      sealKey = relPath;
    }
    if (sealKey !== null) {
      const rawBytes = extractFile(archivePath, relPath);
      const digest = createHash('sha256').update(normalizeSealedBytes(relPath, rawBytes)).digest('hex');
      if (hashes[sealKey] !== digest) throw new Error(`ASAR asset mismatch: ${sealKey}`);
      assets++;
    }
  }
  if (!assets || Object.keys(hashes).length !== assets) throw new Error('ASAR asset inventory mismatch');
  const pkg = JSON.parse(extractFile(archivePath, 'package.json').toString());
  if (pkg.main !== 'electron/nesting.js') throw new Error('ASAR entry mismatch');
  for (const name of ['electron/nesting.js', 'dist/renderer/index.html', 'dist/preload/preload.cjs']) {
    if (!extractFile(archivePath, name).length) throw new Error(`ASAR required entry absent: ${name}`);
  }
}

/** Seal all executed renderer, preload, and electron files in deterministic key order.
 * @param {string} app
 * @param {{ readdir?: typeof fs.readdir }} [options] */
export async function sealRendererAssets(app, options = {}) {
  const readdirFn = options.readdir ?? fs.readdir;
  /** @type {Array<[string, string]>} */
  const collected = [];
  /**
   * @param {string} baseDir
   * @param {string} keyPrefix
   * @param {string} relPrefix
   */
  async function walkSection(baseDir, keyPrefix, relPrefix) {
    /** @param {string} part */
    async function walk(part) {
      const entries = (await readdirFn(join(baseDir, part), { withFileTypes: true })).slice().sort(compareEntryNames);
      for (const entry of entries) {
        const name = part ? `${part}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error('Renderer alias refused');
        if (entry.isDirectory()) {
          await walk(name);
        } else if (entry.isFile()) {
          const relPath = `${relPrefix}${name}`;
          const key = `${keyPrefix}${name}`;
          const rawBytes = await fs.readFile(join(baseDir, name));
          const normalized = normalizeSealedBytes(relPath, rawBytes);
          const fileDigest = createHash('sha256').update(normalized).digest('hex');
          collected.push([key, fileDigest]);
        } else {
          throw new Error('Renderer entry refused');
        }
      }
    }
    await walk('');
  }
  await walkSection(join(app, 'dist/renderer'), '', 'dist/renderer/');
  const preloadDir = join(app, 'dist/preload');
  const preloadStat = await fs.lstat(preloadDir).catch(() => null);
  if (preloadStat) {
    if (preloadStat.isSymbolicLink() || !preloadStat.isDirectory()) throw new Error('Renderer alias refused');
    await walkSection(preloadDir, 'dist/preload/', 'dist/preload/');
  }
  const electronDir = join(app, 'electron');
  const electronStat = await fs.lstat(electronDir).catch(() => null);
  if (electronStat) {
    if (electronStat.isSymbolicLink() || !electronStat.isDirectory()) throw new Error('Renderer alias refused');
    await walkSection(electronDir, 'electron/', 'electron/');
  }
  collected.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const [key, value] of collected) {
    hashes[key] = value;
  }
  const serialized = JSON.stringify(hashes);
  const mainPath = join(app, 'electron/main.js');
  const unsealedMain = stripMainSeal(await fs.readFile(mainPath, 'utf8'));
  const marker = `${ASSET_SEAL_PREFIX}{}));`;
  if (unsealedMain.split(marker).length !== 2) throw new Error('ASAR seal marker mismatch');
  await fs.writeFile(mainPath, unsealedMain.replace(marker,
    `const PACKAGED_ASSET_DIGESTS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze(${serialized}));`));
  const nestingPath = join(app, 'electron/nesting.js');
  const nestingRaw = await fs.readFile(nestingPath, 'utf8').catch(() => null);
  if (nestingRaw !== null && nestingRaw.includes(EXEC_SEAL_PREFIX)) {
    const unsealedEntry = stripEntrySeal(nestingRaw);
    const entryMarker = `${EXEC_SEAL_PREFIX}{});`;
    if (unsealedEntry.split(entryMarker).length !== 2) throw new Error('ASAR entry seal marker mismatch');
    await fs.writeFile(nestingPath, unsealedEntry.replace(entryMarker, `${EXEC_SEAL_PREFIX}${serialized});`));
  }
}

/**
 * Enforce a single shared boot budget across socket wait and hello/mainDirectEntry.
 * @template T
 * @param {{
 *   socketPath?: string,
 *   budgetMs?: number,
 *   pollMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   checkSocket?: () => Promise<unknown>,
 *   isFailed?: () => boolean,
 *   hasCoreFailed?: () => boolean,
 *   startMain?: (remainingMs: number) => Promise<T>,
 *   runEntry?: (remainingMs: number) => Promise<T>,
 * }} options
 * @returns {Promise<T>}
 */
export async function runPackagedBootWait({
  socketPath = '',
  budgetMs = PKG_BOOT_BUDGET_MS,
  pollMs = 25,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  checkSocket = () => fs.access(socketPath),
  isFailed,
  hasCoreFailed,
  startMain,
  runEntry,
}) {
  const failed = isFailed ?? hasCoreFailed ?? (() => false);
  const invokeMain = startMain ?? runEntry;
  if (typeof invokeMain !== 'function') {
    throw new Error('PKG_CORE_START_FAILED');
  }
  const deadline = now() + budgetMs;
  for (;;) {
    if (failed() || now() > deadline) {
      throw new Error('PKG_CORE_START_FAILED');
    }
    let ready = false;
    try {
      ready = (await checkSocket()) !== false;
    } catch {
      ready = false;
    }
    if (ready) break;
    const remainingBeforePoll = deadline - now();
    if (remainingBeforePoll <= 0) {
      throw new Error('PKG_CORE_START_FAILED');
    }
    await sleep(Math.min(pollMs, remainingBeforePoll));
  }
  const remaining = deadline - now();
  if (remaining <= 0) {
    throw new Error('PKG_CORE_START_FAILED');
  }
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('PKG_CORE_START_FAILED')), remaining);
  });
  try {
    return await Promise.race([invokeMain(remaining), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// [TARGET, unit decision] The delivered entry owns a fresh real-core session and
// supervises the bundled adapter next to core when OpenSuperficies (MV_SRF_BIN_DIR)
// is configured, degrading cleanly to core-only when absent.
export const productionEntry = String.raw`
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstatSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { format } from 'node:util';
const PACKAGED_EXEC_DIGESTS = Object.freeze({});
const root = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(root);
function writeFdSync(fd, value) {
  const text = String(value ?? '');
  const bytes = Buffer.from(text.endsWith('\n') ? text : text + '\n', 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    try {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) break;
      offset += written;
    } catch (err) {
      if (err && (err.code === 'EINTR' || err.code === 'EAGAIN')) continue;
      try {
        (fd === 1 ? process.stdout : process.stderr).write(bytes.subarray(offset));
      } catch {}
      break;
    }
  }
}
function formatErrorLine(error) {
  if (error instanceof Error) return error.stack || error.message || String(error);
  return typeof error === 'string' ? error : format(error);
}
console.error = (...args) => {
  writeFdSync(2, format(...args));
};
function verifyBootSeal(baseDir) {
  const keys = Object.keys(PACKAGED_EXEC_DIGESTS);
  if (keys.length === 0) throw new Error('PKG_SEAL_MISSING');
  const mainPrefix = 'const PACKAGED_ASSET_' + 'DIGESTS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze(';
  const execPrefix = 'const PACKAGED_EXEC_' + 'DIGESTS = Object.freeze(';
  const normalize = (relPath, rawBytes) => {
    if (relPath === 'electron/main.js') {
      const text = rawBytes.toString('utf8');
      const parts = text.split(mainPrefix);
      if (parts.length !== 2) throw new Error('PKG_SEAL_MARKER_MISMATCH');
      const end = parts[1].indexOf('));');
      if (end < 0) throw new Error('PKG_SEAL_MARKER_MISMATCH');
      const embedded = JSON.parse(parts[1].slice(0, end));
      if (JSON.stringify(embedded) !== JSON.stringify(PACKAGED_EXEC_DIGESTS)) {
        throw new Error('PKG_SEAL_MISMATCH: electron/main.js');
      }
      return Buffer.from(parts[0] + mainPrefix + '{}' + parts[1].slice(end), 'utf8');
    }
    if (relPath === 'electron/nesting.js') {
      const text = rawBytes.toString('utf8');
      const parts = text.split(execPrefix);
      if (parts.length !== 2) throw new Error('PKG_SEAL_MARKER_MISMATCH');
      const end = parts[1].indexOf(');');
      if (end < 0) throw new Error('PKG_SEAL_MARKER_MISMATCH');
      return Buffer.from(parts[0] + execPrefix + '{}' + parts[1].slice(end), 'utf8');
    }
    return rawBytes;
  };
  let verifiedCount = 0;
  const walkSection = (sectionDir, keyPrefix, relPrefix) => {
    const walk = part => {
      const entries = readdirSync(join(sectionDir, part), { withFileTypes: true }).slice()
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const name = part ? part + '/' + entry.name : entry.name;
        const fullPath = join(sectionDir, name);
        const st = lstatSync(fullPath);
        if (st.isSymbolicLink()) throw new Error('PKG_SEAL_SYMLINK: ' + relPrefix + name);
        if (st.isDirectory()) {
          walk(name);
        } else if (st.isFile()) {
          const relPath = relPrefix + name;
          const key = keyPrefix + name;
          const digest = createHash('sha256').update(normalize(relPath, readFileSync(fullPath))).digest('hex');
          if (PACKAGED_EXEC_DIGESTS[key] !== digest) {
            throw new Error('PKG_SEAL_MISMATCH: ' + key);
          }
          verifiedCount++;
        } else {
          throw new Error('PKG_SEAL_ENTRY_INVALID: ' + relPrefix + name);
        }
      }
    };
    walk('');
  };
  walkSection(join(baseDir, 'dist/renderer'), '', 'dist/renderer/');
  walkSection(join(baseDir, 'dist/preload'), 'dist/preload/', 'dist/preload/');
  walkSection(join(baseDir, 'electron'), 'electron/', 'electron/');
  if (verifiedCount !== keys.length) {
    throw new Error('PKG_SEAL_INVENTORY_MISMATCH');
  }
}
try {
  verifyBootSeal(appRoot);
} catch (error) {
  writeFdSync(2, error?.message || String(error));
  process.exit(1);
}
const { app, protocol } = await import('electron').catch(() => ({ app: { exit: code => process.exit(code), on: () => {}, removeAllListeners: () => {} }, protocol: null }));
const mainModule = await import('./main.js');
const { mainDirectEntry, validateRetailLaunch } = mainModule;
const { scrubChildEnv, validateKillTarget } = await import('./coreLauncher.js');
const retail = validateRetailLaunch(process.argv.slice(1), process.env);
if (!retail.ok) {writeFdSync(2, retail.code + ': retail launch refused');app.exit(1);}
else if (process.argv.includes('--nested-depth=1')) {
  await import('./nested-display.js');
} else {
  if (protocol && typeof mainModule.registerPrivilegedScheme === 'function') {
    try { mainModule.registerPrivilegedScheme(protocol); } catch {}
  }
  const resourcesPath = process.resourcesPath || dirname(appRoot);
  const pin = JSON.parse(await fs.readFile(join(root, 'package-pin.json'), 'utf8'));
  const runtime = await fs.mkdtemp(join(tmpdir(), 'mv-pkg-'));
  await fs.chmod(runtime, 0o700);
  await fs.mkdir(join(runtime, 'metaviewer'), {mode:0o700});
  const stateHome = join(runtime, 'state');
  const configHome = join(runtime, 'config');
  const srfStateDir = process.env.MV_SRF_STATE_DIR || join(runtime, 'srf-state');
  const srfIdentityRoot = process.env.SRF_IDENTITY_STORE_ROOT || join(runtime, 'srf-identity');
  for (const dir of [stateHome, configHome, srfStateDir, srfIdentityRoot]) {
    await fs.mkdir(dir, {recursive:true, mode:0o700});
    await fs.chmod(dir, 0o700);
  }
  const registration = component => ({endpoint:{component,instance:component+'-'+randomUUID()},hello:{
    schema:'hello/v0.2',contract_version:'v0.2',component,component_version:pin.version,
    component_commit:pin.commit,dependencies:[]}});
  const config = {session_id:'pkg-'+randomUUID(),core:registration('core'),
    peers:['daemon','agent','ui'].map(registration)};
  const configPath = join(runtime, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config), {mode:0o600});
  const daemonPeer = config.peers.find(p => p.endpoint.component === 'daemon');
  process.env.XDG_RUNTIME_DIR = runtime;
  process.env.MV_CORE_CONFIG = configPath;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.MV_SESSION_ID = config.session_id;
  process.env.MV_CORE_INSTANCE = config.core.endpoint.instance;
  process.env.MV_DAEMON_INSTANCE = daemonPeer.endpoint.instance;
  process.env.MV_COMPONENT_COMMIT = pin.commit;
  process.env.MV_CONTRACT_DIR = join(resourcesPath, 'contracts/v0.2');
  process.env.MV_SRF_STATE_DIR = srfStateDir;
  process.env.SRF_IDENTITY_STORE_ROOT = srfIdentityRoot;
  process.env.SRF_PROXY_REGISTRY = process.env.SRF_PROXY_REGISTRY || join(runtime, 'srf-proxy-registry.json');
  process.env.MV_ADAPTER_BIN = join(resourcesPath, 'bin/mv-daemon-adapter');
  delete process.env.MV_CORE_BOOTSTRAP;
  const coreEnv = {...scrubChildEnv(process.env, runtime), XDG_STATE_HOME:stateHome, MV_CORE_CONFIG:configPath};
  const core = spawn(join(resourcesPath,'bin/metaviewer-core'), [], {env:coreEnv,stdio:['pipe','pipe','pipe'],shell:false});
  let failure;
  core.on('error', error => {failure=error;});
  core.stdout.on('data', () => {});
  core.stderr.on('data', bytes => writeFdSync(2, bytes.toString('utf8')));
  let boot = null;
  let stopping = false;
  let stopPromise = null;
  const stop = () => {
    if (stopPromise !== null) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      try {
        app.removeAllListeners?.('window-all-closed');
        app.on?.('window-all-closed', () => {});
      } catch {}
      try { await boot?.dispose?.(); } catch {}
      if (validateKillTarget(core.pid, process.pid, process.pid) && core.exitCode === null && core.signalCode === null) {
        const exited = once(core,'exit');
        try {process.kill(core.pid,'SIGTERM');} catch {}
        const killer = setTimeout(() => {
          if (validateKillTarget(core.pid, process.pid, process.pid) && core.exitCode === null && core.signalCode === null) {
            try {process.kill(core.pid,'SIGKILL');} catch {}
          }
        }, 1500);
        await exited;
        clearTimeout(killer);
      }
      await fs.rm(runtime,{recursive:true,force:true});
    })();
    return stopPromise;
  };
  app.on('will-quit', event => {
    if (stopping || process.env.MV_PACKAGE_SMOKE === '1') {try {event?.preventDefault?.();} catch {}}
    if (!stopping && validateKillTarget(core.pid, process.pid, process.pid)) {try {process.kill(core.pid,'SIGTERM');} catch {}}
  });
  process.on('exit', () => {
    if (validateKillTarget(core.pid, process.pid, process.pid)) {try {process.kill(core.pid,'SIGKILL');} catch {}}
  });
  const bootBudgetMs = Number(process.env.MV_PKG_BOOT_BUDGET_MS) > 0 ? Number(process.env.MV_PKG_BOOT_BUDGET_MS) : 10000;
  const deadline = Date.now() + bootBudgetMs;
  try {
    for (;;) {
      if (failure || core.exitCode !== null || Date.now() > deadline) throw new Error('PKG_CORE_START_FAILED');
      try {await fs.access(join(runtime,'metaviewer/core.sock'));break;} catch {}
      const remainingPoll = deadline - Date.now();
      if (remainingPoll <= 0) throw new Error('PKG_CORE_START_FAILED');
      await new Promise(resolve => setTimeout(resolve, Math.min(25, remainingPoll)));
    }
    let entry;
    if (process.env.MV_PACKAGE_SMOKE === '1') {
      let smokeHandled = false;
      console.log = (...args) => {
        writeFdSync(1, format(...args));
        if (!smokeHandled && args[0] === 'METAVIEWER_MAIN_READY') {
          smokeHandled = true;
          void Promise.resolve().then(() => entry).then(async resolvedBoot => {
            boot = resolvedBoot;
            if (process.env.MV_SRF_BIN_DIR) {
              const st = boot?.adapter?.getStatus?.();
              if (!st || st.availability !== 'live' || st.handshakeSeen !== true) {
                throw new Error('PKG_ADAPTER_START_FAILED');
              }
            }
            await stop();
            writeFdSync(1, 'METAVIEWER_MAIN_SMOKE_OK\n');
            app.exit(0);
          }).catch(async error => {
            writeFdSync(2, formatErrorLine(error));
            try { await stop(); } catch {}
            app.exit(1);
          });
        }
      };
    }
    const remainingBootMs = deadline - Date.now();
    if (remainingBootMs <= 0) throw new Error('PKG_CORE_START_FAILED');
    let bootTimer;
    const bootTimeout = new Promise((_, reject) => {
      bootTimer = setTimeout(() => reject(new Error('PKG_CORE_START_FAILED')), remainingBootMs);
    });
    entry = Promise.race([
      mainDirectEntry().then(resolved => {
        if (!resolved || process.exitCode) throw new Error('PKG_MAIN_ENTRY_FAILED');
        boot = resolved;
        return resolved;
      }),
      bootTimeout,
    ]).finally(() => {
      if (bootTimer !== undefined) clearTimeout(bootTimer);
    });
    void entry.catch(async error => {writeFdSync(2, formatErrorLine(error));try {await stop();} catch {}app.exit(1);});
  } catch(error) {writeFdSync(2, formatErrorLine(error));try {await stop();} catch {}app.exit(1);}
}
`;

/** @param {string} path */
async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

/** @param {string} name @param {Buffer} bytes */
function rejectFont(name, bytes) {
  if (/\.(woff2?|ttf|otf|ttc|eot|pfa|pfb)$/i.test(name) ||
      ['wOFF','wOF2','OTTO','ttcf','true','typ1'].includes(bytes.subarray(0,4).toString('ascii')) ||
      bytes.subarray(0,4).equals(Buffer.from([0,1,0,0]))) throw new Error(`PKG_FONT_FORBIDDEN: ${name}`);
}

/** @param {string} path */
export async function verifyBinary(path, arch = architecture.arch) {
  const { machine } = packageArchitecture(arch);
  const info = await fs.lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || !(info.mode & 0o111)) throw new Error(`PKG_BINARY_MISSING: ${basename(path)}`);
  const file = await fs.open(path,'r');
  try {
    const bytes = Buffer.alloc(64); await file.read(bytes,0,64,0);
    if (bytes.subarray(0,4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== machine)
      throw new Error(`PKG_ARCH_MISMATCH: ${basename(path)}`);
  } finally {await file.close();}
}

/** Complete exact inventory: extras, aliases, mode drift and omissions all fail closed.
 * @param {string} root */
export async function verifyInstall(root, arch = architecture.arch) {
  for (const name of ['metaviewer','resources/bin/metaviewer-core','resources/bin/mv-daemon-adapter']) await verifyBinary(join(root,name), arch);
  const manifest = await fs.readFile(`${root}.sha256`,'utf8');
  /** @type {Map<string, { digest: string, mode: number }>} */
  const expected = new Map();
  for (const line of manifest.trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64})(?: ([0-7]{4}))?  (.+)$/.exec(line);
    if (!match || match[3].split('/').some(part => !part || part === '.' || part === '..') || /[\\\r\n]/.test(match[3]) || expected.has(match[3]))
      throw new Error('PKG_MANIFEST_INVALID');
    const mode = match[2] !== undefined ? Number.parseInt(match[2], 8) : DEFAULT_UMASK_FILE_MODE;
    expected.set(match[3], { digest: match[1], mode });
  }
  let count=0;
  async function walk(part) {
    const items = (await fs.readdir(join(root,part),{withFileTypes:true})).slice().sort(compareEntryNames);
    for (const item of items) {
      const name = part ? `${part}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw new Error('PKG_ALIAS_FORBIDDEN');
      if (item.isDirectory()) {await walk(name);continue;}
      if (!item.isFile()) throw new Error('PKG_ENTRY_INVALID');
      const fullPath = join(root,name);
      const st = await fs.lstat(fullPath);
      const file = await fs.open(fullPath,'r');
      const prefix=Buffer.alloc(4);
      try {await file.read(prefix,0,4,0);} finally {await file.close();}
      rejectFont(name,prefix);
      const record = expected.get(name);
      if (!record || record.digest !== await digest(fullPath) || record.mode !== (st.mode & 0o777)) {
        throw new Error(`PKG_MANIFEST_MISMATCH: ${name}`);
      }
      count++;
    }
  }
  await walk('');
  if (count !== expected.size) throw new Error('PKG_MANIFEST_MISSING');
  const asar=join(root,'resources/app.asar');
  uncache(asar);
  for (const name of listPackage(asar,{})) {
    const entry=statFile(asar,name.replace(/^\//,''),false);
    if ('size' in entry) rejectFont(name,extractFile(asar,name.replace(/^\//,'')));
  }
  await verifyPackagedSecurity(root);
}

/** @param {string} root */
export async function bundlePackage(root, arch = architecture.arch) {
  await verifyInstall(root, arch);
  const artifact=`${root}.tar`;
  await execute('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner',
    '--format=gnu','--mode=u+rwX,go+rX,go-w','-cf',artifact,'-C',dirname(root),basename(root),`${basename(root)}.sha256`]);
  return {artifact,artifact_sha256:await digest(artifact),size_bytes:(await fs.stat(artifact)).size};
}

/** @type {Readonly<Record<string, { archiveSha256: string, treeSha256: string }>>} */
export const PINNED_ELECTRON_DIST_TREES = Object.freeze({
  [`electron-v${ELECTRON_PIN}-linux-arm64.zip`]: Object.freeze({
    archiveSha256: 'f113a7f1f04ddb09f2e9b7bf4785f45eb1cb310dd9f2183e01f44c0a7b8df77d',
    treeSha256: '1fb4bc1f410365889baf6fe046a190579da3a6bdf1de48d7afdee366af8cb244',
  }),
});

export const LOCKED_ELECTRON_PACKAGE_INTEGRITY =
  'sha512-mZ79mSsjLlgU91Uck3UhDcI0AU/draTkS+qsSnasZstNYitsdHr5XeIK3b6I6RkLqVe07QHeYVRZnQVTHL/9Lg==';

/** @type {Readonly<Record<string, string>>} */
export const LOCKED_ELECTRON_NPM_FILES = Object.freeze({
  LICENSE: '5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d',
  'README.md': 'cb788749d3f0d3991e9c17b0cbcd9fd15a8c9bd73e45874d0a936fdbd9d3745b',
  abi_version: '05ada863a4cf9660fd8c68e2295f1d35b2264815f5b605003d6625bd9e0492cf',
  'checksums.json': '3ffe9db2fb6e3115fddc95d0a297175f8ae2b9ffd4ea45e40359577f6d70cb8d',
  'cli.js': '186a8ffa8cfea268bfef39569a145f8122d662db1ac4c022f3ef60bb4c894cc5',
  'electron.d.ts': 'd52c1c43af68d7f7348c899033e202a7c4b08866e458c026a8a69f89a774e08d',
  'index.js': '331e1e14d5f00ccbc61af0df6af6767ebabd48cf2f05d38d3d3345b20f8ce3f9',
  'install.js': '3b9e0c3c9070edbdb732dc05ed23c6f1c6b7a404bd623033a2f0b71052534e93',
  'package.json': '91c4ac0a8c04185efb3d360a11415f18fc6925e98fa6046595bdf1cb77ec277d',
});

/**
 * Build a PKG_ELECTRON_CHECKSUM error that prints expected and actual identity.
 * @param {string} context
 * @param {string} expected
 * @param {string} actual
 * @param {boolean} [legacyExactMessage]
 */
export function electronChecksumError(context, expected, actual, legacyExactMessage = false) {
  const detail = `PKG_ELECTRON_CHECKSUM: ${context} expected=${expected} actual=${actual}`;
  writeFdSync(2, detail);
  const err = /** @type {Error & { code?: string, context?: string, expected?: string, actual?: string, detail?: string }} */ (
    new Error(legacyExactMessage ? 'PKG_ELECTRON_CHECKSUM' : detail)
  );
  err.code = 'PKG_ELECTRON_CHECKSUM';
  err.context = context;
  err.expected = expected;
  err.actual = actual;
  err.detail = detail;
  return err;
}

/**
 * Return candidate paths for the upstream Electron release zip, including
 * @electron/get's SHA-256 release-URL cache directory and temp directories.
 * @param {string} expectedArchive
 * @param {NodeJS.ProcessEnv} [env]
 */
export function defaultElectronZipCandidates(expectedArchive, env = process.env) {
  const releaseBaseUrl = `https://github.com/electron/electron/releases/download/v${ELECTRON_PIN}`;
  const urlHash = createHash('sha256').update(releaseBaseUrl).digest('hex');
  /** @type {string[]} */
  const cacheRoots = [];
  if (env.electron_config_cache) cacheRoots.push(env.electron_config_cache);
  if (env.XDG_CACHE_HOME) cacheRoots.push(join(env.XDG_CACHE_HOME, 'electron'));
  if (env.HOME) cacheRoots.push(join(env.HOME, '.cache/electron'));
  try {
    const homeCache = join(homedir(), '.cache/electron');
    if (!cacheRoots.includes(homeCache)) cacheRoots.push(homeCache);
  } catch {}
  /** @type {string[]} */
  const candidates = [];
  for (const root of cacheRoots) {
    candidates.push(join(root, urlHash, expectedArchive));
    candidates.push(join(root, expectedArchive));
  }
  candidates.push(join(tmpdir(), expectedArchive));
  candidates.push(join('/tmp', expectedArchive));
  return [...new Set(candidates)];
}

/**
 * Compute per-file SHA-256 digests and a deterministic tree digest over an
 * unpacked Electron distribution directory.
 * @param {string} dist
 */
export async function computeElectronDistTreeDigest(dist) {
  /** @type {Array<{ name: string, mode: string }>} */
  const entries = [];
  /** @param {string} part */
  async function walk(part) {
    const dirPath = part ? join(dist, part) : dist;
    const items = (await fs.readdir(dirPath, { withFileTypes: true })).slice().sort(compareEntryNames);
    for (const item of items) {
      const name = part ? `${part}/${item.name}` : item.name;
      if (/[\r\n\\]/.test(name) || item.isSymbolicLink()) {
        throw electronChecksumError(`dist entry ${name}`, 'regular-file-or-dir', 'symlink-or-invalid-name');
      }
      if (item.isDirectory()) {
        await walk(name);
      } else if (item.isFile()) {
        const st = await fs.lstat(join(dist, name));
        entries.push({ name, mode: (st.mode & 0o111) !== 0 ? '0755' : '0644' });
      } else {
        throw electronChecksumError(`dist entry ${name}`, 'regular-file', 'special-entry');
      }
    }
  }
  await walk('');
  entries.sort(compareEntryNames);
  if (entries.length === 0) throw electronChecksumError('dist tree', 'non-empty', 'empty');
  /** @type {Map<string, string>} */
  const files = new Map();
  const lines = [];
  for (const entry of entries) {
    const fileDigest = await digest(join(dist, entry.name));
    files.set(entry.name, fileDigest);
    lines.push(`${fileDigest} ${entry.mode}  ${entry.name}\n`);
  }
  const treeSha256 = createHash('sha256').update(lines.join('')).digest('hex');
  return { treeSha256, files };
}

/**
 * Verify a local Electron release zip directory against checksums.json.
 * @param {string} zipDir
 * @param {string} [arch]
 * @param {{ checksumsPath?: string }} [options]
 */
export async function verifyElectronZip(zipDir, arch = architecture.arch, options = {}) {
  const { archive: expectedArchive } = packageArchitecture(arch);
  const checksumsCandidates = [
    ...(options.checksumsPath ? [options.checksumsPath] : []),
    join(ui, 'node_modules/electron/checksums.json'),
  ];
  /** @type {Record<string, any> | null} */
  let checksums = null;
  for (const candidate of checksumsCandidates) {
    try {
      checksums = JSON.parse(await fs.readFile(candidate, 'utf8'));
      break;
    } catch {}
  }
  const expectedArchiveSha = checksums?.[expectedArchive];
  if (typeof expectedArchiveSha !== 'string' || !/^[0-9a-f]{64}$/.test(expectedArchiveSha)) {
    throw electronChecksumError(
      `checksums.json[${expectedArchive}]`,
      '64-hex-sha256',
      String(expectedArchiveSha ?? 'missing'),
    );
  }
  const zipPath = join(zipDir, expectedArchive);
  const actualArchiveSha = await digest(zipPath).catch(() => 'missing');
  if (actualArchiveSha !== expectedArchiveSha) {
    throw electronChecksumError(`zip ${expectedArchive} (${zipPath})`, expectedArchiveSha, actualArchiveSha);
  }
  return { archive: expectedArchive, archiveSha256: actualArchiveSha, zipPath };
}

/**
 * Verify that the Electron npm package wrapper and lockfile entry match the
 * pinned version and package-lock.json integrity.
 * @param {string} dist
 * @param {Record<string, any> | null} checksums
 * @param {{ checksumsPath?: string, lockfilePath?: string, requireLockfileWrapper?: boolean }} [options]
 */
export async function verifyElectronLockfileBinding(dist, checksums, options = {}) {
  const wrapperDir = dirname(dist);
  const wrapperPkgPath = join(wrapperDir, 'package.json');
  const hasWrapperPkg = await fs
    .stat(wrapperPkgPath)
    .then(st => st.isFile())
    .catch(() => false);
  if (!hasWrapperPkg && !options.lockfilePath && !options.requireLockfileWrapper) {
    return null;
  }
  const candidateLockfiles = [
    ...(options.lockfilePath ? [options.lockfilePath] : []),
    join(dirname(dirname(wrapperDir)), 'package-lock.json'),
    join(ui, 'package-lock.json'),
  ];
  /** @type {Record<string, any> | null} */
  let lockfile = null;
  for (const candidate of candidateLockfiles) {
    try {
      lockfile = JSON.parse(await fs.readFile(candidate, 'utf8'));
      break;
    } catch {}
  }
  const electronLock = lockfile?.packages?.['node_modules/electron'];
  if (!electronLock || typeof electronLock !== 'object') {
    throw electronChecksumError('package-lock.json packages[node_modules/electron]', 'present', 'missing');
  }
  if (String(electronLock.version ?? '') !== ELECTRON_PIN) {
    throw electronChecksumError(
      'package-lock.json packages[node_modules/electron].version',
      ELECTRON_PIN,
      String(electronLock.version ?? 'missing'),
    );
  }
  if (String(electronLock.integrity ?? '') !== LOCKED_ELECTRON_PACKAGE_INTEGRITY) {
    throw electronChecksumError(
      'package-lock.json packages[node_modules/electron].integrity',
      LOCKED_ELECTRON_PACKAGE_INTEGRITY,
      String(electronLock.integrity ?? 'missing'),
    );
  }
  if (hasWrapperPkg || options.requireLockfileWrapper) {
    const wrapperPkg = JSON.parse(await fs.readFile(wrapperPkgPath, 'utf8').catch(() => '{}'));
    if (String(wrapperPkg.version ?? '') !== ELECTRON_PIN) {
      throw new Error('PKG_ELECTRON_PIN');
    }
    for (const [fileName, expectedSha] of Object.entries(LOCKED_ELECTRON_NPM_FILES)) {
      if (fileName === 'checksums.json' && options.checksumsPath) continue;
      const actualSha = await digest(join(wrapperDir, fileName)).catch(() => 'missing');
      if (actualSha !== expectedSha) {
        throw electronChecksumError(`electron npm file ${fileName}`, expectedSha, actualSha);
      }
    }
    if (typeof checksums?.['electron.d.ts'] === 'string') {
      const actualDtsSha = await digest(join(wrapperDir, 'electron.d.ts')).catch(() => 'missing');
      if (actualDtsSha !== checksums['electron.d.ts']) {
        throw electronChecksumError('electron.d.ts', checksums['electron.d.ts'], actualDtsSha);
      }
    }
  }
  return {
    version: ELECTRON_PIN,
    integrity: LOCKED_ELECTRON_PACKAGE_INTEGRITY,
  };
}

/**
 * Verify an unpacked Electron distribution against checksums.json, lockfile
 * metadata, a pinned per-file tree digest, or a checksum-verified local
 * upstream archive (including @electron/get's release cache).
 * @param {string} dist
 * @param {string} [arch]
 * @param {{
 *   checksumsPath?: string,
 *   lockfilePath?: string,
 *   requireLockfileWrapper?: boolean,
 *   zipCandidates?: string[],
 *   expectedTreeDigest?: string,
 *   ignorePinnedTrees?: boolean,
 *   includeIdentityInError?: boolean,
 *   env?: NodeJS.ProcessEnv,
 * }} [options]
 */
export async function verifyElectronDist(dist, arch = architecture.arch, options = {}) {
  const { archive: expectedArchive } = packageArchitecture(arch);
  await fs.access(join(dist, 'electron')).catch(() => {
    throw electronChecksumError('dist/electron', 'present', 'missing');
  });
  const versionRaw = await fs.readFile(join(dist, 'version'), 'utf8').catch(() => '');
  if (versionRaw.trim().replace(/^v/, '') !== ELECTRON_PIN) throw new Error('PKG_ELECTRON_PIN');
  await verifyBinary(join(dist, 'electron'), arch);
  const checksumsCandidates = [
    ...(options.checksumsPath ? [options.checksumsPath] : []),
    join(dirname(dist), 'checksums.json'),
    join(ui, 'node_modules/electron/checksums.json'),
  ];
  /** @type {Record<string, any> | null} */
  let checksums = null;
  for (const candidate of checksumsCandidates) {
    try {
      checksums = JSON.parse(await fs.readFile(candidate, 'utf8'));
      break;
    } catch {}
  }
  const expectedArchiveSha = checksums?.[expectedArchive];
  if (typeof expectedArchiveSha !== 'string' || !/^[0-9a-f]{64}$/.test(expectedArchiveSha)) {
    throw electronChecksumError(
      `checksums.json[${expectedArchive}]`,
      '64-hex-sha256',
      String(expectedArchiveSha ?? 'missing'),
    );
  }
  await verifyElectronLockfileBinding(dist, checksums, options);
  const { treeSha256, files } = await computeElectronDistTreeDigest(dist);
  const expectedTree = options.expectedTreeDigest ?? checksums?.[`${expectedArchive}:tree`];
  if (typeof expectedTree === 'string') {
    const legacyExactMessage = Boolean(
      options.checksumsPath && options.expectedTreeDigest === undefined && !options.includeIdentityInError,
    );
    if (treeSha256 !== expectedTree) {
      throw electronChecksumError(`dist tree ${expectedArchive}`, expectedTree, treeSha256, legacyExactMessage);
    }
    return { archiveSha256: expectedArchiveSha, treeSha256 };
  }
  const expectedFiles = checksums?.[`${expectedArchive}:files`];
  if (expectedFiles && typeof expectedFiles === 'object' && !Array.isArray(expectedFiles)) {
    const keys = Object.keys(expectedFiles);
    if (keys.length === 0 || keys.length !== files.size) {
      throw electronChecksumError(`dist file count ${expectedArchive}`, String(keys.length), String(files.size));
    }
    for (const key of keys) {
      if (files.get(key) !== expectedFiles[key]) {
        throw electronChecksumError(`dist file ${key}`, String(expectedFiles[key]), String(files.get(key) ?? 'missing'));
      }
    }
    return { archiveSha256: expectedArchiveSha, treeSha256 };
  }
  const pinned = !options.ignorePinnedTrees && !options.zipCandidates ? PINNED_ELECTRON_DIST_TREES[expectedArchive] : undefined;
  if (pinned && pinned.archiveSha256 === expectedArchiveSha) {
    if (treeSha256 !== pinned.treeSha256) {
      throw electronChecksumError(`dist tree ${expectedArchive}`, pinned.treeSha256, treeSha256);
    }
    for (const zipPath of defaultElectronZipCandidates(expectedArchive, options.env)) {
      const zipStat = await fs.stat(zipPath).catch(() => null);
      if (!zipStat?.isFile()) continue;
      const actualZipSha = await digest(zipPath);
      if (actualZipSha !== expectedArchiveSha) {
        throw electronChecksumError(`zip ${expectedArchive} (${zipPath})`, expectedArchiveSha, actualZipSha);
      }
    }
    return { archiveSha256: expectedArchiveSha, treeSha256 };
  }
  const zipCandidates = options.zipCandidates ?? defaultElectronZipCandidates(expectedArchive, options.env);
  /** @type {{ zipPath: string, actualZipSha: string } | null} */
  let lastZipMismatch = null;
  for (const zipPath of zipCandidates) {
    const zipStat = await fs.stat(zipPath).catch(() => null);
    if (!zipStat?.isFile()) continue;
    const actualZipSha = await digest(zipPath);
    if (actualZipSha !== expectedArchiveSha) {
      lastZipMismatch = { zipPath, actualZipSha };
      continue;
    }
    const unpackTmp = await fs.mkdtemp(join(tmpdir(), '.mv-el-verify-'));
    try {
      await execute('unzip', ['-q', zipPath, '-d', unpackTmp]);
      const unpacked = await computeElectronDistTreeDigest(unpackTmp);
      if (unpacked.treeSha256 !== treeSha256) {
        let diffDetail = '';
        for (const [name, expectedFileSha] of unpacked.files.entries()) {
          const actualFileSha = files.get(name);
          if (actualFileSha !== expectedFileSha) {
            diffDetail = ` file=${name} fileExpected=${expectedFileSha} fileActual=${actualFileSha ?? 'missing'}`;
            break;
          }
        }
        if (!diffDetail) {
          for (const [name, actualFileSha] of files.entries()) {
            if (!unpacked.files.has(name)) {
              diffDetail = ` file=${name} fileExpected=absent fileActual=${actualFileSha}`;
              break;
            }
          }
        }
        throw electronChecksumError(
          `dist tree ${expectedArchive}${diffDetail}`,
          unpacked.treeSha256,
          treeSha256,
        );
      }
      return { archiveSha256: expectedArchiveSha, treeSha256 };
    } finally {
      await fs.rm(unpackTmp, { recursive: true, force: true });
    }
  }
  if (lastZipMismatch) {
    throw electronChecksumError(
      `zip ${expectedArchive} (${lastZipMismatch.zipPath})`,
      expectedArchiveSha,
      lastZipMismatch.actualZipSha,
    );
  }
  throw electronChecksumError(
    `unverified dist ${expectedArchive} (no pinned tree or cached zip in [${zipCandidates.join(', ')}])`,
    expectedArchiveSha,
    `tree:${treeSha256}`,
  );
}

/**
 * Stage package directory and manifest together under workDir and publish with
 * manifest-first fsync + single directory rename, rolling back on any fault so
 * a partial final directory without its manifest is never visible.
 * @param {string} stagedDir
 * @param {string} workDir
 * @param {string} finalDir
 * @param {{ rename?: typeof fs.rename }} [options]
 */
export async function publishStagedPackage(stagedDir, workDir, finalDir, options = {}) {
  const renameFn = options.rename ?? fs.rename;
  const outputDir = dirname(finalDir);
  const archName = basename(finalDir);
  const prior = await fs.readdir(outputDir);
  if (prior.includes(archName) || prior.includes(`${archName}.sha256`)) {
    throw new Error('Package destination already exists');
  }
  const bundleStage = join(workDir, 'publish-stage');
  await fs.mkdir(bundleStage, { recursive: true });
  const stagedTargetDir = join(bundleStage, archName);
  const stagedManifest = join(bundleStage, `${archName}.sha256`);
  await fs.rename(stagedDir, stagedTargetDir);
  await writeManifest(stagedTargetDir, stagedManifest);
  const manifestFd = await fs.open(stagedManifest, 'r');
  try {
    await manifestFd.sync();
  } finally {
    await manifestFd.close();
  }
  const finalManifest = `${finalDir}.sha256`;
  try {
    await renameFn(stagedManifest, finalManifest);
    await renameFn(stagedTargetDir, finalDir);
  } catch (error) {
    await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(finalManifest, { force: true }).catch(() => {});
    throw error;
  }
  const outFd = await fs.open(outputDir, 'r');
  try {
    await outFd.sync();
  } finally {
    await outFd.close();
  }
}

/**
 * Format bounded process diagnostics carrying exit code, signal, and the last
 * 3000 characters of stdout and stderr.
 * @param {{ code?: number | string | null, signal?: NodeJS.Signals | string | null, stdout?: string | Buffer, stderr?: string | Buffer }} [details]
 */
export function formatSmokeDiagnostics(details = {}) {
  const code = details?.code !== undefined ? details.code : 0;
  const signal = details?.signal !== undefined ? details.signal : null;
  const stdout = String(details?.stdout ?? '').slice(-SMOKE_DIAGNOSTIC_TAIL_CHARS);
  const stderr = String(details?.stderr ?? '').slice(-SMOKE_DIAGNOSTIC_TAIL_CHARS);
  return JSON.stringify({ code, signal, stdout, stderr });
}

/**
 * Build a self-explaining Error carrying child exit code, signal, and the last
 * 3000 characters of stdout and stderr.
 * @param {string} reason
 * @param {{ code?: number | string | null, signal?: NodeJS.Signals | string | null, stdout?: string | Buffer, stderr?: string | Buffer }} [details]
 * @param {unknown} [cause]
 */
export function createSmokeDiagnosticError(reason, details = {}, cause = undefined) {
  const code = details?.code !== undefined ? details.code : 0;
  const signal = details?.signal !== undefined ? details.signal : null;
  const stdout = String(details?.stdout ?? '').slice(-SMOKE_DIAGNOSTIC_TAIL_CHARS);
  const stderr = String(details?.stderr ?? '').slice(-SMOKE_DIAGNOSTIC_TAIL_CHARS);
  const serialized = formatSmokeDiagnostics({ code, signal, stdout, stderr });
  const error = /** @type {Error & { code?: number | string | null, signal?: NodeJS.Signals | string | null, stdout?: string, stderr?: string }} */ (
    cause !== undefined ? new Error(`${reason}: ${serialized}`, { cause }) : new Error(`${reason}: ${serialized}`)
  );
  error.code = code;
  error.signal = signal;
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

/**
 * @param {string | { stdout?: string | Buffer, stderr?: string | Buffer, code?: number | string | null, signal?: NodeJS.Signals | string | null }} stdout
 * @param {{ stdout?: string | Buffer, stderr?: string | Buffer, code?: number | string | null, signal?: NodeJS.Signals | string | null }} [details]
 */
export function assertSmokeOutput(stdout, details = {}) {
  const isRecord = typeof stdout === 'object' && stdout !== null && !(stdout instanceof Buffer);
  const merged = isRecord ? { ...details, ...stdout } : { ...details, stdout };
  const code = merged.code !== undefined ? merged.code : 0;
  const signal = merged.signal !== undefined ? merged.signal : null;
  const outText = String(merged.stdout ?? '');
  const errText = String(merged.stderr ?? '');
  if (!outText.split('\n').includes('METAVIEWER_MAIN_SMOKE_OK')) {
    throw createSmokeDiagnosticError('PKG_SMOKE_MARKER_MISSING', { code, signal, stdout: outText, stderr: errText });
  }
}

/**
 * Execute the packaged smoke child process and verify both zero exit and the
 * exact smoke marker on stdout. On a non-zero child exit or missing marker,
 * throw an Error carrying child exit code, signal, and the last 3000 characters
 * of stdout and stderr.
 * @param {() => Promise<{ stdout?: string | Buffer, stderr?: string | Buffer, code?: number | string | null, signal?: NodeJS.Signals | string | null }>} launch
 */
export async function runSmokeCommand(launch) {
  let result;
  try {
    result = await launch();
  } catch (error) {
    const rec = /** @type {Record<string, unknown>} */ (error && typeof error === 'object' ? error : {});
    const code = typeof rec.code === 'number' || typeof rec.code === 'string'
      ? rec.code
      : typeof rec.status === 'number'
        ? rec.status
        : null;
    const signal = typeof rec.signal === 'string' ? rec.signal : null;
    const stdout = rec.stdout !== undefined ? String(rec.stdout) : '';
    const stderr = rec.stderr !== undefined
      ? String(rec.stderr)
      : error instanceof Error
        ? error.message
        : String(error);
    throw createSmokeDiagnosticError('PKG_SMOKE_CHILD_FAILED', { code, signal, stdout, stderr }, error);
  }
  const code = result?.code !== undefined ? result.code : 0;
  const signal = result?.signal !== undefined ? result.signal : null;
  const stdout = String(result?.stdout ?? '');
  const stderr = String(result?.stderr ?? '');
  if ((typeof code === 'number' && code !== 0) || code === null || signal !== null) {
    throw createSmokeDiagnosticError('PKG_SMOKE_CHILD_FAILED', { code, signal, stdout, stderr });
  }
  assertSmokeOutput(stdout, { code, signal, stdout, stderr });
  return { stdout, stderr, code, signal };
}

/**
 * Write a deterministic fake adapter executable for clean-install smoke testing
 * (never uses the live capsule). Connects to the real core socket, completes the
 * daemon hello/v0.2 handshake, records its scrubbed environment and PID, and
 * records SIGTERM reaping on quit.
 * @param {string} destination
 * @param {string} receiptPath
 */
export async function writeFakeSmokeAdapter(destination, receiptPath) {
  const script = `#!${process.execPath}
import { createConnection } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const receiptPath = ${JSON.stringify(receiptPath)};
const record = {
  pid: process.pid,
  started: true,
  handshake: false,
  reaped: false,
  srfBinDir: process.env.MV_SRF_BIN_DIR || null,
  sessionId: process.env.MV_SESSION_ID || null,
  envKeys: Object.keys(process.env).sort(),
};
const save = () => { try { writeFileSync(receiptPath, JSON.stringify(record)); } catch {} };
save();
process.on('SIGTERM', () => {
  record.reaped = true;
  save();
  process.exit(0);
});
const config = JSON.parse(readFileSync(process.env.MV_CORE_CONFIG, 'utf8'));
const daemon = config.peers.find(p => p.endpoint.component === 'daemon');
const sock = createConnection(join(process.env.XDG_RUNTIME_DIR, 'metaviewer/core.sock'));
let buf = '';
sock.on('connect', () => {
  const env = {
    schema: 'envelope/v0.2',
    msg_id: 'smoke-daemon-hello',
    ts_ns: 0,
    from: daemon.endpoint,
    to: config.core.endpoint,
    session_id: config.session_id,
    seq: 1,
    nonce: randomUUID(),
    body: daemon.hello,
  };
  sock.write(JSON.stringify(env) + '\\n');
});
sock.on('data', chunk => {
  buf += chunk.toString('utf8');
  if (buf.includes('\\n')) {
    record.handshake = true;
    save();
    process.stdout.write('ADAPTER_HANDSHAKE_OK\\n');
  }
});
sock.on('error', () => {});
setInterval(() => {}, 1000);
`;
  await fs.writeFile(destination, script, { mode: 0o755 });
}

/**
 * Verify that the fake adapter in the smoke test started with a valid PID > 1,
 * observed the core handshake, received the scrubbed environment subset, and
 * was reaped on quit.
 * @param {string} receiptPath
 * @param {string} expectedSrfBinDir
 */
export async function verifySmokeAdapterReceipt(receiptPath, expectedSrfBinDir) {
  let receipt;
  try {
    receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  } catch {
    throw new Error('PKG_SMOKE_ADAPTER_RECEIPT_MISSING');
  }
  if (typeof receipt?.pid !== 'number' || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 1) {
    throw new Error('PKG_SMOKE_ADAPTER_PID_INVALID');
  }
  if (receipt.started !== true || receipt.handshake !== true) {
    throw new Error('PKG_SMOKE_ADAPTER_HANDSHAKE_MISSING');
  }
  if (receipt.srfBinDir !== expectedSrfBinDir || typeof receipt.sessionId !== 'string' || !receipt.sessionId.startsWith('pkg-')) {
    throw new Error('PKG_SMOKE_ADAPTER_ENV_MISMATCH');
  }
  if (receipt.reaped !== true) {
    throw new Error('PKG_SMOKE_ADAPTER_NOT_REAPED');
  }
  let alive = false;
  try {
    process.kill(receipt.pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  if (alive) {
    throw new Error('PKG_SMOKE_ADAPTER_STILL_ALIVE');
  }
  return receipt;
}

/** Extract actual product bytes, trace all descendants, refuse source access.
 * @param {string} artifact */
export async function cleanInstallSmoke(artifact) {
  const clean=await fs.mkdtemp(join(tmpdir(),'mv-clean-'));
  validateOutput(clean,repo);
  try {
    const types=await execute('tar',['-tvf',artifact],{maxBuffer:1024*1024});
    if (types.stdout.split('\n').filter(Boolean).some(line => !['-','d'].includes(line[0]))) throw new Error('PKG_ARCHIVE_ALIAS');
    const listing=await execute('tar',['-tf',artifact],{maxBuffer:1024*1024});
    if (listing.stdout.split('\n').filter(Boolean).some(name => !(name.startsWith(architecture.name + '/') || name === architecture.name + '.sha256') || name.split('/').includes('..'))) throw new Error('PKG_ARCHIVE_INVALID');
    await execute('tar',['--no-same-owner','-pxf',artifact,'-C',clean]);
    const installed=join(clean,architecture.name);
    await verifyInstall(installed);
    // Exercise the delivered bytes, then restore each control before launch.
    const expectReason = async code => {
      try {await verifyInstall(installed);}
      catch (error) {if (error.message.startsWith(code)) return;throw error;}
      throw new Error(`PKG_NEGATIVE_CONTROL_PASSED: ${code}`);
    };
    const notice=join(installed,'INSTALL.md');
    const original=await fs.readFile(notice);
    const originalMode=(await fs.lstat(notice)).mode & 0o777;
    try {await fs.appendFile(notice,'tampered');await expectReason('PKG_MANIFEST_MISMATCH');}
    finally {await fs.writeFile(notice,original,{mode:originalMode});await fs.chmod(notice,originalMode);}
    try {await fs.chmod(notice,0o600);await expectReason('PKG_MANIFEST_MISMATCH');}
    finally {await fs.chmod(notice,originalMode);}
    const font=join(installed,'planted.woff2');
    try {await fs.writeFile(font,'wOF2');await expectReason('PKG_FONT_FORBIDDEN');}
    finally {await fs.rm(font,{force:true});}
    const adapter=join(installed,'resources/bin/mv-daemon-adapter');
    await fs.rename(adapter,`${adapter}.control`);
    try {await expectReason('PKG_BINARY_MISSING: mv-daemon-adapter');}
    finally {await fs.rename(`${adapter}.control`,adapter);}
    await verifyInstall(installed);
    const srfBinDir=join(clean,'srf-bin');
    await fs.mkdir(srfBinDir,{mode:0o700});
    const receiptPath=join(clean,'adapter-smoke-receipt.json');
    await fs.rename(adapter,`${adapter}.real`);
    try {
      await writeFakeSmokeAdapter(adapter,receiptPath);
      const trace=join(clean,'files.trace');
      const env={PATH:process.env.PATH,HOME:clean,LANG:'C.UTF-8',MV_PACKAGE_SMOKE:'1',MV_SRF_BIN_DIR:srfBinDir};
      await runSmokeCommand(() => execute('xvfb-run',['-a','strace','-f','-e','trace=file','-o',trace,
        join(installed,'metaviewer'),`--user-data-dir=${join(clean,'profile')}`],{cwd:clean,env,timeout:30000,maxBuffer:1024*1024}));
      await verifySmokeAdapterReceipt(receiptPath,srfBinDir);
      const accesses=await fs.readFile(trace,'utf8');
      if (accesses.includes(repo) || accesses.includes(await fs.realpath(repo))) throw new Error('PKG_SOURCE_ACCESS');
    } finally {
      await fs.rename(`${adapter}.real`,adapter);
    }
    await verifyInstall(installed);
    const env={PATH:process.env.PATH,HOME:clean,LANG:'C.UTF-8',MV_PACKAGE_SMOKE:'1'};
    let refused=false, refusalDetail='';
    try {
      await execute('xvfb-run',['-a',join(installed,'metaviewer'),
        `--user-data-dir=${join(clean,'refusal-profile')}`,'--remote-debugging-port=9222'],
        {cwd:clean,env,timeout:10000,maxBuffer:1024*1024});
    } catch (error) {
      refusalDetail=JSON.stringify({code:error.code,signal:error.signal,stdout:error.stdout,stderr:error.stderr,message:error.message}).slice(-3000);
      refused=typeof error.code === 'number' && error.code !== 0 && /RETAIL_FLAG/.test(String(error.stderr) + String(error.stdout));
    }
    if (!refused) throw new Error(`PKG_RETAIL_REFUSAL_MISSING: ${refusalDetail}`);
    return {marker:'METAVIEWER_MAIN_SMOKE_OK',source_access:false,negative_controls:'PASS'};
  } finally {await fs.rm(clean,{recursive:true,force:true});}
}

/** @param {NodeJS.ProcessEnv} env */
export async function packageShell(env = process.env) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node >=24 required');
  const repository = await fs.realpath(repo);
  const requested = validateOutput(env.MV_PKG_OUT, repository);
  // Validate through the nearest existing ancestor before any filesystem write.
  let ancestor = requested;
  const suffix = [];
  let canonical;
  for (;;) {
    try {
      canonical = await fs.realpath(ancestor);
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      // A dangling symlink is not a missing directory: fail closed.
      const entry = await fs.lstat(ancestor).catch(cause => {
        if (cause.code !== 'ENOENT') throw cause;
        return null;
      });
      if (entry) throw new Error('MV_PKG_OUT ancestor cannot be resolved');
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  const destination = validateOutput(join(canonical, ...suffix), repository);
  await fs.mkdir(destination, { recursive: true });
  const output = validateOutput(await fs.realpath(destination), repository);
  if (!env.CAPSULE_UI_KIT_REPO) throw new Error('CAPSULE_UI_KIT_REPO is required');
  if (!env.MV_ELECTRON_ZIP_DIR && !env.ELECTRON_OVERRIDE_DIST_PATH) {
    throw new Error('Set MV_ELECTRON_ZIP_DIR or ELECTRON_OVERRIDE_DIST_PATH to a local Electron distribution');
  }
  const final = join(output, architecture.name);
  // Refuse replacement of a previously delivered artifact.
  const prior = await fs.readdir(output);
  if (prior.includes(architecture.name) || prior.includes(architecture.name + '.sha256')) {
    throw new Error('Package destination already exists');
  }
  const work = await fs.mkdtemp(join(output, '.pkg-'));
  try {
    const builder = join(work, 'builder');
    const app = join(work, 'app');
    await fs.mkdir(builder);
    await fs.mkdir(app);
    for (const name of ['src', 'index.html', 'vite.config.js', 'electron']) {
      await fs.cp(join(ui, name), join(builder, name), { recursive: true });
    }
    await fs.copyFile(join(ui, 'package.json'), join(builder, 'package.json'));
    await fs.symlink(join(ui, 'node_modules'), join(builder, 'node_modules'), 'dir');
    await syncKit({ kitRepo: env.CAPSULE_UI_KIT_REPO,
      dest: join(builder, '.kit/capsule-ui-kit'), lockPath: join(ui, 'kit.lock.json') });
    await execute(process.execPath, [join(ui, 'node_modules/vite/bin/vite.js'), 'build',
      '--outDir', join(app, 'dist/renderer')], { cwd: builder, env, maxBuffer: 1024 * 1024 });
    await fs.cp(join(ui, 'electron'), join(app, 'electron'), { recursive: true });
    const pkgVersion = JSON.parse(await fs.readFile(join(ui,'package.json'),'utf8')).version;
    const commit = (await execute('git',['rev-parse','HEAD'],{cwd:repo})).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('PKG_REVISION_INVALID');
    await fs.rename(join(app,'electron/nesting.js'),join(app,'electron/nested-display.js'));
    await fs.appendFile(join(app,'electron/main.js'),'\nexport { mainDirectEntry };\n');
    await fs.writeFile(join(app,'electron/nesting.js'),productionEntry);
    await fs.writeFile(join(app,'electron/package-pin.json'),JSON.stringify({version:pkgVersion,commit}));
    await sealRendererAssets(app);
    const pkg = JSON.parse(await fs.readFile(join(ui, 'package.json'), 'utf8'));
    await fs.writeFile(join(app, 'package.json'), JSON.stringify({ name: 'metaviewer',
      version: pkg.version, type: 'module', main: 'electron/nesting.js' }));
    let zipDir = env.MV_ELECTRON_ZIP_DIR;
    if (!zipDir) {
      const dist = await fs.realpath(/** @type {string} */ (env.ELECTRON_OVERRIDE_DIST_PATH));
      await verifyElectronDist(dist, architecture.arch);
      zipDir = join(work, 'electron-zip');
      await fs.mkdir(zipDir);
      await execute('zip', ['-q', '-r', '-X', join(zipDir, archive), '.'], { cwd: dist });
      const createdZipSha = await digest(join(zipDir, archive)).catch(() => 'missing');
      if (!/^[0-9a-f]{64}$/.test(createdZipSha)) {
        throw electronChecksumError(`staged zip ${archive}`, '64-hex-sha256', createdZipSha);
      }
    } else {
      await verifyElectronZip(zipDir, architecture.arch);
    }
    const native = join(work,'native');
    await fs.mkdir(native);
    const cargo = env.CARGO || 'cargo';
    const target = env.CARGO_TARGET_DIR;
    if (!target || !isAbsolute(target)) throw new Error('PKG_CARGO_TARGET_REQUIRED');
    await execute(cargo,['build','--offline','--release','--bin','metaviewer-core'],{cwd:repo,env,maxBuffer:1024*1024});
    await fs.copyFile(join(target,'release/metaviewer-core'),join(native,'metaviewer-core'));
    await execute(env.GO || 'go',['build','-trimpath','-buildvcs=false','-ldflags=-buildid=',
      '-o',join(native,'mv-daemon-adapter'),'./cmd/mv-daemon-adapter'],
      {cwd:join(repo,'daemon-adapter'),env:{...env,GOPROXY:'off',GOSUMDB:'off',GOTOOLCHAIN:'local'},maxBuffer:1024*1024});
    for (const name of ['metaviewer-core','mv-daemon-adapter']) await verifyBinary(join(native,name));
    const { packager } = await import('@electron/packager');
    const fuseConfig = buildFuseConfig();
    assertPackagingPolicy(true, fuseConfig);
    const built = await packager({ dir: app, out: join(work, 'packed'), name: 'MetaViewer',
      executableName: 'metaviewer', platform: 'linux', arch: architecture.arch, electronVersion: ELECTRON_PIN,
      electronZipDir: zipDir, asar: true, prune: false, overwrite: false });
    if (built.length !== 1) throw new Error(`Expected exactly one linux-${architecture.arch} package`);
    await verifyBinary(join(built[0],'metaviewer'));
    await fs.cp(native,join(built[0],'resources/bin'),{recursive:true});
    await fs.cp(join(repo,'contracts/v0.2'),join(built[0],'resources/contracts/v0.2'),{recursive:true});
    await fs.copyFile(join(repo,'deps.lock'),join(built[0],'resources/deps.lock'));
    await fs.copyFile(join(ui,'kit.lock.json'),join(built[0],'resources/kit.lock.json'));
    await fs.writeFile(join(built[0],'INSTALL.md'), `# MetaViewer Linux ${architecture.arch}

Run ./metaviewer to start the production UI with its bundled real core.
Use --nested-depth=1 only for the separate display-only view.
Verify every delivered file from this directory with:
sha256sum -c ../${architecture.name}.sha256

The manifest pins the core, adapter, Electron, renderer and preload bytes.
resources/kit.lock.json records the build's verified UI kit pin;
resources/deps.lock records the external component pins.
Surface execution additionally requires the OpenSuperficies revision in
resources/deps.lock, supplied by the operator through MV_SRF_BIN_DIR.
The adapter is resources/bin/mv-daemon-adapter; its deployment requires
MV_CONTRACT_DIR pointing to resources/contracts/v0.2, MV_COMPONENT_COMMIT
from electron/package-pin.json inside app.asar, and the trusted session
registration/runtime environment documented by the adapter's existing ABI.
When MV_SRF_BIN_DIR is configured, main supervises the bundled adapter next to
the core; when absent, it starts core-only in a typed degraded state.
`);
    await applyFuses(join(built[0], 'metaviewer'), fuseConfig);
    await normalizePackageModes(built[0]);
    await verifyPackagedSecurity(built[0]);
    await publishStagedPackage(built[0], work, final);
    const product = await bundlePackage(final);
    console.log(JSON.stringify({ ...product, directory: final, manifest: `${final}.sha256`,
      argv: [join(final, 'metaviewer')], wmClassExpected: ['metaviewer', 'metaviewer'] }));
    return final;
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] === '--verify'
    ? verifyPackagedSecurity(process.argv[3]) : process.argv[2] === '--verify-install'
    ? verifyInstall(process.argv[3]) : process.argv[2] === '--smoke'
    ? cleanInstallSmoke(process.argv[3]).then(result => console.log(JSON.stringify(result))) : packageShell();
  action.catch(error => { console.error(error.message); process.exitCode = 1; });
}
