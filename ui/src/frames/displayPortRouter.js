// @ts-check
/**
 * @fileoverview Display-port router: main-world consumer for unverified 20-30 fps DISPLAY tier ports.
 *
 * Preload forwards one MessagePort per surface with
 * `window.postMessage({type:'metaviewer:display-port', schema:'display_port/v1', surface_id}, origin, [port])`.
 * This router is completely isolated from the VERIFIED `framePortRouter.js` path, `frame_ref`
 * handling, and receipts. It validates `display_delivery/v1` and `display_state/v1` payloads,
 * paints the newest display frame onto the bound tile canvas, tracks the 2 s stale timeout,
 * and acks deliveries on the display port so the host reader never blocks or queues stale frames.
 * @module frames/displayPortRouter
 */

/** Notice type posted by preload to the main world for DISPLAY ports. @type {string} */
export const DISPLAY_PORT_NOTICE_TYPE = 'metaviewer:display-port';

/** Closed notice schema for DISPLAY ports. @type {string} */
export const DISPLAY_PORT_NOTICE_SCHEMA = 'display_port/v1';

/** Delivery envelope schema for DISPLAY frames. @type {string} */
export const DISPLAY_DELIVERY_SCHEMA = 'display_frame/v1';

/** State envelope schema for DISPLAY liveness transitions. @type {string} */
export const DISPLAY_STATE_SCHEMA = 'display_state/v1';

/** Ack envelope schema for DISPLAY frames. @type {string} */
export const DISPLAY_ACK_SCHEMA = 'display_ack/v1';

/** Milliseconds without a new display frame before the tile enters visible stale state [TARGET]. @type {number} */
export const DISPLAY_STALE_MS = 2000;

const PRIVILEGED_ORIGIN = 'app://metaviewer';
const SURFACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NOTICE_KEYS = 'schema,surface_id,type';
const DELIVERY_KEYS = 'byteLength,bytes,captureMonoNs,format,generation,height,kind,schema,seq,surfaceId,width';
const STATE_KEYS = 'generation,kind,schema,state,surfaceId';

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Reflect.ownKeys(v)) {
    if (typeof key !== 'string') return false;
    const desc = Object.getOwnPropertyDescriptor(v, key);
    if (!desc || !('value' in desc)) return false;
  }
  return true;
}

/**
 * @param {unknown} v
 * @param {string} expectedSortedKeys
 * @returns {v is Record<string, any>}
 */
function hasExactKeys(v, expectedSortedKeys) {
  return isPlain(v) && Object.keys(v).sort().join(',') === expectedSortedKeys;
}

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isValidSurfaceId(v) {
  return typeof v === 'string' && SURFACE_ID_RE.test(v);
}

/**
 * @param {unknown} value
 * @returns {value is {type: 'metaviewer:display-port', schema: 'display_port/v1', surface_id: string}}
 */
export function isValidDisplayNotice(value) {
  return (
    hasExactKeys(value, NOTICE_KEYS) &&
    value.type === DISPLAY_PORT_NOTICE_TYPE &&
    value.schema === DISPLAY_PORT_NOTICE_SCHEMA &&
    isValidSurfaceId(value.surface_id)
  );
}

/**
 * @param {unknown} value
 * @returns {value is {
 *   schema: 'display_delivery/v1',
 *   kind: 'display_frame',
 *   surfaceId: string,
 *   width: number,
 *   height: number,
 *   format: 'rgb24',
 *   seq: string,
 *   captureMonoNs: string,
 *   generation: string,
 *   byteLength: number,
 *   bytes: Uint8Array
 * }}
 */
