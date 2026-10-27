// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
  CHANNELS,
  CONTENT_SECURITY_POLICY,
  ELECTRON_PIN,
  MainError,
  PRIVILEGED_ORIGIN,
  decideNavigation,
  handleAppRequest,
  loadMainBindings,
} from '../electron/main.js';
import {
  WIRE_CHANNELS,
  deliverAuthorityFrame,
  installAuthorityWire,
  recordingDestination,
} from '../electron/authorityWire.js';
import {
  FRAME_DIAG_FILE,
  installFrameDiag,
  resolveFrameDiagConfig,
  validateFrameDiagPreload,
  writeFrameDiagSnapshot,
} from '../electron/frameDiag.js';
import { createMainBindings } from '../electron/hostBindings.js';
import { createPreloadFacade } from '../electron/preload.js';

const surface = {
  schema: 'surface/v0.2',
  surface_id: 's1',
  kind: 'browser',
  display: ':1',
  geometry: { w: 2, h: 2 },
  state: 'active',
  visibility: 'unfolded',
  control: 'human',
  profile_id: 'test',
};

const validNotice = {
  surface,
  frame_ref: {
    schema: 'frame_ref/v0.2',
    surface_id: 's1',
    generation: 5,
    tick: 1,
    ts_ns: 1,
    width: 2,
    height: 2,
    format: 'rgb24',
    sha256: 'a'.repeat(64),
    capture_us: 1,
  },
};

test('L11-1: missing or invalid MV_RECORDING_DESTINATION fails closed with typed SETTINGS_DESTINATION naming the env var and leaking no path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mv-rv9-l11-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);

  const missingDir = join(root, 'does-not-exist-secret-dir');
  const fileTarget = join(root, 'not-a-dir.txt');
  await writeFile(fileTarget, 'hello', { mode: 0o600 });
  const validDir = join(root, 'valid-recordings');
  await mkdir(validDir, { mode: 0o700 });

  for (const badPath of [missingDir, fileTarget, 'relative/secret-dir']) {
    assert.throws(
      () => recordingDestination({ MV_RECORDING_DESTINATION: badPath }),
      (/** @type {any} */ err) => {
        assert.ok(err instanceof MainError, `expected MainError, got ${err}`);
        assert.equal(err.code, 'SETTINGS_DESTINATION');
        assert.match(err.message, /MV_RECORDING_DESTINATION/);
        assert.equal(err.message.includes(badPath), false, 'must not leak path in error message');
        return true;
      },
    );
  }

  const repoPath = fileURLToPath(new URL('../', import.meta.url));
  assert.throws(
    () => recordingDestination({ MV_RECORDING_DESTINATION: repoPath }),
    (/** @type {any} */ err) => {
      assert.ok(err instanceof MainError);
      assert.equal(err.code, 'SETTINGS_IN_REPO');
      assert.match(err.message, /MV_RECORDING_DESTINATION/);
      assert.equal(err.message.includes(repoPath), false, 'must not leak repo path');
      return true;
    },
  );

  // Set up a live core socket fixture to verify createMainBindings and loadMainBindings propagate the typed error.
  const rtDir = join(root, 'rt');
  await mkdir(join(rtDir, 'metaviewer'), { recursive: true, mode: 0o700 });
  await chmod(rtDir, 0o700);
  await chmod(join(rtDir, 'metaviewer'), 0o700);
  const reg = (/** @type {string} */ component) => ({
    endpoint: { component, instance: `${component}-1` },
    hello: {
      schema: 'hello/v0.2',
      contract_version: 'v0.2',
      component,
      component_version: '0.1.2',
      component_commit: 'a'.repeat(40),
      dependencies: [],
    },
  });
  const config = { session_id: 'rv9-l11', core: reg('core'), peers: [reg('ui')] };
  const configPath = join(root, 'core-config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const env = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (env.body?.schema === 'hello/v0.2') {
          socket.write(
            `${JSON.stringify({
              schema: 'envelope/v0.2',
              msg_id: 'm-1',
              ts_ns: 0,
              from: config.core.endpoint,
              to: config.peers[0].endpoint,
              session_id: config.session_id,
              seq: 1,
              nonce: 'n-1',
              body: config.core.hello,
            })}\n`,
          );
        }
      }
    });
  });
  const sockPath = join(rtDir, 'metaviewer/core.sock');
  server.listen(sockPath);
  await once(server, 'listening');
  await chmod(sockPath, 0o600);
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const createMessageChannel = () => ({ port1: { close() {} }, port2: { close() {} } });
  const baseEnv = { MV_CORE_CONFIG: configPath, XDG_RUNTIME_DIR: rtDir };

  await assert.rejects(
    () => createMainBindings({ env: { ...baseEnv, MV_RECORDING_DESTINATION: missingDir }, createMessageChannel }),
    (/** @type {any} */ err) => {
      assert.ok(err instanceof MainError);
      assert.equal(err.code, 'SETTINGS_DESTINATION');
      assert.match(err.message, /MV_RECORDING_DESTINATION/);
      assert.equal(err.message.includes(missingDir), false);
      return true;
    },
  );

  await assert.rejects(
    () => loadMainBindings({ ...baseEnv, MV_RECORDING_DESTINATION: missingDir }, { createMessageChannel }),
    (/** @type {any} */ err) => {
      assert.ok(err instanceof MainError);
      assert.equal(err.code, 'SETTINGS_DESTINATION');
      assert.notEqual(err.code, 'CORE_SEAMS_ABSENT');
      assert.match(err.message, /MV_RECORDING_DESTINATION/);
      assert.equal(err.message.includes(missingDir), false);
      return true;
    },
  );

  // Negative control: valid existing directory succeeds and connects cleanly.
  assert.equal(recordingDestination({ MV_RECORDING_DESTINATION: validDir }), validDir);
  const okBindings = await loadMainBindings(
    { ...baseEnv, MV_RECORDING_DESTINATION: validDir },
    { createMessageChannel },
  );
  t.after(() => okBindings.core.dispose());
  assert.equal((await okBindings.core.start()).availability, 'live');
});

