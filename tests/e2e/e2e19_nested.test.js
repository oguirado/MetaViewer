'use strict';
// U20 / E2E-U20n: real display-only boot for depth one, typed refusal before
// display for depth two, and live depth-1 inner capsule + core journey with
// separate profile and sockets (shared socket path refused).
// Mutation: in validateRetailLaunch change `nested === 1` to false
// -> the positive process refuses before loading its wall.
// Mutation: accept --nested-depth=2 alongside =1 -> the negative callback runs.
// Mutation: in core/src/transport/mod.rs allow bind_owner_only to unlink an
// active socket (`if false { return Err(TransportError::SocketInUse(...)) }`)
// -> the shared-socket negative control in E2E-U20n fails.
// Mutation: in ui/electron/authorityWire.js omit `state.surface_id !== ref.surface_id`
// or in harness.js omit `expectedOwner !== tile.capsuleId`
// -> the cross-surface frame negative control in E2E-U20n-tile fails.
// Mutation: in contracts/v0.2/surface_request.schema.json / core wire decoding
// allow `nested_depth: 2` on create -> the depth-2 socket refusal and unchanged
// journal event count assertion in E2E-U20n-tile fail.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { createConnection } = require('node:net');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const harness = require('./ac-harness.cjs');

function buildCoreBinary(root) {
  const cargo = process.env.CARGO || 'cargo';
  const out = execFileSync(
    cargo,
    ['build', '--offline', '--bin', 'metaviewer-core', '--message-format=json'],
    { cwd: root, env: process.env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
  );
  const bins = out
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((row) => row.reason === 'compiler-artifact' && row.target.name === 'metaviewer-core' && row.executable)
    .map((row) => row.executable);
  assert.equal(bins.length, 1, 'E2E_PREREQ: metaviewer-core binary required');
  return bins[0];
}

function makeRegistration(component, instanceSuffix, version) {
  return {
    endpoint: { component, instance: `${component}-${instanceSuffix}` },
    hello: {
      schema: 'hello/v0.2',
      contract_version: 'v0.2',
      component,
      component_version: version,
      component_commit: '0123456789abcdef0123456789abcdef01234567',
      dependencies: [],
    },
  };
}

function writeCoreConfig(dir, sessionId, instanceSuffix, version) {
  const config = {
    session_id: sessionId,
    core: makeRegistration('core', instanceSuffix, version),
    peers: [
      makeRegistration('daemon', instanceSuffix, version),
      makeRegistration('agent', instanceSuffix, version),
      makeRegistration('ui', instanceSuffix, version),
    ],
  };
  const configPath = join(dir, `config-${instanceSuffix}.json`);
  writeFileSync(configPath, JSON.stringify(config));
  return { config, configPath };
}

function connectAndPublishLiveCapsule({ sockPath, config, surfaceId, kind, profileId, deadlineMs = 10000 }) {
  const start = Date.now();
  const daemonPeer = config.peers[0];
  const coreEndpoint = config.core.endpoint;
  const helloEnv = {
    schema: 'envelope/v0.2',
    msg_id: `hello-${surfaceId}`,
    ts_ns: 0,
    from: daemonPeer.endpoint,
    to: coreEndpoint,
    session_id: config.session_id,
    seq: 1,
    nonce: `hello-${surfaceId}`,
    body: daemonPeer.hello,
  };
  const createdEnv = {
    schema: 'envelope/v0.2',
    msg_id: `created-${surfaceId}`,
    ts_ns: 1,
    from: daemonPeer.endpoint,
    to: coreEndpoint,
    session_id: config.session_id,
    seq: 2,
    nonce: `created-${surfaceId}`,
    body: {
      schema: 'surface_event/v0.2',
      event: 'created',
      data: {
        surface: {
          schema: 'surface/v0.2',
          surface_id: surfaceId,
          kind,
          display: ':99',
          geometry: { w: 1280, h: 720 },
          state: 'active',
          visibility: 'unfolded',
          control: 'agent',
          profile_id: profileId,
        },
      },
    },
  };

  return new Promise((resolvePromise, rejectPromise) => {
    function attempt() {
      if (Date.now() - start > deadlineMs) {
        rejectPromise(new Error(`E2E_TIMEOUT: timed out connecting to ${sockPath}`));
        return;
      }
      const client = createConnection(sockPath);
      let buf = '';
      let settled = false;
      client.setEncoding('utf8');
      client.on('connect', () => {
        client.write(`${JSON.stringify(helloEnv)}\n`);
      });
      client.on('data', (chunk) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl !== -1 && !settled) {
          settled = true;
          const reply = JSON.parse(buf.slice(0, nl));
          client.write(`${JSON.stringify(createdEnv)}\n`, () => {
            client.end();
            resolvePromise(reply);
          });
        }
      });
      client.on('error', () => {
        if (!settled) {
          client.destroy();
          setImmediate(attempt);
        }
      });
    }
    attempt();
  });
}

