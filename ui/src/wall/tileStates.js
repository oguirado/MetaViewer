/**
 * @file Wall tile states: the seven display states of a capsule tile.
 * Pure module, dependency-free: node:test imports this file directly and the
 * SurfacePanel setup script shares its mapping, so it must stay free of
 * framework calls, host access and external loads.
 */

/** @typedef {{ code: string, message: string }} TileAdmissionError */
/** @typedef {{ id: string, surfaceId: string, backendLifecycle: string, generation: number, visibility: string, control: string, attachmentState?: string, refusal?: TileAdmissionError|null }} TileSurfaceRow */
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
 * folded wins (capture continues), then human, then agent, else plain live.
 * @param {TileSurfaceRow|null} row
 * @returns {string}
 */
export function controlAxisTile(row) {
  if (row?.visibility === 'folded') return 'folded';
  if (row?.control === 'human') return 'human-control';
  if (row?.control === 'agent') return 'agent-acting';
  return 'live';
}

/**
 * Resolve one control verb. An explicit asked verb wins (bare or kit
 * `surface_request.*` namespaced); otherwise the authoritative row control
 * decides, defaulting to take_control when no row is bound.
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
  return row?.control === 'agent' ? 'release_control' : 'take_control';
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
 * Precedence: typed refusal (error) > terminal lifecycle (lost) > unknown
 * lifecycle or missing row (connecting/Waiting, never live) > stale transport
 * (Stale) > non-live transport (connecting/Waiting) > attaching binding
 * (connecting/Connecting) > fold/control axis (Live). Status labels stay
 * identical to the panel status derivation for every shared case.
 * The error status keeps the coded `Refused: <code>` form for that parity;
 * render TILE_ERROR_DISPLAY_STATUS and read refusalCodeFor instead of
 * parsing the status.
 * @param {TileProjectionSnapshot|null} snapshot
 * @param {TileSurfaceRow|null} row
 * @returns {TileDecision}
 */
export function deriveTileState(snapshot, row) {
  const code = refusalCodeFor(snapshot, row);
  if (code !== null) {
    return freezeTile({
      tile: 'error',
      status: `Refused: ${code}`,
      controlVerb: controlVerbForRow(row, null),
      keepsCapturing: isCapturingRow(row),
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