test('frameDiag coalesces rapid writes', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'mv-rv9-diag-coalesce-'));
  await chmod(runDir, 0o700);
  const originalRename = fsPromises.rename;
  let renameCount = 0;
  /** @type {(() => void) | null} */
  let releaseGate = null;
  /** @type {Promise<void> | null} */
  let gatePromise = null;

  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(runDir, { recursive: true, force: true });
  });

  t.mock.method(fsPromises, 'rename', async (...args) => {
    if (gatePromise) {
      await gatePromise;
    }
    renameCount += 1;
    return originalRename(...args);
  });
  syncBuiltinESMExports();

  const diag = installFrameDiag({
    ipcMain: { handle() {}, removeHandler() {} },
    contents: {},
    env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: runDir },
    runDir,
  });
  t.after(() => diag.dispose());

  for (let i = 1; i <= 5; i += 1) {
    diag.recordDelivery({
      surfaceId: 's1',
      surfaceGeneration: 1,
      frameGeneration: i,
      epoch: 1,
      announced: i === 1,
    });
  }
  await diag.flush();

  assert.ok(renameCount <= 2, `expected <= 2 writes after 5 rapid recordDelivery calls, got ${renameCount}`);
  const persisted = JSON.parse(await readFile(join(runDir, FRAME_DIAG_FILE), 'utf8'));
  assert.equal(persisted.main.deliveriesPosted, 5);
  assert.equal(persisted.main.lastDelivery.frameGeneration, 5);

  // Post-dispose check: a batch queued while a write is in flight must not write after dispose().
  gatePromise = new Promise((resolve) => {
    releaseGate = resolve;
  });
  diag.recordDelivery({ surfaceId: 's1', surfaceGeneration: 1, frameGeneration: 6, epoch: 1 });
  // Wait a microtask so write #6 enters rename (in flight) and clears pendingBatch.
  await new Promise((resolve) => setImmediate(resolve));
  // Queue #7 and #8 while #6 is blocked in rename, then call dispose() before releasing #6.
  diag.recordDelivery({ surfaceId: 's1', surfaceGeneration: 1, frameGeneration: 7, epoch: 1 });
  diag.recordDelivery({ surfaceId: 's1', surfaceGeneration: 1, frameGeneration: 8, epoch: 1 });
  const disposePromise = diag.dispose();
  gatePromise = null;
  releaseGate?.();
  await disposePromise;

  const afterDispose = JSON.parse(await readFile(join(runDir, FRAME_DIAG_FILE), 'utf8'));
  assert.equal(
    afterDispose.main.lastDelivery.frameGeneration,
    6,
    'queued batch behind in-flight write must be cancelled once dispose() is called',
  );
});

