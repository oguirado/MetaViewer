import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = process.env.ELECTRON_OVERRIDE_DIST_PATH;
test('V028-FIT-2: production slot fits banner, complete frame and wrapped footer', {
  timeout: 30000,
}, () => {
  assert.ok(dist, 'requires the gate-provided local Electron dist');
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MV_FIT_HOLD;
  delete env.MV_FIT_RECEIPT;
  delete env.MV_FIT_NEGATIVE;
  const entry = fileURLToPath(new URL('./v028-fit-render.cjs', import.meta.url));
  for (const negative of [false, 'black-background', 'sideways-banner']) {
    const run = spawnSync('xvfb-run', ['-a', join(dist, 'electron'), entry], {
      env: {...env, ...(negative ? {MV_FIT_NEGATIVE:negative} : {})},
      encoding:'utf8', timeout:12000,
    });
    const output = run.stdout + run.stderr;
    assert.equal(run.error, undefined, output);
    if (negative) {
      assert.notEqual(run.status, 0, output);
      assert.match(output, negative === 'black-background' ? /letterbox must use tile background/ : /clipped:|banner must occupy/);
    } else {
      assert.equal(run.status, 0, output);
      assert.match(output, /V028_FIT_RENDER_OK/);
    }
  }
});
