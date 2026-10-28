import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  deliverAuthorityFrame,
  mapSurfaceInputRefusal,
  validateIntentBody,
  validateSurfaceInputBatch,
} from '../electron/authorityWire.js';

test('validateIntentBody enforces upper off-by-one caps for index, position, and size', () => {
  const validMove = {
    schema: 'ui_intent/v0.2',
    request_id: 'req-move-255',
    op: 'move',
    params: { slot_id: 'slot-1', group_id: 'group-1', index: 255 },
  };
  const validTab = {
    schema: 'ui_intent/v0.2',
    request_id: 'req-tab-255',
    op: 'tab',
    params: { slot_id: 'slot-1', group_id: 'group-1', index: 255 },
  };
  assert.equal(validateIntentBody(validMove), validMove);
  assert.equal(validateIntentBody(validTab), validTab);

  for (const op of ['move', 'tab']) {
    for (const badIndex of [-1, 256, 257]) {
      assert.throws(
        () =>
          validateIntentBody({
            schema: 'ui_intent/v0.2',
            request_id: `req-${op}-${badIndex}`,
            op,
            params: { slot_id: 'slot-1', group_id: 'group-1', index: badIndex },
          }),
        /INTENT/,
      );
    }
  }

  const validFloat = {
    schema: 'ui_intent/v0.2',
    request_id: 'req-float-max',
    op: 'float',
    params: {
      slot_id: 'slot-1',
      x_px: 16383,
      y_px: 16383,
      width_px: 16384,
      height_px: 16384,
    },
  };
  assert.equal(validateIntentBody(validFloat), validFloat);

  const validFloatMin = {
    schema: 'ui_intent/v0.2',
    request_id: 'req-float-min',
    op: 'float',
    params: {
      slot_id: 'slot-1',
      x_px: 0,
      y_px: 0,
      width_px: 1,
      height_px: 1,
    },
  };
  assert.equal(validateIntentBody(validFloatMin), validFloatMin);

  for (const [field, badVal] of [
    ['x_px', -1],
    ['x_px', 16384],
    ['y_px', -1],
    ['y_px', 16384],
    ['width_px', 0],
    ['width_px', 16385],
    ['height_px', 0],
    ['height_px', 16385],
  ]) {
    assert.throws(
      () =>
        validateIntentBody({
          ...validFloat,
          params: { ...validFloat.params, [field]: badVal },
        }),
      /INTENT/,
    );
  }
});

test('mapSurfaceInputRefusal maps OUT_OF_BOUNDS, POLICY, and PAYLOAD to SCHEMA', () => {
  assert.equal(mapSurfaceInputRefusal('OUT_OF_BOUNDS'), 'SCHEMA');
  assert.equal(mapSurfaceInputRefusal('POLICY'), 'SCHEMA');
  assert.equal(mapSurfaceInputRefusal('PAYLOAD'), 'SCHEMA');
  assert.equal(mapSurfaceInputRefusal('LOCKED_BY_OTHER'), 'NOT_IN_CONTROL');
  assert.equal(mapSurfaceInputRefusal('SURFACE_NOT_HUMAN_CONTROLLED'), 'NOT_IN_CONTROL');
  assert.equal(mapSurfaceInputRefusal('SURFACE_NOT_AGENT_CONTROLLED'), 'NOT_IN_CONTROL');
  assert.equal(mapSurfaceInputRefusal('STALE_FRAME'), 'STALE_STREAM');
  assert.equal(mapSurfaceInputRefusal('BUDGET_EXCEEDED'), 'LIMIT');
  assert.equal(mapSurfaceInputRefusal('UNMAPPED_REASON'), 'CORE_UNAVAILABLE');
});

