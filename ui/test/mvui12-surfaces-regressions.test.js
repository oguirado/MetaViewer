import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as surfaces from '../src/surfaces/tileScheduler.js';

const budget = Object.freeze({ maxDrawsPerTick: 1, maxUploadBytesPerTick: 64,
  maxPresentMsPerTick: 8, maxWarmResourcesPerSurface: 2, maxDrainSteps: 2 });
const state = { panelOpen: true, panelSelected: true, folded: false, width: 10, height: 10,
  viewportIntersecting: true, windowPresentationAllowed: true };
const binding = id => ({ surfaceId: id, principal: 'utility', epoch: 1, surfaceGeneration: 1 });
const canvas = () => ({ getContext: () => ({ createImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData() {} }) });
const frame = (id, gen = 1, extra = {}) => ({ ...binding(id), frameGeneration: gen, leaseId: `${id}-${gen}`,
  width: 1, height: 1, byteLength: 3, bytes: new Uint8Array([1, 2, 3]), ...extra });
function setup(ids, extra = {}) {
  const engine = surfaces.createTileScheduler({ budget, ...extra });
  for (const id of ids) {
    assert.equal(engine.registerSurface({ ...binding(id), state, captureLeaseId: `capture-${id}`, captureLeaseActive: true }).ok, true);
    engine.attachCanvas({ surfaceId: id, canvas: canvas() });
  }
  return engine;
}

test('R2-04: permanently deferred A cannot starve C behind fresh B', () => {
  const engine = setup(['A', 'B', 'C']);
  try {
    engine.submitFrame(frame('A', 1, { estimatedPresentMs: 1000 }));
    engine.submitFrame(frame('C'));
    const seen = [];
    for (let tick = 1; tick <= 3; tick++) {
      engine.submitFrame(frame('B', tick));
      seen.push(...engine.runTick().presented.map(record => record.surfaceId));
    }
    assert.ok(seen.includes('C'));
  } finally { engine.destroy(); }
});
test('R2-04 control: all-deferred turn preserves pending mailboxes', () => {
  const engine = setup(['A', 'B']);
  try {
    for (const id of ['A', 'B']) engine.submitFrame(frame(id, 1, { estimatedPresentMs: 1000 }));
    for (let tick = 0; tick < 2; tick++) {
      const turn = engine.runTick();
      assert.equal(turn.budgetDeferrals, 2);
      assert.deepEqual(turn.presented, []);
    }
    for (const id of ['A', 'B']) assert.equal(engine.getInstrumentation(id).pendingMailboxFrameGen, 1);
    engine.submitFrame(frame('A', 2));
    engine.submitFrame(frame('B', 2));
    assert.equal(engine.runTick().presented[0].surfaceId, 'A');
  } finally { engine.destroy(); }
});
test('R2-04 control: temporarily byte-deferred B keeps priority over fresh small draws', () => {
  const engine = setup(['A', 'B', 'C'], { budget: Object.freeze({ ...budget,
    maxUploadBytesPerTick: 9, maxDrawsPerTick: 2 }) });
  const wide = id => frame(id, 1, { width: 2, byteLength: 6, bytes: new Uint8Array(6) });
  try {
    engine.submitFrame(wide('A'));
    engine.submitFrame(wide('B'));
    engine.submitFrame(frame('C'));
    assert.deepEqual(engine.runTick().presented.map(record => record.surfaceId), ['A', 'C']);
    engine.submitFrame(frame('A', 2));
    engine.submitFrame(frame('C', 2));
    assert.equal(engine.runTick().presented[0].surfaceId, 'B');
  } finally { engine.destroy(); }
});

for (const throws of [true, false]) test(`R2-06: teardown isolates disposers (throws=${throws})`, () => {
  const releases = [], disposed = [];
  const engine = setup(['A'], { onReleaseLease: release => releases.push(release) });
  engine.submitFrame(frame('A'));
  for (const id of ['first', 'second']) engine.allocateWarmResource('A', {
    resourceId: id, byteLength: 4, dispose() { disposed.push(id); if (throws && id === 'first') throw Error('native boom'); },
  });
  try {
    const result = engine.destroySurface('A');
    assert.equal(result.ok, true);
    assert.equal(result.disposerFaults, throws ? 1 : 0);
    assert.deepEqual(disposed, ['first', 'second']);
    assert.equal(engine.getInstrumentation('A').destroyed, true);
    assert.equal(engine.getInstrumentation('A').captureLeaseActive, false);
    assert.equal(engine.getInstrumentation('A').canvasAttached, false);
    assert.equal(engine.registerSurface({ ...binding('A'), state }).reason, 'SURFACE_DESTROYED');
    assert.deepEqual(releases.map(release => release.reason), ['SURFACE_DESTROYED']);
    engine.destroySurface('A');
    assert.equal(disposed.length, 2);
  } finally { engine.destroy(); }
});