function waitForJournalSurface(eventPath, surfaceId, deadlineMs = 10000) {
  const start = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    function poll() {
      try {
        if (existsSync(eventPath) && statSync(eventPath).size > 0) {
          const data = JSON.parse(readFileSync(eventPath, 'utf8'));
          if (data && data.state && data.state.surfaces && data.state.surfaces[surfaceId] && data.state.surfaces[surfaceId].live === true) {
            resolvePromise(data.state);
            return;
          }
        }
      } catch {
        // Sidecar write in progress; retry until deadline.
      }
      if (Date.now() - start > deadlineMs) {
        rejectPromise(new Error(`E2E_TIMEOUT: surface ${surfaceId} not live in ${eventPath}`));
        return;
      }
      setImmediate(poll);
    }
    poll();
  });
}

test('nested depth one boots an isolated read-only wall; depth two refuses before display', () => {
  const scratch = harness.makeScratch('mv-nested');
  try {
    const root = join(__dirname, '../..');
    execFileSync(process.execPath, [join(root, 'ui/node_modules/vite/bin/vite.js'), 'build',
      '--outDir', join(scratch, 'dist/renderer')], { cwd: join(root, 'ui'), env: process.env,
      encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'mv-nested-test',
      version: '0.0.0', type: 'module', main: 'probe.mjs' }));
    writeFileSync(join(scratch, 'probe.mjs'),
      `import ${JSON.stringify(pathToFileURL(join(__dirname, 'nested-main.mjs')).href)};`);
    const run = depth => {
      const report = join(scratch, `depth-${depth}.json`);
      const result = harness.runUnderXvfb({ electron: harness.electronBinary(root),
        appDir: scratch, extraArgs: [report, `--nested-depth=${depth}`], timeoutMs: 30000 });
      return { result, report: JSON.parse(readFileSync(report, 'utf8')) };
    };
    const good = run(1);
    assert.equal(good.result.status, 0, JSON.stringify(good));
    assert.deepEqual(good.report, { status: 'ready', calls: 1,
      renderer: { node: 'undefined', layout: null, saveRefused: true, settled: true,
        depth: 1, settings: null, blocked: [true, true, true] } });
    const bad = run(2);
    assert.equal(bad.result.status, 1, JSON.stringify(bad));
    assert.equal(bad.report.status, 'refused');
    assert.equal(bad.report.calls, 0);
    assert.match(bad.report.error, /NESTED_DEPTH/);
  } finally { harness.removeScratch(scratch); }
});

