// @ts-check
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { constants as fsConstants } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deliverAuthorityFrame, installAuthorityWire } from '../electron/authorityWire.js';
import { FRAME_DIAG_ACQUIRE_CAUSES, installFrameDiag } from '../electron/frameDiag.js';
import { ACQUIRE_CAUSE_CODES } from '../electron/frameReader.js';
import { createMainBindings } from '../electron/hostBindings.js';
import { PRIVILEGED_ORIGIN } from '../electron/main.js';

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
    },
  };
}

async function createCoreHarness(t) {
  const root = await mkdtemp(join(tmpdir(), 'mv-w3-acq-'));
  const shmDir = await mkdtemp('/dev/shm/mv-w3-acq-');
  await chmod(root, 0o700);
  await chmod(shmDir, 0o700);
  const runtimeDir = join(root, 'rt');
  const mvDir = join(runtimeDir, 'metaviewer');
  const diagDir = join(root, 'diag');
  await mkdir(runtimeDir, { mode: 0o700 });
  await mkdir(mvDir, { mode: 0o700 });
  await mkdir(diagDir, { mode: 0o700 });

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
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  const sockets = new Set();
  /** @type {import('node:net').Socket | null} */
  let activeSocket = null;
  let seq = 0;

  const server = createServer((socket) => {
    sockets.add(socket);
    activeSocket = socket;
    socket.on('close', () => sockets.delete(socket));
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

  const socketPath = join(mvDir, 'core.sock');
  t.after(async () => {
    for (const s of sockets) s.destroy();
    if (server.listening) {
      await new Promise((resolve) => server.close(() => resolve(null)));
    }
    await rm(shmDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(socketPath, () => resolve(null)));
  await chmod(socketPath, 0o600);
  const { ino } = await lstat(socketPath);

  return {
    root,
    shmDir,
    diagDir,
    env: {
      MV_CORE_CONFIG: configPath,
      XDG_RUNTIME_DIR: runtimeDir,
      MV_FRAME_DIAG: '1',
      MV_FRAME_DIAG_DIR: diagDir,
    },
    send,
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
  const harness = await createCoreHarness(t);
  const channels = [];
  const bindings = await createMainBindings({
    env: harness.env,
    getPeerCredentials: harness.getPeerCredentials,
    createMessageChannel: () => {
      const ch = fakeChannel();
      channels.push(ch);
      return ch;
    },
  });
  t.after(() => bindings.core.dispose());

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
  t.after(() => frameDiag.dispose());

  const wire = installAuthorityWire({
    ipcMain,
    contents,
    core: bindings.core,
    env: harness.env,
    frames: bindings.wire.frames,
    frameDiag,
  });
  t.after(() => wire.dispose());

  const senderEvent = {
    sender: contents,
    senderFrame,
  };
  await ipcHandlers.get('metaviewer:authority.subscribe')(senderEvent);

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

  await waitFor(() => frameDiag.getSnapshot().main.deliveriesPosted >= 1);
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

  await waitFor(() => frameDiag.getSnapshot().main.lastDelivery?.frameGeneration === 4);

  const ref5 = await pub.publish('s1', 2, 2, 0x55);
  harness.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: ref5 } });
  await waitFor(() => frameDiag.getSnapshot().main.lastDelivery?.frameGeneration === 5);

  const ref6 = await pub.publish('s1', 2, 2, 0x66);
  harness.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: ref6 } });
  await waitFor(() => frameDiag.getSnapshot().main.lastDelivery?.frameGeneration === 6);

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
  const negBindings = await createMainBindings({
    env: negHarness.env,
    getPeerCredentials: negHarness.getPeerCredentials,
    createMessageChannel: fakeChannel,
  });
  t.after(() => negBindings.core.dispose());

  let capturedRef2Entry = null;
  let resolveRef2Entry = null;
  const ref2EntryPromise = new Promise((resolve) => {
    resolveRef2Entry = resolve;
  });
  negBindings.wire.frames.subscribe((entry) => {
    if (entry.frameRef.generation === 2) {
      capturedRef2Entry = entry;
      resolveRef2Entry(entry);
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
  await ref2EntryPromise;
  assert.ok(capturedRef2Entry, 'expected real hostBindings entry for generation 2');

  // Publisher advances to generation 3 and 4 with 2-slot retention, unlinking negRef2 from /dev/shm.
  await negPub.publish('s1', 2, 2, 0x33);
  await negPub.publish('s1', 2, 2, 0x44);

  const negDiagDir = await mkdtemp(join(harness.root, 'neg-diag-'));
  await chmod(negDiagDir, 0o700);
  const negDiag = installFrameDiag({
    ipcMain: { handle() {}, removeHandler() {} },
    contents,
    env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: negDiagDir },
    runDir: negDiagDir,
  });
  t.after(() => negDiag.dispose());

  const negStreams = new Set();
  try {
    const ok = await deliverAuthorityFrame(capturedRef2Entry, contents, negStreams, negDiag);
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
      await s.reader.closeReader();
      s.port.revokeFramePort('SHUTDOWN');
    }
  }
});

