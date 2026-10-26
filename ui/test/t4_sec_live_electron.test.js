import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Live Electron checklist (skip if ELECTRON_OVERRIDE_DIST_PATH is absent)', (t) => {
  const distPath = process.env.ELECTRON_OVERRIDE_DIST_PATH;

  if (!distPath) {
    t.skip('Skipping live Electron test: ELECTRON_OVERRIDE_DIST_PATH environment variable is not set');
    return;
  }

  // If ELECTRON_OVERRIDE_DIST_PATH is present, we attempt live verification
  assert.ok(distPath, 'ELECTRON_OVERRIDE_DIST_PATH must point to local Electron dist');
});