test('E2E-U20n: depth-1 inner runs a live capsule with separate profile and sockets; shared socket path is refused', async () => {
  const scratch = harness.makeScratch('mv-nested-u20n');
  const spawnedPids = [];
  try {
    const root = join(__dirname, '../..');
    const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
    execFileSync(process.execPath, [join(root, 'ui/node_modules/vite/bin/vite.js'), 'build',
      '--outDir', join(scratch, 'dist/renderer')], { cwd: join(root, 'ui'), env: process.env,
      encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'mv-nested-u20n-test',
      version: '0.0.0', type: 'module', main: 'probe.mjs' }));
    writeFileSync(join(scratch, 'probe.mjs'),
      `import ${JSON.stringify(pathToFileURL(join(__dirname, 'nested-main.mjs')).href)};`);

    const run = (depth, subDir, extraEnv = {}) => {
      mkdirSync(subDir, { recursive: true });
      const report = join(subDir, `depth-${depth}.json`);
      const prev = {};
      for (const [k, v] of Object.entries(extraEnv)) {
        prev[k] = process.env[k];
        process.env[k] = v;
      }
      try {
        const result = harness.runUnderXvfb({ electron: harness.electronBinary(root),
          appDir: scratch, extraArgs: [report, `--nested-depth=${depth}`], timeoutMs: 30000 });
        return {
          result,
          report: JSON.parse(readFileSync(report, 'utf8')),
          baseProfileDir: join(subDir, `profile-${depth}`),
          profileDir: join(subDir, `profile-${depth}-nested-depth-1`),
        };
      } finally {
        for (const [k, v] of Object.entries(prev)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    };

    const coreBin = buildCoreBinary(root);
    const outerRuntime = join(scratch, 'outer-runtime');
    const innerRuntime = join(scratch, 'inner-runtime');
    const outerState = join(scratch, 'outer-state');
    const innerState = join(scratch, 'inner-state');
    const outerProfile = join(scratch, 'outer-profile');
    const innerRunDir = join(scratch, 'inner-run');
    mkdirSync(outerRuntime, { mode: 0o700, recursive: true });
    mkdirSync(innerRuntime, { mode: 0o700, recursive: true });
    mkdirSync(outerState, { mode: 0o700, recursive: true });
    mkdirSync(innerState, { mode: 0o700, recursive: true });
    mkdirSync(outerProfile, { mode: 0o700, recursive: true });

    const outerCfg = writeCoreConfig(scratch, 'outer-session', 'outer', version);
    const innerCfg = writeCoreConfig(scratch, 'inner-session', 'inner', version);

    const outerCore = spawn(coreBin, [], {
      cwd: scratch,
      env: {
        ...process.env,
        MV_CORE_CONFIG: outerCfg.configPath,
        XDG_RUNTIME_DIR: outerRuntime,
        XDG_STATE_HOME: outerState,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawnedPids.push(outerCore.pid);

    const innerCore = spawn(coreBin, [], {
      cwd: scratch,
      env: {
        ...process.env,
        MV_CORE_CONFIG: innerCfg.configPath,
        XDG_RUNTIME_DIR: innerRuntime,
        XDG_STATE_HOME: innerState,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawnedPids.push(innerCore.pid);

    const outerSock = join(outerRuntime, 'metaviewer/core.sock');
    const innerSock = join(innerRuntime, 'metaviewer/core.sock');
    assert.notEqual(outerSock, innerSock);

    const outerHello = await connectAndPublishLiveCapsule({
      sockPath: outerSock,
      config: outerCfg.config,
      surfaceId: 'cap-outer-host',
      kind: 'desktop_capsule',
      profileId: 'prof-outer-1',
    });
    assert.equal(outerHello.body.component, 'core');

    const innerHello = await connectAndPublishLiveCapsule({
      sockPath: innerSock,
      config: innerCfg.config,
      surfaceId: 'cap-inner-live',
      kind: 'browser',
      profileId: 'prof-inner-1',
    });
    assert.equal(innerHello.body.component, 'core');

    const outerEventPath = join(outerState, 'metaviewer/sessions/outer-session/events/2.json');
    const innerEventPath = join(innerState, 'metaviewer/sessions/inner-session/events/2.json');
    const outerCommitted = await waitForJournalSurface(outerEventPath, 'cap-outer-host');
    const innerCommitted = await waitForJournalSurface(innerEventPath, 'cap-inner-live');

    assert.equal(outerCommitted.surfaces['cap-outer-host'].live, true);
    assert.equal(outerCommitted.surfaces['cap-inner-live'], undefined);
    assert.equal(innerCommitted.surfaces['cap-inner-live'].live, true);
    assert.equal(innerCommitted.surfaces['cap-outer-host'], undefined);

    // Boot depth-1 inner display wall with its own isolated profile and inner runtime dir while both capsules are live.
    const innerDisplay = run(1, innerRunDir, { XDG_RUNTIME_DIR: innerRuntime });
    assert.equal(innerDisplay.result.status, 0, JSON.stringify(innerDisplay));
    assert.equal(innerDisplay.report.status, 'ready');
    assert.equal(innerDisplay.report.renderer.depth, 1);
    assert.equal(innerDisplay.report.renderer.settled, true);
    assert.notEqual(innerDisplay.profileDir, outerProfile);
    assert.notEqual(innerDisplay.profileDir, innerDisplay.baseProfileDir);
    assert.equal(existsSync(innerDisplay.profileDir), true);
    assert.equal(existsSync(innerDisplay.baseProfileDir), false);

    // Negative control: inner core attempting to share the outer XDG_RUNTIME_DIR / core.sock path is refused with LiveSocket.
    const sharedSocketAttempt = spawnSync(coreBin, [], {
      cwd: scratch,
      env: {
        ...process.env,
        MV_CORE_CONFIG: innerCfg.configPath,
        XDG_RUNTIME_DIR: outerRuntime,
        XDG_STATE_HOME: join(scratch, 'clashing-state'),
      },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(sharedSocketAttempt.status, 2, JSON.stringify(sharedSocketAttempt));
    assert.match(sharedSocketAttempt.stderr, /LiveSocket/);
    assert.equal(outerCore.exitCode, null, 'outer core must stay live after shared-socket refusal');
    assert.equal(innerCore.exitCode, null, 'inner core must stay live after shared-socket refusal');
  } finally {
    for (const pid of spawnedPids) {
      if (typeof pid === 'number' && pid > 1) {
        try {
          await harness.terminate(pid);
        } catch {
          // Best-effort cleanup of test child processes.
        }
      }
    }
    harness.removeScratch(scratch);
  }
});

function connectUiSubscriber({ sockPath, config, expectedSurfaceId, expectedGeneration, deadlineMs = 10000 }) {
  const start = Date.now();
  const uiPeer = config.peers[2];
  const coreEndpoint = config.core.endpoint;
  const helloEnv = {
    schema: 'envelope/v0.2',
    msg_id: `ui-hello-${expectedSurfaceId}`,
    ts_ns: 0,
    from: uiPeer.endpoint,
    to: coreEndpoint,
    session_id: config.session_id,
    seq: 1,
    nonce: `ui-hello-${expectedSurfaceId}`,
    body: uiPeer.hello,
  };

  let client = null;
  let surface = null;
  let frame = null;
  let resolveFrame = null;
  let rejectFrame = null;
  const framePromise = new Promise((res, rej) => {
    resolveFrame = res;
    rejectFrame = rej;
  });

  const ready = new Promise((resolveReady, rejectReady) => {
    function attempt() {
      if (Date.now() - start > deadlineMs) {
        rejectReady(new Error(`E2E_TIMEOUT: UI subscriber timed out connecting to ${sockPath}`));
        return;
      }
      const conn = createConnection(sockPath);
      client = conn;
      let buf = '';
      let greeted = false;
      conn.setEncoding('utf8');
      conn.on('connect', () => {
        conn.write(`${JSON.stringify(helloEnv)}\n`);
      });
      conn.on('data', (chunk) => {
        buf += chunk;
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          nl = buf.indexOf('\n');
          if (!line.trim()) continue;
          const env = JSON.parse(line);
          if (!greeted) {
            greeted = true;
            resolveReady(env);
            continue;
          }
          if (env.body && env.body.schema === 'surface_event/v0.2') {
            if (env.body.event === 'created' && env.body.data?.surface?.surface_id === expectedSurfaceId) {
              surface = env.body.data.surface;
            } else if (
              env.body.event === 'frame_ready' &&
              env.body.data?.frame_ref?.surface_id === expectedSurfaceId &&
              env.body.data?.frame_ref?.generation === expectedGeneration
            ) {
              frame = env.body.data.frame_ref;
            }
            if (surface && frame) {
              resolveFrame({ surface, frame });
            }
          }
        }
      });
      conn.on('error', (err) => {
        if (!greeted) {
          conn.destroy();
          setImmediate(attempt);
        } else {
          rejectFrame(err);
        }
      });
    }
    attempt();
  });

  return {
    ready,
    waitForFannedOutFrame(waitMs = 10000) {
      let timer;
      return Promise.race([
        framePromise,
        new Promise((_, rejectTimeout) => {
          timer = setTimeout(
            () => rejectTimeout(new Error(`E2E_TIMEOUT: UI did not receive fanned-out frame for ${expectedSurfaceId}`)),
            waitMs,
          );
        }),
      ]).finally(() => clearTimeout(timer));
    },
    close() {
      if (client) client.destroy();
    },
  };
}

function publishCapsuleWithFrame({ sockPath, config, surfaceId, kind, profileId, geometry, frameRef, deadlineMs = 10000 }) {
  const start = Date.now();
  const daemonPeer = config.peers[0];
  const coreEndpoint = config.core.endpoint;
  const helloEnv = {
    schema: 'envelope/v0.2',
    msg_id: `hello-${surfaceId}`,
    ts_ns: 0,
    from: daemonPeer.endpoint,
    to: coreEndpoint,
    session_id: config.session_id,
    seq: 1,
    nonce: `hello-${surfaceId}`,
    body: daemonPeer.hello,
  };
  const createdEnv = {
    schema: 'envelope/v0.2',
    msg_id: `created-${surfaceId}`,
    ts_ns: 1,
    from: daemonPeer.endpoint,
    to: coreEndpoint,
    session_id: config.session_id,
    seq: 2,
    nonce: `created-${surfaceId}`,
    body: {
      schema: 'surface_event/v0.2',
      event: 'created',
      data: {
        surface: {
          schema: 'surface/v0.2',
          surface_id: surfaceId,
          kind,
          display: ':99',
          geometry,
          state: 'active',
          visibility: 'unfolded',
          control: 'agent',
          profile_id: profileId,
        },
      },
    },
  };
  const frameReadyEnv = {
    schema: 'envelope/v0.2',
    msg_id: `frame-${surfaceId}-${frameRef.generation}`,
    ts_ns: 2,
    from: daemonPeer.endpoint,
    to: coreEndpoint,
    session_id: config.session_id,
    seq: 3,
    nonce: `frame-${surfaceId}-${frameRef.generation}`,
    body: {
      schema: 'surface_event/v0.2',
      event: 'frame_ready',
      data: {
        frame_ref: frameRef,
      },
    },
  };

  return new Promise((resolvePromise, rejectPromise) => {
    function attempt() {
      if (Date.now() - start > deadlineMs) {
        rejectPromise(new Error(`E2E_TIMEOUT: timed out connecting daemon to ${sockPath}`));
        return;
      }
      const client = createConnection(sockPath);
      let buf = '';
      let settled = false;
      client.setEncoding('utf8');
      client.on('connect', () => {
        client.write(`${JSON.stringify(helloEnv)}\n`);
      });
      client.on('data', (chunk) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl !== -1 && !settled) {
          settled = true;
          const reply = JSON.parse(buf.slice(0, nl));
          client.write(`${JSON.stringify(createdEnv)}\n${JSON.stringify(frameReadyEnv)}\n`, () => {
            client.end();
            resolvePromise(reply);
          });
        }
      });
      client.on('error', () => {
        if (!settled) {
          client.destroy();
          setImmediate(attempt);
        }
      });
    }
    attempt();
  });
}

function waitForJournalFrame(eventPath, surfaceId, generation, sha256, deadlineMs = 10000) {
  const start = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    function poll() {
      try {
        if (existsSync(eventPath) && statSync(eventPath).size > 0) {
          const data = JSON.parse(readFileSync(eventPath, 'utf8'));
          const surf = data?.state?.surfaces?.[surfaceId];
          if (
            surf &&
            surf.live === true &&
            surf.frame &&
            surf.frame.generation === generation &&
            surf.frame.sha256 === sha256
          ) {
            resolvePromise(data.state);
            return;
          }
        }
      } catch {
        // Sidecar write in progress; retry until deadline.
      }
      if (Date.now() - start > deadlineMs) {
        rejectPromise(new Error(`E2E_TIMEOUT: frame gen ${generation} for ${surfaceId} not committed in ${eventPath}`));
        return;
      }
      setImmediate(poll);
    }
    poll();
  });
}

function runRelayProbe(root, fixturePath, profileDir) {
  const prevFixture = process.env.MV_E2E_FRAME_FIXTURE;
  process.env.MV_E2E_FRAME_FIXTURE = fixturePath;
  try {
    const result = harness.runUnderXvfb({
      electron: harness.electronBinary(root),
      appDir: join(root, 'tests/e2e/e2e1_slice/electron-relay.mjs'),
      extraArgs: [`--user-data-dir=${profileDir}`],
      timeoutMs: 30000,
    });
    const jsonLine = result.stdout
      .trim()
      .split('\n')
      .reverse()
      .find((line) => line.trim().startsWith('{'));
    assert.ok(jsonLine, `relay must emit JSON on stdout; got: ${ JSON.stringify(result) }`);
    return { result, relay: JSON.parse(jsonLine) };
  } finally {
    if (prevFixture === undefined) delete process.env.MV_E2E_FRAME_FIXTURE;
    else process.env.MV_E2E_FRAME_FIXTURE = prevFixture;
  }
}

function sendDepthTwoCreate({ sockPath, config, profileId, onBeforeSend, deadlineMs = 10000 }) {
  const agentPeer = config.peers[1];
  const coreEndpoint = config.core.endpoint;
  const helloEnv = {
    schema: 'envelope/v0.2',
    msg_id: `agent-hello-${profileId}`,
    ts_ns: 0,
    from: agentPeer.endpoint,
    to: coreEndpoint,
    session_id: config.session_id,
    seq: 1,
    nonce: `agent-hello-${profileId}`,
    body: agentPeer.hello,
  };
  const createDepth2Env = {
    schema: 'envelope/v0.2',
    msg_id: `create-depth2-${profileId}`,
    ts_ns: 1,
    from: agentPeer.endpoint,
    to: coreEndpoint,
    session_id: config.session_id,
    seq: 2,
    nonce: `create-depth2-${profileId}`,
    body: {
      schema: 'surface_request/v0.2',
      op: 'create',
      params: {
        kind: 'desktop_capsule',
        profile_id: profileId,
        geometry: { w: 1280, h: 720 },
        nested_depth: 2,
      },
    },
  };

  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`E2E_TIMEOUT: depth-2 create probe timed out on ${sockPath}`)),
      deadlineMs,
    );
    const client = createConnection(sockPath);
    let buf = '';
    let helloReply = null;
    const postHelloReplies = [];
    client.setEncoding('utf8');
    client.on('connect', () => {
      client.write(`${JSON.stringify(helloEnv)}\n`);
    });
    client.on('data', (chunk) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (!helloReply) {
          helloReply = parsed;
          if (typeof onBeforeSend === 'function') onBeforeSend();
          client.write(`${JSON.stringify(createDepth2Env)}\n`);
        } else {
          postHelloReplies.push(parsed);
        }
      }
    });
    client.on('close', () => {
      clearTimeout(timer);
      resolvePromise({ helloReply, postHelloReplies, closed: true });
    });
    client.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
  });
}

