// MVUI32 lane I (R3-INPUT-1): gate-closure integration — the REAL
// SurfaceCanvas SFC (compiled with @vue/compiler-sfc, inline template, closed
// import map) wired to the REAL inputPort with a saved-RAF double and a
// recording facade. A key buffered in WRITE must never reach sendFn once the
// gate closes (READ switch, blur, unmount, stream change, control loss), must
// not replay when WRITE returns, and a fresh key must dispatch normally.
// Plain node:test; no sleeps, no sockets, no Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, ref } from 'vue';
import { createInputPort } from '../src/input/inputPort.js';
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
  const compiled = compileScript(parse(source).descriptor, { id: 'mvui32i-tile', inlineTemplate: true });
  const code = rewriteImports(compiled.content, {
    './tileScheduler.js': schedulerUrl,
    '../input/keyMap.js': keyMapUrl,
    '../input/frameMap.js': frameMapUrl,
  });
  const tag = `mvui32i-tile-${sfcSerial++}`;
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}`)).default;
}

const SurfaceCanvas = await compileTile(tileSource);

const RECT_2X = { x: 10, y: 20, width: 200, height: 100, left: 10, top: 20, right: 210, bottom: 120 };
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

/** @returns {{ raf: (cb: (t: number) => void) => unknown, cancelRaf: () => void, fire: () => void, scheduled: boolean }} */
function makeSavedRaf() {
  /** @type {((t: number) => void) | null} */
  let cb = null;
  return {
    raf: (fn) => { cb = fn; return 1; },
    cancelRaf: () => { cb = null; },
    fire: () => { const f = cb; cb = null; if (f) f(0); },
    get scheduled() { return cb !== null; },
  };
}

/** @returns {{ facade: { calls: any[], send: (batch: any) => Promise<any> }, frames: ReturnType<typeof makeSavedRaf>, port: ReturnType<typeof createInputPort> }} */
function wiredPort() {
  const calls = [];
  const facade = {
    calls,
    send: (batch) => { calls.push(batch); return Promise.resolve({ ok: true, accepted: batch.events.length }); },
  };
  const frames = makeSavedRaf();
  const port = createInputPort(facade, { raf: frames.raf, cancelRaf: frames.cancelRaf });
  return { facade, frames, port };
}

function mountedWriteTile(wiring, initialProps = {}) {
  const { canvas } = inputCanvasDouble(RECT_2X, PAINT_W, PAINT_H);
  const tile = mountTile(SurfaceCanvas, { inputPort: wiring.port }, canvas,
    { inputEnabled: true, streamId: 3, ...initialProps });
  return { tile, canvas };
}

test('mvui32i read: buffered key never sends after a WRITE->READ switch', async () => {
  const wiring = wiredPort();
  const { tile, canvas } = mountedWriteTile(wiring);
  try {
    canvas.focus();
    const stale = fakeKeyEvent('a');
    canvas.props.onKeydown(stale);
    assert.equal(stale.defaultPrevented, true, 'WRITE key is captured');
    assert.equal(wiring.frames.scheduled, true, 'capture schedules the RAF flush');
    await tile.setProps({ inputEnabled: false });
    wiring.frames.fire();
    await tick();
    assert.equal(wiring.facade.calls.length, 0, 'stale buffered key is never sent');
  } finally {
    tile.app.unmount();
    wiring.port.dispose();
  }
});

test('mvui32i read: no replay on WRITE return, fresh key dispatches once', async () => {
  const wiring = wiredPort();
  const { tile, canvas } = mountedWriteTile(wiring);
  try {
    canvas.focus();
    canvas.props.onKeydown(fakeKeyEvent('a'));
    await tile.setProps({ inputEnabled: false });
    wiring.frames.fire();
    await tick();
    assert.equal(wiring.facade.calls.length, 0);
    await tile.setProps({ inputEnabled: true });
    canvas.focus();
    wiring.frames.fire();
    await tick();
    assert.equal(wiring.facade.calls.length, 0, 'cancelled key still does not replay');
    const fresh = fakeKeyEvent('Enter');
    canvas.props.onKeydown(fresh);
    assert.equal(fresh.defaultPrevented, true, 'fresh WRITE key is captured');
    wiring.frames.fire();
    await tick();
    assert.equal(wiring.facade.calls.length, 1, 'fresh key dispatches once');
    assert.equal(wiring.facade.calls[0].surface_id, 'A');
    assert.equal(wiring.facade.calls[0].stream_id, 3);
    assert.deepEqual(wiring.facade.calls[0].events, [{ kind: 'key', keys: ['Return'] }]);
  } finally {
    tile.app.unmount();
    wiring.port.dispose();
  }
});

test('mvui32i blur: buffered key never sends after focus loss', async () => {
  const wiring = wiredPort();
  const { tile, canvas } = mountedWriteTile(wiring);
  try {
    canvas.focus();
    canvas.props.onKeydown(fakeKeyEvent('a'));
    canvas.blur();
    wiring.frames.fire();
    await tick();
    assert.equal(wiring.facade.calls.length, 0, 'key buffered before blur is never sent');
    canvas.focus();
    canvas.props.onKeydown(fakeKeyEvent('Enter'));
    wiring.frames.fire();
    await tick();
    assert.equal(wiring.facade.calls.length, 1, 'post-blur fresh key dispatches');
  } finally {
    tile.app.unmount();
    wiring.port.dispose();
  }
});

test('mvui32i unmount: buffered key never sends after the tile unmounts', async () => {
  const wiring = wiredPort();
  const { tile, canvas } = mountedWriteTile(wiring);
  try {
    canvas.focus();
    canvas.props.onKeydown(fakeKeyEvent('a'));
    assert.equal(wiring.frames.scheduled, true);
    tile.app.unmount();
    wiring.frames.fire();
    await tick();
    assert.equal(wiring.facade.calls.length, 0, 'key buffered before unmount is never sent');
  } finally {
    wiring.port.dispose();
  }
});

test('mvui32i stream: buffered key never sends after a stream change', async () => {
  const wiring = wiredPort();
  const { tile, canvas } = mountedWriteTile(wiring);
  try {
    canvas.focus();
    canvas.props.onKeydown(fakeKeyEvent('a'));
    await tile.setProps({ streamId: 4 });
    wiring.frames.fire();
    await tick();
    assert.equal(wiring.facade.calls.length, 0, 'key buffered under the old stream is never sent');
    canvas.props.onKeydown(fakeKeyEvent('Enter'));
    wiring.frames.fire();
    await tick();
    assert.equal(wiring.facade.calls.length, 1, 'fresh key dispatches on the new stream');
    assert.equal(wiring.facade.calls[0].stream_id, 4);
    assert.deepEqual(wiring.facade.calls[0].events, [{ kind: 'key', keys: ['Return'] }]);
  } finally {
    tile.app.unmount();
    wiring.port.dispose();
  }
});

test('mvui32i control: buffered key never sends after a control handoff', async () => {
  // The App maps a non-human control handoff to inputEnabled=false, the same
  // signal as a READ switch; the tile must drop the buffered key either way.
  const wiring = wiredPort();
  const { tile, canvas } = mountedWriteTile(wiring);
  try {
    canvas.focus();
    canvas.props.onKeydown(fakeKeyEvent('a'));
    await tile.setProps({ inputEnabled: false });
    wiring.frames.fire();
    await tick();
    assert.equal(wiring.facade.calls.length, 0, 'key buffered before the handoff is never sent');
    await tile.setProps({ inputEnabled: true });
    canvas.focus();
    canvas.props.onKeydown(fakeKeyEvent('Enter'));
    wiring.frames.fire();
    await tick();
    assert.equal(wiring.facade.calls.length, 1, 'fresh key dispatches after control returns');
  } finally {
    tile.app.unmount();
    wiring.port.dispose();
  }
});

test('mvui32i negative: queued key dispatches normally while the gate stays open', async () => {
  const wiring = wiredPort();
  const { tile, canvas } = mountedWriteTile(wiring);
  try {
    canvas.focus();
    canvas.props.onKeydown(fakeKeyEvent('a'));
    wiring.frames.fire();
    await tick();
    assert.equal(wiring.facade.calls.length, 1);
    assert.equal(wiring.facade.calls[0].surface_id, 'A');
    assert.equal(wiring.facade.calls[0].stream_id, 3);
    assert.deepEqual(wiring.facade.calls[0].events, [{ kind: 'type', text: 'a' }]);
  } finally {
    tile.app.unmount();
    wiring.port.dispose();
  }
});
