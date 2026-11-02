import { isForeignIdentity } from './identityProtection.js';
import { hostKeyboardLayout } from './keyboardLayout.js';
import { stageOpeningMode } from './openingMode.js';
import { identityMarkers } from './identityMarkers.js';
import { xpraClientQuery } from './xpraClient.js';
// Additive v0.3 role API. All capsule/socket selection stays in Electron main.
import { open, realpath, readFile } from 'node:fs/promises';
import { constants, statSync } from 'node:fs';
import { join, isAbsolute, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  CAPSULE_MEMORY_LIMIT_BYTES,
  CREATE_REFUSAL_REASONS,
  MAX_CAPSULES,
  configuredProfiles,
  createRefusalReason,
  formatCapsuleLimitReason,
  formatCapsuleSlotReason,
  formatMemoryRefusalReason,
  parseMemAvailableBytes,
  summarizeSurfaces,
} from './profilePicker.js';
import { recordingDestination } from './authorityWire.js';
import { createXpraHumanSession } from './xpraHumanSession.js';
import { openXpraHumanBridge } from './xpraHumanBridge.js';
import { attachXpraHumanTile } from './xpraHumanTile.js';
import { createHumanTraceFile, pruneHumanTraces } from './humanTrace.js';

/** @param {any} s */
const rendererSurface = s => Object.fromEntries(['schema','surface_id','profile_id','state','control','visibility','display','geometry'].filter(k => s[k] !== undefined).map(k => [k,s[k]]));

