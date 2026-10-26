import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFrameReader, FRAME_REASONS } from '../electron/frameReader.js';
const rgbBytes = () => new Uint8Array(36).fill(7);
const validRef = (over = {}) => ({schema: 'frame_ref/v0.1', surface_id: 'capsule-A',
  generation: 1, tick: 11, ts_ns: 22, width: 4, height: 3, format: 'rgb24',
  ramws_path: '/dev/shm/mv-test/f000001.rgb', capture_us: 33,
  sha256: createHash('sha256').update(rgbBytes()).digest('hex'), ...over});
const binding = {principal: 'test', epoch: 1, surfaceId: 'capsule-A', surfaceGeneration: 1};
const makeLease = ({identity, readImpl, releaseImpl}) => ({lease: {
  identity: {...binding, ...identity}, byteLength: 36, published: true,
  readOwnedBytes: readImpl, release: releaseImpl,
}});
const makeReader = ({acquireImpl}) => ({reader: createFrameReader({binding,
  limits: {maxFrameBytes: 4096, maxWidth: 64, maxHeight: 64, readTimeoutMs: 1000, maxConcurrentReads: 4},
  pixelEnvironment: {environmentId: 'test-rig', zoom: 1, dpr: 1},
  acquirePublishedLease: acquireImpl, onReleaseLease() {},
})});
it('R1-060 reversed completions never roll back the generation floor', async () => {
  const resolveRead = new Map();
  const releases = [];
  const { reader } = makeReader({ acquireImpl: async ({frameRef}) => {
    const generation = frameRef.generation;
    return makeLease({ identity: { frameGeneration: generation, leaseId: `lease-${generation}` },
      readImpl: () => new Promise(resolve => resolveRead.set(generation, resolve)),
      releaseImpl: async () => { releases.push(generation); } }).lease;
  }});
  const first = reader.readFrame(validRef());
  const second = reader.readFrame(validRef({generation: 2}));
  for (let turn = 0; turn < 50 && resolveRead.size < 2; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolveRead.size, 2);
  resolveRead.get(2)(rgbBytes());
  assert.equal((await second).ok, true);
  resolveRead.get(1)(rgbBytes());
  assert.equal((await first).reason, FRAME_REASONS.STALE_FRAME_GENERATION);
  assert.equal((await reader.readFrame(validRef({generation: 2}))).reason, FRAME_REASONS.STALE_FRAME_GENERATION);
  assert.deepEqual(releases.sort(), [1, 2]);
  await reader.closeReader();
});
