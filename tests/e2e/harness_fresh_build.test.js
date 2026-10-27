'use strict';

/**
 * W3-E2E-FRESH-BUILD tests and negative controls for prepareWall UI build
 * freshness verification and stamp enforcement.
 *
 * [TARGET, unit decision] Verifies that prepareWall rebuilds ui/dist whenever
 * any file under ui/src, ui/electron, ui/index.html, ui/vite.config.* or
 * ui/kit.lock.json is newer than the build or when the build lacks a valid
 * content hash stamp, reuses ui/dist when the stamp matches and no source is
 * newer, and fails closed with E2EError('E2E_PREREQ', ...) (removing stale
 * artifacts) when a stale build cannot be rebuilt.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');

const {
  E2EError,
  UI_BUILD_STAMP_FILE,
  UI_BUILD_STAMP_SCHEMA,
  collectUiBuildSources,
  ensureFreshUiDist,
  inspectUiDistFreshness,
  makeScratch,
  prepareWall,
  removeScratch,
} = require('./ac-harness.cjs');

/**
 * Create a self-contained disposable repository fixture with a real Node Vite
 * CLI stub at ui/node_modules/vite/bin/vite.js that records build invocations
 * and embeds the current source contents into dist/renderer/index.html and
 * dist/preload/preload.cjs.
 * @param {string} baseScratch Parent scratch directory.
 * @param {string} [subDir] Optional subdirectory name (including non-ASCII).
 */
function createUiFixtureRepo(baseScratch, subDir = 'repo') {
  const root = join(baseScratch, subDir);
  const uiRoot = join(root, 'ui');
  mkdirSync(join(root, 'contracts', 'v0.2'), { recursive: true });
  mkdirSync(join(uiRoot, 'src', 'surfaces'), { recursive: true });
  mkdirSync(join(uiRoot, 'electron'), { recursive: true });
  mkdirSync(join(uiRoot, 'node_modules', 'vite', 'bin'), { recursive: true });

  writeFileSync(join(uiRoot, 'package.json'), '{"name":"metaviewer-ui","version":"0.1.2"}\n', 'utf8');
  writeFileSync(
    join(uiRoot, 'src', 'App.vue'),
    '<template><main id="metaviewer-app">v1</main></template>\n',
    'utf8',
  );
  writeFileSync(
    join(uiRoot, 'src', 'surfaces', 'SurfaceCanvas.vue'),
    '<template><canvas data-surface-canvas="v1"></canvas></template>\n',
    'utf8',
  );
  writeFileSync(
    join(uiRoot, 'electron', 'main.js'),
    'export const MAIN_ENTRY = "v1";\n',
    'utf8',
  );
  writeFileSync(
    join(uiRoot, 'electron', 'preload.js'),
    'export const PRELOAD_ENTRY = "v1";\n',
    'utf8',
  );
  writeFileSync(
    join(uiRoot, 'index.html'),
    '<!doctype html><html><body><div id="metaviewer-app"></div></body></html>\n',
    'utf8',
  );
  writeFileSync(
    join(uiRoot, 'vite.config.js'),
    'export default { base: "./", build: { outDir: "dist/renderer" } };\n',
    'utf8',
  );
  writeFileSync(
    join(uiRoot, 'kit.lock.json'),
    JSON.stringify({
      repo: 'https://github.com/oguirado/capsule-ui-kit.git',
      commit: 'bf31bc201987206d16dbd88d93102f9d5ce026f9',
      version: '0.2.1',
      contentHash: '1bee78c76a0a2a41d085beed918ca6ca791beaf53b952d4a9367dad660fd6dc2',
    }) + '\n',
    'utf8',
  );

  const counterPath = join(root, 'build-count.txt');
  writeFileSync(counterPath, '0\n', 'utf8');

  const viteScript = `'use strict';
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
if (process.argv[2] !== 'build') {
  process.stderr.write('unexpected vite subcommand\\n');
  process.exit(2);
}
if (process.env.MV_TEST_VITE_FAIL === '1') {
  process.stderr.write('simulated vite build failure\\n');
  process.exit(1);
}
const uiRoot = process.cwd();
const countFile = join(uiRoot, '..', 'build-count.txt');
const nextCount = Number(readFileSync(countFile, 'utf8').trim()) + 1;
writeFileSync(countFile, String(nextCount) + '\\n', 'utf8');
const canvas = readFileSync(join(uiRoot, 'src', 'surfaces', 'SurfaceCanvas.vue'), 'utf8').trim();
const app = readFileSync(join(uiRoot, 'src', 'App.vue'), 'utf8').trim();
const html = readFileSync(join(uiRoot, 'index.html'), 'utf8').trim();
const cfg = readFileSync(join(uiRoot, 'vite.config.js'), 'utf8').trim();
const kit = readFileSync(join(uiRoot, 'kit.lock.json'), 'utf8').trim();
const preload = readFileSync(join(uiRoot, 'electron', 'preload.js'), 'utf8').trim();
const main = readFileSync(join(uiRoot, 'electron', 'main.js'), 'utf8').trim();
mkdirSync(join(uiRoot, 'dist', 'renderer'), { recursive: true });
mkdirSync(join(uiRoot, 'dist', 'preload'), { recursive: true });
writeFileSync(
  join(uiRoot, 'dist', 'renderer', 'index.html'),
  JSON.stringify({ buildCount: nextCount, html, app, canvas, cfg, kit }) + '\\n',
  'utf8',
);
writeFileSync(
  join(uiRoot, 'dist', 'preload', 'preload.cjs'),
  JSON.stringify({ buildCount: nextCount, preload, main }) + '\\n',
  'utf8',
);
`;
  writeFileSync(join(uiRoot, 'node_modules', 'vite', 'bin', 'vite.js'), viteScript, 'utf8');

  const readBuildCount = () => Number(readFileSync(counterPath, 'utf8').trim());
  return { root, uiRoot, counterPath, readBuildCount };
}

