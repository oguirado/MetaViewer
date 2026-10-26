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
  const timers = {pendingCount: () => armed.size};
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