export function isValidDisplayDelivery(value) {
  if (!hasExactKeys(value, DELIVERY_KEYS)) return false;
  if (value.schema !== DISPLAY_DELIVERY_SCHEMA && value.schema !== 'display_delivery/v1') return false;
  if (value.kind !== 'display_frame') return false;
  if (!isValidSurfaceId(value.surfaceId) || value.format !== 'rgb24') return false;
  if (!Number.isSafeInteger(value.width) || value.width < 1 || value.width > 4096) return false;
  if (!Number.isSafeInteger(value.height) || value.height < 1 || value.height > 4096) return false;
  const expectedBytes = value.width * value.height * 3;
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength !== expectedBytes) return false;
  const seqStr = typeof value.seq === 'number' && Number.isSafeInteger(value.seq) ? String(value.seq) : value.seq;
  if (typeof seqStr !== 'string' || !/^[0-9]{1,20}$/.test(seqStr)) return false;
  try {
    const seqBig = BigInt(seqStr);
    if (seqBig < 2n || (seqBig & 1n) !== 0n) return false;
  } catch {
    return false;
  }
  const monoStr =
    typeof value.captureMonoNs === 'number' && Number.isSafeInteger(value.captureMonoNs)
      ? String(value.captureMonoNs)
      : value.captureMonoNs;
  if (typeof monoStr !== 'string' || !/^[0-9]{1,20}$/.test(monoStr)) return false;
  const genStr =
    typeof value.generation === 'number' && Number.isSafeInteger(value.generation)
      ? String(value.generation)
      : value.generation;
  if (typeof genStr !== 'string' || !/^[0-9]{1,20}$/.test(genStr)) return false;
  let bytesView = null;
  if (value.bytes instanceof Uint8Array) {
    bytesView = value.bytes;
  } else if (value.bytes instanceof ArrayBuffer) {
    bytesView = new Uint8Array(value.bytes);
  } else if (ArrayBuffer.isView(value.bytes)) {
    bytesView = new Uint8Array(value.bytes.buffer, value.bytes.byteOffset, value.bytes.byteLength);
  }
  if (!bytesView || bytesView.byteLength !== expectedBytes) return false;
  return true;
}

/**
 * @param {unknown} value
 * @returns {value is {
 *   schema: 'display_state/v1',
 *   kind: 'display_state',
 *   surfaceId: string,
 *   state: 'active' | 'stale' | 'absent',
 *   generation: string | number
 * }}
 */
export function isValidDisplayState(value) {
  if (!hasExactKeys(value, STATE_KEYS)) return false;
  if (value.schema !== DISPLAY_STATE_SCHEMA || value.kind !== 'display_state') return false;
  if (!isValidSurfaceId(value.surfaceId)) return false;
  if (value.state !== 'active' && value.state !== 'stale' && value.state !== 'absent') return false;
  const genStr =
    typeof value.generation === 'number' && Number.isSafeInteger(value.generation)
      ? String(value.generation)
      : value.generation;
  if (typeof genStr !== 'string' || !/^[0-9]{1,20}$/.test(genStr)) return false;
  return true;
}

/**
 * @param {any} rawBytes
 * @returns {Uint8Array}
 */
function toUint8Array(rawBytes) {
  if (rawBytes instanceof Uint8Array) return rawBytes;
  if (rawBytes instanceof ArrayBuffer) return new Uint8Array(rawBytes);
  return new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
}

/** @type {WeakMap<object, { width: number, height: number, image: any }>} */
const canvasScratchByElement = new WeakMap();

/**
 * Paint an unverified DISPLAY RGB24 frame onto a 2D canvas element.
 * Never enters the VERIFIED scheduler, frame_ref handling, or receipts.
 *
 * @param {any} canvas
 * @param {{ width: number, height: number, bytes: Uint8Array }} frame
 * @returns {boolean}
 */
