import test from 'node:test';
import assert from 'node:assert/strict';
import { Socket, createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, chmod, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createMainBindings } from '../electron/hostBindings.js';
import { installAuthorityWire, deliverAuthorityFrame, WIRE_CHANNELS } from '../electron/authorityWire.js';
import { installFrameDiag } from '../electron/frameDiag.js';

const STEP_TIMEOUT_MS = 5000;

/** @type {Map<string, Set<Socket>>} */
const clientSocketsByPath = new Map();
const origSocketConnect = Socket.prototype.connect;
Socket.prototype.connect = function patchedConnect(...args) {
  const first = args[0];
  const targetPath =
    typeof first === 'string'
      ? first
      : first && typeof first === 'object' && !Array.isArray(first) && typeof first.path === 'string'
        ? first.path
        : Array.isArray(first) && first[0] && typeof first[0].path === 'string'
          ? first[0].path
          : null;
  if (targetPath && clientSocketsByPath.has(targetPath)) {
    const set = clientSocketsByPath.get(targetPath);
    set?.add(this);
    this.once('close', () => set?.delete(this));
  }
  return origSocketConnect.apply(this, args);
};

async function withTimeout(promise, label, timeoutMs = STEP_TIMEOUT_MS) {
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

async function waitFor(predicate, label = 'condition', timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await withTimeout(Promise.resolve().then(() => predicate()), `waitFor(${label}) predicate`, timeoutMs)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
}

const baseSurface = Object.freeze({
  schema: 'surface/v0.2',
  surface_id: 's1',
  kind: 'desktop_capsule',
  display: ':99',
  geometry: { w: 4, h: 4 },
  state: 'active',
  visibility: 'unfolded',
  control: 'agent',
  profile_id: 'capsule',
});

const registration = component => ({
  endpoint: { component, instance: `${component}-w3-ctl` },
  hello: {
    schema: 'hello/v0.2',
    contract_version: 'v0.2',
    component,
    component_version: '0.1.2',
    component_commit: 'a'.repeat(40),
    dependencies: [],
  },
});

async function createControlFrameFixture(t, { shouldDropIntent = () => false } = {}) {
  const root = await withTimeout(mkdtemp(join(tmpdir(), 'mv-w3-ctl-')), 'mkdtemp root');
  const ram = await withTimeout(mkdtemp('/dev/shm/mv-w3-ctl-'), 'mkdtemp ram');
  const config = {
    session_id: 'w3-ctl-session',
    core: registration('core'),
    peers: [registration('ui')],
  };
  await withTimeout(mkdir(join(root, 'metaviewer'), { mode: 0o700 }), 'mkdir metaviewer');
  const configPath = join(root, 'config.json');
  await withTimeout(writeFile(configPath, JSON.stringify(config), { mode: 0o600 }), 'writeFile config.json');

  const sockPath = join(root, 'metaviewer/core.sock');
  const acceptedSockets = new Set();
  const clientSockets = new Set();
  clientSocketsByPath.set(sockPath, clientSockets);
  const cleanups = [];
  const requests = [];
  let peer = null;
  let helloExchanged = false;
  let closing = false;
  let seq = 0;
  let currentSurface = { ...baseSurface };

  const send = body => {
    assert.ok(peer && !peer.destroyed, 'expected active control fixture peer socket');
    seq += 1;
    peer.write(
      JSON.stringify({
        schema: 'envelope/v0.2',
        msg_id: `reply-${seq}`,
        ts_ns: seq * 1000,
        from: config.core.endpoint,
        to: config.peers[0].endpoint,
        session_id: config.session_id,
        seq,
        nonce: `nonce-${seq}`,
        body,
      }) + '\n',
    );
  };

  const server = createServer(socket => {
    if (closing) {
      socket.destroy();
      socket.unref?.();
      return;
    }
    peer = socket;
    acceptedSockets.add(socket);
    socket.on('close', () => acceptedSockets.delete(socket));
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      let offset;
      while ((offset = buffer.indexOf('\n')) >= 0) {
        const env = JSON.parse(buffer.slice(0, offset));
        buffer = buffer.slice(offset + 1);
        requests.push(env);
        if (env.body.schema === 'hello/v0.2') {
          send(config.core.hello);
          helloExchanged = true;
        } else if (env.body.schema === 'ui_intent/v0.2') {
          if (shouldDropIntent(env.body)) continue;
          if (env.body.op === 'take_control') {
            currentSurface = { ...currentSurface, control: 'human' };
            send({
              schema: 'surface_event/v0.2',
              event: 'state_changed',
              data: { surface: currentSurface },
            });
          } else if (env.body.op === 'release_control') {
            currentSurface = { ...currentSurface, control: 'agent' };
            send({
              schema: 'surface_event/v0.2',
              event: 'state_changed',
              data: { surface: currentSurface },
            });
          }
        } else if (env.body.schema === 'action_proposal/v0.2') {
          send({
            schema: 'action_verdict/v0.2',
            proposal_id: env.body.proposal_id,
            decision: 'refused',
            reason_code: 'POLICY',
            core_seq: 1,
          });
        } else if (env.body.schema === 'surface_request/v0.2' && env.body.op === 'input') {
          send({
            schema: 'action_verdict/v0.2',
            proposal_id: env.body.params?.proposal_id,
            decision: 'refused',
            reason_code: 'SURFACE_NOT_HUMAN_CONTROLLED',
            core_seq: 2,
          });
        }
      }
    });
  });

  await withTimeout(
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(sockPath, () => {
        server.removeListener('error', reject);
        resolve(null);
      });
    }),
    'control fixture server.listen',
  );
  await withTimeout(chmod(sockPath, 0o600), 'chmod core.sock');

  function registerCleanup(fn) {
    cleanups.push(fn);
  }

  let cleanupPromise = null;
  async function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      closing = true;
      while (cleanups.length > 0) {
        const fn = cleanups.pop();
        if (fn) {
          try {
            await withTimeout(Promise.resolve().then(() => fn()), 'control fixture registered cleanup');
          } catch {
            // Continue socket and directory teardown even if a disposable throws.
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
          new Promise(resolve => server.close(() => resolve(null))),
          'control fixture server.close',
        );
      }
      server.unref?.();
      await withTimeout(
        unlink(sockPath).catch(err => {
          if (err?.code !== 'ENOENT') throw err;
        }),
        'unlink core.sock',
      );
      clientSocketsByPath.delete(sockPath);
      await withTimeout(rm(root, { recursive: true, force: true }), 'rm root');
      await withTimeout(rm(ram, { recursive: true, force: true }), 'rm ram');
    })();
    return cleanupPromise;
  }

  t.after(() => cleanup());

  async function writeFrame(generation, fillByte = generation & 0xff) {
    const bytes = Buffer.alloc(4 * 4 * 3, fillByte);
    const framePath = join(ram, `frame-${generation}.rgb`);
    await withTimeout(writeFile(framePath, bytes, { mode: 0o600 }), `writeFrame(${generation})`);
    return {
      schema: 'frame_ref/v0.2',
      surface_id: 's1',
      generation,
      tick: generation,
      ts_ns: generation * 1000,
      width: 4,
      height: 4,
      format: 'rgb24',
      ramws_path: framePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      capture_us: 100,
    };
  }

  const portMessages = [];
  const channels = [];
  registerCleanup(() => {
    for (const ch of channels) {
      ch.port1.close?.();
      ch.port2.close?.();
    }
  });
  const createMessageChannel = () => {
    const port1 = new EventEmitter();
    let closed = false;
    Object.assign(port1, {
      postMessage: value => {
        if (closed) return;
        portMessages.push(value);
        // Auto-ACK every delivered frame so continuous generations flow.
        queueMicrotask(() => {
          if (closed) return;
          port1.emit('message', {
            schema: 'frame_ack/v0.2',
            kind: 'ack',
            correlation: value.correlation,
            principal: value.principal,
            epoch: value.epoch,
            surfaceId: value.surfaceId,
            surfaceGeneration: value.surfaceGeneration,
            frameGeneration: value.frameGeneration,
            leaseId: value.leaseId,
            outcome: 'PRESENTED',
          });
        });
      },
      start() {},
      close() {
        closed = true;
        port1.removeAllListeners();
      },
    });
    const port2 = { close() {} };
    channels.push({ port1, port2 });
    return { port1, port2 };
  };

  return {
    env: { MV_CORE_CONFIG: configPath, XDG_RUNTIME_DIR: root },
    root,
    ram,
    sockPath,
    requests,
    portMessages,
    channels,
    createMessageChannel,
    send,
    writeFrame,
    registerCleanup,
    cleanup,
    async waitForReady(bindings) {
      registerCleanup(() => bindings.core.dispose());
      await waitFor(
        () =>
          helloExchanged &&
          peer !== null &&
          !peer.destroyed &&
          bindings.core.getStatus().availability === 'live',
        'control fixture hello handshake and live bindings availability',
      );
    },
    disconnect: () => {
      peer?.destroy();
      peer?.unref?.();
    },
    sendMalformed: raw => peer?.write(raw + '\n'),
  };
}

