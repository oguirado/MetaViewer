// @ts-check
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { constants as fsConstants } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { Socket, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deliverAuthorityFrame, installAuthorityWire } from '../electron/authorityWire.js';
import { FRAME_DIAG_ACQUIRE_CAUSES, installFrameDiag } from '../electron/frameDiag.js';
import { ACQUIRE_CAUSE_CODES } from '../electron/frameReader.js';
import { createMainBindings } from '../electron/hostBindings.js';
import { PRIVILEGED_ORIGIN } from '../electron/main.js';

const STEP_TIMEOUT_MS = 5000;

/** @type {Map<string, Set<Socket>>} */
const clientSocketsByPath = new Map();
const origSocketConnect = Socket.prototype.connect;
Socket.prototype.connect = function patchedConnect(...args) {
  const first = args[0];
  const targetPath =
    typeof first === 'string'
      ? first
      : first && typeof first === 'object' && !Array.isArray(first) && typeof (/** @type {any} */ (first).path) === 'string'
        ? /** @type {any} */ (first).path
        : Array.isArray(first) && first[0] && typeof first[0].path === 'string'
          ? first[0].path
          : null;
  if (targetPath && clientSocketsByPath.has(targetPath)) {
    const set = clientSocketsByPath.get(targetPath);
    set?.add(this);
    this.once('close', () => set?.delete(this));
  }
  return origSocketConnect.apply(this, /** @type {any} */ (args));
};

/**
 * Bounds a promise with a deterministic timeout that fails the test with a clear message.
 * @template T
 * @param {Promise<T>} promise
 * @param {string} label
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
async function withTimeout(promise, label, timeoutMs = STEP_TIMEOUT_MS) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms awaiting ${label}`));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Polls predicate until truthy or rejects after timeoutMs with a clear message.
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {string} [label]
 * @param {number} [timeoutMs]
 */
async function waitFor(predicate, label = 'condition', timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await withTimeout(Promise.resolve().then(() => predicate()), `waitFor(${label}) predicate`, timeoutMs)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
}

function fakePort() {
  const port = new EventEmitter();
  /** @type {any[]} */
  port.messages = [];
  let peer = null;
  port.connect = (other) => {
    peer = other;
  };
  port.start = () => {};
  port.close = () => {
    port.closed = true;
    port.emit('close');
  };
  port.postMessage = (message) => {
    port.messages.push(message);
    if (peer && !peer.closed) {
      queueMicrotask(() => peer.emit('message', message));
    }
  };
  return port;
}

function fakeChannel() {
  const port1 = fakePort();
  const port2 = fakePort();
  port1.connect(port2);
  port2.connect(port1);
  return { port1, port2 };
}

/**
 * Mirrors daemon-adapter/internal/frames/publisher.go file lifecycle:
 * writes <32-hex>.rgb.tmp with O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW (0600),
 * hardlinks to <32-hex>.rgb, unlinks .tmp, and evicts refs[0] when ring full.
 * @param {string} outputDir
 * @param {number} maxRetained
 */
function createRotatingPublisher(outputDir, maxRetained = 2) {
  /** @type {Array<{generation: number, path: string}>} */
  const refs = [];
  let nextGen = 0;
  return {
    async publish(surfaceId, width, height, rgbByte) {
      return withTimeout(
        (async () => {
          const raw = Buffer.alloc(width * height * 3, rgbByte & 0xff);
          const sha256 = createHash('sha256').update(raw).digest('hex');
          const name = `${randomBytes(16).toString('hex')}.rgb`;
          const tempPath = join(outputDir, `${name}.tmp`);
          const finalPath = join(outputDir, name);
          const fh = await open(
            tempPath,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
            0o600,
          );
          try {
            await fh.writeFile(raw);
          } finally {
            await fh.close();
          }
          await link(tempPath, finalPath);
          await unlink(tempPath);
          while (refs.length >= maxRetained) {
            const expired = refs.shift();
            if (expired) {
              await unlink(expired.path);
            }
          }
          nextGen += 1;
          refs.push({ generation: nextGen, path: finalPath });
          return {
            schema: 'frame_ref/v0.2',
            surface_id: surfaceId,
            generation: nextGen,
            tick: nextGen,
            ts_ns: nextGen * 1000,
            width,
            height,
            format: 'rgb24',
            ramws_path: finalPath,
            sha256,
            capture_us: 100,
          };
        })(),
        `publish(${surfaceId}, gen=${nextGen + 1})`,
      );
    },
  };
}

