/**
 * @file Wall tile states: the seven display states of a capsule tile.
 * Pure module, dependency-free: node:test imports this file directly and the
 * SurfacePanel setup script shares its mapping, so it must stay free of
 * framework calls, host access and external loads.
 */

/** @typedef {{ code: string, message: string }} TileAdmissionError */
/** @typedef {{ id: string, surfaceId: string, backendLifecycle: string, generation: number, visibility: string, control: string, controlOwner?: string, aiSessionActivity?: string, dispatchOutcome?: string, attachmentState?: string, refusal?: TileAdmissionError|null }} TileSurfaceRow */
/** @typedef {{ schema: string, epoch: number, revision: number, query: string, projection: { rows: readonly TileSurfaceRow[] } }} TileProjectionEnvelope */
/** @typedef {{ status: string, stale: boolean, envelope: TileProjectionEnvelope|null, error: TileAdmissionError|null }} TileProjectionSnapshot */
/** @typedef {Readonly<{ tile: string, status: string, controlVerb: string, keepsCapturing: boolean }>} TileDecision */

/**
 * The seven wall tile states: connecting / live / folded (keeps capturing) /
 * human-control / agent-acting / lost / error. Frozen, never extended locally.
 */
export const TILE_STATES = Object.freeze([
  'connecting',
  'live',
  'folded',
  'human-control',
  'agent-acting',
  'lost',
  'error',
]);

/** Lifecycles whose capture pipeline keeps running behind the tile. */
export const CAPTURING_LIFECYCLES = Object.freeze(['active', 'standby', 'ceded']);

/** Attachment phases that mean the live binding is not established yet. */
export const CONNECTING_ATTACHMENTS = Object.freeze(['attaching', 'restoring']);

/**
 * AI session activities that mean the agent is currently acting on the tile.
 * Waiting, exited and failed sessions are explicitly not acting: the agent
 * is blocked on the operator or done, so a shared tile stays plain live.
 */
export const AGENT_ACTING_ACTIVITIES = Object.freeze(['busy']);

/**
 * Proposal outcomes that mean the agent has an action in flight on the tile.
 * Settled or terminal outcomes (`none`, `completed-unverified`, `verified`,
 * `refused`, `uncertain`, `cancelled`) are explicitly not acting: the run is
 * over or never started, so the chip must not claim motion.
 */
export const AGENT_ACTING_OUTCOMES = Object.freeze(['admitting', 'accepted', 'executing']);

/** Verbs the wall may request on the control axis. */
export const CONTROL_VERBS = Object.freeze(['take_control', 'release_control']);

export const TILE_INVALID_STATE = 'ERR_TILE_INVALID_STATE';

/** Display-safe status for the error tile; the raw refusal code never renders. */
export const TILE_ERROR_DISPLAY_STATUS = 'Surface update unavailable';

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTileState(value) {
  return typeof value === 'string' && TILE_STATES.includes(value);
}

/**
 * Capture continues behind every drawable lifecycle, including folded tiles
 * and refused control requests; only terminal or unknown lifecycles stop it.
 * @param {TileSurfaceRow|null} row
 * @returns {boolean}
 */
export function isCapturingRow(row) {
  return row !== null && CAPTURING_LIFECYCLES.includes(row.backendLifecycle);
}

/**
 * Fold/presentation axis over control ownership for an admitted live row:
 * folded wins (capture continues), then the exclusive owner when the row
 * carries one (falling back to the surface control for rows that predate
 * it), then a busy AI session on shared control, else plain live.
 * @param {TileSurfaceRow|null} row
 * @returns {string}
 */
export function controlAxisTile(row) {
  if (row?.visibility === 'folded') return 'folded';
  const owner = row?.controlOwner;
  const control = owner === 'human' || owner === 'agent' ? owner : row?.control;
  if (control === 'human') return 'human-control';
  if (control === 'agent') return 'agent-acting';
  if (typeof row?.aiSessionActivity === 'string'
    && AGENT_ACTING_ACTIVITIES.includes(row.aiSessionActivity)) {
    return 'agent-acting';
  }
  return 'live';
}

