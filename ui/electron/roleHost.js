import { xpraClientQuery } from './xpraClient.js';
// Additive v0.3 role API. All capsule/socket selection stays in Electron main.
import { open, realpath, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { configuredProfiles, summarizeSurfaces, MAX_CAPSULES } from './profilePicker.js';
import { recordingDestination } from './authorityWire.js';
import { createXpraHumanSession } from './xpraHumanSession.js';
import { openXpraHumanBridge } from './xpraHumanBridge.js';
import { attachXpraHumanTile } from './xpraHumanTile.js';
import { createHumanTraceFile } from './humanTrace.js';

const CHANNEL = 'metaviewer:roles.v0.3';
/** @param {unknown} value */
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
/** @param {string} code */
const refuse = code => Object.assign(new Error(code), {code});
/** @param {any} v @param {string} keys */
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Reflect.ownKeys(v).sort().join(',') === keys && Object.values(Object.getOwnPropertyDescriptors(v)).every(d => 'value' in d);
/** @param {any} bounds */
export function validateRoleBounds(bounds) {
  if (!exact(bounds, 'height,width,x,y') || !Object.values(bounds).every(Number.isSafeInteger) ||
      bounds.x < 0 || bounds.y < 0 || bounds.width < 1 || bounds.height < 1 ||
      bounds.x + bounds.width > 16384 || bounds.y + bounds.height > 16384) throw refuse('XPRA_BOUNDS_REFUSED');
  return {...bounds};
}

/** Open only an adapter-selected, private regular binding; never renderer paths. */
/** @param {string} stateDir @param {any} surface @param {string} role */
export async function readRoleBinding(stateDir, surface, role) {
  if (!isAbsolute(stateDir) || !id(surface?.surface_id)) throw refuse('XPRA_BINDING_REFUSED');
  const path = join(stateDir, 'human-bindings', surface.surface_id + '.json');
  if (await realpath(path) !== path) throw refuse('XPRA_BINDING_REFUSED');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > 4096) throw refuse('XPRA_BINDING_REFUSED');
    const b = JSON.parse(await handle.readFile('utf8'));
    if (b.schema !== 'metaviewer.human_binding/v0.3' || b.surface_id !== surface.surface_id ||
        b.role !== role || !b.control_ready || b.width !== 1280 || b.height !== 900 ||
        !/^srf-id-[a-z0-9-]+$/.test(b.container) || !id(b.run_id) ||
        b.profile_id !== surface.profile_id) throw refuse('XPRA_BINDING_REFUSED');
    return b;
  } finally { await handle.close(); }
}

/** @param {{tool:string,stateDir:string,container:string,readonly:boolean,env:NodeJS.ProcessEnv}} options @returns {Promise<boolean>} */
export function runHumanMode({tool, stateDir, container, readonly, env}) {
  return new Promise((resolve, reject) => {
    execFile(tool, ['human','--container',container,readonly ? '--readonly' : '--writable',
      '--state-dir',stateDir], {env, timeout:30000, maxBuffer:4096, windowsHide:true}, (error, stdout) => {
      if (error) { reject(refuse('XPRA_MODE_REFUSED')); return; }
      try {
        if (stdout.trim().split('\n').length !== 1) throw Error();
        const ack = JSON.parse(stdout);
        if (!exact(ack,'container,ready,schema,writable') || ack.schema !== 'srf.human-xpra/v1' ||
            ack.container !== container || ack.ready !== true || ack.writable !== !readonly) throw Error();
        resolve(true);
      } catch { reject(refuse('XPRA_MODE_UNPROVEN')); }
    });
  });
}

