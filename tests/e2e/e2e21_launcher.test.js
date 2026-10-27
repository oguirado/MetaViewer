'use strict';
// U04n: UI launch choices feed real core catalog transitions through a minimal
// test handoff. VM is not a launcher choice on this base; ac03 covers its core.
// Mutation: remove `if (result.ok) emit('create', result.intent);` from the
// product CatalogLauncher.vue -> the emitted-intent assertion fails.
// Mutation: change CatalogRegistry's SurfaceIdUsed refusal to accept a used id
// -> launcher-authority.rs refuses the revived-id outcome.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const harness = require('./ac-harness.cjs');
const { runRust } = require('./core-driver.js');

test('New Capsule launcher creates and destroys each offered kind; terminal ids never revive', () => {
  const scratch = harness.makeScratch('mv-launcher');
  try {
    const build = join(scratch, 'build'), report = join(scratch, 'launcher.json');
    execFileSync(process.execPath, [join(__dirname, 'perf-build.mjs')], {
      env: { ...process.env, MV_E2E_BUILD: build,
        MV_E2E_JOURNEY_FIXTURE: join(__dirname, 'launcher-fixture.mjs') },
      timeout: 120000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const result = harness.runUnderXvfb({
      electron: harness.electronBinary(join(__dirname, '../..')),
      appDir: join(__dirname, 'perf-main.cjs'),
      extraArgs: [build, report, JSON.stringify({ journey: 'launcher' })], timeoutMs: 45000,
    });
    assert.equal(result.status, 0, JSON.stringify(result));
    const journey = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(journey.schema, 'metaviewer.launcher-journey/v1');
    const kinds = ['identity-browser', 'program', 'holdings-app', 'desktop'];
    assert.deepEqual(journey.intents, kinds.map(kind => ({ type: 'create-capsule', kind, placement: 'tab' })));
    assert.deepEqual(journey.unknown, { errors: ['ERR_CATALOG_UNKNOWN_KIND'], cards: 0, emitted: 0 });
    mkdirSync(join(scratch, 'state_dir'));
    writeFileSync(join(scratch, 'state_dir/launcher-intents.json'), JSON.stringify(journey.intents));
    const transitions = JSON.parse(runRust(scratch,
      readFileSync(join(__dirname, 'launcher-authority.rs'), 'utf8')));
    assert.deepEqual(transitions.map(row => row.kind), kinds);
    assert.equal(new Set(transitions.flatMap(row => [row.original, row.fresh])).size, 8);
    assert.ok(transitions.every(row => row.old_id_refused === true));
    assert.deepEqual(transitions.map(row => row.binary), [
      'srf-identity-surface', 'srf-identity-surface', 'srf-holdings-capsule', 'srf-capsula-desktop',
    ]);
  } finally { harness.removeScratch(scratch); }
});
