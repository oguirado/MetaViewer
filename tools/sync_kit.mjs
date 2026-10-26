import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const metadata = 'KIT_SOURCE.json';
const excluded = new Set([metadata, 'node_modules', '.git']);
/** @typedef {{repo:string, commit:string, version:string, contentHash:string}} KitPin */

/** @param {string} filename */
async function json(filename) {
  if (!(await fs.lstat(filename)).isFile()) throw new Error('Expected regular JSON file');
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

/** @param {string} root @returns {Promise<string>} */
export async function kitDigest(root) {
  if (!(await fs.lstat(root)).isDirectory()) throw new Error('Expected kit directory');
  const hash = createHash('sha256');
  /** @param {string} relative */
  async function walk(relative) {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlink rejected: ${name}`);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(path.join(root, name));
        const key = Buffer.from(name);
        hash.update(`${key.length}:`).update(key).update(`${bytes.length}:`).update(bytes);
      } else throw new Error(`Unsupported entry: ${name}`);
    }
  }
  await walk('');
  return hash.digest('hex');
}

/** @param {string} root @param {KitPin} pin */
export async function verifyKit(root, pin) {
  const record = await json(path.join(root, metadata));
  const pkg = await json(path.join(root, 'package.json'));
  const contentHash = await kitDigest(root);
  if (record.schema !== 'capsule-ui-kit-source/v1' ||
      record.algorithm !== 'sha256-length-framed-tree' ||
      !['export', 'vendor'].includes(record.direction) ||
      pkg.name !== 'capsule-ui-kit' || pkg.version !== pin.version ||
      record.version !== pin.version || record.contentHash !== contentHash ||
      contentHash !== pin.contentHash) throw new Error('Kit metadata/pin/hash mismatch');
  return { version: pin.version, contentHash };
}

/** @param {string} filename */
async function statOrMissing(filename) {
  try { return await fs.lstat(filename); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    return undefined;
  }
}

/** @param {string} filename */
async function rejectSymlinkAncestors(filename) {
  let current = path.resolve(filename);
  while (true) {
    const stat = await statOrMissing(current);
    if (stat?.isSymbolicLink()) throw new Error('Destination ancestors must not be symlinks');
    if (stat && !stat.isDirectory()) throw new Error('Expected destination directory');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** @param {string} directory @param {string[]} args */
async function git(directory, args) {
  // Ignore inherited repository overrides so provenance belongs to the supplied checkout.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const { stdout } = await execute('git', ['-C', directory, ...args],
    { env, maxBuffer: 65536 });
  return stdout.trim();
}

/**
 * @param {{kitRepo:string, dest?:string, lockPath?:string, check?:boolean}} options
 * @returns {Promise<{version:string, contentHash:string, direction:string}>}
 */
export async function syncKit({ kitRepo, dest = path.join(project, 'ui/.kit/capsule-ui-kit'),
  lockPath = path.join(project, 'ui/kit.lock.json'), check = false }) {
  /** @type {KitPin} */
  const pin = await json(lockPath);
  if (Object.keys(pin).sort().join(',') !== 'commit,contentHash,repo,version' ||
      typeof pin.repo !== 'string' || !pin.repo || typeof pin.version !== 'string' ||
      !pin.version || !/^[0-9a-f]{40}$/.test(pin.commit) ||
      !/^[0-9a-f]{64}$/.test(pin.contentHash)) throw new Error('Invalid kit lock');
  const local = await fs.realpath(kitRepo);
  const repo = await fs.realpath(await git(local, ['rev-parse', '--show-toplevel']));
  const source = path.join(repo, 'packages/capsule-ui-kit');
  if (local !== repo && local !== source) throw new Error('Expected kit repo or package');
  if (await fs.realpath(source) !== source) throw new Error('Source ancestors must not be symlinks');
  /** @returns {Promise<void>} */
  async function identity() {
    if (await git(repo, ['rev-parse', 'HEAD']) !== pin.commit ||
        await git(repo, ['remote', 'get-url', 'origin']) !== pin.repo) {
      throw new Error('Kit repository/commit mismatch');
    }
  }
  await identity();
  dest = path.resolve(dest);
  await rejectSymlinkAncestors(dest);
  /** @param {string} a @param {string} b */
  const ancestor = (a, b) => a === b || b.startsWith(`${a}${path.sep}`);
  if (ancestor(repo, dest) || ancestor(dest, repo)) throw new Error('Source and destination overlap');
  const verified = await verifyKit(source, pin);
  if (check) {
    await verifyKit(dest, pin);
    await identity();
    return { ...verified, direction: 'vendor' };
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await rejectSymlinkAncestors(dest);
  const staging = await fs.mkdtemp(path.join(path.dirname(dest), '.kit-sync-'));
  let backup;
  try {
    await fs.cp(source, staging, { recursive: true,
      filter: filename => !excluded.has(path.basename(filename)) });
    const record = { schema: 'capsule-ui-kit-source/v1', ...verified,
      algorithm: 'sha256-length-framed-tree', direction: 'vendor' };
    await fs.writeFile(path.join(staging, metadata), `${JSON.stringify(record, null, 2)}\n`);
    await verifyKit(staging, pin);
    await verifyKit(source, pin);
    await identity();
    await rejectSymlinkAncestors(dest);
    if (await statOrMissing(dest)) {
      backup = `${staging}.previous`;
      await fs.rename(dest, backup);
    }
    try { await fs.rename(staging, dest); }
    catch (error) {
      if (backup) {
        try { await fs.rename(backup, dest); }
        catch { throw new Error(`Activation and restoration failed; preserved backup: ${backup}`); }
      }
      throw error;
    }
    if (backup) await fs.rm(backup, { recursive: true });
    return { ...verified, direction: 'vendor' };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const positional = args.filter(arg => arg !== '--check');
  const kitRepo = positional[0] || process.env.CAPSULE_UI_KIT_REPO;
  if (!kitRepo || positional.length > 1 || args.filter(arg => arg === '--check').length > 1 ||
      positional.some(arg => arg.startsWith('-'))) {
    console.error('ERROR: Usage: node tools/sync_kit.mjs [kit-repo] [--check] (or CAPSULE_UI_KIT_REPO)');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await syncKit({ kitRepo, check: args.includes('--check') }))); }
    catch (error) {
      console.error(`ERROR: ${/** @type {Error} */ (error).message}`);
      process.exitCode = 1;
    }
  }
}
