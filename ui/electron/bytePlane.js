/**
 * Lossless byte plane for MetaViewer terminal sessions (unit R-W1-TERM).
 *
 * Pure accounting: no DOM, no timers, no filesystem, no Electron. Each
 * `{session, direction}` ledger ingests contiguous `{seq, b64}` frames and
 * retires them through cumulative parser-consumed ACKs. An accepted byte is
 * never dropped: malformed caller input throws `TypeError` before any
 * effect, stale or off-ledger operations throw `PlaneError` with the ledger
 * untouched, and wire violations fault the session explicitly through
 * `onFault` exactly once.
 *
 * @module bytePlane
 */

/**
 * Fatal wire-violation and stable refusal codes. Fatal codes close the
 * session (`onFault` fires once); refusal codes leave the ledger untouched.
 * @typedef {'seq-gap'|'seq-duplicate'|'bad-base64'|'frame-too-large'|'pending-overflow'|'frames-overflow'|'lifetime-overflow'|'unknown-session'|'closed'|'stale-generation'|'ack-stale'|'ack-unknown-seq'|'ack-not-boundary'|'duplicate-open'} PlaneCode
 */

/**
 * @typedef {object} FlowController
 * @property {(bytes: number) => void} enqueue record bytes handed to the parser
 * @property {(bytes: number) => void} acknowledge record parser-consumed bytes
 * @property {() => void} reset clear bytes and pause state (generation change)
 * @property {() => {buffered: number, paused: boolean}} snapshot read counters
 */

/**
 * @typedef {object} PlaneLimits
 * @property {number} maxFrameBytes largest accepted decoded frame
 * @property {number} highWaterBytes unacked bytes that pause the producer
 * @property {number} lowWaterBytes resume when unacked bytes reach or fall below this value
 * @property {number} maxPendingBytes unacked bytes that fault the session
 * @property {number} maxPendingFrames unacked frames that fault the session
 * @property {number} replayBytes retained replay-suffix bound
 * @property {number} maxSessionOutputBytes lifetime bytes that end the session
 */

/**
 * Authority-issued operation context; input and output are distinct ledgers.
 * @typedef {object} ByteContext
 * @property {string} session session id, never empty, never contains NUL
 * @property {'input'|'output'} direction independent directional ledger
 * @property {number} serviceGeneration broker service incarnation
 * @property {number} epoch admission epoch, observed but not compared here
 * @property {number} attachmentGeneration view attachment incarnation
 */

/**
 * @typedef {object} EncodedFrame wire frame: base64 only on the wire
 * @property {number} seq strictly contiguous, starts at 1
 * @property {string} b64 strict padded base64
 */

/**
 * @typedef {object} DataFrame decoded frame with owned bytes
 * @property {string} session
 * @property {number} seq
 * @property {Uint8Array} bytes fresh copy, safe for the caller to keep
 * @property {number} byteLength equals `bytes.length`
 */

/**
 * Cumulative consumed prefix, never a delta.
 * @typedef {object} Ack
 * @property {number} seq highest consumed frame
 * @property {number} bytes total consumed bytes through `seq`
 */

/**
 * Display-only replay suffix; `truncated` forces resync, never continuation.
 * @typedef {object} ReplaySuffix
 * @property {number|null} firstSeq seq of the first retained byte, if any
 * @property {number|null} lastSeq seq of the last retained byte, if any
 * @property {Uint8Array} bytes retained tail, oldest first
 * @property {boolean} truncated true once any byte aged out of the bound
 */

/**
 * @typedef {object} PlaneSnapshot
 * @property {number} sent lifetime accepted bytes
 * @property {number} acked lifetime consumed-prefix bytes
 * @property {number} lastSeq highest accepted seq
 * @property {number} pendingFrames unacked frame count
 * @property {boolean} paused producer pause advice latched
 */

/**
 * @typedef {object} BytePlane
 * @property {(context: ByteContext) => void} open create one directional ledger
 * @property {(context: ByteContext, frame: EncodedFrame) => DataFrame} ingest accept one frame
 * @property {(context: ByteContext, ack: Ack) => void} acknowledge retire a consumed prefix
 * @property {(context: ByteContext) => ReplaySuffix} attach bump generation, read suffix
 * @property {(context: ByteContext) => void} close idempotent teardown
 * @property {(context: ByteContext) => PlaneSnapshot} snapshot read counters
 */

