import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createFrameReader } from '../electron/frameReader.js';
import { createPreloadFacade } from '../electron/preload.js';
import { createMainBindings } from '../electron/hostBindings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, '..', '..', 'tests', 'fixtures', 'frames_parity.json');
const FRAME_READER_PATH = join(HERE, '..', 'electron', 'frameReader.js');

// D8 NON-FINDING for box containment: frozen observation.schema.json has no such rule.
// JS observation decoder absence remains a separate peer finding.
export const FINDINGS = Object.freeze({
  'js_host_bindings:frame_ref_valid_width_8192': 'FINDING D2',
  'js_host_bindings:frame_ref_valid_max_16384': 'FINDING D2',
  'js_host_bindings:frame_ref_invalid_sha256_upper': 'FINDING D1',
  'js_host_bindings:frame_ref_invalid_sha256_nonhex64': 'FINDING D1',
  'js_host_bindings:frame_ref_invalid_unknown_stride': 'FINDING D3',
  'js_host_bindings:frame_ref_invalid_null_tick': 'FINDING D5',
  'js_host_bindings:frame_ref_invalid_null_format': 'FINDING D5',
  'js_host_bindings:frame_ref_invalid_null_sha256': 'FINDING D5',
  'js_host_bindings:frame_ref_invalid_ramws_overlong': 'FINDING D6',
  'js_host_bindings:frame_ref_invalid_ramws_9_segments': 'FINDING D6',
  'js_host_bindings:frame_ref_invalid_ramws_hidden_segment': 'FINDING D6',
  'js_observation:observation_valid_full': 'FINDING D8',
  'js_observation:observation_valid_minimal': 'FINDING D8',
  'js_observation:observation_invalid_null_vision': 'FINDING D8',
  'js_observation:observation_invalid_escape_changed_region': 'FINDING D8',
  'js_observation:observation_invalid_escape_element_bbox': 'FINDING D8',
});

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

async function decodeWithFrameReader(framePayload) {
  const rawSid = framePayload?.surface_id;
  const boundSid = typeof rawSid === 'string' && rawSid.length >= 1 && [...rawSid].length <= 128
    ? rawSid
    : 'surface-demo';
  let leaseRequested = false;
  const reader = createFrameReader({
    binding: {
      principal: 'parity-test',
      epoch: 1,
      surfaceId: boundSid,
      surfaceGeneration: 1,
    },
    limits: {
      maxFrameBytes: Number.MAX_SAFE_INTEGER,
      maxWidth: Number.MAX_SAFE_INTEGER,
      maxHeight: Number.MAX_SAFE_INTEGER,
      readTimeoutMs: 1000,
      maxConcurrentReads: 4,
    },
    pixelEnvironment: {
      environmentId: 'parity-env',
      zoom: 1,
      dpr: 1,
    },
    acquirePublishedLease() {
      leaseRequested = true;
      throw new Error('STOP_AT_LEASE');
    },
    onReleaseLease() {},
  });
  await reader.readFrame(framePayload);
  await reader.closeReader();
  return leaseRequested;
}

function decodeWithPreloadNotice(framePayload, surfaceTemplate) {
  /** @type {((value: any, ports?: any[]) => void) | null} */
  let notifyFrame = null;
  const facade = createPreloadFacade({
    transport: {
      invoke: () => Promise.resolve({ ok: true }),
      subscribe: (channel, cb) => {
        if (channel === 'metaviewer:authority.frames') {
          notifyFrame = cb;
        }
        return () => {};
      },
    },
    bridge: {
      exposeInMainWorld() {},
    },
  });
  const received = [];
  const unsubscribe = facade.authority.subscribeFrames((value) => {
    received.push(value);
  });
  const strippedFrame = { ...framePayload };
  delete strippedFrame.ramws_path;
  const surface = {
    ...surfaceTemplate,
    surface_id: typeof strippedFrame.surface_id === 'string' ? strippedFrame.surface_id : surfaceTemplate.surface_id,
    geometry: {
      w: typeof strippedFrame.width === 'number' && strippedFrame.width >= 1 ? strippedFrame.width : 800,
      h: typeof strippedFrame.height === 'number' && strippedFrame.height >= 1 ? strippedFrame.height : 600,
    },
  };
  notifyFrame?.({ frame_ref: strippedFrame, surface }, []);
  unsubscribe();
  return received.length === 1;
}

function registration(component) {
  return {
    endpoint: { component, instance: `${component}-parity` },
    hello: {
      schema: 'hello/v0.2',
      contract_version: 'v0.2',
      component,
      component_version: '0.1.2',
      component_commit: 'a'.repeat(40),
      dependencies: [],
    },
  };
}