const CHANNEL = 'metaviewer:roles.v0.3';
/** @param {unknown} value */
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
/** @param {string} code */
const refuse = code => Object.assign(new Error(code), {code});
// Adapter details can contain native diagnostics. Log only fixed protocol text.
const createDetails = new Set([
  'profile already bound', 'surface capacity or unresolved native outcome',
  'identity display pool exhausted; stop a capsule first', 'configured display is in use; stop its capsule first',
  'human mode requires 1280x900 browser', 'unadmitted profile, kind or geometry',
  'private opening directory required', 'private opening request required',
  'opening mode refused', 'native operation has no verified result',
  'native frame identity, time or allocation mismatch', 'native frame allocation mismatch',
]);
/** @param {any} reply */
export function surfaceCreateRefusal(reply) {
  const raw = reply?.data?.code;
  const code = typeof raw === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(raw) ? raw : 'unknown';
  const rawDetail = reply?.data?.detail;
  // wireFailure may wrap a Fault in a compensated initial-capture error. Emit
  // its fixed cause only, never the wrapper's surface identity or native text.
  const detail = typeof rawDetail === 'string' && rawDetail.length <= 65536
    ? [...createDetails].find(text => rawDetail === text || rawDetail.includes(': ' + text)) || 'withheld' : 'withheld';
  console.info(`METAVIEWER_SURFACE_CREATE_REFUSED code=${code} detail=${detail}`);
  if (/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  if (code === 'binding' && detail === 'profile already bound') return 'PROFILE_ALREADY_BOUND';
  if (code === 'uncertain' && detail === 'surface capacity or unresolved native outcome') return 'SURFACE_CAPACITY_OR_QUARANTINE';
  if (code === 'profile' && ['identity display pool exhausted; stop a capsule first','configured display is in use; stop its capsule first'].includes(detail)) return 'CAPSULE_SLOT_UNAVAILABLE';
  if (code === 'identity_unavailable') return 'IDENTITY_UNAVAILABLE';
  return /^[a-z][a-z0-9_]{0,55}$/.test(code) && code !== 'unknown' ? 'ADAPTER_' + code.toUpperCase() : 'SURFACE_CREATE_REFUSED';
}
/** @param {any} v @param {string} keys */
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Reflect.ownKeys(v).sort().join(',') === keys && Object.values(Object.getOwnPropertyDescriptors(v)).every(d => 'value' in d);

/** The app starts with PATH=/usr/bin:/bin; programs also install here (games in /usr/games). */
export const HOST_BINARY_STANDARD_DIRS = Object.freeze(['/usr/local/bin', '/usr/games', '/usr/local/games', '/usr/sbin', '/sbin']);
/** Resolve a bare binary name via PATH or validate an absolute path on the host without any shell. */
/** @param {unknown} binary @param {NodeJS.ProcessEnv} [env] @returns {{path:string, name:string}} */
export function resolveHostBinary(binary, env = process.env, standardDirs = HOST_BINARY_STANDARD_DIRS) {
  const trimmed = typeof binary === 'string' ? binary.trim() : '';
  const fail = (/** @type {string} */ detail) => {
    const reason = `host_program_unavailable: ${detail}`;
    return Object.assign(new Error(reason), {code:'HOST_PROGRAM_UNAVAILABLE', reason});
  };
  if (!trimmed || trimmed.length > 256) throw fail('binary name is required');
  if (/[;\s|&$`<>(){}[\]!#*?~"'\\\x00-\x1f\x7f]/.test(trimmed)) throw fail(`${trimmed}: invalid binary name`);
  const isExec = (/** @type {string} */ candidate) => {
    try { const st = statSync(candidate); return st.isFile() && (st.mode & 0o111) !== 0; }
    catch { return false; }
  };
  if (trimmed.startsWith('/')) {
    if (posix.normalize(trimmed) !== trimmed || trimmed.endsWith('/')) throw fail(`${trimmed}: path must be clean`);
    if (!isExec(trimmed)) throw fail(`${trimmed}: not found or not executable`);
    return {path:trimmed, name:posix.basename(trimmed)};
  }
  if (trimmed.includes('/') || trimmed === '.' || trimmed === '..') throw fail(`${trimmed}: relative path refused`);
  for (const dir of [...String(env?.PATH || '').split(':'), ...standardDirs]) {
    const cleanDir = dir.replace(/\/+$/, '');
    if (!cleanDir.startsWith('/') || posix.normalize(cleanDir) !== cleanDir) continue;
    const candidate = join(cleanDir, trimmed);
    if (isExec(candidate)) return {path:candidate, name:trimmed};
  }
  throw fail(`${trimmed}: not found in PATH`);
}
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
        (b.kind !== undefined && !['browser','program'].includes(b.kind)) ||
        !/^srf-(id|pg)-[a-z0-9-]+$/.test(b.container) || !id(b.run_id) ||
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
        if ((!exact(ack,'container,ready,schema,writable') && !(exact(ack,'container,kind,ready,schema,writable') && ['browser','program'].includes(ack.kind))) ||
            ack.schema !== 'srf.human-xpra/v1' ||
            ack.container !== container || ack.ready !== true || ack.writable !== !readonly) throw Error();
        resolve(true);
      } catch { reject(refuse('XPRA_MODE_UNPROVEN')); }
    });
  });
}

/** Renderer gets only role, profile ids, state, and opaque success. */
/** @param {any} options */
export function installRoleHost({electron, window, core, env, capsuleStates, admit,
  listIdentities, provisionProgramIdentity, readFreeMemoryBytes, keyboardLayout, keyboardMap, stageMode = stageOpeningMode, mode = runHumanMode, bridgeFactory = openXpraHumanBridge, tileFactory = attachXpraHumanTile}) {
  const {ipcMain} = electron;
  const defaultReadFreeMemoryBytes = async () => {
    try {
      return parseMemAvailableBytes(await readFile('/proc/meminfo', 'utf8'));
    } catch {
      return null;
    }
  };
  const readHostFreeMemory = async () => {
    const reader = typeof readFreeMemoryBytes === 'function' ? readFreeMemoryBytes : defaultReadFreeMemoryBytes;
    try {
      const measured = await reader();
      return Number.isSafeInteger(measured) && measured >= 0 ? measured : null;
    } catch {
      return null;
    }
  };
  const defaultProvisionProgramIdentity = async (/** @type {{id:string,label:string}} */ {id: profileId, label}) => {
    if (typeof env?.SRF_IDENTITY_STORE_ROOT !== 'string' || !env.SRF_IDENTITY_STORE_ROOT) {
      return {ok:true, rows:[{id:profileId, label, domains:[], logged_in:'unknown', browser:'program'}]};
    }
    const {defaultIdentityTool, identityEnvironment, identityRunner, resolveIdentityTool} = await import('./operatorBridge.js');
    const tool = resolveIdentityTool({tool:env.MV_IDENTITY_TOOL || defaultIdentityTool(), env});
    return identityRunner({tool, env:identityEnvironment(env, tool)})('create', {id:profileId, label, domains:[], browser:'program'});
  };
  const provisionIdentity = typeof provisionProgramIdentity === 'function' ? provisionProgramIdentity : defaultProvisionProgramIdentity;
  const traceBudget = {bytes:0,paused:false};
  const traceDirectory = recordingDestination(env);
  if (traceDirectory) {try {pruneHumanTraces(traceDirectory);} catch(error) {
    if (/** @type {any} */(error)?.code !== 'ENOENT') console.info('METAVIEWER_TRACE_RETENTION_REFUSED');
  }}
  const raw = env.MV_SRF_PROFILES ? JSON.parse(env.MV_SRF_PROFILES) : {};
  const profiles = configuredProfiles(env);
  // Identity names come from the trusted operator list, never from a renderer
  // profile definition. Geometry comes from one configured browser template.
  const template = [...profiles].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).find(p => {
    const configured = raw[p.id];
    return configured?.Kind === 'browser' && configured.NativeKind === 'browser'
      && configured.Width === 1280 && configured.Height === 900
      && typeof configured.RAMRoot === 'string' && configured.RAMRoot.startsWith('/dev/shm')
      && typeof configured.Display === 'string'
      && !isForeignIdentity(p.id);
  });
  const dynamicProfiles = new Map();
  const programProfiles = new Map();
  const browserProfiles = () => [...profiles, ...dynamicProfiles.values()];
  const identityAllowed = (/** @type {string} */ value) => /^[a-z0-9][a-z0-9-]{1,39}$/.test(value) && !isForeignIdentity(value);
  /** @param {string} profile */
  const roleOf = profile => raw[profile]?.default_mode ?? raw[profile]?.role ?? 'agent';
  if (profiles.some(p => !['human','agent'].includes(roleOf(p.id)))) throw refuse('CAPSULE_ROLE_INVALID');
  const openingRoles = new Map();
  const pruneProgramProfiles = () => {
    for (const [profId, entry] of programProfiles.entries()) {
      const sid = entry.surfaceId;
      const cs = sid ? capsuleStates.get(sid) : [...capsuleStates.values()].find(s => s?.profile_id === profId);
      const hs = sid && typeof core.getHumanSurface === 'function' ? core.getHumanSurface(sid) : cs;
      const csDead = !cs || cs.state === 'destroyed' || cs.state === 'lost' || cs.profile_id !== profId;
      const hsDead = !hs || hs.state === 'destroyed' || hs.state === 'lost' || hs.profile_id !== profId;
      if (csDead || hsDead) {
        programProfiles.delete(profId);
        if (sid) {
          openingRoles.delete(sid);
          if (hs && (hs.state === 'destroyed' || hs.state === 'lost') && cs && cs.state !== hs.state) {
            capsuleStates.set(sid, hs);
          } else if (!hs && cs && cs.state !== 'destroyed' && cs.state !== 'lost') {
            capsuleStates.delete(sid);
          }
        }
      }
    }
  };
  const allProfiles = () => {
    pruneProgramProfiles();
    return [...profiles, ...dynamicProfiles.values(), ...programProfiles.values()];
  };
  const roleFor = (/** @type {any} */ surface) => openingRoles.get(surface.surface_id) ?? roleOf(surface.profile_id);
  const markers = identityMarkers(join(electron.app?.getPath('userData') || env.MV_SRF_STATE_DIR, 'identity-markers'));
  const transitions = new Map();
  const sessions = new Map(), failedSessions = new Map();
  const viewStates = new Map();
  const locks = new Set();
  const epochs = new Map();
  let creating = false, disposed = false;
  /** @param {string} surfaceId */
  const authoritative = surfaceId => {
    pruneProgramProfiles();
    if (!id(surfaceId)) throw refuse('SURFACE_UNKNOWN');
    const s = core.getHumanSurface?.(surfaceId);
    if (s && isForeignIdentity(s.profile_id)) throw refuse('IDENTITY_PROTECTED');
    if (!s || s.state !== 'active' || !allProfiles().some(p => p.id === s.profile_id)) throw refuse('SURFACE_UNKNOWN');
    return s;
  };
  /** @param {string} surfaceId */
  const status = surfaceId => {
    const s = authoritative(surfaceId);
    return {role:roleFor(s), profileId:s.profile_id, control:s.control,
      view:viewStates.get(surfaceId) || {state:'closed'}, transition:transitions.get(s.profile_id) || null};
  };
  /** @param {string} surfaceId */
  async function close(surfaceId) {
    let closedRole = openingRoles.get(surfaceId);
    try { closedRole = roleFor(authoritative(surfaceId)); } catch { /* terminal row */ }
    epochs.delete(surfaceId);
    const session = sessions.get(surfaceId) ?? failedSessions.get(surfaceId);
    sessions.delete(surfaceId); failedSessions.delete(surfaceId);
    viewStates.delete(surfaceId);
    try {await session?.close();} catch(error) {failedSessions.set(surfaceId,session);throw error;}
    if (session) console.info(`METAVIEWER_XPRA_STAGE surface=${surfaceId} role=${closedRole === 'human' ? 'human' : 'watch'} stage=CLOSED detail=view_closed`);
  }
  /** @param {string} surfaceId @param {any} bounds */
  async function mount(surfaceId, bounds) {
    if (creating) throw refuse('SURFACE_CREATE_BUSY');
    bounds = validateRoleBounds(bounds);
    if (locks.has(surfaceId)) throw refuse('XPRA_VIEW_BUSY');
    locks.add(surfaceId);
    let trace = null, mountedRole = 'agent';
    try {
      const current = authoritative(surfaceId);
      if (current.control !== (roleFor(current) === 'human' ? 'human' : 'agent')) throw refuse('XPRA_ROLE_OWNERSHIP');
      if (sessions.get(surfaceId)?.active) {
        sessions.get(surfaceId).resize(bounds);
        sessions.get(surfaceId).setVisible(false);
        return {ok:true,role:roleFor(current),visible:false};
      }
      await close(surfaceId);
      const epoch = Symbol(surfaceId);
      epochs.set(surfaceId,epoch);
      const surface = authoritative(surfaceId), role = roleFor(surface);
      mountedRole = role;
      if (role === 'human' && surface.control !== 'human' || role === 'agent' && surface.control !== 'agent') throw refuse('XPRA_ROLE_OWNERSHIP');
      const binding = await readRoleBinding(env.MV_SRF_STATE_DIR, surface, role);
      if (role === 'human') {
        const directory = recordingDestination(env);
        if (!directory) throw refuse('TRACE_DESTINATION_UNSET');
        trace = createHumanTraceFile({directory, sessionId:env.MV_SESSION_ID || randomUUID(), surfaceId, capsuleId:binding.container,profileId:surface.profile_id, budget:traceBudget, onPause:() => {viewStates.set(surfaceId,{...viewStates.get(surfaceId),recording:'paused_size_limit'});}});
      }
      const active = () => {
        try { const s = authoritative(surfaceId); return !disposed && epochs.get(surfaceId) === epoch && sessions.has(surfaceId) &&
          roleFor(s) === role && s.control === (role === 'human' ? 'human' : 'agent'); } catch { return false; }
      };
      const clientKeyboardLayout = await (keyboardLayout ? keyboardLayout() : hostKeyboardLayout({...process.env,...env}));
      // Load physical keyboard support only for a mounted role view, keeping
      // production main startup's memory surface unchanged.
      const keycodes = keyboardMap ? await keyboardMap() : !keyboardLayout
        ? await (await import('./xpraKeyboard.js')).hostPhysicalKeycodes({...process.env,...env}) : undefined;
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
          return bridgeFactory({viewRoot:join(env.MV_SRF_STATE_DIR,'view'),capsule:binding.container,expectedSocketUid:10001,jquery,
            keyboard:keycodes ? {layout:clientKeyboardLayout,keycodes} : undefined});
        },
        showView: (bridge, recoverBridge) => tileFactory({electron,window,bridge,bounds,recoverBridge,
          trace:recorder || dummyTrace,isActive:active,initiallyVisible:false,capsuleId:surfaceId,writable:role === 'human',rawKeyboard:!!keycodes,
          capsuleSize:() => ({width:1280,height:900}),
          clientQuery:xpraClientQuery(role === 'human',clientKeyboardLayout),
          onFocus: () => {if(active()) window.webContents.send?.('metaviewer:role-focus.v0.3',surfaceId);},
          onState: (/** @type {string} */ state) => {
            if (!active()) return;
            viewStates.set(surfaceId,{...viewStates.get(surfaceId),state});
            if (state === 'ready') console.info(`METAVIEWER_XPRA_STAGE surface=${surfaceId} role=${role === 'human' ? 'human' : 'watch'} stage=CLIENT_CONNECTED detail=readiness_verified`);
            if (state === 'reconnecting') console.info(`METAVIEWER_XPRA_STAGE surface=${surfaceId} role=${role === 'human' ? 'human' : 'watch'} stage=LOST detail=probe_failed`);
            // Typed stage line, like the DISPLAY tier: never carries the token or the origin.
            console.info(`METAVIEWER_XPRA_STAGE surface=${surfaceId} role=${role === 'human' ? 'human' : 'watch'} stage=${(/** @type {Record<string,string>} */({connecting:'BRIDGE_UP',reconnecting:'RECONNECT',ready:'READY',lost:'LOST'}))[state] || String(state).toUpperCase()} detail=client_state`);
          },
          onFailure: async (/** @type {any} */ error) => {
            if (!active()) return;
            const code = ['XPRA_VIEW_CRASHED','XPRA_VIEW_UNRESPONSIVE','XPRA_TRACE_FAILED'].includes(error?.code)
              ? error.code : 'XPRA_TRACE_FAILED';
            const closing = close(surfaceId);
            viewStates.set(surfaceId,{state:'error',code});
            console.info(`METAVIEWER_XPRA_STAGE surface=${surfaceId} role=${role === 'human' ? 'human' : 'watch'} stage=ERROR detail=${code}`);
            try { await closing; } catch { /* typed error remains available for Reopen */ }
          }}),
        closeTrace:() => recorder?.close(),
      });
      sessions.set(surfaceId,session);
      if (!active()) throw refuse('XPRA_ROLE_OWNERSHIP');
      await session.open();
      if (!active()) { await close(surfaceId); throw refuse('XPRA_ROLE_OWNERSHIP'); }
      return {ok:true,role,visible:false};
    } catch (error) {
      if (/** @type {any} */(error)?.code === 'XPRA_CLIENT_READY_TIMEOUT') console.info(`METAVIEWER_XPRA_STAGE surface=${surfaceId} role=${mountedRole === 'human' ? 'human' : 'watch'} stage=TIMEOUT detail=XPRA_CLIENT_READY_TIMEOUT`);
      try {await close(surfaceId);} finally {trace?.close();}
      throw error;
    }
    finally { locks.delete(surfaceId); }
  }
  async function choices() {
    pruneProgramProfiles();
    const {bound} = summarizeSurfaces(capsuleStates);
    const reply = await listIdentities();
    if (reply?.ok !== true || !Array.isArray(reply.rows)) throw refuse('IDENTITY_LIST_UNAVAILABLE');
    const names = new Set(reply.rows.filter((/** @type {any} */ row) => row?.browser !== 'program' && !programProfiles.has(row?.id)).map((/** @type {any} */ row) => row.id));
    if (template) {
      for (const name of names) {
        if (!identityAllowed(name) || profiles.some(p => p.id === name)) continue;
        dynamicProfiles.set(name,{id:name,request:{...template.request,params:{...template.request.params,profile_id:name}}});
      }
      for (const name of dynamicProfiles.keys()) if (!names.has(name) && !bound.has(name)) dynamicProfiles.delete(name);
    }
    return await Promise.all(browserProfiles().filter(p=>!isForeignIdentity(p.id) && !programProfiles.has(p.id)).map(async p => {
      const entry = [...capsuleStates.values()].find(s => s.profile_id === p.id && !['destroyed','closed'].includes(s.state));
      return {profileId:p.id,role:roleOf(p.id),defaultMode:roleOf(p.id),available:names.has(p.id),
        currentMode:entry?.surface_id ? roleFor(entry) : 'closed', surfaceId:entry?.surface_id || null,
        lastLogin:await markers.read(p.id),busy:bound.has(p.id) && !entry?.surface_id};
    }));
  }

  /** @param {any} choice @param {boolean} [held] @param {string} [preferredProfileId] */
  async function createProgram(choice, held = false, preferredProfileId = '') {
    if (choice && typeof choice === 'object' && ('profileId' in choice || 'profile_id' in choice || 'profile' in choice)) {
      throw Object.assign(refuse('PROGRAM_PROFILE_FORBIDDEN'), {reason:'Renderer cannot select a profile for a program capsule.'});
    }
    if (!exact(choice, 'binary') && !exact(choice, 'binary,role')) {
      throw Object.assign(refuse('PROGRAM_BINARY_REQUIRED'), {reason:'Binary name is required.'});
    }
    if (choice.role !== undefined && !['human','agent'].includes(choice.role)) {
      throw Object.assign(refuse('CAPSULE_ROLE_INVALID'), {reason:'Invalid capsule role.'});
    }
    const role = choice.role ?? 'agent';
    const resolved = resolveHostBinary(choice.binary, {...process.env, ...env});
    if (creating && !held) throw Object.assign(refuse('SURFACE_CREATE_BUSY'), {reason:CREATE_REFUSAL_REASONS.SURFACE_CREATE_BUSY});
    creating = true;
    let key, clearMode;
    try {
      pruneProgramProfiles();
      const {live,bound} = summarizeSurfaces(capsuleStates);
      if (live >= MAX_CAPSULES) throw Object.assign(refuse('CAPSULE_LIMIT_REACHED'), {reason:formatCapsuleLimitReason(live)});
      const freeBytes = await readHostFreeMemory();
      if (freeBytes === null || freeBytes < CAPSULE_MEMORY_LIMIT_BYTES) {
        throw Object.assign(refuse('RAM_ADMISSION_REFUSED'), {reason:formatMemoryRefusalReason(freeBytes, live)});
      }
      let idReply;
      try {
        idReply = typeof listIdentities === 'function' ? await listIdentities() : null;
      } catch {
        idReply = null;
      }
      if (idReply?.ok !== true || !Array.isArray(idReply.rows) || !idReply.rows.every((/** @type {any} */ r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id.length > 0)) {
        throw Object.assign(refuse('IDENTITY_LIST_UNAVAILABLE'), {reason:CREATE_REFUSAL_REASONS.IDENTITY_LIST_UNAVAILABLE});
      }
      const knownIdentities = new Set(idReply.rows.map((/** @type {any} */ r) => r.id));
      const programIdentities = new Set(Array.isArray(idReply?.rows) ? idReply.rows.filter((/** @type {any} */ r) => r?.browser === 'program').map((/** @type {any} */ r) => r.id) : []);
      if (disposed) throw refuse('XPRA_HOST_CLOSED');
      let base = resolved.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
      if (base.length < 2) base = ('pg-' + (base || 'app')).slice(0, 30);
      const forbidden = new Set(['notepad-1','metaviewer-1','srf-egress-proxy','n8n','distil-box']);
      if (isForeignIdentity(base) || forbidden.has(base) || base.startsWith('mv-') || base === env.MV_SRF_LIVE_PROFILE) {
        throw Object.assign(refuse('IDENTITY_PROTECTED'), {reason:`${resolved.name}: protected identity name refused`});
      }
      const canUse = (/** @type {string} */ candidate) => identityAllowed(candidate) && !forbidden.has(candidate)
        && !candidate.startsWith('mv-') && candidate !== env.MV_SRF_LIVE_PROFILE
        && !raw[candidate] && !profiles.some(p => p.id === candidate)
        && !dynamicProfiles.has(candidate) && (!knownIdentities.has(candidate) || programIdentities.has(candidate))
        && !programProfiles.has(candidate) && !bound.has(candidate);
      let profileId = (preferredProfileId && canUse(preferredProfileId)) ? preferredProfileId : (canUse(base) ? base : '');
      for (let n = 2; !profileId && n <= 99; n++) {
        const candidate = `${base.slice(0, 36)}-${n}`;
        if (canUse(candidate)) profileId = candidate;
      }
      if (!profileId) throw Object.assign(refuse('CAPSULE_SLOT_UNAVAILABLE'), {reason:formatCapsuleSlotReason(live)});
      key = `pending:${profileId}`;
      capsuleStates.set(key, {profile_id:profileId, state:'creating'});
      try {
        const provReply = await provisionIdentity({id:profileId, label:resolved.name, binary:resolved.name, path:resolved.path});
        if (provReply && provReply.ok === false) {
          const pCode = typeof provReply.code === 'string' && provReply.code ? provReply.code : 'PROFILE_NOT_PROVISIONED';
          const pReason = typeof provReply.reason === 'string' && provReply.reason ? provReply.reason : pCode;
          throw Object.assign(refuse(pCode), {reason:pReason.includes(resolved.name) ? pReason : `${resolved.name}: ${pReason}`});
        }
      } catch (provErr) {
        const rawCode = typeof /** @type {any} */ (provErr)?.code === 'string' && /** @type {any} */ (provErr).code
          ? /** @type {any} */ (provErr).code
          : (typeof /** @type {any} */ (provErr)?.message === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(/** @type {any} */ (provErr).message)
            ? /** @type {any} */ (provErr).message
            : 'PROFILE_NOT_PROVISIONED');
        const rawReason = typeof /** @type {any} */ (provErr)?.reason === 'string' && /** @type {any} */ (provErr).reason
          ? /** @type {any} */ (provErr).reason
          : (typeof /** @type {any} */ (provErr)?.message === 'string' && /** @type {any} */ (provErr).message
            ? /** @type {any} */ (provErr).message
            : rawCode);
        const reason = rawReason.includes(resolved.name) ? rawReason : `${resolved.name}: ${rawReason}`;
        throw Object.assign(refuse(rawCode), {reason});
      }
      clearMode = await stageMode(env.MV_SRF_STATE_DIR, profileId, role, resolved.path);
      if (disposed) throw refuse('XPRA_HOST_CLOSED');
      const reply = await core.request({schema:'surface_request/v0.2', op:'create', params:{kind:'desktop_capsule', profile_id:profileId, geometry:{w:1280, h:900}}});
      if (reply?.schema !== 'surface_event/v0.2' || reply.event !== 'created') {
        const code = surfaceCreateRefusal(reply);
        if (code === 'HOST_PROGRAM_UNAVAILABLE') {
          const rawDetail = typeof reply?.data?.detail === 'string' ? reply.data.detail : '';
          const baseReason = rawDetail.includes('host_program_unavailable:') ? rawDetail : (rawDetail ? `host_program_unavailable: ${rawDetail}` : `host_program_unavailable: ${code}`);
          const reason = baseReason.includes(resolved.name) ? baseReason : baseReason.replace(/^host_program_unavailable:\s*/, `host_program_unavailable: ${resolved.name}: `);
          throw Object.assign(refuse(code), {reason});
        }
        const reason = code === 'CAPSULE_LIMIT_REACHED'
          ? formatCapsuleLimitReason(live)
          : code === 'CAPSULE_SLOT_UNAVAILABLE' || code === 'SURFACE_CAPACITY_OR_QUARANTINE'
            ? formatCapsuleSlotReason(live)
            : code === 'RAM_ADMISSION_REFUSED'
              ? formatMemoryRefusalReason(freeBytes, live)
              : createRefusalReason(code);
        throw Object.assign(refuse(code), {reason});
      }
      const surface = reply.data.surface;
      if (disposed || !id(surface?.surface_id) || surface.profile_id !== profileId || surface.state !== 'active' || (choice.role !== undefined && surface.control !== undefined && surface.control !== role)) {
        if (id(surface?.surface_id)) {
          capsuleStates.set(surface.surface_id, surface);
          const stopped = await core.stopSurface?.(surface.surface_id);
          if (stopped?.event !== 'state_changed' || stopped.data?.surface?.surface_id !== surface.surface_id || stopped.data.surface.state !== 'destroyed') throw refuse('CAPSULE_STOP_UNPROVEN');
          capsuleStates.set(surface.surface_id, stopped.data.surface);
        }
        throw refuse(disposed ? 'XPRA_HOST_CLOSED' : 'CAPSULE_MODE_UNPROVEN');
      }
      openingRoles.set(surface.surface_id, role);
      programProfiles.set(profileId, {id:profileId, surfaceId:surface.surface_id, binary:resolved.name, path:resolved.path, role});
      capsuleStates.set(surface.surface_id, surface);
      return {ok:true, surfaceId:surface.surface_id, profileId, role, binary:resolved.name, path:resolved.path};
    } finally {
      if (key) capsuleStates.delete(key);
      try { await clearMode?.(); } catch { /* keep original error and always reset creating */ }
      creating = false;
    }
  }

  /** @param {any} choice */
  async function create(choice, held = false) {
    if (!exact(choice,'profileId,role') || !['human','agent'].includes(choice.role) || !id(choice.profileId)) throw refuse('CAPSULE_ROLE_INVALID');
    if (isForeignIdentity(choice.profileId)) throw refuse('IDENTITY_PROTECTED');
    if (creating && !held) throw refuse('SURFACE_CREATE_BUSY');
    creating = true;
    let key, clearMode;
    try {
      pruneProgramProfiles();
      const {live,bound} = summarizeSurfaces(capsuleStates);
      if (bound.has(choice.profileId)) throw refuse('PROFILE_ALREADY_BOUND');
      if (live >= MAX_CAPSULES) throw Object.assign(refuse('CAPSULE_LIMIT_REACHED'), {reason:formatCapsuleLimitReason(live)});
      const freeBytes = await readHostFreeMemory();
      if (freeBytes === null || freeBytes < CAPSULE_MEMORY_LIMIT_BYTES) {
        throw Object.assign(refuse('RAM_ADMISSION_REFUSED'), {reason:formatMemoryRefusalReason(freeBytes, live)});
      }
      const available = await choices();
      if (disposed) throw refuse('XPRA_HOST_CLOSED');
      const profile = browserProfiles().find(p => p.id === choice.profileId && !programProfiles.has(p.id));
      if (!profile || !available.find(p => p.profileId === profile.id)?.available) throw refuse('NO_IDENTITY');
      key = `pending:${profile.id}`;
      capsuleStates.set(key,{profile_id:profile.id,state:'creating'});
      clearMode = await stageMode(env.MV_SRF_STATE_DIR, profile.id, choice.role);
      if (disposed) throw refuse('XPRA_HOST_CLOSED');
      const reply = await core.request(profile.request);
      if (reply?.schema !== 'surface_event/v0.2' || reply.event !== 'created') throw refuse(surfaceCreateRefusal(reply));
      const surface = reply.data.surface;
      if (disposed || !id(surface?.surface_id) || surface.profile_id !== profile.id || surface.state !== 'active' || surface.control !== choice.role) {
        // The created acknowledgement is host authority even when its requested
        // mode cannot be proved. Compensate before releasing the pending slot.
        if (id(surface?.surface_id)) {
          capsuleStates.set(surface.surface_id,surface);
          const stopped = await core.stopSurface?.(surface.surface_id);
          if (stopped?.event !== 'state_changed' || stopped.data?.surface?.surface_id !== surface.surface_id || stopped.data.surface.state !== 'destroyed') throw refuse('CAPSULE_STOP_UNPROVEN');
          capsuleStates.set(surface.surface_id,stopped.data.surface);
        }
        throw refuse(disposed ? 'XPRA_HOST_CLOSED' : 'CAPSULE_MODE_UNPROVEN');
      }
      openingRoles.set(surface.surface_id,choice.role);
      capsuleStates.set(surface.surface_id,surface);
      return {ok:true,surfaceId:surface.surface_id,role:choice.role};
    } finally {
      if (key) capsuleStates.delete(key);
      try { await clearMode?.(); } catch { /* keep original error and always reset creating */ }
      if (!held) creating = false;
    }
  }
  /** Only an acknowledged destroy releases a profile for a fresh capsule. */
  /** @param {string} surfaceId */
  async function stop(surfaceId) {
    const surface = authoritative(surfaceId);
    await close(surfaceId);
    if (typeof core.stopSurface !== 'function') throw refuse('CAPSULE_STOP_UNAVAILABLE');
    const reply = await core.stopSurface(surfaceId);
    if (reply?.schema !== 'surface_event/v0.2' || reply.event !== 'state_changed' ||
        reply.data?.surface?.surface_id !== surfaceId || reply.data.surface.state !== 'destroyed') throw refuse('CAPSULE_STOP_UNPROVEN');
    capsuleStates.set(surfaceId,reply.data.surface);
    openingRoles.delete(surfaceId);
    programProfiles.delete(surface.profile_id);
    return {ok:true,profileId:surface.profile_id};
  }
  /** @param {string} surfaceId */
  async function switchMode(surfaceId) {
    if (creating) throw refuse('SURFACE_CREATE_BUSY');
    const surface = authoritative(surfaceId), profileId = surface.profile_id;
    const role = roleFor(surface) === 'human' ? 'agent' : 'human';
    const program = programProfiles.get(profileId);
    creating = true;
    transitions.set(profileId,'stopping');
    try {
      await stop(surfaceId);
      transitions.set(profileId,'starting');
      if (program) {
        return await createProgram({binary:program.path,role},true,profileId);
      }
      // A new surface identity has no VERIFIED frame. Existing core/P14 fences
      // require its first fresh capture before any proposal can be admitted.
      return await create({profileId,role},true);
    } finally { creating = false; transitions.delete(profileId); }
  }
  /** @param {any} choice */
  async function openIdentity(choice) {
    pruneProgramProfiles();
    if (!exact(choice,'profileId,role') || !['human','agent'].includes(choice.role) || !id(choice.profileId)) throw refuse('CAPSULE_ROLE_INVALID');
    if (isForeignIdentity(choice.profileId)) throw refuse('IDENTITY_PROTECTED');
    if (creating) throw refuse('SURFACE_CREATE_BUSY');
    if (programProfiles.has(choice.profileId)) throw refuse('NO_IDENTITY');
    const surface = [...capsuleStates.values()].find(s => s.profile_id === choice.profileId && s.state !== 'destroyed');
    if (surface) {
      if (!surface.surface_id || surface.state !== 'active') throw refuse('PROFILE_ALREADY_BOUND');
      if (roleFor(surface) !== choice.role) return {ok:false,code:'PROFILE_ALREADY_BOUND',surfaceId:surface.surface_id,currentMode:roleFor(surface),requestedMode:choice.role};
      return {ok:true,reused:true,surfaceId:surface.surface_id,role:choice.role};
    }
    return await create(choice);
  }
  /** @param {any} event @param {any} message */
  const handler = async (event, message) => {
    if (disposed || !admit(event) || !message || message.schema !== 'metaviewer.roles/v0.3') throw refuse('XPRA_SENDER_REFUSED');
    const {op} = message;
    const keys = ['choices','surfaces'].includes(op) ? 'op,schema' : ['create','open','create-program'].includes(op) ? 'choice,op,schema'
      : ['mount','resize'].includes(op) ? 'bounds,op,schema,surfaceId'
      : op === 'visibility' ? 'op,schema,surfaceId,visible' : 'op,schema,surfaceId';
    if (!exact(message,keys)) throw refuse('XPRA_PAYLOAD_REFUSED');
    try {
      if (op === 'choices') return await choices();
      if (op === 'surfaces') {
        pruneProgramProfiles();
        return [...capsuleStates.values()].filter(s => s.surface_id && s.state === 'active' && roleFor(s) === 'human')
          .map(s => ({schema:'metaviewer.role_surface/v0.3',role:'human',surface:rendererSurface(authoritative(s.surface_id))}));
      }
      if (op === 'create') return await create(message.choice);
      if (op === 'create-program') return await createProgram(message.choice);
      if (op === 'open') return await openIdentity(message.choice);
      if (op === 'switch') return await switchMode(message.surfaceId);
      if (op === 'stop') {
        if (creating) throw refuse('SURFACE_CREATE_BUSY');
        creating = true; try { return await stop(message.surfaceId); } finally { creating = false; }
      }
      if (op === 'confirm-login') {
        const surface = authoritative(message.surfaceId);
        if (roleFor(surface) !== 'human' || surface.control !== 'human') throw refuse('LOGIN_CONFIRMATION_REQUIRES_HUMAN');
        return {ok:true,lastLogin:await markers.confirm(surface.profile_id)};
      }
      if (op === 'raise') {authoritative(message.surfaceId);sessions.get(message.surfaceId)?.bringToFront();return {ok:true};}
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
    } catch (error) {
      const code = typeof /** @type {any} */ (error)?.code === 'string' ? /** @type {any} */ (error).code : 'XPRA_REFUSED';
      const reason = typeof /** @type {any} */ (error)?.reason === 'string' ? /** @type {any} */ (error).reason : undefined;
      return reason ? {ok:false,code,reason} : {ok:false,code};
    }
  };
  ipcMain.handle(CHANNEL,handler);
  const parentSession = window.webContents.session;
  const preloadId = parentSession.registerPreloadScript({type:'frame',filePath:fileURLToPath(new URL('./rolePreload.cjs',import.meta.url))});
  // Capsule loss or emergency agent takeover immediately revokes the watch.
  const timer = setInterval(() => {
    pruneProgramProfiles();
    for (const surfaceId of new Set([...sessions.keys(),...failedSessions.keys()])) {
      try { const s = status(surfaceId); if (failedSessions.has(surfaceId) || s.control !== (s.role === 'human' ? 'human' : 'agent')) void close(surfaceId).catch(()=>{}); }
      catch { void close(surfaceId).catch(()=>{}); }
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
    await Promise.all([...new Set([...sessions.keys(),...failedSessions.keys()])].map(close));
    epochs.clear(); openingRoles.clear(); programProfiles.clear();
  }
  return Object.freeze({dispose});
}
