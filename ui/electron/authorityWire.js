// @ts-check
/** [TARGET, unit decision] Host binding for the authority lane. Core requests use
 * {op:'propose'|'intent',json}; the core remains the admission authority. A trusted
 * frame source supplies reader/port capabilities; paths never cross IPC.
 * Side-terminal commands are host-owned profile IDs and exact argv matches.
 * Frame stream cap = 64 [TARGET, unit decision]; stream lifetimes follow the
 * existing port revocation/ACK deadlines and the main window's teardown.
 */
import { open, mkdir, rename, unlink, lstat, realpath } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { join, isAbsolute, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { observeSender, PRIVILEGED_ORIGIN } from './main.js';
import { createFrameReader } from './frameReader.js';
import { createFramePort } from './framePort.js';
import { createTerminalFacade, validateProviderArgv } from './ptyBroker.js';

export const WIRE_CHANNELS = Object.freeze({
  loadSettings:'metaviewer:settings.load', saveSettings:'metaviewer:settings.save',
  recordingDestination:'metaviewer:recording.destination', nestedDepth:'metaviewer:nested.depth',
  selfCapsuleId:'metaviewer:nested.self', propose:'metaviewer:authority.propose',
  intent:'metaviewer:authority.intent', subscribeFrames:'metaviewer:authority.subscribe',
  unsubscribeFrames:'metaviewer:authority.unsubscribe',
  terminalOpen:'metaviewer:side-terminal.open', terminalEnabled:'metaviewer:side-terminal.enabled',
});
export const WIRE_MAX_BYTES = 256 * 1024;
export const INTENT_OPS = Object.freeze({
  take_control: 'surface_id', release_control: 'surface_id',
  fold: 'slot_id', unfold: 'slot_id', hide: 'slot_id', show: 'slot_id',
  move: 'group_id,index,slot_id', tab: 'group_id,index,slot_id',
  float: 'height_px,slot_id,width_px,x_px,y_px',
});
/** @param {any} body @param {()=>Error} [error] */
export function validateIntentBody(body, error = () => new Error('INTENT')) {
  const validId = (/** @type {unknown} */ value) => typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(value);
  const keys = body && typeof body.op === 'string' && Object.hasOwn(INTENT_OPS, body.op)
    ? INTENT_OPS[/** @type {keyof typeof INTENT_OPS} */ (body.op)] : null;
  const idKey = keys === 'surface_id' ? 'surface_id' : 'slot_id';
  if (!keys || Object.keys(body).sort().join(',') !== 'op,params,request_id,schema'
      || body.schema !== 'ui_intent/v0.2' || !validId(body.request_id)
      || !body.params || Array.isArray(body.params) || typeof body.params !== 'object'
      || Object.keys(body.params).sort().join(',') !== keys || !validId(body.params[idKey])) throw error();
  const p = body.params;
  if (keys === 'group_id,index,slot_id' && (!validId(p.group_id)
      || !Number.isInteger(p.index) || p.index < 0 || p.index > 255)) throw error();
  if (body.op === 'float') {
    for (const key of ['height_px', 'width_px', 'x_px', 'y_px']) {
      const size = key === 'height_px' || key === 'width_px';
      if (!Number.isInteger(p[key]) || p[key] < (size ? 1 : 0) || p[key] > (size ? 16384 : 16383)) throw error();
    }
  }
  return body;
}
/** @param {unknown} value @returns {any} */
export function jsonObject(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value,'utf8') > WIRE_MAX_BYTES) throw new Error('PAYLOAD');
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('PAYLOAD');
  return parsed;
}
/** @param {any} value */
export function verdictReply(value) {
  const keys = value && Object.keys(value).sort().join(',');
  const refused = value?.decision === 'refused';
  if (!value || value.schema !== 'action_verdict/v0.2'
      || typeof value.proposal_id !== 'string' || !value.proposal_id.length || value.proposal_id.length > 128
      || !Number.isSafeInteger(value.core_seq) || value.core_seq < 1
      || (value.decision !== 'admitted' && !refused)
      || keys !== (refused ? 'core_seq,decision,proposal_id,reason_code,schema' : 'core_seq,decision,proposal_id,schema')
      || (refused && !['STALE_FRAME','SURFACE_NOT_AGENT_CONTROLLED','LOCKED_BY_OTHER','BUDGET_EXCEEDED','OUT_OF_BOUNDS','POLICY'].includes(value.reason_code))) throw new Error('OUTCOME');
  return value;
}
/** Renderer preferences use the exact closed settingsModel.js shape.
 * Missing keys default only as decodeMvSettings does. Invalid input never
 * replaces disk; corrupt storage returns the renderer's defaults signal.
 * @param {string} text */