async function decodeWithHostBindings(bodyPayload, surfaceTemplate) {
  const root = await mkdtemp(join(tmpdir(), 'mv-parity-hb-'));
  const config = {
    session_id: 'parity-session',
    core: registration('core'),
    peers: [registration('ui')],
  };
  await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  const sockets = new Set();
  /** @type {import('node:net').Socket | null} */
  let peer = null;
  let seq = 0;
  const peerClosed = new EventEmitter();

  const send = (body) => {
    if (!peer || peer.destroyed) return;
    seq += 1;
    peer.write(
      JSON.stringify({
        schema: 'envelope/v0.2',
        msg_id: `reply-${seq}`,
        ts_ns: seq * 1000,
        from: config.core.endpoint,
        to: config.peers[0].endpoint,
        session_id: config.session_id,
        seq,
        nonce: `nonce-${seq}`,
        body,
      }) + '\n',
    );
  };

  const server = createServer((socket) => {
    peer = socket;
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      peerClosed.emit('closed');
    });
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      let offset;
      while ((offset = buffer.indexOf('\n')) >= 0) {
        const env = JSON.parse(buffer.slice(0, offset));
        buffer = buffer.slice(offset + 1);
        if (env.body.schema === 'hello/v0.2') {
          send(config.core.hello);
        }
      }
    });
  });

  const sockPath = join(root, 'metaviewer/core.sock');
  server.listen(sockPath);
  await once(server, 'listening');
  await chmod(sockPath, 0o600);

  const createMessageChannel = () => {
    const port1 = new EventEmitter();
    Object.assign(port1, { postMessage() {}, start() {}, close() {} });
    const port2 = { close() {} };
    return { port1, port2 };
  };

  let bindings = null;
  try {
    bindings = await createMainBindings({
      env: { MV_CORE_CONFIG: configPath, XDG_RUNTIME_DIR: root },
      createMessageChannel,
    });
    const delivered = [];
    const deliveryEvent = new EventEmitter();
    bindings.wire.frames.subscribe((entry) => {
      delivered.push(entry);
      deliveryEvent.emit('entry', entry);
    });

    const sentinelSurface = {
      ...surfaceTemplate,
      surface_id: 'surface-sentinel',
    };
    send({ schema: 'surface_event/v0.2', event: 'created', data: { surface: surfaceTemplate } });
    send({ schema: 'surface_event/v0.2', event: 'created', data: { surface: sentinelSurface } });

    const done = new Promise((resolve) => {
      const onEntry = (entry) => {
        if (entry.frameRef?.surface_id === 'surface-sentinel') {
          cleanupListeners();
          resolve('sentinel');
        }
      };
      const onClose = () => {
        cleanupListeners();
        resolve('closed');
      };
      const cleanupListeners = () => {
        deliveryEvent.off('entry', onEntry);
        peerClosed.off('closed', onClose);
      };
      deliveryEvent.on('entry', onEntry);
      peerClosed.on('closed', onClose);
    });

    send(bodyPayload);
    send({
      schema: 'surface_event/v0.2',
      event: 'frame_ready',
      data: {
        frame_ref: {
          schema: 'frame_ref/v0.2',
          surface_id: 'surface-sentinel',
          generation: 1,
          tick: 1,
          ts_ns: 1000,
          width: 16,
          height: 16,
          format: 'rgb24',
          ramws_path: '/dev/shm/ramws/sentinel.rgb',
          sha256: 'b'.repeat(64),
          capture_us: 10,
        },
      },
    });

    const outcome = await done;
    if (outcome === 'closed') {
      return false;
    }
    return delivered.some((e) => e.frameRef?.surface_id !== 'surface-sentinel');
  } finally {
    bindings?.core?.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

test('JS decoders parity across shared frames_parity.json vectors', async (t) => {
  const fixture = loadFixture();
  assert.equal(fixture.schema, 'metaviewer.frames_parity/v1');
  assert.equal(fixture.contract_version, 'v0.2');
  assert.equal(fixture.vectors.length, 26);

  const recordedFindings = {};

  for (const vec of fixture.vectors) {
    const expectedAccept = vec.contract_verdict === 'accept';

    if (vec.family === 'frame_ref') {
      await t.test(`js_reader/${vec.id}`, async (sub) => {
        const actualAccept = await decodeWithFrameReader(vec.payload);
        const finding = FINDINGS[`js_reader:${vec.id}`];
        if (finding) {
          assert.notEqual(actualAccept, expectedAccept, `${finding} resolved on ${vec.id}`);
          recordedFindings[`js_reader:${vec.id}`] = finding;
          sub.skip(`${finding}: frameReader diverges from contract verdict ${vec.contract_verdict} on ${vec.id}`);
          return;
        }
        assert.equal(actualAccept, expectedAccept, `js_reader/${vec.id}`);
      });

      const touchesRamwsOnly = vec.id.startsWith('frame_ref_invalid_ramws_');
      if (!touchesRamwsOnly) {
        await t.test(`js_preload/${vec.id}`, (sub) => {
          const actualAccept = decodeWithPreloadNotice(vec.payload, fixture.surface_template);
          const finding = FINDINGS[`js_preload:${vec.id}`];
          if (finding) {
            assert.notEqual(actualAccept, expectedAccept, `${finding} resolved on ${vec.id}`);
            recordedFindings[`js_preload:${vec.id}`] = finding;
            sub.skip(`${finding}: preload validFrameNotice diverges from contract verdict ${vec.contract_verdict} on ${vec.id}`);
            return;
          }
          assert.equal(actualAccept, expectedAccept, `js_preload/${vec.id}`);
        });
      }

      await t.test(`js_host_bindings/${vec.id}`, async (sub) => {
        const actualAccept = await decodeWithHostBindings(vec.payload, fixture.surface_template);
        const finding = vec.findings.js_host_bindings;
        if (finding) {
          assert.notEqual(actualAccept, expectedAccept, `${finding} resolved on ${vec.id}`);
          recordedFindings[`js_host_bindings:${vec.id}`] = finding;
          sub.skip(`${finding}: hostBindings.publish diverges from contract verdict ${vec.contract_verdict} on ${vec.id}`);
          return;
        }
        assert.equal(actualAccept, expectedAccept, `js_host_bindings/${vec.id}`);
      });
    } else if (vec.family === 'surface_event' && vec.payload.event === 'frame_ready') {
      await t.test(`js_host_bindings/${vec.id}`, async () => {
        const actualAccept = await decodeWithHostBindings(vec.payload, fixture.surface_template);
        assert.equal(actualAccept, expectedAccept, `js_host_bindings/${vec.id}`);
      });
    } else if (vec.family === 'observation') {
      await t.test(`js_observation/${vec.id}`, (sub) => {
        const finding = vec.findings.js_observation;
        assert.equal(finding, 'FINDING D8');
        recordedFindings[`js_observation:${vec.id}`] = finding;
        sub.skip(`${finding}: JS observation/v0.2 decoder is AUSENTE on ${vec.id}`);
      });
    }
  }

  assert.deepEqual(recordedFindings, FINDINGS);
});

test('kills mutated frameReader accepting uppercase sha256', () => {
  // Mutation in ui/electron/frameReader.js:456:
  // replacing `!/^[0-9a-f]{64}$/.test(raw.sha256)` with `!/^[0-9a-fA-F]{64}$/.test(raw.sha256)`
  // so uppercase SHA-256 digests are accepted by admitFrameRef.
  const source = readFileSync(FRAME_READER_PATH, 'utf8');
  const target = '!/^[0-9a-f]{64}$/.test(raw.sha256)';
  assert.ok(source.includes(target), 'expected sha256 regex guard in frameReader.js');

  const startIdx = source.indexOf('function isNonNegativeInt(');
  const endIdx = source.indexOf('function assertReaderOptions(');
  assert.ok(startIdx > 0 && endIdx > startIdx);

  const snippet = source
    .slice(startIdx, endIdx)
    .replace(target, '!/^[0-9a-fA-F]{64}$/.test(raw.sha256)');

  const context = vm.createContext({
    Object,
    Array,
    Number,
    String,
    RegExp,
    SHM_PREFIX: '/dev/shm/',
    FRAME_REF_SCHEMA: 'frame_ref/v0.2',
    FRAME_REF_KEYS: 'capture_us,format,generation,height,ramws_path,schema,sha256,surface_id,tick,ts_ns,width',
    FRAME_REASONS: {
      INVALID_CONTRACT: 'INVALID_CONTRACT',
      INVALID_GENERATION: 'INVALID_GENERATION',
      INVALID_PATH: 'INVALID_PATH',
    },
    isRecord: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
    hasClosedKeys: (v, expected) =>
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      Object.getOwnPropertySymbols(v).length === 0 &&
      Object.keys(v).sort().join(',') === expected,
    refusal: (reason, detail) => ({ ok: false, reason, detail }),
    isPositiveInt: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1,
  });
  vm.runInContext(`${snippet}\nglobalThis.mutatedAdmitFrameRef = admitFrameRef;`, context);

  const fixture = loadFixture();
  const upperVec = fixture.vectors.find((v) => v.id === 'frame_ref_invalid_sha256_upper');
  assert.ok(upperVec);

  const mutatedOutcome = context.mutatedAdmitFrameRef(upperVec.payload);
  assert.equal(
    mutatedOutcome.ok,
    true,
    'mutated admitFrameRef accepts frame_ref_invalid_sha256_upper, which the parity suite refuses',
  );
});
