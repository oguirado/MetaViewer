import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTerminalHost } from '../electron/terminalHost.js';

// In-process ports and an injected clock keep admission/retry checks deterministic.
test('TERM-FIX-3: same-seq retry survives refusal (MUT_SEQ_BEFORE_CHECK)', async () => {
  for (const limit of ['writeOps', 'writeBytes']) {
    let clock = 0;
    let exit;
    let killed = false;
    const writes = [], frames = [];
    const port1 = new EventEmitter();
    port1.postMessage = frame => frames.push(frame);
    port1.start = () => {};
    port1.close = () => {};
    const port2 = { postMessage: frame => port1.emit('message', frame) };
    const host = createTerminalHost({
      pty: { spawn: () => ({
        pid: 2147483647,
        onData() {}, onExit(fn) { exit = fn; },
        write(data) { writes.push(data); }, resize() {},
        kill() { killed = true; exit({ exitCode: 0 }); },
      }) },
      env: {}, createMessageChannel: () => ({ port1, port2 }), now: () => clock,
      [`${limit}Burst`]: 1, [`${limit}PerSec`]: 1,
      resizeBurst: 1, resizePerSec: 1,
    });
    try {
      await host.setEnabled(true);
      const { session } = await host.open({ command: 'shell', cols: 80, rows: 24 });
      const { port } = await host.attach({ session });
      const write = seq => port.postMessage({ session, seq, bytes: new Uint8Array([65]) });
      const refused = expectedSeq => assert.deepEqual(frames.pop(), {
        session, error: 'TERMINAL_IO_REFUSED', retryable: true, expectedSeq,
      });
      write(1);
      write(2);
      refused(2);
      assert.deepEqual(writes, ['A']);
      assert.equal(killed, false);
      clock += 1000;
      write(2);
      assert.deepEqual(writes, ['A', 'A']);
      assert.equal(killed, false);
      port.postMessage({ session, cols: 90, rows: 30 });
      port.postMessage({ session, cols: 91, rows: 30 });
      refused(3);
      await host.setEnabled(false);
      write(3);
      refused(3);
      await host.setEnabled(true);
      clock += 1000;
      write(3);
      assert.deepEqual(writes, ['A', 'A', 'A']);
      assert.equal(killed, false);
    } finally {
      await host.dispose();
    }
  }
});

async function fixture(limits = {}) {
  let clock = 0, exit, killed = false, throwPost = false;
  const writes = [], resizes = [], frames = [];
  const port1 = new EventEmitter();
  port1.postMessage = frame => {
    if (throwPost) throw new Error('closed port');
    frames.push(frame);
  };
  port1.start = () => {};
  port1.close = () => {};
  const port2 = { postMessage: frame => port1.emit('message', frame) };
  const host = createTerminalHost({
    pty: { spawn: () => ({
      pid: 2147483647,
      onData() {}, onExit(fn) { exit = fn; },
      write(data) { writes.push(data); }, resize(...size) { resizes.push(size); },
      kill() { killed = true; exit({ exitCode: 0 }); },
    }) },
    env: {}, createMessageChannel: () => ({ port1, port2 }), now: () => clock,
    ...limits,
  });
  await host.setEnabled(true);
  const { session } = await host.open({ command: 'shell', cols: 80, rows: 24 });
  const { port } = await host.attach({ session });
  return {
    host, writes, resizes, frames, session,
    get killed() { return killed; },
    advance(ms) { clock += ms; },
    throwPosts() { throwPost = true; },
    write(seq, bytes = [65]) { port.postMessage({ session, seq, bytes: new Uint8Array(bytes) }); },
    resize() { port.postMessage({ session, cols: 90, rows: 30 }); },
    ack() { port.postMessage({ session, ack: 1, bytes: 0 }); },
    refused(expectedSeq) {
      assert.deepEqual(frames.pop(), {
        session, error: 'TERMINAL_IO_REFUSED', retryable: true, expectedSeq,
      });
      assert.equal(killed, false);
    },
    fatal() {
      assert.deepEqual(frames.pop(), { session, error: 'TERMINAL_IO_REFUSED' });
      assert.equal(killed, true);
    },
  };
}

test('TERM-FIX-3: refusal budget is shared and bounded (MUT_REFUSAL_UNBOUNDED)', async () => {
  const f = await fixture();
  try {
    await f.host.setEnabled(false);
    for (let i = 0; i < 64; i += 1) {
      if (i % 2) f.resize(); else f.write(1);
      f.refused(1);
      f.ack(); // Output acknowledgements do not admit input or reset the budget.
    }
    f.write(1);
    f.fatal();
    assert.deepEqual(f.writes, []);
  } finally { await f.host.dispose(); }
});

