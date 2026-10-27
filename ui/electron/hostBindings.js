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
 */
import { INTENT_OPS, recordingDestination, validateIntentBody } from './authorityWire.js';
export { INTENT_OPS };
import { assertCaptureCall, assertCaptureReply, validCaptureState } from './captureBridge.js';
import { createConnection } from 'node:net';
import { spawnSync } from 'node:child_process';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const MAX_WIRE = 1024 * 1024, MAX_FRAME = 64 * 1024 * 1024, MAX_ITEMS = 64, DEADLINE = 3000;
const fail = () => new Error('CORE_SEAMS_ABSENT');
const PEERCRED_PY = [
  'import os, socket, struct, sys',
  's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM, 0, 3)',
  'pid, uid, gid = struct.unpack("3i", s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))',
  'cino = os.fstat(3).st_ino',
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
  const res = spawnSync('python3', ['-S', '-c', PEERCRED_PY], {
    stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8', timeout: DEADLINE,
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
  if (!isAbsolute(path) || path.split('/').some(x => x === '..' || x === '.')) throw fail();
  const parts = path.split('/').filter(Boolean);
  let dir = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of parts.slice(0, -1)) {
      const next = await open(`/proc/self/fd/${dir.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await dir.close(); dir = next;
    }
    return await open(`/proc/self/fd/${dir.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } finally { await dir.close(); }
}

/** Trusted options are host-only; no renderer pathname or capability is accepted.
 * @param {{env?:NodeJS.ProcessEnv,createMessageChannel?:()=>any,getPeerCredentials?:(socket:import('node:net').Socket)=>{pid:number,uid:number,gid:number,ino?:number}}} [options]
 * @returns {Promise<{core: any, wire: any}>} */
export async function createMainBindings({env = process.env, createMessageChannel, getPeerCredentials = readPeerCredentials} = {}) {
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
    if (!createMessageChannel) {
      const electron = /** @type {any} */ (await import('electron'));
      if (typeof electron.MessageChannelMain !== 'function') throw fail();
      createMessageChannel = () => new electron.MessageChannelMain();
    }
    const channelFactory = createMessageChannel;
    /** @type {Set<(entry:any)=>any>} */ const listeners = new Set();
    /** @type {Map<string,any>} */ const surfaces = new Map();
    /** @type {Map<string,any>} */ const latestFrames = new Map();
    /** @type {Map<string,any>} */ const channels = new Map();
    /** @type {Set<string>} */ const subscriptions = new Set();
    /** @type {Set<string>} */ const delivering = new Set();
    /** @type {Map<string,{body:any,resolve:(value:any)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}>} */ const pending = new Map();
    let live = false, disposed = false, seq = 0, received = 0;
    /** @type {ReturnType<typeof setInterval> | undefined} */ let keepalive;
    /** @type {(value?:any)=>void} */ let ready;
    /** @type {(error:Error)=>void} */ let rejectReady;
    const handshake = new Promise((resolve,reject) => {ready=resolve;rejectReady=reject;});
    // Attach the rejection handler before any socket callbacks can fire.
    void handshake.catch(() => {});
    const shutdown = () => {
      clearTimeout(helloTimer); clearInterval(keepalive);
      if (disposed) return; disposed = true; live = false;
      rejectReady(fail()); socket?.destroy();
      for (const item of pending.values()) {clearTimeout(item.timer);item.reject(fail());} pending.clear();
      for (const channel of channels.values()) {channel.port1.close();channel.port2.close();}
      channels.clear();surfaces.clear();latestFrames.clear();subscriptions.clear();listeners.clear();captureListeners.clear();
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
    /** @param {any} frame */
    function publish(frame) {
      const state = surfaces.get(frame?.surface_id);
      if (!state || state.state !== 'active') return;
      if (!id(frame.surface_id) || frame.schema !== 'frame_ref/v0.2' || !Number.isSafeInteger(frame.generation) || frame.generation < 1
          || typeof frame.ramws_path !== 'string' || !frame.ramws_path.startsWith('/dev/shm/')
          || !Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height)
          || frame.width < 1 || frame.height < 1 || frame.width > 4096 || frame.height > 4096) throw fail();
      const published = Object.freeze({...frame});
      latestFrames.set(frame.surface_id, published);
      if (listeners.size === 0 || delivering.has(frame.surface_id)) return;
      let channel = channels.get(frame.surface_id);
      if (!channel) {
        if (channels.size >= MAX_ITEMS) throw fail();
        channel = channelFactory();channels.set(frame.surface_id, channel);
      }
      const binding = Object.freeze({principal:'ui',epoch:1,surfaceId:frame.surface_id,surfaceGeneration:1});
      const entry = {frameRef:published,state:{...state},rendererPorts:[channel.port2],
        readerOptions:{binding,limits:{maxFrameBytes:MAX_FRAME,maxWidth:4096,maxHeight:4096,readTimeoutMs:1000,maxConcurrentReads:1},
          pixelEnvironment:{environmentId:config.session_id,zoom:1,dpr:1},onReleaseLease(){},
          /** @param {any} request */
          async acquirePublishedLease(request) {
            if (disposed || !isDeepStrictEqual(request.binding,binding) || !isDeepStrictEqual(request.frameRef,published)
                || published.surface_id !== binding.surfaceId) throw new Error('FRAME_BINDING');
            const file = await openPinned(published.ramws_path);
            try {
              const info = await file.stat();
              if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) || info.size > MAX_FRAME) throw fail();
              let released = false;
              const release = async () => {if (!released) {released=true;await file.close();}};
              return {identity:{...binding,frameGeneration:published.generation,leaseId:randomUUID()},published:true,byteLength:info.size,
                /** @param {{maxBytes:number,signal:AbortSignal}} read */
                async readOwnedBytes({maxBytes,signal}) {
                  if (released || signal.aborted || request.signal.aborted || info.size > maxBytes) throw fail();
                  const bytes = Buffer.alloc(info.size + 1);let offset = 0;
                  while (offset < bytes.length) {
                    if (signal.aborted || request.signal.aborted) throw fail();
                    const {bytesRead} = await file.read(bytes,offset,bytes.length-offset,offset);
                    if (!bytesRead) break;offset += bytesRead;
                  }
                  if (offset !== info.size) throw fail();
                  return new Uint8Array(bytes.subarray(0,offset));
                },release};
            } catch(error) {await file.close();throw error;}
          }},
        portOptions:{port:channel.port1,role:'sender',binding,limits:{maxFrameBytes:MAX_FRAME,ackTimeoutMs:10000,maxSurfacesPerPort:1},onReleaseLease(){},onRevoke(){}}};
      delivering.add(frame.surface_id);
      for (const listener of listeners) Promise.resolve().then(() => listener(entry)).catch(shutdown).finally(() => delivering.delete(frame.surface_id));
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
          latestFrames.delete(state.surface_id);
          subscriptions.delete(state.surface_id);
          delivering.delete(state.surface_id);
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
          else if (['take_control','release_control','fold','unfold'].includes(item.body.op)) {
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
        if (result !== undefined) {clearTimeout(item.timer);pending.delete(key);item.resolve(result);}
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
            || (cred.ino !== undefined && cred.ino !== (socketInfo.ino >>> 0))) throw fail();
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
    return {core:{
      /** @param {(state:any)=>void} cb */
      subscribeCapture(cb) {
        if(disposed || typeof cb !== 'function' || captureListeners.size >= MAX_ITEMS) throw fail();
        captureListeners.add(cb);return ()=>captureListeners.delete(cb);
      },start:async()=>getStatus(),getStatus,dispose:async()=>shutdown(),
      /** @param {any} message */
      async request(message) {
        if (message?.op === 'capture') {
          if (!live || disposed || pending.size >= MAX_ITEMS
              || Object.keys(message).sort().join(',') !== 'method,op,request'
              || !['screenshot','recordStart','recordStop','export','list'].includes(message.method)) throw fail();
          assertCaptureCall(message.method,message.request === undefined ? [] : [message.request]);
          if (message.method === 'export' && (destination === null || message.request.destination === null)) {
            return {ok:false,code:'DESTINATION_UNSET',request_id:message.request.request_id};
          }
          const key = message.method === 'list' ? `capture-list:${randomUUID()}` : randomUUID();
          const request = message.request;
          const captureId = randomUUID();
          // Stop identity is host-owned; the core resolves unknown IDs and journals refusals.
          const surfaceId = ['recordStop','export'].includes(message.method) ? (captureSurfaces.get(request.recording_id ?? request.capture_id) ?? 'capture') : request?.surface_id;
          const params = message.method === 'export' ? {surface_id:surfaceId,recording_id:request.capture_id,destination_capability_id:'recording:configured',destination_path:destination,max_fps:30}
            : message.method === 'recordStart' ? {surface_id:surfaceId,recording_id:captureId,ring_bytes:8388608,max_fps:30}
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
        if (!live || disposed || !['intent','propose'].includes(message?.op) || typeof message.json !== 'string'
            || Buffer.byteLength(message.json) > 256 * 1024 || pending.size >= MAX_ITEMS) throw fail();
        const body = JSON.parse(message.json);
        if (message.op === 'intent') validateIntentBody(body, fail);
        else if (body?.schema !== 'action_proposal/v0.2') throw fail();
        const key = message.op === 'intent' ? body.request_id : body.proposal_id;
        if (!id(key) || pending.has(key)) throw fail();
        return new Promise((resolve,reject) => {
          const timer = setTimeout(() => {pending.delete(key);reject(new Error('CORE_TIMEOUT'));shutdown();},DEADLINE);
          pending.set(key,{body,resolve,reject,timer});
          try {send(body);} catch {shutdown();}
        });
      }},wire:{frames:{
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
  } catch {socket?.destroy();throw fail();}
}