async function createCoreHarness(t) {
  const root = await withTimeout(mkdtemp(join(tmpdir(), 'mv-w3-acq-')), 'mkdtemp root');
  const shmDir = await withTimeout(mkdtemp('/dev/shm/mv-w3-acq-'), 'mkdtemp shmDir');
  await withTimeout(chmod(root, 0o700), 'chmod root');
  await withTimeout(chmod(shmDir, 0o700), 'chmod shmDir');
  const runtimeDir = join(root, 'rt');
  const mvDir = join(runtimeDir, 'metaviewer');
  const diagDir = join(root, 'diag');
  await withTimeout(mkdir(runtimeDir, { mode: 0o700 }), 'mkdir runtimeDir');
  await withTimeout(mkdir(mvDir, { mode: 0o700 }), 'mkdir mvDir');
  await withTimeout(mkdir(diagDir, { mode: 0o700 }), 'mkdir diagDir');

  const config = {
    session_id: 'session-w3-acq',
    core: {
      endpoint: { component: 'core', instance: 'core-1' },
      hello: {
        schema: 'hello/v0.2',
        contract_version: 'v0.2',
        component: 'core',
        component_version: '0.1.0',
        component_commit: 'a'.repeat(40),
        dependencies: [],
      },
    },
    peers: [
      {
        endpoint: { component: 'ui', instance: 'ui-1' },
        hello: {
          schema: 'hello/v0.2',
          contract_version: 'v0.2',
          component: 'ui',
          component_version: '0.1.0',
          component_commit: 'b'.repeat(40),
          dependencies: [],
        },
      },
    ],
  };
  const configPath = join(root, 'core-config.json');
  await withTimeout(writeFile(configPath, JSON.stringify(config), { mode: 0o600 }), 'writeFile core-config.json');

  const socketPath = join(mvDir, 'core.sock');
  /** @type {Set<Socket>} */
  const acceptedSockets = new Set();
  /** @type {Set<Socket>} */
  const clientSockets = new Set();
  clientSocketsByPath.set(socketPath, clientSockets);
  /** @type {Array<() => void | Promise<void>>} */
  const cleanups = [];
  /** @type {Socket | null} */
  let activeSocket = null;
  let helloExchanged = false;
  let closing = false;
  let seq = 0;

  const server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      socket.unref?.();
      return;
    }
    acceptedSockets.add(socket);
    activeSocket = socket;
    socket.on('close', () => acceptedSockets.delete(socket));
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const env = JSON.parse(line);
        if (env.body?.schema === 'hello/v0.2') {
          send(config.core.hello);
          helloExchanged = true;
        }
      }
    });
  });

  function send(body) {
    assert.ok(activeSocket && !activeSocket.destroyed, 'expected active core socket');
    seq += 1;
    const env = {
      schema: 'envelope/v0.2',
      msg_id: `m-${seq}`,
      ts_ns: seq,
      from: config.core.endpoint,
      to: config.peers[0].endpoint,
      session_id: config.session_id,
      seq,
      nonce: `n-${seq}`,
      body,
    };
    activeSocket.write(`${JSON.stringify(env)}\n`);
  }

  /** @param {() => void | Promise<void>} fn */
  function registerCleanup(fn) {
    cleanups.push(fn);
  }

  /** @type {Promise<void> | null} */
  let cleanupPromise = null;
  async function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      closing = true;
      while (cleanups.length > 0) {
        const fn = cleanups.pop();
        if (fn) {
          try {
            await withTimeout(Promise.resolve().then(() => fn()), 'harness registered cleanup');
          } catch {
            // Continue tearing down sockets and temp directories even if a disposable throws.
          }
        }
      }
      for (const cs of clientSockets) {
        cs.destroy();
        cs.unref?.();
      }
      clientSockets.clear();
      for (const as of acceptedSockets) {
        as.destroy();
        as.unref?.();
      }
      acceptedSockets.clear();
      if (server.listening) {
        await withTimeout(
          new Promise((resolve) => server.close(() => resolve(null))),
          'core server.close',
        );
      }
      server.unref?.();
      await withTimeout(
        unlink(socketPath).catch((err) => {
          if (err?.code !== 'ENOENT') throw err;
        }),
        'unlink core.sock',
      );
      clientSocketsByPath.delete(socketPath);
      await withTimeout(rm(shmDir, { recursive: true, force: true }), 'rm shmDir');
      await withTimeout(rm(root, { recursive: true, force: true }), 'rm root');
    })();
    return cleanupPromise;
  }

  t.after(() => cleanup());

  await withTimeout(
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve(null);
      });
    }),
    'core server.listen',
  );
  await withTimeout(chmod(socketPath, 0o600), 'chmod core.sock');
  const { ino } = await withTimeout(lstat(socketPath), 'lstat core.sock');

  return {
    root,
    shmDir,
    diagDir,
    socketPath,
    env: {
      MV_CORE_CONFIG: configPath,
      XDG_RUNTIME_DIR: runtimeDir,
      MV_FRAME_DIAG: '1',
      MV_FRAME_DIAG_DIR: diagDir,
    },
    send,
    registerCleanup,
    cleanup,
    async waitForReady(bindings) {
      registerCleanup(() => bindings.core.dispose());
      await waitFor(
        () =>
          helloExchanged &&
          activeSocket !== null &&
          !activeSocket.destroyed &&
          bindings.core.getStatus().availability === 'live',
        'core hello handshake and live bindings availability',
      );
    },
    getPeerCredentials: () => ({
      pid: process.pid,
      uid: process.getuid ? process.getuid() : 0,
      gid: process.getgid ? process.getgid() : 0,
      ino,
    }),
  };
}

