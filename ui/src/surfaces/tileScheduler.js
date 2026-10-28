/**
 * @fileoverview Fair newest-only tile scheduler for wall surfaces.
 *
 * Plain JavaScript with JSDoc; no authored TypeScript. The lane-P input
 * mappers are re-exported via static import (MVUI26B lane S: synchronous
 * module evaluation, no top-level await) so SurfaceCanvas keeps its closed
 * SFC dependency map (vue + this module).
 * Non-reactive external registry: frame bytes, mailboxes, leases, canvases
 * and warm resources live here, never inside Vue reactivity proxies.
 *
 * Scheduling model: coordinated fair round-robin ticks under a frozen
 * aggregate budget. Submission never draws; each surface holds a single
 * newest-only mailbox slot; a tick consumes the mailbox into a presented
 * slot and fires metadata-only `onPresent`, and the wall draws through
 * `presentHandle` reentrantly during that same coordinated turn.
 *
 * Fold/hide/context-loss stop only the display branch: pending display
 * leases drain with explicit causes while the capture lease stays active
 * and capture witnesses keep advancing. Reopen requests the newest
 * generation above every witness floor; hidden backlog never replays.
 */

/**
 * MVUI25B lane C: lane-P keyboard mapper, re-exported so SurfaceCanvas.vue
 * keeps its closed SFC dependency map (vue plus this module). MVUI26B lane
 * S: static import — module evaluation stays synchronous (no top-level
 * await), so pages and e2e harnesses can call in right after load.
 */
import { mapKeyboardEvent } from '../input/keyMap.js';

/**
 * MVUI25B lane C: lane-P client-to-frame mapper, re-exported (see above).
 */
import { mapClientToFrame } from '../input/frameMap.js';

export { mapClientToFrame, mapKeyboardEvent };

/**
 * @typedef {Object} FrozenTileBudget
 * @property {number} maxDrawsPerTick - Max surface draws per tick (positive safe integer).
 * @property {number} maxUploadBytesPerTick - Max aggregate raw bytes per tick (positive safe integer).
 * @property {number} maxPresentMsPerTick - Max aggregate present time ms per tick (positive finite number).
 * @property {number} maxWarmResourcesPerSurface - Retained warm resources per surface (non-negative safe integer).
 * @property {number} maxDrainSteps - Max bounded drain steps when folding (positive safe integer).
 */

/**
 * @typedef {Object} TilePresentationState
 * @property {boolean} panelOpen - Hosting panel is open in the workspace.
 * @property {boolean} panelSelected - Hosting panel/tab is selected in its stack.
 * @property {boolean} folded - Display branch is folded by the user/workspace.
 * @property {number} width - Content box width in CSS pixels.
 * @property {number} height - Content box height in CSS pixels.
 * @property {number} [x] - Content box X in content-window CSS pixels.
 * @property {number} [y] - Content box Y in content-window CSS pixels.
 * @property {boolean} viewportIntersecting - Surface intersects the visible viewport.
 * @property {boolean} windowPresentationAllowed - Host window permits drawing.
 * @property {boolean} [contextLost] - Underlying canvas context is currently lost.
 */

/**
 * @typedef {Object} TileContentBox
 * @property {number} x - Rounded CSS X coordinate.
 * @property {number} y - Rounded CSS Y coordinate.
 * @property {number} width - Rounded CSS width (> 0).
 * @property {number} height - Rounded CSS height (> 0).
 */

/**
 * @typedef {Object} TileEligibilityResult
 * @property {boolean} eligible - True only when every axis holds and context is live.
 * @property {string[]} reasons - Frozen reason codes; empty when eligible.
 * @property {TileContentBox|null} box - Rounded box when eligible; null otherwise.
 */

/**
 * @typedef {Object} TileFrameSubmission - Verified renderer-side frame (identity + owned bytes).
 * @property {string} surfaceId - Bound tile surface identifier.
 * @property {number} surfaceGeneration - Core-issued surface generation.
 * @property {number} frameGeneration - Monotonic frame generation within the surface generation.
 * @property {string} leaseId - Unique frame lease identifier.
 * @property {number} byteLength - Raw payload byte length.
 * @property {number} width - Frame width in pixels.
 * @property {number} height - Frame height in pixels.
 * @property {Uint8Array} bytes - Owned tightly packed top-left RGB24 bytes.
 * @property {string} principal - Bound endpoint principal.
 * @property {number} epoch - Bound endpoint epoch.
 * @property {string} [sha256] - Verified digest supplied with the frame.
 * @property {number} [submittedAtMs] - Submission timestamp in ms.
 * @property {number} [inputTimestampMs] - Originating input timestamp for input-to-present latency.
 * @property {number} [decodeDurationMs] - Upstream decode duration in ms.
 * @property {number} [estimatedPresentMs] - Estimated presentation cost in ms (explicit positive
 * values win verbatim; otherwise the tile's measured moving average when one exists, else 1).
 * @property {number} [leaseExpiresAtMs] - Optional lease expiration deadline in ms.
 */

/**
 * @typedef {Object} TileLeaseRelease - Single-object lease lifecycle callback payload.
 * @property {string} principal - Bound endpoint principal.
 * @property {number} epoch - Bound endpoint epoch.
 * @property {string} surfaceId - Bound tile surface identifier.
 * @property {number} surfaceGeneration - Surface generation the lease belonged to.
 * @property {number} frameGeneration - Frame generation the lease belonged to.
 * @property {string} leaseId - Released lease identifier.
 * @property {string} reason - Release cause from RELEASE_CAUSES.
 * @property {number} releasedAtMs - Release timestamp in ms.
 */

/**
 * Closed refusal vocabulary: kit scheduler codes plus the drawable
 * eligibility axis codes plus binding/routing codes. Every refusal returned
 * by this module uses one of these values; nothing else is emitted.
 */
export const SCHEDULER_REASONS = Object.freeze({
  INVALID_BUDGET: 'INVALID_BUDGET',
  INVALID_BINDING: 'INVALID_BINDING',
  INVALID_SURFACE_ID: 'INVALID_SURFACE_ID',
  INVALID_GENERATION: 'INVALID_GENERATION',
  SURFACE_NOT_REGISTERED: 'SURFACE_NOT_REGISTERED',
  SURFACE_DESTROYED: 'SURFACE_DESTROYED',
  SURFACE_MISMATCH: 'SURFACE_MISMATCH',
  STALE_SURFACE_GENERATION: 'STALE_SURFACE_GENERATION',
  STALE_FRAME_GENERATION: 'STALE_FRAME_GENERATION',
  STALE_LEASE: 'STALE_LEASE',
  HIDDEN_SURFACE: 'HIDDEN_SURFACE',
  FOLDED_DISPLAY_DISABLED: 'FOLDED_DISPLAY_DISABLED',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  EMPTY_MAILBOX: 'EMPTY_MAILBOX',
  CONTEXT_LOST: 'CONTEXT_LOST',
  DRAIN_LIMIT_EXCEEDED: 'DRAIN_LIMIT_EXCEEDED',
  PORT_REVOKED: 'PORT_REVOKED',
  MISSING_STATE: 'MISSING_STATE',
  PANEL_NOT_SELECTED_OR_OPEN: 'PANEL_NOT_SELECTED_OR_OPEN',
  FOLDED: 'FOLDED',
  NON_POSITIVE_SIZE: 'NON_POSITIVE_SIZE',
  NOT_INTERSECTING_VIEWPORT: 'NOT_INTERSECTING_VIEWPORT',
  WINDOW_PRESENTATION_DISALLOWED: 'WINDOW_PRESENTATION_DISALLOWED'
});

/**
 * Closed lease-release cause vocabulary for `onReleaseLease`.
 */
export const RELEASE_CAUSES = Object.freeze({
  PRESENTED: 'PRESENTED',
  SUPERSEDED: 'SUPERSEDED',
  FOLD_DRAIN: 'FOLD_DRAIN',
  HIDDEN: 'HIDDEN',
  CONTEXT_LOST: 'CONTEXT_LOST',
  SURFACE_DESTROYED: 'SURFACE_DESTROYED',
  REFUSED: 'REFUSED'
});

const ALLOWED_BUDGET_KEYS = new Set([
  'maxDrawsPerTick',
  'maxUploadBytesPerTick',
  'maxPresentMsPerTick',
  'maxWarmResourcesPerSurface',
  'maxDrainSteps'
]);

/**
 * Validates that a scheduler budget carries the exact frozen bounds.
 * Unknown, missing, or out-of-range limits block qualification.
 *
 * @param {FrozenTileBudget|null|undefined} budget
 * @param {{ requireFrozen?: boolean }} [options]
 * @returns {{ ok: boolean, reason?: string, detail?: string, budget?: FrozenTileBudget }}
 */
export function validateFrozenBudget(budget, options = {}) {
  const requireFrozen = options.requireFrozen !== false;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    return { ok: false, reason: SCHEDULER_REASONS.INVALID_BUDGET, detail: 'Budget must be a non-null object' };
  }
  if (requireFrozen && !Object.isFrozen(budget)) {
    return { ok: false, reason: SCHEDULER_REASONS.INVALID_BUDGET, detail: 'Actual budgets must be frozen before runs' };
  }
  for (const key of Object.keys(budget)) {
    if (!ALLOWED_BUDGET_KEYS.has(key)) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BUDGET, detail: `Unknown budget key: ${key}` };
    }
  }
  for (const reqKey of ALLOWED_BUDGET_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(budget, reqKey)) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BUDGET, detail: `Missing required budget key: ${reqKey}` };
    }
  }
  if (!Number.isSafeInteger(budget.maxDrawsPerTick) || budget.maxDrawsPerTick <= 0) {
    return { ok: false, reason: SCHEDULER_REASONS.INVALID_BUDGET, detail: 'maxDrawsPerTick must be a positive safe integer' };
  }
  if (!Number.isSafeInteger(budget.maxUploadBytesPerTick) || budget.maxUploadBytesPerTick <= 0) {
    return { ok: false, reason: SCHEDULER_REASONS.INVALID_BUDGET, detail: 'maxUploadBytesPerTick must be a positive safe integer' };
  }
  if (typeof budget.maxPresentMsPerTick !== 'number' || !Number.isFinite(budget.maxPresentMsPerTick) || budget.maxPresentMsPerTick <= 0) {
    return { ok: false, reason: SCHEDULER_REASONS.INVALID_BUDGET, detail: 'maxPresentMsPerTick must be a positive finite number' };
  }
  if (!Number.isSafeInteger(budget.maxWarmResourcesPerSurface) || budget.maxWarmResourcesPerSurface < 0) {
    return { ok: false, reason: SCHEDULER_REASONS.INVALID_BUDGET, detail: 'maxWarmResourcesPerSurface must be a non-negative safe integer' };
  }
  if (!Number.isSafeInteger(budget.maxDrainSteps) || budget.maxDrainSteps <= 0) {
    return { ok: false, reason: SCHEDULER_REASONS.INVALID_BUDGET, detail: 'maxDrainSteps must be a positive safe integer' };
  }
  return { ok: true, budget };
}

