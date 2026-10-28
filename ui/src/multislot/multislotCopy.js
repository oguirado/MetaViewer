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
import { TERMINAL_COPYTEXT_TEXT_RE } from '../terminal/sideTerminalFacade.js';

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
 * Reports whether the host `copyText` would admit the text (MVUI29c lane
 * T): the fixed host API accepts only the closed copytext grammar and
 * refuses anything else with `ERR_CLIPBOARD_INVALID`. The copy action and
 * the slot control check this before calling, so an off-grammar capsule
 * id disables the control with a reason instead of reaching the host.
 *
 * @param {unknown} text Candidate text.
 * @returns {boolean} True when the text matches the host grammar.
 */
export function isCopyTextAllowed(text) {
  return typeof text === 'string' && TERMINAL_COPYTEXT_TEXT_RE.test(text);
}

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
 * @typedef {object} CopyPorts
 * @property {ClipboardLike | null | undefined} [clipboard] Injected clipboard;
 * test doubles land here.
 * @property {((text: string) => Promise<unknown>) | null | undefined} [copyText]
 * Fixed-API clipboard path: used when no clipboard is injected.
 */

/**
 * Reports whether any copy path is currently available: the injected
 * clipboard, the fixed-API copyText, or the ambient clipboard. Synchronous
 * so the host can disable the control with a reason before the first copy.
 *
 * @param {CopyPorts} [options={}] Copy ports to probe.
 * @returns {boolean} True when a copy attempt can reach a clipboard.
 */
export function copyAvailable({ clipboard, copyText } = {}) {
  if (clipboard !== null && clipboard !== undefined) {
    return typeof clipboard.writeText === 'function';
  }
  if (typeof copyText === 'function') return true;
  return ambientClipboard() !== null;
}

/**
 * @param {CopyPorts} [options={}] Injected clipboard; test doubles land here.
 * When omitted, the fixed-API copyText runs next and `navigator.clipboard`
 * is used when available.
 * @returns {{ copy: (capsuleId: unknown) => Promise<CopyOutcome> }} Copy action.
 */
export function createCopyCapsuleId({ clipboard, copyText } = {}) {
  const injected = clipboard !== null && clipboard !== undefined && typeof clipboard.writeText === 'function'
    ? clipboard
    : null;
  const hostCopy = typeof copyText === 'function' ? copyText : null;
  const hostCopyTarget = hostCopy ? { writeText: hostCopy } : null;
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
      // The host admits only copytext-grammar text: check before calling
      // so the typed code is projected without touching any target.
      if (!isCopyTextAllowed(checked.id)) {
        return { state: 'unavailable', reason: 'ERR_CLIPBOARD_INVALID' };
      }
      const target = injected ?? hostCopyTarget ?? ambientClipboard();
      if (!target) {
        return { state: 'unavailable', reason: 'ERR_CLIPBOARD_UNAVAILABLE' };
      }
      try {
        await target.writeText(checked.id);
      } catch (error) {
        // The fixed-API host refuses non-id text with its typed code; that
        // code travels in the reason (never in visible text), while every
        // other failure keeps the generic write refusal.
        if (target === hostCopyTarget && /\bERR_CLIPBOARD_INVALID\b/.test(String(error))) {
          return { state: 'unavailable', reason: 'ERR_CLIPBOARD_INVALID' };
        }
        return { state: 'unavailable', reason: 'ERR_CLIPBOARD_WRITE_REFUSED' };
      }
      return { state: 'copied', reason: '' };
    },
  };
}
