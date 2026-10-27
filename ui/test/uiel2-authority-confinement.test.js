import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  installAuthorityWire,
  WIRE_CHANNELS,
  createSettingsStore,
  deliverAuthorityFrame,
  verdictReply,
} from '../electron/authorityWire.js';
import { createPreloadFacade, installPreload } from '../electron/preload.js';
import { createLayoutBridge, resolveMainPaths, CHANNELS } from '../electron/main.js';
import { writeManifest, validateOutput, packageShell } from '../tools/package.js';
import { createWallLayout } from '../src/wall/layout.js';

const validKinds = ['desktop_capsule', 'browser', 'game_capsule', 'vm'];

function makeNotice(kind = 'browser', extraRef = {}) {
  return {
    frame_ref: {
      schema: 'frame_ref/v0.2',
      surface_id: 's1',
      generation: 1,
      tick: 1,
      ts_ns: 1,
      width: 1,
      height: 1,
      format: 'rgb24',
      sha256: 'a'.repeat(64),
      capture_us: 1,
      ...extraRef,
    },
    surface: {
      schema: 'surface/v0.2',
      surface_id: 's1',
      kind,
      display: ':1',
      geometry: { w: 1, h: 1 },
      state: 'active',
      visibility: 'unfolded',
      control: 'human',
      profile_id: 'test',
    },
  };
}

function makeDeliverEntry(kind = 'browser', generation = 1) {
  const bytes = new Uint8Array([1, 2, 3]);
  const binding = { principal: 'ui', epoch: 1, surfaceId: 's1', surfaceGeneration: 1 };
  const wirePort = new EventEmitter();
  const messages = [];
  wirePort.postMessage = value => messages.push(value);
  wirePort.start = () => {};
  wirePort.close = () => {};
  const frameRef = {
    schema: 'frame_ref/v0.2',
    surface_id: 's1',
    generation,
    tick: 1,
    ts_ns: 1,
    width: 1,
    height: 1,
    format: 'rgb24',
    ramws_path: '/dev/shm/private.rgb',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    capture_us: 1,
  };
  const entry = {
    frameRef,
    state: {
      schema: 'surface/v0.2',
      surface_id: 's1',
      kind,
      display: ':1',
      geometry: { w: 1, h: 1 },
      state: 'active',
      visibility: 'unfolded',
      control: 'human',
      profile_id: 'test',
    },
    readerOptions: {
      binding,
      limits: { maxFrameBytes: 4096, maxWidth: 64, maxHeight: 64, readTimeoutMs: 1000, maxConcurrentReads: 1 },
      pixelEnvironment: { environmentId: 'test', zoom: 1, dpr: 1 },
      onReleaseLease() {},
      acquirePublishedLease: async () => ({
        identity: { ...binding, frameGeneration: entry.frameRef.generation, leaseId: `lease-${entry.frameRef.generation}` },
        published: true,
        byteLength: 3,
        readOwnedBytes: async () => bytes,
        release: async () => {},
      }),
    },
    portOptions: {
      port: wirePort,
      role: 'sender',
      binding,
      limits: { maxFrameBytes: 4096, ackTimeoutMs: 1000, maxSurfacesPerPort: 1 },
      onReleaseLease() {},
      onRevoke() {},
    },
  };
  return { entry, messages };
}