/**
 * @typedef {object} Ledger
 * @property {string} session
 * @property {'input'|'output'} direction
 * @property {number} serviceGeneration
 * @property {number} attachmentGeneration
 * @property {number} sent
 * @property {number} acked
 * @property {number} lastSeq
 * @property {number} ackSeq
 * @property {Map<number, number>} frames seq to cumulative sent offset
 * @property {Array<{seq: number, bytes: Uint8Array}>} replay oldest-first chunks
 * @property {number} replayBytes
 * @property {number} droppedBytes bytes trimmed off the replay head, sticky
 * @property {boolean} paused
 * @property {boolean} closed
 */

/** Strict padded base64 over the canonical alphabet; empty string matches. */
const B64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Protocol refusal or fatal wire violation. `code` is stable; the message
 * carries counters only, never payload bytes.
 */
export class PlaneError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message human detail without payload bytes
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'PlaneError';
    /** @type {string} */
    this.code = code;
  }
}

/**
 * @param {string} name field name for the error
 * @param {unknown} bytes candidate value
 * @param {number} min inclusive lower bound
 * @returns {number} validated safe integer
 */
function assertByteCount(name, bytes, min) {
  if (!Number.isSafeInteger(bytes) || /** @type {number} */ (bytes) < min) {
    throw new TypeError(`${name} must be a safe integer >= ${min}`);
  }
  return /** @type {number} */ (bytes);
}

/**
 * Host-side backpressure advice: byte accounting with high/low watermarks.
 * Crossing the high watermark fires `onPause` once; draining to the low
 * watermark or below fires `onResume` once. Never drops bytes.
 * @param {object} options all fields required, no implicit layer defaults
 * @param {number} options.highWaterBytes pause at or above this buffered count
 * @param {number} options.lowWaterBytes resume at or below this buffered count
 * @param {() => void} options.onPause fired once when pausing
 * @param {() => void} options.onResume fired once when resuming
 * @returns {FlowController}
 */
export function createFlowController(options) {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('createFlowController: options object required');
  }
  const raw = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (options));
  const highWaterBytes = assertByteCount('createFlowController: highWaterBytes', raw.highWaterBytes, 1);
  const lowWaterBytes = assertByteCount('createFlowController: lowWaterBytes', raw.lowWaterBytes, 1);
  if (typeof raw.onPause !== 'function' || typeof raw.onResume !== 'function') {
    throw new TypeError('createFlowController: onPause and onResume must be functions');
  }
  if (!(highWaterBytes > lowWaterBytes)) {
    throw new RangeError('createFlowController: need lowWaterBytes < highWaterBytes');
  }
  const onPause = /** @type {() => void} */ (raw.onPause);
  const onResume = /** @type {() => void} */ (raw.onResume);
  let buffered = 0;
  let paused = false;
  /** @type {FlowController} */
  const controller = {
    enqueue(bytes) {
      const count = assertByteCount('createFlowController: enqueue', bytes, 0);
      const next = buffered + count;
      if (!Number.isSafeInteger(next)) {
        throw new RangeError('createFlowController: buffered byte count overflows');
      }
      buffered = next;
      if (!paused && buffered >= highWaterBytes) {
        paused = true;
        onPause();
      }
    },
    acknowledge(bytes) {
      const count = assertByteCount('createFlowController: acknowledge', bytes, 0);
      buffered = Math.max(0, buffered - count);
      if (paused && buffered <= lowWaterBytes) {
        paused = false;
        onResume();
      }
    },
    reset() {
      buffered = 0;
      paused = false;
    },
    snapshot() {
      return { buffered, paused };
    },
  };
  return controller;
}

/**
 * @param {string} name bound name for the error
 * @param {unknown} value candidate value
 * @returns {number} validated bound
 */
function limitInt(name, value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1) {
    throw new TypeError(`createBytePlane: limits.${name} must be a safe integer >= 1`);
  }
  return /** @type {number} */ (value);
}

/**
 * Validates every bound and proves the ingest additions cannot overflow
 * before any ledger or buffer exists.
 * @param {unknown} value candidate limits object
 * @returns {PlaneLimits} owned copy
 */
