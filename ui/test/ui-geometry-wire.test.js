// UI-GEOMETRY-WIRE (night P5): the capsule browser fills its tile with no
// letterbox bands. The tile box takes the capsule's real aspect (from the
// surface's Width/Height, default 1280x900, never hard-coded 16:9) at every
// wall size and with 1-4 capsules; pointer coordinates (click, wheel, echo
// dot) stay exact; the DISPLAY chip/footer stays visible.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as Vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { containFit, mapClientToFrame } from '../src/input/frameMap.js';
import {
  DEFAULT_SURFACE_WIDTH,
  DEFAULT_SURFACE_HEIGHT,
  DEFAULT_SURFACE_ASPECT_RATIO,
  resolveSurfaceDimensions,
  computeTileContentBox,
} from '../src/surfaces/tileScheduler.js';
import {
  SCOPE,
  DEFAULT_CAPSULE_WIDTH,
  DEFAULT_CAPSULE_HEIGHT,
  resolveCapsuleDimensions,
  resolveWallTileBox,
  createWallLayout,
} from '../src/wall/layout.js';
import {
  DISPLAY_PORT_NOTICE_TYPE,
  DISPLAY_PORT_NOTICE_SCHEMA,
  createDisplayPort,
} from '../electron/framePort.js';
import { installDisplayPortRouter } from '../src/frames/displayPortRouter.js';

const SFC_PATH = fileURLToPath(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url));
const SCHEDULER_PATH = fileURLToPath(new URL('../src/surfaces/tileScheduler.js', import.meta.url));
const LAYOUT_PATH = fileURLToPath(new URL('../src/wall/layout.js', import.meta.url));
const WALL_CSS_PATH = fileURLToPath(new URL('../src/wall/wall.css', import.meta.url));
const LAYOUT_PROFILE_URL = pathToFileURL(
  fileURLToPath(new URL('../.kit/capsule-ui-kit/src/workspace/layoutProfile.js', import.meta.url)),
).href;
const KEY_MAP_URL = pathToFileURL(
  fileURLToPath(new URL('../src/input/keyMap.js', import.meta.url)),
).href;
const FRAME_MAP_URL = pathToFileURL(
  fileURLToPath(new URL('../src/input/frameMap.js', import.meta.url)),
).href;
const ECHO_URL = pathToFileURL(
  fileURLToPath(new URL('../src/surfaces/pointerEcho.js', import.meta.url)),
).href;
const VUE_URL = import.meta.resolve('vue');

const SFC_SOURCE = readFileSync(SFC_PATH, 'utf8');
const SCHEDULER_SOURCE = readFileSync(SCHEDULER_PATH, 'utf8');
const LAYOUT_SOURCE = readFileSync(LAYOUT_PATH, 'utf8');
const WALL_CSS_SOURCE = readFileSync(WALL_CSS_PATH, 'utf8');

let moduleSerial = 0;

