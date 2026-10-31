// INPUT-U2-PORT: renderer input port distillation unit (wheel accumulator,
// release_all on gate closure, drag-release clamp, tile default blocks).
// Every scenario runs against the REAL source and against a mutated copy of
// inputPort.js that must FAIL the same scenario (in-suite mutants; a mutation
// that does not apply fails the suite, so no mutant can silently no-op).
// Plain node:test; no sleeps, no sockets, no Electron.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as real from '../src/input/inputPort.js';
import { createInputDouble } from '../src/input/inputDouble.js';
import { tick } from './frame-wait.mjs';

const SRC_DIR = fileURLToPath(new URL('../src/input/', import.meta.url));
const SOURCE = readFileSync(join(SRC_DIR, 'inputPort.js'), 'utf8');

let mutantSeq = 0;
/**
 * Loads a mutated copy of inputPort.js (with its sibling frameMap.js).
 * @param {Array<[string, string]>} edits - [find, replace] pairs; each must apply exactly once.
 */
async function loadMutant(edits) {
  let text = SOURCE;
  for (const [find, replace] of edits) {
    assert.equal(text.split(find).length - 1, 1, `mutation must apply exactly once: ${find.slice(0, 50)}`);
    text = text.replace(find, () => replace);
  }
  const dir = mkdtempSync(join(tmpdir(), 'mv-inputu2-mut-'));
  try {
    copyFileSync(join(SRC_DIR, 'frameMap.js'), join(dir, 'frameMap.js'));
    writeFileSync(join(dir, 'inputPort.js'), text);
    mutantSeq += 1;
    return await import(`${pathToFileURL(join(dir, 'inputPort.js')).href}?m=${mutantSeq}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeSavedRaf() {
  let cb = null;
  return {
    raf: (fn) => { cb = fn; return 1; },
    cancelRaf: () => { cb = null; },
    fire: () => { const f = cb; cb = null; if (f) f(0); },
    get scheduled() { return cb !== null; },
  };
}

function makeFacade(reply = (batch) => ({ ok: true, accepted: batch.events.length })) {
  const calls = [];
  return { calls, send: (batch) => { calls.push(batch); return Promise.resolve(reply(batch)); } };
}

function rig(mod, { facade = makeFacade(), options = {} } = {}) {
  const frames = makeSavedRaf();
  const port = mod.createInputPort(facade, { raf: frames.raf, cancelRaf: frames.cancelRaf, ...options });
  const refusals = [];
  port.onRefusal((r) => refusals.push(r));
  return { port, facade, frames, refusals };
}

const wheel = (dx, dy, deltaMode, x = 5, y = 6) => ({ kind: 'scroll', dx, dy, x, y, deltaMode });
const click = (x = 10, y = 20, button = 'left') => ({ kind: 'click', x, y, button });
const key = (keys = ['Return']) => ({ kind: 'key', keys });
const RELEASE = { kind: 'release_all' };
const releaseCalls = (facade) => facade.calls.filter((b) => b.events.length === 1 && b.events[0].kind === 'release_all');

// ---------------------------------------------------------------- scenarios

const scenarios = {
  async wheelSixEventsTwoStepsCarry20(mod) {
    const { port, facade, frames } = rig(mod);
    for (let i = 0; i < 6; i += 1) port.queue('s', 1, wheel(0, 20, 0));
    frames.fire();
    await tick();
    assert.equal(facade.calls.length, 1);
    assert.deepEqual(facade.calls[0].events, [{ kind: 'scroll', dx: 0, dy: 2, x: 5, y: 6 }], '120 px = 2 steps');
    port.queue('s', 1, wheel(0, 29, 0));
    assert.equal(frames.scheduled, false, '20 + 29 = 49 px: still below one step');
    port.queue('s', 1, wheel(0, 1, 0));
    frames.fire();
    await tick();
    assert.deepEqual(facade.calls[1].events, [{ kind: 'scroll', dx: 0, dy: 1, x: 5, y: 6 }], 'carry of 20 px survived');
    port.dispose();
  },

  async wheelLineModeScaled(mod) {
    const { port, facade, frames } = rig(mod);
    port.queue('s', 1, wheel(0, 3, 1));
    frames.fire();
    await tick();
    assert.deepEqual(facade.calls[0].events, [{ kind: 'scroll', dx: 0, dy: 1, x: 5, y: 6 }], '3 lines = 57 px = 1 step');
    port.queue('s', 1, wheel(0, 43, 0));
    frames.fire();
    await tick();
    assert.equal(facade.calls[1].events[0].dy, 1, 'carry of 7 px + 43 px = 1 step');
    port.dispose();
  },

  async wheelPageModeScaled(mod) {
    const { port, facade, frames } = rig(mod);
    port.queue('s', 1, wheel(0, 1, 2));
    assert.equal(frames.scheduled, false, 'one page = 19 px: zero steps');
    frames.fire();
    await tick();
    assert.equal(facade.calls.length, 0);
    port.queue('s', 1, wheel(0, 31, 0));
    frames.fire();
    await tick();
    assert.equal(facade.calls.length, 1, '19 px carry + 31 px = one step');
    // Page mode with a larger delta must scale as well (3 pages = 57 px).
    port.queue('t', 1, wheel(0, 3, 2));
    frames.fire();
    await tick();
    assert.equal(facade.calls[1].events[0].dy, 1);
    port.dispose();
  },

  async wheelNegativeAndHorizontalAxes(mod) {
    const { port, facade, frames } = rig(mod);
    port.queue('s', 1, wheel(-3, -3, 1, 7, 8));
    frames.fire();
    await tick();
    assert.deepEqual(facade.calls[0].events, [{ kind: 'scroll', dx: -1, dy: -1, x: 7, y: 8 }], 'sign kept, axes independent');
    port.queue('s', 1, wheel(-43, 0, 0));
    frames.fire();
    await tick();
    assert.equal(facade.calls[1].events[0].dx, -1, '-7 px carry + -43 px');
    assert.equal(facade.calls[1].events[0].dy, 0);
    port.dispose();
  },

  async wheelWireShapeIsClosed(mod) {
    const { port, facade, frames } = rig(mod);
    port.queue('s', 1, wheel(0, 100, 0));
    frames.fire();
    await tick();
    const [ev] = facade.calls[0].events;
    assert.deepEqual(Object.keys(ev).sort(), ['dx', 'dy', 'kind', 'x', 'y'], 'deltaMode never reaches the wire');
    assert.equal(real.isValidInputEvent(ev), true);
    port.dispose();
  },

  async wheelDoesNotMergeWithLegacyScroll(mod) {
    const { port, facade, frames } = rig(mod);
    port.queue('s', 1, { kind: 'scroll', dx: 0, dy: 120, x: 1, y: 1 });
    port.queue('s', 1, wheel(0, 100, 0, 2, 2));
    frames.fire();
    await tick();
    assert.deepEqual(facade.calls[0].events, [
      { kind: 'scroll', dx: 0, dy: 120, x: 1, y: 1 },
      { kind: 'scroll', dx: 0, dy: 2, x: 2, y: 2 },
    ], 'legacy pixels and wheel steps are different units');
    port.dispose();
  },

  async wheelCarryResetsOnGateStreamAndSurface(mod) {
    const { port, facade, frames } = rig(mod);
    port.queue('s', 1, wheel(0, 40, 0));
    port.closeGate('s', { release: false });
    port.queue('s', 1, wheel(0, 40, 0));
    assert.equal(frames.scheduled, false, 'gate closure drops the 40 px remainder');
    port.queue('s', 2, wheel(0, 40, 0));
    assert.equal(frames.scheduled, false, 'a new stream starts from zero');
    port.queue('other', 2, wheel(0, 40, 0));
    assert.equal(frames.scheduled, false, 'surfaces do not share remainders');
    port.queue('s', 2, wheel(0, 10, 0));
    frames.fire();
    await tick();
    assert.equal(facade.calls.length, 1);
    assert.equal(facade.calls[0].surface_id, 's');
    port.dispose();
  },

  async wheelRejectsHostileInput(mod) {
    const { port, facade, frames, refusals } = rig(mod);
    const bad = [
      wheel(0, 1, 3), wheel(0, 1, -1), wheel(0, 1, '1'), wheel(0, 1.5, 1), wheel(0, Number.MAX_SAFE_INTEGER, 1),
      { ...wheel(0, 1, 0), extra: 1 }, { kind: 'scroll', dx: 0, dy: 1, x: -1, y: 0, deltaMode: 0 },
    ];
    for (const ev of bad) port.queue('s', 1, ev);
    assert.equal(refusals.length, bad.length);
    assert.ok(refusals.every((r) => r.code === 'SCHEMA'));
    frames.fire();
    await tick();
    assert.equal(facade.calls.length, 0);
    port.dispose();
  },

  async wheelStepsPerEventCapped(mod) {
    const { port, facade, frames } = rig(mod);
    port.queue('s', 1, wheel(0, 50_000_000, 0));
    frames.fire();
    await tick();
    assert.equal(facade.calls[0].events[0].dy, real.WHEEL_MAX_STEPS_PER_EVENT);
    port.dispose();
  },

  async clicksNeverMerge(mod) {
    const { port, facade, frames } = rig(mod);
    port.queue('s', 1, click(1, 1));
    port.queue('s', 1, click(2, 2));
    port.queue('s', 1, wheel(0, 100, 0));
    port.queue('s', 1, click(3, 3, 'right'));
    frames.fire();
    await tick();
    assert.deepEqual(facade.calls[0].events.map((e) => e.kind), ['click', 'click', 'scroll', 'click']);
    assert.deepEqual(facade.calls[0].events[1], click(2, 2));
    port.dispose();
  },

  async blurAfterInputSendsExactlyOneRelease(mod) {
    const { port, facade, frames, refusals } = rig(mod);
    port.queue('s', 7, key());
    frames.fire();
    await tick();
    assert.equal(facade.calls.length, 1);
    port.closeGate('s');
    port.closeGate('s');
    port.closeGate('s');
    await tick();
    const releases = releaseCalls(facade);
    assert.equal(releases.length, 1, 'exactly one release_all');
    assert.equal(releases[0].stream_id, 7, 'release goes to the stream that took input');
    assert.equal(releases[0].seq, 2);
    assert.deepEqual(releases[0].events, [RELEASE]);
    assert.equal(refusals.length, 0);
    port.dispose();
  },

  async releaseBypassesEpochDropAndKeepsStaleInputDropped(mod) {
    const { port, facade, frames } = rig(mod);
    port.queue('s', 1, key());
    frames.fire();
    await tick();
    port.queue('s', 1, { kind: 'type', text: 'stale' });
    port.closeGate('s');
    frames.fire();
    await tick();
    assert.equal(releaseCalls(facade).length, 1, 'release survives the epoch drop');
    assert.ok(facade.calls.every((b) => b.events.every((e) => e.kind !== 'type')), 'stale input stays dropped');
    port.queue('s', 1, key(['a']));
    frames.fire();
    await tick();
    assert.deepEqual(facade.calls.at(-1).events, [key(['a'])], 'fresh input dispatches after the release');
    port.dispose();
  },

  async readSwitchAndIdleSurfacesSendNoRelease(mod) {
    const { port, facade, frames } = rig(mod);
    port.closeGate('s');
    port.queue('s', 1, key());
    port.closeGate('s');
    frames.fire();
    await tick();
    assert.equal(facade.calls.length, 0, 'queued but never dispatched input holds nothing');
    port.queue('s', 1, key());
    frames.fire();
    await tick();
    port.closeGate('s', { release: false });
    port.closeGate('s');
    await tick();
    assert.equal(releaseCalls(facade).length, 0, 'READ switch (release:false) sends none, nor later closes');
    port.dispose();
  },

  async releaseCanBeDisabledByOption(mod) {
    const { port, facade, frames } = rig(mod, { options: { releaseAll: false } });
    port.queue('s', 1, key());
    frames.fire();
    await tick();
    port.closeGate('s');
    assert.equal(releaseCalls(facade).length, 0);
    port.dispose();
  },

  async reentrantClosureInsideSendNeverReleases(mod) {
    const calls = [];
    let port;
    const frames = makeSavedRaf();
    port = mod.createInputPort({
      send: (batch) => {
        calls.push(batch);
        port.closeGate('s');
        return Promise.resolve({ ok: true, accepted: batch.events.length });
      },
    }, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    port.queue('s', 1, key());
    frames.fire();
    await tick();
    assert.equal(calls.length, 1, 'host-driven closure inside the facade send is not an operator blur');
    port.dispose();
  },

  async releaseIgnoresRendererRateWindow(mod) {
    const { port, facade, frames } = rig(mod, { options: { now: () => 1000 } });
    for (let i = 0; i < 60; i += 1) {
      port.queue('s', 1, key([String(i % 10)]));
      frames.fire();
    }
    await tick();
    assert.equal(facade.calls.length, 60);
    port.closeGate('s');
    await tick();
    assert.equal(releaseCalls(facade).length, 1, '61st batch in the window is the release and still goes');
    port.dispose();
  },

  async releaseBenignRefusalsSilentSchemaLoud(mod) {
    for (const code of ['NOT_IN_CONTROL', 'INPUT_MODE_READ', 'STALE_STREAM', 'SURFACE_UNKNOWN']) {
      const facade = makeFacade((b) => (b.events[0].kind === 'release_all' ? { ok: false, code } : { ok: true, accepted: 1 }));
      const { port, frames, refusals } = rig(mod, { facade });
      port.queue('s', 1, key());
      frames.fire();
      await tick();
      port.closeGate('s');
      await tick();
      assert.equal(releaseCalls(facade).length, 1);
      assert.deepEqual(refusals, [], `${code} on a release is silent`);
      port.dispose();
    }
    const facade = makeFacade((b) => (b.events[0].kind === 'release_all' ? { ok: false, code: 'SCHEMA' } : { ok: true, accepted: 1 }));
    const { port, frames, refusals } = rig(mod, { facade });
    port.queue('s', 1, key());
    frames.fire();
    await tick();
    port.closeGate('s');
    await tick();
    assert.deepEqual(refusals, [{ surfaceId: 's', code: 'SCHEMA' }], 'an unsupported release stays visible');
    // The same benign code on a normal batch is still reported.
    const f2 = makeFacade(() => ({ ok: false, code: 'NOT_IN_CONTROL' }));
    const r2 = rig(mod, { facade: f2 });
    r2.port.queue('s', 1, key());
    r2.frames.fire();
    await tick();
    assert.deepEqual(r2.refusals, [{ surfaceId: 's', code: 'NOT_IN_CONTROL' }]);
    // A host that said NOT_IN_CONTROL holds nothing: the blur sends no release.
    r2.port.closeGate('s');
    await tick();
    assert.equal(releaseCalls(f2).length, 0);
    port.dispose();
    r2.port.dispose();
  },

  async queuedReleaseSurvivesAndIsNotDuplicated(mod) {
    const { port, facade, frames } = rig(mod);
    port.queue('s', 3, RELEASE);
    port.closeGate('s');
    port.closeGate('s');
    frames.fire();
    await tick();
    assert.equal(releaseCalls(facade).length, 1);
    assert.equal(facade.calls[0].stream_id, 3);
    port.dispose();
  },

  async directSendTracksLiveInput(mod) {
    const { port, facade } = rig(mod);
    assert.deepEqual(await port.send('s', 4, [click()]), { ok: true, accepted: 1 });
    port.closeGate('s');
    await tick();
    assert.equal(releaseCalls(facade).length, 1);
    assert.equal(releaseCalls(facade)[0].stream_id, 4);
    assert.deepEqual(await port.send('s', 4, [RELEASE]), { ok: true, accepted: 1 });
    port.closeGate('s');
    await tick();
    assert.equal(releaseCalls(facade).length, 2, 'an explicit release clears the live mark: no third');
    port.dispose();
  },
};

const SCENARIO_NAMES = Object.keys(scenarios);

describe('INPUT-U2 real source passes every scenario', () => {
  for (const name of SCENARIO_NAMES) {
    it(name, async () => { await scenarios[name](real); });
  }
});

// ------------------------------------------------------------- pure helpers

describe('INPUT-U2 pure helpers', () => {
  it('wheelDeltaToPixels scales every non-pixel mode by 19', () => {
    assert.equal(real.wheelDeltaToPixels(7, 0), 7);
    assert.equal(real.wheelDeltaToPixels(3, 1), 57);
    assert.equal(real.wheelDeltaToPixels(1, 2), 19);
    assert.equal(real.wheelDeltaToPixels(-2, 2), -38);
    assert.equal(real.wheelDeltaToPixels(1, 3), null);
    assert.equal(real.wheelDeltaToPixels(1.5, 0), null);
  });

  it('accumulateWheel splits whole 50 px steps and keeps the signed remainder', () => {
    assert.deepEqual(real.accumulateWheel(0, 120), { steps: 2, carry: 20 });
    assert.deepEqual(real.accumulateWheel(0, 57), { steps: 1, carry: 7 });
    assert.deepEqual(real.accumulateWheel(0, 19), { steps: 0, carry: 19 });
    assert.deepEqual(real.accumulateWheel(0, -57), { steps: -1, carry: -7 });
    assert.deepEqual(real.accumulateWheel(40, 10), { steps: 1, carry: 0 });
  });

  it('release_all is a closed event kind', () => {
    assert.equal(real.isValidInputEvent({ kind: 'release_all' }), true);
    assert.equal(real.isValidInputEvent({ kind: 'release_all', keys: ['Alt'] }), false);
    assert.equal(real.isValidInputEvent({ kind: 'release_all', x: 1 }), false);
    assert.equal(real.isValidInputEvent({ kind: 'release_everything' }), false);
    assert.equal(real.isValidInputEvent({ kind: 'scroll', dx: 0, dy: 1, x: 0, y: 0, deltaMode: 0 }), false, 'deltaMode is not a wire field');
  });

  it('the recording double accepts a release_all batch', async () => {
    const dbl = createInputDouble();
    const result = await dbl.send({
      schema: real.INPUT_SCHEMA, surface_id: 's', stream_id: 1, seq: 1, events: [RELEASE],
    });
    assert.deepEqual(result, { ok: true, accepted: 1 });
  });
});

// ------------------------------------------------ drag clamp / tile defaults

const rect = { left: 100, top: 50, width: 200, height: 100 };
const dragScenarios = {
  clampedReleaseLandsOnTheFrameEdge(mod) {
    // Frame 100x100 in a 200x100 box: image spans client x 150..250, y 50..150.
    const at = (clientX, clientY) => mod.mapClientToFrameClamped({
      clientX, clientY, rect, frameWidth: 100, frameHeight: 100,
    });
    assert.deepEqual(at(200, 100), { x: 50, y: 50 }, 'inside the frame behaves as the strict mapper');
    assert.deepEqual(at(10, 100), { x: 0, y: 50 }, 'left of the frame clamps to column 0');
    assert.deepEqual(at(120, 100), { x: 0, y: 50 }, 'inside the left letterbox clamps to column 0');
    assert.deepEqual(at(999, 100), { x: 99, y: 50 }, 'right of the frame clamps to the last column');
    assert.deepEqual(at(200, -500), { x: 50, y: 0 });
    assert.deepEqual(at(200, 5000), { x: 50, y: 99 });
    assert.deepEqual(at(-1e9, 1e9), { x: 0, y: 99 });
  },
  invalidGeometryStillNull(mod) {
    const base = { clientX: 1, clientY: 1, rect, frameWidth: 100, frameHeight: 100 };
    for (const bad of [
      null, {}, { ...base, rect: null }, { ...base, rect: { ...rect, width: 0 } }, { ...base, frameWidth: 0 },
      { ...base, frameHeight: 1.5 }, { ...base, clientX: NaN }, { ...base, clientY: Infinity },
    ]) {
      assert.equal(mod.mapClientToFrameClamped(bad), null);
    }
  },
  strictMapperStillDropsLetterbox() {
    // Presses stay strict: the clamped mapper is for the release of an in-frame press only.
    return import('../src/input/frameMap.js').then(({ mapClientToFrame }) => {
      assert.equal(mapClientToFrame({ clientX: 120, clientY: 100, rect, frameWidth: 100, frameHeight: 100 }), null);
    });
  },
  tileBlocksContextmenuAndAuxclickOnlyInWrite(mod) {
    for (const type of ['contextmenu', 'auxclick']) {
      assert.equal(mod.shouldBlockTileDefault(type, true), true, `${type} is blocked in WRITE`);
      assert.equal(mod.shouldBlockTileDefault(type, false), false, `${type} is left alone in READ`);
      assert.equal(mod.shouldBlockTileDefault(type, undefined), false);
      assert.equal(mod.shouldBlockTileDefault(type, 'yes'), false);
    }
    for (const type of ['click', 'pointerdown', 'wheel', 'keydown', 7, null]) {
      assert.equal(mod.shouldBlockTileDefault(type, true), false, `${String(type)} is not a blocked default`);
    }
    assert.deepEqual([...mod.TILE_BLOCKED_DEFAULTS], ['contextmenu', 'auxclick']);
  },
};

describe('INPUT-U2 drag clamp and tile defaults (real source)', () => {
  for (const [name, fn] of Object.entries(dragScenarios)) {
    it(name, async () => { await fn(real); });
  }
});

// ------------------------------------------------------------------ mutants

/** @type {Array<{ name: string, edits: Array<[string, string]>, killedBy: string[] }>} */
const SCENARIO_MUTANTS = [
  {
    name: 'page mode is not scaled (only line mode is)',
    edits: [['deltaMode === 0 ? delta : delta * WHEEL_LINE_PX', 'deltaMode === 1 ? delta * WHEEL_LINE_PX : delta']],
    killedBy: ['wheelPageModeScaled'],
  },
  {
    name: 'line mode is not scaled',
    edits: [['deltaMode === 0 ? delta : delta * WHEEL_LINE_PX', 'delta']],
    killedBy: ['wheelLineModeScaled', 'wheelPageModeScaled'],
  },
  {
    name: 'wrong step size',
    edits: [['export const WHEEL_STEP_PX = 50;', 'export const WHEEL_STEP_PX = 40;']],
    killedBy: ['wheelSixEventsTwoStepsCarry20'],
  },
  {
    name: 'remainder is dropped between events',
    edits: [['state.cy = ay.carry;', 'state.cy = 0;']],
    killedBy: ['wheelSixEventsTwoStepsCarry20'],
  },
  {
    name: 'remainder survives the gate closure',
    edits: [['wheelCarryBySurface.delete(id);\n    const live', 'const live']],
    killedBy: ['wheelCarryResetsOnGateStreamAndSurface'],
  },
  {
    name: 'remainder leaks across streams',
    edits: [['state.streamId !== streamId', 'false']],
    killedBy: ['wheelCarryResetsOnGateStreamAndSurface'],
  },
  {
    name: 'deltaMode leaks onto the wire',
    edits: [['dy: ay.steps, x: input.x, y: input.y };', 'dy: ay.steps, x: input.x, y: input.y, deltaMode: input.deltaMode };']],
    killedBy: ['wheelWireShapeIsClosed'],
  },
  {
    name: 'wheel steps merge with legacy pixel scrolls',
    edits: [['&& WHEEL_STEP_EVENTS.has(prev) === WHEEL_STEP_EVENTS.has(ev)) {', ') {']],
    killedBy: ['wheelDoesNotMergeWithLegacyScroll'],
  },
  {
    name: 'unknown deltaMode accepted',
    edits: [
      ['(ev.deltaMode === 0 || ev.deltaMode === 1 || ev.deltaMode === 2)', 'true'],
      ['if (deltaMode !== 0 && deltaMode !== 1 && deltaMode !== 2) return null;', ''],
    ],
    killedBy: ['wheelRejectsHostileInput'],
  },
  {
    name: 'step count uncapped',
    edits: [['const steps = Math.max(-WHEEL_MAX_STEPS_PER_EVENT, Math.min(WHEEL_MAX_STEPS_PER_EVENT, whole));', 'const steps = whole;']],
    killedBy: ['wheelStepsPerEventCapped'],
  },
  {
    name: 'clicks merge',
    edits: [["prev.kind === 'type' && ev.kind === 'type') {", "prev.kind === 'type' && ev.kind === 'type' || prev.kind === 'click' && ev.kind === 'click') {"]],
    killedBy: ['clicksNeverMerge'],
  },
  {
    name: 'release is queued under the old epoch (swallowed by the drop)',
    edits: [["[{ kind: 'release_all' }], gateEpochBySurface.get(id) ?? 0);", "[{ kind: 'release_all' }], (gateEpochBySurface.get(id) ?? 0) - 1);"]],
    killedBy: ['blurAfterInputSendsExactlyOneRelease', 'releaseBypassesEpochDropAndKeepsStaleInputDropped'],
  },
  {
    name: 'READ switch still releases',
    edits: [['&& !(options !== null && typeof options === \'object\' && options.release === false)', '']],
    killedBy: ['readSwitchAndIdleSurfacesSendNoRelease'],
  },
  {
    name: 'release is sent even when nothing was dispatched',
    edits: [
      ['} else if (live !== undefined && releaseEnabled', '} else if (releaseEnabled'],
      ['releaseStream = live;', 'releaseStream = live ?? 0;'],
    ],
    killedBy: ['readSwitchAndIdleSurfacesSendNoRelease', 'blurAfterInputSendsExactlyOneRelease'],
  },
  {
    name: 'release ignores the port-level off switch',
    edits: [['const releaseEnabled = options.releaseAll !== false;', 'const releaseEnabled = true;']],
    killedBy: ['releaseCanBeDisabledByOption'],
  },
  {
    name: 'closure inside the facade send releases',
    edits: [['releaseEnabled && sendDepth === 0', 'releaseEnabled']],
    killedBy: ['reentrantClosureInsideSendNeverReleases'],
  },
  {
    name: 'release consumes a renderer rate slot',
    edits: [['if (!releaseOnly && !takeRateSlot(surfaceId, now())) {', 'if (!takeRateSlot(surfaceId, now())) {']],
    killedBy: ['releaseIgnoresRendererRateWindow'],
  },
  {
    name: 'a dispatched release keeps the live mark (repeated closes release again)',
    edits: [
      ['if (releaseOnly) {\n        markReleaseSeq(surfaceId, seq);\n        liveStreamBySurface.delete(surfaceId);\n      } else {', 'if (releaseOnly) {\n        markReleaseSeq(surfaceId, seq);\n      } else {'],
      ['    liveStreamBySurface.delete(id);\n    /** @type {number | undefined} */', '    /** @type {number | undefined} */'],
    ],
    killedBy: ['blurAfterInputSendsExactlyOneRelease'],
  },
  {
    name: 'benign release refusals are reported',
    edits: [['releaseSeqs.has(key) && BENIGN_RELEASE_REFUSALS.includes(code)', 'false']],
    killedBy: ['releaseBenignRefusalsSilentSchemaLoud'],
  },
  {
    name: 'every release refusal is silent (SCHEMA hidden)',
    edits: [['releaseSeqs.has(key) && BENIGN_RELEASE_REFUSALS.includes(code)', 'releaseSeqs.has(key)']],
    killedBy: ['releaseBenignRefusalsSilentSchemaLoud'],
  },
  {
    name: 'not-admitted refusals do not clear the live mark',
    edits: [['if (NOT_ADMITTED_REFUSALS.includes(code)) liveStreamBySurface.delete(surfaceId);', '']],
    killedBy: ['releaseBenignRefusalsSilentSchemaLoud'],
  },
  {
    name: 'a queued release is dropped by the closure',
    edits: [['if (queuedRelease !== undefined) {', 'if (false) {']],
    killedBy: ['queuedReleaseSurvivesAndIsNotDuplicated'],
  },
  {
    name: 'direct sends are not tracked as live input',
    edits: [['liveStreamBySurface.set(batch.surface_id, batch.stream_id);', '']],
    killedBy: ['directSendTracksLiveInput'],
  },
  {
    name: 'release_all rejected by the closed schema',
    edits: [["if (kind === 'release_all') {", "if (kind === 'release_all_disabled') {"]],
    killedBy: ['directSendTracksLiveInput'],
  },
];

const DRAG_MUTANTS = [
  {
    name: 'drag release is dropped at the letterbox instead of clamped (X)',
    edits: [['Math.min(Math.max(input.clientX, left), left + fit.width - inset)', 'input.clientX']],
    killedBy: ['clampedReleaseLandsOnTheFrameEdge'],
  },
  {
    name: 'drag release is dropped at the letterbox instead of clamped (Y)',
    edits: [['Math.min(Math.max(input.clientY, top), top + fit.height - inset)', 'input.clientY']],
    killedBy: ['clampedReleaseLandsOnTheFrameEdge'],
  },
  {
    name: 'far edge clamps one pixel too far (off the frame)',
    edits: [['const inset = fit.scale / 2;', 'const inset = 0;']],
    killedBy: ['clampedReleaseLandsOnTheFrameEdge'],
  },
  {
    name: 'clamp accepts invalid geometry',
    edits: [['if (fit === null) return null;\n  if (typeof input.clientX', 'if (typeof input.clientX']],
    killedBy: ['invalidGeometryStillNull'],
  },
  {
    name: 'tile blocks contextmenu in READ',
    edits: [['writeArmed === true && typeof eventType', 'typeof eventType']],
    killedBy: ['tileBlocksContextmenuAndAuxclickOnlyInWrite'],
  },
  {
    name: 'tile no longer blocks auxclick',
    edits: [["Object.freeze(['contextmenu', 'auxclick'])", "Object.freeze(['contextmenu'])"]],
    killedBy: ['tileBlocksContextmenuAndAuxclickOnlyInWrite'],
  },
  {
    name: 'tile blocks every pointer default',
    edits: [['TILE_BLOCKED_DEFAULTS.includes(eventType)', "typeof eventType === 'string'"]],
    killedBy: ['tileBlocksContextmenuAndAuxclickOnlyInWrite'],
  },
];

async function failsOn(mod, runner) {
  try {
    await runner(mod);
  } catch {
    return true;
  }
  return false;
}

describe('INPUT-U2 mutants (each must be killed by its named scenario)', () => {
  for (const mutant of SCENARIO_MUTANTS) {
    it(`kills: ${mutant.name}`, async () => {
      const mod = await loadMutant(mutant.edits);
      for (const name of mutant.killedBy) {
        assert.ok(scenarios[name], `unknown scenario ${name}`);
        assert.equal(await failsOn(mod, scenarios[name]), true, `scenario ${name} must fail on the mutant`);
      }
    });
  }
  for (const mutant of DRAG_MUTANTS) {
    it(`kills: ${mutant.name}`, async () => {
      const mod = await loadMutant(mutant.edits);
      for (const name of mutant.killedBy) {
        assert.ok(dragScenarios[name], `unknown scenario ${name}`);
        assert.equal(await failsOn(mod, dragScenarios[name]), true, `scenario ${name} must fail on the mutant`);
      }
    });
  }
  it('control: an unmutated copy passes every scenario (the loader itself is sound)', async () => {
    const mod = await loadMutant([]);
    for (const name of SCENARIO_NAMES) await scenarios[name](mod);
    for (const fn of Object.values(dragScenarios)) await fn(mod);
  });
});
