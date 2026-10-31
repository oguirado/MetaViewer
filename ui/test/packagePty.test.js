import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createPackage } from '@electron/asar';
import { buildFuseConfig } from '../electron/main.js';
import { resolveNodePtyDir } from '../electron/ptyBroker.js';
import {
  MAX_GLIBC_VERSION,
  MAX_GLIBCXX_VERSION,
  PACKAGED_NODE_PTY_ADDON,
  PACKAGED_NODE_PTY_DIR,
  PACKAGED_NODE_PTY_FILES,
  PACKAGED_NODE_PTY_REQUIRED,
  applyFuses,
  compareVersionTuples,
  normalizePackageModes,
  parseElfSymbolVersions,
  parseVersionTuple,
  sealRendererAssets,
  stageElectronModules,
  stageNodePty,
  verifyInstall,
  verifyNativeAddon,
  verifyPackagedSecurity,
  verifyStagedNodePty,
  writeManifest,
} from '../tools/package.js';

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const realNodePtyRoot = join(uiRoot, 'node_modules/node-pty');
const realAddonPath = join(realNodePtyRoot, PACKAGED_NODE_PTY_ADDON);
const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');

/**
 * Builds a minimal valid 64-bit little-endian ELF shared object (ET_DYN) with
 * SHT_STRTAB (.dynstr) and SHT_GNU_verneed (.gnu.version_r) section headers.
 * @param {{
 *   machine?: number,
 *   elfClass?: number,
 *   endian?: number,
 *   elfType?: number,
 *   magic?: Buffer,
 *   glibcVersions?: string[],
 *   glibcxxVersions?: string[],
 *   corruptShoff?: boolean,
 * }} [opts]
 */
function buildSyntheticPtyElf(opts = {}) {
  const machine = opts.machine ?? 183;
  const elfClass = opts.elfClass ?? 2;
  const endian = opts.endian ?? 1;
  const elfType = opts.elfType ?? 3;
  const magic = opts.magic ?? Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  const glibcVersions = opts.glibcVersions ?? ['2.17', '2.34'];
  const glibcxxVersions = opts.glibcxxVersions ?? ['3.4', '3.4.22'];

  // Build .dynstr table: index 0 is NUL, followed by library names and version strings.
  /** @type {string[]} */
  const strings = [
    '',
    'libc.so.6',
    'libstdc++.so.6',
    ...glibcVersions.map(v => `GLIBC_${v}`),
    ...glibcxxVersions.map(v => `GLIBCXX_${v}`),
  ];
  /** @type {Map<string, number>} */
  const strOffsets = new Map();
  const strChunks = [];
  let currentOffset = 0;
  for (const s of strings) {
    strOffsets.set(s, currentOffset);
    const buf = Buffer.from(`${s}\0`, 'utf8');
    strChunks.push(buf);
    currentOffset += buf.length;
  }
  const dynstr = Buffer.concat(strChunks);

  // Build .gnu.version_r (SHT_GNU_verneed):Verneed (16 bytes) + Vernaux (16 bytes each)
  /** @type {Buffer[]} */
  const verneedChunks = [];
  const families = [
    { file: 'libc.so.6', tags: glibcVersions.map(v => `GLIBC_${v}`) },
    { file: 'libstdc++.so.6', tags: glibcxxVersions.map(v => `GLIBCXX_${v}`) },
  ].filter(f => f.tags.length > 0);

  for (let fIdx = 0; fIdx < families.length; fIdx++) {
    const fam = families[fIdx];
    const vnSize = 16 + fam.tags.length * 16;
    const vn = Buffer.alloc(16);
    vn.writeUInt16LE(1, 0); // vn_version
    vn.writeUInt16LE(fam.tags.length, 2); // vn_cnt
    vn.writeUInt32LE(strOffsets.get(fam.file) ?? 0, 4); // vn_file
    vn.writeUInt32LE(16, 8); // vn_aux
    vn.writeUInt32LE(fIdx + 1 < families.length ? vnSize : 0, 12); // vn_next
    verneedChunks.push(vn);
    for (let tIdx = 0; tIdx < fam.tags.length; tIdx++) {
      const vna = Buffer.alloc(16);
      vna.writeUInt32LE(0, 0); // vna_hash
      vna.writeUInt16LE(0, 4); // vna_flags
      vna.writeUInt16LE(tIdx + 2, 6); // vna_other
      vna.writeUInt32LE(strOffsets.get(fam.tags[tIdx]) ?? 0, 8); // vna_name
      vna.writeUInt32LE(tIdx + 1 < fam.tags.length ? 16 : 0, 12); // vna_next
      verneedChunks.push(vna);
    }
  }
  const verneed = Buffer.concat(verneedChunks);

  const ehdrSize = 64;
  const dynstrOff = ehdrSize;
  const verneedOff = dynstrOff + dynstr.length;
  const shoff = verneedOff + verneed.length;
  const shentsize = 64;
  const shnum = 3; // [0] NULL, [1] .dynstr, [2] .gnu.version_r

  const ehdr = Buffer.alloc(ehdrSize);
  magic.copy(ehdr, 0, 0, 4);
  ehdr[4] = elfClass;
  ehdr[5] = endian;
  ehdr[6] = 1; // EV_CURRENT
  ehdr.writeUInt16LE(elfType, 16);
  ehdr.writeUInt16LE(machine, 18);
  ehdr.writeUInt32LE(1, 20);
  ehdr.writeBigUInt64LE(BigInt(opts.corruptShoff ? shoff + 4096 : shoff), 40);
  ehdr.writeUInt16LE(ehdrSize, 52);
  ehdr.writeUInt16LE(shentsize, 58);
  ehdr.writeUInt16LE(shnum, 60);

  const shNull = Buffer.alloc(shentsize);
  const shDynstr = Buffer.alloc(shentsize);
  shDynstr.writeUInt32LE(3, 4); // SHT_STRTAB
  shDynstr.writeBigUInt64LE(BigInt(dynstrOff), 24);
  shDynstr.writeBigUInt64LE(BigInt(dynstr.length), 32);

  const shVerneed = Buffer.alloc(shentsize);
  shVerneed.writeUInt32LE(0x6ffffffe, 4); // SHT_GNU_verneed
  shVerneed.writeBigUInt64LE(BigInt(verneedOff), 24);
  shVerneed.writeBigUInt64LE(BigInt(verneed.length), 32);
  shVerneed.writeUInt32LE(1, 40); // sh_link -> section 1 (.dynstr)

  return Buffer.concat([ehdr, dynstr, verneed, shNull, shDynstr, shVerneed]);
}