export function validateSettings(text) {
  const value=jsonObject(text);
  if(Object.keys(value).some(key=>!['scheme','density'].includes(key))) throw new Error('SETTINGS_UNKNOWN_KEY');
  const scheme=value.scheme===undefined?'mv-light':value.scheme;
  const density=value.density===undefined?'compact':value.density;
  if(!['mv-light','mv-dark'].includes(scheme)) throw new Error('SETTINGS_SCHEME');
  if(density!=='compact') throw new Error('SETTINGS_DENSITY');
  return {scheme,density};
}
const sourceRoot=fileURLToPath(new URL('../..',import.meta.url));
/** @param {string} candidate */
function outsideSource(candidate) {
  const rel=relative(sourceRoot,resolve(candidate));
  if(rel==='' || (rel!=='..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw new Error('SETTINGS_IN_REPO');
}
/** [TARGET, unit decision] Recording is host configuration, separate from
 * renderer preferences. MV_RECORDING_DESTINATION is an explicit operator
 * directory, validated once at wire installation; unset/empty stays null.
 * This resolved path stays main-side; the renderer receives only its opaque token.
 * @param {NodeJS.ProcessEnv} env */
export function recordingDestination(env) {
  const destination=env.MV_RECORDING_DESTINATION;
  if(destination===undefined || destination==='') return null;
  if(!isAbsolute(destination) || destination.length>4096 || /[\0\r\n]/.test(destination)) throw new Error('SETTINGS_DESTINATION');
  const path=realpathSync(resolve(destination));
  outsideSource(path);
  return path;
}
/** Atomic private settings file. No caller-supplied pathname.
 * @param {NodeJS.ProcessEnv} env */
export function createSettingsStore(env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  if (!isAbsolute(base)) throw new Error('CONFIG_PATH');
  const dir = join(base,'metaviewer');
  const path = join(dir,'settings.json');
  outsideSource(path);
  // Check the nearest existing ancestor before mkdir can follow parent aliases.
  const checkAncestors=async()=> {
    let ancestor=dir;
    for(;;) {
      try { await lstat(ancestor); }
      catch(e) {
        if(/** @type {NodeJS.ErrnoException} */(e).code!=='ENOENT') throw e;
        const parent=dirname(ancestor);
        if(parent===ancestor) throw new Error('CONFIG_PATH');
        ancestor=parent; continue;
      }
      // An existing but unresolvable entry is not an absent directory. Live
      // outside-source symlink ancestors remain supported, as before.
      let canonical;
      try { canonical=await realpath(ancestor); }
      catch(e) {
        if(/** @type {NodeJS.ErrnoException} */(e).code==='ENOENT') throw new Error('SETTINGS_DIRECTORY');
        throw e;
      }
      outsideSource(canonical); return;
    }
  };
  const checkDirectory=async()=> {
    const info=await lstat(dir);
    if(!info.isDirectory() || info.isSymbolicLink() || (info.mode&0o777)!==0o700
      || (process.getuid && info.uid!==process.getuid())) throw new Error('SETTINGS_DIRECTORY');
    outsideSource(await realpath(dir));
  };
  return Object.freeze({
    async load() {
      let file;
      try { await checkAncestors(); await checkDirectory(); file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (e) { if (/** @type {NodeJS.ErrnoException} */(e).code === 'ENOENT') return null; throw e; }
      try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600
            || (process.getuid && stat.uid !== process.getuid())) throw new Error('SETTINGS_FILE');
        const buffer = Buffer.alloc(WIRE_MAX_BYTES + 1);
        const {bytesRead} = await file.read(buffer,0,buffer.length,0);
        if (stat.size > WIRE_MAX_BYTES || bytesRead > WIRE_MAX_BYTES) {
          console.warn('MetaViewer settings: file exceeds byte cap; using defaults'); return null;
        }
        const text = buffer.subarray(0,bytesRead).toString('utf8');
        try { validateSettings(text); return text; }
        catch { console.warn('MetaViewer settings: invalid JSON or schema; using defaults'); return null; }
      } finally { await file.close(); }
    },
    /** @param {string} json */
    async save(json) {
      validateSettings(json); await checkAncestors(); await mkdir(dir,{recursive:true,mode:0o700});await checkDirectory();
      const temp = join(dir,`.settings-${randomUUID()}.tmp`);
      try {
        const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
        try { await file.writeFile(json,'utf8'); await file.sync(); } finally { await file.close(); }
        await rename(temp,path);
        const directory = await open(dir,constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
        return true;
      } finally { await unlink(temp).catch(e => { if(e.code !== 'ENOENT') throw e; }); }
    },
  });
}
/** @param {string[]} argv @param {NodeJS.ProcessEnv} env */
export function nestedIdentity(argv,env) {
  const flags = argv.filter(x=>x.startsWith('--nested-depth'));
  if (flags.length > 1 || (flags.length && !['--nested-depth=0','--nested-depth=1'].includes(flags[0]))) throw new Error('NESTED_DEPTH');
  const self = env.MV_SELF_CAPSULE_ID ?? null;
  if (self !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(self)) throw new Error('CAPSULE_ID');
  return {depth:flags.length ? Number(flags[0].slice(-1)) : null,self};
}
/** @param {any} options */
export function installAuthorityWire({ipcMain,contents,core,env=process.env,argv=process.argv.slice(1),terminal=null,profiles=new Map(),frames=null}) {
  if (terminal?.request && terminal?.subscribe) terminal=createSideTerminalAdapter(terminal);
  const store = createSettingsStore(env);
  const destination = recordingDestination(env);
  const destinationToken = destination === null ? null : 'recording:configured';
  const identity = nestedIdentity(argv,env);
  const channels = /** @type {string[]} */([]);
  const ownedProfiles = new Map([...profiles].map(([id,profile])=>[id,{args:[...validateProviderArgv([id,...profile.args])].slice(1)}]));
  let subscribed = false, enabled = false, disposed = false;
  const handlers = {
    loadSettings: async () => store.load(),
    saveSettings: async (/** @type {string} */json) => store.save(json),
    recordingDestination: async () => destinationToken,
    nestedDepth: async () => identity.depth,
    selfCapsuleId: async () => identity.self,
    propose: async (/** @type {string} */json) => {
      jsonObject(json); return verdictReply(await core.request({op:'propose',json}));
    },
    intent: async (/** @type {string} */json) => {
      validateIntentBody(jsonObject(json));
      if (await core.request({op:'intent',json}) !== true) throw new Error('OUTCOME'); return true;
    },
    subscribeFrames: async () => {
      subscribed=true;
      const queued=[...pendingEntries.values()];
      pendingEntries.clear();
      for (const entry of queued) {
        if (!subscribed || disposed) break;
        await deliverAuthorityFrame(entry,contents,streams);
      }
      return true;
    },
    unsubscribeFrames: async () => { subscribed=false; return true; },
    terminalEnabled: async (/** @type {boolean} */value) => {
      if (typeof value !== 'boolean') throw new Error('PAYLOAD');
      if (!terminal || await terminal.setEnabled(value) !== true) throw new Error('OUTCOME'); enabled=value; return true;
    },
    terminalOpen: async (/** @type {any} */value) => {
      if (!value || Object.keys(value).sort().join(',') !== 'args,cols,command,rows'
          || typeof value.command !== 'string' || !Array.isArray(value.args)
          || !Number.isSafeInteger(value.cols) || value.cols < 2 || value.cols > 500
          || !Number.isSafeInteger(value.rows) || value.rows < 2 || value.rows > 300) throw new Error('PAYLOAD');
      const argv = validateProviderArgv([value.command,...value.args]);
      const profile=ownedProfiles.get(value.command);
      if (!profile || JSON.stringify(profile.args) !== JSON.stringify(argv.slice(1))) throw new Error('COMMAND_NOT_ALLOWED');
      if (!terminal || !enabled) throw new Error('TERMINAL_DISABLED');
      const result=await terminal.open({command:'provider',provider:value.command,cols:value.cols,rows:value.rows});
      if (!result || Object.keys(result).join(',') !== 'session' || typeof result.session !== 'string'
          || !/^[A-Za-z0-9._-]{1,128}$/.test(result.session)) throw new Error('OUTCOME');
      return {session:result.session};
    },
  };
  try {
    for (const [name,fn] of Object.entries(handlers)) {
      const channel=WIRE_CHANNELS[/** @type {keyof typeof WIRE_CHANNELS} */(name)];
      const arity=['saveSettings','propose','intent','terminalOpen','terminalEnabled'].includes(name) ? 1 : 0;
      ipcMain.handle(channel,/** @param {unknown} event @param {...any} args */ async (event,...args) => {
        if (disposed || observeSender(event,contents,PRIVILEGED_ORIGIN).verdict !== 'admit') throw new Error('SENDER');
        if (args.length !== arity) throw new Error('ARGS');
        if (arity && (JSON.stringify(args[0]) === undefined || Buffer.byteLength(typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]),'utf8') > WIRE_MAX_BYTES)) throw new Error('PAYLOAD');
        return /** @type {any} */(fn)(...args);
      }); channels.push(channel);
    }
  } catch(e) { for (const channel of channels) ipcMain.removeHandler?.(channel); throw e; }
  // The source owns reader/port capabilities and calls deliver; no frame path is sent.
  /** @type {Map<string, any>} */ const pendingEntries = new Map();
  /** @type {Set<any>} */ const streams = new Set();
  const stopFrames = frames ? frames.subscribe(async (/** @type {any} */entry) => {
    if (disposed) return;
    if (!subscribed) {
      const sid = entry?.frameRef?.surface_id;
      if (typeof sid === 'string') {
        const prior = pendingEntries.get(sid);
        if (entry.stateOnly && prior && !prior.stateOnly) {
          pendingEntries.set(sid, {...prior, state: entry.state});
        } else {
          pendingEntries.set(sid, entry);
        }
      }
      return;
    }
    await deliverAuthorityFrame(entry,contents,streams);
  }) : () => {};
  return {async dispose() { disposed=true; subscribed=false; stopFrames();
    pendingEntries.clear();
    for(const stream of [...streams]) {await stream.reader.closeReader();stream.port.revokeFramePort('SHUTDOWN');}
    streams.clear();terminal?.dispose?.();for(const channel of channels) ipcMain.removeHandler?.(channel);
  }};
}
/** Trusted host frame capability entry: readerOptions/portOptions, state, frameRef.
 * @param {any} entry @param {any} contents @param {Set<any>} streams */
