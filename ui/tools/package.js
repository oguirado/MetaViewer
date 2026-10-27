// @ts-check
// [TARGET, unit decision] Deterministic Linux bundle with an owned real-core session.
// Local archives are mandatory; packager never reaches its download branch.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, basename, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildFuseConfig, FUSE_TABLE } from '../electron/main.js';
import { extractFile, listPackage, statFile, uncache } from '@electron/asar';
import { syncKit } from '../../tools/sync_kit.mjs';

const execute = promisify(execFile);
const ui = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(ui, '..');
/** @param {string} value */
export function packageArchitecture(value = process.arch) {
  if (value !== 'arm64' && value !== 'x64') throw new Error('PKG_ARCH_UNSUPPORTED');
  return { arch: value, machine: value === 'arm64' ? 183 : 62,
    name: `MetaViewer-linux-${value}`, archive: `electron-v44.9.2-linux-${value}.zip` };
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

// [TARGET, unit decision] The delivered entry owns a fresh real-core session.
// Adapter bytes are shipped and pinned; launching surfaces still requires the
// operator's pinned OpenSuperficies deployment (MV_SRF_BIN_DIR), never a stub.
const productionEntry = String.raw`
import { app } from 'electron';
import { mainDirectEntry, validateRetailLaunch } from './main.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const root = dirname(fileURLToPath(import.meta.url));
const retail = validateRetailLaunch(process.argv.slice(1), process.env);
if (!retail.ok) {console.error(retail.code + ': retail launch refused');app.exit(1);}
else if (process.argv.includes('--nested-depth=1')) {
  await import('./nested-display.js');
} else {
  const pin = JSON.parse(await fs.readFile(join(root, 'package-pin.json'), 'utf8'));
  const runtime = await fs.mkdtemp(join(tmpdir(), 'mv-pkg-'));
  await fs.chmod(runtime, 0o700);
  await fs.mkdir(join(runtime, 'metaviewer'), {mode:0o700});
  const registration = component => ({endpoint:{component,instance:component+'-'+randomUUID()},hello:{
    schema:'hello/v0.2',contract_version:'v0.2',component,component_version:pin.version,
    component_commit:pin.commit,dependencies:[]}});
  const config = {session_id:'pkg-'+randomUUID(),core:registration('core'),
    peers:['daemon','agent','ui'].map(registration)};
  const configPath = join(runtime, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config), {mode:0o600});
  process.env.XDG_RUNTIME_DIR = runtime;
  process.env.MV_CORE_CONFIG = configPath;
  delete process.env.MV_CORE_BOOTSTRAP;
  const env = {...process.env, XDG_STATE_HOME:join(runtime,'state')};
  const core = spawn(join(process.resourcesPath,'bin/metaviewer-core'), [], {env,stdio:['ignore','ignore','pipe']});
  let failure;
  core.on('error', error => {failure=error;});
  core.stderr.on('data', bytes => process.stderr.write(bytes));
  const stop = async () => {
    if (core.pid && core.exitCode === null && core.signalCode === null) {
      const exited = once(core,'exit'); core.kill('SIGKILL'); await exited;
    }
    await fs.rm(runtime,{recursive:true,force:true});
  };
  app.on('will-quit', () => {core.kill('SIGKILL');});
  process.on('exit', () => {core.kill('SIGKILL');});
  const deadline = Date.now()+10000;
  try {
    for (;;) {
      if (failure || core.exitCode !== null || Date.now()>deadline) throw new Error('PKG_CORE_START_FAILED');
      try {await fs.access(join(runtime,'metaviewer/core.sock'));break;} catch {}
      await new Promise(resolve => setTimeout(resolve,25));
    }
    if (process.env.MV_PACKAGE_SMOKE === '1') {
      const log = console.log;
      console.log = (...args) => {
        log(...args);
        if (args[0] === 'METAVIEWER_MAIN_READY') {
          void stop().then(() => {log('METAVIEWER_MAIN_SMOKE_OK');app.exit(0);}, error => {console.error(error);app.exit(1);});
        }
      };
    }
    void mainDirectEntry();
  } catch(error) {console.error(error);await stop();app.exit(1);}
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

/** Complete exact inventory: extras, aliases and omissions all fail closed.
 * @param {string} root */
export async function verifyInstall(root, arch = architecture.arch) {
  for (const name of ['metaviewer','resources/bin/metaviewer-core','resources/bin/mv-daemon-adapter']) await verifyBinary(join(root,name), arch);
  const manifest = await fs.readFile(`${root}.sha256`,'utf8');
  const expected = new Map();
  for (const line of manifest.trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match || match[2].split('/').some(part => !part || part === '.' || part === '..') || /[\\\r\n]/.test(match[2]) || expected.has(match[2]))
      throw new Error('PKG_MANIFEST_INVALID');
    expected.set(match[2],match[1]);
  }
  let count=0;
  async function walk(part) {
    for (const item of await fs.readdir(join(root,part),{withFileTypes:true})) {
      const name = part ? `${part}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw new Error('PKG_ALIAS_FORBIDDEN');
      if (item.isDirectory()) {await walk(name);continue;}
      if (!item.isFile()) throw new Error('PKG_ENTRY_INVALID');
      const file = await fs.open(join(root,name),'r');
      const prefix=Buffer.alloc(4);
      try {await file.read(prefix,0,4,0);} finally {await file.close();}
      rejectFont(name,prefix);
      if (expected.get(name) !== await digest(join(root,name))) throw new Error(`PKG_MANIFEST_MISMATCH: ${name}`);
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

/** @param {string} stdout */
export function assertSmokeOutput(stdout) {
  if (!stdout.split('\n').includes('METAVIEWER_MAIN_SMOKE_OK')) throw new Error('PKG_SMOKE_MARKER_MISSING');
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
    await execute('tar',['--no-same-owner','-xf',artifact,'-C',clean]);
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
    try {await fs.appendFile(notice,'tampered');await expectReason('PKG_MANIFEST_MISMATCH');}
    finally {await fs.writeFile(notice,original);}
    const font=join(installed,'planted.woff2');
    try {await fs.writeFile(font,'wOF2');await expectReason('PKG_FONT_FORBIDDEN');}
    finally {await fs.rm(font,{force:true});}
    const adapter=join(installed,'resources/bin/mv-daemon-adapter');
    await fs.rename(adapter,`${adapter}.control`);
    try {await expectReason('PKG_BINARY_MISSING: mv-daemon-adapter');}
    finally {await fs.rename(`${adapter}.control`,adapter);}
    await verifyInstall(installed);
    const trace=join(clean,'files.trace');
    const env={PATH:process.env.PATH,HOME:clean,LANG:'C.UTF-8',MV_PACKAGE_SMOKE:'1'};
    const result=await execute('xvfb-run',['-a','strace','-f','-e','trace=file','-o',trace,
      join(installed,'metaviewer'),`--user-data-dir=${join(clean,'profile')}`],{cwd:clean,env,timeout:30000,maxBuffer:1024*1024});
    assertSmokeOutput(result.stdout);
    const accesses=await fs.readFile(trace,'utf8');
    if (accesses.includes(repo) || accesses.includes(await fs.realpath(repo))) throw new Error('PKG_SOURCE_ACCESS');
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
      await fs.access(join(dist, 'electron'));
      if ((await fs.readFile(join(dist,'version'),'utf8')).trim().replace(/^v/,'') !== '44.9.2') throw new Error('PKG_ELECTRON_PIN');
      zipDir = join(work, 'electron-zip');
      await fs.mkdir(zipDir);
      await execute('zip', ['-q', '-r', join(zipDir, archive), '.'], { cwd: dist });
    }
    await fs.access(join(zipDir, archive));
    if (env.MV_ELECTRON_ZIP_DIR) {
      const checksums=JSON.parse(await fs.readFile(join(ui,'node_modules/electron/checksums.json'),'utf8'));
      if (!checksums[archive] || await digest(join(zipDir,archive)) !== checksums[archive]) throw new Error('PKG_ELECTRON_CHECKSUM');
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
      executableName: 'metaviewer', platform: 'linux', arch: architecture.arch, electronVersion: '44.9.2',
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
This package starts the core and UI; it does not automatically start the adapter
or create surfaces. The clean-install smoke proves real-core UI startup only.
`);
    await applyFuses(join(built[0], 'metaviewer'), fuseConfig);
    await verifyPackagedSecurity(built[0]);
    const stagedManifest = join(work, 'package.sha256');
    await writeManifest(built[0], stagedManifest);
    await fs.rename(built[0], final);
    await fs.rename(stagedManifest, `${final}.sha256`);
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