test('E2E-U20n-tile: outer tile renders inner surface frame via relay; cross-surface routing and depth-2 create are refused', async () => {
  const scratch = harness.makeScratch('mv-nested-u20n-tile');
  const shmBase = process.env.MV_SHM_DIR || '/dev/shm';
  const shmDir = mkdtempSync(join(shmBase, 'mv-nested-tile-'));
  chmodSync(shmDir, 0o700);
  const spawnedPids = [];
  let uiSub = null;
  try {
    const root = join(__dirname, '../..');
    const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
    const coreBin = buildCoreBinary(root);

    const outerRuntime = join(scratch, 'outer-runtime');
    const innerRuntime = join(scratch, 'inner-runtime');
    const outerState = join(scratch, 'outer-state');
    const innerState = join(scratch, 'inner-state');
    mkdirSync(outerRuntime, { mode: 0o700, recursive: true });
    mkdirSync(innerRuntime, { mode: 0o700, recursive: true });
    mkdirSync(outerState, { mode: 0o700, recursive: true });
    mkdirSync(innerState, { mode: 0o700, recursive: true });

    const outerCfg = writeCoreConfig(scratch, 'outer-tile-session', 'outer', version);
    const innerCfg = writeCoreConfig(scratch, 'inner-tile-session', 'inner', version);

    let outerStderr = '';
    const outerCore = spawn(coreBin, [], {
      cwd: scratch,
      env: {
        ...process.env,
        MV_CORE_CONFIG: outerCfg.configPath,
        XDG_RUNTIME_DIR: outerRuntime,
        XDG_STATE_HOME: outerState,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawnedPids.push(outerCore.pid);
    outerCore.stderr.setEncoding('utf8');
    outerCore.stderr.on('data', (chunk) => {
      outerStderr += chunk;
    });

    const innerCore = spawn(coreBin, [], {
      cwd: scratch,
      env: {
        ...process.env,
        MV_CORE_CONFIG: innerCfg.configPath,
        XDG_RUNTIME_DIR: innerRuntime,
        XDG_STATE_HOME: innerState,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawnedPids.push(innerCore.pid);

    const outerSock = join(outerRuntime, 'metaviewer/core.sock');
    const innerSock = join(innerRuntime, 'metaviewer/core.sock');
    assert.notEqual(outerSock, innerSock);

    // Step 1: With both cores live, publish a synthetic inner RGB24 frame tagged with the inner surface id.
    const innerSurfaceId = 'cap-inner-live';
    const width = 4;
    const height = 4;
    const rgbBytes = Buffer.alloc(width * height * 3);
    for (let i = 0; i < rgbBytes.length; i += 3) {
      rgbBytes[i] = (i * 17 + 29) & 0xff;
      rgbBytes[i + 1] = (i * 43 + 97) & 0xff;
      rgbBytes[i + 2] = (i * 71 + 181) & 0xff;
    }
    const frameSha256 = createHash('sha256').update(rgbBytes).digest('hex');
    const ramwsPath = join(shmDir, 'inner-surface-gen7.rgb');
    writeFileSync(ramwsPath, rgbBytes, { mode: 0o600 });
    chmodSync(ramwsPath, 0o600);

    const innerFrameRef = {
      schema: 'frame_ref/v0.2',
      surface_id: innerSurfaceId,
      generation: 7,
      tick: 7,
      ts_ns: 7000,
      width,
      height,
      format: 'rgb24',
      ramws_path: ramwsPath,
      sha256: frameSha256,
      capture_us: 250,
    };

    uiSub = connectUiSubscriber({
      sockPath: outerSock,
      config: outerCfg.config,
      expectedSurfaceId: innerSurfaceId,
      expectedGeneration: 7,
    });
    const uiHello = await uiSub.ready;
    assert.equal(uiHello.body.component, 'core');

    const innerHello = await publishCapsuleWithFrame({
      sockPath: innerSock,
      config: innerCfg.config,
      surfaceId: innerSurfaceId,
      kind: 'desktop_capsule',
      profileId: 'prof-inner-1',
      geometry: { w: width, h: height },
      frameRef: innerFrameRef,
    });
    assert.equal(innerHello.body.component, 'core');

    const outerHello = await publishCapsuleWithFrame({
      sockPath: outerSock,
      config: outerCfg.config,
      surfaceId: innerSurfaceId,
      kind: 'desktop_capsule',
      profileId: 'prof-inner-1',
      geometry: { w: width, h: height },
      frameRef: innerFrameRef,
    });
    assert.equal(outerHello.body.component, 'core');

    const innerSessionDir = join(innerState, 'metaviewer/sessions/inner-tile-session');
    const outerSessionDir = join(outerState, 'metaviewer/sessions/outer-tile-session');
    const innerStateCommitted = await waitForJournalFrame(
      join(innerSessionDir, 'events/3.json'),
      innerSurfaceId,
      7,
      frameSha256,
    );
    const outerStateCommitted = await waitForJournalFrame(
      join(outerSessionDir, 'events/3.json'),
      innerSurfaceId,
      7,
      frameSha256,
    );
    assert.equal(innerStateCommitted.surfaces[innerSurfaceId].frame.sha256, frameSha256);
    assert.equal(outerStateCommitted.surfaces[innerSurfaceId].frame.sha256, frameSha256);
    assert.deepEqual(readFileSync(join(outerSessionDir, 'artifacts', frameSha256)), rgbBytes);

    const fannedOut = await uiSub.waitForFannedOutFrame();
    uiSub.close();
    uiSub = null;
    assert.equal(fannedOut.surface.surface_id, innerSurfaceId);
    assert.equal(fannedOut.frame.surface_id, innerSurfaceId);
    assert.equal(fannedOut.frame.generation, 7);
    assert.equal(fannedOut.frame.sha256, frameSha256);

    // Step 2: Drive the outer renderer tile scheduler through the existing relay path
    // and assert canvas RGB digest equals the published frame digest and projection admits generation.
    const fixturePath = join(scratch, 'electron-frame.json');
    writeFileSync(fixturePath, JSON.stringify({ frame: fannedOut.frame, surface: fannedOut.surface }));
    const goodRelay = runRelayProbe(root, fixturePath, join(scratch, 'relay-profile-good'));
    assert.equal(goodRelay.result.status, 0, JSON.stringify(goodRelay));
    assert.equal(goodRelay.relay.tile, 'PASS');
    assert.equal(goodRelay.relay.authority_delivered, true);
    assert.equal(goodRelay.relay.ok, true);
    assert.equal(goodRelay.relay.sha256, frameSha256);
    assert.equal(goodRelay.relay.generation, 7);
    assert.equal(goodRelay.relay.presentCount, 1);
    assert.equal(goodRelay.relay.path_stripped, true);

    const wallSummary = harness.validateWallReport(
      {
        schema: 'e2e-wall-report/v1',
        phase: 'wall',
        errors: [],
        tiles: [{ capsuleId: innerSurfaceId, visible: true, frameId: goodRelay.relay.sha256 }],
      },
      { minTiles: 1, frameOwners: new Map([[frameSha256, innerSurfaceId]]) },
    );
    assert.equal(wallSummary.visible, 1);

    // Negative control 1: frame retagged to another surface id is refused (cross-capsule routing).
    assert.throws(
      () =>
        harness.validateWallReport(
          {
            schema: 'e2e-wall-report/v1',
            phase: 'wall',
            errors: [],
            tiles: [{ capsuleId: 'cap-outer-foreign', visible: true, frameId: frameSha256 }],
          },
          { minTiles: 1, frameOwners: new Map([[frameSha256, innerSurfaceId]]) },
        ),
      { code: 'E2E_ROUTING' },
    );
    const crossFixturePath = join(scratch, 'electron-frame-cross.json');
    writeFileSync(
      crossFixturePath,
      JSON.stringify({
        frame: { ...fannedOut.frame, surface_id: 'cap-outer-foreign' },
        surface: fannedOut.surface,
      }),
    );
    const badRelay = runRelayProbe(root, crossFixturePath, join(scratch, 'relay-profile-bad'));
    assert.equal(badRelay.result.status, 1, JSON.stringify(badRelay));
    assert.equal(badRelay.relay.tile, 'FAIL');
    assert.match(badRelay.relay.error, /SURFACE_STATE/);

    // Step 3 & Negative control 2: send a nested create with depth 2 via the core socket
    // and assert typed refusal with no surface committed to the journal and event count unchanged.
    const outerJournalPath = join(outerSessionDir, 'journal.jsonl');
    const outerEventsDir = join(outerSessionDir, 'events');
    let journalBefore = [];
    let eventsBefore = [];
    const depth2Attempt = await sendDepthTwoCreate({
      sockPath: outerSock,
      config: outerCfg.config,
      profileId: 'prof-depth2',
      onBeforeSend() {
        journalBefore = readFileSync(outerJournalPath, 'utf8').trim().split('\n');
        eventsBefore = readdirSync(outerEventsDir).sort();
      },
    });
    assert.equal(depth2Attempt.helloReply.body.component, 'core');
    assert.equal(depth2Attempt.postHelloReplies.length, 0);
    assert.equal(depth2Attempt.closed, true);

    const stderrDeadline = Date.now() + 5000;
    while (!/Decode\(InvalidField\)/.test(outerStderr) && Date.now() < stderrDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(outerStderr, /Decode\(InvalidField\)/);

    const journalAfter = readFileSync(outerJournalPath, 'utf8').trim().split('\n');
    const eventsAfter = readdirSync(outerEventsDir).sort();
    assert.equal(journalAfter.length, journalBefore.length, 'depth-2 create must leave journal record count unchanged');
    assert.deepEqual(eventsAfter, eventsBefore, 'depth-2 create must leave journal event count unchanged');

    const latestOuterState = JSON.parse(
      readFileSync(join(outerEventsDir, `${eventsAfter.length}.json`), 'utf8'),
    ).state;
    assert.deepEqual(Object.keys(latestOuterState.surfaces), [innerSurfaceId]);
    assert.equal(latestOuterState.surfaces['prof-depth2'], undefined);
    assert.equal(outerCore.exitCode, null, 'outer core must stay live after depth-2 refusal');
    assert.equal(innerCore.exitCode, null, 'inner core must stay live after depth-2 refusal');
  } finally {
    if (uiSub) uiSub.close();
    for (const pid of spawnedPids) {
      if (typeof pid === 'number' && pid > 1) {
        try {
          await harness.terminate(pid);
        } catch {
          // Best-effort cleanup of test child processes.
        }
      }
    }
    rmSync(shmDir, { recursive: true, force: true });
    harness.removeScratch(scratch);
  }
});