export async function deliverAuthorityFrame(entry,contents,streams) {
  const raw=entry.frameRef;
  const ref={schema:raw.schema,surface_id:raw.surface_id,generation:raw.generation,tick:raw.tick,
    ts_ns:raw.ts_ns,width:raw.width,height:raw.height,format:raw.format,sha256:raw.sha256,capture_us:raw.capture_us};
  // Closed metadata projection, never spreads adapter state or frame paths.
  const rawState=entry.state;
  const state={schema:rawState.schema,surface_id:rawState.surface_id,kind:rawState.kind,display:rawState.display,
    geometry:{w:rawState.geometry?.w,h:rawState.geometry?.h},state:rawState.state,
    visibility:rawState.visibility,control:rawState.control,profile_id:rawState.profile_id};
  if(state.schema!=='surface/v0.2' || state.surface_id!==ref.surface_id
      || !['desktop_capsule','browser','game_capsule','vm'].includes(state.kind)
      || typeof state.display!=='string' || !state.display.length || state.display.length>65536
      || !Number.isSafeInteger(state.geometry.w) || state.geometry.w<1
      || !Number.isSafeInteger(state.geometry.h) || state.geometry.h<1
      || !['active','standby','ceded','destroyed','lost'].includes(state.state)
      || !['folded','unfolded','pinned'].includes(state.visibility)
      || !['agent','human','shared'].includes(state.control)
      || typeof state.profile_id!=='string' || !state.profile_id.length || state.profile_id.length>128) throw new Error('SURFACE_STATE');
  if (entry.stateOnly) {
    contents.postMessage('metaviewer:authority.frames',{frame_ref:ref,surface:state},[]);
    return true;
  }
  const binding=entry.readerOptions.binding;
  const bindingKeys=['principal','epoch','surfaceId','surfaceGeneration'];
  const key=JSON.stringify(bindingKeys.map(name=>binding[name]));
  let stream=[...streams].find(item=>item.key===key);
  if (!stream) {
    if (streams.size>=64) throw new Error('FRAME_STREAM_CAP');
    if (bindingKeys.some(name=>binding[name]!==entry.portOptions.binding?.[name]) || entry.portOptions.role!=='sender') throw new Error('FRAME_BINDING');
    let currentAcquire=entry.readerOptions.acquirePublishedLease;
    const reader=createFrameReader({...entry.readerOptions,acquirePublishedLease:(/** @type {any} */req)=>currentAcquire(req)});
    let port;
    const revoke=entry.portOptions.onRevoke;
    try { port=createFramePort({...entry.portOptions,onRevoke:(/** @type {any} */notice)=>{
      streams.delete(stream);void reader.closeReader();revoke(notice);
    }}); } catch(e) {await reader.closeReader();throw e;}
    stream={key,reader,port,announced:false,setAcquire:(/** @type {any} */fn)=>{currentAcquire=fn;}};streams.add(stream);
  } else {
    stream.setAcquire?.(entry.readerOptions.acquirePublishedLease);
  }
  const result=await stream.reader.readFrame(entry.frameRef);
  if (!result.ok) return false;
  const sent=stream.port.postFrame(result.frame);
  if (!sent.ok) return false;
  try {
    contents.postMessage('metaviewer:authority.frames',{frame_ref:ref,surface:state},stream.announced ? [] : (entry.rendererPorts || []));
    stream.announced=true;
  } catch(error) {stream.port.revokeFramePort('SHUTDOWN');throw error;}

  return sent.ok;
}

/** [TARGET, unit decision] Adapter to the existing closed PTY facade. The host
 * supplies registerTerminalIpc request/subscribe seams; the renderer has no owner
 * envelope, executable, cwd, environment, or shell-string capability.
 * @param {any} options */
export function createSideTerminalAdapter(options) {
  const facade=createTerminalFacade(options);
  return {
    /** @param {boolean} enabled */
    async setEnabled(enabled) { facade.setEnabled(enabled);return true; },
    /** @param {any} spec */
    async open(spec) {
      const capabilities=await facade.capabilities();
      if (capabilities.ok!==true) throw new Error('TERMINAL_UNAVAILABLE');
      const result=await facade.open(spec);
      if(result.ok!==true || typeof result.session!=='string') throw new Error('TERMINAL_REFUSED');
      return {session:result.session};
    },
    dispose:()=>facade.dispose(),
  };
}
