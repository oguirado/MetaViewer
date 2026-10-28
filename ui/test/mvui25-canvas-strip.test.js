// MVUI25 lane C: strip READ-ONLY toggle plus the pure input-anchor helpers.
// The strip label is asserted through the REAL SurfaceCanvas SFC (compiled
// with @vue/compiler-sfc, inline template) on a stub renderer: gated-in
// tiles show no READ-ONLY guard, every other state renders it exactly as
// before. Helper tests pin the anchor shape, DOM-safety, and the grammar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, ref } from 'vue';
import {
  SURFACE_ID_SEGMENT_RE,
  formatFrameStrip,
  surfaceCanvasAnchor,
  surfaceCanvasDomId,
  surfaceIdSegment,
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
  const compiled = compileScript(parse(source).descriptor, { id: 'mvui25c-strip', inlineTemplate: true });
  const code = rewriteImports(compiled.content, {
    './tileScheduler.js': schedulerUrl,
    '../input/keyMap.js': keyMapUrl,
    '../input/frameMap.js': frameMapUrl,
  });
  const tag = `mvui25c-strip-${sfcSerial++}`;
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}`)).default;
}

const SurfaceCanvas = await compileTile(tileSource);

function stubOps() {
  return {
    createElement(tag) {
      const node = { tag, props: {}, children: [], text: null, parent: null };
      // The gate-loss watcher calls canvas.blur(); model the DOM method.
      if (tag === 'canvas') {
        node.focus = () => {};
        node.blur = () => {};
      }
      return node;
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

function mountTile(Component, provides, initialProps = {}) {
  const { createApp } = createRenderer(stubOps());
  const propsRef = ref({
    surfaceId: 'A', generation: 1, epoch: 7,
    frame: 'f1', digest: 'ab', state: 'live', frameWidth: 0, frameHeight: 0,
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

const mountStrip = (provides, initialProps = {}) => mountTile(SurfaceCanvas, provides, initialProps);

// MVUI25D lane C: preamble-shaped port double with a selectable gate flag.
function stubPort(available) {
  return Object.freeze({
    available,
    send: async () => ({ ok: true, accepted: 0 }),
    queue: () => {},
    onRefusal: () => () => {},
    dispose: () => {},
  });
}

const mountNodes = (node) => [node, ...(node.children ?? []).flatMap(mountNodes)];
const mountText = (node) => [node.text ?? '', ...(node.children ?? []).map(mountText)].join(' ');
const byClass = (root, cls) => mountNodes(root).filter((node) => node.props?.class === cls);
const mountCanvas = (root) => mountNodes(root).find((node) => node.tag === 'canvas');

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

test('mvui25c anchor helper: shape and passthrough for safe ids', () => {
  for (const id of ['A', 'cap-01', 'capsule-a', 'srf_01.main:slot-2']) {
    assert.equal(surfaceInputFocusAnchor(id), `tile-${id}-input-focus`, `anchor for ${id}`);
  }
  assert.equal(surfaceInputFocusAnchor('cap-07'), 'tile-cap-07-input-focus');
});

test('mvui25c anchor helper: hostile ids map through the same DOM-safe segment', () => {
  const segment = surfaceIdSegment('a b/c');
  assert.ok(!/[\s/]/.test(segment), `segment carries whitespace/slash: ${segment}`);
  assert.ok(SURFACE_ID_SEGMENT_RE.test(segment), `segment outside grammar: ${segment}`);
  const anchor = surfaceInputFocusAnchor('a b/c');
  assert.equal(anchor, `tile-${segment}-input-focus`, 'anchor derives from the DOM-safe segment');
  assert.ok(!/[\s/]/.test(anchor), `anchor carries whitespace/slash: ${anchor}`);
  assert.equal(surfaceInputFocusAnchor('a b/c'), anchor, 'deterministic');
  assert.notEqual(surfaceInputFocusAnchor('a b/c'), surfaceInputFocusAnchor('a b/d'), 'distinct ids stay distinct');
  assert.notEqual(anchor, 'tile-a b/c-input-focus', 'raw id still interpolated');
});

test('mvui25c anchor helper: typical anchors fit the QA single-segment grammar', () => {
  for (const id of ['A', 'cap-01', 'capsule-a']) {
    const anchor = surfaceInputFocusAnchor(id);
    assert.equal(anchor.split('/').length, 1, `single segment: ${anchor}`);
    assert.ok(SURFACE_ID_SEGMENT_RE.test(anchor), `grammar-valid: ${anchor}`);
  }
  // The existing anchors are untouched by the new export.
  assert.equal(surfaceCanvasDomId('cap-01'), 'mv-surface-canvas-cap-01');
  assert.equal(surfaceCanvasAnchor('cap-01'), 'capsule/cap-01/slot');
});

test('mvui25c name helper: stable accessible name', () => {
  assert.equal(surfaceInputAccessibleName({ surfaceId: 'cap-07' }), 'Capsule input for cap-07');
  assert.equal(surfaceInputAccessibleName({ surfaceId: 'A' }), 'Capsule input for A');
});

test('mvui25c strip helper: readOnly false clears the label, otherwise unchanged', () => {
  assert.equal(
    formatFrameStrip({ frame: 'f1', generation: 1, digest: 'ab', readOnly: false }).readOnlyText, '');
  assert.equal(
    formatFrameStrip({ frame: 'f1', generation: 1, digest: 'ab' }).readOnlyText,
    'READ-ONLY ISOLATED EXECUTION');
  assert.equal(
    formatFrameStrip({ frame: 'f1', generation: 1, digest: 'ab', readOnly: undefined }).readOnlyText,
    'READ-ONLY ISOLATED EXECUTION');
  const cleared = formatFrameStrip({ frame: 'f1', generation: 12, digest: 'd'.repeat(64), readOnly: false });
  assert.equal(cleared.frameText, 'f1');
  assert.equal(cleared.generationText, '12');
  assert.ok(cleared.digestText.length > 0, 'other strip fields survive the toggle');
});

// ---------------------------------------------------------------------------
// Mounted strip toggle.
// ---------------------------------------------------------------------------

test('mvui25c strip: gated-in tile shows no READ-ONLY guard', () => {
  const tile = mountStrip({ inputPort: stubPort(true) }, { inputEnabled: true, streamId: 3 });
  try {
    const strips = byClass(tile.root, 'mv-surface__strip');
    assert.equal(strips.length, 1, 'witness strip renders while live');
    assert.equal(mountText(strips[0]).includes('READ-ONLY'), false, 'no READ-ONLY while gated in');
    assert.equal(byClass(tile.root, 'mv-surface__guard').length, 0, 'guard span absent while gated in');
    const text = mountText(strips[0]);
    assert.ok(text.includes('FRAME:'), 'frame witness survives');
    assert.ok(text.includes('GEN:'), 'generation witness survives');
    assert.ok(text.includes('SHA256:'), 'digest witness survives');
    assert.equal(String(strips[0].props['aria-label'] ?? '').includes('READ-ONLY'), false);
  } finally {
    tile.app.unmount();
  }
});

test('mvui25c strip negative: gated-out tile keeps the READ-ONLY guard', async () => {
  // MVUI25D lane C: the toggle half needs an available port; with no port the
  // guard now (correctly) stays. Assertions below are unchanged.
  const tile = mountStrip({ inputPort: stubPort(true) }, { inputEnabled: false });
  try {
    const strips = byClass(tile.root, 'mv-surface__strip');
    assert.equal(strips.length, 1, 'witness strip renders while live');
    const guards = byClass(tile.root, 'mv-surface__guard');
    assert.equal(guards.length, 1, 'guard span renders while gated out');
    assert.equal(mountText(guards[0]).trim(), 'READ-ONLY ISOLATED EXECUTION');
    assert.ok(String(strips[0].props['aria-label'] ?? '').includes('READ-ONLY ISOLATED EXECUTION'));
    // The same tile toggles the label when gated in, without remounting.
    await tile.setProps({ inputEnabled: true });
    assert.equal(byClass(tile.root, 'mv-surface__guard').length, 0, 'guard clears on gate-in');
    assert.equal(byClass(tile.root, 'mv-surface__strip').length, 1, 'strip stays mounted');
    await tile.setProps({ inputEnabled: false });
    assert.equal(byClass(tile.root, 'mv-surface__guard').length, 1, 'guard returns on gate-out');
  } finally {
    tile.app.unmount();
  }
});

test('mvui25d strip negative: inputEnabled with null port keeps READ-ONLY and no tabindex', () => {
  const tile = mountStrip({ inputPort: null }, { inputEnabled: true, streamId: 3 });
  try {
    const strips = byClass(tile.root, 'mv-surface__strip');
    assert.equal(strips.length, 1, 'witness strip renders while live');
    const guards = byClass(tile.root, 'mv-surface__guard');
    assert.equal(guards.length, 1, 'guard span renders without a port');
    assert.equal(mountText(guards[0]).trim(), 'READ-ONLY ISOLATED EXECUTION');
    assert.ok(String(strips[0].props['aria-label'] ?? '').includes('READ-ONLY ISOLATED EXECUTION'));
    const canvas = mountCanvas(tile.root);
    assert.ok(canvas, 'canvas renders');
    assert.equal(canvas.props.tabindex, undefined, 'no tabindex without a port');
    assert.equal(canvas.props['aria-hidden'], 'true', 'canvas stays hidden without a port');
  } finally {
    tile.app.unmount();
  }
});

test('mvui25d strip negative: inputEnabled with unavailable port keeps READ-ONLY and no tabindex', () => {
  const tile = mountStrip({ inputPort: stubPort(false) }, { inputEnabled: true, streamId: 3 });
  try {
    const strips = byClass(tile.root, 'mv-surface__strip');
    assert.equal(strips.length, 1, 'witness strip renders while live');
    const guards = byClass(tile.root, 'mv-surface__guard');
    assert.equal(guards.length, 1, 'guard span renders with an unavailable port');
    assert.equal(mountText(guards[0]).trim(), 'READ-ONLY ISOLATED EXECUTION');
    assert.ok(String(strips[0].props['aria-label'] ?? '').includes('READ-ONLY ISOLATED EXECUTION'));
    const canvas = mountCanvas(tile.root);
    assert.ok(canvas, 'canvas renders');
    assert.equal(canvas.props.tabindex, undefined, 'no tabindex with an unavailable port');
    assert.equal(canvas.props['aria-hidden'], 'true', 'canvas stays hidden with an unavailable port');
  } finally {
    tile.app.unmount();
  }
});

test('mvui25c strip: the guard still renders from the strip readOnly path', () => {
  assert.ok(tileSource.includes('strip.readOnlyText'), 'guard renders from strip.readOnlyText');
  assert.ok(tileSource.includes('mv-surface__guard'), 'guard span survives in the template');
  assert.ok(tileSource.includes('readOnly: canvasFocusable.value ? false : undefined'),
    'strip readOnly keys off canvasFocusable');
});

test('mvui25c rss: bounded memory for the strip suite', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