/**
 * Acting evidence for the agent chip. The tile state stays on the control
 * axis (an agent-owned tile is `agent-acting` whatever the agent does), but
 * the chip copy claims motion only with evidence: a busy AI session, an
 * in-flight proposal outcome, or — when the row projects neither signal —
 * exclusive agent ownership derived from what the live host provides. The
 * authority feed carries no activity or dispatch fields, so a live row with
 * no finer signal and the agent holding the surface reads acting; any
 * present-but-quiet signal (ready session, settled proposal) reads ready.
 * @param {TileSurfaceRow|null} row
 * @returns {boolean}
 */
export function isAgentActingRow(row) {
  if (row === null || typeof row !== 'object') return false;
  if (typeof row.aiSessionActivity === 'string'
    && AGENT_ACTING_ACTIVITIES.includes(row.aiSessionActivity)) {
    return true;
  }
  if (typeof row.dispatchOutcome === 'string'
    && AGENT_ACTING_OUTCOMES.includes(row.dispatchOutcome)) {
    return true;
  }
  if (row.aiSessionActivity === undefined && row.dispatchOutcome === undefined) {
    const owner = row.controlOwner;
    const control = owner === 'human' || owner === 'agent' ? owner : row.control;
    return control === 'agent';
  }
  return false;
}

/**
 * Latest admitted frame identity for one row: `Frame <generation>`, or the
 * empty string when no frame was ever admitted. The generation is the
 * authority-issued frame generation from the notice, never a rendered-frame
 * count; callers decide which tiles display it.
 * @param {TileSurfaceRow|null|undefined} row
 * @returns {string}
 */
export function frameFreshnessText(row) {
  const generation = row?.generation;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) return '';
  return `Frame ${generation}`;
}

/**
 * Presented-frame witness for one tile scheduler: the opaque handle of the
 * last frame the scheduler presented for this surface lifetime, or the
 * empty string when the scheduler affirmatively reports nothing presented
 * (unknown surface, stale generation or epoch, terminal flags, empty
 * handle), or null when presentation is unknowable (no scheduler API,
 * unreadable or malformed instrumentation, refused read). Callers hide the
 * Frame badge on the empty string so it never shares the tile with the
 * waiting placeholder; null keeps the admitted-generation badge.
 * @param {unknown} scheduler
 * @param {string} capsuleId
 * @param {unknown} generation
 * @param {unknown} epoch
 * @returns {string|null}
 */
