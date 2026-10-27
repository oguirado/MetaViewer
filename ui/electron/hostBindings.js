// @ts-check
/** [TARGET, unit decision] Attach to the already running owner-only core socket
 * at $XDG_RUNTIME_DIR/metaviewer/core.sock, using the UI registration and core
 * hello pinned by MV_CORE_CONFIG (the live runner's ABI). Never spawn a guessed
 * binary. Intent success requires a matching core surface update; proposals
 * return the core verdict, including POLICY refusals on the UI lane.
 * Bounds [TARGET, unit decision]: 1 MiB wire/config, 64 surfaces/pending calls,
 * 64 MiB frame, 4096 pixels per axis, 3 s request/hello deadline.
 */
import { createConnection } from 'node:net';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const MAX_WIRE = 1024 * 1024, MAX_FRAME = 64 * 1024 * 1024, MAX_ITEMS = 64, DEADLINE = 3000;
const fail = () => new Error('CORE_SEAMS_ABSENT');
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
 * @param {{env?:NodeJS.ProcessEnv,createMessageChannel?:()=>any}} [options]
 * @returns {Promise<{core: any, wire: any}>} */
export async function createMainBindings({env = process.env, createMessageChannel} = {}) {
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
    if (!createMessageChannel) {
      const electron = /** @type {any} */ (await import('electron'));
      if (typeof electron.MessageChannelMain !== 'function') throw fail();
      createMessageChannel = () => new electron.MessageChannelMain();
    }
    const channelFactory = createMessageChannel;
    /** @type {Set<(entry:any)=>any>} */ const listeners = new Set();
    /** @type {Map<string,any>} */ const surfaces = new Map();
    /** @type {Map<string,any>} */ const channels = new Map();
    /** @type {Set<string>} */ const subscriptions = new Set();
    /** @type {Set<string>} */ const delivering = new Set();
    /** @type {Map<string,{body:any,resolve:(value:any)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}>} */ const pending = new Map();
    let live = false, disposed = false, seq = 0, received = 0;
    /** @type {(value?:any)=>void} */ let ready;
    /** @type {(error:Error)=>void} */ let rejectReady;
    const handshake = new Promise((resolve,reject) => {ready=resolve;rejectReady=reject;});
    // Attach the rejection handler before any socket callbacks can fire.
    void handshake.catch(() => {});
    const shutdown = () => {
      if (disposed) return; disposed = true; live = false; clearTimeout(helloTimer);
      rejectReady(fail()); socket?.destroy();
      for (const item of pending.values()) {clearTimeout(item.timer);item.reject(fail());} pending.clear();
      for (const channel of channels.values()) {channel.port1.close();channel.port2.close();}
      channels.clear();surfaces.clear();subscriptions.clear();listeners.clear();
    };
    const helloTimer = setTimeout(shutdown, DEADLINE);
    /** @param {any} body */
    function send(body) {
      if (disposed || !socket || !Number.isSafeInteger(++seq)) throw fail();
      const value = {schema:'envelope/v0.2',msg_id:body.request_id || body.proposal_id || randomUUID(),ts_ns:0,
        from:ui.endpoint,to:config.core.endpoint,session_id:config.session_id,seq,nonce:randomUUID(),body};
      const line = JSON.stringify(value) + '\n'; if (Buffer.byteLength(line) > MAX_WIRE || socket.writableLength > MAX_WIRE) throw fail();
      socket.write(line);
    }
    /** @param {any} frame */
    function publish(frame) {
      const state = surfaces.get(frame?.surface_id);
      if (!state || state.state !== 'active' || listeners.size === 0 || delivering.has(frame.surface_id)) return;
      if (!id(frame.surface_id) || frame.schema !== 'frame_ref/v0.2' || !Number.isSafeInteger(frame.generation) || frame.generation < 1
          || typeof frame.ramws_path !== 'string' || !frame.ramws_path.startsWith('/dev/shm/')
          || !Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height)
          || frame.width < 1 || frame.height < 1 || frame.width > 4096 || frame.height > 4096) throw fail();
      let channel = channels.get(frame.surface_id);
      if (!channel) {
        if (channels.size >= MAX_ITEMS) throw fail();
        channel = channelFactory();channels.set(frame.surface_id, channel);
      }
      const binding = Object.freeze({principal:'ui',epoch:1,surfaceId:frame.surface_id,surfaceGeneration:1});
      const published = Object.freeze({...frame});
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
        portOptions:{port:channel.port1,role:'sender',binding,limits:{maxFrameBytes:MAX_FRAME,ackTimeoutMs:10000,maxSurfacesPerPort:1},onReleaseLease(){},onRevoke(){shutdown();}}};
      delivering.add(frame.surface_id);
      for (const listener of listeners) Promise.resolve().then(() => listener(entry)).catch(shutdown).finally(() => delivering.delete(frame.surface_id));
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
      if (env?.schema !== 'envelope/v0.2' || env.session_id !== config.session_id
          || !isDeepStrictEqual(env.from,config.core.endpoint) || !isDeepStrictEqual(env.to,ui.endpoint)
          || !Number.isSafeInteger(env.seq) || env.seq <= received || !id(env.nonce) || !id(env.msg_id) || !env.body) throw fail();
      received = env.seq;const body = env.body;
      if (!live) {
        if (!isDeepStrictEqual(body,config.core.hello)) throw fail();
        live = true;clearTimeout(helloTimer);ready();return;
      }
      if (body.schema === 'surface_event/v0.2' && ['created','state_changed'].includes(body.event)) {
        const state = body.data?.surface;
        if (state?.schema !== 'surface/v0.2' || !id(state.surface_id)) throw fail();
        if (!surfaces.has(state.surface_id) && surfaces.size >= MAX_ITEMS) throw fail();
        surfaces.set(state.surface_id,Object.freeze({...state}));
        subscribeSurface(state);
      }
      for (const [key,item] of pending) {
        let result;
        if (body.schema === 'action_verdict/v0.2' && body.proposal_id === key) {
          if (item.body.schema === 'action_proposal/v0.2') result = body;
          else {clearTimeout(item.timer);pending.delete(key);item.reject(new Error('INTENT_REFUSED'));continue;}
        }
        const state = body.schema === 'surface_event/v0.2' && body.event === 'state_changed' ? body.data?.surface : null;
        const request = item.body;
        if (request.schema === 'ui_intent/v0.2' && state?.surface_id === (request.params.surface_id || request.params.slot_id)) {
          const satisfied = request.op === 'take_control' ? state.control === 'human'
            : request.op === 'release_control' ? state.control === 'agent'
            : state.visibility === (request.op === 'fold' ? 'folded' : 'unfolded');
          if (satisfied) result = true;
        }
        if (result !== undefined) {clearTimeout(item.timer);pending.delete(key);item.resolve(result);}
      }
      if (body.schema === 'frame_ref/v0.2') publish(body);
      else if (body.schema === 'surface_event/v0.2' && body.event === 'frame_ready') publish(body.data?.frame_ref);
    }
    socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    socket.on('error',shutdown);socket.on('close',shutdown);
    socket.on('connect',() => {try {send(ui.hello);} catch {shutdown();}});
    socket.on('data',data => {
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
    // Binding epoch is local to this single, never-reconnected host connection.
    const getStatus = () => ({availability:live ? 'live' : 'unavailable',pid:null,authority_epoch:live ? 1 : null,reason:live ? null : 'CORE_SEAMS_ABSENT'});
    return {core:{start:async()=>getStatus(),getStatus,dispose:async()=>shutdown(),
      /** @param {any} message */
      async request(message) {
        if (!live || disposed || !['intent','propose'].includes(message?.op) || typeof message.json !== 'string'
            || Buffer.byteLength(message.json) > 256 * 1024 || pending.size >= MAX_ITEMS) throw fail();
        const body = JSON.parse(message.json);
        if (body?.schema !== (message.op === 'intent' ? 'ui_intent/v0.2' : 'action_proposal/v0.2')) throw fail();
        const key = message.op === 'intent' ? body.request_id : body.proposal_id;
        if (!id(key) || pending.has(key) || (message.op === 'intent' && (!['take_control','release_control','fold','unfold'].includes(body.op) || !body.params))) throw fail();
        return new Promise((resolve,reject) => {
          const timer = setTimeout(() => {pending.delete(key);reject(new Error('CORE_TIMEOUT'));shutdown();},DEADLINE);
          pending.set(key,{body,resolve,reject,timer});
          try {send(body);} catch {shutdown();}
        });
      }},wire:{frames:{
      /** @param {(entry:any)=>any} listener */
      subscribe(listener) {
        if (disposed || listeners.size) throw fail();listeners.add(listener);
        try {for (const state of surfaces.values()) subscribeSurface(state);} catch {shutdown();throw fail();}
        return () => listeners.delete(listener);
      }}}};
  } catch {socket?.destroy();throw fail();}
}
