// @ts-check
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  chmodSync,
  symlinkSync,
  unlinkSync,
  rmSync,
  readFileSync,
  constants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as Vue from 'vue';
import { EventEmitter } from 'node:events';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';

import {
  DISPLAY_RING_MAGIC,
  DISPLAY_HEADER_BYTES,
  DISPLAY_FORMATS,
  DISPLAY_READER_REASONS,
  openGuardedRingFile,
  createDisplayReader,
  createDisplayHost,
  displayBaseDir,
  installDisplayBridge,
} from '../electron/displayReader.js';
import {
  DISPLAY_PORT_NOTICE_TYPE,
  DISPLAY_PORT_NOTICE_SCHEMA,
  DISPLAY_DELIVERY_SCHEMA,
  createDisplayPort,
} from '../electron/framePort.js';
import { createPreloadFacade } from '../electron/preload.js';
import {
  installDisplayPortRouter,
  isValidDisplayNotice,
} from '../src/frames/displayPortRouter.js';
import {
  installFramePortRouter,
  FRAME_PORT_NOTICE_TYPE,
  FRAME_PORT_NOTICE_SCHEMA,
} from '../src/frames/framePortRouter.js';
import * as tileSchedulerMod from '../src/surfaces/tileScheduler.js';

const SFC_PATH = fileURLToPath(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url));

/**
 * Create a temporary runtime directory on `/dev/shm` (real tmpfs `0x01021994`).
 * @returns {{ xdgDir: string, mvDir: string, displayDir: string, cleanup: () => void }}
 */