test('validateSurfaceInputBatch enforces per-token key caps, click/scroll positions, and 32-bit scroll deltas', () => {
  const wrap = (event) =>
    validateSurfaceInputBatch({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 1,
      events: [event],
    });

  // 1-key token cap: 32 admitted, 33 refused
  assert.equal(wrap({ kind: 'key', keys: ['a'.repeat(32)] }).ok, true);
  assert.deepEqual(wrap({ kind: 'key', keys: ['a'.repeat(33)] }), { ok: false, code: 'SCHEMA' });

  // 2-key token cap: 15 admitted, 16 refused even when total chord length <= 32
  assert.equal(wrap({ kind: 'key', keys: ['a'.repeat(15), 'b'.repeat(15)] }).ok, true);
  assert.deepEqual(wrap({ kind: 'key', keys: ['a'.repeat(16), 'b'] }), { ok: false, code: 'SCHEMA' });
  assert.deepEqual(wrap({ kind: 'key', keys: ['a', 'b'.repeat(16)] }), { ok: false, code: 'SCHEMA' });

  // 3-key and 4-key token cap: 7 admitted, 8 refused even when total chord length <= 32
  assert.equal(wrap({ kind: 'key', keys: ['a'.repeat(7), 'b'.repeat(7), 'c'.repeat(7)] }).ok, true);
  assert.deepEqual(wrap({ kind: 'key', keys: ['a'.repeat(8), 'b', 'c'] }), { ok: false, code: 'SCHEMA' });
  assert.equal(
    wrap({ kind: 'key', keys: ['a'.repeat(7), 'b'.repeat(7), 'c'.repeat(7), 'd'.repeat(7)] }).ok,
    true,
  );
  assert.deepEqual(
    wrap({ kind: 'key', keys: ['a'.repeat(8), 'b', 'c', 'd'] }),
    { ok: false, code: 'SCHEMA' },
  );

  // 5-to-8-key token cap: 3 admitted, 4 refused
  assert.equal(wrap({ kind: 'key', keys: ['aaa', 'bbb', 'ccc', 'ddd', 'eee'] }).ok, true);
  assert.deepEqual(
    wrap({ kind: 'key', keys: ['aaaa', 'b', 'c', 'd', 'e'] }),
    { ok: false, code: 'SCHEMA' },
  );

  // Click coordinate bounds: 0..65535 admitted, -1 and 65536 refused
  assert.equal(wrap({ kind: 'click', x: 65535, y: 65535, button: 'left' }).ok, true);
  assert.equal(wrap({ kind: 'click', x: 0, y: 0, button: 'right' }).ok, true);
  for (const [x, y] of [
    [65536, 0],
    [0, 65536],
    [-1, 0],
    [0, -1],
  ]) {
    assert.deepEqual(wrap({ kind: 'click', x, y, button: 'left' }), { ok: false, code: 'SCHEMA' });
  }

  // Scroll coordinate and 32-bit signed delta bounds
  assert.equal(
    wrap({ kind: 'scroll', x: 65535, y: 65535, dx: -2147483648, dy: 2147483647 }).ok,
    true,
  );
  assert.equal(
    wrap({ kind: 'scroll', x: 0, y: 0, dx: 2147483647, dy: -2147483648 }).ok,
    true,
  );
  for (const badScroll of [
    { kind: 'scroll', x: 65536, y: 0, dx: 0, dy: 0 },
    { kind: 'scroll', x: 0, y: 65536, dx: 0, dy: 0 },
    { kind: 'scroll', x: -1, y: 0, dx: 0, dy: 0 },
    { kind: 'scroll', x: 0, y: -1, dx: 0, dy: 0 },
    { kind: 'scroll', x: 0, y: 0, dx: -2147483649, dy: 0 },
    { kind: 'scroll', x: 0, y: 0, dx: 2147483648, dy: 0 },
    { kind: 'scroll', x: 0, y: 0, dx: 0, dy: -2147483649 },
    { kind: 'scroll', x: 0, y: 0, dx: 0, dy: 2147483648 },
  ]) {
    assert.deepEqual(wrap(badScroll), { ok: false, code: 'SCHEMA' });
  }
});

