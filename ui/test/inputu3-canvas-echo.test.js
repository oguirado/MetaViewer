// INPUT-U3: the REAL SurfaceCanvas SFC on a stub renderer — local click echo and
// contextmenu/auxclick hygiene. The echo timing rule is MetaViewer's own design
// [TARGET, unit decision]. Every guard has a mutant of the SFC (or module) source
// that its scenario must kill. Bounded fakes: one tile, single-digit events.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';
import { tick } from './frame-wait.mjs';
import {
  canvasDouble, click as rawClick, compileTile, findAll, mountTile, plainEvent, pointerEvent, stubInputPort, stubScheduler,
} from './inputu3-harness.mjs';

// 400x200 paint-owned frame, 200x200 box: contain content 200x100, bars of 50 px.
const LETTERBOX_RECT = { x: 0, y: 0, width: 200, height: 200, left: 0, top: 0, right: 200, bottom: 200 };
const T0 = 5_000_000;

/** Click, then let Vue flush the render. */
async function click(canvas, x, y, button = 0) {
  rawClick(canvas, x, y, button);
  await nextTick();
}

const dots = (root) => findAll(root, 'circle');

/** Mounts a gated-in tile; the echo module is warm so it settles within ticks. */
async function setup(Component, { props = {}, rect = LETTERBOX_RECT, withScheduler = true } = {}) {
  const { canvas, doc } = canvasDouble(rect, 400, 200);
  const { port, queueCalls, gateCloses } = stubInputPort();
  const { scheduler, state } = stubScheduler();
  const provides = { inputPort: port };
  if (withScheduler) provides.tileScheduler = scheduler;
  const tile = mountTile(Component, provides, canvas, props);
  await tick(); // lazy echo module settles
  canvas.focus();
  return { canvas, doc, tile, queueCalls, gateCloses, state };
}

