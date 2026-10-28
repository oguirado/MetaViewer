// MVUI26B lane S: no page scroll on canvas pointer focus — the REAL
// SurfaceCanvas SFC (compiled with @vue/compiler-sfc, inline template) on a
// stub renderer with REAL focus semantics plus focus-option recording:
// pointerdown/click on a focusable canvas prevent the default action and
// focus with { preventScroll: true }; consumed keys prevent while focused;
// a non-focusable canvas keeps today's behaviour untouched. Bounded fakes
// (one tile, single-digit events); async waits via frame-wait.
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
  const compiled = compileScript(parse(source).descriptor, { id: 'mvui26b-tile', inlineTemplate: true });
  const code = rewriteImports(compiled.content, {
    './tileScheduler.js': schedulerUrl,
  });
  const tag = `mvui26b-tile-${sfcSerial++}`;
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

function mounted(provides, canvasStub, initialProps = {}) {
  return mountTile(SurfaceCanvas, provides, canvasStub, initialProps);
}

test('mvui26b canvas scroll: focusable pointerdown prevents and focuses without scrolling', () => {
  const { canvas, doc, focusCalls } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    const down = fakePointerEvent('pointerdown', { button: 0, clientX: 110, clientY: 70 });
    canvas.props.onPointerdown(down);
    assert.equal(down.defaultPrevented, true, 'focusable pointerdown prevents page scroll');
    assert.equal(doc.activeElement, canvas, 'pointerdown takes focus');
    assert.equal(focusCalls.length, 1, 'one focus call');
    assert.deepEqual(focusCalls[0], { preventScroll: true }, 'focus never scrolls the page');
    assert.equal(queueCalls.length, 0, 'pointerdown sends nothing');
    assert.equal(typeof canvas.props.onClick, 'function', 'click handler is bound');
    const click = fakePointerEvent('click', { button: 0, clientX: 110, clientY: 70 });
    canvas.props.onClick(click);
    assert.equal(click.defaultPrevented, true, 'focusable click prevents page scroll');
    assert.equal(queueCalls.length, 0, 'click sends nothing');
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 0, clientX: 110, clientY: 70 }));
    assert.equal(queueCalls.length, 1, 'matching release still clicks');
    assert.deepEqual(queueCalls[0].event, { kind: 'click', x: 200, y: 100, button: 'left' });
  } finally {
    tile.app.unmount();
  }
});

test('mvui26b canvas scroll: pointerdown outside the frame still prevents but never queues', () => {
  const { canvas, doc, focusCalls } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    const down = fakePointerEvent('pointerdown', { button: 0, clientX: 500, clientY: 500 });
    canvas.props.onPointerdown(down);
    assert.equal(down.defaultPrevented, true, 'outside-frame down still prevents page scroll');
    assert.equal(doc.activeElement, canvas, 'outside-frame down still focuses');
    assert.deepEqual(focusCalls[0], { preventScroll: true });
    canvas.props.onPointerup(fakePointerEvent('pointerup', { button: 0, clientX: 500, clientY: 500 }));
    assert.equal(queueCalls.length, 0, 'outside-frame press never queues');
  } finally {
    tile.app.unmount();
  }
});

test('mvui26b canvas scroll negative: non-focusable canvas keeps page scroll and clicks', () => {
  for (const [label, provides, props] of [
    ['disabled', null, { inputEnabled: false, streamId: 3 }],
    ['unavailable port', 'unavailable', { inputEnabled: true, streamId: 3 }],
  ]) {
    const { canvas, doc, focusCalls } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
    const stub = stubInputPort();
    const port = provides === null
      ? stub.port
      : Object.freeze({ ...stub.port, available: false });
    const tile = mounted({ inputPort: port }, canvas, props);
    try {
      assert.equal(canvas.props.tabindex, undefined, `${label}: no tabindex`);
      const down = fakePointerEvent('pointerdown', { button: 0, clientX: 110, clientY: 70 });
      canvas.props.onPointerdown(down);
      assert.equal(down.defaultPrevented, false, `${label}: down keeps page scroll`);
      assert.equal(doc.activeElement, null, `${label}: down never focuses`);
      assert.equal(focusCalls.length, 0, `${label}: focus never called`);
      const click = fakePointerEvent('click', { button: 0, clientX: 110, clientY: 70 });
      canvas.props.onClick(click);
      assert.equal(click.defaultPrevented, false, `${label}: click untouched`);
      assert.equal(stub.queueCalls.length, 0, `${label}: nothing queued`);
    } finally {
      tile.app.unmount();
    }
  }
});

test('mvui26b canvas scroll: consumed keys prevent page scroll while focused', () => {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
  try {
    canvas.focus();
    const keys = [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'];
    for (const key of keys) {
      const before = queueCalls.length;
      const event = fakeKeyEvent(key);
      canvas.props.onKeydown(event);
      assert.equal(event.defaultPrevented, true, `focused ${key} prevents page scroll`);
      assert.equal(queueCalls.length, before + 1, `focused ${key} queues`);
    }
  } finally {
    tile.app.unmount();
  }
});

test('mvui26b canvas scroll negative: unfocused canvas leaves scroll keys untouched', () => {
  const { canvas, doc } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port, queueCalls } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
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

test('mvui26b canvas scroll static: focus passes preventScroll and never scrolls into view', () => {
  assert.ok(tileSource.includes('preventScroll: true'), 'focus passes preventScroll');
  assert.equal(tileSource.includes('scrollIntoView'), false, 'no scrollIntoView call in the SFC');
  // Negative controls: both guards fire on planted fixtures.
  assert.ok('el.focus({ preventScroll: true });'.includes('preventScroll: true'),
    'positive guard matches the shipped call shape');
  assert.ok('canvas.scrollIntoView();'.includes('scrollIntoView'),
    'negative guard detects a planted scrollIntoView call');
  assert.equal('el.focus();'.includes('preventScroll'), false,
    'positive guard rejects a bare focus() call');
});

test('mvui26b canvas scroll negative: the doubles start unprevented with bare focus options', () => {
  const { canvas, doc, focusCalls } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const { port } = stubInputPort();
  const tile = mounted({ inputPort: port }, canvas, { inputEnabled: true, streamId: 3 });
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