test('navigation keeps refusing residual percent escapes (strict bundled app policy)', async (t) => {
  assert.equal(decideNavigation('app://metaviewer/assets/foo%25bar.png'), 'deny');
  assert.equal(decideNavigation('app://metaviewer/assets/100%25zoom.png'), 'deny');
  assert.equal(decideNavigation('app://metaviewer/assets/foo.png'), 'allow');
  assert.equal(decideNavigation('app://metaviewer/assets/a%25%25b'), 'deny');

  // A literal '%' filename is never served: bundled assets never contain '%'.
  const root = await mkdtemp(join(tmpdir(), 'mv-rv9-nav-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rendererRoot = join(root, 'dist', 'renderer');
  await mkdir(join(rendererRoot, 'assets'), { recursive: true });
  await writeFile(join(rendererRoot, 'assets', 'foo%bar.png'), 'PNGDATA');

  const okRes = await handleAppRequest(
    rendererRoot,
    { url: `${PRIVILEGED_ORIGIN}/assets/foo%25bar.png` },
    { styleNonce: false },
  );
  assert.notEqual(okRes.status, 200);

  // Negative controls: multi-encoded traversal spellings remain denied.
  for (const badUrl of [
    `${PRIVILEGED_ORIGIN}/%252e%252e/secret`,
    `${PRIVILEGED_ORIGIN}/%25252e%25252e/secret`,
    `${PRIVILEGED_ORIGIN}/a%252fb/secret`,
    `${PRIVILEGED_ORIGIN}/a%255cb/secret`,
    `${PRIVILEGED_ORIGIN}/%2500/secret`,
    `${PRIVILEGED_ORIGIN}/%25zz/app.js`,
    `${PRIVILEGED_ORIGIN}/assets/a%25%25b`,
  ]) {
    assert.equal(decideNavigation(badUrl), 'deny', `must deny ${badUrl}`);
    const badRes = await handleAppRequest(rendererRoot, { url: badUrl }, { styleNonce: false });
    assert.equal(badRes.status, 403, `expected 403 for ${badUrl}`);
  }
});

test('preload diag records forwarded frame_port/v1 surface_generation in lastSurfaceGeneration and frame_ref.generation in lastFrameGeneration', (t) => {
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let wallPresent = false;
  /** @type {any[]} */
  const postedMessages = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { origin: PRIVILEGED_ORIGIN },
      postMessage: (/** @type {any[]} */ ...args) => postedMessages.push(args),
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      getElementById: (/** @type {string} */ id) => (id === 'metaviewer-app' && wallPresent ? {} : null),
    },
  });
  t.after(() => {
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else delete (/** @type {any} */ (globalThis)).window;
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete (/** @type {any} */ (globalThis)).document;
  });

  /** @type {any[]} */
  const diagPayloads = [];
  /** @type {((value: any, ports?: any[]) => void) | null} */
  let frameListener = null;
  const api = createPreloadFacade({
    transport: {
      frameDiag: true,
      invoke: async (channel, args) => {
        if (channel === 'metaviewer:frame.diag') {
          diagPayloads.push(args[0]);
        }
        return true;
      },
      subscribe: (_channel, cb) => {
        frameListener = cb;
        return () => {};
      },
    },
    bridge: { exposeInMainWorld() {} },
  });

  const unsub = api.authority.subscribeFrames(() => {});
  try {
    assert.ok(frameListener);
    // Negative control 1: without a forwarded frame_port/v1 notice (no ports), lastSurfaceGeneration stays null
    // while lastFrameGeneration records frame_ref.generation (5).
    frameListener(validNotice, []);
    assert.equal(diagPayloads.length, 1);
    assert.equal(diagPayloads[0].framesReceived, 1);
    assert.equal(diagPayloads[0].lastSurfaceId, 's1');
    assert.equal(diagPayloads[0].lastSurfaceGeneration, null);
    assert.equal(diagPayloads[0].lastFrameGeneration, 5);

    // Negative control 2: legacy schemaless notice when #metaviewer-app is absent does not set lastSurfaceGeneration.
    frameListener(
      { ...validNotice, frame_ref: { ...validNotice.frame_ref, generation: 2 } },
      [{ close() {} }],
    );
    assert.equal(diagPayloads.length, 2);
    assert.equal(diagPayloads[1].legacyNoticesForwarded, 1);
    assert.equal(diagPayloads[1].noticesForwarded, 0);
    assert.equal(diagPayloads[1].lastSurfaceGeneration, null);
    assert.equal(diagPayloads[1].lastFrameGeneration, 2);

    // Positive: forwarding a frame_port/v1 notice in the wall app records its surface_generation (1),
    // and subsequent frames (2, 3) without ports advance lastFrameGeneration while preserving lastSurfaceGeneration (1).
    wallPresent = true;
    const port1 = { close() {} };
    frameListener(
      { ...validNotice, frame_ref: { ...validNotice.frame_ref, generation: 1 } },
      [port1],
    );
    assert.equal(diagPayloads.length, 3);
    assert.equal(diagPayloads[2].noticesForwarded, 1);
    assert.equal(diagPayloads[2].lastSurfaceGeneration, 1);
    assert.equal(diagPayloads[2].lastFrameGeneration, 1);

    frameListener(
      { ...validNotice, frame_ref: { ...validNotice.frame_ref, generation: 2 } },
      [],
    );
    frameListener(
      { ...validNotice, frame_ref: { ...validNotice.frame_ref, generation: 3 } },
      [],
    );
    assert.equal(diagPayloads.length, 5);
    assert.equal(diagPayloads[4].noticesForwarded, 1);
    assert.equal(diagPayloads[4].lastSurfaceGeneration, 1);
    assert.equal(diagPayloads[4].lastFrameGeneration, 3);
    const validated = validateFrameDiagPreload(diagPayloads[4]);
    assert.equal(validated.lastSurfaceGeneration, 1);
    assert.equal(validated.lastFrameGeneration, 3);

    // Negative control 3: generation 0 is rejected by validFrameNotice, increments invalidNotices,
    // and preserves both lastSurfaceGeneration (1) and lastFrameGeneration (3); validateFrameDiagPreload also rejects lastFrameGeneration: 0.
    frameListener(
      {
        ...validNotice,
        frame_ref: { ...validNotice.frame_ref, generation: 0 },
      },
      [],
    );
    assert.equal(diagPayloads.length, 6);
    assert.equal(diagPayloads[5].invalidNotices, 1);
    assert.equal(diagPayloads[5].framesReceived, 5);
    assert.equal(diagPayloads[5].lastSurfaceGeneration, 1);
    assert.equal(diagPayloads[5].lastFrameGeneration, 3);
    assert.throws(
      () => validateFrameDiagPreload({ ...diagPayloads[4], lastFrameGeneration: 0 }),
      { code: 'FRAME_DIAG_PAYLOAD' },
    );
  } finally {
    unsub();
  }
});