test('W3-CONTROL-TIMEOUT: take_control and release_control are not starved or clobbered by slow in-flight frame reads or rotated frame files; negative control reproduces pre-fix state drop and clobber', async t => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 'injected never-resolving await', 40),
    /Timed out after 40ms awaiting injected never-resolving await/,
  );

  const f = await createControlFrameFixture(t);
  const bindings = await withTimeout(
    createMainBindings({
      env: f.env,
      createMessageChannel: f.createMessageChannel,
    }),
    'createMainBindings',
  );
  await f.waitForReady(bindings);

  const handlers = new Map();
  const senderFrame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
  const notices = [];
  const contents = {
    id: 41,
    mainFrame: senderFrame,
    isDestroyed: () => false,
    postMessage: (channel, payload, transfer) => {
      notices.push({ channel, payload, transfer, atMs: Date.now() });
    },
  };
  const diag = installFrameDiag({ env: {} });
  f.registerCleanup(() => diag.dispose());
  const wire = installAuthorityWire({
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: ch => handlers.delete(ch),
    },
    contents,
    core: bindings.core,
    frames: bindings.wire.frames,
    frameDiag: diag,
  });
  f.registerCleanup(() => wire.dispose());

  await withTimeout(
    handlers.get(WIRE_CHANNELS.subscribeFrames)({ sender: contents, senderFrame }),
    'subscribeFrames',
  );

  f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface: baseSurface } });
  const frame1 = await f.writeFrame(1, 0x11);
  f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frame1 } });
  await waitFor(() => notices.some(n => n.payload.frame_ref.generation === 1), 'frame generation 1 notice');
  assert.equal(notices.at(-1).payload.surface.control, 'agent');

  // Stream frames 2..8 continuously while issuing take_control and release_control,
  // including a rotated-out frame (generation 5) that triggers OPEN_ENOENT.
  for (let gen = 2; gen <= 4; gen += 1) {
    const frameRef = await f.writeFrame(gen, gen);
    f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frameRef } });
  }

  const takeStart = Date.now();
  const takeRes = await withTimeout(
    handlers.get(WIRE_CHANNELS.intent)(
      { sender: contents, senderFrame },
      JSON.stringify({
        schema: 'ui_intent/v0.2',
        request_id: 'w3-take-1',
        op: 'take_control',
        params: { surface_id: 's1' },
      }),
    ),
    'take_control intent',
  );
  const takeElapsed = Date.now() - takeStart;
  assert.equal(takeRes, true);
  assert.ok(takeElapsed < 500, `take_control must resolve promptly under frame load (took ${takeElapsed}ms)`);

  // Frame 5 is unlinked before read (simulating ring rotation), followed by frames 6..8.
  const frame5 = await f.writeFrame(5, 0x55);
  await withTimeout(rm(frame5.ramws_path, { force: true }), 'rm frame5');
  f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frame5 } });
  for (let gen = 6; gen <= 8; gen += 1) {
    const frameRef = await f.writeFrame(gen, gen);
    f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frameRef } });
  }
  await waitFor(
    () =>
      notices.some(n => n.payload.surface.control === 'human') &&
      notices.some(n => n.payload.frame_ref.generation === 8),
    'control=human and frame generation 8 notice',
  );

  // Every notice emitted after take_control must preserve surface.control === 'human'
  // (never clobbered back to 'agent' by an in-flight or subsequent frame read).
  const humanIndex = notices.findIndex(n => n.payload.surface.control === 'human');
  assert.ok(humanIndex >= 0, 'renderer must receive control=human notice');
  for (let i = humanIndex; i < notices.length; i += 1) {
    assert.equal(
      notices[i].payload.surface.control,
      'human',
      `frame delivery at index ${i} (gen ${notices[i].payload.frame_ref.generation}) must not clobber control=human back to agent`,
    );
  }

  // Now issue release_control while frames 9..11 flow.
  const releaseStart = Date.now();
  const releaseRes = await withTimeout(
    handlers.get(WIRE_CHANNELS.intent)(
      { sender: contents, senderFrame },
      JSON.stringify({
        schema: 'ui_intent/v0.2',
        request_id: 'w3-release-1',
        op: 'release_control',
        params: { surface_id: 's1' },
      }),
    ),
    'release_control intent',
  );
  const releaseElapsed = Date.now() - releaseStart;
  assert.equal(releaseRes, true);
  assert.ok(releaseElapsed < 500, `release_control must resolve promptly (took ${releaseElapsed}ms)`);

  for (let gen = 9; gen <= 11; gen += 1) {
    const frameRef = await f.writeFrame(gen, gen);
    f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frameRef } });
  }
  await waitFor(
    () =>
      notices.at(-1)?.payload.surface.control === 'agent' &&
      notices.at(-1)?.payload.frame_ref.generation === 11,
    'control=agent and frame generation 11 notice',
  );

  assert.equal(notices.at(-1).payload.surface.control, 'agent');
  assert.equal(notices.at(-1).payload.frame_ref.generation, 11);

  // Direct test of in-flight readFrame race: state_changed arrives WHILE readFrame is awaiting I/O.
  let currentControl = 'agent';
  let releaseSlowRead;
  const slowReadGate = new Promise(resolve => { releaseSlowRead = resolve; });
  const slowStreams = new Set();
  const raceNotices = [];
  const slowChannel = f.createMessageChannel();
  const slowFrameRef = await f.writeFrame(20, 0x20);
  const slowBinding = Object.freeze({ principal: 'ui', epoch: 1, surfaceId: 's1', surfaceGeneration: 1 });
  const slowEntry = {
    frameRef: slowFrameRef,
    state: { ...baseSurface, control: 'agent' },
    rendererPorts: [slowChannel.port2],
    resolveLatestState: () => ({ ...baseSurface, control: currentControl }),
    readerOptions: {
      binding: slowBinding,
      limits: { maxFrameBytes: 64 * 1024 * 1024, maxWidth: 4096, maxHeight: 4096, readTimeoutMs: 1000, maxConcurrentReads: 1 },
      pixelEnvironment: { environmentId: 'w3-ctl-session', zoom: 1, dpr: 1 },
      onReleaseLease() {},
      async acquirePublishedLease() {
        await withTimeout(slowReadGate, 'slowReadGate');
        const bytes = Buffer.alloc(4 * 4 * 3, 0x20);
        return {
          identity: { ...slowBinding, frameGeneration: 20, leaseId: 'lease-20' },
          published: true,
          byteLength: bytes.byteLength,
          async readOwnedBytes() { return new Uint8Array(bytes); },
          async release() {},
        };
      },
    },
    portOptions: {
      port: slowChannel.port1,
      role: 'sender',
      binding: slowBinding,
      limits: { maxFrameBytes: 64 * 1024 * 1024, ackTimeoutMs: 10000, maxSurfacesPerPort: 1 },
      onReleaseLease() {},
      onRevoke() {},
    },
  };

  try {
    const inFlightDelivery = deliverAuthorityFrame(
      slowEntry,
      { postMessage: (_ch, payload) => raceNotices.push(payload) },
      slowStreams,
    );
    // While readFrame is blocked in acquirePublishedLease, control switches to 'human'.
    currentControl = 'human';
    releaseSlowRead();
    assert.equal(await withTimeout(inFlightDelivery, 'inFlightDelivery'), true);
    assert.equal(
      raceNotices[0].surface.control,
      'human',
      'in-flight frame completion must project the latest surface control state via resolveLatestState()',
    );

    // Negative control: without resolveLatestState(), the pre-fix entry projects stale control='agent'.
    await withTimeout(new Promise(resolve => setImmediate(resolve)), 'setImmediate drain');
    const slowFrameRef21 = await f.writeFrame(21, 0x21);
    const { resolveLatestState: _omitted, ...legacyBase } = slowEntry;
    const legacyEntry = {
      ...legacyBase,
      frameRef: slowFrameRef21,
      readerOptions: {
        ...slowEntry.readerOptions,
        async acquirePublishedLease() {
          const bytes = Buffer.alloc(4 * 4 * 3, 0x21);
          return {
            identity: { ...slowBinding, frameGeneration: 21, leaseId: 'lease-21' },
            published: true,
            byteLength: bytes.byteLength,
            async readOwnedBytes() { return new Uint8Array(bytes); },
            async release() {},
          };
        },
      },
    };
    const legacyNotices = [];
    assert.equal(
      await withTimeout(
        deliverAuthorityFrame(
          legacyEntry,
          { postMessage: (_ch, payload) => legacyNotices.push(payload) },
          slowStreams,
        ),
        'legacyEntry deliverAuthorityFrame',
      ),
      true,
    );
    assert.equal(
      legacyNotices[0].surface.control,
      'agent',
      'negative control: omitting resolveLatestState() reproduces the pre-fix stale control=agent clobber',
    );
  } finally {
    for (const stream of slowStreams) {
      await withTimeout(stream.reader.closeReader(), 'closeReader');
      stream.port.revokeFramePort('SHUTDOWN');
    }
  }
});

