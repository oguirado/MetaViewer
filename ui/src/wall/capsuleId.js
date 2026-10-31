/**
 * @file Wall tile capsule identifier: the short visible id, the "Copy ID for
 * AI" ready line and the transient copy confirmation (FEEDBACK row 7, pillar
 * P2). Pure module with no imports: node:test imports it directly and
 * TileCaptureChrome reaches it through the `tileCapture.js` re-export (the
 * chrome's single pure-module import), so it must stay free of framework
 * calls and host access. The renderer stays display-only: it formats host-issued ids
 * and writes one string to an injected clipboard; it never builds a path,
 * reads the environment or launches anything.
 *
 * [TARGET, unit decision] Attach contract. The PKG-FIX attach pointer
 * (`$XDG_RUNTIME_DIR/metaviewer/attach/current.env`, schema
 * `metaviewer.attach/v1`, published while the packaged app is live and
 * retracted on stop) is not on this branch yet. The ready line therefore
 * names the documented usage from `docs/AGENT_ENTRY.md` (`python3 -m
 * metaviewer_agents.mw_run --identity <id> --site <site> --workflow
 * <workflow>` from the agents directory) and the pointer by its documented
 * name; the line carries no host path, so it is identical in dev and
 * packaged runs. `<site>` and `<workflow>` stay placeholders the AI picks
 * from MemoryWeb data. The line never invents an identity: with no usable
 * `profile_id` it carries the capsule id only and says so.
 */
/** Host-issued surface id grammar: contract surface_id (1..128 [CITED]) narrowed to prompt- and shell-safe characters. */
export const CAPSULE_SURFACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Identity (profile) grammar the adapter and mw_run admit; anything else is never put in a command. */
export const CAPSULE_IDENTITY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Visible id: ids up to this length render whole, longer ones middle-ellipsize [TARGET]. */
export const CAPSULE_ID_SHORT_MAX = 14;
/** The transient "Copied" confirmation clears after this many ms [TARGET]. */
export const CAPSULE_COPY_CONFIRM_MS = 2000;
/** Upper bound of the copied line, well inside the host clipboard bound of 16384 bytes [CITED]. */
export const CAPSULE_READY_LINE_MAX_BYTES = 4096;
/** Closed copy states, aligned with the multislot copy states. */
export const CAPSULE_COPY_STATES = Object.freeze(['ready', 'copying', 'copied', 'unavailable']);
/** Tile states whose capsule cannot be managed: the id stays visible, the copy is disabled. */
export const CAPSULE_COPY_BLOCKED_TILES = Object.freeze(['lost', 'error']);

export const CAPSULE_COPY_LABEL = 'Copy ID for AI';
export const CAPSULE_COPIED_TEXT = 'Copied';
export const CAPSULE_COPY_FAILED_TEXT = 'Copy unavailable';

/**
 * @param {unknown} id
 * @returns {boolean} True for a host-issued id that is safe to display and to put in a line.
 */
export function isCapsuleSurfaceId(id) {
  return typeof id === 'string' && CAPSULE_SURFACE_ID_RE.test(id);
}

/**
 * @param {unknown} id
 * @returns {boolean} True for an identity name admitted in a command.
 */
export function isCapsuleIdentity(id) {
  return typeof id === 'string' && CAPSULE_IDENTITY_RE.test(id);
}

/**
 * Short readable form: whole when it fits, otherwise head, ellipsis, tail.
 * The full id is always available on hover and in the accessible name.
 * @param {unknown} id Host-issued surface id.
 * @returns {string} Display text (empty for a non-string).
 */
export function shortCapsuleId(id) {
  if (typeof id !== 'string') return '';
  if (id.length <= CAPSULE_ID_SHORT_MAX) return id;
  return `${id.slice(0, 8)}…${id.slice(-5)}`;
}

/**
 * Builds the line an AI in a terminal receives. Closed inputs only: a
 * non-grammar surface id yields null (nothing to copy); an absent or
 * non-grammar identity yields an id-only line with no command.
 * @param {{ surfaceId?: unknown, profileId?: unknown }} input
 * @returns {string|null} Single-line ready text, or null when the id is unusable.
 */
export function buildCapsuleReadyLine(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const surfaceId = /** @type {{ surfaceId?: unknown }} */ (source).surfaceId;
  const profileId = /** @type {{ profileId?: unknown }} */ (source).profileId;
  if (!isCapsuleSurfaceId(surfaceId)) return null;
  if (!isCapsuleIdentity(profileId)) {
    return `MetaViewer capsule ${surfaceId}. The host reported no usable identity name for this capsule, `
      + 'so no command is given: ask the operator for the identity name and never guess it.';
  }
  return `MetaViewer capsule ${surfaceId} (identity ${profileId}). Manage only this capsule, with the operator present. `
    + 'In a subshell source "$XDG_RUNTIME_DIR/metaviewer/attach/current.env" '
    + '(published while MetaViewer is running; ignore it if its pid is not running), '
    + 'then from "$MV_OPERATOR_REPO/agents" run: '
    + `python3 -m metaviewer_agents.mw_run --identity ${profileId} --site <site> --workflow <workflow> [--slot name=value]. `
    + 'Choose the site and workflow from MemoryWeb data. Read the single JSON result line and accept success only on rc 0 '
    + 'with the verified run summary. Stop on any refusal or HUMAN_HANDOFF. '
    + 'Never solve a CAPTCHA, type credentials, retry a send or change the network mode.';
}