function validateLimits(value) {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('createBytePlane: limits object required');
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  const limits = {
    maxFrameBytes: limitInt('maxFrameBytes', raw.maxFrameBytes),
    highWaterBytes: limitInt('highWaterBytes', raw.highWaterBytes),
    lowWaterBytes: limitInt('lowWaterBytes', raw.lowWaterBytes),
    maxPendingBytes: limitInt('maxPendingBytes', raw.maxPendingBytes),
    maxPendingFrames: limitInt('maxPendingFrames', raw.maxPendingFrames),
    replayBytes: limitInt('replayBytes', raw.replayBytes),
    maxSessionOutputBytes: limitInt('maxSessionOutputBytes', raw.maxSessionOutputBytes),
  };
  if (!(limits.lowWaterBytes < limits.highWaterBytes)) {
    throw new RangeError('createBytePlane: need lowWaterBytes < highWaterBytes');
  }
  if (!(limits.highWaterBytes <= limits.maxPendingBytes)) {
    throw new RangeError('createBytePlane: need highWaterBytes <= maxPendingBytes');
  }
  const sums = [
    ['maxPendingBytes + maxFrameBytes', limits.maxPendingBytes + limits.maxFrameBytes],
    ['maxSessionOutputBytes + maxFrameBytes', limits.maxSessionOutputBytes + limits.maxFrameBytes],
  ];
  for (const [name, sum] of sums) {
    if (!Number.isSafeInteger(sum)) {
      throw new RangeError(`createBytePlane: ${name} overflows`);
    }
  }
  return limits;
}

/**
 * @param {unknown} value candidate context
 * @returns {ByteContext} owned copy
 */
function assertContext(value) {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('bytePlane: context must be an object');
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  if (typeof raw.session !== 'string' || raw.session.length === 0 || raw.session.includes('\0')) {
    throw new TypeError('bytePlane: context.session must be a non-empty string without NUL');
  }
  if (raw.direction !== 'input' && raw.direction !== 'output') {
    throw new TypeError("bytePlane: context.direction must be 'input' or 'output'");
  }
  if (!Number.isSafeInteger(raw.serviceGeneration) || /** @type {number} */ (raw.serviceGeneration) < 0) {
    throw new TypeError('bytePlane: context.serviceGeneration must be a safe unsigned integer');
  }
  if (!Number.isSafeInteger(raw.epoch) || /** @type {number} */ (raw.epoch) < 0) {
    throw new TypeError('bytePlane: context.epoch must be a safe unsigned integer');
  }
  if (!Number.isSafeInteger(raw.attachmentGeneration)
      || /** @type {number} */ (raw.attachmentGeneration) < 0) {
    throw new TypeError('bytePlane: context.attachmentGeneration must be a safe unsigned integer');
  }
  return {
    session: raw.session,
    direction: /** @type {'input'|'output'} */ (raw.direction),
    serviceGeneration: /** @type {number} */ (raw.serviceGeneration),
    epoch: /** @type {number} */ (raw.epoch),
    attachmentGeneration: /** @type {number} */ (raw.attachmentGeneration),
  };
}

/**
 * @param {unknown} value candidate frame
 * @returns {EncodedFrame} owned copy
 */
function assertFrame(value) {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('bytePlane: frame must be an object');
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  if (!Number.isSafeInteger(raw.seq)) {
    throw new TypeError('bytePlane: frame.seq must be a safe integer');
  }
  if (typeof raw.b64 !== 'string') {
    throw new TypeError('bytePlane: frame.b64 must be a string');
  }
  return { seq: /** @type {number} */ (raw.seq), b64: raw.b64 };
}

/**
 * @param {unknown} value candidate ack
 * @returns {Ack} owned copy
 */
function assertAck(value) {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('bytePlane: ack must be an object');
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  if (!Number.isSafeInteger(raw.seq) || /** @type {number} */ (raw.seq) < 0) {
    throw new TypeError('bytePlane: ack.seq must be a safe unsigned integer');
  }
  if (!Number.isSafeInteger(raw.bytes) || /** @type {number} */ (raw.bytes) < 0) {
    throw new TypeError('bytePlane: ack.bytes must be a safe unsigned integer');
  }
  return { seq: /** @type {number} */ (raw.seq), bytes: /** @type {number} */ (raw.bytes) };
}

/**
 * @param {ByteContext} context validated context
 * @returns {string} ledger map key
 */
function ledgerKey(context) {
  return `${context.direction}\0${context.session}`;
}

/**
 * @param {ByteContext} context validated context
 * @returns {ByteContext} fresh copy for host callbacks
 */
function copyContext(context) {
  return {
    session: context.session,
    direction: context.direction,
    serviceGeneration: context.serviceGeneration,
    epoch: context.epoch,
    attachmentGeneration: context.attachmentGeneration,
  };
}

/**
 * @param {Map<string, Ledger>} ledgers live ledgers
 * @param {ByteContext} context validated context
 * @returns {Ledger} open ledger
 */
function requireOpen(ledgers, context) {
  const ledger = ledgers.get(ledgerKey(context));
  if (!ledger) {
    throw new PlaneError('unknown-session', `no ledger for ${context.direction}:${context.session}`);
  }
  if (ledger.closed) {
    throw new PlaneError('closed', `session ${context.session} is closed`);
  }
  return ledger;
}

