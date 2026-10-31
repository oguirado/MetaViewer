// INPUT-U3: pointerEcho.js unit tests — geometry, hide rules and the timer,
// each guard paired with a mutant of the module source that must fail it.
// The timing rule is MetaViewer's own design [TARGET, unit decision]; it is not
// derived from RustDesk (its 1000 ms protection is dead code) nor from noVNC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapClientToFrame } from '../src/input/frameMap.js';
import {
  ECHO_DOT_PX, ECHO_TTL_MS, createPointerEcho, echoPlacement, echoPointFromClient, frameInputTimestampMs,
} from '../src/surfaces/pointerEcho.js';
import { echoModuleUrl } from './inputu3-harness.mjs';

// 400x200 frame in a 200x200 box: contain content 200x100, 50 px bars top and bottom.
const LETTERBOX = { left: 0, top: 0, width: 200, height: 200 };
// 400x200 frame in a 200x100 box at (10,20): exact 0.5 scale, no bars.
const EXACT = { left: 10, top: 20, width: 200, height: 100 };

/** Manual clock and timer bank. */
function fakeClock() {
  const clock = { t: 1_000_000, timers: [], nextId: 1 };
  clock.now = () => clock.t;
  clock.setTimer = (fn, ms) => { const id = clock.nextId++; clock.timers.push({ id, fn, at: clock.t + ms }); return id; };
  clock.clearTimer = (id) => { clock.timers = clock.timers.filter((timer) => timer.id !== id); };
  clock.advance = (ms) => {
    clock.t += ms;
    for (const timer of clock.timers.filter((candidate) => candidate.at <= clock.t)) {
      clock.timers = clock.timers.filter((candidate) => candidate.id !== timer.id);
      timer.fn();
    }
  };
  return clock;
}

function echoWith(clock, extra = {}) {
  const changes = [];
  const echo = createPointerEcho({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onChange: (snapshot, cause) => changes.push([snapshot === null ? null : { ...snapshot }, cause]),
    ...extra,
  });
  return { echo, changes };
}

