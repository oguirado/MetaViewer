// MVUI25 lane C: focusable canvas capture — the REAL SurfaceCanvas SFC
// (compiled with @vue/compiler-sfc, inline template) on a stub renderer:
// tabindex/anchor/aria gating, keydown/pointer/wheel capture through the
// lane-P input modules, stream-id passthrough. The injected port is a
// hand-rolled preamble-shaped double recording queue() calls, so these
// tests pin component behavior only; lane P owns the port/key/frame tables
// (asserted here only where the room preamble pins the mapping). The canvas
// double models REAL focus semantics: focus() takes effect only with a
// tabindex, and focus()/blur() fire the registered handlers like the DOM.
// Bounded fakes (one tile, single-digit events); async waits via frame-wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, ref } from 'vue';
import {
  surfaceInputAccessibleName,
  surfaceInputFocusAnchor,
} from '../src/surfaces/tileScheduler.js';
import { tick } from './frame-wait.mjs';

const tileSource = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');

const vueUrl = JSON.stringify(import.meta.resolve('vue'));
const schedulerUrl = JSON.stringify(import.meta.resolve('../src/surfaces/tileScheduler.js'));
const keyMapUrl = JSON.stringify(import.meta.resolve('../src/input/keyMap.js'));
const frameMapUrl = JSON.stringify(import.meta.resolve('../src/input/frameMap.js'));
let sfcSerial = 0;