/**
 * @param {Ledger} ledger open ledger
 * @param {ByteContext} context validated context
 */
function requireGeneration(ledger, context) {
  if (context.serviceGeneration !== ledger.serviceGeneration
      || context.attachmentGeneration !== ledger.attachmentGeneration) {
    throw new PlaneError('stale-generation', `session ${ledger.session} moved generation`);
  }
}

/**
 * @param {Ledger} ledger open ledger
 * @param {ByteContext} context validated context
 * @param {string} code fatal code
 * @param {string} detail counter-only detail
 * @param {(context: ByteContext, code: string) => void} onFault host observer
 * @returns {never} always throws
 */
function fail(ledger, context, code, detail, onFault) {
  closeLedger(ledger);
  onFault(copyContext(context), code);
  throw new PlaneError(code, detail);
}

/** Release retained payload and ACK boundaries, preserving lifetime counters.
 * @param {Ledger} ledger
 */
function closeLedger(ledger) {
  ledger.closed = true;
  ledger.replay = [];
  ledger.replayBytes = 0;
  ledger.frames.clear();
  ledger.paused = false;
}

/**
 * @param {Ledger} ledger open ledger
 * @param {PlaneLimits} limits validated bounds
 * @param {number} seq accepted seq
 * @param {Uint8Array} bytes owned chunk, retained by reference
 */
function appendReplay(ledger, limits, seq, bytes) {
  if (bytes.length === 0) return;
  ledger.replay.push({ seq, bytes });
  ledger.replayBytes += bytes.length;
  let excess = ledger.replayBytes - limits.replayBytes;
  while (excess > 0 && ledger.replay.length > 0) {
    const front = ledger.replay[0];
    if (front.bytes.length <= excess) {
      excess -= front.bytes.length;
      ledger.replayBytes -= front.bytes.length;
      ledger.droppedBytes += front.bytes.length;
      ledger.replay.shift();
    } else {
      ledger.replay[0] = { seq: front.seq, bytes: front.bytes.slice(excess) };
      ledger.replayBytes -= excess;
      ledger.droppedBytes += excess;
      excess = 0;
    }
  }
}

/**
 * Creates the lossless byte plane: contiguous per-direction ledgers with
 * cumulative ACKs, pause/resume watermarks and generation-fenced attach.
 * @param {object} options owned configuration
 * @param {PlaneLimits} options.limits validated before anything is allocated
 * @param {(context: ByteContext) => void} options.onPause pause advice
 * @param {(context: ByteContext) => void} options.onResume resume advice
 * @param {(context: ByteContext, code: string) => void} options.onFault fatal observer
 * @returns {BytePlane}
 */
