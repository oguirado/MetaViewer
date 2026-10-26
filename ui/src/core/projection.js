/**
 * @file Wall projection admission: strict decode plus a read-only view.
 *
 * Presentation only; the core owns authority. Every raw ingress runs the
 * injected decoder first, then the shared kit admission on both the push and
 * the initial-response path. Decoder refusals preserve the last-good
 * snapshot visibly stale. Components receive only the frozen view.
 * @module projection
 */
import { createPublicProjectionCoordinator } from '../../.kit/capsule-ui-kit/src/state/publicProjection.js';

/**
 * @typedef {Readonly<{ code: string, message: string }>} AdmissionError
 */

/**
 * @template T
 * @typedef {Readonly<{ ok: true, value: T }> | Readonly<{ ok: false, error: AdmissionError }>} AdmissionResult
 */

/** @typedef {Readonly<{ maxBytes: number, maxDepth: number, maxKeys: number, maxStringLength: number, maxBatchRows: number }>} IngressLimits */

/** @typedef {'unknown' | 'ready' | 'busy' | 'waiting-input' | 'waiting-permission' | 'exited' | 'failed'} KitActivity */

/** @typedef {'detached' | 'attaching' | 'restoring' | 'live' | 'disconnected'} KitAttachment */

/** @typedef {'none' | 'admitting' | 'accepted' | 'executing' | 'completed-unverified' | 'verified' | 'refused' | 'uncertain' | 'cancelled'} KitOutcome */

/**
 * @typedef {Readonly<{
 *   id: string,
 *   surfaceId: string,
 *   backendLifecycle: 'active' | 'standby' | 'ceded' | 'destroyed' | 'lost',
 *   generation: number,
 *   visibility: 'folded' | 'unfolded' | 'pinned',
 *   control: 'agent' | 'human' | 'shared',
 *   title?: string,
 *   aiSessionActivity?: KitActivity,
 *   attachmentState?: KitAttachment,
 *   dispatchOutcome?: KitOutcome,
 *   refusal?: AdmissionError | null
 * }>} WallSurfaceRow
 */

/**
 * @typedef {Readonly<{
 *   rows?: readonly WallSurfaceRow[],
 *   upsertRows?: readonly WallSurfaceRow[],
 *   removeRowIds?: readonly string[]
 * }>} ProjectionPayload
 */

/**
 * Local normalized adapter shape produced by the injected decoder.
 * @typedef {Readonly<{
 *   schema: string,
 *   epoch: number,
 *   revision: number,
 *   durableRevision?: number | null,
 *   baseRevision?: number,
 *   mode?: 'snapshot' | 'delta',
 *   query: string,
 *   projection: ProjectionPayload
 * }>} ProjectionEnvelope
 */

/**
 * @typedef {Readonly<{
 *   status: 'unavailable' | 'live' | 'stale',
 *   stale: boolean,
 *   ramRevision: number | null,
 *   durableRevision: number | null,
 *   envelope: ProjectionEnvelope | null,
 *   error: AdmissionError | null
 * }>} ProjectionSnapshot
 */

/**
 * @typedef {Readonly<{ ok: true, snapshot: ProjectionSnapshot }> | Readonly<{ ok: false, error: AdmissionError, snapshot: ProjectionSnapshot }>} AdmissionOutcome
 */

/**
 * @typedef {Readonly<{
 *   allowedSchemas: readonly string[],
 *   limits: IngressLimits,
 *   decode: (raw: unknown, limits: IngressLimits) => AdmissionResult<ProjectionEnvelope>
 * }>} WallProjectionOptions
 */

/**
 * @typedef {Readonly<{
 *   getSnapshot: () => ProjectionSnapshot,
 *   getProjection: () => ProjectionPayload | null,
 *   getAllowedSchemas: () => readonly string[],
 *   reconcileSelection: (ids: readonly string[]) => Readonly<{ validIds: readonly string[], removedIds: readonly string[] }>,
 *   subscribe: (listener: (snapshot: ProjectionSnapshot) => void) => () => void
 * }>} ProjectionView
 */

/**
 * @typedef {Readonly<{
 *   beginSession: (params: { query: string, epoch: number, onUnsubscribe?: () => void }) => Readonly<{ generation: number, query: string, epoch: number, subscriptionReady: boolean, active: boolean }>,
 *   markSubscriptionReady: (generation: number) => { ok: boolean, error?: AdmissionError },
 *   canRequestSnapshot: (generation: number) => boolean,
 *   admitInitialResponse: (raw: unknown, meta: { generation: number }) => AdmissionOutcome,
 *   admitPush: (raw: unknown, meta: { generation: number }) => AdmissionOutcome,
 *   invalidateSession: (reason?: string) => number,
 *   getView: () => ProjectionView,
 *   dispose: () => void
 * }>} WallProjectionController
 */

