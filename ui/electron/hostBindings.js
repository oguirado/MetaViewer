// @ts-check
/** [TARGET, unit decision] Attach to the already running owner-only core socket
 * at $XDG_RUNTIME_DIR/metaviewer/core.sock, using the UI registration and core
 * hello pinned by MV_CORE_CONFIG (the live runner's ABI). Never spawn a guessed
 * binary. Intent success requires a matching core surface update; proposals
 * return the core verdict, including POLICY refusals on the UI lane.
 * [TARGET, unit decision] Capture export uses the disk_start carrier with the
 * sealed capture ID and host-owned destination grant, never a renderer path.
 * Bounds [TARGET, unit decision]: 1 MiB wire/config, 64 surfaces/pending calls,
 * 64 MiB frame, 4096 pixels per axis, 3 s request/hello deadline.
 * [TARGET, unit decision] Coalesce in-flight frame_ready deliveries per surface
 * to the max published generation so older out-of-order arrivals never overwrite
 * a newer pending generation; classify acquire failures with closed cause tokens
 * without paths or bytes; record per-(surface, seq) applied-prefix progress floor
 * so retried partially-applied input batches skip already-applied prefix primitives.
 * [TARGET, unit decision] Store and expose requestedWallFps on host bindings and
 * default capture recording max_fps to recordingFps (default 3) unless overridden per request.
 */
import { createSettingsStore, DEFAULT_SETTINGS, INTENT_OPS, mapSurfaceInputRefusal, recordingDestination, validateIntentBody, validateProposalBody, validateSettings, validateSurfaceInputBatch } from './authorityWire.js';
export { INTENT_OPS };
import { createTerminalHost } from './terminalHost.js';
import { assertCaptureCall, assertCaptureReply, validCaptureState } from './captureBridge.js';
import { createConnection } from 'node:net';
import { spawnSync } from 'node:child_process';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const MAX_WIRE = 1024 * 1024, MAX_FRAME = 64 * 1024 * 1024, MAX_ITEMS = 64, DEADLINE = 3000;
const MAX_SURFACE_INPUT_QUEUE_EVENTS = 256, MAX_ADAPTER_TYPE_TEXT_BYTES = 16384;
const fail = () => new Error('CORE_SEAMS_ABSENT');
/** @param {string} cause @param {string} [msg] */
function acquireFail(cause, msg = 'CORE_SEAMS_ABSENT') {
  const err = new Error(`${msg}: ${cause}`);
  /** @type {any} */ (err).causeCode = cause;
  return err;
}
/** @param {unknown} error */
function mapOpenError(error) {
  if (error && typeof error === 'object' && typeof /** @type {any} */ (error).causeCode === 'string') {
    return /** @type {Error} */ (error);
  }
  const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
  if (code === 'ENOENT') return acquireFail('OPEN_ENOENT');
  if (code === 'ELOOP' || code === 'ENOTDIR') return acquireFail('OPEN_SYMLINK');
  if (code === 'EACCES' || code === 'EPERM') return acquireFail('OPEN_EACCES');
  return acquireFail('OPEN_IO');
}
const PEERCRED_PY = [
  'import os, socket, struct, sys',
  's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM, 0, 3)',
  'pid, uid, gid = struct.unpack("3i", s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))',
  'cino = os.fstat(3).st_ino & 0xffffffff',
  's.detach()',
  'nl = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 4)',
  'nl.bind((0, 0))',
  'req = struct.pack("=BBHIIIII", socket.AF_UNIX, 0, 0, 0xfff, 0, 6, 0, 0)',
  'nl.send(struct.pack("=IHHII", 16 + len(req), 20, 0x301, 1, 0) + req)',
  'table, done = {}, False',
  'while not done:',
  '    data = nl.recv(65536)',
  '    pos = 0',
  '    while pos + 16 <= len(data):',
  '        nllen, nltype, flags, seq, rpid = struct.unpack_from("=IHHII", data, pos)',
  '        if nltype in (2, 3): done = True; break',
  '        if nltype == 20:',
  '            m_ino = struct.unpack_from("=I", data, pos + 20)[0]',
  '            apos, vfs, peer = pos + 32, None, None',
  '            while apos + 4 <= pos + nllen:',
  '                alen, atype = struct.unpack_from("=HH", data, apos)',
  '                if alen < 4: break',
  '                p = data[apos+4:apos+alen]',
  '                if atype == 1 and len(p) >= 8: vfs = struct.unpack_from("=II", p, 0)[0]',
  '                elif atype == 2 and len(p) >= 4: peer = struct.unpack_from("=I", p, 0)[0]',
  '                apos += (alen + 3) & ~3',
  '            table[m_ino] = (vfs, peer)',
  '        pos += (nllen + 3) & ~3',
  'nl.close()',
  'peer_ino = table.get(cino, (None, None))[1]',
  'vfs_ino = table.get(peer_ino, (None, None))[0]',
  'if vfs_ino is None: sys.exit(1)',
  'print(f"{pid}:{uid}:{gid}:{vfs_ino}")',
].join('\n');
/** Authenticate the connected unix domain socket peer via SO_PEERCRED and kernel peer VFS inode.
 * @param {import('node:net').Socket} socket
 * @returns {{pid:number,uid:number,gid:number,ino:number}} */
export function readPeerCredentials(socket) {
  const fd = /** @type {any} */ (socket)?._handle?.fd;
  if (!Number.isInteger(fd) || fd < 0) throw fail();
  const res = spawnSync('/usr/bin/python3', ['-S', '-c', PEERCRED_PY], {
    stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8', timeout: DEADLINE,
    env: {PATH: '/usr/bin:/bin'},
  });
  if (res.status !== 0 || typeof res.stdout !== 'string') throw fail();
  const parts = res.stdout.trim().split(':').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n))) throw fail();
  const [pid, uid, gid, ino] = parts;
  return Object.freeze({pid, uid, gid, ino});
}
/** @param {any} info @param {number} mode */
function owned(info, mode) {
  if (typeof process.getuid !== 'function' || info.uid !== process.getuid() || (info.mode & 0o777) !== mode) throw fail();
}
/** Pin every directory, including intermediate components, against symlinks.
 * /proc/self/fd anchors openat-like access on the Linux host, as in core.
 * @param {string} path */
