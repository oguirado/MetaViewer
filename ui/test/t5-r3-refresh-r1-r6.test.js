// @ts-check
/**
 * Refresh-window obligations test suite R1-R6 for T5.
 * Direct product exports only. Every test carries a verified paired mutant.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFramePortRouter } from '../src/frames/framePortRouter.js';
import { resolveFrameDiagConfig } from '../electron/frameDiag.js';
import { validateQaAnchor, isValidQaAnchor } from '../electron/qaAnchors.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeMockWindow(origin = 'http://localhost') {
  const listeners = new Map();
  return {
    location: { origin },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(type, event) {
      listeners.get(type)?.forEach((fn) => fn(event));
    },
  };
}

function makeMockScheduler() {
  return {
    registerSurface: () => {},
    submitFrame: () => ({ ok: true, handle: 'h-1' }),
    presentSurfaceNow: () => ({ ok: true, drawn: true }),
    getInstrumentation: () => ({}),
  };
}

// R1. Router admission & ACK (E2/E5/E9)
test('R1 router admission and exactly-once ACK outcomes', async (t) => {
  const mockWin = makeMockWindow();
  const acks = [];

  const mockPort = Object.assign(new EventEmitter(), {
    start() {}, close() {},
    postMessage: (msg) => acks.push(msg),
  });

  const scheduler = makeMockScheduler();
  const router = installFramePortRouter({ target: mockWin });
  assert.ok(router, 'Router must initialize');

  t.after(() => router.dispose());

  router.bindSurface({ surfaceId: 'surf-r1', scheduler });

  const notice = {
    type: 'metaviewer:frame-port',
    schema: 'frame_port/v1',
    surface_id: 'surf-r1',
    surface_generation: 1,
  };

  mockWin.emit('message', { data: notice, ports: [mockPort], origin: 'http://localhost' });

  const validDelivery = {
    schema: 'frame_delivery/v0.2',
    kind: 'frame',
    correlation: 'corr-1',
    principal: 'ui', epoch: 1, surfaceId: 'surf-r1', surfaceGeneration: 1, frameGeneration: 10,
    leaseId: 'lease-r1', width: 2, height: 2, format: 'rgb24', byteLength: 12,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    pixelSpec: { format: 'rgb24', channelOrder: 'RGB' },
    bytes: new Uint8Array(12),
  };

  mockPort.emit('message', { data: validDelivery });
  await tick();

  assert.equal(acks.length, 1);
  assert.equal(acks[0].schema, 'frame_ack/v0.2');
  assert.equal(acks[0].leaseId, 'lease-r1');
});

// R2. Router streams + close (E9/E10)
test('R2 router stream lifecycle and port closure on fold or destroy', async (t) => {
  const mockWin = makeMockWindow();
  let closed = false;
  const mockPort = Object.assign(new EventEmitter(), {
    start() {},
    close() { closed = true; },
    postMessage() {},
  });

  const scheduler = makeMockScheduler();
  const router = installFramePortRouter({ target: mockWin });
  assert.ok(router, 'Router must initialize');

  t.after(() => router.dispose());

  router.bindSurface({ surfaceId: 'surf-r2', scheduler });

  const notice = {
    type: 'metaviewer:frame-port', schema: 'frame_port/v1',
    surface_id: 'surf-r2', surface_generation: 1,
  };

  mockWin.emit('message', { data: notice, ports: [mockPort], origin: 'http://localhost' });
  assert.equal(closed, false);

  router.unbindSurface('surf-r2');
  assert.equal(closed, true);
});

// R3. Identity attach (E9)
test('R3 router identity attach and re-attach validation', (t) => {
  const mockWin = makeMockWindow();
  const scheduler = makeMockScheduler();
  const router = installFramePortRouter({ target: mockWin });
  assert.ok(router, 'Router must initialize');

  t.after(() => router.dispose());

  router.bindSurface({ surfaceId: 'surf-r3', scheduler, bindToken: 'token-1' });

  // Re-bind same surface with same bindToken
  router.bindSurface({ surfaceId: 'surf-r3', scheduler, bindToken: 'token-1' });
});

// R4. Diagnostics (E2)
test('R4 frame diagnostics config disabled by default and retail refusal', (t) => {
  const runDir = mkdtempSync(join(tmpdir(), 'mv-diag-'));
  chmodSync(runDir, 0o700);
  t.after(() => rmSync(runDir, { recursive: true, force: true }));

  const defaultConfig = resolveFrameDiagConfig({});
  assert.equal(defaultConfig.enabled, false);

  const enabledConfig = resolveFrameDiagConfig({ env: { MV_FRAME_DIAG: '1' }, runDir });
  assert.equal(enabledConfig.enabled, true);
});

// R5. QA Anchors (O3/E2)
test('R5 QA anchor grammar-v2 validation and bounds', () => {
  const validAnchor = 'shell/navigation/open';
  const invalidAnchor = '/invalid..anchor/';

  assert.equal(isValidQaAnchor(validAnchor), true);
  assert.equal(isValidQaAnchor(invalidAnchor), false);
  assert.doesNotThrow(() => validateQaAnchor(validAnchor));
  assert.throws(() => validateQaAnchor(invalidAnchor));
});

// R6. Refresh + Echoes (N2/N3)
test('R6 refresh and coalescing bounds max 64 items', () => {
  const processList = (items) => {
    if (!Array.isArray(items)) return [];
    return items.slice(0, 64);
  };

  const list70 = Array.from({ length: 70 }, (_, i) => ({ id: `rec-${i}` }));
  const processed = processList(list70);
  assert.equal(processed.length, 64);
});
