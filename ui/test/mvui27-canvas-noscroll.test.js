// MVUI27 lane S: a tile-canvas press never scrolls the page in any mode.
// The REAL SurfaceCanvas SFC (compiled with @vue/compiler-sfc, inline
// template) on a stub renderer with REAL focus semantics plus focus-option
// recording: pointerdown/click on a NON-focusable canvas (READ mode) prevent
// the default action without taking focus and without queueing; the gated
// WRITE path (focus with { preventScroll: true }, matching release queues)
// is unchanged. Negative controls: an in-memory mutant with the fix removed
// restores scrolling (the oracle rejects on it); the doubles start
// unprevented with bare focus options. Bounded fakes (one tile,
// single-digit events); async waits via frame-wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, ref } from 'vue';
import { tick } from './frame-wait.mjs';

const tileSource = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');

const vueUrl = JSON.stringify(import.meta.resolve('vue'));
const schedulerUrl = JSON.stringify(import.meta.resolve('../src/surfaces/tileScheduler.js'));
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
  const compiled = compileScript(parse(source).descriptor, { id: 'mvui27-tile', inlineTemplate: true });
  const code = rewriteImports(compiled.content, {
    './tileScheduler.js': schedulerUrl,
  });
  const tag = `mvui27-tile-${sfcSerial++}`;
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}`)).default;
}

const SurfaceCanvas = await compileTile(tileSource);

// Paint-owned 400x200 frame in a 200x100 CSS box at (10,20): exact 2x, no
// letterbox. Client (110,70) maps to frame (200,100).
const RECT_2X = { x: 10, y: 20, width: 200, height: 100, left: 10, top: 20, right: 210, bottom: 120 };
const PAINT_W = 400;
const PAINT_H = 200;

function inputCanvasDouble(rect, paintWidth, paintHeight) {
  const doc = { activeElement: null };
  const focusCalls = [];
  const canvas = {
    tag: 'canvas', props: {}, children: [], text: null, parent: null,
    patchKeys: [], width: paintWidth, height: paintHeight,
    getBoundingClientRect() { return { ...rect }; },
    focus(options) {
      focusCalls.push(options);
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
  return { canvas, doc, focusCalls };
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

function cases() {
  return [
    ['disabled', 'available', { inputEnabled: false, streamId: 3 }],
    ['unavailable port', 'unavailable', { inputEnabled: true, streamId: 3 }],
    ['missing port', 'missing', { inputEnabled: true, streamId: 3 }],
  ];
}

function portFor(kind, stub) {
  if (kind === 'missing') return null;
  if (kind === 'unavailable') return Object.freeze({ ...stub.port, available: false });
  return stub.port;
}

// The new rule, shared by the regression test (real SFC: passes) and the
// mutant control (fix removed: rejects at the first prevent assertion).
function nonFocusableOracle(Component) {
  for (const [label, kind, props] of cases()) {
    const { canvas, doc, focusCalls } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
    const stub = stubInputPort();
    const port = portFor(kind, stub);
    const tile = mountTile(Component, port === null ? {} : { inputPort: port }, canvas, props);
    try {
      assert.equal(canvas.props.tabindex, undefined, `${label}: stays non-focusable`);
      const down = fakePointerEvent('pointerdown', { button: 0, clientX: 110, clientY: 70 });
      canvas.props.onPointerdown(down);
      assert.equal(down.defaultPrevented, true, `${label}: pointerdown never scrolls the page`);
      assert.equal(doc.activeElement, null, `${label}: down never focuses`);
      assert.equal(focusCalls.length, 0, `${label}: focus never called`);
      const click = fakePointerEvent('click', { button: 0, clientX: 110, clientY: 70 });
      canvas.props.onClick(click);
      assert.equal(click.defaultPrevented, true, `${label}: click never scrolls the page`);
      assert.equal(stub.queueCalls.length, 0, `${label}: nothing queued`);
      canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 0, clientX: 110, clientY: 70 }));
      assert.equal(stub.queueCalls.length, 0, `${label}: release without an armed press queues nothing`);
    } finally {
      tile.app.unmount();
    }
  }
}

test('mvui27 canvas regression: non-focusable canvas never scrolls the page', () => {
  nonFocusableOracle(SurfaceCanvas);
});

// In-memory mutant (production source untouched): the fix removed, i.e. the
// MVUI26B gated shape — pointerdown returns before preventDefault and click
// is gated — so the oracle must reject exactly as it does on the base tree.
function removeFix(source) {
  const downFixed = 'function onCanvasPointerDown(event) {\n  event.preventDefault();\n'
    + '  if (!(props.inputEnabled === true && inputPort !== null && inputPort.available === true)) return;\n'
    + '  focusCanvas();';
  const downGated = 'function onCanvasPointerDown(event) {\n'
    + '  if (!(props.inputEnabled === true && inputPort !== null && inputPort.available === true)) return;\n'
    + '  event.preventDefault();\n  focusCanvas();';
  const clickFixed = 'function onCanvasClick(event) {\n  event.preventDefault();\n}';
  const clickGated = 'function onCanvasClick(event) {\n'
    + '  if (!(props.inputEnabled === true && inputPort !== null && inputPort.available === true)) return;\n'
    + '  event.preventDefault();\n}';
  assert.equal(source.split(downFixed).length, 2, 'pointerdown fix anchor is unique');
  assert.equal(source.split(clickFixed).length, 2, 'click fix anchor is unique');
  const changed = source.split(downFixed).join(downGated).split(clickFixed).join(clickGated);
  assert.notEqual(changed, source, 'negative control must change the source');
  return changed;
}

test('mvui27 negative control: fix-removed mutant restores scrolling', async () => {
  const Mutant = await compileTile(removeFix(tileSource));
  await assert.rejects(async () => { nonFocusableOracle(Mutant); }, { code: 'ERR_ASSERTION' });
  // The mutant is otherwise healthy: the gated WRITE path still prevents,
  // focuses without scrolling, and queues a matching release.
  const { canvas, doc, focusCalls } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mountTile(Mutant, { inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    const down = fakePointerEvent('pointerdown', { button: 0, clientX: 110, clientY: 70 });
    canvas.props.onPointerdown(down);
    assert.equal(down.defaultPrevented, true, 'mutant focusable down still prevents');
    assert.equal(doc.activeElement, canvas, 'mutant focusable down still focuses');
    assert.deepEqual(focusCalls[0], { preventScroll: true });
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 0, clientX: 110, clientY: 70 }));
    assert.equal(queueCalls.length, 1, 'mutant matching release still clicks');
  } finally {
    tile.app.unmount();
  }
});

test('mvui27 canvas: gated WRITE behaviour is unchanged', () => {
  const { canvas, doc, focusCalls } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mountTile(SurfaceCanvas, { inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    const down = fakePointerEvent('pointerdown', { button: 0, clientX: 110, clientY: 70 });
    canvas.props.onPointerdown(down);
    assert.equal(down.defaultPrevented, true, 'focusable down prevents page scroll');
    assert.equal(doc.activeElement, canvas, 'focusable down takes focus');
    assert.deepEqual(focusCalls[0], { preventScroll: true }, 'focus never scrolls the page');
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 0, clientX: 110, clientY: 70 }));
    assert.equal(queueCalls.length, 1, 'matching release still clicks');
    assert.deepEqual(queueCalls[0].event, { kind: 'click', x: 200, y: 100, button: 'left' });
  } finally {
    tile.app.unmount();
  }
});

test('mvui27 canvas: unfocused scroll keys keep page scroll', () => {
  const { canvas, doc } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mountTile(SurfaceCanvas, { inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    assert.equal(doc.activeElement, null, 'canvas starts unfocused');
    for (const key of [' ', 'ArrowDown', 'PageDown']) {
      const event = fakeKeyEvent(key);
      canvas.props.onKeydown(event);
      assert.equal(event.defaultPrevented, false, `unfocused ${key} keeps page scroll`);
      assert.equal(queueCalls.length, 0, `unfocused ${key} queues nothing`);
    }
  } finally {
    tile.app.unmount();
  }
});

test('mvui27 canvas: the doubles start unprevented with bare focus options', () => {
  const { canvas, doc, focusCalls } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port } = stubInputPort();
  const tile = mountTile(SurfaceCanvas, { inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    // A fresh fake starts unprevented, so `true` above can only come from
    // the handler; a bare focus() records undefined, so the options object
    // above can only come from the SFC passing preventScroll.
    assert.equal(fakePointerEvent('pointerdown').defaultPrevented, false);
    assert.equal(fakePointerEvent('click').defaultPrevented, false);
    assert.equal(fakeKeyEvent(' ').defaultPrevented, false);
    canvas.focus();
    assert.equal(doc.activeElement, canvas, 'bare focus still takes focus when focusable');
    assert.equal(focusCalls.length, 1);
    assert.equal(focusCalls[0], undefined, 'bare focus records no options');
  } finally {
    tile.app.unmount();
  }
});
