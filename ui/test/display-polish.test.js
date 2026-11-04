// @ts-check
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import * as Vue from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';

import {
  ALLOWED_ADAPTER_ENV,
  createAdapterLauncher,
  scrubAdapterEnv,
} from '../electron/coreLauncher.js';
import {
  DISPLAY_PORT_NOTICE_TYPE,
  DISPLAY_PORT_NOTICE_SCHEMA,
  createDisplayPort,
} from '../electron/framePort.js';
import { installDisplayPortRouter } from '../src/frames/displayPortRouter.js';
import * as tileSchedulerMod from '../src/surfaces/tileScheduler.js';

const CORE_LAUNCHER_PATH = fileURLToPath(
  new URL('../electron/coreLauncher.js', import.meta.url),
);
const SURFACE_CANVAS_PATH = fileURLToPath(
  new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url),
);
const WALL_CSS_PATH = fileURLToPath(
  new URL('../src/wall/wall.css', import.meta.url),
);

function createAdapterSpawnFixture(extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mv-dispolish-'));
  const xdg = mkdtempSync(join(tmpdir(), 'mv-dispolish-xdg-'));
  chmodSync(xdg, 0o700);
  const stateHome = join(root, 'state');
  const srfBinDir = join(root, 'srf-bin');
  const binDir = join(root, 'bin');
  mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  mkdirSync(srfBinDir, { recursive: true, mode: 0o700 });
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const adapterBin = join(binDir, 'mv-daemon-adapter');
  writeFileSync(adapterBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(adapterBin, 0o755);

  const sessionId = 'dispolish-session-1';
  const sessionEventsDir = join(stateHome, 'metaviewer', 'sessions', sessionId, 'events');
  mkdirSync(sessionEventsDir, { recursive: true, mode: 0o700 });

  const env = {
    LANG: 'C.UTF-8',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: root,
    XDG_RUNTIME_DIR: xdg,
    XDG_STATE_HOME: stateHome,
    MV_SESSION_ID: sessionId,
    MV_CORE_INSTANCE: 'core-1',
    MV_DAEMON_INSTANCE: 'daemon-1',
    MV_SRF_BIN_DIR: srfBinDir,
    ...extraEnv,
  };

  return {
    root,
    xdg,
    adapterBin,
    sessionEventsDir,
    env,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    },
  };
}

/**
 * Extract the CSS rule body for a selector from a stylesheet string.
 * @param {string} css
 * @param {string} selector
 * @returns {string}
 */
function extractCssRule(css, selector) {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `CSS selector ${selector} must exist`);
  const end = css.indexOf('}', start);
  assert.ok(end > start, `CSS rule ${selector} must have a closing brace`);
  return css.slice(start + marker.length, end);
}

/**
 * Compile a `SurfaceCanvas.vue` source string into a mountable Vue component.
 * @param {string} source
 */
function compileSurfaceCanvas(source) {
  const { descriptor } = parse(source, { filename: 'SurfaceCanvas.vue' });
  const compiledScript = compileScript(descriptor, { id: 'display-polish-sfc' });
  const compiledTemplate = compileTemplate({
    source: descriptor.template?.content ?? '',
    filename: 'SurfaceCanvas.vue',
    id: 'display-polish-sfc',
    compilerOptions: {
      bindingMetadata: compiledScript.bindings,
    },
  });

  const rewriteImports = (/** @type {string} */ code, /** @type {string} */ vueVar, /** @type {string} */ schedVar) =>
    code
      .replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/g, (_, names) => {
        const mapped = names
          .split(',')
          .map((/** @type {string} */ s) => s.trim())
          .filter(Boolean)
          .map((/** @type {string} */ s) => s.replace(/\s+as\s+/, ': '));
        return `const { ${mapped.join(', ')} } = ${vueVar};`;
      })
      .replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/tileScheduler\.js['"];?/g, (_, names) => {
        const mapped = names
          .split(',')
          .map((/** @type {string} */ s) => s.trim())
          .filter(Boolean)
          .map((/** @type {string} */ s) => s.replace(/\s+as\s+/, ': '));
        return `const { ${mapped.join(', ')} } = ${schedVar};`;
      })
      .replace(/\bimport\s*\([^)]*\)/g, 'Promise.reject(new Error("stub"))');

  const scriptBody = rewriteImports(compiledScript.content, '__vue__', '__sched__').replace(
    /export\s+default\s+/,
    'const __sfc__ = ',
  );
  const templateBody = rewriteImports(compiledTemplate.code, '__vue__', '__sched__').replace(
    /export\s+function\s+render/,
    'function render',
  );
  const factory = new Function(
    '__vue__',
    '__sched__',
    `${scriptBody}\n${templateBody}\n__sfc__.render = render;\nreturn __sfc__;`,
  );
  return factory(Vue, tileSchedulerMod);
}

