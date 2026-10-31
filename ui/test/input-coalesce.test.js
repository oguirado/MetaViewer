// INPUT-COALESCE: renderer keystroke coalescing (TYPE_COALESCE_MS = 40 ms),
// relative ordering with non-printable keys / clicks / scroll, gate-close drop
// accounting on release, and full-stack release_all SCHEMA regression tests.
// Plain node:test with an injected deterministic clock; no real sleeps.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as real from '../src/input/inputPort.js';
import { createPreloadFacade } from '../electron/preload.js';
import { installAuthorityWire, validateSurfaceInputBatch } from '../electron/authorityWire.js';
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
    assert.equal(text.split(find).length - 1, 1, `mutation must apply exactly once: ${find.slice(0, 60)}`);
    text = text.replace(find, () => replace);
  }
  const dir = mkdtempSync(join(tmpdir(), 'mv-input-coalesce-mut-'));
  try {
    copyFileSync(join(SRC_DIR, 'frameMap.js'), join(dir, 'frameMap.js'));
    writeFileSync(join(dir, 'inputPort.js'), text);
    mutantSeq += 1;
    return await import(`${pathToFileURL(join(dir, 'inputPort.js')).href}?m=${mutantSeq}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Deterministic injected clock driving `now()`, `raf`/`cancelRaf` (16 ms vsync)
 * and `setTimer`/`clearTimer` without wall-clock sleeps.
 */
function makeInjectedClock(startMs = 1_000_000) {
  let currentMs = startMs;
  let nextId = 1;
  /** @type {Map<number, { dueAt: number, cb: () => void }>} */
  const timers = new Map();
  /** @type {Map<number, (time: number) => void>} */
  const rafs = new Map();
  let lastVsyncMs = startMs;

  function now() {
    return currentMs;
  }

  function raf(cb) {
    const id = nextId;
    nextId += 1;
    rafs.set(id, cb);
    return id;
  }

  function cancelRaf(id) {
    rafs.delete(/** @type {number} */ (id));
  }

  function setTimer(cb, ms) {
    const id = nextId;
    nextId += 1;
    timers.set(id, { dueAt: currentMs + Math.max(0, ms), cb });
    return id;
  }

  function clearTimer(id) {
    timers.delete(/** @type {number} */ (id));
  }

  function fireRafs() {
    if (rafs.size === 0) return;
    const pending = Array.from(rafs.entries());
    rafs.clear();
    for (const [, cb] of pending) {
      cb(currentMs);
    }
  }

  function fireDueTimers() {
    for (;;) {
      let earliestId = null;
      let earliest = null;
      for (const [id, entry] of timers) {
        if (entry.dueAt <= currentMs && (earliest === null || entry.dueAt < earliest.dueAt)) {
          earliestId = id;
          earliest = entry;
        }
      }
      if (earliestId === null || earliest === null) break;
      timers.delete(earliestId);
      earliest.cb();
    }
  }

  /**
   * Steps simulated time forward by `deltaMs` in 1 ms ticks, firing 16 ms vsync
   * rAF callbacks and any due timers in chronological order.
   *
   * @param {number} deltaMs
   */
  function advance(deltaMs) {
    const target = currentMs + deltaMs;
    while (currentMs < target) {
      currentMs += 1;
      fireDueTimers();
      if (currentMs - lastVsyncMs >= 16) {
        lastVsyncMs = currentMs;
        fireRafs();
      }
      fireDueTimers();
    }
  }

  return {
    now,
    raf,
    cancelRaf,
    setTimer,
    clearTimer,
    fireRafs,
    fireDueTimers,
    advance,
    get pendingTimers() { return timers.size; },
    get pendingRafs() { return rafs.size; },
  };
}

function makeRig(mod, options = {}) {
  const clock = makeInjectedClock();
  /** @type {Array<{ at: number, batch: any }>} */
  const sent = [];
  const facade = {
    calls: sent,
    send(batch) {
      sent.push({ at: clock.now(), batch });
      return Promise.resolve({ ok: true, accepted: batch.events.length });
    },
  };
  const port = mod.createInputPort(facade, {
    now: clock.now,
    raf: clock.raf,
    cancelRaf: clock.cancelRaf,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...options,
  });
  /** @type {Array<{ surfaceId: string, code: string }>} */
  const refusals = [];
  port.onRefusal((r) => refusals.push(r));
  return { clock, port, facade, sent, refusals };
}

/**
 * Extracts concatenated `type` text from all sent batches.
 * @param {Array<{ at: number, batch: any }>} sent
 * @returns {string}
 */
function collectedText(sent) {
  return sent
    .flatMap((entry) => entry.batch.events)
    .filter((ev) => ev.kind === 'type')
    .map((ev) => ev.text)
    .join('');
}

/**
 * Flattens dispatched events across batches, merging adjacent `type` events so
 * relative ordering between text runs and non-type actions is exact.
 * @param {Array<{ at: number, batch: any }>} sent
 */
function flattenedTranscript(sent) {
  /** @type {any[]} */
  const out = [];
  for (const { batch } of sent) {
    for (const ev of batch.events) {
      const prev = out.at(-1);
      if (prev && prev.kind === 'type' && ev.kind === 'type') {
        prev.text += ev.text;
      } else {
        out.push(structuredClone(ev));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- scenarios

const scenarios = {
  async sustained10KeysPerSecond200Keys(mod) {
    const { clock, port, sent, refusals } = makeRig(mod);
    const expected = Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    for (let i = 0; i < expected.length; i += 1) {
      port.queue('s1', 1, { kind: 'type', text: expected[i] });
      clock.advance(100); // 10 keys/s = 100 ms per key
    }
    clock.advance(100);
    await tick();
    assert.deepEqual(refusals, [], '10 keys/s sustained produces zero refusals');
    assert.equal(collectedText(sent), expected, 'exact 200-char text in order');
    port.dispose();
  },

  async burst30KeysPerSecond200Keys(mod) {
    // 1. Uniform 30 keys/s burst of 200 keys (33 ms per key).
    {
      const { clock, port, sent, refusals } = makeRig(mod);
      const expected = Array.from({ length: 200 }, (_, i) => String.fromCharCode(65 + (i % 26))).join('');
      for (let i = 0; i < expected.length; i += 1) {
        port.queue('s1', 1, { kind: 'type', text: expected[i] });
        clock.advance(33);
      }
      clock.advance(100);
      await tick();
      assert.deepEqual(refusals, [], 'uniform 30 keys/s burst of 200 keys produces zero LIMIT refusals');
      assert.equal(collectedText(sent), expected, 'uniform 30 keys/s delivers exact 200 chars in order');
      assert.ok(sent.length < 180, `coalescing merges bursts below 1 batch/key (got ${sent.length})`);
      port.dispose();
    }

    // 2. Realistic human / xdotool burst averaging ~30 keys/s over 200 keys:
    // micro-bursts of 70 keys at 14 ms spacing (~71 keys/s instantaneous across
    // 16 ms frames, exceeding 60 frames/s inside a 1000 ms window) followed by
    // a brief cadence pause so the 200-key burst averages ~30 keys/s.
    {
      const { clock, port, sent, refusals } = makeRig(mod);
      const expected = Array.from({ length: 200 }, (_, i) => String.fromCharCode(48 + (i % 10))).join('');
      for (let i = 0; i < expected.length; i += 1) {
        port.queue('s1', 1, { kind: 'type', text: expected[i] });
        const stepMs = (i % 70 === 69) ? 1300 : 14;
        clock.advance(stepMs);
      }
      clock.advance(100);
      await tick();
      assert.deepEqual(refusals, [], 'bursty 30 keys/s (with 14 ms micro-bursts) produces zero LIMIT refusals');
      assert.equal(collectedText(sent), expected, 'bursty 30 keys/s delivers exact 200 chars in order');
      // Verify rate ceiling: no 1000 ms sliding window ever exceeds 30 sent batches (limit is 60).
      for (let i = 0; i < sent.length; i += 1) {
        const tEnd = sent[i].at;
        const inWindow = sent.filter((entry) => entry.at > tEnd - 1000 && entry.at <= tEnd).length;
        assert.ok(inWindow <= 30, `sliding 1 s batch count (${inWindow}) stays well below 60 batches/s`);
      }
      port.dispose();
    }
  },

  async nonPrintableAndPointerEventsPreserveOrder(mod) {
    const { clock, port, sent, refusals } = makeRig(mod);
    // Type "hello" across multiple frames so "llo" is held inside the 40 ms coalesce window.
    for (const ch of 'hello') {
      port.queue('s1', 1, { kind: 'type', text: ch });
      clock.advance(8);
    }
    // At t = +40 ms after first key (24 ms after first frame flush at +16 ms),
    // "llo" is still held in the coalesce window when Enter is pressed.
    port.queue('s1', 1, { kind: 'key', keys: ['Return'] });
    clock.advance(16);

    // Type "world" across multiple frames, then press Tab, ArrowLeft, and a modifier chord.
    for (const ch of 'world') {
      port.queue('s1', 1, { kind: 'type', text: ch });
      clock.advance(8);
    }
    port.queue('s1', 1, { kind: 'key', keys: ['Tab'] });
    port.queue('s1', 1, { kind: 'key', keys: ['Left'] });
    port.queue('s1', 1, { kind: 'key', keys: ['Control_L', 'a'] });
    clock.advance(16);

    // Type "!", then click and scroll while "!" is held.
    port.queue('s1', 1, { kind: 'type', text: '!' });
    clock.advance(8);
    port.queue('s1', 1, { kind: 'click', x: 42, y: 84, button: 'left' });
    port.queue('s1', 1, { kind: 'scroll', dx: 0, dy: 100, x: 42, y: 84, deltaMode: 0 });
    clock.advance(60);
    await tick();

    assert.deepEqual(refusals, []);
    assert.deepEqual(flattenedTranscript(sent), [
      { kind: 'type', text: 'hello' },
      { kind: 'key', keys: ['Return'] },
      { kind: 'type', text: 'world' },
      { kind: 'key', keys: ['Tab'] },
      { kind: 'key', keys: ['Left'] },
      { kind: 'key', keys: ['Control_L', 'a'] },
      { kind: 'type', text: '!' },
      { kind: 'click', x: 42, y: 84, button: 'left' },
      { kind: 'scroll', dx: 0, dy: 2, x: 42, y: 84 },
    ]);
    port.dispose();
  },

  async releaseMidBurstDropsAndCountsPendingText(mod) {
    const { clock, port, sent, refusals } = makeRig(mod);
    const fullBurst = Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    // Type the first 100 keys at 14 ms spacing; release mid-burst right after key 100
    // while the trailing keys in the active 40 ms coalesce window are still held.
    for (let i = 0; i < 100; i += 1) {
      port.queue('s1', 1, { kind: 'type', text: fullBurst[i] });
      if (i < 99) clock.advance(14);
    }
    const textBeforeRelease = collectedText(sent);
    const droppedBefore = port.droppedCount('s1');
    assert.equal(droppedBefore, 0);

    // Release / gate close mid-burst.
    port.closeGate('s1');
    const droppedAfter = port.droppedCount('s1');
    assert.ok(droppedAfter > 0, 'held pending keys in the coalesce window are explicitly dropped and counted');
    assert.equal(port.droppedCount(), droppedAfter, 'total droppedCount matches');
    assert.equal(
      textBeforeRelease.length + droppedAfter,
      100,
      'every key queued before release is either sent before release or dropped and counted',
    );
    assert.equal(
      fullBurst.slice(0, textBeforeRelease.length),
      textBeforeRelease,
      'text sent before release is an exact prefix in order',
    );

    const batchesAtRelease = sent.length;
    const lastBatch = sent.at(-1)?.batch;
    assert.deepEqual(lastBatch?.events, [{ kind: 'release_all' }], 'closeGate sends release_all and no held text');

    // Advance clock well past the coalesce window: nothing is sent after release.
    clock.advance(5000);
    await tick();
    assert.equal(sent.length, batchesAtRelease, 'nothing is sent after release');
    assert.equal(collectedText(sent), textBeforeRelease, 'no pending text leaks after release');
    assert.deepEqual(refusals, [], 'no refusal emitted on mid-burst release');
    port.dispose();
  },
};

describe('INPUT-COALESCE real source passes every scenario', () => {
  for (const [name, fn] of Object.entries(scenarios)) {
    it(name, async () => {
      assert.equal(real.TYPE_COALESCE_MS, 40);
      await fn(real);
    });
  }
});

// ------------------------------------------------ full-stack SCHEMA regression

describe('INPUT-COALESCE preload + authorityWire release_all SCHEMA regression', () => {
  it('admits release_all on gate close across preload and authorityWire without SCHEMA refusal', async () => {
    const clock = makeInjectedClock();
    const handlers = new Map();
    const coreEnvelopes = [];
    const frame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
    const contents = { id: 1, mainFrame: frame, isDestroyed: () => false, postMessage() {} };
    const event = { sender: contents, senderFrame: frame };
    const wire = installAuthorityWire({
      ipcMain: {
        handle: (channel, fn) => handlers.set(channel, fn),
        removeHandler: (channel) => handlers.delete(channel),
      },
      contents,
      core: {
        async request(req) {
          coreEnvelopes.push(req);
          if (req && req.op === 'input') {
            return { ok: true, accepted: req.batch.events.length };
          }
          return true;
        },
      },
      frames: { subscribe: () => () => {} },
      env: {},
      argv: [],
      clock: clock.now,
    });

    const api = createPreloadFacade({
      transport: {
        nested: false,
        invoke: (channel, args) => handlers.get(channel)(event, ...args),
        subscribe: () => () => {},
      },
      bridge: { exposeInMainWorld() {} },
    });

    const port = real.createInputPort(api.input, {
      now: clock.now,
      raf: clock.raf,
      cancelRaf: clock.cancelRaf,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const refusals = [];
    port.onRefusal((r) => refusals.push(r));

    try {
      port.queue('s1', 1, { kind: 'type', text: 'a' });
      port.queue('s1', 1, { kind: 'type', text: 'b' });
      clock.advance(20);
      await tick();

      // Queue trailing text in the coalesce window and immediately close the gate (blur / Release).
      port.queue('s1', 1, { kind: 'type', text: 'c' });
      port.closeGate('s1');
      clock.advance(100);
      await tick();

      assert.deepEqual(refusals, [], 'gate close after typing never emits SCHEMA');
      assert.equal(port.droppedCount('s1'), 1, 'trailing held key dropped on closeGate');
      assert.equal(coreEnvelopes.length, 1, 'release_all is absorbed at authorityWire without forwarding an unknown kind to core');
      assert.deepEqual(coreEnvelopes[0].batch.events, [{ kind: 'type', text: 'ab' }]);

      // Negative control: extra keys on release_all still fail validateSurfaceInputBatch as SCHEMA.
      assert.deepEqual(
        validateSurfaceInputBatch({
          schema: 'surface_input/v1',
          surface_id: 's1',
          stream_id: 1,
          seq: 99,
          events: [{ kind: 'release_all', extra: 1 }],
        }),
        { ok: false, code: 'SCHEMA' },
      );
    } finally {
      port.dispose();
      await wire.dispose();
    }
  });
});

// -------------------------------------------------------------------- mutants

/** @type {Array<{ name: string, edits: Array<[string, string]>, killedBy: keyof typeof scenarios }>} */
const MUTANTS = [
  {
    name: 'no coalescing (TYPE_COALESCE_MS = 0) -> LIMIT at 30 keys/s burst',
    edits: [
      ['export const TYPE_COALESCE_MS = 40;', 'export const TYPE_COALESCE_MS = 0;'],
    ],
    killedBy: 'burst30KeysPerSecond200Keys',
  },
  {
    name: 'ordering broken (non-type events flush ahead of held type events)',
    edits: [
      [
        '      list.length = 0;\n      clearSurfaceTimer(surfaceId);\n      if (fresh.some((it) => it.event.kind === \'type\')) {\n        lastTypeFlushBySurface.set(surfaceId, tNow);\n      }\n      flushSurface(surfaceId, fresh, expectedEpoch);',
        '      const nonType = fresh.filter((it) => it.event.kind !== \'type\');\n      const heldType = fresh.filter((it) => it.event.kind === \'type\');\n      if (nonType.length > 0 && heldType.length > 0 && lastTypeAt !== undefined && tNow - lastTypeAt < typeCoalesceMs) {\n        list.splice(0, list.length, ...heldType);\n        scheduleSurfaceCoalesce(surfaceId, typeCoalesceMs - (tNow - lastTypeAt));\n        flushSurface(surfaceId, nonType, expectedEpoch);\n        continue;\n      }\n      list.length = 0;\n      clearSurfaceTimer(surfaceId);\n      if (fresh.some((it) => it.event.kind === \'type\')) {\n        lastTypeFlushBySurface.set(surfaceId, tNow);\n      }\n      flushSurface(surfaceId, fresh, expectedEpoch);',
      ],
    ],
    killedBy: 'nonPrintableAndPointerEventsPreserveOrder',
  },
  {
    name: 'send after release (closeGate fails to drop held pending events)',
    edits: [
      ['      gateEpochBySurface.set(id, next);', '      gateEpochBySurface.set(id, next - 1);'],
      ['    pendingBySurface.delete(id);', ''],
    ],
    killedBy: 'releaseMidBurstDropsAndCountsPendingText',
  },
];

describe('INPUT-COALESCE mutants (each must fail its targeted scenario)', () => {
  for (const mutant of MUTANTS) {
    it(`kills: ${mutant.name}`, async () => {
      const mod = await loadMutant(mutant.edits);
      let failed = false;
      try {
        await scenarios[mutant.killedBy](mod);
      } catch {
        failed = true;
      }
      assert.equal(failed, true, `mutant "${mutant.name}" survived ${mutant.killedBy}`);
    });
  }
});