export function paintDisplayCanvas(canvas, frame) {
  if (!canvas || typeof canvas !== 'object' || typeof canvas.getContext !== 'function') return false;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.putImageData !== 'function' || typeof ctx.createImageData !== 'function') return false;
  const { width, height, bytes } = frame;
  if (!bytes || bytes.byteLength !== width * height * 3) return false;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  let scratch = canvasScratchByElement.get(canvas) ?? null;
  let image = null;
  if (
    scratch !== null &&
    scratch.width === width &&
    scratch.height === height &&
    scratch.image?.data &&
    scratch.image.data.length === width * height * 4
  ) {
    image = scratch.image;
  } else {
    image = ctx.createImageData(width, height);
    scratch = { width, height, image };
    canvasScratchByElement.set(canvas, scratch);
  }
  const rgba = image.data;
  for (let s = 0, d = 0; s < bytes.byteLength; s += 3, d += 4) {
    rgba[d] = bytes[s];
    rgba[d + 1] = bytes[s + 1];
    rgba[d + 2] = bytes[s + 2];
    rgba[d + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return true;
}

/**
 * @typedef {object} DisplaySurfaceBinding
 * @property {string} surfaceId
 * @property {symbol|object} [bindToken]
 * @property {() => any} [getCanvas]
 * @property {(frame: {
 *   surfaceId: string,
 *   width: number,
 *   height: number,
 *   format: 'rgb24',
 *   seq: string,
 *   captureMonoNs: string,
 *   generation: string,
 *   bytes: Uint8Array
 * }) => boolean | void} [onFrame]
 * @property {(state: {
 *   surfaceId: string,
 *   state: 'active' | 'stale' | 'absent',
 *   generation: string
 * }) => void} [onState]
 * @property {() => boolean} [isVisible]
 */

/**
 * Install a display-port router listening on `target` (defaults to `window`).
 *
 * @param {{
 *   target?: any,
 *   expectedOrigin?: string,
 *   staleTimeoutMs?: number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout
 * }} [options]
 */
export function installDisplayPortRouter(options = {}) {
  const target = options.target ?? (typeof window !== 'undefined' ? window : null);
  const expectedOrigin = options.expectedOrigin ?? PRIVILEGED_ORIGIN;
  const staleTimeoutMs =
    typeof options.staleTimeoutMs === 'number' && options.staleTimeoutMs > 0
      ? options.staleTimeoutMs
      : DISPLAY_STALE_MS;
  const setTimer = options.setTimeoutFn ?? setTimeout;
  const clearTimer = options.clearTimeoutFn ?? clearTimeout;

  /** @type {Map<string, Array<{token: unknown, getCanvas?: DisplaySurfaceBinding['getCanvas'], onFrame?: DisplaySurfaceBinding['onFrame'], onState?: DisplaySurfaceBinding['onState'], isVisible?: DisplaySurfaceBinding['isVisible'], visible: boolean}>>} */
  const bindingsBySurface = new Map();

  /**
   * @type {Map<string, {
   *   port: any,
   *   onMessage: (ev: any) => void,
   *   state: 'active' | 'stale' | 'absent',
   *   generation: string,
   *   lastFrame: any | null,
   *   parked: boolean,
   *   staleTimer: any | null
   * }>}
   */
  const streams = new Map();

  let disposed = false;
  let paintedCount = 0;
  let refusedCount = 0;
  // [TARGET, unit decision] Bound diagnostics at the producer as well as main:
  // a broken high-rate stream cannot create high-rate diagnostic IPC.
  /** @type {Map<string, Set<string>>} */
  const diagnosticStages = new Map();
  /** @param {string} surfaceId @param {string} stage @param {string} detail */
  function diagnostic(surfaceId, stage, detail) {
    let seen = diagnosticStages.get(surfaceId);
    if (!seen) {
      if (diagnosticStages.size >= 256) return;
      seen = new Set(); diagnosticStages.set(surfaceId, seen);
    }
    if (seen.has(stage)) return;
    seen.add(stage);
    target?.postMessage?.({type:'metaviewer:display-diagnostic',schema:'display_diagnostic/v1',surface_id:surfaceId,stage,detail}, expectedOrigin);
  }

  /**
   * @param {string} surfaceId
   */
  function activeBinding(surfaceId) {
    const stack = bindingsBySurface.get(surfaceId);
    if (!stack || stack.length === 0) return null;
    return stack[stack.length - 1];
  }

  /**
   * @param {{
   *   getCanvas?: () => any,
   *   onFrame?: DisplaySurfaceBinding['onFrame'],
   *   isVisible?: () => boolean,
   *   visible: boolean
   * }} binding
   * @param {any} frame
   * @returns {boolean}
   */
  function deliverBindingFrame(binding, frame) {
    if (!binding || !binding.visible) return false;
    if (typeof binding.isVisible === 'function') {
      try {
        if (!binding.isVisible()) return false;
      } catch {
        return false;
      }
    }
    let painted = true;
    if (typeof binding.getCanvas === 'function') {
      try {
        painted = paintDisplayCanvas(binding.getCanvas(), frame);
      } catch {
        painted = false;
      }
      if (!painted) return false;
    }
    if (typeof binding.onFrame === 'function') {
      try {
        const res = binding.onFrame(frame);
        if (res === false) painted = false;
      } catch {
        painted = false;
      }
    }
    return painted;
  }

  /**
   * @param {{ staleTimer: any | null }} stream
   */
  function clearStaleWatchdog(stream) {
    if (stream.staleTimer !== null) {
      try {
        clearTimer(stream.staleTimer);
      } catch {
        /* ignore timer teardown error */
      }
      stream.staleTimer = null;
    }
  }

  /**
   * @param {string} surfaceId
   * @param {{
   *   port: any,
   *   onMessage: (ev: any) => void,
   *   state: 'active' | 'stale' | 'absent',
   *   generation: string,
   *   lastFrame: any | null,
   *   parked: boolean,
   *   staleTimer: any | null
   * }} stream
   */
  function armStaleWatchdog(surfaceId, stream) {
    clearStaleWatchdog(stream);
    if (disposed || stream.state !== 'active') return;
    stream.staleTimer = setTimer(() => {
      stream.staleTimer = null;
      if (disposed || streams.get(surfaceId) !== stream || stream.state !== 'active') return;
      stream.state = 'stale';
      const binding = activeBinding(surfaceId);
      if (binding && typeof binding.onState === 'function') {
        try {
          binding.onState({
            surfaceId,
            state: 'stale',
            generation: stream.generation,
          });
        } catch {
          /* ignore listener throw */
        }
      }
    }, staleTimeoutMs);
    if (stream.staleTimer && typeof stream.staleTimer === 'object' && typeof stream.staleTimer.unref === 'function') {
      stream.staleTimer.unref();
    }
  }

  /**
   * @param {any} port
   * @param {string} surfaceId
   * @param {string} seq
   * @param {'PRESENTED' | 'HIDDEN' | 'REFUSED'} outcome
   */
  function postAck(port, surfaceId, seq, outcome) {
    try {
      port.postMessage({
        schema: DISPLAY_ACK_SCHEMA,
        kind: 'display_ack',
        surfaceId,
        seq,
        outcome,
      });
    } catch {
      /* ignore closed port */
    }
  }

  // [TARGET, unit decision] Retry missing handoffs every 500 ms while bound
  // and visible. A bind before frames subscription therefore converges too.
  /** @type {Map<string, {timer:any,last:number}>} */
  const pulls = new Map();
  /** @param {string} surfaceId */
  function requestDisplay(surfaceId) {
    if (!target?.postMessage || disposed || !activeBinding(surfaceId)?.visible) return;
    let pull = pulls.get(surfaceId);
    if (!pull) { pull = {timer:null,last:-Infinity}; pulls.set(surfaceId,pull); }
    if (Date.now() - pull.last >= 500) {
      pull.last = Date.now();
      target.postMessage({type:'metaviewer:display-request',schema:'display_request/v1',surface_id:surfaceId}, expectedOrigin);
    }
    if (!pull.timer) pull.timer = setTimer(() => {
      const current = pulls.get(surfaceId);
      if (current) current.timer = null;
      if (pulls.has(surfaceId)) requestDisplay(surfaceId);
    }, 500);
  }
  /** @param {string} surfaceId */
  function stopPull(surfaceId) {
    const pull = pulls.get(surfaceId);
    if (pull?.timer) clearTimer(pull.timer);
    pulls.delete(surfaceId);
  }
  /** @param {string} surfaceId */
  function parkStream(surfaceId) {
    stopPull(surfaceId);
    const stream = streams.get(surfaceId);
    if (!stream) return;
    try { stream.port.postMessage({schema:DISPLAY_ACK_SCHEMA,kind:'display_visibility',surfaceId,hidden:true}); } catch {}
    stream.parked = true;
    stream.lastFrame = null;
    clearStaleWatchdog(stream);
  }

  /**
   * @param {string} surfaceId
   */
  function closeStream(surfaceId) {
    const stream = streams.get(surfaceId);
    if (!stream) return;
    streams.delete(surfaceId);
    clearStaleWatchdog(stream);
    try {
      if (typeof stream.port.removeEventListener === 'function') {
        stream.port.removeEventListener('message', stream.onMessage);
      } else if (typeof stream.port.off === 'function') {
        stream.port.off('message', stream.onMessage);
      }
    } catch {
      /* ignore */
    }
    try {
      stream.port.close?.();
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {string} surfaceId
   * @param {any} port
   */
  function attachStream(surfaceId, port) {
    stopPull(surfaceId);
    closeStream(surfaceId);
    const stream = {
      port,
      /** @param {any} ev */
      onMessage(ev) {
        if (disposed || streams.get(surfaceId) !== stream) return;
        const payload = ev && typeof ev === 'object' && 'data' in ev ? ev.data : ev;
        if (payload?.kind === 'display_frame') diagnostic(surfaceId, 'FIRST_FRAME', 'OK');
        if (isValidDisplayDelivery(payload)) {
          if (payload.surfaceId !== surfaceId) {
            refusedCount += 1;
            diagnostic(surfaceId, 'REFUSED', 'SURFACE_MISMATCH');
            postAck(port, surfaceId, payload.seq, 'REFUSED');
            return;
          }
          const frame = Object.freeze({
            surfaceId,
            width: payload.width,
            height: payload.height,
            format: /** @type {'rgb24'} */ ('rgb24'),
            seq: payload.seq,
            captureMonoNs: payload.captureMonoNs,
            generation: payload.generation,
            bytes: toUint8Array(payload.bytes),
          });
          stream.generation = payload.generation;
          stream.lastFrame = stream.parked ? null : frame;
          const prevState = stream.state;
          stream.state = 'active';
          if (!stream.parked) armStaleWatchdog(surfaceId, stream);

          const binding = activeBinding(surfaceId);
          if (!binding || !binding.visible) {
            diagnostic(surfaceId, 'REFUSED', !binding ? 'NO_BINDING' : 'HIDDEN');
            postAck(port, surfaceId, payload.seq, 'HIDDEN');
            return;
          }
          if (prevState !== 'active' && typeof binding.onState === 'function') {
            try {
              binding.onState({
                surfaceId,
                state: 'active',
                generation: stream.generation,
              });
            } catch {
              /* ignore */
            }
          }
          const painted = deliverBindingFrame(binding, frame);
          if (painted) {
            diagnostic(surfaceId, 'FIRST_PAINT', 'OK');
            paintedCount += 1;
            postAck(port, surfaceId, payload.seq, 'PRESENTED');
          } else {
            diagnostic(surfaceId, 'REFUSED', 'PAINT_FAILED');
            postAck(port, surfaceId, payload.seq, 'HIDDEN');
          }
          return;
        }
        if (isValidDisplayState(payload)) {
          if (payload.surfaceId !== surfaceId) {
            refusedCount += 1;
            return;
          }
          stream.generation = String(payload.generation);
          stream.state = payload.state;
          if (payload.state !== 'active') {
            clearStaleWatchdog(stream);
            if (payload.state === 'absent') {
              stream.lastFrame = null;
            }
          }
          const binding = activeBinding(surfaceId);
          if (binding && typeof binding.onState === 'function') {
            try {
              binding.onState({
                surfaceId,
                state: payload.state,
                generation: String(payload.generation),
              });
            } catch {
              /* ignore */
            }
          }
          return;
        }
        refusedCount += 1;
        diagnostic(surfaceId, 'REFUSED', typeof payload?.generation === 'number' && !Number.isSafeInteger(payload.generation)
          ? 'UNSAFE_GENERATION' : 'INVALID_DELIVERY');
      },
      parked: false,
      state: /** @type {'active' | 'stale' | 'absent'} */ ('absent'),
      generation: '0',
      lastFrame: /** @type {any} */ (null),
      staleTimer: /** @type {any} */ (null),
    };
    streams.set(surfaceId, stream);
    diagnostic(surfaceId, 'ROUTER_ATTACHED', 'OK');
    const binding = activeBinding(surfaceId);
    try { port.postMessage({schema:DISPLAY_ACK_SCHEMA,kind:'display_visibility',surfaceId,hidden:!binding?.visible}); } catch {}
    diagnostic(surfaceId, 'VISIBILITY', binding?.visible ? 'VISIBLE' : 'HIDDEN');
    if (typeof port.addEventListener === 'function') {
      port.addEventListener('message', stream.onMessage);
    } else if (typeof port.on === 'function') {
      port.on('message', stream.onMessage);
    } else {
      port.onmessage = stream.onMessage;
    }
    try {
      port.start?.();
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {any} event
   */
  function onWindowMessage(event) {
    if (disposed || !event || typeof event !== 'object') return;
    const ports = Array.isArray(event.ports) ? event.ports : [];
    const data = event.data;
    if (!isValidDisplayNotice(data)) return;
    const origin = typeof event.origin === 'string' && event.origin.length > 0
      ? event.origin
      : typeof target?.location?.origin === 'string'
        ? target.location.origin
        : '';
    if (origin !== expectedOrigin || ports.length !== 1 || !ports[0]) {
      refusedCount += 1;
      for (const p of ports) {
        try {
          p?.close?.();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    attachStream(data.surface_id, ports[0]);
  }

  if (target && typeof target.addEventListener === 'function') {
    target.addEventListener('message', onWindowMessage);
    // [TARGET, unit decision] Release ports retained by the isolated preload
    // only after this main-world listener exists (the tile imports us lazily).
    target.postMessage?.({ type: 'metaviewer:display-ready', schema: 'display_ready/v1' }, expectedOrigin);
  }

  return Object.freeze({
    /**
     * Bind a tile canvas to receive DISPLAY frames and state transitions for `surfaceId`.
     * @param {DisplaySurfaceBinding} spec
     */
    bindSurface(spec) {
      if (
        disposed ||
        !spec ||
        !isValidSurfaceId(spec.surfaceId) ||
        (typeof spec.onFrame !== 'function' && typeof spec.getCanvas !== 'function')
      ) {
        return () => {};
      }
      const token = spec.bindToken ?? Symbol('display-bind');
      const visible = typeof spec.isVisible === 'function' ? Boolean(spec.isVisible()) : true;
      const entry = {
        token,
        getCanvas: spec.getCanvas,
        onFrame: spec.onFrame,
        onState: spec.onState,
        isVisible: spec.isVisible,
        visible,
      };
      let stack = bindingsBySurface.get(spec.surfaceId);
      if (!stack) {
        stack = [];
        bindingsBySurface.set(spec.surfaceId, stack);
      }
      const existingIdx = stack.findIndex((item) => item.token === token);
      if (existingIdx !== -1) stack.splice(existingIdx, 1);
      stack.push(entry);
      requestDisplay(spec.surfaceId);

      const stream = streams.get(spec.surfaceId);
      if (stream) {
        stream.parked = false;
        // A frame delivered before this tile mounted paused the host. Resume
        // explicitly; repainting the retained frame alone cannot restart reads.
        try { stream.port.postMessage({ schema: DISPLAY_ACK_SCHEMA, kind: 'display_visibility', surfaceId: spec.surfaceId, hidden: !visible }); } catch { /* retired port */ }
        if (stream.state !== 'absent' && typeof entry.onState === 'function') {
          try {
            entry.onState({
              surfaceId: spec.surfaceId,
              state: stream.state,
              generation: stream.generation,
            });
          } catch {
            /* ignore */
          }
        }
        if (entry.visible && stream.lastFrame && stream.state !== 'absent') {
          if (deliverBindingFrame(entry, stream.lastFrame)) {
            paintedCount += 1;
          }
        }
      }
      return () => {
        this.unbindSurface(spec.surfaceId, token);
      };
    },

    /**
     * Unbind a tile from `surfaceId`.
     * @param {string} surfaceId
     * @param {unknown} [bindToken]
     */
    unbindSurface(surfaceId, bindToken) {
      const stack = bindingsBySurface.get(surfaceId);
      if (!stack) return;
      if (bindToken === undefined) {
        bindingsBySurface.delete(surfaceId);
        parkStream(surfaceId);
        return;
      }
      const idx = stack.findIndex((item) => item.token === bindToken);
      if (idx !== -1) stack.splice(idx, 1);
      if (stack.length === 0) {
        parkStream(surfaceId);
        bindingsBySurface.delete(surfaceId);
      }
    },

    /**
     * Update tile visibility for `surfaceId`.
     * @param {string} surfaceId
     * @param {boolean} visible
     */
    setSurfaceVisible(surfaceId, visible) {
      const binding = activeBinding(surfaceId);
      if (!binding) return;
      const nextVisible = Boolean(visible);
      if (binding.visible === nextVisible) return;
      binding.visible = nextVisible;
      if (nextVisible) requestDisplay(surfaceId);
      else stopPull(surfaceId);
      const visibilityStream = streams.get(surfaceId);
      try { visibilityStream?.port.postMessage({ schema: DISPLAY_ACK_SCHEMA, kind: 'display_visibility', surfaceId, hidden: !nextVisible }); } catch { /* retired port */ }
      if (nextVisible) {
        const stream = streams.get(surfaceId);
        if (stream && stream.lastFrame && stream.state !== 'absent') {
          if (deliverBindingFrame(binding, stream.lastFrame)) {
            paintedCount += 1;
          }
        }
      }
    },

    /**
     * Direct notice injection helper for deterministic unit tests without a DOM window.
     * @param {unknown} data
     * @param {ReadonlyArray<any>} ports
     * @param {string} [origin]
     */
    receiveNotice(data, ports, origin = expectedOrigin) {
      onWindowMessage({ data, ports, origin });
    },

    /**
     * Diagnostic counters for tests.
     */
    getStats() {
      return Object.freeze({
        paintedCount,
        refusedCount,
        activeStreams: streams.size,
      });
    },

    /**
     * Dispose the router and close all active display ports.
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      if (target && typeof target.removeEventListener === 'function') {
        try {
          target.removeEventListener('message', onWindowMessage);
        } catch {
          /* ignore */
        }
      }
      for (const sid of [...streams.keys()]) {
        closeStream(sid);
      }
      for (const sid of pulls.keys()) stopPull(sid);
      bindingsBySurface.clear();
    },
  });
}

/** @type {ReturnType<typeof installDisplayPortRouter> | null} */
let sharedDisplayRouter = null;

/**
 * Return the singleton main-world display port router, installing it on `window` on first call.
 */
export function getSharedDisplayPortRouter() {
  if (!sharedDisplayRouter) {
    sharedDisplayRouter = installDisplayPortRouter();
  }
  return sharedDisplayRouter;
}
