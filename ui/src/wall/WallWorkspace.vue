<script>
/**
 * @fileoverview MetaViewer wall workspace: presentation-only composition over
 * the kit DockWorkspace. Exactly one permanent panel per capsuleId; the kit
 * owns the layout host, controller and restore barrier. This module never
 * touches storage, layout bytes or backend verbs: reveal and presentation
 * intents use only the Dockview api handed over by the kit `ready` event,
 * which the kit emits after its cold restore settles.
 */
import { defineComponent, h } from 'vue';

/** Panel id namespace: deterministic, reversible, never a bare numeric index. */
export const WALL_PANEL_ID_PREFIX = 'panel-';
/** Minimum live tile size, shared with the Holdings grid exemplar. */
export const WALL_PANEL_MIN_WIDTH = 240;
export const WALL_PANEL_MIN_HEIGHT = 200;
/** Initial viewport seed; the kit remeasures the outer stage after restore. */
export const WALL_INITIAL_VIEWPORT_WIDTH = 1280;
export const WALL_INITIAL_VIEWPORT_HEIGHT = 720;
/** Closed reveal placements. Popout stays unavailable by design (R2). */
export const WALL_PLACEMENTS = Object.freeze(['tab', 'split', 'floating']);
/** Closed local presentation verbs. None of them ends a backend surface. */
export const WALL_PRESENTATION_VERBS = Object.freeze(['close', 'hide', 'show', 'float', 'dock-back']);

/** @typedef {Readonly<{ code: string, message: string }>} WallAdmissionError */

/**
 * @template T
 * @typedef {Readonly<{ ok: true, value: T }> | Readonly<{ ok: false, error: WallAdmissionError }>} WallAdmissionResult
 */

/**
 * Authoritative surface row. The workspace reads id, surfaceId, lifecycle
 * and title; the remaining fields keep the view opaque-compatible with the
 * sibling panel contract.
 * @typedef {Object} WallSurfaceRow
 * @property {string} id
 * @property {string} surfaceId
 * @property {string} backendLifecycle
 * @property {string} [attachmentState]
 * @property {number} generation
 * @property {string} visibility
 * @property {string} control
 * @property {string} [title]
 * @property {WallAdmissionError | null} [refusal]
 */

/**
 * The controller still refuses rowless answers at runtime; the row type stays
 * required here so the shared view keeps matching the sibling panel prop.
 * @typedef {Object} WallProjectionView
 * @property {() => ({ rows: ReadonlyArray<WallSurfaceRow> } | null)} getProjection
 */

/** @typedef {Object} WallDockviewApi
 * @property {(id: string) => WallDockviewPanel | undefined} getPanel
 * @property {Array<{id:string,size:number}>} [groups]
 * @property {(group:{id:string,size:number}) => void} [removeGroup]
 * @property {(id:string) => unknown} [getGroup]
 * @property {(options:{id:string,referencePanel:string,direction:string}) => unknown} [addGroup]
 * @property {(options: WallAddPanelOptions) => WallDockviewPanel} addPanel
 * @property {Function} [toJSON]
 * @property {Function} [fromJSON]
 * @property {number} [width]
 * @property {number} [height]
 */

/**
 * @typedef {Object} WallDockviewPanel
 * @property {string} id
 * @property {WallDockviewPanelApi} api
 */

/**
 * @typedef {Object} WallDockviewPanelApi
 * @property {(options:{group:unknown,position:string,index:number}) => void} [moveTo]
 * @property {() => void} close
 * @property {() => void} setActive
 */

/**
 * @typedef {Object} WallAddPanelOptions
 * @property {string} id
 * @property {string} component
 * @property {string} [title]
 * @property {{ capsuleId: string }} params
 * @property {'always'} renderer
 * @property {number} minimumWidth
 * @property {number} minimumHeight
 * @property {{ direction: 'right' }} [position]
 */

