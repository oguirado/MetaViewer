/**
 * MVUI26 lane I: canvas regression tests for frames RV10-04 (pointerup
 * requires a matching pointerdown) and frames NEW-02 (wheel prevents
 * page scroll only when an event is queued) in SurfaceCanvas.vue. Each
 * fix pairs the report's regression test with a negative control. The
 * REAL SFC is compiled with the closed dependency map on the stub
 * renderer with REAL focus semantics, like the committed canvas suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, ref } from 'vue';
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
  const compiled = compileScript(parse(source).descriptor, { id: 'mvui26i-tile', inlineTemplate: true });
  const code = rewriteImports(compiled.content, {
    './tileScheduler.js': schedulerUrl,
    '../input/keyMap.js': keyMapUrl,
    '../input/frameMap.js': frameMapUrl,
  });
  const tag = `mvui26i-tile-${sfcSerial++}`;
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}`)).default;
}

const SurfaceCanvas = await compileTile(tileSource);

const RECT_2X = { x: 10, y: 20, width: 200, height: 100, left: 10, top: 20, right: 210, bottom: 120 };
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
    },
  };
}

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

function fakePointerEvent(type, overrides = {}) {
  const event = {
    type, button: 0, buttons: 1, clientX: 0, clientY: 0, pointerId: 7,
    defaultPrevented: false,
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

test('mvui26 pointerup without pointerdown sends nothing', () => {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    canvas.focus();
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 0, clientX: 110, clientY: 70 }));
    assert.equal(queueCalls.length, 0, 'release with no press sends nothing');
  } finally {
    tile.app.unmount();
  }
});

test('mvui26 pointer control: matching down then up sends one click', () => {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    canvas.props.onPointerdown(fakePointerEvent('pointerdown', { button: 0, clientX: 110, clientY: 70 }));
    assert.equal(queueCalls.length, 0, 'pointerdown sends nothing');
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 0, clientX: 110, clientY: 70 }));
    assert.equal(queueCalls.length, 1);
    assert.deepEqual(queueCalls[0].event, { kind: 'click', x: 200, y: 100, button: 'left' });
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 0, clientX: 110, clientY: 70 }));
    assert.equal(queueCalls.length, 1, 'one press yields at most one click');
  } finally {
    tile.app.unmount();
  }
});

test('mvui26 pointer: cancelled, blurred and outside-started presses never click', async () => {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    canvas.focus();
    canvas.props.onPointerdown(fakePointerEvent('pointerdown', { clientX: 110, clientY: 70 }));
    canvas.props.onPointercancel?.(fakePointerEvent('pointercancel', { clientX: 110, clientY: 70 }));
    canvas.props.onPointerup(fakePointerEvent('pointerup', { clientX: 110, clientY: 70 }));
    assert.equal(queueCalls.length, 0, 'cancelled press sends nothing');
    canvas.props.onPointerdown(fakePointerEvent('pointerdown', { clientX: 110, clientY: 70 }));
    canvas.blur();
    canvas.focus();
    canvas.props.onPointerup(fakePointerEvent('pointerup', { clientX: 110, clientY: 70 }));
    assert.equal(queueCalls.length, 0, 'blurred press sends nothing');
    canvas.props.onPointerdown(fakePointerEvent('pointerdown', { button: 0, clientX: 110, clientY: 70 }));
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 2, clientX: 110, clientY: 70 }));
    assert.equal(queueCalls.length, 0, 'mismatched button sends nothing');
    const bar = inputCanvasDouble(LETTERBOX_RECT, PAINT_W, PAINT_H);
    const gated = mounted({ inputPort: port }, bar.canvas, { inputEnabled: true, streamId: 3 });
    try {
      bar.canvas.focus();
      bar.canvas.props.onPointerdown(fakePointerEvent('pointerdown', { clientX: 100, clientY: 25 }));
      bar.canvas.props.onPointerup(fakePointerEvent('pointerup', { clientX: 100, clientY: 100 }));
      assert.equal(queueCalls.length, 0, 'outside-started press sends nothing');
    } finally {
      gated.app.unmount();
    }
    await tile.setProps({ inputEnabled: true });
  } finally {
    tile.app.unmount();
  }
});

test('mvui26 letterbox wheel does not prevent scroll', () => {
  const { canvas } = inputCanvasDouble(LETTERBOX_RECT, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    canvas.focus();
    const bar = fakeWheelEvent({ clientX: 100, clientY: 25, deltaY: -10 });
    canvas.props.onWheel(bar);
    assert.equal(bar.defaultPrevented, false, 'letterbox wheel keeps page scroll');
    assert.equal(queueCalls.length, 0);
    const inside = fakeWheelEvent({ clientX: 100, clientY: 100, deltaY: -10 });
    canvas.props.onWheel(inside);
    assert.equal(inside.defaultPrevented, true, 'queued wheel prevents page scroll');
    assert.equal(queueCalls.length, 1);
    assert.deepEqual(queueCalls[0].event, { kind: 'scroll', dx: 0, dy: -10, x: 200, y: 100 });
  } finally {
    tile.app.unmount();
  }
});

test('mvui26 wheel: zero deltas keep scroll; unfocused wheels untouched', () => {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    const cold = fakeWheelEvent({ clientX: 110, clientY: 70, deltaY: -10 });
    canvas.props.onWheel(cold);
    assert.equal(cold.defaultPrevented, false, 'unfocused wheel keeps page scroll');
    assert.equal(queueCalls.length, 0);
    canvas.focus();
    const zero = fakeWheelEvent({ clientX: 110, clientY: 70, deltaX: 0.1, deltaY: -0.1 });
    canvas.props.onWheel(zero);
    assert.equal(zero.defaultPrevented, false, 'zero-delta wheel keeps page scroll');
    assert.equal(queueCalls.length, 0);
  } finally {
    tile.app.unmount();
  }
});