function rewriteImports(code, deps) {
  let out = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
  out = out.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
    if (spec === 'vue') return all.replace(/(['"])vue\1/, vueUrl);
    assert.ok(spec in deps, `Unmapped SFC dependency: ${spec}`);
    return `const ${bindings.trim()} = await import(${deps[spec]});`;
  });
  return out;
}

async function compileTile(source) {
  const compiled = compileScript(parse(source).descriptor, { id: 'mvui25c-tile', inlineTemplate: true });
  const code = rewriteImports(compiled.content, {
    './tileScheduler.js': schedulerUrl,
    '../input/keyMap.js': keyMapUrl,
    '../input/frameMap.js': frameMapUrl,
  });
  const tag = `mvui25c-tile-${sfcSerial++}`;
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}`)).default;
}

const SurfaceCanvas = await compileTile(tileSource);

// Paint-owned 400x200 frame in a 200x100 CSS box at (10,20): exact 2x, no
// letterbox. Client (110,70) maps to frame (200,100) under any faithful
// object-fit:contain implementation.
const RECT_2X = { x: 10, y: 20, width: 200, height: 100, left: 10, top: 20, right: 210, bottom: 120 };
// Same 400x200 frame in a 200x200 CSS box: contain content is 200x100
// centered, with 50 px bars top/bottom. CSS (100,100) -> frame (200,100);
// CSS (100,25) sits in the top bar -> null.
const LETTERBOX_RECT = { x: 0, y: 0, width: 200, height: 200, left: 0, top: 0, right: 200, bottom: 200 };
const PAINT_W = 400;
const PAINT_H = 200;

function inputCanvasDouble(rect, paintWidth, paintHeight) {
  const doc = { activeElement: null };
  const canvas = {
    tag: 'canvas', props: {}, children: [], text: null, parent: null,
    patchKeys: [], width: paintWidth, height: paintHeight,
    getBoundingClientRect() { return { ...rect }; },
    focus() {
      if (canvas.props.tabindex === 0 || canvas.props.tabindex === '0') {
        doc.activeElement = canvas;
        canvas.props.onFocus?.({ type: 'focus', target: canvas });
      }
    },
    blur() {
      if (doc.activeElement === canvas) {
        doc.activeElement = null;
        canvas.props.onBlur?.({ type: 'blur', target: canvas });
      }
    },
  };
  return { canvas, doc };
}

function stubOps(canvasStub) {
  return {
    createElement(tag) {
      if (tag === 'canvas' && canvasStub) return canvasStub;
      return { tag, props: {}, children: [], text: null, parent: null };
    },
    createText(text) { return { text, parent: null }; },
    createComment(text) { return { comment: text, parent: null }; },
    setText(node, text) { node.text = text; },
    setElementText(el, text) { el.children = []; el.text = text; },
    insert(child, parent, anchor = null) {
      if (!parent || !Array.isArray(parent.children)) return;
      child.parent = parent;
      const at = anchor ? parent.children.indexOf(anchor) : -1;
      if (at >= 0) parent.children.splice(at, 0, child);
      else parent.children.push(child);
    },
    remove(child) {
      const parent = child.parent;
      if (parent && Array.isArray(parent.children)) {
        const at = parent.children.indexOf(child);
        if (at >= 0) parent.children.splice(at, 1);
      }
      child.parent = null;
    },
    parentNode(node) { return node.parent ?? null; },
    nextSibling(node) {
      const parent = node.parent;
      if (!parent || !Array.isArray(parent.children)) return null;
      return parent.children[parent.children.indexOf(node) + 1] ?? null;
    },
    patchProp(el, key, _prev, next) {
      if (!el.props || typeof el.props !== 'object') el.props = {};
      el.props[key] = next;
      if (el === canvasStub) {
        canvasStub.patchKeys.push(key);
        if ((key === 'width' || key === 'height') && Number.isSafeInteger(next)) el[key] = next;
      }
    },
  };
}

// Preamble-shaped input port double: queue() records, nothing else.
function stubInputPort() {
  const queueCalls = [];
  const port = Object.freeze({
    available: true,
    send: async () => ({ ok: true, accepted: 0 }),
    queue: (surfaceId, streamId, event) => { queueCalls.push({ surfaceId, streamId, event }); },
    onRefusal: () => () => {},
    dispose: () => {},
  });
  return { port, queueCalls };
}

function mountTile(Component, provides, canvasStub, initialProps = {}) {
  const { createApp } = createRenderer(stubOps(canvasStub));
  const propsRef = ref({
    surfaceId: 'A', generation: 1, epoch: 7,
    frame: '', digest: '', state: 'live', frameWidth: 0, frameHeight: 0,
    inputEnabled: false, streamId: 0,
    ...initialProps,
  });
  const Holder = { setup: () => () => h(Component, { ...propsRef.value }) };
  const app = createApp(Holder);
  for (const [key, value] of Object.entries(provides)) app.provide(key, value);
  const root = { children: [] };
  app.mount(root);
  return {
    app, root,
    async setProps(patch) {
      propsRef.value = { ...propsRef.value, ...patch };
      await nextTick();
      await nextTick();
      await tick();
    },
  };
}

function fakeKeyEvent(key, overrides = {}) {
  const event = {
    type: 'keydown', key, ctrlKey: false, altKey: false, shiftKey: false,
    metaKey: false, keyCode: 0, isComposing: false, defaultPrevented: false,
    ...overrides,
    preventDefault() { event.defaultPrevented = true; },
  };
  return event;
}

function fakePointerEvent(type, overrides = {}) {
  const event = {
    type, button: 0, buttons: 1, clientX: 0, clientY: 0, defaultPrevented: false,
    ...overrides,
    preventDefault() { event.defaultPrevented = true; },
  };
  return event;
}

function fakeWheelEvent(overrides = {}) {
  const event = {
    type: 'wheel', deltaX: 0, deltaY: 0, deltaMode: 0, clientX: 0, clientY: 0,
    defaultPrevented: false,
    ...overrides,
    preventDefault() { event.defaultPrevented = true; },
  };
  return event;
}

function mounted(provides, canvasStub, initialProps = {}) {
  return mountTile(SurfaceCanvas, provides, canvasStub, initialProps);
}

// ---------------------------------------------------------------------------
// Attribute gating: tabindex / anchor / aria.
// ---------------------------------------------------------------------------

test('mvui25c attrs: gated-in canvas exposes tabindex, anchor id, name; aria-hidden off', () => {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    assert.equal(canvas.props.tabindex, 0);
    assert.equal(canvas.props.id, 'tile-A-input-focus');
    assert.equal(canvas.props.id, surfaceInputFocusAnchor('A'));
    assert.equal(canvas.props['data-semantic-anchor'], 'tile-A-input-focus');
    assert.equal(canvas.props['aria-hidden'], undefined);
    assert.equal(canvas.props['aria-label'], 'Capsule input for A');
    assert.equal(canvas.props['aria-label'], surfaceInputAccessibleName({ surfaceId: 'A' }));
  } finally {
    tile.app.unmount();
  }
});

test('mvui25c attrs: gated-out canvas keeps the legacy attributes', () => {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: false });
  try {
    assert.equal(canvas.props.tabindex, undefined);
    assert.equal(canvas.props.id, undefined);
    assert.equal(canvas.props['data-semantic-anchor'], undefined);
    assert.equal(canvas.props['aria-hidden'], 'true');
    assert.equal(canvas.props['aria-label'], undefined);
  } finally {
    tile.app.unmount();
  }
});

test('mvui25c attrs: missing port keeps the canvas unfocusable without side effects', () => {
  const { canvas, doc } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const tile = mounted({}, canvas, { inputEnabled: true, streamId: 5 });
  try {
    assert.equal(canvas.props.tabindex, undefined, 'no tabindex without a port');
    assert.equal(canvas.props['aria-hidden'], 'true');
    canvas.focus();
    assert.equal(doc.activeElement, null, 'focus is a no-op without tabindex');
    const key = fakeKeyEvent('a');
    canvas.props.onKeydown(key);
    assert.equal(key.defaultPrevented, false, 'no preventDefault without a port');
    const wheel = fakeWheelEvent({ clientX: 110, clientY: 70, deltaY: -10 });
    canvas.props.onWheel(wheel);
    assert.equal(wheel.defaultPrevented, false, 'wheel untouched without a port');
    canvas.props.onPointerdown(fakePointerEvent('pointerdown', { clientX: 110, clientY: 70 }));
    canvas.props.onPointerup(fakePointerEvent('pointerup', { clientX: 110, clientY: 70 }));
    assert.equal(doc.activeElement, null, 'pointer never focuses without a port');
  } finally {
    tile.app.unmount();
  }
});

// ---------------------------------------------------------------------------
// Key capture.
// ---------------------------------------------------------------------------

test('mvui25c keys: mapped keys queue and prevent (preamble-pinned mappings)', () => {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    canvas.focus();
    const cases = [
      ['a', {}, 'type', 'a', undefined],
      ['Enter', {}, 'key', undefined, ['Return']],
      ['Backspace', {}, 'key', undefined, ['BackSpace']],
      ['ArrowLeft', {}, 'key', undefined, ['Left']],
      ['F1', {}, 'key', undefined, ['F1']],
      ['l', { ctrlKey: true }, 'key', undefined, ['ctrl', 'l']],
    ];
    for (const [key, overrides, kind, text, keys] of cases) {
      const before = queueCalls.length;
      const event = fakeKeyEvent(key, overrides);
      canvas.props.onKeydown(event);
      assert.equal(event.defaultPrevented, true, `prevented: ${key}`);
      assert.equal(queueCalls.length, before + 1, `queued: ${key}`);
      const queued = queueCalls.at(-1);
      assert.equal(queued.surfaceId, 'A');
      assert.equal(queued.streamId, 3);
      assert.equal(queued.event.kind, kind, `kind: ${key}`);
      if (text !== undefined) assert.equal(queued.event.text, text, `text: ${key}`);
      if (keys !== undefined) assert.deepEqual(queued.event.keys, keys, `keys: ${key}`);
    }
  } finally {
    tile.app.unmount();
  }
});

test('mvui25c keys: Escape blurs without forwarding or preventing', () => {
  const { canvas, doc } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    canvas.focus();
    assert.equal(doc.activeElement, canvas);
    const event = fakeKeyEvent('Escape');
    canvas.props.onKeydown(event);
    assert.equal(doc.activeElement, null, 'Escape releases focus');
    assert.equal(queueCalls.length, 0, 'Escape is never forwarded');
    assert.equal(event.defaultPrevented, false, 'Escape is not prevented');
  } finally {
    tile.app.unmount();
  }
});

test('mvui25c keys: dead and IME keys pass through untouched', () => {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    canvas.focus();
    for (const probe of [fakeKeyEvent('Dead'), fakeKeyEvent('Unidentified', { keyCode: 229, isComposing: true })]) {
      const before = queueCalls.length;
      canvas.props.onKeydown(probe);
      assert.equal(queueCalls.length, before, `nothing queued for ${probe.key}`);
      assert.equal(probe.defaultPrevented, false, `not prevented: ${probe.key}`);
    }
  } finally {
    tile.app.unmount();
  }
});

test('mvui25c keys negative: Space unfocused sends nothing and is not prevented', () => {
  const { canvas, doc } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    assert.equal(doc.activeElement, null, 'canvas starts unfocused');
    const event = fakeKeyEvent(' ');
    canvas.props.onKeydown(event);
    assert.equal(queueCalls.length, 0, 'unfocused Space sends nothing');
    assert.equal(event.defaultPrevented, false, 'unfocused Space keeps page scroll');
    // Positive control on the same tile: focused Space types.
    canvas.focus();
    const focused = fakeKeyEvent(' ');
    canvas.props.onKeydown(focused);
    assert.equal(focused.defaultPrevented, true);
    assert.equal(queueCalls.length, 1);
    assert.equal(queueCalls[0].event.kind, 'type');
    assert.equal(queueCalls[0].event.text, ' ');
  } finally {
    tile.app.unmount();
  }
});

test('mvui25c gate negative: disabled tile sends nothing even when focus-flagged', async () => {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  // inputEnabled false is the READ-mode / agent-control state (App computes it).
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: false, streamId: 3 });
  try {
    // Adversarial: set the focus flag directly, bypassing the missing tabindex.
    canvas.props.onFocus({ type: 'focus', target: canvas });
    const key = fakeKeyEvent('a');
    canvas.props.onKeydown(key);
    assert.equal(queueCalls.length, 0, 'READ mode sends nothing');
    assert.equal(key.defaultPrevented, false, 'READ mode prevents nothing');
    const wheel = fakeWheelEvent({ clientX: 110, clientY: 70, deltaY: -10 });
    canvas.props.onWheel(wheel);
    assert.equal(queueCalls.length, 0, 'wheel in READ mode sends nothing');
    assert.equal(wheel.defaultPrevented, false);
    canvas.props.onPointerup(fakePointerEvent('pointerup', { clientX: 110, clientY: 70 }));
    assert.equal(queueCalls.length, 0, 'pointer in READ mode sends nothing');
    // Positive control: enabling the same tile opens the gate.
    await tile.setProps({ inputEnabled: true });
    assert.equal(canvas.props.tabindex, 0, 'gate opens on enable');
    canvas.focus();
    const enabled = fakeKeyEvent('a');
    canvas.props.onKeydown(enabled);
    assert.equal(queueCalls.length, 1, 'WRITE mode sends');
    assert.equal(enabled.defaultPrevented, true);
  } finally {
    tile.app.unmount();
  }
});

// ---------------------------------------------------------------------------
// Pointer capture.
// ---------------------------------------------------------------------------

test('mvui25c pointer: pointerdown focuses, pointerup clicks at frame pixels', () => {
  const { canvas, doc } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    const down = fakePointerEvent('pointerdown', { clientX: 110, clientY: 70 });
    canvas.props.onPointerdown(down);
    assert.equal(doc.activeElement, canvas, 'pointerdown takes focus');
    assert.equal(down.defaultPrevented, false, 'pointerdown never prevents');
    assert.equal(queueCalls.length, 0, 'pointerdown sends nothing');
    const up = fakePointerEvent('pointerup', { button: 0, clientX: 110, clientY: 70 });
    canvas.props.onPointerup(up);
    assert.equal(up.defaultPrevented, false, 'pointerup never prevents');
    assert.equal(queueCalls.length, 1);
    assert.deepEqual(queueCalls[0].event, { kind: 'click', x: 200, y: 100, button: 'left' });
  } finally {
    tile.app.unmount();
  }
});

test('mvui25c pointer: middle/right map; unknown buttons and outside-frame ignored', () => {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    canvas.focus();
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 1, clientX: 110, clientY: 70 }));
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 2, clientX: 110, clientY: 70 }));
    assert.equal(queueCalls.length, 2);
    assert.equal(queueCalls[0].event.button, 'middle');
    assert.equal(queueCalls[1].event.button, 'right');
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 3, clientX: 110, clientY: 70 }));
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: -1, clientX: 110, clientY: 70 }));
    assert.equal(queueCalls.length, 2, 'unknown buttons are ignored');
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 0, clientX: 500, clientY: 500 }));
    assert.equal(queueCalls.length, 2, 'clicks outside the frame are not sent');
  } finally {
    tile.app.unmount();
  }
});

test('mvui25c pointer negative: disabled pointerdown does not focus or send', () => {
  const { canvas, doc } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: false, streamId: 3 });
  try {
    canvas.props.onPointerdown(fakePointerEvent('pointerdown', { clientX: 110, clientY: 70 }));
    assert.equal(doc.activeElement, null, 'disabled pointerdown never focuses');
    canvas.props.onPointerup(fakePointerEvent('pointerup', { clientX: 110, clientY: 70 }));
    assert.equal(queueCalls.length, 0, 'disabled pointer sends nothing');
  } finally {
    tile.app.unmount();
  }
});

test('mvui25c letterbox: clicks map through contain bars via the paint-owned size', () => {
  const { canvas } = inputCanvasDouble(LETTERBOX_RECT, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  // Wrong projection props: the mapping must use the paint-owned canvas size.
  const tile = mounted({ inputPort: port }, canvas,
    { inputEnabled: true, streamId: 3, frameWidth: 9999, frameHeight: 9999 });
  try {
    canvas.focus();
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 0, clientX: 100, clientY: 25 }));
    assert.equal(queueCalls.length, 0, 'letterbox bar positions are not sent');
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 0, clientX: 100, clientY: 100 }));
    assert.equal(queueCalls.length, 1);
    assert.deepEqual(queueCalls[0].event, { kind: 'click', x: 200, y: 100, button: 'left' });
  } finally {
    tile.app.unmount();
  }
});

// ---------------------------------------------------------------------------
// Wheel capture.
// ---------------------------------------------------------------------------

test('mvui25c wheel: scroll queues rounded deltas and prevents page scroll', () => {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    canvas.focus();
    const event = fakeWheelEvent({ clientX: 110, clientY: 70, deltaX: 5.4, deltaY: -12.2 });
    canvas.props.onWheel(event);
    assert.equal(event.defaultPrevented, true, 'focused wheel is prevented');
    assert.equal(queueCalls.length, 1);
    assert.deepEqual(queueCalls[0].event, { kind: 'scroll', dx: 5, dy: -12, x: 200, y: 100 });
    const zero = fakeWheelEvent({ clientX: 110, clientY: 70, deltaX: 0.1, deltaY: -0.1 });
    canvas.props.onWheel(zero);
    assert.equal(queueCalls.length, 1, 'zero-rounded deltas send nothing');
    assert.equal(zero.defaultPrevented, true, 'but the page still does not scroll');
  } finally {
    tile.app.unmount();
  }
});

test('mvui25c wheel: outside-frame prevents but does not send; unfocused untouched', () => {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    const unfocused = fakeWheelEvent({ clientX: 110, clientY: 70, deltaY: -10 });
    canvas.props.onWheel(unfocused);
    assert.equal(unfocused.defaultPrevented, false, 'unfocused wheel keeps page scroll');
    assert.equal(queueCalls.length, 0);
    canvas.focus();
    const outside = fakeWheelEvent({ clientX: 500, clientY: 500, deltaY: -10 });
    canvas.props.onWheel(outside);
    assert.equal(outside.defaultPrevented, true, 'focused wheel is prevented anywhere on canvas');
    assert.equal(queueCalls.length, 0, 'outside-frame wheel sends nothing');
  } finally {
    tile.app.unmount();
  }
});

// ---------------------------------------------------------------------------
// Gate transitions, identity passthrough, static guards.
// ---------------------------------------------------------------------------

test('mvui25c gate: losing inputEnabled blurs and removes tabindex', async () => {
  const { canvas, doc } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    canvas.focus();
    assert.equal(doc.activeElement, canvas);
    await tile.setProps({ inputEnabled: false });
    assert.equal(doc.activeElement, null, 'gate loss releases focus');
    assert.equal(canvas.props.tabindex, undefined, 'gate loss removes tabindex');
    assert.equal(canvas.props.id, undefined, 'gate loss removes the anchor');
    assert.equal(canvas.props['aria-hidden'], 'true', 'gate loss re-hides the canvas');
    const key = fakeKeyEvent('a');
    canvas.props.onKeydown(key);
    assert.equal(queueCalls.length, 0, 'stale focus can never capture');
    assert.equal(key.defaultPrevented, false);
  } finally {
    tile.app.unmount();
  }
});

test('mvui25c stream: queue carries surface id and stream id verbatim', () => {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas,
    { surfaceId: 'cap-07', inputEnabled: true, streamId: 12 });
  try {
    assert.equal(canvas.props.id, 'tile-cap-07-input-focus');
    canvas.focus();
    canvas.props.onKeydown(fakeKeyEvent('a'));
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 0, clientX: 110, clientY: 70 }));
    assert.equal(queueCalls.length, 2);
    for (const call of queueCalls) {
      assert.equal(call.surfaceId, 'cap-07');
      assert.equal(call.streamId, 12);
    }
  } finally {
    tile.app.unmount();
  }
});

test('mvui25c anchor: hostile surface ids stay DOM-safe on the canvas', () => {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { surfaceId: 'a b/c', inputEnabled: true });
  try {
    const expected = surfaceInputFocusAnchor('a b/c');
    assert.equal(canvas.props.id, expected);
    assert.equal(canvas.props['data-semantic-anchor'], expected);
    assert.ok(!/[\s/]/.test(expected), `anchor carries whitespace/slash: ${expected}`);
    assert.ok(expected.startsWith('tile-') && expected.endsWith('-input-focus'), `anchor shape: ${expected}`);
  } finally {
    tile.app.unmount();
  }
});

test('mvui25c css: focus ring uses existing tokens, no raw colours or inline styles', () => {
  const style = tileSource.split('<style scoped>')[1]?.split('</style>')[0];
  assert.ok(style, 'scoped style block survives');
  const rule = style.match(/\.mv-surface__canvas:focus-visible\s*\{([^}]*)\}/s);
  assert.ok(rule, ':focus-visible rule for the canvas exists');
  const body = rule[1];
  for (const decl of [
    'outline-width: var(--cuk-semantic-focus-ring-width)',
    'outline-style: var(--cuk-semantic-focus-ring-style)',
    'outline-color: var(--cuk-semantic-focus-ring-color)',
    'outline-offset: calc(var(--cuk-semantic-focus-ring-offset) * -1)',
  ]) {
    assert.ok(body.includes(decl), `ring declaration: ${decl}`);
  }
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(body), false, 'no raw colour literal in the ring rule');
  assert.equal(/rgba?\(/.test(body), false, 'no rgb() colour in the ring rule');
  const template = tileSource.split('<template>')[1]?.split('</template>')[0] ?? '';
  assert.equal(template.includes('style='), false, 'no inline styles in the template');
});

test('mvui25c l81: no reactive canvas dimension patch reaches the element', async () => {
  assert.equal(tileSource.includes(':width="'), false, 'template carries no reactive width');
  assert.equal(tileSource.includes(':height="'), false, 'template carries no reactive height');
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas,
    { inputEnabled: true, streamId: 3, frameWidth: 2, frameHeight: 2 });
  try {
    canvas.patchKeys.length = 0;
    await tile.setProps({ frameWidth: 3, frameHeight: 2 });
    assert.equal(canvas.patchKeys.includes('width'), false, 'no reactive width patch hits the canvas');
    assert.equal(canvas.patchKeys.includes('height'), false, 'no reactive height patch hits the canvas');
    assert.equal(canvas.width, PAINT_W, 'paint-owned size untouched by props');
    assert.equal(canvas.height, PAINT_H);
  } finally {
    tile.app.unmount();
  }
});

test('mvui25d canvas: unavailable port never focuses, prevents, or queues', () => {
  const { canvas, doc } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const avail = stubInputPort();
  const port = Object.freeze({ ...avail.port, available: false });
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    assert.equal(canvas.props.tabindex, undefined, 'no tabindex with an unavailable port');
    assert.equal(canvas.props['aria-hidden'], 'true', 'canvas stays hidden with an unavailable port');
    canvas.focus();
    assert.equal(doc.activeElement, null, 'focus is a no-op with an unavailable port');
    // Adversarial: set the focus flag directly, bypassing the missing tabindex.
    canvas.props.onFocus({ type: 'focus', target: canvas });
    const space = fakeKeyEvent(' ');
    canvas.props.onKeydown(space);
    assert.equal(space.defaultPrevented, false, 'Space is never prevented');
    assert.equal(avail.queueCalls.length, 0, 'Space queues nothing');
    const wheel = fakeWheelEvent({ clientX: 110, clientY: 70, deltaY: -10 });
    canvas.props.onWheel(wheel);
    assert.equal(wheel.defaultPrevented, false, 'wheel is never prevented');
    assert.equal(avail.queueCalls.length, 0, 'wheel queues nothing');
    canvas.props.onPointerdown(fakePointerEvent('pointerdown', { clientX: 110, clientY: 70 }));
    assert.equal(doc.activeElement, null, 'pointer never focuses with an unavailable port');
    canvas.props.onPointerup(fakePointerEvent('pointerup', { clientX: 110, clientY: 70 }));
    assert.equal(avail.queueCalls.length, 0, 'pointer queues nothing');
  } finally {
    tile.app.unmount();
  }
  // Positive control on a sibling tile: the same events capture when available.
  const again = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const live = stubInputPort();
  const ok = mounted({ inputPort: live.port }, again.canvas, { inputEnabled: true, streamId: 3 });
  try {
    again.canvas.focus();
    const space = fakeKeyEvent(' ');
    again.canvas.props.onKeydown(space);
    assert.equal(space.defaultPrevented, true, 'control: focused Space is prevented');
    assert.equal(live.queueCalls.length, 1, 'control: focused Space queues');
    const wheel = fakeWheelEvent({ clientX: 110, clientY: 70, deltaY: -10 });
    again.canvas.props.onWheel(wheel);
    assert.equal(wheel.defaultPrevented, true, 'control: focused wheel is prevented');
    assert.equal(live.queueCalls.length, 2, 'control: focused wheel queues');
  } finally {
    ok.app.unmount();
  }
});

test('mvui25c rss: bounded memory for the input suite', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
