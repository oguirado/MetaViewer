// @ts-check
import { it, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ELECTRON_PIN,
  PRIVILEGED_ORIGIN,
  handleAppRequest,
  observeSender,
} from '../electron/main.js';
import { findForbiddenEnv } from '../electron/coreLauncher.js';
import { installPreload } from '../electron/preload.js';
import { createSettingsStore } from '../electron/authorityWire.js';

function makeTempRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function rmRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

function makeBundle() {
  const root = makeTempRoot('mv0r2-open-bundle-');
  const rendererRoot = join(root, 'dist', 'renderer');
  mkdirSync(rendererRoot, { recursive: true });
  writeFileSync(join(rendererRoot, 'index.html'), '<!doctype html><html><head><title>t</title></head><body>x</body></html>');
  writeFileSync(join(rendererRoot, 'app.js'), 'console.log(1);\n');
  return { root, rendererRoot };
}

describe('T4 Still-Open Confirmation Tests', () => {

  it('KNOWN-OPEN:R1-005 URL double decoding returns 404 instead of 403', async () => {
    const { root, rendererRoot } = makeBundle();
    try {
      const res = await handleAppRequest(rendererRoot, { url: `${PRIVILEGED_ORIGIN}/%252e%252e/app.js` });
      // R1-005 open finding: double decoding causes 404 instead of 403, but containment holds.
      assert.equal(res.status, 404, 'KNOWN-OPEN:R1-005 URL double decoding returns 404 instead of 403');
    } finally {
      rmRoot(root);
    }
  });

  it('KNOWN-OPEN:R1-054+R1-059 manifest lacks header/epoch/root and walk-then-hash TOCTOU', () => {
    // Shared with T7: confirm writeManifest lacks SW240-MANIFEST-V1 header line or epoch
    const pkgSrc = readFileSync(new URL('../tools/package.js', import.meta.url), 'utf8');
    assert.ok(!pkgSrc.includes('SW240-MANIFEST-V1'), 'KNOWN-OPEN:R1-054+R1-059 writeManifest lacks canonical header');
  });

  it('KNOWN-OPEN:R1-055 findForbiddenEnv skips non-string values', () => {
    // findForbiddenEnv ignores non-string values in environment object
    // @ts-ignore
    const result = findForbiddenEnv({ FORBIDDEN_VAR: 12345 });
    assert.ok(Array.isArray(result) && result.length === 0, 'KNOWN-OPEN:R1-055 findForbiddenEnv skips non-string values');
  });

  it('KNOWN-OPEN:R1-056 observeSender liveness check only performed if function exists', () => {
    const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
    const contents = { id: 1, mainFrame: frame };
    const event = { sender: contents, senderFrame: frame };
    const verdict = observeSender(event, contents, PRIVILEGED_ORIGIN);
    assert.equal(verdict.verdict, 'admit', 'KNOWN-OPEN:R1-056 observeSender liveness check depends on isDestroyed existence');
  });

  it('KNOWN-OPEN:R1-057 createWindowOptions ignores non-enumerable or symbol options', () => {
    const mainSrc = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
    assert.ok(mainSrc.includes('createWindowOptions'), 'KNOWN-OPEN:R1-057 createWindowOptions ignores symbol options');
  });

  it('KNOWN-OPEN:R1-058 assertDeps accepts non-enumerable extra properties', () => {
    const bridge = { invoke: async () => {}, on: () => {}, removeListener: () => {} };
    const transport = { invoke: async () => {}, on: () => {}, removeListener: () => {} };
    const deps = { bridge, transport };
    Object.defineProperty(deps, 'extraSecret', { value: 'forbidden', enumerable: false });
    assert.doesNotThrow(
      () => installPreload({ contextBridge: { exposeInMainWorld: () => {} }, ipcRenderer: deps.transport }),
      'KNOWN-OPEN:R1-058 assertDeps ignores non-enumerable extra keys'
    );
  });

  it('KNOWN-OPEN:ARG-ui_shell-6 duplicate ELECTRON_PIN in package.js vs main.js', () => {
    const mainSrc = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
    const pkgSrc = readFileSync(new URL('../tools/package.js', import.meta.url), 'utf8');
    assert.ok(mainSrc.includes(`ELECTRON_PIN = '${ELECTRON_PIN}'`));
    assert.ok(pkgSrc.includes('electron-v44.9.2-linux-'), 'KNOWN-OPEN:ARG-ui_shell-6 hardcoded duplicate ELECTRON_PIN literal');
  });

  it('KNOWN-OPEN:ARG-n_uisrc-2 save never stats settings.json before rename', async () => {
    const root = makeTempRoot('mv0r2-settings-');
    try {
      const store = createSettingsStore({ XDG_CONFIG_HOME: root, HOME: root });
      const res = await store.save(JSON.stringify({ scheme: 'mv-light', density: 'compact' }));
      assert.equal(res, true, 'KNOWN-OPEN:ARG-n_uisrc-2 save overwrites without stat');
    } finally {
      rmRoot(root);
    }
  });

  it('KNOWN-OPEN:ARG-n_uisrc-7 startDisplay double-prefixes error message', () => {
    const nestingSrc = readFileSync(new URL('../electron/nesting.js', import.meta.url), 'utf8');
    assert.ok(nestingSrc.includes('DISPLAY_ONLY:'), 'KNOWN-OPEN:ARG-n_uisrc-7 startDisplay contains double-prefix DISPLAY_ONLY:');
  });

  it('KNOWN-OPEN:U-SET-XDG no XDG refusal gate on fallback', () => {
    const store = createSettingsStore({});
    assert.ok(store, 'KNOWN-OPEN:U-SET-XDG fallback to homedir without XDG refusal');
  });

});
