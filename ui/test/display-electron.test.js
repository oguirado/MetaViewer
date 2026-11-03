// [TARGET, unit decision] Exercise the sealed retail ASAR, preload and renderer
// with the real App wall, production boot create and late spec-v1.1 ring; no capsule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extractAll, createPackage } from '@electron/asar';
import { packageShell, sealRendererAssets } from '../tools/package.js';

export const DISPLAY_ELECTRON_SOFTWARE_FLAGS = Object.freeze([
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--disable-dev-shm-usage',
]);

async function runArtifact(archive, dist) {
  // Retail launches start from an empty environment. Only host launch inputs
  // and the private harness artifact coordinate are admitted here.
  const env = Object.fromEntries(['HOME', 'USER', 'LANG', 'XAUTHORITY', 'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS', 'WAYLAND_DISPLAY'].filter(k => process.env[k] !== undefined)
    .map(k => [k, process.env[k]]));
  env.PATH = process.env.PATH ?? '';
  env.LANG ??= 'C.UTF-8';
  env.MV_DISPLAY_E2E_SHELL_ROOT = archive;
  const electronFlags = process.env.MV_DISPLAY_E2E_ELECTRON_FLAGS !== undefined
    ? process.env.MV_DISPLAY_E2E_ELECTRON_FLAGS.trim().split(/\s+/).filter(Boolean)
    : DISPLAY_ELECTRON_SOFTWARE_FLAGS;
  env.MV_DISPLAY_E2E_ELECTRON_FLAGS = electronFlags.join(' ');
  // OnlyLoadAppFromAsar forces the packaged executable into its owned-core
  // entry, ignoring a fake entry argument. The upstream pinned runtime loads
  // this test entry, which imports *all* production modules from sealed ASAR.
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1280x900x24', join(dist, 'electron'),
    ...electronFlags,
    fileURLToPath(new URL('./display-electron-main.mjs', import.meta.url))],
  { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = '';
  child.stdout.on('data', b => { output = (output + b).slice(-12000); });
  child.stderr.on('data', b => { output = (output + b).slice(-12000); });
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 25000);
  try {
    const rc = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    return { rc, output };
  } finally {
    clearTimeout(timer);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
}