/**
 * Committed float geometry in wall pixels. The kit `float` accepts it as an
 * optional second argument (MVUI16 lane P, ARG-pmui-4); older kit builds
 * ignore the extra argument and keep their fixed defaults.
 * @typedef {Object} WallFloatBounds
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} WallWindowPresentation
 * @property {(id: string) => { hidden: boolean }} state
 * @property {(id: string) => void} show
 * @property {(id: string) => void} hide
 * @property {(id: string, bounds?: WallFloatBounds) => void} float
 * @property {(id: string) => void} dock
 */

/**
 * @typedef {Object} WallWorkspaceControllerOptions
 * @property {boolean} [allowLostSurface] - Diagnostic fixture presentation only.
 * @property {WallProjectionView | null} [projectionView]
 */

/** @typedef {'submit-intent' | 'activate-surface' | 'panel-closed'} WallForwardedEmit */

/** @typedef {(name: WallForwardedEmit, payload: unknown) => void} WallEmitFn */

/**
 * @typedef {Object} WallPanelCallbacks
 * @property {(body: unknown) => void} onSubmitIntent
 * @property {(payload: unknown) => void} onActivateSurface
 * @property {(intent: unknown) => WallAdmissionResult<Readonly<{ panelId: string, type: string }>>} onPresentationIntent
 */

/**
 * @typedef {Object} WallWorkspaceController
 * @property {(payload: unknown) => WallAdmissionResult<Readonly<{ ready: boolean }>>} handleReady
 * @property {() => void} dispose
 * @property {(capsuleId:string,body:any) => WallAdmissionResult<unknown>} applyLayoutEcho
 * @property {(capsuleId: unknown, placement: unknown) => WallAdmissionResult<Readonly<{ panelId: string }>>} revealSurface
 * @property {(intent: unknown) => WallAdmissionResult<Readonly<{ panelId: string, type: string }>>} applyPresentationIntent
 * @property {(emit: WallEmitFn) => WallPanelCallbacks} createPanelCallbacks
 */

/**
 * Snapshot mirror of the sibling panel view. Field-for-field compatible so
 * the shared projection object passes through without a cast.
 * @typedef {Object} WallSnapshotLike
 * @property {string} status
 * @property {boolean} stale
 * @property {WallEnvelopeLike | null} envelope
 * @property {WallAdmissionError | null} error
 */

/**
 * @typedef {Object} WallEnvelopeLike
 * @property {string} schema
 * @property {number} epoch
 * @property {number} revision
 * @property {string} query
 * @property {{ rows: ReadonlyArray<WallSurfaceRow> }} projection
 */

/**
 * Shared projection view: the controller reads getProjection, the sibling
 * panel reads getSnapshot and subscribe. Both ride on one object.
 * @typedef {Object} WallSharedProjectionView
 * @property {() => ({ rows: ReadonlyArray<WallSurfaceRow> } | null)} getProjection
 * @property {() => WallSnapshotLike | null} getSnapshot
 * @property {(listener: (snapshot: WallSnapshotLike | null) => void) => () => void} subscribe
 */

/**
 * Shared intent builders, mirroring the sibling intent inputs exactly.
 * @typedef {Object} WallSharedIntentBuilders
 * @property {(input: { capsuleId: string, verb: string, pinned?: boolean }) => unknown} visibility
 * @property {(input: { capsuleId: string, verb: string }) => unknown} control
 * @property {(input: { capsuleId: string, verb: string }) => unknown} presentation
 */

/** @typedef {import('capsule-ui-kit/layout').LayoutProfileScope} KitLayoutScope */

/** @typedef {import('capsule-ui-kit/layout').LayoutProfileEnvelope} KitLayoutProfile */

/**
 * Storage mirror of the kit `LayoutStorage` declaration: raw bytes in,
 * atomic payload plus owner metadata out. Never implemented here.
 * @typedef {Object} KitLayoutStorage
 * @property {() => Promise<string | null>} readRaw
 * @property {(payload: string, meta: { ownerWindowId: string, scope: KitLayoutScope }) => Promise<void>} writeAtomic
 */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  if (typeof value !== 'object' || value === null) return {};
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {WallAdmissionError}
 */
export function wallError(code, message) {
  return Object.freeze({ code, message });
}

