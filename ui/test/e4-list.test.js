// @ts-check
/**
 * E4-LIST: packaged profile picker identity listing parity with the Identities dialog.
 *
 * Exercises the real bootProductionMain wiring against a staged packaged layout
 * (<resources>/operator/tools/mv_identity.py and <resources>/app.asar/dist/renderer)
 * with fake native binaries in a temporary directory and no MV_MW_HOME in the launcher
 * environment. Never reads identity-store contents. Includes a mutant restoring the
 * pre-fix main.js listIdentities wiring that bypassed identityEnvironment/resolveIdentityTool.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHANNELS, ELECTRON_PIN, PRIVILEGED_ORIGIN, resolveIdentityTool } from '../electron/main.js';
import { WIRE_CHANNELS } from '../electron/authorityWire.js';
import { createRefusalReason } from '../electron/profilePicker.js';

const REPO_TOOL = fileURLToPath(new URL('../../tools/mv_identity.py', import.meta.url));
const MAIN_URL = new URL('../electron/main.js', import.meta.url);
const MAIN_PATH = fileURLToPath(MAIN_URL);

// Fake native CLI: never reads or writes identity-store file contents.
// `create` touches an empty 0600 marker file at metadata/<id>.json so `mv_identity.py list`
// discovers the id stem by globbing metadata/*.json; `show` checks only path existence and
// emits synthetic public metadata JSON on stdout.
const FAKE_NATIVE_ADMIN = String.raw`#!/usr/bin/env python3
import json, sys
from pathlib import Path

args = sys.argv[1:]
def arg(flag):
    idx = args.index(flag)
    return args[idx + 1]

verb = args[0]
root = Path(arg('--store-root'))
identity = arg('--id')
meta = root / 'metadata' / (identity + '.json')

if verb == 'create':
    for name in ('metadata', 'profiles', 'locks'):
        (root / name).mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    if meta.exists():
        sys.exit(4)
    meta.touch(mode=0o600)
    meta.chmod(0o600)
    (root / 'profiles' / identity).mkdir(mode=0o700, exist_ok=True)
    (root / 'profiles' / identity).chmod(0o700)
elif verb == 'show':
    if not meta.is_file():
        sys.exit(4)
else:
    sys.exit(2)

print(json.dumps({
    'profile_id': identity,
    'browser': 'chromium',
    'account_label': 'Account ' + identity,
    'allowed_domains': ['example.test'],
    'created_unix': 1,
}))
`;

const PROFILES_FOUR = JSON.stringify({
  'mv-live-1': { Kind: 'browser', Width: 1280, Height: 900 },
  'mv-live-2': { Kind: 'browser', Width: 1280, Height: 900 },
  'mv-live-3': { Kind: 'browser', Width: 1280, Height: 900 },
  'mv-live-4': { Kind: 'browser', Width: 1280, Height: 900 },
});

/**
 * Import main.js (or a source-mutated copy) from a temp module wired to sibling electron modules.
 * @param {string} baseDir
 * @param {string | null} [from]
 * @param {string} [to]
 */
