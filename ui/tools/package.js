// @ts-check
// [TARGET, unit decision] Isolated staging and a display-only package entry.
// Local archives are mandatory; packager never reaches its download branch.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildFuseConfig, FUSE_TABLE } from '../electron/main.js';
import { extractFile, listPackage, statFile, uncache } from '@electron/asar';
import { syncKit } from '../../tools/sync_kit.mjs';

const execute = promisify(execFile);
const ui = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(ui, '..');
const archive = 'electron-v44.9.2-linux-arm64.zip';

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

/** @param {string} root @param {string} destination */
export async function writeManifest(root, destination) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} part */
  async function walk(part) {
    for (const item of await fs.readdir(join(root, part), { withFileTypes: true })) {
      const name = part ? `${part}/${item.name}` : item.name;
      if (/[\r\n\\]/.test(name)) throw new Error('Unsupported manifest filename');
      if (item.isSymbolicLink()) throw new Error(`Symlink refused: ${name}`);
      if (item.isDirectory()) await walk(name);
      else if (item.isFile()) files.push(name);
      else throw new Error(`Unsupported package entry: ${name}`);
    }
  }
  await walk('');
  const lines = [];
  for (const name of files.sort()) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(join(root, name))) hash.update(bytes);
    lines.push(`${hash.digest('hex')}  ${name}\n`);
  }
  await fs.writeFile(destination, lines.join(''), { flag: 'wx' });
}

// [TARGET, unit decision] Pinned Linux fuse-wire writer: the sentinel, version,
// count and byte states are checked against the local Electron artifact. Unknown
// wire layouts fail closed. No runtime dependency or downloaded fuse helper.
const ASSET_SEAL_PREFIX = 'const PACKAGED_ASSET_DIGESTS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze(';
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');

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
  let assets = 0;
  // The immutable ASAR namespace must not contain aliases or unpacked files.
  for (const name of listPackage(archivePath, {})) {
    const entry = statFile(archivePath, name.replace(/^\//, ''), false);
    if ('link' in entry || ('unpacked' in entry && entry.unpacked)) throw new Error('ASAR alias/unpacked entry refused');
    const prefix = '/dist/renderer/';
    if (name.startsWith(prefix) && 'size' in entry) {
      const relativeName = name.slice(prefix.length);
      const digest = createHash('sha256').update(extractFile(archivePath, name.slice(1))).digest('hex');
      if (hashes[relativeName] !== digest) throw new Error(`ASAR asset mismatch: ${relativeName}`);
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

/** Seal the bytes that the already-loaded main module may serve from ASAR.
 * @param {string} app */
export async function sealRendererAssets(app) {
  /** @type {Record<string, string>} */
  const hashes = {};
  const renderer = join(app, 'dist/renderer');
  /** @param {string} part */
  async function walk(part) {
    for (const entry of await fs.readdir(join(renderer, part), {withFileTypes: true})) {
      const name = part ? `${part}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Renderer alias refused');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) hashes[name] = createHash('sha256').update(await fs.readFile(join(renderer, name))).digest('hex');
      else throw new Error('Renderer entry refused');
    }
  }
  await walk('');
  const mainPath = join(app, 'electron/main.js');
  const source = await fs.readFile(mainPath, 'utf8');
  const marker = `${ASSET_SEAL_PREFIX}{}));`;
  if (source.split(marker).length !== 2) throw new Error('ASAR seal marker mismatch');
  await fs.writeFile(mainPath, source.replace(marker,
    `const PACKAGED_ASSET_DIGESTS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze(${JSON.stringify(hashes)}));`));
}

/** @param {NodeJS.ProcessEnv} env */
export async function packageShell(env = process.env) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node >=24 required');
  const requested = validateOutput(env.MV_PKG_OUT, await fs.realpath(repo));
  await fs.mkdir(requested, { recursive: true });
  const output = validateOutput(await fs.realpath(requested), await fs.realpath(repo));
  if (!env.CAPSULE_UI_KIT_REPO) throw new Error('CAPSULE_UI_KIT_REPO is required');
  if (!env.MV_ELECTRON_ZIP_DIR && !env.ELECTRON_OVERRIDE_DIST_PATH) {
    throw new Error('Set MV_ELECTRON_ZIP_DIR or ELECTRON_OVERRIDE_DIST_PATH to a local Electron distribution');
  }
  const final = join(output, 'MetaViewer-linux-arm64');
  // Refuse replacement of a previously delivered artifact.
  const prior = await fs.readdir(output);
  if (prior.includes('MetaViewer-linux-arm64') || prior.includes('MetaViewer-linux-arm64.sha256')) {
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
    await sealRendererAssets(app);
    const pkg = JSON.parse(await fs.readFile(join(ui, 'package.json'), 'utf8'));
    await fs.writeFile(join(app, 'package.json'), JSON.stringify({ name: 'metaviewer',
      version: pkg.version, type: 'module', main: 'electron/nesting.js' }));
    let zipDir = env.MV_ELECTRON_ZIP_DIR;
    if (!zipDir) {
      const dist = await fs.realpath(/** @type {string} */ (env.ELECTRON_OVERRIDE_DIST_PATH));
      await fs.access(join(dist, 'electron'));
      zipDir = join(work, 'electron-zip');
      await fs.mkdir(zipDir);
      await execute('zip', ['-q', '-r', join(zipDir, archive), '.'], { cwd: dist });
    }
    await fs.access(join(zipDir, archive));
    const { packager } = await import('@electron/packager');
    const fuseConfig = buildFuseConfig();
    assertPackagingPolicy(true, fuseConfig);
    const built = await packager({ dir: app, out: join(work, 'packed'), name: 'MetaViewer',
      executableName: 'metaviewer', platform: 'linux', arch: 'arm64', electronVersion: '44.9.2',
      electronZipDir: zipDir, asar: true, prune: false, overwrite: false });
    if (built.length !== 1) throw new Error('Expected exactly one linux-arm64 package');
    await applyFuses(join(built[0], 'metaviewer'), fuseConfig);
    await verifyPackagedSecurity(built[0]);
    const stagedManifest = join(work, 'package.sha256');
    await writeManifest(built[0], stagedManifest);
    await fs.rename(built[0], final);
    await fs.rename(stagedManifest, `${final}.sha256`);
    console.log(JSON.stringify({ directory: final, manifest: `${final}.sha256`,
      argv: [join(final, 'metaviewer'), '--nested-depth=1'], wmClassExpected: ['metaviewer', 'metaviewer'] }));
    return final;
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] === '--verify'
    ? verifyPackagedSecurity(process.argv[3]) : packageShell();
  action.catch(error => { console.error(error.message); process.exitCode = 1; });
}