export function presentedFrameHandle(scheduler, capsuleId, generation, epoch) {
  if (scheduler === null || typeof scheduler !== 'object') return null;
  const reader = /** @type {{ getInstrumentation?: unknown }} */ (scheduler);
  if (typeof reader.getInstrumentation !== 'function') return null;
  /** @type {unknown} */
  let info;
  try {
    info = reader.getInstrumentation(capsuleId);
  } catch {
    return null;
  }
  if (info === null || info === undefined) return '';
  if (typeof info !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (info);
  if (record.destroyed === true || record.contextLost === true) return '';
  if (!('lastPresentedHandle' in record)) return '';
  if (record.surfaceGeneration !== generation || record.epoch !== epoch) return '';
  return typeof record.lastPresentedHandle === 'string' ? record.lastPresentedHandle : null;
}

/**
 * Resolve one control verb. An explicit asked verb wins (bare or kit
 * `surface_request.*` namespaced). A missing verb only requests take_control;
 * releasing control requires an explicit request, including on agent rows.
 * @param {TileSurfaceRow|null} row
 * @param {unknown} asked
 * @returns {string}
 */
export function controlVerbForRow(row, asked) {
  if (asked === 'take_control' || asked === 'surface_request.take_control') {
    return 'take_control';
  }
  if (asked === 'release_control' || asked === 'surface_request.release_control') {
    return 'release_control';
  }
  return 'take_control';
}

/**
 * @param {TileDecision} decision
 * @returns {TileDecision}
 */
function freezeTile(decision) {
  return Object.freeze({ ...decision });
}

/**
 * Raw refusal code behind a snapshot/row pair, or null when no typed refusal
 * applies. Dedicated accessor so consumers never parse `status` text.
 * @param {TileProjectionSnapshot|null} snapshot
 * @param {TileSurfaceRow|null} row
 * @returns {string|null}
 */
export function refusalCodeFor(snapshot, row) {
  const refusal = row?.refusal ?? snapshot?.error ?? null;
  const code = refusal !== null && typeof refusal === 'object' ? refusal.code : null;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * Derive one tile decision from the authoritative snapshot and row.
 * Precedence: typed refusal / error transport > unavailable transport >
 * departed row with resident live/stale feed (lost) > terminal lifecycle (lost) > unknown
 * lifecycle or missing row (connecting/Waiting, never live) > stale transport
 * (Stale) > non-live transport (connecting/Waiting) > attaching binding
 * (connecting/Connecting) > fold/control axis (Live). Status labels stay
 * identical to the panel status derivation for every shared case.
 * The error status keeps the coded `Refused: <code>` form for that parity;
 * render TILE_ERROR_DISPLAY_STATUS and read refusalCodeFor instead of
 * parsing the status.
 * @param {TileProjectionSnapshot|null} snapshot
 * @param {TileSurfaceRow|null} row
 * @param {TileSurfaceRow|null} [lastRow] Last admitted row for the current binding only.
 * @returns {TileDecision}
 */
export function deriveTileState(snapshot, row, lastRow = null) {
  const code = refusalCodeFor(snapshot, row);
  if (code !== null || snapshot?.status === 'error') {
    return freezeTile({
      tile: 'error',
      status: code !== null ? `Refused: ${code}` : TILE_ERROR_DISPLAY_STATUS,
      controlVerb: controlVerbForRow(row, null),
      keepsCapturing: isCapturingRow(row),
    });
  }
  if (snapshot?.status === 'unavailable') {
    return freezeTile({
      tile: 'connecting', status: 'Waiting', controlVerb: controlVerbForRow(row, null), keepsCapturing: false,
    });
  }
  if (row === null && lastRow !== null && snapshot?.envelope != null
    && (snapshot.status === 'live' || snapshot.status === 'stale')) {
    return freezeTile({
      tile: 'lost', status: 'Lost', controlVerb: controlVerbForRow(lastRow, null), keepsCapturing: false,
    });
  }
  const lifecycle = row?.backendLifecycle ?? null;
  if (lifecycle === 'destroyed') {
    return freezeTile({
      tile: 'lost', status: 'Destroyed', controlVerb: controlVerbForRow(row, null), keepsCapturing: false,
    });
  }
  if (lifecycle === 'lost') {
    return freezeTile({
      tile: 'lost', status: 'Lost', controlVerb: controlVerbForRow(row, null), keepsCapturing: false,
    });
  }
  if (typeof lifecycle !== 'string' || !CAPTURING_LIFECYCLES.includes(lifecycle)) {
    return freezeTile({
      tile: 'connecting',
      status: 'Waiting',
      controlVerb: controlVerbForRow(row, null),
      keepsCapturing: false,
    });
  }
  if (snapshot?.status === 'stale' || snapshot?.stale === true) {
    return freezeTile({
      tile: controlAxisTile(row),
      status: 'Stale',
      controlVerb: controlVerbForRow(row, null),
      keepsCapturing: true,
    });
  }
  if (!(snapshot?.status === 'live' && snapshot.envelope !== null && row !== null)) {
    return freezeTile({
      tile: 'connecting',
      status: 'Waiting',
      controlVerb: controlVerbForRow(row, null),
      keepsCapturing: false,
    });
  }
  if (typeof row.attachmentState === 'string'
    && CONNECTING_ATTACHMENTS.includes(row.attachmentState)) {
    return freezeTile({
      tile: 'connecting',
      status: 'Connecting',
      controlVerb: controlVerbForRow(row, null),
      keepsCapturing: true,
    });
  }
  return freezeTile({
    tile: controlAxisTile(row),
    status: 'Live',
    controlVerb: controlVerbForRow(row, null),
    keepsCapturing: true,
  });
}
