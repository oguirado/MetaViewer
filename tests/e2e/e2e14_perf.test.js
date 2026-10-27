'use strict';
// U03: real wall/scheduler/canvas with synthetic capture. 10 fps, 2 s maximum
// silence and a 600 s nightly override are [TARGET], never fixture measurements.
// Mutation: replace `if (n === 0) {` in runTick with `if (true) {`
// -> timestamp/FPS assertions fail because no canvas is presented.
// Mutation: remove `entry.state = { ...entry.state, folded: true };` from
// foldSurface -> the hidden tile still draws and the folded audit fails.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const harness = require('./ac-harness.cjs');

function validate(report) {
  assert.equal(report.schema, 'metaviewer.perf-wall/v1');
  assert.equal(report.capture, 'synthetic-rgb24');
  assert.equal(report.visible.length, 4);
  assert.equal(new Set(report.visible.map(t => t.id)).size, 4);
  const duration = report.ended - report.started;
  assert.ok(Number.isFinite(duration) && duration >= 2900, 'E2E_PERF: sampling window');
  for (const tile of report.visible) {
    const times = [report.started, ...tile.times, report.ended];
    assert.ok(tile.times.length * 1000 / duration >= 10, `E2E_FPS: ${tile.id}`);
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i] >= times[i - 1] && times[i] - times[i - 1] <= 2000,
        `E2E_STALL: ${tile.id}`);
    }
    assert.equal(tile.info.presentCount, tile.times.length);
    assert.ok(tile.info.lastCaptureGeneration > 0);
    assert.deepEqual(tile.pixel, tile.expectedPixel, `E2E_ROUTING: ${tile.id}`);
  }
  const { before, after, hidden } = report.folded;
  assert.equal(hidden, true);
  assert.equal(after.folded, true);
  assert.equal(after.captureLeaseActive, true);
  assert.ok(after.lastCaptureGeneration > before.lastCaptureGeneration, 'E2E_FOLD: capture stalled');
  assert.equal(after.drawSubmissions, before.drawSubmissions, 'E2E_FOLD: hidden draw');
  return report;
}

test('wall canvas soak measures cadence and folded capture; a producer stall fails', () => {
  const seconds = process.env.MV_SOAK_SECS === undefined ? 3 : Number(process.env.MV_SOAK_SECS);
  assert.ok(Number.isInteger(seconds) && seconds >= 3 && seconds <= 600,
    'E2E_PREREQ: MV_SOAK_SECS must be an integer in [3,600] [TARGET]');
  const scratch = harness.makeScratch('mv-perf-wall');
  try {
    const build = join(scratch, 'build');
    execFileSync(process.execPath, [join(__dirname, 'perf-build.mjs')], {
      env: { ...process.env, MV_E2E_BUILD: build }, timeout: 120000,
      encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const run = (name, options) => {
      const report = join(scratch, name + '.json');
      const outcome = harness.runUnderXvfb({
        electron: harness.electronBinary(join(__dirname, '../..')),
        appDir: join(__dirname, 'perf-main.cjs'),
        extraArgs: [build, report, JSON.stringify(options)],
        timeoutMs: (options.seconds + 35) * 1000,
      });
      assert.equal(outcome.status, 0, JSON.stringify(outcome));
      return JSON.parse(readFileSync(report, 'utf8'));
    };
    const clean = validate(run('clean', { seconds }));
    console.log('PERF_WALL [MEASURED]: ' + JSON.stringify(clean.visible.map(tile => ({
      id: tile.id, fps: tile.times.length * 1000 / (clean.ended - clean.started),
    }))));
    const stalled = run('stall', { seconds: 3, stallMs: 2200 });
    assert.throws(() => validate(stalled), /E2E_FPS|E2E_STALL/);
    // Exercise the silence bound independently of average throughput.
    const gap = structuredClone(clean);
    gap.visible[0].times = gap.visible[0].times.map(() => gap.started);
    assert.throws(() => validate(gap), /E2E_STALL/);
    const folded = structuredClone(clean);
    folded.folded.after.lastCaptureGeneration = folded.folded.before.lastCaptureGeneration;
    assert.throws(() => validate(folded), /E2E_FOLD/);
  } finally { harness.removeScratch(scratch); }
});