/**
 * Mount a compiled `SurfaceCanvas` component with an active DISPLAY stream.
 * @param {any} Component
 */
async function mountActiveDisplayCanvas(Component) {
  const displayRouter = installDisplayPortRouter({ target: null });
  let nodeId = 0;
  const makeNode = (/** @type {string} */ tag) => ({
    id: ++nodeId,
    tag,
    props: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    parent: /** @type {any} */ (null),
    text: '',
  });

  const fakeCanvasEl = {
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
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
  };

  const renderer = Vue.createRenderer({
    createElement(tag) {
      const node = makeNode(tag);
      if (tag === 'canvas') Object.assign(node, fakeCanvasEl);
      return node;
    },
    createText(text) {
      const node = makeNode('#text');
      node.text = text;
      return node;
    },
    createComment(text) {
      const node = makeNode('#comment');
      node.text = text;
      return node;
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

  const surfaceId = 's-dispolish';
  const Root = {
    setup() {
      Vue.provide('displayPortRouter', displayRouter);
      return () =>
        Vue.h(Component, {
          surfaceId,
          generation: 3,
          epoch: 1,
          frame: 'tile/s-dispolish/g3/h1',
          digest: 'c'.repeat(64),
          state: 'live',
        });
    },
  };

  const container = makeNode('root');
  const app = renderer.createApp(Root);
  app.mount(container);
  await Vue.nextTick();

  const ch = new MessageChannel();
  const sender = createDisplayPort({ port: ch.port1, surfaceId });
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
    bytes: new Uint8Array(12).fill(0x55),
  });
  await new Promise((r) => setTimeout(r, 25));
  await Vue.nextTick();

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
    findAll: (/** @type {(n: any) => boolean} */ pred) => walk(container).filter(pred),
    textOf,
    dispose() {
      sender.close();
      displayRouter.dispose();
      app.unmount();
    },
  };
}