function toDataUrl(code, label) {
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${label}-${++moduleSerial}`;
}

async function importSchedulerModule(source = SCHEDULER_SOURCE) {
  const rewritten = source
    .replace("'../input/keyMap.js'", JSON.stringify(KEY_MAP_URL))
    .replace("'../input/frameMap.js'", JSON.stringify(FRAME_MAP_URL));
  return import(toDataUrl(rewritten, 'sched-mod'));
}

async function importLayoutModule(source = LAYOUT_SOURCE) {
  const rewritten = source.replace(
    "'../../.kit/capsule-ui-kit/src/workspace/layoutProfile.js'",
    JSON.stringify(LAYOUT_PROFILE_URL),
  );
  return import(toDataUrl(rewritten, 'layout-mod'));
}

async function compileSurfaceCanvasSfc(sfcSource = SFC_SOURCE, schedulerUrl = pathToFileURL(SCHEDULER_PATH).href) {
  const { descriptor } = parse(sfcSource, { filename: 'SurfaceCanvas.vue' });
  const compiled = compileScript(descriptor, {
    id: `geomwire-${++moduleSerial}`,
    inlineTemplate: true,
  });
  let code = compiled.content.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
  code = code.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
    if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(VUE_URL));
    assert.equal(spec, './tileScheduler.js', `Unexpected SFC import: ${spec}`);
    return `const ${bindings.trim()} = await import(${JSON.stringify(schedulerUrl)});`;
  });
  code = code.replace("import('./pointerEcho.js')", `import(${JSON.stringify(ECHO_URL)})`);
  await import(ECHO_URL);
  return (await import(toDataUrl(code, 'geomwire-sfc'))).default;
}

function extractCssRule(css, selector) {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `CSS selector ${selector} must exist`);
  const end = css.indexOf('}', start);
  assert.ok(end > start, `CSS selector ${selector} must close`);
  return css.slice(start + marker.length, end);
}

/**
 * Mounts compiled SurfaceCanvas on a custom renderer whose canvas and strip
 * bounding boxes are computed from the tile geometry rules.
 */
async function mountRenderedTile(Component, {
  wallWidth = 1920,
  wallHeight = 1080,
  capsuleCount = 1,
  frameWidth = 1280,
  frameHeight = 900,
  schedulerMod = { computeTileContentBox },
  withDisplay = true,
} = {}) {
  const box = schedulerMod.computeTileContentBox({
    wallWidth,
    wallHeight,
    capsuleCount,
    frameWidth,
    frameHeight,
  });
  const canvasRect = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: box.width,
    height: box.height,
    right: box.width,
    bottom: box.height,
  };
  const stripRect = {
    x: 0,
    y: box.height,
    left: 0,
    top: box.height,
    width: box.width,
    height: box.stripHeight,
    right: box.width,
    bottom: box.height + box.stripHeight,
  };
  const tileRect = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: box.cellWidth,
    height: box.cellHeight,
    right: box.cellWidth,
    bottom: box.cellHeight,
  };

  const doc = { activeElement: null };
  const canvasEl = {
    tag: 'canvas',
    props: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    parent: /** @type {any} */ (null),
    text: '',
    width: frameWidth > 0 ? frameWidth : DEFAULT_SURFACE_WIDTH,
    height: frameHeight > 0 ? frameHeight : DEFAULT_SURFACE_HEIGHT,
    offsetLeft: 0,
    offsetTop: 0,
    getBoundingClientRect: () => ({ ...canvasRect }),
    getContext: (/** @type {string} */ kind) =>
      kind === '2d'
        ? {
            createImageData: (/** @type {number} */ w, /** @type {number} */ h) => ({
              width: w,
              height: h,
              data: new Uint8ClampedArray(w * h * 4),
            }),
            putImageData: () => {},
          }
        : null,
    focus() {
      if (canvasEl.props.tabindex === 0 || canvasEl.props.tabindex === '0') {
        doc.activeElement = canvasEl;
        canvasEl.props.onFocus?.({ type: 'focus', target: canvasEl });
      }
    },
    blur() {
      if (doc.activeElement === canvasEl) {
        doc.activeElement = null;
        canvasEl.props.onBlur?.({ type: 'blur', target: canvasEl });
      }
    },
  };

  /** @type {Array<{ surfaceId: string, streamId: number, event: any }>} */
  const queuedInput = [];
  const inputPort = Object.freeze({
    available: true,
    send: async () => ({ ok: true, accepted: 0 }),
    queue: (/** @type {string} */ surfaceId, /** @type {number} */ streamId, /** @type {any} */ event) => {
      queuedInput.push({ surfaceId, streamId, event });
    },
    closeGate: () => {},
    onRefusal: () => () => {},
    dispose: () => {},
  });

  const displayRouter = withDisplay ? installDisplayPortRouter({ target: null }) : null;

  const renderer = Vue.createRenderer({
    createElement(tag) {
      if (tag === 'canvas') return canvasEl;
      return {
        tag,
        props: /** @type {Record<string, any>} */ ({}),
        children: /** @type {any[]} */ ([]),
        parent: /** @type {any} */ (null),
        text: '',
        getBoundingClientRect() {
          if (this.props?.class === 'mv-surface__strip' || this.props?.class === 'mv-surface__display-chip') {
            return { ...stripRect };
          }
          return { ...tileRect };
        },
      };
    },
    createText(text) {
      return { tag: '#text', props: {}, children: [], parent: null, text };
    },
    createComment(text) {
      return { tag: '#comment', props: {}, children: [], parent: null, text };
    },
    setText(node, text) {
      node.text = text;
    },
    setElementText(node, text) {
      node.text = text;
      node.children = [];
    },
    insert(child, parent, anchor = null) {
      child.parent = parent;
      const idx = anchor ? parent.children.indexOf(anchor) : -1;
      if (idx === -1) parent.children.push(child);
      else parent.children.splice(idx, 0, child);
    },
    remove(child) {
      if (!child.parent) return;
      const idx = child.parent.children.indexOf(child);
      if (idx !== -1) child.parent.children.splice(idx, 1);
      child.parent = null;
    },
    parentNode(node) {
      return node.parent;
    },
    nextSibling(node) {
      if (!node.parent) return null;
      const idx = node.parent.children.indexOf(node);
      return idx >= 0 && idx + 1 < node.parent.children.length ? node.parent.children[idx + 1] : null;
    },
    patchProp(el, key, _prev, next) {
      if (next === undefined || next === null) delete el.props[key];
      else el.props[key] = next;
    },
  });

  const surfaceId = 'cap-geom-1';
  const Root = {
    setup() {
      Vue.provide('inputPort', inputPort);
      if (displayRouter) Vue.provide('displayPortRouter', displayRouter);
      return () =>
        Vue.h(Component, {
          surfaceId,
          generation: 1,
          epoch: 1,
          frame: 'tile/cap-geom-1/g1/h1',
          digest: 'a'.repeat(64),
          state: 'live',
          frameWidth,
          frameHeight,
          inputEnabled: true,
          streamId: 1,
        });
    },
  };

  const container = { tag: 'root', props: {}, children: /** @type {any[]} */ ([]), parent: null, text: '' };
  const app = renderer.createApp(Root);
  app.mount(container);
  await Vue.nextTick();
  await new Promise((r) => setTimeout(r, 15));

  /** @type {any} */
  let sender = null;
  if (displayRouter) {
    const ch = new MessageChannel();
    sender = createDisplayPort({ port: ch.port1, surfaceId });
    displayRouter.receiveNotice(
      {
        type: DISPLAY_PORT_NOTICE_TYPE,
        schema: DISPLAY_PORT_NOTICE_SCHEMA,
        surface_id: surfaceId,
      },
      [ch.port2],
    );
    sender.postDisplayFrame({
      width: 2,
      height: 2,
      seq: 2,
      captureMonoNs: '1000',
      generation: 1,
      bytes: new Uint8Array(12).fill(0x7f),
    });
    await new Promise((r) => setTimeout(r, 20));
    await Vue.nextTick();
  }

  canvasEl.focus();

  const walk = (/** @type {any} */ node, /** @type {any[]} */ out = []) => {
    out.push(node);
    for (const c of node.children || []) walk(c, out);
    return out;
  };
  const textOf = (/** @type {any} */ node) => {
    if (!node) return '';
    if (node.tag === '#text') return node.text;
    return (node.text || '') + (node.children || []).map(textOf).join('');
  };

  return {
    container,
    canvasEl,
    box,
    canvasRect,
    stripRect,
    tileRect,
    queuedInput,
    findAll: (/** @type {(n: any) => boolean} */ pred) => walk(container).filter(pred),
    textOf,
    dispose() {
      if (sender) sender.close();
      if (displayRouter) displayRouter.dispose();
      app.unmount();
    },
  };
}

/**
 * Guard 1 assertion suite: verifies that a 1280x900 surface yields a tile whose
 * content box aspect is 1280/900 across wall sizes and 1-4 capsules, custom
 * surface Width/Height is respected, no letterbox bands remain, and the
 * DISPLAY chip/footer stays visible.
 */
async function assertTileAspectAndFooter({
  sfcSource = SFC_SOURCE,
  schedulerSource = SCHEDULER_SOURCE,
  layoutSource = LAYOUT_SOURCE,
  wallCssSource = WALL_CSS_SOURCE,
} = {}) {
  const schedUrl = toDataUrl(
    schedulerSource
      .replace("'../input/keyMap.js'", JSON.stringify(KEY_MAP_URL))
      .replace("'../input/frameMap.js'", JSON.stringify(FRAME_MAP_URL)),
    'sched-guard1',
  );
  const schedMod = await import(schedUrl);
  const layoutMod = await importLayoutModule(layoutSource);

  // 1. Default capsule constants and layout grid use 1280x900 (aspect 1280/900), never 16:9 (1280x720).
  assert.equal(schedMod.DEFAULT_SURFACE_WIDTH, 1280);
  assert.equal(schedMod.DEFAULT_SURFACE_HEIGHT, 900);
  assert.equal(layoutMod.DEFAULT_CAPSULE_WIDTH, 1280);
  assert.equal(layoutMod.DEFAULT_CAPSULE_HEIGHT, 900);

  const defaultDims = schedMod.resolveSurfaceDimensions({});
  assert.equal(defaultDims.width, 1280);
  assert.equal(defaultDims.height, 900);
  assert.ok(Math.abs(defaultDims.aspect - 1280 / 900) < 1e-9, `expected 1280/900 aspect, got ${defaultDims.aspect}`);
  assert.equal(defaultDims.aspectRatio, '1280 / 900');

  // 2. Non-default surface Width/Height (and geometry.w/h) is respected, never hardcoded.
  const customDims = schedMod.resolveSurfaceDimensions({ Width: 1600, Height: 1000 });
  assert.equal(customDims.width, 1600);
  assert.equal(customDims.height, 1000);
  assert.ok(Math.abs(customDims.aspect - 1.6) < 1e-9);
  assert.equal(customDims.aspectRatio, '1600 / 1000');

  const geomDims = layoutMod.resolveCapsuleDimensions({ id: 'cap-1', geometry: { w: 1280, h: 900 } });
  assert.equal(geomDims.width, 1280);
  assert.equal(geomDims.height, 900);
  assert.ok(Math.abs(geomDims.aspect - 1280 / 900) < 1e-9);

  // 3. Wall layout grid and 1-4 capsule tile boxes at every wall size yield 1280/900 aspect and zero letterbox bands.
  const wallSizes = [
    [1280, 720],
    [1280, 900],
    [1920, 1080],
    [2560, 1440],
  ];
  for (const count of [1, 2, 3, 4]) {
    const surfaces = Array.from({ length: count }, (_, i) => ({
      id: `cap-${i + 1}`,
      Width: 1280,
      Height: 900,
    }));
    const profile = layoutMod.createWallLayout(SCOPE, surfaces);
    assert.equal(profile.dockview.grid.width, 1280);
    assert.equal(profile.dockview.grid.height, 900);
    assert.ok(
      Math.abs(profile.dockview.grid.width / profile.dockview.grid.height - 1280 / 900) < 1e-9,
      'wall layout grid aspect must be 1280/900, not 16:9',
    );

    for (const [wallWidth, wallHeight] of wallSizes) {
      const tileBox = schedMod.computeTileContentBox({
        wallWidth,
        wallHeight,
        capsuleCount: count,
        Width: 1280,
        Height: 900,
      });
      const wallBox = layoutMod.resolveWallTileBox({
        wallWidth,
        wallHeight,
        capsuleCount: count,
        Width: 1280,
        Height: 900,
      });
      assert.ok(
        Math.abs(tileBox.width / tileBox.height - 1280 / 900) < 1e-6,
        `tile content box aspect at ${wallWidth}x${wallHeight} (${count} capsules) must be 1280/900, got ${tileBox.width / tileBox.height}`,
      );
      assert.ok(
        Math.abs(wallBox.width / wallBox.height - 1280 / 900) < 1e-6,
        `wall tile box aspect at ${wallWidth}x${wallHeight} (${count} capsules) must be 1280/900, got ${wallBox.width / wallBox.height}`,
      );
      const fit = containFit(tileBox.width, tileBox.height, 1280, 900);
      assert.ok(fit);
      assert.ok(Math.abs(fit.offsetX) < 1e-6, `expected zero horizontal letterbox band, got ${fit.offsetX}`);
      assert.ok(Math.abs(fit.offsetY) < 1e-6, `expected zero vertical letterbox band, got ${fit.offsetY}`);
      assert.ok(Math.abs(fit.width - tileBox.width) < 1e-6, 'frame must fill tile content box width');
      assert.ok(Math.abs(fit.height - tileBox.height) < 1e-6, 'frame must fill tile content box height');
      assert.equal(tileBox.stripVisible, true, 'footer strip must remain visible inside the tile');
    }
  }

  // 4. CSS rules in SurfaceCanvas.vue and wall.css constrain the tile canvas/surface to 1280/900 and keep the strip visible.
  const styleBlock = sfcSource.slice(sfcSource.indexOf('<style'));
  const canvasRule = extractCssRule(styleBlock, '.mv-surface__canvas');
  assert.match(canvasRule, /aspect-ratio:\s*1280\s*\/\s*900/, '.mv-surface__canvas must declare aspect-ratio: 1280 / 900');
  const surfaceStripRule = extractCssRule(styleBlock, '.mv-surface:has(> .mv-surface__strip)');
  assert.match(surfaceStripRule, /1280\s*\/\s*900/, '.mv-surface with strip must size to 1280 / 900');
  assert.match(surfaceStripRule, /900\s*\/\s*1280/, '.mv-surface with strip must size height to 900 / 1280 + 23px');
  const stripRule = extractCssRule(styleBlock, '.mv-surface__strip');
  assert.match(stripRule, /flex:\s*0 0 auto/, '.mv-surface__strip must not shrink out of view');
  assert.match(wallCssSource, /container-type:\s*size/, 'wall.css must establish a size container on .mv-tile-capture-host');

  // 5. Mounted SurfaceCanvas renderer test: content box aspect is 1280/900 and DISPLAY chip/footer stays visible.
  const Component = await compileSurfaceCanvasSfc(sfcSource, schedUrl);
  const mounted = await mountRenderedTile(Component, {
    wallWidth: 1920,
    wallHeight: 1080,
    capsuleCount: 1,
    frameWidth: 1280,
    frameHeight: 900,
    schedulerMod: schedMod,
    withDisplay: true,
  });
  try {
    const sections = mounted.findAll((n) => n.tag === 'section' && n.props?.class === 'mv-surface');
    assert.equal(sections.length, 1);
    assert.equal(sections[0].props['data-aspect-ratio'], '1280 / 900');
    const cRect = mounted.canvasEl.getBoundingClientRect();
    assert.ok(
      Math.abs(cRect.width / cRect.height - 1280 / 900) < 1e-6,
      `mounted canvas content box aspect must be 1280/900, got ${cRect.width / cRect.height}`,
    );
    const strips = mounted.findAll((n) => n.props?.class === 'mv-surface__strip');
    assert.equal(strips.length, 1, 'witness footer strip must render');
    const sRect = strips[0].getBoundingClientRect();
    assert.ok(sRect.height >= 22, 'footer strip must have positive visible height');
    assert.ok(sRect.bottom <= mounted.tileRect.bottom + 1e-6, 'footer strip must fit inside tile bounds');
    const chips = mounted.findAll((n) => n.props?.class === 'mv-surface__display-chip');
    assert.equal(chips.length, 1, 'DISPLAY chip must remain rendered and visible in the footer strip');
    assert.equal(mounted.textOf(chips[0]), 'DISPLAY · unverified');
  } finally {
    mounted.dispose();
  }
}

/**
 * Guard 2 assertion suite: verifies pointer coordinates (click, wheel, echo dot)
 * stay exact at the new 1280x900 geometry across 1-4 capsule tiles.
 */
async function assertPointerMappingAtNewGeometry({
  sfcSource = SFC_SOURCE,
  schedulerSource = SCHEDULER_SOURCE,
} = {}) {
  const schedUrl = toDataUrl(
    schedulerSource
      .replace("'../input/keyMap.js'", JSON.stringify(KEY_MAP_URL))
      .replace("'../input/frameMap.js'", JSON.stringify(FRAME_MAP_URL)),
    'sched-guard2',
  );
  const schedMod = await import(schedUrl);
  const Component = await compileSurfaceCanvasSfc(sfcSource, schedUrl);

  for (const capsuleCount of [1, 2, 4]) {
    const mounted = await mountRenderedTile(Component, {
      wallWidth: 1920,
      wallHeight: 1080,
      capsuleCount,
      frameWidth: 1280,
      frameHeight: 900,
      schedulerMod: schedMod,
      withDisplay: false,
    });
    try {
      const rect = mounted.canvasEl.getBoundingClientRect();
      assert.ok(Math.abs(rect.width / rect.height - 1280 / 900) < 1e-6);
      const scaleX = rect.width / 1280;
      const scaleY = rect.height / 900;
      assert.ok(Math.abs(scaleX - scaleY) < 1e-9, 'uniform scale with zero letterbox offset');

      const samplePoints = [
        [0, 0],
        [640, 450],
        [1279, 899],
        [320, 225],
        [960, 675],
      ];

      for (const [fx, fy] of samplePoints) {
        const clientX = rect.left + (fx + 0.5) * scaleX;
        const clientY = rect.top + (fy + 0.5) * scaleY;

        // 1. Click (pointerdown + pointerup) maps to exact (fx, fy)
        mounted.queuedInput.length = 0;
        mounted.canvasEl.props.onPointerdown({
          type: 'pointerdown',
          pointerId: 1,
          button: 0,
          buttons: 1,
          clientX,
          clientY,
          preventDefault() {},
        });
        mounted.canvasEl.props.onPointerup({
          type: 'pointerup',
          pointerId: 1,
          button: 0,
          buttons: 0,
          clientX,
          clientY,
          preventDefault() {},
        });
        await Vue.nextTick();

        assert.equal(mounted.queuedInput.length, 1, `click at (${fx}, ${fy}) must queue one event`);
        assert.deepEqual(
          mounted.queuedInput[0].event,
          { kind: 'click', x: fx, y: fy, button: 'left' },
          `click at (${fx}, ${fy}) must map to exact frame coordinates`,
        );

        // 2. Echo dot (cx, cy) aligns with the clicked point on the canvas
        const circles = mounted.findAll((n) => n.tag === 'circle' && n.props?.class === 'mv-surface__echo-dot');
        assert.equal(circles.length, 1, 'echo dot must render for in-frame click');
        assert.ok(
          Math.abs(circles[0].props.cx - clientX) <= 1 && Math.abs(circles[0].props.cy - clientY) <= 1,
          `echo dot (${circles[0].props.cx}, ${circles[0].props.cy}) must match click (${clientX}, ${clientY})`,
        );

        // 3. Wheel maps to exact (fx, fy)
        mounted.queuedInput.length = 0;
        let wheelPrevented = false;
        mounted.canvasEl.props.onWheel({
          type: 'wheel',
          clientX,
          clientY,
          deltaX: 0,
          deltaY: -120,
          preventDefault() {
            wheelPrevented = true;
          },
        });
        assert.equal(wheelPrevented, true);
        assert.equal(mounted.queuedInput.length, 1);
        assert.deepEqual(
          mounted.queuedInput[0].event,
          { kind: 'scroll', dx: 0, dy: -120, x: fx, y: fy },
          `wheel at (${fx}, ${fy}) must map to exact frame coordinates`,
        );
      }
    } finally {
      mounted.dispose();
    }
  }
}

describe('UI-GEOMETRY-WIRE: capsule browser fills its tile with no letterbox', () => {
  test('Guard 1: 1280x900 surface yields a 1280/900 tile content box across 1-4 capsules and wall sizes with DISPLAY chip visible; 16:9 mutants fail', async () => {
    assert.equal(DEFAULT_SURFACE_WIDTH, 1280);
    assert.equal(DEFAULT_SURFACE_HEIGHT, 900);
    assert.equal(DEFAULT_SURFACE_ASPECT_RATIO, '1280 / 900');
    assert.equal(DEFAULT_CAPSULE_WIDTH, 1280);
    assert.equal(DEFAULT_CAPSULE_HEIGHT, 900);

    // Production passes
    await assertTileAspectAndFooter();

    // Mutant 1a: restore the 16:9 (1280x720) default box in tileScheduler.js
    const mutantScheduler16x9 = SCHEDULER_SOURCE.replace(
      'export const DEFAULT_SURFACE_HEIGHT = 900;',
      'export const DEFAULT_SURFACE_HEIGHT = 720;',
    );
    assert.notEqual(mutantScheduler16x9, SCHEDULER_SOURCE, 'scheduler 16:9 mutant must alter source');
    await assert.rejects(
      () => assertTileAspectAndFooter({ schedulerSource: mutantScheduler16x9 }),
      assert.AssertionError,
      'restoring 16:9 (1280x720) in tileScheduler.js must fail the renderer aspect guard',
    );

    // Mutant 1b: restore the 16:9 (1280x720) grid box in layout.js
    const mutantLayout16x9 = LAYOUT_SOURCE.replace(
      'export const DEFAULT_CAPSULE_HEIGHT = 900;',
      'export const DEFAULT_CAPSULE_HEIGHT = 720;',
    );
    assert.notEqual(mutantLayout16x9, LAYOUT_SOURCE, 'layout 16:9 mutant must alter source');
    await assert.rejects(
      () => assertTileAspectAndFooter({ layoutSource: mutantLayout16x9 }),
      assert.AssertionError,
      'restoring 16:9 (1280x720) in layout.js must fail the wall layout aspect guard',
    );

    // Mutant 1c: restore 16:9 aspect-ratio in SurfaceCanvas.vue CSS
    const mutantSfc16x9 = SFC_SOURCE.replace(
      'aspect-ratio: 1280 / 900;',
      'aspect-ratio: 16 / 9;',
    );
    assert.notEqual(mutantSfc16x9, SFC_SOURCE, 'SFC 16:9 mutant must alter source');
    await assert.rejects(
      () => assertTileAspectAndFooter({ sfcSource: mutantSfc16x9 }),
      assert.AssertionError,
      'restoring 16:9 in SurfaceCanvas.vue must fail the CSS/renderer aspect guard',
    );
  });

  test('Guard 2: pointer coordinates (click, wheel, echo dot) map accurately at the new 1280x900 geometry; off-by-letterbox mutant fails', async () => {
    // Direct frameMap spot-check at 1280x900 aspect
    const box = computeTileContentBox({ wallWidth: 1920, wallHeight: 1080, capsuleCount: 1, Width: 1280, Height: 900 });
    const rect = { left: 100, top: 50, width: box.width, height: box.height };
    assert.deepEqual(
      mapClientToFrame({ clientX: rect.left + 0.1, clientY: rect.top + 0.1, rect, frameWidth: 1280, frameHeight: 900 }),
      { x: 0, y: 0 },
    );

    // Production SFC passes across 1, 2, and 4 capsule tiles
    await assertPointerMappingAtNewGeometry();

    // Mutant 2: introduce an off-by-letterbox offset in SurfaceCanvas.vue clientToFramePoint
    // (simulating a stale 160px horizontal letterbox band from an unconstrained 16:9 box)
    const mutantOffByLetterbox = SFC_SOURCE.replace(
      '      clientX: point.clientX,',
      '      clientX: point.clientX - 160,',
    );
    assert.notEqual(mutantOffByLetterbox, SFC_SOURCE, 'off-by-letterbox mutant must alter SurfaceCanvas.vue');
    await assert.rejects(
      () => assertPointerMappingAtNewGeometry({ sfcSource: mutantOffByLetterbox }),
      assert.AssertionError,
      'off-by-letterbox offset mutant must fail the pointer-mapping guard',
    );
  });
});
