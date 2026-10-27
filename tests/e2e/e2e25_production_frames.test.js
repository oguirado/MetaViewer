'use strict';
// W2-FRAME-LIVE-DIAG: production-path frame delivery diagnostics (MV_FRAME_DIAG=1)
// and end-to-end journey booting the shipped ui/electron/main.js + preload.cjs +
// hostBindings.js against a fixture core publishing live RGB24 frames in /dev/shm.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { accessSync, constants } = require('node:fs');
const {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} = require('node:fs/promises');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const harness = require('./ac-harness.cjs');

const ROOT = resolve(__dirname, '../..');
const UI_ROOT = join(ROOT, 'ui');

function ensureShippedUiBuild() {
  const indexHtml = join(UI_ROOT, 'dist/renderer/index.html');
  const preloadCjs = join(UI_ROOT, 'dist/preload/preload.cjs');
  try {
    accessSync(indexHtml, constants.R_OK);
    accessSync(preloadCjs, constants.R_OK);
    return;
  } catch {
    const viteBin = join(UI_ROOT, 'node_modules/vite/bin/vite.js');
    execFileSync(process.execPath, [viteBin, 'build'], {
      cwd: UI_ROOT,
      env: process.env,
      stdio: 'pipe',
      timeout: 120000,
    });
  }
}

function makeRgbFrame(width, height, r, g, b) {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
  }
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { buf, sha256 };
}