test('writeFrameDiagSnapshot preserves MainError when cleanup unlink fails', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'mv-rv9-unlink-'));
  await chmod(runDir, 0o700);
  const targetPath = join(runDir, FRAME_DIAG_FILE);
  const originalLstat = fsPromises.lstat;
  const originalUnlink = fsPromises.unlink;
  let targetStatCount = 0;

  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(runDir, { recursive: true, force: true });
  });

  t.mock.method(fsPromises, 'lstat', async (path, ...rest) => {
    const st = await originalLstat(path, ...rest);
    if (path === targetPath) {
      targetStatCount += 1;
      // Post-write verification stat is the first existing stat on targetPath after rename.
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { mode: 0o100644 });
    }
    return st;
  });
  t.mock.method(fsPromises, 'unlink', async (path, ...rest) => {
    await originalUnlink(path, ...rest).catch(() => {});
    const err = /** @type {NodeJS.ErrnoException} */ (new Error('unlink EACCES'));
    err.code = 'EACCES';
    throw err;
  });
  syncBuiltinESMExports();

  await assert.rejects(
    () => writeFrameDiagSnapshot(runDir, { schema: 'frame_diag/v1', seq: 1 }),
    (/** @type {any} */ err) => {
      assert.ok(err instanceof MainError, `expected MainError, got ${err}`);
      assert.equal(err.code, 'FRAME_DIAG_WRITE');
      return true;
    },
  );
  assert.ok(targetStatCount >= 1);
});

