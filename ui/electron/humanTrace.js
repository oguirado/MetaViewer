// Continuous human_trace/v0.3 recorder; frozen wire contracts are unchanged.
import { open } from 'node:fs/promises';
import { constants, mkdirSync, lstatSync, realpathSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export const HUMAN_TRACE_SCHEMA = 'metaviewer.human_trace/v0.3';
const kinds = new Set(['click', 'move', 'key', 'scroll']);
const navKeys = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp',
  'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/** No raw DOM/AX objects or user-provided object spreads may reach persistence.
 * AX context must be a trusted, current capsule AX row, NOT the HTML5 canvas.
 * All printable keys are withheld: a missing/stale password classification
 * cannot leak text. A later consented text-learning channel needs its own gate.
 * @param {{sessionId:string,surfaceId:string,capsuleId:string,write:(line:string)=>void,clock?:()=>bigint,maxEvents?:number}} options
 */
export function createHumanTrace({ sessionId, surfaceId, capsuleId, write,
  clock = () => process.hrtime.bigint(), maxEvents = 100000 }) {
  if (![sessionId, surfaceId, capsuleId].every(s => typeof s === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(s)) ||
      typeof write !== 'function' || !Number.isSafeInteger(maxEvents) || maxEvents < 1) throw Error('TRACE_BINDING_REFUSED');
  const origin = clock();
  let active = false, seq = 0, last = -1n;
  return Object.freeze({
    /** @param {boolean} value */
    setActive(value) { active = value === true; },
    /** @param {Record<string,any>} event
     * @param {{width:number,height:number,capsuleWidth:number,capsuleHeight:number}} geometry
     * @param {{sensitive?:boolean,password?:boolean,row?:number}|null} [ax] */
    record(event, geometry, ax = null) {
      if (!active) return false;
      if (!event || !kinds.has(event.kind)) throw Error('TRACE_EVENT_REFUSED');
      if (seq >= maxEvents) throw Error('TRACE_LIMIT');
      const now = clock() - origin;
      if (now < 0n || now < last || now > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('TRACE_CLOCK_REFUSED');
      if (!geometry || ![geometry.width, geometry.height, geometry.capsuleWidth, geometry.capsuleHeight].every(value =>
        Number.isSafeInteger(value) && value > 0)) throw Error('TRACE_GEOMETRY_REFUSED');
      const point = ['click', 'move', 'scroll'].includes(event.kind);
      let coords = null;
      if (point) {
        if (!Number.isFinite(event.x) || !Number.isFinite(event.y) || event.x < 0 || event.y < 0 ||
            event.x >= geometry.width || event.y >= geometry.height) throw Error('TRACE_COORDINATE_REFUSED');
        coords = { tile: { x: event.x, y: event.y }, capsule: {
          x: event.x * geometry.capsuleWidth / geometry.width,
          y: event.y * geometry.capsuleHeight / geometry.height } };
      }
      if (event.kind === 'click' && ![0, 1, 2].includes(event.button)) throw Error('TRACE_BUTTON_REFUSED');
      if (event.kind === 'key' && !['up', 'down'].includes(event.phase)) throw Error('TRACE_KEY_PHASE_REFUSED');
      if (event.kind === 'scroll' && (!Number.isFinite(event.dx) || !Number.isFinite(event.dy) ||
          ![0, 1, 2].includes(event.deltaMode))) throw Error('TRACE_SCROLL_REFUSED');
      const sensitive = ax === null || ax.sensitive !== false || ax.password === true;
      const details = event.kind === 'key' ? {
        phase: event.phase,
        key: !sensitive && navKeys.has(event.key) ? event.key : null,
        redacted: sensitive || !navKeys.has(event.key),
      } : event.kind === 'scroll' ? {
        dx: event.dx, dy: event.dy, delta_mode: event.deltaMode,
      } : event.kind === 'click' ? { button: event.button } : {};
      const row = {
        schema: HUMAN_TRACE_SCHEMA, session_id: sessionId, surface_id: surfaceId, capsule_id: capsuleId,
        seq: seq + 1, monotonic_ns: Number(now), kind: event.kind, coords,
        viewport: { width: geometry.width, height: geometry.height },
        ax_row: !sensitive && ax && typeof ax.row === 'number' && Number.isSafeInteger(ax.row) && ax.row >= 0 ? ax.row : null,
        details,
      };
      // A synchronous bounded sink refuses before publication on overflow.
      write(JSON.stringify(row) + '\n');
      seq++; last = now;
      return true;
    },
  });
}

/** Host-owned directory, no-clobber private file; every event is written now,
 * rather than exported from a memory buffer when the tile closes.
 * @param {{directory:string,sessionId:string,surfaceId:string,capsuleId:string,profileId?:string}} options */
export function createHumanTraceFile({ directory, sessionId, surfaceId, capsuleId, profileId }) {
  if (profileId !== undefined) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profileId)) throw Error('TRACE_PROFILE_REFUSED');
    directory = join(directory, profileId);
    mkdirSync(directory, {mode:0o700,recursive:true});
    const st = lstatSync(directory);
    if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700 || realpathSync(directory) !== directory) throw Error('TRACE_DIRECTORY_REFUSED');
  }
  const filename = `human-trace-${randomUUID()}.jsonl`;
  const path = join(directory, filename);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let closed = false;
  let trace;
  try { trace = createHumanTrace({ sessionId, surfaceId, capsuleId, maxEvents:Number.MAX_SAFE_INTEGER, write(line) {
    if (closed) throw Error('TRACE_CLOSED');
    const bytes = Buffer.from(line);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw Error('TRACE_WRITE_FAILED');
      offset += count;
    }
  } }); } catch (error) { closeSync(fd); throw error; }
  return Object.freeze({ ...trace, path, close() {
    if (closed) return;
    closed = true;
    trace.setActive(false);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } });
}

/** Bounded memory first; explicit no-clobber export, never a renderer path. */
export function createHumanTraceBuffer(maxBytes = 4 * 1024 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw Error('TRACE_LIMIT');
  /** @type {string[]} */ const chunks = [];
  let size = 0;
  return Object.freeze({
    /** @param {string} line */
    write(line) {
      if (typeof line !== 'string' || size + Buffer.byteLength(line) > maxBytes) throw Error('TRACE_LIMIT');
      chunks.push(line); size += Buffer.byteLength(line);
    },
    get bytes() { return size; },
    /** @param {string} path */
    async exportTo(path) {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(chunks.join('')); await handle.sync(); } finally { await handle.close(); }
    },
  });
}
