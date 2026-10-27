import { buildAuthorityIntent } from '../core/intents.js';

/**
 * Operator input-mode gate for the MetaViewer AI multislot.
 *
 * Pure renderer module: no DOM or framework. The host projects
 * one operator input mode (`read|write`, default `read`, aligned with the kit
 * `AiInputModeChip` normalizer) and this module decides, at two boundaries,
 * whether operator keystrokes may travel:
 *
 * 1. the kit control lease (`leaseForInputMode` feeds `hasControlLease`, so
 *    the kit terminal registry itself drops keystrokes in READ mode);
 * 2. the host facade writer (`createGatedTerminalWriter` drops `write`
 *    calls in READ mode, so a kit regression can never deliver them).
 *
 * READ mode never delivers operator keystrokes; WRITE mode delivers them
 * unchanged. Unknown modes fail closed to READ.
 *
 * AC-06 placement builders share this boundary: hide, show, float (with
 * measured geometry), move and tab (with group and index) are built as
 * exact closed ui_intent/v0.2 bodies through the shared authority builder,
 * so out-of-range values are rejected client-side before anything is sent.
 * Builders never touch the wire; presentation stays authoritative (the
 * caller applies placement only on the echoed acknowledgement).
 *
 * @module multislot/multislotInputGate
 */

/** Operator input modes admitted on this surface. */
export const MULTISLOT_INPUT_MODES = Object.freeze(['read', 'write']);

/** Typed reason carried by a dropped write. */
export const INPUT_GATE_REFUSAL = 'ERR_INPUT_MODE_READ';

// Pinned against AiMultiSlot.multislotDomIds().root by mvui3-renderer.test.js.
const MULTISLOT_ID_PREFIX = 'cuk-ai-slot-';
/** @param {string} capsuleId */
export function multislotSlotId(capsuleId) {
  return `${MULTISLOT_ID_PREFIX}${capsuleId}`;
}

/**
 * @param {unknown} mode Candidate projected mode.
 * @returns {'read'|'write'} Known mode, failing closed to `read`.
 */
export function normalizeMultislotInputMode(mode) {
  return mode === 'write' ? 'write' : 'read';
}

/**
 * @param {unknown} mode Candidate projected mode.
 * @returns {boolean} True only in WRITE mode: the value the host feeds to
 * the kit `hasControlLease` prop, so the kit registry drops keystrokes in
 * READ mode before they reach any host boundary.
 */
export function leaseForInputMode(mode) {
  return normalizeMultislotInputMode(mode) === 'write';
}

/**
 * @typedef {object} GatedWriteInput
 * @property {string} session Target broker session id.
 * @property {number[]} bytes Input bytes to deliver.
 */

/**
 * @typedef {object} GatedWriteOutcome
 * @property {boolean} delivered True when the bytes reached the facade.
 * @property {string} reason Empty when delivered, otherwise the typed
 * refusal code (`ERR_INPUT_MODE_READ`).
 */

/**
 * Wraps a terminal facade with the READ-mode input gate. The gate reads the
 * live mode through `getInputMode` on every write, so a mode switch applies
 * to the next keystroke without rewiring.
 *
 * @param {{ facade: { write: (input: GatedWriteInput) => void }, getInputMode: () => unknown }} options
 * @returns {{ write: (input: GatedWriteInput) => GatedWriteOutcome }} Gated writer.
 */
export function createGatedTerminalWriter({ facade, getInputMode }) {
  if (!facade || typeof facade.write !== 'function') {
    throw new TypeError('createGatedTerminalWriter requires a facade with write()');
  }
  if (typeof getInputMode !== 'function') {
    throw new TypeError('createGatedTerminalWriter requires a getInputMode function');
  }
  return {
    /**
     * @param {GatedWriteInput} input
     * @returns {GatedWriteOutcome}
     */
    write(input) {
      if (normalizeMultislotInputMode(getInputMode()) !== 'write') {
        return { delivered: false, reason: INPUT_GATE_REFUSAL };
      }
      facade.write(input);
      return { delivered: true, reason: '' };
    },
  };
}

/** Admit kit fold controls through the shared authority builder. The slot
 * identity matches AiMultiSlot.multislotDomIds().root; mounted tests pin it.
 * @param {'fold'|'unfold'} op
 * @param {string} capsuleId
 * @returns {Readonly<Record<string, unknown>>}
 */
export function buildMultislotFoldIntent(op, capsuleId) {
  return buildAuthorityIntent({ op, params: { slot_id: multislotSlotId(capsuleId) } });
}

/** Authoritative layout ops the multislot slot may request (AC-06). */
export const MULTISLOT_LAYOUT_OPS = Object.freeze(['fold', 'unfold', 'move', 'tab', 'float', 'hide', 'show']);

