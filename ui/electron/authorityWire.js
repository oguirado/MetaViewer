// @ts-check
/** [TARGET, unit decision] Host binding for the authority lane. Core requests use
 * {op:'propose'|'intent',json}; the core remains the admission authority. A trusted
 * frame source supplies reader/port capabilities; paths never cross IPC.
 * Side-terminal commands are host-owned profile IDs and exact argv matches.
 * Frame stream cap = 64 [TARGET, unit decision]; stream lifetimes follow the
 * existing port revocation/ACK deadlines and the main window's teardown.
 */
import { open, mkdir, rename, unlink, lstat, realpath } from 'node:fs/promises';
import { constants, realpathSync, statSync } from 'node:fs';
import { join, isAbsolute, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { MainError, observeSender, PRIVILEGED_ORIGIN } from './main.js';
import { createFrameReader } from './frameReader.js';
import { createFramePort } from './framePort.js';
import { createTerminalFacade, validateProviderArgv } from './ptyBroker.js';

export const WIRE_CHANNELS = Object.freeze({
  loadSettings:'metaviewer:settings.load', saveSettings:'metaviewer:settings.save',
  recordingDestination:'metaviewer:recording.destination', nestedDepth:'metaviewer:nested.depth',
  selfCapsuleId:'metaviewer:nested.self', propose:'metaviewer:authority.propose',
  intent:'metaviewer:authority.intent',
  subscribeFrames:'metaviewer:authority.subscribe',
  unsubscribeFrames:'metaviewer:authority.unsubscribe',
  terminalOpen:'metaviewer:side-terminal.open', terminalEnabled:'metaviewer:side-terminal.enabled',
});
export const SURFACE_INPUT_CHANNEL = WIRE_CHANNELS.intent;
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
  if (!keys || Reflect.ownKeys(body).length !== Object.keys(body).length
      || Reflect.ownKeys(body).sort().join(',') !== 'op,params,request_id,schema'
      || body.schema !== 'ui_intent/v0.2' || !validId(body.request_id)
      || !body.params || Array.isArray(body.params) || typeof body.params !== 'object'
      || Reflect.ownKeys(body.params).length !== Object.keys(body.params).length
      || Reflect.ownKeys(body.params).sort().join(',') !== keys || !validId(body.params[idKey])) throw error();
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
const HUMAN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/;
const HUMAN_KEY_TOKEN_RE = /^[A-Za-z0-9_+]{1,32}(?![\s\S])/;
export const SURFACE_INPUT_CODES = Object.freeze([
  'NOT_IN_CONTROL',
  'SURFACE_UNKNOWN',
  'STALE_STREAM',
  'LIMIT',
  'NESTED_DISPLAY_ONLY',
  'SCHEMA',
  'CORE_UNAVAILABLE',
]);
const SURFACE_INPUT_CODE_SET = new Set(SURFACE_INPUT_CODES);
const SURFACE_INPUT_MAX_EVENTS = 32;
const SURFACE_INPUT_MAX_BYTES = 16 * 1024;
const SURFACE_INPUT_MAX_BATCHES_PER_SEC = 60;
/** @param {string} text */
function isWellFormedString(text) {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = text.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) i += 1;
      else return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
/** @param {any} v @param {string} keys */
function exactDataKeys(v, keys) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
    && Reflect.ownKeys(v).length === keys.split(',').length
    && Object.keys(v).sort().join(',') === keys
    && Object.values(Object.getOwnPropertyDescriptors(v)).every(d => 'value' in d);
}
/** @param {unknown} code @returns {string} */
export function mapSurfaceInputRefusal(code) {
  if (typeof code === 'string' && SURFACE_INPUT_CODE_SET.has(code)) return code;
  if (code === 'LOCKED_BY_OTHER' || code === 'SURFACE_NOT_HUMAN_CONTROLLED' || code === 'SURFACE_NOT_AGENT_CONTROLLED') {
    return 'NOT_IN_CONTROL';
  }
  if (code === 'STALE_FRAME') return 'STALE_STREAM';
  if (code === 'BUDGET_EXCEEDED') return 'LIMIT';
  if (code === 'OUT_OF_BOUNDS' || code === 'POLICY' || code === 'PAYLOAD') return 'SCHEMA';
  return 'CORE_UNAVAILABLE';
}
/** @param {unknown} raw @returns {{ok:true,batch:any}|{ok:false,code:'SCHEMA'|'LIMIT'}} */
export function validateSurfaceInputBatch(raw) {
  if (!exactDataKeys(raw, 'events,schema,seq,stream_id,surface_id')) {
    return { ok: false, code: 'SCHEMA' };
  }
  const rec = /** @type {Record<string, any>} */ (raw);
  if ((rec.schema !== 'surface_input/v1' && rec.schema !== 'surface_input/v0.2')
      || typeof rec.surface_id !== 'string' || !HUMAN_ID_RE.test(rec.surface_id)
      || !Number.isSafeInteger(rec.stream_id) || rec.stream_id < 0
      || !Number.isSafeInteger(rec.seq) || rec.seq < 1
      || !Array.isArray(rec.events) || Object.getPrototypeOf(rec.events) !== Array.prototype
      || rec.events.length < 1 || Reflect.ownKeys(rec.events).length !== rec.events.length + 1) {
    return { ok: false, code: 'SCHEMA' };
  }
  const inspectCount = Math.min(rec.events.length, 256);
  const events = [];
  let hasOverlongTypeText = false;
  for (let i = 0; i < inspectCount; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(rec.events, i);
    if (!desc || !('value' in desc)) return { ok: false, code: 'SCHEMA' };
    const ev = desc.value;
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)
        || (Object.getPrototypeOf(ev) !== Object.prototype && Object.getPrototypeOf(ev) !== null)) {
      return { ok: false, code: 'SCHEMA' };
    }
    if (ev.kind === 'click') {
      if (!exactDataKeys(ev, 'button,kind,x,y')
          || !Number.isSafeInteger(ev.x) || ev.x < 0 || ev.x > 65535
          || !Number.isSafeInteger(ev.y) || ev.y < 0 || ev.y > 65535
          || !['left', 'middle', 'right'].includes(ev.button)) {
        return { ok: false, code: 'SCHEMA' };
      }
      events.push(Object.freeze({ kind: 'click', x: ev.x, y: ev.y, button: ev.button }));
    } else if (ev.kind === 'key') {
      if (!exactDataKeys(ev, 'keys,kind')
          || !Array.isArray(ev.keys) || Object.getPrototypeOf(ev.keys) !== Array.prototype
          || ev.keys.length < 1 || ev.keys.length > 8
          || Reflect.ownKeys(ev.keys).length !== ev.keys.length + 1) {
        return { ok: false, code: 'SCHEMA' };
      }
      const keys = [];
      for (let j = 0; j < ev.keys.length; j += 1) {
        const kDesc = Object.getOwnPropertyDescriptor(ev.keys, j);
        if (!kDesc || !('value' in kDesc) || typeof kDesc.value !== 'string' || !HUMAN_KEY_TOKEN_RE.test(kDesc.value)) {
          return { ok: false, code: 'SCHEMA' };
        }
        keys.push(kDesc.value);
      }
      const chord = keys.join('+');
      if (chord.length < 1 || chord.length > 32 || !HUMAN_KEY_TOKEN_RE.test(chord)) {
        return { ok: false, code: 'SCHEMA' };
      }
      events.push(Object.freeze({ kind: 'key', keys: Object.freeze(keys) }));
    } else if (ev.kind === 'type') {
      if (!exactDataKeys(ev, 'kind,text')
          || typeof ev.text !== 'string' || ev.text.length < 1
          || ev.text.includes('\0') || !isWellFormedString(ev.text)) {
        return { ok: false, code: 'SCHEMA' };
      }
      if (ev.text.length > 1024) hasOverlongTypeText = true;
      events.push(Object.freeze({ kind: 'type', text: ev.text }));
    } else if (ev.kind === 'scroll') {
      if (!exactDataKeys(ev, 'dx,dy,kind,x,y')
          || !Number.isSafeInteger(ev.dx) || ev.dx < -2147483648 || ev.dx > 2147483647
          || !Number.isSafeInteger(ev.dy) || ev.dy < -2147483648 || ev.dy > 2147483647
          || !Number.isSafeInteger(ev.x) || ev.x < 0 || ev.x > 65535
          || !Number.isSafeInteger(ev.y) || ev.y < 0 || ev.y > 65535) {
        return { ok: false, code: 'SCHEMA' };
      }
      events.push(Object.freeze({ kind: 'scroll', dx: ev.dx, dy: ev.dy, x: ev.x, y: ev.y }));
    } else {
      return { ok: false, code: 'SCHEMA' };
    }
  }
  if (rec.events.length > SURFACE_INPUT_MAX_EVENTS) {
    return { ok: false, code: 'LIMIT' };
  }
  const batch = Object.freeze({
    schema: rec.schema,
    surface_id: rec.surface_id,
    stream_id: rec.stream_id,
    seq: rec.seq,
    events: Object.freeze(events),
  });
  const encoded = JSON.stringify(batch);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > SURFACE_INPUT_MAX_BYTES) {
    return { ok: false, code: 'LIMIT' };
  }
  if (hasOverlongTypeText) {
    return { ok: false, code: 'SCHEMA' };
  }
  return { ok: true, batch };
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
  if(typeof destination!=='string' || !isAbsolute(destination) || destination.length>4096 || /[\0\r\n]/.test(destination)) {
    throw new MainError('SETTINGS_DESTINATION','MV_RECORDING_DESTINATION must be an existing directory');
  }
  let path;
  try {
    path=realpathSync(resolve(destination));
    if(!statSync(path).isDirectory()) throw new Error('NOT_DIRECTORY');
  } catch {
    throw new MainError('SETTINGS_DESTINATION','MV_RECORDING_DESTINATION must be an existing directory');
  }
  try {
    outsideSource(path);
  } catch {
    throw new MainError('SETTINGS_IN_REPO','MV_RECORDING_DESTINATION must be outside the source tree');
  }
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
export function installAuthorityWire({ipcMain,contents,core,env=process.env,argv=process.argv.slice(1),terminal=null,profiles=new Map(),frames=null,frameDiag=null}) {
  if (terminal?.request && terminal?.subscribe) terminal=createSideTerminalAdapter(terminal);
  const store = createSettingsStore(env);
  const destination = recordingDestination(env);
  const destinationToken = destination === null ? null : 'recording:configured';
  const identity = nestedIdentity(argv,env);
  const channels = /** @type {string[]} */([]);
  const ownedProfiles = new Map([...profiles].map(([id,profile])=>[id,{args:[...validateProviderArgv([id,...profile.args])].slice(1)}]));
  let subscribed = false, enabled = false, disposed = false;
  /** @type {Map<string,number>} */ const inputLastSeq = new Map();
  /** @type {Map<string,number>} */ const inputInFlightSeq = new Map();
  /** @type {Map<string,number[]>} */ const inputRateWindow = new Map();
  const handlers = {
    loadSettings: async () => store.load(),
    saveSettings: async (/** @type {string} */json) => store.save(json),
    recordingDestination: async () => destinationToken,
    nestedDepth: async () => identity.depth,
    selfCapsuleId: async () => identity.self,
    propose: async (/** @type {string} */json) => {
      jsonObject(json); return verdictReply(await core.request({op:'propose',json}));
    },
    intent: async (/** @type {unknown} */arg) => {
      if (typeof arg !== 'string') return handleSurfaceInput(arg);
      validateIntentBody(jsonObject(arg));
      if (await core.request({op:'intent',json:arg}) !== true) throw new Error('OUTCOME'); return true;
    },
    subscribeFrames: async () => {
      subscribed=true;
      await drainPendingEntries();
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
  const handleSurfaceInput = async (/** @type {unknown} */raw) => {
    if (identity.depth === 1) return Object.freeze({ ok: false, code: 'NESTED_DISPLAY_ONLY' });
    const checked = validateSurfaceInputBatch(raw);
    if (!checked.ok) return Object.freeze({ ok: false, code: checked.code });
    const batch = checked.batch;
    const sid = batch.surface_id;
    const prevSeq = Math.max(inputLastSeq.get(sid) ?? 0, inputInFlightSeq.get(sid) ?? 0);
    if (batch.seq <= prevSeq) return Object.freeze({ ok: false, code: 'SCHEMA' });
    const now = Date.now();
    const recent = (inputRateWindow.get(sid) ?? []).filter(t => now - t < 1000);
    if (recent.length >= SURFACE_INPUT_MAX_BATCHES_PER_SEC) {
      inputRateWindow.set(sid, recent);
      return Object.freeze({ ok: false, code: 'LIMIT' });
    }
    recent.push(now);
    inputRateWindow.set(sid, recent);
    inputInFlightSeq.set(sid, batch.seq);
    try {
      const reply = await core.request({ op: 'input', batch });
      if (exactDataKeys(reply, 'accepted,ok') && reply.ok === true
          && Number.isSafeInteger(reply.accepted) && reply.accepted >= 1 && reply.accepted <= batch.events.length) {
        inputLastSeq.set(sid, batch.seq);
        return Object.freeze({ ok: true, accepted: reply.accepted });
      }
      if (exactDataKeys(reply, 'code,ok') && reply.ok === false) {
        return Object.freeze({ ok: false, code: mapSurfaceInputRefusal(reply.code) });
      }
      return Object.freeze({ ok: false, code: 'CORE_UNAVAILABLE' });
    } catch (error) {
      const errCode = /** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message;
      return Object.freeze({ ok: false, code: mapSurfaceInputRefusal(errCode) });
    } finally {
      inputInFlightSeq.delete(sid);
    }
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
  /** @type {Promise<void> | null} */ let drainPromise = null;
  /** @param {any} entry */
  function stageEntry(entry) {
    const sid = entry?.frameRef?.surface_id;
    if (typeof sid !== 'string') return;
    if (!subscribed && ['destroyed','lost'].includes(entry?.state?.state)) {
      pendingEntries.delete(sid);
      return;
    }
    const prior = pendingEntries.get(sid);
    if (entry.stateOnly && prior && !prior.stateOnly && !['destroyed','lost'].includes(entry?.state?.state)) {
      pendingEntries.set(sid, {...prior, state: entry.state, stateUpdated: true});
    } else if (!entry.stateOnly && prior && (prior.stateOnly || prior.stateUpdated) && !['destroyed','lost'].includes(prior?.state?.state)) {
      const freshState = typeof entry.resolveLatestState === 'function' ? entry.resolveLatestState() : prior.state;
      pendingEntries.set(sid, {...entry, state: freshState, stateUpdated: true});
    } else {
      pendingEntries.set(sid, entry);
    }
  }
  function drainPendingEntries() {
    if (drainPromise) return drainPromise;
    if (!subscribed || disposed || pendingEntries.size === 0) return Promise.resolve();
    const run = Promise.resolve().then(async () => {
      try {
        while (subscribed && !disposed && pendingEntries.size > 0) {
          const next = pendingEntries.entries().next();
          if (next.done) break;
          const [sid, nextEntry] = next.value;
          pendingEntries.delete(sid);
          let freshEntry = !nextEntry.stateOnly && typeof nextEntry.resolveLatestEntry === 'function'
            ? (nextEntry.resolveLatestEntry() ?? nextEntry)
            : nextEntry;
          if (nextEntry.stateUpdated && !freshEntry.stateUpdated) {
            freshEntry = {...freshEntry, stateUpdated: true};
          }
          await deliverAuthorityFrame(freshEntry,contents,streams,frameDiag);
        }
      } finally {
        if (drainPromise === run) drainPromise = null;
      }
    });
    drainPromise = run;
    return run;
  }
  const stopFrames = frames ? frames.subscribe(async (/** @type {any} */entry) => {
    if (disposed) return;
    if (subscribed && entry?.stateOnly && !['destroyed','lost'].includes(entry?.state?.state)) {
      const sid = entry?.frameRef?.surface_id;
      const prior = typeof sid === 'string' ? pendingEntries.get(sid) : undefined;
      if (prior && !prior.stateOnly) {
        pendingEntries.set(sid, {...prior, state: entry.state});
      }
      await deliverAuthorityFrame(entry,contents,streams,frameDiag);
      return;
    }
    stageEntry(entry);
    if (!subscribed) return;
    await drainPendingEntries();
  }) : () => {};
  return {async dispose() { disposed=true; subscribed=false; stopFrames();
    pendingEntries.clear();
    for(const stream of [...streams]) {
      try { await stream.reader.closeReader(); } catch {}
      finally { stream.port.revokeFramePort('SHUTDOWN'); }
    }
    streams.clear();terminal?.dispose?.();for(const channel of channels) ipcMain.removeHandler?.(channel);
  }};
}
/** @param {unknown} key @returns {string | null} */
function streamKeySurfaceId(key) {
  if (typeof key !== 'string') return null;
  try {
    const parsed = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[2] === 'string' ? parsed[2] : null;
  } catch {
    return null;
  }
}
/** @param {any} rawState @param {string} refSurfaceId */
function projectSurfaceState(rawState, refSurfaceId) {
  const state={schema:rawState?.schema,surface_id:rawState?.surface_id,kind:rawState?.kind,display:rawState?.display,
    geometry:{w:rawState?.geometry?.w,h:rawState?.geometry?.h},state:rawState?.state,
    visibility:rawState?.visibility,control:rawState?.control,profile_id:rawState?.profile_id};
  if(state.schema!=='surface/v0.2' || state.surface_id!==refSurfaceId
      || !['desktop_capsule','browser','game_capsule','vm'].includes(state.kind)
      || typeof state.display!=='string' || !state.display.length || state.display.length>65536
      || !Number.isSafeInteger(state.geometry.w) || state.geometry.w<1
      || !Number.isSafeInteger(state.geometry.h) || state.geometry.h<1
      || !['active','standby','ceded','destroyed','lost'].includes(state.state)
      || !['folded','unfolded','pinned'].includes(state.visibility)
      || !['agent','human','shared'].includes(state.control)
      || typeof state.profile_id!=='string' || !state.profile_id.length || state.profile_id.length>128) throw new Error('SURFACE_STATE');
  return state;
}
/** Trusted host frame capability entry: readerOptions/portOptions, state, frameRef.
 * @param {any} entry @param {any} contents @param {Set<any>} streams @param {any} [frameDiag] */
export async function deliverAuthorityFrame(entry,contents,streams,frameDiag=null) {
  const raw=entry.frameRef;
  const ref={schema:raw.schema,surface_id:raw.surface_id,generation:raw.generation,tick:raw.tick,
    ts_ns:raw.ts_ns,width:raw.width,height:raw.height,format:raw.format,sha256:raw.sha256,capture_us:raw.capture_us};
  // Closed metadata projection, never spreads adapter state or frame paths.
  let state=projectSurfaceState(entry.state, ref.surface_id);
  if (entry.stateOnly) {
    if (['destroyed','lost'].includes(state.state)) {
      const deadList=[...streams].filter(item=>item.surfaceId===state.surface_id || streamKeySurfaceId(item.key)===state.surface_id);
      for (const dead of deadList) {
        streams.delete(dead);
        try { await dead.reader.closeReader(); } catch {}
        finally { dead.port.revokeFramePort('SHUTDOWN'); }
      }
    }
    contents.postMessage('metaviewer:authority.frames',{frame_ref:ref,surface:state},[]);
    frameDiag?.recordStateOnly?.({surfaceId:ref.surface_id});
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
    const origOnAck=entry.portOptions.onAck;
    try { port=createFramePort({...entry.portOptions,
      onAck:(/** @type {any} */ack)=>{frameDiag?.recordAck?.(ack);origOnAck?.(ack);},
      onRevoke:(/** @type {any} */notice)=>{
        streams.delete(stream);void reader.closeReader().catch(() => {});frameDiag?.recordRevocation?.(notice);revoke(notice);
      }}); } catch(e) {await reader.closeReader();throw e;}
    stream={key,surfaceId:binding.surfaceId,reader,port,announced:false,setAcquire:(/** @type {any} */fn)=>{currentAcquire=fn;}};streams.add(stream);
  } else {
    stream.setAcquire?.(entry.readerOptions.acquirePublishedLease);
  }
  const result=await stream.reader.readFrame(entry.frameRef);
  if (typeof entry.resolveLatestState === 'function') {
    const latestState = entry.resolveLatestState();
    if (latestState && latestState.surface_id === ref.surface_id) {
      state=projectSurfaceState(latestState, ref.surface_id);
    }
  }
  if (!result.ok) {
    frameDiag?.recordReaderRefusal?.({
      surfaceId:ref.surface_id,
      frameGeneration:ref.generation,
      reason:result.reason,
      detail:result.detail,
      ...(typeof /** @type {any} */ (result).cause === 'string' ? {cause: /** @type {any} */ (result).cause} : {}),
    });
    if (entry.stateUpdated) {
      contents.postMessage('metaviewer:authority.frames',{frame_ref:ref,surface:state},[]);
      frameDiag?.recordStateOnly?.({surfaceId:ref.surface_id});
    }
    return false;
  }
  const sent=stream.port.postFrame(result.frame);
  if (!sent.ok) {
    frameDiag?.recordPortRefusal?.({surfaceId:ref.surface_id,frameGeneration:ref.generation,reason:sent.reason});
    if (entry.stateUpdated) {
      contents.postMessage('metaviewer:authority.frames',{frame_ref:ref,surface:state},[]);
      frameDiag?.recordStateOnly?.({surfaceId:ref.surface_id});
    }
    return false;
  }
  const wasAnnounced=stream.announced;
  try {
    contents.postMessage('metaviewer:authority.frames',{frame_ref:ref,surface:state},stream.announced ? [] : (entry.rendererPorts || []));
    stream.announced=true;
    if (!wasAnnounced && Boolean(entry.rendererPorts?.length)) {
      entry.onStreamAnnounced?.(ref.generation);
    }
    frameDiag?.recordDelivery?.({
      surfaceId:binding.surfaceId,
      surfaceGeneration:binding.surfaceGeneration,
      frameGeneration:result.frame.frameGeneration,
      epoch:binding.epoch,
      announced:!wasAnnounced && Boolean(entry.rendererPorts?.length),
    });
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
