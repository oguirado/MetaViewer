import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFrameReader, FRAME_REASONS } from '../electron/frameReader.js';
import { installPreload } from '../electron/preload.js';

const bytes = new Uint8Array([1, 2, 3]);
const reference = { schema: 'frame_ref/v0.2', surface_id: 'good', generation: 1, tick: 0, ts_ns: 0,
  capture_us: 0, width: 1, height: 1, format: 'rgb24', sha256: createHash('sha256').update(bytes).digest('hex'), ramws_path: '/dev/shm/mv/f.rgb' };
function harness(t, ref) {
  const acquired = [], binding = { principal: 'test', epoch: 1, surfaceId: ref.surface_id, surfaceGeneration: 1 };
  const reader = createFrameReader({ binding,
    limits: { maxFrameBytes: 3, maxWidth: 1, maxHeight: 1, readTimeoutMs: 1000, maxConcurrentReads: 1 },
    pixelEnvironment: { environmentId: 'test', zoom: 1, dpr: 1 }, onReleaseLease() {},
    acquirePublishedLease: async ({ frameRef }) => {
      acquired.push(frameRef);
      return { identity: { ...binding, frameGeneration: frameRef.generation, leaseId: 'lease' },
        published: true, byteLength: 3, readOwnedBytes: async () => bytes, release: async () => {} };
    },
  }); t.after(() => reader.closeReader());
  return { reader, acquired };
}
test('M-R1 admits eight ramws segments and refuses nine before acquisition', async t => {
  const ref = { ...reference, ramws_path: '/dev/shm/a/b/c/d/e/f/g/h' };
  const f = harness(t, ref);
  assert.equal((await f.reader.readFrame(ref)).ok, true);
  assert.equal(f.acquired.length, 1);
  assert.equal((await f.reader.readFrame({ ...ref, ramws_path: ref.ramws_path + '/i' })).reason, FRAME_REASONS.INVALID_PATH);
  assert.equal(f.acquired.length, 1);
});
for (const surface_id of ['good/bad', 'good bad', '-good', 'good:ok_1.2-3']) {
  test(`M-R2 isolated surface shape ${surface_id}`, async t => {
    const ref = { ...reference, surface_id }, f = harness(t, ref);
    const result = await f.reader.readFrame(ref), valid = surface_id === 'good:ok_1.2-3';
    assert.equal(result.ok, valid);
    if (!valid) assert.equal(result.reason, FRAME_REASONS.INVALID_CONTRACT);
    assert.equal(f.acquired.length, valid ? 1 : 0);
  });
  test(`M-P1 preload isolated surface shape ${surface_id}`, t => {
    const delivered = [], posts = [], listeners = new Map();
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      location: { origin: 'app://metaviewer' }, postMessage: (...args) => posts.push(args),
    } });
    t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
    const api = installPreload({ contextBridge: { exposeInMainWorld() {} }, ipcRenderer: {
      invoke: async () => true, on: (ch, fn) => listeners.set(ch, fn), removeListener() {},
    } }); t.after(api.authority.subscribeFrames(value => delivered.push(value)));
    const { ramws_path, ...frame_ref } = { ...reference, surface_id };
    const value = { frame_ref, surface: { schema: 'surface/v0.2', surface_id, kind: 'browser', display: ':1',
      geometry: { w: 1, h: 1 }, state: 'active', visibility: 'unfolded', control: 'human', profile_id: 'test' } };
    for (const fn of listeners.values()) fn({ ports: [{}] }, value);
    const count = surface_id === 'good:ok_1.2-3' ? 1 : 0;
    assert.equal(delivered.length, count); assert.equal(posts.length, count);
  });
}
