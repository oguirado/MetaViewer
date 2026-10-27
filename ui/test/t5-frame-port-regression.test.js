import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createFramePort } from '../electron/framePort.js';
const makeFrame = (over = {}) => ({
  principal: 'test', epoch: 1, surfaceId: 'capsule-A', surfaceGeneration: 1,
  frameGeneration: 1, leaseId: 'lease-1', width: 4, height: 4, format: 'rgb24',
  sha256: 'b'.repeat(64), byteLength: 48, pixelSpec: {format: 'rgb24', channelOrder: 'RGB'},
  bytes: new Uint8Array(48), ...over,
});
function makeSender() {
  const port = {postMessage() {}, on() {}, off() {}, close() {}, start() {}};
  const armed = new Set();
  const timers = {
    pendingCount: () => armed.size,
    fireFirst: () => {
      const [first] = armed;
      assert.ok(first, 'expected an armed timer');
      armed.delete(first);
      first();
    },
  };
  const sinks = {releases: [], revokes: []};
  const endpoint = createFramePort({port, role: 'sender',
    binding: {principal: 'test', epoch: 1, surfaceId: 'capsule-A', surfaceGeneration: 1},
    limits: {maxFrameBytes: 4096, ackTimeoutMs: 50, maxSurfacesPerPort: 4},
    onReleaseLease: value => sinks.releases.push(value), onRevoke: value => sinks.revokes.push(value),
    setTimer: callback => {armed.add(callback); return callback;}, clearTimer: callback => armed.delete(callback),
  });
  return {port, endpoint, timers, sinks};
}
it('R1-066 synchronous send failure revokes and releases exactly once', () => {
  const {port, endpoint, timers, sinks} = makeSender();
  port.postMessage = () => { throw new Error('transport failed'); };
  const result = endpoint.postFrame(makeFrame());
  assert.equal(result.ok, false);
  const state = endpoint.getInstrumentation();
  assert.equal(state.revoked, true);
  assert.equal(state.inFlightGeneration, null);
  assert.equal(state.pendingGeneration, null);
  assert.equal(timers.pendingCount(), 0);
  assert.equal(sinks.releases.length, 1);
  assert.equal(sinks.revokes.length, 1);
  endpoint.revokeFramePort();
  assert.equal(sinks.releases.length, 1);
  assert.equal(endpoint.postFrame(makeFrame({frameGeneration: 2})).ok, false);
});

it('R1-066 pending promotion failure cleans up both holdings', () => {
  const {port, endpoint, timers, sinks} = makeSender();
  assert.equal(endpoint.postFrame(makeFrame()).ok, true);
  assert.equal(timers.pendingCount(), 1);
  assert.equal(endpoint.postFrame(makeFrame({frameGeneration: 2, leaseId: 'lease-2'})).queued, true);
  port.postMessage = () => {throw new Error('promotion failed');};
  assert.equal(endpoint.acceptAck({kind: 'ack', correlation: 'capsule-A#1#lease-1',
    principal: 'test', epoch: 1, surfaceId: 'capsule-A', surfaceGeneration: 1,
    frameGeneration: 1, leaseId: 'lease-1', outcome: 'PRESENTED'}).ok, false);
  assert.equal(endpoint.getInstrumentation().revoked, true);
  assert.deepEqual(sinks.releases.map(value => value.leaseId).sort(), ['lease-1', 'lease-2']);
  assert.equal(timers.pendingCount(), 0);
});

it('T5-R2-10 synchronous reentrant ACK during postMessage arms 0 timers; genuinely unacked frame still times out', () => {
  const {port, endpoint, timers, sinks} = makeSender();
  let syncAck = true;
  port.postMessage = (msg) => {
    if (syncAck) {
      endpoint.acceptAck({
        kind: 'ack',
        correlation: msg.correlation,
        principal: msg.principal,
        epoch: msg.epoch,
        surfaceId: msg.surfaceId,
        surfaceGeneration: msg.surfaceGeneration,
        frameGeneration: msg.frameGeneration,
        leaseId: msg.leaseId,
        outcome: 'PRESENTED',
      });
    }
  };
  const first = endpoint.postFrame(makeFrame({frameGeneration: 1, leaseId: 'lease-1'}));
  assert.equal(first.ok, true);
  assert.equal(endpoint.getInstrumentation().inFlightGeneration, null);
  assert.equal(timers.pendingCount(), 0);

  // Post frame 2 without sync ACK: only 1 timer is armed for frame 2; firing it revokes frame 2 as control.
  syncAck = false;
  let capturedStaleCallback = null;
  const {port: port2, endpoint: endpoint2, timers: timers2} = makeSender();
  const origSetTimer = port2;
  assert.ok(origSetTimer);
  const second = endpoint.postFrame(makeFrame({frameGeneration: 2, leaseId: 'lease-2'}));
  assert.equal(second.ok, true);
  assert.equal(endpoint.getInstrumentation().inFlightGeneration, 2);
  assert.equal(timers.pendingCount(), 1);
  assert.equal(endpoint.getInstrumentation().revoked, false);

  timers.fireFirst();
  assert.equal(endpoint.getInstrumentation().revoked, true);
  assert.equal(endpoint.getInstrumentation().revokeReason, 'TIMEOUT');
  assert.equal(sinks.revokes.length, 1);
  assert.deepEqual(sinks.releases.map(r => [r.frameGeneration, r.reason]), [
    [1, 'PRESENTED'],
    [2, 'TIMEOUT'],
  ]);

  // Also verify token guard: invoking a captured stale timer callback from frame 1 cannot revoke frame 2.
  const callbacks = [];
  const tokenPort = {postMessage() {}, on() {}, off() {}, close() {}, start() {}};
  const tokenEndpoint = createFramePort({
    port: tokenPort,
    role: 'sender',
    binding: {principal: 'test', epoch: 1, surfaceId: 'capsule-A', surfaceGeneration: 1},
    limits: {maxFrameBytes: 4096, ackTimeoutMs: 50, maxSurfacesPerPort: 4},
    onReleaseLease() {},
    onRevoke() {},
    setTimer: cb => { callbacks.push(cb); return cb; },
    clearTimer() {},
  });
  assert.equal(tokenEndpoint.postFrame(makeFrame({frameGeneration: 1, leaseId: 'lease-1'})).ok, true);
  capturedStaleCallback = callbacks[0];
  assert.equal(tokenEndpoint.acceptAck({
    kind: 'ack',
    correlation: 'capsule-A#1#lease-1',
    principal: 'test',
    epoch: 1,
    surfaceId: 'capsule-A',
    surfaceGeneration: 1,
    frameGeneration: 1,
    leaseId: 'lease-1',
    outcome: 'PRESENTED',
  }).ok, true);
  assert.equal(tokenEndpoint.postFrame(makeFrame({frameGeneration: 2, leaseId: 'lease-2'})).ok, true);
  capturedStaleCallback();
  assert.equal(tokenEndpoint.getInstrumentation().revoked, false);
  assert.equal(tokenEndpoint.getInstrumentation().inFlightGeneration, 2);
  callbacks[1]();
  assert.equal(tokenEndpoint.getInstrumentation().revoked, true);
  assert.equal(tokenEndpoint.getInstrumentation().revokeReason, 'TIMEOUT');
  assert.equal(timers2.pendingCount(), 0);
});
