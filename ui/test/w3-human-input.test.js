import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installAuthorityWire,
  SURFACE_INPUT_CHANNEL,
  SURFACE_INPUT_CODES,
  validateSurfaceInputBatch,
} from '../electron/authorityWire.js';
import { createMainBindings } from '../electron/hostBindings.js';
import { createPreloadFacade, installPreload } from '../electron/preload.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const registration = (component) => ({
  endpoint: { component, instance: `${component}-test` },
  hello: {
    schema: 'hello/v0.2',
    contract_version: 'v0.2',
    component,
    component_version: '0.1.2',
    component_commit: 'a'.repeat(40),
    dependencies: [],
  },
});

function makeSurface(surfaceId = 's1', control = 'agent', state = 'active', w = 320, h = 200) {
  return {
    schema: 'surface/v0.2',
    surface_id: surfaceId,
    kind: 'browser',
    display: ':99',
    geometry: { w, h },
    state,
    visibility: 'unfolded',
    control,
    profile_id: 'default',
  };
}

async function createFullStackFixture(t, { nested = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mv-w3-human-input-'));
  const configDir = join(root, 'config');
  await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const socketPath = join(root, 'metaviewer', 'core.sock');
  const configPath = join(root, 'config.json');
  const config = {
    session_id: 'w3-human-input-session',
    core: registration('core'),
    peers: [registration('ui')],
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  const receivedFromHost = [];
  const surfaces = new Map([
    ['s1', makeSurface('s1', 'agent', 'active', 320, 200)],
    ['s2', makeSurface('s2', 'agent', 'active', 320, 200)],
  ]);
  const sockets = new Set();
  let serverSeq = 0;
  let coreRefuseNextInput = null;
  let activeConn = null;

  const sendToHost = (conn, body) => {
    serverSeq += 1;
    conn.write(
      `${JSON.stringify({
        schema: 'envelope/v0.2',
        msg_id: `reply-${serverSeq}`,
        ts_ns: serverSeq * 1000,
        from: config.core.endpoint,
        to: config.peers[0].endpoint,
        session_id: config.session_id,
        seq: serverSeq,
        nonce: `nonce-${serverSeq}`,
        body,
      })}\n`,
    );
  };

  const server = createServer((conn) => {
    activeConn = conn;
    sockets.add(conn);
    conn.on('close', () => sockets.delete(conn));
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const env = JSON.parse(line);
        receivedFromHost.push(env);
        const body = env.body;
        if (body.schema === 'hello/v0.2') {
          sendToHost(conn, config.core.hello);
          for (const surface of surfaces.values()) {
            sendToHost(conn, {
              schema: 'surface_event/v0.2',
              event: 'created',
              data: { surface },
            });
          }
          continue;
        }
        if (body.schema === 'ui_intent/v0.2' && (body.op === 'take_control' || body.op === 'release_control')) {
          const sid = body.params.surface_id;
          const prev = surfaces.get(sid) ?? makeSurface(sid);
          const next = {
            ...prev,
            control: body.op === 'take_control' ? 'human' : 'agent',
          };
          surfaces.set(sid, next);
          sendToHost(conn, {
            schema: 'surface_event/v0.2',
            event: 'state_changed',
            data: { surface: next },
          });
          continue;
        }
        if (body.schema === 'surface_request/v0.2' && body.op === 'input') {
          if (coreRefuseNextInput) {
            const reasonCode = coreRefuseNextInput;
            coreRefuseNextInput = null;
            sendToHost(conn, {
              schema: 'action_verdict/v0.2',
              proposal_id: body.params.proposal_id,
              decision: 'refused',
              reason_code: reasonCode,
              core_seq: serverSeq + 1,
            });
          } else {
            sendToHost(conn, {
              schema: 'action_verdict/v0.2',
              proposal_id: body.params.proposal_id,
              decision: 'admitted',
              core_seq: serverSeq + 1,
            });
          }
        }
      }
    });
  });

  server.listen(socketPath);
  await once(server, 'listening');
  await chmod(socketPath, 0o600);

  const env = {
    XDG_RUNTIME_DIR: root,
    XDG_CONFIG_HOME: configDir,
    MV_CORE_CONFIG: configPath,
  };
  const createMessageChannel = () => {
    const port1 = new EventEmitter();
    Object.assign(port1, { postMessage() {}, start() {}, close() {} });
    const port2 = { close() {} };
    return { port1, port2 };
  };
  const host = await createMainBindings({ env, createMessageChannel });
  const handlers = new Map();
  const frame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false, postMessage() {} };
  const event = { sender: contents, senderFrame: frame };
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const wire = installAuthorityWire({
    ipcMain,
    contents,
    core: host.core,
    frames: host.wire.frames,
    env,
    argv: nested ? ['--nested-depth=1'] : [],
  });
  const api = createPreloadFacade({
    transport: {
      nested,
      invoke: (channel, args) => handlers.get(channel)(event, ...args),
      subscribe: () => () => {},
    },
    bridge: { exposeInMainWorld() {} },
  });

  t.after(async () => {
    await wire.dispose();
    await host.core.dispose();
    for (const s of sockets) s.destroy();
    activeConn?.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  return {
    api,
    handlers,
    event,
    host,
    receivedFromHost,
    emitSurfaceState(surface) {
      surfaces.set(surface.surface_id, surface);
      if (activeConn) {
        sendToHost(activeConn, {
          schema: 'surface_event/v0.2',
          event: 'state_changed',
          data: { surface },
        });
      }
    },
    setCoreRefuseNextInput(reasonCode) {
      coreRefuseNextInput = reasonCode;
    },
  };
}

test('W3-HUMAN-INPUT-R3 contract schema: contracts/v0.2/surface_input.schema.json and examples pass check_contracts validator and variant coverage', async () => {
  const script = [
    'from pathlib import Path',
    'from tools import check_contracts as cc',
    'root = Path.cwd()',
    'errors = cc.check_repository(root)',
    'assert not errors, f"check_repository errors: {errors}"',
    'validator = cc.Validator(root / "contracts/v0.2")',
    'schema = validator.load("surface_input.schema.json")',
    'positives = []',
    'for p in sorted((root / "contracts/examples/v0.2").glob("surface_input.valid*.json")):',
    '    val = cc.loads_strict(p.read_text())',
    '    validator.validate(val, schema)',
    '    positives.append(val)',
    'assert positives, "expected at least one valid example"',
    'missing = cc.variant_coverage(validator, schema, positives)',
    'assert not missing, f"unwitnessed variants: {missing}"',
    'negatives = sorted((root / "contracts/examples/v0.2").glob("surface_input.invalid*.json"))',
    'assert negatives, "expected invalid examples"',
    'for p in negatives:',
    '    val = cc.loads_strict(p.read_text())',
    '    try:',
    '        validator.validate(val, schema)',
    '    except cc.ValidationError:',
    '        continue',
    '    raise AssertionError(f"expected failure for {p}")',
  ].join('\n');

  execFileSync('python3', ['-c', script], { cwd: REPO_ROOT, stdio: 'pipe' });

  const examplesDir = join(REPO_ROOT, 'contracts/examples/v0.2');
  const files = (await readdir(examplesDir)).filter((f) => f.startsWith('surface_input.')).sort();
  assert.ok(files.length >= 6);
  for (const file of files) {
    const parsed = JSON.parse(await readFile(join(examplesDir, file), 'utf8'));
    const checked = validateSurfaceInputBatch(parsed);
    if (file.includes('.valid')) {
      assert.equal(checked.ok, true, `expected ${file} to pass validateSurfaceInputBatch`);
    } else if (file.includes('.invalid')) {
      assert.equal(checked.ok, false, `expected ${file} to fail validateSurfaceInputBatch`);
      assert.equal(checked.code, 'SCHEMA');
    }
  }
});

test('W3-HUMAN-INPUT-R2: metaviewer.input.send(batch) accepts click, key, type, and scroll (dropping x,y) under human control', async (t) => {
  const f = await createFullStackFixture(t);
  assert.equal(SURFACE_INPUT_CHANNEL, 'metaviewer:authority.intent');
  assert.equal(typeof f.api.input?.send, 'function');
  assert.equal(Object.keys(f.api).includes('input'), true);
  assert.deepEqual(Object.keys(f.api.input), ['send']);
  assert.equal(Object.isFrozen(f.api.input), true);
  assert.equal('input' in f.api.authority, false);

  for (const frameDiag of [false, true]) {
    const installed = installPreload({
      frameDiag,
      contextBridge: { exposeInMainWorld() {} },
      ipcRenderer: {
        invoke: async () => true,
        on() {},
        removeListener() {},
      },
    });
    assert.equal(Object.keys(installed).includes('input'), true);
    assert.deepEqual(Object.keys(installed.input), ['send']);
    assert.equal(Object.isFrozen(installed.input), true);
  }

  await f.api.authority.intent(
    JSON.stringify({
      schema: 'ui_intent/v0.2',
      request_id: 'req-take-1',
      op: 'take_control',
      params: { surface_id: 's1' },
    }),
  );

  const res = await f.api.input.send({
    schema: 'surface_input/v1',
    surface_id: 's1',
    stream_id: 1,
    seq: 1,
    events: [
      { kind: 'click', x: 120, y: 44, button: 'left' },
      { kind: 'key', keys: ['Control_L', 'l'] },
      { kind: 'type', text: 'https://capsule.local/search?q=live' },
      { kind: 'scroll', dx: 0, dy: -120, x: 200, y: 100 },
    ],
  });
  assert.deepEqual(res, { ok: true, accepted: 4 });
  assert.equal(Object.isFrozen(res), true);

  const inputEnvelopes = f.receivedFromHost
    .map((env) => env.body)
    .filter((b) => b.schema === 'surface_request/v0.2' && b.op === 'input');
  assert.equal(inputEnvelopes.length, 4);
  assert.deepEqual(
    inputEnvelopes.map((e) => e.params.action),
    [
      { type: 'click', x: 120, y: 44, button: 'left' },
      { type: 'key', keys: ['Control_L', 'l'] },
      { type: 'type', text: 'https://capsule.local/search?q=live' },
      { type: 'scroll', dx: 0, dy: -120 },
    ],
  );
  for (const env of inputEnvelopes) {
    assert.equal(env.params.surface_id, 's1');
    assert.match(env.params.proposal_id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  }
});

test('W3-HUMAN-INPUT-R2 refusal codes: NOT_IN_CONTROL, SURFACE_UNKNOWN, STALE_STREAM, SCHEMA, and seq monotonicity', async (t) => {
  const f = await createFullStackFixture(t);
  assert.deepEqual(SURFACE_INPUT_CODES, [
    'NOT_IN_CONTROL',
    'SURFACE_UNKNOWN',
    'STALE_STREAM',
    'LIMIT',
    'NESTED_DISPLAY_ONLY',
    'SCHEMA',
    'CORE_UNAVAILABLE',
  ]);

  const countInputs = () =>
    f.receivedFromHost.filter((e) => e.body.schema === 'surface_request/v0.2' && e.body.op === 'input').length;

  // 1. NOT_IN_CONTROL when surface is agent-controlled.
  const notInControl = await f.api.input.send({
    schema: 'surface_input/v1',
    surface_id: 's1',
    stream_id: 1,
    seq: 1,
    events: [{ kind: 'key', keys: ['Return'] }],
  });
  assert.deepEqual(notInControl, { ok: false, code: 'NOT_IN_CONTROL' });
  assert.equal(countInputs(), 0);

  // 2. SURFACE_UNKNOWN when surface_id does not exist.
  const unknownSurface = await f.api.input.send({
    schema: 'surface_input/v1',
    surface_id: 'no-such-surface',
    stream_id: 1,
    seq: 1,
    events: [{ kind: 'key', keys: ['Return'] }],
  });
  assert.deepEqual(unknownSurface, { ok: false, code: 'SURFACE_UNKNOWN' });
  assert.equal(countInputs(), 0);

  // Take human control of s1.
  await f.api.authority.intent(
    JSON.stringify({
      schema: 'ui_intent/v0.2',
      request_id: 'req-take-2',
      op: 'take_control',
      params: { surface_id: 's1' },
    }),
  );

  // 3. STALE_STREAM when stream_id does not match active stream generation.
  const staleStream = await f.api.input.send({
    schema: 'surface_input/v1',
    surface_id: 's1',
    stream_id: 99,
    seq: 1,
    events: [{ kind: 'key', keys: ['Return'] }],
  });
  assert.deepEqual(staleStream, { ok: false, code: 'STALE_STREAM' });
  assert.equal(countInputs(), 0);

  // 4. Out-of-bounds click against surface geometry (320x200) -> SCHEMA.
  const oobClick = await f.api.input.send({
    schema: 'surface_input/v1',
    surface_id: 's1',
    stream_id: 1,
    seq: 1,
    events: [{ kind: 'click', x: 320, y: 10, button: 'left' }],
  });
  assert.deepEqual(oobClick, { ok: false, code: 'SCHEMA' });
  assert.equal(countInputs(), 0);

  // 5. Core refusal mappings: LOCKED_BY_OTHER -> NOT_IN_CONTROL, STALE_FRAME -> STALE_STREAM, BUDGET_EXCEEDED -> LIMIT.
  f.setCoreRefuseNextInput('LOCKED_BY_OTHER');
  assert.deepEqual(
    await f.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 1,
      events: [{ kind: 'key', keys: ['Return'] }],
    }),
    { ok: false, code: 'NOT_IN_CONTROL' },
  );

  f.setCoreRefuseNextInput('STALE_FRAME');
  assert.deepEqual(
    await f.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 1,
      events: [{ kind: 'key', keys: ['Return'] }],
    }),
    { ok: false, code: 'STALE_STREAM' },
  );

  f.setCoreRefuseNextInput('BUDGET_EXCEEDED');
  assert.deepEqual(
    await f.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 1,
      events: [{ kind: 'key', keys: ['Return'] }],
    }),
    { ok: false, code: 'LIMIT' },
  );

  // 6. Accept seq=2, then verify seq<=2 is refused with SCHEMA and seq=3 succeeds.
  assert.deepEqual(
    await f.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 2,
      events: [{ kind: 'type', text: 'ok' }],
    }),
    { ok: true, accepted: 1 },
  );
  assert.deepEqual(
    await f.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 2,
      events: [{ kind: 'type', text: 'replay' }],
    }),
    { ok: false, code: 'SCHEMA' },
  );
  assert.deepEqual(
    await f.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 1,
      events: [{ kind: 'type', text: 'regression' }],
    }),
    { ok: false, code: 'SCHEMA' },
  );
  assert.deepEqual(
    await f.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 3,
      events: [{ kind: 'type', text: 'next' }],
    }),
    { ok: true, accepted: 1 },
  );

  // 7. After release_control, human input is refused again with NOT_IN_CONTROL.
  await f.api.authority.intent(
    JSON.stringify({
      schema: 'ui_intent/v0.2',
      request_id: 'req-release-2',
      op: 'release_control',
      params: { surface_id: 's1' },
    }),
  );
  assert.deepEqual(
    await f.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 4,
      events: [{ kind: 'key', keys: ['a'] }],
    }),
    { ok: false, code: 'NOT_IN_CONTROL' },
  );

  // 8. Destroyed surface returns SURFACE_UNKNOWN.
  f.emitSurfaceState(makeSurface('s1', 'human', 'destroyed', 320, 200));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    await f.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 5,
      events: [{ kind: 'key', keys: ['a'] }],
    }),
    { ok: false, code: 'SURFACE_UNKNOWN' },
  );
});