/**
 * Evaluates the five drawable-eligibility axes plus the context veto.
 * Only materialized visible surfaces receive a rounded box; anything else
 * receives `box: null` and is blocked from drawing.
 *
 * @param {TilePresentationState|null|undefined} state
 * @returns {TileEligibilityResult}
 */
export function evaluateTileEligibility(state) {
  if (!state || typeof state !== 'object') {
    return { eligible: false, reasons: [SCHEDULER_REASONS.MISSING_STATE], box: null };
  }
  /** @type {string[]} */
  const reasons = [];
  if (state.panelOpen !== true || state.panelSelected !== true) {
    reasons.push(SCHEDULER_REASONS.PANEL_NOT_SELECTED_OR_OPEN);
  }
  if (state.folded !== false) {
    reasons.push(SCHEDULER_REASONS.FOLDED);
  }
  const hasPositiveSize =
    typeof state.width === 'number' &&
    Number.isFinite(state.width) &&
    Math.round(state.width) > 0 &&
    typeof state.height === 'number' &&
    Number.isFinite(state.height) &&
    Math.round(state.height) > 0;
  if (!hasPositiveSize) {
    reasons.push(SCHEDULER_REASONS.NON_POSITIVE_SIZE);
  }
  if (state.viewportIntersecting !== true) {
    reasons.push(SCHEDULER_REASONS.NOT_INTERSECTING_VIEWPORT);
  }
  if (state.windowPresentationAllowed !== true) {
    reasons.push(SCHEDULER_REASONS.WINDOW_PRESENTATION_DISALLOWED);
  }
  if (state.contextLost === true) {
    reasons.push(SCHEDULER_REASONS.CONTEXT_LOST);
  }
  if (reasons.length > 0) {
    return { eligible: false, reasons, box: null };
  }
  const x = typeof state.x === 'number' && Number.isFinite(state.x) ? Math.round(state.x) : 0;
  const y = typeof state.y === 'number' && Number.isFinite(state.y) ? Math.round(state.y) : 0;
  return {
    eligible: true,
    reasons: [],
    box: Object.freeze({ x, y, width: Math.round(state.width), height: Math.round(state.height) })
  };
}

/** Surface presentation states; unknown input never renders as live. @type {ReadonlyArray<string>} */
export const SURFACE_STATES = Object.freeze(['live', 'connecting', 'lost', 'empty']);

/**
 * @param {unknown} state
 * @returns {string} Known state, falling back to `empty` (never fake-live).
 */
export function normalizeSurfaceState(state) {
  return SURFACE_STATES.includes(/** @type {string} */ (state)) ? /** @type {string} */ (state) : 'empty';
}

/**
 * Closed grammar for a surface-id segment embedded in DOM ids and QA
 * anchors: alnum lead, alnum/`._:-` rest, at most 64 chars. It mirrors the
 * terminal anchor grammar so a hostile host id cannot inject whitespace,
 * slashes, or over-long segments into the `capsule/{id}/slot` family.
 * @type {RegExp}
 */
export const SURFACE_ID_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * Derives the DOM/QA-anchor segment for a host surface id (MVUI24 lane S).
 * Ids that already fit the segment grammar pass through byte-identical, so
 * every existing valid id and anchor is unchanged; anything else maps to a
 * deterministic lead-plus-rest-plus-fnv1a32 segment that always validates.
 * Scheduler calls keep the raw id; only the DOM id/anchor use the segment.
 * @param {unknown} surfaceId Host surface id.
 * @returns {string} Grammar-valid segment, at most 61 chars.
 */
export function surfaceIdSegment(surfaceId) {
  if (typeof surfaceId === 'string' && SURFACE_ID_SEGMENT_RE.test(surfaceId)) return surfaceId;
  const text = typeof surfaceId === 'string' ? surfaceId : '';
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const suffix = (hash >>> 0).toString(16).padStart(8, '0');
  const lead = /^[A-Za-z0-9]/.test(text) ? text[0] : 's';
  const rest = text.slice(1, 52).replace(/[^A-Za-z0-9._:-]/g, '-');
  return `${lead}${rest}-${suffix}`;
}

/**
 * @param {string} surfaceId
 * @returns {string} Stable canvas host DOM id (segment-derived, no raw id).
 */
export function surfaceCanvasDomId(surfaceId) {
  return `mv-surface-canvas-${surfaceIdSegment(surfaceId)}`;
}

/**
 * @param {string} surfaceId
 * @returns {string} Semantic anchor in the `capsule/{id}/slot` family
 * (segment-derived, always three segments).
 */
export function surfaceCanvasAnchor(surfaceId) {
  return `capsule/${surfaceIdSegment(surfaceId)}/slot`;
}

/**
 * @param {{ surfaceId: string, state?: unknown }} input
 * @returns {string} Stable accessible name for the tile host.
 */
export function surfaceCanvasAccessibleName(input) {
  const state = normalizeSurfaceState(input.state);
  if (state === 'live') return `Live surface for ${input.surfaceId}`;
  if (state === 'connecting') return `Surface connecting for ${input.surfaceId}`;
  if (state === 'lost') return `Surface lost for ${input.surfaceId}`;
  return `No surface for ${input.surfaceId}`;
}

/**
 * MVUI25 lane C: DOM id AND `data-semantic-anchor` value for the focusable
 * input canvas of a tile, `tile-<segment>-input-focus`. The segment is the
 * same `surfaceIdSegment` derivation as every other DOM-safe id, so hostile
 * host ids stay whitespace/slash-free here too. Typical ids fit the QA
 * single-segment grammar; adversarial 61-char segments still yield a unique
 * DOM id (the anchor collector skips over-long values, like every other
 * unbounded DOM id in this module).
 * @param {string} surfaceId Host surface id.
 * @returns {string} Input-focus anchor value for the canvas element.
 */
export function surfaceInputFocusAnchor(surfaceId) {
  return `tile-${surfaceIdSegment(surfaceId)}-input-focus`;
}

/**
 * MVUI25 lane C: accessible name for the focusable input canvas, exposed
 * only while the tile is gated in (human control + WRITE mode).
 * @param {{ surfaceId: string }} input
 * @returns {string} Stable accessible name for the input canvas.
 */
export function surfaceInputAccessibleName(input) {
  return `Capsule input for ${input.surfaceId}`;
}

/**
 * MVUI30 lane L: DOM id AND `data-semantic-anchor` value for the Lost badge
 * of a frozen tile, `tile-<segment>-lost-badge`. The segment is the same
 * `surfaceIdSegment` derivation as every other DOM-safe id, so hostile host
 * ids stay whitespace/slash-free here too.
 * @param {string} surfaceId Host surface id.
 * @returns {string} Lost-badge anchor value for the tile.
 */
export function surfaceLostBadgeAnchor(surfaceId) {
  return `tile-${surfaceIdSegment(surfaceId)}-lost-badge`;
}

/**
 * MVUI30 lane L: accessible name for the frozen-tile Lost badge.
 * @returns {string} Stable accessible name for the Lost badge.
 */
export function surfaceLostBadgeAccessibleName() {
  return 'Capsule lost: showing the last frame';
}

/**
 * MVUI30 lane L: canvas state for one projection row. A `lost` backend
 * lifecycle maps to the distinct `lost` canvas state (frozen last frame);
 * every other lifecycle keeps the attachment mapping (`live` only while the
 * binding is live, else `connecting`). Destroyed, detached and unknown rows
 * never yield `lost`, so they can never render the frozen view. App.vue
 * mirrors this truth table locally (its import surface is pinned for the
 * stub harnesses, so the helper cannot be imported there); keep the two in
 * sync.
 * @param {unknown} row Projection surface row.
 * @returns {string} `lost`, `live`, or `connecting`.
 */
export function canvasStateForRow(row) {
  if (row !== null && typeof row === 'object'
    && /** @type {{ backendLifecycle?: unknown }} */ (row).backendLifecycle === 'lost') {
    return 'lost';
  }
  const attachment = row !== null && typeof row === 'object'
    ? /** @type {{ attachmentState?: unknown }} */ (row).attachmentState : undefined;
  return attachment === 'live' ? 'live' : 'connecting';
}

/**
 * Shortens a digest for the mono witness strip (head...tail).
 * @param {unknown} value
 * @param {number} [head=8]
 * @param {number} [tail=6]
 * @returns {string} '' when no digest was provided.
 */
export function shortenDigest(value, head = 8, tail = 6) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) return '';
  const cleanHead = Number.isFinite(head) && head > 0 ? Math.floor(head) : 8;
  const cleanTail = Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : 6;
  if (text.length <= cleanHead + cleanTail + 1) return text;
  return `${text.slice(0, cleanHead)}…${text.slice(text.length - cleanTail)}`;
}

/**
 * Resolves the visible witness-strip fields from raw props. Display-only.
 * @param {{ frame?: unknown, generation?: unknown, digest?: unknown, readOnly?: unknown, readOnlyLabel?: unknown }} [input={}]
 * @returns {{ frameText: string, generationText: string, digestText: string, readOnlyText: string }}
 */