test('stateOnly destroyed revokes all matching streams despite one close failure', async () => {
  /** @type {string[]} */
  const revoked = [];
  /** @type {any[]} */
  const posted = [];
  const streams = new Set([
    {
      key: JSON.stringify(['ui', 1, 's1', 1]),
      surfaceId: 's1',
      reader: {
        closeReader: async () => {
          throw new Error('close boom');
        },
      },
      port: {
        revokeFramePort: (/** @type {string} */ reason) => {
          revoked.push(`s1-g1:${reason}`);
        },
      },
    },
    {
      key: JSON.stringify(['ui', 1, 's1', 2]),
      surfaceId: 's1',
      reader: {
        closeReader: async () => {},
      },
      port: {
        revokeFramePort: (/** @type {string} */ reason) => {
          revoked.push(`s1-g2:${reason}`);
        },
      },
    },
    {
      key: 'not-json',
      surfaceId: 's2',
      reader: {
        closeReader: async () => {},
      },
      port: {
        revokeFramePort: (/** @type {string} */ reason) => {
          revoked.push(`s2:${reason}`);
        },
      },
    },
  ]);

  const ok = await deliverAuthorityFrame(
    {
      stateOnly: true,
      frameRef: validNotice.frame_ref,
      state: { ...surface, surface_id: 's1', state: 'destroyed' },
    },
    {
      postMessage: (/** @type {any[]} */ ...args) => {
        posted.push(args);
      },
    },
    streams,
  );

  assert.equal(ok, true);
  assert.deepEqual(revoked, ['s1-g1:SHUTDOWN', 's1-g2:SHUTDOWN']);
  assert.equal(posted.length, 1);
  assert.equal(streams.size, 1, 'negative control: non-matching s2 stream with non-JSON key survives');
});