// [TARGET, unit decision] This regression packages the real app.asar, so it needs the pinned kit checkout and the
// built core/adapter (CARGO_TARGET_DIR). The local integration gate provides both; the hosted js job has neither
// built binary, so there it is skipped with this reason and the packaged leg owns it.
const PACKAGED_PREREQS = (process.env.CAPSULE_UI_KIT_REPO || process.env.MV_KIT_CHECKOUT) && process.env.CARGO_TARGET_DIR;
const T=async(n,f)=>{const t=Date.now();try{return await f()}finally{console.log(`PHASE ${n} ${Date.now()-t}`)}};
test('packaged wall paints UnixNano DISPLAY generations after VERIFIED create; reverted guards fail', { timeout: 400000, skip: PACKAGED_PREREQS ? false : 'needs the pinned kit checkout and CARGO_TARGET_DIR with built core/adapter (packaged leg)' }, async () => {
  const dist = process.env.ELECTRON_OVERRIDE_DIST_PATH;
  assert.ok(dist, 'local Electron dist required');
  const root = await mkdtemp(join(tmpdir(), 'mv-display-packaged-Música-'));
  try {
    // Hosted CI stages the pinned kit as MV_KIT_CHECKOUT (js job); local gates use CAPSULE_UI_KIT_REPO.
    const kitRepo = process.env.CAPSULE_UI_KIT_REPO || process.env.MV_KIT_CHECKOUT;
    assert.ok(kitRepo, 'pinned capsule-ui-kit checkout required (CAPSULE_UI_KIT_REPO or MV_KIT_CHECKOUT)');
    const product = await T('packageShell',()=>packageShell({ ...process.env, CAPSULE_UI_KIT_REPO: kitRepo, MV_PKG_OUT: join(root, 'output') }));
    const archive = join(product, 'resources/app.asar');
    const nominal = await T('run archive',()=>runArtifact(archive, dist));
    assert.equal(nominal.rc, 0, nominal.output);
    assert.match(nominal.output, /METAVIEWER_RENDERER_READY/);
    assert.match(nominal.output, /METAVIEWER_SURFACE_CREATE_PENDING/);
    assert.doesNotMatch(nominal.output, /METAVIEWER_SURFACE_CREATE_DEGRADED/);
    assert.doesNotMatch(nominal.output, /Creation of StagingBuffer's SharedImage failed\./);
    assert.match(nominal.output, /DISPLAY_E2E_OK fps=(\d+)/);
    assert.equal((nominal.output.match(/METAVIEWER_DISPLAY_PORT /g) ?? []).length, 1, nominal.output);
    assert.equal((nominal.output.match(/METAVIEWER_DISPLAY_ACK /g) ?? []).length, 1, nominal.output);
    assert.match(nominal.output, /METAVIEWER_DISPLAY_ACK surface=display-e2e outcome=(PRESENTED|HIDDEN)/);
    for (const stage of ['PRELOAD_GOT_PORT','PRELOAD_FORWARDED','ROUTER_ATTACHED','FIRST_FRAME','FIRST_PAINT','VISIBILITY']) {
      assert.equal((nominal.output.match(new RegExp(`stage=${stage} `,'g')) ?? []).length, 1, nominal.output);
    }
    assert.match(nominal.output, /stage=VISIBILITY detail=VISIBLE/);
    console.log(nominal.output.match(/METAVIEWER_DISPLAY_STAGE[^\n]+/g).join('\n'));
    console.log(nominal.output.match(/DISPLAY_E2E_OK fps=\d+/)[0]);

    // Revert only the fix in an isolated artifact, then reseal it. Security
    // checks still pass: failure must be missing DISPLAY, not broken integrity.
    const mutantRoot = join(root, 'mutant');
    extractAll(archive, mutantRoot);
    const mainPath = join(mutantRoot, 'electron/displayReader.js');
    const source = await readFile(mainPath, 'utf8');
    const mutant = source.replace('    const entry = entries.get(surfaceId);\n    if (!enabled || disposed || !entry || !rendererSubscribed) return false;', '    return false; // mutant: restore one-shot offers\n    const entry = entries.get(surfaceId);\n    if (!enabled || disposed || !entry || !rendererSubscribed) return false;');
    assert.notEqual(mutant, source);
    await writeFile(mainPath, mutant);
    await sealRendererAssets(mutantRoot);
    const mutantArchive = join(root, 'mutant.asar');
    await createPackage(mutantRoot, mutantArchive);
    const negative = await T('run mutantArchive',()=>runArtifact(mutantArchive, dist));
    assert.equal(negative.rc, 1, negative.output);
    assert.match(negative.output, /DISPLAY chip\/paint fps=0/);
    assert.doesNotMatch(negative.output, /DISPLAY_E2E_OK/);
    console.log('DISPLAY_PACKAGED_MUTANT_REJECTED');

    await writeFile(mainPath, source);
    // Real Go generations are uint64 UnixNano identities, not small counters.
    // Reverting the wire conversion must reproduce the conductor's TIMEOUT.
    const rounded = source.replace('generation: String(h1.generation)', 'generation: Number(h1.generation)');
    assert.notEqual(rounded, source);
    await writeFile(mainPath, rounded);
    await sealRendererAssets(mutantRoot);
    const roundedArchive = join(root, 'rounded-generation.asar');
    await createPackage(mutantRoot, roundedArchive);
    const lostGeneration = await T('run roundedArchive',()=>runArtifact(roundedArchive, dist));
    assert.equal(lostGeneration.rc, 1, lostGeneration.output);
    assert.match(lostGeneration.output, /DISPLAY chip\/paint fps=(?:[0-9]|1[0-9]);/);
    assert.match(lostGeneration.output, /stage=FIRST_FRAME detail=OK/);
    assert.match(lostGeneration.output, /stage=REFUSED detail=UNSAFE_GENERATION/);
    assert.match(lostGeneration.output, /outcome=TIMEOUT/);
    assert.doesNotMatch(lostGeneration.output, /stage=FIRST_PAINT/);
    console.log('DISPLAY_U64_GENERATION_MUTANT_REJECTED');
    await writeFile(mainPath, source);
    const assets = join(mutantRoot, 'dist/renderer/assets');
    const routerPath = join(assets, (await readdir(assets)).find(name => /^displayPortRouter-.*\.js$/.test(name)));
    const routerSource = await readFile(routerPath, 'utf8');
    // Vite spells the explicit hidden:true parking message as hidden:!0.
    const unparked = routerSource.replace('hidden:!0', 'hidden:!1');
    assert.notEqual(unparked, routerSource);
    await writeFile(routerPath, unparked);
    await sealRendererAssets(mutantRoot);
    const unboundArchive = join(root, 'unbound.asar');
    await createPackage(mutantRoot, unboundArchive);
    const unbound = await T('run unboundArchive',()=>runArtifact(unboundArchive, dist));
    assert.equal(unbound.rc, 1, unbound.output);
    assert.match(unbound.output, /unbound tile must have zero host reads/);
    await writeFile(routerPath, routerSource);
    console.log('DISPLAY_UNBIND_MUTANT_REJECTED');

    // Readiness is now advisory: reverting R4's native-ready retention must
    // converge through a later authenticated pull rather than strand the tile.
    const readiness = source.replace('let receiverReady = false;', 'let receiverReady = true;');
    assert.notEqual(readiness, source);
    await writeFile(mainPath, readiness);
    await sealRendererAssets(mutantRoot);
    const readinessArchive = join(root, 'readiness.asar');
    await createPackage(mutantRoot, readinessArchive);
    const recovered = await T('run readinessArchive',()=>runArtifact(readinessArchive, dist));
    assert.equal(recovered.rc, 0, recovered.output);
    assert.match(recovered.output, /DISPLAY_E2E_OK fps=(\d+)/);
    console.log('DISPLAY_READY_LOSS_RECOVERED');
  } finally { await rm(root, { recursive: true, force: true }); }
});