/** Placement subset: full READ/agent/hidden guards apply (fold/unfold keep hidden-only). */
export const MULTISLOT_PLACEMENT_OPS = Object.freeze(['move', 'tab', 'float', 'hide', 'show']);

/** Conventional dock target for dock-back (groups are declarative names). */
export const MULTISLOT_DOCK_GROUP = 'multislot-dock';
export const MULTISLOT_DOCK_INDEX = 0;

/** Index bounds shared by move/tab (mirrors ui_intent/v0.2). */
export const MULTISLOT_PLACEMENT_INDEX_MIN = 0;
export const MULTISLOT_PLACEMENT_INDEX_MAX = 255;

/**
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
function throwPlacementError(code, message) {
  const err = /** @type {Error & {code: string}} */ (new Error(`${code}: ${message}`));
  err.code = code;
  throw err;
}

/** Hide the whole slot (capsule and terminal travel together).
 * @param {string} capsuleId
 * @returns {Readonly<Record<string, unknown>>}
 */
export function buildMultislotHideIntent(capsuleId) {
  return buildAuthorityIntent({ op: 'hide', params: { slot_id: multislotSlotId(capsuleId) } });
}

/** Show a hidden slot again.
 * @param {string} capsuleId
 * @returns {Readonly<Record<string, unknown>>}
 */
export function buildMultislotShowIntent(capsuleId) {
  return buildAuthorityIntent({ op: 'show', params: { slot_id: multislotSlotId(capsuleId) } });
}

/**
 * @typedef {Readonly<{x: number, y: number, width: number, height: number}>} FloatBox
 */

/** Float the slot at measured integer geometry. Bounds reject before sending.
 * @param {string} capsuleId
 * @param {{x?: unknown, y?: unknown, width?: unknown, height?: unknown} | null | undefined} box
 * @returns {Readonly<Record<string, unknown>>}
 */
export function buildMultislotFloatIntent(capsuleId, box) {
  const source = box && typeof box === 'object' ? box : {};
  return buildAuthorityIntent({ op: 'float', params: {
    height_px: source.height, slot_id: multislotSlotId(capsuleId), width_px: source.width,
    x_px: source.x, y_px: source.y,
  } });
}

/** Move the slot into a dock group at an index (0..255 rejects before sending).
 * @param {string} capsuleId
 * @param {unknown} groupId
 * @param {unknown} index
 * @returns {Readonly<Record<string, unknown>>}
 */
export function buildMultislotMoveIntent(capsuleId, groupId, index) {
  return buildAuthorityIntent({ op: 'move', params: {
    group_id: groupId, index, slot_id: multislotSlotId(capsuleId),
  } });
}

/** Tab the slot into a group at an index (0..255 rejects before sending).
 * @param {string} capsuleId
 * @param {unknown} groupId
 * @param {unknown} index
 * @returns {Readonly<Record<string, unknown>>}
 */
export function buildMultislotTabIntent(capsuleId, groupId, index) {
  return buildAuthorityIntent({ op: 'tab', params: {
    group_id: groupId, index, slot_id: multislotSlotId(capsuleId),
  } });
}

/** Round measured geometry to integer pixels; unmeasurable boxes yield null
 * so the caller refuses instead of fabricating geometry.
 * @param {unknown} box
 * @returns {FloatBox | null}
 */
export function roundFloatBox(box) {
  if (typeof box !== 'object' || box === null) return null;
  const candidate = /** @type {Record<string, unknown>} */ (box);
  const parts = [candidate.x, candidate.y, candidate.width, candidate.height];
  if (!parts.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  return Object.freeze({ x: Math.round(/** @type {number} */ (candidate.x)),
    y: Math.round(/** @type {number} */ (candidate.y)),
    width: Math.round(/** @type {number} */ (candidate.width)),
    height: Math.round(/** @type {number} */ (candidate.height)) });
}

/** Parse a placement index from raw input: digits only, 0..255, no trim.
 * @param {unknown} raw
 * @returns {number}
 */
export function parsePlacementIndex(raw) {
  if (typeof raw === 'string' && /^\d{1,3}$/.test(raw)) {
    const parsed = Number(raw);
    if (parsed <= MULTISLOT_PLACEMENT_INDEX_MAX) return parsed;
  } else if (typeof raw === 'number' && Number.isInteger(raw)
    && raw >= MULTISLOT_PLACEMENT_INDEX_MIN && raw <= MULTISLOT_PLACEMENT_INDEX_MAX) {
    return raw;
  }
  throwPlacementError('ERR_INVALID_PLACEMENT_INPUT', 'placement index must be an integer 0..255');
}