/**
 * Display model of the tile id chip.
 * @param {{ surfaceId?: unknown, profileId?: unknown, tile?: unknown }} input
 * @returns {Readonly<{ visible: boolean, text: string, hover: string, copyName: string,
 *   canCopy: boolean, blockedReason: string }>} Closed model; `visible` is false for an unusable id.
 */
export function capsuleIdModel(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const surfaceId = /** @type {{ surfaceId?: unknown }} */ (source).surfaceId;
  const profileId = /** @type {{ profileId?: unknown }} */ (source).profileId;
  const tile = /** @type {{ tile?: unknown }} */ (source).tile;
  if (!isCapsuleSurfaceId(surfaceId)) {
    return Object.freeze({ visible: false, text: '', hover: '', copyName: '', canCopy: false, blockedReason: '' });
  }
  const id = /** @type {string} */ (surfaceId);
  const identity = isCapsuleIdentity(profileId) ? ` · Identity: ${profileId}` : '';
  const blocked = typeof tile === 'string' && CAPSULE_COPY_BLOCKED_TILES.includes(tile);
  return Object.freeze({
    visible: true,
    text: shortCapsuleId(id),
    hover: `Capsule ID: ${id}${identity}`,
    copyName: `${CAPSULE_COPY_LABEL}: capsule ${id}`,
    canCopy: !blocked,
    blockedReason: blocked ? `Capsule is ${tile}; nothing to manage` : '',
  });
}

/**
 * @typedef {object} CapsuleClipboardLike
 * @property {(text: string) => Promise<unknown>|unknown} writeText
 */

/**
 * @returns {CapsuleClipboardLike|null} The ambient clipboard when one exists, else null.
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
 * Reports whether a copy attempt can reach any clipboard.
 * @param {CapsuleClipboardLike|null|undefined} clipboard Injected clipboard (host or test double).
 * @returns {boolean}
 */
export function capsuleCopyAvailable(clipboard) {
  if (clipboard !== null && clipboard !== undefined) return typeof clipboard.writeText === 'function';
  return ambientClipboard() !== null;
}

/**
 * Copies the ready line. Never throws; every outcome is a projected state.
 * @param {{ surfaceId?: unknown, profileId?: unknown }} ids Host-issued ids.
 * @param {CapsuleClipboardLike|null|undefined} clipboard Injected clipboard; falls back to the ambient one.
 * @returns {Promise<{ state: 'copied'|'unavailable', reason: string, text: string }>}
 */
export async function copyCapsuleReadyLine(ids, clipboard) {
  const text = buildCapsuleReadyLine(ids);
  if (text === null) return { state: 'unavailable', reason: 'ERR_CAPSULE_ID_INVALID', text: '' };
  if (utf8ByteLength(text) > CAPSULE_READY_LINE_MAX_BYTES) {
    return { state: 'unavailable', reason: 'ERR_CAPSULE_LINE_TOO_LARGE', text: '' };
  }
  const injected = clipboard !== null && clipboard !== undefined && typeof clipboard.writeText === 'function'
    ? clipboard : null;
  const target = injected ?? ambientClipboard();
  if (!target) return { state: 'unavailable', reason: 'ERR_CLIPBOARD_UNAVAILABLE', text: '' };
  try {
    await target.writeText(text);
  } catch {
    return { state: 'unavailable', reason: 'ERR_CLIPBOARD_WRITE_REFUSED', text: '' };
  }
  return { state: 'copied', reason: '', text };
}

/** @param {string} value UTF-8 byte length without a Node-only global. */
function utf8ByteLength(value) {
  return new TextEncoder().encode(value).length;
}

/**
 * Transient copy confirmation: `copying` while the write is pending, then
 * `copied` or `unavailable` until the timer returns the control to `ready`.
 * A new run replaces the previous timer; `dispose` clears it.
 * @param {(state: string, reason: string) => void} onState Receives every state change.
 * @param {{ setTimer?: (fn: () => void, ms: number) => unknown, clearTimer?: (handle: unknown) => void, delayMs?: number }} [options]
 * @returns {{ run: (copy: () => Promise<{ state: string, reason: string }>) => Promise<void>, dispose: () => void }}
 */
export function createCapsuleCopyFeedback(onState, options = {}) {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(/** @type {any} */ (handle)));
  const delayMs = options.delayMs ?? CAPSULE_COPY_CONFIRM_MS;
  /** @type {unknown} */
  let timer = null;
  let generation = 0;
  let disposed = false;
  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  return {
    async run(copy) {
      if (disposed) return;
      stopTimer();
      generation += 1;
      const mine = generation;
      onState('copying', '');
      let outcome;
      try {
        outcome = await copy();
      } catch {
        outcome = { state: 'unavailable', reason: 'ERR_CLIPBOARD_WRITE_REFUSED' };
      }
      if (disposed || mine !== generation) return;
      const state = outcome?.state === 'copied' ? 'copied' : 'unavailable';
      onState(state, state === 'copied' ? '' : String(outcome?.reason ?? ''));
      timer = setTimer(() => {
        timer = null;
        if (!disposed && mine === generation) onState('ready', '');
      }, delayMs);
    },
    dispose() {
      disposed = true;
      stopTimer();
    },
  };
}
