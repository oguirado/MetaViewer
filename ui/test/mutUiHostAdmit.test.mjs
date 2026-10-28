import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installAuthorityWire } from '../electron/authorityWire.js';
import { createMainBindings } from '../electron/hostBindings.js';
import { createPreloadFacade } from '../electron/preload.js';

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

test('createMainBindings refuses clicks with y >= height as SCHEMA while admitting in-bounds clicks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mv-mut-uihost-admit-'));
  const configDir = join(root, 'config');
  await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const socketPath = join(root, 'metaviewer', 'core.sock');
  const configPath = join(root, 'config.json');
  const config = {
    session_id: 'mut-uihost-admit-session',
    core: registration('core'),
    peers: [registration('ui')],
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  const receivedFromHost = [];
  const surfaces = new Map([['s1', makeSurface('s1', 'agent', 'active', 320, 200)]]);
  const sockets = new Set();
  let serverSeq = 0;
  let activeConn = null;

  const sendToHost = (conn, body) => {
    if (!conn || conn.destroyed) return;
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
        if (body.schema === 'ui_intent/v0.2' && body.op === 'take_control') {
          const sid = body.params.surface_id;
          const next = { ...(surfaces.get(sid) ?? makeSurface(sid)), control: 'human' };
          surfaces.set(sid, next);
          sendToHost(conn, {
            schema: 'surface_event/v0.2',
            event: 'state_changed',
            data: { surface: next },
          });
          continue;
        }
        if (body.schema === 'surface_request/v0.2' && body.op === 'input') {
          sendToHost(conn, {
            schema: 'action_verdict/v0.2',
            proposal_id: body.params.proposal_id,
            decision: 'admitted',
            core_seq: serverSeq + 1,
          });
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
    frames: { subscribe: () => () => {} },
    env,
    argv: [],
  });
  const api = createPreloadFacade({
    transport: {
      nested: false,
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

  await api.authority.intent(
    JSON.stringify({
      schema: 'ui_intent/v0.2',
      request_id: 'take-s1',
      op: 'take_control',
      params: { surface_id: 's1' },
    }),
  );

  const countInputs = () =>
    receivedFromHost.filter((e) => e.body.schema === 'surface_request/v0.2' && e.body.op === 'input').length;

  // Click with y === height (200) while x (10) < width (320) must be refused as SCHEMA
  const atHeight = await api.input.send({
    schema: 'surface_input/v1',
    surface_id: 's1',
    stream_id: 1,
    seq: 1,
    events: [{ kind: 'click', x: 10, y: 200, button: 'left' }],
  });
  assert.deepEqual(atHeight, { ok: false, code: 'SCHEMA' });
  assert.equal(countInputs(), 0);

  // Click with y > height (201) while x < width must be refused as SCHEMA
  const overHeight = await api.input.send({
    schema: 'surface_input/v1',
    surface_id: 's1',
    stream_id: 1,
    seq: 1,
    events: [{ kind: 'click', x: 10, y: 201, button: 'left' }],
  });
  assert.deepEqual(overHeight, { ok: false, code: 'SCHEMA' });
  assert.equal(countInputs(), 0);

  // Click with x === width (320) while y < height must be refused as SCHEMA
  const atWidth = await api.input.send({
    schema: 'surface_input/v1',
    surface_id: 's1',
    stream_id: 1,
    seq: 1,
    events: [{ kind: 'click', x: 320, y: 10, button: 'left' }],
  });
  assert.deepEqual(atWidth, { ok: false, code: 'SCHEMA' });
  assert.equal(countInputs(), 0);

  // Click inside geometry at (width - 1, height - 1) = (319, 199) is admitted
  const inside = await api.input.send({
    schema: 'surface_input/v1',
    surface_id: 's1',
    stream_id: 1,
    seq: 1,
    events: [{ kind: 'click', x: 319, y: 199, button: 'left' }],
  });
  assert.deepEqual(inside, { ok: true, accepted: 1 });
  assert.equal(countInputs(), 1);
});