test('W3-HUMAN-INPUT-R2 limits, NESTED_DISPLAY_ONLY, CORE_UNAVAILABLE, and closed schema negative controls', async (t) => {
  const f = await createFullStackFixture(t);
  await f.api.authority.intent(
    JSON.stringify({
      schema: 'ui_intent/v0.2',
      request_id: 'req-take-limits',
      op: 'take_control',
      params: { surface_id: 's1' },
    }),
  );
  await f.api.authority.intent(
    JSON.stringify({
      schema: 'ui_intent/v0.2',
      request_id: 'req-take-limits-s2',
      op: 'take_control',
      params: { surface_id: 's2' },
    }),
  );

  // 1. > 32 events per batch -> LIMIT.
  const tooManyEvents = Array.from({ length: 33 }, () => ({ kind: 'key', keys: ['a'] }));
  assert.deepEqual(
    await f.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 1,
      events: tooManyEvents,
    }),
    { ok: false, code: 'LIMIT' },
  );

  // 2. Payload > 16 KiB -> LIMIT (both multi-event >16 KiB and single large payload >16 KiB).
  const multiEvent16k = Array.from({ length: 20 }, () => ({ kind: 'type', text: 'x'.repeat(900) }));
  assert.deepEqual(
    await f.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 1,
      events: multiEvent16k,
    }),
    { ok: false, code: 'LIMIT' },
  );
  assert.deepEqual(
    await f.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 1,
      events: [{ kind: 'type', text: 'x'.repeat(17000) }],
    }),
    { ok: false, code: 'LIMIT' },
  );

  // 3. Single type event > 1024 chars (under 16 KiB batch cap) -> SCHEMA.
  assert.deepEqual(
    await f.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 1,
      events: [{ kind: 'type', text: 'x'.repeat(1025) }],
    }),
    { ok: false, code: 'SCHEMA' },
  );

  // 4. Malformed batches -> SCHEMA with 0 core envelopes.
  const badBatches = [
    null,
    undefined,
    42,
    '{}',
    [],
    { schema: 'human_input/v1', surface_id: 's1', stream_id: 1, seq: 1, events: [{ kind: 'key', keys: ['a'] }] },
    { schema: 'surface_input/v1', surface_id: '../escape', stream_id: 1, seq: 1, events: [{ kind: 'key', keys: ['a'] }] },
    { schema: 'surface_input/v1', surface_id: 's1', stream_id: -1, seq: 1, events: [{ kind: 'key', keys: ['a'] }] },
    { schema: 'surface_input/v1', surface_id: 's1', stream_id: 1, seq: 0, events: [{ kind: 'key', keys: ['a'] }] },
    { schema: 'surface_input/v1', surface_id: 's1', stream_id: 1, seq: 1, events: [] },
    { schema: 'surface_input/v1', surface_id: 's1', stream_id: 1, seq: 1, extra: 1, events: [{ kind: 'key', keys: ['a'] }] },
    { schema: 'surface_input/v1', surface_id: 's1', stream_id: 1, seq: 1, events: [{ kind: 'move', x: 1, y: 2 }] },
    { schema: 'surface_input/v1', surface_id: 's1', stream_id: 1, seq: 1, events: [{ kind: 'key', keys: [] }] },
    { schema: 'surface_input/v1', surface_id: 's1', stream_id: 1, seq: 1, events: [{ kind: 'key', keys: Array(9).fill('a') }] },
    { schema: 'surface_input/v1', surface_id: 's1', stream_id: 1, seq: 1, events: [{ kind: 'key', keys: ['bad key!'] }] },
    { schema: 'surface_input/v1', surface_id: 's1', stream_id: 1, seq: 1, events: [{ kind: 'type', text: '' }] },
    { schema: 'surface_input/v1', surface_id: 's1', stream_id: 1, seq: 1, events: [{ kind: 'type', text: 'a\0b' }] },
    { schema: 'surface_input/v1', surface_id: 's1', stream_id: 1, seq: 1, events: [{ kind: 'click', x: -1, y: 0, button: 'left' }] },
    { schema: 'surface_input/v1', surface_id: 's1', stream_id: 1, seq: 1, events: [{ kind: 'click', x: 0, y: 0, button: 'fourth' }] },
    { schema: 'surface_input/v1', surface_id: 's1', stream_id: 1, seq: 1, events: [{ kind: 'scroll', dx: 0, dy: -10 }] },
  ];
  for (const bad of badBatches) {
    assert.deepEqual(await f.api.input.send(bad), { ok: false, code: 'SCHEMA' });
  }
  assert.deepEqual(await f.api.input.send(), { ok: false, code: 'SCHEMA' });

  // 5. Rate limit: <= 60 batches/s per surface -> first 60 pass, 61st returns LIMIT, while s2 still passes.
  for (let seq = 1; seq <= 60; seq += 1) {
    const ok = await f.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq,
      events: [{ kind: 'key', keys: ['a'] }],
    });
    assert.deepEqual(ok, { ok: true, accepted: 1 });
  }
  const rateLimited = await f.api.input.send({
    schema: 'surface_input/v1',
    surface_id: 's1',
    stream_id: 1,
    seq: 61,
    events: [{ kind: 'key', keys: ['a'] }],
  });
  assert.deepEqual(rateLimited, { ok: false, code: 'LIMIT' });

  const otherSurfaceOk = await f.api.input.send({
    schema: 'surface_input/v1',
    surface_id: 's2',
    stream_id: 1,
    seq: 1,
    events: [{ kind: 'key', keys: ['a'] }],
  });
  assert.deepEqual(otherSurfaceOk, { ok: true, accepted: 1 });

  // 6. NESTED_DISPLAY_ONLY in both preload and authorityWire.
  const nestedFixture = await createFullStackFixture(t, { nested: true });
  assert.deepEqual(
    await nestedFixture.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 1,
      events: [{ kind: 'key', keys: ['a'] }],
    }),
    { ok: false, code: 'NESTED_DISPLAY_ONLY' },
  );
  assert.deepEqual(
    await nestedFixture.handlers.get(SURFACE_INPUT_CHANNEL)(nestedFixture.event, {
      schema: 'surface_input/v1',
      surface_id: 's1',
      stream_id: 1,
      seq: 1,
      events: [{ kind: 'key', keys: ['a'] }],
    }),
    { ok: false, code: 'NESTED_DISPLAY_ONLY' },
  );

  // 7. CORE_UNAVAILABLE after core dispose.
  await f.host.core.dispose();
  assert.deepEqual(
    await f.api.input.send({
      schema: 'surface_input/v1',
      surface_id: 's2',
      stream_id: 1,
      seq: 2,
      events: [{ kind: 'key', keys: ['b'] }],
    }),
    { ok: false, code: 'CORE_UNAVAILABLE' },
  );
});
