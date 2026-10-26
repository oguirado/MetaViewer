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
    const built = await packager({ dir: app, out: join(work, 'packed'), name: 'MetaViewer',
      executableName: 'metaviewer', platform: 'linux', arch: 'arm64', electronVersion: '44.9.2',
      electronZipDir: zipDir, asar: false, prune: false, overwrite: false });
    if (built.length !== 1) throw new Error('Expected exactly one linux-arm64 package');
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
  packageShell().catch(error => { console.error(error.message); process.exitCode = 1; });
}
