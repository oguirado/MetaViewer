import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createStdioLink,
  registerTerminalIpc,
  runBroker,
  spawnTerminalBroker,
  TERMINAL_CHANNEL_PREFIX,
} from '../electron/ptyBroker.js';
import { createBytePlane, PlaneError } from '../electron/bytePlane.js';
import { createPtySession } from '../electron/ptySession.js';

const profile = {
  command: 'provider',
  executable: '/bin/echo',
  argv: ['/bin/echo'],
  cwd: '/tmp',
  loginShell: '/bin/sh',
  env: { LANG: 'C', TERM: 'xterm' },
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('T5-R2-01 child engine refuses byte/frame-inconsistent ACKs and accepts exact boundary ACKs', async () => {
  let receive;
  let onData;
  let pauses = 0;
  let resumes = 0;
  const sent = [];
  const engine = runBroker({
    profiles: new Map([['provider', profile]]),
    limits: {
      highWaterBytes: 8,
      lowWaterBytes: 4,
      maxPendingBytes: 32,
      maxPendingFrames: 8,
    },
    processes: { record() {}, async reapOwned() {} },
    transport: {
      send: (value) => sent.push(value),
      onMessage(fn) {
        receive = fn;
        return () => {};
      },
    },
    pty: {
      spawn() {
        return {
          pid: 123,
          onData(fn) {
            onData = fn;
            return { dispose() {} };
          },
          onExit() {
            return { dispose() {} };
          },
          kill() {},
          write() {},
          resize() {},
          pause() {
            pauses += 1;
          },
          resume() {
            resumes += 1;
          },
        };
      },
    },
  });
  try {
    receive({ version: 1, generation: 1, op: 'open', id: 's1', provider: 'provider', command: 'provider' });
    await tick();
    onData(Buffer.from('abcd'));
    await tick();
    onData(Buffer.from('efgh'));
    await tick();
    assert.equal(pauses, 1);

    for (const badAck of [
      { ack_seq: 0, ack_bytes: 4 },
      { ack_seq: 1, ack_bytes: 0 },
      { ack_seq: 1, ack_bytes: 6 },
      { ack_seq: 2, ack_bytes: 4 },
    ]) {
      const beforeLen = sent.length;
      receive({ version: 1, generation: 1, op: 'ack', id: 's1', ...badAck });
      await tick();
      assert.equal(sent.length, beforeLen + 1);
      assert.equal(sent.at(-1).ev, 'error');
      assert.equal(sent.at(-1).code, 'ACK_REFUSED');
      assert.equal(resumes, 0);
    }

    // Negative control: consistent boundary ACKs advance watermarks and resume below lowWaterBytes.
    const countBeforeGood = sent.length;
    receive({ version: 1, generation: 1, op: 'ack', id: 's1', ack_seq: 1, ack_bytes: 4 });
    await tick();
    assert.equal(sent.length, countBeforeGood);
    assert.equal(resumes, 0);

    receive({ version: 1, generation: 1, op: 'ack', id: 's1', ack_seq: 2, ack_bytes: 8 });
    await tick();
    assert.equal(sent.length, countBeforeGood);
    assert.equal(resumes, 1);

    // Duplicate/stale ACK after boundary consumption is refused.
    receive({ version: 1, generation: 1, op: 'ack', id: 's1', ack_seq: 2, ack_bytes: 8 });
    await tick();
    assert.equal(sent.at(-1).code, 'ACK_REFUSED');
  } finally {
    await engine.dispose();
  }
});

test('T5-R2-02 bytePlane.ingest and child handleWrite pre-check base64 size before Buffer.from decode', async () => {
  const oversizedB64 = Buffer.alloc(1000, 0x61).toString('base64');
  const exactB64 = Buffer.alloc(64, 0x61).toString('base64');
  const ctx = {
    session: 's1',
    direction: 'output',
    serviceGeneration: 1,
    epoch: 1,
    attachmentGeneration: 0,
  };
  const limits = {
    maxFrameBytes: 64,
    highWaterBytes: 128,
    lowWaterBytes: 64,
    maxPendingBytes: 256,
    maxPendingFrames: 8,
    replayBytes: 128,
    maxSessionOutputBytes: 1024,
  };
  const plane = createBytePlane({
    limits,
    onPause() {},
    onResume() {},
    onFault() {},
  });
  plane.open(ctx);

  const originalFrom = Buffer.from;
  let b64FromCalls = 0;
  Buffer.from = function patchedFrom(value, encodingOrOffset, length) {
    if (encodingOrOffset === 'base64') b64FromCalls += 1;
    return originalFrom.call(Buffer, value, encodingOrOffset, length);
  };
  try {
    assert.throws(
      () => plane.ingest(ctx, { seq: 1, b64: oversizedB64 }),
      (err) => err instanceof PlaneError && err.code === 'frame-too-large',
    );
    assert.equal(b64FromCalls, 0, 'bytePlane.ingest must not call Buffer.from on oversized base64');

    // Negative control: exact-cap frame decodes once and passes.
    const controlCtx = { ...ctx, session: 's2' };
    plane.open(controlCtx);
    const frame = plane.ingest(controlCtx, { seq: 1, b64: exactB64 });
    assert.equal(frame.byteLength, 64);
    assert.equal(b64FromCalls, 1);
  } finally {
    Buffer.from = originalFrom;
  }

  let receive;
  const sent = [];
  const writes = [];
  const engine = runBroker({
    profiles: new Map([['provider', profile]]),
    limits: { maxWriteBytes: 64 },
    processes: { record() {}, async reapOwned() {} },
    transport: {
      send: (value) => sent.push(value),
      onMessage(fn) {
        receive = fn;
        return () => {};
      },
    },
    pty: {
      spawn() {
        return {
          pid: 123,
          onData() {
            return { dispose() {} };
          },
          onExit() {
            return { dispose() {} };
          },
          kill() {},
          write(text) {
            writes.push(text);
          },
          resize() {},
          pause() {},
          resume() {},
        };
      },
    },
  });
  try {
    receive({ version: 1, generation: 1, op: 'open', id: 's1', provider: 'provider', command: 'provider' });
    await tick();

    b64FromCalls = 0;
    Buffer.from = function patchedFromChild(value, encodingOrOffset, length) {
      if (encodingOrOffset === 'base64') b64FromCalls += 1;
      return originalFrom.call(Buffer, value, encodingOrOffset, length);
    };
    try {
      receive({ version: 1, generation: 1, op: 'write', id: 's1', b64: oversizedB64 });
      await tick();
      assert.equal(sent.at(-1).code, 'WRITE_TOO_LARGE');
      assert.equal(b64FromCalls, 0, 'handleWrite must not call Buffer.from on oversized base64');
      assert.equal(writes.length, 0);

      // Negative control: exact-cap write decodes and reaches PTY.
      receive({ version: 1, generation: 1, op: 'write', id: 's1', b64: exactB64 });
      await tick();
      assert.equal(writes.length, 1);
      assert.equal(writes[0], 'a'.repeat(64));
      assert.equal(b64FromCalls, 1);
    } finally {
      Buffer.from = originalFrom;
    }
  } finally {
    await engine.dispose();
  }
});

test('T5-R2-05 ptySession stores onData/onExit disposables and disposes idempotently on close and onExit', () => {
  const spec = {
    file: '/bin/echo',
    args: ['hello'],
    cwd: '/tmp',
    env: { PATH: '/usr/bin:/bin' },
  };
  let dataDisposed = 0;
  let exitDisposed = 0;
  let onDataCb;
  let onExitCb;
  const messages = [];
  const session1 = createPtySession({
    session: 'sess-1',
    spec,
    spawn() {
      return {
        onData(fn) {
          onDataCb = fn;
          return {
            dispose() {
              dataDisposed += 1;
            },
          };
        },
        onExit(fn) {
          onExitCb = fn;
          return {
            dispose() {
              exitDisposed += 1;
            },
          };
        },
        write() {},
        resize() {},
        pause() {},
        resume() {},
        kill() {},
      };
    },
    send(msg) {
      messages.push(msg);
    },
  });

  // Negative control: active before close
  assert.equal(dataDisposed, 0);
  assert.equal(exitDisposed, 0);
  onDataCb(Buffer.from('hi'));
  assert.equal(messages.length, 1);

  session1.close();
  assert.equal(dataDisposed, 1);
  assert.equal(exitDisposed, 1);

  // Double close is idempotent
  session1.close();
  assert.equal(dataDisposed, 1);
  assert.equal(exitDisposed, 1);

  // Also test onExit path and throwing first disposer resilience
  let dataDisposed2 = 0;
  let exitDisposed2 = 0;
  let onExitCb2;
  const session2 = createPtySession({
    session: 'sess-2',
    spec,
    spawn() {
      return {
        onData() {
          return {
            dispose() {
              dataDisposed2 += 1;
              throw new Error('boom');
            },
          };
        },
        onExit(fn) {
          onExitCb2 = fn;
          return {
            dispose() {
              exitDisposed2 += 1;
            },
          };
        },
        write() {},
        resize() {},
        pause() {},
        resume() {},
        kill() {},
      };
    },
    send(msg) {
      messages.push(msg);
    },
  });
  onExitCb2({ exitCode: 0 });
  assert.equal(dataDisposed2, 1);
  assert.equal(exitDisposed2, 1);
  session2.close();
  assert.equal(dataDisposed2, 1);
  assert.equal(exitDisposed2, 1);
});

test('T5-R2-07 bridge ack forwards before advancing bytePlane so retry after transport failure succeeds without double credit', async () => {
  const handlers = new Map();
  const forwarded = [];
  let receive;
  let failSend = false;
  const plane = createBytePlane({
    limits: {
      maxFrameBytes: 65536,
      highWaterBytes: 131072,
      lowWaterBytes: 65536,
      maxPendingBytes: 524288,
      maxPendingFrames: 4096,
      replayBytes: 131072,
      maxSessionOutputBytes: 8388608,
    },
    onPause() {},
    onResume() {},
    onFault() {},
  });
  const host = registerTerminalIpc({
    ipcMain: {
      handle: (name, fn) => handlers.set(name, fn),
      removeHandler: (name) => handlers.delete(name),
    },
    authenticate: () => ({ owner: 'owner' }),
    authority: {
      admit: async () => ({
        allowed: true,
        context: { session: 'session', epoch: 0 },
        profile,
      }),
    },
    providers: new Map([['provider', profile]]),
    transport: {
      send(message) {
        if (failSend) throw new Error('broken pipe');
        forwarded.push(message);
      },
      onMessage(fn) {
        receive = fn;
        return () => {};
      },
    },
    plane,
  });
  const call = (method, value) =>
    handlers.get(TERMINAL_CHANNEL_PREFIX + method)({}, { owner: 'owner', value });
  const ctx = {
    session: 'session',
    direction: 'output',
    serviceGeneration: 1,
    epoch: 0,
    attachmentGeneration: 0,
  };

  try {
    assert.equal((await call('open', { provider: 'provider', command: 'provider' })).ok, true);
    receive({ version: 1, generation: 1, ev: 'open', id: 'session', pid: 321 });
    receive({
      version: 1,
      generation: 1,
      ev: 'data',
      id: 'session',
      seq: 1,
      b64: Buffer.from('abcd').toString('base64'),
    });
    assert.deepEqual(plane.snapshot(ctx), {
      sent: 4,
      acked: 0,
      lastSeq: 1,
      pendingFrames: 1,
      paused: false,
    });

    // Forward fails twice while transport is down; ledger stays unacked.
    failSend = true;
    assert.deepEqual(await call('ack', { session: 'session', ack_seq: 1, ack_bytes: 4 }), {
      version: 1,
      generation: 1,
      ok: false,
      reason: 'TRANSPORT_FAILED',
    });
    assert.deepEqual(await call('ack', { session: 'session', ack_seq: 1, ack_bytes: 4 }), {
      version: 1,
      generation: 1,
      ok: false,
      reason: 'TRANSPORT_FAILED',
    });
    assert.equal(plane.snapshot(ctx).acked, 0);
    assert.equal(plane.snapshot(ctx).pendingFrames, 1);

    // Transport recovers: retry succeeds and credits exactly once.
    failSend = false;
    assert.deepEqual(await call('ack', { session: 'session', ack_seq: 1, ack_bytes: 4 }), {
      version: 1,
      generation: 1,
      ok: true,
      session: 'session',
    });
    assert.equal(plane.snapshot(ctx).acked, 4);
    assert.equal(plane.snapshot(ctx).pendingFrames, 0);
    assert.equal(forwarded.filter((m) => m.op === 'ack').length, 1);

    // Control: duplicate ACK after recovery is refused with no double credit.
    assert.deepEqual(await call('ack', { session: 'session', ack_seq: 1, ack_bytes: 4 }), {
      version: 1,
      generation: 1,
      ok: false,
      reason: 'ACK_REFUSED',
    });
    assert.equal(plane.snapshot(ctx).acked, 4);
  } finally {
    await host.dispose();
  }
});

test('T5-R2-11 stdio link and broker transport preserve multibyte UTF-8 scalars split across chunks', async () => {
  const input = new EventEmitter();
  const linkMessages = [];
  const link = createStdioLink({
    input,
    output: { write() {} },
  });
  link.onMessage((msg) => linkMessages.push(msg));

  const payload = Buffer.from(`${JSON.stringify({ version: 1, text: '€100' })}\n`, 'utf8');
  const euroOffset = payload.indexOf(0xe2);
  assert.ok(euroOffset > 0);

  // Split 3-byte '€' (0xe2 0x82 0xac) across three separate chunks.
  input.emit('data', payload.subarray(0, euroOffset + 1));
  input.emit('data', payload.subarray(euroOffset + 1, euroOffset + 2));
  assert.equal(linkMessages.length, 0);
  input.emit('data', payload.subarray(euroOffset + 2));
  assert.equal(linkMessages.length, 1);
  assert.equal(linkMessages[0].text, '€100');

  // Also verify spawnTerminalBroker stdout chunk decoding.
  const childStdout = new EventEmitter();
  const childStdin = { write() {} };
  const transport = spawnTerminalBroker({
    entry: '/bin/echo',
    cwd: '/tmp',
    env: { LANG: 'C' },
    runtime: {
      kind: 'node-test',
      fork() {
        return {
          pid: 456,
          stdin: childStdin,
          stdout: childStdout,
          stderr: new EventEmitter(),
          on() {},
          kill() {},
        };
      },
    },
  });
  const transportMessages = [];
  transport.onMessage((msg) => transportMessages.push(msg));
  try {
    childStdout.emit('data', payload.subarray(0, euroOffset + 1));
    childStdout.emit('data', payload.subarray(euroOffset + 1, euroOffset + 2));
    assert.equal(transportMessages.length, 0);
    childStdout.emit('data', payload.subarray(euroOffset + 2));
    assert.equal(transportMessages.length, 1);
    assert.equal(transportMessages[0].text, '€100');

    // Control: split mid-line ASCII frames once upon newline.
    const ascii = Buffer.from('{"version":1,"text":"ascii-ok"}\n', 'utf8');
    childStdout.emit('data', ascii.subarray(0, 10));
    assert.equal(transportMessages.length, 1);
    childStdout.emit('data', ascii.subarray(10));
    assert.equal(transportMessages.length, 2);
    assert.equal(transportMessages[1].text, 'ascii-ok');
  } finally {
    await transport.dispose();
  }
});