describe('DISPLAY-POLISH (P12.1): adapter MV_DISPLAY_TAP allowlist and visible DISPLAY chip', () => {
  test('Goal 1: ALLOWED_ADAPTER_ENV and adapter spawn env carry MV_DISPLAY_TAP; dropping it fails', async () => {
    assert.ok(
      ALLOWED_ADAPTER_ENV.includes('MV_DISPLAY_TAP'),
      'ALLOWED_ADAPTER_ENV must include MV_DISPLAY_TAP',
    );

    async function assertAdapterForwardsDisplayTap(launcherMod) {
      const fx = createAdapterSpawnFixture({ MV_DISPLAY_TAP: 'off' });
      try {
        const scrubbed = launcherMod.scrubAdapterEnv(fx.env, fx.xdg);
        assert.equal(
          scrubbed.MV_DISPLAY_TAP,
          'off',
          'scrubAdapterEnv must preserve MV_DISPLAY_TAP=off',
        );

        /** @type {Array<{command: string, args: ReadonlyArray<string>, opts: Record<string, any>}>} */
        const spawned = [];
        const child = Object.assign(new EventEmitter(), {
          pid: 6161,
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
        });
        const launcher = launcherMod.createAdapterLauncher({
          command: fx.adapterBin,
          args: ['--daemon'],
          env: fx.env,
          runtimeDir: fx.xdg,
          selfPid: 100,
          selfPgid: 100,
          spawn: (command, args, opts) => {
            spawned.push({ command, args, opts });
            setImmediate(() => child.stdout.emit('data', 'ADAPTER_HANDSHAKE_OK\n'));
            return child;
          },
          killFn: (_target, sig) => {
            child.emit('exit', 0, sig);
          },
        });

        const status = await launcher.start();
        assert.equal(status.availability, 'live');
        assert.equal(spawned.length, 1);
        assert.equal(
          spawned[0].opts.env.MV_DISPLAY_TAP,
          'off',
          'adapter spawn env must carry MV_DISPLAY_TAP=off',
        );
        await launcher.dispose();
      } finally {
        fx.cleanup();
      }
    }

    // Production module passes
    await assertAdapterForwardsDisplayTap({
      scrubAdapterEnv,
      createAdapterLauncher,
    });

    // Mutant: drop MV_DISPLAY_TAP from ALLOWED_ADAPTER_ENV and verify the test fails
    const source = readFileSync(CORE_LAUNCHER_PATH, 'utf8');
    const mutantSource = source.replace("  'MV_DISPLAY_TAP',\n", '')
      .replace(/(from\s*['"])(\.\/[^'"]+)(['"])/g,
        (_all, before, spec, after) => before + new URL(spec, new URL('../electron/coreLauncher.js', import.meta.url)).href + after);
    assert.notEqual(mutantSource, source, 'mutant must remove MV_DISPLAY_TAP from coreLauncher.js');
    const mutantMod = await import(
      `data:text/javascript;base64,${Buffer.from(mutantSource).toString('base64')}#mutant-core-launcher`
    );
    await assert.rejects(
      () => assertAdapterForwardsDisplayTap(mutantMod),
      /MV_DISPLAY_TAP/,
      'dropping MV_DISPLAY_TAP from ALLOWED_ADAPTER_ENV must fail the spawn env assertion',
    );
  });

  test('Goal 2: DISPLAY chip renders in the footer strip next to FPS/CAP and never shares the top-right corner with .mv-input-chip; mutant fails', async () => {
    const sfcSource = readFileSync(SURFACE_CANVAS_PATH, 'utf8');
    const wallCss = readFileSync(WALL_CSS_PATH, 'utf8');

    const controlChipRule = extractCssRule(wallCss, '.mv-input-chip');
    assert.match(controlChipRule, /position:\s*absolute/, '.mv-input-chip is absolutely positioned');
    assert.match(controlChipRule, /top:\s*var\(--cuk-semantic-spacing-xs\)/, '.mv-input-chip is anchored at top');
    assert.match(controlChipRule, /right:\s*var\(--cuk-semantic-spacing-xs\)/, '.mv-input-chip is anchored at right');

    async function assertChipPlacementAndUncovered(candidateSfcSource) {
      const styleSection = candidateSfcSource.slice(candidateSfcSource.indexOf('<style'));
      const displayChipRule = extractCssRule(styleSection, '.mv-surface__display-chip');

      // Assert CSS placement: the display chip must not share the top-right corner with .mv-input-chip
      const sharesTopRightCorner =
        /position:\s*absolute/.test(displayChipRule) &&
        /\btop\s*:/.test(displayChipRule) &&
        /\bright\s*:/.test(displayChipRule);
      assert.equal(
        sharesTopRightCorner,
        false,
        '.mv-surface__display-chip must not share the top-right corner with .mv-input-chip',
      );

      // Assert DOM structure: rendered inside .mv-surface__strip next to FPS/CAP with exact text & attribute
      const Component = compileSurfaceCanvas(candidateSfcSource);
      const mounted = await mountActiveDisplayCanvas(Component);
      try {
        const chips = mounted.findAll((n) => n.props?.class === 'mv-surface__display-chip');
        assert.equal(chips.length, 1, 'exactly one .mv-surface__display-chip must render when DISPLAY is active');
        const chip = chips[0];
        assert.equal(chip.props['data-display-chip'], 'unverified');
        assert.equal(mounted.textOf(chip), 'DISPLAY · unverified');
        assert.equal(
          chip.parent?.props?.class,
          'mv-surface__strip',
          'DISPLAY chip must live inside the footer .mv-surface__strip next to FPS/CAP',
        );
        const siblingClasses = (chip.parent?.children || []).map((/** @type {any} */ c) => c.props?.class);
        assert.ok(
          siblingClasses.includes('mv-surface__key'),
          'DISPLAY chip must be a sibling of .mv-surface__key items in the footer strip',
        );
      } finally {
        mounted.dispose();
      }
    }

    // Production SurfaceCanvas.vue passes
    await assertChipPlacementAndUncovered(sfcSource);

    // Mutant 1: put .mv-surface__display-chip back in the top-right corner -> fails corner assertion
    const cornerMutant = sfcSource.replace(
      '.mv-surface__display-chip {\n  flex: none;',
      '.mv-surface__display-chip {\n  position: absolute;\n  top: 6px;\n  right: 6px;',
    );
    assert.notEqual(cornerMutant, sfcSource, 'corner mutant must alter SurfaceCanvas.vue');
    await assert.rejects(
      () => assertChipPlacementAndUncovered(cornerMutant),
      /must not share the top-right corner/,
      'top-right corner mutant must fail',
    );

    // Mutant 2: move the chip outside .mv-surface__strip onto the canvas root -> fails parent strip assertion
    const outsideStripMutant = sfcSource
      .replace(
        '      <span v-if="displayActive" class="mv-surface__display-chip" data-display-chip="unverified">DISPLAY · unverified</span>\n',
        '',
      )
      .replace(
        '    <div v-if="showFrozen"',
        '    <span v-if="displayActive" class="mv-surface__display-chip" data-display-chip="unverified">DISPLAY · unverified</span>\n    <div v-if="showFrozen"',
      );
    assert.notEqual(outsideStripMutant, sfcSource, 'outside-strip mutant must alter SurfaceCanvas.vue');
    await assert.rejects(
      () => assertChipPlacementAndUncovered(outsideStripMutant),
      /must live inside the footer \.mv-surface__strip/,
      'outside-strip mutant must fail',
    );
  });
});