/** The whole behaviour contract, run against the real module and against mutants. */
async function contract(url) {
  const m = await import(url);
  // Letterbox: nothing is drawn.
  for (const [cx, cy] of [[100, 10], [100, 190], [100, 49], [100, 151], [-1, 100], [201, 100]]) {
    assert.equal(m.echoPointFromClient({ clientX: cx, clientY: cy, rect: LETTERBOX, frameWidth: 400, frameHeight: 200 }), null,
      `letterbox (${cx},${cy}) draws nothing`);
  }
  // In-frame click lands within 1 px of the click, through the same contain transform.
  const inFrame = m.echoPointFromClient({ clientX: 101.3, clientY: 99.7, rect: LETTERBOX, frameWidth: 400, frameHeight: 200 });
  assert.notEqual(inFrame, null);
  const placed = m.echoPlacement(inFrame, { width: 200, height: 200 }, { width: 400, height: 200 });
  assert.ok(Math.abs(placed.left - 101.3) <= 1 && Math.abs(placed.top - 99.7) <= 1, `placement ${JSON.stringify(placed)}`);
  const exact = m.echoPointFromClient({ clientX: 110, clientY: 70, rect: EXACT, frameWidth: 400, frameHeight: 200 });
  assert.deepEqual([exact.x, exact.y], [200, 100]);
  const exactPlaced = m.echoPlacement(exact, { width: 200, height: 100 }, { width: 400, height: 200 });
  assert.ok(Math.abs(exactPlaced.left - 100) <= 1 && Math.abs(exactPlaced.top - 50) <= 1);
  assert.equal(m.echoPlacement({ fx: 10, fy: 10 }, { width: 0, height: 100 }, { width: 400, height: 200 }), null);
  assert.equal(m.echoPlacement({ fx: 401, fy: 10 }, { width: 200, height: 100 }, { width: 400, height: 200 }), null);
  // frameInputTimestampMs recovers presentedAt - sinceInput.
  assert.equal(m.frameInputTimestampMs({ inputToPresentMs: 20, timingScopes: { presentationMs: 1000 } }), 980);
  assert.equal(m.frameInputTimestampMs({ inputToPresentMs: null, timingScopes: { presentationMs: 1000 } }), null);
  assert.equal(m.frameInputTimestampMs(null), null);
  // Newer frame hides, equal/older/unstamped frames do not.
  {
    const c = fakeClock();
    const changes = [];
    const echo = m.createPointerEcho({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onChange: (s, why) => changes.push(why) });
    assert.equal(echo.show({ fx: 5, fy: 6 }), true);
    assert.equal(echo.observeFrame({ inputTimestampMs: c.t - 10 }), false, 'older frame keeps the dot');
    assert.equal(echo.observeFrame({ inputTimestampMs: c.t }), false, 'equal stamp is not newer');
    assert.equal(echo.observeFrame({}), false, 'unstamped frame keeps the dot');
    assert.equal(echo.observeFrame({ inputTimestampMs: Number.NaN }), false, 'NaN stamp keeps the dot');
    assert.equal(echo.observeFrame(null), false);
    assert.notEqual(echo.current(), null);
    assert.equal(echo.observeFrame({ inputTimestampMs: c.t + 1 }), true, 'newer frame hides');
    assert.equal(echo.current(), null);
    assert.deepEqual(changes, ['show', 'frame']);
    assert.equal(c.timers.length, 0, 'hiding cancels the timer');
  }
  // TTL: visible at 999 ms, gone at 1000 ms; a second show restarts the clock.
  {
    const c = fakeClock();
    const echo = m.createPointerEcho({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    echo.show({ fx: 1, fy: 1 });
    c.advance(m.ECHO_TTL_MS - 1);
    assert.notEqual(echo.current(), null, 'still visible at ttl - 1');
    c.advance(1);
    assert.equal(echo.current(), null, 'hidden at ttl');
    echo.show({ fx: 1, fy: 1 });
    c.advance(600);
    echo.show({ fx: 2, fy: 2 });
    c.advance(600);
    assert.deepEqual([echo.current()?.fx, echo.current()?.fy], [2, 2], 'second show restarts the ttl (old timer cancelled)');
    c.advance(400);
    assert.equal(echo.current(), null);
  }
  // clear + dispose.
  {
    const c = fakeClock();
    const echo = m.createPointerEcho({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    echo.show({ fx: 3, fy: 3 });
    assert.equal(echo.clear('gate'), true);
    assert.equal(echo.current(), null);
    assert.equal(c.timers.length, 0, 'clear cancels the timer');
    assert.equal(echo.clear('gate'), false, 'clearing an empty echo is a no-op');
    echo.show({ fx: 3, fy: 3 });
    echo.dispose();
    assert.equal(echo.current(), null);
    assert.equal(echo.show({ fx: 3, fy: 3 }), false, 'disposed echo refuses to show');
  }
  // Malformed points never show.
  {
    const c = fakeClock();
    const echo = m.createPointerEcho({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    for (const bad of [null, undefined, {}, { fx: 'a', fy: 1 }, { fx: 1, fy: Number.NaN }, { fx: Infinity, fy: 1 }]) {
      assert.equal(echo.show(bad), false);
    }
    assert.equal(echo.current(), null);
  }
}

test('inputu3 echo contract holds for the real module', async () => {
  await contract(echoModuleUrl());
});

test('inputu3 echo constants are the documented targets', () => {
  assert.equal(ECHO_TTL_MS, 1000);
  assert.equal(ECHO_DOT_PX, 12);
});

test('inputu3 echo: point mapping is null exactly where mapClientToFrame is null (grid parity)', () => {
  for (const rect of [LETTERBOX, EXACT, { left: 3, top: 4, width: 137, height: 91 }]) {
    for (let cx = -5; cx <= 215; cx += 7) {
      for (let cy = -5; cy <= 215; cy += 7) {
        const input = { clientX: cx, clientY: cy, rect, frameWidth: 400, frameHeight: 200 };
        const mapped = mapClientToFrame(input);
        const echoed = echoPointFromClient(input);
        assert.equal(echoed === null, mapped === null, `null parity at (${cx},${cy})`);
        if (mapped !== null) {
          assert.deepEqual([echoed.x, echoed.y], [mapped.x, mapped.y]);
          assert.equal(Math.floor(echoed.fx), mapped.x);
          assert.equal(Math.floor(echoed.fy), mapped.y);
        }
      }
    }
  }
});

test('inputu3 echo: placement round-trips the click within 1 px on a scaled letterboxed tile', () => {
  const rect = { left: 7, top: 9, width: 173, height: 311 };
  for (let cx = 7; cx < 180; cx += 11) {
    for (let cy = 9; cy < 320; cy += 13) {
      const point = echoPointFromClient({ clientX: cx, clientY: cy, rect, frameWidth: 1280, frameHeight: 720 });
      if (point === null) continue;
      const placed = echoPlacement(point, { width: rect.width, height: rect.height }, { width: 1280, height: 720 });
      assert.ok(Math.abs(rect.left + placed.left - cx) <= 1 && Math.abs(rect.top + placed.top - cy) <= 1, `(${cx},${cy})`);
    }
  }
});

test('inputu3 echo: injected options and listener faults', () => {
  const c = fakeClock();
  const { echo } = echoWith(c, { ttlMs: 250 });
  echo.show({ fx: 1, fy: 1 });
  c.advance(249);
  assert.notEqual(echo.current(), null);
  c.advance(1);
  assert.equal(echo.current(), null, 'ttl override honoured');
  const faulty = createPointerEcho({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onChange: () => { throw new Error('x'); } });
  assert.equal(faulty.show({ fx: 1, fy: 1 }), true, 'a throwing listener never breaks show');
  assert.equal(faulty.clear(), true);
  const noTimer = createPointerEcho({ now: c.now, setTimer: () => { throw new Error('no timer'); }, clearTimer: c.clearTimer });
  assert.equal(noTimer.show({ fx: 1, fy: 1 }), true, 'a failing timer never breaks show');
  assert.equal(noTimer.observeFrame({ inputTimestampMs: c.t + 5 }), true, 'a frame still hides without a timer');
});

test('inputu3 echo: default timer is the real clock and does not hold the loop', async () => {
  const echo = createPointerEcho({ ttlMs: 20 });
  echo.show({ fx: 1, fy: 1 });
  assert.notEqual(echo.current(), null);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(echo.current(), null, 'real timer retired the dot');
});

test('inputu3 frameInputTimestampMs rejects unusable figures', () => {
  assert.equal(frameInputTimestampMs({ inputToPresentMs: -1, timingScopes: { presentationMs: 5 } }), null);
  assert.equal(frameInputTimestampMs({ inputToPresentMs: 1, timingScopes: {} }), null);
  assert.equal(frameInputTimestampMs({ inputToPresentMs: Number.NaN, timingScopes: { presentationMs: 5 } }), null);
  assert.equal(frameInputTimestampMs('x'), null);
});

// ---------------------------------------------------------------------------
// Mutants: each edit of the module source must be caught by the contract.
// ---------------------------------------------------------------------------
const MUTANTS = [
  ['M1 letterbox not delegated (null mapping ignored)',
    (s) => s.replace('if (mapped === null) return null;\n  const rect', 'const rect')
    .replace('x: mapped.x,\n    y: mapped.y,', 'x: mapped?.x ?? 0,\n    y: mapped?.y ?? 0,')],
  ['M2 equal stamp hides (>= instead of >)', (s) => s.replace('if (!(stamp > current.atMs)) return false;', 'if (!(stamp >= current.atMs)) return false;')],
  ['M3 unstamped frame hides', (s) => s.replace("if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return false;", "if (typeof stamp !== 'number') return hide('frame');")],
  ['M4 older frame hides (comparison dropped)', (s) => s.replace('if (!(stamp > current.atMs)) return false;', '')],
  ['M5 ttl is ten times longer', (s) => s.replace('export const ECHO_TTL_MS = 1000;', 'export const ECHO_TTL_MS = 10000;')],
  ['M6 clear is a no-op', (s) => s.replace("clear(cause = 'clear') {\n      return hide(cause);", "clear(cause = 'clear') {\n      return false;")],
  ['M7 timestamp sign flipped', (s) => s.replace('return presentedAt - sinceInput;', 'return presentedAt + sinceInput;')],
  ['M8 placement drops the letterbox offset', (s) => s.replace('return { left: fit.offsetX + fx * fit.scale, top: fit.offsetY + fy * fit.scale };', 'return { left: fx * fit.scale, top: fy * fit.scale };')],
  ['M9 dispose does not refuse show', (s) => s.replace('hide(\'dispose\');\n      disposed = true;', 'hide(\'dispose\');')],
  ['M10 show keeps the previous timer', (s) => s.replace('if (disposed) return false;', 'if (disposed) return false;\n      const keep = true; void keep;').replace('dropTimer();\n      current = {', 'current = {')],
  ['M11 timer expiry does not hide', (s) => s.replace("timer = null; hide('ttl');", 'timer = null;')],
  ['M12 hide keeps the timer armed', (s) => s.replace('function hide(cause) {\n    dropTimer();', 'function hide(cause) {')],
  ['M13 NaN point accepted', (s) => s.replace("|| typeof point.fx !== 'number' || !Number.isFinite(point.fx)", "|| typeof point.fx !== 'number'")
    .replace("|| typeof point.fy !== 'number' || !Number.isFinite(point.fy)) return false;", "|| typeof point.fy !== 'number') return false;")],
];

for (const [name, mutate] of MUTANTS) {
  test(`inputu3 echo mutant killed: ${name}`, async () => {
    const url = echoModuleUrl(mutate);
    await import(url); // the mutant must load: a syntax error would kill it vacuously
    await assert.rejects(() => contract(url), (error) => error?.name === 'AssertionError', `mutant survived: ${name}`);
  });
}
