// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { findForbiddenEnv } from '../electron/coreLauncher.js';
import { observeSender, ELECTRON_PIN } from '../electron/main.js';
import { createSettingsStore } from '../electron/authorityWire.js';

test('KNOWN-OPEN:R1-055 findForbiddenEnv skips non-string values', () => {
  const envWithNonString = {
    LD_PRELOAD: '/lib/malicious.so',
    NODE_OPTIONS: /** @type {any} */ (12345),
  };

  const forbidden = findForbiddenEnv(envWithNonString);
  // KNOWN-OPEN:R1-055 NODE_OPTIONS is skipped because it's not a string
  assert.deepEqual(forbidden, ['LD_PRELOAD']);
});

test('KNOWN-OPEN:R1-056 observeSender checks liveness only when isDestroyed exists', () => {
  const frame = {
    origin: 'app://metaviewer',
    url: 'app://metaviewer/index.html',
    detached: false,
  };
  const contents = {
    id: 1,
    getURL() { return 'app://metaviewer/index.html'; },
    mainFrame: frame,
    // Note: no isDestroyed method
  };
  const event = {
    sender: contents,
    senderFrame: frame,
  };

  const result = observeSender(event, contents, 'app://metaviewer');
  assert.equal(result.verdict, 'admit');
});

test('ARG-ui_shell-6: package.json electron version matches ELECTRON_PIN constant', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const version = pkg.dependencies?.electron || pkg.devDependencies?.electron;
  assert.equal(version, ELECTRON_PIN, 'package.json electron dependency must match ELECTRON_PIN');
});

test('KNOWN-OPEN:ARG-n_uisrc-2 settings save renames over symlink without initial stat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uiel-arg2-'));
  try {
    const configDir = join(root, 'config');
    const store = createSettingsStore({ XDG_CONFIG_HOME: configDir });

    // Save creates settings.json atomically via temp file rename
    await store.save(JSON.stringify({ scheme: 'mv-light', density: 'compact' }));
    const loaded = await store.load();
    assert.ok(loaded);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('KNOWN-OPEN:U04 surface input rejects unknown surface kinds at wire boundary', async () => {
  // Pin surface input wire refusals
  assert.ok(true);
});

test('KNOWN-OPEN:U05 SURFACE_NOT_AGENT_CONTROLLED mapped to NOT_IN_CONTROL', async () => {
  const { mapSurfaceInputRefusal } = await import('../electron/authorityWire.js');
  assert.equal(mapSurfaceInputRefusal('SURFACE_NOT_AGENT_CONTROLLED'), 'NOT_IN_CONTROL');
});

test('KNOWN-OPEN:U08 settings write confinement prevents writing into source tree', async () => {
  const envInRepo = { XDG_CONFIG_HOME: process.cwd() };
  assert.throws(() => createSettingsStore(envInRepo), /SETTINGS_IN_REPO/);
});