function buildExecutableElf(machine = 183, withFuses = false) {
  const header = Buffer.alloc(64);
  header.write('\x7fELF', 0, 'binary');
  header[4] = 2;
  header[5] = 1;
  header[6] = 1;
  header.writeUInt16LE(2, 16);
  header.writeUInt16LE(machine, 18);
  if (!withFuses) return header;
  return Buffer.concat([header, sentinel, Buffer.from([1, 9]), Buffer.from('101100011')]);
}

async function resolveLocalElectronBinary(scratch) {
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    const binary = join(process.env.ELECTRON_OVERRIDE_DIST_PATH, 'electron');
    await access(binary, constants.X_OK);
    return binary;
  }
  const installed = fileURLToPath(new URL('../node_modules/electron/dist/electron', import.meta.url));
  try {
    await access(installed, constants.X_OK);
    return installed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const pkg = JSON.parse(await readFile(new URL('../node_modules/electron/package.json', import.meta.url), 'utf8'));
  const checksums = JSON.parse(await readFile(new URL('../node_modules/electron/checksums.json', import.meta.url), 'utf8'));
  const name = `electron-v${pkg.version}-${process.platform}-${process.arch}.zip`;
  const cache = process.env.electron_config_cache || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'electron');
  for (const entry of await readdir(cache, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const archive = join(cache, entry.name, name);
    try {
      await access(archive);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(archive)) hash.update(bytes);
    assert.equal(hash.digest('hex'), checksums[name], 'Cached Electron checksum mismatch');
    const dist = join(scratch, 'electron-dist');
    await mkdir(dist, { recursive: true });
    const unpack = spawnSync('unzip', ['-q', archive, '-d', dist], { encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.error?.message || unpack.stderr);
    const binary = join(dist, 'electron');
    await access(binary, constants.X_OK);
    return binary;
  }
  throw new Error(`Local ${name} required; set ELECTRON_OVERRIDE_DIST_PATH (no downloads)`);
}

test('U1-PTY-PKG Guard 1: stageNodePty stages node-pty outside app.asar under resources/build-native/pty-runtime/node-pty and seals SHA-256 inventory', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mv-pty-pkg-stage-'));
  try {
    const resources = join(scratch, 'resources');
    await mkdir(resources, { recursive: true });
    const staged = await stageNodePty(resources, { arch: 'arm64' });

    assert.equal(staged.target, join(resources, 'build-native/pty-runtime/node-pty'));
    assert.equal(resolveNodePtyDir({}, resources), staged.target);
    assert.equal(staged.arch, 'arm64');
    assert.equal(staged.addon.machine, 183);
    assert.match(staged.addon.sha256, /^[0-9a-f]{64}$/);
    assert.ok(compareVersionTuples(staged.addon.maxGlibc, MAX_GLIBC_VERSION) <= 0);
    assert.ok(compareVersionTuples(staged.addon.maxGlibcxx, MAX_GLIBCXX_VERSION) <= 0);

    for (const req of PACKAGED_NODE_PTY_REQUIRED) {
      assert.match(staged.files[req] ?? '', /^[0-9a-f]{64}$/, `missing digest for ${req}`);
    }
    for (const relPath of Object.keys(staged.files)) {
      assert.doesNotMatch(relPath, /(?:\.test\.js|\.map|\.d\.ts)$/, `excluded artifact leaked: ${relPath}`);
      assert.doesNotMatch(relPath, /(?:^|\/)testUtils\./, `testUtils leaked: ${relPath}`);
    }

    // Mutant 1a: Tampering with 1 byte of a staged file breaks verifyStagedNodePty against sealed expectedFiles.
    const indexJs = join(staged.target, 'lib/index.js');
    const originalIndex = await readFile(indexJs);
    await writeFile(indexJs, Buffer.concat([originalIndex, Buffer.from('\n// mutant\n')]));
    await assert.rejects(
      verifyStagedNodePty(resources, { arch: 'arm64', expectedFiles: staged.files }),
      (/** @type {any} */ err) => err.code === 'PKG_MANIFEST_MISMATCH' && /lib\/index\.js/.test(err.message),
    );
    await writeFile(indexJs, originalIndex);

    // Mutant 1b: Deleting a required file breaks verifyStagedNodePty with PKG_NATIVE_MISSING.
    const licenseFile = join(staged.target, 'LICENSE');
    const originalLicense = await readFile(licenseFile);
    await unlink(licenseFile);
    await assert.rejects(
      verifyStagedNodePty(resources, { arch: 'arm64', expectedFiles: staged.files }),
      (/** @type {any} */ err) => err.code === 'PKG_NATIVE_MISSING' && /LICENSE/.test(err.message),
    );
    await writeFile(licenseFile, originalLicense);

    // Mutant 1c: Dropping a forbidden .d.ts or .test.js into staged lib/ breaks verifyStagedNodePty.
    const leakedDts = join(staged.target, 'lib/leaked.d.ts');
    await writeFile(leakedDts, 'export {};\n');
    await assert.rejects(
      verifyStagedNodePty(resources, { arch: 'arm64' }),
      (/** @type {any} */ err) => err.code === 'PKG_ENTRY_INVALID' && /leaked\.d\.ts/.test(err.message),
    );
    await unlink(leakedDts);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('U1-PTY-PKG Guard 2: ELF64 header, class, endianness, type, and mode-0644 (non-+x) validation + mutants', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mv-pty-pkg-elf-'));
  try {
    // Valid 0644 (non-executable mode) arm64 ELF64 shared object passes verifyNativeAddon.
    const validAddon = join(scratch, 'pty.node');
    await writeFile(validAddon, buildSyntheticPtyElf({ machine: 183 }));
    await chmod(validAddon, 0o644);
    const verified = await verifyNativeAddon(validAddon, 'arm64');
    assert.equal(verified.machine, 183);
    assert.equal(verified.maxGlibc, '2.34');
    assert.equal(verified.maxGlibcxx, '3.4.22');

    // Mutant 2a: Non-ELF magic is rejected with PKG_ELF_INVALID.
    const badMagic = join(scratch, 'bad-magic.node');
    await writeFile(badMagic, buildSyntheticPtyElf({ magic: Buffer.from('NOPE') }));
    await assert.rejects(
      verifyNativeAddon(badMagic, 'arm64'),
      (/** @type {any} */ err) => err.code === 'PKG_ELF_INVALID' && err.reason === 'TERMINAL_UNAVAILABLE',
    );

    // Mutant 2b: 32-bit ELF (EI_CLASS = 1) is rejected with PKG_ELF_INVALID.
    const elf32 = join(scratch, 'elf32.node');
    await writeFile(elf32, buildSyntheticPtyElf({ elfClass: 1 }));
    await assert.rejects(
      verifyNativeAddon(elf32, 'arm64'),
      (/** @type {any} */ err) => err.code === 'PKG_ELF_INVALID',
    );

    // Mutant 2c: Big-endian ELF (EI_DATA = 2) is rejected with PKG_ELF_INVALID.
    const bigEndian = join(scratch, 'big-endian.node');
    await writeFile(bigEndian, buildSyntheticPtyElf({ endian: 2 }));
    await assert.rejects(
      verifyNativeAddon(bigEndian, 'arm64'),
      (/** @type {any} */ err) => err.code === 'PKG_ELF_INVALID',
    );

    // Mutant 2d: Relocatable object (ET_REL = 1) instead of ET_DYN/ET_EXEC is rejected with PKG_ELF_INVALID.
    const etRel = join(scratch, 'et-rel.node');
    await writeFile(etRel, buildSyntheticPtyElf({ elfType: 1 }));
    await assert.rejects(
      verifyNativeAddon(etRel, 'arm64'),
      (/** @type {any} */ err) => err.code === 'PKG_ELF_INVALID' && err.elfType === 1,
    );

    // Mutant 2e: Corrupt section header offset is rejected with PKG_ELF_INVALID.
    const corruptSh = join(scratch, 'corrupt-sh.node');
    await writeFile(corruptSh, buildSyntheticPtyElf({ corruptShoff: true }));
    await assert.rejects(
      verifyNativeAddon(corruptSh, 'arm64'),
      (/** @type {any} */ err) => err.code === 'PKG_ELF_INVALID',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('U1-PTY-PKG Guard 3: typed refusal when prebuilt/addon does not match target architecture (x64 vs arm64) + mutants', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mv-pty-pkg-arch-'));
  try {
    // Real installed node-pty addon is arm64 (e_machine = 183). Requesting x64 (e_machine = 62)
    // must return a typed refusal carrying code PKG_ARCH_MISMATCH and reason TERMINAL_UNAVAILABLE.
    await assert.rejects(
      verifyNativeAddon(realAddonPath, 'x64'),
      (/** @type {any} */ err) => {
        assert.equal(err.code, 'PKG_ARCH_MISMATCH');
        assert.equal(err.reason, 'TERMINAL_UNAVAILABLE');
        assert.equal(err.targetArch, 'x64');
        assert.equal(err.expectedMachine, 62);
        assert.equal(err.actualMachine, 183);
        assert.match(err.message, /PKG_ARCH_MISMATCH:.*TERMINAL_UNAVAILABLE/);
        return true;
      },
    );

    // Staging for x64 against the arm64 prebuilt fails closed before creating the staged runtime directory.
    const resources = join(scratch, 'resources');
    await mkdir(resources, { recursive: true });
    await assert.rejects(
      stageNodePty(resources, { arch: 'x64' }),
      (/** @type {any} */ err) =>
        err.code === 'PKG_ARCH_MISMATCH' &&
        err.reason === 'TERMINAL_UNAVAILABLE' &&
        err.targetArch === 'x64' &&
        err.expectedMachine === 62 &&
        err.actualMachine === 183,
    );
    await assert.rejects(access(join(resources, PACKAGED_NODE_PTY_DIR)));

    // Synthetic x64 addon (e_machine = 62) is accepted when arch === 'x64', and refused when arch === 'arm64' (mutant).
    const x64Addon = join(scratch, 'pty-x64.node');
    await writeFile(x64Addon, buildSyntheticPtyElf({ machine: 62 }));
    const x64Verified = await verifyNativeAddon(x64Addon, 'x64');
    assert.equal(x64Verified.machine, 62);
    assert.equal(x64Verified.arch, 'x64');

    // Mutant 3b: Passing x64 addon to arm64 target is refused with PKG_ARCH_MISMATCH.
    await assert.rejects(
      verifyNativeAddon(x64Addon, 'arm64'),
      (/** @type {any} */ err) =>
        err.code === 'PKG_ARCH_MISMATCH' &&
        err.reason === 'TERMINAL_UNAVAILABLE' &&
        err.expectedMachine === 183 &&
        err.actualMachine === 62,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('U1-PTY-PKG Guard 4: GLIBC <= 2.34 and GLIBCXX <= 3.4.22 symbol version gate + numeric tuple ordering + mutants', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mv-pty-pkg-abi-'));
  try {
    // Numeric tuple comparison must order 2.9 < 2.34 and 3.4.9 < 3.4.22 (unlike lexicographic compare).
    assert.deepEqual(parseVersionTuple('3.4.22'), [3, 4, 22]);
    assert.equal(compareVersionTuples('2.9', '2.34'), -1);
    assert.equal(compareVersionTuples('2.34', '2.34'), 0);
    assert.equal(compareVersionTuples('2.35', '2.34'), 1);
    assert.equal(compareVersionTuples('3.4.9', '3.4.22'), -1);
    assert.equal(compareVersionTuples('3.4.22', '3.4.22'), 0);
    assert.equal(compareVersionTuples('3.4.23', '3.4.22'), 1);

    // Real pty.node on host satisfies GLIBC <= 2.34 and GLIBCXX <= 3.4.22.
    const realBytes = await readFile(realAddonPath);
    const realAbi = parseElfSymbolVersions(realBytes, 'pty.node');
    assert.ok(realAbi.glibcVersions.includes('2.34'));
    assert.ok(realAbi.glibcxxVersions.includes('3.4.22'));
    assert.equal(realAbi.maxGlibc, '2.34');
    assert.equal(realAbi.maxGlibcxx, '3.4.22');

    // Boundary pass: GLIBC_2.9 + GLIBC_2.34 and GLIBCXX_3.4.9 + GLIBCXX_3.4.22 pass.
    const boundaryOk = join(scratch, 'boundary-ok.node');
    await writeFile(
      boundaryOk,
      buildSyntheticPtyElf({
        machine: 183,
        glibcVersions: ['2.9', '2.17', '2.34'],
        glibcxxVersions: ['3.4', '3.4.9', '3.4.22'],
      }),
    );
    const okRes = await verifyNativeAddon(boundaryOk, 'arm64');
    assert.equal(okRes.maxGlibc, '2.34');
    assert.equal(okRes.maxGlibcxx, '3.4.22');

    // Mutant 4a: GLIBC_2.35 (> 2.34) is refused with PKG_GLIBC_VERSION_FORBIDDEN.
    const glibcTooNew = join(scratch, 'glibc-235.node');
    await writeFile(
      glibcTooNew,
      buildSyntheticPtyElf({
        machine: 183,
        glibcVersions: ['2.17', '2.34', '2.35'],
        glibcxxVersions: ['3.4', '3.4.22'],
      }),
    );
    await assert.rejects(
      verifyNativeAddon(glibcTooNew, 'arm64'),
      (/** @type {any} */ err) =>
        err.code === 'PKG_GLIBC_VERSION_FORBIDDEN' &&
        err.symbolFamily === 'GLIBC' &&
        err.foundVersion === '2.35' &&
        err.maxVersion === '2.34',
    );

    // Mutant 4b: GLIBCXX_3.4.23 (> 3.4.22) is refused with PKG_GLIBCXX_VERSION_FORBIDDEN.
    const glibcxxTooNew = join(scratch, 'glibcxx-3423.node');
    await writeFile(
      glibcxxTooNew,
      buildSyntheticPtyElf({
        machine: 183,
        glibcVersions: ['2.17', '2.34'],
        glibcxxVersions: ['3.4', '3.4.22', '3.4.23'],
      }),
    );
    await assert.rejects(
      verifyNativeAddon(glibcxxTooNew, 'arm64'),
      (/** @type {any} */ err) =>
        err.code === 'PKG_GLIBCXX_VERSION_FORBIDDEN' &&
        err.symbolFamily === 'GLIBCXX' &&
        err.foundVersion === '3.4.23' &&
        err.maxVersion === '3.4.22',
    );

    // Mutant 4c: Stripped/missing GLIBC or GLIBCXX version tags fail closed with PKG_ABI_UNREADABLE.
    const noAbi = join(scratch, 'no-abi.node');
    await writeFile(
      noAbi,
      buildSyntheticPtyElf({
        machine: 183,
        glibcVersions: [],
        glibcxxVersions: [],
      }),
    );
    await assert.rejects(
      verifyNativeAddon(noAbi, 'arm64'),
      (/** @type {any} */ err) => err.code === 'PKG_ABI_UNREADABLE',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('U1-PTY-PKG Guard 5: symlink and missing-file refusal across node-pty source and staged runtime + mutants', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mv-pty-pkg-symlink-'));
  try {
    const fakeRoot = join(scratch, 'node-pty-src');
    await mkdir(join(fakeRoot, 'build/Release'), { recursive: true });
    await mkdir(join(fakeRoot, 'lib'), { recursive: true });
    for (const file of PACKAGED_NODE_PTY_FILES) {
      await copyFile(join(realNodePtyRoot, file), join(fakeRoot, file));
    }
    await writeFile(join(fakeRoot, 'lib/index.js'), 'module.exports = {};\n');
    await writeFile(join(fakeRoot, 'lib/unixTerminal.js'), 'module.exports = {};\n');
    await copyFile(realAddonPath, join(fakeRoot, PACKAGED_NODE_PTY_ADDON));

    // Baseline fakeRoot stages cleanly.
    const resOk = join(scratch, 'res-ok');
    await mkdir(resOk, { recursive: true });
    await stageNodePty(resOk, { nodePtyRoot: fakeRoot, arch: 'arm64' });

    // Mutant 5a: Replacing pty.node with a symlink is refused with PKG_NATIVE_MISSING.
    const symlinkAddonRoot = join(scratch, 'node-pty-sym-addon');
    await mkdir(join(symlinkAddonRoot, 'build/Release'), { recursive: true });
    await symlink(realAddonPath, join(symlinkAddonRoot, PACKAGED_NODE_PTY_ADDON));
    await assert.rejects(
      verifyNativeAddon(join(symlinkAddonRoot, PACKAGED_NODE_PTY_ADDON), 'arm64'),
      (/** @type {any} */ err) => err.code === 'PKG_NATIVE_MISSING' && err.reason === 'TERMINAL_UNAVAILABLE',
    );

    // Mutant 5b: Symlink inside lib/ during stageNodePty is refused with PKG_ALIAS_FORBIDDEN.
    await symlink(join(fakeRoot, 'lib/index.js'), join(fakeRoot, 'lib/alias.js'));
    const resSym = join(scratch, 'res-sym');
    await mkdir(resSym, { recursive: true });
    await assert.rejects(
      stageNodePty(resSym, { nodePtyRoot: fakeRoot, arch: 'arm64' }),
      (/** @type {any} */ err) => err.code === 'PKG_ALIAS_FORBIDDEN',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('U1-PTY-PKG Guard 6: writeManifest and verifyInstall seal resources/build-native/pty-runtime/node-pty and verifyPackagedSecurity admits it outside app.asar + mutants', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mv-pty-pkg-install-'));
  try {
    const root = join(scratch, 'MetaViewer-linux-arm64');
    const appSource = join(scratch, 'app-src');
    await mkdir(join(appSource, 'dist/renderer'), { recursive: true });
    await mkdir(join(appSource, 'dist/preload'), { recursive: true });
    await mkdir(join(appSource, 'electron'), { recursive: true });
    await writeFile(join(appSource, 'dist/renderer/index.html'), '<!doctype html><title>MV</title>');
    await writeFile(join(appSource, 'dist/preload/preload.cjs'), 'preload');
    await writeFile(join(appSource, 'electron/nesting.js'), 'entry');
    for (const name of ['main.js', 'coreLauncher.js']) {
      await copyFile(new URL(`../electron/${name}`, import.meta.url), join(appSource, 'electron', name));
    }
    await sealRendererAssets(appSource);
    await writeFile(join(appSource, 'package.json'), JSON.stringify({ name: 'metaviewer', main: 'electron/nesting.js' }));

    await mkdir(join(root, 'resources/bin'), { recursive: true });
    await writeFile(join(root, 'metaviewer'), buildExecutableElf(183, true), { mode: 0o755 });
    await applyFuses(join(root, 'metaviewer'), buildFuseConfig());
    for (const bin of ['resources/bin/metaviewer-core', 'resources/bin/mv-daemon-adapter']) {
      await writeFile(join(root, bin), buildExecutableElf(183, false), { mode: 0o755 });
    }
    await createPackage(appSource, join(root, 'resources/app.asar'));

    // Stage node-pty outside app.asar under resources/build-native/pty-runtime/node-pty.
    const staged = await stageNodePty(join(root, 'resources'), { arch: 'arm64' });
    await normalizePackageModes(root);
    await writeManifest(root, `${root}.sha256`);

    // Manifest seals every staged node-pty file under resources/build-native/pty-runtime/node-pty/.
    const manifestText = await readFile(`${root}.sha256`, 'utf8');
    assert.match(
      manifestText,
      new RegExp(`${staged.addon.sha256} .*resources/build-native/pty-runtime/node-pty/build/Release/pty\\.node`),
    );

    // Both verifyPackagedSecurity and verifyInstall pass on the sealed package.
    await verifyPackagedSecurity(root);
    await verifyInstall(root, 'arm64');

    // Mutant 6a: Verify verifyInstall refuses x64 architecture against the arm64 staged pty.node.
    // Replace the 3 main binaries with x64 ELF headers so verifyBinary passes for x64 and verifyStagedNodePty catches pty.node.
    const origBin = await readFile(join(root, 'metaviewer'));
    const origCore = await readFile(join(root, 'resources/bin/metaviewer-core'));
    const origAdapter = await readFile(join(root, 'resources/bin/mv-daemon-adapter'));
    await writeFile(join(root, 'metaviewer'), buildExecutableElf(62, true), { mode: 0o755 });
    await applyFuses(join(root, 'metaviewer'), buildFuseConfig());
    await writeFile(join(root, 'resources/bin/metaviewer-core'), buildExecutableElf(62, false), { mode: 0o755 });
    await writeFile(join(root, 'resources/bin/mv-daemon-adapter'), buildExecutableElf(62, false), { mode: 0o755 });
    await assert.rejects(
      verifyInstall(root, 'x64'),
      (/** @type {any} */ err) => err.code === 'PKG_ARCH_MISMATCH' && err.reason === 'TERMINAL_UNAVAILABLE',
    );
    await writeFile(join(root, 'metaviewer'), origBin, { mode: 0o755 });
    await writeFile(join(root, 'resources/bin/metaviewer-core'), origCore, { mode: 0o755 });
    await writeFile(join(root, 'resources/bin/mv-daemon-adapter'), origAdapter, { mode: 0o755 });

    // Mutant 6b: Tampering with staged pty.node bytes after writeManifest fails verifyInstall with PKG_MANIFEST_MISMATCH.
    const stagedAddonPath = join(root, 'resources', PACKAGED_NODE_PTY_DIR, PACKAGED_NODE_PTY_ADDON);
    const pristineAddon = await readFile(stagedAddonPath);
    await writeFile(stagedAddonPath, buildSyntheticPtyElf({ machine: 183, glibcVersions: ['2.17'] }), { mode: 0o644 });
    await assert.rejects(verifyInstall(root, 'arm64'), /PKG_MANIFEST_MISMATCH/);
    await writeFile(stagedAddonPath, pristineAddon, { mode: 0o644 });
    await verifyInstall(root, 'arm64');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('U1-PTY-PKG L-LIVE: packaged app.asar + resources/build-native/pty-runtime/node-pty spawns a live PTY under Electron / xvfb and refuses missing or mismatched runtime', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mv-pty-pkg-live-'));
  try {
    const electronBinary = await resolveLocalElectronBinary(scratch);
    const appDir = join(scratch, 'app');
    const resourcesDir = join(scratch, 'resources');
    const hostRuntime = join(scratch, 'runtime');
    await mkdir(join(appDir, 'electron'), { recursive: true });
    await mkdir(resourcesDir, { recursive: true });
    await mkdir(hostRuntime, { mode: 0o700, recursive: true });

    // Stage all electron main-process modules into the ASAR so ptyBroker.js and its transitive imports resolve.
    await stageElectronModules(appDir);
    await writeFile(
      join(appDir, 'package.json'),
      JSON.stringify({ name: 'mv-pty-live-smoke', version: '0.0.0', type: 'module', main: 'electron/liveProbe.js' }),
    );
    await writeFile(
      join(appDir, 'electron/liveProbe.js'),
      `import { app, dialog } from 'electron';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { resolveNodePtyDir } from './ptyBroker.js';

dialog.showErrorBox = () => {};
const resourcesDir = process.env.MV_TEST_RESOURCES_DIR;
const mode = process.env.MV_TEST_MODE || 'live';

app.whenReady().then(async () => {
  try {
    const nodePtyDir = resolveNodePtyDir({}, resourcesDir);
    if (!nodePtyDir || nodePtyDir !== join(resourcesDir, 'build-native', 'pty-runtime', 'node-pty')) {
      console.log(JSON.stringify({ ok: false, reason: 'TERMINAL_UNAVAILABLE', nodePtyDir }));
      app.exit(mode === 'missing' ? 0 : 2);
      return;
    }
    const req = createRequire(import.meta.url);
    const nodePty = req(join(nodePtyDir, 'lib', 'index.js'));
    const term = nodePty.spawn('/bin/sh', ['-c', 'printf "LIVE_PACKAGED_PTY_OK:%s\\\\n" "$TERM"'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: resourcesDir,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    let output = '';
    term.onData(chunk => { output += chunk; });
    term.onExit(({ exitCode }) => {
      console.log(JSON.stringify({ ok: exitCode === 0, exitCode, nodePtyDir, output }));
      app.exit(exitCode === 0 ? 0 : 3);
    });
  } catch (err) {
    console.log(JSON.stringify({ ok: false, reason: 'TERMINAL_UNAVAILABLE', error: String(err?.message || err) }));
    app.exit(mode === 'missing' ? 0 : 1);
  }
});
`,
    );

    const asarPath = join(resourcesDir, 'app.asar');
    await createPackage(appDir, asarPath);
    await stageNodePty(resourcesDir, { arch: 'arm64' });

    const hasXvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).status === 0;
    const runElectronProbe = (/** @type {string} */ targetResources, /** @type {string} */ mode) => {
      const env = {
        XDG_RUNTIME_DIR: hostRuntime,
        PATH: process.env.PATH,
        HOME: scratch,
        LANG: 'C.UTF-8',
        MV_TEST_RESOURCES_DIR: targetResources,
        MV_TEST_MODE: mode,
      };
      const args = [
        '--no-sandbox',
        '--disable-gpu',
        `--user-data-dir=${join(scratch, `profile-${mode}`)}`,
        asarPath,
      ];
      const cmd = hasXvfb ? 'xvfb-run' : electronBinary;
      const cmdArgs = hasXvfb ? ['-a', electronBinary, ...args] : args;
      return spawnSync(cmd, cmdArgs, { cwd: scratch, encoding: 'utf8', env, timeout: 25000 });
    };

    const live = runElectronProbe(resourcesDir, 'live');
    assert.equal(live.status, 0, live.stderr || live.stdout);
    const jsonLine = live.stdout
      .trim()
      .split('\n')
      .reverse()
      .find(line => line.startsWith('{') && line.endsWith('}'));
    assert.ok(jsonLine, `expected JSON output from live Electron probe, got: ${live.stdout}`);
    const parsed = JSON.parse(jsonLine);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.nodePtyDir, join(resourcesDir, 'build-native/pty-runtime/node-pty'));
    assert.match(parsed.output, /LIVE_PACKAGED_PTY_OK:xterm-256color/);

    // Negative control: empty resourcesDir without staged node-pty fails closed with TERMINAL_UNAVAILABLE.
    const emptyResources = join(scratch, 'empty-resources');
    await mkdir(emptyResources, { recursive: true });
    const refusal = runElectronProbe(emptyResources, 'missing');
    assert.equal(refusal.status, 0, refusal.stderr || refusal.stdout);
    const refusalLine = refusal.stdout
      .trim()
      .split('\n')
      .reverse()
      .find(line => line.startsWith('{') && line.endsWith('}'));
    assert.ok(refusalLine, `expected JSON refusal line, got: ${refusal.stdout}`);
    const refusalParsed = JSON.parse(refusalLine);
    assert.equal(refusalParsed.ok, false);
    assert.equal(refusalParsed.reason, 'TERMINAL_UNAVAILABLE');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
