import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, mkdir, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createMainBindings } from '../electron/hostBindings.js';
import { installAuthorityWire, deliverAuthorityFrame, WIRE_CHANNELS } from '../electron/authorityWire.js';
import { installFrameDiag } from '../electron/frameDiag.js';

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
  const root = await mkdtemp(join(tmpdir(), 'mv-w3-ctl-'));
  const ram = await mkdtemp('/dev/shm/mv-w3-ctl-');
  const config = {
    session_id: 'w3-ctl-session',
    core: registration('core'),
    peers: [registration('ui')],
  };
  await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  const sockets = new Set();
  const requests = [];
  let peer = null;
  let seq = 0;
  let currentSurface = { ...baseSurface };

  const send = body => {
    if (!peer || peer.destroyed) return;
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
    peer = socket;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
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
        }
      }
    });
  });

  const sockPath = join(root, 'metaviewer/core.sock');
  server.listen(sockPath);
  await once(server, 'listening');
  await chmod(sockPath, 0o600);

  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(ram, { recursive: true, force: true });
  });

  async function writeFrame(generation, fillByte = generation & 0xff) {
    const bytes = Buffer.alloc(4 * 4 * 3, fillByte);
    const framePath = join(ram, `frame-${generation}.rgb`);
    await writeFile(framePath, bytes, { mode: 0o600 });
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
  const createMessageChannel = () => {
    const port1 = new EventEmitter();
    Object.assign(port1, {
      postMessage: value => {
        portMessages.push(value);
        // Auto-ACK every delivered frame so continuous generations flow.
        queueMicrotask(() => {
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
      close() {},
    });
    const port2 = { close() {} };
    channels.push({ port1, port2 });
    return { port1, port2 };
  };

  return {
    env: { MV_CORE_CONFIG: configPath, XDG_RUNTIME_DIR: root },
    root,
    ram,
    requests,
    portMessages,
    channels,
    createMessageChannel,
    send,
    writeFrame,
    disconnect: () => peer?.destroy(),
    sendMalformed: raw => peer?.write(raw + '\n'),
  };
}

test('W3-CONTROL-TIMEOUT: take_control and release_control are not starved or clobbered by slow in-flight frame reads or rotated frame files; negative control reproduces pre-fix state drop and clobber', async t => {
  const f = await createControlFrameFixture(t);
  const bindings = await createMainBindings({
    env: f.env,
    createMessageChannel: f.createMessageChannel,
  });
  t.after(() => bindings.core.dispose());

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
  t.after(() => wire.dispose());

  await handlers.get(WIRE_CHANNELS.subscribeFrames)({ sender: contents, senderFrame });

  f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface: baseSurface } });
  const frame1 = await f.writeFrame(1, 0x11);
  f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frame1 } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(notices.some(n => n.payload.frame_ref.generation === 1));
  assert.equal(notices.at(-1).payload.surface.control, 'agent');

  // Stream frames 2..8 continuously while issuing take_control and release_control,
  // including a rotated-out frame (generation 5) that triggers OPEN_ENOENT.
  for (let gen = 2; gen <= 4; gen += 1) {
    const frameRef = await f.writeFrame(gen, gen);
    f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frameRef } });
  }

  const takeStart = Date.now();
  const takeRes = await handlers.get(WIRE_CHANNELS.intent)(
    { sender: contents, senderFrame },
    JSON.stringify({
      schema: 'ui_intent/v0.2',
      request_id: 'w3-take-1',
      op: 'take_control',
      params: { surface_id: 's1' },
    }),
  );
  const takeElapsed = Date.now() - takeStart;
  assert.equal(takeRes, true);
  assert.ok(takeElapsed < 500, `take_control must resolve promptly under frame load (took ${takeElapsed}ms)`);

  // Frame 5 is unlinked before read (simulating ring rotation), followed by frames 6..8.
  const frame5 = await f.writeFrame(5, 0x55);
  await rm(frame5.ramws_path, { force: true });
  f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frame5 } });
  for (let gen = 6; gen <= 8; gen += 1) {
    const frameRef = await f.writeFrame(gen, gen);
    f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frameRef } });
  }
  await new Promise(resolve => setTimeout(resolve, 50));

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
  const releaseRes = await handlers.get(WIRE_CHANNELS.intent)(
    { sender: contents, senderFrame },
    JSON.stringify({
      schema: 'ui_intent/v0.2',
      request_id: 'w3-release-1',
      op: 'release_control',
      params: { surface_id: 's1' },
    }),
  );
  const releaseElapsed = Date.now() - releaseStart;
  assert.equal(releaseRes, true);
  assert.ok(releaseElapsed < 500, `release_control must resolve promptly (took ${releaseElapsed}ms)`);

  for (let gen = 9; gen <= 11; gen += 1) {
    const frameRef = await f.writeFrame(gen, gen);
    f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frameRef } });
  }
  await new Promise(resolve => setTimeout(resolve, 50));

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
        await slowReadGate;
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
    assert.equal(await inFlightDelivery, true);
    assert.equal(
      raceNotices[0].surface.control,
      'human',
      'in-flight frame completion must project the latest surface control state via resolveLatestState()',
    );

    // Negative control: without resolveLatestState(), the pre-fix entry projects stale control='agent'.
    await new Promise(resolve => setImmediate(resolve));
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
      await deliverAuthorityFrame(
        legacyEntry,
        { postMessage: (_ch, payload) => legacyNotices.push(payload) },
        slowStreams,
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
      await stream.reader.closeReader();
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

  const bindings = await createMainBindings({
    env: f.env,
    createMessageChannel: f.createMessageChannel,
  });
  t.after(() => bindings.core.dispose());

  f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface: baseSurface } });
  const frame1 = await f.writeFrame(1, 0x10);
  f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frame1 } });

  const deliveredEntries = [];
  bindings.wire.frames.subscribe(entry => {
    deliveredEntries.push(entry);
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(deliveredEntries.length, 1);

  // 1. Trigger a single CORE_TIMEOUT (3000 ms deadline) on an unanswered intent while the socket stays healthy.
  dropNextIntent = true;
  await assert.rejects(
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
    await bindings.core.request({
      op: 'intent',
      json: JSON.stringify({
        schema: 'ui_intent/v0.2',
        request_id: 'req-take-after-timeout',
        op: 'take_control',
        params: { surface_id: 's1' },
      }),
    }),
    true,
  );
  assert.equal(
    await bindings.core.request({
      op: 'intent',
      json: JSON.stringify({
        schema: 'ui_intent/v0.2',
        request_id: 'req-release-after-timeout',
        op: 'release_control',
        params: { surface_id: 's1' },
      }),
    }),
    true,
  );

  // Frame streaming also remains alive after the recovered timeout.
  const frame2 = await f.writeFrame(2, 0x20);
  f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frame2 } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(deliveredEntries.at(-1).frameRef.generation, 2);

  // 3. Negative control: an actual transport disconnect or wire protocol violation still calls shutdown()
  // and transitions the authority wire to unavailable (CORE_SEAMS_ABSENT).
  f.disconnect();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(bindings.core.getStatus().availability, 'unavailable');
  assert.equal(bindings.core.getStatus().reason, 'CORE_SEAMS_ABSENT');
  await assert.rejects(
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
  );
});