async function wireFixture(t, env = {}) {
  const root = await mkdtemp(join(tmpdir(), 'uiel2-wire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map();
  const frame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
  const contents = { id: 9, mainFrame: frame, isDestroyed: () => false, postMessage() {} };
  const event = { sender: contents, senderFrame: frame };
  let coreReply = {
    schema: 'action_verdict/v0.2',
    proposal_id: 'p1',
    decision: 'refused',
    reason_code: 'SURFACE_NOT_AGENT_CONTROLLED',
    core_seq: 1,
  };
  const coreCalls = [];
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: channel => handlers.delete(channel),
  };
  const binding = installAuthorityWire({
    ipcMain,
    contents,
    env: { XDG_CONFIG_HOME: root, ...env },
    argv: [],
    core: {
      request: async value => {
        coreCalls.push(value);
        return coreReply;
      },
    },
  });
  t.after(() => binding.dispose());
  const api = createPreloadFacade({
    transport: {
      invoke: (channel, args) => handlers.get(channel)(event, ...args),
      subscribe: () => () => {},
    },
    bridge: { exposeInMainWorld() {} },
  });
  return { root, handlers, event, api, coreCalls, setCoreReply: value => { coreReply = value; } };
}

// Mutation: remove `!['desktop_capsule','browser','game_capsule','vm'].includes(s.kind)` in ui/electron/preload.js (or `state.kind` check in ui/electron/authorityWire.js).
test('U04 valid surface kinds deliver across authority wire and preload; unknown surface kind is refused with zero consumer calls', async t => {
  let listener;
  const delivered = [], closed = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'app://metaviewer' }, postMessage() {} },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  });
  const api = installPreload({
    contextBridge: { exposeInMainWorld() {} },
    ipcRenderer: { invoke: async () => true, on: (_ch, fn) => { listener = fn; }, removeListener() {} },
  });
  t.after(api.authority.subscribeFrames(value => delivered.push(value.surface.kind)));

  for (const kind of validKinds) {
    listener({ ports: [{ close: () => closed.push(kind) }] }, makeNotice(kind));
  }
  assert.deepEqual(delivered, validKinds);
  assert.deepEqual(closed, []);

  for (const badKind of ['__unknown__', '', 'terminal', null, 42]) {
    let portClosed = 0;
    listener({ ports: [{ close: () => { portClosed += 1; } }] }, makeNotice(badKind));
    assert.equal(portClosed, 1, `port must close when kind=${String(badKind)} is dropped`);
  }
  assert.deepEqual(delivered, validKinds, 'unknown surface kind must trigger zero consumer calls');

  const streams = new Set();
  const posted = [];
  const contents = { postMessage: (...args) => posted.push(args) };
  try {
    const good = makeDeliverEntry('desktop_capsule', 1);
    assert.equal(await deliverAuthorityFrame(good.entry, contents, streams), true);
    assert.equal(posted.length, 1);

    const bad = makeDeliverEntry('__unknown__', 2);
    await assert.rejects(deliverAuthorityFrame(bad.entry, contents, streams), /SURFACE_STATE/);
    assert.equal(posted.length, 1);
    assert.equal(bad.messages.length, 0);
  } finally {
    for (const stream of [...streams]) {
      await stream.reader.closeReader();
      stream.port.revokeFramePort('SHUTDOWN');
    }
  }
});

// Mutation: remove `Object.keys(f).sort().join(',')!=='capture_us,format,generation,height,schema,sha256,surface_id,tick,ts_ns,width'` in ui/electron/preload.js.
test('U04 negative control: notice carrying ramws_path is dropped before reaching frame consumers', t => {
  let listener;
  const delivered = [];
  let portClosed = 0;
  const api = createPreloadFacade({
    transport: { invoke: async () => true, subscribe: (_ch, cb) => { listener = cb; return () => {}; } },
    bridge: { exposeInMainWorld() {} },
  });
  const stop = api.authority.subscribeFrames(value => delivered.push(value));
  t.after(stop);
  listener(makeNotice('browser', { ramws_path: '/dev/shm/secret.rgb' }), [{ close: () => { portClosed += 1; } }]);
  assert.deepEqual(delivered, []);
  assert.equal(portClosed, 1);
});

// Mutation: remove `'SURFACE_NOT_AGENT_CONTROLLED'` from the allowed `reason_code` list in `verdictReply` (ui/electron/authorityWire.js) or `wireFacade` (ui/electron/preload.js).
test('U05 SURFACE_NOT_AGENT_CONTROLLED verdict propagates end-to-end through installAuthorityWire propose and preload facade', async t => {
  const f = await wireFixture(t);
  const proposal = JSON.stringify({ schema: 'action_proposal/v0.2', proposal_id: 'p1' });
  const outcome = await f.api.authority.propose(proposal);
  assert.deepEqual(outcome, {
    schema: 'action_verdict/v0.2',
    proposal_id: 'p1',
    decision: 'refused',
    reason_code: 'SURFACE_NOT_AGENT_CONTROLLED',
    core_seq: 1,
  });
  assert.ok(Object.isFrozen(outcome));
  assert.deepEqual(f.coreCalls, [{ op: 'propose', json: proposal }]);
});

// Mutation: remove the `reason_code` allowlist check in `verdictReply` (ui/electron/authorityWire.js) and `wireFacade` (ui/electron/preload.js).
test('U05 negative control: unknown refusal reason_code is rejected with OUTCOME at both authority wire and preload boundaries', async t => {
  const f = await wireFixture(t);
  const badVerdict = {
    schema: 'action_verdict/v0.2',
    proposal_id: 'p1',
    decision: 'refused',
    reason_code: 'UNKNOWN_REASON_CODE',
    core_seq: 1,
  };
  assert.throws(() => verdictReply(badVerdict), /OUTCOME/);
  f.setCoreReply(badVerdict);
  await assert.rejects(f.api.authority.propose('{"proposal_id":"p1"}'), /OUTCOME/);

  const directPreload = createPreloadFacade({
    transport: { invoke: async () => badVerdict, subscribe: () => () => {} },
    bridge: { exposeInMainWorld() {} },
  });
  await assert.rejects(directPreload.authority.propose('{"proposal_id":"p1"}'), /OUTCOME/);
});

