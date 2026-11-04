// V028-FIT: compile the real tile and observe presentation-owned geometry.
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

test('V028-FIT: last painted dimensions override projection until the next paint', async () => {
  let notify;
  let count = 0;
  const {canvas} = inputCanvasDouble(RECT_2X, 1280, 720);
  const scheduler = {
    attachCanvas: () => ({ok:true}), detachCanvas() {}, evictSurface() {},
    getInstrumentation: () => ({presentCount:count,lastPresentedHandle: count ? `frame-${count}` : ''}),
    subscribePresentation(cb) { notify = cb; return () => {}; },
  };
  const tile = mountTile(SurfaceCanvas, {tileScheduler:scheduler}, canvas,
    {frameWidth:1280,frameHeight:900});
  try {
    await nextTick();
    const section = tile.root.children[0];
    assert.equal(section.props['data-aspect-ratio'], '1280 / 900');
    count++; notify(); await nextTick();
    assert.equal(section.props['data-aspect-ratio'], '1280 / 720');
    await tile.setProps({frameWidth:900,frameHeight:1280});
    assert.equal(section.props['data-aspect-ratio'], '1280 / 720', 'projection cannot resize painted pixels');
    canvas.width=600; canvas.height=800; count++; notify(); await nextTick();
    assert.equal(section.props['data-aspect-ratio'], '600 / 800');
    assert.equal(section.props['data-frame-width'], 600);
    assert.equal(section.props['data-frame-height'], 800);
  } finally { tile.app.unmount(); }
});

test('V028-FIT: DISPLAY paint owns aspect and rebinding clears it', async () => {
  let binding;
  const {canvas} = inputCanvasDouble(RECT_2X, 640, 360);
  const router = { bindSurface(spec) { binding = spec; }, unbindSurface() {} };
  const tile = mountTile(SurfaceCanvas, {displayPortRouter:router}, canvas,
    {frameWidth:1280,frameHeight:900});
  try {
    await nextTick();
    assert.equal(binding.onFrame({surfaceId:'elsewhere'}), false);
    assert.equal(tile.root.children[0].props['data-aspect-ratio'], '1280 / 900');
    assert.equal(binding.onFrame({surfaceId:'A'}), true);
    await nextTick();
    assert.equal(tile.root.children[0].props['data-aspect-ratio'], '640 / 360');
    await tile.setProps({surfaceId:'B'});
    assert.equal(tile.root.children[0].props['data-aspect-ratio'], '1280 / 900');
  } finally {tile.app.unmount();}
});