export function formatFrameStrip(input = {}) {
  const text = (/** @type {unknown} */ value) => (typeof value === 'string' ? value.trim() : '');
  const generationText =
    typeof input.generation === 'number' && Number.isFinite(input.generation)
      ? String(Math.trunc(input.generation))
      : text(input.generation);
  const label = text(input.readOnlyLabel);
  return {
    frameText: text(input.frame),
    generationText,
    digestText: shortenDigest(input.digest),
    readOnlyText: input.readOnly === false ? '' : (label.length > 0 ? label : 'READ-ONLY ISOLATED EXECUTION')
  };
}

/**
 * Validates an immutable surface identifier: no empty strings, no bare numbers.
 * @param {unknown} surfaceId
 * @returns {boolean}
 */
function isValidSurfaceId(surfaceId) {
  if (typeof surfaceId !== 'string' || surfaceId.trim().length === 0) {
    return false;
  }
  if (/^\d+$/.test(surfaceId.trim())) {
    return false;
  }
  return true;
}

/**
 * True on little-endian hosts (every supported target): packed RGBA bytes
 * [r, g, b, 255] equal the Uint32 word 0xFF000000 | (b << 16) | (g << 8) | r.
 * Evaluated once; any other host keeps the reference byte loop.
 * @type {boolean}
 */
const IS_LITTLE_ENDIAN = (() => {
  const probe = new Uint16Array([0x00ff]);
  return new Uint8Array(probe.buffer)[0] === 0xff;
})();

/**
 * Lower clamp for a measured present estimate: a tile never accounts below
 * the historical 1 ms default, so admission only grows stricter as real
 * cost is observed, never looser.
 * @type {number}
 */
const MIN_MEASURED_ESTIMATE_MS = 1;

/**
 * Byte-exact RGB24 to RGBA conversion into a caller-provided row-major
 * buffer. Pixel (x, y) maps to the same (x, y); alpha is always opaque.
 * This is the reference loop (the historical per-present behaviour); the
 * word path in convertRgb24ToRgba stays bit-identical to it.
 * @param {Uint8Array} bytes Packed RGB24 bytes.
 * @param {Uint8ClampedArray|Uint8Array|Array<number>} out RGBA output buffer.
 * @param {number} wholePixels Pixels to convert, bounded by the input.
 * @returns {void}
 */
function convertRgb24ToRgbaBytes(bytes, out, wholePixels) {
  for (let px = 0, src = 0, dst = 0; px < wholePixels; px += 1, src += 3, dst += 4) {
    out[dst] = bytes[src];
    out[dst + 1] = bytes[src + 1];
    out[dst + 2] = bytes[src + 2];
    out[dst + 3] = 255;
  }
}

/**
 * Converts tightly packed top-left RGB24 bytes to row-major RGBA, covering
 * every pixel of a width*height frame; alpha is always opaque. On
 * little-endian hosts with a 4-byte-aligned ArrayBuffer-backed output this
 * stores one 32-bit word per pixel, otherwise it takes the reference byte
 * loop. Both paths are bit-identical.
 * @param {Uint8Array} bytes Packed RGB24 bytes.
 * @param {Uint8ClampedArray|Uint8Array|Array<number>} out RGBA output buffer.
 * @param {number} width Frame width in pixels.
 * @param {number} height Frame height in pixels.
 * @returns {void}
 */
export function convertRgb24ToRgba(bytes, out, width, height) {
  const pixelCount = width * height;
  const wholePixels = Math.min(pixelCount, Math.floor(bytes.length / 3));
  const candidate = /** @type {{ buffer?: unknown, byteOffset?: unknown, byteLength?: unknown }} */ (out);
  const backing = candidate !== null && typeof candidate === 'object' ? candidate.buffer : null;
  const byteOffset = candidate !== null && typeof candidate === 'object' ? candidate.byteOffset : null;
  const byteLength = candidate !== null && typeof candidate === 'object' ? candidate.byteLength : null;
  const aligned = ArrayBuffer.isView(out)
    && !(out instanceof DataView)
    && typeof byteOffset === 'number' && byteOffset % 4 === 0
    && byteLength === pixelCount * 4
    && (backing instanceof ArrayBuffer
      || (typeof SharedArrayBuffer === 'function' && backing instanceof SharedArrayBuffer));
  if (IS_LITTLE_ENDIAN && wholePixels === pixelCount && aligned) {
    const words = new Uint32Array(
      /** @type {ArrayBuffer|SharedArrayBuffer} */ (backing),
      /** @type {number} */ (byteOffset),
      pixelCount,
    );
    for (let px = 0, src = 0; px < pixelCount; px += 1, src += 3) {
      words[px] = 0xFF000000 | (bytes[src + 2] << 16) | (bytes[src + 1] << 8) | bytes[src];
    }
    return;
  }
  convertRgb24ToRgbaBytes(bytes, out, wholePixels);
}

/**
 * True when the slot holds an ImageData-like of exactly these dimensions
 * with a full RGBA backing store worth overwriting in place.
 * @param {unknown} slot Tile scratch slot (or null when none).
 * @param {number} width Frame width in pixels.
 * @param {number} height Frame height in pixels.
 * @returns {boolean}
 */
function isReusableScratch(slot, width, height) {
  if (slot === null || typeof slot !== 'object') return false;
  const holder = /** @type {Record<string, unknown>} */ (slot);
  if (holder.width !== width || holder.height !== height) return false;
  const image = holder.image;
  if (image === null || typeof image !== 'object') return false;
  const frame = /** @type {Record<string, unknown>} */ (image);
  if (frame.width !== width || frame.height !== height) return false;
  const data = frame.data;
  if (data === null || (typeof data !== 'object' && typeof data !== 'function')) return false;
  return /** @type {{ length?: unknown }} */ (data).length === width * height * 4;
}

/**
 * Folds one measured convert-plus-upload sample into the tile's moving
 * average. Non-positive samples (a frozen test clock) and non-finite clock
 * faults carry no signal and leave the average untouched, so frozen-clock
 * suites keep the historical 1 ms default exactly.
 * @param {{ measuredPresentMs?: unknown }} entry Tile entry.
 * @param {unknown} sampleMs Measured milliseconds for one successful draw.
 * @returns {void}
 */
function notePresentSample(entry, sampleMs) {
  if (typeof sampleMs !== 'number' || !Number.isFinite(sampleMs) || sampleMs <= 0) return;
  const prev = entry.measuredPresentMs;
  entry.measuredPresentMs = typeof prev === 'number' && Number.isFinite(prev) && prev > 0
    ? prev + (sampleMs - prev) / 2
    : sampleMs;
}

/**
 * Converts tightly packed top-left RGB24 bytes to RGBA and uploads them to
 * a canvas 2D context. No flip, rotation, or channel reorder: pixel (x, y)
 * maps to the same (x, y). Alpha is always opaque.
 *
 * MVUI31: when the tile entry carries a same-dimension scratch ImageData it
 * is reused (fully overwritten on every present); any dimension change,
 * shape mismatch, or unsuitable scratch reallocates instead. Short or
 * over-long inputs always take a fresh ImageData, preserving the historical
 * prefix semantics.
 *
 * @param {any} canvas - Canvas element (or test double with getContext).
 * @param {Uint8Array} bytes - Packed RGB24 bytes, length width * height * 3.
 * @param {number} width - Frame width in pixels.
 * @param {number} height - Frame height in pixels.
 * @param {{ presentScratch?: unknown }|null} [entry] - Tile entry holding the reusable scratch slot.
 * @returns {{ ok: true } | { ok: false, reason: string, detail: string }}
 */
function drawRgb24ToCanvas(canvas, bytes, width, height, entry = null) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'Canvas handle is not drawable' };
  }
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.putImageData !== 'function' || typeof ctx.createImageData !== 'function') {
    return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'Canvas 2d context unavailable' };
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const exactBytes = bytes.length === width * height * 3;
  const slot = entry !== null && typeof entry === 'object' ? entry.presentScratch : null;
  /** @type {any} */
  let image = null;
  if (exactBytes && isReusableScratch(slot, width, height)) {
    image = /** @type {{ image: unknown }} */ (slot).image;
  } else {
    image = ctx.createImageData(width, height);
    if (entry !== null && typeof entry === 'object' && exactBytes) {
      entry.presentScratch = { width, height, image };
    }
  }
  convertRgb24ToRgba(bytes, image.data, width, height);
  ctx.putImageData(image, 0, 0);
  return { ok: true };
}

/**
 * Eviction policy for retired scheduler entries (MVUI24 lane S, NEW-02): an
 * entry may go only when its frame stream fully retired AND no canvas is
 * attached. A live or grace-held stream always keeps the entry, so the
 * keepStream remount gap and the retained-frame/late-attach path never lose
 * theirs; an attached canvas keeps it too, so a bound tile in a port-close
 * race never loses its paint.
 * @param {{ streamRetired?: unknown, canvasAttached?: unknown }} [input={}]
 * @returns {boolean}
 */
export function shouldEvictSchedulerEntry(input = {}) {
  if (input === null || typeof input !== 'object') return false;
  return input.streamRetired === true && input.canvasAttached !== true;
}

/**
 * Creates a non-reactive coordinated fair tile scheduler instance.
 *
 * @param {Object} options
 * @param {FrozenTileBudget} options.budget - Frozen budget limits (exact keys, no defaults).
 * @param {() => number} [options.clock] - Monotonic clock source returning milliseconds.
 * @param {(record: Object) => unknown} [options.onPresent] - Metadata-only present callback
 *   receiving `{ surfaceId, handle, frameGeneration, box }`; the wall draws via
 *   `presentHandle` reentrantly during the same turn. Only a successful draw
 *   counts as presented; absent callbacks use `presentHandle` directly.
 * @param {(release: TileLeaseRelease) => void} [options.onReleaseLease] - Single-object
 *   callback invoked exactly once per retired display lease.
 * @param {(req: Object) => void} [options.onRequestNewestGeneration] - Callback invoked on
 *   unfold/restore with `{ surfaceId, surfaceGeneration, epoch, afterFrameGeneration }`.
 */