test('frame diag timer cancelled on unsubscribe', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  let diagInvokes = 0;
  /** @type {((value: any, ports?: any[]) => void) | null} */
  let frameListener = null;
  const api = createPreloadFacade({
    transport: {
      frameDiag: true,
      invoke: async (channel) => {
        if (channel === 'metaviewer:frame.diag') {
          diagInvokes += 1;
        }
        return true;
      },
      subscribe: (_channel, cb) => {
        frameListener = cb;
        return () => {};
      },
    },
    bridge: { exposeInMainWorld() {} },
  });

  // Negative control: while subscribed, advancing 250ms fires the delayed diag report.
  const unsub1 = api.authority.subscribeFrames(() => {});
  assert.ok(frameListener);
  frameListener(validNotice, []);
  assert.equal(diagInvokes, 1);
  t.mock.timers.tick(250);
  assert.equal(diagInvokes, 2, 'negative control: active subscription fires 250ms delayed diag');
  unsub1();

  // After unsubscribe, advancing 250ms must NOT fire an extra frame.diag invoke.
  diagInvokes = 0;
  const unsub2 = api.authority.subscribeFrames(() => {});
  frameListener(validNotice, []);
  assert.equal(diagInvokes, 1);
  unsub2();
  t.mock.timers.tick(250);
  assert.equal(diagInvokes, 1, 'unsubscribed listener must cancel pending diagTimer');
});

test('preload diag tolerates non-conforming surface ids', () => {
  /** @type {any[]} */
  const diagPayloads = [];
  /** @type {((value: any, ports?: any[]) => void) | null} */
  let frameListener = null;
  const api = createPreloadFacade({
    transport: {
      frameDiag: true,
      invoke: async (channel, args) => {
        if (channel === 'metaviewer:frame.diag') {
          diagPayloads.push(args[0]);
        }
        return true;
      },
      subscribe: (_channel, cb) => {
        frameListener = cb;
        return () => {};
      },
    },
    bridge: { exposeInMainWorld() {} },
  });

  const unsub = api.authority.subscribeFrames(() => {});
  try {
    assert.ok(frameListener);
    frameListener(
      {
        surface: { ...surface, surface_id: 'bad id!' },
        frame_ref: { ...validNotice.frame_ref, surface_id: 'bad id!' },
      },
      [],
    );
    assert.equal(diagPayloads.length, 1, 'non-conforming surface_id must not blind preload diag');
    assert.equal(diagPayloads[0].lastSurfaceId, null);

    // Negative control: conforming surface_id is preserved.
    frameListener(
      {
        surface: { ...surface, surface_id: 'good-s1' },
        frame_ref: { ...validNotice.frame_ref, surface_id: 'good-s1' },
      },
      [],
    );
    assert.equal(diagPayloads.length, 2);
    assert.equal(diagPayloads[1].lastSurfaceId, 'good-s1');
  } finally {
    unsub();
  }
});