/** Behaviour contract of the echo; run against the real SFC and against its mutants. */
async function echoScenarios(Component) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  try {
    // 0. A press alone, a mismatched pointer and a cancelled press draw nothing.
    {
      const t = await setup(Component);
      t.canvas.props.onPointerdown(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
      await nextTick();
      assert.equal(dots(t.tile.root).length, 0, 'a press alone draws nothing');
      t.canvas.props.onPointerup(pointerEvent('pointerup', { clientX: 100, clientY: 100, pointerId: 99 }));
      await nextTick();
      assert.equal(dots(t.tile.root).length, 0, 'a mismatched pointer draws nothing');
      t.canvas.props.onPointerdown(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
      t.canvas.props.onPointercancel(pointerEvent('pointercancel'));
      t.canvas.props.onPointerup(pointerEvent('pointerup', { clientX: 100, clientY: 100 }));
      await nextTick();
      assert.equal(dots(t.tile.root).length, 0, 'a cancelled press draws nothing');
      assert.equal(t.queueCalls.length, 0);
      t.tile.app.unmount();
    }
    // 1. Letterbox click: queues nothing, draws nothing.
    {
      const t = await setup(Component);
      await click(t.canvas, 100, 10);
      assert.equal(t.queueCalls.length, 0, 'letterbox click queues nothing');
      assert.equal(dots(t.tile.root).length, 0, 'letterbox click draws nothing');
      t.tile.app.unmount();
    }
    // 2. In-frame click: one click queued and one dot at the click point (+-1 px).
    {
      const t = await setup(Component);
      await click(t.canvas, 120.4, 80.6);
      assert.equal(t.queueCalls.length, 1);
      const found = dots(t.tile.root);
      assert.equal(found.length, 1, 'one dot');
      const { cx, cy } = found[0].props;
      assert.ok(Math.abs(cx - 120.4) <= 1 && Math.abs(cy - 80.6) <= 1, `dot at ${cx},${cy}`);
      assert.equal(found[0].parent.props['aria-hidden'], 'true', 'the echo layer is hidden from assistive tech');
      // Last click wins: still one dot, at the new point.
      await click(t.canvas, 20.2, 60.2);
      const again = dots(t.tile.root);
      assert.equal(again.length, 1);
      assert.ok(Math.abs(again[0].props.cx - 20.2) <= 1 && Math.abs(again[0].props.cy - 60.2) <= 1);
      t.tile.app.unmount();
    }
    // 3. Right and middle clicks echo too (they travel as clicks).
    {
      const t = await setup(Component);
      await click(t.canvas, 100, 100, 2);
      assert.equal(dots(t.tile.root).length, 1, 'right click echoes');
      t.tile.app.unmount();
    }
    // 4. Newer frame hides the dot; older, equal and unstamped frames do not.
    {
      const t = await setup(Component);
      await click(t.canvas, 100, 100);
      assert.equal(dots(t.tile.root).length, 1);
      const frames = [
        ['older', { inputToPresentMs: 20, timingScopes: { presentationMs: T0 + 10 } }, 1],
        ['equal', { inputToPresentMs: 10, timingScopes: { presentationMs: T0 + 10 } }, 1],
        ['unstamped', { inputToPresentMs: null, timingScopes: { presentationMs: T0 + 10 } }, 1],
        ['newer', { inputToPresentMs: 10, timingScopes: { presentationMs: T0 + 40 } }, 0],
      ];
      let n = 2;
      for (const [label, info, expected] of frames) {
        t.state.info = info;
        await t.tile.setProps({ frame: `h${n}`, digest: `d${n}` });
        n += 1;
        assert.equal(dots(t.tile.root).length, expected, `${label} frame -> ${expected} dot(s)`);
      }
      t.tile.app.unmount();
    }
    // 5. TTL: visible just before 1000 ms, gone at 1000 ms.
    {
      const t = await setup(Component);
      await click(t.canvas, 100, 100);
      mock.timers.tick(999);
      await t.tile.setProps({});
      assert.equal(dots(t.tile.root).length, 1, 'visible at 999 ms');
      mock.timers.tick(1);
      await t.tile.setProps({});
      assert.equal(dots(t.tile.root).length, 0, 'hidden at 1000 ms');
      t.tile.app.unmount();
    }
    // 6. Gate closure drops the dot: blur, READ switch, lost transition.
    for (const [label, drop] of [
      ['blur', (t) => t.canvas.blur()],
      ['READ switch', (t) => t.tile.setProps({ inputEnabled: false })],
      ['lost', (t) => t.tile.setProps({ state: 'lost' })],
      ['stream change', (t) => t.tile.setProps({ streamId: 9 })],
    ]) {
      const t = await setup(Component);
      await click(t.canvas, 100, 100);
      assert.equal(dots(t.tile.root).length, 1, `${label}: dot shows first`);
      await drop(t);
      await t.tile.setProps({});
      assert.equal(dots(t.tile.root).length, 0, `${label}: dot dropped with the gate`);
      t.tile.app.unmount();
    }
    // 7. READ: no focusable canvas, no echo, nothing queued.
    {
      const t = await setup(Component, { props: { inputEnabled: false } });
      await click(t.canvas, 100, 100);
      assert.equal(t.queueCalls.length, 0);
      assert.equal(dots(t.tile.root).length, 0, 'READ draws nothing');
      t.tile.app.unmount();
    }
    // 8. Unmount cancels the timer (no late write into a dead tile).
    {
      const t = await setup(Component);
      await click(t.canvas, 100, 100);
      t.tile.app.unmount();
      assert.doesNotThrow(() => mock.timers.tick(2000));
    }
  } finally {
    mock.timers.reset();
  }
}

/** contextmenu / auxclick contract (no timers needed). */
async function buttonScenarios(Component) {
  for (const type of ['onContextmenu', 'onAuxclick']) {
    // WRITE armed: default prevented.
    {
      const t = await setup(Component);
      assert.equal(typeof t.canvas.props[type], 'function', `${type} is bound`);
      const event = plainEvent(type);
      t.canvas.props[type](event);
      assert.equal(event.defaultPrevented, true, `${type} prevented in WRITE`);
      t.tile.app.unmount();
    }
    // READ: left alone.
    {
      const t = await setup(Component, { props: { inputEnabled: false } });
      const event = plainEvent(type);
      t.canvas.props[type]?.(event);
      assert.equal(event.defaultPrevented, false, `${type} untouched in READ`);
      t.tile.app.unmount();
    }
    // Frozen (lost) tile: not armed, left alone.
    {
      const t = await setup(Component, { props: { state: 'lost' } });
      const event = plainEvent(type);
      t.canvas.props[type]?.(event);
      assert.equal(event.defaultPrevented, false, `${type} untouched on a lost tile`);
      t.tile.app.unmount();
    }
    // No port: not armed.
    {
      const { canvas } = canvasDouble(LETTERBOX_RECT, 400, 200);
      const tile = mountTile(Component, {}, canvas, { inputEnabled: true });
      const event = plainEvent(type);
      canvas.props[type]?.(event);
      assert.equal(event.defaultPrevented, false, `${type} untouched without a port`);
      tile.app.unmount();
    }
  }
}

const Real = await compileTile();

test('inputu3 canvas echo: scenarios hold for the real SFC', async () => {
  await echoScenarios(Real);
});

test('inputu3 canvas buttons: contextmenu and auxclick are prevented in WRITE only', async () => {
  await buttonScenarios(Real);
});

test('inputu3 canvas echo: a failed echo load leaves capture intact and draws nothing', async () => {
  const Broken = await compileTile({ echo: 'missing' });
  const t = await setup(Broken);
  await tick();
  await click(t.canvas, 100, 100);
  assert.equal(t.queueCalls.length, 1, 'click still queued');
  assert.equal(dots(t.tile.root).length, 0, 'no echo without the module');
  const event = plainEvent('contextmenu');
  t.canvas.props.onContextmenu(event);
  assert.equal(event.defaultPrevented, true, 'button hygiene does not depend on the echo module');
  t.tile.app.unmount();
});

test('inputu3 canvas echo: no inline style or raw colour reaches the template (strict CSP)', async () => {
  const { SFC_SOURCE } = await import('./inputu3-harness.mjs');
  const template = SFC_SOURCE.split('<template>')[1].split('</template>')[0];
  assert.equal(/(?:^|[\s"'`:=])style\s*=/m.test(template), false);
  assert.match(template, /<svg v-if="echoDot !== null" class="mv-surface__echo" aria-hidden="true"/);
});

// ---------------------------------------------------------------------------
// Mutants of the SFC and of the module as wired by the SFC.
// ---------------------------------------------------------------------------
// Not mutated here: echoController.dispose() on unmount (closeInputGate already
// cancels the dot and its timer first, so the call is defence in depth) and the
// module letterbox guard (the SFC only echoes after a click was queued, which is
// already refused in the letterbox; the module guard is killed in
// inputu3-pointer-echo.test.js mutants M1).
const SFC_MUTANTS = [
  ['S1 echo not shown after a queued click', 'echo',
    (s) => s.replace('  showEcho(event);\n}', '}')],
  ['S2 gate closure keeps the dot', 'echo',
    (s) => s.replace("  clearEcho('gate');\n", '')],
  ['S3 frame arrival never retires the dot', 'echo',
    (s) => s.replace('watch(() => [props.frame, props.digest], observeEchoFrame);', '')],
  ['S4 contextmenu not bound', 'buttons',
    (s) => s.replace(' @contextmenu="onCanvasButtonDefault"', '')],
  ['S5 auxclick not bound', 'buttons',
    (s) => s.replace(' @auxclick="onCanvasButtonDefault"', '')],
  ['S6 button handler never prevents', 'buttons',
    (s) => s.replace('  if (!canvasFocusable.value) return;\n  event.preventDefault();', '  if (!canvasFocusable.value) return;')],
  ['S7 button handler prevents in READ', 'buttons',
    (s) => s.replace('  if (!canvasFocusable.value) return;\n  event.preventDefault();', '  event.preventDefault();')],
  ['S8 echo drawn at the unplaced client origin', 'echo',
    (s) => s.replace("(Number.isFinite(canvas.offsetLeft) ? canvas.offsetLeft : 0) + placement.left", '0')],
  ['S10 echo drawn on pointerdown before the click is queued', 'echo',
    (s) => s.replace('  focusCanvas();\n  // MVUI30 lane L: a frozen tile never arms a press', '  focusCanvas();\n  showEcho(event);\n  // MVUI30 lane L: a frozen tile never arms a press')],
];

for (const [name, kind, mutate] of SFC_MUTANTS) {
  test(`inputu3 canvas mutant killed: ${name}`, async () => {
    const Mutant = await compileTile({ mutateSfc: mutate }); // must compile: a syntax error would kill it vacuously
    const run = kind === 'echo' ? echoScenarios : buttonScenarios;
    await assert.rejects(() => run(Mutant), (error) => error?.name === 'AssertionError', `mutant survived: ${name}`);
  });
}

const ECHO_MUTANTS = [
  ['E1 module never hides on a newer frame', (s) => s.replace('if (!(stamp > current.atMs)) return false;\n      return hide(\'frame\');', 'return false;')],
  ['E2 module ttl removed', (s) => s.replace('handle = setTimer(() => { timer = null; hide(\'ttl\'); }, ttlMs);', 'handle = null;')],
];

for (const [name, mutate] of ECHO_MUTANTS) {
  test(`inputu3 canvas mutant killed (module): ${name}`, async () => {
    const Mutant = await compileTile({ mutateEcho: mutate });
    await assert.rejects(() => echoScenarios(Mutant), (error) => error?.name === 'AssertionError', `mutant survived: ${name}`);
  });
}
