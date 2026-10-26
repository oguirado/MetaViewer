/**
 * Copy-capsule-ID host action for the MetaViewer multislot.
 *
 * Pure renderer module: no DOM, no framework. The kit identity plate emits a
 * `copy-id` intent and the kit never touches the clipboard itself; this
 * module performs the write against an injected clipboard
 * (`{writeText(text): Promise<void>}`) defaulting to `navigator.clipboard`
 * when available. The capsule id is validated with the kit
 * `multislotIntents.validateCapsuleId` contract: a missing or unstable id
 * reports `unavailable` without touching the clipboard. Copy never throws;
 * every outcome is a projected state (`ready|copying|copied|unavailable`,
 * aligned with the kit `AiIdentityPlate` states).
 *
 * @module multislot/multislotCopy
 */
import { validateCapsuleId } from '../../.kit/capsule-ui-kit/src/multislot/multislotIntents.js';

/** Copy states projected to the kit identity plate. */
export const MULTISLOT_COPY_STATES = Object.freeze(['ready', 'copying', 'copied', 'unavailable']);

/**
 * @param {unknown} state
 * @returns {'ready'|'copying'|'copied'|'unavailable'} Known state, failing closed to `unavailable`.
 */
export function normalizeCopyState(state) {
  return state === 'ready' || state === 'copying' || state === 'copied' ? state : 'unavailable';
}

/**
 * @typedef {object} ClipboardLike
 * @property {(text: string) => Promise<void>} writeText Writes text to the clipboard.
 */

/**
 * @typedef {object} CopyOutcome
 * @property {'copied'|'unavailable'} state Projected copy state.
 * @property {string} reason Empty on success, otherwise the typed cause.
 */

/**
 * @returns {ClipboardLike | null} Ambient clipboard when one is installed, else null.
 */
function ambientClipboard() {
  try {
    const candidate = globalThis?.navigator?.clipboard ?? null;
    if (candidate && typeof candidate.writeText === 'function') return candidate;
  } catch {
    return null;
  }
  return null;
}

/**
 * @param {{ clipboard?: ClipboardLike | null }} [options={}] Injected clipboard; test
 * doubles land here. When omitted, `navigator.clipboard` is used when available.
 * @returns {{ copy: (capsuleId: unknown) => Promise<CopyOutcome> }} Copy action.
 */
export function createCopyCapsuleId({ clipboard } = {}) {
  const injected = clipboard === undefined ? null : clipboard;
  return {
    /**
     * @param {unknown} capsuleId Host-issued capsule id to copy.
     * @returns {Promise<CopyOutcome>} Never rejects.
     */
    async copy(capsuleId) {
      const checked = validateCapsuleId(capsuleId);
      if (checked.ok === false) {
        return { state: 'unavailable', reason: checked.error.code };
      }
      const target = injected ?? ambientClipboard();
      if (!target) {
        return { state: 'unavailable', reason: 'ERR_CLIPBOARD_UNAVAILABLE' };
      }
      try {
        await target.writeText(checked.id);
      } catch {
        return { state: 'unavailable', reason: 'ERR_CLIPBOARD_WRITE_REFUSED' };
      }
      return { state: 'copied', reason: '' };
    },
  };
}