// Mutation: omit `await unlink(temp)` in `createSettingsStore.save` finally block in ui/electron/authorityWire.js.
test('U08 write-confinement matrix: every electron fs store writes strictly inside allowed roots and cleans up tmp on crash-mid-rename', async t => {
  const sandbox = await mkdtemp(join(tmpdir(), 'uiel2-confinement-Música-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const xdgConfig = join(sandbox, 'xdg-config');
  const xdgRuntime = join(sandbox, 'xdg-runtime');
  const userData = join(sandbox, 'user-data');
  const pkgOut = join(sandbox, 'pkg-out');
  const bundleRoot = join(sandbox, 'bundle');
  await mkdir(xdgRuntime, { mode: 0o700 });
  await mkdir(join(bundleRoot, 'dist', 'renderer'), { recursive: true });
  await mkdir(join(bundleRoot, 'dist', 'preload'), { recursive: true });
  await writeFile(join(bundleRoot, 'dist', 'preload', 'preload.cjs'), 'preload');

  // 1. Settings store: normal save + simulated crash-mid-rename (target path is a directory so rename throws EISDIR).
  const store = createSettingsStore({ XDG_CONFIG_HOME: xdgConfig });
  const validSettings = JSON.stringify({ scheme: 'mv-dark', density: 'compact' });
  assert.equal(await store.save(validSettings), true);
  const settingsDir = join(xdgConfig, 'metaviewer');
  assert.deepEqual(await readdir(settingsDir), ['settings.json']);

  const crashConfig = join(sandbox, 'xdg-config-crash');
  const crashStore = createSettingsStore({ XDG_CONFIG_HOME: crashConfig });
  await mkdir(join(crashConfig, 'metaviewer', 'settings.json'), { recursive: true, mode: 0o700 });
  await chmod(join(crashConfig, 'metaviewer'), 0o700);
  await assert.rejects(crashStore.save(validSettings));
  assert.deepEqual(
    await readdir(join(crashConfig, 'metaviewer')),
    ['settings.json'],
    'failed rename must unlink temporary .settings-*.tmp file',
  );

  // 2. Runtime directory creation via resolveMainPaths.
  const paths = resolveMainPaths(
    { getAppPath: () => bundleRoot, getPath: name => { assert.equal(name, 'userData'); return userData; } },
    bundleRoot,
    { xdgRuntimeDir: xdgRuntime, uid: process.getuid() },
  );
  assert.equal(paths.runtimeDir, join(xdgRuntime, 'metaviewer'));
  assert.equal((await stat(paths.runtimeDir)).mode & 0o777, 0o700);

  // 3. Layout presentation storage under userData/presentation.
  const bridge = createLayoutBridge({
    app: {
      requestSingleInstanceLock: () => true,
      whenReady: async () => {},
      on() {},
      quit() {},
      getAppPath: () => bundleRoot,
      getPath: name => { assert.equal(name, 'userData'); return userData; },
    },
  });
  const saveLayout = bridge.find(x => x.channel === CHANNELS.save);
  const layoutJson = JSON.stringify(createWallLayout());
  assert.equal(await saveLayout.invoke(saveLayout.decode(layoutJson)), true);
  assert.deepEqual(await readdir(join(userData, 'presentation')), ['layout.json']);
  assert.equal(await readFile(join(userData, 'presentation', 'layout.json'), 'utf8'), layoutJson);

  // 4. Package output and manifest write inside MV_PKG_OUT.
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  assert.equal(validateOutput(pkgOut, repoRoot), pkgOut);
  await assert.rejects(packageShell({ MV_PKG_OUT: pkgOut }), /CAPSULE_UI_KIT_REPO is required/);
  const manifestTarget = join(pkgOut, 'artifact');
  await mkdir(manifestTarget, { recursive: true });
  await writeFile(join(manifestTarget, 'payload.txt'), 'metaviewer');
  await writeManifest(manifestTarget, `${manifestTarget}.sha256`);
  assert.deepEqual((await readdir(pkgOut)).sort(), ['artifact', 'artifact.sha256']);

  // Verify top-level sandbox contains only the declared roots and no stray files.
  assert.deepEqual(
    (await readdir(sandbox)).sort(),
    ['bundle', 'pkg-out', 'user-data', 'xdg-config', 'xdg-config-crash', 'xdg-runtime'],
  );
});

// Mutation: remove `outsideSource(path)` from `createSettingsStore` in ui/electron/authorityWire.js.
test('U08 negative control: XDG_CONFIG_HOME or MV_PKG_OUT inside the repository is refused before any write', async () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  assert.throws(() => createSettingsStore({ XDG_CONFIG_HOME: join(repoRoot, 'ui', 'in-repo-config') }), /SETTINGS_IN_REPO/);
  assert.throws(() => validateOutput(join(repoRoot, 'in-repo-pkg'), repoRoot), /must not overlap/);
  await assert.rejects(packageShell({ MV_PKG_OUT: join(repoRoot, 'in-repo-pkg') }), /must not overlap/);
});
