import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  installAuthorityWire,
  deliverAuthorityFrame,
} from '../electron/authorityWire.js';
import { createMainBindings } from '../electron/hostBindings.js';
import { createPreloadFacade } from '../electron/preload.js';

const registration = (component) => ({
  endpoint: { component, instance: `${component}-test` },
  hello: {
    schema: 'hello/v0.2',
    contract_version: 'v0.2',
    component,
    component_version: '0.1.2',
    component_commit: 'a'.repeat(40),
    dependencies: [],
  },
});

function makeSurface(surfaceId = 's1', control = 'human', state = 'active', w = 320, h = 200) {
  return {
    schema: 'surface/v0.2',
    surface_id: surfaceId,
    kind: 'browser',
    display: ':99',
    geometry: { w, h },
    state,
    visibility: 'unfolded',
    control,
    profile_id: 'default',
  };
}

async function setupInputHarness(t) {
  const root = await mkdtemp(join(tmpdir(), 'mv-r3-elec1-'));
  const configDir = join(root, 'config');
  await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const socketPath = join(root, 'metaviewer', 'core.sock');
  const configPath = join(root, 'config.json');
  const config = {
    session_id: 'r3-elec1-session',
    core: registration('core'),
    peers: [registration('ui')],
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  const appliedActions = [];
  let refuseActionType = null;
  let serverSeq = 0;
  const sockets = new Set();

  const sendToHost = (conn, body) => {
    if (conn.destroyed) return;
    serverSeq += 1;
    conn.write(
      `${JSON.stringify({
        schema: 'envelope/v0.2',
        msg_id: `reply-${serverSeq}`,
        ts_ns: serverSeq * 1000,
        from: config.core.endpoint,
        to: config.peers[0].endpoint,
        session_id: config.session_id,
        seq: serverSeq,
        nonce: `nonce-${serverSeq}`,
        body,
      })}\n`,
    );
  };

  const server = createServer((conn) => {
    sockets.add(conn);
    conn.on('close', () => sockets.delete(conn));
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const env = JSON.parse(line);
        const body = env.body;
        if (body.schema === 'hello/v0.2') {
          sendToHost(conn, config.core.hello);
          sendToHost(conn, {
            schema: 'surface_event/v0.2',
            event: 'created',
            data: { surface: makeSurface('s1', 'human', 'active', 320, 200) },
          });
          continue;
        }
        if (body.schema === 'surface_request/v0.2' && body.op === 'input') {
          const action = body.params.action;
          if (refuseActionType && action.type === refuseActionType) {
            sendToHost(conn, {
              schema: 'action_verdict/v0.2',
              proposal_id: body.params.proposal_id,
              decision: 'refused',
              reason_code: 'POLICY',
              core_seq: serverSeq + 1,
            });
          } else {
            appliedActions.push(action);
            sendToHost(conn, {
              schema: 'action_verdict/v0.2',
              proposal_id: body.params.proposal_id,
              decision: 'admitted',
              core_seq: serverSeq + 1,
            });
          }
        }
      }
    });
  });

  server.listen(socketPath);
  await once(server, 'listening');
  await chmod(socketPath, 0o600);

  let fakeNow = 1_000_000;
  const clock = () => fakeNow;

  const env = {
    XDG_RUNTIME_DIR: root,
    XDG_CONFIG_HOME: configDir,
    MV_CORE_CONFIG: configPath,
  };
  const createMessageChannel = () => {
    const port1 = new EventEmitter();
    Object.assign(port1, { postMessage() {}, start() {}, close() {} });
    const port2 = { close() {} };
    return { port1, port2 };
  };
  const host = await createMainBindings({ env, createMessageChannel, inputDeadlineMs: 5000 });
  const handlers = new Map();
  const frame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false, postMessage() {} };
  const event = { sender: contents, senderFrame: frame };
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const wire = installAuthorityWire({
    ipcMain,
    contents,
    core: host.core,
    frames: host.wire.frames,
    env,
    argv: [],
    now: clock,
  });
  const api = createPreloadFacade({
    transport: {
      nested: false,
      invoke: (channel, args) => handlers.get(channel)(event, ...args),
      subscribe: () => () => {},
    },
    bridge: { exposeInMainWorld() {} },
  });

  t.after(async () => {
    await wire.dispose();
    await host.core.dispose();
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  return {
    api,
    host,
    wire,
    appliedActions,
    setRefuseActionType(val) {
      refuseActionType = val;
    },
    advanceClock(ms) {
      fakeNow += ms;
    },
  };
}

test('T5-R3-02: partial input-batch retry skips already-applied prefix primitives; full batch still applies once', { timeout: 10000 }, async (t) => {
  const { api, host, appliedActions, setRefuseActionType } = await setupInputHarness(t);

  // Negative control 1: a wholly-refused batch failing at index 0 does not advance the applied floor
  setRefuseActionType('click');
  const whollyRefused = await api.input.send({
    schema: 'surface_input/v1',
    surface_id: 's1',
    stream_id: 1,
    seq: 1,
    events: [
      { kind: 'click', x: 10, y: 10, button: 'left' },
      { kind: 'key', keys: ['Return'] },
    ],
  });
  assert.deepEqual(whollyRefused, { ok: false, code: 'SCHEMA' });
  assert.equal(appliedActions.length, 0);

  // Negative control 2: a full batch applies once and rejects duplicate seq replay
  setRefuseActionType(null);
  const fullBatch = {
    schema: 'surface_input/v1',
    surface_id: 's1',
    stream_id: 1,
    seq: 1,
    events: [
      { kind: 'click', x: 12, y: 14, button: 'left' },
      { kind: 'key', keys: ['Tab'] },
    ],
  };
  const fullOk = await api.input.send(fullBatch);
  assert.deepEqual(fullOk, { ok: true, accepted: 2 });
  assert.equal(appliedActions.length, 2);

  const duplicateFull = await api.input.send(fullBatch);
  assert.deepEqual(duplicateFull, { ok: false, code: 'SCHEMA' });
  assert.equal(appliedActions.length, 2);
  appliedActions.length = 0;

  // T5-R3-02 regression: submit 2-event batch [click, policy-refused-key] at seq 2, then retry
  setRefuseActionType('key');
  const partialBatch = {
    schema: 'surface_input/v1',
    surface_id: 's1',
    stream_id: 1,
    seq: 2,
    events: [
      { kind: 'click', x: 25, y: 30, button: 'left' },
      { kind: 'key', keys: ['Return'] },
    ],
  };
  const firstAttempt = await api.input.send(partialBatch);
  assert.deepEqual(firstAttempt, { ok: false, code: 'SCHEMA' });
  assert.equal(appliedActions.filter((a) => a.type === 'click').length, 1);

  // Retry while key is still policy-refused: click prefix is skipped
  const secondAttemptRefused = await api.input.send(partialBatch);
  assert.deepEqual(secondAttemptRefused, { ok: false, code: 'SCHEMA' });
  assert.equal(appliedActions.filter((a) => a.type === 'click').length, 1);
  assert.deepEqual(host.core.getInputProgress('s1'), { lastSeq: 1, partialSeq: 2, partialApplied: 1 });

  // Retry when key is admitted: click prefix is skipped, key is applied once, batch completes
  setRefuseActionType(null);
  const thirdAttemptOk = await api.input.send(partialBatch);
  assert.deepEqual(thirdAttemptOk, { ok: true, accepted: 2 });
  assert.equal(appliedActions.filter((a) => a.type === 'click').length, 1);
  assert.equal(appliedActions.filter((a) => a.type === 'key').length, 1);
  assert.deepEqual(host.core.getInputProgress('s1'), { lastSeq: 2, partialSeq: 0, partialApplied: 0 });
});

test('T5-R3-08: unknown surface IDs are bounded (N=65, N=4096) and known surface IDs keep their rate windows', { timeout: 10000 }, async (t) => {
  const { api, wire } = await setupInputHarness(t);

  // Seed 10 admitted batches on known surface s1 in the current 1s rate window
  for (let i = 1; i <= 10; i += 1) {
    const ok = await api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: i,
      events: [{ kind: 'key', keys: ['a'] }],
    });
    assert.deepEqual(ok, { ok: true, accepted: 1 });
  }
  assert.equal(wire.inputRateWindow.get('s1')?.length, 10);

  // Flood N=65 and N=4096 distinct unknown surface IDs
  for (const N of [65, 4096]) {
    for (let i = 1; i <= N; i += 1) {
      const res = await api.input.send({
        schema: 'surface_input/v1',
        surface_id: `unknown-${N}-${i}`,
        stream_id: 1,
        seq: 1,
        events: [{ kind: 'key', keys: ['a'] }],
      });
      assert.deepEqual(res, { ok: false, code: 'SURFACE_UNKNOWN' });
      assert.ok(wire.inputRateWindow.size <= 64, `expected inputRateWindow.size <= 64, got ${wire.inputRateWindow.size}`);
      assert.ok(wire.inputLastSeq.size <= 64);
      assert.ok(wire.inputInFlightSeq.size <= 64);
    }
  }

  // Negative control: known surface s1 kept its rate window of 10 entries across the flood
  assert.equal(wire.inputRateWindow.get('s1')?.length, 10);
  for (let i = 11; i <= 60; i += 1) {
    const ok = await api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: i,
      events: [{ kind: 'key', keys: ['a'] }],
    });
    assert.deepEqual(ok, { ok: true, accepted: 1 });
  }
  const limited = await api.input.send({
    schema: 'surface_input/v1',
    surface_id: 's1',
    stream_id: 1,
    seq: 61,
    events: [{ kind: 'key', keys: ['a'] }],
  });
  assert.deepEqual(limited, { ok: false, code: 'LIMIT' });
});