async function openPinned(path) {
  if (!isAbsolute(path) || path.split('/').some(x => x === '..' || x === '.')) throw acquireFail('OPEN_PATH');
  const parts = path.split('/').filter(Boolean);
  let dir;
  try {
    dir = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    throw mapOpenError(error);
  }
  try {
    for (const part of parts.slice(0, -1)) {
      const next = await open(`/proc/self/fd/${dir.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await dir.close(); dir = next;
    }
    return await open(`/proc/self/fd/${dir.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw mapOpenError(error);
  } finally { await dir.close(); }
}

/** Trusted options are host-only; no renderer pathname or capability is accepted.
 * @param {{env?:NodeJS.ProcessEnv,createMessageChannel?:()=>any,getPeerCredentials?:(socket:import('node:net').Socket)=>{pid:number,uid:number,gid:number,ino:number},inputDeadlineMs?:number}} [options]
 * @returns {Promise<{core: any, wire: any}>} */
export async function createMainBindings({env = process.env, createMessageChannel, getPeerCredentials = readPeerCredentials, inputDeadlineMs = DEADLINE} = {}) {
  /** @type {import('node:net').Socket | undefined} */ let socket;
  try {
    if (!env.MV_CORE_CONFIG || !isAbsolute(env.MV_CORE_CONFIG) || !env.XDG_RUNTIME_DIR || !isAbsolute(env.XDG_RUNTIME_DIR)) throw fail();
    for (const path of [env.XDG_RUNTIME_DIR, join(env.XDG_RUNTIME_DIR, 'metaviewer')]) {
      const info = await lstat(path); owned(info, 0o700); if (!info.isDirectory() || info.isSymbolicLink()) throw fail();
    }
    const socketPath = join(env.XDG_RUNTIME_DIR, 'metaviewer/core.sock');
    const socketInfo = await lstat(socketPath); owned(socketInfo, 0o600); if (!socketInfo.isSocket()) throw fail();
    const file = await openPinned(env.MV_CORE_CONFIG);
    /** @type {any} */ let config;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) || info.size > MAX_WIRE) throw fail();
      const bytes = Buffer.alloc(MAX_WIRE + 1); const {bytesRead} = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_WIRE) throw fail();
      config = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    } finally { await file.close(); }
    const id = (/** @type {any} */ value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
    const endpoint = (/** @type {any} */ value, /** @type {string} */ component) => value?.component === component && id(value.instance) && Object.keys(value).sort().join(',') === 'component,instance';
    const hello = (/** @type {any} */ reg, /** @type {string} */ component) => endpoint(reg?.endpoint, component)
      && reg.hello?.schema === 'hello/v0.2' && reg.hello.contract_version === 'v0.2' && reg.hello.component === component
      && typeof reg.hello.component_version === 'string' && /^[0-9a-f]{40}$/.test(reg.hello.component_commit)
      && Array.isArray(reg.hello.dependencies);
    const peers = config.peers?.filter((/** @type {any} */ peer) => peer?.endpoint?.component === 'ui');
    if (!id(config.session_id) || !hello(config.core, 'core') || peers?.length !== 1 || !hello(peers[0], 'ui')) throw fail();
    const ui = peers[0];
    const destination = recordingDestination(env);
    /** @type {any} */ let electronMod = null;
    if (!createMessageChannel || process.versions?.electron) {
      electronMod = /** @type {any} */ (await import('electron'));
      if (!createMessageChannel) {
        if (typeof electronMod.MessageChannelMain !== 'function') throw fail();
        createMessageChannel = () => new electronMod.MessageChannelMain();
      }
    }
    const channelFactory = createMessageChannel;
    const clipboardMod = electronMod?.clipboard ?? { writeText() {} };
    const terminal = createTerminalHost({ createMessageChannel: channelFactory, clipboard: clipboardMod, env });
    electronMod?.app?.once?.('before-quit', () => { void terminal.dispose(); });
    /** @type {Set<(entry:any)=>any>} */ const listeners = new Set();
    /** @type {Map<string,any>} */ const surfaces = new Map();
    /** @type {Map<string,any>} */ const latestFrames = new Map();
    /** @type {Map<string,number>} */ const streamIds = new Map();
    /** @type {Map<string,any>} */ const channels = new Map();
    /** @type {Set<string>} */ const subscriptions = new Set();
    /** @type {Set<string>} */ const delivering = new Set();
    /** @type {Set<string>} */ const pendingDeliveries = new Set();
    /** @type {Map<string,number>} */ const failedFrameGenerations = new Map();
    /** @type {Map<string,{body:any,resolve:(value:any)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}>} */ const pending = new Map();
    /** @type {Map<string,{lastSeq:number,inFlightSeq:number,partialSeq:number,partialApplied:number,draining:boolean,queue:Array<{batch:any,events:any[],applied:number,resolve:(value:any)=>void}>}>} */ const surfaceInputQueues = new Map();
    const nonInputPendingCount = () => {
      let count = 0;
      for (const item of pending.values()) {
        if (!(item.body?.schema === 'surface_request/v0.2' && item.body?.op === 'input')) count += 1;
      }
      return count;
    };
    let live = false, disposed = false, seq = 0, received = 0, lastIntentReplySeq = 1;
    /** @type {number} */
    let requestedWallFps = DEFAULT_SETTINGS.wallFps;
    /** @type {number} */
    let recordingFps = DEFAULT_SETTINGS.recordingFps;
    /** @type {number | null} */
    let explicitRecordingFps = null;
    /** @type {ReturnType<typeof createSettingsStore> | null} */
    let settingsStore = null;
    if (typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.length > 0) {
      try {
        settingsStore = createSettingsStore(env);
        const initialSettings = await settingsStore.load().catch(() => null);
        if (typeof initialSettings === 'string') {
          const parsed = validateSettings(initialSettings);
          requestedWallFps = parsed.wallFps;
          recordingFps = parsed.recordingFps;
        }
      } catch {
        settingsStore = null;
      }
    }
    /** @type {Set<(cadence: { wallFps: number }) => void>} */
    const cadenceListeners = new Set();
    /** @param {{ wallFps?: unknown, recordingFps?: unknown }} cadence */
    const applyCadence = (cadence) => {
      if (!cadence || typeof cadence !== 'object') throw new Error('SETTINGS_WALL_FPS');
      if (cadence.wallFps !== undefined) {
        if (typeof cadence.wallFps !== 'number' || !Number.isSafeInteger(cadence.wallFps) || ![3, 30, 60].includes(cadence.wallFps)) {
          throw new Error('SETTINGS_WALL_FPS');
        }
        requestedWallFps = cadence.wallFps;
        const notice = Object.freeze({ wallFps: requestedWallFps });
        for (const notify of [...cadenceListeners]) {
          try { notify(notice); } catch {}
        }
      }
      if (cadence.recordingFps !== undefined) {
        if (typeof cadence.recordingFps !== 'number' || !Number.isSafeInteger(cadence.recordingFps) || cadence.recordingFps < 1 || cadence.recordingFps > 60) {
          throw new Error('SETTINGS_RECORDING_FPS');
        }
        recordingFps = cadence.recordingFps;
        explicitRecordingFps = cadence.recordingFps;
      }
    };
    /** @type {ReturnType<typeof setInterval> | undefined} */ let keepalive;
    /** @type {(value?:any)=>void} */ let ready;
    /** @type {(error:Error)=>void} */ let rejectReady;
    const handshake = new Promise((resolve,reject) => {ready=resolve;rejectReady=reject;});
    // Attach the rejection handler before any socket callbacks can fire.
    void handshake.catch(() => {});
    const shutdown = () => {
      clearTimeout(helloTimer); clearInterval(keepalive);
      if (disposed) return; disposed = true; live = false;
      void terminal.dispose();
      rejectReady(fail()); socket?.destroy();
      for (const item of pending.values()) {clearTimeout(item.timer);item.reject(fail());} pending.clear();
      for (const qState of surfaceInputQueues.values()) {
        const queued = qState.queue.splice(0, qState.queue.length);
        for (const item of queued) item.resolve(Object.freeze({ ok: false, code: 'CORE_UNAVAILABLE' }));
      }
      surfaceInputQueues.clear();
      for (const channel of channels.values()) {channel.port1.close();channel.port2.close();}
      channels.clear();surfaces.clear();latestFrames.clear();streamIds.clear();subscriptions.clear();delivering.clear();pendingDeliveries.clear();failedFrameGenerations.clear();listeners.clear();captureListeners.clear();cadenceListeners.clear();
    };
    /** @type {Set<(state:any)=>void>} */ const captureListeners = new Set();
    const helloTimer = setTimeout(shutdown, DEADLINE);
    /** @param {any} body @param {string} [messageId] */
    function send(body, messageId = undefined) {
      if (disposed || !socket || !Number.isSafeInteger(++seq)) throw fail();
      const value = {schema:'envelope/v0.2',msg_id:messageId || body.request_id || body.proposal_id || randomUUID(),ts_ns:0,
        from:ui.endpoint,to:config.core.endpoint,session_id:config.session_id,seq,nonce:randomUUID(),body};
      const line = JSON.stringify(value) + '\n'; if (Buffer.byteLength(line) > MAX_WIRE || socket.writableLength > MAX_WIRE) throw fail();
      socket.write(line);
    }
    /** @param {any} published @param {any} state */
    function buildFrameEntry(published, state) {
      let channel = channels.get(published.surface_id);
      if (!channel) {
        if (channels.size >= MAX_ITEMS) throw fail();
        channel = channelFactory();channels.set(published.surface_id, channel);
      }
      const binding = Object.freeze({principal:'ui',epoch:1,surfaceId:published.surface_id,surfaceGeneration:1});
      return {frameRef:published,state:{...state},rendererPorts:[channel.port2],
        /** @param {number} gen */
        onStreamAnnounced(gen) {
          if (Number.isSafeInteger(gen) && gen >= 1) streamIds.set(published.surface_id, gen);
        },
        resolveLatestState() {
          const curState = surfaces.get(published.surface_id);
          return curState ? {...curState} : null;
        },
        resolveLatestEntry() {
          const latest = latestFrames.get(published.surface_id);
          const curState = surfaces.get(published.surface_id);
          if (latest && curState && curState.state === 'active' && latest.generation > published.generation) {
            pendingDeliveries.delete(published.surface_id);
            return buildFrameEntry(latest, curState);
          }
          if (curState && !isDeepStrictEqual(curState, state)) {
            return buildFrameEntry(published, curState);
          }
          return null;
        },
        readerOptions:{binding,limits:{maxFrameBytes:MAX_FRAME,maxWidth:4096,maxHeight:4096,readTimeoutMs:1000,maxConcurrentReads:1},
          pixelEnvironment:{environmentId:config.session_id,zoom:1,dpr:1},onReleaseLease(){},
          /** @param {any} request */
          async acquirePublishedLease(request) {
            if (disposed || !isDeepStrictEqual(request.binding,binding) || published.surface_id !== binding.surfaceId) {
              throw acquireFail('FRAME_BINDING', 'FRAME_BINDING');
            }
            if (!isDeepStrictEqual(request.frameRef,published)) {
              if (request.frameRef?.surface_id === published.surface_id
                  && Number.isSafeInteger(request.frameRef?.generation)
                  && request.frameRef.generation < published.generation) {
                throw acquireFail('STALE', 'FRAME_BINDING');
              }
              throw acquireFail('FRAME_BINDING', 'FRAME_BINDING');
            }
            let file;
            try {
              file = await openPinned(published.ramws_path);
            } catch (error) {
              failedFrameGenerations.set(published.surface_id, published.generation);
              throw error;
            }
            try {
              let info;
              try { info = await file.stat(); } catch { throw acquireFail('STAT_IO'); }
              if (!info.isFile()) throw acquireFail('STAT_NOT_FILE');
              if (info.uid !== process.getuid?.()) throw acquireFail('STAT_UID');
              if (info.mode & 0o022) throw acquireFail('STAT_MODE');
              if (info.size > MAX_FRAME) throw acquireFail('SIZE');
              let released = false;
              const release = async () => {if (!released) {released=true;await file.close();}};
              return {identity:{...binding,frameGeneration:published.generation,leaseId:randomUUID()},published:true,byteLength:info.size,
                /** @param {{maxBytes:number,signal:AbortSignal}} read */
                async readOwnedBytes({maxBytes,signal}) {
                  if (released || signal.aborted || request.signal.aborted || info.size > maxBytes) {
                    failedFrameGenerations.set(published.surface_id, published.generation);
                    throw fail();
                  }
                  const bytes = Buffer.alloc(info.size + 1);let offset = 0;
                  while (offset < bytes.length) {
                    if (signal.aborted || request.signal.aborted) {
                      failedFrameGenerations.set(published.surface_id, published.generation);
                      throw fail();
                    }
                    const {bytesRead} = await file.read(bytes,offset,bytes.length-offset,offset);
                    if (!bytesRead) break;offset += bytesRead;
                  }
                  if (offset !== info.size) {
                    failedFrameGenerations.set(published.surface_id, published.generation);
                    throw fail();
                  }
                  return new Uint8Array(bytes.subarray(0,offset));
                },
                /** @param {{reason?:string}} [req] */
                async release(req) {
                  if (req?.reason && req.reason !== 'SNAPSHOT_VERIFIED') {
                    failedFrameGenerations.set(published.surface_id, published.generation);
                  } else if (failedFrameGenerations.get(published.surface_id) === published.generation) {
                    failedFrameGenerations.delete(published.surface_id);
                  }
                  await release();
                }};
            } catch(error) {
              failedFrameGenerations.set(published.surface_id, published.generation);
              await file.close();throw error;
            }
          }},
        portOptions:{port:channel.port1,role:'sender',binding,limits:{maxFrameBytes:MAX_FRAME,ackTimeoutMs:10000,maxSurfacesPerPort:1},onReleaseLease(){},onRevoke(){if(channels.get(published.surface_id)===channel){channels.delete(published.surface_id);streamIds.delete(published.surface_id);}}}};
    }
    /** @param {string} surfaceId */
    async function drainSurface(surfaceId) {
      try {
        while (!disposed && listeners.size > 0 && pendingDeliveries.has(surfaceId)) {
          pendingDeliveries.delete(surfaceId);
          const state = surfaces.get(surfaceId);
          const published = latestFrames.get(surfaceId);
          if (!state || state.state !== 'active' || !published) break;
          const entry = buildFrameEntry(published, state);
          for (const listener of listeners) {
            await listener(entry);
          }
        }
      } finally {
        delivering.delete(surfaceId);
      }
    }
    /** @param {any} frame */
    function publish(frame) {
      const state = surfaces.get(frame?.surface_id);
      if (!state || state.state !== 'active') return;
      if (!id(frame.surface_id) || frame.schema !== 'frame_ref/v0.2' || !Number.isSafeInteger(frame.generation) || frame.generation < 1
          || typeof frame.ramws_path !== 'string' || !frame.ramws_path.startsWith('/dev/shm/')
          || !Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height)
          || frame.width < 1 || frame.height < 1 || frame.width > 4096 || frame.height > 4096) throw fail();
      const prior = latestFrames.get(frame.surface_id);
      if (prior && frame.generation < prior.generation && failedFrameGenerations.get(frame.surface_id) !== prior.generation) return;
      failedFrameGenerations.delete(frame.surface_id);
      const published = Object.freeze({...frame});
      latestFrames.set(frame.surface_id, published);
      if (!streamIds.has(frame.surface_id)) streamIds.set(frame.surface_id, frame.generation);
      if (listeners.size === 0) return;
      if (!channels.has(frame.surface_id)) {
        if (channels.size >= MAX_ITEMS) throw fail();
        channels.set(frame.surface_id, channelFactory());
      }
      pendingDeliveries.add(frame.surface_id);
      if (delivering.has(frame.surface_id)) return;
      delivering.add(frame.surface_id);
      Promise.resolve().then(() => drainSurface(frame.surface_id)).catch(shutdown);
    }
    /** @param {any} state */
    function publishState(state) {
      const frame = latestFrames.get(state?.surface_id);
      if (!frame || listeners.size === 0) return;
      const binding = Object.freeze({principal:'ui',epoch:1,surfaceId:state.surface_id,surfaceGeneration:1});
      const entry = {stateOnly:true,frameRef:frame,state:{...state},readerOptions:{binding}};
      for (const listener of listeners) Promise.resolve().then(() => listener(entry)).catch(shutdown);
    }
    /** @param {any} state */
    function subscribeSurface(state) {
      if (listeners.size && state.state === 'active' && !subscriptions.has(state.surface_id)) {
        subscriptions.add(state.surface_id);
        send({schema:'surface_request/v0.2',op:'frame_subscribe',params:{surface_id:state.surface_id}});
      }
    }
    /** @param {any} env */
    function receive(env) {
      const ownKeys = env && typeof env === 'object' && !Array.isArray(env) ? Reflect.ownKeys(env) : null;
      const keyList = ownKeys && ownKeys.length === Object.keys(env).length ? ownKeys.sort().join(',') : '';
      const validKeys = keyList === 'body,from,msg_id,nonce,schema,seq,session_id,to,ts_ns'
        || (!live && keyList === 'body,from,msg_id,nonce,schema,seq,session_id,to');
      if (!validKeys
          || env.schema !== 'envelope/v0.2' || env.session_id !== config.session_id
          || !isDeepStrictEqual(env.from,config.core.endpoint) || !isDeepStrictEqual(env.to,ui.endpoint)
          || ((live || Object.hasOwn(env,'ts_ns')) && (!Number.isSafeInteger(env.ts_ns) || env.ts_ns < 0))
          || !Number.isSafeInteger(env.seq) || env.seq <= received || !id(env.nonce) || !id(env.msg_id)
          || !env.body || typeof env.body !== 'object' || Array.isArray(env.body)) throw fail();
      received = env.seq;const body = env.body;
      if (!live) {
        if (!isDeepStrictEqual(body,config.core.hello)) throw fail();
        live = true;clearTimeout(helloTimer);ready();return;
      }
      // [TARGET, unit decision] Capture metadata uses the frozen error-detail
      // carrier. It never reaches renderer error consumers or exposes raw detail.
      if (body.schema === 'surface_event/v0.2' && body.event === 'error'
          && ['CAPTURE_REPLY','CAPTURE_STATE'].includes(body.data?.code)) {
        if (Object.keys(body).sort().join(',') !== 'data,event,schema'
            || Object.keys(body.data).sort().join(',') !== 'code,detail,surface_id'
            || body.data.surface_id !== 'capture' || typeof body.data.detail !== 'string'
            || Buffer.byteLength(body.data.detail) > 65536) throw fail();
        const value = JSON.parse(body.data.detail);
        if (body.data.code === 'CAPTURE_STATE') {
          if (!validCaptureState(value)) throw fail();
          for (const cb of captureListeners) cb(Object.freeze({...value}));
        } else {
          if (Object.keys(value).sort().join(',') !== 'method,reply,request_id') throw fail();
          const item = pending.get(value.request_id);
          if (!item || item.body.schema !== 'capture_host/v1' || value.method !== item.body.method) throw fail();
          let reply = assertCaptureReply(value.method,value.reply,value.request_id);
          if (reply.ok === false) reply = {...reply,request_id:item.body.requestId};
          clearTimeout(item.timer);pending.delete(value.request_id);item.resolve(reply);
        }
        return;
      }
      if (body.schema === 'surface_event/v0.2' && ['created','state_changed'].includes(body.event)) {
        const state = body.data?.surface;
        if (state?.schema !== 'surface/v0.2' || !id(state.surface_id)) throw fail();
        if (['destroyed','lost'].includes(state.state)) {
          if (body.event === 'state_changed') publishState(state);
          surfaces.delete(state.surface_id);
          surfaceInputQueues.delete(state.surface_id);
          latestFrames.delete(state.surface_id);
          streamIds.delete(state.surface_id);
          subscriptions.delete(state.surface_id);
          delivering.delete(state.surface_id);
          pendingDeliveries.delete(state.surface_id);
          failedFrameGenerations.delete(state.surface_id);
          const channel = channels.get(state.surface_id);
          if (channel) {
            channels.delete(state.surface_id);
            channel.port1.close();
            channel.port2.close();
          }
        } else {
          if (!surfaces.has(state.surface_id) && surfaces.size >= MAX_ITEMS) throw fail();
          surfaces.set(state.surface_id,Object.freeze({...state}));
          subscribeSurface(state);
          if (body.event === 'state_changed') publishState(state);
        }
      }
      const layoutError = body.schema === 'surface_event/v0.2' && body.event === 'error'
        && ['LAYOUT_UNKNOWN_SLOT','LAYOUT_ILLEGAL_TRANSITION','LAYOUT_INPUT_MODE_READ'].includes(body.data?.code)
        ? body.data : null;
      if (layoutError && (Object.keys(body).sort().join(',') !== 'data,event,schema'
          || Object.keys(layoutError).sort().join(',') !== 'code,detail,surface_id'
          || !id(layoutError.surface_id) || !id(layoutError.detail))) throw fail();
      for (const [key,item] of pending) {
        let result;
        if (layoutError && item.body.schema === 'ui_intent/v0.2' && layoutError.detail === key && layoutError.surface_id === item.body.params?.slot_id) {
          clearTimeout(item.timer);pending.delete(key);item.reject(new Error(layoutError.code));continue;
        }
        if (body.schema === 'action_verdict/v0.2' && body.proposal_id === key) {
          if (item.body.schema === 'action_proposal/v0.2') result = body;
          else if (item.body.schema === 'surface_request/v0.2' && item.body.op === 'input') {
            if (body.decision === 'admitted') result = true;
            else {
              const code = typeof body.reason_code === 'string' && body.reason_code.length ? body.reason_code : 'INPUT_REFUSED';
              clearTimeout(item.timer);pending.delete(key);
              item.reject(Object.assign(new Error(code), { code, verdict: body }));
              continue;
            }
          } else if (['take_control','release_control','fold','unfold'].includes(item.body.op)) {
            clearTimeout(item.timer);pending.delete(key);item.reject(new Error('INTENT_REFUSED'));continue;
          } else continue;
        }
        const state = body.schema === 'surface_event/v0.2' && body.event === 'state_changed' ? body.data?.surface : null;
        const request = item.body;
        const slot = request.params?.surface_id || request.params?.slot_id;
        const target = surfaces.has(slot) ? slot : String(slot ?? '').replace(/^cuk-ai-slot-/, '');
        if (request.schema === 'ui_intent/v0.2' && ['take_control','release_control','fold','unfold'].includes(request.op)
            && state?.surface_id === target) {
          const satisfied = request.op === 'take_control' ? state.control === 'human'
            : request.op === 'release_control' ? state.control === 'agent'
            : state.visibility === (request.op === 'fold' ? 'folded' : 'unfolded');
          if (satisfied) result = true;
        } else if (request.schema === 'ui_intent/v0.2' && !['take_control','release_control','fold','unfold'].includes(request.op)
            && isDeepStrictEqual(body, request)) {
          result = true;
        }
        if (result !== undefined) {clearTimeout(item.timer);pending.delete(key);if (request.schema === 'ui_intent/v0.2') lastIntentReplySeq = received;item.resolve(result);}
      }
      if (body.schema === 'frame_ref/v0.2') publish(body);
      else if (body.schema === 'surface_event/v0.2' && body.event === 'frame_ready') publish(body.data?.frame_ref);
    }
    const clientSocket = createConnection(socketPath);
    socket = clientSocket;
    let buffer = Buffer.alloc(0);
    clientSocket.on('error',shutdown);clientSocket.on('close',shutdown);
    clientSocket.on('connect',() => {
      try {
        const cred = getPeerCredentials(clientSocket);
        if (!cred || typeof process.getuid !== 'function' || cred.uid !== process.getuid()
            || !Number.isInteger(cred.pid) || cred.pid < 1 || !Number.isInteger(cred.gid) || cred.gid < 0
            || typeof cred.ino !== 'number' || !Number.isInteger(cred.ino) || (cred.ino >>> 0) !== (socketInfo.ino >>> 0)) throw fail();
        send(ui.hello);
      } catch {shutdown();}
    });
    clientSocket.on('data',data => {
      try {
        buffer = Buffer.concat([buffer,data]);let newline;
        while ((newline = buffer.indexOf(10)) !== -1) {
          if (newline >= MAX_WIRE) throw fail();
          const raw = buffer.subarray(0,newline);buffer = buffer.subarray(newline+1);
          receive(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));
        }
        if (buffer.length >= MAX_WIRE) throw fail();
      } catch {shutdown();}
    });
    await handshake;
    const after = await lstat(socketPath);
    if (after.ino !== socketInfo.ino || after.dev !== socketInfo.dev || after.mode !== socketInfo.mode || after.uid !== socketInfo.uid) {shutdown();throw fail();}
    if (disposed || !live) {shutdown();throw fail();}
    // [TARGET, unit decision] The frozen transport closes receive-idle peers
    // after 30 s. An admitted list round trip keeps UI/core/daemon live even
    // when no user input or frame subscription is active. Never reconnect.
    keepalive = setInterval(() => {
      if (disposed || !live) return;
      try {send({schema:'surface_request/v0.2',op:'list',params:{}});} catch {shutdown();}
    }, 10000);
    keepalive.unref();
    // Binding epoch is local to this single, never-reconnected host connection.
    const getStatus = () => ({availability:live ? 'live' : 'unavailable',pid:null,authority_epoch:live ? 1 : null,reason:live ? null : 'CORE_SEAMS_ABSENT'});
    /** @type {Map<string,string>} */ const captureSurfaces = new Map();
    let timeoutAtSeq = 0;
    /**
     * @param {string} surfaceId
     * @param {number} streamId
     * @param {ReadonlyArray<any>} events
     * @returns {string | null}
     */
    function checkSurfaceInputAdmissibility(surfaceId, streamId, events) {
      if (!live || disposed || !socket || socket.destroyed || !socket.writable) {
        return 'CORE_UNAVAILABLE';
      }
      const state = surfaces.get(surfaceId);
      if (!state || ['destroyed', 'lost'].includes(state.state)) {
        return 'SURFACE_UNKNOWN';
      }
      const expectedStreamId = streamIds.get(surfaceId) ?? 1;
      if (streamId !== expectedStreamId) {
        return 'STALE_STREAM';
      }
      if (state.state !== 'active' || state.control !== 'human') {
        return 'NOT_IN_CONTROL';
      }
      const frame = latestFrames.get(surfaceId);
      const width = frame?.width ?? state.geometry?.w ?? null;
      const height = frame?.height ?? state.geometry?.h ?? null;
      for (const ev of events) {
        if (ev.kind === 'click') {
          if ((width !== null && ev.x >= width) || (height !== null && ev.y >= height)) {
            return 'SCHEMA';
          }
        } else if (ev.kind !== 'key' && ev.kind !== 'type' && ev.kind !== 'scroll') {
          return 'SCHEMA';
        }
      }
      return null;
    }
    /**
     * @param {string} surfaceId
     * @param {any} action
     * @returns {Promise<void>}
     */
    function sendInputActionToCore(surfaceId, action) {
      if (!live || disposed || !socket || socket.destroyed || !socket.writable) {
        return Promise.reject(Object.assign(new Error('CORE_UNAVAILABLE'), { code: 'CORE_UNAVAILABLE' }));
      }
      const key = randomUUID();
      if (!id(key) || pending.has(key)) {
        return Promise.reject(Object.assign(new Error('CORE_UNAVAILABLE'), { code: 'CORE_UNAVAILABLE' }));
      }
      const body = {
        schema: 'surface_request/v0.2',
        op: 'input',
        params: {
          surface_id: surfaceId,
          proposal_id: key,
          origin: 'human',
          action,
        },
      };
      return new Promise((resolve, reject) => {
        // [TARGET, unit decision] Never dispose the authority wire or frame
        // channels on an input refusal or input timeout; report per batch only.
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(Object.assign(new Error('CORE_UNAVAILABLE'), { code: 'CORE_UNAVAILABLE' }));
        }, inputDeadlineMs);
        pending.set(key, { body, resolve, reject, timer });
        try {
          send(body, key);
        } catch {
          clearTimeout(timer);
          pending.delete(key);
          reject(Object.assign(new Error('CORE_UNAVAILABLE'), { code: 'CORE_UNAVAILABLE' }));
        }
      });
    }
    /** @param {string} surfaceId */
    async function drainSurfaceInputQueue(surfaceId) {
      const qState = surfaceInputQueues.get(surfaceId);
      if (!qState || qState.draining) return;
      qState.draining = true;
      try {
        while (qState.queue.length > 0) {
          await Promise.resolve();
          if (qState.queue.length === 0) break;
          const head = qState.queue[0];
          const admissibilityErr = checkSurfaceInputAdmissibility(surfaceId, head.batch.stream_id, head.events);
          if (admissibilityErr !== null) {
            if (head.applied > 0) {
              qState.partialSeq = head.batch.seq;
              qState.partialApplied = head.applied;
              qState.lastSeq = Math.max(qState.lastSeq, head.batch.seq - 1);
            }
            qState.queue.shift();
            head.resolve(Object.freeze({ ok: false, code: admissibilityErr }));
            continue;
          }
          const firstEv = head.events[0];
          if (firstEv.kind === 'type') {
            /** @type {Array<{item: {batch:any,events:any[],applied:number,resolve:(value:any)=>void}, count: number}>} */
            const consumed = [];
            let coalescedText = '';
            let coalescedBytes = 0;
            const streamId = head.batch.stream_id;
            outer: for (let qi = 0; qi < qState.queue.length; qi += 1) {
              const item = qState.queue[qi];
              if (item.batch.stream_id !== streamId) break;
              if (qi > 0 && checkSurfaceInputAdmissibility(surfaceId, item.batch.stream_id, item.events) !== null) {
                break;
              }
              let itemCount = 0;
              for (let ei = 0; ei < item.events.length; ei += 1) {
                const ev = item.events[ei];
                if (ev.kind !== 'type') {
                  if (itemCount > 0) consumed.push({ item, count: itemCount });
                  break outer;
                }
                const evBytes = Buffer.byteLength(ev.text, 'utf8');
                if (coalescedText.length > 0 && (coalescedBytes + evBytes > MAX_ADAPTER_TYPE_TEXT_BYTES || coalescedText.length + ev.text.length > MAX_ADAPTER_TYPE_TEXT_BYTES)) {
                  if (itemCount > 0) consumed.push({ item, count: itemCount });
                  break outer;
                }
                coalescedText += ev.text;
                coalescedBytes += evBytes;
                itemCount += 1;
              }
              if (itemCount > 0) {
                consumed.push({ item, count: itemCount });
              }
            }
            const lastConsumed = consumed[consumed.length - 1];
            qState.inFlightSeq = lastConsumed.item.batch.seq;
            try {
              await sendInputActionToCore(surfaceId, { type: 'type', text: coalescedText });
              qState.inFlightSeq = 0;
              for (const { item, count } of consumed) {
                item.events.splice(0, count);
                item.applied += count;
                if (item.events.length === 0) {
                  const idx = qState.queue.indexOf(item);
                  if (idx !== -1) qState.queue.splice(idx, 1);
                  qState.lastSeq = Math.max(qState.lastSeq, item.batch.seq);
                  if (qState.partialSeq <= item.batch.seq) {
                    qState.partialSeq = 0;
                    qState.partialApplied = 0;
                  }
                  item.resolve(Object.freeze({ ok: true, accepted: item.batch.events.length }));
                } else {
                  qState.partialSeq = item.batch.seq;
                  qState.partialApplied = item.applied;
                }
              }
            } catch (error) {
              qState.inFlightSeq = 0;
              const errCode = /** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message;
              const mapped = mapSurfaceInputRefusal(errCode);
              for (const { item } of consumed) {
                if (item.applied > 0) {
                  qState.partialSeq = item.batch.seq;
                  qState.partialApplied = item.applied;
                  qState.lastSeq = Math.max(qState.lastSeq, item.batch.seq - 1);
                }
                const idx = qState.queue.indexOf(item);
                if (idx !== -1) qState.queue.splice(idx, 1);
                item.resolve(Object.freeze({ ok: false, code: mapped }));
              }
            }
          } else {
            const action = firstEv.kind === 'click'
              ? { type: 'click', x: firstEv.x, y: firstEv.y, button: firstEv.button }
              : firstEv.kind === 'key'
                ? { type: 'key', keys: [...firstEv.keys] }
                : { type: 'scroll', dx: firstEv.dx, dy: firstEv.dy };
            qState.inFlightSeq = head.batch.seq;
            try {
              await sendInputActionToCore(surfaceId, action);
              qState.inFlightSeq = 0;
              head.events.shift();
              head.applied += 1;
              if (head.events.length === 0) {
                const idx = qState.queue.indexOf(head);
                if (idx !== -1) qState.queue.splice(idx, 1);
                qState.lastSeq = Math.max(qState.lastSeq, head.batch.seq);
                if (qState.partialSeq <= head.batch.seq) {
                  qState.partialSeq = 0;
                  qState.partialApplied = 0;
                }
                head.resolve(Object.freeze({ ok: true, accepted: head.batch.events.length }));
              } else {
                qState.partialSeq = head.batch.seq;
                qState.partialApplied = head.applied;
              }
            } catch (error) {
              qState.inFlightSeq = 0;
              if (head.applied > 0) {
                qState.partialSeq = head.batch.seq;
                qState.partialApplied = head.applied;
                qState.lastSeq = Math.max(qState.lastSeq, head.batch.seq - 1);
              }
              const errCode = /** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message;
              const mapped = mapSurfaceInputRefusal(errCode);
              const idx = qState.queue.indexOf(head);
              if (idx !== -1) qState.queue.splice(idx, 1);
              head.resolve(Object.freeze({ ok: false, code: mapped }));
            }
          }
        }
      } finally {
        qState.draining = false;
      }
    }
    return {core:{
      /** @param {(state:any)=>void} cb */
      subscribeCapture(cb) {
        if(disposed || typeof cb !== 'function' || captureListeners.size >= MAX_ITEMS) throw fail();
        captureListeners.add(cb);return ()=>captureListeners.delete(cb);
      },
      /** @param {string} surfaceId */
      getInputProgress(surfaceId) {
        const qState = surfaceInputQueues.get(surfaceId);
        if (!qState) return null;
        return Object.freeze({
          lastSeq: qState.lastSeq,
          partialSeq: qState.partialSeq,
          partialApplied: qState.partialApplied,
        });
      },
      get requestedWallFps() {
        return requestedWallFps;
      },
      get recordingFps() {
        return recordingFps;
      },
      /** @param {{ wallFps: number, recordingFps?: number }} cadence */
      requestCadence(cadence) {
        applyCadence(cadence);
      },
      /** @param {{ wallFps: number, recordingFps?: number }} cadence */
      setCadence(cadence) {
        applyCadence(cadence);
      },
      /** @param {number} fps */
      setRecordingFps(fps) {
        if (typeof fps !== 'number' || !Number.isSafeInteger(fps) || fps < 1 || fps > 60) {
          throw new Error('SETTINGS_RECORDING_FPS');
        }
        recordingFps = fps;
        explicitRecordingFps = fps;
      },
      start:async()=>getStatus(),getStatus,dispose:async()=>shutdown(),
      /** @param {any} message */
      async request(message) {
        if (message?.op === 'cadence') {
          applyCadence(message);
          return true;
        }
        if (message?.op === 'capture') {
          if (!live || disposed || nonInputPendingCount() >= MAX_ITEMS
              || Object.keys(message).sort().join(',') !== 'method,op,request'
              || !['screenshot','recordStart','recordStop','export','list'].includes(message.method)) throw fail();
          const rawReq = message.request;
          /** @type {number | null} */
          let overrideMaxFps = null;
          let callReq = rawReq;
          if ((message.method === 'recordStart' || message.method === 'export')
              && rawReq !== null && typeof rawReq === 'object' && !Array.isArray(rawReq)) {
            const hasMaxFps = Object.hasOwn(rawReq, 'max_fps');
            const hasCamelMaxFps = Object.hasOwn(rawReq, 'maxFps');
            if (hasMaxFps && hasCamelMaxFps) throw fail();
            if (hasMaxFps || hasCamelMaxFps) {
              const desc = Object.getOwnPropertyDescriptor(rawReq, hasMaxFps ? 'max_fps' : 'maxFps');
              if (!desc || !('value' in desc)) throw fail();
              const candidateFps = desc.value;
              if (typeof candidateFps !== 'number' || !Number.isSafeInteger(candidateFps) || candidateFps < 1 || candidateFps > 60) {
                throw fail();
              }
              overrideMaxFps = candidateFps;
              const { max_fps: _m1, maxFps: _m2, ...rest } = rawReq;
              callReq = rest;
            }
          }
          assertCaptureCall(message.method,callReq === undefined ? [] : [callReq]);
          if (message.method === 'export' && (destination === null || message.request.destination === null)) {
            return {ok:false,code:'DESTINATION_UNSET',request_id:message.request.request_id};
          }
          if (overrideMaxFps === null && (message.method === 'recordStart' || message.method === 'export') && settingsStore !== null && explicitRecordingFps === null) {
            try {
              const stored = await settingsStore.load();
              if (typeof stored === 'string') {
                const parsed = validateSettings(stored);
                recordingFps = parsed.recordingFps;
                requestedWallFps = parsed.wallFps;
              }
            } catch {}
          }
          const effectiveMaxFps = overrideMaxFps ?? recordingFps;
          const key = message.method === 'list' ? `capture-list:${randomUUID()}` : randomUUID();
          const request = message.request;
          const captureId = randomUUID();
          // Stop identity is host-owned; the core resolves unknown IDs and journals refusals.
          const surfaceId = ['recordStop','export'].includes(message.method) ? (captureSurfaces.get(request.recording_id ?? request.capture_id) ?? 'capture') : request?.surface_id;
          const params = message.method === 'export' ? {surface_id:surfaceId,recording_id:request.capture_id,destination_capability_id:'recording:configured',destination_path:destination,max_fps:effectiveMaxFps}
            : message.method === 'recordStart' ? {surface_id:surfaceId,recording_id:captureId,ring_bytes:8388608,max_fps:effectiveMaxFps}
            : message.method === 'recordStop' ? {surface_id:surfaceId,recording_id:request.recording_id}
            : {surface_id:surfaceId,capture_id:captureId};
          const body = message.method === 'list' ? {schema:'surface_request/v0.2',op:'list',params:{}}
            : {schema:'record_request/v0.2',request_id:key,op:(/** @type {Record<string,string>} */ ({screenshot:'screenshot',recordStart:'ram_start',recordStop:'ram_stop',export:'disk_start'}))[message.method],params};
          return new Promise((resolve,reject) => {
            const timer = setTimeout(() => {pending.delete(key);reject(fail());shutdown();},DEADLINE);
            pending.set(key,{body:{schema:'capture_host/v1',method:message.method,requestId:request?.request_id ?? ''},resolve:value=>{
              if(value.ok && message.method === 'recordStart') captureSurfaces.set(value.recording_id,request.surface_id);
              if(value.ok && message.method === 'screenshot') captureSurfaces.set(value.shot.id,request.surface_id);
              resolve(value);
            },reject,timer});
            try {send(body,key);} catch {shutdown();}
          });
        }
        if (message?.op === 'input') {
          if (!live || disposed || !socket || socket.destroyed || !socket.writable) {
            return Object.freeze({ ok: false, code: 'CORE_UNAVAILABLE' });
          }
          const checked = validateSurfaceInputBatch(message.batch ?? message.request ?? message.json);
          if (!checked.ok) return Object.freeze({ ok: false, code: checked.code });
          const batch = checked.batch;
          const sid = batch.surface_id;
          let qState = surfaceInputQueues.get(sid);
          const highestQueuedSeq = qState && qState.queue.length > 0 ? qState.queue[qState.queue.length - 1].batch.seq : 0;
          const prevSeq = qState ? Math.max(qState.lastSeq, qState.inFlightSeq, highestQueuedSeq) : 0;
          const resumeOffset = qState && batch.seq === qState.partialSeq && qState.partialApplied > 0
            && qState.inFlightSeq === 0 && highestQueuedSeq === 0 ? qState.partialApplied : 0;
          if (batch.seq <= prevSeq || (qState && qState.partialSeq > 0 && batch.seq < qState.partialSeq)
              || (resumeOffset > 0 && batch.events.length <= resumeOffset)) {
            return Object.freeze({ ok: false, code: 'SCHEMA' });
          }
          const pendingEvents = resumeOffset > 0 ? batch.events.slice(resumeOffset) : batch.events;
          const admissibilityErr = checkSurfaceInputAdmissibility(sid, batch.stream_id, pendingEvents);
          if (admissibilityErr !== null) {
            return Object.freeze({ ok: false, code: admissibilityErr });
          }
          if (!qState) {
            if (surfaceInputQueues.size >= MAX_ITEMS) {
              const oldest = surfaceInputQueues.keys().next().value;
              if (oldest !== undefined) surfaceInputQueues.delete(oldest);
            }
            qState = { lastSeq: 0, inFlightSeq: 0, partialSeq: 0, partialApplied: 0, draining: false, queue: [] };
            surfaceInputQueues.set(sid, qState);
          } else if (qState.partialSeq > 0 && batch.seq > qState.partialSeq) {
            qState.lastSeq = Math.max(qState.lastSeq, qState.partialSeq);
            qState.partialSeq = 0;
            qState.partialApplied = 0;
          }
          let queuedEvents = 0;
          for (const item of qState.queue) queuedEvents += item.events.length;
          if (queuedEvents + pendingEvents.length > MAX_SURFACE_INPUT_QUEUE_EVENTS) {
            return Object.freeze({ ok: false, code: 'LIMIT' });
          }
          return new Promise((resolve) => {
            /** @type {Array<Record<string, unknown>>} */
            const clonedEvents = [];
            for (const ev of pendingEvents) clonedEvents.push({ ...ev });
            qState.queue.push({
              batch,
              events: clonedEvents,
              applied: resumeOffset,
              resolve,
            });
            if (!qState.draining) {
              void drainSurfaceInputQueue(sid);
            }
          });
        }
        if (!live || disposed || !['intent','propose'].includes(message?.op) || typeof message.json !== 'string'
            || Buffer.byteLength(message.json) > 256 * 1024 || nonInputPendingCount() >= MAX_ITEMS) throw fail();
        const body = JSON.parse(message.json);
        if (message.op === 'intent') validateIntentBody(body, fail);
        else validateProposalBody(body, fail);
        const key = message.op === 'intent' ? body.request_id : body.proposal_id;
        if (!id(key) || pending.has(key)) throw fail();
        // [TARGET, unit decision] One intent CORE_TIMEOUT on a healthy active
        // session (socket writable, surfaces present, and intent-reply progress
        // since any prior timeout) rejects that intent with CORE_TIMEOUT while
        // keeping the authority wire and frame streams alive; silent peers or
        // repeated timeouts without intent-reply progress call shutdown().
        return new Promise((resolve,reject) => {
          const timer = setTimeout(() => {
            pending.delete(key);
            const healthyIntentTimeout = message.op === 'intent'
              && !disposed && live && socket && !socket.destroyed && socket.writable
              && surfaces.size > 0 && timeoutAtSeq !== lastIntentReplySeq;
            if (healthyIntentTimeout) timeoutAtSeq = lastIntentReplySeq;
            else shutdown();
            reject(new Error('CORE_TIMEOUT'));
          },DEADLINE);
          pending.set(key,{body,resolve,reject,timer});
          try {send(body);} catch {shutdown();}
        });
      }},wire:{terminal,profiles:terminal.profiles,frames:{
      get requestedWallFps() {
        return requestedWallFps;
      },
      /** @param {{ wallFps: number, recordingFps?: number }} cadence */
      requestCadence(cadence) {
        applyCadence(cadence);
      },
      /** @param {{ wallFps: number, recordingFps?: number }} cadence */
      setCadence(cadence) {
        applyCadence(cadence);
      },
      /** @param {(cadence: { wallFps: number }) => void} listener */
      onCadence(listener) {
        if (typeof listener !== 'function') throw fail();
        cadenceListeners.add(listener);
        return () => cadenceListeners.delete(listener);
      },
      /** @param {(entry:any)=>any} listener */
      subscribe(listener) {
        if (disposed || listeners.size) throw fail();listeners.add(listener);
        try {
          for (const state of surfaces.values()) {
            subscribeSurface(state);
            const latest = latestFrames.get(state.surface_id);
            if (latest && state.state === 'active') publish(latest);
          }
        } catch {shutdown();throw fail();}
        return () => listeners.delete(listener);
      }}}};
  } catch (error) {
    socket?.destroy();
    if (error && typeof error === 'object' && ['SETTINGS_DESTINATION', 'SETTINGS_IN_REPO'].includes(/** @type {any} */ (error).code)) {
      throw error;
    }
    throw fail();
  }
}