test('W3-FRAME-ACQUIRE: hostBindings and frameDiag classify every acquire check failure with a typed cause code and zero paths or bytes', async (t) => {
  const harness = await createCoreHarness(t);
  const bindings = await createMainBindings({
    env: harness.env,
    getPeerCredentials: harness.getPeerCredentials,
    createMessageChannel: fakeChannel,
  });
  t.after(() => bindings.core.dispose());

  let latestEntry = null;
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
  await writeFile(framePath, rawBytes, { mode: 0o600 });
  await chmod(framePath, 0o600);

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
    return p;
  };

  const entry1 = await sendGen(1);

  // 1. FRAME_BINDING mismatch
  await assert.rejects(
    entry1.readerOptions.acquirePublishedLease({
      binding: { ...entry1.readerOptions.binding, epoch: 99 },
      frameRef: entry1.frameRef,
      signal: new AbortController().signal,
    }),
    (err) => err?.causeCode === 'FRAME_BINDING' && /FRAME_BINDING/.test(err.message),
  );

  // 2. STAT_MODE (group-writable 0620)
  await chmod(framePath, 0o620);
  await assert.rejects(
    entry1.readerOptions.acquirePublishedLease({
      binding: entry1.readerOptions.binding,
      frameRef: entry1.frameRef,
      signal: new AbortController().signal,
    }),
    (err) => err?.causeCode === 'STAT_MODE' && /CORE_SEAMS_ABSENT/.test(err.message),
  );
  await chmod(framePath, 0o600);

  // 3. OPEN_ENOENT (unlinked file)
  await unlink(framePath);
  await assert.rejects(
    entry1.readerOptions.acquirePublishedLease({
      binding: entry1.readerOptions.binding,
      frameRef: entry1.frameRef,
      signal: new AbortController().signal,
    }),
    (err) => err?.causeCode === 'OPEN_ENOENT' && /CORE_SEAMS_ABSENT/.test(err.message),
  );

  // 4. OPEN_SYMLINK (symlink in /dev/shm)
  const targetPath = join(harness.shmDir, 'real-target.rgb');
  const linkPath = join(harness.shmDir, 'symlink-frame.rgb');
  await writeFile(targetPath, rawBytes, { mode: 0o600 });
  await symlink(targetPath, linkPath);
  const entry2 = await sendGen(2, linkPath);
  await assert.rejects(
    entry2.readerOptions.acquirePublishedLease({
      binding: entry2.readerOptions.binding,
      frameRef: entry2.frameRef,
      signal: new AbortController().signal,
    }),
    (err) => err?.causeCode === 'OPEN_SYMLINK' && /CORE_SEAMS_ABSENT/.test(err.message),
  );

  // 5. OPEN_PATH (dot-segment path)
  const entry3 = await sendGen(3, `${harness.shmDir}/./real-target.rgb`);
  await assert.rejects(
    entry3.readerOptions.acquirePublishedLease({
      binding: entry3.readerOptions.binding,
      frameRef: entry3.frameRef,
      signal: new AbortController().signal,
    }),
    (err) => err?.causeCode === 'OPEN_PATH' && /CORE_SEAMS_ABSENT/.test(err.message),
  );

  // 5b. STALE (older frameRef generation passed to newer entry's acquirePublishedLease)
  await assert.rejects(
    entry3.readerOptions.acquirePublishedLease({
      binding: entry3.readerOptions.binding,
      frameRef: entry1.frameRef,
      signal: new AbortController().signal,
    }),
    (err) => err?.causeCode === 'STALE' && /FRAME_BINDING/.test(err.message),
  );

  // 6. Verify deliverAuthorityFrame + frameDiag records typed cause codes and never writes paths or bytes.
  const diag = installFrameDiag({
    ipcMain: { handle() {}, removeHandler() {} },
    contents: {},
    env: harness.env,
    runDir: harness.diagDir,
  });
  t.after(() => diag.dispose());

  const streams = new Set();
  try {
    assert.equal(await deliverAuthorityFrame(entry1, { postMessage() {} }, streams, diag), false);
    assert.equal(diag.getSnapshot().main.lastReaderRefusal?.cause, 'OPEN_ENOENT');
    assert.equal(await deliverAuthorityFrame(entry2, { postMessage() {} }, streams, diag), false);
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

    await diag.flush();
    const rawDiag = await readFile(join(harness.diagDir, 'frame-diag.json'), 'utf8');
    assert.ok(!rawDiag.includes('/dev/shm'), 'frame-diag.json must never contain /dev/shm paths');
    assert.ok(!rawDiag.includes('secret-path'), 'frame-diag.json must never contain unvalidated cause strings');
  } finally {
    for (const s of streams) {
      await s.reader.closeReader();
      s.port.revokeFramePort('SHUTDOWN');
    }
  }
  assert.ok(latestEntry);
});

