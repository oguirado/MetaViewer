// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { findForbiddenEnv } from '../electron/coreLauncher.js';
import { observeSender, ELECTRON_PIN, PRIVILEGED_ORIGIN } from '../electron/main.js';
import {
  createSettingsStore,
  mapSurfaceInputRefusal,
  SURFACE_INPUT_CODES,
} from '../electron/authorityWire.js';
import { createPreloadFacade } from '../electron/preload.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * @param {string} prefix
 * @returns {string}
 */
function makeTempRoot(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test('R1-055: findForbiddenEnv flags forbidden env names regardless of value type and stays total', () => {
  const envWithMixedTypes = {
    PATH: '/usr/bin',
    MV_OK: '1',
    LD_PRELOAD: '/lib/malicious.so',
    NODE_OPTIONS: /** @type {any} */ (12345),
    ELECTRON_RUN_AS_NODE: /** @type {any} */ (null),
    PYTHONPATH: /** @type {any} */ (undefined),
    BASH_ENV: /** @type {any} */ ({ nested: true }),
  };

  const forbidden = findForbiddenEnv(envWithMixedTypes);
  assert.deepEqual(forbidden, [
    'LD_PRELOAD',
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
    'PYTHONPATH',
    'BASH_ENV',
  ]);
  assert.equal(Object.isFrozen(forbidden), true);

  // Negative controls: allowed names pass and malformed env records return frozen []
  assert.deepEqual(findForbiddenEnv({ PATH: '/usr/bin', MV_OK: 'true' }), []);
  for (const malformed of [null, undefined, 42, 'env', ['LD_PRELOAD']]) {
    const res = findForbiddenEnv(malformed);
    assert.deepEqual(res, []);
    assert.equal(Object.isFrozen(res), true);
  }
});

test('R1-056: observeSender refuses missing, non-function, throwing, or non-false isDestroyed and admits live sender', () => {
  const frame = {
    origin: PRIVILEGED_ORIGIN,
    url: `${PRIVILEGED_ORIGIN}/index.html`,
    detached: false,
  };

  // Missing isDestroyed refuses with SENDER
  const missingIsDestroyed = {
    id: 1,
    getURL() {
      return `${PRIVILEGED_ORIGIN}/index.html`;
    },
    mainFrame: frame,
  };
  assert.deepEqual(
    observeSender({ sender: missingIsDestroyed, senderFrame: frame }, missingIsDestroyed, PRIVILEGED_ORIGIN),
    { verdict: 'refuse', code: 'SENDER' },
  );

  // Non-function isDestroyed refuses with SENDER
  for (const badVal of [false, true, null, undefined, 0, 'false', {}]) {
    const nonFn = { id: 1, mainFrame: frame, isDestroyed: badVal };
    assert.deepEqual(
      observeSender({ sender: nonFn, senderFrame: frame }, nonFn, PRIVILEGED_ORIGIN),
      { verdict: 'refuse', code: 'SENDER' },
    );
  }

  // Non-false return from isDestroyed() refuses with SENDER
  for (const retVal of [true, 1, 0, null, undefined, 'false', {}]) {
    const nonFalse = { id: 1, mainFrame: frame, isDestroyed: () => retVal };
    assert.deepEqual(
      observeSender({ sender: nonFalse, senderFrame: frame }, nonFalse, PRIVILEGED_ORIGIN),
      { verdict: 'refuse', code: 'SENDER' },
    );
  }

  // Throwing isDestroyed getter or call refuses with SENDER and snapshots once
  let getterReads = 0;
  const singleSnapshotSender = {
    id: 1,
    mainFrame: frame,
    get isDestroyed() {
      getterReads += 1;
      return () => false;
    },
  };
  const snapVerdict = observeSender(
    { sender: singleSnapshotSender, senderFrame: frame },
    singleSnapshotSender,
    PRIVILEGED_ORIGIN,
  );
  assert.equal(snapVerdict.verdict, 'admit');
  assert.equal(getterReads, 1);
});

test('ARG-ui_shell-6: package.json electron version matches ELECTRON_PIN constant', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const version = pkg.dependencies?.electron || pkg.devDependencies?.electron;
  assert.equal(version, ELECTRON_PIN, 'package.json electron dependency must match ELECTRON_PIN');
});