function makeTmpfsRuntimeDir() {
  const xdgDir = join('/dev/shm', `mv-disp-${process.pid}-${randomUUID().slice(0, 8)}`);
  const mvDir = join(xdgDir, 'metaviewer');
  const displayDir = join(mvDir, 'display');
  mkdirSync(xdgDir, { mode: 0o700 });
  chmodSync(xdgDir, 0o700);
  mkdirSync(mvDir, { mode: 0o700 });
  chmodSync(mvDir, 0o700);
  mkdirSync(displayDir, { mode: 0o700 });
  chmodSync(displayDir, 0o700);
  return {
    xdgDir,
    mvDir,
    displayDir,
    cleanup() {
      try {
        rmSync(xdgDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    },
  };
}

/**
 * Build a 64-byte ring header per DISPLAY_RING_SPEC.md.
 * @param {{
 *   width: number,
 *   height: number,
 *   stride?: number,
 *   format?: number,
 *   seq: bigint,
 *   captureMonoNs: bigint,
 *   generation: bigint,
 *   reservedByte?: number
 * }} opts
 * @returns {Buffer}
 */
function buildRingHeader(opts) {
  const format = opts.format ?? DISPLAY_FORMATS.RGB24;
  const bpp = format === DISPLAY_FORMATS.RGB24 ? 3 : 4;
  const stride = opts.stride ?? opts.width * bpp;
  const header = Buffer.alloc(DISPLAY_HEADER_BYTES, 0);
  DISPLAY_RING_MAGIC.copy(header, 0);
  header.writeUInt32LE(opts.width, 8);
  header.writeUInt32LE(opts.height, 12);
  header.writeUInt32LE(stride, 16);
  header.writeUInt32LE(format, 20);
  header.writeBigUInt64LE(opts.seq, 24);
  header.writeBigUInt64LE(opts.captureMonoNs, 32);
  header.writeBigUInt64LE(opts.generation, 40);
  if (opts.reservedByte !== undefined) {
    header[48] = opts.reservedByte;
  }
  return header;
}

/**
 * Create a spec-conformant fake ring writer for `$XDG_RUNTIME_DIR/metaviewer/display/<surfaceId>.ring`.
 * @param {{
 *   displayDir: string,
 *   surfaceId: string,
 *   width: number,
 *   height: number,
 *   format?: number,
 *   stride?: number,
 *   generation?: bigint,
 *   mode?: number
 * }} spec
 */
function createFakeRingWriter(spec) {
  const format = spec.format ?? DISPLAY_FORMATS.RGB24;
  const bpp = format === DISPLAY_FORMATS.RGB24 ? 3 : 4;
  const stride = spec.stride ?? spec.width * bpp;
  const slotBytes = stride * spec.height;
  const totalBytes = DISPLAY_HEADER_BYTES + 2 * slotBytes;
  const ringPath = join(spec.displayDir, `${spec.surfaceId}.ring`);
  const fd = openSync(
    ringPath,
    constants.O_CREAT | constants.O_TRUNC | constants.O_RDWR | constants.O_NOFOLLOW,
    spec.mode ?? 0o600,
  );
  chmodSync(ringPath, spec.mode ?? 0o600);
  const initBuf = Buffer.alloc(totalBytes, 0);
  const initHeader = buildRingHeader({
    width: spec.width,
    height: spec.height,
    stride,
    format,
    seq: 0n,
    captureMonoNs: 0n,
    generation: spec.generation ?? 1n,
  });
  initHeader.copy(initBuf, 0);
  writeSync(fd, initBuf, 0, totalBytes, 0);

  let currentSeq = 0n;
  let currentGen = spec.generation ?? 1n;
  let closed = false;

  return {
    ringPath,
    fd,
    slotBytes,
    totalBytes,
    /**
     * Perform a complete seqlock write (odd seq -> write slot -> even seq).
     * @param {Uint8Array | Buffer} slotPayload
     * @param {bigint} captureMonoNs
     * @param {bigint} [generation]
     */
    writeFrame(slotPayload, captureMonoNs, generation = currentGen) {
      currentGen = generation;
      const oddSeq = currentSeq + 1n;
      const evenSeq = currentSeq + 2n;
      const targetSlot = Number(((oddSeq + 1n) / 2n) % 2n);
      const slotOffset = DISPLAY_HEADER_BYTES + targetSlot * slotBytes;

      const oddHeader = buildRingHeader({
        width: spec.width,
        height: spec.height,
        stride,
        format,
        seq: oddSeq,
        captureMonoNs,
        generation: currentGen,
      });
      writeSync(fd, oddHeader, 0, DISPLAY_HEADER_BYTES, 0);
      writeSync(fd, slotPayload, 0, slotBytes, slotOffset);

      const evenHeader = buildRingHeader({
        width: spec.width,
        height: spec.height,
        stride,
        format,
        seq: evenSeq,
        captureMonoNs,
        generation: currentGen,
      });
      writeSync(fd, evenHeader, 0, DISPLAY_HEADER_BYTES, 0);
      currentSeq = evenSeq;
      return evenSeq;
    },
    /**
     * Leave the ring in an in-progress odd-seq state (simulating a writer mid-frame).
     * @param {bigint} oddSeq
     * @param {bigint} captureMonoNs
     */
    writeOddSeqHeader(oddSeq, captureMonoNs) {
      const oddHeader = buildRingHeader({
        width: spec.width,
        height: spec.height,
        stride,
        format,
        seq: oddSeq,
        captureMonoNs,
        generation: currentGen,
      });
      writeSync(fd, oddHeader, 0, DISPLAY_HEADER_BYTES, 0);
      currentSeq = oddSeq - 1n;
    },
    close() {
      if (!closed) {
        closed = true;
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

let cachedSurfaceCanvasComponent = null;
/**
 * Compile `SurfaceCanvas.vue` in-memory for node:test mounting.
 */
async function loadSurfaceCanvasComponent() {
  if (cachedSurfaceCanvasComponent) return cachedSurfaceCanvasComponent;
  const source = readFileSync(SFC_PATH, 'utf8');
  const { descriptor } = parse(source, { filename: SFC_PATH });
  const compiledScript = compileScript(descriptor, { id: 'disp-test' });
  const compiledTemplate = compileTemplate({
    source: descriptor.template?.content ?? '',
    filename: SFC_PATH,
    id: 'disp-test',
    compilerOptions: { bindingMetadata: compiledScript.bindings },
  });

  const rewriteImports = (code, vueVar, schedVar) =>
    code
      .replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/g, (_, names) => {
        const mapped = names
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s.replace(/\s+as\s+/, ': '));
        return `const { ${mapped.join(', ')} } = ${vueVar};`;
      })
      .replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/tileScheduler\.js['"];?/g, (_, names) => {
        const mapped = names
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s.replace(/\s+as\s+/, ': '));
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
  cachedSurfaceCanvasComponent = factory(Vue, tileSchedulerMod);
  return cachedSurfaceCanvasComponent;
}

/**
 * Mount `SurfaceCanvas.vue` with a minimal custom renderer and fake 2D canvas.
 * @param {Record<string, any>} initialProps
 * @param {{ displayPortRouter?: any, framePortRouter?: any, tileScheduler?: any }} [provides]
 */
async function mountSurfaceCanvasHarness(initialProps, provides = {}) {
  const Component = await loadSurfaceCanvasComponent();
  /** @type {Array<{ width: number, height: number, data: Uint8ClampedArray }>} */
  const paintedImages = [];
  const fakeCanvasEl = {
    width: 0,
    height: 0,
    offsetLeft: 0,
    offsetTop: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
    getContext: (kind) =>
      kind === '2d'
        ? {
            createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
            putImageData: (img) => {
              paintedImages.push({
                width: img.width,
                height: img.height,
                data: new Uint8ClampedArray(img.data),
              });
            },
          }
        : null,
  };

  let nodeId = 0;
  const makeNode = (tag) => ({
    id: ++nodeId,
    tag,
    props: {},
    children: [],
    parent: null,
    text: '',
  });

  const renderer = Vue.createRenderer({
    createElement(tag) {
      const node = makeNode(tag);
      if (tag === 'canvas') {
        Object.assign(node, fakeCanvasEl);
      }
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

  const reactiveProps = Vue.reactive({ ...initialProps });
  const Root = {
    setup() {
      if (provides.tileScheduler !== undefined) Vue.provide('tileScheduler', provides.tileScheduler);
      if (provides.framePortRouter !== undefined) Vue.provide('framePortRouter', provides.framePortRouter);
      if (provides.displayPortRouter !== undefined) Vue.provide('displayPortRouter', provides.displayPortRouter);
      return () => Vue.h(Component, reactiveProps);
    },
  };

  const container = makeNode('root');
  const app = renderer.createApp(Root);
  app.mount(container);
  await Vue.nextTick();

  const walk = (node, out = []) => {
    out.push(node);
    for (const c of node.children || []) walk(c, out);
    return out;
  };
  const textOf = (node) => {
    if (!node) return '';
    if (node.tag === '#text') return node.text;
    return (node.text || '') + (node.children || []).map(textOf).join('');
  };

  return {
    container,
    reactiveProps,
    paintedImages,
    findAll: (pred) => walk(container).filter(pred),
    findByClass: (cls) => walk(container).filter((n) => n.props?.class === cls),
    textOf,
    unmount() {
      app.unmount();
    },
  };
}

describe('DISPLAY-READER-R2: ring security guards, seqlock, 30 fps harness, stale, and VERIFIED isolation', () => {
  test('security guards refuse wrong owner, wrong mode, non-tmpfs, and symlinks', async () => {
    const rt = makeTmpfsRuntimeDir();
    try {
      const writer = createFakeRingWriter({
        displayDir: rt.displayDir,
        surfaceId: 's-guard',
        width: 4,
        height: 4,
      });
      writer.writeFrame(Buffer.alloc(4 * 4 * 3, 0x22), 100n, 1n);
      writer.close();

      // 1. Valid tmpfs ring opens cleanly
      const validOpened = await openGuardedRingFile({
        runtimeDir: rt.xdgDir,
        surfaceId: 's-guard',
      });
      assert.equal(validOpened.ok, true);
      if (validOpened.ok) {
        await validOpened.handle.close();
      }

      // 2. Wrong owner uid is refused with STAT_UID
      const wrongOwner = await openGuardedRingFile({
        runtimeDir: rt.xdgDir,
        surfaceId: 's-guard',
        uid: (process.getuid?.() ?? 1000) + 1,
      });
      assert.deepEqual(wrongOwner, { ok: false, reason: DISPLAY_READER_REASONS.STAT_UID });

      // 3. Wrong file mode (0644 instead of 0600) is refused with STAT_MODE
      chmodSync(writer.ringPath, 0o644);
      const wrongFileMode = await openGuardedRingFile({
        runtimeDir: rt.xdgDir,
        surfaceId: 's-guard',
      });
      assert.deepEqual(wrongFileMode, { ok: false, reason: DISPLAY_READER_REASONS.STAT_MODE });
      chmodSync(writer.ringPath, 0o600);

      // 4. Wrong directory mode (0755 on display dir instead of 0700) is refused with STAT_MODE
      chmodSync(rt.displayDir, 0o755);
      const wrongDirMode = await openGuardedRingFile({
        runtimeDir: rt.xdgDir,
        surfaceId: 's-guard',
      });
      assert.deepEqual(wrongDirMode, { ok: false, reason: DISPLAY_READER_REASONS.STAT_MODE });
      chmodSync(rt.displayDir, 0o700);

      // 5. Symlink ring file is refused with OPEN_SYMLINK
      const symlinkRingPath = join(rt.displayDir, 's-symlink.ring');
      symlinkSync(writer.ringPath, symlinkRingPath);
      const symFileRes = await openGuardedRingFile({
        runtimeDir: rt.xdgDir,
        surfaceId: 's-symlink',
      });
      assert.deepEqual(symFileRes, { ok: false, reason: DISPLAY_READER_REASONS.OPEN_SYMLINK });

      // 6. Symlink parent directory is refused with OPEN_SYMLINK
      const symParentRoot = join('/dev/shm', `mv-symparent-${process.pid}-${randomUUID().slice(0, 8)}`);
      mkdirSync(symParentRoot, { mode: 0o700 });
      chmodSync(symParentRoot, 0o700);
      symlinkSync(rt.mvDir, join(symParentRoot, 'metaviewer'));
      try {
        const symDirRes = await openGuardedRingFile({
          runtimeDir: symParentRoot,
          surfaceId: 's-guard',
        });
        assert.deepEqual(symDirRes, { ok: false, reason: DISPLAY_READER_REASONS.OPEN_SYMLINK });
      } finally {
        rmSync(symParentRoot, { recursive: true, force: true });
      }

      // 7. Non-tmpfs filesystem (real /tmp on ext4) is refused with NOT_TMPFS
      const nonTmpfsRoot = join(tmpdir(), `mv-nontmpfs-${process.pid}-${randomUUID().slice(0, 8)}`);
      const nonTmpfsMv = join(nonTmpfsRoot, 'metaviewer');
      const nonTmpfsDisp = join(nonTmpfsMv, 'display');
      mkdirSync(nonTmpfsRoot, { mode: 0o700 });
      chmodSync(nonTmpfsRoot, 0o700);
      mkdirSync(nonTmpfsMv, { mode: 0o700 });
      chmodSync(nonTmpfsMv, 0o700);
      mkdirSync(nonTmpfsDisp, { mode: 0o700 });
      chmodSync(nonTmpfsDisp, 0o700);
      const nonTmpfsWriter = createFakeRingWriter({
        displayDir: nonTmpfsDisp,
        surfaceId: 's-ext4',
        width: 4,
        height: 4,
      });
      nonTmpfsWriter.writeFrame(Buffer.alloc(4 * 4 * 3, 0x11), 100n, 1n);
      nonTmpfsWriter.close();
      try {
        const nonTmpfsRes = await openGuardedRingFile({
          runtimeDir: nonTmpfsRoot,
          surfaceId: 's-ext4',
          statfsFn: async () => /** @type {any} */ ({ type: 0xef53 }),
        });
        assert.deepEqual(nonTmpfsRes, { ok: false, reason: DISPLAY_READER_REASONS.NOT_TMPFS });
      } finally {
        rmSync(nonTmpfsRoot, { recursive: true, force: true });
      }
    } finally {
      rt.cleanup();
    }
  });

  test('torn read (odd seq or mid-read seq mutation) is never painted', async () => {
    const rt = makeTmpfsRuntimeDir();
    try {
      const width = 4;
      const height = 4;
      const writer = createFakeRingWriter({
        displayDir: rt.displayDir,
        surfaceId: 's-torn',
        width,
        height,
      });

      // 1. Odd seq (writer in progress) -> TORN_SEQ_ODD, never calls onFrame
      writer.writeOddSeqHeader(1n, 500n);
      /** @type {Array<any>} */
      const emittedFrames = [];
      let mutateMidRead = false;

      const reader = createDisplayReader({
        runtimeDir: rt.xdgDir,
        surfaceId: 's-torn',
        onFrame(frame) {
          emittedFrames.push(frame);
        },
        onBeforeHeaderReRead() {
          if (mutateMidRead) {
            // Writer begins next frame mid-read (seq becomes odd 3n)
            writer.writeOddSeqHeader(3n, 1500n);
          }
        },
      });

      const resOdd = await reader.readOnce({ ignoreRateLimit: true });
      assert.deepEqual(resOdd, { ok: false, reason: DISPLAY_READER_REASONS.TORN_SEQ_ODD });
      assert.equal(emittedFrames.length, 0, 'odd seq must never emit a frame');
      assert.equal(reader.getInstrumentation().tornReads, 1);

      // 2. Even seq on initial header read, but writer mutates seq before post-slot header re-read
      const validPixels = Buffer.alloc(width * height * 3, 0x33);
      writer.writeFrame(validPixels, 1000n, 1n);
      mutateMidRead = true;
      const resMidTorn = await reader.readOnce({ ignoreRateLimit: true });
      assert.deepEqual(resMidTorn, { ok: false, reason: DISPLAY_READER_REASONS.TORN_SEQ_CHANGED });
      assert.equal(emittedFrames.length, 0, 'mid-read torn frame must never be painted');
      assert.equal(reader.getInstrumentation().tornReads, 2);

      // 3. Clean frame (seq = 4n) succeeds and emits exact 0x44 bytes
      mutateMidRead = false;
      writer.writeFrame(Buffer.alloc(width * height * 3, 0x44), 2000n, 1n);
      const resClean = await reader.readOnce({ ignoreRateLimit: true });
      assert.equal(resClean.ok, true);
      assert.equal(emittedFrames.length, 1);
      assert.equal(emittedFrames[0].seq, '4');
      assert.equal(emittedFrames[0].bytes[0], 0x44);

      await reader.close();
      writer.close();
    } finally {
      rt.cleanup();
    }
  });

  test('BGRX32 format (format=2) with row stride padding converts accurately to packed RGB24', async () => {
    const rt = makeTmpfsRuntimeDir();
    try {
      const width = 2;
      const height = 2;
      const stride = 12; // 2 pixels * 4 bytes = 8 bytes + 4 bytes row padding
      const writer = createFakeRingWriter({
        displayDir: rt.displayDir,
        surfaceId: 's-bgrx',
        width,
        height,
        format: DISPLAY_FORMATS.BGRX32,
        stride,
      });
      const slotBuf = Buffer.alloc(stride * height, 0xff);
      // Row 0, Pixel 0: B=10, G=20, R=30, X=0
      slotBuf.set([10, 20, 30, 0], 0);
      // Row 0, Pixel 1: B=40, G=50, R=60, X=99
      slotBuf.set([40, 50, 60, 99], 4);
      // Row 1, Pixel 0: B=70, G=80, R=90, X=0
      slotBuf.set([70, 80, 90, 0], stride);
      // Row 1, Pixel 1: B=100, G=110, R=120, X=0
      slotBuf.set([100, 110, 120, 0], stride + 4);

      writer.writeFrame(slotBuf, 2000n, 1n);
      const reader = createDisplayReader({
        runtimeDir: rt.xdgDir,
        surfaceId: 's-bgrx',
      });
      const res = await reader.readOnce({ ignoreRateLimit: true });
      assert.equal(res.ok, true);
      if (res.ok && res.frame) {
        assert.deepEqual(
          Array.from(res.frame.bytes),
          [30, 20, 10, 60, 50, 40, 90, 80, 70, 120, 110, 100],
        );
      }
      await reader.close();
      writer.close();
    } finally {
      rt.cleanup();
    }
  });

  test('spec-conformant fake ring writer driving 30 fps proves >= 25 painted frames/s and <= 30 reads/s', async (t) => {
    const rt = makeTmpfsRuntimeDir();
    try {
      const surfaceId = 's-fps30';
      const width = 16;
      const height = 16;
      const writer = createFakeRingWriter({
        displayDir: rt.displayDir,
        surfaceId,
        width,
        height,
      });

      t.after(() => writer.close());
      // Set up full end-to-end pipeline:
      // createDisplayHost -> installDisplayBridge -> preload -> installDisplayPortRouter -> SurfaceCanvas.vue
      /** @type {Array<(value: any, ports: any[]) => void>} */
      const preloadFrameListeners = [];
      const fakeWindowListeners = new Set();
      const fakeWindow = {
        location: { origin: 'app://metaviewer' },
        addEventListener(type, fn) {
          if (type === 'message') fakeWindowListeners.add(fn);
        },
        removeEventListener(type, fn) {
          if (type === 'message') fakeWindowListeners.delete(fn);
        },
        postMessage(data, origin, transfer) {
          for (const fn of [...fakeWindowListeners]) {
            fn({ data, origin, ports: transfer ?? [] });
          }
        },
      };

      const prevWindow = globalThis.window;
      /** @type {any} */ (globalThis).window = fakeWindow;
      try {
        const preloadFacade = createPreloadFacade({
          transport: {
            subscribe(channel, cb) {
              if (channel === 'metaviewer:authority.frames') {
                preloadFrameListeners.push(cb);
              }
              return () => {};
            },
            invoke: async () => ({ ok: true }),
          },
          bridge: { exposeInMainWorld() {} },
        });
        const unsubPreload = preloadFacade.authority.subscribeFrames(() => {});
        t.after(unsubPreload);

        const displayRouter = installDisplayPortRouter({
          target: fakeWindow,
          expectedOrigin: 'app://metaviewer',
        });

        t.after(() => displayRouter.dispose());
        const mounted = await mountSurfaceCanvasHarness(
          {
            surfaceId,
            generation: 5,
            epoch: 1,
            frame: 'tile/s-fps30/g5/h1',
            digest: 'a'.repeat(64),
            state: 'live',
          },
          { displayPortRouter: displayRouter },
        );

        t.after(() => mounted.unmount());
        const displayHost = createDisplayHost({
          root: rt.xdgDir,
          env: { XDG_RUNTIME_DIR: rt.xdgDir },
        });
        t.after(() => displayHost.dispose());
        const fakeContents = {
          postMessage(channel, message, transfer) {
            if (channel === 'metaviewer:authority.frames') {
              for (const fn of preloadFrameListeners) {
                fn(message, transfer ?? []);
              }
            }
          },
        };
        const ipcMain = new EventEmitter();
        fakeContents.mainFrame = { url: 'app://metaviewer/index.html' };
        const bridge = installDisplayBridge({
          ipcMain,
          contents: fakeContents,
          display: displayHost,
        });

        t.after(() => bridge.dispose());
        ipcMain.emit('metaviewer:display-receiver-ready', { sender: fakeContents, senderFrame: fakeContents.mainFrame });
        // Seed initial frame before activating surface
        const frameBuf = Buffer.alloc(width * height * 3, 1);
        writer.writeFrame(frameBuf, 1_000_000n, 1n);

        displayHost.setSubscribed(true);
        displayHost.updateSurface({
          surface_id: surfaceId,
          state: 'active',
          visibility: 'unfolded',
        });

        // Startup file guards and port transfer are not steady-state paint
        // throughput. Keep the same floor after the first actual presentation.
        const readyDeadline = Date.now() + 5000;
        while (mounted.paintedImages.length === 0 && Date.now() < readyDeadline) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(mounted.paintedImages.length > 0, 'DISPLAY pipeline must present before measurement');
        const paintedAtStart = mounted.paintedImages.length;
        const startMs = Date.now();
        let writerFrameIndex = 1;
        const writerTimer = setInterval(() => {
          writerFrameIndex += 1;
          frameBuf[0] = writerFrameIndex & 0xff;
          const monoNs = BigInt(writerFrameIndex) * 33_333_333n;
          writer.writeFrame(frameBuf, monoNs, 1n);
        }, 31);

        await new Promise((resolve) => setTimeout(resolve, 1060));
        clearInterval(writerTimer);
        const elapsedSec = (Date.now() - startMs) / 1000;

        const paintedTotal = mounted.paintedImages.length - paintedAtStart;
        const paintedFps = paintedTotal / elapsedSec;
        const readerInfo = displayHost.getReaderInstrumentation(surfaceId);
        assert.ok(
          paintedTotal >= 25,
          `expected at least 25 painted frames in ~1 s, measured ${paintedTotal} (${paintedFps.toFixed(1)} fps)`,
        );
        assert.ok(
          readerInfo && readerInfo.readsPerSecond <= 30,
          `readsPerSecond must be capped at <= 30, got ${readerInfo?.readsPerSecond}`,
        );

        // Verify the DISPLAY · unverified chip is rendered and VERIFIED footer stays on GEN: 5
        await Vue.nextTick();
        const chips = mounted.findByClass('mv-surface__display-chip');
        assert.equal(chips.length, 1, 'persistent DISPLAY · unverified chip must be visible');
        assert.equal(mounted.textOf(chips[0]), 'DISPLAY · unverified');

        const strips = mounted.findByClass('mv-surface__strip');
        assert.equal(strips.length, 1);
        const stripText = mounted.textOf(strips[0]);
        assert.ok(stripText.includes('GEN: 5'), `VERIFIED GEN must stay 5, got: ${stripText}`);
        assert.ok(stripText.includes('aaaaaaaa…aaaaaa'), `VERIFIED SHA256 must stay intact, got: ${stripText}`);

        await bridge.dispose();
        await displayHost.dispose();
        displayRouter.dispose();
        unsubPreload();
        mounted.unmount();
      } finally {
        /** @type {any} */ (globalThis).window = prevWindow;
        writer.close();
      }
    } finally {
      rt.cleanup();
    }
  });

  test('stale after 2 s without new display frames, and ring absent falls back to VERIFIED rendering', async () => {
    const rt = makeTmpfsRuntimeDir();
    try {
      const surfaceId = 's-stale';
      const width = 4;
      const height = 4;

      // Part A: Ring absent -> VERIFIED-only rendering unchanged
      const displayRouter = installDisplayPortRouter({
        target: null,
        staleTimeoutMs: 120,
      });
      const mounted = await mountSurfaceCanvasHarness(
        {
          surfaceId,
          generation: 12,
          epoch: 1,
          frame: 'tile/s-stale/g12/h1',
          digest: 'b'.repeat(64),
          state: 'live',
        },
        { displayPortRouter: displayRouter },
      );

      let currentNowMs = 1000;
      /** @type {Array<string>} */
      const readerStates = [];
      /** @type {Array<any>} */
      const readerFrames = [];

      const reader = createDisplayReader({
        runtimeDir: rt.xdgDir,
        surfaceId,
        clock: () => currentNowMs,
        onFrame(frame) {
          readerFrames.push(frame);
        },
        onState(st) {
          readerStates.push(st);
        },
      });
      await reader.readOnce({ ignoreRateLimit: true });

      // Ring file does not exist -> tile has no display chip and stays in VERIFIED live state
      assert.equal(mounted.findByClass('mv-surface__display-chip').length, 0);
      const sectionNode = mounted.findByClass('mv-surface')[0];
      assert.equal(sectionNode.props['data-state'], 'live');
      assert.equal(sectionNode.props['data-display-state'], undefined);

      // Part B: Ring file appears and writes a frame -> transitions to 'active'
      const writer = createFakeRingWriter({
        displayDir: rt.displayDir,
        surfaceId,
        width,
        height,
      });
      writer.writeFrame(Buffer.alloc(width * height * 3, 0x77), 10_000_000n, 1n);

      const ch = new MessageChannel();
      const senderPort = createDisplayPort({
        port: ch.port1,
        surfaceId,
      });
      displayRouter.receiveNotice(
        {
          type: DISPLAY_PORT_NOTICE_TYPE,
          schema: DISPLAY_PORT_NOTICE_SCHEMA,
          surface_id: surfaceId,
        },
        [ch.port2],
      );

      currentNowMs = 1050;
      await reader.readOnce({ ignoreRateLimit: true });
      assert.equal(readerFrames.length, 1);
      assert.deepEqual(readerStates, ['active']);
      senderPort.postDisplayFrame(readerFrames[0]);
      await new Promise((r) => setTimeout(r, 20));
      await Vue.nextTick();

      assert.equal(mounted.findByClass('mv-surface__display-chip').length, 1);
      assert.equal(sectionNode.props['data-state'], 'live');
      assert.equal(sectionNode.props['data-display-state'], 'active');

      // Part C: Advance clock by >= 2000 ms without any new frame -> reader emits 'stale'
      currentNowMs = 3100;
      await reader.readOnce({ ignoreRateLimit: true });
      assert.equal(readerStates.at(-1), 'stale', 'reader must emit stale after 2 s without new frame');
      senderPort.postDisplayState('stale', 1);
      await new Promise((r) => setTimeout(r, 20));
      await Vue.nextTick();

      assert.equal(sectionNode.props['data-state'], 'stale', 'tile section data-state must be stale');
      assert.equal(sectionNode.props['data-display-state'], 'stale', 'tile data-display-state must be stale');
      assert.equal(
        mounted.findByClass('mv-surface__display-chip').length,
        1,
        'DISPLAY · unverified chip stays visible while stale',
      );

      await reader.close();
      senderPort.close();
      displayRouter.dispose();
      mounted.unmount();
      writer.close();
    } finally {
      rt.cleanup();
    }
  });

  test('reopens ring on generation change and on unlink+recreate', async () => {
    const rt = makeTmpfsRuntimeDir();
    try {
      const surfaceId = 's-reopen';
      const width = 4;
      const height = 4;
      let writer = createFakeRingWriter({
        displayDir: rt.displayDir,
        surfaceId,
        width,
        height,
        generation: 1n,
      });
      writer.writeFrame(Buffer.alloc(width * height * 3, 0x10), 100n, 1n);

      /** @type {Array<any>} */
      const frames = [];
      let now = 1000;
      const reader = createDisplayReader({
        runtimeDir: rt.xdgDir,
        surfaceId,
        clock: () => now,
        onFrame: (f) => frames.push(f),
      });

      await reader.readOnce({ ignoreRateLimit: true });
      assert.equal(frames.length, 1);
      assert.equal(frames[0].generation, '1');
      const initialReopens = reader.getInstrumentation().reopens;

      // Change generation in-place to 2n
      now += 40;
      writer.writeFrame(Buffer.alloc(width * height * 3, 0x20), 200n, 2n);
      await reader.readOnce({ ignoreRateLimit: true });
      assert.equal(frames.length, 2);
      assert.equal(frames[1].generation, '2');
      assert.ok(reader.getInstrumentation().reopens > initialReopens, 'must reopen on generation change');

      // Unlink and recreate ring file with generation 3n
      const reopensAfterGen2 = reader.getInstrumentation().reopens;
      writer.close();
      unlinkSync(writer.ringPath);
      writer = createFakeRingWriter({
        displayDir: rt.displayDir,
        surfaceId,
        width,
        height,
        generation: 3n,
      });
      writer.writeFrame(Buffer.alloc(width * height * 3, 0x30), 300n, 3n);
      now += 40;
      await reader.readOnce({ ignoreRateLimit: true });
      assert.equal(frames.length, 3);
      assert.equal(frames[2].generation, '3');
      assert.ok(reader.getInstrumentation().reopens > reopensAfterGen2, 'must reopen on inode change');

      await reader.close();
      writer.close();
    } finally {
      rt.cleanup();
    }
  });

  test('hidden or folded tile stops reading immediately and resumes when unfolded', async () => {
    const rt = makeTmpfsRuntimeDir();
    try {
      const surfaceId = 's-hidden';
      const width = 4;
      const height = 4;
      const writer = createFakeRingWriter({
        displayDir: rt.displayDir,
        surfaceId,
        width,
        height,
      });
      writer.writeFrame(Buffer.alloc(width * height * 3, 0x44), 1000n, 1n);

      const displayHost = createDisplayHost({
        root: rt.xdgDir,
        env: { XDG_RUNTIME_DIR: rt.xdgDir },
      });
      displayHost.setSubscribed(true);
      displayHost.updateSurface({
        surface_id: surfaceId,
        state: 'active',
        visibility: 'unfolded',
      });

      await new Promise((r) => setTimeout(r, 90));
      const statsActive = displayHost.getReaderInstrumentation(surfaceId);
      assert.ok(statsActive && statsActive.readsAttempted >= 1, 'active unfolded tile must read');

      // Fold the tile -> reading must stop
      displayHost.updateSurface({
        surface_id: surfaceId,
        state: 'active',
        visibility: 'folded',
      });
      const statsAtFold = displayHost.getReaderInstrumentation(surfaceId);
      assert.equal(statsAtFold?.visible, false);
      const readsAtFold = statsAtFold?.readsAttempted ?? 0;

      writer.writeFrame(Buffer.alloc(width * height * 3, 0x55), 2000n, 1n);
      await new Promise((r) => setTimeout(r, 100));
      const statsWhileFolded = displayHost.getReaderInstrumentation(surfaceId);
      assert.equal(
        statsWhileFolded?.readsAttempted,
        readsAtFold,
        'folded tile must perform zero reads while folded',
      );

      // Hide the tile -> reading must remain stopped
      displayHost.updateSurface({
        surface_id: surfaceId,
        state: 'active',
        visibility: 'hidden',
      });
      writer.writeFrame(Buffer.alloc(width * height * 3, 0x66), 3000n, 1n);
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(
        displayHost.getReaderInstrumentation(surfaceId)?.readsAttempted,
        readsAtFold,
        'hidden tile must perform zero reads while hidden',
      );

      // Unfold the tile -> reading resumes
      displayHost.updateSurface({
        surface_id: surfaceId,
        state: 'active',
        visibility: 'unfolded',
      });
      writer.writeFrame(Buffer.alloc(width * height * 3, 0x77), 4000n, 1n);
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(
        (displayHost.getReaderInstrumentation(surfaceId)?.readsAttempted ?? 0) > readsAtFold,
        'unfolded tile must resume reading',
      );

      await displayHost.dispose();
      writer.close();
    } finally {
      rt.cleanup();
    }
  });

  test('display frames never reach VERIFIED framePortRouter path (and mutant routing them there fails)', async () => {
    const fakeWindowListeners = new Set();
    const fakeWindow = {
      location: { origin: 'app://metaviewer' },
      addEventListener(type, fn) {
        if (type === 'message') fakeWindowListeners.add(fn);
      },
      removeEventListener(type, fn) {
        if (type === 'message') fakeWindowListeners.delete(fn);
      },
      postMessage(data, origin, transfer) {
        for (const fn of [...fakeWindowListeners]) {
          fn({ data, origin, ports: transfer ?? [] });
        }
      },
    };

    let verifiedRegisteredCalls = 0;
    let verifiedSubmittedFrames = 0;
    const spyScheduler = {
      registerSurface() {
        verifiedRegisteredCalls += 1;
        return { ok: true };
      },
      submitFrame() {
        verifiedSubmittedFrames += 1;
        return { ok: true };
      },
      presentSurfaceNow() {
        return { ok: true };
      },
      attachCanvas() {
        return { ok: true, token: Symbol('canvas') };
      },
      detachCanvas() {},
      getInstrumentation() {
        return null;
      },
    };

    const verifiedRouter = installFramePortRouter({
      target: fakeWindow,
      expectedOrigin: 'app://metaviewer',
    });
    verifiedRouter.bindSurface({
      surfaceId: 's-iso',
      scheduler: /** @type {any} */ (spyScheduler),
      onRegistered() {},
    });

    const displayRouter = installDisplayPortRouter({
      target: fakeWindow,
      expectedOrigin: 'app://metaviewer',
    });
    /** @type {Array<any>} */
    const displayFramesReceived = [];
    displayRouter.bindSurface({
      surfaceId: 's-iso',
      onFrame(f) {
        displayFramesReceived.push(f);
        return true;
      },
    });

    // Send a display port notice and frame through fakeWindow
    const ch = new MessageChannel();
    const senderPort = createDisplayPort({
      port: ch.port1,
      surfaceId: 's-iso',
    });
    fakeWindow.postMessage(
      {
        type: DISPLAY_PORT_NOTICE_TYPE,
        schema: DISPLAY_PORT_NOTICE_SCHEMA,
        surface_id: 's-iso',
      },
      'app://metaviewer',
      [ch.port2],
    );
    senderPort.postDisplayFrame({
      width: 2,
      height: 2,
      seq: 2,
      captureMonoNs: '1000',
      generation: 1,
      bytes: new Uint8Array(2 * 2 * 3).fill(0x99),
    });

    await new Promise((r) => setTimeout(r, 30));

    assert.equal(displayFramesReceived.length, 1, 'display router must receive the display frame');
    assert.equal(verifiedRegisteredCalls, 0, 'VERIFIED scheduler must never register a display stream');
    assert.equal(verifiedSubmittedFrames, 0, 'VERIFIED scheduler must never receive display frames');
    assert.equal(verifiedRouter.getSurfaceStatus('s-iso'), null, 'VERIFIED router must stay untouched');

    // Mutant check: if a defective implementation routes a display notice or display delivery
    // onto the VERIFIED framePortRouter path, our isolation guard and schema checks fail!
    function runIsolationAudit(routeNoticeFn) {
      let mutantEnteredVerified = false;
      const auditTarget = {
        postMessage(notice, _origin, ports) {
          if (
            notice?.type === FRAME_PORT_NOTICE_TYPE ||
            notice?.schema === FRAME_PORT_NOTICE_SCHEMA ||
            !isValidDisplayNotice(notice)
          ) {
            mutantEnteredVerified = true;
          }
          for (const p of ports ?? []) p?.close?.();
        },
      };
      routeNoticeFn(auditTarget);
      if (mutantEnteredVerified) {
        throw new Error('MUTANT_DETECTED: display notice routed to VERIFIED frame-port path');
      }
    }

    // Production notice passes the isolation audit
    runIsolationAudit((target) => {
      target.postMessage(
        {
          type: DISPLAY_PORT_NOTICE_TYPE,
          schema: DISPLAY_PORT_NOTICE_SCHEMA,
          surface_id: 's-iso',
        },
        'app://metaviewer',
        [],
      );
    });

    // Planted mutant: routing display port as FRAME_PORT_NOTICE_TYPE fails the audit
    assert.throws(
      () =>
        runIsolationAudit((target) => {
          target.postMessage(
            {
              type: FRAME_PORT_NOTICE_TYPE,
              schema: FRAME_PORT_NOTICE_SCHEMA,
              surface_id: 's-iso',
              surface_generation: 1,
            },
            'app://metaviewer',
            [],
          );
        }),
      /MUTANT_DETECTED/,
    );

    // Planted mutant 2: sending a display_frame/v1 payload on a VERIFIED framePortRouter stream
    // is refused by the VERIFIED router and never calls submitFrame.
    const mutantCh = new MessageChannel();
    fakeWindow.postMessage(
      {
        type: FRAME_PORT_NOTICE_TYPE,
        schema: FRAME_PORT_NOTICE_SCHEMA,
        surface_id: 's-iso',
        surface_generation: 1,
      },
      'app://metaviewer',
      [mutantCh.port2],
    );
    mutantCh.port1.postMessage({
      schema: DISPLAY_DELIVERY_SCHEMA,
      kind: 'display_frame',
      surfaceId: 's-iso',
      width: 2,
      height: 2,
      format: 'rgb24',
      seq: 2,
      captureMonoNs: '1000',
      generation: 1,
      byteLength: 12,
      bytes: new Uint8Array(12),
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(verifiedSubmittedFrames, 0, 'VERIFIED router must refuse display_frame/v1 payloads');
    mutantCh.port1.close();
    mutantCh.port2.close();

    senderPort.close();
    displayRouter.dispose();
    verifiedRouter.dispose();
  });
});

// The packaged XDG directory may be on ext4. DISPLAY uses its own tmpfs base.
test('DISPLAY base ignores private XDG and honors explicit override', () => {
  const env = { XDG_RUNTIME_DIR: tmpdir() };
  assert.equal(displayBaseDir(env), `/dev/shm/metaviewer-display-${process.getuid()}`);
  assert.equal(displayBaseDir({ ...env, MV_DISPLAY_DIR: '/dev/shm/explicit-display' }), '/dev/shm/explicit-display');
});

test('MV_DISPLAY_TAP=off ignores even a valid old ring', async () => {
  const runtime = makeTmpfsRuntimeDir();
  const writer = createFakeRingWriter({ displayDir: runtime.displayDir, surfaceId: 'disabled', width: 2, height: 1 });
  let channels = 0;
  const host = createDisplayHost({ root: runtime.xdgDir, env: { MV_DISPLAY_TAP: 'off' },
    createDisplayChannel: () => { channels++; throw new Error('disabled channel'); } });
  try {
    host.setSubscribed(true);
    host.updateSurface({ surface_id: 'disabled', state: 'active', visibility: 'unfolded' });
    const diagnostic = console.error;
    console.error = () => { throw new Error('disabled DISPLAY emitted diagnostics'); };
    try { host.notePortPosted('disabled'); } finally { console.error = diagnostic; }
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(host.getReaderInstrumentation('disabled'), null);
    assert.equal(channels, 0);
  } finally { await host.dispose(); writer.close(); runtime.cleanup(); }
});

test('early DISPLAY ports wait for same-origin router readiness and release once', async () => {
  const previous = globalThis.window;
  const events = new Set();
  const forwarded = [];
  let receive;
  const target = {
    location: { origin: 'app://metaviewer' },
    addEventListener(type, callback) { if (type === 'message') events.add(callback); },
    postMessage(...args) { forwarded.push(args); },
  };
  globalThis.window = target;
  try {
    const facade = createPreloadFacade({ bridge: { exposeInMainWorld() {} }, transport: {
      subscribe(_channel, callback) { receive = callback; return () => {}; },
      invoke: async () => true,
    } });
    const stop = facade.authority.subscribeFrames(() => {});
    let closed = 0;
    const old = { close() { closed++; } }, latest = { close() { closed++; } };
    const notice = { schema: 'display_port/v1', surface_id: 'early' };
    receive(notice, [old]);
    receive(notice, [latest]);
    assert.equal(closed, 1, 'replaced pending port closes');
    assert.equal(forwarded.length, 0, 'router is not installed yet');
    const ready = { type: 'metaviewer:display-ready', schema: 'display_ready/v1' };
    for (const callback of events) callback({ origin: 'https://foreign.invalid', data: ready });
    assert.equal(forwarded.length, 0, 'foreign readiness cannot release ports');
    for (const callback of events) callback({ origin: 'app://metaviewer', data: ready });
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0][2][0], latest);
    for (const callback of events) callback({ origin: 'app://metaviewer', data: ready });
    assert.equal(forwarded.length, 1, 'ready repeats cannot transfer a detached port');
    stop();
  } finally { globalThis.window = previous; }
});

test('late tile binding resumes a DISPLAY sender paused by an unbound delivery', async () => {
  const channel = new MessageChannel();
  const visibility = [];
  const sender = createDisplayPort({ port: channel.port1, surfaceId: 'late-tile', onVisibilityChange: value => visibility.push(value) });
  const router = installDisplayPortRouter({ target: null });
  let painted = 0;
  try {
    router.receiveNotice({ type: DISPLAY_PORT_NOTICE_TYPE, schema: DISPLAY_PORT_NOTICE_SCHEMA, surface_id: 'late-tile' }, [channel.port2]);
    const frame = { generation: 1, seq: 2, captureMonoNs: '100', width: 2, height: 1, bytes: new Uint8Array(6) };
    sender.postDisplayFrame(frame);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(visibility.at(-1), false, 'unbound tile pauses the host');
    router.bindSurface({ surfaceId: 'late-tile', onFrame: () => { painted++; return true; } });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(visibility.at(-1), true, 'binding must resume the paused host');
    sender.postDisplayFrame({ ...frame, seq: 4, captureMonoNs: '200' });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(painted, 2, 'retained frame and new live frame both paint');
    router.setSurfaceVisible('late-tile', false);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(visibility.at(-1), false);
    router.setSurfaceVisible('late-tile', true);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(visibility.at(-1), true);
  } finally { sender.close(); router.dispose(); }
});

test('DISPLAY preserves full uint64 generation, seq and capture time from ring to router', async () => {
  const rt = makeTmpfsRuntimeDir();
  const generation = (1n << 64n) - 1n;
  const seq = generation - 1n;
  const writer = createFakeRingWriter({displayDir:rt.displayDir,surfaceId:'u64',width:2,height:1,generation});
  const channel = new MessageChannel();
  const sender = createDisplayPort({port:channel.port1,surfaceId:'u64'});
  const router = installDisplayPortRouter({target:null});
  const painted = [], states = [];
  const reader = createDisplayReader({runtimeDir:rt.xdgDir,surfaceId:'u64',
    onFrame:frame=>sender.postDisplayFrame(frame),onState:(state,gen)=>states.push([state,gen])});
  try {
    router.bindSurface({surfaceId:'u64',onFrame:frame=>{painted.push(frame);return true;}});
    router.receiveNotice({type:DISPLAY_PORT_NOTICE_TYPE,schema:DISPLAY_PORT_NOTICE_SCHEMA,surface_id:'u64'},[channel.port2]);
    writer.writeFrame(Buffer.alloc(6,79),generation,generation);
    const fd = openSync(writer.ringPath,'r+');
    try { const bytes=Buffer.alloc(8);bytes.writeBigUInt64LE(seq);writeSync(fd,bytes,0,8,24); }
    finally { closeSync(fd); }
    await reader.readOnce({ignoreRateLimit:true});
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(painted.length,1);
    assert.equal(painted[0].generation,String(generation));
    assert.equal(painted[0].seq,String(seq));
    assert.equal(painted[0].captureMonoNs,String(generation));
    assert.deepEqual(states,[['active',String(generation)]]);
    assert.equal(reader.getInstrumentation().lastGeneration,String(generation));
    assert.equal(reader.getInstrumentation().lastSeq,String(seq));
  } finally { await reader.close();sender.close();router.dispose();writer.close();rt.cleanup(); }
});


test('DISPLAY main holds early ports until its own top-frame preload receiver is ready', async () => {
  const ipcMain = new EventEmitter();
  const mainFrame = { url: 'app://metaviewer/index.html' };
  const posted = [], diagnostics = [], closed = [];
  let announce;
  let disposed = false;
  const contents = { mainFrame, isDestroyed: () => false,
    postMessage: (...args) => posted.push(args) };
  const display = { subscribePorts: callback => { announce = callback; return () => {}; },
    notePortPosted: (...args) => diagnostics.push(args), dispose: async () => { disposed = true; } };
  const bridge = installDisplayBridge({ contents, ipcMain, display });
  const port = id => ({ close: () => closed.push(id) });
  try {
    announce({ surfaceId: 'resident', port: port('old') });
    announce({ surfaceId: 'resident', port: port('current') });
    assert.deepEqual(closed, ['old']);
    assert.equal(posted.length, 0, 'ports cannot be posted into an unloaded document');
    ipcMain.emit('metaviewer:display-receiver-ready', { sender: {}, senderFrame: mainFrame });
    ipcMain.emit('metaviewer:display-receiver-ready', { sender: contents, senderFrame: { url: mainFrame.url } });
    mainFrame.url = 'https://example.test/';
    ipcMain.emit('metaviewer:display-receiver-ready', { sender: contents, senderFrame: mainFrame });
    assert.equal(posted.length, 0, 'foreign contents, subframes and origins cannot drain ports');
    mainFrame.url = 'app://metaviewer/index.html';
    ipcMain.emit('metaviewer:display-receiver-ready', { sender: contents, senderFrame: mainFrame });
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0][1], { schema: 'display_port/v1', surface_id: 'resident' });
    assert.equal(diagnostics.length, 1);
    ipcMain.emit('metaviewer:display-receiver-ready', { sender: contents, senderFrame: mainFrame });
    assert.equal(posted.length, 1, 'a native port is transferred only once');
    announce({ surfaceId: 'later', port: port('later') });
    assert.equal(posted.length, 2);
  } finally { await bridge.dispose(); }
  assert.equal(disposed, true);
  assert.equal(ipcMain.listenerCount('metaviewer:display-receiver-ready'), 0);
});

test('DISPLAY main bounds and closes ports while preload is absent', async () => {
  let announce;
  let closed = 0;
  const ipcMain = new EventEmitter();
  const display = { subscribePorts: callback => { announce = callback; return () => {}; },
    dispose: async () => {} };
  const bridge = installDisplayBridge({ contents: {}, ipcMain, display });
  for (let i = 0; i < 300; i++) announce({ surfaceId: 'surface-' + i, port: { close: () => { closed++; } } });
  assert.equal(closed, 44);
  await bridge.dispose();
  assert.equal(closed, 300, 'shutdown closes every retained native port');
});

test('retail DISPLAY stages authenticate main-frame IPC, refuse unknown surfaces and log once', async (t) => {
  const lines = [];
  t.mock.method(console,'error',line=>lines.push(line));
  const host = createDisplayHost({root:'/unused',env:{}});
  host.updateSurface({surface_id:'known',state:'active',visibility:'hidden'});
  const ipcMain=new EventEmitter(),mainFrame={url:'app://metaviewer/index.html'};
  const contents={mainFrame};
  const bridge=installDisplayBridge({contents,ipcMain,display:host});
  const event={sender:contents,senderFrame:mainFrame};
  const value={schema:'display_diagnostic/v1',surface_id:'known',stage:'FIRST_FRAME',detail:'OK'};
  try {
    ipcMain.emit('metaviewer:display-diagnostic',{...event,sender:{}},value);
    ipcMain.emit('metaviewer:display-diagnostic',{...event,senderFrame:{...mainFrame}},value);
    mainFrame.url='https://example.test/';
    ipcMain.emit('metaviewer:display-diagnostic',event,value);
    mainFrame.url='app://metaviewer/index.html';
    ipcMain.emit('metaviewer:display-diagnostic',event,{...value,surface_id:'unknown'});
    ipcMain.emit('metaviewer:display-diagnostic',event,{...value,detail:'injected\nline'});
    assert.equal(lines.length,0);
    for(let i=0;i<100;i++) ipcMain.emit('metaviewer:display-diagnostic',event,value);
    assert.deepEqual(lines,['METAVIEWER_DISPLAY_STAGE surface=known stage=FIRST_FRAME detail=OK']);
    ipcMain.emit('metaviewer:display-diagnostic',event,{...value,stage:'FIRST_PAINT'});
    assert.equal(lines.length,2);
  } finally { await bridge.dispose(); }
  assert.equal(ipcMain.listenerCount('metaviewer:display-diagnostic'),0);
  const off=createDisplayHost({root:'/unused',env:{MV_DISPLAY_TAP:'off'}});
  off.updateSurface({surface_id:'known',state:'active'});off.noteStage(value);
  assert.equal(lines.length,2,'tap-off emits no stages');
  await off.dispose();
});

// [TARGET, unit decision] Pull handoffs tolerate early offers and subscription
// gaps; known-surface replacement is bounded and never allocates for strangers.
test('DISPLAY pull replaces lost ports, bounds requests, and parks unbound readers', async () => {
  const rt = makeTmpfsRuntimeDir();
  const writer = createFakeRingWriter({displayDir:rt.displayDir,surfaceId:'pull',width:2,height:1});
  let now = 0;
  const host = createDisplayHost({root:rt.xdgDir,clock:()=>now});
  const router = installDisplayPortRouter({target:null});
  let offered = 0;
  const retired = [];
  host.subscribePorts(({surfaceId,port})=>{
    offered++;
    if (offered === 1) { retired.push(port); return; }
    router.receiveNotice({type:DISPLAY_PORT_NOTICE_TYPE,schema:DISPLAY_PORT_NOTICE_SCHEMA,surface_id:surfaceId},[port]);
  });
  try {
    host.updateSurface({surface_id:'pull',state:'active',visibility:'unfolded'});
    assert.equal(host.requestPort('pull'),false,'before subscription refuses without latching');
    host.setSubscribed(true);
    writer.writeFrame(Buffer.alloc(6,1),1n,1n);
    // The first offer is the one this test loses. Wait for it: a slow filesystem lookup can outlast
    // any sleep, and then the request below would create the first offer and discard it instead.
    for (const deadline = Date.now() + 3000; offered === 0 && Date.now() < deadline;) await new Promise(r=>setTimeout(r,20));
    assert.equal(offered,1,'first offer delivered before the replacement request');
    let painted = 0;
    const unbind = router.bindSurface({surfaceId:'pull',onFrame:()=>{painted++;return true;}});
    assert.equal(host.requestPort('stranger'),false);
    assert.equal(host.requestPort('pull'),true,'a lost first offer must be replaceable');
    assert.equal(host.requestPort('pull'),false,'duplicate burst is bounded');
    writer.writeFrame(Buffer.alloc(6,2),2n,1n);
    // Wait on the state, not the wall clock: under gate load the reader poll and port delivery can exceed 60 ms.
    for (const deadline = Date.now() + 3000; painted === 0 && Date.now() < deadline;) await new Promise(r=>setTimeout(r,20));
    assert.ok(painted>0);
    assert.equal(router.getStats().activeStreams,1);
    now = 250;
    assert.equal(host.requestPort('pull'),true,'later requests replace the sole endpoint');
    writer.writeFrame(Buffer.alloc(6,3),3n,1n);
    await new Promise(r=>setTimeout(r,60));
    unbind();
    await new Promise(r=>setTimeout(r,60));
    const parked = host.getReaderInstrumentation('pull').readsAttempted;
    writer.writeFrame(Buffer.alloc(6,4),4n,1n);
    await new Promise(r=>setTimeout(r,90));
    assert.equal(host.getReaderInstrumentation('pull').visible,false);
    assert.equal(host.getReaderInstrumentation('pull').readsAttempted,parked,'unbind parks all host reads');
  } finally { router.dispose(); for(const p of retired)p.close(); await host.dispose(); writer.close(); rt.cleanup(); }
});

test('DISPLAY pull announces the initial port before a delayed first ring read', async () => {
  const rt = makeTmpfsRuntimeDir();
  const writer = createFakeRingWriter({displayDir:rt.displayDir,surfaceId:'slow-pull',width:2,height:1});
  const opened = Promise.withResolvers();
  const release = Promise.withResolvers();
  const host = createDisplayHost({root:rt.xdgDir,statfs:async () => {
    opened.resolve();
    await release.promise;
    return {type:0x01021994};
  }});
  const ports = [];
  host.subscribePorts(({port}) => ports.push(port));
  try {
    writer.writeFrame(Buffer.alloc(6,7),1n,1n);
    host.updateSurface({surface_id:'slow-pull',state:'active',visibility:'unfolded'});
    host.setSubscribed(true);
    await opened.promise;
    assert.equal(ports.length,1,'initial offer must precede asynchronous ring I/O');
    assert.equal(host.requestPort('slow-pull'),true);
    assert.equal(ports.length,2,'pull must replace the lost initial offer even before the first frame');
  } finally {
    release.resolve();
    for (const port of ports) port.close();
    await host.dispose(); writer.close(); rt.cleanup();
  }
});

test('DISPLAY pull replays a static frame after replacement without refreshing capture liveness', async () => {
  const rt = makeTmpfsRuntimeDir();
  const writer = createFakeRingWriter({displayDir:rt.displayDir,surfaceId:'static-pull',width:2,height:1});
  const timers = new Map();
  let nextTimer = 0, now = 0;
  const host = createDisplayHost({root:rt.xdgDir,clock:()=>now,
    setTimer:cb=>{timers.set(++nextTimer,cb);return nextTimer;},clearTimer:id=>timers.delete(id)});
  const router = installDisplayPortRouter({target:null});
  const firstFrame = Promise.withResolvers();
  const retired = [];
  let offers = 0;
  host.subscribePorts(({surfaceId,port}) => {
    if (++offers === 1) {
      retired.push(port);
      port.addEventListener('message',event=>{
        if (event.data.kind === 'display_frame') firstFrame.resolve(event.data);
      });
      port.start();
    } else router.receiveNotice({type:DISPLAY_PORT_NOTICE_TYPE,schema:DISPLAY_PORT_NOTICE_SCHEMA,surface_id:surfaceId},[port]);
  });
  const painted = [];
  router.bindSurface({surfaceId:'static-pull',onFrame:frame=>{painted.push(frame);return true;}});
  async function poll() {
    // Drain the completed read's finally handler before advancing its fake timer.
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(timers.size,1,'exactly one scheduled reader poll');
    const [id,callback] = [...timers][0]; timers.delete(id); callback();
    // A port message is posted before the next poll is scheduled. Wait for both.
    while (timers.size === 0) await new Promise(resolve=>setImmediate(resolve));
    await new Promise(resolve=>setImmediate(resolve));
  }
  try {
    writer.writeFrame(Buffer.from([1,2,3,4,5,6]),1n,1n);
    host.updateSurface({surface_id:'static-pull',state:'active',visibility:'unfolded'});
    host.setSubscribed(true);
    const original = await firstFrame.promise;
    assert.equal(painted.length,0);
    assert.equal(host.requestPort('static-pull'),true);
    now = 2500;
    await poll();
    assert.equal(painted.length,1,'replacement must paint the unchanged capture');
    assert.equal(painted[0].seq,original.seq);
    assert.equal(painted[0].captureMonoNs,original.captureMonoNs);
    assert.deepEqual(painted[0].bytes,original.bytes);
    assert.equal(host.getReaderInstrumentation('static-pull').state,'stale','replay is not a new capture');
    await poll();
    assert.equal(painted.length,1,'ordinary unchanged polls remain deduplicated');
  } finally {
    router.dispose(); for (const port of retired) port.close();
    await host.dispose(); writer.close(); rt.cleanup();
  }
});

test('DISPLAY router retries bind before subscription; unbind mutant fails', async () => {
  const source = readFileSync(new URL('../src/frames/displayPortRouter.js',import.meta.url),'utf8');
  async function exercise(install) {
    const requests = [], messages = [], timers = new Map();
    let next = 0;
    const router = install({target:{postMessage:value=>requests.push(value),addEventListener(){},removeEventListener(){}},
      setTimeoutFn:cb=>{timers.set(++next,cb);return next;},clearTimeoutFn:id=>timers.delete(id)});
    try {
      router.bindSurface({surfaceId:'early',onFrame:()=>true});
      assert.equal(requests.filter(v=>v.schema==='display_request/v1').length,1);
      assert.ok(timers.size>0,'missing subscription must keep a bounded retry');
      const retry = [...timers.values()][0]; timers.clear();
      await new Promise(r=>setTimeout(r,510)); retry();
      assert.equal(requests.filter(v=>v.schema==='display_request/v1').length,2,'missing subscription retries');
      router.receiveNotice({type:DISPLAY_PORT_NOTICE_TYPE,schema:DISPLAY_PORT_NOTICE_SCHEMA,surface_id:'early'},
        [{postMessage:v=>messages.push(v),addEventListener(){},start(){},close(){}}]);
      assert.equal(timers.size,0,'successful handoff clears retry');
      await new Promise(r=>setTimeout(r,510));
      router.setSurfaceVisible('early',false);
      router.setSurfaceVisible('early',true);
      assert.equal(requests.filter(v=>v.schema==='display_request/v1').length,3,'show requests a fresh port');
      router.unbindSurface('early');
      assert.equal(messages.at(-1).hidden,true,'unbind must send hidden');
    } finally { router.dispose(); }
  }
  await exercise(installDisplayPortRouter);
  const mutant = source.replaceAll('        parkStream(surfaceId);','        /* mutant: omit parking */');
  assert.notEqual(mutant,source);
  const {installDisplayPortRouter:bad} = await import('data:text/javascript;base64,'+Buffer.from(mutant).toString('base64'));
  await assert.rejects(exercise(bad),/unbind must send hidden/);
  for (const [from,to,reason] of [
    ['if (pulls.has(surfaceId)) requestDisplay(surfaceId);','if (false) requestDisplay(surfaceId);',/missing subscription retries/],
    ['if (nextVisible) requestDisplay(surfaceId);','if (false) requestDisplay(surfaceId);',/show requests a fresh port/],
  ]) {
    const mutated=source.replace(from,to); assert.notEqual(mutated,source);
    const {installDisplayPortRouter:negative}=await import('data:text/javascript;base64,'+Buffer.from(mutated).toString('base64'));
    await assert.rejects(exercise(negative),reason);
  }
});


test('DISPLAY pull itself releases pending preload ports if ready was missed', () => {
  const previous=globalThis.window,events=new Set(),forwarded=[],requests=[];
  let receive;
  globalThis.window={location:{origin:'app://metaviewer'},addEventListener(type,fn){if(type==='message')events.add(fn);},postMessage(...args){forwarded.push(args);}};
  try {
    const facade=createPreloadFacade({bridge:{exposeInMainWorld(){}},transport:{
      invoke:async()=>true,subscribe(_channel,cb){receive=cb;return()=>{};},displayRequest:id=>requests.push(id)}});
    const stop=facade.authority.subscribeFrames(()=>{});
    const port={close(){}};
    receive({schema:'display_port/v1',surface_id:'missed'},[port]);
    for(const fn of events)fn({origin:'app://metaviewer',data:{type:'metaviewer:display-request',schema:'display_request/v1',surface_id:'missed'}});
    assert.deepEqual(requests,['missed']);
    assert.equal(forwarded[0][2][0],port,'pull must supersede the one-shot router-ready message');
    stop();
  }finally{globalThis.window=previous;}
});

test('DISPLAY pull authenticates the top frame and supersedes missed native readiness', async () => {
  const ipcMain=new EventEmitter(),requests=[],posted=[];
  const mainFrame={url:'app://metaviewer/index.html'};
  const contents={mainFrame,postMessage:(...args)=>posted.push(args)};
  let offer;
  const bridge=installDisplayBridge({contents,ipcMain,display:{subscribePorts:fn=>{offer=fn;return()=>{};},requestPort:id=>requests.push(id),notePortPosted(){},dispose:async()=>{}}});
  try {
    offer({surfaceId:'known',port:{close(){}}});
    const message={schema:'display_request/v1',surface_id:'known'};
    ipcMain.emit('metaviewer:display-request',{sender:{},senderFrame:mainFrame},message);
    ipcMain.emit('metaviewer:display-request',{sender:contents,senderFrame:{url:mainFrame.url}},message);
    ipcMain.emit('metaviewer:display-request',{sender:contents,senderFrame:mainFrame},{...message,extra:true});
    mainFrame.url='https://foreign.invalid/';
    ipcMain.emit('metaviewer:display-request',{sender:contents,senderFrame:mainFrame},message);
    assert.deepEqual(requests,[]);assert.equal(posted.length,0);
    mainFrame.url='app://metaviewer/index.html';
    ipcMain.emit('metaviewer:display-request',{sender:contents,senderFrame:mainFrame},message);
    assert.deepEqual(requests,['known']);assert.equal(posted.length,1);
  }finally{await bridge.dispose();}
});

test('DISPLAY parks during an awaited seqlock read; immediate-close mutant fails', async () => {
  async function exercise(createReader) {
    const rt=makeTmpfsRuntimeDir();
    const writer=createFakeRingWriter({displayDir:rt.displayDir,surfaceId:'drain',width:2,height:1});
    let delivered=0,reader;
    reader=createReader({runtimeDir:rt.xdgDir,surfaceId:'drain',onFrame:()=>{delivered++;},
      onBeforeHeaderReRead:async()=>{reader.setVisible(false);await Promise.resolve();}});
    try {
      writer.writeFrame(Buffer.alloc(6),1n,1n);
      const result=await reader.readOnce({ignoreRateLimit:true});
      assert.equal(result.reason,DISPLAY_READER_REASONS.HIDDEN);
      assert.equal(delivered,0);
      assert.equal(reader.getInstrumentation().visible,false);
    }finally{await reader.close();writer.close();rt.cleanup();}
  }
  await exercise(createDisplayReader);
  const source=readFileSync(new URL('../electron/displayReader.js',import.meta.url),'utf8');
  const mutant=source.replaceAll('if (!inFlight) void closeHandle();','void closeHandle();');
  assert.notEqual(mutant,source);
  const code=mutant.replace("'./framePort.js'",JSON.stringify(new URL('../electron/framePort.js',import.meta.url).href));
  const {createDisplayReader:negative}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
  await assert.rejects(exercise(negative),/Cannot read properties of null/);
});
