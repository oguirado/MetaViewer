/**
 * @file Wall tile capture chrome helpers (MVUI9 lane T): tile-scoped ids,
 * anchors, accessible names, elapsed formatting and capture-state reads.
 *
 * The chrome rail on every wall tile is driven by the capture store the wall
 * root receives (`captureState` prop): `bySurface` entries shaped
 * `{phase, recordingId, frames, elapsedMs, lastShot, lastCode}` plus
 * `toggleRecord(surfaceId)` / `screenshot(surfaceId)` actions. This module
 * reads that shape defensively (a missing store disables the chrome, it
 * never throws) and owns the `tile-<surface>-*` anchor family.
 *
 * Pure module, dependency-free: node:test imports this file directly and the
 * TileCaptureChrome setup script shares its mapping, so it must stay free of
 * framework calls, host access and external loads.
 */

/**
 * Record-axis phases shared with the capture store and the kit record
 * vocabulary. Must stay identical to `MV_RECORDING_PHASES`.
 * @type {ReadonlyArray<string>}
 */
export const TILE_CAPTURE_PHASES = Object.freeze([
  'idle',
  'starting',
  'recording',
  'stopping',
  'sealed',
  'error',
]);

/**
 * Accessible reason carried by disabled chrome controls when no capture
 * store (or no capture actions) is bound.
 * @type {string}
 */
export const TILE_CAPTURE_UNAVAILABLE_REASON = 'Recording is unavailable';

/**
 * Elapsed readout when no elapsed time is known. Mirrors the kit elapsed
 * convention: unreadable values never fabricate a zero.
 * @type {string}
 */
export const TILE_CAPTURE_ELAPSED_UNKNOWN = '--:--';

/**
 * @param {unknown} value
 * @returns {boolean} True only for a known record-axis phase.
 */
export function isTileCapturePhase(value) {
  return typeof value === 'string' && TILE_CAPTURE_PHASES.includes(value);
}

/**
 * @param {unknown} phase
 * @returns {string} Known record phase, falling back to `idle`.
 */
export function normalizeTileCapturePhase(phase) {
  return isTileCapturePhase(phase) ? /** @type {string} */ (phase) : 'idle';
}

/**
 * @param {unknown} phase
 * @returns {boolean} True while the host transition is pending.
 */
export function tileCapturePhaseBusy(phase) {
  const normalized = normalizeTileCapturePhase(phase);
  return normalized === 'starting' || normalized === 'stopping';
}

/**
 * Preserve canonical ids and encode every UTF-16 unit otherwise. The
 * reserved prefix is encoded too, so an encoded value cannot collide with
 * a host id. Mirrors the recording-model segment encoding.
 * @param {unknown} value Host surface id.
 * @returns {string} Safe, deterministic DOM/anchor segment.
 */
export function tileIdSegment(value) {
  if (typeof value === 'string'
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
    && !value.startsWith('encoded-')) {
    return value;
  }
  const text = typeof value === 'string' ? value : String(value);
  let encoded = 'encoded';
  for (let index = 0; index < text.length; index += 1) {
    encoded += `-${text.charCodeAt(index).toString(16).padStart(4, '0')}`;
  }
  return `${encoded}-end`;
}

/**
 * @param {unknown} surfaceId Host-issued surface id.
 * @returns {string} Stable DOM id for the tile record-for-AI handle.
 */
export function tileRecordDomId(surfaceId) {
  return `tile-${tileIdSegment(surfaceId)}-record-ai`;
}

/**
 * @param {unknown} surfaceId Host-issued surface id.
 * @returns {string} Semantic anchor for the tile record-for-AI handle.
 */
export function tileRecordAnchor(surfaceId) {
  return `tile-${tileIdSegment(surfaceId)}-record-ai`;
}

/**
 * @param {unknown} surfaceId Host-issued surface id.
 * @returns {string} Stable DOM id for the tile screenshot control.
 */
export function tileScreenshotDomId(surfaceId) {
  return `tile-${tileIdSegment(surfaceId)}-screenshot`;
}

/**
 * @param {unknown} surfaceId Host-issued surface id.
 * @returns {string} Semantic anchor for the tile screenshot control.
 */
export function tileScreenshotAnchor(surfaceId) {
  return `tile-${tileIdSegment(surfaceId)}-screenshot`;
}

/**
 * @param {unknown} surfaceId Host-issued surface id.
 * @returns {string} Stable DOM id for the tile recording-state badge.
 */
export function tileBadgeDomId(surfaceId) {
  return `tile-${tileIdSegment(surfaceId)}-recording-badge`;
}

/**
 * @param {unknown} surfaceId Host-issued surface id.
 * @returns {string} Semantic anchor for the tile recording-state badge.
 */
export function tileBadgeAnchor(surfaceId) {
  return `tile-${tileIdSegment(surfaceId)}-recording-badge`;
}

/**
 * @param {{ capsuleLabel?: unknown, capsuleId?: unknown } | null | undefined} input
 * @returns {string} Human label used inside accessible names.
 */
export function tileChromeLabel(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const raw = typeof source.capsuleLabel === 'string' ? source.capsuleLabel.trim() : '';
  if (raw.length > 0) return raw;
  return typeof source.capsuleId === 'string' && source.capsuleId.length > 0
    ? source.capsuleId
    : 'capsule';
}