const surfaceState = {
  schema: 'surface/v0.2',
  surface_id: 's1',
  kind: 'desktop_capsule',
  display: ':99',
  geometry: { w: 2, h: 2 },
  state: 'active',
  visibility: 'unfolded',
  control: 'human',
  profile_id: 'default',
};

test('W3-FRAME-ACQUIRE: rotating publisher lifecycle delivers generations >= 2 without reader refusals, while legacy uncoalesced publish fails with OPEN_ENOENT', async (t) => {
  // Negative control for bounded await helpers: a never-resolving await fails fast with a clear message.
  await assert.rejects(
    withTimeout(new Promise(() => {}), 'injected never-resolving await', 40),
    /Timed out after 40ms awaiting injected never-resolving await/,
  );

  const harness = await createCoreHarness(t);
  /** @type {Array<{port1: any, port2: any}>} */
  const channels = [];
  harness.registerCleanup(() => {
    for (const ch of channels) {
      ch.port1.close();
      ch.port2.close();
    }
  });
  const bindings = await withTimeout(
    createMainBindings({
      env: harness.env,
      getPeerCredentials: harness.getPeerCredentials,
      createMessageChannel: () => {
        const ch = fakeChannel();
        channels.push(ch);
        return ch;
      },
    }),
    'createMainBindings',
  );
  await harness.waitForReady(bindings);

  const ipcHandlers = new Map();
  const ipcMain = {
    handle(channel, fn) {
      ipcHandlers.set(channel, fn);
    },
    removeHandler(channel) {
      ipcHandlers.delete(channel);
    },
  };
  const postedNotices = [];
  const senderFrame = {
    routingId: 1,
    origin: PRIVILEGED_ORIGIN,
    url: `${PRIVILEGED_ORIGIN}/index.html`,
    parent: null,
  };
  const contents = {
    id: 1,
    mainFrame: senderFrame,
    isDestroyed: () => false,
    getURL: () => `${PRIVILEGED_ORIGIN}/index.html`,
    postMessage: (channel, msg, transfer) => {
      postedNotices.push({ channel, msg, transfer });
    },
  };
  const frameDiag = installFrameDiag({
    ipcMain,
    contents,
    env: harness.env,
    runDir: harness.diagDir,
  });
  harness.registerCleanup(() => frameDiag.dispose());

  const wire = installAuthorityWire({
    ipcMain,
    contents,
    core: bindings.core,
    env: harness.env,
    frames: bindings.wire.frames,
    frameDiag,
  });
  harness.registerCleanup(() => wire.dispose());

  const senderEvent = {
    sender: contents,
    senderFrame,
  };
  await withTimeout(
    ipcHandlers.get('metaviewer:authority.subscribe')(senderEvent),
    'metaviewer:authority.subscribe',
  );

  const pub = createRotatingPublisher(harness.shmDir, 2);
  harness.send({
    schema: 'surface_event/v0.2',
    event: 'created',
    data: { surface: surfaceState },
  });

  // Generation 1 published and delivered.
  const ref1 = await pub.publish('s1', 2, 2, 0x11);
  harness.send({
    schema: 'surface_event/v0.2',
    event: 'frame_ready',
    data: { frame_ref: ref1 },
  });

  await waitFor(() => frameDiag.getSnapshot().main.deliveriesPosted >= 1, 'gen 1 delivery posted');
  const senderPort = channels[0].port1;
  const rendererPort = channels[0].port2;
  const ackDelivery = (delivery) => {
    rendererPort.postMessage({
      schema: 'frame_ack/v0.2',
      kind: 'ack',
      correlation: delivery.correlation,
      principal: delivery.principal,
      epoch: delivery.epoch,
      surfaceId: delivery.surfaceId,
      surfaceGeneration: delivery.surfaceGeneration,
      frameGeneration: delivery.frameGeneration,
      leaseId: delivery.leaseId,
      outcome: 'PRESENTED',
    });
  };
  rendererPort.on('message', (data) => {
    if (data?.kind === 'frame') {
      ackDelivery(data);
    }
  });
  ackDelivery(senderPort.messages[0]);

  // Burst rotation: generations 2, 3, 4 are published by the 2-slot rotating
  // publisher (unlinking gen 1 and gen 2 before main finishes draining),
  // followed by sequential generations 5 and 6.
  const ref2 = await pub.publish('s1', 2, 2, 0x22);
  const ref3 = await pub.publish('s1', 2, 2, 0x33);
  const ref4 = await pub.publish('s1', 2, 2, 0x44); // unlinks ref2!
  harness.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: ref2 } });
  harness.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: ref3 } });
  harness.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: ref4 } });

  await waitFor(() => frameDiag.getSnapshot().main.lastDelivery?.frameGeneration === 4, 'gen 4 delivered');

  const ref5 = await pub.publish('s1', 2, 2, 0x55);
  harness.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: ref5 } });
  await waitFor(() => frameDiag.getSnapshot().main.lastDelivery?.frameGeneration === 5, 'gen 5 delivered');

  const ref6 = await pub.publish('s1', 2, 2, 0x66);
  harness.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: ref6 } });
  await waitFor(() => frameDiag.getSnapshot().main.lastDelivery?.frameGeneration === 6, 'gen 6 delivered');

  const snap = frameDiag.getSnapshot();
  assert.equal(snap.main.deliveriesRefusedByReader, 0, `expected 0 reader refusals, got ${JSON.stringify(snap.main)}`);
  assert.equal(snap.main.lastReaderRefusal, null);
  assert.equal(snap.main.lastDelivery.frameGeneration, 6);
  assert.ok(snap.main.deliveriesPosted >= 4);

  // NEGATIVE CONTROL: pre-fix uncoalesced publish() captures the first frame (ref2)
  // in its closure and drops ref3/ref4 while delivering is busy; when the 2-slot
  // publisher has rotated out ref2, the real hostBindings acquirePublishedLease
  // fails with OPEN_ENOENT.
  const negHarness = await createCoreHarness(t);
  harness.registerCleanup(() => negHarness.cleanup());
  const negBindings = await withTimeout(
    createMainBindings({
      env: negHarness.env,
      getPeerCredentials: negHarness.getPeerCredentials,
      createMessageChannel: fakeChannel,
    }),
    'createMainBindings (negative control)',
  );
  await negHarness.waitForReady(negBindings);

  let capturedRef2Entry = null;
  /** @type {((entry: any) => void) | null} */
  let resolveRef2Entry = null;
  const ref2EntryPromise = new Promise((resolve) => {
    resolveRef2Entry = resolve;
  });
  negBindings.wire.frames.subscribe((entry) => {
    if (entry.frameRef.generation === 2) {
      capturedRef2Entry = entry;
      resolveRef2Entry?.(entry);
    }
  });
  negHarness.send({
    schema: 'surface_event/v0.2',
    event: 'created',
    data: { surface: surfaceState },
  });
  const negPub = createRotatingPublisher(negHarness.shmDir, 2);
  const negRef1 = await negPub.publish('s1', 2, 2, 0x11);
  const negRef2 = await negPub.publish('s1', 2, 2, 0x22);
  negHarness.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: negRef1 } });
  negHarness.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: negRef2 } });
  await withTimeout(ref2EntryPromise, 'ref2EntryPromise (negative control generation 2)');
  assert.ok(capturedRef2Entry, 'expected real hostBindings entry for generation 2');

  // Publisher advances to generation 3 and 4 with 2-slot retention, unlinking negRef2 from /dev/shm.
  await negPub.publish('s1', 2, 2, 0x33);
  await negPub.publish('s1', 2, 2, 0x44);

  const negDiagDir = await withTimeout(mkdtemp(join(negHarness.root, 'neg-diag-')), 'mkdtemp negDiagDir');
  await withTimeout(chmod(negDiagDir, 0o700), 'chmod negDiagDir');
  const negDiag = installFrameDiag({
    ipcMain: { handle() {}, removeHandler() {} },
    contents,
    env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: negDiagDir },
    runDir: negDiagDir,
  });
  negHarness.registerCleanup(() => negDiag.dispose());

  const negStreams = new Set();
  try {
    const ok = await withTimeout(
      deliverAuthorityFrame(capturedRef2Entry, contents, negStreams, negDiag),
      'deliverAuthorityFrame (negative control)',
    );
    assert.equal(ok, false, 'negative control must refuse unlinked generation 2');
    const negSnap = negDiag.getSnapshot();
    assert.equal(negSnap.main.deliveriesRefusedByReader, 1);
    assert.deepEqual(negSnap.main.lastReaderRefusal, {
      surfaceId: 's1',
      frameGeneration: 2,
      reason: 'IO_ERROR',
      detail: 'acquire-failed',
      cause: ACQUIRE_CAUSE_CODES.OPEN_ENOENT,
    });
    assert.equal(negSnap.main.readerRefusalsByCause.OPEN_ENOENT, 1);
  } finally {
    for (const s of negStreams) {
      await withTimeout(s.reader.closeReader(), 'closeReader (negative control)');
      s.port.revokeFramePort('SHUTDOWN');
    }
  }
});

