'use strict';
// W3-HUMAN-INPUT-R2 (e2e27): boots the real shipped ui/electron/main.js +
// preload.cjs + hostBindings.js + renderer dist against a fixture core.
// Verifies that:
// 1. window.metaviewer.input.send(batch) is exposed in the shipped preload
//    (and authority.input is absent).
// 2. Under human control (after take_control), surface_input/v1 batches with
//    key, type, click, and scroll events reach the fixture core as
//    surface_request/v0.2 op="input" (with scroll x,y dropped) and resolve to
//    { ok: true, accepted: n }.
// 3. Negative controls: NOT_IN_CONTROL before take_control and after
//    release_control, SURFACE_UNKNOWN for unknown surface_id, STALE_STREAM for
//    mismatched stream_id, LIMIT for >32 events, and SCHEMA for malformed or
//    non-increasing seq batches.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { constants: fsConstants } = require('node:fs');
const {
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
  return { buf, sha256 };
}

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

async function e2e27ProductionProbe(config) {
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
            if (cmd.op === 'sampleState') {
              const sidJson = JSON.stringify(String(cmd.surfaceId));
              const result = await wc.executeJavaScript(
                `(() => {
                  const sid = ${sidJson};
                  const slot = document.querySelector('[data-capsule-id="' + sid + '"] [data-anchor="capsule/' + sid + '/slot"]');
                  const tile = slot ? slot.closest('.mv-tile') : document.querySelector('.mv-tile');
                  const controlBtn = document.querySelector(
                    '[data-semantic-anchor="capsule/' + sid + '/control"], [data-anchor="capsule/' + sid + '/control"]',
                  );
                  return {
                    slotExists: Boolean(slot),
                    dataState: slot ? slot.getAttribute('data-state') : null,
                    tileState: tile ? tile.getAttribute('data-tile-state') : null,
                    controlButtonExists: Boolean(controlBtn),
                    controlButtonDisabled: controlBtn ? Boolean(controlBtn.disabled) : true,
                    hasInputSend: typeof window.metaviewer?.input?.send === 'function',
                    hasAuthorityInput: typeof window.metaviewer?.authority?.input !== 'undefined',
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
            } else if (cmd.op === 'invokeInputSend') {
              const batchJson = JSON.stringify(cmd.batch);
              const result = await wc.executeJavaScript(
                `(async () => {
                  return await window.metaviewer.input.send(${batchJson});
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

test('W3-HUMAN-INPUT-R2 (e2e27): window.metaviewer.input.send(batch) drives surface_input/v1 through shipped preload against fixture core', async () => {
  harness.requireNativeTool('xvfb-run');
  harness.ensureFreshUiDist({ root: ROOT, uiRoot: UI_ROOT });
  const electron = harness.electronBinary(ROOT);
  const { findForbiddenEnv } = await import(
    pathToFileURL(join(UI_ROOT, 'electron/coreLauncher.js')).href
  );

  const root = await mkdtemp(join(tmpdir(), 'mv-e2e27-'));
  await chmod(root, 0o700);
  const shmRoot = await mkdtemp('/dev/shm/mv-e2e27-');
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
    await mkdir(runtimeDir, { mode: 0o700 });
    await mkdir(mvDir, { mode: 0o700 });
    await mkdir(diagDir, { mode: 0o700 });
    await mkdir(profileDir, { mode: 0o700 });

    const width = 4;
    const height = 4;
    const publisherDir = await mkdtemp(join(shmRoot, 'frames-'));
    await chmod(publisherDir, 0o700);
    const retainedPaths = [];

    const publishFrame = async (gen) => {
      const frame = makeRgbFrame(width, height, 0x20, 0x80, (gen * 17) & 0xff);
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
      if (retainedPaths.length >= 16) {
        const expired = retainedPaths.shift();
        await unlink(expired).catch(() => {});
      }
      retainedPaths.push(finalPath);
      return { path: finalPath, sha256: frame.sha256 };
    };

    const registration = (component) => ({
      endpoint: { component, instance: `${component}-e2e27` },
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
      session_id: `e2e27-${randomUUID().slice(0, 8)}`,
      core: registration('core'),
      peers: [registration('ui')],
    };
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await chmod(configPath, 0o600);

    const surfaceId = 'surface-e2e27-live';
    let surfaceState = {
      schema: 'surface/v0.2',
      surface_id: surfaceId,
      kind: 'browser',
      display: ':99',
      geometry: { w: width, h: height },
      state: 'active',
      visibility: 'unfolded',
      control: 'agent',
      profile_id: 'mv-e2e27-prof',
    };

    let subscribed = false;
    let currentGeneration = 0;
    let publishingFrame = false;
    const receivedIntents = [];
    const receivedInputs = [];

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
          const published = await publishFrame(gen);
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
            void emitNextFrame();
            frameInterval = setInterval(() => {
              void emitNextFrame();
            }, 180);
          } else if (env.body?.schema === 'ui_intent/v0.2') {
            const op = env.body.op;
            const targetSid = env.body.params?.surface_id || env.body.params?.slot_id;
            if ((op === 'take_control' || op === 'release_control') && targetSid === surfaceId) {
              receivedIntents.push(env.body);
              const nextControl = op === 'take_control' ? 'human' : 'agent';
              surfaceState = { ...surfaceState, control: nextControl };
              sendCore({
                schema: 'surface_event/v0.2',
                event: 'state_changed',
                data: { surface: surfaceState },
              });
            }
          } else if (env.body?.schema === 'surface_request/v0.2' && env.body?.op === 'input') {
            receivedInputs.push(env.body);
            if (
              env.body.params?.surface_id === surfaceId &&
              surfaceState.control === 'human' &&
              env.body.params?.action?.type === 'click' &&
              env.body.params?.action?.x === 3 &&
              env.body.params?.action?.y === 3
            ) {
              sendCore({
                schema: 'action_verdict/v0.2',
                proposal_id: env.body.params.proposal_id,
                decision: 'refused',
                reason_code: 'OUT_OF_BOUNDS',
                core_seq: seq + 1,
              });
            } else if (
              env.body.params?.surface_id === surfaceId &&
              surfaceState.control === 'human'
            ) {
              sendCore({
                schema: 'action_verdict/v0.2',
                proposal_id: env.body.params.proposal_id,
                decision: 'admitted',
                core_seq: seq + 1,
              });
            } else {
              sendCore({
                schema: 'action_verdict/v0.2',
                proposal_id: env.body.params?.proposal_id || 'refused',
                decision: 'refused',
                reason_code: 'LOCKED_BY_OTHER',
                core_seq: seq + 1,
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
    const probePath = join(root, 'e2e27-probe.cjs');
    const probeConfig = {
      uiRoot: UI_ROOT,
      mainUrl: pathToFileURL(join(UI_ROOT, 'electron/main.js')).href,
      ctlSock,
    };
    await writeFile(
      probePath,
      `'use strict';\n(${e2e27ProductionProbe.toString()})(${JSON.stringify(probeConfig)});\n`,
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

    let boundStreamId = 1;
    await waitForBounded(
      async () => {
        const parsed = await readDiagOrNull();
        const sample = await callProbeControl(ctlSock, {
          op: 'sampleState',
          surfaceId,
        }).catch(() => null);
        if (
          parsed?.main?.acksByOutcome?.PRESENTED >= 1 &&
          sample?.slotExists === true &&
          sample?.dataState === 'live' &&
          sample?.tileState === 'agent-acting' &&
          sample?.controlButtonExists === true &&
          sample?.controlButtonDisabled === false &&
          sample?.hasInputSend === true &&
          sample?.hasAuthorityInput === false
        ) {
          boundStreamId = parsed?.preload?.lastSurfaceGeneration ?? 1;
          return sample;
        }
        return null;
      },
      {
        timeoutMs: 18000,
        intervalMs: 40,
        code: 'E2E27_READY_TIMEOUT',
        checkChild: checkChildAlive,
        describe: () => `Timed out waiting for live agent-acting tile\n${output}`,
      },
    );

    // 1. Negative control before take_control: surface is agent-controlled -> NOT_IN_CONTROL.
    const preControlInput = await callProbeControl(ctlSock, {
      op: 'invokeInputSend',
      batch: {
        schema: 'surface_input/v1',
        surface_id: surfaceId,
        stream_id: boundStreamId,
        seq: 1,
        events: [{ kind: 'key', keys: ['space'] }],
      },
    });
    assert.deepEqual(preControlInput, { ok: false, code: 'NOT_IN_CONTROL' });
    assert.equal(receivedInputs.length, 0);

    // 2. Click Control to take human control of the surface.
    const clickTake = await callProbeControl(ctlSock, {
      op: 'clickControl',
      surfaceId,
    });
    assert.equal(clickTake.clicked, true);

    await waitForBounded(
      async () => {
        const sample = await callProbeControl(ctlSock, {
          op: 'sampleState',
          surfaceId,
        });
        return sample?.tileState === 'human-control' ? sample : null;
      },
      {
        timeoutMs: 4000,
        intervalMs: 25,
        code: 'E2E27_TAKE_CONTROL_TIMEOUT',
        checkChild: checkChildAlive,
        describe: () => 'Timed out waiting for human-control tile state',
      },
    );

    // 3. Negative controls under human control: SURFACE_UNKNOWN, STALE_STREAM, LIMIT, SCHEMA.
    assert.deepEqual(
      await callProbeControl(ctlSock, {
        op: 'invokeInputSend',
        batch: {
          schema: 'surface_input/v1',
          surface_id: 'unknown-surface',
          stream_id: boundStreamId,
          seq: 1,
          events: [{ kind: 'key', keys: ['Return'] }],
        },
      }),
      { ok: false, code: 'SURFACE_UNKNOWN' },
    );
    assert.deepEqual(
      await callProbeControl(ctlSock, {
        op: 'invokeInputSend',
        batch: {
          schema: 'surface_input/v1',
          surface_id: surfaceId,
          stream_id: boundStreamId + 999,
          seq: 1,
          events: [{ kind: 'key', keys: ['Return'] }],
        },
      }),
      { ok: false, code: 'STALE_STREAM' },
    );
    assert.deepEqual(
      await callProbeControl(ctlSock, {
        op: 'invokeInputSend',
        batch: {
          schema: 'surface_input/v1',
          surface_id: surfaceId,
          stream_id: boundStreamId,
          seq: 1,
          events: Array.from({ length: 33 }, () => ({ kind: 'key', keys: ['a'] })),
        },
      }),
      { ok: false, code: 'LIMIT' },
    );
    assert.deepEqual(
      await callProbeControl(ctlSock, {
        op: 'invokeInputSend',
        batch: {
          schema: 'surface_input/v1',
          surface_id: surfaceId,
          stream_id: boundStreamId,
          seq: 1,
          events: [],
        },
      }),
      { ok: false, code: 'SCHEMA' },
    );
    assert.equal(receivedInputs.length, 0);

    // 4. Positive control: batch with key, type, click, and scroll reaches fixture core.
    const batchRes = await callProbeControl(ctlSock, {
      op: 'invokeInputSend',
      batch: {
        schema: 'surface_input/v1',
        surface_id: surfaceId,
        stream_id: boundStreamId,
        seq: 1,
        events: [
          { kind: 'key', keys: ['Control_L', 'l'] },
          { kind: 'type', text: 'https://capsule.local/live' },
          { kind: 'click', x: 2, y: 1, button: 'left' },
          { kind: 'scroll', dx: 0, dy: -120, x: 2, y: 1 },
        ],
      },
    });
    assert.deepEqual(batchRes, { ok: true, accepted: 4 });
    assert.equal(receivedInputs.length, 4);
    for (const r of receivedInputs) {
      assert.equal(r.schema, 'surface_request/v0.2');
      assert.equal(r.op, 'input');
      assert.deepEqual(Object.keys(r).sort(), ['op', 'params', 'schema']);
      assert.deepEqual(Object.keys(r.params).sort(), ['action', 'proposal_id', 'surface_id']);
      assert.equal(typeof r.params.proposal_id, 'string');
      assert.equal(r.params.proposal_id.length >= 1 && r.params.proposal_id.length <= 128, true);
    }
    assert.deepEqual(
      receivedInputs.map((r) => ({ surface_id: r.params.surface_id, action: r.params.action })),
      [
        { surface_id: surfaceId, action: { type: 'key', keys: ['Control_L', 'l'] } },
        { surface_id: surfaceId, action: { type: 'type', text: 'https://capsule.local/live' } },
        { surface_id: surfaceId, action: { type: 'click', x: 2, y: 1, button: 'left' } },
        { surface_id: surfaceId, action: { type: 'scroll', dx: 0, dy: -120 } },
      ],
    );

    // 5. Monotonic seq check and typed wire refusal outcome: replaying seq=1 is refused locally with SCHEMA;
    // wire refusal (OUT_OF_BOUNDS on click (3,3)) reaches fixture core and maps to UI typed code SCHEMA; seq=3 succeeds.
    assert.deepEqual(
      await callProbeControl(ctlSock, {
        op: 'invokeInputSend',
        batch: {
          schema: 'surface_input/v1',
          surface_id: surfaceId,
          stream_id: boundStreamId,
          seq: 1,
          events: [{ kind: 'key', keys: ['Return'] }],
        },
      }),
      { ok: false, code: 'SCHEMA' },
    );
    assert.equal(receivedInputs.length, 4);
    assert.deepEqual(
      await callProbeControl(ctlSock, {
        op: 'invokeInputSend',
        batch: {
          schema: 'surface_input/v1',
          surface_id: surfaceId,
          stream_id: boundStreamId,
          seq: 2,
          events: [{ kind: 'click', x: 3, y: 3, button: 'left' }],
        },
      }),
      { ok: false, code: 'SCHEMA' },
    );
    assert.equal(receivedInputs.length, 5);
    assert.deepEqual(
      await callProbeControl(ctlSock, {
        op: 'invokeInputSend',
        batch: {
          schema: 'surface_input/v1',
          surface_id: surfaceId,
          stream_id: boundStreamId,
          seq: 3,
          events: [{ kind: 'key', keys: ['Return'] }],
        },
      }),
      { ok: true, accepted: 1 },
    );
    assert.equal(receivedInputs.length, 6);

    // 6. Release control and verify subsequent input is refused with NOT_IN_CONTROL.
    const clickRelease = await callProbeControl(ctlSock, {
      op: 'clickControl',
      surfaceId,
    });
    assert.equal(clickRelease.clicked, true);

    await waitForBounded(
      async () => {
        const sample = await callProbeControl(ctlSock, {
          op: 'sampleState',
          surfaceId,
        });
        return sample?.tileState === 'agent-acting' ? sample : null;
      },
      {
        timeoutMs: 4000,
        intervalMs: 25,
        code: 'E2E27_RELEASE_CONTROL_TIMEOUT',
        checkChild: checkChildAlive,
        describe: () => 'Timed out waiting for agent-acting tile state after release',
      },
    );

    const postReleaseInput = await callProbeControl(ctlSock, {
      op: 'invokeInputSend',
      batch: {
        schema: 'surface_input/v1',
        surface_id: surfaceId,
        stream_id: boundStreamId,
        seq: 4,
        events: [{ kind: 'key', keys: ['a'] }],
      },
    });
    assert.deepEqual(postReleaseInput, { ok: false, code: 'NOT_IN_CONTROL' });
    assert.equal(receivedInputs.length, 6);
    assert.equal(receivedIntents.length, 2);
  } finally {
    if (frameInterval) clearInterval(frameInterval);
    stopChild();
    for (const s of sockets) s.destroy();
    if (server) {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
    await rm(root, { recursive: true, force: true });
    await rm(shmRoot, { recursive: true, force: true });
  }
});
