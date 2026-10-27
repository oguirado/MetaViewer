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
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
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
        return { result, report: JSON.parse(readFileSync(report, 'utf8')), profileDir: join(subDir, `profile-${depth}`) };
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
    assert.equal(existsSync(innerDisplay.profileDir), true);

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
          harness.terminate(pid);
        } catch {
          // Best-effort cleanup of test child processes.
        }
      }
    }
    harness.removeScratch(scratch);
  }
});
