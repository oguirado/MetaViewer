'use strict';
// W3-CONTROL-TIMEOUT (e2e26): boots the real shipped ui/electron/main.js +
// preload.cjs + hostBindings.js + renderer dist against the e2e25 fixture core
// extended to answer take_control / release_control intents while rotating
// RGB24 frames flow continuously at >= 2 fps. Asserts both intents are acked
// within 1 s, journaled by the core, and reflected in the renderer tile state
// without starving behind frame traffic or killing the authority wire.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { constants: fsConstants } = require('node:fs');
const {
  appendFile,
  chmod,
  link,
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
 * @param {() => Promise<T | null | false>} checkFn
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
  const intervalMs = options.intervalMs ?? 30;
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
async function e2e26ProductionProbe(config) {
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
            if (cmd.op === 'sampleControlState') {
              const sidJson = JSON.stringify(String(cmd.surfaceId));
              const result = await wc.executeJavaScript(
                `(() => {
                  const sid = ${sidJson};
                  const slot = document.querySelector('[data-capsule-id="' + sid + '"] [data-anchor="capsule/' + sid + '/slot"]');
                  const tile = slot ? slot.closest('.mv-tile') : document.querySelector('.mv-tile');
                  const controlBtn = document.querySelector(
                    '[data-semantic-anchor="capsule/' + sid + '/control"], [data-anchor="capsule/' + sid + '/control"]',
                  );
                  const activityEl = document.querySelector('.mv-activity');
                  const canvas = slot ? slot.querySelector('canvas.mv-surface__canvas') : null;
                  let nonBlack = false;
                  if (canvas && canvas.width > 0 && canvas.height > 0 && !canvas.hidden) {
                    const ctx = canvas.getContext('2d');
                    if (ctx) {
                      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                      nonBlack = d[3] === 255 && (d[0] > 0 || d[1] > 0 || d[2] > 0);
                    }
                  }
                  return {
                    slotExists: Boolean(slot),
                    dataState: slot ? slot.getAttribute('data-state') : null,
                    frameHandle: slot ? slot.getAttribute('data-frame-handle') : null,
                    tileState: tile ? tile.getAttribute('data-tile-state') : null,
                    controlButtonExists: Boolean(controlBtn),
                    controlButtonDisabled: controlBtn ? Boolean(controlBtn.disabled) : true,
                    activityText: activityEl ? String(activityEl.textContent || '').trim() : '',
                    nonBlack,
                  };
                })()`,
                true,
              );
              conn.write(`${JSON.stringify({ ok: true, result })}\n`);
            } else if (cmd.op === 'clickControl') {
              const sidJson = JSON.stringify(String(cmd.surfaceId));
              const result = await wc.executeJavaScript(
                `(() => {
                  const sid = ${sidJson};
                  const el = document.querySelector(
                    '[data-semantic-anchor="capsule/' + sid + '/control"], [data-anchor="capsule/' + sid + '/control"]',
                  );
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
            conn.write(
              `${JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) })}\n`,
            );
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
      rejectCall(
        new harness.E2EError(
          'E2E_PROBE_CTL_TIMEOUT',
          `probe control socket timed out on ${String(payload.op)}`,
        ),
      );
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
            rejectCall(
              new harness.E2EError('E2E_PROBE_CTL', String(parsed.error || 'probe command failed')),
            );
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

function assertControlWithFramesAudit(evidence) {
  assert.equal(typeof evidence, 'object');
  assert.ok(
    evidence.fps >= 2,
    `expected frames flowing at >= 2 fps during control journey, got ${evidence.fps} fps`,
  );
  assert.ok(
    evidence.takeAckMs > 0 && evidence.takeAckMs < 1000,
    `take_control must be acked within 1000 ms while frames flow, got ${evidence.takeAckMs} ms`,
  );
  assert.ok(
    evidence.releaseAckMs > 0 && evidence.releaseAckMs < 1000,
    `release_control must be acked within 1000 ms while frames flow, got ${evidence.releaseAckMs} ms`,
  );
  assert.equal(evidence.tileStateBeforeTake, 'agent-acting');
  assert.equal(evidence.tileStateAfterTake, 'human-control');
  assert.equal(evidence.tileStateSustainedUnderHumanControl, 'human-control');
  assert.equal(evidence.tileStateAfterRelease, 'agent-acting');
  assert.equal(evidence.activityErrorSeen, false, 'Activity strip must not report request unavailable');
  assert.ok(
    Number.isInteger(evidence.presentedDuringTake) &&
      evidence.presentedDuringTake >= evidence.presentedBeforeTake + 2,
    `expected >= 2 PRESENTED frames while holding human-control (${evidence.presentedBeforeTake} -> ${evidence.presentedDuringTake})`,
  );
  assert.ok(
    Number.isInteger(evidence.presentedAtRelease) &&
      evidence.presentedAtRelease >= evidence.presentedDuringTake,
    `expected monotonic presentedAtRelease baseline (${evidence.presentedDuringTake} -> ${evidence.presentedAtRelease})`,
  );
  assert.ok(
    evidence.presentedAfterRelease >= evidence.presentedAtRelease + 1 &&
      evidence.presentedAfterRelease > evidence.presentedBeforeTake + 2,
    `expected >= 1 new PRESENTED frame after release_control (${evidence.presentedBeforeTake} -> ${evidence.presentedAtRelease} -> ${evidence.presentedAfterRelease})`,
  );
  assert.equal(evidence.readerRefusals, 0);
  assert.equal(evidence.portRefusals, 0);
  assert.equal(evidence.revocations, 0);
  assert.ok(evidence.stateOnlyPosted >= 2, `expected >= 2 stateOnly notices, got ${evidence.stateOnlyPosted}`);
  assert.equal(evidence.journaledIntents.length, 2);
  assert.equal(evidence.journaledIntents[0].op, 'take_control');
  assert.equal(evidence.journaledIntents[0].control, 'human');
  assert.equal(evidence.journaledIntents[1].op, 'release_control');
  assert.equal(evidence.journaledIntents[1].control, 'agent');
  assert.ok(
    evidence.journaledSurfaceChangedCount >= 4,
    `expected >= 4 journaled surface_changed records, got ${evidence.journaledSurfaceChangedCount}`,
  );
}

async function runControlWithFramesJourney() {
  harness.requireNativeTool('xvfb-run');
  harness.ensureFreshUiDist({ root: ROOT, uiRoot: UI_ROOT });
  const electron = harness.electronBinary(ROOT);
  const { findForbiddenEnv } = await import(
    pathToFileURL(join(UI_ROOT, 'electron/coreLauncher.js')).href
  );

  const root = await mkdtemp(join(tmpdir(), 'mv-e2e26-'));
  await chmod(root, 0o700);
  const shmRoot = await mkdtemp('/dev/shm/mv-e2e26-');
  await chmod(shmRoot, 0o700);

  const sockets = new Set();
  let server = null;
  let child = null;
  let frameInterval = null;

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
    const journalPath = join(root, 'journal.jsonl');
    await mkdir(runtimeDir, { mode: 0o700 });
    await mkdir(mvDir, { mode: 0o700 });
    await mkdir(diagDir, { mode: 0o700 });
    await mkdir(profileDir, { mode: 0o700 });
    await writeFile(journalPath, '', { mode: 0o600 });

    const width = 4;
    const height = 4;
    const palette = [
      [0x18, 0x64, 0xab],
      [0x2b, 0x8a, 0x3e],
      [0xd9, 0x48, 0x0f],
      [0x5f, 0x3d, 0xc4],
      [0x0b, 0x72, 0x85],
      [0xc9, 0x2a, 0x2a],
      [0x36, 0x4f, 0xc7],
      [0x08, 0x7f, 0x5b],
    ];
    const publisherDir = await mkdtemp(join(shmRoot, 'frames-'));
    await chmod(publisherDir, 0o700);
    const retainedRotatingPaths = [];

    let journalSeq = 0;
    const journalRecords = [];
    let journalChain = Promise.resolve();
    const appendJournalRecord = (record) => {
      journalSeq += 1;
      const entry = { core_seq: journalSeq, ...record, ts_ms: Date.now() };
      journalRecords.push(entry);
      journalChain = journalChain.then(() =>
        appendFile(journalPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 }),
      );
      return entry;
    };

    const publishNextRotatingFrame = async (generation) => {
      const [r, g, b] = palette[(generation - 1) % palette.length];
      const frame = makeRgbFrame(width, height, r, g, b);
      const name = `${randomBytes(16).toString('hex')}.rgb`;
      const tempPath = join(publisherDir, `${name}.tmp`);
      const finalPath = join(publisherDir, name);
      const fh = await open(
        tempPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await fh.writeFile(frame.buf);
      } finally {
        await fh.close();
      }
      await link(tempPath, finalPath);
      await unlink(tempPath);
      // Retain up to 16 frames in /dev/shm matching the daemon-adapter publisher ring.
      if (retainedRotatingPaths.length >= 16) {
        const expired = retainedRotatingPaths.shift();
        await unlink(expired).catch(() => {});
      }
      retainedRotatingPaths.push(finalPath);
      return { path: finalPath, sha256: frame.sha256 };
    };

    const registration = (component) => ({
      endpoint: { component, instance: `${component}-e2e26` },
      hello: {
        schema: 'hello/v0.2',
        contract_version: 'v0.2',
        component,
        component_version: '0.1.2',
        component_commit: 'a'.repeat(40),
        dependencies: [],
      },
    });
    const config = {
      session_id: `e2e26-${randomUUID().slice(0, 8)}`,
      core: registration('core'),
      peers: [registration('ui')],
    };
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await chmod(configPath, 0o600);

    const surfaceId = 'surface-e2e25-live';
    let surfaceState = {
      schema: 'surface/v0.2',
      surface_id: surfaceId,
      kind: 'browser',
      display: ':99',
      geometry: { w: width, h: height },
      state: 'active',
      visibility: 'unfolded',
      control: 'agent',
      profile_id: 'mv-e2e26-prof',
    };

    let subscribed = false;
    let currentGeneration = 0;
    let streamStartedAtMs = 0;
    let publishingFrame = false;

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

      const emitNextFrame = async () => {
        if (publishingFrame || socket.destroyed) return;
        publishingFrame = true;
        try {
          currentGeneration += 1;
          const gen = currentGeneration;
          const published = await publishNextRotatingFrame(gen);
          appendJournalRecord({
            kind: 'surface_changed',
            surface_id: surfaceId,
            generation: gen,
            sha256: published.sha256,
          });
          sendCore({
            schema: 'surface_event/v0.2',
            event: 'frame_ready',
            data: {
              frame_ref: {
                schema: 'frame_ref/v0.2',
                surface_id: surfaceId,
                generation: gen,
                tick: gen,
                ts_ns: gen * 1000000,
                width,
                height,
                format: 'rgb24',
                ramws_path: published.path,
                sha256: published.sha256,
                capture_us: 100,
              },
            },
          });
        } finally {
          publishingFrame = false;
        }
      };

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
            setTimeout(() => {
              sendCore({
                schema: 'surface_event/v0.2',
                event: 'created',
                data: { surface: surfaceState },
              });
            }, 60);
          } else if (
            env.body?.schema === 'surface_request/v0.2' &&
            env.body?.op === 'frame_subscribe' &&
            !subscribed
          ) {
            subscribed = true;
            streamStartedAtMs = Date.now();
            void emitNextFrame();
            // Stream frames continuously at ~5.5 fps (>= 2 fps requirement).
            frameInterval = setInterval(() => {
              void emitNextFrame();
            }, 180);
          } else if (env.body?.schema === 'ui_intent/v0.2') {
            const op = env.body.op;
            const targetSid = env.body.params?.surface_id || env.body.params?.slot_id;
            if (
              (op === 'take_control' || op === 'release_control') &&
              targetSid === surfaceId
            ) {
              const nextControl = op === 'take_control' ? 'human' : 'agent';
              surfaceState = { ...surfaceState, control: nextControl };
              appendJournalRecord({
                kind: 'intent',
                op,
                request_id: env.body.request_id,
                surface_id: surfaceId,
                control: nextControl,
              });
              sendCore({
                schema: 'surface_event/v0.2',
                event: 'state_changed',
                data: { surface: surfaceState },
              });
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
    const probePath = join(root, 'e2e26-probe.cjs');
    const probeConfig = {
      uiRoot: UI_ROOT,
      mainUrl: pathToFileURL(join(UI_ROOT, 'electron/main.js')).href,
      ctlSock,
    };
    await writeFile(
      probePath,
      `'use strict';\n(${e2e26ProductionProbe.toString()})(${JSON.stringify(probeConfig)});\n`,
      { mode: 0o600 },
    );

    const env = {
      ...process.env,
      XDG_RUNTIME_DIR: runtimeDir,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_STATE_HOME: join(root, 'state'),
      MV_CORE_CONFIG: configPath,
      MV_FRAME_DIAG: '1',
      MV_FRAME_DIAG_DIR: diagDir,
    };
    for (const name of findForbiddenEnv(env)) delete env[name];
    delete env.MV_CORE_BOOTSTRAP;
    delete env.MV_QA_ANCHORS;
    delete env.MV_QA_RUN_DIR;

    let spawnError = null;
    child = harness.trackChildProcess(
      spawn(
        'xvfb-run',
        ['-a', electron, probePath, `--user-data-dir=${profileDir}`],
        { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
    child.on('error', (err) => {
      if (!spawnError) spawnError = err;
    });

    let output = '';
    const onChunk = (bytes) => {
      output = (output + bytes.toString('utf8')).slice(-16384);
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

    let lastSample = null;
    let lastDiag = null;
    const readyState = await waitForBounded(
      async () => {
        const parsed = await readDiagOrNull();
        if (parsed) lastDiag = parsed;
        const sample = await callProbeControl(ctlSock, {
          op: 'sampleControlState',
          surfaceId,
        }).catch(() => null);
        if (sample) lastSample = sample;
        if (
          parsed?.main?.acksByOutcome?.PRESENTED >= 2 &&
          sample?.slotExists === true &&
          sample?.dataState === 'live' &&
          sample?.nonBlack === true &&
          sample?.tileState === 'agent-acting' &&
          sample?.controlButtonExists === true &&
          sample?.controlButtonDisabled === false
        ) {
          return { diag: parsed, sample };
        }
        return null;
      },
      {
        timeoutMs: 18000,
        intervalMs: 40,
        code: 'E2E26_READY_TIMEOUT',
        checkChild: checkChildAlive,
        describe: () =>
          `Timed out waiting for live agent-acting tile with >=2 PRESENTED frames (lastSample=${JSON.stringify(lastSample)}, lastDiag=${JSON.stringify(lastDiag)})\n${output}`,
      },
    );

    const tileStateBeforeTake = readyState.sample.tileState;
    const presentedBeforeTake = readyState.diag.main.acksByOutcome.PRESENTED;
    let activityErrorSeen = false;

    // 1. Click Control to issue take_control while frames stream at >= 2 fps; must be acked & journaled < 1 s.
    const takeStartMs = Date.now();
    const clickTake = await callProbeControl(ctlSock, {
      op: 'clickControl',
      surfaceId,
    });
    assert.equal(clickTake.clicked, true, `clickControl take failed: ${JSON.stringify(clickTake)}`);

    const afterTakeSample = await waitForBounded(
      async () => {
        const sample = await callProbeControl(ctlSock, {
          op: 'sampleControlState',
          surfaceId,
        });
        lastSample = sample;
        if (sample.activityText.includes('unavailable')) {
          activityErrorSeen = true;
        }
        const hasTakeJournal = journalRecords.some(
          (r) => r.kind === 'intent' && r.op === 'take_control' && r.control === 'human',
        );
        if (hasTakeJournal && sample.tileState === 'human-control') {
          return sample;
        }
        return null;
      },
      {
        timeoutMs: 1000,
        intervalMs: 20,
        code: 'E2E26_TAKE_CONTROL_TIMEOUT',
        checkChild: checkChildAlive,
        describe: () =>
          `take_control was not journaled and acked in renderer within 1000 ms (lastSample=${JSON.stringify(lastSample)}, journalIntents=${JSON.stringify(journalRecords.filter((r) => r.kind === 'intent'))})\n${output}`,
      },
    );
    const takeAckMs = Date.now() - takeStartMs;

    // Let >= 2 more frames arrive while in human-control and verify tile state is never clobbered back to agent-acting.
    let presentedDuringTake = presentedBeforeTake;
    const sustainedSample = await waitForBounded(
      async () => {
        const parsed = await readDiagOrNull();
        if (parsed) lastDiag = parsed;
        const sample = await callProbeControl(ctlSock, {
          op: 'sampleControlState',
          surfaceId,
        });
        if (sample.activityText.includes('unavailable')) {
          activityErrorSeen = true;
        }
        if (
          parsed?.main?.acksByOutcome?.PRESENTED >= presentedBeforeTake + 2 &&
          sample.tileState === 'human-control'
        ) {
          presentedDuringTake = parsed.main.acksByOutcome.PRESENTED;
          return sample;
        }
        return null;
      },
      {
        timeoutMs: 2500,
        intervalMs: 40,
        code: 'E2E26_SUSTAINED_HUMAN_CONTROL_TIMEOUT',
        checkChild: checkChildAlive,
        describe: () =>
          `Timed out waiting for >= 2 additional PRESENTED frames under human-control (lastSample=${JSON.stringify(lastSample)}, lastDiag=${JSON.stringify(lastDiag)})\n${output}`,
      },
    );

    // 2. Click Control again to issue release_control while frames stream at >= 2 fps; must be acked & journaled < 1 s.
    const releaseStartMs = Date.now();
    const clickRelease = await callProbeControl(ctlSock, {
      op: 'clickControl',
      surfaceId,
    });
    assert.equal(clickRelease.clicked, true, `clickControl release failed: ${JSON.stringify(clickRelease)}`);

    const afterReleaseSample = await waitForBounded(
      async () => {
        const sample = await callProbeControl(ctlSock, {
          op: 'sampleControlState',
          surfaceId,
        });
        lastSample = sample;
        if (sample.activityText.includes('unavailable')) {
          activityErrorSeen = true;
        }
        const hasReleaseJournal = journalRecords.some(
          (r) => r.kind === 'intent' && r.op === 'release_control' && r.control === 'agent',
        );
        if (hasReleaseJournal && sample.tileState === 'agent-acting') {
          return sample;
        }
        return null;
      },
      {
        timeoutMs: 1000,
        intervalMs: 20,
        code: 'E2E26_RELEASE_CONTROL_TIMEOUT',
        checkChild: checkChildAlive,
        describe: () =>
          `release_control was not journaled and acked in renderer within 1000 ms (lastSample=${JSON.stringify(lastSample)}, journalIntents=${JSON.stringify(journalRecords.filter((r) => r.kind === 'intent'))})\n${output}`,
      },
    );
    const releaseAckMs = Date.now() - releaseStartMs;
    const diagAtRelease = await readDiagOrNull();
    if (diagAtRelease) lastDiag = diagAtRelease;
    const presentedAtRelease = Math.max(
      presentedDuringTake,
      diagAtRelease?.main?.acksByOutcome?.PRESENTED ??
        lastDiag?.main?.acksByOutcome?.PRESENTED ??
        presentedDuringTake,
    );

    // Wait for at least one more frame after release_control to confirm the stream and wire stay healthy.
    const finalDiag = await waitForBounded(
      async () => {
        const parsed = await readDiagOrNull();
        if (parsed) lastDiag = parsed;
        if (
          parsed?.main?.acksByOutcome?.PRESENTED >= presentedBeforeTake + 3 &&
          parsed?.main?.acksByOutcome?.PRESENTED >= presentedAtRelease + 1 &&
          parsed?.main?.stateOnlyPosted >= 2
        ) {
          return parsed;
        }
        return null;
      },
      {
        timeoutMs: 2500,
        intervalMs: 40,
        code: 'E2E26_FINAL_DIAG_TIMEOUT',
        checkChild: checkChildAlive,
        describe: () =>
          `Timed out waiting for final frame-diag.json after release_control (lastDiag=${JSON.stringify(lastDiag)})\n${output}`,
      },
    );

    if (frameInterval) {
      clearInterval(frameInterval);
      frameInterval = null;
    }
    await journalChain;

    const streamElapsedSec = Math.max(0.1, (Date.now() - streamStartedAtMs) / 1000);
    const persistedLines = (await readFile(journalPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const journaledIntents = persistedLines.filter((r) => r.kind === 'intent');
    const journaledSurfaceChangedCount = persistedLines.filter(
      (r) => r.kind === 'surface_changed',
    ).length;
    const fps = finalDiag.main.acksByOutcome.PRESENTED / streamElapsedSec;

    return {
      fps,
      takeAckMs,
      releaseAckMs,
      tileStateBeforeTake,
      tileStateAfterTake: afterTakeSample.tileState,
      tileStateSustainedUnderHumanControl: sustainedSample.tileState,
      tileStateAfterRelease: afterReleaseSample.tileState,
      activityErrorSeen,
      presentedBeforeTake,
      presentedDuringTake,
      presentedAtRelease,
      presentedAfterRelease: finalDiag.main.acksByOutcome.PRESENTED,
      readerRefusals: finalDiag.main.deliveriesRefusedByReader,
      portRefusals: finalDiag.main.deliveriesRefusedByPort,
      revocations: finalDiag.main.revocationsTotal,
      stateOnlyPosted: finalDiag.main.stateOnlyPosted,
      journaledIntents,
      journaledSurfaceChangedCount,
    };
  } finally {
    if (frameInterval) clearInterval(frameInterval);
    stopChild();
    for (const s of sockets) s.destroy();
    if (server) {
      await new Promise((r) => server.close(r));
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(shmRoot, { recursive: true, force: true }).catch(() => {});
  }
}

test(
  'e2e26: shipped main + preload + hostBindings acknowledge and journal take_control and release_control within < 1 s while rotating frames stream at >= 2 fps; negative control rejects starved/unjournaled intents',
  { timeout: 60000 },
  async () => {
    const evidence = await runControlWithFramesJourney();
    assertControlWithFramesAudit(evidence);

    // Negative controls: planted regressions (0 journaled intents, > 1000 ms latency,
    // clobbered tileState, Activity error banner, or < 2 fps) must fail the audit.
    assert.throws(
      () => assertControlWithFramesAudit({ ...evidence, journaledIntents: [] }),
      /expected|2/i,
    );
    assert.throws(
      () => assertControlWithFramesAudit({ ...evidence, takeAckMs: 1250 }),
      /take_control must be acked within 1000 ms/,
    );
    assert.throws(
      () => assertControlWithFramesAudit({ ...evidence, releaseAckMs: 3000 }),
      /release_control must be acked within 1000 ms/,
    );
    assert.throws(
      () =>
        assertControlWithFramesAudit({
          ...evidence,
          tileStateSustainedUnderHumanControl: 'agent-acting',
        }),
      /human-control/,
    );
    assert.throws(
      () => assertControlWithFramesAudit({ ...evidence, activityErrorSeen: true }),
      /Activity strip must not report request unavailable/,
    );
    assert.throws(
      () => assertControlWithFramesAudit({ ...evidence, fps: 1.2 }),
      />= 2 fps/,
    );
    // T8-R3-08 negative control: frames advance during TAKE (+5) but stall (+0) after RELEASE.
    assert.throws(
      () =>
        assertControlWithFramesAudit({
          ...evidence,
          presentedBeforeTake: 2,
          presentedDuringTake: 7,
          presentedAtRelease: 7,
          presentedAfterRelease: 7,
        }),
      /expected >= 1 new PRESENTED frame after release_control/,
    );
  },
);