test('deliverAuthorityFrame enforces 64-stream cap, port binding parity, and sender role', async () => {
  const bytes = new Uint8Array([10, 20, 30]);
  const sha = createHash('sha256').update(bytes).digest('hex');

  const makeEntry = (surfaceId, overrides = {}) => {
    const binding = {
      principal: 'ui',
      epoch: 1,
      surfaceId,
      surfaceGeneration: 1,
      ...(overrides.readerBinding ?? {}),
    };
    const portBinding = {
      ...binding,
      ...(overrides.portBinding ?? {}),
    };
    const wirePort = new EventEmitter();
    wirePort.postMessage = () => {};
    wirePort.start = () => {};
    wirePort.close = () => {};
    return {
      frameRef: {
        schema: 'frame_ref/v0.2',
        surface_id: surfaceId,
        generation: 1,
        tick: 1,
        ts_ns: 1,
        width: 1,
        height: 1,
        format: 'rgb24',
        ramws_path: '/dev/shm/f.rgb',
        sha256: sha,
        capture_us: 1,
      },
      state: {
        schema: 'surface/v0.2',
        surface_id: surfaceId,
        kind: 'browser',
        display: ':99',
        geometry: { w: 1, h: 1 },
        state: 'active',
        visibility: 'unfolded',
        control: 'agent',
        profile_id: 'default',
      },
      readerOptions: {
        binding,
        limits: {
          maxFrameBytes: 4096,
          maxWidth: 64,
          maxHeight: 64,
          readTimeoutMs: 1000,
          maxConcurrentReads: 1,
        },
        pixelEnvironment: { environmentId: 'test', zoom: 1, dpr: 1 },
        onReleaseLease() {},
        acquirePublishedLease: async () => ({
          identity: { ...binding, frameGeneration: 1, leaseId: `lease-${surfaceId}` },
          published: true,
          byteLength: 3,
          readOwnedBytes: async () => bytes,
          release: async () => {},
        }),
      },
      portOptions: {
        port: wirePort,
        role: overrides.role ?? 'sender',
        binding: portBinding,
        limits: { maxFrameBytes: 4096, ackTimeoutMs: 1000, maxSurfacesPerPort: 1 },
        onReleaseLease() {},
        onRevoke() {},
      },
    };
  };

  const streams = new Set();
  try {
    // Mismatched portOptions.binding fields and non-sender role are refused before adding stream
    for (const [field, badVal] of [
      ['principal', 'other'],
      ['epoch', 2],
      ['surfaceId', 'other-surface'],
      ['surfaceGeneration', 2],
    ]) {
      await assert.rejects(
        deliverAuthorityFrame(
          makeEntry('s-mismatch', { portBinding: { [field]: badVal } }),
          { postMessage() {} },
          streams,
        ),
        /FRAME_BINDING/,
      );
    }
    await assert.rejects(
      deliverAuthorityFrame(
        makeEntry('s-role', { role: 'receiver' }),
        { postMessage() {} },
        streams,
      ),
      /FRAME_BINDING/,
    );
    assert.equal(streams.size, 0);

    // Pre-populate 63 synthetic stream records, admit the 64th real stream, refuse the 65th
    for (let i = 1; i <= 63; i += 1) {
      streams.add({
        key: JSON.stringify(['ui', 1, `s-pre-${i}`, 1]),
        surfaceId: `s-pre-${i}`,
        reader: { closeReader: async () => {} },
        port: { revokeFramePort() {} },
      });
    }
    assert.equal(streams.size, 63);
    assert.equal(
      await deliverAuthorityFrame(makeEntry('s-64'), { postMessage() {} }, streams),
      true,
    );
    assert.equal(streams.size, 64);
    await assert.rejects(
      deliverAuthorityFrame(makeEntry('s-65'), { postMessage() {} }, streams),
      /FRAME_STREAM_CAP/,
    );
    assert.equal(streams.size, 64);
  } finally {
    for (const stream of [...streams]) {
      await stream.reader.closeReader().catch(() => {});
      stream.port.revokeFramePort('SHUTDOWN');
    }
  }
});