test('W3-CONTROL-TIMEOUT resilience: a single CORE_TIMEOUT does not dispose a healthy authority wire; subsequent control intents and frames succeed; negative control verifies socket close and protocol violations still shut down', async t => {
  let dropNextIntent = false;
  const f = await createControlFrameFixture(t, {
    shouldDropIntent: body => {
      if (dropNextIntent && body.request_id === 'req-timeout-once') {
        dropNextIntent = false;
        return true;
      }
      return false;
    },
  });

  const bindings = await withTimeout(
    createMainBindings({
      env: f.env,
      createMessageChannel: f.createMessageChannel,
    }),
    'createMainBindings',
  );
  await f.waitForReady(bindings);

  const deliveredEntries = [];
  bindings.wire.frames.subscribe(entry => {
    deliveredEntries.push(entry);
  });

  f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface: baseSurface } });
  const frame1 = await f.writeFrame(1, 0x10);
  f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frame1 } });

  await waitFor(() => deliveredEntries.length === 1, 'frame 1 deliveredEntry');
  assert.equal(deliveredEntries.length, 1);

  // 1. Trigger a single CORE_TIMEOUT (3000 ms deadline) on an unanswered intent while the socket stays healthy.
  dropNextIntent = true;
  await withTimeout(
    assert.rejects(
      bindings.core.request({
        op: 'intent',
        json: JSON.stringify({
          schema: 'ui_intent/v0.2',
          request_id: 'req-timeout-once',
          op: 'take_control',
          params: { surface_id: 's1' },
        }),
      }),
      /^Error: CORE_TIMEOUT$/,
    ),
    'single CORE_TIMEOUT request',
    10000,
  );

  // [TARGET, unit decision] Authority wire remains live after a single timeout on a healthy socket.
  assert.deepEqual(bindings.core.getStatus(), {
    availability: 'live',
    pid: null,
    authority_epoch: 1,
    reason: null,
  });

  // 2. Subsequent take_control and release_control intents on the same session succeed without CORE_SEAMS_ABSENT.
  assert.equal(
    await withTimeout(
      bindings.core.request({
        op: 'intent',
        json: JSON.stringify({
          schema: 'ui_intent/v0.2',
          request_id: 'req-take-after-timeout',
          op: 'take_control',
          params: { surface_id: 's1' },
        }),
      }),
      'take_control after timeout',
    ),
    true,
  );
  assert.equal(
    await withTimeout(
      bindings.core.request({
        op: 'intent',
        json: JSON.stringify({
          schema: 'ui_intent/v0.2',
          request_id: 'req-release-after-timeout',
          op: 'release_control',
          params: { surface_id: 's1' },
        }),
      }),
      'release_control after timeout',
    ),
    true,
  );

  // Frame streaming also remains alive after the recovered timeout.
  const frame2 = await f.writeFrame(2, 0x20);
  f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frame2 } });
  await waitFor(() => deliveredEntries.at(-1)?.frameRef.generation === 2, 'frame 2 deliveredEntry after timeout');
  assert.equal(deliveredEntries.at(-1).frameRef.generation, 2);

  // 3. Negative control: an actual transport disconnect or wire protocol violation still calls shutdown()
  // and transitions the authority wire to unavailable (CORE_SEAMS_ABSENT).
  f.disconnect();
  await waitFor(
    () => bindings.core.getStatus().availability === 'unavailable',
    'bindings status unavailable after disconnect',
  );
  assert.equal(bindings.core.getStatus().availability, 'unavailable');
  assert.equal(bindings.core.getStatus().reason, 'CORE_SEAMS_ABSENT');
  await withTimeout(
    assert.rejects(
      bindings.core.request({
        op: 'intent',
        json: JSON.stringify({
          schema: 'ui_intent/v0.2',
          request_id: 'req-after-disconnect',
          op: 'take_control',
          params: { surface_id: 's1' },
        }),
      }),
      /^Error: CORE_SEAMS_ABSENT$/,
    ),
    'request after disconnect',
  );
});

