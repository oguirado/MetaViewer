import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFramePort } from '../electron/framePort.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const binding = { principal: 'ui', epoch: 1, surfaceId: 'folded', surfaceGeneration: 1 };
const frame = generation => ({ ...binding, frameGeneration: generation, leaseId: `lease-${generation}`,
  width: 1, height: 1, format: 'rgb24', sha256: 'a'.repeat(64), byteLength: 3,
  pixelSpec: { format: 'rgb24', channelOrder: 'RGB' }, bytes: new Uint8Array([1, 2, 3]) });

function linked(t, onFrame) {
  const ports = [new EventEmitter(), new EventEmitter()];
  ports.forEach((port, i) => Object.assign(port, { start() {}, close() {},
    postMessage: data => queueMicrotask(() => ports[1 - i].emit('message', { data })) }));
  const timers = new Map(), released = [[], []], revoked = [];
  const endpoints = ports.map((port, i) => createFramePort({ port, role: i ? 'receiver' : 'sender', binding,
    limits: { maxFrameBytes: 1024, ackTimeoutMs: 50, maxSurfacesPerPort: 1 },
    onReleaseLease: value => released[i].push(value), onRevoke: value => revoked.push(value),
    setTimer(callback) { const token = {}; timers.set(token, callback); return token; },
    clearTimer: token => timers.delete(token), ...(i ? { onFrame } : {}) }));
  t.after(() => endpoints.forEach(endpoint => endpoint.revokeFramePort('SHUTDOWN')));
  return { sender: endpoints[0], receiver: endpoints[1], timers, released, revoked };
}

// Mutation: omit postOutcomeAck(record, outcome) in consumeRecord.
test('U03 folded receiver drains 50 generations without drawing or timing out, then presents newest', async t => {
  let folded = true;
  const consumed = [], drawn = [];
  const f = linked(t, async value => {
    consumed.push(value.frameGeneration);
    if (!folded) drawn.push(value.frameGeneration);
    return { outcome: folded ? 'FOLD_DRAIN' : 'PRESENTED' };
  });
  for (let generation = 1; generation <= 50; generation++) {
    assert.equal(f.sender.postFrame(frame(generation)).ok, true);
    await tick();
    assert.equal(f.sender.getInstrumentation().ackedFloor, generation);
    assert.equal(f.receiver.getInstrumentation().acceptedFloor, generation);
    assert.equal(f.timers.size, 0, 'draining must cancel the ACK deadline');
  }
  assert.deepEqual(drawn, []);
  assert.deepEqual(consumed, Array.from({ length: 50 }, (_, i) => i + 1));
  assert.equal(f.sender.getInstrumentation().revoked, false);
  assert.deepEqual(f.revoked, []);
  for (const releases of f.released) {
    assert.equal(releases.length, 50);
    assert.equal(new Set(releases.map(value => value.leaseId)).size, 50);
    assert.ok(releases.every(value => value.reason === 'FOLD_DRAIN'));
  }
  folded = false;
  assert.equal(f.sender.postFrame(frame(51)).ok, true);
  await tick();
  assert.deepEqual(drawn, [51]);
  assert.equal(f.sender.getInstrumentation().ackedFloor, 51);
  assert.equal(f.timers.size, 0);
});

// Mutation: replace the sender's TIMEOUT revocation with a no-op.
test('U03 negative control: a receiver that never consumes still reaches ACK timeout', async t => {
  const f = linked(t, () => new Promise(() => {}));
  assert.equal(f.sender.postFrame(frame(1)).ok, true);
  await tick();
  assert.equal(f.timers.size, 1);
  const expire = [...f.timers.values()][0];
  expire();
  assert.equal(f.sender.getInstrumentation().revoked, true);
  assert.equal(f.sender.getInstrumentation().revokeReason, 'TIMEOUT');
  assert.equal(f.sender.getInstrumentation().timeouts, 1);
  assert.equal(f.released[0].length, 1);
  assert.equal(f.sender.postFrame(frame(2)).ok, false);
});