test('authority onRevoke never emits unhandledRejection', async (t) => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const binding = { principal: 'ui', epoch: 1, surfaceId: 's1', surfaceGeneration: 1 };
  const wirePort = new EventEmitter();
  wirePort.postMessage = () => {};
  wirePort.start = () => {};
  wirePort.close = () => {};

  const streams = new Set();
  let revokedCount = 0;
  const entry = {
    frameRef: { ...validNotice.frame_ref, generation: 1, ramws_path: '/dev/shm/private.rgb', sha256 },
    state: surface,
    readerOptions: {
      binding,
      limits: { maxFrameBytes: 4096, maxWidth: 64, maxHeight: 64, readTimeoutMs: 1000, maxConcurrentReads: 1 },
      pixelEnvironment: { environmentId: 'test', zoom: 1, dpr: 1 },
      onReleaseLease() {},
      acquirePublishedLease: async () => ({
        identity: { ...binding, frameGeneration: 1, leaseId: 'lease-1' },
        published: true,
        byteLength: 12,
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
      onRevoke() {
        revokedCount += 1;
      },
    },
  };

  assert.equal(await deliverAuthorityFrame(entry, { postMessage() {} }, streams), true);
  assert.equal(streams.size, 1);
  const [stream] = [...streams];
  t.mock.method(Promise, 'allSettled', () => Promise.reject(new Error('onRevoke close boom')));

  /** @type {unknown[]} */
  const unhandled = [];
  const onUnhandled = (/** @type {unknown} */ err) => {
    unhandled.push(err);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    stream.port.revokeFramePort('SHUTDOWN');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(revokedCount, 1);
    assert.equal(unhandled.length, 0, `expected 0 unhandledRejection, got ${unhandled.length}`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    t.mock.restoreAll();
  }
});

test('authority dispose revokes all streams despite one close failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mv-rv9-dispose-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const handlers = new Map();
  /** @type {string[]} */
  const removedChannels = [];
  let terminalDisposed = 0;
  /** @type {string[]} */
  const revoked = [];
  /** @type {((entry: any) => Promise<void>) | null} */
  let deliverEntry = null;

  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false, postMessage() {} };
  const event = { sender: contents, senderFrame: frame };
  const ipcMain = {
    handle: (/** @type {string} */ ch, /** @type {Function} */ fn) => handlers.set(ch, fn),
    removeHandler: (/** @type {string} */ ch) => {
      removedChannels.push(ch);
      handlers.delete(ch);
    },
  };

  const wire = installAuthorityWire({
    ipcMain,
    contents,
    core: { request: async () => true },
    env: { XDG_CONFIG_HOME: root },
    argv: [],
    frames: {
      subscribe: (/** @type {(entry: any) => Promise<void>} */ cb) => {
        deliverEntry = cb;
        return () => {};
      },
    },
    terminal: {
      setEnabled: async () => true,
      open: async () => ({ session: 's1' }),
      dispose: () => {
        terminalDisposed += 1;
      },
    },
  });

  await handlers.get(WIRE_CHANNELS.subscribeFrames)(event);
  assert.ok(deliverEntry);

  for (const sid of ['s1', 's2']) {
    const binding = { principal: 'ui', epoch: 1, surfaceId: sid, surfaceGeneration: 1 };
    const wirePort = new EventEmitter();
    wirePort.postMessage = () => {};
    wirePort.start = () => {};
    wirePort.close = () => {};
    await deliverEntry({
      frameRef: { ...validNotice.frame_ref, surface_id: sid, generation: 1, ramws_path: '/dev/shm/private.rgb', sha256 },
      state: { ...surface, surface_id: sid },
      readerOptions: {
        binding,
        limits: { maxFrameBytes: 4096, maxWidth: 64, maxHeight: 64, readTimeoutMs: 1000, maxConcurrentReads: 1 },
        pixelEnvironment: { environmentId: 'test', zoom: 1, dpr: 1 },
        onReleaseLease() {},
        acquirePublishedLease: async () => ({
          identity: { ...binding, frameGeneration: 1, leaseId: `lease-${sid}` },
          published: true,
          byteLength: 12,
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
        onRevoke(/** @type {any} */ notice) {
          revoked.push(`${sid}:${notice.reason}`);
        },
      },
    });
  }

  const origAllSettled = Promise.allSettled.bind(Promise);
  let closeCalls = 0;
  t.mock.method(Promise, 'allSettled', (/** @type {any} */ items) => {
    closeCalls += 1;
    if (closeCalls === 1) {
      return Promise.reject(new Error('dispose close boom'));
    }
    return origAllSettled(items);
  });

  try {
    await wire.dispose();
  } finally {
    t.mock.restoreAll();
  }
  assert.deepEqual(revoked, ['s1:SHUTDOWN', 's2:SHUTDOWN']);
  assert.equal(terminalDisposed, 1);
  assert.equal(removedChannels.length, Object.keys(WIRE_CHANNELS).length);
  assert.equal(handlers.size, 0);
});

test('RV9-07 non-defect lock: resolveFrameDiagConfig disables only on --nested-depth=1 while retail/nestedIdentity refuse invalid depths', () => {
  assert.equal(resolveFrameDiagConfig({ argv: ['--nested-depth=1'], env: { MV_FRAME_DIAG: '1' } }).enabled, false);
  assert.throws(() => resolveFrameDiagConfig({ env: { MV_FRAME_DIAG: '1' }, packaged: true }), { code: 'RETAIL_ENV' });
});