test('R3-T4-005: unrelated proposal and surface_input replies do not reset intent progress across consecutive intent timeouts', async t => {
  const f = await createControlFrameFixture(t, {
    shouldDropIntent: () => true,
  });
  const bindings = await withTimeout(createMainBindings({ ...f }), 'createMainBindings r3-005');
  f.registerCleanup(() => bindings.core.dispose());

  f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface: baseSurface } });
  const frame1 = await f.writeFrame(1, 0x10);
  f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frame1 } });
  await new Promise(resolve => setTimeout(resolve, 20));

  await withTimeout(
    assert.rejects(
      bindings.core.request({
        op: 'intent',
        json: JSON.stringify({
          schema: 'ui_intent/v0.2',
          request_id: 'r3-005-intent-1',
          op: 'take_control',
          params: { surface_id: 's1' },
        }),
      }),
      /^Error: CORE_TIMEOUT$/,
    ),
    'first intent timeout spared',
    10000,
  );
  assert.equal(bindings.core.getStatus().availability, 'live');

  const verdict = await withTimeout(
    bindings.core.request({
      op: 'propose',
      json: JSON.stringify({
        schema: 'action_proposal/v0.2',
        proposal_id: 'r3-005-prop-1',
        surface_id: 's1',
        based_on_frame: { generation: 1, sha256: 'a'.repeat(64) },
        action: { type: 'click', x: 1, y: 1, button: 'left' },
        expectation: { type: 'state_sha256_change' },
        budget: { max_ms: 500, max_retries: 0 },
      }),
    }),
    'propose between intent timeouts',
  );
  assert.equal(verdict.decision, 'refused');

  const inputOut = await withTimeout(
    bindings.core.request({
      op: 'input',
      batch: {
        schema: 'surface_input/v1',
        surface_id: 's1',
        stream_id: 1,
        seq: 1,
        events: [{ kind: 'key', keys: ['a'] }],
      },
    }),
    'input refusal between intent timeouts',
  );
  assert.equal(inputOut.ok, false);

  await withTimeout(
    assert.rejects(
      bindings.core.request({
        op: 'intent',
        json: JSON.stringify({
          schema: 'ui_intent/v0.2',
          request_id: 'r3-005-intent-2',
          op: 'take_control',
          params: { surface_id: 's1' },
        }),
      }),
      /^Error: CORE_TIMEOUT$/,
    ),
    'second consecutive intent timeout shuts down',
    10000,
  );
  assert.equal(bindings.core.getStatus().availability, 'unavailable');
});