/**
 * Capsule ids arrive from layout params and panel intents, never invented
 * here: blank or whitespace-bearing values refuse before any admission work.
 * @param {unknown} value
 * @returns {WallAdmissionResult<string>}
 */
export function validateWallCapsuleId(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    /** @type {WallAdmissionResult<string>} */
    const result = { ok: false, error: wallError('ERR_INVALID_CAPSULE_ID', 'capsuleId must be a non-empty string') };
    return Object.freeze(result);
  }
  if (value !== value.trim() || /\s/.test(value)) {
    /** @type {WallAdmissionResult<string>} */
    const result = { ok: false, error: wallError('ERR_INVALID_CAPSULE_ID', `capsuleId must not contain whitespace: "${value}"`) };
    return Object.freeze(result);
  }
  /** @type {WallAdmissionResult<string>} */
  const result = { ok: true, value };
  return Object.freeze(result);
}

/**
 * Reads the capsule id from dockview panel props (`{ params: { capsuleId },
 * api }`). Anything else renders the missing-id alert, never a guessed panel.
 * @param {unknown} params
 * @returns {string | null}
 */
export function resolveRouterCapsuleId(params) {
  const id = asNonEmptyString(asRecord(asRecord(params).params).capsuleId);
  if (id === null || id !== id.trim() || /\s/.test(id)) return null;
  return id;
}

/** Dock tab control id namespace: deterministic per capsule, never a bare numeric index. */
export const DOCK_TAB_ID_PREFIX = 'wall-tab-';
/** Tab title fallback when the panel carries no usable title or capsule id. */
export const DOCK_TAB_FALLBACK_TITLE = 'Capsule';

/** @typedef {Readonly<{ capsuleId: (string | null), id: (string | null), anchor: (string | null), title: string }>} DockTabDescription */

/**
 * Reads the capsule id behind a dockview tab component invocation. Tab
 * components receive `{ params, api, containerApi, tabLocation }`: the panel
 * params carry the authoritative capsuleId, and the panel id re-derives it
 * through the reversible panel prefix when params are absent.
 * @param {unknown} tabProps
 * @returns {string | null}
 */
export function resolveDockTabCapsuleId(tabProps) {
  const fromParams = resolveRouterCapsuleId(tabProps);
  if (fromParams !== null) return fromParams;
  const panelId = asNonEmptyString(asRecord(asRecord(tabProps).api).id);
  if (panelId !== null && panelId.startsWith(WALL_PANEL_ID_PREFIX)) {
    const candidate = panelId.slice(WALL_PANEL_ID_PREFIX.length);
    const checked = validateWallCapsuleId(candidate);
    if (checked.ok) return checked.value;
  }
  return null;
}

/**
 * Resolves the rendered tab title: the panel title verbatim when it carries
 * non-blank text, otherwise the capsule id, otherwise the Capsule fallback.
 * @param {unknown} tabProps
 * @param {string | null} capsuleId
 * @returns {string}
 */
export function resolveDockTabTitle(tabProps, capsuleId) {
  const title = asNonEmptyString(asRecord(asRecord(tabProps).api).title);
  if (title !== null && title.trim().length > 0) return title;
  return capsuleId ?? DOCK_TAB_FALLBACK_TITLE;
}

/**
 * Describes one dock tab for the agent lane: a stable control id plus a
 * capsule-scoped semantic anchor when a capsule id resolves, title only
 * otherwise (retired or foreign panels keep legacy unanchored rendering and
 * never receive an invented identity).
 * @param {unknown} tabProps
 * @returns {DockTabDescription}
 */
export function describeDockTab(tabProps) {
  const capsuleId = resolveDockTabCapsuleId(tabProps);
  const title = resolveDockTabTitle(tabProps, capsuleId);
  if (capsuleId === null) {
    return Object.freeze({ capsuleId: null, id: null, anchor: null, title });
  }
  return Object.freeze({
    capsuleId,
    id: `${DOCK_TAB_ID_PREFIX}${capsuleId}`,
    anchor: `workspace/tab/${capsuleId}`,
    title,
  });
}

