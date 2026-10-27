import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEmptySideTerminalFacade } from '../src/terminal/sideTerminalFacade.js';
import { createSideTerminalModel } from '../.kit/capsule-ui-kit/src/side-terminal/sideTerminalModel.js';
import * as sideTerminal from '../src/terminal/sideTerminalFacade.js';
import * as multislotProviders from '../src/multislot/multislotProviders.js';
import { compileSfc, childStub, mountComponent, flush } from './mvui2-terminal-mount.mjs';

const OVERLAY_URL = new URL('../src/terminal/SideTerminalOverlay.vue', import.meta.url);
const overlay = readFileSync(OVERLAY_URL, 'utf8');

/** Minimal stream-registry double: initialize() with zero sessions touches none of these. */
function stubRegistry() {
  return {
    createSession() {},
    beginAttach() {},
    applyRestoreSnapshot() {},
    writeOutputChunk() {},
    setControlLease() {},
    disposeSession() {},
    forgetSession() {},
  };
}

test('MV-1: a null facade produces a typed capabilities refusal', async () => {
  const model = createSideTerminalModel({ facade: null, createRegistry: stubRegistry });
  await model.initialize();
  const snap = model.snapshot();
  const assertTypedRefusal = error => {
    assert.equal(error, 'Terminal capabilities unavailable');
    assert.doesNotMatch(error, /Cannot read properties|TypeError|reading ['"]capabilities/);
  };
  assertTypedRefusal(snap.error);
  assert.throws(() => assertTypedRefusal("Cannot read properties of null (reading 'capabilities')"));
  assert.equal(snap.errorCode, 'TERMINAL_CAPABILITIES_UNAVAILABLE');
  assert.equal(snap.ready, false);
  model.dispose();
});

test('MV-1 fix: the empty facade initializes the kit model with no error text', async () => {
  const model = createSideTerminalModel({ facade: createEmptySideTerminalFacade(), createRegistry: stubRegistry });
  await model.initialize();
  const snap = model.snapshot();
  assert.equal(snap.error, '');
  assert.equal(snap.ready, true);
  assert.equal(snap.enabled, false);
  assert.deepEqual(snap.sessions, []);
  assert.ok(!/Cannot read properties|TypeError/.test(JSON.stringify(snap)));
  model.dispose();
});

test('empty facade answers the kit contract with typed refusals only', async () => {
  const facade = createEmptySideTerminalFacade();
  assert.deepEqual(await facade.capabilities(), { developerMode: false, commands: [] });
  assert.deepEqual(await facade.attach(), { enabled: false, sessions: [] });
  assert.equal(typeof facade.onData(() => {}), 'function');
  assert.equal(typeof facade.onExit(() => {}), 'function');
  await assert.rejects(facade.setEnabled(true), /Terminal access unavailable/);
  await assert.rejects(facade.open({ command: 'shell', args: [], cols: 80, rows: 24 }), /Terminal launch unavailable/);
  await assert.rejects(facade.ack({ session: 'x', seq: 1, bytes: 0 }), /Terminal session unavailable/);
  await assert.rejects(facade.write({ session: 'x', bytes: [] }), /Terminal session unavailable/);
  await assert.rejects(facade.resize({ session: 'x', cols: 80, rows: 24 }), /Terminal session unavailable/);
  await facade.setEnabled(true).then(
    () => assert.fail('setEnabled must refuse without a core'),
    (error) => assert.ok(!/Cannot read properties/.test(error.message), 'typed refusal, never JS internals'),
  );
  facade.close({ session: 'x' });
  facade.dispose();
});

test('MV-1: overlay hands the kit panel a non-null facade with no binding', async () => {
  const children = {};
  const Overlay = await compileSfc('terminal/SideTerminalOverlay.vue', {
    '/.kit/capsule-ui-kit/src/side-terminal/SideTerminalPanel.vue': childStub('terminal', children),
    './BrokerLaunchControls.vue': childStub('launch', children),
    './sideTerminalFacade.js': sideTerminal,
    '../multislot/multislotProviders.js': multislotProviders,
  });
  const f = mountComponent(Overlay, { open: true });
  try {
    await flush();
    const facade = children.terminal.attrs.facade;
    assert.ok(facade, 'kit panel receives a facade object, never null');
    assert.deepEqual(await facade.capabilities(), { developerMode: false, commands: [] });
    assert.deepEqual(await facade.attach(), { enabled: false, sessions: [] });
  } finally { f.app.unmount(); }
});

test('overlay rebind falls back to the empty facade instead of a null kit facade', () => {
  assert.ok(overlay.includes('createEmptySideTerminalFacade'));
  assert.ok(overlay.includes(':facade="facadeRef ?? undefined"'));
  const rebind = overlay.slice(overlay.indexOf('function rebind()'), overlay.indexOf('rebind();'));
  assert.ok(!rebind.includes('facadeRef.value = null'), 'no null facade reaches the kit panel');
});

test('overlay null-facade matcher detects the legacy path (negative control)', () => {
  const legacy = 'function rebind() { facadeRef.value = null; return; }';
  assert.ok(legacy.includes('facadeRef.value = null'));
});