test('TERM-FIX-3: admitted write and resize each reset refusal budget', async () => {
  const f = await fixture();
  try {
    for (const admission of ['write', 'resize', 'host.resize']) {
      await f.host.setEnabled(false);
      const before = f.writes.length + 1;
      for (let i = 0; i < 64; i += 1) { f.write(before); f.refused(before); }
      await f.host.setEnabled(true);
      if (admission === 'resize') f.resize();
      else if (admission === 'host.resize') await f.host.resize({ session: f.session, cols: 90, rows: 30 });
      else f.write(before);
      await f.host.setEnabled(false);
      // The write advanced the input sequence; resize leaves it unchanged.
      const expected = 2;
      for (let i = 0; i < 64; i += 1) { f.write(expected); f.refused(expected); }
      await f.host.setEnabled(true);
      f.resize(); // Reset before the next iteration.
    }
    assert.deepEqual(f.writes, ['A']);
    assert.equal(f.killed, false);
  } finally { await f.host.dispose(); }
});

test('TERM-FIX-3: bytes refusal consumes no ops (MUT_OPS_CHARGED_ON_BYTES_FAIL)', async () => {
  const f = await fixture({ writeOpsBurst: 1, writeOpsPerSec: 0,
    writeBytesBurst: 1, writeBytesPerSec: 0 });
  try {
    f.write(1, [65, 66]);
    f.refused(1);
    assert.deepEqual(f.writes, []);
    f.write(1);
    assert.deepEqual(f.writes, ['A']);
    f.write(1); // An admitted sequence cannot be replayed.
    f.fatal();
    assert.deepEqual(f.writes, ['A']);
  } finally { await f.host.dispose(); }
});

test('TERM-FIX-3: ops refusal consumes no bytes, same-seq retry admitted once', async () => {
  const f = await fixture({ writeOpsBurst: 1, writeOpsPerSec: 1,
    writeBytesBurst: 2, writeBytesPerSec: 0 });
  try {
    f.write(1);
    f.write(2);
    f.refused(2);
    f.advance(1000);
    f.write(2);
    assert.deepEqual(f.writes, ['A', 'A']);
    f.write(2);
    f.fatal();
    assert.deepEqual(f.writes, ['A', 'A']);
  } finally { await f.host.dispose(); }
});

test('TERM-FIX-3: disabled refusal preserves same-seq retry, skipped sequence is fatal', async () => {
  const f = await fixture();
  try {
    await f.host.setEnabled(false);
    f.write(1);
    f.refused(1);
    await f.host.setEnabled(true);
    f.write(1);
    assert.deepEqual(f.writes, ['A']);
    f.write(3);
    f.fatal();
    assert.deepEqual(f.writes, ['A']);
  } finally { await f.host.dispose(); }
});

test('TERM-FIX-3: zero-byte write is refused without admission or token charge', async () => {
  const f = await fixture({ writeOpsBurst: 1, writeOpsPerSec: 0 });
  try {
    f.write(1, []);
    f.refused(1);
    assert.deepEqual(f.writes, []);
    f.write(1);
    assert.deepEqual(f.writes, ['A']);
    assert.equal(f.killed, false);
  } finally { await f.host.dispose(); }
});

test('TERM-FIX-3: throwing resize refusal post keeps session alive (MUT_RESIZE_POST_UNGUARDED)', async () => {
  const f = await fixture({ resizeBurst: 1, resizePerSec: 1 });
  try {
    f.resize();
    const admitted = f.resizes.length;
    f.throwPosts();
    f.resize();
    assert.equal(f.killed, false);
    assert.equal(f.resizes.length, admitted);
    f.advance(1000);
    f.resize();
    assert.equal(f.resizes.length, admitted + 1);
    assert.equal(f.killed, false);
  } finally { await f.host.dispose(); }
});


test('TERM-FIX-3: ops, bytes and resize throttles each exhaust the refusal budget', async () => {
  for (const kind of ['writeOps', 'writeBytes', 'resize']) {
    const f = await fixture({ [`${kind}Burst`]: 1, [`${kind}PerSec`]: 0 });
    try {
      const attempt = () => kind === 'resize' ? f.resize() : f.write(2);
      if (kind === 'resize') f.resize(); else f.write(1);
      const expectedSeq = kind === 'resize' ? 1 : 2;
      for (let i = 0; i < 64; i += 1) { attempt(); f.refused(expectedSeq); }
      attempt();
      f.fatal();
      assert.deepEqual(f.writes, kind === 'resize' ? [] : ['A']);
    } finally { await f.host.dispose(); }
  }
});
