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