async function importMainModule(baseDir, from = null, to = '') {
  let src = await readFile(MAIN_PATH, 'utf8');
  if (from !== null) {
    assert.equal(src.split(from).length, 2, 'mutant anchor must occur once in ui/electron/main.js');
    const mutated = src.replace(from, () => to);
    assert.notEqual(mutated, src, 'mutant must change ui/electron/main.js');
    src = mutated;
  }
  const electronDirHref = new URL('../electron/', import.meta.url).href;
  src = src
    .replaceAll('import.meta.url', JSON.stringify(MAIN_URL.href))
    .replaceAll("from './", `from '${electronDirHref}`)
    .replaceAll("import('./", `import('${electronDirHref}`);
  const file = join(baseDir, `main-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(file, src, { mode: 0o600 });
  return import(pathToFileURL(file).href);
}

/**
 * Build a packaged fixture with staged resources/operator/tools/mv_identity.py, fake native
 * binaries, and the 3 initial identities (cuentas-1, mv-live-1, perplexity-1; no mv-live-2..4).
 * @param {string} baseDir
 * @param {{stageBundledTool?: boolean}} [options]
 */
async function createPackagedFixture(baseDir, options = {}) {
  const stageBundledTool = options.stageBundledTool ?? true;
  const resources = join(baseDir, 'resources');
  const appRoot = join(resources, 'app.asar');
  const rendererRoot = join(appRoot, 'dist', 'renderer');
  const preloadDir = join(appRoot, 'dist', 'preload');
  const stagedToolDir = join(resources, 'operator', 'tools');
  const stagedTool = join(stagedToolDir, 'mv_identity.py');
  const operatorRepo = join(baseDir, 'operator-repo');
  const binDir = join(baseDir, 'bin');
  const stateDir = join(baseDir, 'srf-state');
  const storeRoot = join(baseDir, 'srf-store');
  const xdg = join(baseDir, 'xdg');
  const home = join(baseDir, 'home');

  await mkdir(rendererRoot, { recursive: true });
  await mkdir(preloadDir, { recursive: true });
  await writeFile(join(rendererRoot, 'index.html'), '<!doctype html><title>MetaViewer</title>');
  await writeFile(join(preloadDir, 'preload.cjs'), '"use strict";\n');

  for (const d of [binDir, stateDir, storeRoot, xdg, home]) {
    await mkdir(d, { recursive: true, mode: 0o700 });
    await chmod(d, 0o700);
  }
  await writeFile(join(binDir, 'srf-identity-admin'), FAKE_NATIVE_ADMIN, { mode: 0o700 });
  await writeFile(join(binDir, 'srf-identity-surface'), FAKE_NATIVE_ADMIN, { mode: 0o700 });

  if (stageBundledTool) {
    await mkdir(stagedToolDir, { recursive: true, mode: 0o700 });
    await copyFile(REPO_TOOL, stagedTool);
    await chmod(stagedTool, 0o700);
  } else {
    await mkdir(join(operatorRepo, 'tools'), { recursive: true, mode: 0o700 });
    await copyFile(REPO_TOOL, join(operatorRepo, 'tools', 'mv_identity.py'));
    await chmod(join(operatorRepo, 'tools', 'mv_identity.py'), 0o700);
  }

  /** @param {string} id */
  const seedIdentity = (id) => {
    const res = spawnSync(
      'python3',
      [
        join(binDir, 'srf-identity-admin'),
        'create',
        '--store-root',
        storeRoot,
        '--id',
        id,
        '--label',
        `Account ${id}`,
        '--domains',
        'example.test',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(res.status, 0, res.stderr);
  };

  for (const id of ['cuentas-1', 'mv-live-1', 'perplexity-1']) {
    seedIdentity(id);
  }

  // Launcher-like environment: MV_MW_HOME is intentionally absent.
  /** @type {Record<string, string>} */
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: baseDir,
    XDG_RUNTIME_DIR: xdg,
    MV_SRF_BIN_DIR: binDir,
    MV_SRF_STATE_DIR: stateDir,
    SRF_IDENTITY_STORE_ROOT: storeRoot,
    MV_SRF_LIVE_PROFILE: 'mv-live-1',
    MV_SRF_PROFILES: PROFILES_FOUR,
    ...(stageBundledTool ? {} : { MV_OPERATOR_REPO: operatorRepo }),
  };

  /** @type {Map<string, Function>} */
  const ipcHandlers = new Map();
  /** @type {Array<any>} */
  const coreCreateRequests = [];
  const webContents = {
    id: 7,
    mainFrame: {
      url: `${PRIVILEGED_ORIGIN}/index.html`,
      origin: PRIVILEGED_ORIGIN,
      parent: null,
      routingId: 10,
      processId: 20,
    },
    isDestroyed: () => false,
    session: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} },
    setWindowOpenHandler: () => {},
    on: () => {},
    setUserAgent: () => {},
    loadURL: async () => {},
    send: () => {},
    postMessage: () => {},
  };
  class StubWindow {
    constructor() {
      this.webContents = webContents;
    }
    once() {}
    show() {}
    hide() {}
    destroy() {}
  }
  const coreStatus = {
    availability: /** @type {const} */ ('live'),
    pid: 4141,
    authority_epoch: 1,
    reason: null,
  };
  const adapterStatus = {
    availability: /** @type {const} */ ('live'),
    handshakeSeen: true,
    code: 'ADAPTER_LIVE',
    reason: null,
  };
  const handles = {
    app: {
      isPackaged: true,
      requestSingleInstanceLock: () => true,
      whenReady: async () => {},
      on: () => {},
      quit: () => {},
      getAppPath: () => appRoot,
      getPath: () => join(baseDir, 'user-data'),
    },
    BrowserWindow: StubWindow,
    ipcMain: {
      handle: (/** @type {string} */ channel, /** @type {Function} */ fn) => {
        ipcHandlers.set(channel, fn);
      },
      removeHandler: (/** @type {string} */ channel) => {
        ipcHandlers.delete(channel);
      },
    },
    protocol: {
      registerSchemesAsPrivileged: () => {},
      handle: () => {},
      unhandle: () => {},
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => {},
      },
    },
    electronVersion: ELECTRON_PIN,
    shellRoot: appRoot,
    argv: ['metaviewer'],
    env,
    runtime: {
      xdgRuntimeDir: xdg,
      uid: typeof process.getuid === 'function' ? process.getuid() : 1000,
    },
    core: {
      start: async () => coreStatus,
      request: async (/** @type {any} */ req) => {
        if (req?.op === 'create') {
          coreCreateRequests.push(req);
          return {
            schema: 'surface_event/v0.2',
            event: 'created',
            data: {
              surface: {
                schema: 'surface/v0.2',
                surface_id: `surface-${req.params.profile_id}`,
                profile_id: req.params.profile_id,
                kind: 'browser',
                state: 'active',
              },
            },
          };
        }
        return { ok: true };
      },
      dispose: async () => {},
      getStatus: () => coreStatus,
    },
    adapter: {
      start: async () => adapterStatus,
      dispose: async () => {},
      getStatus: () => adapterStatus,
    },
    bridge: [
      { channel: CHANNELS.load, decode: () => null, invoke: async () => null },
      { channel: CHANNELS.save, decode: (/** @type {unknown} */ v) => v, invoke: async () => true },
    ],
    geometry: { width: 1280, height: 720 },
  };
  const senderEvent = {
    sender: webContents,
    senderFrame: webContents.mainFrame,
  };

  return {
    resources,
    rendererRoot,
    stagedTool,
    handles,
    ipcHandlers,
    senderEvent,
    coreCreateRequests,
    seedIdentity,
  };
}

test('E4-LIST packaged path: picker lists staged identities without MV_MW_HOME, refuses missing mv-live-2 with NO_IDENTITY, and opens a capsule once mv-live-2 is provisioned', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'mv-e4list-Música-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const fx = await createPackagedFixture(join(base, 'pkg'));
  assert.equal(
    resolveIdentityTool({ packaged: true, resourcesPath: undefined, rendererRoot: fx.rendererRoot }),
    fx.stagedTool,
    'packaged tool resolves to <resources>/operator/tools/mv_identity.py',
  );

  const stderrLines = /** @type {string[]} */ ([]);
  const origConsoleError = console.error;
  console.error = (...args) => {
    stderrLines.push(args.map(String).join(' '));
  };

  try {
    const mainMod = await importMainModule(base);
    const boot = await mainMod.bootProductionMain(/** @type {any} */ (fx.handles));
    try {
      // Boot auto-create claims mv-live-1.
      assert.equal(fx.coreCreateRequests.length, 1);
      assert.equal(fx.coreCreateRequests[0].params.profile_id, 'mv-live-1');

      // 1. Identities dialog IPC channel lists the 3 seeded identities.
      const dialogList = await fx.ipcHandlers.get('metaviewer:identity.list')?.(fx.senderEvent);
      assert.equal(dialogList?.ok, true);
      assert.deepEqual(
        dialogList.rows.map((/** @type {any} */ r) => r.id),
        ['cuentas-1', 'mv-live-1', 'perplexity-1'],
      );

      // 2. Profile picker createSurface uses the same working identity-runner path and returns NO_IDENTITY naming mv-live-2.
      stderrLines.length = 0;
      const refused = await fx.ipcHandlers.get(WIRE_CHANNELS.createSurface)?.(fx.senderEvent);
      assert.deepEqual(refused, { ok: false, code: 'NO_IDENTITY' });
      assert.equal(fx.coreCreateRequests.length, 1, 'no second capsule created when mv-live-2..4 are unprovisioned');
      assert.equal(stderrLines.length, 1);
      assert.equal(
        stderrLines[0],
        `[metaviewer] create refused NO_IDENTITY: ${createRefusalReason('NO_IDENTITY', 'mv-live-2')}`,
      );

      // 3. Provisioning mv-live-2 lets the next createSurface open a capsule on mv-live-2.
      fx.seedIdentity('mv-live-2');
      stderrLines.length = 0;
      const created = await fx.ipcHandlers.get(WIRE_CHANNELS.createSurface)?.(fx.senderEvent);
      assert.deepEqual(created, { ok: true });
      assert.equal(stderrLines.length, 0);
      assert.equal(fx.coreCreateRequests.length, 2);
      assert.equal(fx.coreCreateRequests[1].params.profile_id, 'mv-live-2');
    } finally {
      await boot.dispose();
    }
  } finally {
    console.error = origConsoleError;
  }
});

test('E4-LIST packaged MV_OPERATOR_REPO fallback: picker resolves the checkout tool when bundled resources/operator/tools/mv_identity.py is absent', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'mv-e4list-fallback-Música-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const fx = await createPackagedFixture(join(base, 'fallback'), { stageBundledTool: false });
  const mainMod = await importMainModule(base);
  const boot = await mainMod.bootProductionMain(/** @type {any} */ (fx.handles));
  try {
    const refused = await fx.ipcHandlers.get(WIRE_CHANNELS.createSurface)?.(fx.senderEvent);
    assert.deepEqual(refused, { ok: false, code: 'NO_IDENTITY' });

    fx.seedIdentity('mv-live-2');
    const created = await fx.ipcHandlers.get(WIRE_CHANNELS.createSurface)?.(fx.senderEvent);
    assert.deepEqual(created, { ok: true });
    assert.equal(fx.coreCreateRequests.at(-1)?.params.profile_id, 'mv-live-2');
  } finally {
    await boot.dispose();
  }
});

test('E4-LIST mutant: restoring the pre-fix main.js listIdentities wiring (missing identityEnvironment / resolveOperatorIdentityTool) fails with IDENTITY_LIST_UNAVAILABLE', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'mv-e4list-mutant-Música-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const fx = await createPackagedFixture(join(base, 'mut'));
  const fixedBlock = [
    "      listIdentities: () => (import('./operatorBridge.js')).then(({identityEnvironment, identityRunner, resolveIdentityTool: resolveOperatorIdentityTool}) => {",
    '        const env = /** @type {NodeJS.ProcessEnv} */ (typed.env);',
    '        const resolved = resolveOperatorIdentityTool({',
    '          tool: resolveIdentityTool({ packaged: packagedLaunch, resourcesPath: process.resourcesPath, rendererRoot: paths.rendererRoot }),',
    '          env,',
    '        });',
    "        return identityRunner({ tool: resolved, env: identityEnvironment(env, resolved) })('list', {});",
    '      }),',
  ].join('\n');
  const preFixMutant = [
    "      listIdentities: () => (import('./operatorBridge.js')).then(({identityRunner}) =>",
    "        identityRunner({tool:resolveIdentityTool({ packaged: packagedLaunch, resourcesPath: process.resourcesPath, rendererRoot: paths.rendererRoot }),env:typed.env})('list', {})),",
  ].join('\n');

  const stderrLines = /** @type {string[]} */ ([]);
  const origConsoleError = console.error;
  console.error = (...args) => {
    stderrLines.push(args.map(String).join(' '));
  };

  try {
    const mutatedMain = await importMainModule(base, fixedBlock, preFixMutant);
    const boot = await mutatedMain.bootProductionMain(/** @type {any} */ (fx.handles));
    try {
      // Even under the mutant, the Identities dialog path works because installOperatorBridge applies identityEnvironment.
      const dialogList = await fx.ipcHandlers.get('metaviewer:identity.list')?.(fx.senderEvent);
      assert.equal(dialogList?.ok, true);
      assert.deepEqual(
        dialogList.rows.map((/** @type {any} */ r) => r.id),
        ['cuentas-1', 'mv-live-1', 'perplexity-1'],
      );

      // The picker path under the mutant fails with IDENTITY_LIST_UNAVAILABLE (reproducing P11g e4list_live.log).
      stderrLines.length = 0;
      const mutantReply = await fx.ipcHandlers.get(WIRE_CHANNELS.createSurface)?.(fx.senderEvent);
      assert.deepEqual(mutantReply, { ok: false, code: 'IDENTITY_LIST_UNAVAILABLE' });
      assert.equal(
        stderrLines[0],
        `[metaviewer] create refused IDENTITY_LIST_UNAVAILABLE: ${createRefusalReason('IDENTITY_LIST_UNAVAILABLE')}`,
      );
      assert.throws(
        () => assert.deepEqual(mutantReply, { ok: false, code: 'NO_IDENTITY' }),
        assert.AssertionError,
        'Mutant killed: restoring the pre-fix listIdentities wiring fails the NO_IDENTITY assertion',
      );
    } finally {
      await boot.dispose();
    }

    // Mutant B: drop identityEnvironment(env, resolved) only -> packaged launch without MV_MW_HOME fails with IDENTITY_LIST_UNAVAILABLE.
    const fxNoEnv = await createPackagedFixture(join(base, 'mut-no-env'));
    const mutatedNoEnv = await importMainModule(
      base,
      "return identityRunner({ tool: resolved, env: identityEnvironment(env, resolved) })('list', {});",
      "return identityRunner({ tool: resolved, env })('list', {});",
    );
    const bootNoEnv = await mutatedNoEnv.bootProductionMain(/** @type {any} */ (fxNoEnv.handles));
    try {
      const noEnvReply = await fxNoEnv.ipcHandlers.get(WIRE_CHANNELS.createSurface)?.(fxNoEnv.senderEvent);
      assert.deepEqual(noEnvReply, { ok: false, code: 'IDENTITY_LIST_UNAVAILABLE' });
      assert.throws(
        () => assert.deepEqual(noEnvReply, { ok: false, code: 'NO_IDENTITY' }),
        assert.AssertionError,
        'Mutant B killed: dropping identityEnvironment fails with IDENTITY_LIST_UNAVAILABLE',
      );
    } finally {
      await bootNoEnv.dispose();
    }

    // Mutant C: drop resolveOperatorIdentityTool fallback only -> MV_OPERATOR_REPO fallback fails with IDENTITY_LIST_UNAVAILABLE.
    const fxNoFallback = await createPackagedFixture(join(base, 'mut-no-fallback'), { stageBundledTool: false });
    const mutatedNoFallback = await importMainModule(
      base,
      [
        '        const resolved = resolveOperatorIdentityTool({',
        '          tool: resolveIdentityTool({ packaged: packagedLaunch, resourcesPath: process.resourcesPath, rendererRoot: paths.rendererRoot }),',
        '          env,',
        '        });',
      ].join('\n'),
      '        const resolved = resolveIdentityTool({ packaged: packagedLaunch, resourcesPath: process.resourcesPath, rendererRoot: paths.rendererRoot });',
    );
    const bootNoFallback = await mutatedNoFallback.bootProductionMain(/** @type {any} */ (fxNoFallback.handles));
    try {
      const noFallbackReply = await fxNoFallback.ipcHandlers.get(WIRE_CHANNELS.createSurface)?.(fxNoFallback.senderEvent);
      assert.deepEqual(noFallbackReply, { ok: false, code: 'IDENTITY_LIST_UNAVAILABLE' });
      assert.throws(
        () => assert.deepEqual(noFallbackReply, { ok: false, code: 'NO_IDENTITY' }),
        assert.AssertionError,
        'Mutant C killed: dropping resolveOperatorIdentityTool fails MV_OPERATOR_REPO fallback',
      );
    } finally {
      await bootNoFallback.dispose();
    }
  } finally {
    console.error = origConsoleError;
  }
});