describe('W3-E2E-FRESH-BUILD: prepareWall UI build freshness and stamp gate', () => {
  it('builds ui/dist when absent, writes content hash stamp, and skips rebuild when stamp matches', () => {
    const scratch = makeScratch('mv-fresh-build');
    try {
      const { root, uiRoot, readBuildCount } = createUiFixtureRepo(scratch, 'Música-repo');

      const first = prepareWall({ root, stageWall: false });
      assert.equal(first.rebuilt, true);
      assert.equal(first.reason, 'missing_build_artifacts');
      assert.equal(readBuildCount(), 1);
      assert.equal(existsSync(first.stampPath), true);

      const stamp = JSON.parse(readFileSync(first.stampPath, 'utf8'));
      assert.equal(stamp.schema, UI_BUILD_STAMP_SCHEMA);
      assert.equal(stamp.sourceHash, first.sourceHash);
      assert.match(stamp.sourceHash, /^[0-9a-f]{64}$/);

      // Second call with matching stamp and no newer source file must reuse ui/dist without rebuilding.
      const second = prepareWall({ root, stageWall: false });
      assert.equal(second.rebuilt, false);
      assert.equal(second.reason, 'fresh');
      assert.equal(second.sourceHash, first.sourceHash);
      assert.equal(readBuildCount(), 1);

      const check = inspectUiDistFreshness(uiRoot);
      assert.equal(check.fresh, true);
      assert.equal(check.reason, 'fresh');
    } finally {
      removeScratch(scratch);
    }
  });

  it('rebuilds ui/dist when the build lacks a harness stamp or has a mismatched stamp', () => {
    const scratch = makeScratch('mv-unstamped');
    try {
      const { root, uiRoot, readBuildCount } = createUiFixtureRepo(scratch);

      // Simulate an external `npm run build` that produced dist artifacts with a newer mtime but no harness stamp.
      mkdirSync(join(uiRoot, 'dist', 'renderer'), { recursive: true });
      mkdirSync(join(uiRoot, 'dist', 'preload'), { recursive: true });
      const future = new Date(Date.now() + 60000);
      const rendererIndex = join(uiRoot, 'dist', 'renderer', 'index.html');
      const preloadCjs = join(uiRoot, 'dist', 'preload', 'preload.cjs');
      writeFileSync(rendererIndex, '<html>stale unstamped build</html>\n', 'utf8');
      writeFileSync(preloadCjs, '"use strict"; // stale unstamped preload\n', 'utf8');
      utimesSync(rendererIndex, future, future);
      utimesSync(preloadCjs, future, future);

      const unstampedCheck = inspectUiDistFreshness(uiRoot);
      assert.equal(unstampedCheck.fresh, false);
      assert.equal(unstampedCheck.reason, 'missing_stamp');

      const built = prepareWall({ root, stageWall: false });
      assert.equal(built.rebuilt, true);
      assert.equal(built.reason, 'missing_stamp');
      assert.equal(readBuildCount(), 1);

      // Tamper with the stamp's sourceHash while keeping mtimes unchanged (simulating rebase onto older mtime).
      const stampPath = join(uiRoot, 'dist', UI_BUILD_STAMP_FILE);
      const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
      stamp.sourceHash = '0'.repeat(64);
      writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');

      const rebuiltOnHashDrift = prepareWall({ root, stageWall: false });
      assert.equal(rebuiltOnHashDrift.rebuilt, true);
      assert.equal(rebuiltOnHashDrift.reason, 'source_hash_mismatch');
      assert.equal(readBuildCount(), 2);
    } finally {
      removeScratch(scratch);
    }
  });

  it('negative control: touching a renderer file after a build forces prepareWall to rebuild', () => {
    const scratch = makeScratch('mv-touch-renderer');
    try {
      const { root, uiRoot, readBuildCount } = createUiFixtureRepo(scratch);

      const initial = prepareWall({ root, stageWall: false });
      assert.equal(initial.rebuilt, true);
      assert.equal(readBuildCount(), 1);

      // Touch a renderer file (mtime-only update, identical bytes) after the build.
      const rendererFile = join(uiRoot, 'src', 'surfaces', 'SurfaceCanvas.vue');
      const bumpedTime = new Date(Date.now() + 5000);
      utimesSync(rendererFile, bumpedTime, bumpedTime);

      const staleCheck = inspectUiDistFreshness(uiRoot);
      assert.equal(staleCheck.fresh, false);
      assert.equal(staleCheck.reason, 'source_newer_than_build');
      assert.equal(staleCheck.newerFile, 'src/surfaces/SurfaceCanvas.vue');

      const afterTouch = prepareWall({ root, stageWall: false });
      assert.equal(afterTouch.rebuilt, true);
      assert.equal(afterTouch.reason, 'source_newer_than_build');
      assert.equal(afterTouch.newerFile, 'src/surfaces/SurfaceCanvas.vue');
      assert.equal(readBuildCount(), 2);

      // Subsequent call without further touch does not rebuild.
      const settled = prepareWall({ root, stageWall: false });
      assert.equal(settled.rebuilt, false);
      assert.equal(readBuildCount(), 2);

      // Edit the renderer file content and verify the rebuilt bundle contains the new renderer code.
      writeFileSync(
        rendererFile,
        '<template><canvas data-surface-canvas="v2-fixed"></canvas></template>\n',
        'utf8',
      );
      const afterEdit = prepareWall({ root, stageWall: false });
      assert.equal(afterEdit.rebuilt, true);
      assert.equal(readBuildCount(), 3);
      const builtHtml = JSON.parse(readFileSync(join(uiRoot, 'dist', 'renderer', 'index.html'), 'utf8'));
      assert.equal(builtHtml.buildCount, 3);
      assert.match(builtHtml.canvas, /v2-fixed/);
    } finally {
      removeScratch(scratch);
    }
  });

  it('rebuilds when any watched file under ui/electron, ui/index.html, ui/vite.config.js or ui/kit.lock.json is newer', () => {
    const scratch = makeScratch('mv-watch-all');
    try {
      const { root, uiRoot, readBuildCount } = createUiFixtureRepo(scratch);

      prepareWall({ root, stageWall: false });
      assert.equal(readBuildCount(), 1);

      const watchedTargets = [
        { rel: 'electron/preload.js', abs: join(uiRoot, 'electron', 'preload.js') },
        { rel: 'electron/main.js', abs: join(uiRoot, 'electron', 'main.js') },
        { rel: 'index.html', abs: join(uiRoot, 'index.html') },
        { rel: 'vite.config.js', abs: join(uiRoot, 'vite.config.js') },
        { rel: 'kit.lock.json', abs: join(uiRoot, 'kit.lock.json') },
      ];

      let expectedBuilds = 1;
      for (const target of watchedTargets) {
        const touchDate = new Date(Date.now() + expectedBuilds * 5000);
        utimesSync(target.abs, touchDate, touchDate);
        const result = prepareWall({ root, stageWall: false });
        expectedBuilds += 1;
        assert.equal(result.rebuilt, true, `expected rebuild after touching ${target.rel}`);
        assert.equal(result.reason, 'source_newer_than_build');
        assert.equal(result.newerFile, target.rel);
        assert.equal(readBuildCount(), expectedBuilds);
      }

      // Adding a new file under ui/src also invalidates the build stamp.
      writeFileSync(join(uiRoot, 'src', 'NewHelper.js'), 'export const HELPER = 1;\n', 'utf8');
      const afterAdd = prepareWall({ root, stageWall: false });
      expectedBuilds += 1;
      assert.equal(afterAdd.rebuilt, true);
      assert.equal(afterAdd.reason, 'source_hash_mismatch');
      assert.equal(readBuildCount(), expectedBuilds);
    } finally {
      removeScratch(scratch);
    }
  });

  it('negative control: touching a renderer file when rebuild fails throws E2E_PREREQ and removes stale ui/dist', () => {
    const scratch = makeScratch('mv-refuse-stale');
    try {
      const { root, uiRoot, readBuildCount } = createUiFixtureRepo(scratch);

      const first = prepareWall({ root, stageWall: false });
      assert.equal(first.rebuilt, true);
      assert.equal(readBuildCount(), 1);
      assert.equal(existsSync(join(uiRoot, 'dist', 'renderer', 'index.html')), true);

      // Touch a renderer file after the build, then force the Vite rebuild to fail.
      const rendererFile = join(uiRoot, 'src', 'surfaces', 'SurfaceCanvas.vue');
      const future = new Date(Date.now() + 10000);
      utimesSync(rendererFile, future, future);

      assert.throws(
        () => prepareWall({
          root,
          stageWall: false,
          env: { ...process.env, MV_TEST_VITE_FAIL: '1' },
        }),
        (error) => error instanceof E2EError && error.code === 'E2E_PREREQ',
      );

      // Stale build artifacts and stamp must be removed so no caller can reuse them.
      assert.equal(existsSync(join(uiRoot, 'dist', 'renderer', 'index.html')), false);
      assert.equal(existsSync(join(uiRoot, 'dist', UI_BUILD_STAMP_FILE)), false);

      // Also verify missing vite CLI refuses with E2E_PREREQ when a rebuild is required.
      rmSync(join(uiRoot, 'node_modules', 'vite', 'bin', 'vite.js'), { force: true });
      assert.throws(
        () => ensureFreshUiDist({ root }),
        (error) => error instanceof E2EError && error.code === 'E2E_PREREQ',
      );
      assert.equal(
        collectUiBuildSources(uiRoot).files.includes('src/surfaces/SurfaceCanvas.vue'),
        true,
      );
    } finally {
      removeScratch(scratch);
    }
  });

  it('verifies kit sync prerequisite before rebuild and refuses with E2E_PREREQ when kit cannot be synced', () => {
    const scratch = makeScratch('mv-kit-prereq');
    try {
      const { root, uiRoot, readBuildCount } = createUiFixtureRepo(scratch);
      mkdirSync(join(root, 'tools'), { recursive: true });
      writeFileSync(
        join(root, 'tools', 'sync_kit.mjs'),
        `import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const marker = join(process.cwd(), 'kit-synced.flag');
if (process.argv.includes('--check')) {
  if (!existsSync(marker)) {
    process.stderr.write('kit absent\\n');
    process.exit(1);
  }
  process.exit(0);
}
const repo = process.argv[2] || '';
if (repo !== '/valid-kit-checkout') {
  process.stderr.write('invalid kit checkout\\n');
  process.exit(1);
}
writeFileSync(marker, 'ok\\n', 'utf8');
`,
        'utf8',
      );

      // Without MV_KIT_CHECKOUT / CAPSULE_UI_KIT_REPO, kit check fails and prepareWall refuses with E2E_PREREQ.
      const cleanEnv = { ...process.env };
      delete cleanEnv.MV_KIT_CHECKOUT;
      delete cleanEnv.CAPSULE_UI_KIT_REPO;
      assert.throws(
        () => prepareWall({ root, stageWall: false, env: cleanEnv }),
        (error) => error instanceof E2EError && error.code === 'E2E_PREREQ',
      );
      assert.equal(readBuildCount(), 0);
      assert.equal(existsSync(join(uiRoot, 'dist')), false);

      // With CAPSULE_UI_KIT_REPO set to a valid checkout, prepareWall syncs the kit and builds ui/dist.
      const built = prepareWall({
        root,
        stageWall: false,
        env: { ...cleanEnv, CAPSULE_UI_KIT_REPO: '/valid-kit-checkout' },
      });
      assert.equal(built.rebuilt, true);
      assert.equal(readBuildCount(), 1);
      assert.equal(existsSync(join(uiRoot, 'dist', UI_BUILD_STAMP_FILE)), true);
    } finally {
      removeScratch(scratch);
    }
  });
});