test('W3-FRAME-ACQUIRE: hostBindings and frameDiag classify every acquire check failure with a typed cause code and zero paths or bytes', async (t) => {
  const harness = await createCoreHarness(t);
  const bindings = await withTimeout(
    createMainBindings({
      env: harness.env,
      getPeerCredentials: harness.getPeerCredentials,
      createMessageChannel: fakeChannel,
    }),
    'createMainBindings',
  );
  await harness.waitForReady(bindings);

  let latestEntry = null;
  /** @type {((entry: any) => void) | null} */
  let resolveEntry = null;
  bindings.wire.frames.subscribe((entry) => {
    latestEntry = entry;
    resolveEntry?.(entry);
  });

  harness.send({
    schema: 'surface_event/v0.2',
    event: 'created',
    data: { surface: surfaceState },
  });

  const framePath = join(harness.shmDir, 'cause-probe.rgb');
  const rawBytes = Buffer.alloc(12, 0x7a);
  const sha = createHash('sha256').update(rawBytes).digest('hex');
  await withTimeout(writeFile(framePath, rawBytes, { mode: 0o600 }), 'writeFile cause-probe.rgb');
  await withTimeout(chmod(framePath, 0o600), 'chmod cause-probe.rgb');

  const sendGen = async (gen, pathOverride = framePath) => {
    const p = new Promise((resolve) => {
      resolveEntry = resolve;
    });
    harness.send({
      schema: 'surface_event/v0.2',
      event: 'frame_ready',
      data: {
        frame_ref: {
          schema: 'frame_ref/v0.2',
          surface_id: 's1',
          generation: gen,
          tick: gen,
          ts_ns: gen * 1000,
          width: 2,
          height: 2,
          format: 'rgb24',
          ramws_path: pathOverride,
          sha256: sha,
          capture_us: 50,
        },
      },
    });
    return withTimeout(p, `sendGen(${gen}) frame entry`);
  };

  const entry1 = await sendGen(1);

  // 1. FRAME_BINDING mismatch
  await withTimeout(
    assert.rejects(
      entry1.readerOptions.acquirePublishedLease({
        binding: { ...entry1.readerOptions.binding, epoch: 99 },
        frameRef: entry1.frameRef,
        signal: new AbortController().signal,
      }),
      (err) => err?.causeCode === 'FRAME_BINDING' && /FRAME_BINDING/.test(err.message),
    ),
    'acquirePublishedLease FRAME_BINDING check',
  );

  // 2. STAT_MODE (group-writable 0620)
  await withTimeout(chmod(framePath, 0o620), 'chmod 0620 cause-probe.rgb');
  await withTimeout(
    assert.rejects(
      entry1.readerOptions.acquirePublishedLease({
        binding: entry1.readerOptions.binding,
        frameRef: entry1.frameRef,
        signal: new AbortController().signal,
      }),
      (err) => err?.causeCode === 'STAT_MODE' && /CORE_SEAMS_ABSENT/.test(err.message),
    ),
    'acquirePublishedLease STAT_MODE check',
  );
  await withTimeout(chmod(framePath, 0o600), 'chmod 0600 cause-probe.rgb');

  // 3. OPEN_ENOENT (unlinked file)
  await withTimeout(unlink(framePath), 'unlink cause-probe.rgb');
  await withTimeout(
    assert.rejects(
      entry1.readerOptions.acquirePublishedLease({
        binding: entry1.readerOptions.binding,
        frameRef: entry1.frameRef,
        signal: new AbortController().signal,
      }),
      (err) => err?.causeCode === 'OPEN_ENOENT' && /CORE_SEAMS_ABSENT/.test(err.message),
    ),
    'acquirePublishedLease OPEN_ENOENT check',
  );

  // 4. OPEN_SYMLINK (symlink in /dev/shm)
  const targetPath = join(harness.shmDir, 'real-target.rgb');
  const linkPath = join(harness.shmDir, 'symlink-frame.rgb');
  await withTimeout(writeFile(targetPath, rawBytes, { mode: 0o600 }), 'writeFile real-target.rgb');
  await withTimeout(symlink(targetPath, linkPath), 'symlink symlink-frame.rgb');
  const entry2 = await sendGen(2, linkPath);
  await withTimeout(
    assert.rejects(
      entry2.readerOptions.acquirePublishedLease({
        binding: entry2.readerOptions.binding,
        frameRef: entry2.frameRef,
        signal: new AbortController().signal,
      }),
      (err) => err?.causeCode === 'OPEN_SYMLINK' && /CORE_SEAMS_ABSENT/.test(err.message),
    ),
    'acquirePublishedLease OPEN_SYMLINK check',
  );

  // 5. OPEN_PATH (dot-segment path)
  const entry3 = await sendGen(3, `${harness.shmDir}/./real-target.rgb`);
  await withTimeout(
    assert.rejects(
      entry3.readerOptions.acquirePublishedLease({
        binding: entry3.readerOptions.binding,
        frameRef: entry3.frameRef,
        signal: new AbortController().signal,
      }),
      (err) => err?.causeCode === 'OPEN_PATH' && /CORE_SEAMS_ABSENT/.test(err.message),
    ),
    'acquirePublishedLease OPEN_PATH check',
  );

  // 5b. STALE (older frameRef generation passed to newer entry's acquirePublishedLease)
  await withTimeout(
    assert.rejects(
      entry3.readerOptions.acquirePublishedLease({
        binding: entry3.readerOptions.binding,
        frameRef: entry1.frameRef,
        signal: new AbortController().signal,
      }),
      (err) => err?.causeCode === 'STALE' && /FRAME_BINDING/.test(err.message),
    ),
    'acquirePublishedLease STALE check',
  );

  // 6. Verify deliverAuthorityFrame + frameDiag records typed cause codes and never writes paths or bytes.
  const diag = installFrameDiag({
    ipcMain: { handle() {}, removeHandler() {} },
    contents: {},
    env: harness.env,
    runDir: harness.diagDir,
  });
  harness.registerCleanup(() => diag.dispose());

  const streams = new Set();
  try {
    assert.equal(
      await withTimeout(deliverAuthorityFrame(entry1, { postMessage() {} }, streams, diag), 'deliverAuthorityFrame entry1'),
      false,
    );
    assert.equal(diag.getSnapshot().main.lastReaderRefusal?.cause, 'OPEN_ENOENT');
    assert.equal(
      await withTimeout(deliverAuthorityFrame(entry2, { postMessage() {} }, streams, diag), 'deliverAuthorityFrame entry2'),
      false,
    );
    assert.equal(diag.getSnapshot().main.lastReaderRefusal?.cause, 'OPEN_SYMLINK');

    for (const cause of FRAME_DIAG_ACQUIRE_CAUSES) {
      if (cause === 'UNKNOWN') continue;
      diag.recordReaderRefusal({
        surfaceId: 's1',
        frameGeneration: 10,
        reason: 'IO_ERROR',
        detail: 'acquire-failed',
        cause,
      });
      assert.equal(diag.getSnapshot().main.lastReaderRefusal?.cause, cause);
    }

    // Attempt to inject a path into cause: must be sanitized to UNKNOWN.
    diag.recordReaderRefusal({
      surfaceId: 's1',
      frameGeneration: 11,
      reason: 'IO_ERROR',
      detail: 'acquire-failed',
      cause: '/dev/shm/secret-path.rgb',
    });
    assert.equal(diag.getSnapshot().main.lastReaderRefusal?.cause, 'UNKNOWN');

    await withTimeout(diag.flush(), 'diag.flush');
    const rawDiag = await withTimeout(readFile(join(harness.diagDir, 'frame-diag.json'), 'utf8'), 'readFile frame-diag.json');
    assert.ok(!rawDiag.includes('/dev/shm'), 'frame-diag.json must never contain /dev/shm paths');
    assert.ok(!rawDiag.includes('secret-path'), 'frame-diag.json must never contain unvalidated cause strings');
  } finally {
    for (const s of streams) {
      await withTimeout(s.reader.closeReader(), 'closeReader');
      s.port.revokeFramePort('SHUTDOWN');
    }
  }
  assert.ok(latestEntry);
});