test('ARG-n_uisrc-2: createSettingsStore.save refuses symlink destination before rename and leaves target intact', async () => {
  const root = makeTempRoot('uiel-arg2-');
  try {
    const configDir = join(root, 'config');
    const mvDir = join(configDir, 'metaviewer');
    await mkdir(mvDir, { recursive: true, mode: 0o700 });
    await chmod(mvDir, 0o700);

    const victimFile = join(root, 'victim.txt');
    await writeFile(victimFile, 'ORIGINAL_VICTIM_CONTENT', { mode: 0o600 });

    const settingsPath = join(mvDir, 'settings.json');
    await symlink(victimFile, settingsPath);
    assert.equal(lstatSync(settingsPath).isSymbolicLink(), true);

    const store = createSettingsStore({ XDG_CONFIG_HOME: configDir });
    const validJson = JSON.stringify({ scheme: 'mv-light', density: 'compact' });

    await assert.rejects(async () => store.save(validJson), /SETTINGS_FILE/);
    assert.equal(readFileSync(victimFile, 'utf8'), 'ORIGINAL_VICTIM_CONTENT');
    assert.equal(lstatSync(settingsPath).isSymbolicLink(), true);
    assert.deepEqual(readdirSync(mvDir), ['settings.json']);

    // Negative control: after removing the symlink, initial save (ENOENT) and overwrite save succeed
    await rm(settingsPath);
    assert.equal(await store.save(validJson), true);
    assert.equal(await store.load(), validJson);
    const updatedJson = JSON.stringify({ scheme: 'mv-dark', density: 'compact' });
    assert.equal(await store.save(updatedJson), true);
    assert.equal(await store.load(), updatedJson);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('U05: SURFACE_NOT_AGENT_CONTROLLED maps to NOT_IN_CONTROL and SURFACE_INPUT_CODES stays in parity with preload', async () => {
  assert.equal(mapSurfaceInputRefusal('SURFACE_NOT_AGENT_CONTROLLED'), 'NOT_IN_CONTROL');
  assert.deepEqual(SURFACE_INPUT_CODES, [
    'NOT_IN_CONTROL',
    'SURFACE_UNKNOWN',
    'STALE_STREAM',
    'LIMIT',
    'NESTED_DISPLAY_ONLY',
    'SCHEMA',
    'CORE_UNAVAILABLE',
  ]);
  assert.equal(Object.isFrozen(SURFACE_INPUT_CODES), true);

  let nextReply = /** @type {any} */ ({ ok: false, code: 'NOT_IN_CONTROL' });
  const api = createPreloadFacade({
    transport: {
      nested: false,
      invoke: async () => nextReply,
      subscribe: () => () => {},
    },
    bridge: { exposeInMainWorld() {} },
  });

  let seq = 1;
  for (const code of SURFACE_INPUT_CODES) {
    nextReply = { ok: false, code };
    const out = await api.input.send({
      schema: 'surface_input/v1',
      surface_id: 'surf-parity',
      stream_id: 1,
      seq: seq++,
      events: [{ kind: 'click', x: 1, y: 1, button: 'left' }],
    });
    assert.deepEqual(out, { ok: false, code });
  }

  // Unmapped raw reason code is rejected by preload's closed INPUT_REFUSAL_CODES set and coerced to CORE_UNAVAILABLE
  nextReply = { ok: false, code: 'SURFACE_NOT_AGENT_CONTROLLED' };
  const unmapped = await api.input.send({
    schema: 'surface_input/v1',
    surface_id: 'surf-parity',
    stream_id: 1,
    seq: seq++,
    events: [{ kind: 'click', x: 1, y: 1, button: 'left' }],
  });
  assert.deepEqual(unmapped, { ok: false, code: 'CORE_UNAVAILABLE' });
});

test('U08: settings write confinement prevents writing into source tree via explicit repo root', () => {
  assert.throws(() => createSettingsStore({ XDG_CONFIG_HOME: REPO_ROOT }), /SETTINGS_IN_REPO/);
  assert.throws(
    () => createSettingsStore({ XDG_CONFIG_HOME: join(REPO_ROOT, 'ui') }),
    /SETTINGS_IN_REPO/,
  );
});