/**
 * @param {{ capsuleLabel?: unknown, capsuleId?: unknown } | null | undefined} input
 * @returns {string} Accessible name for the tile chrome group.
 */
export function tileChromeGroupName(input) {
  return `Tile capture controls for ${tileChromeLabel(input)}`;
}

/**
 * Screenshot button label. A fresh capture reads `Captured` until the next
 * capture starts; the in-flight capture reads `Capturing`.
 * @param {{ capturing?: unknown, lastShot?: unknown } | null | undefined} input
 * @returns {string} Visible button label.
 */
export function tileShotLabel(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  if (source.capturing === true) return 'Capturing';
  if (source.lastShot !== null && source.lastShot !== undefined && source.lastShot !== '') {
    return 'Captured';
  }
  return 'Screenshot';
}

/**
 * @param {{ capsuleLabel?: unknown, capsuleId?: unknown, capturing?: unknown, lastShot?: unknown } | null | undefined} input
 * @returns {string} Stable accessible name for the tile screenshot control.
 */
export function tileShotAccessibleName(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const label = tileChromeLabel(source);
  if (source.capturing === true) return `Screenshot capture pending on ${label}`;
  if (source.lastShot !== null && source.lastShot !== undefined && source.lastShot !== '') {
    return `Screenshot captured on ${label}`;
  }
  return `Screenshot ${label}`;
}

/**
 * Formats a host-projected elapsed-milliseconds count as `MM:SS`.
 * Unreadable values render `--:--`, never a fabricated zero.
 * @param {unknown} value
 * @returns {string}
 */
export function formatTileElapsedMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return TILE_CAPTURE_ELAPSED_UNKNOWN;
  }
  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Badge copy for one record phase. Only the active recording carries an
 * elapsed readout; the error phase renders `Idle` (no error text ever
 * renders; the refusal detail stays in the entry `lastCode`, never shown).
 * @param {{ phase?: unknown, elapsedMs?: unknown } | null | undefined} input
 * @returns {string} Visible badge text.
 */
export function tileBadgeText(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const phase = normalizeTileCapturePhase(source.phase);
  if (phase === 'recording') return `Recording ${formatTileElapsedMs(source.elapsedMs)}`;
  if (phase === 'starting') return 'Starting';
  if (phase === 'stopping') return 'Stopping';
  if (phase === 'sealed') return 'Sealed';
  return 'Idle';
}

/**
 * @param {{ phase?: unknown } | null | undefined} input
 * @returns {string} Badge variant for the `data-variant` treatment hook.
 */
export function tileBadgeVariant(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const phase = normalizeTileCapturePhase(source.phase);
  if (phase === 'recording') return 'recording';
  if (phase === 'starting' || phase === 'stopping') return 'busy';
  if (phase === 'sealed') return 'sealed';
  return 'idle';
}

/**
 * Reads one surface entry from a capture store. Accepts `bySurface` as a
 * Map or a plain object; anything else (missing store, missing surface,
 * malformed entry) yields null instead of throwing.
 * @param {unknown} captureState Capture store or null when unbound.
 * @param {unknown} surfaceId Host-issued surface id.
 * @returns {Record<string, unknown> | null}
 */
export function readSurfaceEntry(captureState, surfaceId) {
  if (captureState === null || typeof captureState !== 'object') return null;
  if (typeof surfaceId !== 'string' || surfaceId.length === 0) return null;
  const bySurface = /** @type {Record<string, unknown>} */ (captureState).bySurface;
  /** @type {unknown} */
  let candidate = null;
  if (bySurface instanceof Map) {
    candidate = bySurface.get(surfaceId) ?? null;
  } else if (bySurface !== null && typeof bySurface === 'object' && !Array.isArray(bySurface)) {
    const record = /** @type {Record<string, unknown>} */ (bySurface);
    candidate = Object.prototype.hasOwnProperty.call(record, surfaceId)
      ? record[surfaceId]
      : null;
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  return /** @type {Record<string, unknown>} */ (candidate);
}

/**
 * @param {unknown} entry Surface entry or null.
 * @returns {string} Known record phase, falling back to `idle`.
 */
export function surfaceEntryPhase(entry) {
  if (entry === null || typeof entry !== 'object') return 'idle';
  return normalizeTileCapturePhase(/** @type {Record<string, unknown>} */ (entry).phase);
}

/**
 * @param {unknown} captureState Capture store or null when unbound.
 * @returns {boolean} True only when both capture actions are callable.
 */
export function hasCaptureActions(captureState) {
  if (captureState === null || typeof captureState !== 'object') return false;
  const state = /** @type {Record<string, unknown>} */ (captureState);
  return typeof state.toggleRecord === 'function' && typeof state.screenshot === 'function';
}

/**
 * Chrome availability. A missing store, an explicit `available: false`
 * projection, or missing actions all disable the chrome with the shared
 * unavailable reason; the badge keeps rendering its idle readout.
 * @param {unknown} captureState Capture store or null when unbound.
 * @returns {boolean} True when the chrome must render disabled.
 */
export function isCaptureUnavailable(captureState) {
  if (captureState === null || typeof captureState !== 'object') return true;
  if (/** @type {Record<string, unknown>} */ (captureState).available === false) return true;
  return !hasCaptureActions(captureState);
}
