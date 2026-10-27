'use strict';
// W2-FRAME-LIVE-DIAG & W3-E2E25-MULTISLOT: production-path frame delivery
// diagnostics (MV_FRAME_DIAG=1) and end-to-end journey booting the shipped
// ui/electron/main.js + preload.cjs + hostBindings.js + renderer framePortRouter
// against a fixture core publishing live RGB24 frames in /dev/shm, including
// the wall -> multislot -> wall round trip.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { constants: fsConstants } = require('node:fs');
const {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  unlink,
  writeFile,
} = require('node:fs/promises');
const { createConnection, createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const harness = require('./ac-harness.cjs');

const ROOT = resolve(__dirname, '../..');
const UI_ROOT = join(ROOT, 'ui');

function makeRgbFrame(width, height, r, g, b) {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
  }
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { buf, sha256, rgba: [r, g, b, 255] };
}

/**
 * Bounded polling helper with typed E2EError failure messages.
 * @template T
 * @param {() => Promise<T | null | false>} checkFn Returns truthy value when satisfied.
 * @param {{
 *   timeoutMs: number,
 *   intervalMs?: number,
 *   code: string,
 *   describe: () => string,
 *   checkChild?: () => void,
 * }} options
 * @returns {Promise<T>}
 */
async function waitForBounded(checkFn, options) {
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + options.timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (typeof options.checkChild === 'function') {
      options.checkChild();
    }
    try {
      const value = await checkFn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }
  const suffix = lastError ? ` (lastError=${lastError.message || String(lastError)})` : '';
  throw new harness.E2EError(options.code, `${options.describe()}${suffix}`);
}

/**
 * Serialized Electron probe entry that delegates to ui/electron/main.js
 * mainDirectEntry() while exposing a local Unix control socket for bounded
 * DOM/canvas inspection and QA-anchor clicks on the production BrowserWindow.
 * @param {{ uiRoot: string, mainUrl: string, ctlSock: string }} config
 */
async function e2e25ProductionProbe(config) {
  const electron = require('electron');
  const { createServer: createNetServer } = require('node:net');

  process.argv[1] = config.uiRoot;
  electron.app.getAppPath = () => config.uiRoot;

  let mainWindow = null;
  electron.app.on('browser-window-created', (_event, win) => {
    mainWindow = win;
  });

  const ctlServer = createNetServer((conn) => {
    let buf = '';
    conn.on('error', () => {});
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        void (async () => {
          try {
            const cmd = JSON.parse(line);
            if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
              conn.write(`${JSON.stringify({ ok: false, error: 'WINDOW_NOT_READY' })}\n`);
              return;
            }
            const wc = mainWindow.webContents;
            if (cmd.op === 'sampleSlot') {
              const selectorJson = JSON.stringify(String(cmd.selector));
              const result = await wc.executeJavaScript(
                `(() => {
                  const slot = document.querySelector(${selectorJson});
                  const multislotScreen = document.querySelector('.mv-multislot-screen');
                  const openBtn = document.querySelector('[data-semantic-anchor="capsule/open-multislot"]');
                  const backBtn = document.querySelector('[data-semantic-anchor="multislot/back"]');
                  if (!slot) {
                    return {
                      slotExists: false,
                      multislotScreenExists: Boolean(multislotScreen),
                      openMultislotDisabled: openBtn ? Boolean(openBtn.disabled) : true,
                      backButtonExists: Boolean(backBtn),
                    };
                  }
                  const canvas = slot.querySelector('canvas.mv-surface__canvas');
                  let rgba = null;
                  let uniform = false;
                  let nonBlack = false;
                  let width = 0;
                  let height = 0;
                  let canvasHidden = true;
                  if (canvas) {
                    width = canvas.width;
                    height = canvas.height;
                    canvasHidden = Boolean(canvas.hidden);
                    if (width > 0 && height > 0) {
                      const ctx = canvas.getContext('2d');
                      if (ctx) {
                        const data = ctx.getImageData(0, 0, width, height).data;
                        rgba = [data[0], data[1], data[2], data[3]];
                        nonBlack = data[3] === 255 && (data[0] > 0 || data[1] > 0 || data[2] > 0);
                        uniform = true;
                        for (let i = 0; i < data.length; i += 4) {
                          if (
                            data[i] !== rgba[0] ||
                            data[i + 1] !== rgba[1] ||
                            data[i + 2] !== rgba[2] ||
                            data[i + 3] !== rgba[3]
                          ) {
                            uniform = false;
                            break;
                          }
                        }
                      }
                    }
                  }
                  return {
                    slotExists: true,
                    dataState: slot.getAttribute('data-state'),
                    frameHandle: slot.getAttribute('data-frame-handle'),
                    frameDigest: slot.getAttribute('data-frame-digest'),
                    canvasExists: Boolean(canvas),
                    canvasHidden,
                    width,
                    height,
                    rgba,
                    uniform,
                    nonBlack,
                    multislotScreenExists: Boolean(multislotScreen),
                    openMultislotDisabled: openBtn ? Boolean(openBtn.disabled) : true,
                    backButtonExists: Boolean(backBtn),
                  };
                })()`,
                true,
              );
              conn.write(`${JSON.stringify({ ok: true, result })}\n`);
            } else if (cmd.op === 'clickAnchor') {
              const selectorJson = JSON.stringify(String(cmd.selector));
              const result = await wc.executeJavaScript(
                `(() => {
                  const el = document.querySelector(${selectorJson});
                  if (!el) return { clicked: false, reason: 'ELEMENT_NOT_FOUND' };
                  if (el.disabled) return { clicked: false, reason: 'ELEMENT_DISABLED' };
                  el.click();
                  return { clicked: true };
                })()`,
                true,
              );
              conn.write(`${JSON.stringify({ ok: true, result })}\n`);
            } else {
              conn.write(`${JSON.stringify({ ok: false, error: 'UNKNOWN_OP' })}\n`);
            }
          } catch (err) {
            conn.write(`${JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) })}\n`);
          }
        })();
      }
    });
  });
  ctlServer.listen(config.ctlSock);
  ctlServer.unref();

  await import(config.mainUrl);
}

