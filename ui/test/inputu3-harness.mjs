// INPUT-U3 shared harness: compiles the REAL SurfaceCanvas SFC (inline template)
// on a stub renderer with a closed dependency map, wiring the lazily loaded
// pointerEcho module to a (possibly mutated) source. Bounded fakes only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, ref } from 'vue';
import { tick } from './frame-wait.mjs';

export const SFC_SOURCE = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');
export const ECHO_SOURCE = readFileSync(new URL('../src/surfaces/pointerEcho.js', import.meta.url), 'utf8');
const vueUrl = JSON.stringify(import.meta.resolve('vue'));
const schedulerUrl = JSON.stringify(import.meta.resolve('../src/surfaces/tileScheduler.js'));
const frameMapUrl = import.meta.resolve('../src/input/frameMap.js');
const echoUrl = import.meta.resolve('../src/surfaces/pointerEcho.js');
let serial = 0;

const dataUrl = (code, tag) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}`;

/**
 * Returns the URL of the pointerEcho module, optionally mutated. A mutator must
 * change the source (a vacuous mutant fails loudly).
 */
export function echoModuleUrl(mutate) {
  if (mutate === undefined) return echoUrl;
  const mutated = mutate(ECHO_SOURCE);
  assert.notEqual(mutated, ECHO_SOURCE, 'echo mutant changed nothing');
  const code = mutated.replace("'../input/frameMap.js'", JSON.stringify(frameMapUrl));
  return dataUrl(code, `inputu3-echo-${serial++}`);
}

/**
 * Compiles the SFC. `echo: 'real' | 'missing'`: missing leaves the lazy import
 * unresolvable (relative specifier from a data: URL), modelling a failed load.
 */
export async function compileTile({ mutateSfc, mutateEcho, echo = 'real' } = {}) {
  let source = SFC_SOURCE;
  if (mutateSfc !== undefined) {
    source = mutateSfc(SFC_SOURCE);
    assert.notEqual(source, SFC_SOURCE, 'sfc mutant changed nothing');
  }
  const compiled = compileScript(parse(source).descriptor, { id: `inputu3-tile-${serial}`, inlineTemplate: true });
  let code = compiled.content.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
  code = code.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
    if (spec === 'vue') return all.replace(/(['"])vue\1/, vueUrl);
    assert.equal(spec, './tileScheduler.js', `Unmapped SFC dependency: ${spec}`);
    return `const ${bindings.trim()} = await import(${schedulerUrl});`;
  });
  let url = null;
  if (echo === 'real') {
    url = echoModuleUrl(mutateEcho);
    assert.ok(code.includes("import('./pointerEcho.js')"), 'lazy echo import present');
    code = code.replace("import('./pointerEcho.js')", `import(${JSON.stringify(url)})`);
    await import(url); // warm: the SFC dynamic import then settles within microtasks
  }
  const tag = `inputu3-tile-${serial++}`;
  return (await import(dataUrl(code, tag))).default;
}

export function canvasDouble(rect, paintWidth, paintHeight) {
  const doc = { activeElement: null };
  const canvas = {
    tag: 'canvas', props: {}, children: [], text: null, parent: null,
    patchKeys: [], width: paintWidth, height: paintHeight, offsetLeft: 0, offsetTop: 0,
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
      if (tag === 'canvas') return canvasStub;
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
      if (el === canvasStub) canvasStub.patchKeys.push(key);
    },
  };
}

export function stubInputPort() {
  const queueCalls = [];
  const gateCloses = [];
  const port = Object.freeze({
    available: true,
    send: async () => ({ ok: true, accepted: 0 }),
    queue: (surfaceId, streamId, event) => { queueCalls.push({ surfaceId, streamId, event }); },
    closeGate: (surfaceId) => { gateCloses.push(surfaceId); },
    onRefusal: () => () => {},
    dispose: () => {},
  });
  return { port, queueCalls, gateCloses };
}

/** Scheduler double whose instrumentation the test controls. */
export function stubScheduler() {
  const state = { info: null };
  const scheduler = {
    attachCanvas: () => ({ ok: true, token: Symbol('t') }),
    detachCanvas: () => {},
    getInstrumentation: () => state.info,
    evictSurface: () => {},
  };
  return { scheduler, state };
}

export function mountTile(Component, provides, canvasStub, initialProps = {}) {
  const { createApp } = createRenderer(stubOps(canvasStub));
  const propsRef = ref({
    surfaceId: 'A', generation: 1, epoch: 7,
    frame: 'h1', digest: 'd1', state: 'live', frameWidth: 0, frameHeight: 0,
    inputEnabled: true, streamId: 3,
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

export function findAll(node, tag, found = []) {
  if (node === null || typeof node !== 'object') return found;
  if (node.tag === tag) found.push(node);
  for (const child of node.children ?? []) findAll(child, tag, found);
  return found;
}

export function pointerEvent(type, overrides = {}) {
  const event = {
    type, button: 0, buttons: 1, pointerId: 1, clientX: 0, clientY: 0, defaultPrevented: false,
    ...overrides,
    preventDefault() { event.defaultPrevented = true; },
  };
  return event;
}

export function plainEvent(type) {
  const event = { type, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
  return event;
}

/** Click = pointerdown + pointerup at one client point. */
export function click(canvas, clientX, clientY, button = 0) {
  canvas.props.onPointerdown(pointerEvent('pointerdown', { clientX, clientY, button }));
  canvas.props.onPointerup(pointerEvent('pointerup', { clientX, clientY, button }));
}
