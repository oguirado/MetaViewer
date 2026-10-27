'use strict';
// U17n: run the shipped Linux RSS probe against the actual built Electron shell.
// Its receipt explicitly limits qualification to the shell workload; native
// capsule folding/reconnect/context-loss qualification remains open.
// Mutation: change proc_fields.mjs classifyRole's main-process return to helper
// -> the real probe refuses absent main-role evidence.
// Mutation: make tools/budget_gate.py's `failures = [...]` always empty -> the
// leak planted in the measured receipt is incorrectly accepted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const harness = require('./ac-harness.cjs');
const root = join(__dirname, '../..');

test('real Electron main/renderer/tree stay within frozen RSS caps; a measured-receipt leak fails', () => {
  const scratch = harness.makeScratch('mv-rss-e2e');
  try {
    execFileSync(process.execPath, [join(root, 'ui/node_modules/vite/bin/vite.js'), 'build'], {
      cwd: join(root, 'ui'), env: process.env, encoding: 'utf8', timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const python = process.env.PYTHON || 'python3';
    const measured = spawnSync('xvfb-run', ['-a', python, join(root, 'tools/budget_gate.py'),
      '--probe', '--electron', join(__dirname, 'rss-electron-wrapper.py')], {
      cwd: root, env: { ...process.env, MV_RSS_ELECTRON: harness.electronBinary(root) },
      encoding: 'utf8', timeout: 200000, maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(measured.status, 0, measured.stderr + measured.stdout);
    assert.doesNotMatch(measured.stderr, /No handler registered for 'metaviewer:capture\./,
      'full renderer capture startup must use the production IPC bridge');
    const summary = JSON.parse(measured.stdout.trim().split('\n').at(-1));
    assert.equal(summary.failed, 0);
    assert.equal(summary.receipt.schema, 'metaviewer.perf.rss-receipt/v1');
    assert.deepEqual(summary.receipt.orphans, []);
    assert.ok(summary.receipt.samples.length >= 6);
    for (const sample of summary.receipt.samples) {
      assert.ok(sample.processes.some(row => row.role === 'main' && row.rss_bytes > 0));
      assert.ok(sample.processes.some(row => row.role === 'renderer' && row.rss_bytes > 0));
    }
    console.log('RSS_CAPS [MEASURED]: ' + JSON.stringify(summary.result.maxima_bytes));
    const gate = receipt => {
      const file = join(scratch, 'receipt.json');
      writeFileSync(file, JSON.stringify(receipt));
      return spawnSync(python, [join(root, 'tools/budget_gate.py'), '--receipt', file], {
        cwd: root, env: process.env, encoding: 'utf8', timeout: 10000,
      });
    };
    assert.equal(gate(summary.receipt).status, 0);
    const leak = structuredClone(summary.receipt);
    const sample = leak.samples.at(-1);
    const increase = 370000001 - sample.rss_renderer_bytes;
    sample.rss_renderer_bytes += increase;
    sample.rss_tree_bytes += increase;
    const refused = gate(leak);
    assert.equal(refused.status, 1, refused.stderr + refused.stdout);
    assert.deepEqual(JSON.parse(refused.stdout).result.failures, ['rss_renderer_bytes']);
  } finally { harness.removeScratch(scratch); }
});