test('R2-12: only the current attach token may detach a canvas', () => {
  const engine = setup(['A']);
  try {
    const old = engine.attachCanvas({ surfaceId: 'A', canvas: canvas() });
    const current = engine.attachCanvas({ surfaceId: 'A', canvas: canvas() });
    assert.ok(current.token);
    assert.notEqual(old.token, current.token);
    engine.detachCanvas('A', old.token);
    engine.detachCanvas('A');
    assert.equal(engine.getInstrumentation('A').canvasAttached, true);
    engine.submitFrame(frame('A'));
    assert.equal(engine.runTick().presented.length, 1);
    engine.detachCanvas('A', current.token);
    assert.equal(engine.getInstrumentation('A').canvasAttached, false);
    engine.detachCanvas('missing', current.token);
  } finally { engine.destroy(); }
});

test('R2-17: later lease expires during an earlier draw; valid lease still presents', () => {
  let now = 0;
  const released = [];
  const engine = setup(['A', 'B', 'C'], { budget: Object.freeze({ ...budget, maxDrawsPerTick: 3, maxPresentMsPerTick: 50 }),
    clock: () => now, onReleaseLease: release => released.push(release),
    onPresent(record) { engine.presentHandle(record); if (record.surfaceId === 'A') now = 10; },
  });
  try {
    engine.submitFrame(frame('A'));
    engine.submitFrame(frame('B', 1, { leaseExpiresAtMs: 5 }));
    engine.submitFrame(frame('C', 1, { leaseExpiresAtMs: 20 }));
    const turn = engine.runTick();
    assert.deepEqual(turn.presented.map(record => record.surfaceId), ['A', 'C']);
    assert.equal(turn.rejectedStaleLeases, 1);
    assert.equal(released.find(release => release.surfaceId === 'B').reason, 'REFUSED');
    assert.equal(engine.getInstrumentation('B').drawSubmissions, 0);
  } finally { engine.destroy(); }
});

// Compile the actual template and exercise lifecycle with Vue's custom renderer.
async function component() {
  const { descriptor } = parse(readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8'));
  const compiled = compileScript(descriptor, { id: 'mvui12-surface', inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/from (['"])(.*?)\1/g, (_all, _quote, spec) =>
    `from ${JSON.stringify(spec === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL('../src/surfaces/tileScheduler.js', import.meta.url).href)}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default;
}
function mount(Component, engine, props) {
  const root = { children: [] };
  const renderer = vue.createRenderer({
    createElement: tag => ({ tag, children: [], props: {}, ...(tag === 'canvas' ? canvas() : {}) }),
    createText: text => ({ text }), createComment: () => ({ text: '' }),
    insert(child, parent) { child.parent = parent; parent.children.push(child); },
    remove(child) { const children = child.parent?.children; if (children) children.splice(children.indexOf(child), 1); },
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; },
    parentNode: node => node.parent, nextSibling: () => null,
    patchProp(node, key, _old, value) { node.props[key] = value; }, setScopeId() {},
  });
  const app = renderer.createApp({ setup: () => () => vue.h(Component, props) });
  app.provide('tileScheduler', engine); app.mount(root);
  return { root, close: () => app.unmount() };
}
const nodes = node => [node, ...(node.children ?? []).flatMap(nodes)];
test('R2-16: witness strip follows resolved live/stale state, never connection state', async () => {
  const Component = await component();
  for (const state of ['connecting', 'lost', 'empty', 'live', 'stale']) {
    const engine = setup(['A']);
    const mounted = mount(Component, engine, { surfaceId: 'A', state, frame: 'frame-witness', generation: 1 });
    try {
      const strips = nodes(mounted.root).filter(node => node.props?.class === 'mv-surface__strip');
      assert.equal(strips.length, ['live', 'stale'].includes(state) ? 1 : 0, state);
    } finally { mounted.close(); engine.destroy(); }
  }
});
test('R2-12 component: stale unmount preserves replacement; owner unmount detaches', async () => {
  const Component = await component();
  const engine = setup(['A']);
  const old = mount(Component, engine, { surfaceId: 'A' });
  const current = mount(Component, engine, { surfaceId: 'A' });
  try {
    old.close();
    assert.equal(engine.getInstrumentation('A').canvasAttached, true);
    current.close();
    assert.equal(engine.getInstrumentation('A').canvasAttached, false);
  } finally { engine.destroy(); }
});
