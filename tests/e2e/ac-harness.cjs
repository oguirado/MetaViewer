'use strict';
// [TARGET, unit decision] AC tests stage their renderer without the unrelated
// MV_E2E_LIVE flag. Missing real tools still fail; no dependency is downloaded.
const harness = require('./harness.js');
const { after } = require('node:test');
const { execFileSync } = require('node:child_process');
const { accessSync, constants } = require('node:fs');
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
module.exports = { ...harness, prepareWall, electronBinary };