export function createBytePlane(options) {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('createBytePlane: options object required');
  }
  const raw = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (options));
  const limits = validateLimits(raw.limits);
  if (typeof raw.onPause !== 'function' || typeof raw.onResume !== 'function'
      || typeof raw.onFault !== 'function') {
    throw new TypeError('createBytePlane: onPause, onResume and onFault must be functions');
  }
  const onPause = /** @type {(context: ByteContext) => void} */ (raw.onPause);
  const onResume = /** @type {(context: ByteContext) => void} */ (raw.onResume);
  const onFault = /** @type {(context: ByteContext, code: string) => void} */ (raw.onFault);
  /** @type {Map<string, Ledger>} */
  const ledgers = new Map();
  /** @type {BytePlane} */
  const plane = {
    open(rawContext) {
      const context = assertContext(rawContext);
      if (ledgers.has(ledgerKey(context))) {
        throw new PlaneError('duplicate-open', `ledger for ${context.direction}:${context.session} exists`);
      }
      ledgers.set(ledgerKey(context), {
        session: context.session,
        direction: context.direction,
        serviceGeneration: context.serviceGeneration,
        attachmentGeneration: context.attachmentGeneration,
        sent: 0,
        acked: 0,
        lastSeq: 0,
        ackSeq: 0,
        frames: new Map(),
        replay: [],
        replayBytes: 0,
        droppedBytes: 0,
        paused: false,
        closed: false,
      });
    },
    ingest(rawContext, rawFrame) {
      const context = assertContext(rawContext);
      const ledger = requireOpen(ledgers, context);
      requireGeneration(ledger, context);
      const frame = assertFrame(rawFrame);
      if (frame.seq !== ledger.lastSeq + 1) {
        const rewind = frame.seq <= ledger.lastSeq;
        fail(ledger, context, rewind ? 'seq-duplicate' : 'seq-gap',
          `expected seq ${ledger.lastSeq + 1}, got ${frame.seq}`, onFault);
      }
      if (!B64_PATTERN.test(frame.b64)) {
        fail(ledger, context, 'bad-base64', `seq ${frame.seq} is not strict base64`, onFault);
      }
      const bytes = new Uint8Array(Buffer.from(frame.b64, 'base64'));
      if (bytes.length > limits.maxFrameBytes) {
        fail(ledger, context, 'frame-too-large',
          `seq ${frame.seq} carries ${bytes.length} bytes`, onFault);
      }
      const sent = ledger.sent + bytes.length;
      if (ledger.frames.size >= limits.maxPendingFrames) {
        fail(ledger, context, 'frames-overflow',
          `${ledger.frames.size} unacked frames`, onFault);
      }
      if (sent - ledger.acked > limits.maxPendingBytes) {
        fail(ledger, context, 'pending-overflow',
          `${sent - ledger.acked} unacked bytes`, onFault);
      }
      if (sent > limits.maxSessionOutputBytes) {
        fail(ledger, context, 'lifetime-overflow', `${sent} lifetime bytes`, onFault);
      }
      ledger.lastSeq = frame.seq;
      ledger.sent = sent;
      ledger.frames.set(frame.seq, sent);
      appendReplay(ledger, limits, frame.seq, bytes);
      if (!ledger.paused && sent - ledger.acked >= limits.highWaterBytes) {
        ledger.paused = true;
        onPause(copyContext(context));
      }
      return { session: ledger.session, seq: frame.seq, bytes: bytes.slice(), byteLength: bytes.length };
    },
    acknowledge(rawContext, rawAck) {
      const context = assertContext(rawContext);
      const ledger = requireOpen(ledgers, context);
      requireGeneration(ledger, context);
      const ack = assertAck(rawAck);
      if (ack.seq <= ledger.ackSeq) {
        throw new PlaneError('ack-stale', `seq ${ack.seq} at or below acked ${ledger.ackSeq}`);
      }
      const boundary = ledger.frames.get(ack.seq);
      if (boundary === undefined) {
        throw new PlaneError('ack-unknown-seq', `seq ${ack.seq} has no recorded boundary`);
      }
      if (boundary !== ack.bytes) {
        throw new PlaneError('ack-not-boundary',
          `seq ${ack.seq} recorded ${boundary} bytes, ack claims ${ack.bytes}`);
      }
      ledger.acked = ack.bytes;
      ledger.ackSeq = ack.seq;
      for (const seq of ledger.frames.keys()) {
        if (seq <= ack.seq) {
          ledger.frames.delete(seq);
        }
      }
      if (ledger.paused && ledger.sent - ledger.acked <= limits.lowWaterBytes) {
        ledger.paused = false;
        onResume(copyContext(context));
      }
    },
    attach(rawContext) {
      const context = assertContext(rawContext);
      const ledger = requireOpen(ledgers, context);
      if (context.serviceGeneration !== ledger.serviceGeneration
          || context.attachmentGeneration <= ledger.attachmentGeneration) {
        throw new PlaneError('stale-generation', `session ${ledger.session} moved generation`);
      }
      ledger.attachmentGeneration = context.attachmentGeneration;
      const bytes = new Uint8Array(ledger.replayBytes);
      let offset = 0;
      for (const chunk of ledger.replay) {
        bytes.set(chunk.bytes, offset);
        offset += chunk.bytes.length;
      }
      const firstSeq = ledger.replay.length > 0 ? ledger.replay[0].seq : null;
      const lastSeq = ledger.replay.length > 0 ? ledger.replay[ledger.replay.length - 1].seq : null;
      return { firstSeq, lastSeq, bytes, truncated: ledger.droppedBytes > 0 };
    },
    close(rawContext) {
      const context = assertContext(rawContext);
      const ledger = ledgers.get(ledgerKey(context));
      if (!ledger) {
        throw new PlaneError('unknown-session', `no ledger for ${context.direction}:${context.session}`);
      }
      if (!ledger.closed) requireGeneration(ledger, context);
      closeLedger(ledger);
    },
    snapshot(rawContext) {
      const context = assertContext(rawContext);
      const ledger = ledgers.get(ledgerKey(context));
      if (!ledger) {
        throw new PlaneError('unknown-session', `no ledger for ${context.direction}:${context.session}`);
      }
      return {
        sent: ledger.sent,
        acked: ledger.acked,
        lastSeq: ledger.lastSeq,
        pendingFrames: ledger.frames.size,
        paused: ledger.paused,
      };
    },
  };
  return plane;
}
