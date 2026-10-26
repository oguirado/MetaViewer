'use strict';
// [TARGET, unit decision] Test-only Rust process entry. Resolve artifacts from
// Cargo's receipt (never an arbitrary stale rlib); all builds are offline.
const { execFileSync, spawnSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const ROOT = join(__dirname, '../..');
const TARGET = '/home/admin/.cache/cargo-target/metaviewer-workers';
const env = { ...process.env, CARGO_TARGET_DIR: TARGET };
let artifacts;
function buildCore() {
  if (!artifacts) {
    const output = execFileSync('/home/admin/.cargo/bin/cargo',
      ['build', '--offline', '--manifest-path', join(ROOT, 'Cargo.toml'), '--message-format=json'],
      { env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    artifacts = new Map();
    for (const line of output.trim().split('\n')) {
      const row = JSON.parse(line);
      if (row.reason === 'compiler-artifact') artifacts.set(row.target.name, row);
    }
  }
  return artifacts;
}
function compileRust(scratch, source) {
  const builds = buildCore();
  const input = join(scratch, 'driver.rs');
  const binary = join(scratch, 'driver');
  writeFileSync(input, source);
  const args = ['--edition=2021', input, '-o', binary];
  for (const name of ['metaviewer_core', 'serde_json']) {
    const file = builds.get(name)?.filenames.find((file) => file.endsWith('.rlib'));
    if (!file) throw new Error(`E2E_PREREQ: Cargo artifact absent: ${name}`);
    args.push('--extern', `${name}=${file}`, '-L', `dependency=${dirname(file)}`);
  }
  execFileSync('/home/admin/.cargo/bin/rustc', args, { env });
  return binary;
}
function runRust(scratch, source) {
  return execFileSync(compileRust(scratch, source), [join(scratch, 'state_dir')],
    { env, encoding: 'utf8', timeout: 30000 });
}
function replay(journal, root, verify = false) {
  const binary = buildCore().get('mv-replay')?.executable;
  if (!binary) throw new Error('E2E_PREREQ: mv-replay absent');
  const result = spawnSync(binary, ['--journal', journal, '--witness-root', root,
    ...(verify ? ['--verify-only'] : [])], { env, encoding: 'utf8', timeout: 30000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`E2E_REPLAY: rc=${result.status}: ${result.stderr}`);
  if (verify && (result.stdout !== '' || result.stderr !== '')) {
    throw new Error('E2E_REPLAY: verify-only must have empty stdout and stderr');
  }
  return result.stdout;
}
module.exports = { runRust, compileRust, replay };