test('W3-FRAME-ACQUIRE: stream never stalls after N refused generations and next available generation is PRESENTED', async (t) => {
  const harness = await createCoreHarness(t);
  /** @type {Array<{port1: any, port2: any}>} */
  const channels = [];
  harness.registerCleanup(() => {
    for (const ch of channels) {
      ch.port1.close();
      ch.port2.close();
    }
  });
  const bindings = await withTimeout(
    createMainBindings({
      env: harness.env,
      getPeerCredentials: harness.getPeerCredentials,
      createMessageChannel: () => {
        const ch = fakeChannel();
        channels.push(ch);
        return ch;
      },
    }),
    'createMainBindings',
  );
  await harness.waitForReady(bindings);

  const ipcHandlers = new Map();
  const ipcMain = {
    handle(channel, fn) {
      ipcHandlers.set(channel, fn);
    },
    removeHandler(channel) {
      ipcHandlers.delete(channel);
    },
  };
  const senderFrame = {
    routingId: 1,
    origin: PRIVILEGED_ORIGIN,
    url: `${PRIVILEGED_ORIGIN}/index.html`,
    parent: null,
  };
  const contents = {
    id: 1,
    mainFrame: senderFrame,
    isDestroyed: () => false,
    getURL: () => `${PRIVILEGED_ORIGIN}/index.html`,
    postMessage() {},
  };
  const frameDiag = installFrameDiag({
    ipcMain,
    contents,
    env: harness.env,
    runDir: harness.diagDir,
  });
  harness.registerCleanup(() => frameDiag.dispose());

  const wire = installAuthorityWire({
    ipcMain,
    contents,
    core: bindings.core,
    env: harness.env,
    frames: bindings.wire.frames,
    frameDiag,
  });
  harness.registerCleanup(() => wire.dispose());

  await withTimeout(
    ipcHandlers.get('metaviewer:authority.subscribe')({
      sender: contents,
      senderFrame,
    }),
    'metaviewer:authority.subscribe',
  );

  const pub = createRotatingPublisher(harness.shmDir, 16);
  harness.send({
    schema: 'surface_event/v0.2',
    event: 'created',
    data: { surface: surfaceState },
  });

  // Generation 1 delivered and PRESENTED.
  const ref1 = await pub.publish('s1', 2, 2, 0x10);
  harness.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: ref1 } });
  await waitFor(() => frameDiag.getSnapshot().main.deliveriesPosted === 1, 'gen 1 delivery posted');

  const senderPort = channels[0].port1;
  const rendererPort = channels[0].port2;
  const ackDelivery = (delivery) => {
    rendererPort.postMessage({
      schema: 'frame_ack/v0.2',
      kind: 'ack',
      correlation: delivery.correlation,
      principal: delivery.principal,
      epoch: delivery.epoch,
      surfaceId: delivery.surfaceId,
      surfaceGeneration: delivery.surfaceGeneration,
      frameGeneration: delivery.frameGeneration,
      leaseId: delivery.leaseId,
      outcome: 'PRESENTED',
    });
  };
  rendererPort.on('message', (data) => {
    if (data?.kind === 'frame') {
      ackDelivery(data);
    }
  });
  ackDelivery(senderPort.messages[0]);
  await waitFor(() => frameDiag.getSnapshot().main.acksByOutcome.PRESENTED === 1, 'gen 1 PRESENTED ack');

  // N = 3 refused generations (generations 2, 3, 4 unlinked before main opens them).
  for (let gen = 2; gen <= 4; gen += 1) {
    const ref = await pub.publish('s1', 2, 2, gen * 0x10);
    await withTimeout(unlink(ref.ramws_path), `unlink gen ${gen}`);
    harness.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: ref } });
    await waitFor(
      () => frameDiag.getSnapshot().main.deliveriesRefusedByReader === gen - 1,
      `refused generation ${gen}`,
    );
  }

  const afterRefusals = frameDiag.getSnapshot();
  assert.equal(afterRefusals.main.deliveriesRefusedByReader, 3);
  assert.equal(afterRefusals.main.readerRefusalsByCause.OPEN_ENOENT, 3);
  assert.equal(afterRefusals.main.lastReaderRefusal?.frameGeneration, 4);
  assert.equal(afterRefusals.main.lastReaderRefusal?.cause, 'OPEN_ENOENT');
  assert.equal(afterRefusals.main.revocationsTotal, 0);

  // Next available generation (generation 5) is published and must be delivered and PRESENTED.
  const ref5 = await pub.publish('s1', 2, 2, 0x50);
  harness.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: ref5 } });
  await waitFor(
    () =>
      frameDiag.getSnapshot().main.lastDelivery?.frameGeneration === 5 &&
      frameDiag.getSnapshot().main.lastAck?.frameGeneration === 5 &&
      frameDiag.getSnapshot().main.lastAck?.outcome === 'PRESENTED',
    'gen 5 delivered and PRESENTED',
  );

  const recovered = frameDiag.getSnapshot();
  assert.equal(recovered.main.deliveriesPosted, 2);
  assert.equal(recovered.main.acksByOutcome.PRESENTED, 2);
  assert.equal(recovered.main.deliveriesRefusedByReader, 3);
  assert.equal(recovered.main.revocationsTotal, 0);
});