const BACKEND_LIFECYCLES = Object.freeze(['active', 'standby', 'ceded', 'destroyed', 'lost']);
const VISIBILITIES = Object.freeze(['folded', 'unfolded', 'pinned']);
const CONTROLS = Object.freeze(['agent', 'human', 'shared']);
const KIT_ACTIVITIES = Object.freeze([
  'unknown',
  'ready',
  'busy',
  'waiting-input',
  'waiting-permission',
  'exited',
  'failed',
]);
const KIT_ATTACHMENTS = Object.freeze(['detached', 'attaching', 'restoring', 'live', 'disconnected']);
const KIT_OUTCOMES = Object.freeze([
  'none',
  'admitting',
  'accepted',
  'executing',
  'completed-unverified',
  'verified',
  'refused',
  'uncertain',
  'cancelled',
]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isPositiveSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {AdmissionError}
 */
function admissionError(code, message) {
  return Object.freeze({ code, message });
}

/**
 * @param {AdmissionError} error
 * @param {ProjectionSnapshot} snapshot
 * @returns {AdmissionOutcome}
 */
function refusedOutcome(error, snapshot) {
  return /** @type {AdmissionOutcome} */ (Object.freeze({ ok: false, error, snapshot }));
}

/**
 * @param {ProjectionSnapshot} snapshot
 * @returns {AdmissionOutcome}
 */
function admittedOutcome(snapshot) {
  return /** @type {AdmissionOutcome} */ (Object.freeze({ ok: true, snapshot }));
}

/**
 * Creates the wall projection controller. Options are fully validated before
 * any session exists: schemas, limits and decode have no defaults.
 * @param {WallProjectionOptions} options
 * @returns {WallProjectionController}
 */
export function createWallProjection(options) {
  if (!isRecord(options)) {
    throw new TypeError('[ERR_INVALID_OPTIONS] wall projection options must be a plain object');
  }
  const { allowedSchemas, limits, decode } = options;
  if (
    !Array.isArray(allowedSchemas) ||
    allowedSchemas.length === 0 ||
    !allowedSchemas.every((schema) => typeof schema === 'string' && schema.length > 0)
  ) {
    throw new TypeError(
      '[ERR_INVALID_ALLOWED_SCHEMAS] allowedSchemas must be a non-empty array of non-empty strings',
    );
  }
  if (!isRecord(limits)) {
    throw new TypeError('[ERR_INVALID_INGRESS_LIMITS] limits must be a plain object');
  }
  const maxBytes = limits.maxBytes;
  const maxDepth = limits.maxDepth;
  const maxKeys = limits.maxKeys;
  const maxStringLength = limits.maxStringLength;
  const maxBatchRows = limits.maxBatchRows;
  if (
    !isPositiveSafeInteger(maxBytes) ||
    !isPositiveSafeInteger(maxDepth) ||
    !isPositiveSafeInteger(maxKeys) ||
    !isPositiveSafeInteger(maxStringLength) ||
    !isPositiveSafeInteger(maxBatchRows)
  ) {
    throw new TypeError(
      '[ERR_INVALID_INGRESS_LIMITS] limits must carry five positive safe integers',
    );
  }
  if (typeof decode !== 'function') {
    throw new TypeError('[ERR_MISSING_DECODE] decode must be a (raw, limits) admission function');
  }
  const frozenLimits = Object.freeze({ maxBytes, maxDepth, maxKeys, maxStringLength, maxBatchRows });
  const coordinator = createPublicProjectionCoordinator({
    allowedSchemas: Object.freeze(allowedSchemas.slice()),
  });
  const kitView = coordinator.getView();

  /** @type {AdmissionError | null} */
  let overlayError = null;
  /** @type {boolean} */
  let disposed = false;
  /** @type {ProjectionSnapshot | null} */
  let published = null;
  /** @type {Set<(snapshot: ProjectionSnapshot) => void>} */
  const listeners = new Set();

  /**
   * Current snapshot with any decoder refusal overlaid; the kit cannot
   * represent a refusal that never reaches its admission.
   * @returns {ProjectionSnapshot}
   */
  function currentSnapshot() {
    const base = kitView.getSnapshot();
    if (overlayError === null) {
      return /** @type {ProjectionSnapshot} */ (base);
    }
    const resident = base.envelope !== null;
    return Object.freeze({
      status: resident ? 'stale' : 'unavailable',
      stale: resident,
      ramRevision: base.ramRevision,
      durableRevision: base.durableRevision,
      envelope: /** @type {ProjectionEnvelope | null} */ (base.envelope),
      error: overlayError,
    });
  }

  function notify() {
    published = currentSnapshot();
    for (const listener of listeners) {
      listener(published);
    }
  }

  const stopForward = kitView.subscribe(() => {
    notify();
  });

  /**
   * Single admission path shared by push and initial response.
   * @param {unknown} raw
   * @param {{ generation: number }} meta
   * @param {'initial-response' | 'push'} source
   * @returns {AdmissionOutcome}
   */
  function admit(raw, meta, source) {
    if (disposed) {
      return refusedOutcome(
        admissionError('ERR_DISPOSED', 'wall projection is disposed; late admission refused'),
        currentSnapshot(),
      );
    }
    if (!isRecord(meta) || !Number.isSafeInteger(meta.generation)) {
      throw new TypeError('[ERR_INVALID_META] admit requires meta { generation } with a safe integer');
    }
    const generation = /** @type {number} */ (meta.generation);
    const decoded = decode(raw, frozenLimits);
    if (!isRecord(decoded) || typeof decoded.ok !== 'boolean') {
      throw new TypeError('[ERR_INVALID_DECODER_RESULT] decode must return an admission result');
    }
    if (decoded.ok === false) {
      const failure = /** @type {unknown} */ (decoded.error);
      if (!isRecord(failure) || typeof failure.code !== 'string' || typeof failure.message !== 'string') {
        throw new TypeError('[ERR_INVALID_DECODER_RESULT] decoder refusal must carry code and message');
      }
      overlayError = admissionError(failure.code, failure.message);
      notify();
      return refusedOutcome(overlayError, /** @type {ProjectionSnapshot} */ (published));
    }
    overlayError = null;
    const outcome = source === 'push'
      ? coordinator.admitPush(decoded.value, { generation })
      : coordinator.admitInitialResponse(decoded.value, { generation });
    const snapshot = /** @type {ProjectionSnapshot} */ (published);
    if (outcome.ok) {
      return admittedOutcome(snapshot);
    }
    return refusedOutcome(admissionError(outcome.error.code, outcome.error.message), snapshot);
  }

  const view = Object.freeze({
    getSnapshot() {
      return currentSnapshot();
    },
    getProjection() {
      return /** @type {ProjectionPayload | null} */ (kitView.getProjection());
    },
    getAllowedSchemas() {
      return kitView.getAllowedSchemas();
    },
    /**
     * @param {readonly string[]} ids
     */
    reconcileSelection(ids) {
      return kitView.reconcileSelection(ids);
    },
    /**
     * @param {(snapshot: ProjectionSnapshot) => void} listener
     */
    subscribe(listener) {
      if (disposed) {
        throw new Error('[ERR_DISPOSED] wall projection is disposed');
      }
      if (typeof listener !== 'function') {
        throw new TypeError('Listener must be a function');
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });

  const controller = {
    /**
     * @param {{ query: string, epoch: number, onUnsubscribe?: () => void }} params
     */
    beginSession(params) {
      if (disposed) {
        throw new Error('[ERR_DISPOSED] wall projection is disposed');
      }
      return coordinator.beginSession(params);
    },
    /**
     * @param {number} generation
     */
    markSubscriptionReady(generation) {
      if (disposed) {
        return { ok: false, error: admissionError('ERR_DISPOSED', 'wall projection is disposed') };
      }
      return coordinator.markSubscriptionReady(generation);
    },
    /**
     * @param {number} generation
     */
    canRequestSnapshot(generation) {
      if (disposed) return false;
      return coordinator.canRequestSnapshot(generation);
    },
    /**
     * @param {unknown} raw
     * @param {{ generation: number }} meta
     */
    admitInitialResponse(raw, meta) {
      return admit(raw, meta, 'initial-response');
    },
    /**
     * @param {unknown} raw
     * @param {{ generation: number }} meta
     */
    admitPush(raw, meta) {
      return admit(raw, meta, 'push');
    },
    /**
     * @param {string} [reason]
     */
    invalidateSession(reason) {
      return coordinator.invalidateSession(typeof reason === 'string' ? reason : undefined);
    },
    getView() {
      return /** @type {ProjectionView} */ (view);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopForward();
      listeners.clear();
      overlayError = null;
      coordinator.invalidateSession('disposed');
    },
  };
  return /** @type {WallProjectionController} */ (Object.freeze(controller));
}

/**
 * Selects one exact surface row from a snapshot. Missing data refuses; no
 * lifecycle or generation default is ever invented.
 * @param {unknown} snapshot
 * @param {string} capsuleId
 * @returns {AdmissionResult<WallSurfaceRow>}
 */
export function selectWallSurface(snapshot, capsuleId) {
  if (typeof capsuleId !== 'string' || capsuleId.length === 0) {
    return /** @type {AdmissionResult<WallSurfaceRow>} */ (
      Object.freeze({
        ok: false,
        error: admissionError('ERR_INVALID_CAPSULE_ID', 'capsuleId must be a non-empty string'),
      })
    );
  }
  if (!isRecord(snapshot)) {
    return unavailable();
  }
  const envelope = snapshot.envelope;
  if (!isRecord(envelope)) {
    return unavailable();
  }
  const projection = envelope.projection;
  if (!isRecord(projection) || !Array.isArray(projection.rows)) {
    return unavailable();
  }
  /** @type {Record<string, unknown> | undefined} */
  let found;
  for (const row of projection.rows) {
    if (isRecord(row) && row.id === capsuleId) {
      found = row;
      break;
    }
  }
  if (found === undefined) {
    return /** @type {AdmissionResult<WallSurfaceRow>} */ (
      Object.freeze({
        ok: false,
        error: admissionError('ERR_UNKNOWN_SURFACE', `no admitted row for capsule "${capsuleId}"`),
      })
    );
  }
  if (found.surfaceId !== capsuleId) {
    return malformedRow('row id and surfaceId diverge');
  }
  const lifecycle = found.backendLifecycle;
  const visibility = found.visibility;
  const control = found.control;
  if (
    typeof lifecycle !== 'string' ||
    !BACKEND_LIFECYCLES.includes(lifecycle) ||
    !isPositiveSafeInteger(found.generation) ||
    typeof visibility !== 'string' ||
    !VISIBILITIES.includes(visibility) ||
    typeof control !== 'string' ||
    !CONTROLS.includes(control)
  ) {
    return malformedRow('row misses required lifecycle, generation, visibility or control');
  }
  if (found.title !== undefined && typeof found.title !== 'string') {
    return malformedRow('row title must be a string');
  }
  const activity = found.aiSessionActivity;
  if (activity !== undefined && (typeof activity !== 'string' || !KIT_ACTIVITIES.includes(activity))) {
    return malformedRow('row aiSessionActivity refused');
  }
  const attachment = found.attachmentState;
  if (
    attachment !== undefined &&
    (typeof attachment !== 'string' || !KIT_ATTACHMENTS.includes(attachment))
  ) {
    return malformedRow('row attachmentState refused');
  }
  const outcome = found.dispatchOutcome;
  if (outcome !== undefined && (typeof outcome !== 'string' || !KIT_OUTCOMES.includes(outcome))) {
    return malformedRow('row dispatchOutcome refused');
  }
  const refusal = found.refusal;
  if (refusal !== undefined && refusal !== null) {
    if (
      !isRecord(refusal) ||
      typeof refusal.code !== 'string' ||
      typeof refusal.message !== 'string'
    ) {
      return malformedRow('row refusal must carry string code and message');
    }
  }
  return /** @type {AdmissionResult<WallSurfaceRow>} */ (
    Object.freeze({ ok: true, value: /** @type {WallSurfaceRow} */ (found) })
  );
}

/**
 * @returns {AdmissionResult<WallSurfaceRow>}
 */
function unavailable() {
  return /** @type {AdmissionResult<WallSurfaceRow>} */ (
    Object.freeze({
      ok: false,
      error: admissionError('ERR_PROJECTION_UNAVAILABLE', 'projection snapshot is unavailable'),
    })
  );
}

/**
 * @param {string} message
 * @returns {AdmissionResult<WallSurfaceRow>}
 */
function malformedRow(message) {
  return /** @type {AdmissionResult<WallSurfaceRow>} */ (
    Object.freeze({ ok: false, error: admissionError('ERR_MALFORMED_ROW', message) })
  );
}
