'use strict';
// U20: real display-only boot for depth one, typed refusal before display for
// depth two. Mutation: in validateRetailLaunch change `nested === 1` to false
// -> the positive process refuses before loading its wall.
// Mutation: accept --nested-depth=2 alongside =1 -> the negative callback runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const harness = require('./ac-harness.cjs');

test('nested depth one boots an isolated read-only wall; depth two refuses before display', () => {
  const scratch = harness.makeScratch('mv-nested');
  try {
    const root = join(__dirname, '../..');
    execFileSync(process.execPath, [join(root, 'ui/node_modules/vite/bin/vite.js'), 'build',
      '--outDir', join(scratch, 'dist/renderer')], { cwd: join(root, 'ui'), env: process.env,
      encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'mv-nested-test',
      version: '0.0.0', type: 'module', main: 'probe.mjs' }));
    writeFileSync(join(scratch, 'probe.mjs'),
      `import ${JSON.stringify(pathToFileURL(join(__dirname, 'nested-main.mjs')).href)};`);
    const run = depth => {
      const report = join(scratch, `depth-${depth}.json`);
      const result = harness.runUnderXvfb({ electron: harness.electronBinary(root),
        appDir: scratch, extraArgs: [report, `--nested-depth=${depth}`], timeoutMs: 30000 });
      return { result, report: JSON.parse(readFileSync(report, 'utf8')) };
    };
    const good = run(1);
    assert.equal(good.result.status, 0, JSON.stringify(good));
    assert.deepEqual(good.report, { status: 'ready', calls: 1,
      renderer: { node: 'undefined', layout: null, saveRefused: true, settled: true,
        depth: 1, settings: null, blocked: [true, true, true] } });
    const bad = run(2);
    assert.equal(bad.result.status, 1, JSON.stringify(bad));
    assert.equal(bad.report.status, 'refused');
    assert.equal(bad.report.calls, 0);
    assert.match(bad.report.error, /NESTED_DEPTH/);
  } finally { harness.removeScratch(scratch); }
});