/** Renderer gets only role, profile ids, state, and opaque success. */
/** @param {any} options */
export function installRoleHost({electron, window, core, env, capsuleStates, admit,
  listIdentities, mode = runHumanMode, bridgeFactory = openXpraHumanBridge, tileFactory = attachXpraHumanTile}) {
  const {ipcMain} = electron;
  const raw = env.MV_SRF_PROFILES ? JSON.parse(env.MV_SRF_PROFILES) : {};
  const profiles = configuredProfiles(env);
  /** @param {string} profile */
  const roleOf = profile => raw[profile]?.role ?? 'agent';
  if (profiles.some(p => !['human','agent'].includes(roleOf(p.id)))) throw refuse('CAPSULE_ROLE_INVALID');
  const sessions = new Map();
  const viewStates = new Map();
  const locks = new Set();
  const epochs = new Map();
  let creating = false, disposed = false;
  /** @param {string} surfaceId */
  const authoritative = surfaceId => {
    if (!id(surfaceId)) throw refuse('SURFACE_UNKNOWN');
    const s = core.getHumanSurface?.(surfaceId);
    if (!s || s.state !== 'active' || !profiles.some(p => p.id === s.profile_id)) throw refuse('SURFACE_UNKNOWN');
    return s;
  };
  /** @param {string} surfaceId */
  const status = surfaceId => {
    const s = authoritative(surfaceId);
    return {role:roleOf(s.profile_id), profileId:s.profile_id, control:s.control,
      view:viewStates.get(surfaceId) || {state:'closed'}};
  };
  /** @param {string} surfaceId */
  async function close(surfaceId) {
    epochs.set(surfaceId,(epochs.get(surfaceId) || 0) + 1);
    const session = sessions.get(surfaceId);
    sessions.delete(surfaceId);
    viewStates.delete(surfaceId);
    await session?.close();
  }
  /** @param {string} surfaceId @param {any} bounds */
  async function mount(surfaceId, bounds) {
    bounds = validateRoleBounds(bounds);
    if (locks.has(surfaceId)) throw refuse('XPRA_VIEW_BUSY');
    locks.add(surfaceId);
    let trace = null;
    try {
      const current = authoritative(surfaceId);
      if (current.control !== (roleOf(current.profile_id) === 'human' ? 'human' : 'agent')) throw refuse('XPRA_ROLE_OWNERSHIP');
      if (sessions.get(surfaceId)?.active) {
        sessions.get(surfaceId).resize(bounds);
        return {ok:true,role:roleOf(current.profile_id)};
      }
      await close(surfaceId);
      const epoch = epochs.get(surfaceId);
      const surface = authoritative(surfaceId), role = roleOf(surface.profile_id);
      if (role === 'human' && surface.control !== 'human' || role === 'agent' && surface.control !== 'agent') throw refuse('XPRA_ROLE_OWNERSHIP');
      const binding = await readRoleBinding(env.MV_SRF_STATE_DIR, surface, role);
      if (role === 'human') {
        const directory = recordingDestination(env);
        if (!directory) throw refuse('TRACE_DESTINATION_UNSET');
        trace = createHumanTraceFile({directory, sessionId:env.MV_SESSION_ID || randomUUID(), surfaceId, capsuleId:binding.container});
      }
      const active = () => {
        try { const s = authoritative(surfaceId); return !disposed && epochs.get(surfaceId) === epoch && sessions.has(surfaceId) &&
          roleOf(s.profile_id) === role && s.control === (role === 'human' ? 'human' : 'agent'); } catch { return false; }
      };
      const recorder = trace;
      const dummyTrace = {record(){return false;}, setActive(){}};
      const session = createXpraHumanSession({role,
        setReadonly: readonly => mode({tool:join(env.MV_SRF_BIN_DIR,'srf-identity-surface'),
          stateDir:env.MV_SRF_STATE_DIR,container:binding.container,readonly,env}),
        openBridge: async () => {
          if (!active()) throw refuse('XPRA_ROLE_OWNERSHIP');
          const pinned = await readRoleBinding(env.MV_SRF_STATE_DIR, authoritative(surfaceId), role);
          if (pinned.run_id !== binding.run_id) throw refuse('XPRA_BINDING_CHANGED');
          // Debian's HTML5 client may omit its jquery symlink. This is a
          // public static host asset; an explicit override remains host-owned.
          let jquery;
          try { jquery = await readFile(env.MV_XPRA_JQUERY || '/usr/share/javascript/jquery/jquery.js'); }
          catch (error) { if (env.MV_XPRA_JQUERY || /** @type {any} */ (error)?.code !== 'ENOENT') throw error; }
          return bridgeFactory({viewRoot:join(env.MV_SRF_STATE_DIR,'view'),capsule:binding.container,expectedSocketUid:10001,jquery});
        },
        showView: (bridge, recoverBridge) => tileFactory({electron,window,bridge,bounds,recoverBridge,
          trace:recorder || dummyTrace,isActive:active,writable:role === 'human',
          capsuleSize:() => ({width:1280,height:900}),
          clientQuery:xpraClientQuery(role === 'human'),
          onState: (/** @type {string} */ state) => {
            if (active()) viewStates.set(surfaceId,{state});
          },
          onFailure: async (/** @type {any} */ error) => {
            if (!active()) return;
            const code = ['XPRA_VIEW_CRASHED','XPRA_VIEW_UNRESPONSIVE','XPRA_TRACE_FAILED'].includes(error?.code)
              ? error.code : 'XPRA_TRACE_FAILED';
            const closing = close(surfaceId);
            viewStates.set(surfaceId,{state:'error',code});
            try { await closing; } catch { /* typed error remains available for Reopen */ }
          }}),
        closeTrace:() => recorder?.close(),
      });
      sessions.set(surfaceId,session);
      if (!active()) throw refuse('XPRA_ROLE_OWNERSHIP');
      await session.open();
      if (!active()) { await close(surfaceId); throw refuse('XPRA_ROLE_OWNERSHIP'); }
      return {ok:true,role};
    } catch (error) { await close(surfaceId); trace?.close(); throw error; }
    finally { locks.delete(surfaceId); }
  }
  async function choices() {
    const {bound} = summarizeSurfaces(capsuleStates);
    const reply = await listIdentities();
    if (reply?.ok !== true || !Array.isArray(reply.rows)) throw refuse('IDENTITY_LIST_UNAVAILABLE');
    const names = new Set(reply.rows.map((/** @type {any} */ row) => row.id));
    return profiles.map(p => ({profileId:p.id,role:roleOf(p.id),available:names.has(p.id) && !bound.has(p.id)}));
  }
  /** @param {any} choice */
  async function create(choice) {
    if (!exact(choice,'profileId,role') || !['human','agent'].includes(choice.role) || !id(choice.profileId)) throw refuse('CAPSULE_ROLE_INVALID');
    if (creating) throw refuse('SURFACE_CREATE_BUSY');
    creating = true;
    let key;
    try {
      const {live,bound} = summarizeSurfaces(capsuleStates);
      if (bound.has(choice.profileId)) throw refuse('PROFILE_ALREADY_BOUND');
      if (live >= MAX_CAPSULES) throw refuse('CAPSULE_LIMIT_REACHED');
      const profile = profiles.find(p => p.id === choice.profileId && roleOf(p.id) === choice.role);
      if (!profile) throw refuse('CAPSULE_ROLE_INVALID');
      if (!(await choices()).find(p => p.profileId === profile.id)?.available) throw refuse('NO_IDENTITY');
      key = `pending:${profile.id}`;
      capsuleStates.set(key,{profile_id:profile.id,state:'creating'});
      const reply = await core.request(profile.request);
      if (reply?.schema !== 'surface_event/v0.2' || reply.event !== 'created') throw refuse('SURFACE_CREATE_REFUSED');
      capsuleStates.set(reply.data.surface.surface_id,reply.data.surface);
      return {ok:true};
    } finally { if (key) capsuleStates.delete(key); creating = false; }
  }
  /** @param {any} event @param {any} message */
  const handler = async (event, message) => {
    if (disposed || !admit(event) || !message || message.schema !== 'metaviewer.roles/v0.3') throw refuse('XPRA_SENDER_REFUSED');
    const {op} = message;
    const keys = ['choices'].includes(op) ? 'op,schema' : op === 'create' ? 'choice,op,schema'
      : ['mount','resize'].includes(op) ? 'bounds,op,schema,surfaceId'
      : op === 'visibility' ? 'op,schema,surfaceId,visible' : 'op,schema,surfaceId';
    if (!exact(message,keys)) throw refuse('XPRA_PAYLOAD_REFUSED');
    try {
      if (op === 'choices') return await choices();
      if (op === 'create') return await create(message.choice);
      if (op === 'status') return status(message.surfaceId);
      if (op === 'mount') return await mount(message.surfaceId,message.bounds);
      if (op === 'resize') { authoritative(message.surfaceId); sessions.get(message.surfaceId)?.resize(validateRoleBounds(message.bounds)); return {ok:true}; }
      if (op === 'visibility') {
        authoritative(message.surfaceId);
        if (typeof message.visible !== 'boolean') throw refuse('XPRA_PAYLOAD_REFUSED');
        sessions.get(message.surfaceId)?.setVisible(message.visible);
        return {ok:true};
      }
      if (op === 'close') { if (!id(message.surfaceId)) throw refuse('SURFACE_UNKNOWN'); await close(message.surfaceId); return {ok:true}; }
      throw refuse('XPRA_PAYLOAD_REFUSED');
    } catch (error) { return {ok:false,code:typeof /** @type {any} */ (error)?.code === 'string' ? /** @type {any} */ (error).code : 'XPRA_REFUSED'}; }
  };
  ipcMain.handle(CHANNEL,handler);
  const parentSession = window.webContents.session;
  const preloadId = parentSession.registerPreloadScript({type:'frame',filePath:fileURLToPath(new URL('./rolePreload.cjs',import.meta.url))});
  // Capsule loss or emergency agent takeover immediately revokes the watch.
  const timer = setInterval(() => {
    for (const surfaceId of sessions.keys()) {
      try { const s = status(surfaceId); if (s.control !== (s.role === 'human' ? 'human' : 'agent')) void close(surfaceId); }
      catch { void close(surfaceId); }
    }
  },100);
  timer.unref?.();
  window.once('closed', () => { void dispose(); });
  window.webContents.once?.('render-process-gone', () => { void dispose(); });
  async function dispose() {
    if (disposed) return;
    disposed = true; clearInterval(timer);
    ipcMain.removeHandler(CHANNEL);
    try { parentSession.unregisterPreloadScript(preloadId); } catch { /* closed window */ }
    await Promise.all([...sessions.keys()].map(close));
  }
  return Object.freeze({dispose});
}