/**
 * Dependency-injected wall controller. Pure except for the kit-owned api
 * object it is given: fully unit-testable without a DOM.
 * @param {WallWorkspaceControllerOptions} [options]
 * @returns {WallWorkspaceController}
 */
export function createWallWorkspaceController(options = {}) {
  const projectionView = options.projectionView ?? null;
  /** @type {WallDockviewApi | null} */
  let api = null;
  /** @type {WallWindowPresentation | null} */
  let windows = null;

  /**
   * @template T
   * @param {T} value
   * @returns {WallAdmissionResult<T>}
   */
  function succeed(value) {
    /** @type {WallAdmissionResult<T>} */
    const result = { ok: true, value };
    return Object.freeze(result);
  }

  /**
   * @param {string} code
   * @param {string} message
   * @returns {WallAdmissionResult<never>}
   */
  function fail(code, message) {
    /** @type {WallAdmissionResult<never>} */
    const result = { ok: false, error: wallError(code, message) };
    return Object.freeze(result);
  }

  function collapseEmptyGroups() {
    if (!api || !Array.isArray(api.groups) || typeof api.removeGroup !== 'function') return;
    // Keep the initial empty restore target until a real panel exists. Snapshot
    // the group list because Dockview mutates it while removing empty groups.
    const groups = [...api.groups];
    if (!groups.some(group => group.size > 0)) return;
    for (const group of groups) if (group.size === 0) api.removeGroup(group);
  }

  /**
   * @param {unknown} payload
   * @returns {WallAdmissionResult<Readonly<{ ready: boolean }>>}
   */
  function handleReady(payload) {
    const record = asRecord(payload);
    const candidateApi = asRecord(record.api);
    const candidateWindows = asRecord(record.windows);
    const apiOk = typeof candidateApi.getPanel === 'function' && typeof candidateApi.addPanel === 'function';
    const windowsOk = ['state', 'show', 'hide', 'float', 'dock']
      .every((key) => typeof candidateWindows[key] === 'function');
    if (!apiOk || !windowsOk) {
      return fail('ERR_INVALID_READY', 'ready payload must carry a Dockview api and window presentation');
    }
    api = /** @type {WallDockviewApi} */ (/** @type {unknown} */ (record.api));
    windows = /** @type {WallWindowPresentation} */ (/** @type {unknown} */ (record.windows));
    collapseEmptyGroups();
    return succeed(Object.freeze({ ready: true }));
  }

  function dispose() {
    api = null;
    windows = null;
  }

  /**
   * Exact identity only: the row must exist, its id must equal its surface id
   * and the requested id, and its backend lifecycle must still be present.
   * @param {string} capsuleId
   * @returns {WallAdmissionResult<WallSurfaceRow>}
   */
  function findRow(capsuleId) {
    if (!projectionView || typeof projectionView.getProjection !== 'function') {
      return fail('ERR_PROJECTION_UNAVAILABLE', 'projection view is unavailable');
    }
    const projection = projectionView.getProjection();
    const rows = projection && Array.isArray(projection.rows) ? projection.rows : null;
    if (!rows) {
      return fail('ERR_PROJECTION_UNAVAILABLE', 'projection carries no surface rows');
    }
    const row = rows.find((candidate) => candidate?.surfaceId === capsuleId);
    if (!row) {
      return fail('ERR_UNKNOWN_SURFACE', `unknown surface "${capsuleId}"`);
    }
    if (row.id !== capsuleId) {
      return fail('ERR_ROW_IDENTITY_MISMATCH', `row identity mismatch for "${capsuleId}"`);
    }
    if (row.backendLifecycle === 'lost' && options.allowLostSurface === true) return succeed(row);
    if (row.backendLifecycle === 'lost' || row.backendLifecycle === 'destroyed') {
      return fail('ERR_SURFACE_GONE', `surface "${capsuleId}" is ${row.backendLifecycle}`);
    }
    if (row.backendLifecycle !== 'active' && row.backendLifecycle !== 'standby' && row.backendLifecycle !== 'ceded') {
      return fail('ERR_UNKNOWN_LIFECYCLE', `unknown lifecycle for "${capsuleId}"`);
    }
    return succeed(row);
  }

  /**
   * @param {WallSurfaceRow} row
   * @returns {string}
   */
  function panelTitle(row) {
    return typeof row.title === 'string' && row.title.trim().length > 0 ? row.title : row.surfaceId;
  }

  /**
   * Reveals the single permanent panel for a capsule id, creating its
   * presentation when absent. Backend state is only read, never written.
   * @param {unknown} capsuleId
   * @param {unknown} placement
   * @returns {WallAdmissionResult<Readonly<{ panelId: string }>>}
   */
  function revealSurface(capsuleId, placement) {
    const idCheck = validateWallCapsuleId(capsuleId);
    if (!idCheck.ok) return idCheck;
    if (typeof placement !== 'string' || !WALL_PLACEMENTS.includes(placement)) {
      return fail('ERR_INVALID_PLACEMENT', `unknown placement "${String(placement)}"`);
    }
    if (api === null || windows === null) {
      return fail('ERR_NOT_READY', 'wall is not ready: cold restore has not settled');
    }
    const rowCheck = findRow(idCheck.value);
    if (!rowCheck.ok) return rowCheck;
    const panelId = `${WALL_PANEL_ID_PREFIX}${idCheck.value}`;
    try {
      const existing = api.getPanel(panelId);
      if (existing) {
        if (placement === 'floating') windows.float(panelId);
        else if (windows.state(panelId).hidden) windows.show(panelId);
        else existing.api.setActive();
        return succeed(Object.freeze({ panelId }));
      }
      /** @type {WallAddPanelOptions} */
      const options = {
        id: panelId,
        component: 'CapsulePanel',
        title: panelTitle(rowCheck.value),
        params: { capsuleId: idCheck.value },
        renderer: 'always',
        minimumWidth: WALL_PANEL_MIN_WIDTH,
        minimumHeight: WALL_PANEL_MIN_HEIGHT,
      };
      if (placement === 'split') options.position = { direction: 'right' };
      const panel = api.addPanel(options);
      collapseEmptyGroups();
      if (placement === 'floating') windows.float(panelId);
      else panel.api.setActive();
      return succeed(Object.freeze({ panelId }));
    } catch (error) {
      return fail('ERR_REVEAL_FAILED', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Applies a local presentation intent. Unknown verbs, unknown panels and
   * missing readiness refuse; nothing here creates or ends a surface.
   * @param {unknown} intent
   * @returns {WallAdmissionResult<Readonly<{ panelId: string, type: string }>>}
   */
  function applyPresentationIntent(intent) {
    if (!isPlainObject(intent) || typeof intent.type !== 'string' || !WALL_PRESENTATION_VERBS.includes(intent.type)) {
      return fail('ERR_UNKNOWN_PRESENTATION', 'unknown local presentation intent');
    }
    const idCheck = validateWallCapsuleId(intent.capsuleId);
    if (!idCheck.ok) return idCheck;
    if (api === null || windows === null) {
      return fail('ERR_NOT_READY', 'wall is not ready: cold restore has not settled');
    }
    const panelId = `${WALL_PANEL_ID_PREFIX}${idCheck.value}`;
    try {
      const panel = api.getPanel(panelId);
      if (!panel) {
        return fail('ERR_UNKNOWN_PANEL', `unknown panel "${panelId}"`);
      }
      if (intent.type === 'close') panel.api.close();
      else if (intent.type === 'hide') windows.hide(panelId);
      else if (intent.type === 'show') windows.show(panelId);
      else if (intent.type === 'float') windows.float(panelId);
      else windows.dock(panelId);
      return succeed(Object.freeze({ panelId, type: intent.type }));
    } catch (error) {
      return fail('ERR_PRESENTATION_FAILED', error instanceof Error ? error.message : String(error));
    }
  }

  /** Apply a committed float to the existing panel (MVUI16 lane P,
   * ARG-pmui-4; MVUI16E lane E contract fix). Params mirror the
   * ui_intent/v0.2 float bounds; anything else refuses without touching
   * presentation. Geometry rides the kit windows.float bounds argument;
   * the kit ignores bounds today (kit queue item 15 adds bounds) and the
   * wall contract forbids any renderer layout round trip, so no geometry
   * is applied or asserted here.
   * @param {string} capsuleId @param {any} body @returns {WallAdmissionResult<unknown>} */
  function applyFloatEcho(capsuleId, body) {
    const row = findRow(capsuleId);
    if (!row.ok) return row;
    if (!api || !windows) return fail('ERR_NOT_READY', 'Placement is not ready.');
    const p = body?.params;
    const inRange = (/** @type {any} */ v, /** @type {number} */ min, /** @type {number} */ max) =>
      Number.isInteger(v) && v >= min && v <= max;
    if (!p || ![capsuleId, `cuk-ai-slot-${capsuleId}`].includes(p.slot_id)
        || !inRange(p.x_px, 0, 16383) || !inRange(p.y_px, 0, 16383)
        || !inRange(p.width_px, 1, 16384) || !inRange(p.height_px, 1, 16384)) {
      return fail('ERR_INVALID_PLACEMENT', 'Placement is unavailable.');
    }
    const panelId = `${WALL_PANEL_ID_PREFIX}${capsuleId}`;
    const panel = api.getPanel(panelId);
    if (!panel) return fail('ERR_UNKNOWN_PANEL', `unknown panel "${panelId}"`);
    try {
      windows.float(panelId, { x: p.x_px, y: p.y_px, width: p.width_px, height: p.height_px });
      return succeed(Object.freeze({ panelId }));
    } catch { return fail('ERR_PRESENTATION_FAILED', 'Placement is unavailable.'); }
  }

  /** Apply a committed move/tab to the existing panel, keeping its live renderer.
   * The caller owns correlation and waits for the authority echo first.
   * @param {string} capsuleId @param {any} body @returns {WallAdmissionResult<unknown>} */
  function applyLayoutEcho(capsuleId, body) {
    const row = findRow(capsuleId);
    if (!row.ok) return row;
    if (!api || !windows) return fail('ERR_NOT_READY', 'Placement is not ready.');
    if (body?.op === 'float') return applyFloatEcho(capsuleId, body);
    if (!['move','tab'].includes(body?.op)) return applyPresentationIntent({ type:body?.op, capsuleId });
    const p = body.params;
    if (!p || ![capsuleId, `cuk-ai-slot-${capsuleId}`].includes(p.slot_id)
        || typeof p.group_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(p.group_id)
        || !Number.isInteger(p.index) || p.index < 0 || p.index > 255) return fail('ERR_INVALID_PLACEMENT', 'Placement is unavailable.');
    const panelId = `${WALL_PANEL_ID_PREFIX}${capsuleId}`;
    const panel = api.getPanel(panelId);
    if (!panel?.api.moveTo || !api.getGroup || !api.addGroup) return fail('ERR_NOT_READY', 'Placement is not ready.');
    try {
      const group = api.getGroup(p.group_id) ?? api.addGroup({ id:p.group_id, referencePanel:panelId, direction:'right' });
      windows.dock(panelId);
      panel.api.moveTo({ group, position:'center', index:p.index });
      panel.api.setActive();
      return succeed(Object.freeze({ panelId }));
    } catch { return fail('ERR_PRESENTATION_FAILED', 'Placement is unavailable.'); }
  }

  /**
   * @param {WallEmitFn} emit
   * @returns {WallPanelCallbacks}
   */
  function createPanelCallbacks(emit) {
    return Object.freeze({
      onSubmitIntent: (/** @type {unknown} */ body) => { emit('submit-intent', body); },
      onActivateSurface: (/** @type {unknown} */ payload) => { emit('activate-surface', payload); },
      onPresentationIntent: (/** @type {unknown} */ intent) => {
        const result = applyPresentationIntent(intent);
        // The close (x) removes only the dock panel; the shell must learn it to offer the way back.
        if (result.ok && result.value.type === 'close') emit('panel-closed', Object.freeze({ capsuleId: /** @type {any} */ (intent).capsuleId }));
        return result;
      },
    });
  }

  return Object.freeze({ handleReady, dispose, revealSurface, applyPresentationIntent, applyLayoutEcho, createPanelCallbacks });
}

/**
 * Fallback for retired panel types. The kit routes unknown component names
 * here with their ids and params preserved; the message stays honest about
 * the retired type instead of rendering a live-looking tile.
 */
export const WallMissingPanel = defineComponent({
  name: 'WallMissingPanel',
  props: {
    params: { type: Object, required: true },
  },
  setup(routerProps) {
    return () => {
      const outer = asRecord(routerProps.params);
      const inner = asRecord(outer.params);
      const panelId = asNonEmptyString(asRecord(outer.api).id)
        ?? asNonEmptyString(inner.capsuleId)
        ?? 'unknown panel';
      const reason = asNonEmptyString(inner.unavailableReason)
        ?? 'Panel type retired. Reset the workspace layout.';
      return h('div', { role: 'alert', class: 'wall-missing-panel', 'data-panel-id': panelId }, [
        h('p', { class: 'wall-missing-panel-title' }, `Panel unavailable: ${panelId}.`),
        h('p', { class: 'wall-missing-panel-reason' }, reason),
      ]);
    };
  },
});
</script>
<script setup>
import { markRaw, onBeforeUnmount, useSlots } from 'vue';
import DockWorkspace from 'capsule-ui-kit/DockWorkspace';
import SurfacePanel from './SurfacePanel.vue';

const props = defineProps({
  workspaceComponent: { type: Object, default: () => DockWorkspace },
  scope: {
    type: /** @type {import('vue').PropType<KitLayoutScope>} */ (Object),
    required: true,
  },
  storage: {
    type: /** @type {import('vue').PropType<KitLayoutStorage>} */ (Object),
    required: true,
  },
  ownerWindowId: { type: String, required: true },
  allowLostSurface: { type: Boolean, default: false },
  projectionView: {
    type: /** @type {import('vue').PropType<WallSharedProjectionView>} */ (Object),
    required: true,
  },
  intentBuilders: {
    type: /** @type {import('vue').PropType<WallSharedIntentBuilders>} */ (Object),
    required: true,
  },
  controlRegistry: { type: Object, required: true },
  scheduler: { type: Object, required: true },
  tileScheduler: { type: Object, required: true },
  colorScheme: {
    type: String,
    default: 'light',
    validator: (/** @type {unknown} */ value) => value === 'light' || value === 'dark',
  },
  density: {
    type: String,
    default: 'regular',
    validator: (/** @type {unknown} */ value) => value === 'compact' || value === 'regular' || value === 'comfortable',
  },
  defaultProfile: {
    type: /** @type {import('vue').PropType<KitLayoutProfile | null>} */ (Object),
    default: null,
  },
  captureState: { type: Object, default: null },
  displayOnly: { type: Boolean, default: false },
});

const emit = defineEmits([
  'ready',
  'wall-settled',
  'layout-saved',
  'quarantine-detected',
  'popout-blocked',
  'active-panel-change',
  'submit-intent',
  'activate-surface',
  'panel-closed',
]);

const controller = createWallWorkspaceController({ projectionView: props.projectionView, allowLostSurface: props.allowLostSurface });
const callbacks = controller.createPanelCallbacks(emit);

const slots = useSlots();
const surfaceSlot = slots.surface ?? null;

const viewportWidth = WALL_INITIAL_VIEWPORT_WIDTH;
const viewportHeight = WALL_INITIAL_VIEWPORT_HEIGHT;

/**
 * @param {unknown} payload
 */
function onReady(payload) {
  controller.handleReady(payload);
  emit('ready', payload);
}

/**
 * @param {unknown} payload
 */
function onWallSettled(payload) {
  emit('wall-settled', payload);
}

/**
 * @param {unknown} payload
 */
function onLayoutSaved(payload) {
  emit('layout-saved', payload);
}

/**
 * @param {unknown} payload
 */
function onQuarantineDetected(payload) {
  emit('quarantine-detected', payload);
}

/**
 * @param {unknown} payload
 */
function onPopoutBlocked(payload) {
  emit('popout-blocked', payload);
}

/**
 * @param {unknown} payload
 */
function onActivePanelChange(payload) {
  emit('active-panel-change', payload);
}

const WallSurfaceRouter = markRaw(defineComponent({
  name: 'WallSurfaceRouter',
  props: {
    params: { type: Object, required: true },
  },
  setup(routerProps) {
    return () => {
      const capsuleId = resolveRouterCapsuleId(routerProps.params);
      if (capsuleId === null) {
        return h('p', { role: 'alert', class: 'wall-missing-id' }, 'Missing capsule id. Reset the workspace layout.');
      }
      const api = asRecord(asRecord(routerProps.params).api);
      const instance = asNonEmptyString(api.id) ?? capsuleId;
      return h(SurfacePanel, {
        capsuleId,
        title: typeof api.title === 'string' ? api.title : capsuleId,
        projectionView: props.projectionView,
        intentBuilders: props.intentBuilders,
        controlRegistry: props.controlRegistry,
        scheduler: props.scheduler,
        tileScheduler: props.tileScheduler,
        captureState: props.captureState,
        displayOnly: props.displayOnly,
        presentationInstance: instance,
        onSubmitIntent: callbacks.onSubmitIntent,
        onPresentationIntent: callbacks.onPresentationIntent,
        onActivateSurface: callbacks.onActivateSurface,
      }, {
        surface: (/** @type {unknown} */ slotProps) => (surfaceSlot ? surfaceSlot(slotProps) : []),
      });
    };
  },
}));

const SurfaceTab = defineComponent({
  name: 'SurfaceTab',
  props: { params: { type: Object, required: true } },
  setup(tabProps) {
    return () => {
      const tab = describeDockTab(tabProps.params);
      if (tab.id === null || tab.anchor === null) {
        return h('span', { class: 'mv-surface-tab' }, tab.title);
      }
      return h('span', { class: 'mv-surface-tab', id: tab.id, 'data-semantic-anchor': tab.anchor }, tab.title);
    };
  },
});
const tabComponents = markRaw({ SurfaceTab });

const panelComponents = markRaw({
  CapsulePanel: WallSurfaceRouter,

});

/**
 * @param {unknown} capsuleId
 * @param {unknown} placement
 */
function revealSurface(capsuleId, placement) {
  return controller.revealSurface(capsuleId, placement);
}

/** @param {string} capsuleId @param {unknown} body */
function applyLayoutEcho(capsuleId, body) { return controller.applyLayoutEcho(capsuleId, body); }
defineExpose({ revealSurface, applyLayoutEcho });

onBeforeUnmount(() => {
  controller.dispose();
});
</script>
<template>
  <div class="wall-workspace" data-testid="wall-workspace">
    <component :is="props.workspaceComponent"
      :scope="props.scope"
      :storage="props.storage"
      :default-profile="props.defaultProfile ?? undefined"
      :owner-window-id="props.ownerWindowId"
      :panel-components="panelComponents"
      :tab-components="tabComponents"
      default-tab-component="SurfaceTab"
      :color-scheme="props.colorScheme"
      :density="props.density"
      workspace-title="MetaViewer"
      :initial-viewport-width="viewportWidth"
      :initial-viewport-height="viewportHeight"
      @ready="onReady"
      @wall-settled="onWallSettled"
      @layout-saved="onLayoutSaved"
      @quarantine-detected="onQuarantineDetected"
      @popout-blocked="onPopoutBlocked"
      @active-panel-change="onActivePanelChange"
    />
  </div>
</template>
<style>
.wall-workspace {
  /* Contain Dockview sashes below sibling full-screen app panels. */
  position: relative;
  z-index: 0;
  height: 100%;
  min-height: 0;
  min-width: 0;
}
.wall-missing-panel,
.wall-missing-id {
  font: inherit;
  padding: 12px 16px;
}
.wall-missing-panel-title {
  font-weight: 600;
  margin: 0 0 4px;
}
.wall-missing-panel-reason {
  margin: 0;
}
</style>