export function createTileScheduler(options) {
  if (!options || typeof options !== 'object') {
    throw new Error(`${SCHEDULER_REASONS.INVALID_BUDGET}: Scheduler options are required`);
  }
  const opts = /** @type {any} */ (options);
  const budgetValidation = validateFrozenBudget(opts.budget, { requireFrozen: true });
  if (!budgetValidation.ok || budgetValidation.budget === undefined) {
    throw new Error(`${budgetValidation.reason}: ${budgetValidation.detail}`);
  }
  const budget = budgetValidation.budget;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
  const onPresent = typeof opts.onPresent === 'function' ? opts.onPresent : null;
  const onReleaseLease = typeof opts.onReleaseLease === 'function' ? opts.onReleaseLease : null;
  const onRequestNewestGeneration =
    typeof opts.onRequestNewestGeneration === 'function' ? opts.onRequestNewestGeneration : null;

  /** @type {Map<string, any>} */
  const surfaces = new Map();
  /** @type {Set<string>} Destroyed ids stay tombstoned: revival refuses. */
  const tombstones = new Set();
  /** @type {string[]} */
  const surfaceOrder = [];
  /** @type {Map<string, string>} Live present handle -> owning surface. */
  const liveByHandle = new Map();
  /** @type {Map<string, string>} Newest retired handle -> owning surface. */
  const retiredByHandle = new Map();
  /** @type {Set<() => void>} Metadata-only presentation observers. */
  const presentationListeners = new Set();
  let fairCursor = 0;
  let insideTurn = false;
  let handleSeq = 0;

  /** @param {unknown} surfaceId */
  function missingSurfaceReason(surfaceId) {
    return tombstones.has(/** @type {string} */ (surfaceId))
      ? SCHEDULER_REASONS.SURFACE_DESTROYED : SCHEDULER_REASONS.SURFACE_NOT_REGISTERED;
  }

  /**
   * @param {any} entry
   * @param {any} leaseId
   * @param {any} frameGeneration
   * @param {string} cause
   */
  function emitLeaseRelease(entry, leaseId, frameGeneration, cause) {
    if (onReleaseLease && typeof leaseId === 'string' && leaseId.length > 0) {
      try { onReleaseLease({
        principal: entry.principal,
        epoch: entry.epoch,
        surfaceId: entry.surfaceId,
        surfaceGeneration: entry.surfaceGeneration,
        frameGeneration,
        leaseId,
        reason: cause,
        releasedAtMs: clock()
      }); } catch { /* An observer failure cannot restore retired ownership. */ }
    }
  }

  /**
   * Retires a present handle: it can never draw again, and a later attempt
   * fails closed as stale. One retired slot per surface keeps the map bounded.
   * @param {any} entry
   * @param {string} handle
   */
  function retireHandle(entry, handle) {
    liveByHandle.delete(handle);
    if (typeof entry.lastRetiredHandle === 'string') {
      retiredByHandle.delete(entry.lastRetiredHandle);
    }
    entry.lastRetiredHandle = handle;
    retiredByHandle.set(handle, entry.surfaceId);
  }

  /**
   * Evicts oldest warm resources down to `limit`, invoking each native
   * disposer exactly once. Accounting-only deletion would leak natives.
   * Any eviction also drops the retained repaint frame (MVUI22), the
   * surface's largest idle holding under memory pressure.
   * @param {any} entry
   * @param {number} limit
   */
  function trimWarmResources(entry, limit) {
    let evicted = 0;
    while (entry.warmResources.size > limit) {
      const oldestKey = entry.warmResources.keys().next().value;
      if (oldestKey === undefined) break;
      const removed = entry.warmResources.get(oldestKey);
      entry.warmResources.delete(oldestKey);
      entry.metrics.warmResourceBytes = Math.max(0, entry.metrics.warmResourceBytes - (removed?.bytes || 0));
      entry.metrics.reclaimedWarmResources += 1;
      evicted += 1;
      if (removed && typeof removed.dispose === 'function') {
        try { removed.dispose(); } catch { entry.metrics.disposerFaults += 1; }
      }
    }
    if (evicted > 0) {
      entry.lastPaint = null;
      entry.pendingPaint = null;
    }
  }

  /**
   * Releases every display-owned holding of an entry (mailbox + presented
   * slot + undrawn retain + warm resources) exactly once under one cause,
   * keeping the capture lease untouched. Used by fold/hide/context-loss/
   * destroy paths; hidden backlog never replays.
   * @param {any} entry
   * @param {string} cause
   */
  function drainDisplayHoldings(entry, cause) {
    entry.pendingPaint = null;
    if (entry.mailbox !== null) {
      entry.minAdmissibleFrameGen = Math.max(entry.minAdmissibleFrameGen, entry.mailbox.frameGeneration);
      const slot = entry.mailbox;
      entry.mailbox = null;
      emitLeaseRelease(entry, slot.leaseId, slot.frameGeneration, cause);
    }
    if (entry.presented !== null) {
      entry.minAdmissibleFrameGen = Math.max(entry.minAdmissibleFrameGen, entry.presented.frameGeneration);
      const slot = entry.presented;
      entry.presented = null;
      retireHandle(entry, slot.handle);
      emitLeaseRelease(entry, slot.leaseId, slot.frameGeneration, cause);
    }
  }

  /**
   * Registers a surface with its immutable identity, binding, and capture lease.
   * Epoch and principal are explicit: no defaults are inherited.
   * @param {any} config
   */
  function registerSurface(config) {
    if (!config || !isValidSurfaceId(config.surfaceId)) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_SURFACE_ID };
    }
    if (tombstones.has(config.surfaceId)) {
      return { ok: false, reason: SCHEDULER_REASONS.SURFACE_DESTROYED };
    }
    if (!Number.isSafeInteger(config.surfaceGeneration) || config.surfaceGeneration <= 0) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_GENERATION };
    }
    if (typeof config.principal !== 'string' || config.principal.length === 0) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'principal is required' };
    }
    if (!Number.isSafeInteger(config.epoch) || config.epoch <= 0) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'epoch is required' };
    }
    const captureLeaseId = typeof config.captureLeaseId === 'string' && config.captureLeaseId.length > 0
      ? config.captureLeaseId
      : null;
    if (config.captureLeaseActive === true && captureLeaseId === null) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'Active capture lease needs an id' };
    }

    const initialState = {
      panelOpen: true,
      panelSelected: true,
      folded: false,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      viewportIntersecting: false,
      windowPresentationAllowed: true,
      contextLost: false,
      ...(config.state && typeof config.state === 'object' ? config.state : {})
    };

    const existing = surfaces.get(config.surfaceId);
    let keptPendingPaint = null;
    if (existing && !existing.destroyed) {
      if (config.surfaceGeneration < existing.surfaceGeneration) {
        return { ok: false, reason: SCHEDULER_REASONS.STALE_SURFACE_GENERATION };
      }
      if (config.principal !== existing.principal) {
        return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'principal cannot change' };
      }
      if (config.epoch < existing.epoch) {
        return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'epoch cannot regress' };
      }
      if (config.surfaceGeneration === existing.surfaceGeneration && config.epoch === existing.epoch) {
        keptPendingPaint = existing.pendingPaint;
      }
      drainDisplayHoldings(existing, RELEASE_CAUSES.SUPERSEDED);
      trimWarmResources(existing, 0);
    }

    const sameLifetime = existing && config.surfaceGeneration === existing.surfaceGeneration && config.epoch === existing.epoch;
    if (existing?.lastRetiredHandle && !sameLifetime) retiredByHandle.delete(existing.lastRetiredHandle);
    const entry = {
      surfaceId: config.surfaceId,
      surfaceGeneration: config.surfaceGeneration,
      epoch: config.epoch,
      principal: config.principal,
      captureLeaseId,
      captureLeaseActive: config.captureLeaseActive === true,
      destroyed: false,
      state: initialState,
      mailbox: null,
      presented: null,
      canvas: sameLifetime ? existing.canvas : null,
      canvasToken: sameLifetime ? existing.canvasToken : null,
      lastDetachedCanvas: sameLifetime ? existing.lastDetachedCanvas : null,
      lastPaint: sameLifetime ? existing.lastPaint : null,
      pendingPaint: sameLifetime ? keptPendingPaint : null,
      presentScratch: null,
      measuredPresentMs: sameLifetime ? existing.measuredPresentMs : null,
      lastRetiredHandle: sameLifetime ? existing.lastRetiredHandle : null,
      lastPresentedFrameGen: sameLifetime ? existing.lastPresentedFrameGen : 0,
      minAdmissibleFrameGen: sameLifetime ? existing.minAdmissibleFrameGen : 0,
      lastCaptureGeneration: sameLifetime ? existing.lastCaptureGeneration : 0,
      lastPresentedHandle: sameLifetime ? existing.lastPresentedHandle : '',
      lastPresentedDigest: sameLifetime ? existing.lastPresentedDigest : '',
      lastPresentedWidth: sameLifetime ? existing.lastPresentedWidth : 0,
      lastPresentedHeight: sameLifetime ? existing.lastPresentedHeight : 0,
      warmResources: new Map(),
      metrics: {
        captureCount: 0,
        decodeCount: 0,
        presentCount: 0,
        drawSubmissions: 0,
        uploadSubmissions: 0,
        bytesUploadedTotal: 0,
        convertedBytesTotal: 0,
        mailboxReplacements: 0,
        rejectedHiddenDraws: 0,
        rejectedStaleFrames: 0,
        reclaimedWarmResources: 0,
        disposerFaults: 0,
        warmResourceBytes: 0,
        lastPresentAgeMs: null,
        inputToPresentMs: null,
        lastCaptureTimestampMs: null,
        lastPresentTimestampMs: null,
        timingScopes: {
          submissionMs: null,
          parserConsumptionMs: null,
          presentationMs: null,
          verifiedDomainEffectMs: null
        }
      }
    };

    surfaces.set(config.surfaceId, entry);
    if (!surfaceOrder.includes(config.surfaceId)) {
      surfaceOrder.push(config.surfaceId);
    }
    return { ok: true, surfaceId: entry.surfaceId, surfaceGeneration: entry.surfaceGeneration, epoch: entry.epoch };
  }

  /**
   * Records upstream capture progress. Capture continues while folded/hidden.
   * @param {any} witness
   */
  function recordCaptureWitness(witness) {
    const entry = witness ? surfaces.get(witness.surfaceId) : undefined;
    if (!entry) {
      return { ok: false, reason: missingSurfaceReason(witness?.surfaceId) };
    }
    if (entry.destroyed) {
      return { ok: false, reason: SCHEDULER_REASONS.SURFACE_DESTROYED };
    }
    if (witness.surfaceGeneration !== entry.surfaceGeneration) {
      return { ok: false, reason: SCHEDULER_REASONS.STALE_SURFACE_GENERATION };
    }
    if (!Number.isSafeInteger(witness.captureGeneration) || witness.captureGeneration <= entry.lastCaptureGeneration) {
      return { ok: false, reason: SCHEDULER_REASONS.STALE_FRAME_GENERATION };
    }
    entry.lastCaptureGeneration = witness.captureGeneration;
    entry.metrics.captureCount += 1;
    entry.metrics.lastCaptureTimestampMs = typeof witness.timestampMs === 'number' ? witness.timestampMs : clock();
    if (entry.state.folded) {
      entry.minAdmissibleFrameGen = Math.max(entry.minAdmissibleFrameGen, witness.captureGeneration);
    }
    return { ok: true, captureCount: entry.metrics.captureCount, lastCaptureGeneration: entry.lastCaptureGeneration };
  }

  /**
   * Admission estimate for a frame without a caller-supplied cost: the
   * tile's measured convert-plus-upload moving average when one exists,
   * clamped to the tick budget so an over-budget tile still presents one
   * frame per tick, and never below the historical 1 ms default.
   * @param {{ measuredPresentMs?: unknown }} entry Tile entry.
   * @returns {number}
   */
  function defaultPresentEstimateMs(entry) {
    const avg = entry.measuredPresentMs;
    if (typeof avg !== 'number' || !Number.isFinite(avg) || avg <= 0) return MIN_MEASURED_ESTIMATE_MS;
    return Math.min(Math.max(avg, MIN_MEASURED_ESTIMATE_MS), budget.maxPresentMsPerTick);
  }

  /**
   * Submits a candidate frame into the single-slot newest mailbox. Never draws.
   * @param {TileFrameSubmission} frame
   */
  function submitFrame(frame) {
    if (!frame || typeof frame !== 'object' || !isValidSurfaceId(frame.surfaceId)) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_SURFACE_ID };
    }
    const entry = surfaces.get(frame.surfaceId);
    if (!entry) {
      return { ok: false, reason: missingSurfaceReason(frame.surfaceId) };
    }
    if (entry.destroyed) {
      return { ok: false, reason: SCHEDULER_REASONS.SURFACE_DESTROYED };
    }
    const leaseId = typeof frame.leaseId === 'string' && frame.leaseId.trim().length > 0 ? frame.leaseId : null;
    const frameGen = frame.frameGeneration;

    if (!Number.isSafeInteger(frame.surfaceGeneration) || frame.surfaceGeneration !== entry.surfaceGeneration) {
      entry.metrics.rejectedStaleFrames += 1;
      emitLeaseRelease(entry, leaseId, frameGen, RELEASE_CAUSES.REFUSED);
      return { ok: false, reason: SCHEDULER_REASONS.STALE_SURFACE_GENERATION };
    }
    if (frame.principal !== entry.principal || frame.epoch !== entry.epoch) {
      entry.metrics.rejectedStaleFrames += 1;
      emitLeaseRelease(entry, leaseId, frameGen, RELEASE_CAUSES.REFUSED);
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'principal/epoch mismatch' };
    }
    if (entry.state.folded === true) {
      entry.metrics.rejectedHiddenDraws += 1;
      if (Number.isSafeInteger(frameGen) && frameGen > entry.minAdmissibleFrameGen) {
        entry.minAdmissibleFrameGen = frameGen;
      }
      emitLeaseRelease(entry, leaseId, frameGen, RELEASE_CAUSES.REFUSED);
      return { ok: false, reason: SCHEDULER_REASONS.FOLDED_DISPLAY_DISABLED };
    }
    const currentFloor = Math.max(
      entry.lastPresentedFrameGen,
      entry.minAdmissibleFrameGen,
      entry.mailbox ? entry.mailbox.frameGeneration : 0,
      entry.presented ? entry.presented.frameGeneration : 0
    );
    if (!Number.isSafeInteger(frameGen) || frameGen <= currentFloor) {
      entry.metrics.rejectedStaleFrames += 1;
      emitLeaseRelease(entry, leaseId, frameGen, RELEASE_CAUSES.REFUSED);
      return { ok: false, reason: SCHEDULER_REASONS.STALE_FRAME_GENERATION };
    }
    const now = clock();
    if (!leaseId || (typeof frame.leaseExpiresAtMs === 'number' && frame.leaseExpiresAtMs <= now)) {
      entry.metrics.rejectedStaleFrames += 1;
      emitLeaseRelease(entry, leaseId, frameGen, RELEASE_CAUSES.REFUSED);
      return { ok: false, reason: SCHEDULER_REASONS.STALE_LEASE };
    }
    if (
      !Number.isSafeInteger(frame.width) || frame.width <= 0 ||
      !Number.isSafeInteger(frame.height) || frame.height <= 0 ||
      !(frame.bytes instanceof Uint8Array) ||
      !Number.isSafeInteger(frame.byteLength) ||
      frame.byteLength !== frame.bytes.length ||
      frame.byteLength !== frame.width * frame.height * 3
    ) {
      emitLeaseRelease(entry, leaseId, frameGen, RELEASE_CAUSES.REFUSED);
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'Packed rgb24 shape mismatch' };
    }
    if (frame.byteLength > budget.maxUploadBytesPerTick) {
      emitLeaseRelease(entry, leaseId, frameGen, RELEASE_CAUSES.REFUSED);
      return { ok: false, reason: SCHEDULER_REASONS.BUDGET_EXHAUSTED };
    }
    const eligibility = evaluateTileEligibility(entry.state);
    if (!eligibility.eligible) {
      entry.metrics.rejectedHiddenDraws += 1;
      const lost = entry.state.contextLost === true;
      emitLeaseRelease(entry, leaseId, frameGen, lost ? RELEASE_CAUSES.CONTEXT_LOST : RELEASE_CAUSES.HIDDEN);
      return {
        ok: false,
        reason: lost ? SCHEDULER_REASONS.CONTEXT_LOST : SCHEDULER_REASONS.HIDDEN_SURFACE,
        disqualifiers: eligibility.reasons
      };
    }

    let replacedFrameGeneration = null;
    if (entry.mailbox !== null) {
      replacedFrameGeneration = entry.mailbox.frameGeneration;
      entry.metrics.mailboxReplacements += 1;
      const previous = entry.mailbox;
      entry.mailbox = null;
      emitLeaseRelease(entry, previous.leaseId, previous.frameGeneration, RELEASE_CAUSES.SUPERSEDED);
    }
    entry.metrics.decodeCount += 1;
    entry.mailbox = {
      surfaceId: entry.surfaceId,
      surfaceGeneration: frame.surfaceGeneration,
      frameGeneration: frameGen,
      leaseId,
      leaseExpiresAtMs: typeof frame.leaseExpiresAtMs === 'number' ? frame.leaseExpiresAtMs : null,
      byteLength: frame.byteLength,
      width: frame.width,
      height: frame.height,
      bytes: frame.bytes,
      sha256: typeof frame.sha256 === 'string' ? frame.sha256 : '',
      submittedAtMs: typeof frame.submittedAtMs === 'number' ? frame.submittedAtMs : now,
      inputTimestampMs: typeof frame.inputTimestampMs === 'number' ? frame.inputTimestampMs : null,
      decodeDurationMs: typeof frame.decodeDurationMs === 'number' ? frame.decodeDurationMs : 0,
      estimatedPresentMs:
        typeof frame.estimatedPresentMs === 'number' && frame.estimatedPresentMs > 0
          ? frame.estimatedPresentMs
          : defaultPresentEstimateMs(entry)
    };
    return { ok: true, queuedFrameGeneration: frameGen, replacedFrameGeneration };
  }

  /**
   * Folds a surface: display branch drains with FOLD_DRAIN, warm resources
   * trim to budget, capture lease stays active.
   * @param {unknown} surfaceId
   * @param {{ drainSteps?: number }} [foldOptions]
   */
  function foldSurface(surfaceId, foldOptions = {}) {
    const entry = surfaces.get(/** @type {string} */ (surfaceId));
    if (!entry) {
      return { ok: false, reason: missingSurfaceReason(surfaceId) };
    }
    if (entry.destroyed) {
      return { ok: false, reason: SCHEDULER_REASONS.SURFACE_DESTROYED };
    }
    const drainSteps = foldOptions.drainSteps === undefined ? 1 : foldOptions.drainSteps;
    if (!Number.isSafeInteger(drainSteps) || drainSteps < 0 || drainSteps > budget.maxDrainSteps) {
      return { ok: false, reason: SCHEDULER_REASONS.DRAIN_LIMIT_EXCEEDED };
    }
    entry.state = { ...entry.state, folded: true };
    const drainedFrameGeneration = entry.mailbox !== null
      ? entry.mailbox.frameGeneration
      : (entry.presented !== null ? entry.presented.frameGeneration : null);
    drainDisplayHoldings(entry, RELEASE_CAUSES.FOLD_DRAIN);
    trimWarmResources(entry, budget.maxWarmResourcesPerSurface);
    return {
      ok: true,
      folded: true,
      drainedFrameGeneration,
      captureLeaseRetained: entry.captureLeaseActive,
      warmResourceCount: entry.warmResources.size
    };
  }

  /**
   * Unfolds a surface and requests the newest generation above every witness
   * floor. Zero stale frames replay.
   * @param {unknown} surfaceId
   * @param {{ geometry?: { x?: number, y?: number, width?: number, height?: number } }} [unfoldOptions]
   */
  function unfoldSurface(surfaceId, unfoldOptions = {}) {
    const entry = surfaces.get(/** @type {string} */ (surfaceId));
    if (!entry) {
      return { ok: false, reason: missingSurfaceReason(surfaceId) };
    }
    if (entry.destroyed) {
      return { ok: false, reason: SCHEDULER_REASONS.SURFACE_DESTROYED };
    }
    const nextGeometry = unfoldOptions.geometry && typeof unfoldOptions.geometry === 'object'
      ? {
          x: typeof unfoldOptions.geometry.x === 'number' ? unfoldOptions.geometry.x : entry.state.x,
          y: typeof unfoldOptions.geometry.y === 'number' ? unfoldOptions.geometry.y : entry.state.y,
          width: typeof unfoldOptions.geometry.width === 'number' ? unfoldOptions.geometry.width : entry.state.width,
          height: typeof unfoldOptions.geometry.height === 'number' ? unfoldOptions.geometry.height : entry.state.height
        }
      : {};
    entry.state = { ...entry.state, ...nextGeometry, folded: false };
    const afterFrameGeneration = Math.max(
      entry.lastPresentedFrameGen,
      entry.minAdmissibleFrameGen,
      entry.lastCaptureGeneration
    );
    entry.minAdmissibleFrameGen = afterFrameGeneration;
    if (onRequestNewestGeneration) {
      onRequestNewestGeneration({
        surfaceId: entry.surfaceId,
        surfaceGeneration: entry.surfaceGeneration,
        epoch: entry.epoch,
        afterFrameGeneration
      });
    }
    const eligibility = evaluateTileEligibility(entry.state);
    return { ok: true, eligible: eligibility.eligible, box: eligibility.box, requestedAfterFrameGeneration: afterFrameGeneration };
  }

  /**
   * Updates presentation-only state. Fold and context transitions have
   * dedicated lifecycle methods and are refused here so they cannot bypass
   * drain accounting.
   * @param {unknown} surfaceId
   * @param {Record<string, unknown>} patch
   */
  function updateSurfaceState(surfaceId, patch) {
    const entry = surfaces.get(/** @type {string} */ (surfaceId));
    if (!entry) {
      return { ok: false, reason: missingSurfaceReason(surfaceId) };
    }
    if (entry.destroyed) {
      return { ok: false, reason: SCHEDULER_REASONS.SURFACE_DESTROYED };
    }
    if (!patch || typeof patch !== 'object') {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'State patch must be an object' };
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'folded') || Object.prototype.hasOwnProperty.call(patch, 'contextLost')) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'Use fold/context lifecycle methods' };
    }
    entry.state = { ...entry.state, ...patch };
    const eligibility = evaluateTileEligibility(entry.state);
    if (!eligibility.eligible) {
      drainDisplayHoldings(entry, RELEASE_CAUSES.HIDDEN);
    }
    return { ok: true, eligible: eligibility.eligible, box: eligibility.box, captureLeaseRetained: entry.captureLeaseActive };
  }

  /**
   * Attempts an immediate single-surface present under all guards.
   * @param {unknown} surfaceId
   */
  function presentSurfaceNow(surfaceId) {
    const entry = surfaces.get(/** @type {string} */ (surfaceId));
    if (!entry) {
      return { ok: false, reason: missingSurfaceReason(surfaceId) };
    }
    if (entry.destroyed) {
      return { ok: false, reason: SCHEDULER_REASONS.SURFACE_DESTROYED };
    }
    if (entry.state.folded === true) {
      entry.metrics.rejectedHiddenDraws += 1;
      return { ok: false, reason: SCHEDULER_REASONS.FOLDED_DISPLAY_DISABLED };
    }
    const eligibility = evaluateTileEligibility(entry.state);
    if (!eligibility.eligible) {
      entry.metrics.rejectedHiddenDraws += 1;
      return {
        ok: false,
        reason: entry.state.contextLost ? SCHEDULER_REASONS.CONTEXT_LOST : SCHEDULER_REASONS.HIDDEN_SURFACE,
        disqualifiers: eligibility.reasons
      };
    }
    if (!entry.mailbox) {
      return { ok: false, reason: SCHEDULER_REASONS.EMPTY_MAILBOX };
    }
    return runTick({ targetSurfaceId: /** @type {string} */ (surfaceId) });
  }

  /**
   * Executes one coordinated fair tick under the frozen aggregate budget.
   * @param {{ targetSurfaceId?: string }} [tickOptions]
   */
  function runTick(tickOptions = {}) {
    const empty = { ok: true, scannedSurfaces: 0, presented: [], drawsUsed: 0, bytesUploaded: 0, timeSpentMs: 0, budgetDeferrals: 0, rejectedStaleLeases: 0 };
    // Stable scan membership if a release observer destroys another surface.
    const turnOrder = surfaceOrder.slice();
    const n = turnOrder.length;
    if (n === 0) {
      return Object.freeze({ ...empty, presented: Object.freeze([]) });
    }
    let drawsUsed = 0;
    let bytesUploaded = 0;
    let timeSpentMs = 0;
    let budgetDeferrals = 0;
    let rejectedStaleLeases = 0;
    /** @type {Object[]} */
    const presented = [];
    const startIdx = fairCursor % n;
    let nextCursor = startIdx;
    /** @type {number | null} First deferred candidate that fits a fresh tick. */
    let retryCursor = null;
    insideTurn = true;
    try {
      for (let offset = 0; offset < n; offset += 1) {
        const idx = (startIdx + offset) % n;
        const id = turnOrder[idx];
        if (tickOptions.targetSurfaceId && id !== tickOptions.targetSurfaceId) {
          continue;
        }
        const entry = surfaces.get(id);
        if (!entry || entry.destroyed || !entry.mailbox) {
          continue;
        }
        const eligibility = evaluateTileEligibility(entry.state);
        if (!eligibility.eligible) {
          entry.metrics.rejectedHiddenDraws += 1;
          drainDisplayHoldings(entry, RELEASE_CAUSES.HIDDEN);
          continue;
        }
        const candidate = entry.mailbox;
        const isLeaseExpired = typeof candidate.leaseExpiresAtMs === 'number' && candidate.leaseExpiresAtMs <= clock();
        const isFrameStale =
          candidate.surfaceGeneration !== entry.surfaceGeneration ||
          candidate.frameGeneration <= entry.lastPresentedFrameGen ||
          candidate.frameGeneration <= entry.minAdmissibleFrameGen;
        if (isLeaseExpired || isFrameStale) {
          entry.metrics.rejectedStaleFrames += 1;
          if (isLeaseExpired) {
            rejectedStaleLeases += 1;
          }
          drainDisplayHoldings(entry, RELEASE_CAUSES.REFUSED);
          continue;
        }
        if (drawsUsed + 1 > budget.maxDrawsPerTick ||
            bytesUploaded + candidate.byteLength > budget.maxUploadBytesPerTick ||
            timeSpentMs + candidate.estimatedPresentMs > budget.maxPresentMsPerTick) {
          budgetDeferrals += 1;
          if (budgetDeferrals === 1 && drawsUsed === 0) {
            nextCursor = idx;
          }
          if (retryCursor === null && candidate.byteLength <= budget.maxUploadBytesPerTick
              && candidate.estimatedPresentMs <= budget.maxPresentMsPerTick) {
            retryCursor = idx;
          }
          continue;
        }
        if (entry.presented !== null) {
          const previous = entry.presented;
          entry.presented = null;
          retireHandle(entry, previous.handle);
          emitLeaseRelease(entry, previous.leaseId, previous.frameGeneration, RELEASE_CAUSES.SUPERSEDED);
        }
        entry.mailbox = null;
        drawsUsed += 1;
        bytesUploaded += candidate.byteLength;
        // A later draw must advance past an earlier permanently deferred tile.
        nextCursor = (idx + 1) % n;

        handleSeq += 1;
        const handle = `tile/${entry.surfaceId}/g${candidate.frameGeneration}/h${handleSeq}`;
        entry.presented = {
          handle,
          bytes: candidate.bytes,
          sha256: candidate.sha256,
          width: candidate.width,
          height: candidate.height,
          frameGeneration: candidate.frameGeneration,
          leaseId: candidate.leaseId,
          surfaceGeneration: candidate.surfaceGeneration,
          submittedAtMs: candidate.submittedAtMs,
          inputTimestampMs: candidate.inputTimestampMs
        };
        liveByHandle.set(handle, entry.surfaceId);

        const attemptStartedAtMs = clock();
        const request = Object.freeze({ surfaceId: entry.surfaceId, handle, frameGeneration: candidate.frameGeneration, box: eligibility.box });
        try {
          if (onPresent) onPresent(request);
          else presentHandle(request);
        } catch { /* A failed canvas/callback terminates the candidate below. */ }
        timeSpentMs += Math.max(0, clock() - attemptStartedAtMs);
        if (entry.lastPresentedFrameGen !== candidate.frameGeneration) {
          // No successful draw witness: release and retire the failed handle.
          if (entry.presented?.handle === handle) {
            entry.presented = null;
            retireHandle(entry, handle);
            if (entry.canvas === null) {
              // MVUI23 guard: registered before the canvas attached. The
              // lease still releases REFUSED below, but the newest undrawn
              // frame is retained (bytes by reference, newest wins) so a
              // later attach paints it instead of waiting for new pixels.
              entry.pendingPaint = {
                bytes: candidate.bytes,
                width: candidate.width,
                height: candidate.height,
                frameGeneration: candidate.frameGeneration,
                handle,
                sha256: candidate.sha256,
              };
            }
            emitLeaseRelease(entry, candidate.leaseId, candidate.frameGeneration, RELEASE_CAUSES.REFUSED);
          }
          continue;
        }
        const presentedAtMs = clock();
        const presentAgeMs = Math.max(0, presentedAtMs - candidate.submittedAtMs);
        const inputToPresentMs = typeof candidate.inputTimestampMs === 'number'
          ? Math.max(0, presentedAtMs - candidate.inputTimestampMs)
          : null;
        entry.metrics.presentCount += 1;
        entry.metrics.drawSubmissions += 1;
        entry.metrics.uploadSubmissions += 1;
        entry.metrics.bytesUploadedTotal += candidate.byteLength;
        entry.metrics.lastPresentAgeMs = presentAgeMs;
        entry.metrics.inputToPresentMs = inputToPresentMs;
        entry.metrics.lastPresentTimestampMs = presentedAtMs;
        entry.metrics.timingScopes = {
          submissionMs: candidate.submittedAtMs,
          parserConsumptionMs: candidate.submittedAtMs + candidate.decodeDurationMs,
          presentationMs: presentedAtMs,
          verifiedDomainEffectMs: null
        };
        const record = Object.freeze({
          surfaceId: entry.surfaceId,
          surfaceGeneration: entry.surfaceGeneration,
          epoch: entry.epoch,
          frameGeneration: candidate.frameGeneration,
          handle,
          box: eligibility.box,
          presentedAtMs
        });
        presented.push(record);
        notifyPresentation();
      }
    } finally {
      insideTurn = false;
    }
    // Preserve priority for temporary deferrals, never for an impossible frame.
    const nextId = turnOrder[(retryCursor ?? nextCursor) % n];
    const liveNextIndex = surfaceOrder.indexOf(nextId);
    fairCursor = liveNextIndex >= 0 ? liveNextIndex : 0;
    return Object.freeze({
      ok: true,
      scannedSurfaces: n,
      presented: Object.freeze(presented),
      drawsUsed,
      bytesUploaded,
      timeSpentMs,
      budgetDeferrals,
      rejectedStaleLeases
    });
  }

  /**
   * Allocates or replaces a bounded warm presentation resource. A native
   * disposer is mandatory: eviction always reclaims the native side.
   * @param {unknown} surfaceId
   * @param {any} spec
   */
  function allocateWarmResource(surfaceId, spec) {
    const entry = surfaces.get(/** @type {string} */ (surfaceId));
    if (!entry) {
      return { ok: false, reason: missingSurfaceReason(surfaceId) };
    }
    if (entry.destroyed) {
      return { ok: false, reason: SCHEDULER_REASONS.SURFACE_DESTROYED };
    }
    if (!spec || typeof spec !== 'object' ||
        typeof spec.resourceId !== 'string' || spec.resourceId.length === 0) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'resourceId is required' };
    }
    if (!Number.isSafeInteger(spec.byteLength) || spec.byteLength < 0) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'byteLength must be a safe integer >= 0' };
    }
    if (typeof spec.dispose !== 'function') {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'Native disposer is required' };
    }
    if (entry.warmResources.has(spec.resourceId)) {
      const prev = entry.warmResources.get(spec.resourceId);
      entry.warmResources.delete(spec.resourceId);
      entry.metrics.warmResourceBytes = Math.max(0, entry.metrics.warmResourceBytes - (prev?.bytes || 0));
      if (prev && typeof prev.dispose === 'function') {
        try { prev.dispose(); } catch { entry.metrics.disposerFaults += 1; }
      }
    }
    const byteLength = /** @type {number} */ (spec.byteLength);
    entry.warmResources.set(spec.resourceId, {
      resourceId: spec.resourceId,
      bytes: byteLength,
      dispose: spec.dispose,
      allocatedAtMs: clock()
    });
    entry.metrics.warmResourceBytes += byteLength;
    trimWarmResources(entry, budget.maxWarmResourcesPerSurface);
    return { ok: true, warmResourceCount: entry.warmResources.size, warmResourceBytes: entry.metrics.warmResourceBytes };
  }

  /**
   * Handles canvas context loss: display holdings drain, warm resources drop
   * to zero with disposers, capture lease stays active.
   * @param {unknown} surfaceId
   */
  function onContextLost(surfaceId) {
    const entry = surfaces.get(/** @type {string} */ (surfaceId));
    if (!entry) {
      return { ok: false, reason: missingSurfaceReason(surfaceId) };
    }
    if (entry.destroyed) {
      return { ok: false, reason: SCHEDULER_REASONS.SURFACE_DESTROYED };
    }
    entry.state = { ...entry.state, contextLost: true };
    drainDisplayHoldings(entry, RELEASE_CAUSES.CONTEXT_LOST);
    trimWarmResources(entry, 0);
    return { ok: true, contextLost: true, captureLeaseRetained: entry.captureLeaseActive };
  }

  /**
   * Restores presentation context and requests the newest generation above
   * every witness floor.
   * @param {unknown} surfaceId
   */
  function onContextRestored(surfaceId) {
    const entry = surfaces.get(/** @type {string} */ (surfaceId));
    if (!entry) {
      return { ok: false, reason: missingSurfaceReason(surfaceId) };
    }
    if (entry.destroyed) {
      return { ok: false, reason: SCHEDULER_REASONS.SURFACE_DESTROYED };
    }
    entry.state = { ...entry.state, contextLost: false };
    const afterFrameGeneration = Math.max(
      entry.lastPresentedFrameGen,
      entry.minAdmissibleFrameGen,
      entry.lastCaptureGeneration
    );
    entry.minAdmissibleFrameGen = afterFrameGeneration;
    if (onRequestNewestGeneration) {
      onRequestNewestGeneration({
        surfaceId: entry.surfaceId,
        surfaceGeneration: entry.surfaceGeneration,
        epoch: entry.epoch,
        afterFrameGeneration
      });
    }
    return { ok: true, contextLost: false, requestedAfterFrameGeneration: afterFrameGeneration };
  }

  /**
   * Destroys a surface: display holdings release, warm resources reclaim with
   * disposers, canvas detaches, capture lease terminates, id tombstones.
   * @param {unknown} surfaceId
   */
  function destroySurface(surfaceId) {
    const entry = surfaces.get(/** @type {string} */ (surfaceId));
    if (!entry) {
      return { ok: false, reason: missingSurfaceReason(surfaceId) };
    }
    drainDisplayHoldings(entry, RELEASE_CAUSES.SURFACE_DESTROYED);
    trimWarmResources(entry, 0);
    entry.canvas = null;
    entry.canvasToken = null;
    entry.lastDetachedCanvas = null;
    entry.lastPaint = null;
    entry.presentScratch = null;
    entry.destroyed = true;
    entry.captureLeaseActive = false;
    tombstones.add(entry.surfaceId);
    surfaces.delete(entry.surfaceId);
    if (entry.lastRetiredHandle) retiredByHandle.delete(entry.lastRetiredHandle);
    const index = surfaceOrder.indexOf(entry.surfaceId);
    if (index >= 0) {
      surfaceOrder.splice(index, 1);
      if (index < fairCursor) fairCursor -= 1;
    }
    notifyPresentation();
    return { ok: true, destroyed: true, disposerFaults: entry.metrics.disposerFaults };
  }

  /**
   * Evicts a surface without tombstoning: display holdings release, warm
   * resources reclaim with disposers, canvas detaches, capture lease ends,
   * lastPaint/pendingPaint drop, and the entry leaves the registry. Unlike
   * destroySurface the id stays re-registerable, so a reopened capsule (a
   * new router stream) registers fresh. Call only for fully retired,
   * canvas-less surfaces (see shouldEvictSchedulerEntry); evicting under a
   * live stream would strand its registered flag with no entry to paint on.
   * @param {unknown} surfaceId
   */
  function evictSurface(surfaceId) {
    const entry = surfaces.get(/** @type {string} */ (surfaceId));
    if (!entry) {
      return { ok: false, reason: missingSurfaceReason(surfaceId) };
    }
    drainDisplayHoldings(entry, RELEASE_CAUSES.SURFACE_DESTROYED);
    trimWarmResources(entry, 0);
    entry.canvas = null;
    entry.canvasToken = null;
    entry.lastDetachedCanvas = null;
    entry.lastPaint = null;
    entry.pendingPaint = null;
    entry.presentScratch = null;
    entry.destroyed = true;
    entry.captureLeaseActive = false;
    surfaces.delete(entry.surfaceId);
    if (entry.lastRetiredHandle) retiredByHandle.delete(entry.lastRetiredHandle);
    const index = surfaceOrder.indexOf(entry.surfaceId);
    if (index >= 0) {
      surfaceOrder.splice(index, 1);
      if (index < fairCursor) fairCursor -= 1;
    }
    notifyPresentation();
    return { ok: true, evicted: true, disposerFaults: entry.metrics.disposerFaults };
  }

  /**
   * Returns frozen per-surface instrumentation, or null when unknown.
   * @param {unknown} surfaceId
   */
  function getInstrumentation(surfaceId) {
    const entry = surfaces.get(/** @type {string} */ (surfaceId));
    if (!entry) {
      return tombstones.has(/** @type {string} */ (surfaceId))
        ? Object.freeze({ surfaceId, destroyed: true, captureLeaseActive: false, canvasAttached: false })
        : null;
    }
    const eligibility = evaluateTileEligibility(entry.state);
    return Object.freeze({
      surfaceId: entry.surfaceId,
      surfaceGeneration: entry.surfaceGeneration,
      epoch: entry.epoch,
      destroyed: entry.destroyed,
      folded: entry.state.folded === true,
      contextLost: entry.state.contextLost === true,
      eligible: eligibility.eligible,
      box: eligibility.box,
      captureLeaseId: entry.captureLeaseId,
      captureLeaseActive: entry.captureLeaseActive,
      canvasAttached: entry.canvas !== null,
      lastCaptureGeneration: entry.lastCaptureGeneration,
      lastPresentedFrameGen: entry.lastPresentedFrameGen,
      lastPresentedHandle: entry.lastPresentedHandle,
      lastPresentedDigest: entry.lastPresentedDigest,
      lastPresentedWidth: entry.lastPresentedWidth,
      lastPresentedHeight: entry.lastPresentedHeight,
      pendingMailboxFrameGen: entry.mailbox ? entry.mailbox.frameGeneration : null,
      presentedPendingFrameGen: entry.presented ? entry.presented.frameGeneration : null,
      warmResourceCount: entry.warmResources.size,
      warmResourceBytes: entry.metrics.warmResourceBytes,
      reclaimedWarmResources: entry.metrics.reclaimedWarmResources,
      disposerFaults: entry.metrics.disposerFaults,
      captureCount: entry.metrics.captureCount,
      decodeCount: entry.metrics.decodeCount,
      presentCount: entry.metrics.presentCount,
      drawSubmissions: entry.metrics.drawSubmissions,
      uploadSubmissions: entry.metrics.uploadSubmissions,
      bytesUploadedTotal: entry.metrics.bytesUploadedTotal,
      convertedBytesTotal: entry.metrics.convertedBytesTotal,
      measuredPresentMs: entry.measuredPresentMs,
      mailboxReplacements: entry.metrics.mailboxReplacements,
      rejectedHiddenDraws: entry.metrics.rejectedHiddenDraws,
      rejectedStaleFrames: entry.metrics.rejectedStaleFrames,
      lastPresentAgeMs: entry.metrics.lastPresentAgeMs,
      inputToPresentMs: entry.metrics.inputToPresentMs,
      timingScopes: Object.freeze({ ...entry.metrics.timingScopes })
    });
  }

  /**
   * Binds a canvas element to a surface. Called on tile mount. One canvas
   * is active per surface: a new element replaces the previous attachment
   * (R2-12), and the identity checks stay intact. MVUI20: when the attach
   * swaps in a different element after a frame presented, it repaints the
   * retained frame immediately so the tile never shows black; re-attaching
   * the standing element — including a detach-then-reattach of the same
   * element — repaints nothing (MVUI22). MVUI23: a frame retained while no
   * canvas was attached paints on ANY successful attach (it was never
   * visible, so the MVUI22 no-repaint invariant does not apply to it).
   * MVUI32 (R3-SCHEDULER-1): retained replays obey the same eligibility
   * fence as submit/present/runTick — zero draws while folded, hidden, or
   * context-lost; the attach still stands and the retained frame survives
   * for a later eligible attach.
   * @param {any} args
   */
  function attachCanvas(args) {
    if (!args || !isValidSurfaceId(args.surfaceId)) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_SURFACE_ID };
    }
    const entry = surfaces.get(args.surfaceId);
    if (!entry) {
      return { ok: false, reason: missingSurfaceReason(args.surfaceId) };
    }
    if (entry.destroyed) {
      return { ok: false, reason: SCHEDULER_REASONS.SURFACE_DESTROYED };
    }
    // [TARGET, unit decision] A remounted canvas must match its tile lifetime.
    if ((args.surfaceGeneration !== undefined && args.surfaceGeneration !== entry.surfaceGeneration)
        || (args.epoch !== undefined && args.epoch !== entry.epoch)) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING };
    }
    if (!args.canvas || typeof args.canvas.getContext !== 'function') {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'Canvas handle is not drawable' };
    }
    const previous = entry.canvas;
    // MVUI22: a detach-then-reattach of the same element (the SurfaceCanvas
    // onRegistered pattern) still shows the retained frame, so it repaints
    // nothing. Invariant: lastDetachedCanvas is non-null only while no
    // canvas is attached (every successful attach clears it).
    const sameElementReattach = entry.lastDetachedCanvas === args.canvas;
    entry.canvas = args.canvas;
    entry.canvasToken = Symbol('canvas-owner');
    entry.lastDetachedCanvas = null;
    // MVUI32 lane S (R3-SCHEDULER-1): fence retained replays on the same
    // eligibility criteria as submit/present/runTick. The attach still
    // stands (future presents work); only the draw is skipped, and both
    // retained slots survive so a later eligible attach replays the newest
    // permitted frame.
    if (!evaluateTileEligibility(entry.state).eligible) {
      return { ok: true, surfaceId: entry.surfaceId, token: entry.canvasToken };
    }
    if (entry.pendingPaint !== null) {
      // MVUI23 guard: the newest frame retained while canvas-less was never
      // painted, so it paints on any attach (newest wins over lastPaint)
      // and becomes the retained frame plus the presented witness.
      const retained = entry.pendingPaint;
      entry.pendingPaint = null;
      let painted = null;
      const attachDrawStartedAtMs = clock();
      try {
        painted = drawRgb24ToCanvas(args.canvas, retained.bytes, retained.width, retained.height, entry);
      } catch {
        painted = null;
      }
      if (painted === null || painted === undefined || painted.ok !== true) {
        // MVUI26 RV10-02: the draw reports failure by return, not throw. A
        // failed draw keeps the frame pending and records no witness.
        entry.pendingPaint = retained;
        return { ok: true, surfaceId: entry.surfaceId, token: entry.canvasToken };
      }
      notePresentSample(entry, clock() - attachDrawStartedAtMs);
      entry.lastPaint = { bytes: retained.bytes, width: retained.width, height: retained.height };
      entry.lastPresentedFrameGen = retained.frameGeneration;
      entry.lastPresentedHandle = retained.handle;
      entry.lastPresentedDigest = retained.sha256;
      entry.lastPresentedWidth = retained.width;
      entry.lastPresentedHeight = retained.height;
      // MVUI26 NEW-03: account the attach paint like the coordinated present
      // path so instrumentation stays consistent with the witness.
      entry.metrics.presentCount += 1;
      entry.metrics.convertedBytesTotal += retained.width * retained.height * 4;
      // MVUI26 RV10-02: subscribers learn of the new witness.
      notifyPresentation();
    } else if (entry.lastPaint !== null && previous !== args.canvas && !sameElementReattach) {
      try {
        drawRgb24ToCanvas(args.canvas, entry.lastPaint.bytes, entry.lastPaint.width, entry.lastPaint.height, entry);
      } catch { /* Repaint is best-effort; the attach stands for future presents. */ }
    }
    return { ok: true, surfaceId: entry.surfaceId, token: entry.canvasToken };
  }

  /**
   * Unbinds only the canvas owned by this attachment. Stale unmounts are no-ops.
   * @param {unknown} surfaceId
   * @param {unknown} [token]
   */
  function detachCanvas(surfaceId, token) {
    const entry = surfaces.get(/** @type {string} */ (surfaceId));
    if (entry && typeof token === 'symbol' && entry.canvasToken === token) {
      entry.lastDetachedCanvas = entry.canvas;
      entry.canvas = null;
      entry.canvasToken = null;
    }
  }

  /**
   * Draws an already-presented opaque handle onto the bound canvas. Valid
   * only during a coordinated scheduler turn, only for the owning surface,
   * and only while no canvas-affecting teardown retired the handle.
   * @param {any} args
   */
  function presentHandle(args) {
    if (!insideTurn) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'presentHandle outside coordinated scheduler turn' };
    }
    if (!args || !isValidSurfaceId(args.surfaceId)) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_SURFACE_ID };
    }
    const entry = surfaces.get(args.surfaceId);
    if (!entry) {
      return { ok: false, reason: missingSurfaceReason(args.surfaceId) };
    }
    if (entry.destroyed) {
      return { ok: false, reason: SCHEDULER_REASONS.SURFACE_DESTROYED };
    }
    if (typeof args.handle !== 'string' || args.handle.length === 0) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'Present handle is required' };
    }
    const owner = liveByHandle.has(args.handle)
      ? liveByHandle.get(args.handle)
      : (retiredByHandle.has(args.handle) ? retiredByHandle.get(args.handle) : undefined);
    if (owner === undefined) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'Unknown present handle' };
    }
    if (owner !== entry.surfaceId) {
      return { ok: false, reason: SCHEDULER_REASONS.SURFACE_MISMATCH };
    }
    if (retiredByHandle.has(args.handle) || !entry.presented || entry.presented.handle !== args.handle) {
      return { ok: false, reason: SCHEDULER_REASONS.STALE_FRAME_GENERATION };
    }
    if (!entry.canvas) {
      return { ok: false, reason: SCHEDULER_REASONS.INVALID_BINDING, detail: 'No canvas attached' };
    }
    const slot = entry.presented;
    const drawStartedAtMs = clock();
    const drawn = drawRgb24ToCanvas(entry.canvas, slot.bytes, slot.width, slot.height, entry);
    if (!drawn.ok) {
      return drawn;
    }
    notePresentSample(entry, clock() - drawStartedAtMs);
    const convertedBytes = slot.width * slot.height * 4;
    entry.metrics.convertedBytesTotal += convertedBytes;
    // MVUI20: one retained frame feeds later (re-)attaches; a new surface
    // lifetime, a warm-resource eviction, or destroy drops it. MVUI22: the
    // scheduler owns the submitted bytes, drawn from the same reference, so
    // the retain keeps the validated reference instead of copying per frame.
    // A successful draw also supersedes any MVUI23 undrawn retain.
    entry.lastPaint = { bytes: slot.bytes, width: slot.width, height: slot.height };
    entry.pendingPaint = null;
    entry.lastPresentedFrameGen = slot.frameGeneration;
    entry.lastPresentedHandle = slot.handle;
    entry.lastPresentedDigest = slot.sha256;
    entry.lastPresentedWidth = slot.width;
    entry.lastPresentedHeight = slot.height;
    retireHandle(entry, slot.handle);
    entry.presented = null;
    emitLeaseRelease(entry, slot.leaseId, slot.frameGeneration, RELEASE_CAUSES.PRESENTED);
    return { ok: true, frameGeneration: slot.frameGeneration, convertedBytes };
  }

  /** Invalidates read-only canvas witnesses without exposing frame bytes. */
  function notifyPresentation() {
    for (const listener of presentationListeners) {
      try { listener(); } catch { /* Observer does not own renderer state. */ }
    }
  }

  /** @param {() => void} listener */
  function subscribePresentation(listener) {
    presentationListeners.add(listener);
    return () => { presentationListeners.delete(listener); };
  }

  /**
   * Tears down every surface (leases, disposers, canvases) and resets the
   * registry. The scheduler is usable again afterwards.
   */
  function destroy() {
    for (const entry of surfaces.values()) {
      drainDisplayHoldings(entry, RELEASE_CAUSES.SURFACE_DESTROYED);
      trimWarmResources(entry, 0);
      entry.canvas = null;
      entry.canvasToken = null;
      entry.lastDetachedCanvas = null;
      entry.lastPaint = null;
      entry.presentScratch = null;
      entry.destroyed = true;
      entry.captureLeaseActive = false;
    }
    surfaces.clear();
    tombstones.clear();
    surfaceOrder.length = 0;
    liveByHandle.clear();
    retiredByHandle.clear();
    fairCursor = 0;
    insideTurn = false;
    notifyPresentation();
    presentationListeners.clear();
  }

  return Object.freeze({
    budget,
    registerSurface,
    recordCaptureWitness,
    submitFrame,
    foldSurface,
    unfoldSurface,
    updateSurfaceState,
    presentSurfaceNow,
    runTick,
    allocateWarmResource,
    onContextLost,
    onContextRestored,
    destroySurface,
    evictSurface,
    getInstrumentation,
    subscribePresentation,
    attachCanvas,
    detachCanvas,
    presentHandle,
    destroy
  });
}