test('W3-FRAME-ACQUIRE: stream never stalls after N refused generations and next available generation is PRESENTED', async (t) => {
  const harness = await createCoreHarness(t);
  const channels = [];
  const bindings = await createMainBindings({
    env: harness.env,
    getPeerCredentials: harness.getPeerCredentials,
    createMessageChannel: () => {
      const ch = fakeChannel();
      channels.push(ch);
      return ch;
    },
  });
  t.after(() => bindings.core.dispose());

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
  t.after(() => frameDiag.dispose());

  const wire = installAuthorityWire({
    ipcMain,
    contents,
    core: bindings.core,
    env: harness.env,
    frames: bindings.wire.frames,
    frameDiag,
  });
  t.after(() => wire.dispose());

  await ipcHandlers.get('metaviewer:authority.subscribe')({
    sender: contents,
    senderFrame,
  });

  const pub = createRotatingPublisher(harness.shmDir, 16);
  harness.send({
    schema: 'surface_event/v0.2',
    event: 'created',
    data: { surface: surfaceState },
  });

  // Generation 1 delivered and PRESENTED.
  const ref1 = await pub.publish('s1', 2, 2, 0x10);
  harness.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: ref1 } });
  await waitFor(() => frameDiag.getSnapshot().main.deliveriesPosted === 1);

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
  await waitFor(() => frameDiag.getSnapshot().main.acksByOutcome.PRESENTED === 1);

  // N = 3 refused generations (generations 2, 3, 4 unlinked before main opens them).
  for (let gen = 2; gen <= 4; gen += 1) {
    const ref = await pub.publish('s1', 2, 2, gen * 0x10);
    await unlink(ref.ramws_path);
    harness.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: ref } });
    await waitFor(() => frameDiag.getSnapshot().main.deliveriesRefusedByReader === gen - 1);
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
  );

  const recovered = frameDiag.getSnapshot();
  assert.equal(recovered.main.deliveriesPosted, 2);
  assert.equal(recovered.main.acksByOutcome.PRESENTED, 2);
  assert.equal(recovered.main.deliveriesRefusedByReader, 3);
  assert.equal(recovered.main.revocationsTotal, 0);
});

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('waitFor timed out');
}