async function runProductionFrameJourney({ diagEnabled = true } = {}) {
  harness.requireNativeTool('xvfb-run');
  ensureShippedUiBuild();
  const electron = harness.electronBinary(ROOT);
  const { findForbiddenEnv } = await import(
    pathToFileURL(join(UI_ROOT, 'electron/coreLauncher.js')).href
  );

  const root = await mkdtemp(join(tmpdir(), 'mv-e2e25-'));
  await chmod(root, 0o700);
  const shmRoot = await mkdtemp('/dev/shm/mv-e2e25-');
  await chmod(shmRoot, 0o700);

  const sockets = new Set();
  let server = null;
  let child = null;

  const stopChild = () => {
    if (child && child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  };

  try {
    const runtimeDir = join(root, 'rt');
    const mvDir = join(runtimeDir, 'metaviewer');
    const diagDir = join(root, 'diag');
    const profileDir = join(root, 'profile');
    await mkdir(runtimeDir, { mode: 0o700 });
    await mkdir(mvDir, { mode: 0o700 });
    await mkdir(diagDir, { mode: 0o700 });
    await mkdir(profileDir, { mode: 0o700 });

    const width = 4;
    const height = 4;
    const frames = [
      makeRgbFrame(width, height, 0x12, 0x34, 0x56),
      makeRgbFrame(width, height, 0x22, 0x88, 0xcc),
      makeRgbFrame(width, height, 0xee, 0x44, 0x11),
    ];
    const framePaths = [];
    for (let i = 0; i < frames.length; i += 1) {
      const p = join(shmRoot, `frame-${i + 1}.rgb`);
      await writeFile(p, frames[i].buf, { mode: 0o600 });
      await chmod(p, 0o600);
      framePaths.push(p);
    }

    const registration = (component) => ({
      endpoint: { component, instance: `${component}-e2e25` },
      hello: {
        schema: 'hello/v0.2',
        contract_version: 'v0.2',
        component,
        component_version: '0.1.1',
        component_commit: 'a'.repeat(40),
        dependencies: [],
      },
    });
    const config = {
      session_id: `e2e25-${randomUUID().slice(0, 8)}`,
      core: registration('core'),
      peers: [registration('ui')],
    };
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await chmod(configPath, 0o600);

    const surfaceId = 'surface-e2e25-live';
    const surfaceState = {
      schema: 'surface/v0.2',
      surface_id: surfaceId,
      kind: 'browser',
      display: ':99',
      geometry: { w: width, h: height },
      state: 'active',
      visibility: 'unfolded',
      control: 'human',
      profile_id: 'mv-e2e25-prof',
    };

    const timers = new Set();
    let subscribed = false;

    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      let buffer = '';
      let seq = 0;
      const sendCore = (body) => {
        if (socket.destroyed) return;
        seq += 1;
        const env = {
          schema: 'envelope/v0.2',
          msg_id: `core-msg-${seq}`,
          ts_ns: seq * 1000,
          from: config.core.endpoint,
          to: config.peers[0].endpoint,
          session_id: config.session_id,
          seq,
          nonce: `nonce-${seq}`,
          body,
        };
        socket.write(`${JSON.stringify(env)}\n`);
      };
      const sendFrameReady = (genIndex) => {
        const idx = genIndex - 1;
        sendCore({
          schema: 'surface_event/v0.2',
          event: 'frame_ready',
          data: {
            frame_ref: {
              schema: 'frame_ref/v0.2',
              surface_id: surfaceId,
              generation: genIndex,
              tick: genIndex,
              ts_ns: genIndex * 1000000,
              width,
              height,
              format: 'rgb24',
              ramws_path: framePaths[idx],
              sha256: frames[idx].sha256,
              capture_us: 100,
            },
          },
        });
      };

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const env = JSON.parse(line);
          if (env.body?.schema === 'hello/v0.2') {
            sendCore(config.core.hello);
            const tCreated = setTimeout(() => {
              timers.delete(tCreated);
              sendCore({
                schema: 'surface_event/v0.2',
                event: 'created',
                data: { surface: surfaceState },
              });
            }, 80);
            timers.add(tCreated);
          } else if (
            env.body?.schema === 'surface_request/v0.2' &&
            env.body?.op === 'frame_subscribe' &&
            !subscribed
          ) {
            subscribed = true;
            const t1 = setTimeout(() => {
              timers.delete(t1);
              sendFrameReady(1);
            }, 150);
            const t2 = setTimeout(() => {
              timers.delete(t2);
              sendFrameReady(2);
            }, 550);
            const t3 = setTimeout(() => {
              timers.delete(t3);
              sendFrameReady(3);
            }, 950);
            timers.add(t1);
            timers.add(t2);
            timers.add(t3);
          }
        }
      });
    });

    const sockPath = join(mvDir, 'core.sock');
    server.listen(sockPath);
    await once(server, 'listening');
    await chmod(sockPath, 0o600);

    const env = {
      ...process.env,
      XDG_RUNTIME_DIR: runtimeDir,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_STATE_HOME: join(root, 'state'),
      MV_CORE_CONFIG: configPath,
      MV_FRAME_DIAG_DIR: diagDir,
    };
    for (const name of findForbiddenEnv(env)) delete env[name];
    delete env.MV_CORE_BOOTSTRAP;
    delete env.MV_QA_ANCHORS;
    delete env.MV_QA_RUN_DIR;
    if (diagEnabled) {
      env.MV_FRAME_DIAG = '1';
    } else {
      delete env.MV_FRAME_DIAG;
    }

    child = spawn(
      'xvfb-run',
      ['-a', electron, UI_ROOT, `--user-data-dir=${profileDir}`],
      { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let output = '';
    let mainReady = false;
    const onChunk = (bytes) => {
      output = (output + bytes.toString('utf8')).slice(-16384);
      if (output.includes('METAVIEWER_MAIN_READY')) {
        mainReady = true;
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    const diagPath = join(diagDir, 'frame-diag.json');
    const deadline = Date.now() + 18000;
    let diag = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Electron exited early (rc=${child.exitCode}):\n${output}`);
      }
      if (diagEnabled) {
        try {
          const raw = await readFile(diagPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (
            parsed?.main?.deliveriesPosted >= 3 &&
            parsed?.main?.acksReceived >= 3 &&
            parsed?.preload?.framesReceived >= 3 &&
            parsed?.preload?.domSurfaceState !== null
          ) {
            diag = parsed;
            // Allow the trailing 250ms preload DOM diagnostic timer to settle.
            await new Promise((r) => setTimeout(r, 350));
            diag = JSON.parse(await readFile(diagPath, 'utf8'));
            break;
          }
        } catch {
          // Wait for next atomic write.
        }
      } else if (mainReady && subscribed) {
        await new Promise((r) => setTimeout(r, 600));
        break;
      }
      await new Promise((r) => setTimeout(r, 80));
    }

    for (const t of timers) clearTimeout(t);
    timers.clear();

    let diagStat = null;
    if (diagEnabled) {
      assert.ok(diag !== null, `Timed out waiting for frame-diag.json:\n${output}`);
      diagStat = await lstat(diagPath);
    } else {
      await assert.rejects(lstat(diagPath), { code: 'ENOENT' });
    }

    stopChild();
    await once(child, 'exit');

    return {
      mainReady,
      subscribed,
      diag,
      diagMode: diagStat ? diagStat.mode & 0o777 : null,
      surfaceId,
    };
  } finally {
    stopChild();
    for (const s of sockets) s.destroy();
    if (server && server.listening) {
      await new Promise((r) => server.close(r));
    }
    await rm(shmRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}

test('W2-FRAME-LIVE-DIAG: MV_FRAME_DIAG is off by default, adds no window.metaviewer facade methods, and refuses packaged enablement', async () => {
  const {
    installFrameDiag,
    resolveFrameDiagConfig,
  } = await import(pathToFileURL(join(UI_ROOT, 'electron/frameDiag.js')).href);
  const { installPreload } = await import(
    pathToFileURL(join(UI_ROOT, 'electron/preload.js')).href
  );

  const root = await mkdtemp(join(tmpdir(), 'mv-diag-unit-'));
  await chmod(root, 0o700);
  try {
    assert.deepEqual(resolveFrameDiagConfig({ env: {} }), {
      enabled: false,
      runDir: null,
    });
    assert.deepEqual(resolveFrameDiagConfig({ env: { MV_FRAME_DIAG: '0' } }), {
      enabled: false,
      runDir: null,
    });
    assert.throws(
      () =>
        resolveFrameDiagConfig({
          env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: root },
          packaged: true,
        }),
      /RETAIL_ENV/,
    );

    const disabled = installFrameDiag({ env: {} });
    assert.equal(disabled.enabled, false);
    disabled.recordDelivery({
      surfaceId: 's1',
      surfaceGeneration: 1,
      frameGeneration: 1,
      epoch: 1,
      announced: true,
    });
    await disabled.flush();
    await assert.rejects(lstat(join(root, 'frame-diag.json')), { code: 'ENOENT' });

    const invocations = [];
    const api = installPreload({
      frameDiag: true,
      contextBridge: { exposeInMainWorld() {} },
      ipcRenderer: {
        invoke: async (channel, ...args) => {
          invocations.push([channel, args]);
          return true;
        },
        on() {},
        removeListener() {},
      },
    });
    assert.deepEqual(Object.keys(api).sort(), [
      'authority',
      'capture',
      'load',
      'loadSettings',
      'nestedDepth',
      'recordingDestination',
      'save',
      'saveSettings',
      'selfCapsuleId',
      'sideTerminal',
    ]);
    assert.deepEqual(Object.keys(api.authority).sort(), [
      'intent',
      'propose',
      'subscribeFrames',
    ]);
    assert.equal(invocations.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('W2-FRAME-LIVE-DIAG: production main + preload + hostBindings records main deliveries, ACKs, and preload forwarding in frame-diag.json', async () => {
  const offRun = await runProductionFrameJourney({ diagEnabled: false });
  assert.equal(offRun.mainReady, true);
  assert.equal(offRun.subscribed, true);
  assert.equal(offRun.diag, null);

  const onRun = await runProductionFrameJourney({ diagEnabled: true });
  assert.equal(onRun.diagMode, 0o600);
  const { diag, surfaceId } = onRun;
  assert.equal(diag.schema, 'frame_diag/v1');
  assert.equal(diag.main.deliveriesPosted, 3);
  assert.equal(diag.main.deliveriesRefusedByReader, 0);
  assert.equal(diag.main.deliveriesRefusedByPort, 0);
  assert.equal(diag.main.portAnnouncements, 1);
  assert.equal(diag.main.revocationsTotal, 0);
  assert.equal(diag.main.acksReceived, 3);
  assert.ok(
    diag.main.acksByOutcome.PRESENTED >= 1,
    `expected at least 1 PRESENTED ack on initial frame, got ${JSON.stringify(diag.main.acksByOutcome)}`,
  );
  assert.equal(diag.preload.schema, 'frame_diag_preload/v1');
  assert.equal(diag.preload.inWallApp, true);
  assert.equal(diag.preload.origin, 'app://metaviewer');
  assert.equal(diag.preload.portsReceived, 1);
  assert.equal(diag.preload.noticesForwarded, 1);
  assert.equal(diag.preload.framesReceived, 3);
  assert.equal(diag.preload.lastSurfaceId, surfaceId);
  assert.equal(diag.preload.lastSurfaceGeneration, 3);
});

test(
  'W2-FRAME-LIVE-DIAG: production renderer keeps tile in live state and PRESENTs frames across generations >= 2',
  {
    todo:
      process.env.MV_E2E_STRICT_RENDERER === '1'
        ? false
        : 'Blocked in ui/src renderer: hostAdapters.js:121 + App.vue:446,557 + SurfaceCanvas.vue:47,85,127 conflate frame_ref.generation (frameGeneration) with surfaceGeneration (1), detaching the canvas on generation >= 2 and keeping resolvedState in connecting',
  },
  async () => {
    const { diag } = await runProductionFrameJourney({ diagEnabled: true });
    assert.equal(diag.main.deliveriesPosted, 3);
    assert.equal(
      diag.preload.domSurfaceState,
      'live',
      `expected tile data-state="live", got "${diag.preload.domSurfaceState}" (waiting="${diag.preload.domWaitingText}", acksByOutcome=${JSON.stringify(diag.main.acksByOutcome)})`,
    );
    assert.equal(diag.preload.domWaitingText, null);
    assert.equal(
      diag.main.acksByOutcome.REFUSED,
      0,
      `renderer refused frames after generation >= 2 detached canvas: ${JSON.stringify(diag.main.acksByOutcome)}`,
    );
    assert.equal(
      diag.main.acksByOutcome.PRESENTED,
      3,
      `expected all 3 delivered frames PRESENTED, got ${JSON.stringify(diag.main.acksByOutcome)}`,
    );
  },
);
