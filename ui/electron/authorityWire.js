// @ts-check
/** [TARGET, unit decision] Host binding for the authority lane. Core requests use
 * {op:'propose'|'intent',json}; the core remains the admission authority. A trusted
 * frame source supplies reader/port capabilities; paths never cross IPC.
 * Side-terminal commands are host-owned profile IDs and exact argv matches.
 * Frame stream cap = 64 [TARGET, unit decision]; stream lifetimes follow the
 * existing port revocation/ACK deadlines and the main window's teardown.
 * [TARGET, unit decision] Bound per-surface input rate/sequence maps to
 * MAX_ITEMS = 64 and evict unknown/unadmitted surface IDs on SURFACE_UNKNOWN refusal.
 * [TARGET, unit decision] Closed settings schema {scheme, density, wallFps, recordingFps}
 * with defaults (mv-light, compact, 30, 3); settings.save emits {wallFps} cadence
 * requests and updates default recordingFps.
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
export const SIDE_TERMINAL_CHANNELS = Object.freeze({
  terminalAttach:'metaviewer:side-terminal.attach',
  terminalResize:'metaviewer:side-terminal.resize',
  terminalClose:'metaviewer:side-terminal.close',
  terminalProviders:'metaviewer:side-terminal.providers',
  terminalCopy:'metaviewer:side-terminal.copy',
});
const ALL_WIRE_CHANNELS = Object.freeze({...WIRE_CHANNELS, ...SIDE_TERMINAL_CHANNELS});
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
/** @param {any} body @param {()=>Error} [error] */
export function validateProposalBody(body, error = () => new Error('PROPOSAL')) {
  const validStr = (/** @type {unknown} */ v, /** @type {number} */ min, /** @type {number} */ max) => {
    if (typeof v !== 'string' || !isWellFormedString(v) || Buffer.byteLength(v, 'utf8') > 65536) return false;
    const len = Array.from(v).length;
    return len >= min && len <= max;
  };
  const validIdStr = (/** @type {unknown} */ v) => validStr(v, 1, 128) && !/[\0\r\n]/.test(/** @type {string} */ (v));
  const validSafeInt = (/** @type {unknown} */ v, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
  if (!exactDataKeys(body, 'action,based_on_frame,budget,expectation,proposal_id,schema,surface_id')
      || body.schema !== 'action_proposal/v0.2'
      || !validIdStr(body.proposal_id)
      || !validIdStr(body.surface_id)
      || !exactDataKeys(body.based_on_frame, 'generation,sha256')
      || !validSafeInt(body.based_on_frame.generation, 0)
      || typeof body.based_on_frame.sha256 !== 'string'
      || !/^[0-9a-f]{64}(?![\s\S])/.test(body.based_on_frame.sha256)
      || !exactDataKeys(body.budget, 'max_ms,max_retries')
      || !validSafeInt(body.budget.max_ms, 1, 3600000)
      || !validSafeInt(body.budget.max_retries, 0, 16)) {
    throw error();
  }
  const act = body.action;
  if (!act || typeof act !== 'object' || Array.isArray(act)) throw error();
  if (act.type === 'click') {
    if (!exactDataKeys(act, 'button,type,x,y')
        || !validSafeInt(act.x, 0)
        || !validSafeInt(act.y, 0)
        || !['left', 'middle', 'right'].includes(act.button)) throw error();
  } else if (act.type === 'key') {
    if (!exactDataKeys(act, 'keys,type')
        || !Array.isArray(act.keys) || Object.getPrototypeOf(act.keys) !== Array.prototype
        || act.keys.length < 1 || act.keys.length > 4096
        || Reflect.ownKeys(act.keys).length !== act.keys.length + 1) throw error();
    for (let i = 0; i < act.keys.length; i += 1) {
      const d = Object.getOwnPropertyDescriptor(act.keys, i);
      if (!d || !('value' in d) || !validStr(d.value, 1, 65536)) throw error();
    }
  } else if (act.type === 'type') {
    if (!exactDataKeys(act, 'text,type') || !validStr(act.text, 1, 65536)) throw error();
  } else if (act.type === 'scroll') {
    if (!exactDataKeys(act, 'dx,dy,type') || !validSafeInt(act.dx) || !validSafeInt(act.dy)) throw error();
  } else if (act.type === 'wait') {
    if (!exactDataKeys(act, 'ms,type') || !validSafeInt(act.ms, 1, 3600000)) throw error();
  } else if (act.type === 'lane_submit') {
    if (!exactDataKeys(act, 'payload,type,verb')
        || !validStr(act.verb, 1, 128)
        || !exactDataKeys(act.payload, 'nonce,text')
        || !validStr(act.payload.nonce, 1, 128)
        || !validStr(act.payload.text, 1, 4096)) throw error();
  } else {
    throw error();
  }
  const exp = body.expectation;
  if (!exp || typeof exp !== 'object' || Array.isArray(exp)) throw error();
  if (exp.type === 'changed_region') {
    if (!exactDataKeys(exp, 'min_changed_px,roi,type')
        || !validSafeInt(exp.min_changed_px, 1)
        || !exactDataKeys(exp.roi, 'h,w,x,y')
        || !validSafeInt(exp.roi.x, 0)
        || !validSafeInt(exp.roi.y, 0)
        || !validSafeInt(exp.roi.w, 1)
        || !validSafeInt(exp.roi.h, 1)) throw error();
  } else if (exp.type === 'element_state') {
    if (!exactDataKeys(exp, 'name,role,state,type')
        || !validStr(exp.role, 1, 128)
        || !validStr(exp.name, 0, 4096)
        || !['focused', 'enabled', 'checked', 'present'].includes(exp.state)) throw error();
  } else if (exp.type === 'state_sha256_change') {
    if (!exactDataKeys(exp, 'type')) throw error();
  } else if (exp.type === 'text_present') {
    if (!exactDataKeys(exp, 'text,type') || !validStr(exp.text, 1, 4096)) throw error();
  } else {
    throw error();
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
const SURFACE_INPUT_MAX_SURFACES = 64;
/** @template V @param {Map<string,V>} map @param {string} key @param {V} value @param {Map<string,number>} [admitted] @param {Map<string,number>} [inFlight] */
function setBoundedSurfaceEntry(map, key, value, admitted, inFlight) {
  if (!map.has(key) && map.size >= SURFACE_INPUT_MAX_SURFACES) {
    let evicted = false;
    if (admitted || inFlight) {
      for (const k of map.keys()) {
        if (!admitted?.has(k) && !inFlight?.has(k)) {
          map.delete(k);
          evicted = true;
          break;
        }
      }
    }
    if (!evicted) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }
  map.set(key, value);
}
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
      const maxTokenLen = ev.keys.length === 1 ? 32 : ev.keys.length === 2 ? 15 : ev.keys.length <= 4 ? 7 : 3;
      const keys = [];
      for (let j = 0; j < ev.keys.length; j += 1) {
        const kDesc = Object.getOwnPropertyDescriptor(ev.keys, j);
        if (!kDesc || !('value' in kDesc) || typeof kDesc.value !== 'string'
            || kDesc.value.length > maxTokenLen || !HUMAN_KEY_TOKEN_RE.test(kDesc.value)) {
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
      if (Array.from(ev.text).length > 1024) hasOverlongTypeText = true;
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
export const DEFAULT_SETTINGS = Object.freeze({
  scheme: 'mv-light',
  density: 'compact',
  wallFps: 30,
  recordingFps: 3,
});
const SETTINGS_KEY_SET = new Set(['scheme', 'density', 'wallFps', 'recordingFps']);
const SETTINGS_WALL_FPS_SET = new Set([3, 30, 60]);
const CADENCE_KEY_SET = new Set(['wallFps', 'recordingFps']);

/** @param {string} code */
function settingsStoreError(code) {
  return Object.assign(new Error(code), { code });
}

/** Validate a closed cadence update ({wallFps?, recordingFps?}, non-empty).
 * @param {unknown} cadence
 * @returns {Readonly<{ wallFps?: number, recordingFps?: number }>} */
export function validateCadence(cadence) {
  if (!cadence || typeof cadence !== 'object' || Array.isArray(cadence)) {
    throw new MainError('PAYLOAD', 'PAYLOAD');
  }
  const proto = Object.getPrototypeOf(cadence);
  if (proto !== Object.prototype && proto !== null) {
    throw new MainError('PAYLOAD', 'PAYLOAD');
  }
  if (Object.getOwnPropertySymbols(cadence).length !== 0) {
    throw new MainError('SETTINGS_UNKNOWN_KEY', 'SETTINGS_UNKNOWN_KEY');
  }
  const keys = Object.keys(cadence);
  if (keys.length === 0) {
    throw new MainError('SETTINGS_WALL_FPS', 'SETTINGS_WALL_FPS');
  }
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(cadence, key);
    if (!desc || !('value' in desc) || !CADENCE_KEY_SET.has(key)) {
      throw new MainError('SETTINGS_UNKNOWN_KEY', 'SETTINGS_UNKNOWN_KEY');
    }
  }
  const rec = /** @type {Record<string, unknown>} */ (cadence);
  /** @type {{ wallFps?: number, recordingFps?: number }} */
  const out = {};
  if (Object.hasOwn(rec, 'wallFps')) {
    const wallFps = rec.wallFps;
    if (typeof wallFps !== 'number' || !Number.isSafeInteger(wallFps) || !SETTINGS_WALL_FPS_SET.has(wallFps)) {
      throw new MainError('SETTINGS_WALL_FPS', 'SETTINGS_WALL_FPS');
    }
    out.wallFps = wallFps;
  }
  if (Object.hasOwn(rec, 'recordingFps')) {
    const recordingFps = rec.recordingFps;
    if (typeof recordingFps !== 'number' || !Number.isSafeInteger(recordingFps) || recordingFps < 1 || recordingFps > 60) {
      throw new MainError('SETTINGS_RECORDING_FPS', 'SETTINGS_RECORDING_FPS');
    }
    out.recordingFps = recordingFps;
  }
  return Object.freeze(out);
}

/** Renderer preferences use the exact closed settingsModel.js shape.
 * Missing keys default only as decodeMvSettings does. Invalid input never
 * replaces disk; corrupt storage returns the renderer's defaults signal.
 * @param {string} text */
export function validateSettings(text) {
  const value = jsonObject(text);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new MainError('PAYLOAD', 'PAYLOAD');
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new MainError('SETTINGS_UNKNOWN_KEY', 'SETTINGS_UNKNOWN_KEY');
  for (const key of Object.keys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !('value' in desc) || !SETTINGS_KEY_SET.has(key)) {
      throw new MainError('SETTINGS_UNKNOWN_KEY', 'SETTINGS_UNKNOWN_KEY');
    }
  }
  const scheme = value.scheme === undefined ? DEFAULT_SETTINGS.scheme : value.scheme;
  const density = value.density === undefined ? DEFAULT_SETTINGS.density : value.density;
  const wallFps = value.wallFps === undefined ? DEFAULT_SETTINGS.wallFps : value.wallFps;
  const recordingFps = value.recordingFps === undefined ? DEFAULT_SETTINGS.recordingFps : value.recordingFps;
  if (typeof scheme !== 'string' || !['mv-light', 'mv-dark'].includes(scheme)) {
    throw new MainError('SETTINGS_SCHEME', 'SETTINGS_SCHEME');
  }
  if (typeof density !== 'string' || !['compact', 'comfortable'].includes(density)) {
    throw new MainError('SETTINGS_DENSITY', 'SETTINGS_DENSITY');
  }
  if (typeof wallFps !== 'number' || !Number.isSafeInteger(wallFps) || !SETTINGS_WALL_FPS_SET.has(wallFps)) {
    throw new MainError('SETTINGS_WALL_FPS', 'SETTINGS_WALL_FPS');
  }
  if (typeof recordingFps !== 'number' || !Number.isSafeInteger(recordingFps) || recordingFps < 1 || recordingFps > 60) {
    throw new MainError('SETTINGS_RECORDING_FPS', 'SETTINGS_RECORDING_FPS');
  }
  return { scheme, density, wallFps, recordingFps };
}
const sourceRoot=fileURLToPath(new URL('../..',import.meta.url));
/** @param {string} candidate */
function outsideSource(candidate) {
  const rel=relative(sourceRoot,resolve(candidate));
  if(rel==='' || (rel!=='..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw settingsStoreError('SETTINGS_IN_REPO');
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
/** @type {Map<string, Set<(parsed: Readonly<{ wallFps: number, recordingFps: number }>) => void>>} */
const settingsSubscriptions = new Map();

/** Atomic private settings file. No caller-supplied pathname.
 * @param {NodeJS.ProcessEnv} env */
export function createSettingsStore(env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  if (!isAbsolute(base)) throw settingsStoreError('CONFIG_PATH');
  const dir = join(base,'metaviewer');
  const path = join(dir,'settings.json');
  outsideSource(path);
  const subKey = resolve(path);
  /** @param {{ wallFps: number, recordingFps: number }} parsed */
  const notifySubscribers = (parsed) => {
    const subs = settingsSubscriptions.get(subKey);
    if (!subs || subs.size === 0) return;
    const notice = Object.freeze({ wallFps: parsed.wallFps, recordingFps: parsed.recordingFps });
    for (const fn of [...subs]) {
      try { fn(notice); } catch {}
    }
  };
  // Check the nearest existing ancestor before mkdir can follow parent aliases.
  const checkAncestors=async()=> {
    let ancestor=dir;
    for(;;) {
      try { await lstat(ancestor); }
      catch(e) {
        if(/** @type {NodeJS.ErrnoException} */(e).code!=='ENOENT') throw e;
        const parent=dirname(ancestor);
        if(parent===ancestor) throw settingsStoreError('CONFIG_PATH');
        ancestor=parent; continue;
      }
      // An existing but unresolvable entry is not an absent directory. Live
      // outside-source symlink ancestors remain supported, as before.
      let canonical;
      try { canonical=await realpath(ancestor); }
      catch(e) {
        if(/** @type {NodeJS.ErrnoException} */(e).code==='ENOENT') throw settingsStoreError('SETTINGS_DIRECTORY');
        throw e;
      }
      outsideSource(canonical); return;
    }
  };
  const checkDirectory=async()=> {
    const info=await lstat(dir);
    if(!info.isDirectory() || info.isSymbolicLink() || (info.mode&0o777)!==0o700
      || (process.getuid && info.uid!==process.getuid())) throw settingsStoreError('SETTINGS_DIRECTORY');
    outsideSource(await realpath(dir));
  };
  return Object.freeze({
    /** @param {(parsed: Readonly<{ wallFps: number, recordingFps: number }>) => void} listener */
    subscribe(listener) {
      let subs = settingsSubscriptions.get(subKey);
      if (!subs) {
        subs = new Set();
        settingsSubscriptions.set(subKey, subs);
      }
      subs.add(listener);
      return () => {
        subs?.delete(listener);
        if (subs && subs.size === 0) settingsSubscriptions.delete(subKey);
      };
    },
    async load() {
      let file;
      try { await checkAncestors(); await checkDirectory(); file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (e) {
        const code = /** @type {NodeJS.ErrnoException} */(e).code;
        if (code === 'ENOENT') {
          notifySubscribers(DEFAULT_SETTINGS);
          return null;
        }
        if (code === 'ELOOP') throw settingsStoreError('SETTINGS_FILE');
        throw e;
      }
      try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600
            || (process.getuid && stat.uid !== process.getuid())) throw settingsStoreError('SETTINGS_FILE');
        const buffer = Buffer.alloc(WIRE_MAX_BYTES + 1);
        const {bytesRead} = await file.read(buffer,0,buffer.length,0);
        if (stat.size > WIRE_MAX_BYTES || bytesRead > WIRE_MAX_BYTES) {
          console.warn('MetaViewer settings: file exceeds byte cap; using defaults');
          notifySubscribers(DEFAULT_SETTINGS);
          return null;
        }
        const text = buffer.subarray(0,bytesRead).toString('utf8');
        try {
          const parsed = validateSettings(text);
          notifySubscribers(parsed);
          return text;
        } catch {
          console.warn('MetaViewer settings: invalid JSON or schema; using defaults');
          notifySubscribers(DEFAULT_SETTINGS);
          return null;
        }
      } finally { await file.close(); }
    },
    /** @param {string} json */
    async save(json) {
      const parsed = validateSettings(json); await checkAncestors(); await mkdir(dir,{recursive:true,mode:0o700});await checkDirectory();
      const temp = join(dir,`.settings-${randomUUID()}.tmp`);
      try {
        const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
        try { await file.writeFile(json,'utf8'); await file.sync(); } finally { await file.close(); }
        try {
          const st = await lstat(path);
          if (st.isSymbolicLink() || !st.isFile()) throw settingsStoreError('SETTINGS_FILE');
        } catch (e) {
          if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
        }
        await rename(temp,path);
        const directory = await open(dir,constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
        notifySubscribers(parsed);
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
export function installAuthorityWire({ipcMain,contents,core,env=process.env,argv=process.argv.slice(1),terminal=null,profiles=new Map(),frames=null,frameDiag=null,now:clock=Date.now}) {
  if (terminal?.request && terminal?.subscribe) terminal=createSideTerminalAdapter(terminal);
  const store = createSettingsStore(env);
  const destination = recordingDestination(env);
  const destinationToken = destination === null ? null : 'recording:configured';
  const identity = nestedIdentity(argv,env);
  const channels = /** @type {string[]} */([]);
  const ownedProfiles = new Map(profiles);
  if (terminal?.profiles && typeof terminal.profiles.entries === 'function') {
    for (const [k, v] of terminal.profiles.entries()) ownedProfiles.set(k, v);
  }
  if (!ownedProfiles.has('shell')) ownedProfiles.set('shell', { args: [] });
  let subscribed = false, enabled = false, disposed = false;
  /** @type {number} */
  let requestedWallFps = DEFAULT_SETTINGS.wallFps;
  /** @type {number} */
  let currentRecordingFps = DEFAULT_SETTINGS.recordingFps;
  /** @type {Map<string,number>} */ const inputLastSeq = new Map();
  /** @type {Map<string,number>} */ const inputInFlightSeq = new Map();
  /** @type {Map<string,number>} */ const inputPartialSeq = new Map();
  /** @type {Map<string,number>} */ const inputPartialApplied = new Map();
  /** @type {Map<string,number[]>} */ const inputRateWindow = new Map();
  /** @type {Set<string>} */ const knownSurfaces = new Set();
  const markKnownSurface = (/** @type {string} */ sid) => {
    if (!knownSurfaces.has(sid) && knownSurfaces.size >= SURFACE_INPUT_MAX_SURFACES) {
      const oldest = knownSurfaces.values().next().value;
      if (oldest !== undefined) knownSurfaces.delete(oldest);
    }
    knownSurfaces.add(sid);
  };
  const applySettingsFps = (/** @type {{ wallFps: number, recordingFps: number }} */ parsed) => {
    requestedWallFps = parsed.wallFps;
    currentRecordingFps = parsed.recordingFps;
    const cadence = Object.freeze({ wallFps: parsed.wallFps });
    frames?.requestCadence?.(cadence);
    frames?.setCadence?.(cadence);
    core?.requestCadence?.(cadence);
    core?.setCadence?.(cadence);
    core?.setRecordingFps?.(parsed.recordingFps);
    frameDiag?.recordCadence?.(cadence);
  };
  const handlers = {
    loadSettings: async () => {
      const loaded = await store.load();
      const parsed = typeof loaded === 'string' ? validateSettings(loaded) : DEFAULT_SETTINGS;
      applySettingsFps(parsed);
      return loaded;
    },
    saveSettings: async (/** @type {string} */json) => {
      const parsed = validateSettings(json);
      const saved = await store.save(json);
      applySettingsFps(parsed);
      return saved;
    },
    recordingDestination: async () => destinationToken,
    nestedDepth: async () => identity.depth,
    selfCapsuleId: async () => identity.self,
    propose: async (/** @type {string} */json) => {
      validateProposalBody(jsonObject(json)); return verdictReply(await core.request({op:'propose',json}));
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
    terminalAttach: async (/** @type {any} */value) => {
      if (!exactDataKeys(value, 'session') || typeof value.session !== 'string') throw new Error('TERMINAL_IO_REFUSED');
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(value.session)) throw new Error('TERMINAL_UNKNOWN_SESSION');
      if (!terminal || typeof terminal.attach !== 'function') throw new Error('TERMINAL_UNKNOWN_SESSION');
      const result = await terminal.attach({ session: value.session });
      if (!result || typeof result.port !== 'object' || result.port === null) throw new Error('OUTCOME');
      return result;
    },
    terminalResize: async (/** @type {any} */value) => {
      if (!exactDataKeys(value, 'cols,rows,session') || typeof value.session !== 'string'
          || !Number.isSafeInteger(value.cols) || value.cols < 2 || value.cols > 500
          || !Number.isSafeInteger(value.rows) || value.rows < 2 || value.rows > 300) throw new Error('TERMINAL_IO_REFUSED');
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(value.session)) throw new Error('TERMINAL_UNKNOWN_SESSION');
      if (!terminal || typeof terminal.resize !== 'function') throw new Error('TERMINAL_UNKNOWN_SESSION');
      if (await terminal.resize({ session: value.session, cols: value.cols, rows: value.rows }) !== true) throw new Error('OUTCOME');
      return true;
    },
    terminalClose: async (/** @type {any} */value) => {
      if (!exactDataKeys(value, 'session') || typeof value.session !== 'string') throw new Error('TERMINAL_IO_REFUSED');
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(value.session)) throw new Error('TERMINAL_UNKNOWN_SESSION');
      if (!terminal || typeof terminal.close !== 'function') throw new Error('TERMINAL_UNKNOWN_SESSION');
      if (await terminal.close({ session: value.session }) !== true) throw new Error('OUTCOME');
      return true;
    },
    terminalProviders: async () => {
      if (!terminal || typeof terminal.listProviders !== 'function') {
        return {
          entries: [{ id: 'shell', label: 'System shell', hint: 'Interactive login shell' }],
          capabilities: [{ id: 'shell', available: false, reason: 'TERMINAL_UNAVAILABLE' }],
        };
      }
      const result = await terminal.listProviders();
      if (!exactDataKeys(result, 'capabilities,entries') || !Array.isArray(result.entries) || !Array.isArray(result.capabilities)) {
        throw new Error('OUTCOME');
      }
      return result;
    },
    terminalCopy: async (/** @type {any} */value) => {
      if (!exactDataKeys(value, 'text') || typeof value.text !== 'string'
          || value.text.length < 1 || value.text.length > 128
          || !HUMAN_ID_RE.test(value.text)) throw new Error('ERR_CLIPBOARD_INVALID');
      if (!terminal || typeof terminal.copyText !== 'function') throw new Error('ERR_CLIPBOARD_INVALID');
      if (await terminal.copyText({ text: value.text }) !== true) throw new Error('OUTCOME');
      return true;
    },
    terminalEnabled: async (/** @type {boolean} */value) => {
      if (typeof value !== 'boolean') throw new Error('PAYLOAD');
      if (!terminal || await terminal.setEnabled(value) !== true) throw new Error('OUTCOME'); enabled=value; return true;
    },
    terminalOpen: async (/** @type {any} */value) => {
      if (!value || (!exactDataKeys(value, 'cols,command,rows') && !exactDataKeys(value, 'args,cols,command,rows'))
          || typeof value.command !== 'string' || (value.args !== undefined && !Array.isArray(value.args))
          || !Number.isSafeInteger(value.cols) || value.cols < 2 || value.cols > 500
          || !Number.isSafeInteger(value.rows) || value.rows < 2 || value.rows > 300) throw new Error('PAYLOAD');
      const reqArgs = value.args ?? [];
      if (reqArgs.length > 0) validateProviderArgv([value.command || 'x', ...reqArgs]);
      if (!value.command || value.command.startsWith('-') || value.command.includes('\0') || !ownedProfiles.has(value.command)) {
        throw new Error('COMMAND_NOT_ALLOWED');
      }
      const profile = ownedProfiles.get(value.command);
      const profArgs = Array.isArray(profile?.args) ? profile.args : (Array.isArray(profile?.argv) ? profile.argv.slice(1) : []);
      if (reqArgs.length > 0 && JSON.stringify(reqArgs) !== JSON.stringify(profArgs)) {
        throw new Error('COMMAND_NOT_ALLOWED');
      }
      if (!terminal || !enabled) throw new Error('TERMINAL_DISABLED');
      const result = await terminal.open(
        value.command === 'shell'
          ? {command:'shell',cols:value.cols,rows:value.rows}
          : {command:'provider',provider:value.command,cols:value.cols,rows:value.rows}
      );
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
    const lastSeq = inputLastSeq.get(sid) ?? 0;
    const inFlight = inputInFlightSeq.get(sid) ?? 0;
    const pSeq = inputPartialSeq.get(sid) ?? 0;
    const pApplied = inputPartialApplied.get(sid) ?? 0;
    const prevSeq = Math.max(lastSeq, inFlight);
    const isRetryPartial = pSeq > 0 && pApplied > 0 && batch.seq === pSeq && inFlight === 0;
    if (batch.seq <= prevSeq || (pSeq > 0 && batch.seq < pSeq) || (isRetryPartial && batch.events.length <= pApplied)) {
      return Object.freeze({ ok: false, code: 'SCHEMA' });
    }
    const now = typeof clock === 'function' ? clock() : Date.now();
    const priorRate = inputRateWindow.get(sid);
    const recent = (priorRate ?? []).filter(t => now - t < 1000);
    if (recent.length >= SURFACE_INPUT_MAX_BATCHES_PER_SEC) {
      setBoundedSurfaceEntry(inputRateWindow, sid, recent, inputLastSeq, inputInFlightSeq);
      return Object.freeze({ ok: false, code: 'LIMIT' });
    }
    const hadRateEntry = priorRate !== undefined && recent.length > 0;
    recent.push(now);
    if (pSeq > 0 && batch.seq > pSeq) {
      setBoundedSurfaceEntry(inputLastSeq, sid, Math.max(lastSeq, pSeq), inputLastSeq, inputInFlightSeq);
      inputPartialSeq.delete(sid);
      inputPartialApplied.delete(sid);
    }
    setBoundedSurfaceEntry(inputRateWindow, sid, recent, inputLastSeq, inputInFlightSeq);
    setBoundedSurfaceEntry(inputInFlightSeq, sid, batch.seq, inputLastSeq, inputInFlightSeq);
    const coreTracksProgress = typeof core?.getInputProgress === 'function';
    const baseApplied = isRetryPartial && !coreTracksProgress ? pApplied : 0;
    const coreBatch = baseApplied > 0
      ? Object.freeze({ ...batch, events: Object.freeze(batch.events.slice(baseApplied)) })
      : batch;
    const syncCoreProgress = () => {
      if (!coreTracksProgress) return false;
      const prog = core.getInputProgress(sid);
      if (prog && Number.isSafeInteger(prog.partialSeq) && prog.partialSeq > 0
          && Number.isSafeInteger(prog.partialApplied) && prog.partialApplied > 0) {
        setBoundedSurfaceEntry(inputPartialSeq, sid, prog.partialSeq, inputLastSeq, inputInFlightSeq);
        setBoundedSurfaceEntry(inputPartialApplied, sid, prog.partialApplied, inputLastSeq, inputInFlightSeq);
        if (Number.isSafeInteger(prog.lastSeq) && prog.lastSeq > 0) {
          setBoundedSurfaceEntry(inputLastSeq, sid, prog.lastSeq, inputLastSeq, inputInFlightSeq);
        }
        return true;
      }
      if (prog) {
        inputPartialSeq.delete(sid);
        inputPartialApplied.delete(sid);
      }
      return false;
    };
    try {
      const reply = await core.request({ op: 'input', batch: coreBatch });
      if (exactDataKeys(reply, 'accepted,ok') && reply.ok === true
          && Number.isSafeInteger(reply.accepted) && reply.accepted >= 1 && reply.accepted <= coreBatch.events.length) {
        markKnownSurface(sid);
        inputPartialSeq.delete(sid);
        inputPartialApplied.delete(sid);
        setBoundedSurfaceEntry(inputLastSeq, sid, batch.seq, inputLastSeq, inputInFlightSeq);
        const totalAccepted = baseApplied > 0 && reply.accepted === coreBatch.events.length
          ? batch.events.length
          : reply.accepted;
        return Object.freeze({ ok: true, accepted: totalAccepted });
      }
      if ((exactDataKeys(reply, 'code,ok') || exactDataKeys(reply, 'applied,code,ok')) && reply.ok === false) {
        const synced = syncCoreProgress();
        if (!synced && Number.isSafeInteger(reply.applied) && reply.applied > 0
            && baseApplied + reply.applied < batch.events.length) {
          setBoundedSurfaceEntry(inputPartialSeq, sid, batch.seq, inputLastSeq, inputInFlightSeq);
          setBoundedSurfaceEntry(inputPartialApplied, sid, baseApplied + reply.applied, inputLastSeq, inputInFlightSeq);
          if (batch.seq > 1) {
            setBoundedSurfaceEntry(inputLastSeq, sid, Math.max(inputLastSeq.get(sid) ?? 0, batch.seq - 1), inputLastSeq, inputInFlightSeq);
          }
        }
        const mapped = mapSurfaceInputRefusal(reply.code);
        if (mapped === 'SURFACE_UNKNOWN') {
          knownSurfaces.delete(sid);
        }
        if ((mapped === 'SURFACE_UNKNOWN' && !hadRateEntry && !inputLastSeq.has(sid) && !inputPartialSeq.has(sid))
            || (!knownSurfaces.has(sid) && !inputLastSeq.has(sid) && !inputPartialSeq.has(sid))) {
          inputRateWindow.delete(sid);
          inputLastSeq.delete(sid);
        }
        return Object.freeze({ ok: false, code: mapped });
      }
      if (!knownSurfaces.has(sid) && !inputLastSeq.has(sid) && !inputPartialSeq.has(sid)) {
        inputRateWindow.delete(sid);
        inputLastSeq.delete(sid);
      }
      return Object.freeze({ ok: false, code: 'CORE_UNAVAILABLE' });
    } catch (error) {
      const synced = syncCoreProgress();
      const errApplied = /** @type {any} */ (error)?.applied;
      if (!synced && Number.isSafeInteger(errApplied) && errApplied > 0
          && baseApplied + errApplied < batch.events.length) {
        setBoundedSurfaceEntry(inputPartialSeq, sid, batch.seq, inputLastSeq, inputInFlightSeq);
        setBoundedSurfaceEntry(inputPartialApplied, sid, baseApplied + errApplied, inputLastSeq, inputInFlightSeq);
        if (batch.seq > 1) {
          setBoundedSurfaceEntry(inputLastSeq, sid, Math.max(inputLastSeq.get(sid) ?? 0, batch.seq - 1), inputLastSeq, inputInFlightSeq);
        }
      }
      const errCode = /** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message;
      const mapped = mapSurfaceInputRefusal(errCode);
      if (mapped === 'SURFACE_UNKNOWN') {
        knownSurfaces.delete(sid);
      }
      if ((mapped === 'SURFACE_UNKNOWN' && !hadRateEntry && !inputLastSeq.has(sid) && !inputPartialSeq.has(sid))
          || (!knownSurfaces.has(sid) && !inputLastSeq.has(sid) && !inputPartialSeq.has(sid))) {
        inputRateWindow.delete(sid);
        inputLastSeq.delete(sid);
      }
      return Object.freeze({ ok: false, code: mapped });
    } finally {
      inputInFlightSeq.delete(sid);
    }
  };
  try {
    for (const [name,fn] of Object.entries(handlers)) {
      if (Object.hasOwn(SIDE_TERMINAL_CHANNELS, name) && terminal !== null && typeof terminal.attach !== 'function') {
        continue;
      }
      const channel=ALL_WIRE_CHANNELS[/** @type {keyof typeof ALL_WIRE_CHANNELS} */(name)];
      const arity=['saveSettings','propose','intent','terminalOpen','terminalEnabled','terminalAttach','terminalResize','terminalClose','terminalCopy'].includes(name) ? 1 : 0;
      ipcMain.handle(channel,/** @param {unknown} event @param {...any} args */ async (event,...args) => {
        if (disposed || observeSender(event,contents,PRIVILEGED_ORIGIN).verdict !== 'admit') throw new Error('SENDER');
        if (args.length !== arity) throw new Error('ARGS');
        if (arity && (JSON.stringify(args[0]) === undefined || Buffer.byteLength(typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]),'utf8') > WIRE_MAX_BYTES)) throw new Error('PAYLOAD');
        const result=await /** @type {any} */(fn)(...args);
        if(name==='terminalAttach'){
          contents.postMessage('metaviewer:side-terminal.port',{session:args[0].session},[result.port]);
          if (process.versions?.electron && result.port?.constructor?.name === 'MessagePortMain') {
            return {session:args[0].session};
          }
          return {session:args[0].session,port:result.port};
        }
        return result;
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
    const prior = pendingEntries.get(sid);
    if (entry.stateOnly && prior && !prior.stateOnly && !['destroyed','lost'].includes(entry?.state?.state)) {
      pendingEntries.set(sid, {...prior, state: entry.state, stateUpdated: true});
    } else if (!entry.stateOnly && prior && (prior.stateOnly || prior.stateUpdated) && !['destroyed','lost'].includes(prior?.state?.state)) {
      const freshState = typeof entry.resolveLatestState === 'function' ? (entry.resolveLatestState() ?? prior.state) : prior.state;
      pendingEntries.set(sid, {...entry, state: freshState, stateUpdated: true});
    } else if (!entry.stateOnly && prior && !prior.stateOnly
        && Number.isSafeInteger(prior.frameRef?.generation)
        && Number.isSafeInteger(entry.frameRef?.generation)
        && entry.frameRef.generation < prior.frameRef.generation) {
      return;
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
  let stopFrames = () => {};
  try {
    if (frames) {
      stopFrames = frames.subscribe(async (/** @type {any} */entry) => {
        if (disposed) return;
        const sid = entry?.frameRef?.surface_id;
        const isTerminal = ['destroyed','lost'].includes(entry?.state?.state);
        if (!isTerminal && typeof sid === 'string' && sid.length > 0) {
          markKnownSurface(sid);
        }
        if (subscribed && entry?.stateOnly && !isTerminal) {
          const prior = typeof sid === 'string' ? pendingEntries.get(sid) : undefined;
          if (prior?.stateOnly) {
            pendingEntries.delete(sid);
          } else if (prior) {
            pendingEntries.set(sid, {...prior, state: entry.state, stateUpdated: false});
          }
          await deliverAuthorityFrame(entry,contents,streams,frameDiag);
          return;
        }
        if (subscribed && entry?.stateOnly && isTerminal && typeof sid === 'string') {
          knownSurfaces.delete(sid);
          inputLastSeq.delete(sid);
          inputInFlightSeq.delete(sid);
          inputPartialSeq.delete(sid);
          inputPartialApplied.delete(sid);
          inputRateWindow.delete(sid);
          pendingEntries.delete(sid);
          stageEntry(entry);
          await closeSurfaceStreams(streams, sid);
          await drainPendingEntries();
          return;
        }
        if (isTerminal && typeof sid === 'string') {
          knownSurfaces.delete(sid);
          inputLastSeq.delete(sid);
          inputInFlightSeq.delete(sid);
          inputPartialSeq.delete(sid);
          inputPartialApplied.delete(sid);
          inputRateWindow.delete(sid);
        }
        stageEntry(entry);
        if (!subscribed) return;
        await drainPendingEntries();
      });
    }
  } catch (e) {
    disposed = true;
    subscribed = false;
    for (const channel of channels) ipcMain.removeHandler?.(channel);
    throw e;
  }
  let stopCadence = () => {};
  if (frames && typeof frames.onCadence === 'function') {
    stopCadence = frames.onCadence((/** @type {any} */ cadence) => {
      if (disposed) return;
      const parsed = validateCadence(cadence);
      if (parsed.wallFps !== undefined) {
        requestedWallFps = parsed.wallFps;
        frameDiag?.recordCadence?.(Object.freeze({ wallFps: parsed.wallFps }));
      }
      if (parsed.recordingFps !== undefined) {
        currentRecordingFps = parsed.recordingFps;
        core?.setRecordingFps?.(parsed.recordingFps);
      }
    });
  }
  return {
    get requestedWallFps() {
      return requestedWallFps;
    },
    get recordingFps() {
      return currentRecordingFps;
    },
    inputRateWindow,
    inputLastSeq,
    inputInFlightSeq,
    inputPartialSeq,
    inputPartialApplied,
    async dispose() { disposed=true; subscribed=false; stopFrames(); stopCadence();
      knownSurfaces.clear();
      inputRateWindow.clear();
      inputLastSeq.clear();
      inputInFlightSeq.clear();
      inputPartialSeq.clear();
      inputPartialApplied.clear();
      pendingEntries.clear();
      for(const stream of [...streams]) {
        try { await stream.reader.closeReader(); } catch {}
        finally { stream.port.revokeFramePort('SHUTDOWN'); }
      }
      streams.clear();terminal?.dispose?.();for(const channel of channels) ipcMain.removeHandler?.(channel);
    },
  };
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
/** @param {Set<any>} streams @param {string} surfaceId */
async function closeSurfaceStreams(streams, surfaceId) {
  const deadList=[...streams].filter(item=>item.surfaceId===surfaceId || streamKeySurfaceId(item.key)===surfaceId);
  for (const dead of deadList) {
    streams.delete(dead);
    try { await dead.reader.closeReader(); } catch {}
    finally { dead.port.revokeFramePort('SHUTDOWN'); }
  }
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
      await closeSurfaceStreams(streams, state.surface_id);
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
    if (!latestState) return false;
    if (latestState.surface_id === ref.surface_id) {
      state=projectSurfaceState(latestState, ref.surface_id);
    }
  }
  if (!streams.has(stream)) return false;
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