/**
 * Send one JSON command to the probe control socket inside the bounded timeout.
 * @param {string} ctlSock
 * @param {Record<string, unknown>} payload
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
function callProbeControl(ctlSock, payload, timeoutMs = 4000) {
  return new Promise((resolveCall, rejectCall) => {
    const client = createConnection(ctlSock);
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.destroy();
      rejectCall(new harness.E2EError('E2E_PROBE_CTL_TIMEOUT', `probe control socket timed out on ${String(payload.op)}`));
    }, timeoutMs);
    client.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectCall(err);
    });
    client.on('connect', () => {
      client.write(`${JSON.stringify(payload)}\n`);
    });
    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl >= 0 && !settled) {
        settled = true;
        clearTimeout(timer);
        const line = buffer.slice(0, nl);
        client.end();
        try {
          const parsed = JSON.parse(line);
          if (!parsed.ok) {
            rejectCall(new harness.E2EError('E2E_PROBE_CTL', String(parsed.error || 'probe command failed')));
            return;
          }
          resolveCall(parsed.result);
        } catch (err) {
          rejectCall(err);
        }
      }
    });
  });
}

async function runProductionFrameJourney({
  diagEnabled = true,
  multislotRoundTrip = false,
  rotateFrames = false,
} = {}) {
  harness.requireNativeTool('xvfb-run');
  harness.ensureFreshUiDist({ root: ROOT, uiRoot: UI_ROOT });
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
      makeRgbFrame(width, height, 0x12, 0x34, 0x56), // gen 1: wall initial
      makeRgbFrame(width, height, 0x22, 0x88, 0xcc), // gen 2: wall initial
      makeRgbFrame(width, height, 0xee, 0x44, 0x11), // gen 3: wall initial
      makeRgbFrame(width, height, 0x33, 0xbb, 0x66), // gen 4: multislot live 1
      makeRgbFrame(width, height, 0xd4, 0xaa, 0x22), // gen 5: multislot live 2
      makeRgbFrame(width, height, 0x8a, 0x2b, 0xe2), // gen 6: wall after return 1
      makeRgbFrame(width, height, 0x19, 0xc3, 0x7d), // gen 7: wall after return 2 (changing pixels)
    ];
    const framePaths = [];
    const publisherDir = await mkdtemp(join(shmRoot, 'frames-'));
    await chmod(publisherDir, 0o700);
    const retainedRotatingPaths = [];
    const unlinkedRotatingPaths = [];
    const publishRotatingFile = async (genIndex) => {
      const idx = genIndex - 1;
      const name = `${randomBytes(16).toString('hex')}.rgb`;
      const tempPath = join(publisherDir, `${name}.tmp`);
      const finalPath = join(publisherDir, name);
      const fh = await open(
        tempPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await fh.writeFile(frames[idx].buf);
      } finally {
        await fh.close();
      }
      await link(tempPath, finalPath);
      await unlink(tempPath);
      if (retainedRotatingPaths.length >= 2) {
        const expired = retainedRotatingPaths.shift();
        await unlink(expired);
        unlinkedRotatingPaths.push(expired);
      }
      retainedRotatingPaths.push(finalPath);
      framePaths[idx] = finalPath;
      return finalPath;
    };
    if (!rotateFrames) {
      for (let i = 0; i < frames.length; i += 1) {
        const p = join(shmRoot, `frame-${i + 1}.rgb`);
        await writeFile(p, frames[i].buf, { mode: 0o600 });
        await chmod(p, 0o600);
        framePaths.push(p);
      }
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
    let initialFramesSent = 0;
    let publishFrameReady = null;

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
      publishFrameReady = sendFrameReady;

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const env = harness.parseCoreLine(line);
          if (!env) continue;
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
            if (rotateFrames) {
              const tFirst = setTimeout(() => {
                timers.delete(tFirst);
                void publishRotatingFile(1).then(() => {
                  sendFrameReady(1);
                  initialFramesSent = 1;
                });
              }, 300);
              timers.add(tFirst);
            } else {
              const scheduleInitial = (gen, delayMs) => {
                const timer = setTimeout(() => {
                  timers.delete(timer);
                  sendFrameReady(gen);
                  initialFramesSent = gen;
                }, delayMs);
                timers.add(timer);
              };
              scheduleInitial(1, 300);
              scheduleInitial(2, 650);
              scheduleInitial(3, 1000);
            }
          }
        }
      });
    });

    const sockPath = join(mvDir, 'core.sock');
    server.listen(sockPath);
    await once(server, 'listening');
    await chmod(sockPath, 0o600);

    const ctlSock = join(root, 'probe-ctl.sock');
    const probePath = join(root, 'e2e25-probe.cjs');
    const probeConfig = {
      uiRoot: UI_ROOT,
      mainUrl: pathToFileURL(join(UI_ROOT, 'electron/main.js')).href,
      ctlSock,
    };
    await writeFile(
      probePath,
      `'use strict';\n(${e2e25ProductionProbe.toString()})(${JSON.stringify(probeConfig)});\n`,
      { mode: 0o600 },
    );

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

    const launchTarget = multislotRoundTrip || rotateFrames ? probePath : UI_ROOT;
    let spawnError = null;
    child = harness.trackChildProcess(
      spawn(
        'xvfb-run',
        ['-a', electron, launchTarget, `--user-data-dir=${profileDir}`],
        { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
    child.on('error', (err) => {
      if (!spawnError) spawnError = err;
    });

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

    const checkChildAlive = () => {
      if (spawnError) {
        throw new harness.E2EError(
          'E2E_EARLY_EXIT',
          `Electron failed to spawn (${spawnError.message || String(spawnError)}):\n${output}`,
        );
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new harness.E2EError(
          'E2E_EARLY_EXIT',
          `Electron exited early (rc=${child.exitCode}, signal=${child.signalCode}):\n${output}`,
        );
      }
    };

    const diagPath = join(diagDir, 'frame-diag.json');
    const readDiagOrNull = async () => {
      try {
        return JSON.parse(await readFile(diagPath, 'utf8'));
      } catch {
        return null;
      }
    };

    let diag = null;
    let lastObservedDiag = null;
    if (rotateFrames) {
      const wallSlotSelector = `[data-capsule-id="${surfaceId}"] [data-anchor="capsule/${surfaceId}/slot"]`;
      diag = await waitForBounded(
        async () => {
          const parsed = await readDiagOrNull();
          if (parsed) lastObservedDiag = parsed;
          const sample = await callProbeControl(ctlSock, {
            op: 'sampleSlot',
            selector: wallSlotSelector,
          }).catch(() => null);
          if (
            parsed?.main?.deliveriesPosted >= 1 &&
            parsed?.main?.acksReceived >= 1 &&
            sample?.slotExists === true
          ) {
            return parsed;
          }
          return null;
        },
        {
          timeoutMs: 18000,
          intervalMs: 60,
          code: 'E2E_ROTATE_SLOT_READY_TIMEOUT',
          checkChild: checkChildAlive,
          describe: () =>
            `Timed out waiting for wall slot ${wallSlotSelector} to mount (lastDiag=${JSON.stringify(lastObservedDiag)})\n${output}`,
        },
      );
    } else if (diagEnabled) {
      diag = await waitForBounded(
        async () => {
          const parsed = await readDiagOrNull();
          if (parsed) lastObservedDiag = parsed;
          if (
            parsed?.main?.deliveriesPosted >= 3 &&
            parsed?.main?.acksReceived >= 3 &&
            parsed?.preload?.framesReceived >= 3 &&
            parsed?.preload?.domSurfaceState === 'live'
          ) {
            return parsed;
          }
          return null;
        },
        {
          timeoutMs: 18000,
          intervalMs: 60,
          code: 'E2E_DIAG_TIMEOUT',
          checkChild: checkChildAlive,
          describe: () =>
            `Timed out waiting for initial wall live state in frame-diag.json (lastDiag=${JSON.stringify(lastObservedDiag)})\n${output}`,
        },
      );
    } else {
      await waitForBounded(
        async () => mainReady && subscribed && initialFramesSent >= 3,
        {
          timeoutMs: 18000,
          intervalMs: 60,
          code: 'E2E_MAIN_READY_TIMEOUT',
          checkChild: checkChildAlive,
          describe: () =>
            `Timed out waiting for mainReady=${mainReady}, subscribed=${subscribed}, initialFramesSent=${initialFramesSent}\n${output}`,
        },
      );
    }

    let rotationEvidence = null;
    if (rotateFrames) {
      const wallSlotSelector = `[data-capsule-id="${surfaceId}"] [data-anchor="capsule/${surfaceId}/slot"]`;
      const basePresented = diag.main.acksByOutcome.PRESENTED;
      const baseRefused = diag.main.acksByOutcome.REFUSED;
      const sampledGenerations = [];
      for (let gen = 2; gen <= 7; gen += 1) {
        await publishRotatingFile(gen);
        publishFrameReady(gen);
        let lastSample = null;
        const observed = await waitForBounded(
          async () => {
            const currentDiag = await readDiagOrNull();
            if (currentDiag) lastObservedDiag = currentDiag;
            const sample = await callProbeControl(ctlSock, {
              op: 'sampleSlot',
              selector: wallSlotSelector,
            });
            lastSample = sample;
            if (
              currentDiag?.main?.deliveriesPosted >= gen &&
              currentDiag?.main?.acksReceived >= gen &&
              currentDiag?.main?.lastAck?.frameGeneration === gen &&
              currentDiag?.main?.lastAck?.outcome === 'PRESENTED' &&
              sample?.slotExists === true &&
              sample.dataState === 'live' &&
              sample.canvasExists === true &&
              sample.canvasHidden === false &&
              sample.nonBlack === true &&
              sample.uniform === true &&
              Array.isArray(sample.rgba) &&
              sample.rgba.every((v, idx) => v === frames[gen - 1].rgba[idx])
            ) {
              return { diag: currentDiag, rgba: sample.rgba };
            }
            return null;
          },
          {
            timeoutMs: 10000,
            intervalMs: 40,
            code: `E2E_ROTATE_GEN_${gen}`,
            checkChild: checkChildAlive,
            describe: () =>
              `Rotating generation ${gen} did not PRESENT expected pixels ${JSON.stringify(frames[gen - 1].rgba)}: lastSample=${JSON.stringify(lastSample)}, lastDiag=${JSON.stringify(lastObservedDiag?.main)}`,
          },
        );
        sampledGenerations.push({ generation: gen, rgba: observed.rgba });
        diag = observed.diag;
      }
      for (const expiredPath of unlinkedRotatingPaths) {
        await assert.rejects(lstat(expiredPath), { code: 'ENOENT' });
      }
      rotationEvidence = {
        basePresented,
        baseRefused,
        sampledGenerations,
        unlinkedCount: unlinkedRotatingPaths.length,
        retainedCount: retainedRotatingPaths.length,
      };
    }

    let roundTripEvidence = null;
    if (multislotRoundTrip) {
      const wallSlotSelector = `[data-capsule-id="${surfaceId}"] [data-anchor="capsule/${surfaceId}/slot"]`;
      const multislotSlotSelector = `.mv-multislot-screen [data-anchor="capsule/${surfaceId}/slot"]`;
      const openMultislotAnchor = '[data-semantic-anchor="capsule/open-multislot"]';
      const backToWallAnchor = '[data-semantic-anchor="multislot/back"]';

      let lastSample = null;
      const wallInitial = await waitForBounded(
        async () => {
          const currentDiag = await readDiagOrNull();
          if (currentDiag) lastObservedDiag = currentDiag;
          const sample = await callProbeControl(ctlSock, { op: 'sampleSlot', selector: wallSlotSelector });
          lastSample = sample;
          if (
            currentDiag?.main?.deliveriesPosted >= 3 &&
            currentDiag?.main?.acksReceived >= 3 &&
            currentDiag?.main?.lastAck?.frameGeneration === 3 &&
            currentDiag?.main?.lastAck?.outcome === 'PRESENTED' &&
            sample?.slotExists === true &&
            sample.dataState === 'live' &&
            sample.canvasExists === true &&
            sample.canvasHidden === false &&
            sample.nonBlack === true &&
            sample.uniform === true &&
            Array.isArray(sample.rgba) &&
            sample.rgba.every((v, idx) => v === frames[2].rgba[idx]) &&
            sample.openMultislotDisabled === false
          ) {
            return { diag: currentDiag, sample };
          }
          return null;
        },
        {
          timeoutMs: 10000,
          intervalMs: 50,
          code: 'E2E_WALL_INITIAL_PIXELS',
          checkChild: checkChildAlive,
          describe: () =>
            `Initial wall canvas did not paint generation 3 pixels ${JSON.stringify(frames[2].rgba)}: lastSample=${JSON.stringify(lastSample)}, lastDiag=${JSON.stringify(lastObservedDiag?.main)}`,
        },
      );
      const wallInitialSample = wallInitial.sample;
      const basePresented = wallInitial.diag.main.acksByOutcome.PRESENTED;
      const baseRefused = wallInitial.diag.main.acksByOutcome.REFUSED;

      // Step 1: Open the live surface in the multislot using existing QA semantic anchor.
      const openClick = await callProbeControl(ctlSock, { op: 'clickAnchor', selector: openMultislotAnchor });
      if (!openClick?.clicked) {
        throw new harness.E2EError(
          'E2E_MULTISLOT_OPEN_CLICK',
          `Failed to click ${openMultislotAnchor}: ${JSON.stringify(openClick)}`,
        );
      }

      // Wait for the multislot surface slot to mount and repaint the retained non-black frame.
      const multislotMountedSample = await waitForBounded(
        async () => {
          const sample = await callProbeControl(ctlSock, { op: 'sampleSlot', selector: multislotSlotSelector });
          lastSample = sample;
          if (
            sample?.multislotScreenExists === true &&
            sample.slotExists === true &&
            sample.dataState === 'live' &&
            sample.canvasExists === true &&
            sample.canvasHidden === false &&
            sample.nonBlack === true &&
            sample.uniform === true &&
            sample.backButtonExists === true
          ) {
            return sample;
          }
          return null;
        },
        {
          timeoutMs: 10000,
          intervalMs: 50,
          code: 'E2E_MULTISLOT_MOUNT',
          checkChild: checkChildAlive,
          describe: () =>
            `Multislot canvas did not mount in live non-black state: lastSample=${JSON.stringify(lastSample)}`,
        },
      );

      // Step 2: Deliver frames 4 and 5 while in multislot and wait for PRESENTED acks + non-black multislot pixels.
      publishFrameReady(4);
      const multislotGen4 = await waitForBounded(
        async () => {
          const currentDiag = await readDiagOrNull();
          if (currentDiag) lastObservedDiag = currentDiag;
          const sample = await callProbeControl(ctlSock, { op: 'sampleSlot', selector: multislotSlotSelector });
          lastSample = sample;
          if (
            currentDiag?.main?.deliveriesPosted >= 4 &&
            currentDiag?.main?.acksReceived >= 4 &&
            currentDiag?.main?.acksByOutcome?.PRESENTED === basePresented + 1 &&
            currentDiag?.main?.acksByOutcome?.REFUSED === baseRefused &&
            currentDiag?.main?.lastAck?.frameGeneration === 4 &&
            currentDiag?.main?.lastAck?.outcome === 'PRESENTED' &&
            sample?.slotExists === true &&
            sample.dataState === 'live' &&
            sample.canvasHidden === false &&
            sample.nonBlack === true &&
            sample.uniform === true &&
            Array.isArray(sample.rgba) &&
            sample.rgba.every((v, idx) => v === frames[3].rgba[idx])
          ) {
            return { diag: currentDiag, sample };
          }
          return null;
        },
        {
          timeoutMs: 10000,
          intervalMs: 50,
          code: 'E2E_MULTISLOT_PRESENT_GEN4',
          checkChild: checkChildAlive,
          describe: () =>
            `Multislot failed to PRESENT generation 4 (${JSON.stringify(frames[3].rgba)}): lastSample=${JSON.stringify(lastSample)}, lastAck=${JSON.stringify(lastObservedDiag?.main?.lastAck)}, acksByOutcome=${JSON.stringify(lastObservedDiag?.main?.acksByOutcome)}`,
        },
      );

      publishFrameReady(5);
      const multislotGen5 = await waitForBounded(
        async () => {
          const currentDiag = await readDiagOrNull();
          if (currentDiag) lastObservedDiag = currentDiag;
          const sample = await callProbeControl(ctlSock, { op: 'sampleSlot', selector: multislotSlotSelector });
          lastSample = sample;
          if (
            currentDiag?.main?.deliveriesPosted >= 5 &&
            currentDiag?.main?.acksReceived >= 5 &&
            currentDiag?.main?.acksByOutcome?.PRESENTED === basePresented + 2 &&
            currentDiag?.main?.acksByOutcome?.REFUSED === baseRefused &&
            currentDiag?.main?.lastAck?.frameGeneration === 5 &&
            currentDiag?.main?.lastAck?.outcome === 'PRESENTED' &&
            sample?.slotExists === true &&
            sample.dataState === 'live' &&
            sample.canvasHidden === false &&
            sample.nonBlack === true &&
            sample.uniform === true &&
            Array.isArray(sample.rgba) &&
            sample.rgba.every((v, idx) => v === frames[4].rgba[idx])
          ) {
            return { diag: currentDiag, sample };
          }
          return null;
        },
        {
          timeoutMs: 10000,
          intervalMs: 50,
          code: 'E2E_MULTISLOT_PRESENT_GEN5',
          checkChild: checkChildAlive,
          describe: () =>
            `Multislot failed to PRESENT generation 5 (${JSON.stringify(frames[4].rgba)}): lastSample=${JSON.stringify(lastSample)}, lastAck=${JSON.stringify(lastObservedDiag?.main?.lastAck)}, acksByOutcome=${JSON.stringify(lastObservedDiag?.main?.acksByOutcome)}`,
        },
      );

      // Step 3: Return to the wall using existing QA semantic anchor.
      const backClick = await callProbeControl(ctlSock, { op: 'clickAnchor', selector: backToWallAnchor });
      if (!backClick?.clicked) {
        throw new harness.E2EError(
          'E2E_MULTISLOT_BACK_CLICK',
          `Failed to click ${backToWallAnchor}: ${JSON.stringify(backClick)}`,
        );
      }

      // Verify the wall tile remounts immediately in live state with retained non-black pixels from gen 5.
      const wallReturnedRetained = await waitForBounded(
        async () => {
          const sample = await callProbeControl(ctlSock, { op: 'sampleSlot', selector: wallSlotSelector });
          lastSample = sample;
          if (
            sample?.multislotScreenExists === false &&
            sample.slotExists === true &&
            sample.dataState === 'live' &&
            sample.canvasExists === true &&
            sample.canvasHidden === false &&
            sample.nonBlack === true &&
            sample.uniform === true &&
            Array.isArray(sample.rgba) &&
            sample.rgba.every((v, idx) => v === frames[4].rgba[idx])
          ) {
            return sample;
          }
          return null;
        },
        {
          timeoutMs: 10000,
          intervalMs: 50,
          code: 'E2E_WALL_RETURN_RETAINED',
          checkChild: checkChildAlive,
          describe: () =>
            `Wall tile did not restore retained non-black frame after returning from multislot: lastSample=${JSON.stringify(lastSample)}`,
        },
      );

      // Step 4: Deliver frames 6 and 7 after returning to the wall and verify new PRESENTED acks
      // and non-black, changing pixels on the wall canvas within a bounded time.
      publishFrameReady(6);
      const wallReturnGen6 = await waitForBounded(
        async () => {
          const currentDiag = await readDiagOrNull();
          if (currentDiag) lastObservedDiag = currentDiag;
          const sample = await callProbeControl(ctlSock, { op: 'sampleSlot', selector: wallSlotSelector });
          lastSample = sample;
          if (
            currentDiag?.main?.deliveriesPosted >= 6 &&
            currentDiag?.main?.acksReceived >= 6 &&
            currentDiag?.main?.acksByOutcome?.PRESENTED === basePresented + 3 &&
            currentDiag?.main?.acksByOutcome?.REFUSED === baseRefused &&
            currentDiag?.main?.lastAck?.frameGeneration === 6 &&
            currentDiag?.main?.lastAck?.outcome === 'PRESENTED' &&
            sample?.multislotScreenExists === false &&
            sample.slotExists === true &&
            sample.dataState === 'live' &&
            sample.canvasHidden === false &&
            sample.nonBlack === true &&
            sample.uniform === true &&
            Array.isArray(sample.rgba) &&
            sample.rgba.every((v, idx) => v === frames[5].rgba[idx])
          ) {
            return { diag: currentDiag, sample };
          }
          return null;
        },
        {
          timeoutMs: 10000,
          intervalMs: 50,
          code: 'E2E_WALL_RETURN_PRESENT_GEN6',
          checkChild: checkChildAlive,
          describe: () =>
            `Wall tile failed to PRESENT generation 6 (${JSON.stringify(frames[5].rgba)}) after returning from multislot: lastSample=${JSON.stringify(lastSample)}, lastAck=${JSON.stringify(lastObservedDiag?.main?.lastAck)}, acksByOutcome=${JSON.stringify(lastObservedDiag?.main?.acksByOutcome)}`,
        },
      );

      publishFrameReady(7);
      const wallReturnGen7 = await waitForBounded(
        async () => {
          const currentDiag = await readDiagOrNull();
          if (currentDiag) lastObservedDiag = currentDiag;
          const sample = await callProbeControl(ctlSock, { op: 'sampleSlot', selector: wallSlotSelector });
          lastSample = sample;
          if (
            currentDiag?.main?.deliveriesPosted >= 7 &&
            currentDiag?.main?.acksReceived >= 7 &&
            currentDiag?.main?.acksByOutcome?.PRESENTED === basePresented + 4 &&
            currentDiag?.main?.acksByOutcome?.REFUSED === baseRefused &&
            currentDiag?.main?.lastAck?.frameGeneration === 7 &&
            currentDiag?.main?.lastAck?.outcome === 'PRESENTED' &&
            sample?.multislotScreenExists === false &&
            sample.slotExists === true &&
            sample.dataState === 'live' &&
            sample.canvasHidden === false &&
            sample.nonBlack === true &&
            sample.uniform === true &&
            Array.isArray(sample.rgba) &&
            sample.rgba.every((v, idx) => v === frames[6].rgba[idx])
          ) {
            return { diag: currentDiag, sample };
          }
          return null;
        },
        {
          timeoutMs: 10000,
          intervalMs: 50,
          code: 'E2E_WALL_RETURN_PRESENT_GEN7',
          checkChild: checkChildAlive,
          describe: () =>
            `Wall tile failed to PRESENT changing generation 7 (${JSON.stringify(frames[6].rgba)}) after returning from multislot: lastSample=${JSON.stringify(lastSample)}, lastAck=${JSON.stringify(lastObservedDiag?.main?.lastAck)}, acksByOutcome=${JSON.stringify(lastObservedDiag?.main?.acksByOutcome)}`,
        },
      );

      diag = wallReturnGen7.diag;
      roundTripEvidence = {
        basePresented,
        baseRefused,
        wallInitialRgba: wallInitialSample.rgba,
        multislotMountedRgba: multislotMountedSample.rgba,
        multislotGen4Rgba: multislotGen4.sample.rgba,
        multislotGen5Rgba: multislotGen5.sample.rgba,
        wallReturnedRetainedRgba: wallReturnedRetained.rgba,
        wallReturnGen6Rgba: wallReturnGen6.sample.rgba,
        wallReturnGen7Rgba: wallReturnGen7.sample.rgba,
      };
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

    await harness.waitForChildExit(child, stopChild);

    return {
      mainReady,
      subscribed,
      diag,
      diagMode: diagStat ? diagStat.mode & 0o777 : null,
      surfaceId,
      roundTripEvidence,
      rotationEvidence,
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
  assert.equal(diag.main.lastDelivery.surfaceId, surfaceId);
  assert.equal(diag.main.lastDelivery.surfaceGeneration, 1);
  assert.equal(diag.main.lastDelivery.frameGeneration, 3);
  assert.equal(diag.main.lastAck.surfaceId, surfaceId);
  assert.equal(diag.main.lastAck.surfaceGeneration, 1);
  assert.equal(diag.main.lastAck.frameGeneration, 3);
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

test('W2-FRAME-LIVE-DIAG: production renderer keeps tile in live state and PRESENTs frames across generations >= 2', async () => {
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
});

test('W3-E2E25-MULTISLOT: production frames journey proves the multislot round trip (wall -> multislot -> wall)', async () => {
  const { diag, roundTripEvidence } = await runProductionFrameJourney({
    diagEnabled: true,
    multislotRoundTrip: true,
  });
  assert.ok(roundTripEvidence !== null, 'expected roundTripEvidence from multislot round trip');
  assert.deepEqual(roundTripEvidence.wallInitialRgba, [0xee, 0x44, 0x11, 255]);
  assert.deepEqual(roundTripEvidence.multislotGen4Rgba, [0x33, 0xbb, 0x66, 255]);
  assert.deepEqual(roundTripEvidence.multislotGen5Rgba, [0xd4, 0xaa, 0x22, 255]);
  assert.deepEqual(roundTripEvidence.wallReturnedRetainedRgba, [0xd4, 0xaa, 0x22, 255]);
  assert.deepEqual(roundTripEvidence.wallReturnGen6Rgba, [0x8a, 0x2b, 0xe2, 255]);
  assert.deepEqual(roundTripEvidence.wallReturnGen7Rgba, [0x19, 0xc3, 0x7d, 255]);
  assert.notDeepEqual(
    roundTripEvidence.wallReturnGen6Rgba,
    roundTripEvidence.wallReturnGen7Rgba,
    'expected changing non-black pixels on the wall canvas after returning from multislot',
  );
  assert.equal(diag.main.deliveriesPosted, 7);
  assert.equal(diag.main.acksReceived, 7);
  assert.ok(roundTripEvidence.basePresented >= 2, 'expected initial wall frames PRESENTED');
  assert.equal(diag.main.acksByOutcome.PRESENTED, roundTripEvidence.basePresented + 4);
  assert.equal(diag.main.acksByOutcome.REFUSED, roundTripEvidence.baseRefused);
  assert.equal(diag.main.revocationsTotal, 0);
  assert.equal(diag.preload.framesReceived, 7);
});

test('W3-FRAME-ACQUIRE: rotating publisher replaces/rotates frame files across >= 5 consecutive PRESENTED generations with changing pixels', async () => {
  const { diag, rotationEvidence } = await runProductionFrameJourney({
    diagEnabled: true,
    rotateFrames: true,
  });
  assert.ok(rotationEvidence !== null, 'expected rotationEvidence from rotating publisher journey');
  assert.equal(rotationEvidence.sampledGenerations.length, 6);
  assert.equal(rotationEvidence.unlinkedCount, 5);
  assert.equal(rotationEvidence.retainedCount, 2);
  for (let i = 1; i < rotationEvidence.sampledGenerations.length; i += 1) {
    assert.notDeepEqual(
      rotationEvidence.sampledGenerations[i - 1].rgba,
      rotationEvidence.sampledGenerations[i].rgba,
      `expected changing pixels between rotating step ${i} and ${i + 1}`,
    );
  }
  assert.equal(diag.main.deliveriesPosted, 7);
  assert.equal(diag.main.deliveriesRefusedByReader, 0);
  assert.equal(diag.main.deliveriesRefusedByPort, 0);
  assert.equal(diag.main.lastReaderRefusal, null);
  assert.equal(diag.main.acksReceived, 7);
  assert.equal(diag.main.acksByOutcome.PRESENTED, rotationEvidence.basePresented + 6);
  assert.equal(diag.main.acksByOutcome.REFUSED, rotationEvidence.baseRefused);
  assert.equal(diag.main.revocationsTotal, 0);
  assert.equal(diag.preload.framesReceived, 7);
});