test('T5-R3-04: descending coalesced frame generations keep max generation; ascending generations publish newest', { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mv-r3-frame-'));
  const ram = await mkdtemp('/dev/shm/mv-r3-frame-');
  const configDir = join(root, 'config');
  await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const socketPath = join(root, 'metaviewer', 'core.sock');
  const configPath = join(root, 'config.json');
  const config = {
    session_id: 'r3-frame-session',
    core: registration('core'),
    peers: [registration('ui')],
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  const sockets = new Set();
  let activeConn = null;
  let serverSeq = 0;
  const sendToHost = (conn, body) => {
    if (!conn || conn.destroyed) return;
    serverSeq += 1;
    conn.write(
      `${JSON.stringify({
        schema: 'envelope/v0.2',
        msg_id: `reply-${serverSeq}`,
        ts_ns: serverSeq * 1000,
        from: config.core.endpoint,
        to: config.peers[0].endpoint,
        session_id: config.session_id,
        seq: serverSeq,
        nonce: `nonce-${serverSeq}`,
        body,
      })}\n`,
    );
  };

  const server = createServer((conn) => {
    activeConn = conn;
    sockets.add(conn);
    conn.on('close', () => sockets.delete(conn));
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const env = JSON.parse(line);
        if (env.body.schema === 'hello/v0.2') {
          sendToHost(conn, config.core.hello);
          sendToHost(conn, {
            schema: 'surface_event/v0.2',
            event: 'created',
            data: { surface: makeSurface('s1', 'human', 'active', 2, 2) },
          });
        }
      }
    });
  });

  server.listen(socketPath);
  await once(server, 'listening');
  await chmod(socketPath, 0o600);

  class FakePort extends EventEmitter {
    constructor() {
      super();
      this.peer = null;
      this.messages = [];
    }
    start() {}
    close() {}
    postMessage(data) {
      this.messages.push(data);
      this.peer?.emit('message', data);
    }
  }
  const createMessageChannel = () => {
    const port1 = new FakePort();
    const port2 = new FakePort();
    port1.peer = port2;
    port2.peer = port1;
    const ch = { port1, port2 };
    port2.on('message', (data) => {
      if (data?.kind === 'frame') {
        port2.postMessage({
          schema: 'frame_ack/v0.2',
          kind: 'ack',
          correlation: data.correlation,
          principal: data.principal,
          epoch: data.epoch,
          surfaceId: data.surfaceId,
          surfaceGeneration: data.surfaceGeneration,
          frameGeneration: data.frameGeneration,
          leaseId: data.leaseId,
          outcome: 'PRESENTED',
        });
      }
    });
    return ch;
  };

  const env = {
    XDG_RUNTIME_DIR: root,
    XDG_CONFIG_HOME: configDir,
    MV_CORE_CONFIG: configPath,
  };
  const host = await createMainBindings({ env, createMessageChannel });
  const streams = new Set();
  const deliveredGenerations = [];
  const deliveryWaiters = [];

  const waitForDeliveredCount = (count) => {
    if (deliveredGenerations.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      deliveryWaiters.push({ count, resolve });
    });
  };

  let heldGeneration = 1;
  let onEnteredAcquire = null;
  let acquireBarrier = null;
  let onStateFence = null;

  const armHoldBarrier = (gen) => {
    heldGeneration = gen;
    const entered = new Promise((r) => { onEnteredAcquire = r; });
    let release;
    acquireBarrier = new Promise((r) => { release = r; });
    return {
      entered,
      release: () => {
        heldGeneration = -1;
        release();
      },
    };
  };

  const flushFence = async () => {
    const fencePromise = new Promise((r) => { onStateFence = r; });
    sendToHost(activeConn, {
      schema: 'surface_event/v0.2',
      event: 'state_changed',
      data: { surface: makeSurface('s1', 'human', 'active', 2, 2) },
    });
    await fencePromise;
  };

  const contents = {
    id: 1,
    mainFrame: { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' },
    isDestroyed: () => false,
    postMessage(channel, payload) {
      if (channel === 'metaviewer:authority.frames') {
        deliveredGenerations.push(payload.frame_ref.generation);
        for (let i = deliveryWaiters.length - 1; i >= 0; i -= 1) {
          if (deliveredGenerations.length >= deliveryWaiters[i].count) {
            const w = deliveryWaiters.splice(i, 1)[0];
            w.resolve();
          }
        }
      }
    },
  };

  host.wire.frames.subscribe(async (entry) => {
    if (entry.stateOnly) {
      onStateFence?.();
      return;
    }
    if (entry.frameRef.generation === heldGeneration) {
      const origAcquire = entry.readerOptions.acquirePublishedLease;
      entry.readerOptions.acquirePublishedLease = async (req) => {
        onEnteredAcquire?.();
        await acquireBarrier;
        return origAcquire(req);
      };
    }
    let current = entry;
    while (current) {
      await deliverAuthorityFrame(current, contents, streams);
      current = typeof current.resolveLatestEntry === 'function' ? current.resolveLatestEntry() : null;
    }
  });

  t.after(async () => {
    for (const s of streams) {
      await s.reader.closeReader().catch(() => {});
      s.port.revokeFramePort('SHUTDOWN');
    }
    await host.core.dispose();
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(ram, { recursive: true, force: true });
  });

  const makeFrameFile = async (gen, byteVal) => {
    const bytes = Buffer.alloc(12, byteVal);
    const p = join(ram, `frame-${gen}.rgb`);
    await writeFile(p, bytes, { mode: 0o600 });
    return {
      schema: 'frame_ref/v0.2',
      surface_id: 's1',
      generation: gen,
      tick: gen,
      ts_ns: gen * 1000,
      width: 2,
      height: 2,
      format: 'rgb24',
      ramws_path: p,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      capture_us: 10,
    };
  };

  const f1 = await makeFrameFile(1, 0x11);
  const f2 = await makeFrameFile(2, 0x22);
  const f3 = await makeFrameFile(3, 0x33);
  const f4 = await makeFrameFile(4, 0x44);
  const f5 = await makeFrameFile(5, 0x55);
  const f6 = await makeFrameFile(6, 0x66);

  // T5-R3-04 regression: hold g1, publish g3 then g2 (descending), release g1 -> g3 delivered, g2 discarded
  const hold1 = armHoldBarrier(1);
  sendToHost(activeConn, { schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: f1 } });
  await hold1.entered;

  sendToHost(activeConn, { schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: f3 } });
  sendToHost(activeConn, { schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: f2 } });
  await flushFence();

  hold1.release();
  await waitForDeliveredCount(2);
  assert.deepEqual(deliveredGenerations, [1, 3]);

  // Negative control: hold g4, publish ascending g5 then g6, release g4 -> newest g6 delivered
  const hold4 = armHoldBarrier(4);
  sendToHost(activeConn, { schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: f4 } });
  await hold4.entered;

  sendToHost(activeConn, { schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: f5 } });
  sendToHost(activeConn, { schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: f6 } });
  await flushFence();

  hold4.release();
  await waitForDeliveredCount(4);
  assert.deepEqual(deliveredGenerations, [1, 3, 4, 6]);
});
